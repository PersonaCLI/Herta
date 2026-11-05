import type { TerminalRecord } from "@herta/app-server";
import { RECORD_WINDOW_WEIGHT } from "@herta/core/record-window";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HertaBridgeProvider,
  useHertaBridge,
} from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import type { SessionStore } from "../../store/session-store.js";
import { Conversation } from "./Conversation.js";
import { WorkspaceRefsProvider } from "./WorkspaceRefs.js";

const blocks = (from: number, to: number): TerminalRecord =>
  Array.from({ length: to - from }, (_, i) => ({
    kind: "user" as const,
    text: `m${from + i}`,
  }));

/** A session whose window opens at block 900 of a chat of messages. */
function open(slice?: { start: number; blocks: TerminalRecord }) {
  const mock = createMockHertaBridge(
    slice !== undefined ? { recordSliceResult: slice } : {},
  );
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
      record: blocks(900, 910),
      recordStart: 900,
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
  });
  return {
    mock,
    container,
    jump: (index: number): void => {
      act(() => (store as unknown as SessionStore).requestJump("s", index));
    },
    start: (): number =>
      (store as unknown as SessionStore).getSnapshot().recordStart,
  };
}

describe("a jump above the loaded window (review 2026-11-05)", () => {
  let scrolled: Element[];

  beforeEach(() => {
    scrolled = [];
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => undefined;
    }
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
      this: Element,
    ) {
      scrolled.push(this);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("asks for the block itself, once, and lands on its row", async () => {
    const s = open({ start: 40, blocks: blocks(40, 900) });
    s.jump(40);
    await waitFor(() => expect(s.start()).toBe(40));
    expect(s.mock.calls.recordSlice).toEqual([
      ["s", 900, RECORD_WINDOW_WEIGHT, 40],
    ]);
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect(scrolled[0]?.getAttribute("data-abs-index")).toBe("40");
  });

  it("a block already in the window asks main for nothing", async () => {
    const s = open();
    s.jump(905);
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect(s.mock.calls.recordSlice).toEqual([]);
  });

  it("a slice that does not come leaves the reader where they are", async () => {
    const s = open({ start: 0, blocks: [] });
    s.jump(40);
    await waitFor(() => expect(s.mock.calls.recordSlice).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(s.start()).toBe(900);
    expect(scrolled).toEqual([]);
  });
});
