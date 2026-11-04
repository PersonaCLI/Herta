import type {
  ActorPromptFrame,
  ProviderAdapter,
  ProviderEvent,
  TerminalRecord,
} from "@herta/core";
import {
  type StaticHertaPrefix,
  serializeActorPrompt,
} from "./actor-prompt.js";
import { sanitizeActorText } from "./escape.js";
import type { PromptLang } from "./prompt-lang.js";
import { buildRecapPrompt, validateRecap } from "./recap-prompt.js";
import { serializeTerminalRecord } from "./serialize.js";
import {
  type CompactionConfig,
  compactThreshold,
  decideRecap,
  estimatePromptTokens,
  type RecapAction,
  type RecapCache,
  recordSpanTokens,
  selectBoundary,
  tailWithinTokenBudget,
} from "./session-recap.js";

/**
 * Per-session runtime for recap compaction. The config is static; `summarize`,
 * `cacheRead`, `cacheWrite` are injected (real ones wired at the driver
 * bootstrap); `consecutiveFailures` is mutable session state for the circuit
 * breaker.
 */
export interface RecapRuntime {
  readonly config: CompactionConfig;
  readonly guide: string;
  /** Head excerpt of HertaBio (already bounded to config.maxBioChars by the
   *  bootstrap) — a first-person voice/style anchor for the recap. "" if absent. */
  readonly bio: string;
  /** Language of LLM-facing recap prose (summarizer instructions, elision
   *  notes, placeholder recaps). Defaults "zh"; record grammar stays CN. */
  readonly lang?: PromptLang;
  summarize(input: {
    system: string;
    user: string;
    signal: AbortSignal;
  }): Promise<string>;
  cacheRead(): RecapCache | null;
  cacheWrite(cache: RecapCache): void;
  /** Delete the persisted sidecar (optional — wired by buildRecapRuntime).
   *  Called on rewind when the truncated record no longer validates the
   *  cached boundary. */
  cacheInvalidate?(): void;
  consecutiveFailures: number;
  /** Skipped summarizer opportunities since the circuit breaker opened —
   *  drives the half-open probe cadence (`breakerProbeEveryNSkips`). Only
   *  consulted while the breaker is open. */
  skippedWhileOpen: number;
}

export interface PreparedRecap {
  readonly recap?: string;
  readonly recapBoundaryIndex: number;
}

/** CN/EN co-located recap-runtime prose (EN interaction slice 3b). The 〔…〕
 *  corner brackets are the record's aside convention and stay in both. */
const RUNTIME_TEXT = {
  zh: {
    placeholder: (droppedTurns: number) =>
      `〔之前还有约 ${droppedTurns} 段对话，细节略。〕`,
    elided: (droppedBlocks: number) =>
      `〔更早的 ${droppedBlocks} 段记录因篇幅略去〕`,
    /** Head of a rolled recap trimmed to keep the stored text under the cap
     *  (self-review 2026-08-11) — see `boundRolledRecap`. */
    recapHeadElided: "〔更早的回忆因篇幅略去〕",
  },
  en: {
    placeholder: (droppedTurns: number) =>
      `〔About ${droppedTurns} earlier exchanges before this; details omitted.〕`,
    elided: (droppedBlocks: number) =>
      `〔${droppedBlocks} earlier record blocks elided for length〕`,
    recapHeadElided: "〔earlier recollection elided for length〕",
  },
} as const;

/**
 * Join a roll's backstory and addendum under a length bound that is hard in
 * every case but one: a single addendum paragraph larger than the cap passes
 * through (bounded by validation at ≤ its stated budget +400 — always under
 * the read path's 2× discard threshold, which is the cliff that matters).
 *
 * The mechanical roll (ADR 0035) made the stored recap `prior + addendum`,
 * which can exceed `maxRecapChars` — and `distrustCachedRecapText` below
 * discards the WHOLE cache past 2× the cap, on a comment that assumes the
 * write path never exceeds it. Self-review 2026-08-11 traced the corner
 * where that fires: a re-derive persistently over the summarizer input
 * budget downgrades to a roll every crossing, each adding up to a floored
 * addendum, and ~6 crossings past the first overflow the entire recap is
 * erased without a word — the amnesia the mechanical roll exists to
 * prevent, arriving later and all at once.
 *
 * So the bound is restored at the write side, and it is stated: whole
 * leading PARAGRAPHS of the backstory are dropped (the recap is
 * autobiography prose; a mid-sentence cut would read as corruption) behind
 * an elision note. This is the backstop, not the plan — the caller also
 * forces the next crossing to re-derive, which recompresses the full span
 * properly. Trimming the head keeps the newest memory, which is the half a
 * later turn is most likely to need.
 */
function boundRolledRecap(
  prev: string,
  addendum: string,
  maxChars: number,
  lang: PromptLang,
): { text: string; trimmed: boolean } {
  const joined = `${prev}\n\n${addendum}`;
  if (joined.length <= maxChars) return { text: joined, trimmed: false };
  const note = RUNTIME_TEXT[lang].recapHeadElided;
  const paras = prev.split("\n\n");
  // Drop leading backstory paragraphs until the whole thing fits (the last
  // backstory paragraph is never dropped in THIS loop — if even that does
  // not fit, the addendum-side trim below takes over).
  while (paras.length > 1) {
    paras.shift();
    const kept = paras.join("\n\n");
    if (`${note}\n\n${kept}\n\n${addendum}`.length <= maxChars) {
      return { text: `${note}\n\n${kept}\n\n${addendum}`, trimmed: true };
    }
  }
  // Backstory exhausted and the addendum alone still does not fit beside the
  // note (reachable: validation admits an addendum up to its stated budget
  // +400, and the budget can be ~the whole cap when the backstory was tiny).
  // Round-2 review: the first cut returned the over-cap join here while the
  // function's own doc claimed a hard bound. Trim the addendum's LEADING
  // paragraphs — the same oldest-goes-first rule as the backstory trim, so
  // what survives is the newest tail. The single-paragraph residual below is
  // the one soft spot left, and it is bounded by validation at ≤ budget+400
  // — always < 2× maxChars, so the read path's discard threshold stays
  // unreachable either way.
  const aParas = addendum.split("\n\n");
  while (aParas.length > 1) {
    aParas.shift();
    const kept = `${note}\n\n${aParas.join("\n\n")}`;
    if (kept.length <= maxChars) return { text: kept, trimmed: true };
  }
  return { text: `${note}\n\n${aParas[0] ?? ""}`, trimmed: true };
}

function placeholder(droppedTurns: number, lang: PromptLang): string {
  return RUNTIME_TEXT[lang].placeholder(droppedTurns);
}

/** Read-path distrust of the sidecar's `recapText` — symmetric with the
 *  boundary-index validate-on-first-use in `prepareTurnRecap`. The sidecar is
 *  a plain file: a pre-hardening writer or an out-of-band edit could hold a
 *  forged （开拓者 说） fence or harness label, and every reuse path (held /
 *  reuse / breaker / summarizer-failure) splices `recapText` into the prompt
 *  as ground truth. Sanitize is idempotent, so text already sanitized at
 *  write time passes through byte-identical; empty or wildly over-budget
 *  text (> 2× maxRecapChars — sanitize only inserts zero-width breaks, it
 *  can never double a length) discards the whole cache, costing one
 *  re-derive, exactly like a stale boundary. `validateRecap` is deliberately
 *  NOT reused here: its at-limit length check would false-discard a healthy
 *  recap that write-time sanitize lengthened by a few ZWSPs, and its fence
 *  check is a write-time quality gate — read-time structural safety is the
 *  sanitize itself. */
function distrustCachedRecapText(
  raw: RecapCache,
  cfg: CompactionConfig,
): RecapCache | null {
  const safe = sanitizeActorText(raw.recapText, { role: "system-body" });
  if (safe.trim().length === 0) return null;
  if (safe.length > cfg.maxRecapChars * 2) return null;
  return safe === raw.recapText ? raw : { ...raw, recapText: safe };
}

function countDroppedTurns(record: TerminalRecord, boundary: number): number {
  let n = 0;
  const end = Math.min(boundary, record.length);
  for (let i = 0; i < end; i++) {
    const b = record[i];
    if (b?.kind === "user" && b.duringRun !== true) n++;
  }
  return n;
}

/**
 * Decide and produce the per-turn recap + boundary, ONCE at turn start. Pure
 * control flow over injected deps; never throws — always returns a usable
 * result (last cache or a deterministic placeholder) so a failing summarizer
 * can never block the actor turn.
 */
export async function prepareTurnRecap(
  record: TerminalRecord,
  staticPrefix: StaticHertaPrefix,
  rt: RecapRuntime | undefined,
  forceCompact: boolean,
  signal: AbortSignal,
  /** Transient hint hook, called `("start")` just before the summarizer LLM
   *  call and `("end")` when it settles (success or failure). Fires ONLY when
   *  the summarizer actually runs — never on reuse / no-op turns. */
  notify?: (phase: "start" | "end") => void,
): Promise<PreparedRecap> {
  if (rt === undefined) return { recapBoundaryIndex: 0 };
  const cfg = rt.config;
  const lang = rt.lang ?? "zh";
  // `enabled` gates the AUTOMATIC threshold trigger only; a manual /compact
  // (forceCompact) always engages so the user can compact on demand even while
  // automatic compaction is off.
  if (!cfg.enabled && !forceCompact) return { recapBoundaryIndex: 0 };

  // Defensive outer guard: the contract is never-throw, so a compaction error
  // can never block the actor turn. The expected summarizer-failure path is
  // handled by the inner try/catch (→ placeholder, keep compacting); this outer
  // guard catches any unexpected error in the otherwise-pure setup and falls
  // back to no compaction (the safest result — the full record still serializes).
  try {
    // Boundary hysteresis. The compaction boundary is STICKY between
    // compactions (held in the cache). Estimate the EFFECTIVE prompt under the
    // current boundary — prefix + cached recap + record[boundary:] + tail —
    // which is what actually reaches the model. While it stays under the
    // high-water mark, hold the boundary and reuse the recap (the verbatim tail
    // just grows; no summarizer call, stable prefix). Only when the effective
    // prompt crosses the high-water mark do we advance the boundary down to the
    // low-water target (selectBoundary) and refresh the recap — so the recap is
    // re-summarized roughly once per high→low band traversal, not every turn.
    // Validate-on-first-use (spec: a stale/out-of-range cache is discarded,
    // never trusted). The cached boundary must index a 开拓者 (user) block
    // INSIDE the current record — selectBoundary only ever produces such
    // boundaries. A sidecar written against a longer/older record state
    // (truncated JSONL, out-of-band edits) would otherwise silently empty the
    // verbatim window — dropping even the fresh user message from the prompt —
    // or split an exchange mid-turn. Discarding costs one re-derive call.
    const rawCache = rt.cacheRead();
    // Discard predicate kept IDENTICAL to the two other consumers of a
    // persisted boundary — cli/src/app/main.ts and app-server/src/session.ts
    // (and prompt-exclusions' reopen filter): a valid boundary is 0 < i <
    // record.length indexing a 开拓者 (user) block. The `<= 0` lower bound
    // was previously only implicit here (masked by the `stickyBoundary <= 0`
    // check below); making it explicit removes an unproven cross-module
    // coupling the recap-boundary fuzz now asserts (2026-07-09). 0 is
    // selectBoundary's "no compaction" sentinel, never a real cached boundary.
    // A lang-mismatched cache (zh recap resumed into an en session or vice
    // versa) is discarded like a stale boundary: replaying wrong-language
    // "memory" into every prompt costs more than the one re-derive.
    const atBoundary =
      rawCache === null ? undefined : record[rawCache.boundaryIndex];
    const boundaryValid =
      rawCache !== null &&
      rawCache.lang === lang &&
      rawCache.boundaryIndex > 0 &&
      rawCache.boundaryIndex < record.length &&
      atBoundary?.kind === "user" &&
      atBoundary.duringRun !== true;
    // Text distrust is symmetric with the boundary distrust above — see
    // distrustCachedRecapText.
    const cache =
      boundaryValid && rawCache !== null
        ? distrustCachedRecapText(rawCache, cfg)
        : null;
    const stickyBoundary = cache?.boundaryIndex ?? 0;
    const stickyRecap = cache?.recapText;
    const highWater = compactThreshold(cfg);

    // "Hold" result: reuse the sticky boundary + recap when something is
    // already compacted, else no compaction. A written cache always has
    // boundaryIndex > 0 and a defined recap, so the `<= 0`/undefined case is
    // exactly "no cache yet".
    const held: PreparedRecap =
      stickyRecap === undefined || stickyBoundary <= 0
        ? { recapBoundaryIndex: 0 }
        : { recap: stickyRecap, recapBoundaryIndex: stickyBoundary };

    const effectiveTokens = estimatePromptTokens(
      serializeActorPrompt({
        staticPrefix,
        record,
        priorTurnLength: record.length,
        ...(stickyRecap !== undefined ? { recap: stickyRecap } : {}),
        recapBoundaryIndex: stickyBoundary,
        openTag: "（我 说）",
        lang,
      }),
    );

    // Under the high-water mark (and not forced): hold the sticky boundary —
    // reuse the recap, let the verbatim tail grow.
    if (effectiveTokens <= highWater && !forceCompact) return held;

    // Over the high-water mark (or forced) → advance the boundary down to the
    // low-water target and refresh the recap.
    const boundaryIndex = selectBoundary(record, cfg);
    // Whole record fits even the low-water tail — nothing more to compact.
    if (boundaryIndex <= 0) return held;

    const droppedTurns = countDroppedTurns(record, boundaryIndex);
    let action: RecapAction = decideRecap(
      cache,
      boundaryIndex,
      forceCompact,
      cfg,
    );

    // Re-derive scaling guard (spec §4's "while the span fits"). A re-derive
    // feeds the WHOLE compacted span [0, boundary) to the summarizer; past the
    // input budget it can only fail — and each failure would count toward the
    // circuit breaker, eventually freezing the rolls that still work fine.
    // Over budget, downgrade to a roll (the prior recap carries the deep
    // history as fixed backstory) — or, when the boundary didn't even advance
    // (a forced /compact), just reuse: rolling an empty aged span would only
    // paraphrase the prior recap, the exact drift re-derive exists to reset.
    if (
      action.kind === "rederive" &&
      cache !== null &&
      recordSpanTokens(record, 0, action.upTo) > cfg.maxSummarizerInputTokens
    ) {
      action =
        cache.boundaryIndex < boundaryIndex
          ? {
              kind: "roll",
              agedFrom: cache.boundaryIndex,
              agedTo: boundaryIndex,
            }
          : { kind: "reuse" };
    }

    if (action.kind === "reuse") {
      // `cache` is non-null whenever decideRecap returns reuse (its contract);
      // the placeholder fallback here is defensive and theoretically unreachable.
      return {
        recap: cache?.recapText ?? placeholder(droppedTurns, lang),
        recapBoundaryIndex: boundaryIndex,
      };
    }

    // Circuit breaker with a half-open probe. After N consecutive failures,
    // stop calling the summarizer — but not forever: a permanently-open
    // breaker would freeze the recap while the boundary keeps advancing,
    // so every over-budget turn drops more blocks that are neither verbatim
    // nor summarized — silent, progressive amnesia with no recovery (the
    // breaker only resets on a success an open breaker prevents). Instead,
    // after breakerProbeEveryNSkips skipped opportunities ONE probe attempt
    // goes through: a success closes the breaker AND rolls the whole gap
    // span (failure paths never cacheWrite, so cache.boundaryIndex still
    // marks where the last good recap ended); a failure re-opens the
    // breaker for another N skips.
    if (rt.consecutiveFailures >= cfg.maxConsecutiveRecapFailures) {
      if (rt.skippedWhileOpen < cfg.breakerProbeEveryNSkips) {
        rt.skippedWhileOpen += 1;
        return {
          recap: cache?.recapText ?? placeholder(droppedTurns, lang),
          recapBoundaryIndex: boundaryIndex,
        };
      }
      rt.skippedWhileOpen = 0;
    }

    const isRederive = action.kind === "rederive";
    const agedBlocks =
      action.kind === "rederive"
        ? record.slice(0, action.upTo)
        : record.slice(action.agedFrom, action.agedTo);
    // Deterministic input bound: however the action was chosen, the raw-turns
    // payload never exceeds the summarizer budget — keep the newest tail and
    // note the elision (reachable on a first engage over an already-huge
    // record, or a roll spanning several missed crossings).
    const bounded = tailWithinTokenBudget(
      agedBlocks,
      cfg.maxSummarizerInputTokens,
    );
    const agedTurnsText =
      bounded.droppedBlocks > 0
        ? `${RUNTIME_TEXT[lang].elided(bounded.droppedBlocks)}\n\n${serializeTerminalRecord(bounded.blocks, { lang })}`
        : serializeTerminalRecord(bounded.blocks, { lang });
    const prevRecap = isRederive ? null : (cache?.recapText ?? null);
    // Mechanical roll (E2E lab 2026-08-11): on a roll the model writes ONLY
    // the addendum and the runtime concatenates prior + addendum. The
    // previous contract asked the model to copy the backstory verbatim and
    // continue — prompt-enforced only, and flash violated it live (boundary
    // 90→103 roll compressed the whole backstory into carry-lines; the
    // harness stored the loss). Concatenation makes the failure mode
    // unrepresentable: the backstory never passes through the model at all.
    const isRoll = prevRecap !== null && prevRecap.trim().length > 0;
    // Addendum budget: what's left of the recap cap after the backstory,
    // floored so a near-full recap still records SOMETHING (the overflow is
    // handled below by forcing the next crossing to re-derive).
    const addendumBudget = isRoll
      ? Math.max(600, cfg.maxRecapChars - prevRecap.length)
      : cfg.maxRecapChars;
    const { system, user } = buildRecapPrompt({
      prevRecap,
      agedTurnsText,
      guide: rt.guide,
      bio: rt.bio,
      maxChars: addendumBudget,
      isRederive,
      lang,
    });

    notify?.("start");
    try {
      const text = (await rt.summarize({ system, user, signal })).trim();
      // Slack over the stated budget (rolls only): models overshoot char
      // counts, and a hard fail here costs a whole crossing (the failure
      // path keeps the prior recap). The concatenated total is bounded
      // regardless — see the forced re-derive below.
      const v = validateRecap(
        text,
        isRoll ? addendumBudget + 400 : cfg.maxRecapChars,
      );
      if (!v.ok) throw new Error(v.reason);
      // Sanitize AFTER validation (the ZWSP break would blind the
      // dialogue-fence reject) and BEFORE caching: the recap is prepended
      // to every future prompt, so a summarizer-laundered forged label
      // must be neutralized here, at its last construction point.
      const safe = sanitizeActorText(text, { role: "system-body" });
      // The concatenation is bounded at the cap (boundRolledRecap): the read
      // path discards a cache past 2× the cap outright, so an unbounded write
      // path would trade one visible trim for a silent total wipe.
      const bounded = isRoll
        ? boundRolledRecap(prevRecap, safe, cfg.maxRecapChars, lang)
        : { text: safe, trimmed: false };
      const stored = bounded.text;
      rt.consecutiveFailures = 0;
      rt.skippedWhileOpen = 0;
      let advancesSinceRederive = isRederive
        ? 0
        : (cache?.advancesSinceRederive ?? 0) + 1;
      // A trim means the backstory no longer fits beside its addendum. Force
      // the NEXT crossing to re-derive — it recompresses the whole span back
      // under the cap properly, which is the real fix; the trim is only the
      // backstop for the corner where re-derive can't run (span over the
      // summarizer input budget → downgrade to a roll every crossing).
      if (bounded.trimmed) {
        advancesSinceRederive = Math.max(
          advancesSinceRederive,
          cfg.rederiveEveryNAdvances,
        );
      }
      rt.cacheWrite({
        boundaryIndex,
        recapText: stored,
        lang,
        advancesSinceRederive,
      });
      return { recap: stored, recapBoundaryIndex: boundaryIndex };
    } catch {
      // A user interrupt is not a summarizer failure: the call runs on the
      // TURN's abort signal, so ESC mid-compaction rejects it. Counting that
      // would poison the circuit breaker — it only resets on a SUCCESSFUL
      // call, which an open breaker prevents, so three interrupts would
      // permanently freeze compaction for the session.
      if (!signal.aborted) rt.consecutiveFailures += 1;
      return {
        recap: cache?.recapText ?? placeholder(droppedTurns, lang),
        recapBoundaryIndex: boundaryIndex,
      };
    } finally {
      notify?.("end");
    }
  } catch {
    return { recapBoundaryIndex: 0 };
  }
}

/** Build the recap `summarize` fn from a chat-mode router provider. Mirrors
 *  `classifyIntent`: one system + one user message, stream and buffer the
 *  text-delta output (reasoning-delta and tool-calls ignored). */
export function makeRecapSummarize(
  provider: ProviderAdapter,
  now: () => string = () => new Date().toISOString(),
): RecapRuntime["summarize"] {
  return async ({ system, user, signal }) => {
    const frame: ActorPromptFrame = {
      stableSystem: system,
      memoryContext: "",
      retrievedLore: "",
      messages: [{ role: "user", text: user, ts: now() }],
      toolSchemas: [],
    };
    let buffered = "";
    for await (const ev of provider.streamChat(
      frame,
      signal,
    ) as AsyncIterable<ProviderEvent>) {
      if (ev.type === "text-delta") buffered += ev.text;
      else if (ev.type === "finish") break;
    }
    return buffered;
  };
}
