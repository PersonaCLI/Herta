import { join } from "node:path";
import {
  type OpeningChoice,
  type PromptLang,
  spanMatchedBaseMs,
} from "@herta/herta";
import { SLOW_MS_PER_CHAR } from "./bus-streaming-sink.js";
import type {
  SpeechSynthesizer,
  SynthesizedAudio,
  VoiceCueEvent,
} from "./types.js";
import { loadClipStems, pickClipStem } from "./voice/clip-list.js";
import { readOpusDurationMs } from "./voice/opus-duration.js";
import {
  loadParticleCatalog,
  matchLeadingParticle,
  pickParticleClip,
} from "./voice/particle-catalog.js";
import { pickVetoReaction, type VetoReaction } from "./voice/veto-reaction.js";

/**
 * The session's voice cues (extracted from session.ts, 2026-09-03): the
 * opening clip and its clip-matched reveal cadence, the particle cue at a
 * turn's first speech, the diversified veto reaction, and the easter egg on
 * a 板砖-card lift — with the clip catalogs they read once and the
 * session-scoped state that keeps consecutive plays from repeating.
 *
 * Every read is best-effort: a missing directory means that cue never
 * fires. No EN voice in v1 (ADR 0013 §5): every cue is suppressed for a
 * non-zh interaction session — no EN wavs exist, and the clips that DO exist
 * are all Chinese. The opening is gated by an absent voiceClipId (the picker
 * pairs no clip with an EN opening); the other three are gated on the
 * language here (adversarial review 2026-07-15 found veto + easter-egg
 * firing Chinese audio in EN sessions).
 *
 * One voice (ADR 0042 amendment 2026-09-08, owner): with the real-time
 * voice on, everything she says comes from the synthesizer — the opening
 * is voiced by the sink like a reply (the session says so through
 * `onOpeningStreamStart(voiced)`), the easter-egg line is synthesized from
 * its text (the clip's filename stem IS the line), and the particle cue is
 * withheld because the synthesized first unit already carries the
 * interjection — a recorded clip would cut that unit off (the renderer
 * plays one voice at a time, newest wins).
 *
 * The veto reaction, too (§7b, 2026-09-09): the "catching herself" line is
 * synthesized from the recording's own text (the veto clips are named by
 * their lines, the sighs by their token), so the beat is in the same voice
 * as the reply it interrupts. It is ARMED when the supervised voiced reply
 * begins — rolled and synthesized then, so a veto never waits on synthesis
 * and the request queues behind the reply's first units rather than ahead
 * of them — and thrown away if she does not need it. At the veto: stop
 * everything (the renderer fades), the filler, and a hold on the voice
 * lane for its length so the retry's first sentence waits. A filler still
 * synthesizing plays when it lands, within a bound; past it, or on a
 * failed synthesis, the recording.
 */

/** Easter-egg voice throttle: ≤1 play per session per hour. */
export const EASTER_EGG_COOLDOWN_MS = 60 * 60 * 1000;

/** Breath after the veto filler before the retry's first sentence. */
export const VETO_FILLER_TAIL_MS = 150;
/** How long a veto waits for a filler still being synthesized. */
export const VETO_FILLER_WAIT_MS = 1500;

/** The reaction rolled and synthesized ahead of a possible veto. */
interface ArmedReaction {
  readonly reaction: VetoReaction;
  readonly utteranceId: string;
  readonly audio: Promise<SynthesizedAudio | null>;
  /** undefined while synthesizing; the answer once it landed. */
  ready: SynthesizedAudio | null | undefined;
}

export interface SessionVoiceOpts {
  /** Voice-clip root (openings/, particle/, veto/, easter_egg/). Config-driven
   *  since 2026-07-06 so a PACKAGED app can point it at its bundled resources
   *  copy; the fallback is the dev layout under the workspace. */
  readonly voiceAssetsDir: string;
  readonly lang: PromptLang;
  /** The session's opening, when it has one (the seed itself came from the
   *  actor stack; the voice pairs the clip and the clip-matched cadence). */
  readonly opening: OpeningChoice | undefined;
  /** Where a cue goes (the session's projector). */
  readonly emit: (cue: VoiceCueEvent) => void;
  /** The host's synthesizer when the session has one (zh only): asked per
   *  cue whether it is available, and given the easter-egg line to speak. */
  readonly synth?: SpeechSynthesizer;
  /** Inject the opening clip's duration (ms) instead of reading the clip from
   *  disk (clip-matched cadence tests). Skips `readOpusDurationMs`. */
  readonly openingDurationMs?: number | null;
  /** Random source for picking a particle clip variant. Defaults to
   *  `Math.random`; tests inject a deterministic source. */
  readonly particleRandom?: () => number;
  /** Random source for the veto-reaction roll (case selection + clip pick). */
  readonly vetoRandom?: () => number;
  /** Random source for the easter-egg 50% roll + clip pick. */
  readonly easterEggRandom?: () => number;
  /** Clock (ms) for the easter-egg per-session hourly throttle. Defaults to
   *  `Date.now`; tests inject a controllable clock. */
  readonly easterEggNow?: () => number;
}

export interface SessionVoice {
  /** The opening's clipId (its filename stem, e.g. "004-late-night-audit"),
   *  or null when there's no opening / no voice. */
  readonly openingClipId: string | null;
  /** Per-char base cadence (ms) for the opening reveal, matched to the voice
   *  clip's duration so the text spans ≈ the audio (SPEC 2026-06-23).
   *  undefined → the sink's read-along default (no clip, or duration
   *  unreadable). */
  readonly openingBaseMs: number | undefined;
  /** The instant the opening's text begins streaming (after the lead beat):
   *  cue the opening clip so voice and reveal land together. No clipId → no
   *  cue; a skip BEFORE stream start never reaches here. `voiced`: the sink
   *  is speaking the opening through the synthesizer — no clip. */
  onOpeningStreamStart(voiced?: boolean): void;
  /** The actor fires this at the FIRST speech of each turn (not retries,
   *  beats, or regenerate): match the leading particle and cue a random
   *  variant on the same voice channel the opening uses. */
  onPrimarySpeechStart(text: string): void;
  /** A supervised VOICED reply has its first unit in flight (the sink's
   *  hook): roll the veto reaction now and synthesize it at low priority,
   *  so a veto has it in hand and the reply's units are never behind it.
   *  No-op without the synthesizer. */
  armVetoReaction(): void;
  /** The turn ended without a veto: drop the armed reaction. */
  disarmVetoReaction(): void;
  /** The rejection moment (see pickVetoReaction). Returns how long the
   *  voice lane should hold for the reaction's audio — 0 for a recorded
   *  clip or silence, which the lane need not wait for. */
  onSupervisorVeto(): number;
  /** GUI easter egg (SPEC 2026-06-23): called per successful 板砖-card lift.
   *  Rolls a 50% chance, throttled to ≤1 play per session per hour. No-op
   *  without clips or within the cooldown. */
  maybePlayEasterEgg(): void;
}

/** Read the clip catalogs once and build the session's cues. */
export async function loadSessionVoice(
  opts: SessionVoiceOpts,
): Promise<SessionVoice> {
  const { voiceAssetsDir, opening, emit } = opts;

  // The opening's voice clipId = its filename stem (the .opus shares the stem),
  // captured for the `voice` cue emitted when playOpening streams the seed.
  // The pairing comes from the picker (slice 4): zh openings carry their
  // filename stem; EN openings carry NO clip (no EN clips in v1) — never
  // derive a clip id from `sourceFile` here, or an EN seed would pair with
  // a CN clip.
  const openingClipId: string | null = opening?.voiceClipId ?? null;
  // Matched per-char cadence so the seed reveal spans ≈ the clip's audio
  // (SPEC 2026-06-23). undefined when there's no clip / the clip is unreadable.
  let openingBaseMs: number | undefined;
  if (opening !== undefined) {
    // Match the text-stream cadence to the voice clip's duration. The clip
    // lives at <voiceAssetsDir>/openings/<clipId>.opus (mirrors the GUI's
    // voice-path resolution; Ogg/Opus since the 2026-07-16 cutover).
    // Best-effort: an unreadable / absent clip — or no clip at all (EN
    // opening) — leaves openingBaseMs undefined → the sink's read-along
    // default.
    const durationMs =
      opts.openingDurationMs ??
      (openingClipId !== null
        ? await readOpusDurationMs(
            join(voiceAssetsDir, "openings", `${openingClipId}.opus`),
          )
        : null);
    // `durationMs` is number | null (the `??` collapses the seam's undefined).
    if (durationMs !== null) {
      openingBaseMs = spanMatchedBaseMs({
        text: opening.seedText,
        targetMs: durationMs,
        fallbackMs: SLOW_MS_PER_CHAR,
      });
    }
  }

  // Particle voice catalog (SPEC 2026-06-23): leading-interjection tokens +
  // their variant clips, read once. Best-effort — a missing dir yields an
  // empty catalog so particles simply never fire. Loaded for every session
  // (particles fire on normal turns, not just new sessions).
  const particleCatalog = await loadParticleCatalog(
    join(voiceAssetsDir, "particle"),
  );
  const particleRandom = opts.particleRandom ?? Math.random;
  // Veto voice clips (SPEC 2026-06-23): full "catching-herself" lines played
  // when the supervisor rejects the candidate speech. Best-effort — missing
  // dir → empty → never fires.
  const vetoClips = await loadClipStems(join(voiceAssetsDir, "veto"));
  const vetoRandom = opts.vetoRandom ?? Math.random;
  // Track the last veto clip so two consecutive rejections never play the same
  // wav — across retries within a turn AND across turns. Session-scoped via
  // this closure (the onSupervisorVeto callback below is built once per
  // session). Resets only when a new session is created.
  let lastVetoClip: string | null = null;
  // Same idea for the sigh case (its `<category>/<clipId>` key): two
  // consecutive sigh rolls never repeat the same wav when an alternative
  // exists. Session-scoped, like lastVetoClip.
  let lastSighClip: string | null = null;
  // The particle token cued at this turn's first speech (null = the speech
  // didn't lead with one). Feeds the veto reaction's sigh-eligibility check.
  // onPrimarySpeechStart fires on EVERY non-empty speech turn and both actor
  // fire sites precede the supervisor check, so this is always fresh by the
  // time a veto can fire — it self-resets each turn with no boundary hook.
  let particleTokenThisTurn: string | null = null;
  const voiceCuesEnabled = opts.lang === "zh";
  // Easter-egg voice clips (SPEC 2026-06-23): played on a successful 板砖-card
  // lift. Best-effort — missing dir → empty → never fires. Empty for non-zh.
  const easterEggClips = voiceCuesEnabled
    ? await loadClipStems(join(voiceAssetsDir, "easter_egg"))
    : [];
  const easterEggRandom = opts.easterEggRandom ?? Math.random;
  const easterEggNow = opts.easterEggNow ?? Date.now;
  // Wall-clock (ms) of the last easter-egg play, or null. Per-session: a new
  // session starts eligible. Enforces ≤1 play per hour.
  let lastEasterEggAt: number | null = null;

  const synth = opts.synth;
  const synthAvailable = (): boolean =>
    voiceCuesEnabled && (synth?.available() ?? false);
  let eggSeq = 0;
  let armed: ArmedReaction | null = null;
  let fillerSeq = 0;
  const rollVeto = (): VetoReaction =>
    pickVetoReaction({
      vetoClips,
      lastVetoClip,
      lastSighClip,
      particleCatalog,
      particleTokenThisTurn,
      random: vetoRandom,
    });
  /** Remember what played, for the consecutive-repeat avoidance. */
  const notePlayed = (r: VetoReaction): void => {
    if (r.kind !== "cue") return;
    if (r.fromVetoFolder) lastVetoClip = r.clipId;
    else lastSighClip = `${r.category}/${r.clipId}`;
  };

  return {
    openingClipId,
    openingBaseMs,
    onOpeningStreamStart(voiced = false): void {
      if (voiced) return; // the sink speaks it (ADR 0042 amendment)
      if (openingClipId !== null) {
        emit({ kind: "cue", category: "openings", clipId: openingClipId });
      }
    },
    onPrimarySpeechStart(text: string): void {
      if (!voiceCuesEnabled) return; // no EN voice in v1 (ADR 0013 §5)
      const token = matchLeadingParticle(text, particleCatalog);
      // Recorded either way: the veto roll's sigh eligibility reads it.
      particleTokenThisTurn = token;
      // The synthesized reply already speaks its leading interjection; a
      // clip on top would cut the first unit's audio (newest wins).
      if (synthAvailable()) return;
      if (token === null) return;
      const clip = pickParticleClip(particleCatalog, token, particleRandom);
      if (clip !== null) {
        emit({ kind: "cue", category: clip.category, clipId: clip.clipId });
      }
    },
    armVetoReaction(): void {
      if (!synthAvailable() || synth === undefined) return;
      const reaction = rollVeto();
      fillerSeq += 1;
      const utteranceId = `veto${fillerSeq}`;
      if (reaction.kind === "silence") {
        armed = {
          reaction,
          utteranceId,
          audio: Promise.resolve(null),
          ready: null,
        };
        return;
      }
      // The recording's own words: a veto clip is named by its line, a sigh
      // by its token — trailing off.
      const text = reaction.fromVetoFolder
        ? reaction.clipId
        : `${reaction.category.slice("particle/".length)}……`;
      const entry: ArmedReaction = {
        reaction,
        utteranceId,
        audio: synth
          .synthesize({
            utteranceId,
            seq: 0,
            text,
            lang: "zh",
            priority: "low",
          })
          .catch(() => null),
        ready: undefined,
      };
      void entry.audio.then((audio) => {
        entry.ready = audio;
      });
      armed = entry;
    },
    disarmVetoReaction(): void {
      const a = armed;
      armed = null;
      // Queued and not yet synthesized: nothing to keep the worker on.
      if (a !== null && a.ready === undefined && synth !== undefined) {
        synth.cancel(a.utteranceId);
      }
    },
    // Veto voice, diversified (user 2026-07-11): the rejection moment rolls
    // one of three reactions instead of always a full "catching-herself"
    // line — a veto/ clip (with the same consecutive repeat avoidance), a
    // short sigh from particle/唉 · particle/哎 (only when this turn's
    // speech didn't already cue a sigh-family particle), or silence (the
    // retract morph alone carries the beat). See pickVetoReaction.
    onSupervisorVeto(): number {
      if (!voiceCuesEnabled) return 0; // no EN voice in v1 (ADR 0013 §5)
      const a = armed;
      armed = null;
      if (a !== null && synthAvailable()) {
        const r = a.reaction;
        if (r.kind === "silence") return 0;
        notePlayed(r);
        const recording = (): void =>
          emit({ kind: "cue", category: r.category, clipId: r.clipId });
        const play = (audio: SynthesizedAudio | null): number => {
          if (audio === null || audio.durationMs <= 0) {
            recording();
            return 0;
          }
          emit({ kind: "ttsStop" });
          emit({
            kind: "tts",
            utteranceId: a.utteranceId,
            seq: 0,
            samples: audio.samples,
            sampleRate: audio.sampleRate,
            durationMs: audio.durationMs,
          });
          return audio.durationMs + VETO_FILLER_TAIL_MS;
        };
        if (a.ready !== undefined) return play(a.ready);
        // A veto faster than the synthesis: play the filler when it lands,
        // within a bound; past it, the recording.
        let settled = false;
        const bound = setTimeout(() => {
          if (settled) return;
          settled = true;
          recording();
        }, VETO_FILLER_WAIT_MS);
        void a.audio.then((audio) => {
          if (settled) return;
          settled = true;
          clearTimeout(bound);
          play(audio);
        });
        return VETO_FILLER_WAIT_MS + VETO_FILLER_TAIL_MS;
      }
      // No synthesizer: the recorded reaction, rolled now, as before.
      const reaction = rollVeto();
      if (reaction.kind === "silence") return 0;
      notePlayed(reaction);
      emit({
        kind: "cue",
        category: reaction.category,
        clipId: reaction.clipId,
      });
      return 0;
    },
    maybePlayEasterEgg(): void {
      if (easterEggClips.length === 0) return;
      const now = easterEggNow();
      if (
        lastEasterEggAt !== null &&
        now - lastEasterEggAt < EASTER_EGG_COOLDOWN_MS
      ) {
        return; // within the per-session hourly cooldown
      }
      if (easterEggRandom() >= 0.5) return; // 50% gate (cooldown not consumed)
      const clipId = pickClipStem(easterEggClips, easterEggRandom);
      if (clipId === null) return;
      lastEasterEggAt = now;
      // With the real-time voice on, the line is synthesized from its text
      // — the clip's stem is the line itself — so it sounds like the rest
      // of her. Newest wins, like a clip: everything else stops first. A
      // synthesis that fails falls back to the recording.
      if (synthAvailable() && synth !== undefined) {
        eggSeq += 1;
        const utteranceId = `egg${eggSeq}`;
        void synth
          .synthesize({ utteranceId, seq: 0, text: clipId, lang: "zh" })
          .then(
            (audio) => {
              if (audio === null || audio.durationMs <= 0) {
                emit({ kind: "cue", category: "easter_egg", clipId });
                return;
              }
              emit({ kind: "ttsStop" });
              emit({
                kind: "tts",
                utteranceId,
                seq: 0,
                samples: audio.samples,
                sampleRate: audio.sampleRate,
                durationMs: audio.durationMs,
              });
            },
            () => emit({ kind: "cue", category: "easter_egg", clipId }),
          );
        return;
      }
      emit({ kind: "cue", category: "easter_egg", clipId });
    },
  };
}
