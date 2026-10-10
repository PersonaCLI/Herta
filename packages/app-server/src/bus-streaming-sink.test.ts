import {
  type AgentEvent,
  InMemoryEventBus,
  type TerminalRecordBlock,
} from "@herta/core";
import {
  PUNCTUATION_PAUSE_RATIO,
  startupDelayMs,
  TARGET_VISIBLE_MS,
} from "@herta/herta";
import { describe, expect, it, vi } from "vitest";
import {
  BusActorStreamingSink,
  SLOW_MS_PER_CHAR,
} from "./bus-streaming-sink.js";
import type { RecordEvent, SpeechControlEvent } from "./types.js";

describe("BusActorStreamingSink.slowStreamSpeech", () => {
  it("holds near the end while the verdict is pending; fastForward drains paced at base cadence", async () => {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus<AgentEvent>();
    const deltas: string[] = [];
    bus.on("assistant.delta", (e) => deltas.push((e as { text: string }).text));
    // Inject deterministic random (0.5 → zero jitter) for timing assertions.
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      () => undefined,
      () => 0.5,
    );
    let resolveVerdict!: () => void;
    const verdictPending = new Promise<void>((r) => {
      resolveVerdict = r;
    });
    const text = "零一二三四五六七八九拾壹貳叁肆伍陸柒捌玖"; // 20 chars → holdIndex 18
    const ctrl = sink.slowStreamSpeech(text, { verdictPending });
    // Run far longer than 20 chars would need at any multiplier: the stream
    // must be HELD two chars short of completion, not finished.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deltas.join("")).toBe(text.slice(0, 18));
    // Still held — more time changes nothing.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deltas.join("")).toBe(text.slice(0, 18));
    // Verdict OK → actor calls fastForward → paced drain at NORMAL cadence
    // (not a jarring 10x speed burst). One char per SLOW_MS_PER_CHAR tick.
    resolveVerdict();
    const countBefore = deltas.length;
    const ff = ctrl.fastForward();
    // After SLOW_MS_PER_CHAR ms the first held char appears (base cadence,
    // not a dump). fastForward resumes at normal speed — no speed change.
    await vi.advanceTimersByTimeAsync(SLOW_MS_PER_CHAR);
    expect(deltas.length).toBe(countBefore + 1);
    await vi.advanceTimersByTimeAsync(1_000);
    await ff;
    await ctrl.done;
    expect(deltas.join("")).toBe(text);
    expect(deltas.length).toBe(countBefore + 2); // two separate drained deltas
    vi.useRealTimers();
  });

  it("front-loads an adaptive startup buffer for a supervised short line", async () => {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus<AgentEvent>();
    const deltas: string[] = [];
    bus.on("assistant.delta", (e) => deltas.push((e as { text: string }).text));
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      () => undefined,
      () => 0.5,
    );
    const text = "好嘞收到"; // 4 chars → short, so the buffer is large
    const startup = startupDelayMs({ total: 4, baseMs: SLOW_MS_PER_CHAR });
    expect(startup).toBeGreaterThan(0); // a short line DOES front-load
    const ctrl = sink.slowStreamSpeech(text, {
      verdictPending: new Promise<void>(() => {}), // never resolves
    });
    ctrl.done.catch(() => undefined);
    // The supervisor wait shifts UP FRONT: nothing streams during the buffer
    // (the 消息正在穿越银河 hint stays), instead of the last char parking at the
    // back of an otherwise-fast reveal.
    await vi.advanceTimersByTimeAsync(startup);
    expect(deltas.join("")).toBe("");
    // Then the first char appears at base cadence.
    await vi.advanceTimersByTimeAsync(SLOW_MS_PER_CHAR);
    expect(deltas.join("")).toBe("好");
    vi.useRealTimers();
  });

  it("resolves done for empty text without emitting", async () => {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus<AgentEvent>();
    const deltas: string[] = [];
    bus.on("assistant.delta", (e) => deltas.push((e as { text: string }).text));
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      () => undefined,
      () => 0.5,
    );
    const ctrl = sink.slowStreamSpeech("");
    await vi.advanceTimersByTimeAsync(100);
    await ctrl.done;
    expect(deltas).toEqual([]);
    vi.useRealTimers();
  });

  it("paces an unsupervised stream at baseMsOverride instead of the default", async () => {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus<AgentEvent>();
    const deltas: string[] = [];
    bus.on("assistant.delta", (e) => deltas.push((e as { text: string }).text));
    // Zero jitter (0.5) so spacing is exactly the base. No verdict → no
    // ramp/hold/startup; each char lands one base apart.
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      () => undefined,
      () => 0.5,
    );
    const base = 200; // distinct from SLOW_MS_PER_CHAR (80)
    const text = "一二三"; // no punctuation → flat base cadence
    const ctrl = sink.slowStreamSpeech(text, { baseMsOverride: base });
    // Just before the first base elapses: nothing yet (proves it isn't the
    // faster 80ms default, which would have emitted by now).
    await vi.advanceTimersByTimeAsync(base - 1);
    expect(deltas.join("")).toBe("");
    await vi.advanceTimersByTimeAsync(1); // t = base
    expect(deltas.join("")).toBe("一");
    await vi.advanceTimersByTimeAsync(base);
    expect(deltas.join("")).toBe("一二");
    await vi.advanceTimersByTimeAsync(base);
    await ctrl.done;
    expect(deltas.join("")).toBe("一二三");
    vi.useRealTimers();
  });

  it("ramps the cadence in the verdict-pending band instead of a fixed multiplier", async () => {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus<AgentEvent>();
    const deltas: string[] = [];
    bus.on("assistant.delta", (e) => deltas.push((e as { text: string }).text));
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      () => undefined,
      () => 0.5,
    );
    const text = "a".repeat(100);
    sink.slowStreamSpeech(text, { verdictPending: new Promise(() => {}) });
    // 55 chars at the base cadence reach the ramp; give it exactly that.
    await vi.advanceTimersByTimeAsync(55 * SLOW_MS_PER_CHAR + 1);
    const atRampStart = deltas.length;
    expect(atRampStart).toBeGreaterThanOrEqual(54);
    // The next 1540ms used to produce another ~55 chars (or 23 at the old
    // fixed 2.4x). With the ramp the cadence keeps stretching: strictly
    // fewer than the pre-ramp rate, and the stream must NOT complete.
    await vi.advanceTimersByTimeAsync(55 * SLOW_MS_PER_CHAR);
    expect(deltas.length - atRampStart).toBeLessThan(40);
    expect(deltas.length).toBeLessThan(92); // never past the hold index
    vi.useRealTimers();
  });

  it("unsupervised streams (no verdictPending) never ramp and never hold", async () => {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus<AgentEvent>();
    const deltas: string[] = [];
    bus.on("assistant.delta", (e) => deltas.push((e as { text: string }).text));
    // Inject deterministic random (0.5 → zero jitter) so exact tick math works.
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      () => undefined,
      () => 0.5,
    );
    const text = "beat-speech-without-supervisor";
    const ctrl = sink.slowStreamSpeech(text); // no opts at all
    // Exactly total*base (+1 tick) must complete it — no slowdown anywhere.
    await vi.advanceTimersByTimeAsync(
      text.length * SLOW_MS_PER_CHAR + SLOW_MS_PER_CHAR,
    );
    await ctrl.done;
    expect(deltas.join("")).toBe(text);
    vi.useRealTimers();
  });

  it("cancelAndBackspace from the held position emits one retract", async () => {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus<AgentEvent>();
    let retracts = 0;
    const sink = new BusActorStreamingSink(
      bus,
      () => {
        retracts += 1;
      },
      () => undefined,
      () => 0.5,
    );
    const ctrl = sink.slowStreamSpeech("零一二三四五六七八九", {
      verdictPending: new Promise(() => {}),
    });
    ctrl.done.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000); // reach the hold
    await ctrl.cancelAndBackspace();
    expect(retracts).toBe(1);
    await expect(ctrl.done).rejects.toThrow("slow-stream cancelled");
    vi.useRealTimers();
  });

  it("cancelAndBackspace emits one retract and resolves immediately (no renderer-time wait); done rejects", async () => {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus<AgentEvent>();
    let retracts = 0;
    const sink = new BusActorStreamingSink(
      bus,
      () => {
        retracts += 1;
      },
      () => undefined,
      () => 0.5,
    );
    const ctrl = sink.slowStreamSpeech("候选答复测试");
    // Swallow the contractual done-rejection so it isn't an unhandled rejection.
    ctrl.done.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(100); // a few chars emitted
    let resolved = false;
    const p = ctrl.cancelAndBackspace().then(() => {
      resolved = true;
    });
    // Drain microtasks ONLY — no timer advancement. The retry must be able
    // to start while the renderer's shrink is still animating (the old
    // implementation blocked here for emitted × 25ms of fake time).
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);
    expect(retracts).toBe(1);
    await expect(ctrl.done).rejects.toThrow("slow-stream cancelled");
    await p;
    // Idempotent: a second call is a no-op (no second retract event).
    await ctrl.cancelAndBackspace();
    expect(retracts).toBe(1);
    vi.useRealTimers();
  });

  it("punctuation pause: 。 delays the next char by PUNCTUATION_PAUSE_RATIO×base extra", async () => {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus<AgentEvent>();
    const deltas: string[] = [];
    bus.on("assistant.delta", (e) => deltas.push((e as { text: string }).text));
    // Unsupervised stream (no verdictPending); deterministic random (zero jitter).
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      () => undefined,
      () => 0.5,
    );
    sink.slowStreamSpeech("好。x");
    // First char "好" emitted after SLOW_MS_PER_CHAR.
    await vi.advanceTimersByTimeAsync(SLOW_MS_PER_CHAR);
    expect(deltas.join("")).toBe("好");
    // Second char "。" emitted after another SLOW_MS_PER_CHAR.
    await vi.advanceTimersByTimeAsync(SLOW_MS_PER_CHAR);
    expect(deltas.join("")).toBe("好。");
    // After "。", the next delay is SLOW_MS_PER_CHAR * (1 + PUNCTUATION_PAUSE_RATIO).
    // Advance one ms short — "x" must NOT be emitted yet.
    await vi.advanceTimersByTimeAsync(
      SLOW_MS_PER_CHAR * (1 + PUNCTUATION_PAUSE_RATIO) - 1,
    );
    expect(deltas.join("")).toBe("好。");
    // Advance the final ms — "x" now appears.
    await vi.advanceTimersByTimeAsync(1);
    expect(deltas.join("")).toBe("好。x");
    vi.useRealTimers();
  });
});

describe("BusActorStreamingSink — flushRemainder + reveal ceiling (slice 3)", () => {
  function mkSink(): {
    sink: BusActorStreamingSink;
    deltas: string[];
  } {
    const bus = new InMemoryEventBus<AgentEvent>();
    const deltas: string[] = [];
    bus.on("assistant.delta", (e) => deltas.push((e as { text: string }).text));
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      () => undefined,
      () => 0.5, // zero jitter
    );
    return { sink, deltas };
  }

  it("flushRemainder mid-drain lands the exact tail in ONE delta and resolves done", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mkSink();
    const text = "零一二三四五六七八九拾壹貳叁肆伍陸柒捌玖";
    const ctrl = sink.slowStreamSpeech(text);
    await vi.advanceTimersByTimeAsync(3 * SLOW_MS_PER_CHAR); // 3 chars out
    expect(deltas.join("")).toBe(text.slice(0, 3));
    ctrl.flushRemainder?.();
    // Synchronous flush: the whole tail in one delta, no loss, no dupes.
    expect(deltas.join("")).toBe(text);
    expect(deltas[deltas.length - 1]).toBe(text.slice(3));
    await ctrl.done;
    // No further ticks fire.
    const count = deltas.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deltas.length).toBe(count);
    // Idempotent.
    ctrl.flushRemainder?.();
    expect(deltas.length).toBe(count);
    vi.useRealTimers();
  });

  it("flushRemainder unblocks a post-verdict paced drain (the interrupt path)", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mkSink();
    let resolveVerdict!: () => void;
    const verdictPending = new Promise<void>((r) => {
      resolveVerdict = r;
    });
    const text = "零一二三四五六七八九拾壹貳叁肆伍陸柒捌玖"; // 20 chars → hold at 18
    const ctrl = sink.slowStreamSpeech(text, { verdictPending });
    await vi.advanceTimersByTimeAsync(120_000); // reach the hold
    resolveVerdict();
    let drained = false;
    const ff = ctrl.fastForward().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(SLOW_MS_PER_CHAR); // one paced char
    expect(drained).toBe(false); // paced drain still in flight
    ctrl.flushRemainder?.(); // ← the stop click
    await ff;
    expect(drained).toBe(true);
    expect(deltas.join("")).toBe(text); // fast-forwarded, never truncated
    vi.useRealTimers();
  });

  it("reveal ceiling: a pathological body flushes its tail in one delta past MAX_REVEAL_MS", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mkSink();
    const text = "字".repeat(1000); // 80s of paced reveal without the ceiling
    const ctrl = sink.slowStreamSpeech(text);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deltas.join("")).toBe(text); // complete well before 80s
    // Paced prefix + ONE flushed tail — not 1000 per-char deltas.
    expect(deltas.length).toBeLessThan(300);
    expect(deltas[deltas.length - 1]?.length ?? 0).toBeGreaterThan(1);
    await ctrl.done;
    vi.useRealTimers();
  });

  it("reveal ceiling: short replies are byte-for-byte unchanged (per-char deltas)", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mkSink();
    const text = "普通长度的一句回话。";
    const ctrl = sink.slowStreamSpeech(text);
    await vi.advanceTimersByTimeAsync(60_000);
    await ctrl.done;
    expect(deltas.join("")).toBe(text);
    expect(deltas.length).toBe([...text].length); // still one delta per char
    vi.useRealTimers();
  });

  it("ceiling never fires while the verdict is pending; anchor restarts on resolve", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mkSink();
    let resolveVerdict!: () => void;
    const verdictPending = new Promise<void>((r) => {
      resolveVerdict = r;
    });
    const text = "零一二三四五六七八九拾壹貳叁肆伍陸柒捌玖"; // hold at 18
    const ctrl = sink.slowStreamSpeech(text, { verdictPending });
    // FAR past the ceiling: the hold must still gate the tail (never flush
    // past a pending supervisor).
    await vi.advanceTimersByTimeAsync(120_000);
    expect(deltas.join("")).toBe(text.slice(0, 18));
    // Verdict resolves → the paced drain proceeds PACED (anchor restarted;
    // the long supervisor wait does not count against the ceiling).
    resolveVerdict();
    const before = deltas.length;
    const ff = ctrl.fastForward();
    await vi.advanceTimersByTimeAsync(SLOW_MS_PER_CHAR);
    expect(deltas.length).toBe(before + 1); // one char, still per-char paced
    await vi.advanceTimersByTimeAsync(1_000);
    await ff;
    expect(deltas.join("")).toBe(text);
    vi.useRealTimers();
  });

  it("live controller: flushRemainder flushes the buffered tail and finishes even mid-input", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mkSink();
    const live = sink.slowStreamSpeechLive({});
    live.pushToken("零一二三四五六七八九");
    await vi.advanceTimersByTimeAsync(2 * SLOW_MS_PER_CHAR); // 2 chars out
    expect(deltas.join("")).toBe("零一");
    live.flushRemainder?.(); // interrupt: generator is aborted with us
    expect(deltas.join("")).toBe("零一二三四五六七八九");
    await live.done;
    vi.useRealTimers();
  });

  it("slice 5: a ``` fence region emits atomically in ONE delta (unsupervised)", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mkSink();
    const text = "看这段：\n```ts\nconst x = 1;\nconst y = 2;\n```\n就这样。";
    const ctrl = sink.slowStreamSpeech(text);
    await vi.advanceTimersByTimeAsync(60_000);
    await ctrl.done;
    expect(deltas.join("")).toBe(text);
    // The whole fence (open line → close line + newline) is one delta.
    expect(deltas).toContain("```ts\nconst x = 1;\nconst y = 2;\n```\n");
    // The prose around it still paces per-char.
    expect(deltas[0]).toBe("看");
    vi.useRealTimers();
  });

  it("slice 5: the atomic fence emit never crosses a pending verdict hold", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mkSink();
    // Long fence so holdIndexFor lands INSIDE the fence region.
    const code = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const text = `\`\`\`\n${code}\n\`\`\``;
    const ctrl = sink.slowStreamSpeech(text, {
      verdictPending: new Promise<void>(() => {}), // never resolves
    });
    ctrl.done.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(120_000);
    const total = [...text].length;
    const emitted = [...deltas.join("")].length;
    // Something emitted (the clamped fence chunk), but the gate held the tail.
    expect(emitted).toBeGreaterThan(0);
    expect(emitted).toBeLessThan(total);
    vi.useRealTimers();
  });
});

describe("BusActorStreamingSink.flushBlocks (canonical-diff record emit)", () => {
  it("emits each newly-appended block once, in record order, including user blocks", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const emitted: RecordEvent[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      (ev) => emitted.push(ev),
    );

    sink.flushBlocks([{ kind: "user", text: "hi" }]);
    sink.flushBlocks([
      { kind: "user", text: "hi" },
      { kind: "herta", surface: "speech", text: "@板砖 去看看" },
    ]);
    sink.flushBlocks([
      { kind: "user", text: "hi" },
      { kind: "herta", surface: "speech", text: "@板砖 去看看" },
      { kind: "system", label: "差分协处理器", body: "Reading a.ts" },
    ]);

    expect(emitted).toHaveLength(3);
    expect(emitted.every((e) => e.kind === "block")).toBe(true);
    const blocks = emitted.map((e) => (e.kind === "block" ? e.block : null));
    expect(blocks[0]).toMatchObject({ kind: "user", text: "hi" });
    expect(blocks[1]).toMatchObject({ kind: "herta", surface: "speech" });
    expect(blocks[2]).toMatchObject({ kind: "system", label: "差分协处理器" });
    expect(
      emitted.every((e) => e.kind === "block" && e.blockId.length > 0),
    ).toBe(true);
  });

  it("does not re-emit when called again with an unchanged record", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const emitted: RecordEvent[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      (ev) => emitted.push(ev),
    );
    const record = [{ kind: "user" as const, text: "hi" }];
    sink.flushBlocks(record);
    sink.flushBlocks(record);
    sink.flushBlocks(record);
    expect(emitted).toHaveLength(1);
  });

  it("seedEmittedCount skips pre-existing blocks (resume / opening seed)", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const emitted: RecordEvent[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      (ev) => emitted.push(ev),
    );
    sink.seedEmittedCount(2);
    sink.flushBlocks([
      { kind: "herta", surface: "speech", text: "seed-0" },
      { kind: "user", text: "seed-1" },
      { kind: "user", text: "new-2" },
    ]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "block",
      block: { text: "new-2" },
    });
  });
});

describe("BusActorStreamingSink.resyncRecord (record-drop heal)", () => {
  it("re-emits seeded + flushed blocks as one reset, with the stamped copies", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const emitted: RecordEvent[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      (ev) => emitted.push(ev),
      () => 0.5,
      () => "2026-07-09T00:00:00.000Z",
    );
    // Loaded-on-resume block (already stamped on disk) skipped by the cursor…
    const loaded = {
      kind: "user" as const,
      text: "seed-0",
      at: "2026-07-08T00:00:00.000Z",
    };
    sink.seedEmittedCount(1, [loaded]);
    // …then one live block flushed (stamped by the sink on emit).
    sink.flushBlocks([loaded, { kind: "user", text: "live-1" }]);

    sink.resyncRecord();

    const reset = emitted[emitted.length - 1];
    expect(reset).toEqual({
      kind: "reset",
      record: [
        loaded,
        // The mirror holds the STAMPED emitted copy, so the heal reset
        // carries the same `at` the GUI saw on the live stream.
        { kind: "user", text: "live-1", at: "2026-07-09T00:00:00.000Z" },
      ],
      // Windowing (2026-07-12): every full-record payload carries its
      // absolute window start; a short record is whole, so 0.
      start: 0,
    });
    // The reset record matches what the block stream delivered (no dup/gap).
    const streamedBlocks = emitted
      .filter((e) => e.kind === "block")
      .map((e) => (e.kind === "block" ? e.block : undefined));
    expect(streamedBlocks).toEqual([
      { kind: "user", text: "live-1", at: "2026-07-09T00:00:00.000Z" },
    ]);
  });

  it("includes a committed opening seed in the heal", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const emitted: RecordEvent[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      (ev) => emitted.push(ev),
      () => 0.5,
      () => "2026-07-09T00:00:00.000Z",
    );
    sink.seedEmittedCount(0, []);
    sink.commitOpeningSeed({ kind: "herta", surface: "speech", text: "开场" });
    sink.resyncRecord();
    expect(emitted[emitted.length - 1]).toEqual({
      kind: "reset",
      start: 0,
      record: [
        {
          kind: "herta",
          surface: "speech",
          text: "开场",
          at: "2026-07-09T00:00:00.000Z",
        },
      ],
    });
  });

  it("no-ops when the mirror was seeded without its record (invariant guard)", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const emitted: RecordEvent[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      (ev) => emitted.push(ev),
    );
    // Count-only seed (older-style caller): the mirror can't know the two
    // skipped blocks, so a heal would emit a WRONG record — prefer not healing.
    sink.seedEmittedCount(2);
    sink.resyncRecord();
    expect(emitted).toHaveLength(0);
  });
});

describe("BusActorStreamingSink.flushBlocks persistence hook (D1)", () => {
  it("persists each newly-flushed block once, in record order, riding the same cursor as the emit", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const emitted: RecordEvent[] = [];
    const persisted: TerminalRecordBlock[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      (ev) => emitted.push(ev),
    );
    sink.setPersistHook((b) => persisted.push(b));

    sink.flushBlocks([{ kind: "user", text: "hi" }]);
    sink.flushBlocks([
      { kind: "user", text: "hi" },
      { kind: "herta", surface: "speech", text: "答复" },
    ]);
    // Unchanged record → nothing new to persist (idempotent, like the emit).
    sink.flushBlocks([
      { kind: "user", text: "hi" },
      { kind: "herta", surface: "speech", text: "答复" },
    ]);

    expect(persisted).toEqual([
      { kind: "user", text: "hi" },
      { kind: "herta", surface: "speech", text: "答复" },
    ]);
    // Persist count tracks the emit count — same blocks, same cursor.
    expect(persisted).toHaveLength(emitted.length);
  });

  it("does not re-persist blocks before the seeded cursor (resume / opening seed)", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const persisted: TerminalRecordBlock[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      () => undefined,
    );
    sink.setPersistHook((b) => persisted.push(b));
    sink.seedEmittedCount(2); // two blocks already on disk
    sink.flushBlocks([
      { kind: "herta", surface: "speech", text: "seed-0" },
      { kind: "user", text: "seed-1" },
      { kind: "user", text: "new-2" },
    ]);
    expect(persisted).toEqual([{ kind: "user", text: "new-2" }]);
  });

  it("persists BEFORE projecting to the render surface (durable-first ordering)", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const order: string[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      () => order.push("emit"),
    );
    sink.setPersistHook(() => order.push("persist"));
    sink.flushBlocks([{ kind: "user", text: "hi" }]);
    expect(order).toEqual(["persist", "emit"]);
  });

  it("without a persist hook, flushBlocks still emits (hook-less sinks fall back to the driver's batch persist)", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const emitted: RecordEvent[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      (ev) => emitted.push(ev),
    );
    sink.flushBlocks([{ kind: "user", text: "hi" }]);
    expect(emitted).toHaveLength(1);
  });
});

describe("BusActorStreamingSink.commitOpeningSeed (D3)", () => {
  it("emits the seed (settle) and advances the cursor, but does NOT persist it", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const emitted: RecordEvent[] = [];
    const persisted: TerminalRecordBlock[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      (ev) => emitted.push(ev),
    );
    sink.setPersistHook((b) => persisted.push(b));
    const seed = {
      kind: "herta" as const,
      surface: "speech" as const,
      text: "你来了。",
    };

    sink.commitOpeningSeed(seed);
    // Emitted to the render surface so the streaming bubble settles…
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: "block",
      block: { text: "你来了。" },
    });
    // …but NOT persisted (the seed was already written to disk at create).
    expect(persisted).toEqual([]);
    // Cursor advanced: a following flushBlocks does not re-emit the seed.
    sink.flushBlocks([seed]);
    expect(emitted).toHaveLength(1);
  });
});

describe("BusActorStreamingSink.slowStreamSpeechLive", () => {
  function mk() {
    const bus = new InMemoryEventBus<AgentEvent>();
    const deltas: string[] = [];
    bus.on("assistant.delta", (e) => deltas.push((e as { text: string }).text));
    const speech: import("./types.js").SpeechControlEvent[] = [];
    const records: import("./types.js").RecordEvent[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      (e) => speech.push(e),
      (e) => records.push(e),
      () => 0.5,
    );
    return { sink, deltas, speech, records };
  }

  it("emits at 1x while input is open and finishes after finishInput drains", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mk();
    const c = sink.slowStreamSpeechLive();
    c.pushToken("一二");
    await vi.runAllTimersAsync();
    expect(deltas.join("")).toBe("一二"); // starved at end, not finished → holds
    c.pushToken("三");
    c.finishInput();
    await vi.runAllTimersAsync();
    await c.done;
    expect(deltas.join("")).toBe("一二三");
    vi.useRealTimers();
  });

  it("holds the tail for a pending verdict, then fastForward drains it", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mk();
    let resolveVerdict!: () => void;
    const verdictPending = new Promise<void>((r) => {
      resolveVerdict = r;
    });
    const c = sink.slowStreamSpeechLive({ verdictPending });
    c.pushToken("一二三四五六七八九十"); // 10 chars
    c.finishInput();
    await vi.runAllTimersAsync();
    expect([...deltas.join("")].length).toBeGreaterThan(0);
    expect([...deltas.join("")].length).toBeLessThan(10);
    resolveVerdict();
    const ff = c.fastForward();
    await vi.runAllTimersAsync();
    await ff;
    await c.done;
    expect(deltas.join("")).toBe("一二三四五六七八九十");
    vi.useRealTimers();
  });

  it("emits a CLOSED code fence atomically in one delta (audit 2026-07-16: the live lane had no fence handling)", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mk();
    const c = sink.slowStreamSpeechLive();
    const text = "看这个：\n```ts\nconst x = 1;\nconst y = 2;\n```\n完了";
    c.pushToken(text);
    c.finishInput();
    await vi.runAllTimersAsync();
    await c.done;
    expect(deltas.join("")).toBe(text);
    // The whole fenced region arrived as ONE delta, not a per-char crawl.
    const fenceDelta = deltas.find((d) => d.includes("```ts"));
    expect(fenceDelta).toBe("```ts\nconst x = 1;\nconst y = 2;\n```\n");
  });

  it("holds a STILL-OPEN fence until its close arrives, then emits it whole", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mk();
    const c = sink.slowStreamSpeechLive();
    c.pushToken("代码：\n```ts\nconst x = 1;\n");
    await vi.runAllTimersAsync();
    // The prose revealed; the open fence held (its close hasn't arrived) —
    // no code chars leaked out at speech cadence.
    expect(deltas.join("")).toBe("代码：\n");
    c.pushToken("const y = 2;\n```\n好了");
    c.finishInput();
    await vi.runAllTimersAsync();
    await c.done;
    expect(deltas.join("")).toBe(
      "代码：\n```ts\nconst x = 1;\nconst y = 2;\n```\n好了",
    );
    const fenceDelta = deltas.find((d) => d.startsWith("```ts"));
    expect(fenceDelta).toBe("```ts\nconst x = 1;\nconst y = 2;\n```\n");
    vi.useRealTimers();
  });

  it("cancelAndBackspace after some text emits a retract control event", async () => {
    vi.useFakeTimers();
    const { sink, deltas, speech } = mk();
    // Verdict stays pending — the cancel (veto) is the terminal path here.
    const verdictPending = new Promise<void>(() => {});
    const c = sink.slowStreamSpeechLive({ verdictPending });
    c.pushToken("一二三");
    c.finishInput();
    // Past the front-load startup (≤ TARGET_VISIBLE_MS covers it) so text is
    // visible before the veto — the mid-reveal retract case.
    await vi.advanceTimersByTimeAsync(TARGET_VISIBLE_MS + 500);
    expect([...deltas.join("")].length).toBeGreaterThan(0);
    await c.cancelAndBackspace();
    expect(speech.some((e) => e.kind === "retract")).toBe(true);
    await expect(c.done).rejects.toThrow(/cancelled/);
    vi.useRealTimers();
  });

  // ── Front-gate (2026-07-11 live-reveal-front-load spec) ────────────────

  it("a SUPERVISED short candidate reveals nothing until finishInput (front-load)", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mk();
    const verdictPending = new Promise<void>(() => {});
    const c = sink.slowStreamSpeechLive({ verdictPending });
    c.pushToken("好，我看看。"); // 6 chars — far below the backlog threshold
    // Pre-fix this revealed at TTFT and froze at the 92% hold for the whole
    // supervisor round-trip. Now the wait sits BEFORE the text.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deltas).toEqual([]);
    c.finishInput();
    await vi.runAllTimersAsync();
    // The reveal ran up to the clause-boundary hold — moving, then gated.
    expect([...deltas.join("")].length).toBeGreaterThan(0);
    expect([...deltas.join("")].length).toBeLessThan(6);
    c.flushRemainder?.();
    await c.done;
    vi.useRealTimers();
  });

  it("a SUPERVISED long backlog opens the reveal before finishInput (threshold path)", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mk();
    const verdictPending = new Promise<void>(() => {});
    const c = sink.slowStreamSpeechLive({ verdictPending });
    // ≥ TARGET_VISIBLE_MS / 80ms = 35 chars buffered: the un-ramped reveal
    // already spans the target — long replies behave exactly as before.
    c.pushToken("零一二三四五六七八九".repeat(4)); // 40 chars
    await vi.advanceTimersByTimeAsync(1_000);
    expect([...deltas.join("")].length).toBeGreaterThan(0);
    c.finishInput();
    c.flushRemainder?.();
    await c.done;
    vi.useRealTimers();
  });

  it("fastForward during the front wait skips the startup remainder", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mk();
    let resolveVerdict!: () => void;
    const verdictPending = new Promise<void>((r) => {
      resolveVerdict = r;
    });
    const c = sink.slowStreamSpeechLive({ verdictPending });
    c.pushToken("一二三四五");
    c.finishInput(); // arms the ~2s front-load
    await vi.advanceTimersByTimeAsync(100);
    expect(deltas).toEqual([]);
    // Verdict lands early: the reveal starts NOW at base cadence — well
    // inside 1s for 5 chars — instead of waiting out the startup.
    resolveVerdict();
    const ff = c.fastForward();
    await vi.advanceTimersByTimeAsync(1_000);
    await ff;
    await c.done;
    expect(deltas.join("")).toBe("一二三四五");
    vi.useRealTimers();
  });

  it("a veto during the front wait retracts NOTHING (no visible text yet)", async () => {
    vi.useFakeTimers();
    const { sink, deltas, speech } = mk();
    const verdictPending = new Promise<void>(() => {});
    const c = sink.slowStreamSpeechLive({ verdictPending });
    c.pushToken("称呼错了的候选");
    c.finishInput();
    await vi.advanceTimersByTimeAsync(100); // still inside the front wait
    expect(deltas).toEqual([]);
    await c.cancelAndBackspace();
    // cursor is 0 — the retract morph is skipped; the retry streams fresh.
    expect(speech.some((e) => e.kind === "retract")).toBe(false);
    await expect(c.done).rejects.toThrow(/cancelled/);
    vi.useRealTimers();
  });

  it("flushRemainder during the front wait lands the full text in one delta", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = mk();
    const verdictPending = new Promise<void>(() => {});
    const c = sink.slowStreamSpeechLive({ verdictPending });
    c.pushToken("一二三");
    c.finishInput();
    await vi.advanceTimersByTimeAsync(100);
    expect(deltas).toEqual([]);
    c.flushRemainder?.();
    expect(deltas).toEqual(["一二三"]);
    await c.done;
    vi.useRealTimers();
  });

  it("empty input (zero pushTokens) finishes cleanly with no deltas and no retract", async () => {
    vi.useFakeTimers();
    const { sink, deltas, speech } = mk();
    const c = sink.slowStreamSpeechLive();
    c.finishInput();
    await vi.runAllTimersAsync();
    await c.done;
    expect(deltas).toEqual([]);
    expect(speech.some((e) => e.kind === "retract")).toBe(false);
    vi.useRealTimers();
  });
});

describe("BusActorStreamingSink.emitRetractFloor", () => {
  it("emits a retractFloor speech-control event carrying keepLen", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const events: SpeechControlEvent[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      (ev) => events.push(ev),
      () => undefined,
    );
    sink.emitRetractFloor(3);
    expect(events).toEqual([{ kind: "retractFloor", keepLen: 3 }]);
  });

  it("still emits exactly one retract on cancelAndBackspace (unchanged)", async () => {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus<AgentEvent>();
    const events: SpeechControlEvent[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      (ev) => events.push(ev),
      () => undefined,
      () => 0.5,
    );
    const ctrl = sink.slowStreamSpeech("零一二三四五");
    await vi.advanceTimersByTimeAsync(10_000); // paint at least one char
    await ctrl.cancelAndBackspace();
    expect(events.filter((e) => e.kind === "retract")).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe("BusActorStreamingSink — EN word reveal (lang 'en')", () => {
  function enMk(): { sink: BusActorStreamingSink; deltas: string[] } {
    const bus = new InMemoryEventBus<AgentEvent>();
    const deltas: string[] = [];
    bus.on("assistant.delta", (e) => deltas.push((e as { text: string }).text));
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      () => undefined,
      () => 0.5, // zero jitter
      undefined, // default `now`
      "en",
    );
    return { sink, deltas };
  }

  /** The letter-by-letter regression: a delta that is a single ASCII letter. */
  const isLoneLetter = (d: string): boolean =>
    d.length === 1 && /[A-Za-z]/.test(d);

  it("emits whole-word deltas (never lone letters) whose join is the exact text, including the final unterminated word", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = enMk();
    const text = "Fixed the parser bug.";
    const ctrl = sink.slowStreamSpeech(text); // unsupervised
    await vi.advanceTimersByTimeAsync(30_000);
    await ctrl.done;
    expect(deltas.join("")).toBe(text);
    expect(deltas[0]).toBe("Fixed ");
    expect(deltas.at(-1)).toBe("bug."); // final word — no trailing space
    expect(deltas.some(isLoneLetter)).toBe(false);
    expect(deltas.every((d) => d.length > 0)).toBe(true); // never an empty delta
    vi.useRealTimers();
  });

  it("supervised: holds on a WORD boundary (no empty-delta spin, no letter leak); fastForward drains whole words", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = enMk();
    let resolveVerdict!: () => void;
    const verdictPending = new Promise<void>((r) => {
      resolveVerdict = r;
    });
    const text = "The parser cursor now resets correctly and the test passes.";
    const ctrl = sink.slowStreamSpeech(text, { verdictPending });
    ctrl.done.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(120_000);
    const held = deltas.join("");
    expect(held.length).toBeGreaterThan(0);
    expect(held.length).toBeLessThan(text.length);
    expect(text.startsWith(held)).toBe(true);
    expect(held.endsWith(" ")).toBe(true); // frozen BETWEEN words, never mid-word
    expect(deltas.every((d) => d.length > 0)).toBe(true); // no empty-delta spin
    expect(deltas.some(isLoneLetter)).toBe(false); // no letter-by-letter leak
    // The hold is stable — more time reveals nothing.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deltas.join("")).toBe(held);
    // Verdict OK → the tail drains as whole words too. fastForward's drain is
    // PACED, so advance timers concurrently (don't await it before ticking).
    resolveVerdict();
    const ff = ctrl.fastForward();
    await vi.advanceTimersByTimeAsync(10_000);
    await ff;
    await ctrl.done;
    expect(deltas.join("")).toBe(text);
    expect(deltas.some(isLoneLetter)).toBe(false);
    vi.useRealTimers();
  });

  it("live: holds a mid-generation PARTIAL word until it completes, then emits it whole", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = enMk();
    const ctrl = sink.slowStreamSpeechLive(); // unsupervised → reveals at once
    ctrl.pushToken("Fix");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deltas.join("")).toBe(""); // "Fix" has no terminator yet → held
    ctrl.pushToken("ed the ");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deltas.join("")).toBe("Fixed the "); // both complete words emit
    expect(deltas.some(isLoneLetter)).toBe(false);
    ctrl.finishInput();
    await vi.advanceTimersByTimeAsync(5_000);
    await ctrl.done;
    expect(deltas.join("")).toBe("Fixed the ");
    vi.useRealTimers();
  });

  it("live: emits the final UNTERMINATED word on finishInput and resolves done (no hang on the last word)", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = enMk();
    const ctrl = sink.slowStreamSpeechLive();
    ctrl.pushToken("Fixed the bug"); // no trailing whitespace
    ctrl.finishInput();
    await vi.advanceTimersByTimeAsync(10_000);
    await ctrl.done; // MUST resolve — the final word is not stranded
    expect(deltas.join("")).toBe("Fixed the bug");
    vi.useRealTimers();
  });

  it("live supervised: the final word emits on fastForward and done resolves", async () => {
    vi.useFakeTimers();
    const { sink, deltas } = enMk();
    let resolveVerdict!: () => void;
    const verdictPending = new Promise<void>((r) => {
      resolveVerdict = r;
    });
    const ctrl = sink.slowStreamSpeechLive({ verdictPending });
    ctrl.done.catch(() => undefined);
    ctrl.pushToken("Fixed the bug");
    ctrl.finishInput();
    await vi.advanceTimersByTimeAsync(60_000);
    resolveVerdict();
    const ff = ctrl.fastForward();
    await vi.advanceTimersByTimeAsync(10_000);
    await ff;
    await ctrl.done;
    expect(deltas.join("")).toBe("Fixed the bug");
    vi.useRealTimers();
  });

  it("zh (default lang) is byte-identical: one code point per delta, not per word", async () => {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus<AgentEvent>();
    const deltas: string[] = [];
    bus.on("assistant.delta", (e) => deltas.push((e as { text: string }).text));
    // No lang arg → "zh" default → cjk path.
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      () => undefined,
      () => 0.5,
    );
    const ctrl = sink.slowStreamSpeech("你好世界");
    await vi.advanceTimersByTimeAsync(10_000);
    await ctrl.done;
    expect(deltas).toEqual(["你", "好", "世", "界"]);
    vi.useRealTimers();
  });
});

describe("BusActorStreamingSink — a text beat is paced like the reply (owner 2026-10-10)", () => {
  // The bridge's order: begin at the first safe token, tokens, end, then the
  // beat's block committed and flushed at once — with the backend's next
  // rows behind it.
  function setup() {
    vi.useFakeTimers();
    const bus = new InMemoryEventBus<AgentEvent>();
    const deltas: string[] = [];
    bus.on("assistant.delta", (e) => deltas.push((e as { text: string }).text));
    const emitted: RecordEvent[] = [];
    const sink = new BusActorStreamingSink(
      bus,
      () => undefined,
      (ev) => emitted.push(ev),
      () => 0.5,
    );
    const kinds = (): string[] =>
      emitted.map((e) => (e.kind === "block" ? e.block.kind : e.kind));
    return { sink, deltas, kinds };
  }
  const BEAT = "结构不算糟，先让测试兜住再说。";
  const record = (beat: string): TerminalRecordBlock[] => [
    { kind: "user", text: "@板砖 写个五子棋" },
    { kind: "herta", surface: "speech", text: beat },
    { kind: "system", label: "差分协处理器", body: "Running node --test" },
  ];
  function fireBeat(sink: BusActorStreamingSink, text: string): void {
    sink.beginHertaStream("speech");
    sink.streamHertaToken(text);
    sink.endHertaStream();
  }

  it("reveals at the read-along cadence, and holds its block and the rows behind it until the reveal ends", async () => {
    const { sink, deltas, kinds } = setup();
    sink.seedEmittedCount(1);
    fireBeat(sink, BEAT);
    sink.flushBlocks(record(BEAT));
    // Generated in one go, but on screen one glyph at a time.
    expect(deltas.join("")).toBe("");
    await vi.advanceTimersByTimeAsync(SLOW_MS_PER_CHAR * 3);
    const early = deltas.join("");
    expect(early.length).toBeGreaterThan(0);
    expect(early.length).toBeLessThan(BEAT.length);
    expect(kinds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deltas.join("")).toBe(BEAT);
    expect(kinds()).toEqual(["herta", "system"]);
    vi.useRealTimers();
  });

  it("the next stream lands a beat still revealing first: its text, then its block, then the new stream", async () => {
    const { sink, deltas, kinds } = setup();
    sink.seedEmittedCount(1);
    fireBeat(sink, BEAT);
    sink.flushBlocks(record(BEAT));
    await vi.advanceTimersByTimeAsync(SLOW_MS_PER_CHAR * 2);
    // The reply opens: the beat's tail and its held blocks go out at once.
    const reply = sink.slowStreamSpeechLive();
    expect(deltas.join("")).toBe(BEAT);
    expect(kinds()).toEqual(["herta", "system"]);
    reply.pushToken("好。");
    reply.finishInput();
    await vi.advanceTimersByTimeAsync(5_000);
    await reply.done;
    expect(deltas.join("")).toBe(`${BEAT}好。`);
    vi.useRealTimers();
  });

  it("a second beat lands the first before its own first glyph", async () => {
    const { sink, deltas, kinds } = setup();
    sink.seedEmittedCount(1);
    fireBeat(sink, BEAT);
    sink.flushBlocks(record(BEAT));
    await vi.advanceTimersByTimeAsync(SLOW_MS_PER_CHAR);
    fireBeat(sink, "跑完了。");
    expect(deltas.join("")).toBe(BEAT);
    expect(kinds()).toEqual(["herta", "system"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deltas.join("")).toBe(`${BEAT}跑完了。`);
    vi.useRealTimers();
  });

  it("turn end waits for it to finish at its own pace — with the supervisor off it is the whole reply", async () => {
    const { sink, deltas, kinds } = setup();
    sink.seedEmittedCount(1);
    fireBeat(sink, BEAT);
    sink.flushBlocks(record(BEAT));
    let settled = false;
    void sink.textRevealsDone().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(SLOW_MS_PER_CHAR * 3);
    expect(settled).toBe(false);
    expect(deltas.join("").length).toBeLessThan(BEAT.length);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(true);
    expect(deltas.join("")).toBe(BEAT);
    expect(kinds()).toEqual(["herta", "system"]);
    vi.useRealTimers();
  });

  it("the stop click lands it in one emit", async () => {
    const { sink, deltas, kinds } = setup();
    sink.seedEmittedCount(1);
    fireBeat(sink, BEAT);
    sink.flushBlocks(record(BEAT));
    await vi.advanceTimersByTimeAsync(SLOW_MS_PER_CHAR);
    sink.settleVoice({ interrupt: true });
    expect(deltas.join("")).toBe(BEAT);
    expect(kinds()).toEqual(["herta", "system"]);
    vi.useRealTimers();
  });
});
