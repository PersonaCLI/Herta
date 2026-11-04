import type { TerminalRecord, TerminalRecordBlock } from "@herta/app-server";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { renderWithSession } from "../../testing/renderWithSession.js";
import { Conversation } from "../Workspace/Conversation.js";
import { WorkspaceRefsProvider } from "../Workspace/WorkspaceRefs.js";
import { FileViewerPanel } from "./FileViewerPanel.js";
import { FileViewerProvider } from "./file-viewer-context.js";

const at = (s: number): string =>
  new Date(Date.parse("2026-11-04T08:00:00.000Z") + s * 1000).toISOString();
const sys = (
  body: string,
  digest: unknown,
  s: number,
  extra: Record<string, unknown> = {},
): TerminalRecordBlock =>
  ({
    kind: "system",
    label: "差分协处理器",
    body,
    digest,
    at: at(s),
    ...extra,
  }) as TerminalRecordBlock;
const op = (verb: string, arg: string, s: number, runsTests?: true) =>
  sys(
    `${verb} ${arg}`,
    { kind: "op", verb, arg, ...(runsTests ? { runsTests } : {}) },
    s,
  );

const LOG = ".herta/logs/s1-c7.log";
/** A whole run: read, write (its preview folded in), a steer, a clipped
 *  build, a test run, the marker with its facts. */
const RUN: TerminalRecord = [
  { kind: "user", text: "修一下登录", at: at(0) },
  { kind: "herta", surface: "speech", text: "交给它。", at: at(1) },
  op("Reading", "src/Login.jsx", 2),
  sys(
    "patch preview: src/Login.jsx (+1 -1)",
    { kind: "patch", files: ["src/Login.jsx"], add: 1, del: 1 },
    3,
    { label: "系统" },
  ),
  op("Writing", "src/Login.jsx", 4),
  { kind: "user", text: "先别动 api 目录", steer: true, at: at(5) },
  op("Running", "node build.js", 6),
  sys(
    "↳ exit 0 · 400 lines",
    { kind: "text", text: "", exitCode: 0, lineCount: 400 },
    7,
    {
      evidence: [
        { kind: "output", text: `built\n…(truncated, full log: ${LOG})` },
      ],
      evidenceDetail: `↳ 输出:\nbuilt\n…(truncated, full log: ${LOG})`,
    },
  ),
  op("Running", "npm test", 8, true),
  sys(
    "↳ tests: 3 passed",
    { kind: "tests", status: "passed", summary: "3 passed" },
    9,
  ),
  sys("完成 · 1 file · tests 3/3", undefined, 12, {
    role: "done-marker",
    markerSummary: {
      kind: "done",
      state: "completed",
      fileCount: 1,
      tests: { passed: 3, failed: 0 },
      riskCount: 0,
    },
    evidence: [{ kind: "files", paths: ["src/Login.jsx"] }],
    evidenceDetail: "↳ 改动文件: src/Login.jsx",
  }),
  { kind: "herta", surface: "speech", text: "修好了。", at: at(13) },
];

function mount(record: TerminalRecord, opts: { undoable?: boolean } = {}) {
  const mock = createMockHertaBridge();
  const readWorkspaceFile = vi.fn(async () => ({
    ok: false as const,
    reason: "not_found" as const,
  }));
  Object.assign(mock.bridge, { readWorkspaceFile });
  const h = renderWithSession(
    <WorkspaceRefsProvider>
      <FileViewerProvider>
        <Conversation />
        <FileViewerPanel />
      </FileViewerProvider>
    </WorkspaceRefsProvider>,
    { mock, lang: "en", sessionId: "s1" },
  );
  act(() => {
    mock.emitReset({
      sessionId: "s1",
      workspaceRoot: "/r",
      record,
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
      lang: "en",
      ...(opts.undoable === true ? { undoable: true } : {}),
    });
  });
  return { ...h, readWorkspaceFile };
}

const openRecord = (container: HTMLElement, i = 0): void => {
  const links = container.querySelectorAll(".run-row__record");
  fireEvent.click(links[i] as HTMLElement);
};
const tab = (): HTMLElement => screen.getByTestId("run-record");

describe("the 完整记录 tab (ADR 0085 §9, amendment 2026-11-04 later)", () => {
  it("every row under the card's phases, the steer with its speaker's avatar where 板砖 took it, and the marker's facts at the end", () => {
    const { container } = mount(RUN);
    openRecord(container);
    const body = tab();
    // Head: the marker's line, the counts and the time.
    expect(body.querySelector(".run-record__summary")?.textContent).toContain(
      "Done · 1 file · tests 3/3",
    );
    expect(body.querySelector(".run-record__counts")?.textContent).toBe(
      "4 steps · 1 file · Took 11s",
    );
    // The stretches, in record order: the steer breaks the run where it
    // landed.
    const order = Array.from(
      body.querySelectorAll(".run-record__phase-name, .run-record__steer"),
    ).map((el) =>
      el.classList.contains("run-record__steer") ? "steer" : el.textContent,
    );
    expect(order).toEqual([
      "Explore",
      "Edit",
      "steer",
      "Verify",
      "result detail",
    ]);
    // None summarised: the read, the write with its diff folded in, the
    // build and its exit, the test run and its result.
    expect(body.querySelectorAll(".activity-step")).toHaveLength(6);
    // The steer: the Trailblazer's avatar, no 插话 label.
    const steer = body.querySelector(".run-record__steer") as HTMLElement;
    expect(
      within(steer).getByRole("img", { name: "Trailblazer" }),
    ).toBeTruthy();
    expect(steer.textContent).toBe("先别动 api 目录");
    // The facts her verdict reads; the changed file opens.
    expect(
      body.querySelector(".run-record__facts-body")?.textContent,
    ).toContain("src/Login.jsx");
  });

  it("a read links its file, a clipped command its full log, a changed file opens", async () => {
    const { container, readWorkspaceFile } = mount(RUN);
    openRecord(container);
    const body = tab();
    // The read's, the write's and the facts' — every one opens it.
    const opens = within(body).getAllByRole("button", {
      name: "View file src/Login.jsx",
    });
    expect(opens).toHaveLength(3);
    fireEvent.click(opens[0] as HTMLElement);
    await waitFor(() =>
      expect(readWorkspaceFile).toHaveBeenCalledWith("s1", "src/Login.jsx"),
    );
    // The file opened in a tab of its own; the run's is one click back.
    fireEvent.click(
      screen.getByRole("tab", { name: "Coprocessor · Full record" }),
    );
    // The exit row opens to its output's tail, and the log it names opens.
    const toggles = within(tab()).getAllByRole("button", {
      name: "show detail",
    });
    fireEvent.click(toggles[0] as HTMLElement);
    fireEvent.click(
      within(tab()).getByRole("button", { name: `View file ${LOG}` }),
    );
    await waitFor(() =>
      expect(readWorkspaceFile).toHaveBeenCalledWith("s1", LOG),
    );
  });

  it("live while the run works: rows land as they do on the card, the newest shimmering", () => {
    const live = RUN.slice(0, 5);
    const h = mount(live);
    h.startTurn();
    h.startBackend();
    openRecord(h.container);
    expect(tab().querySelector(".run-record__led.is-live")).not.toBeNull();
    expect(tab().querySelectorAll(".activity-step")).toHaveLength(2);
    expect(tab().querySelectorAll(".activity-step.is-active")).toHaveLength(1);
    act(() => {
      h.mock.emitRecord({
        kind: "block",
        blockId: "late",
        block: op("Running", "npm test", 8, true),
      });
    });
    expect(tab().querySelectorAll(".activity-step")).toHaveLength(3);
    expect(tab().textContent).toContain("Verify");
  });

  it("撤销本轮改动 once the run has ended, on the run ADR 0074 picks", async () => {
    const { container, mock } = mount(RUN, { undoable: true });
    openRecord(container);
    const undo = within(tab()).getByRole("button", {
      name: "Undo this turn's changes",
    });
    await act(async () => {
      fireEvent.click(undo);
    });
    expect(mock.calls.undoLastTurnEdits).toEqual([["s1", "latest"]]);
  });

  it("a run the loaded record no longer holds says so instead of drawing another", () => {
    const { container, mock } = mount(RUN);
    openRecord(container);
    // A new session state with a different block at that index (a rewind,
    // a reset): the tab does not answer for a run it was not opened on.
    act(() => {
      mock.emitReset({
        sessionId: "s1",
        workspaceRoot: "/r",
        record: [
          { kind: "user", text: "别的", at: at(100) },
          { kind: "herta", surface: "speech", text: "好。", at: at(101) },
          op("Reading", "other.ts", 102),
        ],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
        lang: "en",
      });
    });
    expect(screen.queryByTestId("run-record")).toBeNull();
    expect(
      screen.getByText(
        "This run is no longer in the loaded record. Load earlier messages in the chat, then open it from its row.",
      ),
    ).toBeTruthy();
  });
});
