import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  FADE_OUT_MS,
  isSpeechPlaying,
  playSpeechUnit,
  stopSpeech,
} from "./speech-player.js";
import { setVoiceMuted } from "./voice-prefs.js";

/** Just enough Web Audio for the player: gains with schedulable params,
 *  buffer sources that record start/stop times. */
class FakeParam {
  value = 1;
  readonly setValueAtTime = vi.fn();
  readonly linearRampToValueAtTime = vi.fn();
  readonly cancelScheduledValues = vi.fn();
}
class FakeGain {
  readonly gain = new FakeParam();
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}
class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  readonly connect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn();
}
class FakeContext {
  static current: FakeContext | null = null;
  currentTime = 10;
  state = "running";
  readonly destination = {};
  readonly gains: FakeGain[] = [];
  readonly sources: FakeSource[] = [];
  readonly resume = vi.fn(async () => undefined);
  constructor() {
    FakeContext.current = this;
  }
  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return {
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
    };
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

const unit = (utteranceId: string, seconds: number) => ({
  utteranceId,
  samples: new Int16Array(Math.round(seconds * 24000)),
  sampleRate: 24000,
});

beforeAll(() => {
  vi.stubGlobal("AudioContext", FakeContext as never);
});
afterEach(() => {
  stopSpeech();
  setVoiceMuted(false);
  const c = FakeContext.current;
  if (c !== null) {
    c.sources.length = 0;
    c.currentTime = 10;
  }
});

describe("speech-player", () => {
  it("schedules units of one utterance back to back; a new utterance starts now", () => {
    playSpeechUnit(unit("u1", 1));
    playSpeechUnit(unit("u1", 0.5));
    const c = FakeContext.current as FakeContext;
    expect(c.sources.map((s) => s.start.mock.calls[0]?.[0])).toEqual([10, 11]);
    expect(isSpeechPlaying()).toBe(true);
    // Another utterance ignores the previous cursor.
    playSpeechUnit(unit("u2", 0.25));
    expect(c.sources[2]?.start.mock.calls[0]?.[0]).toBe(10);
  });

  it("a stop FADES the live units over the beat and stops them when the ramp lands (ADR 0042 §7b)", () => {
    playSpeechUnit(unit("u1", 2));
    const c = FakeContext.current as FakeContext;
    const src = c.sources[0] as FakeSource;
    // The master gain is the first node; the unit's own gain follows it.
    const unitGain = c.gains[c.gains.length - 1] as FakeGain;
    expect(unitGain).not.toBe(c.gains[0]);
    c.currentTime = 10.7;
    stopSpeech("u1");
    const end = 10.7 + FADE_OUT_MS / 1000;
    expect(unitGain.gain.cancelScheduledValues).toHaveBeenCalledWith(10.7);
    expect(unitGain.gain.setValueAtTime).toHaveBeenCalledWith(1, 10.7);
    expect(unitGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, end);
    expect(src.stop.mock.calls[0]?.[0]).toBeCloseTo(end + 0.01, 5);
    // The master volume is untouched by the fade.
    expect(
      (c.gains[0] as FakeGain).gain.linearRampToValueAtTime,
    ).not.toHaveBeenCalled();
    // Fading is no longer "her speaking": the aura can drop at once.
    expect(isSpeechPlaying()).toBe(false);
    // A unit that starts during the fade plays whole, on a fresh gain.
    playSpeechUnit(unit("u2", 1));
    const fresh = c.gains[c.gains.length - 1] as FakeGain;
    expect(fresh).not.toBe(unitGain);
    expect(fresh.gain.value).toBe(1);
    expect(c.sources[1]?.start.mock.calls[0]?.[0]).toBe(10.7);
  });

  it("a stop for another utterance is ignored; a bare stop takes everything", () => {
    playSpeechUnit(unit("u1", 1));
    const c = FakeContext.current as FakeContext;
    stopSpeech("stale");
    expect(isSpeechPlaying()).toBe(true);
    expect((c.sources[0] as FakeSource).stop).not.toHaveBeenCalled();
    stopSpeech();
    expect(isSpeechPlaying()).toBe(false);
    expect((c.sources[0] as FakeSource).stop).toHaveBeenCalled();
  });
});
