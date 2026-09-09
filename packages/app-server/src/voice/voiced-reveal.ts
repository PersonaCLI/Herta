import {
  NEWLINE_PAUSE_RATIO,
  nextRevealEnd,
  PAUSE_PUNCTUATION,
  type PacingMode,
  PUNCTUATION_PAUSE_RATIO,
} from "@herta/herta";
import type {
  SpeechSynthesizer,
  SynthesizedAudio,
  VoiceCueEvent,
} from "../types.js";
import {
  type SpeechLang,
  type SpeechUnit,
  segmentSpeechUnits,
} from "./speakable-text.js";

/**
 * The VOICED reveal (ADR 0042): Herta's speech typed in lockstep with her
 * synthesized voice, unit by unit.
 *
 * Same controller contract as the shared text reveal driver
 * (`createRevealDriver` in @herta/herta — pushToken / finishInput /
 * fastForward / flushTail / cancel, deferred begin, exactly-one finish), so
 * the actor turn loop cannot tell the two apart. What differs is the clock:
 * the text driver paces by a per-character cadence; this one paces by the
 * AUDIO. Each sentence-sized unit (`segmentSpeechUnits`) is synthesized the
 * moment it closes — while the model is still generating the rest — and when
 * its turn comes the unit's audio is emitted to the renderer and its
 * characters are revealed spread across that audio's duration, punctuation-
 * weighted like the text cadence. Units whose speakable form is empty (a
 * fenced block, a table row) land atomically after a short beat, the way
 * the text driver already lands fences.
 *
 * The supervisor hold maps onto units: with a verdict pending and input
 * finished, the LAST unit does not start until `fastForward` (OK) opens it —
 * earlier units play pre-verdict exactly as the live text reveal showed
 * them, and a veto (`cancel`) cuts the audio mid-sentence, which is the
 * "catching herself" beat the retract morph and veto clip already stage.
 * The front-load/ramp machinery of the text driver has no equivalent here:
 * synthesis latency IS the front delay, and an audio clip cannot ramp.
 *
 * Voice is never load-bearing for the record: a unit whose synthesis fails
 * or is cancelled types at the read-along cadence instead, `flushTail`
 * lands everything remaining in one emit (and stops the audio), and the
 * text emitted always equals the text the turn commits.
 */
export interface VoicedRevealDeps {
  readonly synth: SpeechSynthesizer;
  /** Identifies this stream's audio to the renderer and for cancellation. */
  readonly utteranceId: string;
  readonly lang: SpeechLang;
  /** Reveal granularity for the text (word for EN, code point for zh). */
  readonly mode: PacingMode;
  /** Per-code-point cadence for units that end up UNVOICED (synthesis
   *  failed/cancelled) — the sink's read-along base. */
  readonly fallbackBaseMs: number;
  /** Wall-clock ceiling on the whole voiced reveal, from the first emit;
   *  past it (input finished, verdict resolved) the tail lands in one emit
   *  and the audio stops. Bounds how long a pathological reply can hold
   *  the composer. */
  readonly maxUtteranceMs: number;
  /** Supervisor gate — present → the last unit holds until fastForward. */
  readonly verdictPending?: Promise<void>;
  /** How many units past the one playing are synthesized ahead. Default 2:
   *  enough to hide per-unit latency on a slow CPU, little enough that a
   *  veto wastes at most a couple of sentences of work. */
  readonly lookahead?: number;
  /** One voice at a time: the first unit waits for this to settle (the
   *  previous voiced stream's `done`, swallowed) — a beat still sounding
   *  must finish before the next line starts, or two of her would speak at
   *  once. Synthesis is NOT deferred, only the start. */
  readonly startAfter?: Promise<void>;
  /** The sentences the VETOED stream fully played, by position (ADR 0042
   *  §7b): a unit of this stream that closes identical to the one at the
   *  same index is revealed at once and not spoken again — the listener
   *  already heard it and the screen already shows it. The first unit that
   *  differs, or the one the veto cut, is spoken whole from its start. */
  readonly alreadySpoken?: readonly string[];
  emitRange(text: string, start: number, end: number): void;
  onBegin(): void;
  onFinish(begun: boolean): void;
  emitVoice(ev: VoiceCueEvent): void;
}

export interface VoicedReveal {
  readonly done: Promise<void>;
  readonly cursor: number;
  pushToken(text: string): void;
  finishInput(): void;
  fastForward(): Promise<void>;
  flushTail(): void;
  cancel(): boolean;
  /** The units that played to their end, in order — what a retry after a
   *  veto may skip (`alreadySpoken`). The unit the cut landed in is not
   *  among them. */
  spokenUnits(): string[];
  /** The start of the sentence `cp` falls in — where a retract floor snaps
   *  to when the retry will speak that sentence whole. Past every closed
   *  unit, the open tail's start; with no unit yet, 0. */
  unitStartAtOrBefore(cp: number): number;
}

/** The beat a silent unit (code block, table row) holds before the next
 *  unit's audio — "she pastes, then goes on". */
export const SILENT_UNIT_MS = 400;

/**
 * Liveness cap on the pre-roll — NOT a latency knob.
 *
 * Why there is a pre-roll at all: the worker synthesizes one unit at a time,
 * so unit 1 cannot start until unit 0 finishes. When unit 0 is short and unit
 * 1 is long — "行。" then a full sentence, which is exactly how she opens —
 * unit 0's second of audio runs out long before unit 1's is ready and the
 * reply stops dead mid-thought (the voice lab measured 2.4 s of silence on
 * that shape; the live run measured 5.6 s). Waiting for unit 1 before
 * starting unit 0 moves that cost to the FRONT, where it is nearly free: the
 * lead-in sits under the supervisor wait and the in-flight hint, which the
 * paced reveal already spends.
 *
 * The pre-roll normally ends the moment unit 1's audio arrives, so this cap
 * only ever bites when synthesis is unusually slow — and a value tuned as a
 * latency budget (2.5 s at first) simply reintroduced the gap it exists to
 * remove. It is set instead to "long enough that a healthy machine never
 * reaches it", leaving it to do its real job: stopping a stuck or failed
 * second unit from holding speech forever.
 *
 * Since sentences can be silent (a Latin fragment, a fence), the pre-roll
 * waits for the first two VOICED units inside the synthesis window rather
 * than for "unit 1": a silent unit is ready at once and covers nothing.
 */
export const PREROLL_MAX_MS = 8000;

type UnitState =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly audio: SynthesizedAudio }
  | { readonly status: "failed" }
  | { readonly status: "silent" }
  /** Heard already (the vetoed stream played it): revealed at once. */
  | { readonly status: "spoken" };

/** Per-character reveal weight: the same pause vocabulary the text cadence
 *  uses, so a unit's characters spread over its audio the way a listener
 *  hears them — a breath after 。，and a longer one at a newline. */
function charWeight(ch: string): number {
  if (ch === "\n") return 1 + NEWLINE_PAUSE_RATIO;
  if (PAUSE_PUNCTUATION.has(ch)) return 1 + PUNCTUATION_PAUSE_RATIO;
  return 1;
}

export function createVoicedReveal(deps: VoicedRevealDeps): VoicedReveal {
  const lookahead = deps.lookahead ?? 2;
  const chars: string[] = [];
  let inputFinished = false;
  let cursor = 0;
  let cancelled = false;
  let finished = false;
  let begun = false;
  let fastForwarding = false;
  let verdictResolved = deps.verdictPending === undefined;
  let firstEmitAtMs: number | null = null;
  let laneOpen = deps.startAfter === undefined;
  deps.startAfter?.then(
    () => {
      laneOpen = true;
      tryAdvance();
    },
    () => {
      laneOpen = true;
      tryAdvance();
    },
  );

  let units: SpeechUnit[] = [];
  const states = new Map<number, UnitState>();
  let playIdx = 0;
  /** The unit currently revealing, with its timers. */
  let active: {
    idx: number;
    timers: Set<ReturnType<typeof setTimeout>>;
  } | null = null;
  /** Pre-roll state (see PREROLL_MAX_MS): armed once, at the stream's head. */
  let prerollTimer: ReturnType<typeof setTimeout> | null = null;
  let prerollExpired = false;

  let resolveDone!: () => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<void>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  done.catch(() => undefined);

  deps.verdictPending
    ?.then(() => {
      verdictResolved = true;
      firstEmitAtMs = null;
    })
    .catch(() => {
      verdictResolved = true;
      firstEmitAtMs = null;
    });

  const ensureBegin = (): void => {
    if (!begun) {
      begun = true;
      deps.onBegin();
    }
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    deps.onFinish(begun);
    resolveDone();
  };

  const emit = (start: number, end: number): void => {
    if (end <= start) return;
    if (firstEmitAtMs === null) firstEmitAtMs = Date.now();
    ensureBegin();
    deps.emitRange(chars.slice(start, end).join(""), start, end);
    cursor = end;
  };

  const clearActive = (): void => {
    if (prerollTimer !== null) {
      clearTimeout(prerollTimer);
      prerollTimer = null;
    }
    if (active === null) return;
    for (const t of active.timers) clearTimeout(t);
    active = null;
  };

  const rawOf = (unit: SpeechUnit): string =>
    chars.slice(unit.start, unit.end).join("");

  const resegment = (): void => {
    const fresh = segmentSpeechUnits(chars, inputFinished, deps.lang);
    // Prefix-stable by construction; only APPENDED units are new.
    units = fresh;
    requestSynthesis();
  };

  const requestSynthesis = (): void => {
    const upto = Math.min(units.length, playIdx + 1 + lookahead);
    for (let idx = playIdx; idx < upto; idx += 1) {
      if (states.has(idx)) continue;
      const unit = units[idx];
      if (unit === undefined) continue;
      // Already heard from the vetoed stream, same sentence at the same
      // position: nothing to synthesize, nothing to wait for.
      if (
        deps.alreadySpoken !== undefined &&
        idx < deps.alreadySpoken.length &&
        rawOf(unit) === deps.alreadySpoken[idx]
      ) {
        states.set(idx, { status: "spoken" });
        continue;
      }
      if (unit.speak.length === 0) {
        states.set(idx, { status: "silent" });
        continue;
      }
      states.set(idx, { status: "pending" });
      deps.synth
        .synthesize({
          utteranceId: deps.utteranceId,
          seq: idx,
          text: unit.speak,
          lang: deps.lang,
        })
        .then(
          (audio) => {
            if (cancelled || finished) return;
            states.set(
              idx,
              audio !== null && audio.durationMs > 0
                ? { status: "ready", audio }
                : { status: "failed" },
            );
            tryAdvance();
          },
          () => {
            if (cancelled || finished) return;
            states.set(idx, { status: "failed" });
            tryAdvance();
          },
        );
    }
  };

  /**
   * Reveal `unit`'s characters spread over `durationMs` from now: each
   * reveal step (a code point, or an EN word) lands at the cumulative
   * punctuation-weighted fraction of the span. Absolute targets, so timer
   * drift never accumulates across a long unit.
   */
  const scheduleReveal = (
    unit: SpeechUnit,
    durationMs: number,
    timers: Set<ReturnType<typeof setTimeout>>,
    onEnd: () => void,
  ): void => {
    const startAt = Date.now();
    // Reveal steps over [cursor, unit.end).
    const steps: { end: number; at: number }[] = [];
    let total = 0;
    for (let i = cursor; i < unit.end; i += 1)
      total += charWeight(chars[i] ?? "");
    let acc = 0;
    let pos = cursor;
    while (pos < unit.end) {
      const stepEnd = Math.min(unit.end, nextRevealEnd(chars, pos, deps.mode));
      const safeEnd = stepEnd > pos ? stepEnd : pos + 1;
      for (let i = pos; i < safeEnd; i += 1) acc += charWeight(chars[i] ?? "");
      steps.push({
        end: safeEnd,
        at: startAt + (total > 0 ? (durationMs * acc) / total : 0),
      });
      pos = safeEnd;
    }
    let k = 0;
    const tick = (): void => {
      const step = steps[k];
      if (step === undefined) return;
      const t = setTimeout(
        () => {
          timers.delete(t);
          if (cancelled || finished) return;
          emit(cursor, step.end);
          k += 1;
          tick();
        },
        Math.max(0, step.at - Date.now()),
      );
      timers.add(t);
    };
    tick();
    const endTimer = setTimeout(
      () => {
        timers.delete(endTimer);
        if (cancelled || finished) return;
        // Belt and braces: every character of the unit is out before we
        // move on (a late step timer cannot leave a hole).
        if (cursor < unit.end) emit(cursor, unit.end);
        onEnd();
      },
      Math.max(0, startAt + durationMs - Date.now()),
    );
    timers.add(endTimer);
  };

  const startUnit = (idx: number, unit: SpeechUnit, st: UnitState): void => {
    // A unit STARTING is where the stream has visibly/audibly begun — mark it
    // before the first emit so onBegin fires with the audio, not the first
    // character (a supervised unit's audio and first char coincide anyway).
    ensureBegin();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    active = { idx, timers };
    // Whitespace between units belongs to nobody; land it with the unit.
    if (cursor < unit.start) emit(cursor, unit.start);
    const onEnd = (): void => {
      clearActive();
      playIdx = idx + 1;
      requestSynthesis();
      tryAdvance();
    };
    if (st.status === "spoken") {
      // On screen and in the ear already: land it and move on, no beat.
      emit(cursor, unit.end);
      onEnd();
      return;
    }
    if (st.status === "silent") {
      emit(cursor, unit.end);
      const t = setTimeout(() => {
        timers.delete(t);
        if (cancelled || finished) return;
        onEnd();
      }, SILENT_UNIT_MS);
      timers.add(t);
      return;
    }
    if (st.status === "ready") {
      deps.emitVoice({
        kind: "tts",
        utteranceId: deps.utteranceId,
        seq: idx,
        samples: st.audio.samples,
        sampleRate: st.audio.sampleRate,
        durationMs: st.audio.durationMs,
      });
      scheduleReveal(unit, st.audio.durationMs, timers, onEnd);
      return;
    }
    // failed → unvoiced, at the read-along cadence.
    let weight = 0;
    for (let i = cursor; i < unit.end; i += 1)
      weight += charWeight(chars[i] ?? "");
    scheduleReveal(unit, weight * deps.fallbackBaseMs, timers, onEnd);
  };

  const tryAdvance = (): void => {
    if (cancelled || finished || active !== null || !laneOpen) return;
    if (playIdx >= units.length) {
      if (inputFinished) {
        if (cursor < chars.length) emit(cursor, chars.length);
        finish();
      }
      return;
    }
    const unit = units[playIdx];
    if (unit === undefined) return;
    // The supervisor hold, at unit granularity: the last unit waits for the
    // verdict's terminal call. Earlier units play; a veto cuts them off.
    const isLast = inputFinished && playIdx === units.length - 1;
    if (isLast && deps.verdictPending !== undefined && !fastForwarding) {
      return;
    }
    // Reveal ceiling (same placement as the text driver: behind the hold).
    if (
      firstEmitAtMs !== null &&
      inputFinished &&
      verdictResolved &&
      Date.now() - firstEmitAtMs > deps.maxUtteranceMs
    ) {
      flushTail();
      return;
    }
    let st = states.get(playIdx);
    if (st === undefined) {
      requestSynthesis();
      st = states.get(playIdx);
    }
    if (st === undefined || st.status === "pending") return; // audio not ready
    // Pre-roll (see PREROLL_MAX_MS): before the FIRST unit starts, give the
    // head of the stream a bounded chance to be ready, so a short opener
    // does not strand the reply in silence while the next sentence
    // synthesizes. "Ready" means the first two VOICED units inside the
    // synthesis window: a silent unit (a fence, a Latin sentence — since
    // 2026-09-06 whole sentences can be silent) lands in a beat and gives
    // no cover, so counting it as the second unit re-created the stall the
    // pre-roll exists to remove (voice lab: 2.9 s after 哼。 + a silent line).
    if (playIdx === 0 && !fastForwarding && !prerollExpired) {
      const windowEnd = Math.min(units.length, 1 + lookahead);
      const head: number[] = [];
      for (let idx = 0; idx < windowEnd && head.length < 2; idx += 1) {
        if ((units[idx]?.speak.length ?? 0) > 0) head.push(idx);
      }
      const headSettled = head.every((idx) => {
        const s = states.get(idx);
        return s !== undefined && s.status !== "pending";
      });
      // Nothing more to wait for: two voiced units in hand, or no second
      // voiced unit can still enter the window (input finished, or the
      // window already holds its full complement of units — an open stream
      // with room left may still deliver one, so it waits, up to the cap).
      const enough =
        head.length >= 2 || inputFinished || units.length >= 1 + lookahead;
      if (!(headSettled && enough)) {
        if (prerollTimer === null) {
          prerollTimer = setTimeout(() => {
            prerollTimer = null;
            prerollExpired = true;
            tryAdvance();
          }, PREROLL_MAX_MS);
        }
        return;
      }
    }
    if (prerollTimer !== null) {
      clearTimeout(prerollTimer);
      prerollTimer = null;
    }
    prerollExpired = true; // one pre-roll per stream, at its head
    startUnit(playIdx, unit, st);
  };

  const flushTail = (): void => {
    if (cancelled || finished) return;
    clearActive();
    inputFinished = true;
    if (cursor < chars.length) emit(cursor, chars.length);
    deps.emitVoice({ kind: "ttsStop", utteranceId: deps.utteranceId });
    deps.synth.cancel(deps.utteranceId);
    finish();
  };

  return {
    done,
    get cursor(): number {
      return cursor;
    },
    pushToken: (text: string): void => {
      if (cancelled || inputFinished) return;
      for (const ch of text) chars.push(ch);
      resegment();
      tryAdvance();
    },
    finishInput: (): void => {
      if (cancelled || finished) return;
      inputFinished = true;
      if (chars.length === 0) {
        finish();
        return;
      }
      resegment();
      tryAdvance();
    },
    fastForward: async (): Promise<void> => {
      if (cancelled) return;
      fastForwarding = true;
      tryAdvance();
      await done;
    },
    flushTail,
    cancel: (): boolean => {
      if (cancelled) return false;
      clearActive();
      cancelled = true;
      deps.emitVoice({ kind: "ttsStop", utteranceId: deps.utteranceId });
      deps.synth.cancel(deps.utteranceId);
      rejectDone(new Error("slow-stream cancelled"));
      return true;
    },
    spokenUnits: (): string[] => units.slice(0, playIdx).map(rawOf),
    unitStartAtOrBefore: (cp: number): number => {
      let start = 0;
      for (const u of units) {
        if (u.end <= cp) {
          start = u.end;
          continue;
        }
        if (u.start <= cp) start = u.start;
        break;
      }
      return start;
    },
  };
}
