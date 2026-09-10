import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpeningChoice } from "@herta/herta";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionVoice,
  VETO_FILLER_TAIL_MS,
  VETO_FILLER_WAIT_MS,
} from "./session-voice.js";
import type {
  SpeechSynthesizer,
  SynthesisRequest,
  SynthesizedAudio,
  VoiceCueEvent,
} from "./types.js";

/** A voice-clip root with one easter-egg clip whose stem is the line, one
 *  sigh variant, and one veto line (named by its text, like the real ones). */
const EGG_LINE = "你动它干什么？实在没事的话，过来帮我测模拟宇宙？";
const VETO_LINE = "等等，我得再改一改。";
function assets(): string {
  const root = mkdtempSync(join(tmpdir(), "herta-voice-"));
  mkdirSync(join(root, "easter_egg"));
  writeFileSync(join(root, "easter_egg", `${EGG_LINE}.opus`), "");
  mkdirSync(join(root, "particle", "唉"), { recursive: true });
  writeFileSync(join(root, "particle", "唉", "01.opus"), "");
  mkdirSync(join(root, "veto"));
  writeFileSync(join(root, "veto", `${VETO_LINE}.opus`), "");
  return root;
}

const AUDIO: SynthesizedAudio = {
  samples: new Int16Array([1, 2, 3]),
  sampleRate: 24000,
  durationMs: 125,
};

function fakeSynth(opts: {
  available: boolean;
  answer?: "audio" | "null" | "throw" | "deferred";
}): SpeechSynthesizer & {
  requests: SynthesisRequest[];
  land(audio: SynthesizedAudio | null): void;
} {
  const requests: SynthesisRequest[] = [];
  const deferred: ((a: SynthesizedAudio | null) => void)[] = [];
  return {
    requests,
    land: (audio) => {
      for (const r of deferred.splice(0)) r(audio);
    },
    available: () => opts.available,
    async synthesize(req) {
      requests.push(req);
      if (opts.answer === "throw") throw new Error("boom");
      if (opts.answer === "null") return null;
      if (opts.answer === "deferred") {
        return new Promise((r) => {
          deferred.push(r);
        });
      }
      return AUDIO;
    },
    cancel: () => undefined,
  };
}

const opening: OpeningChoice = {
  preamble: "",
  seedText: "你来了。",
  sourceFile: "004-late-night-audit.txt",
  band: "neutral",
  voiceClipId: "004-late-night-audit",
};

async function voice(opts: {
  synth?: SpeechSynthesizer;
  lang?: "zh" | "en";
  withOpening?: boolean;
  /** The veto roll's draws: 0 → the veto line, 0.5 → a sigh, 0.9 → silence. */
  vetoRandom?: () => number;
}) {
  const emitted: VoiceCueEvent[] = [];
  const v = await loadSessionVoice({
    voiceAssetsDir: assets(),
    lang: opts.lang ?? "zh",
    opening: opts.withOpening === false ? undefined : opening,
    emit: (e) => emitted.push(e),
    openingDurationMs: 1000,
    particleRandom: () => 0,
    vetoRandom: opts.vetoRandom ?? (() => 0),
    easterEggRandom: () => 0, // the 50% roll always wins; the pick is the first
    easterEggNow: () => 1,
    ...(opts.synth !== undefined ? { synth: opts.synth } : {}),
  });
  return { v, emitted };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("session voice — the veto reaction in her own voice (ADR 0042 §7b)", () => {
  it("armed when the voiced reply is in flight, spoken at the veto: everything stops, the line plays, the lane holds for its length", async () => {
    const synth = fakeSynth({ available: true });
    const { v, emitted } = await voice({ synth });
    v.armVetoReaction();
    // Low priority: the filler never delays the reply's own units.
    expect(synth.requests).toEqual([
      {
        utteranceId: "veto1",
        seq: 0,
        text: VETO_LINE,
        lang: "zh",
        priority: "low",
      },
    ]);
    await flush();
    expect(emitted).toEqual([]); // nothing until the veto
    const hold = v.onSupervisorVeto();
    expect(hold).toBe(125 + VETO_FILLER_TAIL_MS);
    expect(emitted).toEqual([
      { kind: "ttsStop" },
      {
        kind: "tts",
        utteranceId: "veto1",
        seq: 0,
        samples: AUDIO.samples,
        sampleRate: 24000,
        durationMs: 125,
      },
    ]);
    // Spent: a second veto in the same turn has nothing armed and falls
    // back to the recorded roll.
    expect(v.onSupervisorVeto()).toBe(0);
    expect(emitted.at(-1)).toMatchObject({ kind: "cue", category: "veto" });
  });

  it("disarmed at the turn's end: a later veto plays the recording, and a filler still synthesizing is cancelled", async () => {
    const synth = fakeSynth({ available: true, answer: "deferred" });
    const cancelled: string[] = [];
    synth.cancel = (id) => cancelled.push(id);
    const { v, emitted } = await voice({ synth });
    v.armVetoReaction();
    v.disarmVetoReaction();
    expect(cancelled).toEqual(["veto1"]);
    // Nothing armed: the recorded roll, no hold — never a stale filler.
    expect(v.onSupervisorVeto()).toBe(0);
    expect(emitted).toEqual([
      { kind: "cue", category: "veto", clipId: VETO_LINE },
    ]);
    // A filler that had landed is simply dropped, and nothing is cancelled.
    const landed = fakeSynth({ available: true });
    const c2: string[] = [];
    landed.cancel = (id) => c2.push(id);
    const w = await voice({ synth: landed });
    w.v.armVetoReaction();
    await flush();
    w.v.disarmVetoReaction();
    expect(c2).toEqual([]);
    expect(w.v.onSupervisorVeto()).toBe(0);
  });

  it("a sigh is the token trailing off; silence stays silent and asks for nothing", async () => {
    const sigh = fakeSynth({ available: true });
    const a = await voice({ synth: sigh, vetoRandom: () => 0.5 });
    a.v.armVetoReaction();
    expect(sigh.requests[0]?.text).toBe("唉……");
    await flush();
    expect(a.v.onSupervisorVeto()).toBe(125 + VETO_FILLER_TAIL_MS);
    expect(a.emitted[1]).toMatchObject({ kind: "tts", utteranceId: "veto1" });
    const quiet = fakeSynth({ available: true });
    const b = await voice({ synth: quiet, vetoRandom: () => 0.9 });
    b.v.armVetoReaction();
    expect(quiet.requests).toEqual([]);
    expect(b.v.onSupervisorVeto()).toBe(0);
    expect(b.emitted).toEqual([]);
  });

  it("a veto before the filler is ready plays it when it lands; past the bound, the recording", async () => {
    vi.useFakeTimers();
    const late = fakeSynth({ available: true, answer: "deferred" });
    const a = await voice({ synth: late });
    a.v.armVetoReaction();
    expect(a.v.onSupervisorVeto()).toBe(
      VETO_FILLER_WAIT_MS + VETO_FILLER_TAIL_MS,
    );
    expect(a.emitted).toEqual([]);
    late.land(AUDIO);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.emitted.map((e) => e.kind)).toEqual(["ttsStop", "tts"]);
    const never = fakeSynth({ available: true, answer: "deferred" });
    const b = await voice({ synth: never });
    b.v.armVetoReaction();
    b.v.onSupervisorVeto();
    await vi.advanceTimersByTimeAsync(VETO_FILLER_WAIT_MS + 1);
    expect(b.emitted).toEqual([
      { kind: "cue", category: "veto", clipId: VETO_LINE },
    ]);
    // Landing after the bound changes nothing.
    never.land(AUDIO);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.emitted).toHaveLength(1);
  });

  it("a synthesis that fails falls back to the recording; without the synthesizer the recording plays as before, no hold", async () => {
    const failing = fakeSynth({ available: true, answer: "null" });
    const a = await voice({ synth: failing });
    a.v.armVetoReaction();
    await flush();
    expect(a.v.onSupervisorVeto()).toBe(0);
    expect(a.emitted).toEqual([
      { kind: "cue", category: "veto", clipId: VETO_LINE },
    ]);
    const off = await voice({ synth: fakeSynth({ available: false }) });
    off.v.armVetoReaction();
    expect(off.v.onSupervisorVeto()).toBe(0);
    expect(off.emitted).toEqual([
      { kind: "cue", category: "veto", clipId: VETO_LINE },
    ]);
  });
});

describe("session voice — one voice with the synthesizer on (ADR 0042 §7a)", () => {
  it("the opening: the clip cues by default; told `voiced`, no clip — the sink speaks it", async () => {
    const a = await voice({});
    a.v.onOpeningStreamStart();
    expect(a.emitted).toEqual([
      { kind: "cue", category: "openings", clipId: "004-late-night-audit" },
    ]);
    const b = await voice({ synth: fakeSynth({ available: true }) });
    b.v.onOpeningStreamStart(true);
    expect(b.emitted).toEqual([]);
  });

  it("the particle cue is withheld while the synthesizer is available — the synthesized unit carries it", async () => {
    const off = await voice({ synth: fakeSynth({ available: false }) });
    off.v.onPrimarySpeechStart("唉，又来了。");
    expect(off.emitted).toHaveLength(1);
    expect(off.emitted[0]).toMatchObject({
      kind: "cue",
      category: "particle/唉",
    });
    const on = await voice({ synth: fakeSynth({ available: true }) });
    on.v.onPrimarySpeechStart("唉，又来了。");
    expect(on.emitted).toEqual([]);
  });

  it("the lift's line is synthesized from the clip's stem: everything stops, then the unit", async () => {
    const synth = fakeSynth({ available: true, answer: "audio" });
    const { v, emitted } = await voice({ synth });
    v.maybePlayEasterEgg();
    await flush();
    expect(synth.requests).toEqual([
      { utteranceId: "egg1", seq: 0, text: EGG_LINE, lang: "zh" },
    ]);
    expect(emitted).toEqual([
      { kind: "ttsStop" },
      {
        kind: "tts",
        utteranceId: "egg1",
        seq: 0,
        samples: new Int16Array([1, 2, 3]),
        sampleRate: 24000,
        durationMs: 125,
      },
    ]);
  });

  it("a synthesis that answers null, or throws, falls back to the recording", async () => {
    for (const answer of ["null", "throw"] as const) {
      const { v, emitted } = await voice({
        synth: fakeSynth({ available: true, answer }),
      });
      v.maybePlayEasterEgg();
      await flush();
      expect(emitted).toEqual([
        { kind: "cue", category: "easter_egg", clipId: EGG_LINE },
      ]);
    }
  });

  it("without the synthesizer, or with it unavailable, the lift plays the recording as before", async () => {
    const none = await voice({});
    none.v.maybePlayEasterEgg();
    await flush();
    expect(none.emitted).toEqual([
      { kind: "cue", category: "easter_egg", clipId: EGG_LINE },
    ]);
    const off = await voice({ synth: fakeSynth({ available: false }) });
    off.v.maybePlayEasterEgg();
    await flush();
    expect(off.emitted).toEqual([
      { kind: "cue", category: "easter_egg", clipId: EGG_LINE },
    ]);
  });

  it("an EN session cues nothing, synthesizer or not (no EN voice in v1)", async () => {
    const synth = fakeSynth({ available: true });
    const { v, emitted } = await voice({ synth, lang: "en" });
    v.onPrimarySpeechStart("Well, again.");
    v.maybePlayEasterEgg();
    await flush();
    expect(emitted).toEqual([]);
    expect(synth.requests).toEqual([]);
  });
});
