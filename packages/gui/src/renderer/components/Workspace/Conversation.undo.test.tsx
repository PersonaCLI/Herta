import type {
  RewindResult,
  TerminalRecord,
  UndoTurnEditsResult,
} from "@herta/app-server";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { getHoverTip, hideHoverTip } from "../common/hover-tip.js";
import { Composer } from "./Composer.js";
import { Conversation } from "./Conversation.js";
import { WorkspaceRefsProvider } from "./WorkspaceRefs.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** One finished 板砖 turn: the commission, the run, its 完成, her reply. */
const turn = (n: number): TerminalRecord => [
  { kind: "user", text: `commission ${n}` },
  { kind: "system", label: "差分协处理器", body: `Writing a${n}.ts` },
  {
    kind: "system",
    label: "差分协处理器",
    body: "完成 · 1 file",
    role: "done-marker",
  },
  { kind: "herta", surface: "speech", text: `reply ${n}` },
];

const undoLine = {
  kind: "system" as const,
  label: "系统" as const,
  body: "已撤销本轮板砖的文件改动：已还原 a2.ts；README.md 此后已修改，未还原。",
  digest: {
    kind: "undo" as const,
    files: [
      { path: "a2.ts", result: "restored" as const },
      { path: "README.md", result: "changed_since" as const },
    ],
    commands: [],
    commandsUnknown: false,
    incomplete: false,
  },
};

function render(
  record: TerminalRecord,
  opts: {
    undoable?: boolean;
    undoResult?: UndoTurnEditsResult;
    rewindResult?: RewindResult;
  } = {},
) {
  const mock = createMockHertaBridge({
    ...(opts.undoResult !== undefined
      ? { undoLastTurnEditsResult: opts.undoResult }
      : {}),
    ...(opts.rewindResult !== undefined
      ? { rewindLastTurnResult: opts.rewindResult }
      : {}),
  });
  const rendered = renderWithLocale(
    <WorkspaceRefsProvider>
      <HertaBridgeProvider bridge={mock.bridge}>
        <Conversation />
        <Composer />
      </HertaBridgeProvider>
    </WorkspaceRefsProvider>,
  );
  act(() => {
    mock.emitReset({
      sessionId: "s",
      workspaceRoot: "/r",
      record,
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
      lang: "en",
      ...(opts.undoable === true ? { undoable: true } : {}),
    });
  });
  return { mock, ...rendered };
}

const chip = () => screen.queryByRole("button", { name: "Undo" });
const cards = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-testid="activity-block"]'));

describe("the 撤销 chip on the latest turn's card (ADR 0074 §4)", () => {
  it("sits on the latest turn's finished card only, and takes that turn's edits back", async () => {
    const { mock, container } = render([...turn(1), ...turn(2)], {
      undoable: true,
    });
    const blocks = cards(container);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.querySelector(".activity-undo")).toBeNull();
    expect(blocks[1]?.contains(chip())).toBe(true);
    // The app's own tip, not the OS's (owner 2026-10-08).
    expect(chip()?.hasAttribute("title")).toBe(false);
    act(() => {
      fireEvent.focusIn(chip() as HTMLElement);
    });
    expect(getHoverTip()?.text).toBe(
      "Undo Brick's file changes from this turn",
    );
    act(() => {
      hideHoverTip();
    });
    await act(async () => {
      fireEvent.click(chip() as HTMLElement);
    });
    expect(mock.calls.undoLastTurnEdits).toEqual([["s", "latest"]]);
  });

  it("follows main's word on whether there is anything to undo", () => {
    const { mock } = render(turn(1));
    expect(chip()).toBeNull();
    act(() => mock.emitUndo({ kind: "offer", undoable: true }));
    expect(chip()).not.toBeNull();
    act(() => mock.emitUndo({ kind: "offer", undoable: false }));
    expect(chip()).toBeNull();
  });

  it("is not offered while a turn runs", () => {
    const { mock } = render(turn(1), { undoable: true });
    act(() => mock.emitTurn({ kind: "started", turnId: "t2" }));
    expect(chip()).toBeNull();
  });

  it("a turn already undone says so on its card, and its line shows what happened to each file", () => {
    const { container } = render([...turn(1), ...turn(2), undoLine]);
    expect(chip()).toBeNull();
    const [, card, line] = cards(container);
    expect(card?.querySelector(".activity-undo")?.textContent).toBe("Undone");
    expect(line?.textContent).toContain(
      "Changes from this turn undone · 1 restored · 1 not restored",
    );
    expect(line?.textContent).toContain("a2.ts");
    expect(line?.textContent).toContain("restored");
    expect(line?.textContent).toContain("README.md");
    expect(line?.textContent).toContain("modified since; not restored");
  });
});

describe("⟲ offers the rewound turn's edits back in its notice (ADR 0074 §4)", () => {
  it("a rewound turn with undoable edits gets Undo changes beside the notice", async () => {
    vi.useFakeTimers();
    const { container } = render(turn(1), {
      rewindResult: {
        ok: true,
        userText: "commission 1",
        editedFiles: false,
        undoable: true,
      },
    });
    fireEvent.click(container.querySelector(".message-rewind") as HTMLElement);
    await act(async () => {
      vi.advanceTimersByTime(240);
      await Promise.resolve();
    });
    expect(screen.getByText("Edited files were not reverted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo changes" })).toBeTruthy();
  });
});
