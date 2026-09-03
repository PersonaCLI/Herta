import type { AgentEvent } from "@herta/core";
import { describe, expect, it } from "vitest";
import { BeatPolicy, classifyBeatTrigger } from "./beat-policy.js";

describe("classifyBeatTrigger — event → trigger", () => {
  it("returns null for actor-layer events", () => {
    const ev: AgentEvent = {
      type: "tool.call.started",
      layer: "actor",
      id: "t1",
      tool: "read_file",
      inputSummary: "foo.ts",
    };
    expect(classifyBeatTrigger(ev)).toBeNull();
  });

  it("returns null on backend tool.call.started for any workflow kind (N2, 2026-05-23)", () => {
    // 2026-05-23 N2 tightening: beats no longer fire on workflow
    // start events. The model has no useful content to comment on
    // (the START event has no output yet), and firing on every
    // file read / plan step / git_status made Herta too chatty. The
    // → 差分协处理器 system block still appears (projected by the
    // backend bridge); Herta just doesn't beat on it.
    const ev: AgentEvent = {
      type: "tool.call.started",
      layer: "backend",
      id: "t1",
      tool: "edit_file",
      inputSummary: "foo.ts",
    };
    expect(classifyBeatTrigger(ev)).toBeNull();
  });

  it("returns null on tool.call.started for read tools (N2)", () => {
    const a: AgentEvent = {
      type: "tool.call.started",
      layer: "backend",
      id: "t1",
      tool: "read_file",
      inputSummary: "a.ts",
    };
    const b: AgentEvent = {
      type: "tool.call.started",
      layer: "backend",
      id: "t2",
      tool: "list_files",
      inputSummary: "src",
    };
    expect(classifyBeatTrigger(a)).toBeNull();
    expect(classifyBeatTrigger(b)).toBeNull();
  });

  it("returns null on tool.call.started for unknown tool kinds (N2 — same as known)", () => {
    const ev: AgentEvent = {
      type: "tool.call.started",
      layer: "backend",
      id: "t1",
      tool: "frobnicate",
      inputSummary: "?",
    };
    expect(classifyBeatTrigger(ev)).toBeNull();
  });

  it("returns null on tool.call.finished success", () => {
    const ev: AgentEvent = {
      type: "tool.call.finished",
      layer: "backend",
      id: "t1",
      tool: "edit_file",
      result: { ok: true, summary: "patched foo.ts", data: {} },
    };
    expect(classifyBeatTrigger(ev)).toBeNull();
  });

  it("fires on tool.call.finished failure with non-permission code", () => {
    const ev: AgentEvent = {
      type: "tool.call.finished",
      layer: "backend",
      id: "t1",
      tool: "edit_file",
      result: {
        ok: false,
        error: { code: "stale_read", message: "...", retryable: false },
        summary: "failed",
      },
    };
    const t = classifyBeatTrigger(ev);
    expect(t?.signature).toBe("tool.fail:edit_file:stale_read");
  });

  it("carries only the dedup signature — no per-event prose leaks into the spec", () => {
    const ev: AgentEvent = {
      type: "tool.call.finished",
      layer: "backend",
      id: "t1",
      tool: "edit_file",
      result: {
        ok: false,
        error: {
          code: "weird_error",
          message: "buggy tool wrote @板砖 into the message",
          retryable: false,
        },
        summary: "fail",
      },
    };
    const t = classifyBeatTrigger(ev);
    expect(t).not.toBeNull();
    // The error message (which may contain a raw @板砖) must not ride the
    // trigger into any prompt: the spec is signature-only; beat prompts are
    // built from the terminal record.
    expect(Object.keys(t as object)).toEqual(["signature"]);
    expect(JSON.stringify(t)).not.toContain("@板砖");
  });

  it("does NOT fire on permission_denied / permission_failed", () => {
    const denied: AgentEvent = {
      type: "tool.call.finished",
      layer: "backend",
      id: "t1",
      tool: "edit_file",
      result: {
        ok: false,
        error: {
          code: "permission_denied",
          message: "user denied",
          retryable: false,
        },
        summary: "denied",
      },
    };
    expect(classifyBeatTrigger(denied)).toBeNull();
  });

  it("fires on patch.preview", () => {
    const ev: AgentEvent = {
      type: "patch.preview",
      layer: "backend",
      diff: "--- a\n+++ b\n@@\n-x\n+y\n",
      files: ["foo.ts"],
    };
    expect(classifyBeatTrigger(ev)?.signature).toBe("patch.preview:first");
  });

  it("fires on a red verification.finished", () => {
    const ev: AgentEvent = {
      type: "verification.finished",
      layer: "backend",
      result: { passed: false },
    };
    expect(classifyBeatTrigger(ev)?.signature).toBe("verification.finished");
  });

  it("collapses tool_crashed signatures across tools (one crash beat per dispatch, 2026-07-23)", () => {
    const crash = (tool: string): AgentEvent => ({
      type: "tool.call.finished",
      layer: "backend",
      id: `c-${tool}`,
      tool,
      result: {
        ok: false,
        error: { code: "tool_crashed", message: "boom", retryable: false },
        summary: `crashed: ${tool}`,
      },
    });
    const a = classifyBeatTrigger(crash("read_file"));
    const b = classifyBeatTrigger(crash("glob"));
    expect(a?.signature).toBe("tool.fail:crash");
    expect(b?.signature).toBe("tool.fail:crash");
    // The collapse precedes the workflow-kind allowlist: a crash on a tool
    // workflowKindForBeat doesn't know still gets its one beat (consumer
    // audit 2026-07-23).
    expect(classifyBeatTrigger(crash("some_future_tool"))?.signature).toBe(
      "tool.fail:crash",
    );
    // Ordinary failure codes keep the per-tool signature.
    const ordinary = classifyBeatTrigger({
      type: "tool.call.finished",
      layer: "backend",
      id: "c-x",
      tool: "glob",
      result: {
        ok: false,
        error: { code: "invalid_pattern", message: "bad", retryable: false },
        summary: "invalid pattern",
      },
    });
    expect(ordinary?.signature).toBe("tool.fail:glob:invalid_pattern");
  });

  it("fires on a FAILED verification.finished (test-result beat — producer added 2026-07-23)", () => {
    const trigger = classifyBeatTrigger({
      type: "verification.finished",
      layer: "backend",
      result: { passed: false },
    });
    expect(trigger?.signature).toBe("verification.finished");
  });

  it("a green test run earns no beat — the synthesis reports it (owner 2026-09-03)", () => {
    // A passing run that ended the brief drew a beat and then the same news
    // again from Herta's wrap-up. An emitter that does not know the outcome
    // gets no beat either.
    expect(
      classifyBeatTrigger({
        type: "verification.finished",
        layer: "backend",
        result: { passed: true },
      }),
    ).toBeNull();
    expect(
      classifyBeatTrigger({
        type: "verification.finished",
        layer: "backend",
        result: {},
      }),
    ).toBeNull();
  });

  it("returns null on plan.updated (redundant with tool.started:plan)", () => {
    const ev: AgentEvent = {
      type: "plan.updated",
      layer: "backend",
      todos: [],
    };
    expect(classifyBeatTrigger(ev)).toBeNull();
  });

  it("returns null on turn lifecycle events (handled separately by reset)", () => {
    const started: AgentEvent = {
      type: "turn.started",
      layer: "backend",
      userText: "fix",
    };
    const finished: AgentEvent = {
      type: "turn.finished",
      layer: "backend",
      summary: {
        durationMs: 0,
        toolCallCount: 0,
        messageCount: 0,
        endedAt: "",
      },
    };
    expect(classifyBeatTrigger(started)).toBeNull();
    expect(classifyBeatTrigger(finished)).toBeNull();
  });

  it("returns null on tool.call.finished failure with unknown tool name", () => {
    const ev: AgentEvent = {
      type: "tool.call.finished",
      layer: "backend",
      id: "t1",
      tool: "frobnicate",
      result: {
        ok: false,
        error: { code: "weird", message: "broke", retryable: false },
        summary: "fail",
      },
    };
    expect(classifyBeatTrigger(ev)).toBeNull();
  });
});

describe("BeatPolicy — staging, dedup, and fire-time throttle", () => {
  // N2 (2026-05-23): tool.call.started no longer fires beats, so we
  // exercise the staging/dedup machinery via the still-beat-worthy
  // `patch.preview` event. M3 (2026-07-04): staging is clock-free;
  // the throttle window is checked at fire time via readyToFire().
  function previewEv(path: string): AgentEvent {
    return {
      type: "patch.preview",
      layer: "backend",
      diff: "--- a\n+++ b\n@@ ... @@",
      files: [path],
    };
  }
  function verificationEv(): AgentEvent {
    // Red: a green run classifies to null since 2026-09-03.
    return {
      type: "verification.finished",
      layer: "backend",
      result: { passed: false },
    };
  }
  // Unknown event type that won't classify (always returns null
  // regardless of throttle state).
  function unknownEv(): AgentEvent {
    return {
      type: "tool.call.started",
      layer: "backend",
      id: "t-frobnicate",
      tool: "frobnicate",
      inputSummary: "?",
    };
  }

  it("returns a trigger on first event", () => {
    const p = new BeatPolicy({ clock: () => 0 });
    const t = p.shouldStage(previewEv("a.ts"));
    expect(t).not.toBeNull();
    expect(t?.signature).toBe("patch.preview:first");
  });

  it("returns null on second event with the same signature after it fired (dedup)", () => {
    const p = new BeatPolicy({ clock: () => 1000 });
    expect(p.shouldStage(previewEv("a.ts"))).not.toBeNull();
    p.markFired("patch.preview:first", 1000);
    // Same `patch.preview:first` signature — dedup blocks the second.
    expect(p.shouldStage(previewEv("b.ts"))).toBeNull();
  });

  it("stages a different signature even inside the throttle window (M3: staging is clock-free)", () => {
    // Pre-M3 an in-window arrival was dropped forever — even though its
    // beat would have FIRED well after the window elapsed. Staging no
    // longer consults the clock; the window belongs to readyToFire().
    const clock = { now: 0 };
    const p = new BeatPolicy({
      clock: () => clock.now,
      minInterBurstMs: 3000,
    });
    expect(p.shouldStage(previewEv("a.ts"))).not.toBeNull();
    p.markFired("patch.preview:first", 0);

    clock.now = 1000;
    expect(p.shouldStage(verificationEv())?.signature).toBe(
      "verification.finished",
    );
  });

  it("readyToFire is true before any fire, false inside the window, true after", () => {
    const clock = { now: 0 };
    const p = new BeatPolicy({
      clock: () => clock.now,
      minInterBurstMs: 3000,
    });
    // lastBurstAt starts at -Infinity — the first beat is never held.
    expect(p.readyToFire()).toBe(true);
    p.markFired("patch.preview:first", 0);

    clock.now = 1000;
    expect(p.readyToFire()).toBe(false);

    clock.now = 3000;
    expect(p.readyToFire()).toBe(true);
  });

  it("returns null for events that don't classify", () => {
    const p = new BeatPolicy({ clock: () => 0 });
    expect(p.shouldStage(unknownEv())).toBeNull();
  });

  it("a staged-but-never-fired signature may stage again (dedup only via markFired)", () => {
    // A dropped beat (provider error) should not permanently consume its
    // signature; in-flight duplicates are the bridge's staged/ready scan.
    const p = new BeatPolicy({ clock: () => 0 });
    expect(p.shouldStage(previewEv("a.ts"))).not.toBeNull();
    expect(p.shouldStage(previewEv("a.ts"))).not.toBeNull();
  });

  it("reset() clears dedup but does NOT reset lastBurstAt", () => {
    const clock = { now: 0 };
    const p = new BeatPolicy({
      clock: () => clock.now,
      minInterBurstMs: 3000,
    });
    expect(p.shouldStage(previewEv("a.ts"))).not.toBeNull();
    p.markFired("patch.preview:first", 0);
    // Fired → dedup blocks re-staging.
    expect(p.shouldStage(previewEv("b.ts"))).toBeNull();

    p.reset();

    clock.now = 1000;
    // Dedup cleared → the signature stages again; but the throttle
    // window survives reset (lastBurstAt unchanged), so it is not yet
    // eligible to FIRE — that's the turn-2 flood protection.
    expect(p.shouldStage(previewEv("b.ts"))).not.toBeNull();
    expect(p.readyToFire()).toBe(false);

    clock.now = 3000;
    expect(p.readyToFire()).toBe(true);
  });
});
