import type {
  OverlayEvent,
  RecordEvent,
  ResumeEvent,
  Session,
  SessionAgentEvent,
  TurnLifecycleEvent,
} from "@herta/app-server";
import { describe, expect, it } from "vitest";
import {
  type AttentionHost,
  type AttentionNotice,
  type AttentionPrefs,
  LONG_TURN_MS,
  RESUME_SETTLE_MS,
  replyExcerpt,
  watchAttention,
} from "./attention.js";

/** A pushable async stream, as the session's subscriptions are. */
function stream<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(v: T): void {
      queue.push(v);
      wake?.();
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next: async () => {
            while (queue.length === 0 && !closed) {
              await new Promise<void>((r) => {
                wake = r;
              });
            }
            const v = queue.shift();
            return v === undefined
              ? { value: undefined, done: true }
              : { value: v, done: false };
          },
          return: async () => {
            closed = true;
            wake?.();
            return { value: undefined, done: true };
          },
        };
      },
    } as AsyncIterable<T>,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function fixture(
  opts: {
    attended?: boolean;
    prefs?: Partial<AttentionPrefs>;
    lang?: "zh" | "en";
    title?: string | null;
    /** The watcher starts while 板砖 already runs (a re-point mid-run). */
    midRun?: boolean;
  } = {},
) {
  const turn = stream<TurnLifecycleEvent>();
  const agent = stream<SessionAgentEvent>();
  const record = stream<RecordEvent>();
  const overlay = stream<OverlayEvent>();
  const resume = stream<ResumeEvent>();
  const session = {
    title: "title" in opts ? opts.title : "修 parser 的 bug",
    lang: opts.lang ?? "zh",
    turnInFlight: opts.midRun === true,
    backendActive: opts.midRun === true,
    subscribeTurnLifecycle: () => turn.iterable,
    subscribeAgentEvents: () => agent.iterable,
    subscribeRecord: () => record.iterable,
    subscribeOverlay: () => overlay.iterable,
    subscribeResume: () => resume.iterable,
  } as unknown as Session;

  const notices: AttentionNotice[] = [];
  const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
  let clock = 0;
  let held = 0;
  let released = 0;
  let dismissed = 0;
  const state = { attended: opts.attended ?? false };
  const host: AttentionHost = {
    attended: () => state.attended,
    prefs: () => ({ notifications: true, keepAwake: true, ...opts.prefs }),
    locale: () => "zh",
    notify: (n) => notices.push(n),
    dismiss: () => {
      dismissed += 1;
    },
    holdAwake: () => {
      held += 1;
      return () => {
        released += 1;
      };
    },
    setTimer: (fn) => {
      const t = { fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    now: () => clock,
  };
  const stop = watchAttention(session, host);
  const backend = (type: "turn.started" | "turn.finished") =>
    agent.push({ kind: "agent", event: { type, layer: "backend" } as never });
  return {
    turn,
    record,
    overlay,
    resume,
    backend,
    notices,
    state,
    stop,
    advance: (ms: number) => {
      clock += ms;
    },
    fireTimers: () => {
      for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
    },
    awake: () => ({ held, released }),
    dismissed: () => dismissed,
  };
}

const speech = (text: string): RecordEvent => ({
  kind: "block",
  blockId: "b",
  block: { kind: "herta", surface: "speech", text },
});

describe("the attention watcher (ADR 0072 §1)", () => {
  it("started mid-run, it holds the machine awake at once and still notices the reply when the run ends (review 2026-09-30)", async () => {
    const f = fixture({ midRun: true });
    // No turn.started was seen: the session's own state seeds the watcher.
    expect(f.awake()).toEqual({ held: 1, released: 0 });
    f.backend("turn.finished");
    await tick();
    expect(f.awake()).toEqual({ held: 1, released: 1 });
    f.record.push(speech("改好了。"));
    f.turn.push({ kind: "finished" } as unknown as TurnLifecycleEvent);
    await tick();
    f.fireTimers();
    expect(f.notices).toEqual([
      { kind: "reply", title: "修 parser 的 bug", body: "改好了。" },
    ]);
    // Stopped — the window shows another session now — the notice still on
    // screen is taken back: a click on it would front the wrong session.
    f.stop();
    expect(f.dismissed()).toBe(1);
  });

  it("notifies a waiting approval once per request, only while the window is not attended", async () => {
    const f = fixture();
    const pending = (requestId: string): OverlayEvent =>
      ({
        kind: "pending",
        overlay: { kind: "pending-permission", requestId },
      }) as unknown as OverlayEvent;
    f.overlay.push(pending("r1"));
    f.overlay.push(pending("r1"));
    await tick();
    expect(f.notices).toEqual([
      {
        kind: "approval",
        title: "修 parser 的 bug",
        body: "有一项操作正在等待批准。",
      },
    ]);
    f.state.attended = true;
    f.overlay.push(pending("r2"));
    await tick();
    expect(f.notices).toHaveLength(1);
    f.stop();
  });

  it("a turn that ran 板砖 notifies her last line once the 继续 check has had its moment; prose only, code left out", async () => {
    const f = fixture();
    f.turn.push({ kind: "started", turnId: "t" });
    await tick();
    f.backend("turn.started");
    f.backend("turn.finished");
    f.record.push(
      speech("改好了。\n```ts\nconst x = 1;\n```\n全量测试也过了。"),
    );
    await tick();
    f.turn.push({ kind: "finished", turnId: "t" });
    await tick();
    expect(f.notices).toEqual([]);
    f.fireTimers();
    expect(f.notices).toEqual([
      {
        kind: "reply",
        title: "修 parser 的 bug",
        body: "改好了。 全量测试也过了。",
      },
    ]);
    f.stop();
  });

  it("a composer prediction after the turn ends nothing and notifies nothing (2026-10-10)", async () => {
    const f = fixture();
    f.turn.push({ kind: "started", turnId: "p" });
    await tick();
    f.advance(LONG_TURN_MS);
    f.turn.push({ kind: "finished", turnId: "p" });
    await tick();
    f.fireTimers();
    expect(f.notices.map((n) => n.kind)).toEqual(["reply"]);
    // Read as a turn end, it would have queued a second reply notice.
    f.turn.push({ kind: "predicted", turnId: "p", text: "再跑一遍测试" });
    await tick();
    f.fireTimers();
    expect(f.notices.map((n) => n.kind)).toEqual(["reply"]);
    f.stop();
  });

  it("a quick chat reply does not notify; one that took LONG_TURN_MS does", async () => {
    const f = fixture();
    f.turn.push({ kind: "started", turnId: "a" });
    await tick();
    f.advance(LONG_TURN_MS - 1);
    f.turn.push({ kind: "finished", turnId: "a" });
    await tick();
    f.fireTimers();
    expect(f.notices).toEqual([]);

    f.turn.push({ kind: "started", turnId: "b" });
    await tick();
    f.advance(LONG_TURN_MS);
    f.turn.push({ kind: "finished", turnId: "b" });
    await tick();
    f.fireTimers();
    expect(f.notices.map((n) => n.kind)).toEqual(["reply"]);
    // No speech recorded: the plain label stands in.
    expect(f.notices[0]?.body).toBe("黑塔已回复。");
    f.stop();
  });

  it("a 继续 offer after the turn replaces the reply notice", async () => {
    const f = fixture();
    f.turn.push({ kind: "started", turnId: "t" });
    await tick();
    f.backend("turn.started");
    await tick();
    f.turn.push({ kind: "finished", turnId: "t" });
    await tick();
    f.resume.push({ kind: "offer", resumable: true });
    await tick();
    f.fireTimers();
    expect(f.notices.map((n) => n.kind)).toEqual(["resume"]);
    expect(RESUME_SETTLE_MS).toBeGreaterThan(0);
    f.stop();
  });

  it("a failed turn notifies; a Stop the user pressed does not", async () => {
    const f = fixture();
    f.turn.push({ kind: "started", turnId: "a" });
    f.turn.push({
      kind: "failed",
      turnId: "a",
      error: { code: "AbortError", message: "stopped" },
    });
    f.turn.push({ kind: "started", turnId: "b" });
    f.turn.push({
      kind: "failed",
      turnId: "b",
      error: { code: "ProviderError", message: "502", status: 502 },
    });
    await tick();
    expect(f.notices.map((n) => n.kind)).toEqual(["failed"]);
    f.stop();
  });

  it("notifies nothing with the setting off", async () => {
    const f = fixture({ prefs: { notifications: false } });
    f.overlay.push({
      kind: "pending",
      overlay: { kind: "pending-permission", requestId: "r" },
    } as unknown as OverlayEvent);
    f.resume.push({ kind: "offer", resumable: true });
    await tick();
    expect(f.notices).toEqual([]);
    f.stop();
  });

  it("keeps the machine awake while 板砖 runs, and releases at its end, at the turn's end, and on stop", async () => {
    const f = fixture();
    f.backend("turn.started");
    await tick();
    expect(f.awake()).toEqual({ held: 1, released: 0 });
    f.backend("turn.started"); // one hold, however many edges
    await tick();
    expect(f.awake()).toEqual({ held: 1, released: 0 });
    f.backend("turn.finished");
    await tick();
    expect(f.awake()).toEqual({ held: 1, released: 1 });

    // A run whose own end is lost is released with its turn.
    f.backend("turn.started");
    await tick();
    f.turn.push({ kind: "finished", turnId: "t" });
    await tick();
    expect(f.awake()).toEqual({ held: 2, released: 2 });

    // And a watcher stopped mid-run lets go.
    f.backend("turn.started");
    await tick();
    f.stop();
    expect(f.awake()).toEqual({ held: 3, released: 3 });
  });

  it("does not hold the machine awake with that setting off", async () => {
    const f = fixture({ prefs: { keepAwake: false } });
    f.backend("turn.started");
    await tick();
    expect(f.awake()).toEqual({ held: 0, released: 0 });
    f.stop();
  });

  it("an EN session's title and her line show Brick for 板砖; an untitled session is titled by the app", async () => {
    const f = fixture({ lang: "en", title: null });
    f.turn.push({ kind: "started", turnId: "t" });
    await tick();
    f.backend("turn.started");
    f.record.push(speech("@板砖 finished the migration."));
    await tick();
    f.turn.push({ kind: "finished", turnId: "t" });
    await tick();
    f.fireTimers();
    expect(f.notices[0]).toEqual({
      kind: "reply",
      title: "黑塔",
      body: "@Brick finished the migration.",
    });
    f.stop();
  });
});

describe("replyExcerpt", () => {
  it("is one line, prose only, and clipped", () => {
    expect(replyExcerpt("  a\n\nb  ", "zh")).toBe("a b");
    expect(replyExcerpt("```\nonly code\n```", "zh")).toBe("");
    // An unclosed fence (a reply cut off mid-code) drops the rest.
    expect(replyExcerpt("看这个：\n```ts\nlet a", "zh")).toBe("看这个：");
    const long = "字".repeat(200);
    const out = replyExcerpt(long, "zh");
    expect([...out]).toHaveLength(120);
    expect(out.endsWith("…")).toBe(true);
  });
});
