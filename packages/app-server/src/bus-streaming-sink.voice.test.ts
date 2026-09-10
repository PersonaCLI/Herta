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

function sinkWithVoice(onSupervisedVoice?: () => void) {
  const bus = new InMemoryEventBus<AgentEvent>();
  const speech: SpeechControlEvent[] = [];
  const voice: VoiceCueEvent[] = [];
  const deltas: string[] = [];
  bus.on("assistant.delta", (e) => deltas.push((e as { text: string }).text));
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
    ...(onSupervisedVoice !== undefined ? { onSupervisedVoice } : {}),
  });
  return {
    sink,
    synth,
    speech,
    voice,
    deltas,
    tts: () => voice.filter((v) => v.kind === "tts"),
    stops: () => voice.filter((v) => v.kind === "ttsStop"),
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

  it("onSupervisedVoice fires when a SUPERVISED voiced stream's first unit is requested — before its verdict, even for one sentence — and never for an unsupervised one", async () => {
    // What the synthesizer had been asked for at the moment of arming.
    const armed: (string | undefined)[] = [];
    const h = sinkWithVoice(() => armed.push(h.synth.requests.at(-1)?.text));
    const plain = h.sink.slowStreamSpeech(S0);
    await vi.advanceTimersByTimeAsync(1100);
    await plain.done;
    expect(armed).toHaveLength(0);
    // One sentence under a verdict that never comes: the stream cannot
    // begin, but its unit is in flight and the reaction is armed behind it.
    const held = h.sink.slowStreamSpeechLive({
      verdictPending: new Promise<void>(() => {}),
    });
    held.pushToken(S0);
    held.finishInput();
    expect(armed).toEqual([S0]); // after the first request, once
    expect(h.tts()).toHaveLength(1); // the plain stream's only: still held
    held.done.catch(() => undefined);
    await held.cancelAndBackspace();
    h.sink.settleVoice();
    // Two sentences: still once, at the first unit, not at the begin.
    let verdict!: () => void;
    const verdictPending = new Promise<void>((r) => {
      verdict = r;
    });
    const supervised = h.sink.slowStreamSpeechLive({ verdictPending });
    supervised.pushToken(`${S0}${S1}`);
    supervised.finishInput();
    await vi.advanceTimersByTimeAsync(0);
    expect(armed).toHaveLength(2);
    verdict();
    const drained = supervised.fastForward();
    await vi.advanceTimersByTimeAsync(3000);
    await drained;
    expect(armed).toHaveLength(2);
  });

  it("the stop click: a beat lands as before; a primary under the supervisor hold falls silent WITHOUT landing the withheld candidate", async () => {
    const h = sinkWithVoice();
    // A beat sounding alone: the click lands its text in one emit.
    h.sink.beginHertaStream("speech");
    h.sink.streamHertaToken(S1);
    h.sink.endHertaStream();
    await vi.advanceTimersByTimeAsync(200);
    const beatShown = h.deltas.join("");
    expect(beatShown.length).toBeGreaterThan(0);
    expect(beatShown.length).toBeLessThan(S1.length);
    h.sink.settleVoice({ interrupt: true });
    expect(h.deltas.join("")).toBe(S1);
    expect(h.stops()).toHaveLength(1);
    // A one-sentence supervised reply, held: nothing on screen.
    h.deltas.length = 0;
    const held = h.sink.slowStreamSpeechLive({
      verdictPending: new Promise<void>(() => {}),
    });
    held.pushToken(S0);
    held.finishInput();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.deltas).toEqual([]);
    // The stop click: silence, and the candidate did NOT flash.
    h.sink.settleVoice({ interrupt: true });
    expect(h.deltas).toEqual([]);
    expect(h.stops()).toHaveLength(2);
    // …the actor's own abort path follows and retracts, as before.
    held.done.catch(() => undefined);
    await held.cancelAndBackspace();
    expect(h.deltas).toEqual([]);
    // Turn end lands everything, as it always did.
    h.sink.settleVoice();
  });
});
