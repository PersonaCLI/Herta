import type {
  AgentEvent,
  CodingAgentRuntime,
  CompletionProviderAdapter,
  EventBus,
  ProviderAdapter,
  SystemBlock,
  SystemBlockLabel,
  TerminalRecord,
  TerminalRecordBlock,
  V2RecordPersister,
} from "@herta/core";
import type { ActorHints } from "./actor-hints.js";
import type { StaticHertaPrefix } from "./actor-prompt.js";
import { ActorTurnAbortedError, runActorCompletionTurn } from "./actor-turn.js";
import { classifyIntent, lastNSpeechTurns } from "./intent-router.js";
import {
  type AttachedMetaThink,
  type MetaThinkCorpus,
  type MoodState,
  resolveMetaThink,
} from "./meta-think.js";
import type { PromptLang } from "./prompt-lang.js";
import {
  type PreparedRecap,
  prepareTurnRecap,
  type RecapRuntime,
} from "./session-recap-runtime.js";
import type { ActorStreamingSink } from "./streaming-sink.js";

/**
 * Number of consecutive same-state turns after which the SPEAK anchor
 * is refreshed to the current turn's speech position. The speak
 * preamble is anchored at the first speech of a mood-state run (so it
 * reads as a one-time voice baseline reminder), but if the same mood
 * persists for many turns the anchor drifts arbitrarily far back in
 * the rendered prompt and the model effectively stops attending to
 * it. After this many same-state turns the anchor jumps forward to
 * the current speech position; the count then resets.
 *
 * The THINK anchor refreshes EVERY turn (it's tied to the current
 * user message) — this interval only governs the speak anchor.
 *
 * Tuning: 5 is a starting value. Larger keeps the anchor stable at
 * a small voice-drift cost; smaller re-emits the preamble more often
 * at a larger token cost. Change here if a regression suggests it.
 */
const SPEAK_ANCHOR_REFRESH_INTERVAL = 5;

/**
 * D3 lead beat: how long a NEW session's opening seed holds AFTER the turn's
 * `started` lifecycle but BEFORE the first speech delta, so the GUI's in-flight
 * hint (`消息正在穿越银河`) shows first and the opening arrives like a reply —
 * Herta "thinking" before she speaks — rather than the line snapping in. The GUI
 * galaxy row appears after its own ~200ms debounce, so the visible hint is
 * roughly `(this − 200)`ms. Tunable; `SessionImpl` passes it through and tests
 * override it to 0 to skip the wall-clock wait. (User 2026-06-20: 1000ms felt
 * too fast → 2000ms.)
 */
export const OPENING_LEAD_MS = 2000;

/**
 * Returns true when the corpus has at least one non-empty meta-think blob.
 * An all-empty corpus (a test seam — the compiled corpus is never empty)
 * means no meta-think text can be injected, so the driver builds no
 * attachment; the actor still runs its think-then-speak rhythm (the
 * single-phase fallback this used to select is gone, 2026-09-03).
 */
function corpusHasContent(corpus: MetaThinkCorpus): boolean {
  return (
    Object.values(corpus.preThink).some((v) => v.length > 0) ||
    Object.values(corpus.preSpeak).some((v) => v.length > 0)
  );
}

export interface V2ActorDriverDeps {
  readonly provider: CompletionProviderAdapter;
  readonly model: string;
  /** Structured static Herta prefix. See `StaticHertaPrefix` in
   *  `@herta/herta`'s narrative/actor-prompt. */
  readonly staticPrefix: StaticHertaPrefix;
  readonly bus: EventBus<AgentEvent>;
  readonly runtimeFactory: () => CodingAgentRuntime;
  /**
   * Optional persister. If set, every block appended by `runTurn` is pushed
   * synchronously to the persister via `appendBlock(block)`. Survives across
   * `setPersister` swaps (used by `/resume` to redirect writes to a loaded
   * session's file). `loadRecord` does NOT replay loaded blocks through the
   * persister — they're already on disk in the source file.
   *
   * SPEC v0.2 Slice 7b §5.
   */
  readonly persister?: V2RecordPersister;
  /**
   * Optional streaming sink (Slice 9). When provided, the actor's text
   * deltas stream to the sink as they arrive; the sink renders them in
   * real-time. main.ts wires the NarrativeRenderer as the sink so tokens
   * appear live on stdout.
   *
   * Absent → atomic block render at end-of-turn (pre-Slice 9 behavior).
   */
  readonly sink?: ActorStreamingSink;
  /**
   * Optional: forwarded to `ActorTurnDeps.onPrimarySpeechStart` for normal
   * `runTurn` (omitted for regenerate). Fires once per turn at the first speech
   * block's stream start with its leading text — used to play a particle voice
   * cue. See SPEC 2026-06-23 particle-voice.
   */
  readonly onPrimarySpeechStart?: (leadingText: string) => void;
  /**
   * Optional: forwarded to `ActorTurnDeps.onSupervisorVeto` for normal `runTurn`
   * (omitted for regenerate). Fires once when the supervisor rejects the
   * candidate speech — used to play a veto voice clip. See SPEC 2026-06-23
   * veto-voice.
   */
  readonly onSupervisorVeto?: () => void;
  /**
   * Optional prompt-dump callback for debugging. Forwarded to the actor
   * loop via `ActorTurnDeps.onPrompt`. Wired by main.ts when
   * `HERTA_DUMP_PROMPTS` is truthy.
   */
  readonly onPrompt?: (
    label:
      | "primary"
      | "primary-out"
      | "beat"
      | "beat-out"
      | "phase2"
      | "phase2-out"
      | "state"
      | "state-out"
      | "supervisor"
      | "supervisor-out"
      | "supervisor-retry"
      | "supervisor-retry-out",
    prompt: string,
  ) => void;
  /** Slice 13 (chat-mode escalation): router provider. Typically
   *  `deepseekProvider({ model: "deepseek-v4-flash", thinking: "low" })`
   *  (low since the 2026-07-31 flash update; the supervisor keeps its own
   *  "high" adapter).
   *  Used once per user turn to classify the conversation into one of
   *  seven moods. The previous completion-mode implementation was
   *  retired after non-thinking flash failed to classify reliably —
   *  thinking-mode chat gives the model enough cognitive headroom to
   *  follow the classifier instructions.
   *
   *  Model name lives on the provider instance (via the factory's
   *  `model` option), not on per-call requests. */
  readonly routerProvider: ProviderAdapter;
  /** Slice 13: pre-loaded meta-think corpus. An empty corpus (a test
   *  seam) means no meta-think attachment is built; the actor still thinks
   *  then speaks. */
  readonly metaThinkCorpus: MetaThinkCorpus;
  /** Editable actor hints, loaded at startup. Optional: omit to use the
   *  hardcoded `DEFAULT_ACTOR_HINTS`. */
  readonly hints?: ActorHints;
  /** Optional long-session recap runtime. When set, threaded into every
   *  turn's `ActorTurnDeps` so `prepareTurnRecap` can compact old dialogue.
   *  Built at app bootstrap (router summarizer + persisted cache). Undefined
   *  → no compaction. */
  readonly recap?: RecapRuntime;
  /**
   * Optional supervisor chat-mode provider. Typically the same
   * `ProviderAdapter` instance used by the router. When set together
   * with a non-empty `supervisorReference`, the actor runs a supervisor
   * check on every non-empty phase-2 speech before commit.
   */
  readonly supervisorProvider?: ProviderAdapter;
  /**
   * Authored supervisor reference content. Loaded once at startup via
   * `loadSupervisorReference`. Empty string disables the supervisor.
   */
  readonly supervisorReference?: string;
  /**
   * Interaction language of the session (slice 4). Per-session — the
   * driver lives for one session and threads this into EVERY
   * language-parameterized call it makes: the intent router
   * (`classifyIntent`), and the actor turn (`runActorCompletionTurn`
   * → supervisor check, trigger re-pass recheck, fallback hint texts).
   * The static prefix, meta-think corpus, hints, and recap runtime are
   * INJECTED deps — their constructors (`buildStaticHertaPrefix`,
   * `loadMetaThinkCorpus`, `loadActorHints`, `buildRecapRuntime`) take
   * the same lang at session bootstrap; pass a consistent value.
   * Default "zh" — byte-identical to pre-slice-4 behavior.
   */
  readonly lang?: PromptLang;
  /**
   * `maxIterations` is intentionally not exposed here; `runActorCompletionTurn`
   * defaults to 5. If the driver needs to expose iteration limits later, add as
   * an optional field.
   *
   * The per-call `signal` argument to `runTurn` is threaded into
   * `runActorCompletionTurn`'s `deps.signal` so the in-flight LLM call
   * and any backend dispatch this turn fires can be cancelled via Ctrl-C.
   */
}

/**
 * Thin stateful wrapper around `runActorCompletionTurn`. Holds the
 * growing `TerminalRecord` across REPL turns so the CLI can render
 * differentially and the actor can build on prior context.
 *
 * Lifetime: one driver per CLI session. The driver's record IS the
 * session's record — v0.1's `TranscriptStore` equivalent.
 *
 * SPEC v0.2 §6 / Slice 6 Task 3 / Slice 7b §5.
 */
export class V2ActorDriver {
  private record: TerminalRecord = [];
  private persister: V2RecordPersister | undefined;
  private currentIntentState: MoodState = "默认";
  /**
   * The meta-think attachment for the most recently started turn (or
   * `null` if no turn has run yet, or after `loadRecord`). Updated
   * each turn: the THINK anchor (and text) is recomputed against the
   * current record length every turn; the SPEAK anchor (and text)
   * sticks across same-state turns and refreshes only on state change
   * or after `SPEAK_ANCHOR_REFRESH_INTERVAL` consecutive same-state
   * turns. See `AttachedMetaThink` JSDoc for the full contract.
   */
  private attachedMetaThink: AttachedMetaThink | null = null;
  /**
   * Number of same-state turns elapsed since the SPEAK anchor was
   * last refreshed. Reset to 0 on state change, on speak-anchor
   * refresh, and on `loadRecord`. Reaches
   * `SPEAK_ANCHOR_REFRESH_INTERVAL` → the next same-state turn
   * refreshes the speak anchor and resets this counter.
   */
  private turnsSinceSpeakAnchor = 0;
  /**
   * One-shot "force a recap re-derive on the NEXT turn" flag. Set by the
   * `/compact` command via `forceCompactNextTurn()`; consumed (and reset)
   * at the start of the next `runTurn`. Inert until a recap runtime is
   * wired into the actor turn — but the flag still threads through cleanly.
   */
  private forceCompactPending = false;
  /**
   * D1 (mid-stream durability): true when the sink persists each block as it
   * flushes (the GUI `BusActorStreamingSink`). When true, `runTurn` SKIPS its
   * batch-after-turn persist — the sink already wrote each block the instant it
   * was committed, so a mid-turn app-close keeps every finalized block.
   * Hook-less sinks (CLI `NarrativeRenderer`, headless tests) leave this false
   * and the driver batch-persists after the turn as before.
   */
  private sinkPersists = false;

  constructor(private readonly deps: V2ActorDriverDeps) {
    this.persister = deps.persister;
    // Hand a persisting sink a hook that reads our LIVE persister (so a
    // `/resume` `setPersister` swap is honored without re-wiring the sink), and
    // mark that the sink owns persistence. The hook fires inside the sink's
    // canonical-ordered, cursor-guarded `flushBlocks`, so loaded/opening blocks
    // (excluded by the sink's seeded cursor) are never re-persisted.
    if (deps.sink?.setPersistHook !== undefined) {
      deps.sink.setPersistHook((block) => this.persister?.appendBlock(block));
      this.sinkPersists = true;
    }
  }

  /** Force a recap re-derive (compaction) on the NEXT turn. One-shot: consumed
   *  by the next turn. Used by the /compact command. */
  forceCompactNextTurn(): void {
    this.forceCompactPending = true;
  }

  getCurrentIntentState(): MoodState {
    return this.currentIntentState;
  }

  /**
   * Snapshot of the currently-attached meta-think note (or `null`).
   * Exposed for tests; production code consumes the attachment via the
   * actor-turn deps wired in `runTurn`.
   */
  getAttachedMetaThink(): AttachedMetaThink | null {
    return this.attachedMetaThink;
  }

  /**
   * Run one Herta turn against the current `record`. Returns the post-turn
   * record (which is also accessible via `getRecord()`).
   *
   * Persistence note: in both persistence modes a `persister.appendBlock` throw
   * (e.g. disk full) propagates and fails the turn loud (the spec's "turn fails
   * loud rather than silently dropping history" contract). The in-memory vs
   * on-disk state on failure differs by mode:
   *   - Batch fallback (`!sinkPersists`, hook-less sinks): persistence runs
   *     after the turn completes, so on a mid-loop throw `this.record` already
   *     holds the full post-turn state and the on-disk file holds a strict
   *     prefix of it.
   *   - Incremental (`sinkPersists`, D1, the GUI sink): persistence rides
   *     `flushBlocks` DURING the turn, so a throw aborts `runActorCompletionTurn`
   *     before `this.record` is reassigned — `this.record` stays at its PRE-turn
   *     value while the on-disk file holds a prefix of the intended post-turn
   *     record. The blocks already flushed are durable and stay on disk; the
   *     in-memory record does NOT catch up to them ("the next successful turn
   *     rebuilds it" was never true — audit 2026-07-10, finding 10). The
   *     session layer must reseed the sink cursor from this record on its
   *     failure path, or the next turn's user block lands below the stale
   *     cursor and is neither streamed nor persisted.
   * Callers should not retry the same `runTurn` without user intervention — a
   * retry would re-execute the entire turn (including the model call).
   */
  async runTurn(
    text: string,
    signal: AbortSignal,
    // Whether this turn may fire turn-voice cues (particle on first speech, veto
    // on rejection). False for regenerate (a resume-recovery redo should not
    // re-play the interjection or the catching-herself line).
    voiceEligible = true,
    // Attachment blocks sent WITH this message (ADR 0048 §4) — appended after
    // the user block by the actor turn, so they sit inside the turn's span.
    userAttachments: readonly SystemBlock[] = [],
  ): Promise<TerminalRecord> {
    const prevLen = this.record.length;

    // Slice 13: classify intent before the actor runs. Router failure
    // is non-fatal — we keep the prior state and proceed.
    // The attachments are NOT in this preliminary record: the recap
    // summarizes history BEFORE this turn, and the router classifies what the
    // user SAID. Both would be unmoved by a picture appended after the fact.
    const prelimRecord = [...this.record, { kind: "user" as const, text }];

    // The two pre-speech calls run CONCURRENTLY (2026-09-03). The recap
    // summarizes history BEFORE this turn; the router classifies what the
    // user SAID from the raw recent record — neither reads the other's
    // output, and on a compaction turn they used to run back to back, the
    // summarizer's seconds plus the router's on top. The recap is STARTED
    // first: its synchronous prefix (cache read, the prompt estimate, the
    // `recap.compaction` start hint) runs before the router's request is even
    // issued, so the GUI still shows the recap row at turn start on a
    // compaction turn rather than the galaxy-travel row first (user
    // 2026-06-20). Computed once here and threaded into the turn as
    // `precomputedRecap`; the forceCompact one-shot is consumed up here too so
    // it clears even if the turn later throws.
    const forceCompact = this.forceCompactPending;
    this.forceCompactPending = false;
    const recapPending = prepareTurnRecap(
      prelimRecord,
      this.deps.staticPrefix,
      this.deps.recap,
      forceCompact,
      signal,
      (phase) =>
        this.deps.bus.publish({
          type: "recap.compaction",
          layer: "actor",
          phase,
        }),
    );
    // Router failure is non-fatal — the prior state is kept. Settled to
    // null here (not awaited under a try) so a failing router can neither
    // reject unhandled while the recap is still running nor mask it. The
    // driver intentionally does not log the failure — main.ts can decide
    // whether to surface router failures.
    const routerPending = classifyIntent({
      recentRecord: lastNSpeechTurns(prelimRecord, 5),
      currentState: this.currentIntentState,
      provider: this.deps.routerProvider,
      lang: this.deps.lang ?? "zh",
      signal,
    }).then(
      (result) => result,
      () => null,
    );
    const precomputedRecap: PreparedRecap = await recapPending;
    const routed = await routerPending;

    let routerPrompt: string | undefined;
    let routerRawOutput: string | undefined;
    if (routed !== null) {
      this.currentIntentState = routed.state;
      routerPrompt = routed.prompt;
      routerRawOutput = routed.rawOutput;
    }
    // Dump the full router transaction (prompt + raw output) for
    // diagnostics. Only fires when the router call returned without
    // throwing — failed router calls leave `routerPrompt` undefined.
    if (routerPrompt !== undefined && routerRawOutput !== undefined) {
      this.deps.onPrompt?.(
        "state-out",
        `${routerPrompt}\n\n---\n\n${routerRawOutput}`,
      );
    }
    // Log the resolved (or kept) intent state once per turn.
    this.deps.onPrompt?.("state", this.currentIntentState);

    // The routed state always reaches the actor (2026-09-03 — the single-
    // phase fallback an absent state used to select is gone). The corpus
    // check below gates only the meta-think ATTACHMENT: an all-empty corpus
    // (a test seam) means there is no preamble to splice, and the turn runs
    // think-then-speak without one.
    const corpusActive = corpusHasContent(this.deps.metaThinkCorpus);

    // Build the meta-think attachment for this turn. Asymmetric
    // anchoring — the two surfaces have different stickiness AND
    // different positions relative to the user's incoming message:
    //
    //   - `beforeThinkIndex` is recomputed EVERY turn and points to
    //     the position OF the incoming user message (not after it).
    //     The preThinkText preamble sits BEFORE that user message so
    //     the rendered prompt reads:
    //       ... prior turns ...
    //       <preThinkText>
    //       （开拓者 说） <current user> （/开拓者 说）
    //       〔hint〕（我 想）
    //     Placing meta BEFORE the user keeps the user message + hint
    //     immediately adjacent to the open tag — observed in live
    //     testing to materially lower the empty-thought rate (the
    //     model is less likely to close `（我 想）` at position 0 when
    //     the user message it's supposed to react to is the last
    //     piece of context before the open tag).
    //   - `beforeSpeakIndex` is STICKY across same-state turns —
    //     anchored at the first speech position of this mood-state
    //     run, BETWEEN the first user message and the first speech
    //     block. Speech blocks persist in the prompt across turns,
    //     so the speak preamble works as a one-time voice baseline
    //     reminder. Same-state turns normally do NOT re-emit it;
    //     a state change resets the anchor. To prevent the anchor
    //     from drifting arbitrarily far back on long same-mood runs
    //     (observed to weaken the preamble's effect after ~5 turns),
    //     the driver also refreshes the speak anchor every
    //     `SPEAK_ANCHOR_REFRESH_INTERVAL` consecutive same-state
    //     turns, jumping it forward to the current speech position.
    //
    // Position math: the user block we're about to append lands at
    // `this.record.length` (call it N). The think anchor goes to N
    // (= before the user). The speak anchor goes to N + 2 (= where
    // this turn's `（我 说）` will land, after thought at N+1).
    //
    // The corpus texts are re-resolved on state change. For same-
    // state turns we keep the texts (corpus lookup would yield the
    // same value), saving a redundant resolve. `loadRecord` resets
    // the attachment to null so the next turn rebuilds from scratch.
    if (corpusActive) {
      const sameState =
        this.attachedMetaThink !== null &&
        this.attachedMetaThink.state === this.currentIntentState;
      if (sameState && this.attachedMetaThink !== null) {
        this.turnsSinceSpeakAnchor += 1;
        const speakStale =
          this.turnsSinceSpeakAnchor >= SPEAK_ANCHOR_REFRESH_INTERVAL;
        if (speakStale) {
          // Speak anchor drifted too far back across same-state turns.
          // Re-anchor at this turn's speech position so the preamble
          // re-enters the model's effective attention window. Texts
          // are re-resolved too (no-op for unchanged corpus, but
          // picks up hot-reloaded content if the corpus changed mid-
          // session).
          this.attachedMetaThink = {
            state: this.currentIntentState,
            beforeThinkIndex: this.record.length,
            beforeSpeakIndex: this.record.length + 2,
            preThinkText: resolveMetaThink(
              this.deps.metaThinkCorpus,
              "thought",
              this.currentIntentState,
            ),
            preSpeakText: resolveMetaThink(
              this.deps.metaThinkCorpus,
              "speech",
              this.currentIntentState,
            ),
          };
          this.turnsSinceSpeakAnchor = 0;
        } else {
          // Keep speak anchor + texts; update only the think anchor.
          this.attachedMetaThink = {
            ...this.attachedMetaThink,
            beforeThinkIndex: this.record.length,
          };
        }
      } else {
        // State change (or first turn): fresh anchors at current
        // record positions, fresh corpus lookups, counter reset.
        this.attachedMetaThink = {
          state: this.currentIntentState,
          beforeThinkIndex: this.record.length,
          beforeSpeakIndex: this.record.length + 2,
          preThinkText: resolveMetaThink(
            this.deps.metaThinkCorpus,
            "thought",
            this.currentIntentState,
          ),
          preSpeakText: resolveMetaThink(
            this.deps.metaThinkCorpus,
            "speech",
            this.currentIntentState,
          ),
        };
        this.turnsSinceSpeakAnchor = 0;
      }
    }

    let result: { record: TerminalRecord };
    try {
      result = await runActorCompletionTurn({ record: this.record }, text, {
        provider: this.deps.provider,
        model: this.deps.model,
        staticPrefix: this.deps.staticPrefix,
        bus: this.deps.bus,
        runtimeFactory: this.deps.runtimeFactory,
        sink: this.deps.sink,
        onPrompt: this.deps.onPrompt,
        ...(voiceEligible && this.deps.onPrimarySpeechStart !== undefined
          ? { onPrimarySpeechStart: this.deps.onPrimarySpeechStart }
          : {}),
        ...(voiceEligible && this.deps.onSupervisorVeto !== undefined
          ? { onSupervisorVeto: this.deps.onSupervisorVeto }
          : {}),
        signal,
        precomputedRecap,
        ...(userAttachments.length > 0 ? { userAttachments } : {}),
        lang: this.deps.lang ?? "zh",
        intentState: this.currentIntentState,
        attachedMetaThink:
          corpusActive && this.attachedMetaThink !== null
            ? this.attachedMetaThink
            : undefined,
        ...(this.deps.supervisorProvider !== undefined
          ? { supervisorProvider: this.deps.supervisorProvider }
          : {}),
        ...(this.deps.supervisorReference !== undefined
          ? { supervisorReference: this.deps.supervisorReference }
          : {}),
        ...(this.deps.hints !== undefined ? { hints: this.deps.hints } : {}),
      });
    } catch (err) {
      // Interrupt at an iteration boundary (typically right after a @板砖
      // bridge run): adopt the partial record BEFORE re-throwing. The blocks
      // — backend projections, beats, the done-marker — were already rendered
      // (and, with an incremental sink, already persisted); discarding them
      // left screen/memory/disk disagreeing and next turn's prompt with no
      // trace the backend ever ran. The re-throw keeps interrupt semantics:
      // the session still emits turn.failed (cancellation).
      if (err instanceof ActorTurnAbortedError) {
        this.record = err.partialRecord;
        if (this.persister !== undefined && !this.sinkPersists) {
          for (let i = prevLen; i < this.record.length; i++) {
            const block = this.record[i];
            if (block !== undefined) this.persister.appendBlock(block);
          }
        }
      }
      throw err;
    }
    this.record = result.record;
    // Push newly-appended blocks to the persister, in order. Per-turn diff:
    // only the blocks at indices [prevLen, this.record.length). D1: SKIP when
    // the sink persisted these incrementally on flush (mid-stream durable) —
    // re-persisting here would duplicate every block. This batch path remains
    // the fallback for hook-less sinks (CLI) and headless callers.
    if (this.persister !== undefined && !this.sinkPersists) {
      for (let i = prevLen; i < this.record.length; i++) {
        const block = this.record[i];
        if (block !== undefined) this.persister.appendBlock(block);
      }
    }
    return this.record;
  }

  /**
   * D2 (resume recovery): regenerate the reply for an ORPHANED trailing user
   * block — a turn whose reply was lost to a mid-stream app-close, leaving the
   * user message on disk with no following Herta block. Pops the user block and
   * re-runs a full turn for its text, so the actor regenerates the reply with
   * normal compaction / routing / meta-think. No-op (returns the record
   * unchanged, no model call) when the last block is not a user block — i.e. a
   * session that ended on a Herta reply, the common case.
   *
   * GUI resume path only: it relies on the sink's seeded cursor sitting at the
   * loaded record length (set by the factory right after `loadRecord`), so the
   * re-appended user block lands BELOW the cursor — neither re-streamed nor
   * re-persisted (it is already on disk and already shown via the onReset
   * snapshot) — while only the regenerated reply, landing AT the cursor, is.
   * Call once, immediately after the session is pointed at (before any user
   * turn), so that invariant holds.
   */
  async regenerateLastReply(signal: AbortSignal): Promise<TerminalRecord> {
    const last = this.record[this.record.length - 1];
    if (last === undefined || last.kind !== "user") return this.record;
    this.record = this.record.slice(0, -1);
    // voiceEligible=false: a regenerate (resume-recovery redo) must not re-play
    // the particle interjection or the veto catching-herself line.
    return this.runTurn(last.text, signal, false);
  }

  /**
   * D3 (streaming opening): stream a NEW session's opening-seed block in via the
   * sink (paced like a reply — unsupervised, so no ramp/hold), then commit it to
   * the in-memory record and settle the render surface. The seed was already
   * persisted to disk at session creation (durable), so it is NOT persisted
   * again here — `commitOpeningSeed` settles without re-writing. The seed is
   * deferred from the in-memory record at create (so the onReset snapshot is
   * empty and the renderer streams it instead of showing it instantly); this
   * commits it so subsequent turns carry the opening in context. The caller
   * (SessionImpl) locks the composer via turn lifecycle around this so no user
   * turn races the commit.
   */
  async playOpening(
    block: TerminalRecordBlock,
    leadMs: number = OPENING_LEAD_MS,
    /** Fires once, AFTER the lead beat, as the first char is about to stream.
     *  Lets the caller sync an opening voice cue with the text reveal.
     *  Suppressed when `signal` is already aborted (a skipped opening should
     *  not start its voice clip). */
    onStreamStart?: () => void,
    /** Per-char base cadence (ms) so the reveal spans ≈ the voice clip's
     *  duration (wav-matched opening cadence). Omitted → the sink's default. */
    baseMsOverride?: number,
    /**
     * Interrupt-as-SKIP (audit 2026-07-10): pre-fix the opening was fully
     * non-interruptible, but the composer shows a STOP button during it —
     * a dead affordance. An abort now cuts the lead beat short and flushes
     * the remaining text in ONE delta via the controller's flushRemainder —
     * fast-forward, never truncate, so the seed still commits verbatim and
     * the record/screen stay converged.
     */
    signal?: AbortSignal,
  ): Promise<void> {
    const sink = this.deps.sink;
    if (sink?.slowStreamSpeech !== undefined && block.kind === "herta") {
      // Lead beat (D3): hold before the first char so the GUI's in-flight hint
      // shows, then stream — the opening arrives like a reply rather than
      // snapping in. Only meaningful when there's a stream to lead into, so it
      // lives inside this branch (the hook-less/headless fallback skips it, as
      // does a test passing leadMs <= 0). Abort-aware: a stop click during the
      // lead skips straight to the (instant) flush below.
      if (leadMs > 0 && signal?.aborted !== true) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            signal?.removeEventListener("abort", onAbortLead);
            resolve();
          }, leadMs);
          const onAbortLead = (): void => {
            clearTimeout(t);
            resolve();
          };
          signal?.addEventListener("abort", onAbortLead, { once: true });
        });
      }
      if (signal?.aborted !== true) onStreamStart?.();
      const controller = sink.slowStreamSpeech(
        block.text,
        baseMsOverride !== undefined ? { baseMsOverride } : undefined,
      );
      const onAbort = (): void => controller.flushRemainder?.();
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await controller.done;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    }
    this.record = [...this.record, block];
    sink?.commitOpeningSeed?.(block);
  }

  /**
   * Returns the current TerminalRecord snapshot. The returned reference
   * captures the state at call time; the driver replaces `this.record`
   * on each `runTurn`, so a reference saved before a turn will not
   * observe blocks appended by that turn. To get the post-turn record,
   * either re-call `getRecord()` or use the value returned by `runTurn`.
   *
   * The return type is `readonly`, so callers cannot mutate the record.
   */
  getRecord(): TerminalRecord {
    return this.record;
  }

  /**
   * Rewind the latest 开拓者 (user) turn: remove the last `user` block and every
   * block after it (Herta speech/thought, → 系统 / → 差分协处理器, beats, markers)
   * from BOTH the in-memory record and the persisted JSONL. Returns the withdrawn
   * blocks (the first is the user block) so the caller can restore the user text
   * and inspect the span (e.g. for a backend file-edit warning), or `null` when
   * there is no user block to rewind to.
   *
   * Idle-only: the caller gates this on no in-flight turn (the driver never runs
   * concurrently with `runTurn`). Mirrors `loadRecord`'s per-turn state resets
   * (mood + meta-think anchors) so the next turn rebuilds cleanly against the
   * now-shorter record — the stale speak anchor could otherwise point past the
   * record's end.
   *
   * Filesystem side-effects from a withdrawn `@板砖` turn are NOT reverted — this
   * withdraws the record only (see 2026-06-21-rewind-last-turn spec, D-Record-only).
   * The one carve-out lives a layer up: SessionImpl garbage-collects the harness's
   * own stored attachment copies for attachment blocks in the withdrawn span
   * (`cleanUpWithdrawnAttachments`, amendment 2026-08-26) — user project files
   * stay untouched.
   */
  rewindLastUserTurn(): { userText: string; withdrawn: TerminalRecord } | null {
    let userIndex = -1;
    for (let i = this.record.length - 1; i >= 0; i--) {
      if (this.record[i]?.kind === "user") {
        userIndex = i;
        break;
      }
    }
    const userBlock = userIndex === -1 ? undefined : this.record[userIndex];
    if (userBlock === undefined || userBlock.kind !== "user") return null;
    const withdrawn = this.record.slice(userIndex);
    // Durable-first: truncate the persisted JSONL BEFORE mutating the in-memory
    // record, so a persister failure (disk full, permission denied) propagates
    // with BOTH still intact rather than leaving memory shortened ahead of disk
    // (which would desync the canonical record on the next resume).
    this.persister?.truncateToBlockCount(userIndex);
    this.record = this.record.slice(0, userIndex);
    // Recap-sidecar invalidation: when the truncation cuts at/below the
    // cached compaction boundary, the sidecar describes record state that no
    // longer exists. Validate-on-first-use would discard it on the next turn
    // anyway — deleting here just keeps a knowably-stale file from outliving
    // the rewind. A cache whose boundary survived (tail-only cut above it)
    // stays: its compacted span [0, boundary) is untouched.
    const recap = this.deps.recap;
    if (recap !== undefined) {
      const cached = recap.cacheRead();
      if (
        cached !== null &&
        (cached.boundaryIndex >= this.record.length ||
          this.record[cached.boundaryIndex]?.kind !== "user")
      ) {
        recap.cacheInvalidate?.();
      }
    }
    // Per-turn state resets (same as loadRecord): the next turn rebuilds mood +
    // meta-think anchors against the new, shorter record.
    this.currentIntentState = "默认";
    this.attachedMetaThink = null;
    this.turnsSinceSpeakAnchor = 0;
    return { userText: userBlock.text, withdrawn };
  }

  /**
   * Append a `→ 系统` note to the record OUT OF TURN, persist it, and flush it
   * to the live sink so the CLI + GUI show it immediately and it survives
   * resume. Used for workspace changes between turns. Safe because the driver
   * is single-threaded and this is only called between turns.
   */
  appendSystemNote(label: SystemBlockLabel, body: string): void {
    this.appendSystemBlock({ kind: "system", label, body });
  }

  /**
   * The same out-of-turn append for a block that carries structured fields —
   * attachments (ADR 0033), which need `digest` / `evidenceDetail` / `evidence`
   * that a label-and-body note cannot express.
   *
   * The caller owns sanitizing. Every producer of a system block does (the
   * bridge at construction, `ingestAttachment` before returning), because the
   * serializer does NOT sanitize system bodies at read — construction is the
   * only gate on this trust boundary.
   */
  /**
   * Replace one block in place — same index, same count (ADR 0033 attachment
   * removal). Persists the replacement and returns true when it landed.
   *
   * Does NOT flush the sink: the sink streams by a monotonic cursor over new
   * blocks, so a mutation behind that cursor is invisible to it. The caller
   * re-syncs the renderer instead (SessionImpl does, via resyncRecord).
   */
  replaceBlockAt(index: number, block: SystemBlock): boolean {
    if (index < 0 || index >= this.record.length) return false;
    const next = [...this.record];
    next[index] = block;
    this.record = next;
    this.persister?.replaceBlockAt(index, block);
    return true;
  }

  appendSystemBlock(block: SystemBlock): void {
    this.record = [...this.record, block];
    // D1: when the sink persists on flush, the flushBlocks below writes this
    // block (persisting here too would duplicate it). Otherwise persist now.
    if (!this.sinkPersists) this.persister?.appendBlock(block);
    this.deps.sink?.flushBlocks(this.record);
  }

  /**
   * Replace the internal record state. Used by `/resume` and by `main.ts`
   * on `--resume` startup. Loaded blocks are NOT replayed through the
   * persister — they're already on disk in the source file. The next
   * `runTurn` will append only its new blocks to the persister.
   *
   * **Contract for `/resume`:** callers loading a session must pair
   * `loadRecord(record)` with `setPersister(forResume({ sessionFile }))`
   * BEFORE the next `runTurn`. Without the persister swap, new blocks
   * written by the next turn go to the original session's file rather
   * than the loaded session's file. Task 4's `/resume` handler does both
   * in one call site.
   */
  loadRecord(record: TerminalRecord): void {
    this.record = record;
    this.currentIntentState = "默认";
    // Reset the meta-think attachment + speak-anchor counter. The
    // first post-resume turn will rebuild the attachment under
    // whatever state the router resolves, anchored at the loaded
    // record's length, and counts from zero again.
    this.attachedMetaThink = null;
    this.turnsSinceSpeakAnchor = 0;
  }

  /**
   * Swap the persister to point at a different file. Used by `/resume`
   * to redirect writes from the freshly-allocated new-session file to
   * the loaded session's file.
   */
  setPersister(persister: V2RecordPersister): void {
    this.persister = persister;
  }
}
