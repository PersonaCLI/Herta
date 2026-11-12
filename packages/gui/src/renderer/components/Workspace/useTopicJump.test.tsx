import type { TerminalRecord } from "@herta/app-server";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HertaBridgeProvider,
  useHertaBridge,
} from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { type SessionStore, shownWindow } from "../../store/session-store.js";
import { Conversation } from "./Conversation.js";
import { WorkspaceRefsProvider } from "./WorkspaceRefs.js";

// A chat of plain messages: each weighs ten and opens a turn, so a window's
// weight (2 000) is 200 of them.
const blocks = (from: number, to: number): TerminalRecord =>
  Array.from({ length: to - from }, (_, i) => ({
    kind: "user" as const,
    text: `m${from + i}`,
  }));

/** A session of `total` messages whose window opens on its last ten. With
 *  `answers` false main has nothing to say to a jump (a fake, the demo). */
function open(total = 1000, answers = true) {
  const full: Array<TerminalRecord[number]> = [...blocks(0, total)];
  const mock = createMockHertaBridge(answers ? { fullRecord: full } : {});
  let store: SessionStore | null = null;
  const Probe = (): null => {
    store = useHertaBridge().sessionStore;
    return null;
  };
  const { container } = renderWithLocale(
    <WorkspaceRefsProvider>
      <HertaBridgeProvider bridge={mock.bridge}>
        <Probe />
        <Conversation />
      </HertaBridgeProvider>
    </WorkspaceRefsProvider>,
  );
  act(() => {
    mock.emitReset({
      sessionId: "s",
      workspaceRoot: "/r",
      record: full.slice(total - 10),
      recordStart: total - 10,
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
  });
  const snap = () => (store as unknown as SessionStore).getSnapshot();
  return {
    mock,
    container,
    full,
    store: () => store as unknown as SessionStore,
    jump: (index: number): void => {
      act(() => (store as unknown as SessionStore).requestJump("s", index));
    },
    // The window the chat shows, and whether it is the trailing one.
    start: (): number => shownWindow(snap()).start,
    end: (): number =>
      shownWindow(snap()).start + shownWindow(snap()).record.length,
    live: (): boolean => snap().away === null,
    rows: (): number => container.querySelectorAll("[data-abs-index]").length,
  };
}

describe("a jump outside the loaded window", () => {
  let scrolled: Array<{ el: Element; behavior: string | undefined }>;

  beforeEach(() => {
    scrolled = [];
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => undefined;
    }
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
      this: Element,
      arg?: boolean | ScrollIntoViewOptions,
    ) {
      scrolled.push({
        el: this,
        behavior: typeof arg === "object" ? arg.behavior : undefined,
      });
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("near the window: one call, the blocks between join it, and the row is glided to", async () => {
    const s = open();
    s.jump(900);
    await waitFor(() => expect(s.start()).toBe(900));
    expect(s.mock.calls.recordWindow).toEqual([
      ["s", { kind: "jump", start: 990, end: 1000, to: 900 }],
    ]);
    expect(s.mock.calls.recordSlice).toEqual([]);
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect(scrolled[0]?.el.getAttribute("data-abs-index")).toBe("900");
    expect(scrolled[0]?.behavior).toBe("smooth");
    // Still the live window: no way back is needed, and none is offered.
    expect(s.live()).toBe(true);
    expect(screen.queryByText("Load later entries")).not.toBeInTheDocument();
    expect(screen.queryByText("Back to latest")).not.toBeInTheDocument();
  });

  it("far from it: a window around the target, not the 950 messages between (owner 2026-11-12)", async () => {
    const s = open();
    s.jump(40);
    await waitFor(() => expect(s.start()).toBe(0));
    // The old answer was every block from 40 to 990, mounted. This is 190.
    expect(s.end()).toBe(190);
    expect(s.rows()).toBe(190);
    expect(s.live()).toBe(false);
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect(scrolled[0]?.el.getAttribute("data-abs-index")).toBe("40");
    // The window was swapped: there is nothing to glide across.
    expect(scrolled[0]?.behavior).toBe("auto");
    expect(screen.queryByText("m995")).not.toBeInTheDocument();
    expect(screen.getByText("Load later entries")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Back to latest")).toBeInTheDocument(),
    );
  });

  it("Back to latest shows the trailing window again, with no call to main, and the chip's other name goes", async () => {
    const s = open();
    s.jump(40);
    await waitFor(() => expect(s.live()).toBe(false));
    const chip = await screen.findByText("Back to latest");
    await act(async () => {
      fireEvent.click(chip);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(s.live()).toBe(true);
    // The window the session opened on, kept all along.
    expect(s.start()).toBe(990);
    expect(s.end()).toBe(1000);
    expect(screen.getByText("m999")).toBeInTheDocument();
    expect(screen.queryByText("m40")).not.toBeInTheDocument();
    expect(screen.queryByText("Load later entries")).not.toBeInTheDocument();
    expect(s.mock.calls.recordWindow.map(([, r]) => r.kind)).toEqual(["jump"]);
  });

  it("Load later reads on from the history, and where it meets the trailing window the row goes", async () => {
    const s = open();
    s.jump(400);
    await waitFor(() => expect(s.start()).toBe(350));
    expect(s.end()).toBe(550);
    const page = async (): Promise<void> => {
      await act(async () => {
        fireEvent.click(screen.getByText("Load later entries"));
        await new Promise((r) => setTimeout(r, 0));
      });
    };
    await page();
    expect(s.end()).toBe(750);
    expect(s.start()).toBe(350);
    expect(screen.getByText("m749")).toBeInTheDocument();
    await page();
    await page();
    expect(s.end()).toBe(1000);
    expect(s.live()).toBe(true);
    expect(screen.queryByText("Load later entries")).not.toBeInTheDocument();
    expect(screen.queryByText("Back to latest")).not.toBeInTheDocument();
  });

  it("away from the live end the chat shows history only: no live block, no rewind on its last message", async () => {
    const s = open();
    // On the tail, the last message carries the rewind control.
    expect(s.container.querySelectorAll(".message-rewind")).toHaveLength(1);
    s.jump(40);
    await waitFor(() => expect(s.live()).toBe(false));
    // The window's last message is not the session's last.
    expect(s.container.querySelectorAll(".message-rewind")).toHaveLength(0);
    // A block written meanwhile is not drawn under last month's history: it
    // joins the trailing window, which is not on screen…
    const fresh = { kind: "user" as const, text: "written meanwhile" };
    s.full.push(fresh);
    s.mock.setFullRecord(s.full);
    act(() =>
      s.mock.emitRecord({ kind: "block", blockId: "fresh", block: fresh }),
    );
    expect(screen.queryByText("written meanwhile")).not.toBeInTheDocument();
    expect(s.end()).toBe(190);
    expect(s.store().getSnapshot().record.at(-1)).toEqual(fresh);
    // Back at the latest it is there, once, with the rewind control.
    await act(async () => {
      fireEvent.click(screen.getByText("Back to latest"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getAllByText("written meanwhile")).toHaveLength(1);
    expect(s.container.querySelectorAll(".message-rewind")).toHaveLength(1);
  });

  it("her reply as it streams is not drawn under a window of history, and is there again at the latest", async () => {
    const s = open();
    const delta = (text: string): void => {
      act(() => {
        s.mock.emitAgent({
          kind: "agent",
          event: { type: "assistant.delta", layer: "actor", text } as never,
        });
      });
    };
    act(() => s.mock.emitTurn({ kind: "started", turnId: "t1" }));
    delta("She is mid-sentence");
    // The control: on the tail the reply is on screen as it streams.
    await screen.findByTestId("streaming-bubble");
    s.jump(40);
    await waitFor(() => expect(s.live()).toBe(false));
    expect(screen.queryByTestId("streaming-bubble")).not.toBeInTheDocument();
    // The turn itself goes on: the store still holds what she has said.
    delta(", and goes on.");
    expect(s.store().getSnapshot().streamingText).toBe(
      "She is mid-sentence, and goes on.",
    );
    expect(screen.queryByTestId("streaming-bubble")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText("Back to latest"));
      await new Promise((r) => setTimeout(r, 0));
    });
    await screen.findByTestId("streaming-bubble");
  });

  it("a block already in the window asks main for nothing", async () => {
    const s = open();
    s.jump(995);
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect(s.mock.calls.recordWindow).toEqual([]);
    expect(s.mock.calls.recordSlice).toEqual([]);
  });

  it("an answer that does not come leaves the reader where they are", async () => {
    const s = open(1000, false);
    s.jump(40);
    await waitFor(() => expect(s.mock.calls.recordWindow).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(s.start()).toBe(990);
    expect(s.live()).toBe(true);
    expect(scrolled).toEqual([]);
  });
});
