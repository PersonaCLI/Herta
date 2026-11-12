import type { AgentEvent } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";
import { SessionStore, shownWindow } from "./session-store.js";

function deltaEvent(text: string): AgentEvent {
  // assistant.delta carries streamed text; field name confirmed as `text` in events.ts.
  return { type: "assistant.delta", layer: "actor", text } as AgentEvent;
}

function backendDeltaEvent(text: string): AgentEvent {
  return { type: "assistant.delta", layer: "backend", text } as AgentEvent;
}

describe("SessionStore — the held message (ADR 0063)", () => {
  it("a second hold goes through the join it is given (the composer's keeps quotes in front)", () => {
    const store = new SessionStore();
    store.connect(createMockHertaBridge().bridge);
    store.holdMessage("one", () => "unused");
    store.holdMessage("two", (prev, next) => `${next}+${prev}`);
    expect(store.getSnapshot().held).toBe("two+one");
  });

  it("holds one message; a second send joins it as a paragraph; clear and a new activation drop it", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    expect(store.getSnapshot().held).toBeNull();
    store.holdMessage("also rename the test file");
    expect(store.getSnapshot().held).toBe("also rename the test file");
    store.holdMessage("and bump the version");
    expect(store.getSnapshot().held).toBe(
      "also rename the test file\n\nand bump the version",
    );
    store.clearHeld();
    expect(store.getSnapshot().held).toBeNull();
    // Idempotent: clearing nothing emits nothing new.
    store.clearHeld();
    store.holdMessage("x");
    mock.emitReset({
      sessionId: "s2",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    // A message held for one session's turn never travels to another.
    expect(store.getSnapshot().held).toBeNull();
  });

  it("the lift-off point is a side channel read exactly once: armed, taken, then gone", () => {
    const store = new SessionStore();
    expect(store.takeLaunch()).toBeNull();
    store.armLaunch({ left: 120, top: 640 });
    expect(store.takeLaunch()).toEqual({ left: 120, top: 640 });
    // Consumed: a later send never inherits a stale point.
    expect(store.takeLaunch()).toBeNull();
    // Arming null (an ordinary send) clears whatever was left.
    store.armLaunch({ left: 1, top: 2 });
    store.armLaunch(null);
    expect(store.takeLaunch()).toBeNull();
  });
});

describe("SessionStore — a reset that lands mid-turn (UX review 2026-09-22, item 7)", () => {
  it("a window that reloads during 板砖's run comes back busy, in the hold window, with its staged pictures", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s",
      workspaceRoot: "/r",
      record: [{ kind: "user", text: "fix it @板砖" }],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
      turn: { backendActive: true },
      stagedImages: [{ id: "i1", name: "shot.png", path: "a/shot.png" }],
    });
    const s = store.getSnapshot();
    // Pre-fix every reset was idle: no Stop over a running turn.
    expect(s.status).not.toBe("idle");
    expect(s.backendActive).toBe(true);
    expect(s.turnStartedAt).not.toBeNull();
    expect(s.backendStartedAt).not.toBeNull();
    expect(s.restagedImages).toEqual([
      { id: "i1", name: "shot.png", path: "a/shot.png" },
    ]);
    store.clearRestagedImages();
    expect(store.getSnapshot().restagedImages).toBeNull();
    // The turn's own end still settles it the ordinary way.
    mock.emitTurn({ kind: "finished", turnId: "t-unknown" });
    expect(store.getSnapshot().status).toBe("idle");
  });

  it("connecting asks main for the state — a reloaded page's first reset can have gone out before it subscribed", () => {
    const mock = createMockHertaBridge();
    let asked = 0;
    Object.assign(mock.bridge, {
      requestSessionSync: async () => {
        asked += 1;
      },
    });
    const store = new SessionStore();
    store.connect(mock.bridge);
    expect(asked).toBe(1);
  });

  it("an ordinary reset (no turn in flight) is idle, as before", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    const s = store.getSnapshot();
    expect(s.status).toBe("idle");
    expect(s.backendActive).toBe(false);
    expect(s.restagedImages).toBeNull();
  });
});

describe("SessionStore", () => {
  it("starts idle/empty", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    const s = store.getSnapshot();
    expect(s.sessionId).toBeNull();
    expect(s.record).toEqual([]);
    expect(s.streamingText).toBeNull();
    expect(s.status).toBe("idle");
    expect(s.error).toBeNull();
  });

  it("clears a stranded approval overlay when the turn fails (safety net)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitOverlay({
      kind: "pending",
      overlay: {
        kind: "pending-permission",
        requestId: "req-1",
        risk: "network",
        tool: "run_command",
        summary: "x",
      },
    });
    expect(store.getSnapshot().overlay).not.toBeNull();
    // The turn dies mid-gate and NO `resolved` event ever arrives. Without the
    // safety net the overlay was permanent: composer suppressed, session
    // switching and new-session blocked — only an app restart escaped.
    mock.emitTurn({
      kind: "failed",
      turnId: "t1",
      error: { code: "actor_failed", message: "boom" },
    });
    expect(store.getSnapshot().overlay).toBeNull();
    expect(store.getSnapshot().status).toBe("idle");
  });

  it("clears a stranded approval overlay when the turn finishes (dropped resolved event)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitOverlay({
      kind: "pending",
      overlay: {
        kind: "pending-permission",
        requestId: "req-1",
        risk: "workspace_write",
        tool: "edit_file",
        summary: "x",
      },
    });
    mock.emitTurn({ kind: "finished", turnId: "t1" });
    expect(store.getSnapshot().overlay).toBeNull();
  });

  it("counts in-flight backend tool calls for the parallel-batch shimmer (2026-07-23)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    const agent = (event: unknown) =>
      mock.emitAgent({ kind: "agent", event: event as never });
    agent({ type: "turn.started", layer: "backend", userText: "x" });
    expect(store.getSnapshot().backendInFlight).toBe(0);
    agent({
      type: "tool.call.started",
      layer: "backend",
      id: "a",
      tool: "read_file",
      inputSummary: "a.ts",
    });
    agent({
      type: "tool.call.started",
      layer: "backend",
      id: "b",
      tool: "glob",
      inputSummary: "**/*.ts",
    });
    expect(store.getSnapshot().backendInFlight).toBe(2);
    agent({
      type: "tool.call.finished",
      layer: "backend",
      id: "a",
      tool: "read_file",
      result: { ok: true, summary: "read" },
    });
    expect(store.getSnapshot().backendInFlight).toBe(1);
    // Turn end clears the count (a lost finished event can't strand it).
    agent({ type: "turn.finished", layer: "backend", summary: {} });
    expect(store.getSnapshot().backendInFlight).toBe(0);
    store.dispose();
  });

  it("folds supervisor.check start/end and clears it on turn end (safety net)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitAgent({
      kind: "agent",
      event: {
        type: "supervisor.check",
        layer: "actor",
        phase: "start",
      } as never,
    });
    expect(store.getSnapshot().supervisorChecking).toBe(true);
    mock.emitAgent({
      kind: "agent",
      event: {
        type: "supervisor.check",
        layer: "actor",
        phase: "end",
      } as never,
    });
    expect(store.getSnapshot().supervisorChecking).toBe(false);
    // Safety net: a dropped `end` can't linger past the turn.
    mock.emitAgent({
      kind: "agent",
      event: {
        type: "supervisor.check",
        layer: "actor",
        phase: "start",
      } as never,
    });
    mock.emitTurn({ kind: "finished", turnId: "t1" });
    expect(store.getSnapshot().supervisorChecking).toBe(false);
    store.dispose();
  });

  it("turn.started clears a stranded recapCompacting like its supervisorChecking sibling (review 2026-07-31)", () => {
    // Both flags ride dropped-end-event safety nets; recapCompacting was the
    // one sibling the turn.started list missed — a strand (end AND the
    // turn-end events all lost) showed the recap row where the galaxy
    // belongs for the whole next turn.
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitAgent({
      kind: "agent",
      event: {
        type: "recap.compaction",
        layer: "actor",
        phase: "start",
      } as never,
    });
    expect(store.getSnapshot().recapCompacting).toBe(true);
    // Everything after it drops; the next turn must start clean.
    mock.emitTurn({ kind: "started", turnId: "t2" });
    expect(store.getSnapshot().recapCompacting).toBe(false);
    store.dispose();
  });

  it("reset replaces record/sessionId/overlay and clears streaming", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s-1",
      workspaceRoot: "/r",
      record: [{ kind: "user", text: "hi" }],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    const s = store.getSnapshot();
    expect(s.sessionId).toBe("s-1");
    expect(s.record).toHaveLength(1);
    expect(s.status).toBe("idle");
  });

  it("a record reset (rewind) preserves the existing per-index `at` when the reset blocks lack one", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    // Three timestamped blocks arrive via the live stream (as the GUI gets them).
    mock.emitRecord({
      kind: "block",
      blockId: "b1",
      block: { kind: "user", text: "u1", at: "2026-06-21T01:00:00.000Z" },
    });
    mock.emitRecord({
      kind: "block",
      blockId: "b2",
      block: {
        kind: "herta",
        surface: "speech",
        text: "h1",
        at: "2026-06-21T01:00:05.000Z",
      },
    });
    mock.emitRecord({
      kind: "block",
      blockId: "b3",
      block: { kind: "user", text: "u2", at: "2026-06-21T01:01:00.000Z" },
    });
    // Rewind: the server resets to the first two blocks, but its IN-MEMORY copies
    // carry NO `at` (only the streamed/persisted copies were stamped).
    mock.emitRecord({
      kind: "reset",
      record: [
        { kind: "user", text: "u1" },
        { kind: "herta", surface: "speech", text: "h1" },
      ],
    });
    const rec = store.getSnapshot().record;
    expect(rec).toHaveLength(2);
    // The surviving bubbles keep the timestamps the GUI already displayed.
    expect((rec[0] as { at?: string }).at).toBe("2026-06-21T01:00:00.000Z");
    expect((rec[1] as { at?: string }).at).toBe("2026-06-21T01:00:05.000Z");
  });

  it("blanks the active view when its own session is deleted", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s1",
      workspaceRoot: "/r",
      record: [{ kind: "user", text: "hi" }],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    expect(store.getSnapshot().sessionId).toBe("s1");
    mock.emitSessionDeleted({ sessionId: "s1" });
    expect(store.getSnapshot().sessionId).toBeNull();
    expect(store.getSnapshot().record).toEqual([]);
  });

  it("ignores deletion of a non-active session", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s1",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    mock.emitSessionDeleted({ sessionId: "other" });
    expect(store.getSnapshot().sessionId).toBe("s1");
  });

  it("reset with error sets the error field", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({ error: "DeepSeek API key not found" });
    expect(store.getSnapshot().error).toBe("DeepSeek API key not found");
    expect(store.getSnapshot().bootstrapped).toBe(false);
  });

  it("appends record blocks in order", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitRecord({
      kind: "block",
      blockId: "b1",
      block: { kind: "user", text: "a" },
    });
    mock.emitRecord({
      kind: "block",
      blockId: "b2",
      block: { kind: "user", text: "b" },
    });
    expect(
      store.getSnapshot().record.map((b) => (b as { text: string }).text),
    ).toEqual(["a", "b"]);
  });

  it("accumulates assistant.delta into streamingText and sets speaking", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    expect(store.getSnapshot().status).toBe("thinking");
    mock.emitAgent({ kind: "agent", event: deltaEvent("Certainly") });
    mock.emitAgent({ kind: "agent", event: deltaEvent(", Herta.") });
    const s = store.getSnapshot();
    expect(s.streamingText).toBe("Certainly, Herta.");
    expect(s.status).toBe("speaking");
  });

  it("markPendingUser echoes the message, cleared when the user block lands", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    store.markPendingUser("你好呀 黑塔");
    expect(store.getSnapshot().pendingUser).toBe("你好呀 黑塔");
    // The turn's real user RecordEvent supersedes the optimistic echo.
    mock.emitRecord({
      kind: "block",
      blockId: "u1",
      block: { kind: "user", text: "你好呀 黑塔" },
    });
    expect(store.getSnapshot().pendingUser).toBeNull();
    expect(store.getSnapshot().record).toHaveLength(1);
  });

  describe("two messages to Herta before the first has landed (review 2026-11-05, N3)", () => {
    const land = (
      mock: ReturnType<typeof createMockHertaBridge>,
      text: string,
      extra: { duringRun?: true; steer?: true } = { duringRun: true },
    ): void => {
      mock.emitRecord({
        kind: "block",
        blockId: text,
        block: { kind: "user", text, ...extra },
      });
    };
    const setup = () => {
      const mock = createMockHertaBridge();
      const store = new SessionStore();
      store.connect(mock.bridge);
      return { mock, store };
    };

    it("the second waits behind the first, and moves up when the first lands", () => {
      const { mock, store } = setup();
      store.markPendingTalk("一", ["a.ts"]);
      store.markPendingTalk("二", ["b.ts"]);
      expect(store.getSnapshot().pendingUser).toBe("一");
      expect(store.getSnapshot().pendingUserMentions).toEqual(["a.ts"]);
      expect(store.getSnapshot().pendingTalk.map((p) => p.text)).toEqual([
        "二",
      ]);
      land(mock, "一");
      expect(store.getSnapshot().pendingUser).toBe("二");
      expect(store.getSnapshot().pendingUserMentions).toEqual(["b.ts"]);
      expect(store.getSnapshot().pendingTalk).toEqual([]);
      land(mock, "二");
      expect(store.getSnapshot().pendingUser).toBeNull();
      expect(store.getSnapshot().pendingUserMentions).toBeNull();
    });

    it("the same words twice are two messages", () => {
      const { mock, store } = setup();
      store.markPendingTalk("好");
      store.markPendingTalk("好");
      land(mock, "好");
      expect(store.getSnapshot().pendingUser).toBe("好");
      land(mock, "好");
      expect(store.getSnapshot().pendingUser).toBeNull();
    });

    it("a steer landing takes no echo", () => {
      const { mock, store } = setup();
      store.markPendingTalk("问她的");
      land(mock, "说给板砖的", { steer: true });
      expect(store.getSnapshot().pendingUser).toBe("问她的");
    });

    it("a message the run could no longer take leaves the other's echo", () => {
      const { store } = setup();
      store.markPendingTalk("一");
      store.markPendingTalk("二");
      store.withdrawPendingUser("二");
      expect(store.getSnapshot().pendingUser).toBe("一");
      expect(store.getSnapshot().pendingTalk).toEqual([]);
      store.markPendingTalk("三");
      store.withdrawPendingUser("一");
      expect(store.getSnapshot().pendingUser).toBe("三");
    });

    it("the turn's end clears them all", () => {
      const { mock, store } = setup();
      store.markPendingTalk("一");
      store.markPendingTalk("二");
      mock.emitTurn({ kind: "finished", turnId: "t1" });
      expect(store.getSnapshot().pendingUser).toBeNull();
      expect(store.getSnapshot().pendingTalk).toEqual([]);
    });
  });

  it("clears a dangling pendingUser echo on turn failed", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    store.markPendingUser("oops");
    mock.emitTurn({
      kind: "failed",
      turnId: "t1",
      error: { code: "x", message: "y" },
    });
    expect(store.getSnapshot().pendingUser).toBeNull();
  });

  // ── Pictures ride their carrier (ADR 0048 §4) ─────────────────────────────
  // The emit guard clears each image list the moment its carrier clears, no
  // matter which of the many clearing sites fired — pinned per carrier here.
  describe("picture-carrier emit guard", () => {
    const img = { id: "i1", name: "shot.png", path: ".herta/a/shot.png" };

    it("echo images clear WITH the echo when the user block lands", () => {
      const mock = createMockHertaBridge();
      const store = new SessionStore();
      store.connect(mock.bridge);
      store.markPendingUser("看看这个", [img]);
      expect(store.getSnapshot().pendingUserImages).toEqual([img]);
      mock.emitRecord({
        kind: "block",
        blockId: "u1",
        block: { kind: "user", text: "看看这个" },
      });
      expect(store.getSnapshot().pendingUserImages).toBeNull();
    });

    it("echo images clear on turn failed (a site that never mentions them)", () => {
      const mock = createMockHertaBridge();
      const store = new SessionStore();
      store.connect(mock.bridge);
      store.markPendingUser("oops", [img]);
      mock.emitTurn({
        kind: "failed",
        turnId: "t1",
        error: { code: "x", message: "y" },
      });
      expect(store.getSnapshot().pendingUserImages).toBeNull();
    });

    it("withdrawPendingUser moves the pictures to the composer draft", () => {
      const store = new SessionStore();
      store.markPendingUser("failed send", [img]);
      store.withdrawPendingUser("failed send", [img]);
      const s = store.getSnapshot();
      expect(s.pendingUser).toBeNull();
      expect(s.pendingUserImages).toBeNull();
      expect(s.composerDraft).toBe("failed send");
      expect(s.composerDraftImages).toEqual([img]);
    });

    it("clearComposerDraft drops the draft images with the draft", () => {
      const store = new SessionStore();
      store.requestComposerDraft("text", null, [img]);
      expect(store.getSnapshot().composerDraftImages).toEqual([img]);
      store.clearComposerDraft();
      expect(store.getSnapshot().composerDraftImages).toBeNull();
    });

    it("requestKeyPrompt moves the pictures from the echo to the hold; closing drops them", () => {
      const store = new SessionStore();
      store.markPendingUser("no key yet", [img]);
      store.requestKeyPrompt("no key yet", [img]);
      const held = store.getSnapshot();
      expect(held.pendingUser).toBeNull();
      expect(held.pendingUserImages).toBeNull();
      expect(held.needsKeyImages).toEqual([img]);
      store.clearKeyPrompt();
      expect(store.getSnapshot().needsKeyImages).toBeNull();
    });

    it("a rewind draft carries NO images by default (its stored copies are GC'd)", () => {
      const store = new SessionStore();
      store.requestComposerDraft("rewound text", "warning");
      expect(store.getSnapshot().composerDraftImages).toBeNull();
    });
  });

  it("ignores backend-layer deltas (they must not enter Herta's speech bubble)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitAgent({ kind: "agent", event: backendDeltaEvent("rm -rf /") });
    const s = store.getSnapshot();
    expect(s.streamingText).toBeNull();
    expect(s.status).toBe("idle");
  });

  it("clears streamingText when the finalized herta block arrives", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitAgent({ kind: "agent", event: deltaEvent("partial") });
    mock.emitRecord({
      kind: "block",
      blockId: "h1",
      block: { kind: "herta", surface: "speech", text: "partial done" },
    });
    const s = store.getSnapshot();
    expect(s.streamingText).toBeNull();
    expect(s.record).toHaveLength(1);
  });

  it("drops actor deltas outside a turn (cross-channel tail delta must not resurrect a phantom bubble)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitAgent({ kind: "agent", event: deltaEvent("live") });
    expect(store.getSnapshot().streamingText).toBe("live");
    mock.emitTurn({ kind: "finished", turnId: "t1" });
    // A tail delta pumped AFTER the cross-channel turn.finished: nothing
    // will ever clear a bubble it creates — it must be dropped.
    mock.emitAgent({ kind: "agent", event: deltaEvent("stale tail") });
    const s = store.getSnapshot();
    expect(s.streamingText).toBeNull();
    expect(s.status).toBe("idle");
  });

  it("trimRecordWindow drops the oldest blocks and advances recordStart (audit T3.5)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    for (let i = 0; i < 6; i++) {
      mock.emitRecord({
        kind: "block",
        blockId: `u${i}`,
        block: { kind: "user", text: `m${i}` },
      });
    }
    expect(store.getSnapshot().record).toHaveLength(6);
    store.trimRecordWindow(4);
    const s = store.getSnapshot();
    expect(s.record).toHaveLength(4);
    expect(s.recordStart).toBe(2);
    expect((s.record[0] as { text: string }).text).toBe("m2");
    // Under the bound: a no-op that emits nothing.
    const before = store.getSnapshot();
    store.trimRecordWindow(10);
    expect(store.getSnapshot()).toBe(before);
  });

  it("turn finished returns to idle", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitTurn({ kind: "finished", turnId: "t1" });
    expect(store.getSnapshot().status).toBe("idle");
  });

  it("getSnapshot is referentially stable between changes", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    const a = store.getSnapshot();
    const b = store.getSnapshot();
    expect(a).toBe(b);
    mock.emitRecord({
      kind: "block",
      blockId: "b1",
      block: { kind: "user", text: "x" },
    });
    expect(store.getSnapshot()).not.toBe(a);
  });

  it("retract keeps the vetoed text; retry deltas accumulate into retryText", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "候选" } as never,
    });
    mock.emitSpeech({ kind: "retract" });
    expect(store.getSnapshot().retracting).toBe(true);
    expect(store.getSnapshot().streamingText).toBe("候选"); // shrink source, kept
    expect(store.getSnapshot().retryText).toBeNull();
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "候" } as never,
    });
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "补" } as never,
    });
    // Deltas during a retract are the RETRY's tokens: they buffer into
    // retryText; the vetoed text and the retracting flag stay put (the
    // component's morph owns the display).
    expect(store.getSnapshot().retracting).toBe(true);
    expect(store.getSnapshot().streamingText).toBe("候选");
    expect(store.getSnapshot().retryText).toBe("候补");
    expect(store.getSnapshot().status).toBe("speaking");
  });

  it("a re-entrant retract mid-morph is IGNORED (in-flight morph keeps its state)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "候选" } as never,
    });
    mock.emitSpeech({ kind: "retract" });
    mock.emitSpeech({ kind: "retractFloor", keepLen: 1 });
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "重写" } as never,
    });
    // A second retract while retracting (unreachable today; guarded anyway)
    // must NOT discard the buffered retry or the floor — the morph is keyed
    // on the retracting boolean and could not re-seed either way.
    mock.emitSpeech({ kind: "retract" });
    const s = store.getSnapshot();
    expect(s.retracting).toBe(true);
    expect(s.retryText).toBe("重写");
    expect(s.retractKeepLen).toBe(1);
  });

  it("a dropped speech-channel sentinel blanks the live view (a retract may have been lost)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "候选" } as never,
    });
    mock.emitSpeech({ kind: "dropped", count: 2 } as never);
    const s = store.getSnapshot();
    // Blanked rather than risking retry deltas fusing onto the vetoed text;
    // the finalized block re-renders the truth at commit.
    expect(s.streamingText).toBeNull();
    expect(s.retracting).toBe(false);
    expect(s.retryText).toBeNull();
  });

  it("a dropped record-channel sentinel requests a record heal, folded as an ordinary reset", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitRecord({
      kind: "block",
      blockId: "b1",
      block: { kind: "user", text: "在吗" },
    });
    // A block was lost to queue overflow: this mirror has a permanent hole.
    // The store must ask main to re-emit the full record...
    mock.emitRecord({ kind: "dropped", count: 1 });
    expect(mock.calls.resyncRecord).toBe(1);
    // ...which arrives back as an ordinary reset ON the record channel (FIFO
    // with block events — see BusActorStreamingSink.resyncRecord) and heals
    // the hole via the existing reset fold.
    mock.emitRecord({
      kind: "reset",
      record: [
        { kind: "user", text: "在吗" },
        { kind: "herta", surface: "speech", text: "在。" },
        { kind: "user", text: "后续" },
      ],
    });
    const s = store.getSnapshot();
    expect(s.record).toHaveLength(3);
    expect(s.record[1]).toMatchObject({ kind: "herta", text: "在。" });
    store.dispose();
  });

  it("a finalized herta block clears all retract state", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "候选" } as never,
    });
    mock.emitSpeech({ kind: "retract" });
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "修订" } as never,
    });
    mock.emitRecord({
      kind: "block",
      blockId: "h1",
      block: { kind: "herta", surface: "speech", text: "修订" },
    });
    expect(store.getSnapshot().streamingText).toBeNull();
    expect(store.getSnapshot().retracting).toBe(false);
    expect(store.getSnapshot().retryText).toBeNull();
  });

  it("turn.finished mid-retract clears the lingering vetoed bubble (empty retry)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "候选" } as never,
    });
    mock.emitSpeech({ kind: "retract" });
    mock.emitTurn({ kind: "finished", turnId: "t1" });
    expect(store.getSnapshot().streamingText).toBeNull();
    expect(store.getSnapshot().retracting).toBe(false);
    expect(store.getSnapshot().retryText).toBeNull();
  });

  it("turn.started clears stale retract state so new deltas stream normally", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "候选" } as never,
    });
    mock.emitSpeech({ kind: "retract" });
    // turn.finished was dropped/reordered; the next turn starts anyway.
    mock.emitTurn({ kind: "started", turnId: "t2" });
    expect(store.getSnapshot().retracting).toBe(false);
    expect(store.getSnapshot().retryText).toBeNull();
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "新轮" } as never,
    });
    expect(store.getSnapshot().streamingText).toBe("新轮");
    expect(store.getSnapshot().retryText).toBeNull();
  });

  it("a system block mid-retract leaves retract state untouched", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "候选" } as never,
    });
    mock.emitSpeech({ kind: "retract" });
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "修" } as never,
    });
    // Backend work can project a system block while a beat's speech is
    // being retracted — it must not disturb the morph's state.
    mock.emitRecord({
      kind: "block",
      blockId: "s1",
      block: { kind: "system", label: "差分协处理器", body: "Reading a.ts" },
    });
    expect(store.getSnapshot().retracting).toBe(true);
    expect(store.getSnapshot().streamingText).toBe("候选");
    expect(store.getSnapshot().retryText).toBe("修");
  });

  it("clears all retract state if the turn fails mid-retract", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "候选" } as never,
    });
    mock.emitSpeech({ kind: "retract" });
    mock.emitAgent({
      kind: "agent",
      event: { type: "assistant.delta", layer: "actor", text: "新" } as never,
    });
    mock.emitTurn({
      kind: "failed",
      turnId: "t1",
      error: { code: "x", message: "y" },
    });
    expect(store.getSnapshot().streamingText).toBeNull();
    expect(store.getSnapshot().retracting).toBe(false);
    expect(store.getSnapshot().retryText).toBeNull();
  });

  it("retractFloor sets retractKeepLen while retracting; the NEXT cycle's retract starts clean", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    expect(store.getSnapshot().retractKeepLen).toBeNull();
    mock.emitSpeech({ kind: "retract" });
    expect(store.getSnapshot().retractKeepLen).toBeNull();
    mock.emitSpeech({ kind: "retractFloor", keepLen: 4 });
    expect(store.getSnapshot().retractKeepLen).toBe(4);
    // The cycle ends (retry block commits, clearing retract state); a fresh
    // retract in a LATER iteration then starts with no stale floor. (A retract
    // arriving mid-morph is ignored — see the re-entrant guard test.)
    mock.emitRecord({
      kind: "block",
      blockId: "h1",
      block: { kind: "herta", surface: "speech", text: "修订" },
    });
    mock.emitSpeech({ kind: "retract" });
    expect(store.getSnapshot().retracting).toBe(true);
    expect(store.getSnapshot().retractKeepLen).toBeNull();
  });

  it("ignores a retractFloor that arrives when not retracting", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitSpeech({ kind: "retractFloor", keepLen: 4 });
    expect(store.getSnapshot().retractKeepLen).toBeNull();
  });

  it("a finalized herta block clears retractKeepLen", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitSpeech({ kind: "retract" });
    mock.emitSpeech({ kind: "retractFloor", keepLen: 4 });
    expect(store.getSnapshot().retractKeepLen).toBe(4);
    mock.emitRecord({
      kind: "block",
      blockId: "h1",
      block: { kind: "herta", surface: "speech", text: "修订" },
    });
    expect(store.getSnapshot().retractKeepLen).toBeNull();
  });

  it("tracks backendError across backend turn.failed / finished / actor turn start", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    // Failure sets it.
    mock.emitAgent({
      kind: "agent",
      event: {
        type: "turn.failed",
        layer: "backend",
        error: { kind: "tool_failed", message: "x" },
      } as AgentEvent,
    });
    expect(store.getSnapshot().backendError).toBe(true);
    // A new actor turn (user message) clears it.
    mock.emitTurn({ kind: "started", turnId: "t1" });
    expect(store.getSnapshot().backendError).toBe(false);
    // Fail again, then a clean backend finish clears it.
    mock.emitAgent({
      kind: "agent",
      event: {
        type: "turn.failed",
        layer: "backend",
        error: { kind: "tool_failed", message: "y" },
      } as AgentEvent,
    });
    expect(store.getSnapshot().backendError).toBe(true);
    mock.emitAgent({
      kind: "agent",
      event: {
        type: "turn.finished",
        layer: "backend",
        summary: {
          durationMs: 1,
          toolCallCount: 0,
          messageCount: 0,
          endedAt: "",
        },
      } as AgentEvent,
    });
    expect(store.getSnapshot().backendError).toBe(false);
  });

  it("does NOT flag backendError when the backend turn was INTERRUPTED (audit 2026-07-24, M2)", () => {
    // Stopping a dispatch deliberately used to leave the always-visible
    // 差分协处理器 card red until the next message, while the conversation
    // stayed (correctly) silent about it.
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitAgent({
      kind: "agent",
      event: {
        type: "turn.failed",
        layer: "backend",
        error: { kind: "interrupted", message: "turn aborted" },
      } as AgentEvent,
    });
    expect(store.getSnapshot().backendError).toBe(false);
    expect(store.getSnapshot().backendActive).toBe(false);
  });

  it("clears the turn-failure notice when a record reset withdraws the turn it describes (audit 2026-07-24, L2)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitTurn({
      kind: "failed",
      turnId: "t1",
      error: { code: "provider_error", message: "boom", status: 402 },
    });
    expect(store.getSnapshot().turnFailed).toBe(true);
    expect(store.getSnapshot().turnFailedStatus).toBe(402);
    // The rewind that withdraws that turn arrives as a record reset — the
    // notice must go with it, or it reads as "the rewind failed".
    mock.emitRecord({ kind: "reset", record: [], start: 0 });
    expect(store.getSnapshot().turnFailed).toBe(false);
    expect(store.getSnapshot().turnFailedStatus).toBeNull();
  });

  it("tracks backendActive across backend turn.started/finished", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitAgent({
      kind: "agent",
      event: {
        type: "turn.started",
        layer: "backend",
        userText: "",
      } as AgentEvent,
    });
    expect(store.getSnapshot().backendActive).toBe(true);
    mock.emitAgent({
      kind: "agent",
      event: {
        type: "turn.finished",
        layer: "backend",
        summary: {
          durationMs: 1,
          toolCallCount: 0,
          messageCount: 0,
          endedAt: "",
        },
      } as AgentEvent,
    });
    expect(store.getSnapshot().backendActive).toBe(false);
  });

  it("sets turnStartedAt on turn start and clears it on finish", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    expect(store.getSnapshot().turnStartedAt).toBeTypeOf("number");
    mock.emitTurn({ kind: "finished", turnId: "t1" });
    expect(store.getSnapshot().turnStartedAt).toBeNull();
  });

  it("sets backendStartedAt on backend turn.started and clears it on actor turn finished", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    // Initially null.
    expect(store.getSnapshot().backendStartedAt).toBeNull();
    // Backend turn starts — backendStartedAt is set to a timestamp.
    mock.emitAgent({
      kind: "agent",
      event: {
        type: "turn.started",
        layer: "backend",
        userText: "",
      } as AgentEvent,
    });
    expect(store.getSnapshot().backendStartedAt).toBeTypeOf("number");
    expect(store.getSnapshot().backendStartedAt).not.toBeNull();
    // Actor turn finished clears it.
    mock.emitTurn({ kind: "finished", turnId: "t1" });
    expect(store.getSnapshot().backendStartedAt).toBeNull();
  });

  it("clears backendStartedAt on actor turn started (new turn, no backend yet)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    // Set it via a backend turn start.
    mock.emitAgent({
      kind: "agent",
      event: {
        type: "turn.started",
        layer: "backend",
        userText: "",
      } as AgentEvent,
    });
    expect(store.getSnapshot().backendStartedAt).toBeTypeOf("number");
    // A new actor turn clears it.
    mock.emitTurn({ kind: "started", turnId: "t2" });
    expect(store.getSnapshot().backendStartedAt).toBeNull();
  });

  it("clears backendStartedAt on actor turn failed", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitAgent({
      kind: "agent",
      event: {
        type: "turn.started",
        layer: "backend",
        userText: "",
      } as AgentEvent,
    });
    expect(store.getSnapshot().backendStartedAt).toBeTypeOf("number");
    mock.emitTurn({
      kind: "failed",
      turnId: "t1",
      error: { code: "x", message: "y" },
    });
    expect(store.getSnapshot().backendStartedAt).toBeNull();
  });

  it("notifies subscribers on change and stops after unsubscribe + dispose", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    let n = 0;
    const unsub = store.subscribe(() => {
      n += 1;
    });
    mock.emitRecord({
      kind: "block",
      blockId: "b1",
      block: { kind: "user", text: "x" },
    });
    expect(n).toBe(1);
    unsub();
    mock.emitRecord({
      kind: "block",
      blockId: "b2",
      block: { kind: "user", text: "y" },
    });
    expect(n).toBe(1);
    store.dispose();
  });
});

describe("SessionStore — title", () => {
  it("reset carries a disk-loaded title without animating", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s-1",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      title: "已有标题",
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    const s = store.getSnapshot();
    expect(s.title).toBe("已有标题");
    expect(s.titleAnimate).toBe(false);
    store.dispose();
  });

  it("a title event sets the title and flags it to animate", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTitle({ kind: "title", sessionId: "s-1", title: "新标题" });
    const s = store.getSnapshot();
    expect(s.title).toBe("新标题");
    expect(s.titleAnimate).toBe(true);
    store.dispose();
  });
});

describe("SessionStore — backend workspace", () => {
  it("starts with no backend workspace", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    const s = store.getSnapshot();
    expect(s.backendWorkspace).toBeNull();
    expect(s.backendWorkspaceIsDefault).toBe(false);
    store.dispose();
  });

  it("reset carries the effective backend workspace + default flag", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s-1",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/home/u/project",
      backendWorkspaceIsDefault: false,
    });
    const s = store.getSnapshot();
    expect(s.backendWorkspace).toBe("/home/u/project");
    expect(s.backendWorkspaceIsDefault).toBe(false);
    store.dispose();
  });

  it("a live workspace event updates the effective workspace + default flag", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitWorkspace({
      kind: "workspace",
      workspace: "/new/ws",
      isDefault: false,
    });
    expect(store.getSnapshot().backendWorkspace).toBe("/new/ws");
    expect(store.getSnapshot().backendWorkspaceIsDefault).toBe(false);
    // Reset-to-default style event flips the flag back.
    mock.emitWorkspace({
      kind: "workspace",
      workspace: "/managed/default",
      isDefault: true,
    });
    expect(store.getSnapshot().backendWorkspace).toBe("/managed/default");
    expect(store.getSnapshot().backendWorkspaceIsDefault).toBe(true);
    store.dispose();
  });

  it("ignores the dropped overflow sentinel on the workspace channel", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitWorkspace({
      kind: "workspace",
      workspace: "/ws",
      isDefault: false,
    });
    mock.emitWorkspace({ kind: "dropped", count: 3 });
    expect(store.getSnapshot().backendWorkspace).toBe("/ws");
    expect(store.getSnapshot().backendWorkspaceIsDefault).toBe(false);
    store.dispose();
  });

  it("blanks the backend workspace when its own session is deleted", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s1",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/home/u/project",
      backendWorkspaceIsDefault: false,
    });
    mock.emitSessionDeleted({ sessionId: "s1" });
    expect(store.getSnapshot().backendWorkspace).toBeNull();
    expect(store.getSnapshot().backendWorkspaceIsDefault).toBe(false);
    store.dispose();
  });

  it("stops updating the workspace after disconnect", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    const disconnect = store.connect(mock.bridge);
    disconnect();
    mock.emitWorkspace({
      kind: "workspace",
      workspace: "/should-not-apply",
      isDefault: false,
    });
    expect(store.getSnapshot().backendWorkspace).toBeNull();
    store.dispose();
  });
});

describe("bootstrapped flag", () => {
  it("bootstrapped is false before any reset (fresh store)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    expect(store.getSnapshot().bootstrapped).toBe(false);
    store.dispose();
  });

  it("bootstrapped becomes true after a successful reset", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s1",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    const s = store.getSnapshot();
    expect(s.bootstrapped).toBe(true);
    expect(s.sessionId).toBe("s1");
    store.dispose();
  });

  it("bootstrapped stays true after the active session is deleted", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s1",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    mock.emitSessionDeleted({ sessionId: "s1" });
    const s = store.getSnapshot();
    expect(s.sessionId).toBeNull();
    expect(s.bootstrapped).toBe(true);
    store.dispose();
  });
});

describe("bootstrapped flag — no-session reset", () => {
  function makeStore() {
    const bridge = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(bridge.bridge);
    return { store, bridge };
  }

  it("a no-session reset marks bootstrapped with a null session", () => {
    const { store, bridge } = makeStore();
    bridge.emitReset({ noSession: true });
    expect(store.getSnapshot().bootstrapped).toBe(true);
    expect(store.getSnapshot().sessionId).toBeNull();
  });
});

describe("SessionStore — activationFirstUser", () => {
  function userBlock(text: string) {
    return {
      kind: "block" as const,
      blockId: text,
      block: { kind: "user" as const, text },
    };
  }

  it("captures the first user message of an activation and freezes it", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s-1",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    expect(store.getSnapshot().activationFirstUser).toBeNull();

    mock.emitRecord(userBlock("first message"));
    expect(store.getSnapshot().activationFirstUser).toBe("first message");

    // A later message does NOT change it.
    mock.emitRecord(userBlock("second message"));
    expect(store.getSnapshot().activationFirstUser).toBe("first message");
    store.dispose();
  });

  it("a rewind that withdraws the frozen message drops it (sidebar preview)", () => {
    // The bug (user 2026-08-03): enter an old session, send "hi", stop it,
    // rewind — the sidebar card kept previewing "hi", because the ACTIVE card
    // shows activationFirstUser in preference to lastUserText and the record
    // reset never re-decided it.
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s-1",
      workspaceRoot: "/r",
      record: [{ kind: "user", text: "older question" }],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    mock.emitRecord(userBlock("hi"));
    expect(store.getSnapshot().activationFirstUser).toBe("hi");

    // The rewind truncates back to the pre-"hi" record.
    mock.emitRecord({
      kind: "reset",
      record: [{ kind: "user", text: "older question" }],
      start: 0,
    });
    expect(store.getSnapshot().activationFirstUser).toBeNull();
    store.dispose();
  });

  it("a rewind that leaves the frozen message standing keeps it", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s-1",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    mock.emitRecord(userBlock("first message"));
    mock.emitRecord(userBlock("second message"));
    // Withdrawing only the SECOND turn — the frozen first message survives.
    mock.emitRecord({
      kind: "reset",
      record: [{ kind: "user", text: "first message" }],
      start: 0,
    });
    expect(store.getSnapshot().activationFirstUser).toBe("first message");
    store.dispose();
  });

  it("a drop-heal resync (no truncation) never disturbs the frozen message", () => {
    // The other emitter of a record reset re-emits the SAME or a longer record
    // mid-turn; re-deciding there would flicker a live turn's preview.
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s-1",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    mock.emitRecord(userBlock("first message"));
    // The heal window happens not to carry the user block (it is a tail), but
    // nothing shrank, so the frozen value stands.
    mock.emitRecord({
      kind: "reset",
      record: [
        { kind: "user", text: "first message" },
        { kind: "herta", surface: "speech", text: "answer" },
      ],
      start: 0,
    });
    expect(store.getSnapshot().activationFirstUser).toBe("first message");
    store.dispose();
  });

  it("clears on a new activation (reset)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "a",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    mock.emitRecord(userBlock("hi in a"));
    expect(store.getSnapshot().activationFirstUser).toBe("hi in a");

    mock.emitReset({
      sessionId: "b",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    expect(store.getSnapshot().activationFirstUser).toBeNull();
    store.dispose();
  });
});

describe("SessionStore — slice 4 (phantom bubble + turn-failed notice)", () => {
  function connected(): {
    store: SessionStore;
    mock: ReturnType<typeof createMockHertaBridge>;
  } {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    return { store, mock };
  }

  it("clears the streaming bubble when a turn finishes without committing a herta block", () => {
    const { store, mock } = connected();
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitAgent({ kind: "agent", event: deltaEvent("（我 ") });
    expect(store.getSnapshot().streamingText).toBe("（我 ");
    // Clean-to-empty: the actor skipped the commit; no herta block will come.
    mock.emitTurn({ kind: "finished", turnId: "t1" });
    expect(store.getSnapshot().streamingText).toBeNull();
    store.dispose();
  });

  it("leaves the normal finalized-block swap untouched (block clears, finished is a no-op)", () => {
    const { store, mock } = connected();
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitAgent({ kind: "agent", event: deltaEvent("在。") });
    mock.emitRecord({
      kind: "block",
      blockId: "b1",
      block: { kind: "herta", surface: "speech", text: "在。" },
    });
    expect(store.getSnapshot().streamingText).toBeNull();
    mock.emitTurn({ kind: "finished", turnId: "t1" });
    expect(store.getSnapshot().streamingText).toBeNull();
    expect(store.getSnapshot().record).toHaveLength(1);
    store.dispose();
  });

  it("sets turnFailed on a genuine failure; the next turn clears it", () => {
    const { store, mock } = connected();
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitTurn({
      kind: "failed",
      turnId: "t1",
      error: { code: "TypeError", message: "fetch failed" },
    } as never);
    expect(store.getSnapshot().turnFailed).toBe(true);
    expect(store.getSnapshot().status).toBe("idle");
    mock.emitTurn({ kind: "started", turnId: "t2" });
    expect(store.getSnapshot().turnFailed).toBe(false);
    store.dispose();
  });

  it("a user interrupt (AbortError) does NOT set turnFailed", () => {
    const { store, mock } = connected();
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitTurn({
      kind: "failed",
      turnId: "t1",
      error: { code: "AbortError", message: "turn aborted" },
    } as never);
    expect(store.getSnapshot().turnFailed).toBe(false);
    store.dispose();
  });
});

describe("SessionStore — long-session record windowing", () => {
  const SNAPSHOT_BASE = {
    workspaceRoot: "/r",
    overlay: null,
    backendWorkspace: "/r",
    backendWorkspaceIsDefault: true,
  };

  it("adopts the reset snapshot's window start (absent means 0)", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      ...SNAPSHOT_BASE,
      sessionId: "s",
      record: [{ kind: "user", text: "tail-0" }],
      recordStart: 500,
    });
    expect(store.getSnapshot().recordStart).toBe(500);
    mock.emitReset({
      ...SNAPSHOT_BASE,
      sessionId: "s2",
      record: [],
    });
    expect(store.getSnapshot().recordStart).toBe(0);
    store.dispose();
  });

  it("loadOlderBlocks prepends the fetched slice and moves the window start", async () => {
    const mock = createMockHertaBridge({
      recordSliceResult: {
        start: 3,
        blocks: [
          { kind: "user", text: "old-3" },
          { kind: "user", text: "old-4" },
        ],
      },
    });
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      ...SNAPSHOT_BASE,
      sessionId: "s",
      record: [{ kind: "user", text: "tail-5" }],
      recordStart: 5,
    });
    await store.loadOlderBlocks(2);
    expect(mock.calls.recordSlice).toEqual([["s", 5, 2]]);
    const s = store.getSnapshot();
    expect(s.recordStart).toBe(3);
    expect(s.record.map((b) => (b.kind === "user" ? b.text : ""))).toEqual([
      "old-3",
      "old-4",
      "tail-5",
    ]);
    store.dispose();
  });

  describe("a jump, and a window of history beside the trailing one (owner 2026-11-12)", () => {
    // A chat of plain messages: each weighs ten and opens a turn, so a
    // window's weight is 200 of them.
    const chat = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => ({
        kind: "user" as const,
        text: `m${from + i}`,
      }));
    /** A session of `n` messages, opened as the app opens it: on its tail. */
    function open(n: number) {
      const full = chat(n);
      const mock = createMockHertaBridge({ fullRecord: full });
      const store = new SessionStore();
      store.connect(mock.bridge);
      const start = Math.max(0, n - 200);
      mock.emitReset({
        ...SNAPSHOT_BASE,
        sessionId: "s",
        record: full.slice(start),
        recordStart: start,
      });
      /** Main writes `count` more blocks, and their events arrive. */
      const grow = (count: number): void => {
        const more = chat(count, full.length);
        full.push(...more);
        mock.setFullRecord(full);
        for (const block of more)
          mock.emitRecord({ kind: "block", blockId: block.text, block });
      };
      const span = (w: { record: readonly unknown[]; start: number } | null) =>
        w === null ? null : [w.start, w.start + w.record.length];
      return {
        mock,
        store,
        full,
        grow,
        /** The trailing window's span. */
        tail: () => {
          const s = store.getSnapshot();
          return [s.recordStart, s.recordStart + s.record.length];
        },
        /** The window of history, or null. */
        away: () => span(store.getSnapshot().away),
        /** What the chat shows. */
        shown: () => span(shownWindow(store.getSnapshot())),
        texts: (): string[] =>
          store
            .getSnapshot()
            .record.map((b) => (b.kind === "user" ? b.text : "")),
      };
    }

    it("near the trailing window, the blocks between join it: one window, still following the live end", async () => {
      const { mock, store, grow, tail, away } = open(1000);
      expect(await store.jumpTo(700)).toBe("joined");
      expect(mock.calls.recordWindow).toEqual([
        ["s", { kind: "jump", start: 800, end: 1000, to: 700 }],
      ]);
      expect(tail()).toEqual([700, 1000]);
      expect(away()).toBeNull();
      grow(1);
      expect(tail()).toEqual([700, 1001]);
      store.dispose();
    });

    it("far from it, the chat shows a window around the target, 190 messages and not the 760 between, and the trailing window is kept", async () => {
      const { store, tail, away, shown } = open(1000);
      const kept = store.getSnapshot().record;
      expect(await store.jumpTo(40)).toBe("replaced");
      // A quarter of the window before the target (all there is, here), the
      // rest after it.
      expect(away()).toEqual([0, 190]);
      expect(shown()).toEqual([0, 190]);
      expect(tail()).toEqual([800, 1000]);
      expect(store.getSnapshot().record).toBe(kept);
      store.dispose();
    });

    it("a block the chat already shows asks main for nothing", async () => {
      const { mock, store } = open(1000);
      expect(await store.jumpTo(900)).toBe("held");
      expect(mock.calls.recordWindow).toEqual([]);
      store.dispose();
    });

    it("no such block, or no answer: nothing changes and the jump says so", async () => {
      const { store, tail, away } = open(1000);
      expect(await store.jumpTo(5000)).toBeNull();
      expect(tail()).toEqual([800, 1000]);
      expect(away()).toBeNull();
      // A bridge that cannot answer (a fake, the website demo).
      const mock = createMockHertaBridge();
      const bare = new SessionStore();
      bare.connect(mock.bridge);
      mock.emitReset({
        ...SNAPSHOT_BASE,
        sessionId: "s",
        record: chat(10, 900),
        recordStart: 900,
      });
      expect(await bare.jumpTo(40)).toBeNull();
      expect(bare.getSnapshot().recordStart).toBe(900);
      expect(bare.getSnapshot().away).toBeNull();
      store.dispose();
      bare.dispose();
    });

    it("while history is shown the trailing window goes on following the live end, and the history does not move", async () => {
      const { store, grow, tail, away, texts } = open(1000);
      await store.jumpTo(40);
      const history = store.getSnapshot().away;
      grow(3);
      expect(tail()).toEqual([800, 1003]);
      expect(texts().slice(-3)).toEqual(["m1000", "m1001", "m1002"]);
      expect(store.getSnapshot().away).toBe(history);
      expect(away()).toEqual([0, 190]);
      store.dispose();
    });

    it("back to the latest asks main for nothing: the trailing window is there, with what was written meanwhile", async () => {
      const { mock, store, grow, tail, away, shown } = open(1000);
      await store.jumpTo(40);
      grow(3);
      const asked = mock.calls.recordWindow.length;
      store.returnToLatest();
      expect(away()).toBeNull();
      expect(shown()).toEqual([800, 1003]);
      expect(store.getSnapshot().latestLandings).toBe(1);
      expect(mock.calls.recordWindow).toHaveLength(asked);
      grow(1);
      expect(tail()).toEqual([800, 1004]);
      // Already there: a second call is not another landing.
      store.returnToLatest();
      expect(store.getSnapshot().latestLandings).toBe(1);
      store.dispose();
    });

    it("load later reads on from the history, and a page that reaches the trailing window joins the two", async () => {
      const { mock, store, grow, tail, away, texts } = open(1000);
      await store.jumpTo(400);
      expect(away()).toEqual([350, 550]);
      await store.loadLaterBlocks();
      expect(away()).toEqual([350, 750]);
      expect(tail()).toEqual([800, 1000]);
      // The next page runs to block 950, past where the trailing window
      // starts: one window now, and every block in it once.
      await store.loadLaterBlocks();
      expect(away()).toBeNull();
      expect(tail()).toEqual([350, 1000]);
      expect(new Set(texts()).size).toBe(650);
      expect(texts()[0]).toBe("m350");
      expect(texts().at(-1)).toBe("m999");
      // Reading there is not a return: the reader keeps their place.
      expect(store.getSnapshot().latestLandings).toBe(0);
      grow(1);
      expect(tail()).toEqual([350, 1001]);
      // No history on screen: nothing later to ask for.
      const asked = mock.calls.recordWindow.length;
      await store.loadLaterBlocks();
      expect(mock.calls.recordWindow).toHaveLength(asked);
      store.dispose();
    });

    it("a second jump from the history: near joins it, far takes its place, and a block of the trailing window needs no call", async () => {
      const { mock, store, away, shown } = open(1000);
      await store.jumpTo(400);
      expect(await store.jumpTo(600)).toBe("joined");
      expect(away()).toEqual([350, 750]);
      expect(await store.jumpTo(300)).toBe("joined");
      expect(away()).toEqual([300, 750]);
      expect(await store.jumpTo(20)).toBe("replaced");
      expect(away()).toEqual([0, 170]);
      const asked = mock.calls.recordWindow.length;
      expect(await store.jumpTo(900)).toBe("replaced");
      expect(away()).toBeNull();
      expect(shown()).toEqual([800, 1000]);
      expect(mock.calls.recordWindow).toHaveLength(asked);
      // That was a jump, not the chip: the jump scrolls to its row.
      expect(store.getSnapshot().latestLandings).toBe(0);
      store.dispose();
    });

    it("a jump from the history to a block just before the trailing window joins the two", async () => {
      const { store, tail, away } = open(1000);
      await store.jumpTo(40);
      expect(await store.jumpTo(790)).toBe("replaced");
      expect(away()).toBeNull();
      expect(tail()).toEqual([740, 1000]);
      store.dispose();
    });

    it("a message sent from the history takes the reader back with it, in the commit that shows its echo", async () => {
      const { store, away } = open(1000);
      await store.jumpTo(40);
      const seen: Array<[string | null, boolean]> = [];
      store.subscribe(() => {
        const s = store.getSnapshot();
        seen.push([s.pendingUser, s.away === null]);
      });
      store.markPendingUser("hello");
      expect(seen).toEqual([["hello", true]]);
      expect(away()).toBeNull();
      expect(store.getSnapshot().latestLandings).toBe(1);
      // Talk behind an echo goes back the same way.
      await store.jumpTo(40);
      store.markPendingTalk("and this");
      expect(away()).toBeNull();
      expect(store.getSnapshot().pendingTalk.map((p) => p.text)).toEqual([
        "and this",
      ]);
      expect(store.getSnapshot().latestLandings).toBe(2);
      store.dispose();
    });

    it("load earlier and the chat's trim act on the window the chat shows", async () => {
      const { mock, store, tail, away } = open(1000);
      await store.jumpTo(400);
      await store.loadOlderBlocks();
      expect(mock.calls.recordSlice).toEqual([["s", 350, 2000]]);
      expect(away()).toEqual([150, 550]);
      store.trimRecordWindow(100);
      expect(away()).toEqual([450, 550]);
      expect(tail()).toEqual([800, 1000]);
      // And on the trailing window when that is what the chat shows.
      store.returnToLatest();
      await store.loadOlderBlocks();
      expect(tail()).toEqual([600, 1000]);
      store.trimRecordWindow(100);
      expect(tail()).toEqual([900, 1000]);
      store.dispose();
    });

    it("the trailing window is bounded while nothing looks at it: back to a window's weight, at a turn", async () => {
      const hidden = open(1000);
      await hidden.store.jumpTo(40);
      hidden.grow(100);
      const [start, end] = hidden.tail() as [number, number];
      expect(end).toBe(1100);
      // 200 messages is a window; the trim line is 260.
      expect(end - start).toBeGreaterThanOrEqual(200);
      expect(end - start).toBeLessThanOrEqual(260);
      // On screen, the chat's own trims decide, as before: the store leaves it.
      const onScreen = open(1000);
      onScreen.grow(100);
      expect(onScreen.tail()).toEqual([800, 1100]);
      hidden.store.dispose();
      onScreen.store.dispose();
    });

    it("a reset is the trailing window's: the history stays on screen, and an answer that crossed it is dropped", async () => {
      const { mock, store, full, tail, away } = open(1000);
      await store.jumpTo(40);
      // A rewind: the record lost its last two blocks.
      mock.emitRecord({
        kind: "reset",
        record: full.slice(798, 998),
        start: 798,
      });
      expect(tail()).toEqual([798, 998]);
      expect(away()).toEqual([0, 190]);
      expect(store.getSnapshot().latestLandings).toBe(0);
      const jump = store.jumpTo(400);
      mock.emitRecord({
        kind: "reset",
        record: full.slice(798, 998),
        start: 798,
      });
      expect(await jump).toBeNull();
      expect(away()).toEqual([0, 190]);
      store.dispose();
    });

    it("a reset that reaches back to the history joins the two", async () => {
      const { mock, store, full, tail, away } = open(1000);
      await store.jumpTo(40);
      mock.emitRecord({
        kind: "reset",
        record: full.slice(150, 400),
        start: 150,
      });
      expect(away()).toBeNull();
      expect(tail()).toEqual([0, 400]);
      store.dispose();
    });

    it("a session that opens after one that showed history opens on its trailing window", async () => {
      const { mock, store } = open(1000);
      await store.jumpTo(40);
      mock.emitReset({
        ...SNAPSHOT_BASE,
        sessionId: "s2",
        record: chat(3),
      });
      expect(store.getSnapshot().away).toBeNull();
      mock.emitRecord({
        kind: "block",
        blockId: "x",
        block: { kind: "user", text: "x" },
      });
      expect(store.getSnapshot().record).toHaveLength(4);
      store.dispose();
    });
  });

  it("loadOlderBlocks drops a slice that no longer aligns with the window", async () => {
    // The fetched slice must END exactly at the current window start; a
    // misaligned response (window moved while the invoke was in flight)
    // would corrupt absolute indexing — drop it.
    const mock = createMockHertaBridge({
      recordSliceResult: { start: 0, blocks: [{ kind: "user", text: "x" }] },
    });
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      ...SNAPSHOT_BASE,
      sessionId: "s",
      record: [{ kind: "user", text: "tail" }],
      recordStart: 5,
    });
    await store.loadOlderBlocks(2); // slice ends at 1 !== 5 -> dropped
    expect(store.getSnapshot().recordStart).toBe(5);
    expect(store.getSnapshot().record).toHaveLength(1);
    store.dispose();
  });

  it("loadOlderBlocks no-ops at start 0 and without a session", async () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    await store.loadOlderBlocks(); // no session
    mock.emitReset({
      ...SNAPSHOT_BASE,
      sessionId: "s",
      record: [{ kind: "user", text: "all" }],
      recordStart: 0,
    });
    await store.loadOlderBlocks(); // fully loaded
    expect(mock.calls.recordSlice).toEqual([]);
    store.dispose();
  });

  it("a windowed record-channel reset aligns the at-merge by ABSOLUTE index", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    // Window [2, 4): two blocks the GUI stamped at absolute 2 and 3.
    mock.emitReset({
      ...SNAPSHOT_BASE,
      sessionId: "s",
      record: [
        { kind: "user", text: "b2", at: "2026-07-12T00:00:02.000Z" },
        { kind: "user", text: "b3", at: "2026-07-12T00:00:03.000Z" },
      ],
      recordStart: 2,
    });
    // A reset arrives windowed at [3, 5) with b3 missing its `at`: the merge
    // must pull the stamp from absolute index 3 (prev[3 - 2]), not prev[0].
    mock.emitRecord({
      kind: "reset",
      start: 3,
      record: [
        { kind: "user", text: "b3" },
        { kind: "user", text: "b4", at: "2026-07-12T00:00:04.000Z" },
      ],
    } as never);
    const s = store.getSnapshot();
    expect(s.recordStart).toBe(3);
    expect(s.record[0]?.at).toBe("2026-07-12T00:00:03.000Z");
    expect(s.record[1]?.at).toBe("2026-07-12T00:00:04.000Z");
    store.dispose();
  });
});

describe("SessionStore — topic history", () => {
  const BASE = {
    workspaceRoot: "/r",
    overlay: null,
    backendWorkspace: "/r",
    backendWorkspaceIsDefault: true,
  };
  const TOPIC_A = {
    title: "话题A",
    anchorIndex: 0,
    anchorText: "第一问",
    at: "t1",
  };
  const TOPIC_B = {
    title: "话题B",
    anchorIndex: 6,
    anchorText: "换个话题",
    at: "t2",
  };

  it("seeds topics from the reset snapshot and appends title-event topics", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      ...BASE,
      sessionId: "s",
      record: [],
      topics: [TOPIC_A],
    });
    expect(store.getSnapshot().topics).toEqual([TOPIC_A]);
    mock.emitTitle({
      kind: "title",
      sessionId: "s",
      title: "话题B",
      topic: TOPIC_B,
    });
    expect(store.getSnapshot().topics).toEqual([TOPIC_A, TOPIC_B]);
    // A replayed identical event must not double the entry.
    mock.emitTitle({
      kind: "title",
      sessionId: "s",
      title: "话题B",
      topic: TOPIC_B,
    });
    expect(store.getSnapshot().topics).toEqual([TOPIC_A, TOPIC_B]);
    // A retitle WITHOUT a topic (same title re-derived) appends nothing.
    mock.emitTitle({ kind: "title", sessionId: "s", title: "话题B" });
    expect(store.getSnapshot().topics).toEqual([TOPIC_A, TOPIC_B]);
    store.dispose();
  });

  it("adopts the topic history a rewind reset carries", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      ...BASE,
      sessionId: "s",
      record: [
        { kind: "user", text: "u0" },
        { kind: "user", text: "u6" },
      ],
      topics: [TOPIC_A, TOPIC_B],
    });
    mock.emitRecord({
      kind: "reset",
      record: [{ kind: "user", text: "u0" }],
      start: 3,
      topics: [TOPIC_A],
    } as never);
    expect(store.getSnapshot().topics).toEqual([TOPIC_A]);
    store.dispose();
  });

  it("adopts a carried list even when the dropped topic's ANCHOR survives", () => {
    // The bug this replaced (user 2026-07-30). The store used to derive the
    // pruning itself by testing anchor liveness against the new record end —
    // but a re-entry retitle anchors its topic at the title window's start,
    // i.e. a message from hours ago, which a rewind does not touch. Both
    // topics here anchor at index 0, so no inference could tell them apart;
    // only the server (which knows WHICH turn each was born in) can.
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    const older = { ...TOPIC_A, anchorIndex: 0, bornAtLength: 2 };
    const fresh = { ...TOPIC_B, anchorIndex: 0, bornAtLength: 4 };
    mock.emitReset({
      ...BASE,
      sessionId: "s",
      record: [
        { kind: "user", text: "u0" },
        { kind: "herta", surface: "speech", text: "h0" },
        { kind: "user", text: "u2" },
        { kind: "herta", surface: "speech", text: "h2" },
      ],
      topics: [older, fresh],
    });
    mock.emitRecord({
      kind: "reset",
      record: [
        { kind: "user", text: "u0" },
        { kind: "herta", surface: "speech", text: "h0" },
      ],
      topics: [older],
    } as never);
    expect(store.getSnapshot().topics).toEqual([older]);
    store.dispose();
  });

  it("a reset with NO topics leaves them alone (a drop-heal resync)", () => {
    // Resyncs re-emit the SAME record; they carry no topics because they
    // cannot have changed any. Treating absent as empty would blank the rail
    // on every overflow heal.
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      ...BASE,
      sessionId: "s",
      record: [{ kind: "user", text: "u0" }],
      topics: [TOPIC_A, TOPIC_B],
    });
    mock.emitRecord({
      kind: "reset",
      record: [{ kind: "user", text: "u0" }],
    } as never);
    expect(store.getSnapshot().topics).toEqual([TOPIC_A, TOPIC_B]);
    store.dispose();
  });
});

describe("SessionStore — turn-failure status (official DeepSeek codes)", () => {
  it("carries the failed turn''s HTTP status; clears it on the next turn", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitTurn({
      kind: "failed",
      turnId: "t1",
      error: { code: "ProviderError", message: "402 ...", status: 402 },
    } as never);
    expect(store.getSnapshot().turnFailed).toBe(true);
    expect(store.getSnapshot().turnFailedStatus).toBe(402);
    mock.emitTurn({ kind: "started", turnId: "t2" });
    expect(store.getSnapshot().turnFailed).toBe(false);
    expect(store.getSnapshot().turnFailedStatus).toBeNull();
    store.dispose();
  });

  it("a status-less failure stays generic; an interrupt carries nothing", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    mock.emitTurn({
      kind: "failed",
      turnId: "t1",
      error: { code: "TypeError", message: "fetch failed" },
    } as never);
    expect(store.getSnapshot().turnFailed).toBe(true);
    expect(store.getSnapshot().turnFailedStatus).toBeNull();
    mock.emitTurn({ kind: "started", turnId: "t2" });
    mock.emitTurn({
      kind: "failed",
      turnId: "t2",
      error: { code: "AbortError", message: "aborted", status: 402 },
    } as never);
    expect(store.getSnapshot().turnFailed).toBe(false);
    expect(store.getSnapshot().turnFailedStatus).toBeNull();
    store.dispose();
  });
});

describe("SessionStore — composer predictions (owner 2026-10-10)", () => {
  it("takes a prediction only into an idle composer, and a new turn drops it", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitTurn({ kind: "started", turnId: "t1" });
    // A late prediction while a turn runs is for a line already sent.
    mock.emitTurn({ kind: "predicted", turnId: "t0", text: "旧的" });
    expect(store.getSnapshot().prediction).toBeNull();
    mock.emitTurn({ kind: "finished", turnId: "t1" });
    mock.emitTurn({ kind: "predicted", turnId: "t1", text: "再跑一遍测试" });
    expect(store.getSnapshot().prediction).toBe("再跑一遍测试");
    // It is no turn end: the composer stays idle.
    expect(store.getSnapshot().status).toBe("idle");
    mock.emitTurn({ kind: "started", turnId: "t2" });
    expect(store.getSnapshot().prediction).toBeNull();
  });

  // Review 2026-11-10, second pass.
  it("a rewind takes the suggestion with the exchange it was for; a resync keeps it", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    mock.emitReset({
      sessionId: "s-1",
      workspaceRoot: "/r",
      record: [{ kind: "user", text: "older question" }],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });
    mock.emitRecord({
      kind: "block",
      blockId: "hi",
      block: { kind: "user", text: "hi" },
    });
    mock.emitTurn({ kind: "predicted", turnId: "t1", text: "再跑一遍测试" });
    expect(store.getSnapshot().prediction).toBe("再跑一遍测试");
    // A drop-heal resync re-emits the same record: nothing was withdrawn.
    mock.emitRecord({
      kind: "reset",
      record: [
        { kind: "user", text: "older question" },
        { kind: "user", text: "hi" },
      ],
      start: 0,
    });
    expect(store.getSnapshot().prediction).toBe("再跑一遍测试");
    // The rewind truncates back to before "hi".
    mock.emitRecord({
      kind: "reset",
      record: [{ kind: "user", text: "older question" }],
      start: 0,
    });
    expect(store.getSnapshot().prediction).toBeNull();
    store.dispose();
  });
});

describe("SessionStore — a quote for the next session (ADR 0084 §9)", () => {
  const quote = {
    kind: "post" as const,
    id: "post-1",
    url: "https://a.dev/x",
    title: "T",
    text: "body",
  };
  const reset = (mock: ReturnType<typeof createMockHertaBridge>, id: string) =>
    mock.emitReset({
      sessionId: id,
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
    });

  it("lands in the composer of the session that opens next, and only that one", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    store.quoteIntoNextSession(quote);
    expect(store.getSnapshot().composerQuotes).toEqual([]);
    reset(mock, "s1");
    expect(store.getSnapshot().composerQuotes).toEqual([quote]);
    reset(mock, "s2");
    expect(store.getSnapshot().composerQuotes).toEqual([]);
  });

  it("a session that did not open takes its quotes with it", () => {
    const mock = createMockHertaBridge();
    const store = new SessionStore();
    store.connect(mock.bridge);
    store.quoteIntoNextSession(quote);
    store.dropNextSessionQuotes();
    reset(mock, "s1");
    expect(store.getSnapshot().composerQuotes).toEqual([]);
  });
});
