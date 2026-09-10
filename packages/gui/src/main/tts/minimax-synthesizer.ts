import type {
  SpeechSynthesizer,
  SynthesisRequest,
  SynthesizedAudio,
} from "@herta/app-server";
import { errorMessage } from "@herta/core";
import {
  type FetchLike,
  MINIMAX_DEFAULT_MODEL,
  MiniMaxError,
  type MiniMaxFailure,
  synthesizePcm,
} from "./minimax-api.js";

/**
 * Herta's cloud voice (ADR 0062): the MiniMax clone behind the same
 * `SpeechSynthesizer` seam the local model uses, so the voiced reveal — units,
 * pacing, veto, interrupt, the unvoiced fallback — is untouched. One HTTP
 * request per sentence unit; the station-terminal treatment applied here on
 * the returned samples (injected, so this unit-tests without the .cjs).
 *
 * Best-effort like the local engine: a failed, cancelled or overdue unit
 * resolves `null` and types unvoiced; a "voice missing" answer (MiniMax
 * deletes clones idle for 7 days) latches the voice off and tells the clone
 * service, which re-clones; `available()` stays false until a new voice id
 * arrives.
 */
export interface MiniMaxVoiceRef {
  readonly voiceId: string;
  readonly host: string;
}

export interface MiniMaxSynthesizerOpts {
  readonly fetch: FetchLike;
  /** The user's key from the secure store, read per call — never cached. */
  readonly key: () => string | null;
  /** The clone this install owns, or null before one exists. */
  readonly voice: () => MiniMaxVoiceRef | null;
  /** The live toggle + engine choice (both read per call). */
  readonly enabled: () => boolean;
  readonly model?: string;
  /** The comm-channel treatment; identity when omitted. */
  readonly applyEffect?: (
    samples: Float32Array,
    sampleRate: number,
  ) => Float32Array;
  /** The voice MiniMax no longer knows — the clone service re-clones. */
  readonly onVoiceMissing?: (voiceId: string) => void;
  /** A unit was billed — the service stamps `lastUsedAt`. */
  readonly onUsed?: (billedChars: number) => void;
  readonly log?: (line: string) => void;
  /** Per-unit deadline; past it the unit types unvoiced. */
  readonly requestTimeoutMs?: number;
  /** Requests in flight at once (the reveal looks 2–3 units ahead; MiniMax
   *  tiers meter requests per minute). */
  readonly maxInFlight?: number;
}

export interface MiniMaxSynthesizer extends SpeechSynthesizer {
  dispose(): void;
  status(): {
    readonly keySet: boolean;
    readonly voiceReady: boolean;
    readonly inFlight: number;
    readonly lastFailure: MiniMaxFailure | null;
    readonly missingVoice: string | null;
  };
}

const DEFAULT_TIMEOUT_MS = 15_000;

function toFloat(int16: Int16Array): Float32Array {
  const f = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i += 1) f[i] = (int16[i] ?? 0) / 32768;
  return f;
}

function toInt16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i += 1) {
    const v = Math.max(-1, Math.min(1, f32[i] ?? 0));
    out[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
  }
  return out;
}

export function createMiniMaxSynthesizer(
  opts: MiniMaxSynthesizerOpts,
): MiniMaxSynthesizer {
  const log = opts.log ?? ((l: string) => console.log(`[herta-minimax] ${l}`));
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxInFlight = Math.max(1, opts.maxInFlight ?? 2);
  let disposed = false;
  let inFlight = 0;
  let lastFailure: MiniMaxFailure | null = null;
  let missingVoice: string | null = null;
  const waiters: (() => void)[] = [];
  /** Controllers per utterance, so a veto/interrupt aborts its own requests. */
  const controllers = new Map<string, Set<AbortController>>();

  const currentVoice = (): MiniMaxVoiceRef | null => {
    const v = opts.voice();
    if (v === null) return null;
    if (missingVoice !== null && v.voiceId !== missingVoice)
      missingVoice = null;
    return v.voiceId === missingVoice ? null : v;
  };

  const acquire = (): Promise<void> => {
    if (inFlight < maxInFlight) {
      inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        inFlight += 1;
        resolve();
      });
    });
  };
  const release = (): void => {
    inFlight -= 1;
    const next = waiters.shift();
    if (next !== undefined) next();
  };

  const track = (utteranceId: string, ac: AbortController): (() => void) => {
    const set = controllers.get(utteranceId) ?? new Set<AbortController>();
    set.add(ac);
    controllers.set(utteranceId, set);
    return () => {
      set.delete(ac);
      if (set.size === 0) controllers.delete(utteranceId);
    };
  };

  return {
    available(): boolean {
      return (
        !disposed &&
        opts.enabled() &&
        opts.key() !== null &&
        currentVoice() !== null
      );
    },

    async synthesize(req: SynthesisRequest): Promise<SynthesizedAudio | null> {
      if (disposed) return null;
      const key = opts.key();
      const voice = currentVoice();
      if (key === null || voice === null) return null;
      const ac = new AbortController();
      const untrack = track(req.utteranceId, ac);
      await acquire();
      if (ac.signal.aborted || disposed) {
        release();
        untrack();
        return null;
      }
      const timer = setTimeout(() => {
        ac.abort(new DOMException("timeout", "AbortError"));
      }, timeoutMs);
      try {
        const out = await synthesizePcm(opts.fetch, voice.host, key, {
          voiceId: voice.voiceId,
          text: req.text,
          model: opts.model ?? MINIMAX_DEFAULT_MODEL,
          signal: ac.signal,
        });
        const wet =
          opts.applyEffect === undefined
            ? out.samples
            : toInt16(opts.applyEffect(toFloat(out.samples), out.sampleRate));
        lastFailure = null;
        opts.onUsed?.(out.billedChars);
        return {
          samples: wet,
          sampleRate: out.sampleRate,
          durationMs: (wet.length / out.sampleRate) * 1000,
        };
      } catch (err) {
        if (err instanceof MiniMaxError) {
          if (err.reason === "cancelled") return null;
          lastFailure = err.reason;
          if (err.reason === "voice_missing") {
            missingVoice = voice.voiceId;
            log(`voice ${voice.voiceId} is gone on the platform — re-clone`);
            opts.onVoiceMissing?.(voice.voiceId);
          } else {
            log(`unit ${req.seq} failed (${err.reason}): ${err.message}`);
          }
          return null;
        }
        lastFailure = "other";
        log(`unit ${req.seq} failed: ${errorMessage(err)}`);
        return null;
      } finally {
        clearTimeout(timer);
        release();
        untrack();
      }
    },

    cancel(utteranceId: string): void {
      const set = controllers.get(utteranceId);
      if (set === undefined) return;
      for (const ac of set)
        ac.abort(new DOMException("cancelled", "AbortError"));
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const set of controllers.values()) {
        for (const ac of set)
          ac.abort(new DOMException("disposed", "AbortError"));
      }
      controllers.clear();
    },

    status() {
      return {
        keySet: opts.key() !== null,
        voiceReady: currentVoice() !== null,
        inFlight,
        lastFailure,
        missingVoice,
      };
    },
  };
}
