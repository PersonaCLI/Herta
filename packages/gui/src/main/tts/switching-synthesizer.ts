import type {
  SpeechSynthesizer,
  SynthesisRequest,
  SynthesizedAudio,
} from "@herta/app-server";

/**
 * One `SpeechSynthesizer` for the app-server, two engines behind it (ADR
 * 0062): the local Kokoro model and the MiniMax clone. The engine is read at
 * every speech stream's start (`available()`), and each utterance is LATCHED
 * to the engine that answered its first unit: a toggle mid-reply must not
 * switch her voice in the middle of a sentence. `cancel` follows the latch.
 */
export type VoiceEngine = "local" | "minimax";

export interface SwitchingSynthesizerOpts {
  readonly engine: () => VoiceEngine;
  readonly local: SpeechSynthesizer;
  readonly minimax: SpeechSynthesizer;
}

export interface SwitchingSynthesizer extends SpeechSynthesizer {
  /** The engine the next stream would use. */
  active(): VoiceEngine;
}

export function createSwitchingSynthesizer(
  opts: SwitchingSynthesizerOpts,
): SwitchingSynthesizer {
  const latched = new Map<string, VoiceEngine>();
  const pick = (engine: VoiceEngine): SpeechSynthesizer =>
    engine === "minimax" ? opts.minimax : opts.local;
  return {
    active(): VoiceEngine {
      return opts.engine();
    },
    available(): boolean {
      return pick(opts.engine()).available();
    },
    // The engine the stream's first unit will latch to — the reveal reads
    // this just before that request (ADR 0042 §7d).
    warm(): boolean {
      return pick(opts.engine()).warm?.() === true;
    },
    synthesize(req: SynthesisRequest): Promise<SynthesizedAudio | null> {
      let engine = latched.get(req.utteranceId);
      if (engine === undefined) {
        engine = opts.engine();
        latched.set(req.utteranceId, engine);
        // Utterance ids are unique per stream; keep the map bounded.
        if (latched.size > 64) {
          const oldest = latched.keys().next().value;
          if (oldest !== undefined) latched.delete(oldest);
        }
      }
      return pick(engine).synthesize(req);
    },
    cancel(utteranceId: string): void {
      const engine = latched.get(utteranceId);
      if (engine === undefined) {
        opts.local.cancel(utteranceId);
        opts.minimax.cancel(utteranceId);
        return;
      }
      pick(engine).cancel(utteranceId);
    },
  };
}
