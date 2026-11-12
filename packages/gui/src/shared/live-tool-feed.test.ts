import type { AgentEvent, SessionAgentEvent } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import {
  createLiveToolFeed,
  type LiveToolSnapshot,
  TAIL_LINES,
} from "./live-tool-feed.js";

const ev = (event: AgentEvent): SessionAgentEvent => ({ kind: "agent", event });
const delta = (id: string, tool: string, argsDelta: string) =>
  ev({ type: "tool.call.delta", layer: "backend", id, tool, argsDelta });
const started = (id: string, tool: string, inputSummary = "") =>
  ev({ type: "tool.call.started", layer: "backend", id, tool, inputSummary });
const output = (id: string, chunk: string) =>
  ev({ type: "tool.call.output", layer: "backend", id, chunk });
const finished = (id: string, tool: string, ok = true) =>
  ev({
    type: "tool.call.finished",
    layer: "backend",
    id,
    tool,
    result: { ok, summary: "" },
  });

/** A feed on a hand-cranked timer: `tick()` runs the pending flush. */
function harness(
  opts: { readonly midRun?: boolean; readonly now?: () => number } = {},
) {
  const sent: LiveToolSnapshot[] = [];
  let pending: (() => void) | null = null;
  let timers = 0;
  const feed = createLiveToolFeed((s) => sent.push(s), {
    now: () => 1_000,
    ...opts,
    setTimer: (fn) => {
      timers += 1;
      pending = fn;
      return timers;
    },
    clearTimer: () => {
      pending = null;
    },
  });
  const tick = (): LiveToolSnapshot | undefined => {
    const fn = pending;
    pending = null;
    fn?.();
    return sent[sent.length - 1];
  };
  return { feed, sent, tick, timers: () => timers };
}

describe("createLiveToolFeed (ADR 0073)", () => {
  it("a call dispatched as a test run says so on its view (ADR 0073 amendment 2026-10-08)", () => {
    const h = harness();
    h.feed.push(
      ev({
        type: "tool.call.started",
        layer: "backend",
        id: "c1",
        tool: "bash",
        inputSummary: "mkdir -p x && cd x && …",
        runsTests: true,
      }),
    );
    h.feed.push(started("c2", "bash", "ls"));
    const snap = h.tick();
    expect(snap?.views.find((v) => v.id === "c1")?.runsTests).toBe(true);
    expect(snap?.views.find((v) => v.id === "c2")?.runsTests).toBeUndefined();
  });

  it("started mid-run, or after events were lost, it numbers no call until the next run starts (review 2026-09-30)", () => {
    const h = harness({ midRun: true });
    h.feed.push(started("c1", "bash", "pwd"));
    let snap = h.tick();
    expect(snap?.views[0]?.ordinal).toBeUndefined();
    expect(snap?.startedOps).toBe(0);
    // The next run starts: every call from here on is seen, and numbered.
    h.feed.push(ev({ type: "turn.started", layer: "backend" } as AgentEvent));
    h.feed.push(started("c2", "bash", "ls"));
    snap = h.tick();
    expect(snap?.views.map((v) => [v.id, v.ordinal])).toEqual([["c2", 0]]);
    expect(snap?.startedOps).toBe(1);
    // Events lost: the count has missed calls, so numbering stops again.
    h.feed.push({ kind: "dropped", count: 1 } as unknown as SessionAgentEvent);
    h.feed.push(started("c3", "bash", "cat x"));
    snap = h.tick();
    expect(snap?.views.map((v) => [v.id, v.ordinal])).toEqual([
      ["c3", undefined],
    ]);
    expect(snap?.startedOps).toBe(0);
  });

  it("a call the user did not allow leaves the views: the record has no row for it (D7)", () => {
    const h = harness();
    h.feed.push(started("c1", "bash", "rm x"));
    expect(h.tick()?.views).toHaveLength(1);
    h.feed.push(
      ev({
        type: "tool.call.finished",
        layer: "backend",
        id: "c1",
        tool: "bash",
        result: {
          ok: false,
          summary: "",
          error: {
            code: "permission_denied",
            message: "denied",
            retryable: false,
          },
        },
      }),
    );
    expect(h.tick()?.views).toEqual([]);
  });

  it("shows a new file as the model writes it: path, text, line count", () => {
    const h = harness();
    h.feed.push(
      delta(
        "c1",
        "str_replace_editor",
        '{"command":"create","path":"src/a.ts",',
      ),
    );
    h.feed.push(
      delta("c1", "str_replace_editor", '"file_text":"line 1\\nline 2\\nli'),
    );
    expect(h.tick()).toEqual({
      views: [
        {
          id: "c1",
          tool: "str_replace_editor",
          stage: "writing",
          started: false,
          done: false,
          streams: true,
          path: "src/a.ts",
          mode: "text",
          tail: "line 1\nline 2\nli",
          lines: 3,
        },
      ],
      startedOps: 0,
      focus: "c1",
    });
  });

  it("an edit shows what it removes and what it adds", () => {
    const h = harness();
    h.feed.push(
      delta(
        "c1",
        "str_replace_editor",
        '{"command":"str_replace","path":"a.ts","old_str":"a = 1\\nb","new_str":"a = 2\\nc\\nd"}',
      ),
    );
    const v = h.tick()?.views[0];
    expect(v?.mode).toBe("diff");
    expect(v?.tail).toBe("-a = 1\n-b\n+a = 2\n+c\n+d");
    const h2 = harness();
    h2.feed.push(
      delta(
        "c2",
        "str_replace_editor",
        '{"command":"str_replace","path":"a.ts","old_str":"x","new_str":"y"}',
      ),
    );
    expect(h2.tick()?.views[0]?.tail).toBe("-x\n+y");
  });

  it("an editor `view` and an excerpt have no stream: they show only as the step in flight, named by the record's summary once dispatched", () => {
    const h = harness();
    h.feed.push(
      delta("c1", "str_replace_editor", '{"command":"view","path":"a.ts"}'),
    );
    // An excerpt's arguments are not watched at all.
    h.feed.push(
      delta("c2", "show_excerpt", '{"path":"a.ts","fromLine":1,"toLine":4}'),
    );
    expect(h.tick()?.views).toEqual([
      expect.objectContaining({ id: "c1", streams: false, tail: "", lines: 0 }),
    ]);
    h.feed.push(started("c2", "show_excerpt", "a.ts:1-4"));
    expect(h.tick()?.views[1]).toMatchObject({
      id: "c2",
      started: true,
      summary: "a.ts:1-4",
      streams: false,
    });
  });

  it("a path is shown only once it has streamed in whole", () => {
    const h = harness();
    h.feed.push(
      delta("c1", "str_replace_editor", '{"command":"create","path":"/c/Us'),
    );
    expect(h.tick()?.views[0]?.path).toBeUndefined();
    h.feed.push(
      delta("c1", "str_replace_editor", 'ers/me/ws/a.ts","file_text":"x'),
    );
    expect(h.tick()?.views[0]?.path).toBe("/c/Users/me/ws/a.ts");
  });

  it("a command's line is named only once written whole — half a line is not what runs (lab 2026-09-30)", () => {
    const h = harness();
    h.feed.push(delta("c1", "bash", '{"command":"cd /c/Users/me/w'));
    const half = h.tick()?.views[0];
    expect(half?.commandLine).toBeUndefined();
    // Its text still flows in the ticker.
    expect(half?.tail).toBe("cd /c/Users/me/w");
    // A heredoc's first line completes long before its body.
    h.feed.push(
      delta("c2", "bash", '{"command":"cat > a.ts <<\'EOF\'\\nexport'),
    );
    expect(h.tick()?.views[1]?.commandLine).toBe("cat > a.ts <<'EOF'");
    h.feed.push(delta("c1", "bash", 's && npm test"}'));
    expect(h.tick()?.views[0]?.commandLine).toBe(
      "cd /c/Users/me/ws && npm test",
    );
  });

  it("a command: its line while written, its output once it runs — `\\r` progress reduced to where it stands", () => {
    const h = harness();
    h.feed.push(delta("c1", "bash", '{"command":"npm test"}'));
    expect(h.tick()?.views[0]).toMatchObject({
      stage: "writing",
      commandLine: "npm test",
      tail: "npm test",
    });
    h.feed.push(started("c1", "bash", "npm test"));
    h.feed.push(output("c1", "PASS a\n"));
    h.feed.push(output("c1", "10%\r50%\r100%\ndone"));
    expect(h.tick()?.views[0]).toMatchObject({
      stage: "running",
      started: true,
      commandLine: "npm test",
      mode: "text",
      tail: "PASS a\n100%\ndone",
      lines: 3,
    });
  });

  it("a call whose arguments are not watched has no draft; it shows from its start, named by the record's summary", () => {
    const h = harness();
    h.feed.push(delta("c1", "web_search", '{"query":"vitest 4"}'));
    h.tick();
    expect(h.sent).toEqual([]);
    h.feed.push(started("c1", "web_search", "vitest 4"));
    expect(h.tick()?.views[0]).toMatchObject({
      tool: "web_search",
      started: true,
      summary: "vitest 4",
      streams: false,
      tail: "",
    });
  });

  it("only bash's output streams: a deleted tool's is not shown, and its call makes no op row (ADR 0086)", () => {
    const h = harness();
    h.feed.push(started("c1", "run_command", "npm test"));
    h.feed.push(output("c1", "ok\n"));
    const s = h.tick();
    expect(s?.views[0]).toMatchObject({ streams: false, tail: "", lines: 0 });
    expect(s?.views[0]?.ordinal).toBeUndefined();
    expect(s?.startedOps).toBe(0);
  });

  it("the tail is bounded; the line count covers the whole text", () => {
    const h = harness();
    h.feed.push(started("c1", "bash", "yes"));
    const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    h.feed.push(output("c1", `${many}\n`));
    const v = h.tick()?.views[0];
    expect(v?.lines).toBe(500);
    expect(v?.tail.split("\n")).toHaveLength(TAIL_LINES);
    expect(v?.tail.endsWith("line 499")).toBe(true);
  });

  it("throttles: many events, one timer, one emit per window", () => {
    const h = harness();
    for (let i = 0; i < 50; i += 1) {
      h.feed.push(
        delta(
          "c1",
          "str_replace_editor",
          i === 0 ? '{"command":"create","path":"a","file_text":"' : "x",
        ),
      );
    }
    expect(h.timers()).toBe(1);
    h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.views[0]?.tail).toBe("x".repeat(49));
  });

  it("a finished call is marked and KEPT — the record may not have it yet; the next step takes the focus, and only the focused call carries its stream", () => {
    const h = harness();
    h.feed.push(started("c1", "bash", "npm test"));
    h.feed.push(output("c1", "FAIL\n"));
    h.feed.push(finished("c1", "bash", false));
    expect(h.tick()?.views[0]).toMatchObject({
      done: true,
      ok: false,
      tail: "FAIL",
    });
    h.feed.push(started("c2", "str_replace_editor", "view a.ts"));
    const s = h.tick();
    expect(s?.views.map((v) => v.id)).toEqual(["c1", "c2"]);
    expect(s?.focus).toBe("c2");
    expect(s?.views[0]).toMatchObject({ done: true, tail: "", lines: 0 });
  });

  it("numbers the op-making calls as the record numbers their rows; a call with no op row is not counted", () => {
    const h = harness();
    h.feed.push(started("c1", "show_excerpt", "a.ts:1-4"));
    h.feed.push(started("c2", "report_finding", "the cache is stale"));
    h.feed.push(started("c3", "str_replace_editor", "view a.ts"));
    h.feed.push(delta("c4", "bash", '{"command":"npm te'));
    const s = h.tick();
    expect(s?.views.map((v) => [v.id, v.ordinal])).toEqual([
      ["c1", 0],
      ["c2", undefined],
      ["c3", 1],
      ["c4", undefined],
    ]);
    expect(s?.startedOps).toBe(2);
    // A view of a file is a read: no stream.
    expect(s?.views[2]?.streams).toBe(false);
  });

  it("keeps a run's recent calls, bounded — the oldest goes first", () => {
    const h = harness();
    for (let i = 0; i < 40; i += 1) {
      h.feed.push(started(`c${i}`, "str_replace_editor", `view f${i}.ts`));
    }
    const s = h.tick();
    expect(s?.views).toHaveLength(32);
    expect(s?.views[0]?.id).toBe("c8");
    expect(s?.views[31]?.ordinal).toBe(39);
    expect(s?.startedOps).toBe(40);
  });

  it("a draft the finished message does not carry (a retried inference) is dropped", () => {
    const h = harness();
    h.feed.push(
      delta(
        "lost",
        "str_replace_editor",
        '{"command":"create","path":"a","file_text":"x',
      ),
    );
    h.feed.push(
      delta(
        "kept",
        "str_replace_editor",
        '{"command":"create","path":"b","file_text":"y',
      ),
    );
    h.feed.push(
      ev({
        type: "assistant.final",
        layer: "backend",
        message: {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "kept", tool: "str_replace_editor", input: {} }],
          ts: "",
        },
      }),
    );
    expect(h.tick()?.views.map((v) => v.id)).toEqual(["kept"]);
  });

  it("a run's start and end, and lost events, clear every view — the renderer is told once", () => {
    const h = harness();
    h.feed.push(started("c1", "bash", "ls"));
    h.feed.push(output("c1", "a\n"));
    h.tick();
    h.feed.push(
      ev({
        type: "turn.finished",
        layer: "backend",
        summary: {
          durationMs: 1,
          toolCallCount: 1,
          messageCount: 1,
          endedAt: "",
        },
      }),
    );
    expect(h.tick()).toEqual({ views: [], startedOps: 0 });
    const count = h.sent.length;
    // Nothing on screen: nothing more to say.
    h.tick();
    expect(h.sent).toHaveLength(count);
    // A new run opens on its model's first inference: quiet, no views.
    h.feed.push(ev({ type: "turn.started", layer: "backend", userText: "" }));
    expect(h.tick()).toEqual({ views: [], startedOps: 0, quietSince: 1_000 });
    h.feed.push(started("c2", "bash", "ls"));
    h.tick();
    h.feed.push({ kind: "dropped", count: 3 });
    expect(h.tick()).toEqual({ views: [], startedOps: 0 });
  });

  it("the actor layer is not watched; close stops everything", () => {
    const h = harness();
    h.feed.push(
      ev({
        type: "tool.call.delta",
        layer: "actor",
        id: "a",
        tool: "bash",
        argsDelta: '{"command":"x"}',
      }),
    );
    h.tick();
    expect(h.sent).toEqual([]);
    h.feed.push(delta("c1", "bash", '{"command":"x"}'));
    h.feed.close();
    h.tick();
    expect(h.sent).toEqual([]);
  });
});

describe("quietSince: 板砖 thinking between steps (owner 2026-10-12)", () => {
  const runStarted = ev({
    type: "turn.started",
    layer: "backend",
    userText: "",
  });

  it("a run opens quiet; writing the next call keeps it, dispatching it ends it; the last call back starts it again, from then", () => {
    let clock = 1_000;
    const h = harness({ now: () => clock });
    h.feed.push(runStarted);
    expect(h.tick()?.quietSince).toBe(1_000);
    // Still working out that step (lab 2026-10-12: ended here, the row went
    // back to the step before while a heredoc streamed).
    clock = 1_500;
    h.feed.push(delta("w1", "bash", '{"command":"cat > a.py'));
    expect(h.tick()?.quietSince).toBe(1_000);
    h.feed.push(started("w1", "bash", "cat > a.py"));
    expect(h.tick()?.quietSince).toBeUndefined();
    h.feed.push(finished("w1", "bash"));
    h.tick();
    h.feed.push(started("r1", "str_replace_editor", "view a.ts"));
    expect(h.tick()?.quietSince).toBeUndefined();
    clock = 2_000;
    h.feed.push(finished("r1", "str_replace_editor"));
    expect(h.tick()?.quietSince).toBe(2_000);
    // Still the same quiet stretch: its start holds.
    clock = 9_000;
    h.feed.push(finished("r1", "str_replace_editor"));
    expect(h.tick()?.quietSince).toBe(2_000);
  });

  it("a parallel batch is quiet only once its last call is back", () => {
    let clock = 1_000;
    const h = harness({ now: () => clock });
    h.feed.push(runStarted);
    h.feed.push(started("a", "str_replace_editor", "view a.ts"));
    h.feed.push(started("b", "str_replace_editor", "view b.ts"));
    h.feed.push(finished("a", "str_replace_editor"));
    expect(h.tick()?.quietSince).toBeUndefined();
    clock = 3_000;
    h.feed.push(finished("b", "str_replace_editor"));
    expect(h.tick()?.quietSince).toBe(3_000);
  });

  it("an approval wait is not thinking; once answered, the model takes it up", () => {
    let clock = 1_000;
    const h = harness({ now: () => clock });
    h.feed.push(runStarted);
    h.feed.push(
      ev({ type: "permission.requested", layer: "backend" } as AgentEvent),
    );
    expect(h.tick()?.quietSince).toBeUndefined();
    clock = 4_000;
    h.feed.push(
      ev({ type: "permission.resolved", layer: "backend" } as AgentEvent),
    );
    expect(h.tick()?.quietSince).toBe(4_000);
    // Allowed: the call starts at once, and it is busy again.
    h.feed.push(started("c1", "bash", "rm x"));
    expect(h.tick()?.quietSince).toBeUndefined();
  });

  it("a run's end, and lost events, end it", () => {
    const h = harness();
    h.feed.push(runStarted);
    expect(h.tick()?.quietSince).toBe(1_000);
    h.feed.push(
      ev({
        type: "turn.finished",
        layer: "backend",
        summary: {
          durationMs: 1,
          toolCallCount: 0,
          messageCount: 1,
          endedAt: "",
        },
      }),
    );
    expect(h.tick()).toEqual({ views: [], startedOps: 0 });
    h.feed.push(runStarted);
    h.tick();
    h.feed.push({ kind: "dropped", count: 1 });
    expect(h.tick()).toEqual({ views: [], startedOps: 0 });
  });
});
