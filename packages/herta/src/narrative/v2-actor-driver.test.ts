import {
  type AgentEvent,
  type CodingAgentRuntime,
  type CompletionEvent,
  type CompletionProviderAdapter,
  type CompletionRequest,
  type HertaToAgentBrief,
  InMemoryEventBus,
  type ProviderAdapter,
  type ProviderEvent,
  type TerminalRecord,
  type TerminalRecordBlock,
  type V2RecordPersister,
} from "@herta/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as actorTurn from "./actor-turn.js";
import * as intentRouter from "./intent-router.js";
import type { MetaThinkCorpus, MoodState } from "./meta-think.js";
import type { PreparedRecap, RecapRuntime } from "./session-recap-runtime.js";
import * as recapRuntime from "./session-recap-runtime.js";
import type { ActorStreamingSink } from "./streaming-sink.js";
import { V2ActorDriver } from "./v2-actor-driver.js";

async function* streamOf<T>(events: readonly T[]): AsyncGenerator<T> {
  for (const e of events) yield e;
}

function mkProvider(
  scripts: ReadonlyArray<CompletionEvent[]>,
): CompletionProviderAdapter {
  let idx = 0;
  return {
    streamCompletion(_req: CompletionRequest): AsyncIterable<CompletionEvent> {
      const script = scripts[idx] ?? [{ type: "finish", reason: "stop" }];
      idx += 1;
      return streamOf(script);
    },
  };
}

function mkNoopRouter(): ProviderAdapter {
  return {
    streamChat: async function* () {
      yield { type: "text-delta", text: "不变" } as const;
      yield { type: "finish", reason: "stop" } as const;
    },
  };
}

function mkEmptyCorpusForHelper(): MetaThinkCorpus {
  return {
    preThink: {
      默认: "",
      被烦版: "",
      教学版: "",
      被戳穿版: "",
      任务部署版: "",
      板砖代答版: "",
      被顶嘴版: "",
      倾听版: "",
    },
    preSpeak: {
      默认: "",
      被烦版: "",
      教学版: "",
      被戳穿版: "",
      任务部署版: "",
      板砖代答版: "",
      被顶嘴版: "",
      倾听版: "",
    },
  };
}

function mkDriver(
  provider: CompletionProviderAdapter,
  persister?: V2RecordPersister,
): V2ActorDriver {
  const noopRuntime: CodingAgentRuntime = {
    runBrief: async (brief: HertaToAgentBrief) => ({
      taskId: brief.taskId,
      status: "completed" as const,
      evidence: [],
      changedFiles: [],
      tests: [],
      permissions: [],
      residualRisks: [],
      nextActions: [],
    }),
  } as unknown as CodingAgentRuntime;
  return new V2ActorDriver({
    provider,
    model: "test-model",
    staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
    bus: new InMemoryEventBus<AgentEvent>(),
    runtimeFactory: () => noopRuntime,
    routerProvider: mkNoopRouter(),
    metaThinkCorpus: mkEmptyCorpusForHelper(),
    ...(persister !== undefined ? { persister } : {}),
  });
}

describe("V2ActorDriver", () => {
  it("returns a record with user + herta blocks after one turn", async () => {
    const provider = mkProvider([
      [
        { type: "text-delta", text: "好。" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const driver = mkDriver(provider);
    const record = await driver.runTurn("在吗", new AbortController().signal);
    expect(record).toHaveLength(2);
    expect(record[0]).toEqual({ kind: "user", text: "在吗" });
    expect(record[1]).toEqual({
      kind: "herta",
      surface: "speech",
      text: "好。",
    });
  });

  it("D1: wires a persisting sink's hook to the LIVE persister and skips batch-persist", async () => {
    const provider = mkProvider([
      [
        { type: "text-delta", text: "好。" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const blocksA: TerminalRecordBlock[] = [];
    const persA = {
      sessionFile: "/tmp/a.jsonl",
      appendBlock: (b: TerminalRecordBlock): void => {
        blocksA.push(b);
      },
    } as unknown as V2RecordPersister;
    // Captured via an object property so TS control-flow doesn't narrow a
    // closure-assigned `let` to `never` at the call sites below.
    const captured: { fn: ((b: TerminalRecordBlock) => void) | null } = {
      fn: null,
    };
    const sink: ActorStreamingSink = {
      beginHertaStream: () => undefined,
      streamHertaToken: () => undefined,
      endHertaStream: () => undefined,
      flushBlocks: () => undefined,
      setPersistHook: (h) => {
        captured.fn = h;
      },
    };
    const noopRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;
    const driver = new V2ActorDriver({
      provider,
      model: "test-model",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      routerProvider: mkNoopRouter(),
      metaThinkCorpus: mkEmptyCorpusForHelper(),
      persister: persA,
      sink,
    });
    // The hook was installed at construction.
    expect(captured.fn).toBeTypeOf("function");
    // A full turn must NOT batch-persist: the sink owns persistence now. Our
    // fake sink's flushBlocks does NOT invoke the hook, so blocksA staying empty
    // proves the driver skipped its batch loop (no double-write).
    await driver.runTurn("在吗", new AbortController().signal);
    expect(blocksA).toEqual([]);
    // The hook reads the LIVE persister: invoking it writes through to persA.
    captured.fn?.({ kind: "user", text: "x" });
    expect(blocksA).toEqual([{ kind: "user", text: "x" }]);
    // After a `/resume` `setPersister` swap, the SAME hook writes to the new
    // persister (the closure reads `this.persister` at call time).
    const blocksB: TerminalRecordBlock[] = [];
    driver.setPersister({
      sessionFile: "/tmp/b.jsonl",
      appendBlock: (b: TerminalRecordBlock): void => {
        blocksB.push(b);
      },
    } as unknown as V2RecordPersister);
    captured.fn?.({ kind: "user", text: "y" });
    expect(blocksB).toEqual([{ kind: "user", text: "y" }]);
  });

  it("D2: regenerateLastReply pops an orphaned trailing user block and generates its reply", async () => {
    const provider = mkProvider([
      [
        { type: "text-delta", text: "迟到的答复。" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const driver = mkDriver(provider);
    // A resumed session whose reply was lost mid-stream: ends with a user block.
    driver.loadRecord([
      { kind: "herta", surface: "speech", text: "开场白" },
      { kind: "user", text: "在吗" },
    ]);
    const record = await driver.regenerateLastReply(
      new AbortController().signal,
    );
    expect(record).toHaveLength(3);
    // The user block is preserved in place (not duplicated)…
    expect(record[1]).toEqual({ kind: "user", text: "在吗" });
    // …and the reply is regenerated after it.
    expect(record[2]).toEqual({
      kind: "herta",
      surface: "speech",
      text: "迟到的答复。",
    });
  });

  it("particle: forwards onPrimarySpeechStart for runTurn but omits it for regenerate", async () => {
    const noopRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;
    const mkDriverWithCb = (
      provider: CompletionProviderAdapter,
      calls: string[],
    ): V2ActorDriver =>
      new V2ActorDriver({
        provider,
        model: "test-model",
        staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
        bus: new InMemoryEventBus<AgentEvent>(),
        runtimeFactory: () => noopRuntime,
        routerProvider: mkNoopRouter(),
        metaThinkCorpus: mkEmptyCorpusForHelper(),
        onPrimarySpeechStart: (t) => calls.push(t),
      });

    // Normal turn → the callback fires with the speech text.
    const callsA: string[] = [];
    await mkDriverWithCb(
      mkProvider([
        [
          { type: "text-delta", text: "嗯，好。" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      callsA,
    ).runTurn("在吗", new AbortController().signal);
    expect(callsA).toEqual(["嗯，好。"]);

    // Regenerate (resume recovery) of an orphaned user block → NO particle.
    const callsB: string[] = [];
    const dB = mkDriverWithCb(
      mkProvider([
        [
          { type: "text-delta", text: "嗯，再来。" },
          { type: "finish", reason: "stop" },
        ],
      ]),
      callsB,
    );
    dB.loadRecord([
      { kind: "herta", surface: "speech", text: "开场白" },
      { kind: "user", text: "在吗" },
    ]);
    await dB.regenerateLastReply(new AbortController().signal);
    expect(callsB).toEqual([]);
  });

  it("D2: regenerateLastReply is a no-op when the session ends on a Herta reply", async () => {
    const provider = mkProvider([
      [
        { type: "text-delta", text: "不应触发" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const driver = mkDriver(provider);
    driver.loadRecord([
      { kind: "user", text: "在吗" },
      { kind: "herta", surface: "speech", text: "在。" },
    ]);
    const record = await driver.regenerateLastReply(
      new AbortController().signal,
    );
    // Unchanged — no model call (the script above is never consumed), no block.
    expect(record).toHaveLength(2);
    expect(record[1]).toEqual({
      kind: "herta",
      surface: "speech",
      text: "在。",
    });
  });

  it("D3: playOpening commits the seed to the record and settles it without re-persisting", async () => {
    const provider = mkProvider([[{ type: "finish", reason: "stop" }]]);
    const persisted: TerminalRecordBlock[] = [];
    const persister = {
      sessionFile: "/tmp/x.jsonl",
      appendBlock: (b: TerminalRecordBlock): void => {
        persisted.push(b);
      },
    } as unknown as V2RecordPersister;
    const captured: { seed: TerminalRecordBlock | null } = { seed: null };
    const sink: ActorStreamingSink = {
      beginHertaStream: () => undefined,
      streamHertaToken: () => undefined,
      endHertaStream: () => undefined,
      flushBlocks: () => undefined,
      setPersistHook: () => undefined,
      // No slowStreamSpeech → playOpening skips streaming and just commits +
      // settles (graceful fallback for hook-less/headless sinks).
      commitOpeningSeed: (b) => {
        captured.seed = b;
      },
    };
    const noopRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;
    const driver = new V2ActorDriver({
      provider,
      model: "test-model",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      routerProvider: mkNoopRouter(),
      metaThinkCorpus: mkEmptyCorpusForHelper(),
      persister,
      sink,
    });
    const seed = {
      kind: "herta" as const,
      surface: "speech" as const,
      text: "你来了。",
    };
    await driver.playOpening(seed);
    // Committed to the in-memory record (so later turns carry the opening)…
    expect(driver.getRecord()).toEqual([seed]);
    // …settled on the render surface…
    expect(captured.seed).toEqual(seed);
    // …and NOT persisted by the driver: the seed was persisted at create, and
    // commitOpeningSeed settles without re-writing.
    expect(persisted).toEqual([]);
  });

  it("D3: playOpening holds the lead beat before streaming, then streams + commits", async () => {
    vi.useFakeTimers();
    const provider = mkProvider([[{ type: "finish", reason: "stop" }]]);
    const state = { streamCalled: false, committed: false };
    const sink: ActorStreamingSink = {
      beginHertaStream: () => undefined,
      streamHertaToken: () => undefined,
      endHertaStream: () => undefined,
      flushBlocks: () => undefined,
      setPersistHook: () => undefined,
      slowStreamSpeech: () => {
        state.streamCalled = true;
        return {
          done: Promise.resolve(),
          fastForward: async () => undefined,
          cancelAndBackspace: async () => undefined,
        };
      },
      commitOpeningSeed: () => {
        state.committed = true;
      },
    };
    const noopRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;
    const driver = new V2ActorDriver({
      provider,
      model: "test-model",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      routerProvider: mkNoopRouter(),
      metaThinkCorpus: mkEmptyCorpusForHelper(),
      sink,
    });
    const seed = {
      kind: "herta" as const,
      surface: "speech" as const,
      text: "你来了。",
    };
    const onStreamStart = vi.fn();
    const p = driver.playOpening(seed, 1000, onStreamStart);
    // The lead holds: one tick short of the lead, the stream has NOT started and
    // the onStreamStart cue (voice sync) has NOT fired.
    await vi.advanceTimersByTimeAsync(999);
    expect(state.streamCalled).toBe(false);
    expect(onStreamStart).not.toHaveBeenCalled();
    // After the full lead it fires onStreamStart, then streams + commits.
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(onStreamStart).toHaveBeenCalledTimes(1);
    expect(state.streamCalled).toBe(true);
    expect(state.committed).toBe(true);
    expect(driver.getRecord()).toEqual([seed]);
    vi.useRealTimers();
  });

  it("interrupt-as-SKIP (audit 2026-07-10): abort mid-lead skips the wait, suppresses the cue, flushes and still commits", async () => {
    vi.useFakeTimers();
    const provider = mkProvider([[{ type: "finish", reason: "stop" }]]);
    const state = { streamCalled: false, committed: false, flushed: false };
    let resolveDone!: () => void;
    const sink: ActorStreamingSink = {
      beginHertaStream: () => undefined,
      streamHertaToken: () => undefined,
      endHertaStream: () => undefined,
      flushBlocks: () => undefined,
      setPersistHook: () => undefined,
      slowStreamSpeech: () => {
        state.streamCalled = true;
        const done = new Promise<void>((r) => {
          resolveDone = r;
        });
        return {
          done,
          fastForward: async () => undefined,
          cancelAndBackspace: async () => undefined,
          flushRemainder: () => {
            state.flushed = true;
            resolveDone();
          },
        };
      },
      commitOpeningSeed: () => {
        state.committed = true;
      },
    };
    const noopRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;
    const driver = new V2ActorDriver({
      provider,
      model: "test-model",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      routerProvider: mkNoopRouter(),
      metaThinkCorpus: mkEmptyCorpusForHelper(),
      sink,
    });
    const seed = {
      kind: "herta" as const,
      surface: "speech" as const,
      text: "你来了。",
    };
    const onStreamStart = vi.fn();
    const ac = new AbortController();
    const p = driver.playOpening(
      seed,
      1000,
      onStreamStart,
      undefined,
      ac.signal,
    );
    await vi.advanceTimersByTimeAsync(300);
    // Stop click mid-lead: the remaining 700ms lead is skipped, the voice
    // cue never fires (a skipped opening must not start its clip), the
    // stream flushes in one delta (fast-forward, never truncate), and the
    // seed STILL commits — record/screen stay converged.
    ac.abort();
    await p;
    expect(onStreamStart).not.toHaveBeenCalled();
    expect(state.streamCalled).toBe(true);
    expect(state.flushed).toBe(true);
    expect(state.committed).toBe(true);
    expect(driver.getRecord()).toEqual([seed]);
    vi.useRealTimers();
  });

  it("D3: playOpening forwards baseMsOverride to slowStreamSpeech (wav-matched cadence)", async () => {
    const provider = mkProvider([[{ type: "finish", reason: "stop" }]]);
    const seen: { opts?: { baseMsOverride?: number } } = {};
    const sink: ActorStreamingSink = {
      beginHertaStream: () => undefined,
      streamHertaToken: () => undefined,
      endHertaStream: () => undefined,
      flushBlocks: () => undefined,
      setPersistHook: () => undefined,
      slowStreamSpeech: (_text, opts) => {
        seen.opts = opts;
        return {
          done: Promise.resolve(),
          fastForward: async () => undefined,
          cancelAndBackspace: async () => undefined,
        };
      },
      commitOpeningSeed: () => undefined,
    };
    const noopRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;
    const driver = new V2ActorDriver({
      provider,
      model: "test-model",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      routerProvider: mkNoopRouter(),
      metaThinkCorpus: mkEmptyCorpusForHelper(),
      sink,
    });
    const seed = {
      kind: "herta" as const,
      surface: "speech" as const,
      text: "你来了。",
    };
    // leadMs 0 → no wait; pass a base override.
    await driver.playOpening(seed, 0, undefined, 137);
    expect(seen.opts?.baseMsOverride).toBe(137);
  });

  it("D3: playOpening passes no opts when baseMsOverride is omitted", async () => {
    const provider = mkProvider([[{ type: "finish", reason: "stop" }]]);
    const seen: { called: boolean; opts?: unknown } = { called: false };
    const sink: ActorStreamingSink = {
      beginHertaStream: () => undefined,
      streamHertaToken: () => undefined,
      endHertaStream: () => undefined,
      flushBlocks: () => undefined,
      setPersistHook: () => undefined,
      slowStreamSpeech: (_text, opts) => {
        seen.called = true;
        seen.opts = opts;
        return {
          done: Promise.resolve(),
          fastForward: async () => undefined,
          cancelAndBackspace: async () => undefined,
        };
      },
      commitOpeningSeed: () => undefined,
    };
    const noopRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;
    const driver = new V2ActorDriver({
      provider,
      model: "test-model",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      routerProvider: mkNoopRouter(),
      metaThinkCorpus: mkEmptyCorpusForHelper(),
      sink,
    });
    const seed = {
      kind: "herta" as const,
      surface: "speech" as const,
      text: "你来了。",
    };
    await driver.playOpening(seed, 0);
    expect(seen.called).toBe(true);
    expect(seen.opts).toBeUndefined();
  });

  it("preserves state across multiple turns (record grows)", async () => {
    const provider = mkProvider([
      [
        { type: "text-delta", text: "第一次。" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text-delta", text: "第二次。" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const driver = mkDriver(provider);
    const r1 = await driver.runTurn("一", new AbortController().signal);
    expect(r1).toHaveLength(2);
    const r2 = await driver.runTurn("二", new AbortController().signal);
    expect(r2).toHaveLength(4);
    expect(r2[0]).toEqual({ kind: "user", text: "一" });
    expect(r2[1]).toEqual({
      kind: "herta",
      surface: "speech",
      text: "第一次。",
    });
    expect(r2[2]).toEqual({ kind: "user", text: "二" });
    expect(r2[3]).toEqual({
      kind: "herta",
      surface: "speech",
      text: "第二次。",
    });
    // `getRecord()` returns the same reference `runTurn` just returned.
    expect(driver.getRecord()).toBe(r2);
  });

  it("getRecord() returns the current state without running a turn", async () => {
    // Must include a valid speech delta (Slice 10: 说） prefix required) so
    // a HertaBlock is committed and the record grows to length 2.
    const provider = mkProvider([
      [
        { type: "text-delta", text: "说）好。（/我 说）" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const driver = mkDriver(provider);
    expect(driver.getRecord()).toEqual([]);
    await driver.runTurn("hi", new AbortController().signal);
    expect(driver.getRecord()).toHaveLength(2);
  });

  it("forwards the signal to runActorCompletionTurn", async () => {
    const ac = new AbortController();
    let captured: AbortSignal | undefined;
    const provider: CompletionProviderAdapter = {
      streamCompletion(_req, signal): AsyncIterable<CompletionEvent> {
        captured = signal;
        return streamOf([{ type: "finish", reason: "stop" }]);
      },
    };
    const driver = mkDriver(provider);
    await driver.runTurn("test", ac.signal);
    expect(captured).toBeDefined();
    // Behavioral guarantee: aborting the per-call signal aborts the signal
    // the provider received (same signal or linked). A PRE-aborted signal no
    // longer reaches the provider at all — see the adoption test below.
    ac.abort();
    expect(captured?.aborted).toBe(true);
  });

  it("an aborted turn rejects but ADOPTS the partial record (screen truth preserved)", async () => {
    const ac = new AbortController();
    ac.abort(); // interrupt lands before the first iteration
    const provider: CompletionProviderAdapter = {
      streamCompletion(): AsyncIterable<CompletionEvent> {
        throw new Error("provider must not be called on a dead signal");
      },
    };
    const driver = mkDriver(provider);
    await expect(driver.runTurn("打断我", ac.signal)).rejects.toThrow(
      "turn aborted",
    );
    // The accumulated record (here: the user block) is adopted, not
    // discarded — with a @板砖 run in flight this is what keeps the backend
    // projections/done-marker the user already saw from vanishing.
    expect(
      driver.getRecord().some((b) => b.kind === "user" && b.text === "打断我"),
    ).toBe(true);
  });

  it("getRecord() returns a stale snapshot after a subsequent turn", async () => {
    const provider = mkProvider([
      [
        { type: "text-delta", text: "first" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text-delta", text: "second" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const driver = mkDriver(provider);
    await driver.runTurn("一", new AbortController().signal);
    const snapshot = driver.getRecord();
    expect(snapshot).toHaveLength(2);
    await driver.runTurn("二", new AbortController().signal);
    // The captured snapshot reference is from before turn 2; the driver
    // replaced this.record on turn 2 rather than mutating, so the
    // snapshot still shows length 2.
    expect(snapshot).toHaveLength(2);
    expect(driver.getRecord()).toHaveLength(4);
  });

  describe("persister integration", () => {
    function mkPersister(): {
      blocks: TerminalRecordBlock[];
      persister: V2RecordPersister;
    } {
      const blocks: TerminalRecordBlock[] = [];
      const persister = {
        sessionFile: "/tmp/fake.jsonl",
        appendBlock: (b: TerminalRecordBlock): void => {
          blocks.push(b);
        },
      } as unknown as V2RecordPersister;
      return { blocks, persister };
    }

    it("pushes each new block to the persister in order", async () => {
      const provider = mkProvider([
        [
          { type: "text-delta", text: "好。" },
          { type: "finish", reason: "stop" },
        ],
      ]);
      const { blocks, persister } = mkPersister();
      const noopRuntime: CodingAgentRuntime = {
        runBrief: async (brief: HertaToAgentBrief) => ({
          taskId: brief.taskId,
          status: "completed" as const,
          evidence: [],
          changedFiles: [],
          tests: [],
          permissions: [],
          residualRisks: [],
          nextActions: [],
        }),
      } as unknown as CodingAgentRuntime;
      const driver = new V2ActorDriver({
        provider,
        model: "test-model",
        staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
        bus: new InMemoryEventBus<AgentEvent>(),
        runtimeFactory: () => noopRuntime,
        persister,
        routerProvider: mkNoopRouter(),
        metaThinkCorpus: mkEmptyCorpusForHelper(),
      });
      await driver.runTurn("在吗", new AbortController().signal);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({ kind: "user", text: "在吗" });
      expect(blocks[1]).toEqual({
        kind: "herta",
        surface: "speech",
        text: "好。",
      });
    });

    it("only pushes blocks appended in the latest turn (no re-push of prior blocks)", async () => {
      const provider = mkProvider([
        [
          { type: "text-delta", text: "一。" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text-delta", text: "二。" },
          { type: "finish", reason: "stop" },
        ],
      ]);
      const { blocks, persister } = mkPersister();
      const noopRuntime: CodingAgentRuntime = {
        runBrief: async (brief: HertaToAgentBrief) => ({
          taskId: brief.taskId,
          status: "completed" as const,
          evidence: [],
          changedFiles: [],
          tests: [],
          permissions: [],
          residualRisks: [],
          nextActions: [],
        }),
      } as unknown as CodingAgentRuntime;
      const driver = new V2ActorDriver({
        provider,
        model: "test-model",
        staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
        bus: new InMemoryEventBus<AgentEvent>(),
        runtimeFactory: () => noopRuntime,
        persister,
        routerProvider: mkNoopRouter(),
        metaThinkCorpus: mkEmptyCorpusForHelper(),
      });
      await driver.runTurn("一", new AbortController().signal);
      expect(blocks).toHaveLength(2);
      await driver.runTurn("二", new AbortController().signal);
      expect(blocks).toHaveLength(4); // 2 prior + 2 new
      expect(blocks[2]).toEqual({ kind: "user", text: "二" });
      expect(blocks[3]).toEqual({
        kind: "herta",
        surface: "speech",
        text: "二。",
      });
    });

    it("driver works without a persister (optional dep)", async () => {
      const provider = mkProvider([
        [
          { type: "text-delta", text: "好" },
          { type: "finish", reason: "stop" },
        ],
      ]);
      const driver = mkDriver(provider);
      const record = await driver.runTurn("hi", new AbortController().signal);
      expect(record).toHaveLength(2);
    });
  });

  describe("Slice 9 — sink forwarding", () => {
    it("forwards the sink to runActorCompletionTurn via deps", async () => {
      const tokenCapture: string[] = [];
      const sink: ActorStreamingSink = {
        beginHertaStream: () => {},
        streamHertaToken: (t) => {
          tokenCapture.push(t);
        },
        endHertaStream: () => {},
        flushBlocks: () => {},
      };
      // Slice 10: text-delta must include 说） prefix so the loop recognises
      // the surface and routes tokens through the sink.
      const provider = mkProvider([
        [
          { type: "text-delta", text: "说）好。（/我 说）" },
          { type: "finish", reason: "stop" },
        ],
      ]);
      const noopRuntime: CodingAgentRuntime = {
        runBrief: async (brief: HertaToAgentBrief) => ({
          taskId: brief.taskId,
          status: "completed" as const,
          evidence: [],
          changedFiles: [],
          tests: [],
          permissions: [],
          residualRisks: [],
          nextActions: [],
        }),
      } as unknown as CodingAgentRuntime;
      const driver = new V2ActorDriver({
        provider,
        model: "test-model",
        staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
        bus: new InMemoryEventBus<AgentEvent>(),
        runtimeFactory: () => noopRuntime,
        sink,
        routerProvider: mkNoopRouter(),
        metaThinkCorpus: mkEmptyCorpusForHelper(),
      });
      await driver.runTurn("hi", new AbortController().signal);
      // The actor loop should have streamed "好。" via the sink.
      expect(tokenCapture.join("")).toBe("好。");
    });

    it("works without a sink (backward compat)", async () => {
      const provider = mkProvider([
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", reason: "stop" },
        ],
      ]);
      // Use mkDriver helper which does not set a sink.
      const driver = mkDriver(provider);
      const record = await driver.runTurn("hi", new AbortController().signal);
      expect(record).toHaveLength(2);
      expect(record[1]).toEqual({
        kind: "herta",
        surface: "speech",
        text: "ok",
      });
    });
  });

  describe("loadRecord", () => {
    it("replaces internal record state", async () => {
      const provider = mkProvider([[{ type: "finish", reason: "stop" }]]);
      const driver = mkDriver(provider);
      const restored: TerminalRecord = [
        { kind: "user", text: "before" },
        { kind: "herta", surface: "speech", text: "好" },
      ];
      driver.loadRecord(restored);
      expect(driver.getRecord()).toEqual(restored);
    });

    it("does NOT replay through the persister", async () => {
      const { blocks, persister } = (() => {
        const blocks: TerminalRecordBlock[] = [];
        return {
          blocks,
          persister: {
            sessionFile: "/tmp/fake.jsonl",
            appendBlock: (b: TerminalRecordBlock): void => {
              blocks.push(b);
            },
          } as unknown as V2RecordPersister,
        };
      })();
      const provider = mkProvider([
        [
          { type: "text-delta", text: "after" },
          { type: "finish", reason: "stop" },
        ],
      ]);
      const noopRuntime: CodingAgentRuntime = {
        runBrief: async (brief: HertaToAgentBrief) => ({
          taskId: brief.taskId,
          status: "completed" as const,
          evidence: [],
          changedFiles: [],
          tests: [],
          permissions: [],
          residualRisks: [],
          nextActions: [],
        }),
      } as unknown as CodingAgentRuntime;
      const driver = new V2ActorDriver({
        provider,
        model: "test-model",
        staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
        bus: new InMemoryEventBus<AgentEvent>(),
        runtimeFactory: () => noopRuntime,
        persister,
        routerProvider: mkNoopRouter(),
        metaThinkCorpus: mkEmptyCorpusForHelper(),
      });
      driver.loadRecord([
        { kind: "user", text: "old" },
        { kind: "herta", surface: "speech", text: "old-reply" },
      ]);
      // After load, only new blocks from runTurn should hit the persister.
      await driver.runTurn("new", new AbortController().signal);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({ kind: "user", text: "new" });
      expect(blocks[1]).toEqual({
        kind: "herta",
        surface: "speech",
        text: "after",
      });
    });
  });

  describe("rewindLastUserTurn", () => {
    it("removes the last user turn and everything after it, returning the user text", () => {
      const driver = mkDriver(mkProvider([]));
      driver.loadRecord([
        { kind: "user", text: "u1" },
        { kind: "herta", surface: "speech", text: "h1" },
        { kind: "user", text: "u2" },
        { kind: "herta", surface: "thought", text: "t2" },
        { kind: "herta", surface: "speech", text: "h2" },
        { kind: "system", label: "差分协处理器", body: "edited foo.ts" },
      ]);
      const result = driver.rewindLastUserTurn();
      expect(result).not.toBeNull();
      expect(result?.userText).toBe("u2");
      // The whole second turn (user + thought + speech + backend system) is withdrawn.
      expect(result?.withdrawn.map((b) => b.kind)).toEqual([
        "user",
        "herta",
        "herta",
        "system",
      ]);
      expect(driver.getRecord()).toEqual([
        { kind: "user", text: "u1" },
        { kind: "herta", surface: "speech", text: "h1" },
      ]);
    });

    it("returns null when there is no user block (e.g. only an opening seed)", () => {
      const driver = mkDriver(mkProvider([]));
      driver.loadRecord([
        { kind: "herta", surface: "speech", text: "opening" },
      ]);
      expect(driver.rewindLastUserTurn()).toBeNull();
      expect(driver.getRecord()).toHaveLength(1); // unchanged
    });

    it("rewinding the only turn empties the record", () => {
      const driver = mkDriver(mkProvider([]));
      driver.loadRecord([
        { kind: "user", text: "u1" },
        { kind: "herta", surface: "speech", text: "h1" },
      ]);
      expect(driver.rewindLastUserTurn()?.userText).toBe("u1");
      expect(driver.getRecord()).toEqual([]);
    });

    it("truncates the persister to the kept block count (the last-user index)", () => {
      const calls: number[] = [];
      const persister = {
        sessionFile: "/tmp/fake.jsonl",
        appendBlock: () => undefined,
        truncateToBlockCount: (n: number): void => {
          calls.push(n);
        },
      } as unknown as V2RecordPersister;
      const driver = mkDriver(mkProvider([]), persister);
      driver.loadRecord([
        { kind: "user", text: "u1" },
        { kind: "herta", surface: "speech", text: "h1" },
        { kind: "user", text: "u2" },
        { kind: "herta", surface: "speech", text: "h2" },
      ]);
      driver.rewindLastUserTurn();
      expect(calls).toEqual([2]); // keep [u1, h1]
    });

    it("durable-first: a persister truncate failure leaves the in-memory record intact", () => {
      const persister = {
        sessionFile: "/tmp/fake.jsonl",
        appendBlock: () => undefined,
        truncateToBlockCount: (): void => {
          throw new Error("disk full");
        },
      } as unknown as V2RecordPersister;
      const driver = mkDriver(mkProvider([]), persister);
      const initial: TerminalRecord = [
        { kind: "user", text: "u1" },
        { kind: "herta", surface: "speech", text: "h1" },
        { kind: "user", text: "u2" },
        { kind: "herta", surface: "speech", text: "h2" },
      ];
      driver.loadRecord(initial);
      // Truncation runs BEFORE the in-memory slice, so its failure propagates
      // with the record still whole — no memory-ahead-of-disk desync.
      expect(() => driver.rewindLastUserTurn()).toThrow(/disk full/);
      expect(driver.getRecord()).toEqual(initial);
    });

    it("the next turn rebuilds against the shortened record", async () => {
      const provider = mkProvider([
        [
          { type: "text-delta", text: "再答。" },
          { type: "finish", reason: "stop" },
        ],
      ]);
      const driver = mkDriver(provider);
      driver.loadRecord([
        { kind: "user", text: "u1" },
        { kind: "herta", surface: "speech", text: "h1" },
      ]);
      driver.rewindLastUserTurn();
      const record = await driver.runTurn(
        "u1-edited",
        new AbortController().signal,
      );
      expect(record).toEqual([
        { kind: "user", text: "u1-edited" },
        { kind: "herta", surface: "speech", text: "再答。" },
      ]);
    });
  });

  describe("onPrompt forwarding (prompt dump)", () => {
    it("forwards onPrompt callback to runActorCompletionTurn", async () => {
      // Slice 10: must include 说） prefix so the loop commits a speech block
      // and the turn ends (otherwise it loops infinitely).
      const provider = mkProvider([
        [
          { type: "text-delta", text: "说）好。（/我 说）" },
          { type: "finish", reason: "stop" },
        ],
      ]);
      const captured: Array<{
        label: string;
        prompt: string;
      }> = [];
      const noopRuntime: CodingAgentRuntime = {
        runBrief: async (brief: HertaToAgentBrief) => ({
          taskId: brief.taskId,
          status: "completed" as const,
          evidence: [],
          changedFiles: [],
          tests: [],
          permissions: [],
          residualRisks: [],
          nextActions: [],
        }),
      } as unknown as CodingAgentRuntime;
      const driver = new V2ActorDriver({
        provider,
        model: "test-model",
        staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
        bus: new InMemoryEventBus<AgentEvent>(),
        runtimeFactory: () => noopRuntime,
        onPrompt: (label, prompt) => {
          captured.push({ label, prompt });
        },
        routerProvider: mkNoopRouter(),
        metaThinkCorpus: mkEmptyCorpusForHelper(),
      });
      await driver.runTurn("在吗", new AbortController().signal);
      // Expect 4 onPrompt calls: "state-out" (router transaction dump) +
      // "state" (resolved mood, once per turn) + "primary" (request) +
      // "primary-out" (response dump). The empty corpus means mood routing
      // is inactive (single-phase path), but "state-out" and "state" both
      // fire from the driver after the router try/catch.
      expect(captured).toHaveLength(4);
      expect(captured[0]?.label).toBe("state-out");
      expect(captured[1]?.label).toBe("state");
      expect(captured[2]?.label).toBe("primary");
      expect(captured[3]?.label).toBe("primary-out");
      // Prompt must contain the static prefix + user text + open branch tag.
      // Slice 10: prompt ends with "（我 " (open branch, no surface yet) so
      // the model chooses between 想）and 说）. Not "（我 说）" as in pre-Slice-10.
      expect(captured[2]?.prompt).toContain("[prefix]");
      expect(captured[2]?.prompt).toContain("在吗");
      expect(captured[2]?.prompt).toMatch(/（我 $/);
    });

    it("driver works without onPrompt (optional dep)", async () => {
      const provider = mkProvider([
        [
          { type: "text-delta", text: "好" },
          { type: "finish", reason: "stop" },
        ],
      ]);
      const driver = mkDriver(provider);
      const record = await driver.runTurn("hi", new AbortController().signal);
      expect(record).toHaveLength(2);
    });
  });

  describe("setPersister", () => {
    it("swaps the persister so subsequent runTurns push to the new one", async () => {
      const blocksA: TerminalRecordBlock[] = [];
      const blocksB: TerminalRecordBlock[] = [];
      const persA = {
        sessionFile: "/tmp/a.jsonl",
        appendBlock: (b: TerminalRecordBlock): void => {
          blocksA.push(b);
        },
      } as unknown as V2RecordPersister;
      const persB = {
        sessionFile: "/tmp/b.jsonl",
        appendBlock: (b: TerminalRecordBlock): void => {
          blocksB.push(b);
        },
      } as unknown as V2RecordPersister;
      const provider = mkProvider([
        [
          { type: "text-delta", text: "first" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text-delta", text: "second" },
          { type: "finish", reason: "stop" },
        ],
      ]);
      const noopRuntime: CodingAgentRuntime = {
        runBrief: async (brief: HertaToAgentBrief) => ({
          taskId: brief.taskId,
          status: "completed" as const,
          evidence: [],
          changedFiles: [],
          tests: [],
          permissions: [],
          residualRisks: [],
          nextActions: [],
        }),
      } as unknown as CodingAgentRuntime;
      const driver = new V2ActorDriver({
        provider,
        model: "test-model",
        staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
        bus: new InMemoryEventBus<AgentEvent>(),
        runtimeFactory: () => noopRuntime,
        persister: persA,
        routerProvider: mkNoopRouter(),
        metaThinkCorpus: mkEmptyCorpusForHelper(),
      });
      await driver.runTurn("one", new AbortController().signal);
      expect(blocksA).toHaveLength(2);
      driver.setPersister(persB);
      await driver.runTurn("two", new AbortController().signal);
      expect(blocksA).toHaveLength(2); // unchanged
      expect(blocksB).toHaveLength(2); // new persister received turn 2
    });
  });
});

describe("V2ActorDriver — mood routing (Slice 13)", () => {
  function mkPartialCorpus(): MetaThinkCorpus {
    const m: Record<MoodState, string> = {
      默认: "DEFAULT_BLOB",
      被烦版: "ANNOYED_BLOB",
      教学版: "",
      被戳穿版: "",
      任务部署版: "",
      板砖代答版: "",
      被顶嘴版: "",
      倾听版: "",
    };
    return { preThink: { ...m }, preSpeak: { ...m } };
  }

  function mkRouterProvider(outputs: readonly string[]): ProviderAdapter {
    let idx = 0;
    return {
      streamChat(): AsyncIterable<ProviderEvent> {
        const text = outputs[idx] ?? "默认";
        idx += 1;
        return streamOf<ProviderEvent>([
          { type: "text-delta", text },
          { type: "finish", reason: "stop" },
        ]);
      },
    };
  }

  function mkActorProvider(
    scripts: ReadonlyArray<CompletionEvent[]>,
  ): CompletionProviderAdapter {
    let idx = 0;
    return {
      streamCompletion(): AsyncIterable<CompletionEvent> {
        const script = scripts[idx] ?? [{ type: "finish", reason: "stop" }];
        idx += 1;
        return streamOf(script);
      },
    };
  }

  function mkMoodDriver(opts: {
    actorProvider: CompletionProviderAdapter;
    routerProvider: ProviderAdapter;
    corpus: MetaThinkCorpus;
  }): V2ActorDriver {
    const noopRuntime: CodingAgentRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;
    return new V2ActorDriver({
      provider: opts.actorProvider,
      model: "test-actor",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      routerProvider: opts.routerProvider,
      metaThinkCorpus: opts.corpus,
    });
  }

  it("default state is 默认 on construction", () => {
    const driver = mkMoodDriver({
      actorProvider: mkActorProvider([]),
      routerProvider: mkRouterProvider([]),
      corpus: mkPartialCorpus(),
    });
    expect(driver.getCurrentIntentState()).toBe("默认");
  });

  it("runs the router before the actor and updates state", async () => {
    const actor = mkActorProvider([
      [
        { type: "text-delta", text: "说）" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text-delta", text: "好。（/我 说）" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const router = mkRouterProvider(["被烦版"]);
    const driver = mkMoodDriver({
      actorProvider: actor,
      routerProvider: router,
      corpus: mkPartialCorpus(),
    });
    await driver.runTurn("hi", new AbortController().signal);
    expect(driver.getCurrentIntentState()).toBe("被烦版");
  });

  it("router '不变' output keeps the prior state", async () => {
    const actor = mkActorProvider([
      [
        { type: "text-delta", text: "说）" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text-delta", text: "好。（/我 说）" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const router = mkRouterProvider(["不变"]);
    const driver = mkMoodDriver({
      actorProvider: actor,
      routerProvider: router,
      corpus: mkPartialCorpus(),
    });
    await driver.runTurn("hi", new AbortController().signal);
    expect(driver.getCurrentIntentState()).toBe("默认");
  });

  it("router failure keeps prior state and does not throw", async () => {
    const actor = mkActorProvider([
      [
        { type: "text-delta", text: "说）" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text-delta", text: "好。（/我 说）" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const router: ProviderAdapter = {
      // biome-ignore lint/correctness/useYield: test stub throws before yielding
      async *streamChat(): AsyncIterable<ProviderEvent> {
        throw new Error("router unreachable");
      },
    } as unknown as ProviderAdapter;
    const driver = mkMoodDriver({
      actorProvider: actor,
      routerProvider: router,
      corpus: mkPartialCorpus(),
    });
    await driver.runTurn("hi", new AbortController().signal);
    expect(driver.getCurrentIntentState()).toBe("默认");
  });

  it("loadRecord resets state to 默认", async () => {
    const actor = mkActorProvider([
      [
        { type: "text-delta", text: "说）" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text-delta", text: "好。（/我 说）" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const router = mkRouterProvider(["教学版"]);
    const driver = mkMoodDriver({
      actorProvider: actor,
      routerProvider: router,
      corpus: mkPartialCorpus(),
    });
    await driver.runTurn("hi", new AbortController().signal);
    expect(driver.getCurrentIntentState()).toBe("教学版");
    driver.loadRecord([]);
    expect(driver.getCurrentIntentState()).toBe("默认");
  });

  // ---------------------------------------------------------------------
  // Meta-think attachment lifecycle (asymmetric anchoring)
  // ---------------------------------------------------------------------
  //
  // Contract:
  //   - `beforeThinkIndex` recomputed EVERY turn — meta-pre-think sits
  //     immediately before the current turn's `（我 想）` block. Earlier
  //     turns' thoughts are filtered out, so this preamble belongs
  //     only at the current think position.
  //   - `beforeSpeakIndex` STICKY across same-state turns — anchored at
  //     the first speech of this mood-state run. Speech blocks persist
  //     in the prompt, so the speak preamble works as a one-time voice
  //     baseline reminder.
  //   - Texts are resolved on state change and reused across same-
  //     state turns.
  //   - State change → fresh anchors at current turn positions, fresh
  //     texts from the corpus.
  //   - `loadRecord` resets the attachment to null; the first post-
  //     resume turn rebuilds it.
  //   - Empty corpus → no attachment ever (single-phase mode preserved).
  //
  // Helpers used: `mkMoodDriver`, `mkRouterProvider`, `mkActorProvider`,
  // `mkPartialCorpus`, all defined at the top of this describe block.

  /**
   * Build a `CompletionEvent[]` script that produces a thought block
   * (iter 1) followed by a forced-speech block (iter 2). Two-phase
   * mode requires two LLM calls per Herta turn.
   */
  function twoPhaseTurnScript(thoughtText: string, speechText: string) {
    return [
      [
        { type: "text-delta" as const, text: `${thoughtText}（/我 想）` },
        { type: "finish" as const, reason: "stop" as const },
      ],
      [
        { type: "text-delta" as const, text: `${speechText}（/我 说）` },
        { type: "finish" as const, reason: "stop" as const },
      ],
    ];
  }

  it("first turn creates an attachment at beforeBlockIndex=1 (empty starting record)", async () => {
    const actor = mkActorProvider(twoPhaseTurnScript("想想。", "好。"));
    const router = mkRouterProvider(["默认"]);
    const driver = mkMoodDriver({
      actorProvider: actor,
      routerProvider: router,
      corpus: mkPartialCorpus(),
    });
    expect(driver.getAttachedMetaThink()).toBeNull();
    await driver.runTurn("hi", new AbortController().signal);
    const attached = driver.getAttachedMetaThink();
    expect(attached).not.toBeNull();
    expect(attached!.state).toBe("默认");
    // Empty starting record → incoming user lands at index 0; the
    // think anchor sits AT that index so meta-pre-think renders
    // BEFORE the user message. Speech anchor is at the upcoming
    // speech position (after user + thought).
    expect(attached!.beforeThinkIndex).toBe(0);
    expect(attached!.beforeSpeakIndex).toBe(2);
    expect(attached!.preThinkText).toBe("DEFAULT_BLOB");
    expect(attached!.preSpeakText).toBe("DEFAULT_BLOB");
  });

  it("same-state second turn advances the think anchor but keeps the speak anchor", async () => {
    const actor = mkActorProvider([
      ...twoPhaseTurnScript("一。", "好。"),
      ...twoPhaseTurnScript("二。", "嗯。"),
    ]);
    const router = mkRouterProvider(["默认", "默认"]);
    const driver = mkMoodDriver({
      actorProvider: actor,
      routerProvider: router,
      corpus: mkPartialCorpus(),
    });
    await driver.runTurn("turn 1", new AbortController().signal);
    const firstAttachment = driver.getAttachedMetaThink();
    expect(firstAttachment).not.toBeNull();
    expect(firstAttachment!.beforeThinkIndex).toBe(0);
    expect(firstAttachment!.beforeSpeakIndex).toBe(2);

    await driver.runTurn("turn 2", new AbortController().signal);
    const secondAttachment = driver.getAttachedMetaThink();
    expect(secondAttachment).not.toBeNull();
    // Same state → same texts (corpus lookup by state).
    expect(secondAttachment!.state).toBe("默认");
    expect(secondAttachment!.preThinkText).toBe(firstAttachment!.preThinkText);
    expect(secondAttachment!.preSpeakText).toBe(firstAttachment!.preSpeakText);
    // THINK anchor ADVANCES — turn 1 produced 3 blocks (user,
    // thought, speech), so turn 2's user lands at index 3 and the
    // think anchor sits AT that index (meta renders before user).
    expect(secondAttachment!.beforeThinkIndex).toBe(3);
    expect(secondAttachment!.beforeThinkIndex).toBeGreaterThan(
      firstAttachment!.beforeThinkIndex,
    );
    // SPEAK anchor STICKY — still pointing at turn-1's speech
    // position (index 2). The speak preamble is a one-time voice
    // baseline at the mood's first speech, not repeated per turn.
    expect(secondAttachment!.beforeSpeakIndex).toBe(
      firstAttachment!.beforeSpeakIndex,
    );
  });

  it("state change creates a fresh attachment at the current turn's position", async () => {
    const actor = mkActorProvider([
      ...twoPhaseTurnScript("一。", "好。"),
      ...twoPhaseTurnScript("二。", "嗯。"),
    ]);
    const router = mkRouterProvider(["默认", "被烦版"]);
    const driver = mkMoodDriver({
      actorProvider: actor,
      routerProvider: router,
      corpus: mkPartialCorpus(),
    });
    await driver.runTurn("turn 1", new AbortController().signal);
    const firstAttachment = driver.getAttachedMetaThink()!;
    // First turn produces 3 record blocks: user, thought, speech.

    await driver.runTurn("turn 2", new AbortController().signal);
    const secondAttachment = driver.getAttachedMetaThink()!;

    expect(secondAttachment.state).toBe("被烦版");
    // After turn 1: record has 3 blocks. Turn 2's user lands at
    // index 3 (think anchor sits there, meta before user); thought
    // at 4, speech at 5 (speak anchor).
    expect(secondAttachment.beforeThinkIndex).toBe(3);
    expect(secondAttachment.beforeSpeakIndex).toBe(5);
    expect(secondAttachment.beforeThinkIndex).toBeGreaterThan(
      firstAttachment.beforeThinkIndex,
    );
    expect(secondAttachment.beforeSpeakIndex).toBeGreaterThan(
      firstAttachment.beforeSpeakIndex,
    );
    expect(secondAttachment.preThinkText).toBe("ANNOYED_BLOB");
  });

  it("same-state run: think anchor advances every turn; speak anchor sticks for SPEAK_ANCHOR_REFRESH_INTERVAL turns then jumps forward", async () => {
    // 6 turns, all 默认. With SPEAK_ANCHOR_REFRESH_INTERVAL = 5:
    //   turn 1 → fresh attachment, counter=0, speak anchor=2
    //   turns 2-5 → counter increments to 4, anchor stays at 2
    //   turn 6 → counter reaches 5, speak anchor REFRESHES to turn 6's
    //            speech position (record.length + 2 = 15 + 2 = 17),
    //            counter resets to 0.
    // The think anchor advances every turn regardless.
    const scripts = [];
    for (let i = 0; i < 6; i++) {
      scripts.push(...twoPhaseTurnScript(`想${i}。`, `说${i}。`));
    }
    const actor = mkActorProvider(scripts);
    const router = mkRouterProvider(Array(6).fill("默认"));
    const driver = mkMoodDriver({
      actorProvider: actor,
      routerProvider: router,
      corpus: mkPartialCorpus(),
    });

    for (let n = 1; n <= 6; n++) {
      await driver.runTurn(`turn ${n}`, new AbortController().signal);
      const attached = driver.getAttachedMetaThink();
      expect(attached).not.toBeNull();
      expect(attached!.state).toBe("默认");
      expect(attached!.beforeThinkIndex).toBe((n - 1) * 3);
      if (n <= 5) {
        // Sticky at turn 1's first speech position.
        expect(attached!.beforeSpeakIndex).toBe(2);
      } else {
        // Refresh fired at turn 6 — anchor jumps to this turn's
        // speech position (after 5 turns × 3 blocks + user + thought
        // = 15 + 2 = 17).
        expect(attached!.beforeSpeakIndex).toBe(17);
      }
      // Texts stay the same across same-state turns (corpus lookup).
      expect(attached!.preThinkText).toBe("DEFAULT_BLOB");
      expect(attached!.preSpeakText).toBe("DEFAULT_BLOB");
    }
  });

  it("loadRecord resets the attachment to null", async () => {
    const actor = mkActorProvider(twoPhaseTurnScript("想。", "好。"));
    const router = mkRouterProvider(["默认"]);
    const driver = mkMoodDriver({
      actorProvider: actor,
      routerProvider: router,
      corpus: mkPartialCorpus(),
    });
    await driver.runTurn("hi", new AbortController().signal);
    expect(driver.getAttachedMetaThink()).not.toBeNull();
    driver.loadRecord([]);
    expect(driver.getAttachedMetaThink()).toBeNull();
  });

  it("empty corpus → no attachment created (single-phase mode)", async () => {
    const emptyCorpus: MetaThinkCorpus = {
      preThink: {
        默认: "",
        被烦版: "",
        教学版: "",
        被戳穿版: "",
        任务部署版: "",
        板砖代答版: "",
        被顶嘴版: "",
        倾听版: "",
      },
      preSpeak: {
        默认: "",
        被烦版: "",
        教学版: "",
        被戳穿版: "",
        任务部署版: "",
        板砖代答版: "",
        被顶嘴版: "",
        倾听版: "",
      },
    };
    // Single-phase mode: one LLM call (no thought iteration), producing
    // a speech block via autoregressive surface pick.
    const actor = mkActorProvider([
      [
        { type: "text-delta", text: "说）" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text-delta", text: "好。（/我 说）" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const router = mkRouterProvider(["默认"]);
    const driver = mkMoodDriver({
      actorProvider: actor,
      routerProvider: router,
      corpus: emptyCorpus,
    });
    await driver.runTurn("hi", new AbortController().signal);
    expect(driver.getAttachedMetaThink()).toBeNull();
  });
});

describe("V2ActorDriver — appendSystemNote (out-of-turn)", () => {
  function mkPersister(): {
    blocks: TerminalRecordBlock[];
    persister: V2RecordPersister;
  } {
    const blocks: TerminalRecordBlock[] = [];
    const persister = {
      sessionFile: "/tmp/fake.jsonl",
      appendBlock: (b: TerminalRecordBlock): void => {
        blocks.push(b);
      },
    } as unknown as V2RecordPersister;
    return { blocks, persister };
  }

  it("appends a system block to the record, persists it, and flushes the sink", () => {
    const { blocks, persister } = mkPersister();
    const flushed: TerminalRecord[] = [];
    const sink: ActorStreamingSink = {
      beginHertaStream: () => {},
      streamHertaToken: () => {},
      endHertaStream: () => {},
      flushBlocks: (record) => {
        flushed.push(record);
      },
    };
    const noopRuntime: CodingAgentRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;
    const driver = new V2ActorDriver({
      provider: mkProvider([]),
      model: "test-model",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      persister,
      sink,
      routerProvider: mkNoopRouter(),
      metaThinkCorpus: mkEmptyCorpusForHelper(),
    });

    driver.appendSystemNote("系统", "workspace → /x");

    const record = driver.getRecord();
    expect(record).toHaveLength(1);
    expect(record[record.length - 1]).toEqual({
      kind: "system",
      label: "系统",
      body: "workspace → /x",
    });
    // The block was persisted.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      kind: "system",
      label: "系统",
      body: "workspace → /x",
    });
    // The sink was flushed with the full record (so the live UI sees it).
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.[flushed[0].length - 1]).toEqual({
      kind: "system",
      label: "系统",
      body: "workspace → /x",
    });
  });

  it("works without a persister or sink (both optional)", () => {
    const driver = mkDriver(mkProvider([]));
    driver.appendSystemNote("系统", "workspace → /y");
    expect(driver.getRecord()).toEqual([
      { kind: "system", label: "系统", body: "workspace → /y" },
    ]);
  });
});

describe("V2ActorDriver — state-out dump label", () => {
  it("emits 'state-out' with prompt + '---' + rawOutput when onPrompt is provided", async () => {
    const dumps: Array<{ label: string; body: string }> = [];
    const onPrompt = (label: string, body: string): void => {
      dumps.push({ label, body });
    };

    // Router emits "教学版" — distinct from the noop router's "不变" so we
    // can verify the rawOutput in the dump is the literal router response.
    const routerProvider: ProviderAdapter = {
      streamChat(): AsyncIterable<ProviderEvent> {
        return streamOf<ProviderEvent>([
          { type: "text-delta", text: "教学版" },
          { type: "finish", reason: "stop" },
        ]);
      },
    };

    const actorProvider = mkProvider([
      [
        { type: "text-delta", text: "好。" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const noopRuntime: CodingAgentRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;

    const driver = new V2ActorDriver({
      provider: actorProvider,
      model: "test-model",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      routerProvider,
      metaThinkCorpus: mkEmptyCorpusForHelper(),
      onPrompt,
    });

    await driver.runTurn("讲讲归并排序", new AbortController().signal);

    const stateOut = dumps.find((d) => d.label === "state-out");
    expect(stateOut).toBeDefined();
    expect(stateOut!.body).toContain("\n\n---\n\n");
    const parts = stateOut!.body.split("\n\n---\n\n");
    expect(parts).toHaveLength(2);
    expect(parts[1]).toBe("教学版");
    // The `state` label still fires after `state-out`, with the resolved
    // mood name (the router emitted "教学版", which parses to "教学版").
    const stateResolved = dumps.find((d) => d.label === "state");
    expect(stateResolved).toBeDefined();
    expect(stateResolved!.body).toBe("教学版");
  });

  it("does not emit 'state-out' when the router throws", async () => {
    const dumps: Array<{ label: string; body: string }> = [];
    const onPrompt = (label: string, body: string): void => {
      dumps.push({ label, body });
    };

    const throwingRouter: ProviderAdapter = {
      streamChat() {
        throw new Error("router boom");
      },
    };

    const actorProvider = mkProvider([
      [
        { type: "text-delta", text: "好。" },
        { type: "finish", reason: "stop" },
      ],
    ]);

    const noopRuntime: CodingAgentRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;

    const driver = new V2ActorDriver({
      provider: actorProvider,
      model: "test-model",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      routerProvider: throwingRouter,
      metaThinkCorpus: mkEmptyCorpusForHelper(),
      onPrompt,
    });

    await driver.runTurn("hi", new AbortController().signal);

    const stateOut = dumps.find((d) => d.label === "state-out");
    expect(stateOut).toBeUndefined();
    // The `state` label still fires with the kept-default state.
    const stateResolved = dumps.find((d) => d.label === "state");
    expect(stateResolved).toBeDefined();
    expect(stateResolved!.body).toBe("默认");
  });
});

describe("V2ActorDriver — forceCompactNextTurn (one-shot)", () => {
  // The driver consumes the one-shot flag and passes it as the `forceCompact`
  // argument to `prepareTurnRecap` (called BEFORE intent-routing so the recap
  // hint fires at turn-start). We observe it by spying on `prepareTurnRecap`
  // and reading its 4th positional arg, and stub `runActorCompletionTurn` so
  // the real turn does not run.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mkForceCompactDriver(): V2ActorDriver {
    // The actor provider scripts are irrelevant — the spy replaces the real
    // turn implementation — but the driver still runs the router first, which
    // uses the noop router. Each spied call resolves to a minimal state so the
    // driver's post-turn bookkeeping (record assignment) does not throw.
    const provider = mkProvider([[{ type: "finish", reason: "stop" }]]);
    const noopRuntime: CodingAgentRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;
    return new V2ActorDriver({
      provider,
      model: "test-model",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      routerProvider: mkNoopRouter(),
      metaThinkCorpus: mkEmptyCorpusForHelper(),
    });
  }

  it("threads forceCompact=true into the NEXT turn's recap, then resets (one-shot)", async () => {
    // prepareTurnRecap(record, staticPrefix, rt, forceCompact, signal, notify)
    const recapSpy = vi.spyOn(recapRuntime, "prepareTurnRecap");
    vi.spyOn(actorTurn, "runActorCompletionTurn").mockImplementation(
      async (state) => ({ record: state.record }),
    );

    const driver = mkForceCompactDriver();

    // Arm the one-shot flag, then drive a turn — recap must see forceCompact: true.
    driver.forceCompactNextTurn();
    await driver.runTurn("一", new AbortController().signal);

    // Drive a SECOND turn WITHOUT re-arming — the flag must be consumed.
    await driver.runTurn("二", new AbortController().signal);

    expect(recapSpy).toHaveBeenCalledTimes(2);
    expect(recapSpy.mock.calls[0]?.[3]).toBe(true);
    // One-shot: reset to false on the next turn.
    expect(recapSpy.mock.calls[1]?.[3]).toBe(false);
  });

  it("defaults to forceCompact false when never armed", async () => {
    const recapSpy = vi.spyOn(recapRuntime, "prepareTurnRecap");
    vi.spyOn(actorTurn, "runActorCompletionTurn").mockImplementation(
      async (state) => ({ record: state.record }),
    );

    const driver = mkForceCompactDriver();
    await driver.runTurn("hi", new AbortController().signal);

    expect(recapSpy.mock.calls[0]?.[3]).toBe(false);
  });
});

describe("V2ActorDriver — recap dependency", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mkRecapRuntime(): RecapRuntime {
    return {
      config: {
        enabled: true,
        contextWindowTokens: 1_000_000,
        bufferFraction: 0.2,
        recentWindowTokens: 12_000,
        minRecentTurns: 4,
        maxRecentWindowTokens: 20_000,
        maxRecapChars: 1_500,
        maxBioChars: 1_000,
        rederiveEveryNAdvances: 6,
        maxConsecutiveRecapFailures: 3,
        breakerProbeEveryNSkips: 3,
        maxSummarizerInputTokens: 600_000,
      },
      guide: "",
      bio: "",
      summarize: async () => "",
      cacheRead: () => null,
      cacheWrite: () => {},
      consecutiveFailures: 0,
      skippedWhileOpen: 0,
    };
  }

  function mkRecapDriver(recap: RecapRuntime): V2ActorDriver {
    const provider = mkProvider([[{ type: "finish", reason: "stop" }]]);
    const noopRuntime: CodingAgentRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;
    return new V2ActorDriver({
      provider,
      model: "test-model",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      routerProvider: mkNoopRouter(),
      metaThinkCorpus: mkEmptyCorpusForHelper(),
      recap,
    });
  }

  it("computes the recap from the configured runtime BEFORE the turn and threads it as precomputedRecap", async () => {
    // prepareTurnRecap(record, staticPrefix, rt, forceCompact, signal, notify)
    const recapSpy = vi.spyOn(recapRuntime, "prepareTurnRecap");
    const seen: Array<PreparedRecap | undefined> = [];
    vi.spyOn(actorTurn, "runActorCompletionTurn").mockImplementation(
      async (state, _userText, deps) => {
        seen.push(deps.precomputedRecap);
        return { record: state.record };
      },
    );

    const recap = mkRecapRuntime();
    const driver = mkRecapDriver(recap);
    await driver.runTurn("一", new AbortController().signal);

    // The configured runtime is the 3rd positional arg to prepareTurnRecap…
    expect(recapSpy).toHaveBeenCalledTimes(1);
    expect(recapSpy.mock.calls[0]?.[2]).toBe(recap);
    // …and its result is threaded straight through to the turn (same object).
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(await recapSpy.mock.results[0]?.value);
  });

  it("runs the recap and the router CONCURRENTLY — the router is called while the recap is still pending (2026-09-03)", async () => {
    // The recap resolves only once the router has been called. Under the
    // old back-to-back order the router never ran before the recap settled,
    // so this turn would hang; the race below turns that hang into a
    // failure instead of a timeout.
    let routerCalled: () => void = () => {};
    const routerCalledPromise = new Promise<void>((resolve) => {
      routerCalled = resolve;
    });
    const order: string[] = [];
    vi.spyOn(recapRuntime, "prepareTurnRecap").mockImplementation(async () => {
      order.push("recap:start");
      const won = await Promise.race([
        routerCalledPromise.then(() => "router" as const),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), 1000),
        ),
      ]);
      order.push(`recap:end(${won})`);
      return { recapBoundaryIndex: 0 };
    });
    vi.spyOn(actorTurn, "runActorCompletionTurn").mockImplementation(
      async (state) => ({ record: state.record }),
    );
    const router: ProviderAdapter = {
      streamChat(): AsyncIterable<ProviderEvent> {
        order.push("router:called");
        routerCalled();
        return streamOf<ProviderEvent>([
          { type: "text-delta", text: "教学版" },
          { type: "finish", reason: "stop" },
        ]);
      },
    };
    const noopRuntime: CodingAgentRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;
    const driver = new V2ActorDriver({
      provider: mkProvider([[{ type: "finish", reason: "stop" }]]),
      model: "test-model",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      routerProvider: router,
      metaThinkCorpus: mkEmptyCorpusForHelper(),
      recap: mkRecapRuntime(),
    });
    await driver.runTurn("一", new AbortController().signal);
    // The recap was started first (its hint lands first on a compaction
    // turn), the router ran while it was pending, and the router's verdict
    // still applied.
    expect(order).toEqual([
      "recap:start",
      "router:called",
      "recap:end(router)",
    ]);
    expect(driver.getCurrentIntentState()).toBe("教学版");
  });

  it("a failing router still keeps the prior state while the recap runs (non-fatal, no unhandled rejection)", async () => {
    vi.spyOn(recapRuntime, "prepareTurnRecap").mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return { recapBoundaryIndex: 0 };
    });
    vi.spyOn(actorTurn, "runActorCompletionTurn").mockImplementation(
      async (state) => ({ record: state.record }),
    );
    const router: ProviderAdapter = {
      streamChat(): AsyncIterable<ProviderEvent> {
        throw new Error("router unreachable");
      },
    };
    const noopRuntime: CodingAgentRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;
    const driver = new V2ActorDriver({
      provider: mkProvider([[{ type: "finish", reason: "stop" }]]),
      model: "test-model",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      routerProvider: router,
      metaThinkCorpus: mkEmptyCorpusForHelper(),
      recap: mkRecapRuntime(),
    });
    await expect(
      driver.runTurn("一", new AbortController().signal),
    ).resolves.toBeDefined();
    expect(driver.getCurrentIntentState()).toBe("默认");
  });

  it("rewind invalidates the recap sidecar only when the cut lands at/below the cached boundary", () => {
    const invalidate = vi.fn();
    const mk = (boundaryIndex: number): RecapRuntime => ({
      ...mkRecapRuntime(),
      cacheRead: () => ({
        boundaryIndex,
        recapText: "回忆",
        lang: "zh",
        advancesSinceRederive: 0,
      }),
      cacheInvalidate: invalidate,
    });

    // Rewind withdraws the last user turn (u2, h2) → new length 2; the
    // cached boundary 2 now points past the record → sidecar deleted.
    const stale = mkRecapDriver(mk(2));
    stale.loadRecord([
      { kind: "user", text: "u1" },
      { kind: "herta", surface: "speech", text: "h1" },
      { kind: "user", text: "u2" },
      { kind: "herta", surface: "speech", text: "h2" },
    ]);
    expect(stale.rewindLastUserTurn()).not.toBeNull();
    expect(invalidate).toHaveBeenCalledTimes(1);

    // Tail-only cut ABOVE the boundary: boundary 2 still indexes a user
    // block inside the shorter record → compacted span untouched → kept.
    invalidate.mockClear();
    const live = mkRecapDriver(mk(2));
    live.loadRecord([
      { kind: "user", text: "u1" },
      { kind: "herta", surface: "speech", text: "h1" },
      { kind: "user", text: "u2" },
      { kind: "herta", surface: "speech", text: "h2" },
      { kind: "user", text: "u3" },
      { kind: "herta", surface: "speech", text: "h3" },
    ]);
    expect(live.rewindLastUserTurn()).not.toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("calls prepareTurnRecap with rt undefined when no recap runtime is configured", async () => {
    const recapSpy = vi.spyOn(recapRuntime, "prepareTurnRecap");
    const seen: Array<PreparedRecap | undefined> = [];
    vi.spyOn(actorTurn, "runActorCompletionTurn").mockImplementation(
      async (state, _userText, deps) => {
        seen.push(deps.precomputedRecap);
        return { record: state.record };
      },
    );

    const driver = mkDriver(mkProvider([[{ type: "finish", reason: "stop" }]]));
    await driver.runTurn("一", new AbortController().signal);

    expect(recapSpy.mock.calls[0]?.[2]).toBeUndefined();
    // No runtime → prepareTurnRecap short-circuits to a no-op recap.
    expect(seen[0]).toEqual({ recapBoundaryIndex: 0 });
  });
});

describe("V2ActorDriver — interaction language (slice 4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mkLangDriver(lang?: "zh" | "en"): V2ActorDriver {
    const provider = mkProvider([[{ type: "finish", reason: "stop" }]]);
    const noopRuntime: CodingAgentRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => ({
        taskId: brief.taskId,
        status: "completed" as const,
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }),
    } as unknown as CodingAgentRuntime;
    return new V2ActorDriver({
      provider,
      model: "test-model",
      staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
      bus: new InMemoryEventBus<AgentEvent>(),
      runtimeFactory: () => noopRuntime,
      routerProvider: mkNoopRouter(),
      metaThinkCorpus: mkEmptyCorpusForHelper(),
      ...(lang !== undefined ? { lang } : {}),
    });
  }

  it('threads lang: "en" into classifyIntent AND runActorCompletionTurn', async () => {
    const intentSpy = vi.spyOn(intentRouter, "classifyIntent");
    const seenLangs: Array<string | undefined> = [];
    vi.spyOn(actorTurn, "runActorCompletionTurn").mockImplementation(
      async (state, _userText, deps) => {
        seenLangs.push(deps.lang);
        return { record: state.record };
      },
    );
    const driver = mkLangDriver("en");
    await driver.runTurn("hi", new AbortController().signal);
    expect(intentSpy).toHaveBeenCalledTimes(1);
    expect(intentSpy.mock.calls[0]?.[0]?.lang).toBe("en");
    expect(seenLangs).toEqual(["en"]);
  });

  it('defaults to "zh" at both call sites when lang is omitted (zh identity)', async () => {
    const intentSpy = vi.spyOn(intentRouter, "classifyIntent");
    const seenLangs: Array<string | undefined> = [];
    vi.spyOn(actorTurn, "runActorCompletionTurn").mockImplementation(
      async (state, _userText, deps) => {
        seenLangs.push(deps.lang);
        return { record: state.record };
      },
    );
    const driver = mkLangDriver();
    await driver.runTurn("hi", new AbortController().signal);
    expect(intentSpy.mock.calls[0]?.[0]?.lang).toBe("zh");
    expect(seenLangs).toEqual(["zh"]);
  });
});
