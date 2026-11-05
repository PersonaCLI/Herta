// The in-turn beat firer (`makeFireBeat`) — one factory shared by the
// user-typed `@板砖` pre-empt and the main loop's Herta-`@板砖` dispatch.
// Extracted from actor-turn.ts on 2026-09-03 (owner's request: the file had
// grown to 3,200 lines); bodies and comments are verbatim. Her answer to talk
// during a run (`makeFireAnswer`, ADR 0085 step 3) streams the same way.

import { selectBeatHint } from "./actor-hints.js";
import { type ActorPrompt, serializeActorPrompt } from "./actor-prompt.js";
import type { ActorTurnDeps } from "./actor-turn-deps.js";
import { judgeTriggerAndNeutralize } from "./actor-turn-judges.js";
import { resolveHints } from "./actor-turn-prompts.js";
import {
  firstStopIndexAtLineStart,
  STOP_CLOSER_USER,
  STOP_OPENER_USER,
  STOP_PAGE_HEADING,
  STOP_PAGE_RULE,
  safeEmitBoundaryAtLineStart,
} from "./actor-turn-stream.js";
import type { AnswerFirer, BeatFirer } from "./backend-bridge.js";
import { isPlaceholderOnly, stripHintScaffolding } from "./block-shape.js";
import { sanitizeActorText } from "./escape.js";
import {
  banzhuanSentences,
  neutralizeBanzhuanTrigger,
  parseHertaBlock,
} from "./parse.js";
import { FORCED_SPEECH_OPEN_TAG, STOP_SPEECH_CLOSE } from "./thought-hint.js";

/**
 * Factory for the in-turn beat firer. Extracted so user-`@板砖` pre-empt
 * and Herta-`@板砖` main-loop dispatch share the same beat logic.
 *
 * Uses a deferred-begin pattern: `beginHertaStream("speech")` is NOT called
 * at the top of the function. Instead it is deferred until the first actual
 * token is safe to emit. This makes begin/end calls perfectly symmetric:
 * if the beat body is empty (provider returned only the stop sequence),
 * `beginHertaStream` is never called and neither is `endHertaStream`, so the
 * renderer's `streamingSurface` and cursor remain untouched across the
 * null-return path.
 */
export function makeFireBeat(
  deps: ActorTurnDeps,
  priorTurnLength: number,
  recap: string | undefined,
  recapBoundaryIndex: number,
): BeatFirer {
  return async (currentRecord, trigger, abortSignal) => {
    // Beats are always speech surface; the doc's `metaThinkSurface`
    // picks `preSpeakText` and `beforeSpeakIndex` accordingly.
    //
    // Per-trigger hint (N5, 2026-05-23): pick a hint tailored to the
    // event that triggered this beat. `patch.preview:first` steers
    // toward "one-line take on the diff"; `verification.finished`
    // toward "passed/failed verdict"; `tool.fail:*` toward "cold
    // restatement of the failure". Unknown triggers fall back to the
    // generic speech hint — degrades gracefully to pre-N5 behavior.
    //
    // Fresh-window verbatim (M-projection-1, 2026-07-04; supersedes the
    // blanket N6b `compressDiffs: false` + compaction opt-out): the beat
    // is firing because a substantive backend event just landed
    // (typically a `patch.preview` with a fresh diff), and Herta needs
    // the FULL output of THIS invocation to comment substantively —
    // "看 diff 的形状是不是干净" can't work on a 19-line preview.
    // `verbatimSinceLastDispatch` keeps everything after the prior
    // dispatch's done-marker verbatim while EARLIER dispatches stay
    // compressed + compacted, exactly like the main turns see them —
    // the old global opt-outs re-expanded every prior dispatch's diffs
    // and board output into every beat prompt, tokens that grew with
    // each dispatch and slowed the beat's TTFT. The full record stays
    // in the in-memory `TerminalRecord` and the JSONL either way.
    // Attachments are the one exception to "verbatim": they fold in the
    // beat exactly as in the main turn (ADR 0033 §6g amendment) — the
    // fresh window is for the current run's output, not for re-opening
    // a document the turn prompt has already closed.
    const beatDoc: ActorPrompt = {
      staticPrefix: deps.staticPrefix,
      record: currentRecord,
      priorTurnLength,
      attachedMetaThink: deps.attachedMetaThink,
      metaThinkSurface: "speech",
      formatHint: selectBeatHint(resolveHints(deps), trigger.signature),
      openTag: FORCED_SPEECH_OPEN_TAG,
      verbatimSinceLastDispatch: true,
      // Long-session recap (computed once per turn). Orthogonal to the
      // fresh-board compaction toggled off above: the recap summarizes
      // OLD dialogue (history before this turn), while the beat reacts
      // to a brand-new event in the verbatim window. The boundary only
      // drops blocks below `recapBoundaryIndex`, all of which predate
      // the event the beat is commenting on.
      ...(recap !== undefined ? { recap } : {}),
      recapBoundaryIndex,
      lang: deps.lang ?? "zh",
    };
    const beatPrompt = serializeActorPrompt(beatDoc);
    deps.onPrompt?.("beat", beatPrompt);
    deps.onCompletionPrompt?.(beatPrompt);
    const text = await streamInRunSpeech(deps, beatPrompt, abortSignal, 220);
    if (text === null) return null;
    // Slice 6: beats bypass the supervisor BY DESIGN (a full pass mid-run
    // costs a round-trip exactly where latency shows), so the deterministic
    // guards do the work instead:
    //   - sanitizeActorText neutralizes forged evidence labels / cross-role
    //     delimiters and strips control/bidi chars (the beat lane previously
    //     applied ZERO sanitization — the last unguarded path into the
    //     durable record);
    //   - neutralizeBanzhuanTrigger: a beat must NEVER carry a live dispatch
    //     token — the bridge only fires from main-loop speech, but a live
    //     @板砖 in a committed beat renders a dispatch chip for a run that
    //     never happened and teaches tomorrow's prompts the wrong pattern.
    // The live beat display may briefly show the pre-neutralized token; the
    // commit settles it — same accepted one-char settle as the main loop's
    // cap-suppressed trigger.
    return {
      kind: "herta",
      surface: "speech",
      text: neutralizeBanzhuanTrigger(
        sanitizeActorText(text, { role: "speech" }),
      ),
    };
  };
}

/**
 * Her answer to talk while 板砖 works (ADR 0085 step 3): one completion over
 * the record as it stands — the run in its live form, the talk after it —
 * streamed like a beat, committed as a `duringRun` speech. Its hint is its
 * own (`beat_talk`, step 5): under the speech hint, which asks for a thought
 * the answer does not have, the lab's answers passed work on without @板砖
 * and once made up a fact.
 *
 * Her live `@板砖` in it is a steer, not a dispatch (§4): the trigger recheck
 * gates a rhetorical one exactly as it gates the main loop's, and a real one
 * hands 板砖 the sentences that carry it (owner 2026-11-04: the sentence, not
 * the reply). The token stays live in her text — she did call 板砖 — and the
 * block names what reached it.
 */
export function makeFireAnswer(
  deps: ActorTurnDeps,
  priorTurnLength: number,
  recap: string | undefined,
  recapBoundaryIndex: number,
): AnswerFirer {
  return async (currentRecord, abortSignal, canSteer) => {
    const answerDoc: ActorPrompt = {
      staticPrefix: deps.staticPrefix,
      record: currentRecord,
      priorTurnLength,
      attachedMetaThink: deps.attachedMetaThink,
      metaThinkSurface: "speech",
      formatHint: selectBeatHint(resolveHints(deps), "talk"),
      openTag: FORCED_SPEECH_OPEN_TAG,
      // Her view of a live run with talk after it is the live form
      // (`run-grouping.ts`); the beat's fresh-window treatment covers the
      // rest exactly as for a beat.
      verbatimSinceLastDispatch: true,
      ...(recap !== undefined ? { recap } : {}),
      recapBoundaryIndex,
      lang: deps.lang ?? "zh",
    };
    const prompt = serializeActorPrompt(answerDoc);
    // The beat's dump lane: an in-run completion, told apart by its prompt.
    deps.onPrompt?.("beat", prompt);
    deps.onCompletionPrompt?.(prompt);
    const raw = await streamInRunSpeech(deps, prompt, abortSignal, 600);
    if (raw === null) return null;
    let text = sanitizeActorText(raw, { role: "speech" });
    let steered = "";
    if (parseHertaBlock(text).hasBanzhuanTrigger) {
      // Only a run that can still take a steer, and only a call the recheck
      // lets stand; anything else is a mention.
      // With no supervisor the call stands as written, as a main-loop
      // dispatch does: the toggle is the main loop's own test.
      const supervisorProvider = deps.supervisorProvider;
      const supervised =
        supervisorProvider !== undefined &&
        deps.supervisorReference !== undefined &&
        deps.supervisorReference.length > 0;
      let judged = { text };
      if (!canSteer()) {
        judged = { text: neutralizeBanzhuanTrigger(text) };
      } else if (supervised) {
        try {
          judged = await judgeTriggerAndNeutralize({
            deps,
            supervisorProvider,
            signal: abortSignal,
            record: currentRecord,
            candidate: text,
            thought: undefined,
          });
        } catch (err) {
          // Stopped during the recheck, with the answer already on screen
          // and its stream closed: it stands, screen == record, as a mention
          // (review 2026-11-05). The recheck fails soft on everything else.
          if (!abortSignal.aborted) throw err;
          judged = { text: neutralizeBanzhuanTrigger(text) };
        }
      }
      text = sanitizeActorText(judged.text, { role: "speech" });
      // The run may have ended while the recheck ran.
      if (canSteer()) steered = banzhuanSentences(text);
      else text = neutralizeBanzhuanTrigger(text);
    }
    return {
      kind: "herta",
      surface: "speech",
      text,
      duringRun: true,
      ...(steered.length > 0 ? { steered } : {}),
    };
  };
}

/**
 * One in-run speech, streamed: a beat's or an answer's. Returns the text to
 * commit (trimmed, or raw when trimming would empty what was already shown),
 * or null when nothing should be committed. Every stream it opens it closes.
 */
async function streamInRunSpeech(
  deps: ActorTurnDeps,
  beatPrompt: string,
  abortSignal: AbortSignal,
  maxTokens: number,
): Promise<string | null> {
  let beatBuffered = "";
  let beatEmittedTail = 0;
  let beginCalled = false; // deferred until first emit
  const beatStops = [
    STOP_SPEECH_CLOSE,
    STOP_OPENER_USER,
    STOP_CLOSER_USER,
    // A beat can turn the page too (ADR 0070); its token cap only bounds
    // how much of the page it writes.
    STOP_PAGE_HEADING,
    STOP_PAGE_RULE,
  ] as const;

  try {
    for await (const ev of deps.provider.streamCompletion(
      {
        model: deps.model,
        prompt: beatPrompt,
        // Beats are short reactive utterances; they don't carry
        // inline tool calls in practice. If a beat ever DID emit one
        // we'd lack the parallel-supervisor coordination that the
        // main loop has — keep beats simple, no mid-stream watcher.
        // Include the user envelope's tags so a runaway beat that
        // hallucinates the user's next message (`（开拓者 说）...`, or
        // the reply without its open tag and then `（/开拓者 说）`)
        // halts immediately, same as the main-loop streams.
        stop: [...beatStops],
        // Backstop, not the primary terminator: the `（/我 说）` close marker
        // (a stop sequence) ends a well-behaved beat well under this cap — a
        // one/two-line Chinese reaction + marker is ~15-40 tokens. The cap
        // only bites a runaway beat that never closes. Raised 100 → 220
        // (2026-06-28) so a slightly longer beat (e.g. a fuller take on a
        // diff) finishes its sentence AND the close marker instead of being
        // cut at finish_reason=length and leaking a dangling `（/`
        // (the dangling-prefix strip below still cleans that residual case).
        // History: 60 was too tight (truncated the marker), then 100. Kept as
        // a guard so a misbehaving beat can't run to DeepSeek's ~4096 default
        // mid-backend-work — beats stay short by design, not just by hint.
        // An answer to talk is a reply, not a reaction: 600.
        maxTokens,
      },
      abortSignal,
    )) {
      if (ev.type === "text-delta") {
        beatBuffered += ev.text;
        if (deps.sink !== undefined) {
          // firstStopIndex caps the emit at any COMPLETE stop marker a
          // misbehaving provider streamed past (fence-fuzz, 2026-07-09).
          const safeEnd = Math.min(
            safeEmitBoundaryAtLineStart(beatBuffered, beatStops),
            firstStopIndexAtLineStart(beatBuffered, beatStops),
          );
          if (safeEnd > beatEmittedTail) {
            // Defer beginHertaStream until just before the first emit so
            // that if no tokens are ever safe to emit we never open the
            // stream and have nothing to balance with endHertaStream.
            if (!beginCalled) {
              deps.sink.beginHertaStream("speech");
              beginCalled = true;
            }
            deps.sink.streamHertaToken(
              beatBuffered.slice(beatEmittedTail, safeEnd),
            );
            beatEmittedTail = safeEnd;
          }
        }
      } else if (ev.type === "finish") {
        break;
      }
    }
  } catch (err) {
    // Beat stream died mid-flight (interrupt, provider error). If nothing
    // reached the sink the beat can be dropped cleanly — rethrow and let
    // the bridge's fire-loop catch handle it (drop / abort-clear). But if
    // tokens WERE emitted the stream MUST settle here: begin-without-end
    // leaks streamingSurface across turns (wrong flush offsets), while
    // end-without-a-committed-block desyncs the sink cursor from the
    // record (endHertaStream claims a record position, per the sink
    // contract). So salvage: end the stream and commit exactly the text
    // already on screen as the beat block — screen == record, the same
    // convergence rule the interrupt path applies to backend blocks
    // (hang audit 2026-07-09, M1).
    if (!beginCalled) throw err;
    deps.sink?.endHertaStream();
    const salvaged = beatBuffered.slice(0, beatEmittedTail);
    deps.onPrompt?.(
      "beat-out",
      `${beatPrompt}${salvaged}[salvaged: ${String(err)}]`,
    );
    const trimmedSalvage = salvaged.trim();
    return trimmedSalvage.length > 0 ? trimmedSalvage : salvaged;
  }

  // Cut exactly at the FIRST complete stop marker when one exists
  // (matching the live emit cap — see consumePhaseTwoStream; prose ending
  // in `（` right before the marker survives), else strip a DANGLING
  // partial prefix (a trailing `（/` from a beat truncated mid-marker —
  // still possible even at `maxTokens: 220`; the `.trim()` at commit
  // removes only whitespace, not the leaked prefix).
  const beatStopIdx = firstStopIndexAtLineStart(beatBuffered, beatStops);
  let beatText =
    beatStopIdx < beatBuffered.length
      ? beatBuffered.slice(0, beatStopIdx)
      : beatBuffered.slice(
          0,
          safeEmitBoundaryAtLineStart(beatBuffered, beatStops),
        );
  deps.onPrompt?.("beat-out", `${beatPrompt}${beatText}`);

  // Beats carry bracketed hints too (beat_verification / beat_tool_fail),
  // so the same echo is possible here. Repair before the
  // slot check below, for the same ordering reason as runPhaseTwo — but
  // ONLY while nothing has streamed (review 2026-08-12): `beatEmittedTail`
  // indexes into the RAW text, so shortening beatText after live emission
  // would make the tail-flush below slice the wrong substring (or skip a
  // tail it still owes) and desync screen from record — the exact
  // invariant the `!beginCalled` guard on the slot check protects. An
  // echoing beat that already streamed keeps today's behaviour: committed
  // exactly as shown, brackets and all — screen == record wins.
  // (beginCalled === false implies beatEmittedTail === 0: the streaming
  // loop sets beginCalled before its first emit.)
  if (!beginCalled) beatText = stripHintScaffolding(beatText);

  // Slot-only beat (2026-08-12). This lane bypasses the supervisor BY
  // DESIGN (see the commit comment below), so the deterministic guards are
  // the only thing standing between a degenerate completion and the record
  // — exactly the argument that already justifies sanitize and trigger
  // neutralization here.
  //
  // Guarded on `!beginCalled`: beats stream LIVE, so once tokens have
  // reached the sink the cursor has advanced and a block MUST be committed
  // at that position — dropping it then would desync screen from record,
  // which is the worse bug the salvage path above exists to prevent. When
  // nothing has been emitted yet (the safe-emit gate held the whole short
  // beat, the common case) the beat can be dropped cleanly, same as the
  // empty case below.
  if (!beginCalled && isPlaceholderOnly(beatText)) {
    return null;
  }

  if (deps.sink !== undefined && beatEmittedTail < beatText.length) {
    // Flush any tail that wasn't emitted during the streaming loop.
    if (!beginCalled) {
      deps.sink.beginHertaStream("speech");
      beginCalled = true;
    }
    deps.sink.streamHertaToken(beatText.slice(beatEmittedTail));
  }

  if (beatText.length === 0) {
    // The provider emitted only the stop sequence (or nothing at all).
    // beginHertaStream was never called → nothing to balance.
    // streamingSurface stays clean; cursor is not advanced. Safe null return.
    return null;
  }

  // Something WAS streamed. We MUST call endHertaStream to reconcile
  // the renderer's cursor + clear its streaming flag — otherwise
  // subsequent flushBlocks calls render at the wrong offset and
  // streamingSurface leaks across turns.
  if (beginCalled) deps.sink?.endHertaStream();

  // For the committed block, prefer the trimmed text (cleaner JSONL
  // entries + cleaner rendered output). Fall back to raw beatText
  // if trim() emptied it — the cursor was already advanced, so a
  // block MUST be committed at that position. The caller applies the
  // deterministic guards (sanitize; the trigger rule of its lane).
  const trimmed = beatText.trim();
  return trimmed.length > 0 ? trimmed : beatText;
}
