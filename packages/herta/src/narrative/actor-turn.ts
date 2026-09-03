import type {
  ProviderAdapter,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import { makeFireBeat } from "./actor-turn-beat.js";
import {
  ActorTurnAbortedError,
  type ActorTurnDeps,
  MAX_DISPATCHES_PER_TURN,
  type Surface,
} from "./actor-turn-deps.js";
import {
  judgeTriggerAndNeutralize,
  runSupervisorVerdict,
  type SupervisorVerdict,
  startFirstPassJudge,
  wouldDispatch,
} from "./actor-turn-judges.js";
import { thoughtBeforeSpeechTag } from "./actor-turn-prompts.js";
import {
  abandonController,
  armAbortFlush,
  recoverEmptySpeech,
  recoverEmptyThought,
  runPhaseTwo,
  stripStrayOpenTags,
} from "./actor-turn-stream.js";
import { invokeBanzhuanBridge } from "./backend-bridge.js";
import { BeatPolicy } from "./beat-policy.js";
import { isUnusableBlock, retryCause } from "./block-shape.js";
import { commonPrefixLen } from "./common-prefix.js";
import { sanitizeActorText } from "./escape.js";
import { lastNTurnsForSupervisor } from "./intent-router.js";
import {
  neutralizeBanzhuanTrigger,
  parseHertaBlock,
  stripBanzhuanTrigger,
} from "./parse.js";
import {
  type PreparedRecap,
  prepareTurnRecap,
} from "./session-recap-runtime.js";
import type {
  LiveSlowStreamController,
  SlowStreamController,
} from "./streaming-sink.js";
import { buildSupervisorPrompt, sessionMarkerReceipts } from "./supervisor.js";
import { formatSelfCorrectionText } from "./thought-hint.js";

// Split on 2026-09-03 (owner's request: this file had grown to 3,200 lines).
// The turn's shared contract lives in actor-turn-deps.ts, the supervisor-side
// judgment calls in actor-turn-judges.ts, the stream consumers / runPhaseTwo /
// retry ladders in actor-turn-stream.ts, the prompt-side helpers in
// actor-turn-prompts.ts and makeFireBeat in actor-turn-beat.ts. Everything
// this module exported before the split stays importable from here.
export {
  ActorTurnAbortedError,
  type ActorTurnDeps,
  MAX_DISPATCHES_PER_TURN,
} from "./actor-turn-deps.js";

export interface ActorTurnState {
  record: TerminalRecord;
}

/** Leading speech code points buffered before the live path fires the particle
 *  voice. matchLeadingParticle needs at most the longest catalog token (2 cp)
 *  plus one following char to confirm the delimiter, so 3 is sufficient and the
 *  cue lands while the particle is on screen (SPEC particle-voice 2026-06-23). */
const PARTICLE_LEAD_LOOKAHEAD = 3;

/**
 * Supervisor VETO recovery: the veto voice latch, the retract of the visibly
 * streamed candidate, the two-stage rethink → respeak (2026-07-18), the
 * live-feed re-speak with its retract floor, the empty-respeak ladder, the
 * bounded trigger re-pass, and the re-speak's render finalize. Lifted out of
 * the main loop verbatim on 2026-08-19 (ADR 0041): it is one self-contained
 * arc over the iteration's mutable state, which it now takes in and returns
 * explicitly instead of closing over. Every interrupt path throws the
 * record-carrying `ActorTurnAbortedError` (audit 2026-07-13 T2.5) exactly
 * where it did inline — with `record` as of that moment (a committed
 * rethink thought included).
 */
async function recoverFromVeto(ctx: {
  deps: ActorTurnDeps;
  signal: AbortSignal;
  record: TerminalRecord;
  priorTurnLength: number;
  recap: PreparedRecap["recap"];
  recapBoundaryIndex: PreparedRecap["recapBoundaryIndex"];
  streamResult: { surface: Surface; text: string };
  supervisorVerdict: SupervisorVerdict;
  slowStreamController: SlowStreamController | undefined;
  currentTurnThought: string | undefined;
  supervisorProvider: ProviderAdapter;
  dispatchCount: number;
  vetoSignalled: boolean;
  supervisorVetoReasonForRecord: string | undefined;
}): Promise<{
  record: TerminalRecord;
  streamResult: { surface: Surface; text: string };
  /** Whether the committed speech text has yet to reach the sink (the
   *  caller's unified replay renders it iff still true). */
  speechSinkPending: boolean;
  vetoSignalled: boolean;
  supervisorVetoReasonForRecord: string | undefined;
}> {
  const {
    deps,
    signal,
    priorTurnLength,
    recap,
    recapBoundaryIndex,
    supervisorVerdict,
    slowStreamController,
    currentTurnThought,
    supervisorProvider,
    dispatchCount,
  } = ctx;
  let { record, streamResult, vetoSignalled, supervisorVetoReasonForRecord } =
    ctx;
  let speechSinkPending = false;
  // Veto voice (SPEC 2026-06-23): fire the instant the rejection is known,
  // BEFORE the retract — the "等等…" clip leads, then the text retracts and
  // rewrites. Latched to the FIRST veto of the turn: each supervised
  // speech iteration can veto (a multi-iteration @板砖 turn supervises
  // its commentary too), but the clip must not replay per veto.
  if (!vetoSignalled) {
    vetoSignalled = true;
    deps.onSupervisorVeto?.();
  }
  // Bug 2 (2026-06-27): the divergence the GUI erase will halt at is measured
  // against the text the user actually saw (the trimmed candidate that
  // slowStreamSpeech streamed). Capture it before the retry reassigns
  // streamResult. Stray-stripped (slice 4) to match the live stream,
  // which drops stray tags as they arrive.
  const vetoedShown = stripStrayOpenTags(streamResult.text, "speech");
  // Hand the visibly-streamed speech's retraction to the sink before
  // re-prompting. Sinks MAY block until their retract animation
  // completes (the CLI does); the GUI sink returns immediately and
  // morphs the rejected text into the retry as it streams.
  if (slowStreamController !== undefined) {
    await slowStreamController.cancelAndBackspace();
  }
  // Two-stage veto recovery, stage 1 (rethink-respeak, 2026-07-18):
  // before re-speaking, generate a FRESH （我 想） that digests the
  // veto reason and commit it to the record like any thought — the
  // respeak then sees it. Lab-measured (scripts/respeak-lab.mjs):
  // the single-stage reason-bearing respeak collapses on non-coding
  // vetoes (record vocabulary bleeding into e.g. a grief reply)
  // while the rethink flow lands ~6/9 good vs ~2.5/9. The thought
  // streams through the sink normally (visible re-think — the
  // thought indicator is the UX for the pause). Fail-soft: an
  // empty or failed rethink falls back to the single-stage
  // reason-bearing respeak below, so the veto path never gets
  // WORSE than the pre-rethink behavior.
  let rethinkCommitted = false;
  if (supervisorVerdict.reason !== undefined) {
    try {
      const rethinkResult = await runPhaseTwo({
        deps,
        record,
        priorTurnLength,
        surface: "thought",
        signal,
        supervisorRethinkReason: supervisorVerdict.reason,
        vetoedSpeech: streamResult.text,
        recap,
        recapBoundaryIndex,
      });
      const rethinkText = stripStrayOpenTags(
        rethinkResult.text,
        "thought",
      ).trim();
      if (rethinkText.length > 0) {
        // Same commit discipline as the main-loop thought commit:
        // sanitize at construction so disk, prompts, and every
        // projection inherit the safe text.
        record = [
          ...record,
          {
            kind: "herta",
            surface: "thought",
            text: sanitizeActorText(rethinkText, { role: "thought" }),
          },
        ];
        rethinkCommitted = true;
      }
    } catch (err) {
      if (signal.aborted) throw new ActorTurnAbortedError(record);
      // Fail-soft: the rethink is an enhancement, not a gate. Log
      // via the prompt-dump channel and take the single-stage path.
      deps.onPrompt?.(
        "phase2-out",
        `[rethink stage failed: ${err instanceof Error ? err.message : String(err)}]`,
      );
    }
  }
  // Retry phase-2 speech — after a committed rethink, with the slim
  // post-rethink hint (the reason lives in the fresh thought);
  // otherwise with the veto reason interpolated into the format
  // hint. Either way the rejected speech is replayed in the prompt
  // so the model can see what it's revising. Retry result commits
  // unconditionally — no second supervisor pass, no infinite loop.
  //
  // Live-feed the re-speak when the sink supports it: stream it to the
  // morph as it generates (first char at TTFT) instead of generating
  // silently and replaying afterward. Emit the retract floor the moment
  // the streamed re-speak diverges from the vetoed text. Sinks without
  // slowStreamSpeechLive keep the silent depsWithoutSink + replay path.
  // The raw re-speak streams as-is; a @板砖 the trigger re-pass later
  // neutralizes is corrected at commit (SPEC live-feed-veto-respeak §3/§5).
  const baseRetryOpts: Parameters<typeof runPhaseTwo>[0] = {
    deps,
    record,
    priorTurnLength,
    surface: "speech",
    signal,
    vetoedSpeech: streamResult.text,
    recap,
    recapBoundaryIndex,
  };
  if (rethinkCommitted) {
    // Stage 2 of the rethink flow: the reason already lives in the
    // committed fresh thought — the slim static respeak hint applies.
    baseRetryOpts.isPostRethinkRespeak = true;
  } else if (supervisorVerdict.reason !== undefined) {
    baseRetryOpts.supervisorVetoReason = supervisorVerdict.reason;
  }
  if (supervisorVerdict.reason !== undefined) {
    // Capture for the self-correction block (N8) in BOTH paths. Set
    // even if the retry later turns out empty — the commit-section
    // guard skips emitting the block when there's no speech
    // to anchor it to.
    supervisorVetoReasonForRecord = supervisorVerdict.reason;
  }

  let retryLive: LiveSlowStreamController | undefined;
  let retryFloorEmitted = false;
  if (deps.sink?.slowStreamSpeechLive !== undefined) {
    // Call ATTACHED — the live controller's internals use `this`
    // (this.beginHertaStream, this.bus, this.emitSpeech), so a detached
    // `const f = deps.sink.slowStreamSpeechLive; f()` loses the binding and
    // crashes in the tick. Matches the first-pass call site above.
    const live = deps.sink.slowStreamSpeechLive({});
    retryLive = live;
    let retryAccum = "";
    const onLiveToken = (chunk: string): void => {
      live.pushToken(chunk);
      retryAccum += chunk;
      if (!retryFloorEmitted) {
        // Skip the divergence check while the accumulation ends in an
        // unpaired high surrogate (a provider chunk can split a non-BMP
        // char): the half char would read as a false divergence and
        // latch a one-short floor. The next chunk completes the pair.
        const lastCode = retryAccum.charCodeAt(retryAccum.length - 1);
        if (lastCode >= 0xd800 && lastCode <= 0xdbff) return;
        const cp = commonPrefixLen(vetoedShown, retryAccum);
        // O(n²) over the stream but capped: stops at the first divergence,
        // and speech is short — negligible.
        if (cp < [...retryAccum].length) {
          // A chunk reaching here is past safeEmitBoundary (committed text),
          // so a fired floor implies a non-empty retry — this and the
          // empty-recovery replay floor are mutually exclusive: the floor is
          // emitted exactly once.
          deps.sink?.emitRetractFloor?.(cp);
          retryFloorEmitted = true;
        }
      }
    };
    try {
      streamResult = await runPhaseTwo({ ...baseRetryOpts, onLiveToken });
    } catch (err) {
      // Retry generation threw with the live re-speak controller
      // possibly holding pushed tokens: terminal-call it, then abort
      // record-carrying on interrupt (audit 2026-07-13 T2.5, same
      // D7 reasoning as the first-pass catch above).
      await abandonController(live);
      if (signal.aborted) throw new ActorTurnAbortedError(record);
      throw err;
    }
    if (streamResult.text.trim().length > 0) live.finishInput();
  } else {
    // No live primitive: the raw LLM stream must not hit the sink live.
    // Generate sink-less at full model speed; the FINAL retry text (post
    // recovery ladder, post trigger re-pass — so a neutralized token
    // streams exactly the way it commits) is replayed paced through
    // slowStreamSpeech below.
    const { sink: _retrySink, ...depsWithoutSink } = deps;
    streamResult = await runPhaseTwo({
      ...baseRetryOpts,
      deps: depsWithoutSink,
    });
  }
  // Strip stray open tags from the retry — the first pass is stripped
  // above, but the retry reassigned streamResult past that point, so a
  // retry re-emitting `（我 说）` streamed the literal tag to the user
  // and committed it into every future prompt. The live path settles
  // the corrected text at commit (same accepted-flicker mechanism as
  // the @板砖 neutralization, SPEC live-feed-veto-respeak §5).
  streamResult = {
    surface: streamResult.surface,
    text: stripStrayOpenTags(streamResult.text, streamResult.surface),
  };
  // Nothing has reached the sink yet (non-live), or the live controller
  // holds the stream — the finalize step below (or the one-shot unified
  // replay for sinks without slowStreamSpeech) renders the retry.
  speechSinkPending = true;

  // Empty-veto-retry recovery. The supervisor-veto retry uses
  // `buildSupervisorVetoHint(reason)` which is voice/intent-
  // correction focused; it doesn't address the empty-output
  // failure mode. If the model's veto-retry comes back empty
  // (e.g., it tried to "fix" the rejected speech by closing
  // immediately), fall through to the empty-speech retry
  // ladder — same recovery, rising temperature. Commits the
  // ladder's result unconditionally without a second supervisor
  // pass (per spec §2 "single retry per failure mode" — we've
  // already spent the veto retry; the ladder is the recovery
  // for the NEW failure mode introduced by an empty veto-retry).
  //
  // Defer streaming + render via the unified-replay step below
  // — the live-stream sink path already missed its chance
  // (streamResult was reassigned twice, the cursor isn't sync'd).
  // Slot-only counts as empty here too, and this site is the one that
  // matters most: the veto respeak commits WITHOUT a second supervisor
  // pass, so a degenerate `{需要说的话}` has no other guard. The
  // corrective veto hint is itself instruction-dense — exactly the
  // input that pushes a model toward emitting the slot.
  if (isUnusableBlock(streamResult.text)) {
    // The live re-speak was empty; abandon its controller (it pushed
    // nothing) and render the recovered text via the old replay path.
    retryLive = undefined;
    const vetoRetryCause = retryCause(streamResult.text);
    streamResult = await recoverEmptySpeech({
      ...(vetoRetryCause !== undefined ? { cause: vetoRetryCause } : {}),
      deps,
      record,
      priorTurnLength,
      signal,
      recap,
      recapBoundaryIndex,
    });
    // Same strip discipline as every other reassignment point.
    streamResult = {
      surface: streamResult.surface,
      text: stripStrayOpenTags(streamResult.text, streamResult.surface),
    };
    speechSinkPending = true;
  }

  // Bounded trigger re-pass (2026-06-11 trigger-discipline §3.2).
  // The veto retry commits without re-generation, so if it carries the
  // literal @板砖 token this is its ONLY look. Same judge and same
  // neutralize-on-block as the first pass now runs
  // (judgeTriggerAndNeutralize); the difference is only that here
  // there is no supervisor verdict to defer to.
  if (wouldDispatch(streamResult.text, dispatchCount)) {
    let judged: { text: string; reason?: string };
    try {
      judged = await judgeTriggerAndNeutralize({
        deps,
        supervisorProvider,
        signal,
        record,
        candidate: streamResult.text,
        thought: currentTurnThought,
      });
    } catch (err) {
      // Mirrors the first-pass gate's catch: an escaping throw is the
      // interrupt (the judge fail-softs everything else). The live
      // re-speak controller gets its terminal call first (undefined on
      // the empty-recovery path — abandonController tolerates that),
      // then the abort carries the record (audit 2026-07-13 T2.5, D7).
      // This teardown-then-throw was the OLD re-pass's own contract,
      // lost when 2026-07-29 folded it into the shared judge.
      if (signal.aborted) {
        await abandonController(retryLive);
        throw new ActorTurnAbortedError(record);
      }
      throw err;
    }
    if (judged.text !== streamResult.text) {
      streamResult = { ...streamResult, text: judged.text };
      if (judged.reason !== undefined) {
        supervisorVetoReasonForRecord =
          supervisorVetoReasonForRecord !== undefined
            ? `${supervisorVetoReasonForRecord}；${judged.reason}`
            : judged.reason;
      }
    }
  }

  // Finalize the re-speak render. Live path: the morph already filled from
  // the live deltas as the re-speak generated; emit the floor here only if
  // a strict-extension retry never diverged during streaming, then drain
  // the held tail at base cadence. The commit settles the bubble to
  // retryReplayText (so a trigger-neutralized @板砖 → `@板砖` is corrected
  // here — the accepted two-tick flicker). Non-live / empty-recovery path: emit
  // the floor on the final text and replay it paced, as before.
  const retryReplayText = streamResult.text.trim();
  if (retryLive !== undefined && retryReplayText.length > 0) {
    if (!retryFloorEmitted) {
      deps.sink?.emitRetractFloor?.(
        commonPrefixLen(vetoedShown, retryReplayText),
      );
    }
    // Interruptible drain (slice 3): the retry commits
    // unconditionally, so an abort here flushes rather than cancels.
    const disarm = armAbortFlush(signal, retryLive);
    try {
      await retryLive.fastForward();
    } finally {
      disarm();
    }
    speechSinkPending = false;
  } else {
    deps.sink?.emitRetractFloor?.(
      commonPrefixLen(vetoedShown, retryReplayText),
    );
    if (
      retryReplayText.length > 0 &&
      deps.sink?.slowStreamSpeech !== undefined
    ) {
      const replayCtl = deps.sink.slowStreamSpeech(retryReplayText);
      const disarm = armAbortFlush(signal, replayCtl);
      try {
        await replayCtl.fastForward();
      } finally {
        disarm();
      }
      speechSinkPending = false;
    }
  }
  // Sinks without slowStreamSpeech fall through with
  // speechSinkPending=true → the one-shot unified replay below.
  return {
    record,
    streamResult,
    speechSinkPending,
    vetoSignalled,
    supervisorVetoReasonForRecord,
  };
}

/**
 * Drive a single Herta turn in v0.2 narrative-completion mode: the always-
 * think → forced-speech rhythm (Slice 13.3), the user-typed `@板砖` pre-empt
 * that fires the bridge before any completion call, the per-turn dispatch
 * budget, the supervisor and its judges on every speech, and the beats a
 * dispatch fires in between. The Slice 10 single-phase path (an
 * autoregressive surface pick behind the `（我 ` branch tag) was removed on
 * 2026-09-03 — see the surface decision inside the loop.
 */
export async function runActorCompletionTurn(
  state: ActorTurnState,
  userText: string,
  deps: ActorTurnDeps,
): Promise<ActorTurnState> {
  const maxIterations = deps.maxIterations ?? 5;
  const signal = deps.signal ?? new AbortController().signal;

  // Snapshot the pre-turn record length. Thoughts at indices BELOW this
  // boundary are filtered out of every prompt this turn builds — they're
  // prior-turn planning that doesn't help current reasoning. Thoughts at
  // indices >= this boundary are CURRENT-turn thoughts (committed by an
  // earlier iteration of this same call) and stay visible.
  const priorTurnLength = state.record.length;

  // Images the 开拓者 sent WITH this message land immediately after their
  // user block (ADR 0048 §4). Inside the turn's span, so the picture and the
  // words it came with are one episode: Herta reads them together, and a
  // rewind withdraws them together. Empty for every turn without attachments.
  let record: TerminalRecord = [
    ...state.record,
    { kind: "user", text: userText },
    ...(deps.userAttachments ?? []),
  ];

  // Long-session compaction (2026-05-24). Computed EXACTLY ONCE per turn,
  // right after the user block is appended: the recap summarizes history
  // *before* this turn, so any blocks appended later in the turn (thoughts,
  // speech, system/差分协处理器 projections, beats) are always in the verbatim
  // window (index >= recapBoundaryIndex) and never compacted away. Every
  // ActorPrompt the turn builds carries these same once-computed values; the
  // serializer drops blocks below the boundary and renders the recap as a
  // `### 记录：先前` section. When `deps.recap` is undefined, `prepareTurnRecap`
  // returns `{ recapBoundaryIndex: 0 }` (recap undefined) → byte-identical to
  // the no-compaction prompt.
  const { recap, recapBoundaryIndex } =
    deps.precomputedRecap ??
    (await prepareTurnRecap(
      record,
      deps.staticPrefix,
      deps.recap,
      deps.forceCompact === true,
      signal,
      (phase) =>
        deps.bus.publish({ type: "recap.compaction", layer: "actor", phase }),
    ));

  // Dispatch budget (2026-07-10, chained dispatch — supersedes the
  // one-bridge-per-turn cap): Herta's post-run synthesis speech may
  // legitimately carry a follow-up `@板砖` ("测试挂了一个——@板砖 修掉"), so a
  // live token in MAIN-LOOP speech now dispatches again, chaining runs
  // within one user turn. Two bounds keep it deterministic: this hard cap
  // (beyond it the token is neutralized at commit, exactly like the old
  // cap), and `maxIterations` on speech commits. BEATS still never
  // dispatch — every committed beat is trigger-neutralized in makeFireBeat,
  // and the bridge's per-bus latch would refuse a re-entrant run regardless.
  let dispatchCount = 0;

  // -- User-typed @板砖 pre-empt (SPEC §7) ------------------------------
  // Backtick-aware, same scanner as Herta-authored speech (2026-07-04,
  // superseding the 2026-06-11 "deliberately literal" gate): a
  // backticked `@板砖` is quotation on EVERY channel. The GUI composer
  // already renders the backticked form as plain text — no delegation
  // chip (2026-06-16 mention-composer spec) — so dispatching on it
  // made the runtime contradict what the composer told the user.
  // A quoted-only message ("`@板砖` 是什么？") now goes to Herta as a
  // normal turn; she can still delegate herself if it's actually a
  // task. stripBanzhuanTrigger below matches: it removes only bare
  // triggers, so a quoted span stays part of the brief text.
  if (parseHertaBlock(userText).hasBanzhuanTrigger) {
    const brief = stripBanzhuanTrigger(userText).trim();
    if (brief.length > 0) {
      deps.sink?.flushBlocks(record);
      const policy = new BeatPolicy();
      const fireBeat = makeFireBeat(
        deps,
        priorTurnLength,
        recap,
        recapBoundaryIndex,
      );
      record = await invokeBanzhuanBridge(record, [], {
        bus: deps.bus,
        runtimeFactory: deps.runtimeFactory,
        lang: deps.lang,
        signal,
        beatPolicy: policy,
        fireBeat,
        sink: deps.sink,
      });
      dispatchCount += 1;
    }
  }

  // -- Main loop -----------------------------------------------------------
  let speechIterations = 0;
  // Particle voice: fire onPrimarySpeechStart for the FIRST non-empty speech
  // block of the turn only. Latched so later speech blocks, the veto-retry
  // replay, and beats never re-fire. See SPEC 2026-06-23 particle-voice.
  let particleSignalled = false;
  // Per-turn latch for the veto voice clip: the supervisor runs on EVERY
  // supervised speech iteration (post-@板砖 commentary included), so a turn
  // can veto more than once — but the "等等…" clip firing twice in one turn
  // reads as a glitch, not a personality beat. First veto only.
  let vetoSignalled = false;
  let consecutiveThoughts = 0;
  // Tracks consecutive iterations where the phase-2 thought call
  // (plus its inline retry) returned empty content. Used to break out
  // of an empty-thought spin: after one such iteration we force the
  // next iteration into speech so the turn still produces output.
  let consecutiveEmptyThoughtIters = 0;

  while (speechIterations < maxIterations) {
    // Abort at an iteration boundary: an interrupt that landed during (or
    // right after) a @板砖 bridge run must not throw the whole turn away.
    // The projected → 系统 / → 差分协处理器 blocks, beats, and done-marker
    // are already ON SCREEN, and the backend's repo mutations persist — but
    // letting the next provider call throw on the dead signal discarded the
    // accumulated record (the driver keeps its pre-turn copy on a plain
    // throw), so screen, memory, and disk diverged and next turn's prompt
    // carried no trace the backend ever ran (D7/§9). Throw a record-carrying
    // abort instead: the driver adopts the blocks, the session still emits
    // turn.failed (interrupt semantics unchanged).
    if (signal.aborted) throw new ActorTurnAbortedError(record);
    deps.sink?.flushBlocks(record);

    // Slice 13.2: max ONE thought per segment. After a single
    // `（我 想）` commits, the next iteration is forced to speech with
    // pre_speak meta-think — Herta deliberates ONCE, then acts.
    // Was originally `>= 2` (allow two consecutive thoughts) but in
    // practice multi-thought chains read as Herta "stuck in her head".
    // Tightening to 1 makes the rhythm think → speak, never
    // think → think → speak.
    //
    // `consecutiveEmptyThoughtIters >= 1` ALSO forces speech: if the
    // last iteration's phase-2 thought (plus its inline retry) came
    // back empty, give up on thinking for this turn and produce a
    // speech directly. Prevents an infinite spin on the same thought
    // prompt when the model keeps emitting `（/我 想）` at position 0.
    const forceSpeech =
      consecutiveThoughts >= 1 || consecutiveEmptyThoughtIters >= 1;

    // Slice 13.3: Herta ALWAYS thinks before speaking. There's no RNG and no
    // model-decide branch — the soft guard alternates: iteration 1 = thought,
    // iteration 2 (forced) = speech, and after each speech the loop typically
    // terminates (no side effects) or repeats the cycle (side effects → loop
    // → another thought → speech).
    //
    // Rationale: Herta's character (per the pre_think corpus) is a
    // decision-tree planner. Going straight to speech without a deliberation
    // pass produces stylistically plausible but contextually weak responses
    // (model just leans on few-shot conditioning). The always-think rhythm
    // forces "what's actually being asked / what's my decision?" through
    // pre_think before the speech is generated.
    //
    // This is the only rhythm (2026-09-03). The Slice 10 single-phase path —
    // an autoregressive surface pick via the `〔接下来〕` hint, taken when no
    // `intentState` was supplied — was removed: the meta-think corpus has been
    // a compiled asset since M-prompts-1 (2026-07-05), so the driver has
    // always routed, and the path ran only in tests.
    const surface: Surface = forceSpeech ? "speech" : "thought";

    // Compute supervisor enablement once for this iteration. When
    // enabled AND the upcoming call is phase-2 speech, the sink is
    // deferred so the candidate is buffered silently until the verdict.
    // On OK the caller replays to the sink; on veto the retry streams
    // normally (supervisor-veto retry is unsupervised per §6.4).
    // Empty-speech retry follows a different rule: same-state retry
    // is unsupervised and streams live; state-transition retry IS
    // supervised and re-uses the defer/slow-stream path (see the
    // empty-speech-retry block below).
    const supervisorEnabled =
      surface === "speech" &&
      deps.supervisorProvider !== undefined &&
      deps.supervisorReference !== undefined &&
      deps.supervisorReference.length > 0;

    // Live-feed the supervised first-pass speech when the sink supports it:
    // open the paced controller BEFORE generation so tokens stream in at TTFT.
    // verdictPending is hoisted here (the supervisor block below resolves it).
    const useLiveFeed =
      supervisorEnabled && deps.sink?.slowStreamSpeechLive !== undefined;
    let liveFeedActive = useLiveFeed;
    let resolveVerdictPending: () => void = () => {};
    const hoistedVerdictPending = useLiveFeed
      ? new Promise<void>((resolve) => {
          resolveVerdictPending = resolve;
        })
      : undefined;
    const liveController =
      useLiveFeed && deps.sink?.slowStreamSpeechLive !== undefined
        ? deps.sink.slowStreamSpeechLive(
            hoistedVerdictPending !== undefined
              ? { verdictPending: hoistedVerdictPending }
              : {},
          )
        : undefined;

    // Particle voice (live path): the live reveal shows the leading particle at
    // TTFT, so fire onPrimarySpeechStart from the first revealed chars — keeping
    // the wav synced to the on-screen particle — instead of post-generation (the
    // non-live fire below, which stays synced there because the non-live reveal
    // can't begin until the candidate is buffered). PARTICLE_LEAD_LOOKAHEAD code
    // points are enough for the matcher; a speech shorter than that never trips
    // this and falls through to the post-generation fire.
    let liveLeadBuf = "";
    const onLiveSpeechToken = (chunk: string): void => {
      liveController?.pushToken(chunk);
      if (particleSignalled) return;
      liveLeadBuf += chunk;
      if ([...liveLeadBuf].length >= PARTICLE_LEAD_LOOKAHEAD) {
        particleSignalled = true;
        deps.onPrimarySpeechStart?.(liveLeadBuf.trim());
      }
    };

    let streamResult: { surface: Surface; text: string };
    try {
      streamResult = await runPhaseTwo({
        deps,
        record,
        priorTurnLength,
        surface,
        signal,
        ...(useLiveFeed
          ? { onLiveToken: onLiveSpeechToken }
          : { deferStreaming: supervisorEnabled }),
        recap,
        recapBoundaryIndex,
      });
    } catch (err) {
      // Generation threw (interrupt, provider error) with the live first-pass
      // controller possibly holding pushed tokens and an armed timer: give it
      // its exactly-one terminal call so the sink's stream isn't left parked
      // (begin without end / a hold nothing can release), then re-throw.
      await abandonController(liveController);
      // Interrupt mid-generation → record-carrying abort (audit 2026-07-13
      // T2.5, mirrors the iteration-boundary check at the loop head): after
      // a committed @板砖 dispatch the accumulated blocks are already on
      // screen and disk; a raw throw reverts the driver to its pre-turn
      // record and the next prompt loses the backend run (D7).
      if (signal.aborted) throw new ActorTurnAbortedError(record);
      throw err;
    }

    // Live-feed: generation is complete; total is now known to the controller.
    if (useLiveFeed) liveController?.finishInput();

    // Whether the eventual committed speech text has yet to be
    // rendered to the sink. True when the sink was either:
    //   - deferred during the phase-2 speech call (supervisor enabled), or
    //   - given a thought-indicator only because the call was thought-
    //     surface but produced merged thought+speech content (set below
    //     by the merge-detection branch).
    // Reset to false the moment the sink takes the speech text, either
    // via a downstream LLM call that streamed live (empty-speech retry,
    // veto retry) or via the unified replay step right before commit.
    let speechSinkPending = supervisorEnabled && !useLiveFeed;

    // Captured supervisor veto reason for the self-correction note
    // appended to the record before the retry's speech block
    // (N8, 2026-05-23). When supervisor vetoes and the retry runs,
    // the discarded rejected speech + veto reason would otherwise
    // be lost — the model has no memory of the correction on the
    // next turn, and the same mistake (e.g. calling 瓦尔特 by 杨叔)
    // tends to repeat. The self-correction block surfaces the
    // lesson into the persistent record so future-turn prompts
    // include it as concrete context.
    let supervisorVetoReasonForRecord: string | undefined;

    // Empty-thought retry ladder. When phase-2 thought returns an
    // empty body (the model emits `（/我 想）` at position 0 —
    // typically because it treats the preceding meta-think preamble
    // as the whole thought), fall into `recoverEmptyThought`. The
    // helper runs up to 3 retries with rising temperature and
    // varying hint angles (`PHASE_TWO_THOUGHT_RETRY_HINTS` variants
    // 0/1/2: base / specific-anchor / mechanical-force) to break the
    // model out of the deterministic-empty-output rut.
    //
    // The final result is used as-is; if it's still empty, the
    // empty-thought handling further down increments
    // `consecutiveEmptyThoughtIters` and the next loop iteration is
    // forced into speech (see the `forceSpeech` definition near the
    // top of the loop).
    if (
      streamResult.surface === "thought" &&
      isUnusableBlock(streamResult.text)
    ) {
      const thoughtCause = retryCause(streamResult.text);
      streamResult = await recoverEmptyThought({
        ...(thoughtCause !== undefined ? { cause: thoughtCause } : {}),
        deps,
        record,
        priorTurnLength,
        signal,
        recap,
        recapBoundaryIndex,
      });
    }

    // `（我 说）` inside a thought-surface stream is NOT a real surface
    // switch to promote. The phase-2 thought prompt's own instructions
    // reference the tag ("写完 （/我 想） 就停笔——不要继续写 （我 说） …"),
    // and Herta routinely echoes that language while planning her reply
    // ("接着在 `（我 说）` 里，我需要把上面几段合并成自然口语 …"). The old
    // merge detector treated any `（我 说）` substring as a real speech
    // block, split there, and shipped the post-tag planning prose to the
    // user as Herta's line (2026-06-14 turn-013 dump). She also sometimes
    // genuinely rolls into speech without closing `（/我 想）`. In BOTH
    // cases we do the same thing per the user's directive: discard
    // everything from `（我 说）` on, keep the prefix as a normally-
    // completed thought, and let the next (forced-speech) iteration
    // generate the real speech fresh — never promote the clipped tail.
    // Surface stays "thought" so the normal thought-commit path below
    // handles it, including the empty-prefix case (a thought that was
    // nothing but a `（我 说）…` roll-in commits no block and just
    // advances into the forced-speech iteration).
    if (
      streamResult.surface === "thought" &&
      streamResult.text.includes("（我 说）")
    ) {
      streamResult = {
        surface: "thought",
        text: thoughtBeforeSpeechTag(streamResult.text),
      };
    }

    // Strip stray duplicate open tags from the model's output. The
    // model sometimes re-emits the surface open tag mid-output (e.g.
    // `[part 1] （我 想） [part 2] （/我 想）` or
    // `[s1] （我 说） [s2] （/我 说）`), which would otherwise leak the
    // literal tag into the committed block text and into next turn's
    // prompt. Treat the inner open tag as cruft: drop it and let the
    // surrounding whitespace join the parts. Surface-aware:
    // thought-surface text only strips `（我 想）` here (the merge
    // detector above already consumed `（我 说）` if it was the marker);
    // speech-surface text strips both `（我 说）` and a defensive
    // `（我 想）` in case the model wandered across surfaces.
    streamResult = {
      surface: streamResult.surface,
      text: stripStrayOpenTags(streamResult.text, streamResult.surface),
    };

    // Empty-speech retry ladder. When phase-2 speech returns an empty
    // body (typically because a verbose, conclusive thought caused the
    // model to assign very high probability to closing the speech tag
    // immediately at position 0), retry with `PHASE_TWO_SPEECH_RETRY_HINT`
    // and a rising temperature ladder. See `recoverEmptySpeech` for
    // the details — same helper is reused in the supervisor-veto-retry
    // path below when the veto-retry itself comes back empty.
    //
    // Streaming + supervision: retries ALWAYS defer streaming and pass
    // through the supervisor block. As of 2026-05-23 the supervisor
    // checks every non-empty user-visible speech regardless of whether
    // it came from the initial attempt or an empty-speech retry —
    // there's no longer a "trust the corrective hint, skip supervisor"
    // carve-out. The retry text isn't visible to the user until the
    // supervisor either approves (slow-stream fast-forwards) or vetoes
    // (cancelAndBackspace + veto-retry).
    if (
      streamResult.surface === "speech" &&
      // Slot-only counts as empty (2026-08-12): a completion that emits
      // `{需要说的话}` produced no content, and every path that skips the
      // supervisor would otherwise commit it verbatim.
      isUnusableBlock(streamResult.text)
    ) {
      const cause = retryCause(streamResult.text);
      // This branch's live-controller handling was built on "empty ⇒ zero
      // tokens pushed ⇒ the controller drained on its own". A SLOT first
      // pass breaks that premise (review 2026-08-12): its characters WERE
      // pushed and are being revealed on screen, and without a terminal call
      // the controller parks in its verdict hold while the replay below
      // renders the recovered speech next to the placeholder. Retract it,
      // veto-style, before recovering. Empty keeps the drain path untouched;
      // abandonController tolerates an undefined (non-live) controller.
      if (cause === "slot") {
        await abandonController(liveController);
      }
      streamResult = await recoverEmptySpeech({
        ...(cause !== undefined ? { cause } : {}),
        deps,
        record,
        priorTurnLength,
        signal,
        recap,
        recapBoundaryIndex,
      });
      // The ladder's output re-enters the normal pipeline AFTER the strip ran
      // on the first pass — re-strip so a recovered speech that re-emits the
      // open tag doesn't leak it (same reasoning as the veto retry below).
      streamResult = {
        surface: streamResult.surface,
        text: stripStrayOpenTags(streamResult.text, streamResult.surface),
      };
      // Buffered text awaits the supervisor's verdict — must be
      // rendered via the unified-replay or slow-stream path, not
      // bypassed.
      speechSinkPending = true;
      // Render the recovered speech via the non-live paced replay below. The
      // live controller is settled either way: an EMPTY first pass pushed
      // nothing and drained on its own; a SLOT first pass was retracted via
      // abandonController above. The hoisted verdict gate is moot for both.
      liveFeedActive = false;
    }

    // Particle voice (SPEC 2026-06-23): fire onPrimarySpeechStart for the turn's
    // FIRST non-empty speech. The live path already fired this from the first
    // revealed chars (onLiveSpeechToken above, synced to the on-screen particle),
    // so this is the fire for the non-live path — and the
    // fallback for a live speech shorter than PARTICLE_LEAD_LOOKAHEAD. The
    // particleSignalled latch keeps it to the first speech block; the downstream
    // veto-retry replay and beats never reach this point, so they never fire.
    if (
      !particleSignalled &&
      streamResult.surface === "speech" &&
      streamResult.text.trim().length > 0
    ) {
      particleSignalled = true;
      deps.onPrimarySpeechStart?.(streamResult.text.trim());
    }

    // Supervisor check (Slice: supervisor). Runs on EVERY non-empty
    // phase-2 speech with the supervisor enabled — including the
    // empty-speech retry's output. Pre-2026-05-23 a same-state retry
    // bypassed the supervisor (the "trust the corrective hint" carve-
    // out from spec §6.4). Empirically that let bad retries ship
    // unchecked, and the state-transition exception only patched the
    // narrow subset of high-risk turns. Always-supervise is the
    // principled version: the supervisor's purpose is to gate user-
    // visible speech, and a retry's output is just as user-visible as
    // an initial attempt's.
    //
    // The empty-speech retry above sets `deferStreaming: true`, so the
    // sink hasn't seen the retry's text. The supervisor block drives
    // rendering: slowStreamSpeech + fastForward on OK, or
    // cancelAndBackspace + supervisor-veto-retry on VETO.
    if (
      streamResult.surface === "speech" &&
      streamResult.text.trim().length > 0 &&
      deps.supervisorProvider !== undefined &&
      deps.supervisorReference !== undefined &&
      deps.supervisorReference.length > 0
    ) {
      // Capture supervisorProvider into a local const so TypeScript's
      // narrowing survives across `await` boundaries below.
      const supervisorProvider = deps.supervisorProvider;

      // Find the most recent thought block from the CURRENT turn for
      // the supervisor's intent-alignment reference. Walk backwards
      // through the record from the end down to priorTurnLength.
      let currentTurnThought: string | undefined;
      for (let i = record.length - 1; i >= priorTurnLength; i--) {
        const block = record[i];
        if (
          block !== undefined &&
          block.kind === "herta" &&
          block.surface === "thought"
        ) {
          currentTurnThought = block.text;
          break;
        }
      }

      // Build the prompt locally so we can fire onPrompt("supervisor", ...)
      // BEFORE the provider call begins. This way the prompt side of
      // the diagnostic dump is captured even when streamChat throws.
      const { prompt: supervisorPrompt, frame: supervisorFrame } =
        buildSupervisorPrompt({
          // Supervisor needs system blocks (→ 系统 / → 差分协处理器)
          // alongside speech turns so it can verify Herta's
          // candidate speech is grounded in what just happened
          // (file contents, dir listings, backend reports). Uses
          // `lastNTurnsForSupervisor`, NOT the router's
          // `lastNSpeechTurns` which strips system blocks for the
          // mood classifier. See SPEC v0.2 Supervisor design §5.1.
          recentRecord: lastNTurnsForSupervisor(record, 8),
          currentState: deps.intentState ?? "默认",
          ...(currentTurnThought !== undefined ? { currentTurnThought } : {}),
          candidateSpeech: streamResult.text,
          // Same 废案 the actor loaded this session → the supervisor grounds
          // 废案-sourced facts instead of blocking them as 事件/关系编造.
          feianFewShots: deps.staticPrefix.fewShots,
          // Full-session 板砖 completion receipts (2026-07-17): rule 9's
          // receipt check must see markers older than the 8-block window,
          // or a legitimate reference to earlier completed work reads as
          // fabrication and gets falsely vetoed.
          sessionReceipts: sessionMarkerReceipts(record),
          lang: deps.lang ?? "zh",
        });
      deps.onPrompt?.("supervisor", supervisorPrompt);

      // Verdict-pending gate + paced controller. The gate is a promise that
      // resolves once the supervisor stream is done (OK, veto, or fail-soft);
      // the paced controller throttles its per-char cadence in the back half of
      // the speech while the verdict is still pending — keeps the visible
      // stream moving through the supervisor wait instead of finishing early
      // and leaving the user staring at a "rendered but possibly about to
      // retract" state. See `SLOW_STREAM_VERDICT_PENDING_*` constants in
      // `narrative-renderer.ts`.
      //
      // Live-feed reuses the controller opened (and fed) before/during
      // generation, plus its hoisted verdict gate (`resolveVerdictPending`
      // already targets `hoistedVerdictPending`). The non-live path creates the
      // gate here and kicks off the paced replay of the fully-buffered
      // candidate — trim before passing so the live char-by-char animation
      // doesn't emit a leading `\n` (blank line above the speech) or trailing
      // whitespace before endHertaStream's `\n`. When the sink supports neither
      // primitive, `slowStreamController` stays undefined and the verdict
      // branches below fall through to the "defer + unified replay" path.
      let slowStreamController: SlowStreamController | undefined;
      if (liveFeedActive && liveController !== undefined) {
        slowStreamController = liveController;
        // resolveVerdictPending already targets hoistedVerdictPending.
      } else {
        // Reassigns the HOISTED resolveVerdictPending (do NOT add `let` here) —
        // the supervisor's `finally` below resolves this same binding.
        const verdictPending = new Promise<void>((resolve) => {
          resolveVerdictPending = resolve;
        });
        slowStreamController =
          deps.sink?.slowStreamSpeech !== undefined
            ? // Stray-stripped (slice 4): the replay streams the same text
              // the commit stores — a stray tag never types then vanishes.
              deps.sink.slowStreamSpeech(
                stripStrayOpenTags(streamResult.text, "speech"),
                { verdictPending },
              )
            : undefined;
      }
      if (slowStreamController !== undefined) {
        // The slow-stream is taking responsibility for rendering;
        // the unified-replay step below must NOT also render.
        speechSinkPending = false;
      }

      // The supervisor call (deadline, judgment-window bracket, fail-soft and
      // the interrupt teardown all live in runSupervisorVerdict). Always open
      // the slow-stream's verdict-pending gate when it returns — or throws —
      // regardless of OK / veto / fail-soft outcome: the slow-stream uses
      // this signal only to switch cadence; the verdict-driven branching
      // (fastForward vs cancelAndBackspace) happens below.
      //
      // The first-pass judge (trigger gate 2026-07-29 / missing-dispatch,
      // ADR 0036) is started right behind it and read only once the verdict
      // is in — see startFirstPassJudge. The supervisor is started FIRST so
      // the provider sees the two calls in the order it always has.
      const verdictInFlight = runSupervisorVerdict({
        deps,
        supervisorProvider,
        supervisorPrompt,
        supervisorFrame,
        signal,
        record,
        controller: slowStreamController,
      });
      const judge = startFirstPassJudge({
        deps,
        supervisorProvider,
        signal,
        record,
        candidate: streamResult.text,
        thought: currentTurnThought,
        dispatchCount,
      });
      let supervisorVerdict: SupervisorVerdict;
      try {
        supervisorVerdict = await verdictInFlight;
      } catch (err) {
        // The supervisor throws only on interrupt, and the judge's own
        // signal aborts with the turn — let it settle so its window closes
        // and its dump lands before the abort leaves this turn.
        await judge?.settled;
        throw err;
      } finally {
        resolveVerdictPending();
      }

      // Both judges are fail-soft on everything EXCEPT an aborted turn, so
      // an escaping throw is the interrupt. Same contract as the supervisor
      // catch: the parked slow-stream gets its terminal call, then the abort
      // carries the record (audit 2026-07-13 T2.5) — a raw rethrow reverts
      // the driver to its pre-turn record, losing blocks an earlier @板砖
      // dispatch in this turn already put on screen and disk (D7).
      const rethrowJudgeFailure = async (error: unknown): Promise<never> => {
        if (signal.aborted) {
          await abandonController(slowStreamController);
          throw new ActorTurnAbortedError(record);
        }
        throw error;
      };

      if (judge !== undefined && supervisorVerdict.verdict === "block") {
        // A vetoed candidate is being rewritten anyway; the judge's answer
        // is about text that is going away, and the re-speak gets its own
        // pass at the bottom of recoverFromVeto. Settled, not awaited for
        // its content — usually already done, the judge being the faster
        // call.
        await judge.settled;
      } else if (judge?.kind === "trigger") {
        // First-pass trigger gate. A speech the supervisor PASSED can still
        // be carrying a `@板砖` that was never meant to dispatch — see
        // judgeTriggerAndNeutralize for the live miss and the numbers.
        const outcome = await judge.settled;
        if (!outcome.ok) await rethrowJudgeFailure(outcome.error);
        else if (outcome.value.text !== streamResult.text) {
          streamResult = { ...streamResult, text: outcome.value.text };
          const reason = outcome.value.reason;
          if (reason !== undefined) {
            supervisorVetoReasonForRecord =
              supervisorVetoReasonForRecord !== undefined
                ? `${supervisorVetoReasonForRecord}；${reason}`
                : reason;
          }
        }
      } else if (judge?.kind === "missing") {
        // Missing-dispatch judge (ADR 0036) — see runMissingDispatchJudge.
        // A BLOCK folds into the supervisor veto below.
        const outcome = await judge.settled;
        if (!outcome.ok) await rethrowJudgeFailure(outcome.error);
        else if (outcome.value !== null) supervisorVerdict = outcome.value;
      }

      if (supervisorVerdict.verdict === "block") {
        // See recoverFromVeto — the whole veto arc, over this iteration's
        // state, returned explicitly.
        const recovered = await recoverFromVeto({
          deps,
          signal,
          record,
          priorTurnLength,
          recap,
          recapBoundaryIndex,
          streamResult,
          supervisorVerdict,
          slowStreamController,
          currentTurnThought,
          supervisorProvider,
          dispatchCount,
          vetoSignalled,
          supervisorVetoReasonForRecord,
        });
        record = recovered.record;
        streamResult = recovered.streamResult;
        speechSinkPending = recovered.speechSinkPending;
        vetoSignalled = recovered.vetoSignalled;
        supervisorVetoReasonForRecord = recovered.supervisorVetoReasonForRecord;
      } else if (slowStreamController !== undefined) {
        // Verdict OK (or fail-soft). Drain whatever's left of the
        // slow-stream at min cadence so the user sees the speech
        // finish naturally. Interruptible (slice 3): a stop click during
        // this drain flushes the tail in one delta instead of locking the
        // turn until the paced drain finishes.
        const disarm = armAbortFlush(signal, slowStreamController);
        try {
          await slowStreamController.fastForward();
        } finally {
          disarm();
        }
      }
      // When there is no slow-stream controller, verdict OK (or fail-soft
      // to OK) falls through to the unified replay step below, which
      // renders the pending speech to the sink iff `speechSinkPending`
      // is still true.
    }

    // Unified sink replay for pending speech. Fires exactly when the
    // committed speech text has not yet reached the sink — either the
    // initial speech call was sink-deferred (supervisor enabled), or
    // the speech was split out of a merged thought call. Re-uses the
    // sink's begin/token/end protocol so the sink cursor advances by
    // one position to claim the speech block. Trim before emitting
    // so the unified replay matches the streaming-time behavior and
    // doesn't reintroduce blank lines.
    if (speechSinkPending && streamResult.surface === "speech") {
      // Stray-stripped (slice 4) — the one-shot replay must match the commit.
      const replayText = stripStrayOpenTags(streamResult.text, "speech");
      if (replayText.length > 0) {
        deps.sink?.beginHertaStream("speech");
        deps.sink?.streamHertaToken(replayText);
        deps.sink?.endHertaStream();
      }
      speechSinkPending = false;
    }

    // Stray-strip BEFORE the emptiness checks (fence-fuzz, 2026-07-09): a
    // body that is nothing but stray open tags strips to empty and must
    // take the empty-thought / empty-speech path (redirect / graceful end).
    // The pre-strip check used to let it through, and the commit-site strip
    // then emptied it — committing an empty block the live stream (which
    // drops strays as they arrive) had never shown: streamed != committed.
    // The commit sites below keep their own strip (idempotent) because the
    // retry paths can replace `streamResult` after this line.
    streamResult = {
      surface: streamResult.surface,
      text: stripStrayOpenTags(streamResult.text, streamResult.surface),
    };

    if (streamResult.surface === "thought") {
      // Slot-only lands here as well (2026-08-12): a placeholder that
      // survived the ladder must not be committed as a thought, or next
      // turn's prompt shows a row of brackets where a judgement should be
      // and she reads it back as her own reasoning.
      if (isUnusableBlock(streamResult.text)) {
        // Empty thought after the inline retry too — record this
        // iteration as an empty-thought iteration. The next iteration's
        // `forceSpeech` will be true (see counter check at the top of
        // the loop), so we'll produce speech directly instead of
        // looping the same thought prompt forever.
        consecutiveEmptyThoughtIters += 1;
        continue;
      }
      // Real thought content this turn — reset the empty-thought
      // counter so a future empty-thought spin starts fresh.
      consecutiveEmptyThoughtIters = 0;
      // Belt-and-suspenders trim: stream consumers and the dup-tag
      // strip already trim, but the empty-thought retry path returns
      // text that bypasses the dup-tag strip block (it replaces
      // `streamResult` AFTER that block runs). Trimming here ensures
      // the persisted record never contains leading/trailing ws
      // regardless of which path produced the text.
      //
      // sanitizeActorText: the record is the prompt — a forged → 系统 /
      // cross-role delimiter in a committed thought would re-enter every
      // future prompt as harness ground truth (slice 2 of the output-
      // hardening plan). Neutralized at construction so disk, prompts,
      // and every projection inherit the safe text.
      // stripStrayOpenTags at commit for EVERY path (slice 4): the live
      // stream drops stray tags as they arrive, so the committed text must
      // drop them too — otherwise sanitize ZWSP-breaks the leftover tag and
      // streamed ≠ committed. Idempotent over already-stripped paths.
      const thoughtBlock: TerminalRecordBlock = {
        kind: "herta",
        surface: "thought",
        text: sanitizeActorText(
          stripStrayOpenTags(streamResult.text, "thought"),
          { role: "thought" },
        ),
      };
      record = [...record, thoughtBlock];
      consecutiveThoughts += 1;

      // `@板砖` in a thought block is inert prose — backend dispatch
      // requires the trigger to land in a speech block where the
      // supervisor can gate it and the user sees what's being asked
      // of the backend.
      continue;
    }

    // surface === "speech"
    //
    // THE COMMIT BOUNDARY. Every path converges here — first pass, veto
    // respeak, empty-speech ladder, and every supervisor-skipping path
    // (deadline fail-soft, provider error, `config.supervisor.enabled =
    // false`). This is therefore the one place a deterministic shape guard
    // covers all of them, which an LLM judge by construction cannot.
    if (isUnusableBlock(streamResult.text)) {
      // Empty speech (e.g. provider returned only a stop sequence or finish),
      // or a slot-only completion that survived the retry ladder. Don't commit
      // it; terminate the turn gracefully. Silence is recoverable — the user
      // can just speak again — whereas `{需要说的话}` on screen is not.
      deps.sink?.flushBlocks(record);
      return { record };
    }
    // Belt-and-suspenders trim: covers the empty-speech retry and
    // supervisor-veto retry paths, both of which replace
    // `streamResult` AFTER the dup-tag strip block has already run.
    // The record-stored text matches what the user sees on screen.
    //
    // Self-correction anchor (N8/N8b, 2026-05-23): when this speech
    // was committed via the supervisor-veto retry path, attach the
    // veto reason to the block via `selfCorrection`. The CLI
    // renderer ignores the field (only `text` reaches stdout), but
    // the serializer prepends `——<reason>\n\n` as prose before the
    // speech envelope so future-turn LLM prompts carry the lesson.
    // Without this anchor the model loses memory of "I was self-
    // corrected on X" the moment the turn ends, and the same
    // mistake (e.g. 杨叔→瓦尔特) repeats on every subsequent turn.
    // Budget-suppressed trigger (chained dispatch, 2026-07-10): with the
    // per-turn dispatch budget already SPENT, a further `@板砖` in this
    // speech will NOT dispatch — committing it live would leave a
    // dispatch-looking token in the record and the GUI chip for a run that
    // never happened, eroding the literal-token contract the discipline
    // spec teaches. Neutralize at commit (same quoted-`@板砖` mechanism as
    // the recheck path). Within the budget the
    // token stays live and the dispatch branch below fires — a synthesis
    // speech may legitimately chain a follow-up run.
    // sanitizeActorText BEFORE the trigger checks: the strip half can
    // splice a live @板砖 out of zero-width-obfuscated input, so every
    // trigger decision below reads the sanitized text — display and
    // dispatch always agree (slice 2 of the output-hardening plan).
    // stripStrayOpenTags first (slice 4): the live stream drops stray tags
    // as they arrive, so the commit must too — streamed == committed.
    let committedSpeechText = sanitizeActorText(
      stripStrayOpenTags(streamResult.text, "speech"),
      { role: "speech" },
    );
    if (
      dispatchCount >= MAX_DISPATCHES_PER_TURN &&
      parseHertaBlock(committedSpeechText).hasBanzhuanTrigger
    ) {
      committedSpeechText = neutralizeBanzhuanTrigger(committedSpeechText);
    }
    const speechBlock: TerminalRecordBlock =
      supervisorVetoReasonForRecord !== undefined
        ? {
            kind: "herta",
            surface: "speech",
            text: committedSpeechText,
            // The veto reason is supervisor-model output headed for the
            // `——` prose lane of every future prompt. Role "speech":
            // forged labels/delimiters break, but a reason that NAMES
            // @板砖 (trigger-discipline lessons do) keeps the literal
            // token — the prose lane is never dispatch-parsed, and the
            // lesson only teaches if the model sees the real token.
            selfCorrection: sanitizeActorText(
              formatSelfCorrectionText(supervisorVetoReasonForRecord),
              { role: "speech" },
            ),
          }
        : {
            kind: "herta",
            surface: "speech",
            text: committedSpeechText,
          };
    record = [...record, speechBlock];
    consecutiveThoughts = 0;
    consecutiveEmptyThoughtIters = 0;
    speechIterations += 1;

    // Bug 1 (2026-06-27): finalize Herta's speech on the shared record the
    // instant she finishes speaking — BEFORE any @板砖 dispatch — so the GUI
    // swaps its transient streaming bubble for the finalized HertaBubble (which
    // renders the @板砖 chip) at speaking-done, not coupled to the backend run /
    // permission gate. Idempotent: flushBlocks emits emittedCount..length and
    // advances its cursor, so the bridge's later flush and the defensive flush
    // below never re-emit this block (ActorStreamingSink.flushBlocks contract).
    deps.sink?.flushBlocks(record);

    // Parse the dispatch trigger from the COMMITTED (sanitized) text, not
    // the raw stream: the sanitize strip can change trigger presence for
    // zero-width-obfuscated input, and the committed text is what the
    // user sees and the record keeps — the literal-token contract binds
    // dispatch to that, never to invisible raw bytes.
    const parsed = parseHertaBlock(committedSpeechText);
    let ranSideEffect = false;

    if (parsed.hasBanzhuanTrigger && dispatchCount < MAX_DISPATCHES_PER_TURN) {
      const policy = new BeatPolicy();
      const fireBeat = makeFireBeat(
        deps,
        priorTurnLength,
        recap,
        recapBoundaryIndex,
      );
      record = await invokeBanzhuanBridge(record, [], {
        bus: deps.bus,
        runtimeFactory: deps.runtimeFactory,
        lang: deps.lang,
        signal,
        beatPolicy: policy,
        fireBeat,
        sink: deps.sink,
      });
      dispatchCount += 1;
      ranSideEffect = true;
      // No-op handling (2026-05-23 duplicate-speech fix) now lives in the
      // bridge: invokeBanzhuanBridge emits a 无产出 差分协处理器 block when the
      // backend produced no work, so the next iteration has concrete context.
    }

    // A forced speech is a fully committed output block — no need to continue
    // looping for another iteration. (The single-phase path's "continue after
    // forced speech" went with the path, 2026-09-03.)
    if (!ranSideEffect) {
      // Final flush (defensive) — the sink should already be up to date.
      deps.sink?.flushBlocks(record);
      return { record };
    }
  }

  // Safety cap hit on speech iterations.
  deps.sink?.flushBlocks(record);
  return { record };
}
