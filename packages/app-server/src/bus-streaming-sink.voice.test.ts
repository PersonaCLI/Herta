import { type AgentEvent, InMemoryEventBus } from "@herta/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BusActorStreamingSink } from "./bus-streaming-sink.js";
import type {
  SpeechControlEvent,
  SpeechSynthesizer,
  SynthesisRequest,
  VoiceCueEvent,
} from "./types.js";

/** A synthesizer that answers at once: 1 s of audio per unit. */
function instantSynth(): SpeechSynthesizer & { requests: SynthesisRequest[] } {
  const requests: SynthesisRequest[] = [];
  return {
    requests,
    available: () => true,
    async synthesize(req) {
      requests.push(req);
      return {
        samples: new Int16Array(24000),
        sampleRate: 24000,
        durationMs: 1000,
      };
    },
    cancel: () => undefined,
  };
}

function sinkWithVoice(onVoicedBegin?: () => void) {
  const bus = new InMemoryEventBus<AgentEvent>();
  const speech: SpeechControlEvent[] = [];
  const voice: VoiceCueEvent[] = [];
  const sink = new BusActorStreamingSink(
    bus,
    (ev) => speech.push(ev),
    () => undefined,
    () => 0.5,
  );
  const synth = instantSynth();
  sink.attachVoice({
    synth,
    emitVoice: (ev) => voice.push(ev),
    ...(onVoicedBegin !== undefined ? { onVoicedBegin } : {}),
  });
  return {
    sink,
    synth,
    speech,
    voice,
    tts: () => voice.filter((v) => v.kind === "tts"),
  };
}

const S0 = "第一句话说得比较长一些。";
const S1 = "第二句也说得比较长一些。";
const S1b = "第二句换了一个说法来讲。";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("BusActorStreamingSink — the voice after a veto (ADR 0042 §7b)", () => {
  it("holdVoiceLane delays the next voiced driver's first unit by the hold", async () => {
    const h = sinkWithVoice();
    h.sink.holdVoiceLane(500);
    const ctrl = h.sink.slowStreamSpeech(S0);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.tts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(499);
    expect(h.tts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(h.tts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1100);
    await ctrl.done;
  });

  it("after a veto: the retract floor snaps to the start of the sentence it falls in, and the retry skips the sentences already played", async () => {
    const h = sinkWithVoice();
    const vetoed = h.sink.slowStreamSpeechLive();
    vetoed.pushToken(`${S0}${S1}`);
    vetoed.finishInput();
    // Unit 0 plays to its end; unit 1 starts and is cut.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.tts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(300);
    await vetoed.cancelAndBackspace();
    expect(h.speech.at(-1)).toEqual({ kind: "retract" });
    // The divergence lands three characters into the second sentence: the
    // erase goes back to that sentence's start.
    h.sink.emitRetractFloor(S0.length + 3);
    expect(h.speech.at(-1)).toEqual({
      kind: "retractFloor",
      keepLen: S0.length,
    });
    // The retry: the first sentence is the one already heard.
    const before = h.synth.requests.length;
    const retry = h.sink.slowStreamSpeechLive();
    retry.pushToken(`${S0}${S1b}`);
    retry.finishInput();
    await vi.advanceTimersByTimeAsync(0);
    const retryRequests = h.synth.requests.slice(before);
    expect(retryRequests.map((r) => [r.seq, r.text])).toEqual([[1, S1b]]);
    await vi.advanceTimersByTimeAsync(1200);
    await retry.done;
    // The turn settles: the next turn's driver starts clean.
    h.sink.settleVoice();
    h.sink.emitRetractFloor(7);
    expect(h.speech.at(-1)).toEqual({ kind: "retractFloor", keepLen: 7 });
  });

  it("onVoicedBegin fires when a SUPERVISED voiced stream begins, not for an unsupervised one", async () => {
    const begins: number[] = [];
    const h = sinkWithVoice(() => begins.push(1));
    const plain = h.sink.slowStreamSpeech(S0);
    await vi.advanceTimersByTimeAsync(1100);
    await plain.done;
    expect(begins).toHaveLength(0);
    let verdict!: () => void;
    const verdictPending = new Promise<void>((r) => {
      verdict = r;
    });
    const supervised = h.sink.slowStreamSpeechLive({ verdictPending });
    supervised.pushToken(`${S0}${S1}`);
    supervised.finishInput();
    await vi.advanceTimersByTimeAsync(0);
    expect(begins).toHaveLength(1);
    verdict();
    // The drain plays the held last unit: the clock has to move for it.
    const drained = supervised.fastForward();
    await vi.advanceTimersByTimeAsync(3000);
    await drained;
    expect(begins).toHaveLength(1);
  });
});
