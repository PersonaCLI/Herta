import { getVoiceVolume, isVoiceMuted } from "./voice-prefs.js";

/**
 * Gapless playback for Herta's synthesized speech (ADR 0042).
 *
 * The server hands the renderer one PCM buffer per sentence-sized unit, in
 * order, as each unit's reveal begins. Playing them with `<audio>` would put
 * a decode + start gap between every sentence, which reads as stuttering
 * speech; Web Audio lets each unit be SCHEDULED at the exact sample the
 * previous one ends, so a multi-sentence reply sounds like one utterance.
 *
 * The schedule cursor (`nextAt`) is the contract: a unit starts at
 * `max(now, nextAt)` — right away when the queue has drained (the server
 * paces units, so this is the normal case at the start of a reply), or
 * exactly at the previous unit's end when its audio is still playing (which
 * happens when synthesis ran ahead of the reveal). Either way audio never
 * overlaps itself and never leaves a hole mid-sentence.
 *
 * A stop FADES (ADR 0042 §7b, 2026-09-09): each unit rides its own gain
 * node, and `stopSpeech` ramps the live ones to silence over a short beat
 * before stopping them, instead of cutting the waveform mid-word — the
 * veto's "catching herself" still reads as an interruption, without the
 * click. A unit that starts during the fade is untouched by it.
 *
 * Best-effort like every other voice path: no Web Audio, a rejected resume,
 * a malformed buffer — all swallowed. Silence is an acceptable outcome; a
 * broken UI is not.
 */

/** How long a stop takes to reach silence. Short enough to stay a cut. */
export const FADE_OUT_MS = 120;

let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
/** Sources scheduled and not yet ended, each with its own gain — faded and
 *  stopped as a group on a cut. */
const live = new Map<AudioBufferSourceNode, GainNode>();
/** Context time the next unit should start at. */
let nextAt = 0;
/** The utterance the cursor belongs to; a different one resets the schedule. */
let currentUtterance: string | null = null;

const listeners = new Set<() => void>();
function notify(): void {
  for (const l of listeners) l();
}

/** True while scheduled speech audio is still playing. */
export function isSpeechPlaying(): boolean {
  return live.size > 0;
}

/** Subscribe to changes in {@link isSpeechPlaying}. */
export function subscribeSpeechPlaying(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function ensureContext(): { ctx: AudioContext; gain: GainNode } | null {
  if (ctx !== null && gain !== null) return { ctx, gain };
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (Ctor === undefined) return null;
    const c = new Ctor();
    const g = c.createGain();
    g.connect(c.destination);
    ctx = c;
    gain = g;
    return { ctx: c, gain: g };
  } catch {
    return null;
  }
}

/**
 * Schedule one synthesized unit. `utteranceId` groups the units of one
 * reply; a new id resets the schedule cursor so a fresh line never inherits
 * a stale one (which would delay it by the previous reply's tail).
 */
export function playSpeechUnit(unit: {
  readonly utteranceId: string;
  readonly samples: Int16Array;
  readonly sampleRate: number;
}): void {
  // Master mute (Settings → Voice) silences synthesized speech exactly as it
  // silences clips. The server keeps synthesizing — the toggle that stops
  // that work is Settings → Voice → real-time voice.
  if (isVoiceMuted()) return;
  if (unit.samples.length === 0 || !(unit.sampleRate > 0)) return;
  const audio = ensureContext();
  if (audio === null) return;
  try {
    if (audio.ctx.state === "suspended")
      void audio.ctx.resume().catch(() => {});
    audio.gain.gain.value = getVoiceVolume();
    const buffer = audio.ctx.createBuffer(
      1,
      unit.samples.length,
      unit.sampleRate,
    );
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < unit.samples.length; i += 1) {
      // Int16 → [-1, 1). 32768 (not 32767) so the negative rail is exact and
      // the conversion is the inverse of the worker's.
      channel[i] = (unit.samples[i] ?? 0) / 32768;
    }
    const src = audio.ctx.createBufferSource();
    src.buffer = buffer;
    // Per-unit gain: the fade on a cut ramps THIS node, so the master volume
    // stays what the slider says and a unit starting mid-fade plays whole.
    const unitGain = audio.ctx.createGain();
    unitGain.gain.value = 1;
    src.connect(unitGain);
    unitGain.connect(audio.gain);
    if (unit.utteranceId !== currentUtterance) {
      currentUtterance = unit.utteranceId;
      nextAt = 0;
    }
    const at = Math.max(audio.ctx.currentTime, nextAt);
    live.set(src, unitGain);
    notify();
    src.onended = (): void => {
      live.delete(src);
      try {
        unitGain.disconnect();
      } catch {
        // already gone
      }
      notify();
    };
    src.start(at);
    nextAt = at + buffer.duration;
  } catch {
    // ignore — best-effort playback
  }
}

/**
 * Stop synthesized speech, fading it out over {@link FADE_OUT_MS}. With an
 * `utteranceId`, only that utterance's audio (a stale stop for a reply
 * already superseded must not cut the new one); without, everything.
 * Idempotent. The units leave the live set at once — what is fading is no
 * longer "her speaking" — and are stopped when the ramp lands.
 */
export function stopSpeech(utteranceId?: string): void {
  if (utteranceId !== undefined && currentUtterance !== null) {
    if (utteranceId !== currentUtterance) return;
  }
  const c = ctx;
  for (const [src, unitGain] of live) {
    try {
      src.onended = null;
      if (c === null) {
        src.stop();
        continue;
      }
      const now = c.currentTime;
      const end = now + FADE_OUT_MS / 1000;
      unitGain.gain.cancelScheduledValues(now);
      unitGain.gain.setValueAtTime(unitGain.gain.value, now);
      unitGain.gain.linearRampToValueAtTime(0, end);
      src.stop(end + 0.01);
    } catch {
      try {
        src.stop();
      } catch {
        // already ended
      }
    }
  }
  live.clear();
  nextAt = 0;
  currentUtterance = null;
  notify();
}

/** Re-apply the master volume to audio already scheduled (the Settings
 *  slider drags live, like it does for clips). */
export function applySpeechVolume(): void {
  if (gain === null) return;
  try {
    gain.gain.value = getVoiceVolume();
  } catch {
    // ignore — best-effort
  }
}
