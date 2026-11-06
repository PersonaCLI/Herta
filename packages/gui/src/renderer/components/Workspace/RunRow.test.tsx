import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { renderWithSession } from "../../testing/renderWithSession.js";
import { FileViewerPanel } from "../FileViewer/FileViewerPanel.js";
import { FileViewerProvider } from "../FileViewer/file-viewer-context.js";
import { Composer } from "./Composer.js";
import type { SystemBlock } from "./group-record.js";
import { RunRow, type RunRowProps } from "./RunRow.js";
import { WorkspaceRefsProvider } from "./WorkspaceRefs.js";

type Verb = "Reading" | "Writing" | "Running";
const op = (verb: Verb, arg: string, runsTests?: true): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: `${verb} ${arg}`,
  digest: { kind: "op", verb, arg, ...(runsTests ? { runsTests } : {}) },
});
const done = (
  body: string,
  markerSummary?: SystemBlock["markerSummary"],
): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body,
  role: "done-marker",
  ...(markerSummary !== undefined ? { markerSummary } : {}),
});

/** A mock whose bridge can read files: the viewer, and so 完整记录, is
 *  there. */
function viewerMock() {
  const mock = createMockHertaBridge();
  Object.assign(mock.bridge, {
    readWorkspaceFile: vi.fn(async () => ({
      ok: false as const,
      reason: "not_found" as const,
    })),
  });
  return mock;
}

function row(
  props: Partial<RunRowProps> & Pick<RunRowProps, "blocks">,
  opts: { lang?: "zh" | "en"; viewer?: boolean } = {},
) {
  const lang = opts.lang ?? "en";
  const mock = opts.viewer === true ? viewerMock() : createMockHertaBridge();
  const h = renderWithSession(
    <FileViewerProvider>
      <RunRow
        absIndex={3}
        active={false}
        backendStartedAt={null}
        lang={lang}
        {...props}
      />
      <FileViewerPanel />
    </FileViewerProvider>,
    { mock, lang },
  );
  return h;
}

describe("RunRow — a run of 板砖's in the chat (ADR 0085 §9)", () => {
  it("live: the device's word and the step count, the LED pulsing, the time counting from the backend's start", () => {
    const { container } = row(
      {
        blocks: [op("Reading", "a.ts"), op("Writing", "a.ts")],
        active: true,
        backendStartedAt: Date.now() - 3000,
      },
      { lang: "zh" },
    );
    expect(container.textContent).toContain("差分协处理器");
    expect(container.querySelector(".swap-text__in")?.textContent).toBe(
      "处理中",
    );
    expect(container.querySelector(".run-row__live")?.textContent).toContain(
      "2 步",
    );
    expect(
      container.querySelector(".activity-line__led.is-pulsing"),
    ).not.toBeNull();
    const time = container.querySelector(".activity-line__duration");
    expect(time?.textContent).toMatch(/^\d+s$/);
    expect(Number.parseInt(time?.textContent ?? "", 10)).toBeLessThan(10);
    // The run's rows are not unfolded here.
    expect(container.querySelector(".activity-step")).toBeNull();
  });

  it("live, checking: 验证中", () => {
    const { container } = row(
      {
        blocks: [op("Writing", "a.ts"), op("Running", "pnpm test", true)],
        active: true,
        backendStartedAt: Date.now(),
      },
      { lang: "zh" },
    );
    expect(container.querySelector(".swap-text__in")?.textContent).toBe(
      "验证中",
    );
  });

  it("live, parked on an approval: 等待批准, with no count", () => {
    const h = row(
      {
        blocks: [op("Writing", "a.ts")],
        active: true,
        backendStartedAt: Date.now(),
      },
      { lang: "zh" },
    );
    act(() => {
      h.mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "r1",
          risk: "workspace_write",
          tool: "write_new_file",
          summary: "x",
        },
      });
    });
    expect(h.container.querySelector(".swap-text__in")?.textContent).toBe(
      "等待批准",
    );
    expect(h.container.textContent).not.toContain("1 步");
  });

  it("ended: the marker's line, composed in the session's language", () => {
    const marker = done("完成 · 1 file · tests 1/1", {
      kind: "done",
      state: "completed",
      fileCount: 1,
      tests: { passed: 1, failed: 0 },
      riskCount: 0,
    });
    const zh = row({ blocks: [op("Reading", "a.ts"), marker] }, { lang: "zh" });
    expect(zh.container.textContent).toContain("完成 · 1 个文件 · 测试 1/1");
    expect(
      zh.container.querySelector(".activity-line__led.is-pulsing"),
    ).toBeNull();
    zh.unmount();
    // UI and session differ: the row follows the session (ADR 0019).
    const en = row({ blocks: [op("Reading", "a.ts"), marker] }, { lang: "en" });
    expect(en.container.textContent).toContain("Coprocessor");
    expect(en.container.textContent).toContain("Done · 1 file · tests 1/1");
    expect(en.container.textContent).not.toContain("完成");
  });

  it("a no-op run says so", () => {
    const { container } = row({
      blocks: [
        {
          kind: "system",
          label: "差分协处理器",
          body: "无产出",
          role: "noop-marker",
        },
      ],
    });
    expect(container.textContent).toContain("No output");
  });

  it("a run cut short with no marker still counts what it did", () => {
    const { container } = row({
      blocks: [op("Reading", "a.ts"), op("Reading", "b.ts")],
    });
    expect(
      container.querySelector(".activity-line__summary")?.textContent,
    ).toBe("· 2 steps");
  });

  it("an ended run reads its own time from the record's stamps", () => {
    const { container } = row({
      blocks: [
        { ...op("Reading", "a.ts"), at: "2026-11-04T08:00:02.000Z" },
        { ...done("完成"), at: "2026-11-04T08:01:09.000Z" },
      ],
      dispatchedAt: "2026-11-04T08:00:00.000Z",
    });
    expect(
      container.querySelector(".activity-line__duration")?.textContent,
    ).toBe("Took 1:09");
  });

  it("the commit sha the run landed opens the commit (ADR 0059)", async () => {
    const mock = viewerMock();
    const readWorkspaceCommit = vi.fn(async () => ({
      ok: true as const,
      commit: {
        sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
        shortSha: "a1b2c3d",
        subject: "feat: the work",
        body: "",
        author: "Tester",
        authoredAt: "2026-09-07T10:00:00+08:00",
        parents: [],
        files: [],
        filesTotal: 0,
        patch: "",
        patchTruncated: false,
      },
    }));
    Object.assign(mock.bridge, { readWorkspaceCommit });
    const h = renderWithSession(
      <FileViewerProvider>
        <RunRow
          blocks={[
            op("Running", "git commit"),
            done("完成 · 1 file · 提交 a1b2c3d", {
              kind: "done",
              state: "completed",
              fileCount: 1,
              riskCount: 0,
              git: { commit: "a1b2c3d" },
            }),
          ]}
          absIndex={1}
          active={false}
          backendStartedAt={null}
          lang="en"
        />
        <FileViewerPanel />
      </FileViewerProvider>,
      { mock, lang: "en", sessionId: "s1" },
    );
    const sha = h.container.querySelector(
      ".activity-line__summary .file-open-name",
    );
    expect(sha?.textContent).toBe("a1b2c3d");
    fireEvent.click(sha as Element);
    await waitFor(() =>
      expect(readWorkspaceCommit).toHaveBeenCalledWith("s1", "a1b2c3d"),
    );
  });

  it("完整记录 › opens the run's tab; without a viewer it is not offered", () => {
    const blocks = [
      { ...op("Reading", "a.ts"), at: "2026-11-04T08:00:02.000Z" },
    ];
    const bare = row({ blocks }, { lang: "zh" });
    expect(bare.container.querySelector(".run-row__record")).toBeNull();
    bare.unmount();
    const h = row({ blocks }, { lang: "zh", viewer: true });
    const open = h.container.querySelector(".run-row__record") as HTMLElement;
    expect(open.textContent).toBe("完整记录 ›");
    fireEvent.click(open);
    const viewer = h.container.querySelector(".file-viewer");
    expect(viewer?.getAttribute("data-kind")).toBe("run");
    // Its time first: every run's tab used to read the same (N6).
    expect(
      screen.getByRole("tab", { name: /· 差分协处理器 · 完整记录$/u }),
    ).toBe(screen.getByRole("tab", { selected: true }));
    // A run's record is not a file: nothing to copy or open in the OS.
    expect(screen.queryByRole("button", { name: "Copy path" })).toBeNull();
  });

  it("撤销 on the run that ended and changed files, as ADR 0074 decides", () => {
    const onUndo = vi.fn();
    const blocks = [op("Writing", "a.ts"), done("完成 · 1 file")];
    const offer = row({ blocks, undo: { state: "offer", onUndo } });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    offer.unmount();
    const busy = row({ blocks, undo: { state: "busy", onUndo } });
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    busy.unmount();
    const undone = row({ blocks, undo: { state: "done" } });
    expect(
      undone.container.querySelector(".activity-undo.is-done")?.textContent,
    ).toBe("Undone");
    undone.unmount();
    // Never while it runs.
    row({
      blocks: [op("Writing", "a.ts")],
      active: true,
      backendStartedAt: Date.now(),
      undo: { state: "offer", onUndo },
    });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("停止运行 on the live row is the composer's Stop (shown by CSS only where the rail is hidden)", async () => {
    const h = renderWithSession(
      <WorkspaceRefsProvider>
        <RunRow
          blocks={[op("Reading", "a.ts")]}
          absIndex={1}
          active={true}
          backendStartedAt={Date.now()}
          lang="en"
        />
        <Composer />
      </WorkspaceRefsProvider>,
      { lang: "en" },
    );
    h.startTurn();
    h.startBackend();
    const stop = screen.getByRole("button", { name: "Stop the run" });
    await act(async () => {
      fireEvent.click(stop);
    });
    expect(h.mock.calls.interrupt).toHaveLength(1);
    // Under an approval it still answers: the button stays on the screen,
    // and an interrupt ends the gate (review 2026-11-05, N4).
    act(() => {
      h.mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "req-1",
          risk: "workspace_write",
          tool: "bash",
          summary: "writes a file",
          cacheable: false,
        },
      });
    });
    await act(async () => {
      fireEvent.click(stop);
    });
    expect(h.mock.calls.interrupt).toHaveLength(2);
    h.unmount();
    // Ended: no stop.
    row({ blocks: [op("Reading", "a.ts"), done("完成")] });
    expect(screen.queryByRole("button", { name: "Stop the run" })).toBeNull();
  });
});
