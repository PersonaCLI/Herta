// Shared contract of one actor turn — `ActorTurnDeps`, the `Surface` type,
// the record-carrying `ActorTurnAbortedError` and the per-turn dispatch
// budget. Extracted from actor-turn.ts on 2026-09-03 (owner's request: the
// file had grown to 3,200 lines); bodies and comments are verbatim. These
// live apart from the main loop because every extracted module needs them
// and none may import actor-turn.ts back (no cycles); actor-turn.ts
// re-exports them, so its public surface is unchanged.

import type {
  AgentEvent,
  CodingAgentRuntime,
  CompletionProviderAdapter,
  EventBus,
  PickedElement,
  ProviderAdapter,
  SystemBlock,
  TerminalRecord,
} from "@herta/core";
import type { ActorHints } from "./actor-hints.js";
import type { StaticHertaPrefix } from "./actor-prompt.js";
import type { AttachedMetaThink, MoodState } from "./meta-think.js";
import type { PromptLang } from "./prompt-lang.js";
import type { PreparedRecap, RecapRuntime } from "./session-recap-runtime.js";
import type { ActorStreamingSink } from "./streaming-sink.js";

/** The three sink calls a phase-2 stream makes — all a speculation's held
 *  indicator has to stand in for. */
export type PhaseTwoSink = Pick<
  ActorStreamingSink,
  "beginHertaStream" | "streamHertaToken" | "endHertaStream"
>;

/**
 * A first thought started EARLY, on a guess (ADR 0066 amendment 2026-09-21).
 * The contract lives here (types only — this module imports nothing of the
 * turn); `startThoughtSpeculation` in actor-turn-stream.ts is the one
 * implementation, and its doc comment is the full story.
 */
export interface ThoughtSpeculation {
  /** The exact prompt the request was made with. */
  readonly prompt: string;
  /** One-shot: the first caller gets the speculation, later ones nothing. */
  take(): ThoughtSpeculation | undefined;
  /** Make it the turn's thought: forward its indicator to `sink` from here
   *  on and resolve with its result (or reject as the ordinary call would). */
  adopt(
    sink: PhaseTwoSink | undefined,
  ): Promise<{ surface: Surface; text: string }>;
  /** Cancel the request. Idempotent; safe after `adopt` settled. */
  discard(): void;
}

export interface ActorTurnDeps {
  readonly provider: CompletionProviderAdapter;
  readonly model: string;
  /** Static Herta prefix, structured form. See `StaticHertaPrefix` in
   *  `actor-prompt.ts`. Built once at startup via
   *  `buildStaticHertaPrefix`; passed through the driver to the actor
   *  unchanged. */
  readonly staticPrefix: StaticHertaPrefix;
  /** Shared bus — backend events flow through here for projection. */
  readonly bus: EventBus<AgentEvent>;
  /** Factory that creates a fresh CodingAgentRuntime per `@板砖` invocation. */
  readonly runtimeFactory: () => CodingAgentRuntime;
  /** Outer abort signal; passed through to provider and backend. */
  readonly signal?: AbortSignal;
  /**
   * Attachment blocks the 开拓者 sent WITH this message (ADR 0048 §4) —
   * appended immediately after the user block, inside the turn's span, so the
   * picture and the words arrive as one episode and a rewind takes both.
   *
   * Already sanitized by their producer (`ingestAttachment` /
   * `captionStoredImage`), like every other system block: the serializer does
   * not sanitize at read, so construction is the only gate.
   */
  readonly userAttachments?: readonly SystemBlock[];
  /** The paths the user mentioned with the composer's `@` (ADR 0072
   *  amendment 2026-10-20): recorded on the user block. */
  readonly userMentions?: readonly string[];
  /** Elements picked on the page (ADR 0083 §4), recorded on the user block. */
  readonly userPicks?: readonly PickedElement[];
  /**
   * A 继续 turn (ADR 0071 §1.4): the user block is marked `resume`, and the
   * harness continues the interrupted 板砖 run (the bridge's `resume`) before
   * Herta says anything, as a typed `@板砖` dispatches.
   */
  readonly resume?: true;
  /** Max speech iterations before the loop terminates defensively. Default 5. */
  readonly maxIterations?: number;
  /**
   * Optional streaming sink (Slice 9). When provided, the actor:
   *   - calls sink.flushBlocks(record) at the start of each iteration
   *     (renders side-effect blocks from prior iterations);
   *   - calls sink.beginHertaStream(surface) once per block stream;
   *   - emits text-delta chunks via sink.streamHertaToken AS THEY ARRIVE,
   *     respecting safeEmitBoundary so partial stop sequences never reach
   *     stdout (thought surface: no-op in the sink implementation);
   *   - calls sink.endHertaStream() exactly once per Herta block stream
   *     (primary OR beat).
   *
   * When absent, behavior is identical to pre-Slice 9: buffers tokens
   * internally and commits an atomic herta block on `finish`.
   */
  readonly sink?: ActorStreamingSink;
  /**
   * Optional: fires ONCE per turn, at the start of the FIRST non-empty SPEECH
   * block's stream, with that block's leading text. Lets the caller play a
   * "particle" voice cue synced to the first character. Never fires for
   * thoughts, in-turn beats, the supervisor veto-retry replay, or later speech
   * blocks of the same turn (a per-turn latch). The driver omits it for
   * regenerate. See SPEC 2026-06-23 particle-voice.
   */
  readonly onPrimarySpeechStart?: (leadingText: string) => void;
  /**
   * Optional: fires at most ONCE PER TURN (per-turn latch), on the first
   * supervisor REJECTION of a candidate speech (verdict `block`), the instant
   * the rejection is known — before the retract. Note the supervisor itself
   * can veto more than once per turn (every supervised speech iteration is
   * checked, including post-@板砖 commentary); only the CLIP is latched.
   * Lets the caller play a "veto" voice clip (Herta catching herself). Fires
   * only on a real candidate rejection, never on the trigger re-pass recheck,
   * an OK verdict, or an unsupervised turn. The driver omits it for regenerate.
   * See SPEC 2026-06-23 veto-voice.
   */
  readonly onSupervisorVeto?: () => void;
  /**
   * Optional prompt-dump callback for debugging. Fires once per
   * `streamCompletion` call (both primary block streams and in-turn beat
   * streams), receiving a label identifying the call site:
   *   - "primary"     — main loop iteration prompt (request)
   *   - "primary-out" — same call: prompt + model's full completion
   *   - "beat"        — in-turn beat prompt fired during `@板砖` execution
   *   - "beat-out"    — beat prompt + model's full completion
   *   - "phase2"      — two-phase body prompt (request)
   *   - "phase2-out"  — phase2 prompt + model's full completion
   *   - "state"       — resolved mood state name (e.g. "默认"), one per turn
   *   - "state-out"   — router prompt + "---" + raw model output, dumped
   *                     once per turn before the resolved-state dump
   *   - "supervisor"     — supervisor prompt (system + "---评审消息---" +
   *                        user message). Fired BEFORE the provider
   *                        call begins, so the request side is captured
   *                        even when the response side fails.
   *   - "supervisor-out"  — supervisor prompt + "\n\n---\n\n" + raw
   *                        model output. Fires after the supervisor
   *                        call completes. On supervisor throw, the
   *                        output portion is the synthetic literal
   *                        `[supervisor failed: <error message>]`.
   *
   * The `prompt` argument is the literal bytes sent to DeepSeek's
   * completion endpoint (or, for *-out labels, prompt + completion).
   * Wired by main.ts when `HERTA_DUMP_PROMPTS` is truthy;
   * written to `<sessionId>.prompts/turn-NNN-<label>.txt`.
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
  /**
   * Fires with every completion prompt the turn asks for — each thought and
   * speech (the phase-2 funnel, an adopted speculative thought included) and
   * each beat. `runActorCompletionTurn` sets it to measure the turn for the
   * usage log (long-run study item 6); a caller's own hook still fires.
   */
  readonly onCompletionPrompt?: (prompt: string) => void;
  /**
   * The intent router's state (Slice 13). The actor runs in two-phase
   * mood-routing mode: every iteration always thinks first (（我 想）), then
   * the soft guard forces speech on the next iteration. Required since
   * 2026-09-03: the Slice 10 single-phase path that ran when this was
   * absent is gone (the driver has always routed — the meta-think corpus is
   * a compiled asset since M-prompts-1), so an absent state was only ever a
   * test's way of reaching that path.
   *
   * Two-phase mode is not gated on corpus presence — corpus content is the
   * driver's concern via `attachedMetaThink`. Two-phase + no attachment is a
   * valid configuration: think-then-speak rhythm without specific mood
   * guidance on a given turn.
   */
  readonly intentState: MoodState;
  /**
   * Optional meta-think attachment (Slice 13 sticky-positioned refactor).
   * Owned and managed by `V2ActorDriver`. When provided, the actor
   * splices the appropriate (pre_think or pre_speak) text into the
   * serialized record at the attachment's surface-specific splice
   * index before appending the open tag. The text is bare preamble
   * (no enclosing heading markers). When absent, no preamble is
   * emitted this turn — the model relies on prior turns' outputs
   * (which are in the serialized record) to maintain Herta's voice.
   *
   * The driver creates a new attachment when the routed state changes
   * or when the same-state attachment has gone stale (per
   * `META_THINK_REFRESH_INTERVAL` in `V2ActorDriver`). Same-state
   * non-refresh turns keep the existing attachment in place; the model
   * sees the meta-think at its original position earlier in the record.
   *
   * See `AttachedMetaThink` JSDoc for the full lifecycle contract.
   */
  readonly attachedMetaThink?: AttachedMetaThink;
  /**
   * Optional supervisor chat-mode provider (typically the same instance
   * as the router, or another `deepseekProvider({thinking: "high"})`
   * adapter). When set together with a non-empty `supervisorReference`,
   * the actor runs a supervisor check on every non-empty phase-2
   * speech before commit. When either is missing, the supervisor is
   * skipped entirely.
   */
  readonly supervisorProvider?: ProviderAdapter;
  /**
   * Authored supervisor reference content. Loaded once at startup via
   * `loadSupervisorReference`. Empty string disables the supervisor
   * (graceful "no reference authored" path).
   */
  readonly supervisorReference?: string;
  /**
   * ADR 0065: on a veto, ask the supervisor for the corrected line (改说)
   * and adopt it as the re-speak when it is usable — no rethink thought,
   * no respeak call, the retract floor known the moment the verdict lands.
   * An unusable or missing line takes the rethink + respeak path exactly
   * as before. Default false; `createActorStack` resolves the shipped
   * default and the `HERTA_SUPERVISOR_REVISION` override.
   */
  readonly supervisorRevision?: boolean;
  /** Editable actor hints, loaded from `.herta/narrative/hints/*.txt` at
   *  startup. Optional: when absent, resolves to `DEFAULT_ACTOR_HINTS`. */
  readonly hints?: ActorHints;
  /** When set, long-session compaction is active for this turn. Built at the
   *  app bootstrap (router summarizer + persisted cache). Undefined → no compaction. */
  readonly recap?: RecapRuntime;
  /** One-shot: force a recap re-derive this turn (the /compact command). */
  readonly forceCompact?: boolean;
  /**
   * Interaction language of LLM-facing prompt prose (slice 4). Threaded
   * into the supervisor check, the trigger re-pass recheck, and the
   * fallback hint set used when no `hints` dep is provided. Default
   * "zh" — byte-identical to pre-slice-4 prompts. Structural narrative
   * grammar tokens stay CN in both (D2/D7/D8).
   */
  readonly lang?: PromptLang;
  /** Recap precomputed by the driver BEFORE intent-routing, so the recap hint
   *  (recap.compaction start/end) fires at turn-start instead of after the
   *  router LLM call. When provided, the turn uses it as-is and the driver owns
   *  the notify; undefined (e.g. a direct test call) → the turn computes it
   *  inline below (firing the notify itself). */
  readonly precomputedRecap?: PreparedRecap;
  /** A first thought the driver started while the router was still
   *  classifying, under the mood it GUESSED (ADR 0066 amendment 2026-09-21).
   *  `runPhaseTwo` adopts it only if the prompt it builds for real is
   *  byte-identical; otherwise it is cancelled and ignored. Absent → the
   *  turn runs exactly as it always has. */
  readonly thoughtSpeculation?: ThoughtSpeculation;
}

/**
 * Per-turn dispatch budget (chained dispatch, 2026-07-10 — supersedes the
 * one-bridge-per-turn cap). Herta's post-run synthesis speech may carry a
 * follow-up `@板砖` that dispatches AGAIN within the same user turn — real
 * multi-step delegation ("跑完测试有一个挂了——@板砖 修掉"). The budget bounds
 * a self-exciting chain; a token beyond it is neutralized at commit exactly
 * like the old cap. Each dispatch also consumes a speech iteration, so
 * `maxIterations` (default 5) is a second independent bound. The user's
 * pre-empt dispatch counts against the budget. Beats NEVER dispatch
 * regardless (trigger-neutralized in makeFireBeat).
 */
export const MAX_DISPATCHES_PER_TURN = 3;

export type Surface = "speech" | "thought";

/**
 * Thrown when the turn's signal aborts at an iteration boundary — typically
 * an interrupt landing during (or right after) a @板砖 bridge run. Carries
 * the ACCUMULATED record so the driver can adopt the blocks the user already
 * saw (backend projections, beats, the done-marker) instead of discarding
 * the turn wholesale, while the turn still surfaces as failed/cancelled to
 * the session layer (interrupt semantics unchanged). `name` is "AbortError"
 * so generic isAbortError classification treats it as a cancellation.
 */
export class ActorTurnAbortedError extends Error {
  constructor(readonly partialRecord: TerminalRecord) {
    super("turn aborted");
    this.name = "AbortError";
  }
}
