import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  type EventBus,
  publishWithLayer,
  type TerminalRecord,
  type TerminalRecordBlock,
} from "@herta/core";
import {
  type ActorStreamingSink,
  createRevealDriver,
  type LiveSlowStreamController,
  type PacingMode,
  type PromptLang,
  resolveMaxRevealMs,
  type SlowStreamController,
} from "@herta/herta";
import { recordTail } from "./record-window.js";
import type {
  RecordEvent,
  SpeechControlEvent,
  SpeechSynthesizer,
  VoiceCueEvent,
} from "./types.js";
import {
  createVoicedReveal,
  type VoicedReveal,
} from "./voice/voiced-reveal.js";

/**
 * Wall-clock ceiling on one VOICED reveal (ADR 0042), from its first emit.
 * Speech runs ~5 zh chars/s, so a 600-char reply is two minutes of audio;
 * past this the tail lands in one emit and the audio stops, bounding how
 * long a pathological completion can keep the composer locked. Normal
 * replies (p90 ≈ 220 chars, ≈ 45 s) never touch it.
 */
export const MAX_VOICED_MS = 150_000;

/** The reveal driver surface both the text driver (`createRevealDriver`)
 *  and the voiced one (`createVoicedReveal`) share — the sink wraps either
 *  in the same controller. */
interface RevealLike {
  readonly done: Promise<void>;
  readonly cursor: number;
  pushToken(text: string): void;
  finishInput(): void;
  fastForward(): Promise<void>;
  flushTail(): void;
  cancel(): boolean;
}

/** Base per-character cadence of Herta's paced speech (~12.5 chars/s — a read-along pace; user-tuned 2026-06-11, was 28ms). */
export const SLOW_MS_PER_CHAR = 80;

/**
 * ActorStreamingSink that forwards live Herta SPEECH tokens onto the bus as
 * actor-layer assistant.delta events (the GUI accumulates them into the
 * streaming bubble). Thought-surface tokens are dropped (hidden per D6/D7).
 * slowStreamSpeech paces emission for supervised turns and, on a veto,
 * emits one session:speech retract via the injected emitSpeech callback
 * and resolves immediately — the renderer owns the retract animation and
 * buffers any retry deltas that race it.
 */
export class BusActorStreamingSink implements ActorStreamingSink {
  private surface: "speech" | "thought" | null = null;
  /**
   * Monotonic count of record blocks already projected to record
   * subscribers. flushBlocks emits only blocks at indices >= this cursor,
   * then advances it — so each appended block streams exactly once, in
   * canonical order, mirroring the CLI's NarrativeRenderer.update. The
   * record is append-only within and across turns, so the cursor never
   * needs to rewind. Seeded by seedEmittedCount for resumed / opening-seed
   * sessions whose pre-existing blocks reached the GUI via the onReset
   * snapshot rather than the stream.
   */
  private emittedCount = 0;

  /**
   * Live mirror of every block this sink has projected (the `at`-stamped
   * emitted copies), in canonical order. Invariant: `mirror.length ===
   * emittedCount` whenever the seed carried its record (see
   * `seedEmittedCount`). Exists for `resyncRecord`: unlike SessionImpl's
   * `_record` (refreshed only at turn boundaries — STALE mid-turn), this
   * tracks the record as of the last flush, which is exactly when a
   * record-channel overflow drop can occur. Holds references, not copies.
   */
  private mirror: TerminalRecordBlock[] = [];

  /**
   * Optional persistence hook (D1). When installed by the driver, flushBlocks
   * persists each newly-flushed block (durable-first, before projecting it to
   * the record stream). `null` → the driver owns persistence via its batch
   * fallback. Reads the driver's live (swappable) persister at call time.
   */
  private persistHook: ((block: TerminalRecordBlock) => void) | null = null;

  /**
   * Herta's synthesized voice (ADR 0042), attached by the session when the
   * host provides a synthesizer. Read at every speech stream's start: when
   * `available()`, the stream is VOICED — its reveal is paced by the audio
   * (`createVoicedReveal`) instead of the per-char cadence. Null → the text
   * reveal, byte-identical to before.
   */
  private voice: {
    readonly synth: SpeechSynthesizer;
    readonly emitVoice: (ev: VoiceCueEvent) => void;
    /** A SUPERVISED voiced stream has begun — the moment the veto reaction
     *  is armed (ADR 0042 §7b): its first units are in flight, so the
     *  filler queues behind them instead of ahead of the reply. */
    readonly onVoicedBegin?: () => void;
  } | null = null;
  private utteranceSeq = 0;
  /** One voice at a time: every voiced driver starts after the previous
   *  one settles. A beat still sounding when the next line opens must
   *  finish first, or two of her would speak at once. */
  private voiceLane: Promise<void> = Promise.resolve();
  /** The voiced driver a veto cut, kept until the turn settles: the retry's
   *  driver skips the sentences it fully played, and the retract floor
   *  snaps to the start of the sentence the retry will speak whole. */
  private lastVetoed: VoicedReveal | null = null;
  /** Voiced drivers not yet settled — `settleVoice` lands their text. */
  private readonly liveVoiced = new Set<VoicedReveal>();
  /**
   * The BEAT lane's voiced driver (begin/stream/end with no controller —
   * how in-turn beats reach the sink). Tokens route into it instead of the
   * bus; `endHertaStream` finishes its input and it keeps revealing at the
   * audio's pace after the actor has moved on.
   */
  private beatVoice: VoicedReveal | null = null;
  /**
   * Record-stream gate for voiced beats: the bridge commits a beat block
   * and flushes it the instant the beat's tokens are in — but its audio
   * (and audio-paced reveal) is still running, and the committed block
   * would snap the streaming bubble to the full text mid-sentence. While a
   * voiced beat is unsettled, block events queue here (persisted at once,
   * mirrored at once — only the EMIT waits) and drain in order when it ends.
   */
  private beatGate: Promise<void> | null = null;
  private readonly queuedRecord: RecordEvent[] = [];

  constructor(
    private readonly bus: EventBus<AgentEvent>,
    private readonly emitSpeech: (ev: SpeechControlEvent) => void,
    private readonly emitRecord: (ev: RecordEvent) => void,
    private readonly random: () => number = Math.random,
    /** Clock for the per-block `at` stamp on live-emitted blocks. Defaults to
     *  the wall clock; tests inject a fixed value. */
    private readonly now: () => string = () => new Date().toISOString(),
    /** Session interaction language. `en` reveals speech at WORD granularity
     *  (mode `word`) with ASCII breaths; `zh` (default) keeps the byte-identical
     *  per-code-point `cjk` cadence. Session-constant, so it is a constructor
     *  arg — no per-call plumbing. */
    private readonly lang: PromptLang = "zh",
  ) {}

  /** Reveal granularity derived from the session language. */
  private get mode(): PacingMode {
    return this.lang === "en" ? "word" : "cjk";
  }

  /** Attach the host's speech synthesizer (ADR 0042). Called once by
   *  SessionImpl.create when the config carries one; tests may pass a fake. */
  attachVoice(voice: {
    readonly synth: SpeechSynthesizer;
    readonly emitVoice: (ev: VoiceCueEvent) => void;
    readonly onVoicedBegin?: () => void;
  }): void {
    this.voice = voice;
  }

  /**
   * Hold the voice lane for `ms` after whatever is on it settles: the next
   * voiced driver starts after that. The veto reaction's filler rides here
   * (ADR 0042 §7b) — the retry's first sentence waits for "等等…" to land.
   */
  holdVoiceLane(ms: number): void {
    if (!(ms > 0)) return;
    this.voiceLane = this.voiceLane.then(
      () => new Promise<void>((r) => setTimeout(r, ms)),
    );
  }

  /** Whether a stream opened now would be voiced — the host's synthesizer
   *  is attached and says it is available. The session asks before the
   *  opening so the recorded clip and the synthesized line never both
   *  play (ADR 0042 amendment 2026-09-08). */
  voiceAvailable(): boolean {
    return this.voice !== null && this.voice.synth.available();
  }

  /** True when the stream about to open should be voiced. */
  private voiceFor(opts?: { readonly unvoiced?: boolean }): {
    readonly synth: SpeechSynthesizer;
    readonly emitVoice: (ev: VoiceCueEvent) => void;
  } | null {
    if (opts?.unvoiced === true) return null;
    if (this.voice === null || !this.voice.synth.available()) return null;
    return this.voice;
  }

  /**
   * Build a voiced driver on the shared lane. `onBegin`/`onFinish` are the
   * caller's (the controller lanes open/close the surface; the beat lane
   * does neither — the actor already did).
   */
  private makeVoicedDriver(
    voice: NonNullable<typeof this.voice>,
    opts: {
      readonly verdictPending?: Promise<void>;
      readonly baseMsOverride?: number;
      readonly onBegin: () => void;
      readonly onFinish: () => void;
    },
  ): VoicedReveal {
    this.utteranceSeq += 1;
    const startAfter = this.voiceLane;
    const supervised = opts.verdictPending !== undefined;
    const vetoed = this.lastVetoed;
    const driver = createVoicedReveal({
      synth: voice.synth,
      utteranceId: `u${this.utteranceSeq}-${randomUUID().slice(0, 8)}`,
      lang: this.lang,
      mode: this.mode,
      fallbackBaseMs: opts.baseMsOverride ?? SLOW_MS_PER_CHAR,
      maxUtteranceMs: MAX_VOICED_MS,
      ...(opts.verdictPending !== undefined
        ? { verdictPending: opts.verdictPending }
        : {}),
      startAfter,
      // After a veto: the sentences already heard are not spoken twice.
      ...(vetoed !== null ? { alreadySpoken: vetoed.spokenUnits() } : {}),
      emitRange: (text) => {
        publishWithLayer(this.bus, "actor", { type: "assistant.delta", text });
      },
      onBegin: () => {
        opts.onBegin();
        if (supervised) voice.onVoicedBegin?.();
      },
      onFinish: opts.onFinish,
      emitVoice: voice.emitVoice,
    });
    this.liveVoiced.add(driver);
    const settled = driver.done.then(
      () => undefined,
      () => undefined,
    );
    void settled.then(() => this.liveVoiced.delete(driver));
    this.voiceLane = settled;
    return driver;
  }

  /**
   * Land every unsettled voiced reveal now — the text in one emit, the audio
   * stopped — and release the beat gate. Called by the session on interrupt
   * and at turn end, so a beat still sounding can never outlive its turn or
   * hold the committed blocks back after the turn has ended.
   */
  settleVoice(): void {
    for (const d of this.liveVoiced) d.flushTail();
    this.beatVoice = null;
    this.lastVetoed = null;
    this.drainQueuedRecord();
  }

  private gateRecordOn(done: Promise<void>): void {
    const settled = done.then(
      () => undefined,
      () => undefined,
    );
    const gate = (this.beatGate ?? Promise.resolve()).then(() => settled);
    this.beatGate = gate;
    void gate.then(() => {
      // Only the NEWEST gate releases; an older one settling while a newer
      // beat is still sounding must keep the queue held.
      if (this.beatGate === gate) {
        this.beatGate = null;
        this.drainQueuedRecord();
      }
    });
  }

  private drainQueuedRecord(): void {
    this.beatGate = null;
    const pending = this.queuedRecord.splice(0, this.queuedRecord.length);
    for (const ev of pending) this.emitRecord(ev);
  }

  /**
   * Seed the canonical-diff cursor so blocks already present at session
   * start (loaded record on resume, opening seed on a new session) are not
   * re-streamed — the GUI already holds them via the onReset snapshot.
   * Called by SessionImpl.create after loadRecord (before any turn) and by
   * rewindLastTurn after truncation.
   *
   * `record` seeds the resync mirror with the blocks the cursor skips
   * (they never pass through flushBlocks). Callers that omit it (older
   * tests) leave the mirror out of sync, which simply disables
   * `resyncRecord` — the guard there prefers not healing over emitting a
   * wrong record.
   */
  seedEmittedCount(n: number, record?: TerminalRecord): void {
    this.emittedCount = n;
    this.mirror = record !== undefined ? record.slice(0, n) : [];
  }

  /**
   * The blocks this sink has actually STREAMED and (via `persistHook`)
   * PERSISTED — the seeded prefix plus every flush. This is the record the
   * user is looking at and the record on disk, which after a failed turn is
   * strictly longer than the driver's in-memory one (see V2ActorDriver.runTurn's
   * persistence note). `SessionImpl`'s failure path uses it to re-align the
   * driver instead of leaving the three copies disagreeing.
   *
   * Valid only when the mirror invariant holds (`mirror.length ===
   * emittedCount`); returns null otherwise, exactly like `resyncRecord`'s
   * guard — a wrong record is worse than no answer.
   */
  flushedRecord(): TerminalRecord | null {
    if (this.mirror.length !== this.emittedCount) return null;
    return [...this.mirror];
  }

  /**
   * Re-emit the full live record as a `reset` through the record stream
   * (renderer-requested heal after a record-channel overflow drop). Emitting
   * through the SAME channel as block events makes the heal race-free by
   * FIFO ordering: the reset contains exactly the blocks whose events were
   * emitted before it, and any later flush emits only blocks after it — no
   * duplicate, no gap. An out-of-band snapshot could not guarantee this (a
   * still-queued block event would re-append a block the snapshot already
   * contains), and SessionImpl's `_record` would regress the renderer
   * mid-turn. No-op when the mirror invariant does not hold (a seed without
   * its record): a wrong reset is worse than an unhealed hole.
   */
  resyncRecord(): void {
    if (this.mirror.length !== this.emittedCount) return;
    // The mirror already holds blocks whose events a voiced beat is still
    // holding back; release them first so the reset is not followed by
    // duplicates of blocks it already contains.
    this.drainQueuedRecord();
    // Long-session windowing (2026-07-12): the heal carries the trailing
    // window + its absolute start, like every full-record payload to the
    // renderer. The store re-anchors its window on it.
    const tail = recordTail(this.mirror);
    this.emitRecord({
      kind: "reset",
      record: [...tail.record],
      start: tail.start,
    });
  }

  /**
   * Install the persistence hook (D1). Called once by the driver constructor
   * when this sink is wired. The hook persists a single block; the driver's
   * closure reads its live persister so a `/resume` swap is honored.
   */
  setPersistHook(hook: (block: TerminalRecordBlock) => void): void {
    this.persistHook = hook;
  }

  /**
   * D3: settle the opening-seed block after it has streamed in, WITHOUT
   * persisting it (it was written to disk at session creation — re-persisting
   * via the flush hook would duplicate it). Emits the block on the record stream
   * so the renderer settles its streaming bubble, and advances the cursor so a
   * later flushBlocks does not re-emit it. Stamps a render-only `at` like
   * flushBlocks does.
   */
  commitOpeningSeed(block: TerminalRecordBlock): void {
    const stamped =
      block.at === undefined ? { ...block, at: this.now() } : block;
    this.emitRecord({ kind: "block", blockId: randomUUID(), block: stamped });
    this.mirror.push(stamped);
    this.emittedCount += 1;
  }

  /**
   * Emit the prefix-preserving retract floor (Bug 2, 2026-06-27): the
   * code-point length of the shared prefix between the vetoed candidate and the
   * final retry. The GUI morph halts its backward erase at this position
   * instead of walking to empty. Emitted by the actor once the final retry is
   * known, before the paced replay. The store ignores a floor that arrives when
   * it is not retracting (the cursor-0 veto where no retract fired).
   */
  emitRetractFloor(keepLen: number): void {
    // Voiced (ADR 0042 §7b): the retry speaks the sentence the divergence
    // falls in WHOLE, so the erase walks back to that sentence's start and
    // audio and text restart together — a few characters further than the
    // minimum, in lockstep.
    const snapped = this.lastVetoed?.unitStartAtOrBefore(keepLen) ?? keepLen;
    this.emitSpeech({ kind: "retractFloor", keepLen: snapped });
  }

  /**
   * The actor's raw stream lane — how in-turn BEATS reach the sink (the
   * primary speech goes through the paced controllers below, which open and
   * close the surface themselves via `openSurface`/`closeSurface`). With a
   * synthesizer available a beat is voiced too: a driver opens here, the
   * tokens route into it, and `endHertaStream` finishes its input — the
   * reveal then runs at the audio's pace after the actor has moved on, with
   * the record-stream gate holding the committed block until it ends.
   */
  beginHertaStream(surface: "speech" | "thought"): void {
    this.surface = surface;
    if (surface !== "speech" || this.beatVoice !== null) return;
    const voice = this.voiceFor();
    if (voice === null) return;
    const driver = this.makeVoicedDriver(voice, {
      onBegin: () => undefined,
      onFinish: () => undefined,
    });
    this.beatVoice = driver;
    this.gateRecordOn(driver.done);
  }

  streamHertaToken(text: string): void {
    if (text.length === 0) return;
    if (this.beatVoice !== null) {
      this.beatVoice.pushToken(text);
      return;
    }
    if (this.surface !== "speech") return;
    publishWithLayer(this.bus, "actor", { type: "assistant.delta", text });
  }

  endHertaStream(): void {
    this.surface = null;
    if (this.beatVoice !== null) {
      const driver = this.beatVoice;
      this.beatVoice = null;
      driver.finishInput();
    }
  }

  /** Surface bookkeeping for the controller lanes (never opens a beat
   *  driver — the controller IS the voice there). */
  private openSurface(): void {
    this.surface = "speech";
  }

  private closeSurface(): void {
    this.surface = null;
  }

  flushBlocks(record: TerminalRecord): void {
    for (let i = this.emittedCount; i < record.length; i += 1) {
      const block = record[i];
      // The guard satisfies `noUncheckedIndexedAccess` (tsconfig.base.json);
      // the loop bound makes it unreachable at runtime. Mirrors the CLI's
      // NarrativeRenderer.update.
      if (block === undefined) continue;
      // D1 durable-first: persist BEFORE projecting to the render surface, so a
      // persist failure fails the turn loud before the user sees the block.
      // Persist the ORIGINAL block (not the `at`-stamped render copy) — the
      // persister stamps independently on write. The loop's [emittedCount,
      // length) bound (seeded past loaded/opening blocks) means those are never
      // re-persisted.
      this.persistHook?.(block);
      // Stamp a wall-clock `at` on the emitted copy when the block lacks one,
      // so the live GUI shows a per-block timestamp during the active session
      // (the in-memory record is left untouched — non-mutating copy). The
      // persister stamps independently on write; at minute granularity the
      // live and reloaded values match.
      const stamped =
        block.at === undefined ? { ...block, at: this.now() } : block;
      const ev: RecordEvent = {
        kind: "block",
        blockId: randomUUID(),
        block: stamped,
      };
      // A voiced beat still sounding holds the EMIT (see `beatGate`); the
      // persist and the mirror above/below are unconditional.
      if (this.beatGate !== null) this.queuedRecord.push(ev);
      else this.emitRecord(ev);
      this.mirror.push(stamped);
    }
    this.emittedCount = record.length;
  }

  /**
   * Build one live-shaped controller over the shared reveal driver
   * (`@herta/herta` createRevealDriver — see that module for the loop
   * semantics: front-gate, fence/word/char branches, ramp/hold, ceiling,
   * starvation re-arm). This sink contributes only the GUI-specific edges:
   * deltas are published as actor-layer `assistant.delta` bus events, the
   * begin/end stream discipline drives the streaming bubble, and a veto
   * emits ONE `retract` control event (the renderer owns the morph) while
   * resolving immediately so the retry can race it.
   */
  private makeRevealController(opts?: {
    readonly verdictPending?: Promise<void>;
    readonly baseMsOverride?: number;
    readonly unvoiced?: boolean;
  }): LiveSlowStreamController {
    // Per-char base cadence: a voiced stream (the opening) overrides it so the
    // reveal spans ≈ its clip; otherwise the read-along default. Jitter and
    // punctuation breaths ride on top either way.
    const baseMs = opts?.baseMsOverride ?? SLOW_MS_PER_CHAR;
    let begun = false;
    const onBegin = (): void => {
      begun = true;
      this.openSurface();
    };
    const onFinish = (): void => this.closeSurface();
    // Voiced (ADR 0042) when the host's synthesizer is available and the
    // caller did not bring its own voice: the audio paces the reveal.
    const voice = this.voiceFor(opts);
    const voicedDriver: VoicedReveal | null =
      voice !== null
        ? this.makeVoicedDriver(voice, {
            ...(opts?.verdictPending !== undefined
              ? { verdictPending: opts.verdictPending }
              : {}),
            ...(opts?.baseMsOverride !== undefined
              ? { baseMsOverride: opts.baseMsOverride }
              : {}),
            onBegin,
            onFinish,
          })
        : null;
    const driver: RevealLike =
      voicedDriver !== null
        ? voicedDriver
        : createRevealDriver({
            mode: this.mode,
            baseMs,
            random: this.random,
            // Reveal ceiling (slice 3): past it the tail lands in one delta.
            maxRevealMs: resolveMaxRevealMs(),
            // Fenced ``` regions emit atomically (slice 5) on both GUI lanes.
            fences: true,
            // GUI finishes on the tick that emits the last unit (the CLI's
            // deferred completion tick is off).
            completionTick: false,
            // `undefined` means "no supervisor in the loop" (beats, any future
            // unsupervised caller): the gate is open from the start, so the
            // stream never ramps, never holds, never front-gates.
            verdictPending: opts?.verdictPending,
            emitRange: (text) => {
              publishWithLayer(this.bus, "actor", {
                type: "assistant.delta",
                text,
              });
            },
            onBegin,
            onFinish,
          });
    return {
      done: driver.done,
      pushToken: driver.pushToken,
      finishInput: driver.finishInput,
      fastForward: driver.fastForward,
      flushRemainder: (): void => {
        // Interrupt path (slice 3): the whole tail in one delta, right now.
        // The actor arms this on turn abort / post-verdict paced drains — an
        // abort while the verdict is still pending takes the
        // interrupt-during-supervisor path (cancelAndBackspace), so an
        // unapproved candidate never flashes fully on screen.
        driver.flushTail();
      },
      cancelAndBackspace: async (): Promise<void> => {
        // driver.cancel() stops the loop and rejects `done`; false → a
        // repeat call (idempotent, no second retract event).
        if (!driver.cancel()) return;
        // The retry's driver and the retract floor read what this one
        // spoke (ADR 0042 §7b).
        if (voicedDriver !== null) this.lastVetoed = voicedDriver;
        if (!begun) this.openSurface();
        this.closeSurface();
        // cursor === 0 → nothing on screen to retract (veto during the
        // startup buffer); the retry just streams fresh.
        if (driver.cursor > 0) this.emitSpeech({ kind: "retract" });
        // Resolves immediately: the retry races the renderer's
        // prefix-preserving morph (2026-06-10 slice).
      },
    };
  }

  slowStreamSpeech(
    text: string,
    opts?: {
      readonly verdictPending?: Promise<void>;
      readonly baseMsOverride?: number;
      readonly unvoiced?: boolean;
    },
  ): SlowStreamController {
    // Fixed text is the degenerate live call pattern: push everything, then
    // finish. With `inputFinished` true from the first tick, the driver's
    // live-only guards reduce exactly to the historical non-live semantics
    // (including the supervised startup front-load, which the front-gate
    // applies at finishInput / at the backlog threshold for long text).
    const c = this.makeRevealController(opts);
    c.pushToken(text);
    c.finishInput();
    // Return only the SlowStreamController surface (no pushToken/finishInput
    // on a fixed-text stream).
    const { done, fastForward, flushRemainder, cancelAndBackspace } = c;
    return { done, fastForward, flushRemainder, cancelAndBackspace };
  }

  /**
   * Live-feed variant of slowStreamSpeech (SPEC live-feed-supervised-reveal §4/§5).
   * Reveals from a GROWING buffer: 1x while input is open (backlog builds — the
   * reveal lags generation), then pacingDecision ramp/hold on the tail once
   * finishInput makes total known. begin deferred to first emit; endHertaStream
   * once on any terminal path. The verdict-pending gate is consulted ONLY after
   * finishInput.
   *
   * Front-gate (2026-07-11 live-reveal-front-load spec): a SUPERVISED stream
   * does not start revealing at the first token. It opens on whichever comes
   * first — the backlog reaching `TARGET_VISIBLE_MS / baseMs` chars (the
   * un-ramped reveal already spans the target; long replies hit this on the
   * first chunks, behavior unchanged), or `finishInput` (total now known),
   * which applies the non-live path's `startupDelayMs` front-load. A short
   * candidate's supervisor wait thus sits BEFORE the text, under the
   * judgment hint, instead of freezing the sentence at the 92% hold — the
   * old "no front-load (total unknown up front)" rationale only held at
   * controller open, not at finishInput. Unsupervised streams (veto retry,
   * empty-speech retry) keep their instant TTFT reveal.
   */
  slowStreamSpeechLive(opts?: {
    readonly verdictPending?: Promise<void>;
    readonly baseMsOverride?: number;
    readonly unvoiced?: boolean;
  }): LiveSlowStreamController {
    return this.makeRevealController(opts);
  }
}
