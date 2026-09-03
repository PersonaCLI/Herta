// Completion-stream side of the actor turn: the stop sequences and the
// stream text helpers (stray-tag stripping, the first-stop cut), the
// abort-flush / abandon helpers for paced controllers, the two stream
// consumers (`consumeBranchStream`, `consumePhaseTwoStream`), the phase-2
// generation funnel (`runPhaseTwo`) and the empty-body retry ladders that
// re-drive it. Extracted from actor-turn.ts on 2026-09-03 (owner's request:
// the file had grown to 3,200 lines); bodies and comments are verbatim.

import type { CompletionProviderAdapter, TerminalRecord } from "@herta/core";
import { type ActorPrompt, serializeActorPrompt } from "./actor-prompt.js";
import type { ActorTurnDeps, Surface } from "./actor-turn-deps.js";
import { resolveHints } from "./actor-turn-prompts.js";
import {
  isPlaceholderOnly,
  type RetryCause,
  retryCause,
  stripHintScaffolding,
} from "./block-shape.js";
import type {
  ActorStreamingSink,
  SlowStreamController,
} from "./streaming-sink.js";
import { safeEmitBoundary, stripDanglingStopPrefix } from "./streaming-sink.js";
import {
  buildSupervisorVetoHint,
  FINAL_RETRY_BODY_SEED,
  STOP_SPEECH_CLOSE,
  STOP_THOUGHT_CLOSE,
} from "./thought-hint.js";

/**
 * Tag the model uses when hallucinating the user's next message —
 * if the close tag for Herta's own surface (`（/我 说）` / `（/我 想）`)
 * gets skipped, the model often rolls straight into emitting
 * `（开拓者 说）` followed by a fabricated user turn. Stopping on
 * the opening of this tag keeps the runaway content out of the
 * record and out of the prompt for the next turn.
 *
 * Defensive: Herta never writes this string in regular speech
 * (full-width parens + space + open tag is a corpus envelope, not
 * natural prose), so adding it as a stop sequence has zero false-
 * positive risk on valid runs.
 */
export const STOP_OPENER_USER = "（开拓者 说）";

/**
 * Stop sequences passed to the LLM provider. The two surface close
 * tags terminate Herta's own surface as expected; `（开拓者 说）`
 * catches the runaway case where the model skips its own close tag
 * and starts emitting the user's next-turn envelope.
 *
 * History note: an earlier revision also watched mid-stream for
 * inline `read_file("…")` / `list_files("…")` calls and aborted the
 * stream client-side via a linked `AbortController`. Inline tools
 * were removed entirely in the 2026-05-23 sweep because the model
 * occasionally hallucinated calls against non-existent paths during
 * casual conversation. File reads / directory listings are now
 * delegated to the backend via `@板砖`.
 */
const STOP_SEQS = [
  STOP_SPEECH_CLOSE,
  STOP_THOUGHT_CLOSE,
  STOP_OPENER_USER,
] as const;

/** Stray duplicate open tags the model sometimes re-emits mid-body. The
 *  commit path removes them (`stripStrayOpenTags`); slice 4 removes them
 *  from the LIVE stream too, so what types on screen equals what commits. */
const STRAY_OPEN_TAGS = ["（我 说）", "（我 想）"] as const;

/** Emit-boundary hold set for the live stream (slice 4): stop sequences PLUS
 *  the stray open tags, so a tag split across provider chunks is held until
 *  resolved and `stripStrayFromChunk` only ever sees complete tags. Used for
 *  the emit boundary ONLY — end-of-stream cleaning keeps STOP_SEQS (a
 *  dangling partial `（我` at stream end is committed verbatim, and streams
 *  verbatim via the final tail flush: still equal). */
const LIVE_EMIT_HOLD_SEQS = [...STOP_SEQS, ...STRAY_OPEN_TAGS] as const;

/** Chunk-local half of `stripStrayOpenTags` for the live stream: drops
 *  complete stray tags, no trim (the stream's own leading-skip/trailing-hold
 *  owns whitespace). Chunk-local equals whole-string because
 *  `LIVE_EMIT_HOLD_SEQS` guarantees a tag never spans emitted chunks. */
function stripStrayFromChunk(chunk: string, surface: Surface): string {
  if (surface === "thought") return chunk.replaceAll("（我 想）", "");
  return chunk.replaceAll("（我 说）", "").replaceAll("（我 想）", "");
}

/**
 * Temperature ladder for the empty-speech retry path. The first
 * (non-retry) attempt uses the provider/model's baked-in default
 * (DeepSeek's chat default is 1.3 per their public parameter-settings
 * guide). When that attempt returns an empty body, successive retries
 * bump the temperature to break the model out of the deterministic
 * empty-output trap: it's emitting `（/我 说）` at position 0 because
 * the preceding thought + meta-think context led it to assign very
 * high probability mass to the close tag. Sampling at a higher
 * temperature spreads that mass and gives the model a chance to write
 * actual content first.
 *
 * Anchor: the provider's default temperature is 1.0 (DeepSeek
 * completion default). Gentle +0.1 bumps per retry keep the sampler
 * within a narrow band around that anchor. Bigger jumps (revision
 * history had 1.5 / 1.7 / 1.8) caused the retry's content to drift
 * in tone away from the rest of the turn — a high-temperature reply
 * mid-turn reads as a different speaker than the surrounding speech.
 * The +0.1 ladder gives the sampler just enough room to escape the
 * close-tag local minimum without also blowing the voice apart.
 *   1.0   ← attempt 1 (provider default, no override)
 *   1.1   ← retry 1
 *   1.2   ← retry 2
 *   1.3   ← retry 3
 *
 * Length matters: max number of retries is `EMPTY_SPEECH_RETRY_TEMPERATURES.length`.
 * After that many failures the actor terminates the turn quietly
 * (returning the partial record), same as the pre-2026-05-23 behavior
 * but reached only after exhausting the ladder.
 */
const EMPTY_SPEECH_RETRY_TEMPERATURES = [1.1, 1.2, 1.3] as const;

/**
 * Output-token cap on the PRIMARY actor completions (slice 3). A runaway
 * generation (no close tag, stop sequences never matched) used to stream
 * until the provider's own limit, locking the turn for its whole duration.
 * Sized far above the longest legitimate （我 想）/（我 说） block (a few
 * hundred CJK chars ≈ a few hundred tokens) so real speech is never
 * clipped. Deliberate asymmetry: the SUPERVISOR stays UNCAPPED — it runs in
 * thinking mode, where a token cap truncates reasoning and garbles the
 * verdict; its hang protection is SUPERVISOR_DEADLINE_MS instead (standing
 * user constraint — do not add a cap there).
 */
const PRIMARY_COMPLETION_MAX_TOKENS = 2048;

/**
 * Index of the FIRST complete stop marker in `buffered`, or `buffered.length`
 * when none is present. Fence-fuzz finding (2026-07-09): a provider that
 * fails to honor its stop sequences can stream text PAST a complete
 * `（/我 说）` / `（/我 想）` / `（开拓者 说）` — the commit path always
 * truncated at a marker, but the LIVE path streamed the marker plus the
 * runaway tail to the screen (streamed != committed, envelope text visible).
 * Both paths now cut at this index: it is exactly where a stop-honoring
 * provider would have ended the stream, so on well-behaved providers this is
 * a no-op.
 */
export function firstStopIndex(
  buffered: string,
  stops: readonly string[],
): number {
  let min = buffered.length;
  for (const stop of stops) {
    const i = buffered.indexOf(stop);
    if (i >= 0 && i < min) min = i;
  }
  return min;
}

/** Strip stray duplicate open tags the model sometimes re-emits mid-body
 *  (e.g. `[s1] （我 说） [s2]`) so the literal tag never leaks into the
 *  committed block or future prompts. Surface-aware: thought text strips only
 *  `（我 想）`; speech strips both (defensive cross-surface wander). Applied to
 *  the first pass AND every retry reassignment — the veto retry used to skip
 *  it, so a retry re-emitting the tag streamed it to the user verbatim. */
export function stripStrayOpenTags(text: string, surface: Surface): string {
  if (surface === "thought") {
    return text.replaceAll("（我 想）", "").trim();
  }
  return text.replaceAll("（我 说）", "").replaceAll("（我 想）", "").trim();
}

/**
 * Route a turn interrupt into a POST-VERDICT paced drain (slice 3). The
 * reveal runs on the sink's own setTimeout ticks, so the loop-boundary
 * `signal.aborted` check can never stop it — a stop click during a long
 * paced drain used to lock the app until the drain finished (minutes for a
 * long body). Arm this immediately before `await controller.fastForward()`
 * and disarm right after: on abort, `flushRemainder` lands the remaining
 * tail in ONE delta (fast-forward, never truncate — the flushed text equals
 * the text the turn commits) and resolves the drain's `done`, unblocking
 * the await. Scoped to post-verdict drains ONLY: an abort while the verdict
 * is pending takes the interrupt-during-supervisor cancel path instead, so
 * an unapproved candidate never flashes fully on screen.
 */
export function armAbortFlush(
  signal: AbortSignal,
  controller: SlowStreamController | undefined,
): () => void {
  if (controller?.flushRemainder === undefined) return () => {};
  const onAbort = (): void => controller.flushRemainder?.();
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/** Best-effort terminal call for a live/slow controller that is being
 *  abandoned on a THROW path (interrupt, provider error): the sink contract
 *  requires exactly one terminal method or its output stream stays parked in
 *  the verdict hold. The contractual done-rejection is swallowed (it is the
 *  expected outcome of cancelling); sink teardown errors are best-effort. */
export async function abandonController(
  controller:
    | { done: Promise<void>; cancelAndBackspace(): Promise<void> }
    | undefined,
): Promise<void> {
  if (controller === undefined) return;
  controller.done.catch(() => undefined);
  try {
    await controller.cancelAndBackspace();
  } catch {
    // Sink teardown is best-effort on an already-failing path.
  }
}

/**
 * Stream one main-loop iteration. Detects surface from the first 1–2
 * chars after the open tag (`想）` vs `说）`), then streams remaining
 * tokens via `streamHertaToken` (no-op on thought surface inside the
 * sink).
 *
 * Uses a deferred-begin pattern: `beginHertaStream(surface)` is NOT
 * called until the first token chunk that actually has content is safe
 * to emit. This ensures that if the stream body is empty (whitespace-
 * only or literally nothing), `beginHertaStream` is never called and
 * neither is `endHertaStream`, leaving the renderer's cursor and
 * `streamingSurface` untouched — which keeps it in sync with the record
 * (the actor's empty-body path skips the block commit).
 *
 * For speech: any non-empty chunk (including whitespace) triggers begin,
 * because whitespace IS visible content in a speech block.
 * For thought: only a non-whitespace chunk triggers begin, to prevent
 * the renderer's cursor from advancing for whitespace-only thought
 * streams (thought tokens are no-ops in the sink, so holding the
 * whitespace is invisible and correct).
 */
export async function consumeBranchStream(opts: {
  provider: CompletionProviderAdapter;
  model: string;
  prompt: string;
  signal: AbortSignal;
  sink?: ActorStreamingSink;
  forceSpeech: boolean;
}): Promise<{
  surface: Surface;
  text: string;
}> {
  let buffered = "";
  // Two positions track different things in `buffered`:
  //   - `tagSkipPos` is the offset where Herta's body starts (just past
  //     `说）` / `想）` and any leading whitespace). Fixed for the life of
  //     the stream after `tryDecideTagSkip` runs. Used to compute
  //     `cleanText` (the committed block body) at end-of-stream.
  //   - `emittedTail` is the offset past which we've already forwarded
  //     bytes to the sink via `streamHertaToken`. Advances during the
  //     stream as `safeEmitBoundary` clears more content. Always
  //     `>= tagSkipPos` once the tag is decided.
  let tagSkipPos = 0;
  let emittedTail = 0;
  let surface: Surface | null = opts.forceSpeech ? "speech" : null;
  // For forced-speech, the open tag `（我 说）` was in the prompt, so the
  // stream contains pure body — no tag to skip. Mark decided up-front.
  let tagSkipDecided = opts.forceSpeech;
  let beginCalled = false;
  // Tracks whether at least one non-whitespace char has been seen past
  // the open-tag position. Until true, leading whitespace in the body
  // (e.g. the `\n` after `说）` from the corpus format) is held back
  // so the user doesn't see a blank line above Herta's speech. After
  // it goes true, trailing-whitespace runs are held back too — so a
  // run that ends the stream gets dropped, but a run followed by more
  // non-ws gets emitted normally as internal whitespace.
  let bodyStarted = false;

  /**
   * Returns true when the `chunk` justifies opening the stream for the
   * given surface. Both speech and thought require non-whitespace to
   * begin (the leading-ws skip below ensures `streamHertaToken` is
   * never called with a whitespace-only prefix). Pre-2026-05-23,
   * speech allowed any chunk (including whitespace) to trigger begin
   * — that produced the blank-line-above-speech artifact when the
   * model emitted `（我 说）\n<body>`.
   */
  const shouldBegin = (_s: Surface, chunk: string): boolean => {
    return chunk.trim().length > 0;
  };

  const ensureBegin = (s: Surface, chunk: string): void => {
    if (!beginCalled && shouldBegin(s, chunk) && opts.sink !== undefined) {
      opts.sink.beginHertaStream(s);
      beginCalled = true;
    }
  };

  /**
   * Advance `emittedTail` past the leading `说）` / `想）` tag once enough
   * chars are buffered to make a definitive decision. This MUST run before
   * any emit so we never forward partial-tag bytes (the post-merge bug
   * where `说` from delta 1 leaked to stdout before `）` arrived in delta
   * 2). On malformed completions (the tag isn't where it should be), we
   * leave `emittedTail` at 0 and emit verbatim — defensive recovery.
   */
  const tryDecideTagSkip = (): void => {
    if (tagSkipDecided || surface === null) return;
    const tag = surface === "thought" ? "想）" : "说）";
    const wsMatch = buffered.match(/^[\s　]*/);
    const wsLen = wsMatch !== null ? wsMatch[0].length : 0;
    if (buffered.length < wsLen + tag.length) {
      // Not enough chars yet — wait for next delta.
      return;
    }
    if (buffered.slice(wsLen, wsLen + tag.length) === tag) {
      tagSkipPos = wsLen + tag.length;
      emittedTail = tagSkipPos;
    }
    // else: tag malformed; tagSkipPos stays 0, verbatim emission.
    tagSkipDecided = true;
  };

  /**
   * Stream `buffered.slice(emittedTail, safeEnd)` to the sink with
   * speech/thought rules AND with leading/trailing whitespace stripping.
   *
   * Pre-emit: skip leading whitespace until `bodyStarted` flips to true
   * (i.e. the first non-ws char of the body has arrived).
   *
   * Post-emit: hold back any trailing whitespace at the end of the slice
   * — if the next chunk brings more non-ws content the held-back ws is
   * emitted as internal whitespace; if the stream ends, the held-back
   * ws is discarded by the final-flush block below.
   */
  const flushToSink = (safeEnd: number): void => {
    if (
      surface === null ||
      !tagSkipDecided ||
      opts.sink === undefined ||
      safeEnd <= emittedTail
    ) {
      return;
    }
    let start = emittedTail;
    if (!bodyStarted) {
      while (start < safeEnd && /\s/.test(buffered.charAt(start))) {
        start++;
      }
      if (start >= safeEnd) {
        // Still all whitespace — hold and wait.
        emittedTail = safeEnd;
        return;
      }
      bodyStarted = true;
    }
    let end = safeEnd;
    while (end > start && /\s/.test(buffered.charAt(end - 1))) {
      end--;
    }
    if (end > start) {
      // Slice 4 (streamed == committed): drop complete stray open tags the
      // commit path would remove, so the tag never types on screen only to
      // vanish at the block swap. The emit boundary held any partial tag,
      // so this only ever sees complete ones.
      const chunk = stripStrayFromChunk(buffered.slice(start, end), surface);
      if (chunk.length === 0) {
        emittedTail = end; // the slice was one whole stray tag — consume it
        return;
      }
      if (surface === "speech") {
        ensureBegin(surface, chunk);
        if (beginCalled) opts.sink.streamHertaToken(chunk);
      } else {
        ensureBegin(surface, chunk);
      }
      emittedTail = end;
    }
    // Else: slice was all-whitespace-with-no-leading-ws-to-skip; hold
    // it. emittedTail stays put so we re-evaluate on the next call.
  };

  for await (const ev of opts.provider.streamCompletion(
    {
      model: opts.model,
      prompt: opts.prompt,
      stop: [STOP_SPEECH_CLOSE, STOP_THOUGHT_CLOSE, STOP_OPENER_USER],
      // Capped (slice 3); the supervisor call is deadline-only by design —
      // see PRIMARY_COMPLETION_MAX_TOKENS.
      maxTokens: PRIMARY_COMPLETION_MAX_TOKENS,
    },
    opts.signal,
  )) {
    if (ev.type === "text-delta") {
      buffered += ev.text;

      if (surface === null) {
        const detected = detectSurface(buffered);
        if (detected !== null) surface = detected;
      }

      tryDecideTagSkip();

      // Only forward chunks AFTER the tag-skip position is decided.
      // This prevents partial-tag bytes from reaching the sink
      // across split deltas (delta 1 = "说", delta 2 = "）好。").
      // LIVE_EMIT_HOLD_SEQS also holds partial STRAY tags (slice 4).
      // firstStopIndex caps the emit at any COMPLETE stop marker a
      // misbehaving provider streamed past (fence-fuzz, 2026-07-09).
      flushToSink(
        Math.min(
          safeEmitBoundary(buffered, LIVE_EMIT_HOLD_SEQS),
          firstStopIndex(buffered, STOP_SEQS),
        ),
      );
    } else if (ev.type === "finish") {
      break;
    }
  }

  // End-of-stream. If surface was never detected (empty stream, or model
  // emitted only the stop seq), default to speech. Do NOT call
  // beginHertaStream here — begin only fires when there is content.
  if (surface === null) surface = "speech";

  // Stream might have been short enough that we never accumulated full
  // tag length during the loop — decide now with whatever we have.
  tryDecideTagSkip();

  // Clean the raw buffer's tail before committing. Two exclusive cases:
  //   - A COMPLETE stop marker exists: cut exactly at the first one (where a
  //     stop-honoring provider would have ended the stream — matches the
  //     live emit cap above, so streamed == committed even against a
  //     provider that streams past its stops; fence-fuzz 2026-07-09). The
  //     cut point is exact, so prose legitimately ending in `（` right
  //     before the marker is preserved — no dangling-strip afterwards.
  //   - No complete marker: the stream may have ended mid-marker; strip a
  //     DANGLING partial prefix like `（/` (the `.trim()` below only
  //     removes whitespace, not the full-width `（`).
  const stopIdx = firstStopIndex(buffered, STOP_SEQS);
  const withoutClose =
    stopIdx < buffered.length
      ? buffered.slice(0, stopIdx)
      : stripDanglingStopPrefix(buffered, STOP_SEQS);

  // cleanText = buffer past the tag (and past the close-tag strip),
  // with leading and trailing whitespace stripped. Use `tagSkipPos`
  // (NOT `emittedTail`) — the committed block body is the full content
  // after the tag, independent of how much we've already streamed via
  // `streamHertaToken`. Clamp to handle the edge case where
  // `tagSkipPos` exceeds `withoutClose.length` (close tag started
  // right after the open tag). The trim mirrors the streaming-time
  // skip-leading / hold-back-trailing logic so the record stores
  // exactly what the user saw on screen.
  const cleanStart = Math.min(tagSkipPos, withoutClose.length);
  const cleanText = withoutClose.slice(cleanStart).trim();

  // Flush any held tail: content in `withoutClose` past `emittedTail`
  // that wasn't streamed during the loop (held back by safeEmitBoundary
  // pending stop-seq resolution OR by the leading/trailing whitespace
  // skip above). Apply the same leading-skip + trailing-strip rules
  // so the final flush doesn't reintroduce blank lines.
  if (opts.sink !== undefined && emittedTail < withoutClose.length) {
    let start = emittedTail;
    let end = withoutClose.length;
    if (!bodyStarted) {
      while (start < end && /\s/.test(withoutClose.charAt(start))) {
        start++;
      }
      if (start < end) bodyStarted = true;
    }
    while (end > start && /\s/.test(withoutClose.charAt(end - 1))) {
      end--;
    }
    if (end > start) {
      // Slice 4: the emit-boundary hold parks a complete stray tag at the
      // stream's end; strip it here (the commit path removes it too) and
      // re-trim the exposed trailing whitespace so streamed == committed.
      const tailChunk = stripStrayFromChunk(
        withoutClose.slice(start, end),
        surface,
      ).replace(/\s+$/, "");
      if (tailChunk.length > 0) {
        if (surface === "speech") {
          ensureBegin(surface, tailChunk);
          if (beginCalled) opts.sink.streamHertaToken(tailChunk);
        } else {
          ensureBegin(surface, tailChunk);
        }
      }
    }
  }

  // begin/end calls must be balanced — the renderer's cursor advances on
  // endHertaStream, and we only want that advance when a block will
  // commit to TerminalRecord.
  if (beginCalled) opts.sink?.endHertaStream();

  return { surface, text: cleanText };
}

/**
 * Empty-speech recovery ladder. Drives up to
 * `EMPTY_SPEECH_RETRY_TEMPERATURES.length` retry attempts of phase-2
 * speech with `isSpeechRetry: true` (PHASE_TWO_SPEECH_RETRY_HINT) and
 * a rising temperature ladder. Exits as soon as the model produces
 * non-empty content, OR returns the final still-empty result after
 * exhausting the ladder.
 *
 * All attempts pass `deferStreaming: true` — the caller (actor's
 * supervisor block or veto-retry path) is responsible for rendering
 * the eventual non-empty text via `slowStreamSpeech` + fastForward
 * (on supervisor OK) or for committing it without rendering on
 * supervisor-veto. The caller also handles the "still empty after
 * the ladder" fallback (typically: terminate the turn gracefully).
 *
 * Used in two places:
 *   1. After the initial phase-2 speech if it came back empty
 *      (post-meta-think failure mode).
 *   2. After the supervisor-veto-retry if THAT came back empty
 *      (the veto-retry's vetoHint failed to elicit content;
 *      bumping temperature is the documented recovery per
 *      DeepSeek's parameter-settings guide).
 *
 * Always returns `{ surface: "speech", text }` — the caller relies
 * on the surface for downstream branching.
 */
export async function recoverEmptySpeech(opts: {
  deps: ActorTurnDeps;
  record: TerminalRecord;
  priorTurnLength: number;
  signal: AbortSignal;
  recap?: string;
  recapBoundaryIndex?: number;
  /** What the attempt that sent us here did wrong. Recomputed after every
   *  ladder attempt, so the correction always matches the LAST failure
   *  rather than the first one. */
  cause?: RetryCause;
}): Promise<{ surface: Surface; text: string }> {
  let cause: RetryCause = opts.cause ?? "empty";
  let result: { surface: Surface; text: string } = {
    surface: "speech",
    text: "",
  };
  for (
    let attempt = 0;
    attempt < EMPTY_SPEECH_RETRY_TEMPERATURES.length;
    attempt += 1
  ) {
    const temperature = EMPTY_SPEECH_RETRY_TEMPERATURES[attempt];
    const phaseTwoOpts: Parameters<typeof runPhaseTwo>[0] = {
      deps: opts.deps,
      record: opts.record,
      priorTurnLength: opts.priorTurnLength,
      surface: "speech",
      signal: opts.signal,
      isSpeechRetry: true,
      ...(opts.recap !== undefined ? { recap: opts.recap } : {}),
      recapBoundaryIndex: opts.recapBoundaryIndex ?? 0,
      // Per-attempt hint variant from PHASE_TWO_SPEECH_RETRY_HINTS:
      //   idx 0 → base ("you closed empty, write a sentence")
      //   idx 1 → specific-point anchor
      //   idx 2 → mechanical first-character forcing
      retryAttemptIndex: attempt,
      retryCause: cause,
      // Defer sink streaming — caller drives rendering once the
      // recovery returns (typically via the supervisor block's
      // slowStreamSpeech path).
      deferStreaming: true,
    };
    if (temperature !== undefined) {
      phaseTwoOpts.temperature = temperature;
    }
    result = await runPhaseTwo(phaseTwoOpts);
    // Keep climbing the ladder on a slot-only completion too — accepting the
    // first `{需要说的话}` would spend the retries and still commit garbage.
    const next = retryCause(result.text);
    if (next === undefined) break;
    cause = next;
  }
  return result;
}

/**
 * Empty-thought recovery ladder. Mirrors `recoverEmptySpeech` for the
 * thought surface — up to `EMPTY_SPEECH_RETRY_TEMPERATURES.length`
 * (the same ladder is reused; the temperature trajectory works equally
 * well for both surfaces) attempts of phase-2 thought with
 * `isThoughtRetry: true` and a rising temperature.
 *
 * Each attempt uses a different `PHASE_TWO_THOUGHT_RETRY_HINTS`
 * variant (base / specific-anchor / mechanical-force) — varying the
 * hint angle gives the model a different framing to break out of the
 * deterministic-empty-output rut, complementing the temperature bump.
 *
 * Exits as soon as the model produces non-empty content, OR returns
 * the final empty result after exhausting the ladder. The caller
 * (actor's main loop's empty-thought branch) handles the still-empty
 * case by incrementing `consecutiveEmptyThoughtIters` and forcing
 * speech on the next iteration.
 *
 * Always returns `{ surface: "thought", text }`.
 */
export async function recoverEmptyThought(opts: {
  deps: ActorTurnDeps;
  record: TerminalRecord;
  priorTurnLength: number;
  signal: AbortSignal;
  recap?: string;
  recapBoundaryIndex?: number;
  /** What the attempt that sent us here did wrong; recomputed after every
   *  attempt, exactly as on the speech ladder. */
  cause?: RetryCause;
}): Promise<{ surface: Surface; text: string }> {
  let cause: RetryCause = opts.cause ?? "empty";
  let result: { surface: Surface; text: string } = {
    surface: "thought",
    text: "",
  };
  for (
    let attempt = 0;
    attempt < EMPTY_SPEECH_RETRY_TEMPERATURES.length;
    attempt += 1
  ) {
    const temperature = EMPTY_SPEECH_RETRY_TEMPERATURES[attempt];
    const phaseTwoOpts: Parameters<typeof runPhaseTwo>[0] = {
      deps: opts.deps,
      record: opts.record,
      priorTurnLength: opts.priorTurnLength,
      surface: "thought",
      signal: opts.signal,
      isThoughtRetry: true,
      retryAttemptIndex: attempt,
      retryCause: cause,
      ...(opts.recap !== undefined ? { recap: opts.recap } : {}),
      recapBoundaryIndex: opts.recapBoundaryIndex ?? 0,
      // Thought streams write the "(思考中…)" indicator via the sink
      // begin/end protocol; no deferral. Subsequent ladder attempts
      // re-emit the indicator on each call — harmless since the
      // sink's endHertaStream clears it before the next begin.
    };
    if (temperature !== undefined) {
      phaseTwoOpts.temperature = temperature;
    }
    result = await runPhaseTwo(phaseTwoOpts);
    // Slot-only counts as unusable here too: a placeholder thought never
    // reaches the user, but it lands in the record and therefore in next
    // turn's prompt, where it reads as something she actually thought.
    const next = retryCause(result.text);
    if (next === undefined) break;
    cause = next;
  }
  return result;
}

/**
 * Phase 2 — Slice 13 two-phase generation. Builds a fresh prompt with
 * the attached meta-think section spliced in at the right position
 * (see `serializeActorPrompt` in `actor-prompt.ts`), forces the open
 * tag for the resolved surface, omits the `〔接下来〕` hint, and streams
 * content.
 * Used for both regular iterations and forced-speech (soft-guard)
 * cases.
 *
 * SPEC v0.2 Slice 13 §7.2, §7.3.
 */
export async function runPhaseTwo(opts: {
  deps: ActorTurnDeps;
  record: TerminalRecord;
  priorTurnLength: number;
  surface: Surface;
  signal: AbortSignal;
  /**
   * Long-session recap + boundary, computed once per turn by the main
   * loop and threaded through unchanged. The recap is about OLD dialogue
   * (history before this turn) and is therefore orthogonal to the surface
   * being generated; every retry / recovery / veto path reuses the same
   * value. Defaults to no compaction (`recapBoundaryIndex: 0`).
   */
  recap?: string;
  recapBoundaryIndex?: number;
  /**
   * When true, this is a retry call after the first attempt returned
   * an empty body. Uses `PHASE_TWO_SPEECH_RETRY_HINT` instead of the
   * standard hint, and is only valid for `surface: "speech"`. The
   * caller is expected to retry at most once.
   */
  isSpeechRetry?: boolean;
  /**
   * When true, this is a retry call after the first phase-2 thought
   * attempt returned an empty body (model emitted `（/我 想）` at
   * position 0). Uses `PHASE_TWO_THOUGHT_RETRY_HINT` instead of the
   * standard thought hint, and is only valid for `surface: "thought"`.
   * The caller is expected to retry at most once; if the retry also
   * returns empty, the actor bails to speech for the iteration.
   */
  isThoughtRetry?: boolean;
  /**
   * When set, this call is a supervisor-veto retry. Uses
   * `buildSupervisorVetoHint(supervisorVetoReason)` as the format
   * hint with the reason interpolated. Mutually exclusive with
   * `isSpeechRetry`; if both happen to be set, supervisorVetoReason
   * wins (defensive choice).
   */
  supervisorVetoReason?: string;
  /**
   * When set (and `surface === "thought"`), this call is the rethink
   * stage of the two-stage veto recovery (2026-07-18 rethink-respeak):
   * a FRESH （我 想） that digests the veto reason before the respeak.
   * Uses `buildSupervisorVetoHint(hints.supervisorRethinkTemplate,
   * reason)` — a DOMAIN-NEUTRAL hint that fits receipts vetoes and
   * register vetoes alike (the single-stage veto hint is receipts-
   * flavored and measurably derails non-coding redos; see
   * scripts/respeak-lab.mjs).
   */
  supervisorRethinkReason?: string;
  /**
   * When true (and `surface === "speech"`), this is the respeak stage
   * AFTER a committed rethink thought. Uses the slim static
   * `hints.supervisorRespeak` hint — the veto reason itself lives in
   * the fresh thought already spliced into the record. Mutually
   * exclusive with `supervisorVetoReason` (the reason-bearing hint
   * wins if both are set, defensively).
   */
  isPostRethinkRespeak?: boolean;
  /**
   * When set, the rejected speech body from the prior (vetoed) phase-2
   * speech attempt. The serializer wraps it in `（我 说）...（/我 说）`
   * and splices it after the meta-think section and before the
   * veto-format-hint, so the retry can see what it just said. NEVER
   * persisted — recomputed per retry call.
   *
   * SPEC v0.2 Supervisor design §6.5.
   */
  vetoedSpeech?: string;
  /**
   * When true (and `surface === "speech"`), do not stream the output
   * to `deps.sink` during this call. Used by the actor's main loop to
   * defer rendering until the supervisor verdict is known: on OK, the
   * caller replays the buffered text to the sink; on veto, it is
   * discarded silently and the retry streams normally. NEVER applied
   * when `surface === "thought"` — the thought indicator must still
   * appear during the supervisor wait. Defaults to false.
   *
   * SPEC v0.2 Supervisor design §6.6.
   */
  deferStreaming?: boolean;
  /**
   * Sampling temperature forwarded verbatim to the provider's
   * `streamCompletion` request. `undefined` (the default) uses the
   * provider/model's baked-in default. Currently set by the actor's
   * empty-speech retry ladder which bumps temperature on successive
   * retries (see `EMPTY_SPEECH_RETRY_TEMPERATURES`) to break the model
   * out of a deterministic empty-output trap.
   */
  temperature?: number;
  /**
   * Zero-based attempt index for retry-hint variant selection. Only
   * consulted when `isSpeechRetry === true` OR `isThoughtRetry ===
   * true`. Picks from `PHASE_TWO_SPEECH_RETRY_HINTS[idx]` / the
   * matching thought array — variant 0 is the base "you closed
   * empty" hint, variant 1 anchors on a specific point in the user's
   * message, variant 2 escalates to mechanical first-character
   * forcing. Out-of-range indexes (including `undefined`) fall back
   * to variant 0.
   *
   * Aligned with `EMPTY_SPEECH_RETRY_TEMPERATURES` so the hint
   * variation and temperature bump step together per attempt.
   */
  retryAttemptIndex?: number;
  /**
   * Which speech-retry ladder to draw the hint from — i.e. what the
   * attempt that triggered this retry actually did wrong. Only consulted
   * when `isSpeechRetry === true`; defaults to the empty ladder, which is
   * the historical behaviour and the far more common failure.
   */
  retryCause?: RetryCause;
  /**
   * Live-feed sink for the supervised first-pass speech (SPEC §4). When set,
   * safe-boundary chunks stream to it as they generate (instead of
   * `deferStreaming` buffering silently). Mutually exclusive with
   * `deferStreaming`; only valid for `surface: "speech"`.
   */
  onLiveToken?: (chunk: string) => void;
}): Promise<{ surface: Surface; text: string }> {
  const retryIdx = opts.retryAttemptIndex ?? 0;
  const isRetry = opts.isThoughtRetry === true || opts.isSpeechRetry === true;
  // Final-retry body seed: only applies on the LAST attempt of the
  // retry ladder (highest retry index = ladder length - 1). Earlier
  // retries get a fresh chance without the seed so the model can
  // produce naturally-flowing content first. See
  // `FINAL_RETRY_BODY_SEED` JSDoc for the rationale.
  const isFinalRetryAttempt =
    isRetry && retryIdx === EMPTY_SPEECH_RETRY_TEMPERATURES.length - 1;
  const bodySeed = isFinalRetryAttempt ? FINAL_RETRY_BODY_SEED : undefined;

  const hints = resolveHints(opts.deps);
  let formatHint: string;
  if (opts.surface === "thought") {
    if (opts.supervisorRethinkReason !== undefined) {
      formatHint = buildSupervisorVetoHint(
        hints.supervisorRethinkTemplate,
        opts.supervisorRethinkReason,
      );
    } else if (opts.isThoughtRetry === true) {
      // Two ladders here as well — see the speech branch below. A thought
      // that came back as a placeholder did not "close with nothing in it",
      // so the empty ladder's accusation would be wrong in the same way.
      const ladder =
        opts.retryCause === "slot"
          ? hints.thoughtSlotRetry
          : hints.thoughtRetry;
      formatHint = ladder[retryIdx] ?? ladder[0];
    } else {
      formatHint = hints.phase2Thought;
    }
  } else if (opts.supervisorVetoReason !== undefined) {
    formatHint = buildSupervisorVetoHint(
      hints.supervisorVetoTemplate,
      opts.supervisorVetoReason,
    );
  } else if (opts.isPostRethinkRespeak === true) {
    formatHint = hints.supervisorRespeak;
  } else if (opts.isSpeechRetry === true) {
    // Two ladders, picked by WHAT WENT WRONG on the attempt that triggered
    // this retry (2026-08-12). The empty ladder accuses the model of closing
    // early and demands "not blank"; that is the wrong correction for a
    // placeholder, which is not blank at all. `recoverEmptySpeech`
    // recomputes the cause after every attempt, so a run that starts empty
    // and turns into a slot switches ladders mid-flight.
    const ladder =
      opts.retryCause === "slot" ? hints.speechSlotRetry : hints.speechRetry;
    formatHint = ladder[retryIdx] ?? ladder[0];
  } else {
    formatHint = hints.phase2Speech;
  }
  const docPrompt: ActorPrompt = {
    staticPrefix: opts.deps.staticPrefix,
    record: opts.record,
    priorTurnLength: opts.priorTurnLength,
    attachedMetaThink: opts.deps.attachedMetaThink,
    metaThinkSurface: opts.surface,
    formatHint,
    openTag: opts.surface === "thought" ? "（我 想）" : "（我 说）",
    ...(bodySeed !== undefined ? { openTagSuffix: bodySeed } : {}),
    ...(opts.vetoedSpeech !== undefined
      ? { replayBlock: `（我 说）\n${opts.vetoedSpeech}\n（/我 说）` }
      : {}),
    ...(opts.recap !== undefined ? { recap: opts.recap } : {}),
    recapBoundaryIndex: opts.recapBoundaryIndex ?? 0,
    lang: opts.deps.lang ?? "zh",
  };
  const prompt = serializeActorPrompt(docPrompt);
  opts.deps.onPrompt?.("phase2", prompt);

  // Defer the sink for supervised speech that buffers (no live feed); a live
  // feed routes chunks to onLiveToken instead and the controller owns rendering.
  const liveFeeding =
    opts.onLiveToken !== undefined && opts.surface === "speech";
  const effectiveSink =
    liveFeeding || (opts.deferStreaming === true && opts.surface === "speech")
      ? undefined
      : opts.deps.sink;

  let result = await consumePhaseTwoStream({
    provider: opts.deps.provider,
    model: opts.deps.model,
    prompt,
    surface: opts.surface,
    signal: opts.signal,
    ...(effectiveSink !== undefined ? { sink: effectiveSink } : {}),
    ...(liveFeeding ? { onLiveToken: opts.onLiveToken } : {}),
    ...(opts.temperature !== undefined
      ? { temperature: opts.temperature }
      : {}),
  });
  // Dump shows the prompt (with the seed already in the open tag if
  // any) + the model's RAW response. The seed is NOT in result.text
  // yet at this point — the consumer only sees the model's text-
  // delta bytes, not the prompt's open-tag-suffix.
  // Raw output goes to the trace BEFORE any repair, so a hint echo stays
  // visible in the dump rather than being silently cleaned up.
  opts.deps.onPrompt?.("phase2-out", `${prompt}${result.text}`);
  // Hint-echo repair (live lab 2026-08-12). runPhaseTwo is the single funnel
  // for every actor generation — first pass, both ladders, rethink, respeak —
  // so repairing here means the usability checks, the ladders and the commit
  // guards downstream all see de-scaffolded text. Ordering is load-bearing in
  // both directions: BEFORE the body seed below (which would otherwise prefix
  // `……` onto a bracket and stop it matching), and before the callers'
  // isUnusableBlock checks (so `〔{需要说的话}〕` unwraps and is then caught
  // as a slot instead of committing).
  const repaired = stripHintScaffolding(result.text);
  if (repaired !== result.text) {
    result = { surface: result.surface, text: repaired };
  }
  // Final-retry body seed: prepend the seed to the committed body
  // so:
  //   - If the model continued after `……`: body is `……{continuation}`.
  //   - If the model closed immediately (model didn't take the cue
  //     in the prompt either): body is just `……` — a non-empty
  //     Herta-voice fallback (dismissive trailing-off / silent
  //     contemplation) instead of the previous silent-failure mode.
  // The seed becomes part of the streamed render too — downstream
  // slow-stream / unified-replay consume `result.text` which now
  // includes the seed at the start.
  if (bodySeed !== undefined) {
    // A slot-only body is DISCARDED rather than prefixed (2026-08-12).
    // `……{需要说的话}` is no longer whole-string slot-shaped, so it would
    // sail past the commit-boundary guard and put the placeholder on screen
    // with an ellipsis in front of it. Dropping it lets the seed stand alone
    // — which is exactly the graceful non-empty fallback this seed exists to
    // provide, and a better end-of-ladder outcome than a dropped turn.
    const body = isPlaceholderOnly(result.text) ? "" : result.text;
    return { surface: result.surface, text: `${bodySeed}${body}` };
  }
  return result;
}

/**
 * Stream phase 2's content. Stop sequences: close tags only (no
 * need for surface-open tags — the surface is forced in the prompt).
 * Uses deferred-begin pattern from Slice 10 hotfix.
 */
async function consumePhaseTwoStream(opts: {
  provider: CompletionProviderAdapter;
  model: string;
  prompt: string;
  surface: Surface;
  signal: AbortSignal;
  sink?: ActorStreamingSink;
  /**
   * Sampling temperature passed verbatim to the provider's
   * `streamCompletion` request. `undefined` (the default) means the
   * provider/model uses its baked-in default (DeepSeek's chat default
   * is 1.3 per their public parameter-settings guide). Used by the
   * empty-speech retry ladder in the actor's main loop, which bumps
   * the temperature on each successive retry to break the model out
   * of a deterministic empty-output trap.
   */
  temperature?: number;
  /**
   * Live-feed sink (SPEC live-feed-supervised-reveal §4). When set, safe-boundary
   * chunks are pushed here (paced by a LiveSlowStreamController) INSTEAD of the
   * immediate `sink.streamHertaToken`. Mutually exclusive with `sink` — the live
   * controller owns begin/render. Leading/trailing-whitespace handling still
   * applies, so the controller never receives the blank line above the speech.
   */
  onLiveToken?: (chunk: string) => void;
}): Promise<{
  surface: Surface;
  text: string;
}> {
  let buffered = "";
  let emittedTail = 0;
  let beginCalled = false;
  // Tracks whether at least one non-whitespace char has reached the
  // sink. Until true, leading whitespace in the body (the `\n` after
  // the open tag, per the corpus format) is held back so the user
  // doesn't see a blank line above Herta's speech. After it goes
  // true, trailing-whitespace runs are held back too — a run that
  // ends the stream gets dropped; a run followed by more non-ws gets
  // emitted as internal whitespace on the next chunk.
  let bodyStarted = false;

  /**
   * Both speech and thought require non-whitespace to begin. The
   * leading-ws skip in `flushToSink` ensures `streamHertaToken` is
   * never called with a whitespace-only prefix; this guard mirrors
   * the same rule for `beginHertaStream`. Pre-2026-05-23, speech
   * allowed any chunk (including whitespace) to begin, which
   * produced the blank-line-above-speech artifact.
   */
  const shouldBegin = (_s: Surface, chunk: string): boolean => {
    return chunk.trim().length > 0;
  };

  const ensureBegin = (s: Surface, chunk: string): void => {
    if (!beginCalled && shouldBegin(s, chunk) && opts.sink !== undefined) {
      opts.sink.beginHertaStream(s);
      beginCalled = true;
    }
  };

  /**
   * Stream `buffered.slice(emittedTail, safeEnd)` to the sink with
   * leading-ws skip + trailing-ws hold-back.
   */
  const flushToSink = (safeEnd: number): void => {
    if (opts.sink === undefined && opts.onLiveToken === undefined) {
      return; // pure defer/buffer: nothing to emit
    }
    if (safeEnd <= emittedTail) return;
    let start = emittedTail;
    if (!bodyStarted) {
      while (start < safeEnd && /\s/.test(buffered.charAt(start))) {
        start++;
      }
      if (start >= safeEnd) {
        emittedTail = safeEnd;
        return;
      }
      bodyStarted = true;
    }
    let end = safeEnd;
    while (end > start && /\s/.test(buffered.charAt(end - 1))) {
      end--;
    }
    if (end > start) {
      // Slice 4 (streamed == committed): drop complete stray open tags —
      // see consumeBranchStream. Also keeps the live-feed `retryAccum`
      // (fed from onLiveToken) consistent with the stripped commit text,
      // so the retract floor indexes exactly what is on screen.
      const chunk = stripStrayFromChunk(
        buffered.slice(start, end),
        opts.surface,
      );
      if (chunk.length === 0) {
        emittedTail = end; // the slice was one whole stray tag — consume it
        return;
      }
      if (opts.onLiveToken !== undefined) {
        // Live path: the LiveSlowStreamController owns begin/render.
        opts.onLiveToken(chunk);
      } else if (opts.surface === "speech") {
        ensureBegin(opts.surface, chunk);
        if (beginCalled && opts.sink !== undefined) {
          opts.sink.streamHertaToken(chunk);
        }
      } else {
        ensureBegin(opts.surface, chunk);
      }
      emittedTail = end;
    }
  };

  for await (const ev of opts.provider.streamCompletion(
    {
      model: opts.model,
      prompt: opts.prompt,
      stop: [STOP_SPEECH_CLOSE, STOP_THOUGHT_CLOSE, STOP_OPENER_USER],
      // Capped (slice 3); the supervisor call is deadline-only by design —
      // see PRIMARY_COMPLETION_MAX_TOKENS.
      maxTokens: PRIMARY_COMPLETION_MAX_TOKENS,
      ...(opts.temperature !== undefined
        ? { temperature: opts.temperature }
        : {}),
    },
    opts.signal,
  )) {
    if (ev.type === "text-delta") {
      buffered += ev.text;
      // LIVE_EMIT_HOLD_SEQS also holds partial STRAY tags (slice 4).
      // firstStopIndex caps the emit at any COMPLETE stop marker a
      // misbehaving provider streamed past (fence-fuzz, 2026-07-09).
      flushToSink(
        Math.min(
          safeEmitBoundary(buffered, LIVE_EMIT_HOLD_SEQS),
          firstStopIndex(buffered, STOP_SEQS),
        ),
      );
    } else if (ev.type === "finish") {
      break;
    }
  }

  // See consumeBranchStream: cut exactly at the FIRST complete stop marker
  // when one exists (matching the live emit cap, so streamed == committed;
  // prose ending in `（` right before the marker survives), else strip a
  // dangling partial marker prefix left by a stream that ended mid-marker.
  const phase2StopIdx = firstStopIndex(buffered, STOP_SEQS);
  const withoutClose =
    phase2StopIdx < buffered.length
      ? buffered.slice(0, phase2StopIdx)
      : stripDanglingStopPrefix(buffered, STOP_SEQS);
  // Trim the committed body so the record matches what reached the
  // sink (the streaming-time skip + hold-back) char-for-char.
  const cleanText = withoutClose.trim();

  if (
    (opts.sink !== undefined || opts.onLiveToken !== undefined) &&
    emittedTail < withoutClose.length
  ) {
    let start = emittedTail;
    let end = withoutClose.length;
    if (!bodyStarted) {
      while (start < end && /\s/.test(withoutClose.charAt(start))) {
        start++;
      }
      if (start < end) bodyStarted = true;
    }
    while (end > start && /\s/.test(withoutClose.charAt(end - 1))) {
      end--;
    }
    if (end > start) {
      // Slice 4: strip a boundary-held complete stray tag + re-trim the
      // exposed trailing whitespace — see consumeBranchStream's tail flush.
      const tailChunk = stripStrayFromChunk(
        withoutClose.slice(start, end),
        opts.surface,
      ).replace(/\s+$/, "");
      if (tailChunk.length > 0) {
        if (opts.onLiveToken !== undefined) {
          // Live path: the LiveSlowStreamController owns begin/render.
          opts.onLiveToken(tailChunk);
        } else if (opts.surface === "speech") {
          ensureBegin(opts.surface, tailChunk);
          if (beginCalled && opts.sink !== undefined) {
            opts.sink.streamHertaToken(tailChunk);
          }
        } else {
          ensureBegin(opts.surface, tailChunk);
        }
      }
    }
  }

  if (beginCalled) opts.sink?.endHertaStream();

  return { surface: opts.surface, text: cleanText };
}

/**
 * Detect surface from buffered chars. Returns "thought" / "speech" as soon
 * as the surface tag's distinguishing character is visible; returns null
 * if not enough chars yet.
 */
function detectSurface(buffered: string): Surface | null {
  // The model completes with `想）...` or `说）...` (the open tag `（我 `
  // is in the prompt). Whitespace tolerance: skip leading whitespace.
  const trimmedStart = buffered.replace(/^[\s　]+/, "");
  if (trimmedStart.length === 0) return null;
  const first = trimmedStart.charAt(0);
  if (first === "想") return "thought";
  if (first === "说") return "speech";
  // Any other first char — defensively call it speech (malformed completion).
  return "speech";
}
