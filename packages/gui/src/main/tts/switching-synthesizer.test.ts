import type { SpeechSynthesizer } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import {
  createSwitchingSynthesizer,
  type VoiceEngine,
} from "./switching-synthesizer.js";

function engine(name: string, available = true) {
  const calls: string[] = [];
  const cancels: string[] = [];
  const synth: SpeechSynthesizer = {
    available: () => available,
    synthesize: async (req) => {
      calls.push(`${name}:${req.utteranceId}/${req.seq}`);
      return { samples: new Int16Array([1]), sampleRate: 24000, durationMs: 1 };
    },
    cancel: (id) => {
      cancels.push(`${name}:${id}`);
    },
  };
  return { synth, calls, cancels };
}

const req = (utteranceId: string, seq: number) => ({
  utteranceId,
  seq,
  text: "x",
  lang: "zh" as const,
});

describe("createSwitchingSynthesizer", () => {
  it("available() and the first unit follow the engine setting; later units of the utterance stay latched", async () => {
    let choice: VoiceEngine = "local";
    const local = engine("local");
    const minimax = engine("minimax");
    const sw = createSwitchingSynthesizer({
      engine: () => choice,
      local: local.synth,
      minimax: minimax.synth,
    });
    expect(sw.active()).toBe("local");
    await sw.synthesize(req("u1", 0));
    choice = "minimax";
    expect(sw.active()).toBe("minimax");
    await sw.synthesize(req("u1", 1)); // still local: latched
    await sw.synthesize(req("u2", 0)); // a new utterance takes the new engine
    expect(local.calls).toEqual(["local:u1/0", "local:u1/1"]);
    expect(minimax.calls).toEqual(["minimax:u2/0"]);
    sw.cancel("u1");
    sw.cancel("u2");
    sw.cancel("unknown");
    expect(local.cancels).toEqual(["local:u1", "local:unknown"]);
    expect(minimax.cancels).toEqual(["minimax:u2", "minimax:unknown"]);
  });

  it("warm() is the answer of the engine the next stream would use; an engine that cannot say is cold", () => {
    let choice: VoiceEngine = "local";
    let localWarm = false;
    const local = engine("local");
    const minimax = engine("minimax");
    const sw = createSwitchingSynthesizer({
      engine: () => choice,
      local: { ...local.synth, warm: () => localWarm },
      minimax: minimax.synth, // no warm()
    });
    expect(sw.warm?.()).toBe(false);
    localWarm = true;
    expect(sw.warm?.()).toBe(true);
    choice = "minimax";
    expect(sw.warm?.()).toBe(false);
  });

  it("available() is the chosen engine's answer", () => {
    const local = engine("local", false);
    const minimax = engine("minimax", true);
    let choice: VoiceEngine = "local";
    const sw = createSwitchingSynthesizer({
      engine: () => choice,
      local: local.synth,
      minimax: minimax.synth,
    });
    expect(sw.available()).toBe(false);
    choice = "minimax";
    expect(sw.available()).toBe(true);
  });
});
