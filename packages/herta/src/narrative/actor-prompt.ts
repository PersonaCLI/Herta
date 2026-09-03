import type { TerminalRecord, TerminalRecordBlock } from "@herta/core";
import type { AttachedMetaThink } from "./meta-think.js";
import { buildMetaThinkSection } from "./meta-think.js";
import type { PromptLang } from "./prompt-lang.js";
import { serializeTerminalRecord } from "./serialize.js";

/**
 * Typed sub-sections of the static Herta prefix. Built once at session
 * startup by `buildStaticHertaPrefix` and reused for every LLM call.
 *
 * Join order in the serializer (matches the pre-refactor flat string):
 *   bio + (fewShots joined by `\n\n`) + env + opening (if present,
 *   prefixed with `### 此刻\n\n`).
 *
 * The `opening` field carries only the preamble text; the
 * `### 此刻\n\n` header is prepended by the serializer to match the
 * corpus convention (`### 废案：xxx`, `### 记录：xxx`).
 */
export interface StaticHertaPrefix {
  readonly bio: string;
  readonly env: string;
  readonly fewShots: readonly string[];
  readonly opening?: string;
}

/**
 * Structured representation of one LLM call's input for the actor
 * (narrative-completion path). `serializeActorPrompt` produces the
 * flat string DeepSeek receives.
 *
 * One instance is built per LLM call (phase-2 think, phase-2 speech,
 * in-turn beat, speech retry). The doc is
 * effectively immutable from the caller's perspective — assembled,
 * serialized, sent, discarded.
 *
 * See `docs/superpowers/specs/2026-05-18-actor-prompt-document-design.md`
 * for the design rationale.
 */
export interface ActorPrompt {
  readonly staticPrefix: StaticHertaPrefix;
  readonly record: readonly TerminalRecordBlock[];
  /** Cutoff for the prior-turn-thought filter. Set by the actor at
   *  turn start; thoughts at indices `< priorTurnLength` are dropped
   *  from the serialized record. */
  readonly priorTurnLength: number;
  /** Optional meta-think attachment. When present, the surface field
   *  below picks which text (`preThinkText` / `preSpeakText`) and
   *  which splice index (`beforeThinkIndex` / `beforeSpeakIndex`). */
  readonly attachedMetaThink?: AttachedMetaThink;
  /** Required when `attachedMetaThink` is set. Selects the surface-
   *  specific text and index from the attachment. */
  readonly metaThinkSurface?: "thought" | "speech";
  /** Optional surface-specific format-enforcement hint inserted
   *  immediately before the open tag (separated by `\n`): one of
   *  `PHASE_TWO_THOUGHT_HINT`, `PHASE_TWO_SPEECH_HINT`,
   *  `PHASE_TWO_SPEECH_RETRY_HINT`. Omit when no hint applies. */
  readonly formatHint?: string;
  /** The open tag the model continues from: `（我 想）` or `（我 说）`.
   *  (The partial `（我 ` of the removed single-phase surface detection
   *  is still serialized correctly — no trailing newline — should a
   *  caller ever pass one, but nothing in the actor does since
   *  2026-09-03.) */
  readonly openTag: string;
  /** Optional body seed appended immediately after the open tag with
   *  no separator (so the model sees the seed as the start of its
   *  surface body and continues from there). Used by the final
   *  empty-output retry to break the deterministic-empty trap: the
   *  prompt ends with e.g. `（我 说）……` so the model has TWO graceful
   *  paths — continue writing after `……`, OR close immediately and
   *  let `……` stand as the body (a meaningful Herta-voice fallback:
   *  trailing-off / dismissive silence in speech, contemplative blank
   *  in thought).
   *
   *  Callers are responsible for ALSO prepending the seed to the
   *  committed body text after the stream consumes — the model's
   *  raw text-delta doesn't include the seed (it's in the prompt,
   *  not the response), so without prepending the body would be
   *  just the model's continuation. See `runPhaseTwo` for the
   *  prepend logic.
   *
   *  NEVER persisted — synthesized per retry call. */
  readonly openTagSuffix?: string;
  /** Optional verbatim block inserted between the serialized record
   *  (with any meta-think splice applied) and the format-hint/open-tag
   *  tail. Used for supervisor-veto retries to replay the rejected
   *  speech back to the model in its natural `（我 说）...（/我 说）`
   *  form, so the retry can see what it just said and is being asked
   *  to revise. The caller is responsible for wrapping the rejected
   *  text in the proper open/close tags. NEVER persisted — synthesized
   *  per retry call and discarded after the prompt is sent.
   *
   *  SPEC v0.2 Supervisor design §6.5. */
  readonly replayBlock?: string;
  /** Whether to collapse long `\`\`\`diff … \`\`\`` fenced regions in
   *  system block bodies before serialization (N6/N6b, 2026-05-23).
   *  Default `true` — main turns / supervisor / router see compressed
   *  diffs to save context. Beat firing passes `false` so Herta sees
   *  the full diff when reacting to a fresh patch.preview. The full
   *  diff always stays in the in-memory `TerminalRecord` and the
   *  JSONL transcript — this option only affects the prompt bytes. */
  readonly compressDiffs?: boolean;
  /** Whether to collapse contiguous runs of ≥2 system blocks into
   *  a single `[历史已压缩 · 板砖]` summary before serialization
   *  (compaction, 2026-05-24). Default `true` — main turns /
   *  supervisor / router see compacted summaries. The full record
   *  always stays in `TerminalRecord` and the JSONL transcript —
   *  this option only affects the prompt bytes.
   *
   *  See docs/superpowers/specs/2026-05-24-narrative-compaction-design.md §3, §6.3. */
  readonly compactBridgeOutput?: boolean;
  /** Beat mode (M-projection-1, 2026-07-04): serialize blocks up to the
   *  PRIOR dispatch's done-marker with the default token optimizations,
   *  and everything after it — the fresh window the beat is reacting
   *  to — verbatim (full diffs, uncompacted board output). Supersedes
   *  the old beat-path blanket `compressDiffs/compactBridgeOutput:
   *  false`, which un-compressed every EARLIER dispatch too. When set,
   *  the two flags above are ignored. */
  readonly verbatimSinceLastDispatch?: boolean;
  /** Session interaction language. Reaches only the harness's elision
   *  markers inside the serialized record (compaction header, no-output
   *  digest, excerpt elision note, diff-suppression footer) — the
   *  narrative grammar and the static prefix pick their language
   *  elsewhere. Default `zh`. */
  readonly lang?: PromptLang;
  /** First-person 黑塔 recap of the compacted span, rendered as a `### 记录：先前`
   *  section after the static prefix. Prompt-time only; never persisted. */
  readonly recap?: string;
  /** Blocks with index < this are dropped from the serialized prompt (the
   *  compacted span). Indexes the FULL record (append-only) so it is a stable
   *  cache key. Defaults to 0 (no blocks dropped). */
  readonly recapBoundaryIndex?: number;
}

/**
 * Index of the last herta-speech block in the record, or -1 when none
 * exists. Hoisted per projection (perf pass 2026-07-16): the spoken-after
 * test in `keepInPrompt` asks "does any speech follow this thought", which
 * for every thought reduces to comparing against the ONE last-speech index
 * — so walk backward once and stop at the first speech from the tail,
 * instead of an O(n) forward `record.some` per thought block (quadratic
 * per projection as sessions grow, since thoughts stay in the in-memory
 * record). Same backward-walk-and-stop shape as `compactRecordForPrompt`'s
 * done-marker scan; the serialized prompt is byte-for-byte unchanged
 * (equivalence pinned against a naive reference in actor-prompt.test.ts).
 */
function lastSpeechIndex(record: TerminalRecord): number {
  for (let k = record.length - 1; k >= 0; k--) {
    const b = record[k];
    if (b !== undefined && b.kind === "herta" && b.surface === "speech") {
      return k;
    }
  }
  return -1;
}

/**
 * Whether a record block survives into the actor prompt. Herta-thought
 * blocks are ephemeral: a prior-turn thought (idx < priorTurnLength) is
 * always dropped; a current-turn thought is dropped once its speech has
 * been produced (a later （我 说） speech block exists in the same turn),
 * so only the in-flight, not-yet-spoken thought is kept (preserving the
 * two-phase think→speak chain). All other blocks are kept. Thoughts
 * remain in the in-memory record and JSONL — this only affects the
 * prompt bytes.
 *
 * `lastSpeechIdx` is the full-record last-speech index from
 * `lastSpeechIndex`, computed once per projection by the caller;
 * "a speech follows idx" ⟺ `lastSpeechIdx > idx`.
 */
function keepInPrompt(
  block: TerminalRecordBlock,
  idx: number,
  lastSpeechIdx: number,
  priorTurnLength: number,
): boolean {
  if (!(block.kind === "herta" && block.surface === "thought")) return true;
  if (idx < priorTurnLength) return false;
  return lastSpeechIdx <= idx;
}

/**
 * Filter a record down to user blocks + system blocks + herta-speech
 * blocks + in-flight herta-thought blocks. Drops prior-turn thoughts
 * (indices `< priorTurnLength`) and drops same-turn thoughts once their
 * speech has been produced — i.e., a current-turn thought is kept ONLY
 * while no （我 说） speech block follows it in the record (the in-flight
 * thought is present in the prompt that generates its own speech, since
 * at that point no speech follows it yet).
 *
 * Rationale: a thought is an ephemeral per-turn scratchpad (D8 /
 * PHILOSOPHY §0). By turn N+1 the context has moved on — replaying
 * stale interior monologue anchors the model to stale plans. Within a
 * turn, once speech is committed the thought has served its purpose and
 * the speech carries intent forward. Thoughts are still persisted to
 * JSONL and remain in the in-memory `TerminalRecord` for inspection /
 * resume; this filter only affects the bytes that reach the next prompt.
 */
function recordForPrompt(
  record: TerminalRecord,
  priorTurnLength: number,
  boundary: number,
): TerminalRecord {
  const lastSpeechIdx = lastSpeechIndex(record);
  return record.filter(
    (block, idx) =>
      idx >= boundary &&
      keepInPrompt(block, idx, lastSpeechIdx, priorTurnLength),
  );
}

/**
 * Serialize the record (after prior-turn-thought filtering) and
 * splice the attached meta-think section at the surface-specific
 * position. Returns the plain serialized record when no attachment
 * is set or when the attachment's text for the current surface is
 * empty.
 *
 * Index-mapping rationale: `attachedMetaThink.beforeThinkIndex` and
 * `beforeSpeakIndex` are expressed against the FULL record (the
 * driver assigns them at attachment time). Since `recordForPrompt`
 * drops prior-turn thought blocks, this function maps the full
 * index to the filtered-record index before slicing. The
 * past-end case (splice index >= filtered length) appends the
 * section at the end — the typical case on a fresh attachment's
 * first turn, where the upcoming Herta block hasn't been appended
 * yet.
 */
function serializeRecordWithAttachment(opts: {
  record: TerminalRecord;
  priorTurnLength: number;
  attachedMetaThink: AttachedMetaThink | undefined;
  surface: "thought" | "speech" | undefined;
  compressDiffs: boolean;
  compactBridgeOutput: boolean; // ADDED
  verbatimSinceLastDispatch: boolean;
  boundary: number;
  lang: PromptLang;
}): string {
  const filtered = recordForPrompt(
    opts.record,
    opts.priorTurnLength,
    opts.boundary,
  );
  const serializeOpts = {
    compressDiffs: opts.compressDiffs,
    compactBridgeOutput: opts.compactBridgeOutput, // ADDED
    verbatimSinceLastDispatch: opts.verbatimSinceLastDispatch,
    lang: opts.lang,
  };
  const attached = opts.attachedMetaThink;
  if (attached === undefined || opts.surface === undefined) {
    return serializeTerminalRecord(filtered, serializeOpts);
  }
  const text =
    opts.surface === "thought" ? attached.preThinkText : attached.preSpeakText;
  const section = buildMetaThinkSection(text);
  if (section.length === 0) {
    return serializeTerminalRecord(filtered, serializeOpts);
  }
  const fullSpliceIndex =
    opts.surface === "thought"
      ? attached.beforeThinkIndex
      : attached.beforeSpeakIndex;
  let filteredIndex = 0;
  const lastSpeechIdx = lastSpeechIndex(opts.record);
  for (let i = 0; i < Math.min(fullSpliceIndex, opts.record.length); i++) {
    const block = opts.record[i];
    if (block === undefined) continue;
    if (
      i >= opts.boundary &&
      keepInPrompt(block, i, lastSpeechIdx, opts.priorTurnLength)
    )
      filteredIndex++;
  }
  if (filtered.length === 0) {
    return section;
  }
  if (filteredIndex >= filtered.length) {
    return `${serializeTerminalRecord(filtered, serializeOpts)}\n\n${section}`;
  }
  // Run-snap (M-projection-2, 2026-07-04): the halves below are serialized
  // independently, so each gets its own compaction pass. If the splice
  // index lands INSIDE a contiguous system run, the run is cut in two and
  // each half compacts (or passes through) separately — producing a
  // different projection than the unspliced record (two `[历史已压缩]`
  // summaries, or two below-threshold pass-throughs, where one summary
  // belongs). Snap the splice back to the run's first block so no run is
  // ever cut: the meta-think section is a preface for the upcoming
  // surface, and landing before the whole run reads the same to the model.
  while (
    filteredIndex > 0 &&
    filtered[filteredIndex]?.kind === "system" &&
    filtered[filteredIndex - 1]?.kind === "system"
  ) {
    filteredIndex -= 1;
  }
  const before = filtered.slice(0, filteredIndex);
  const after = filtered.slice(filteredIndex);
  const beforeStr =
    before.length > 0 ? serializeTerminalRecord(before, serializeOpts) : "";
  const afterStr = serializeTerminalRecord(after, serializeOpts);
  if (beforeStr.length === 0) {
    return `${section}\n\n${afterStr}`;
  }
  return `${beforeStr}\n\n${section}\n\n${afterStr}`;
}

/**
 * Join the static prefix sub-sections in the canonical order:
 *   bio + (fewShots joined by `\n\n`) + env +
 *   (`### 此刻\n\n${opening}` when opening is set).
 * All inter-section separators are `\n\n`. Empty sub-sections are
 * skipped to avoid double-newlines collapsing to `\n\n\n\n` when
 * (e.g.) test fixtures pass empty env/fewShots — byte-identical to
 * the pre-refactor flat string for equivalent non-empty inputs.
 */
function joinStaticPrefix(prefix: StaticHertaPrefix): string {
  const parts: string[] = [];
  if (prefix.bio.length > 0) parts.push(prefix.bio);
  for (const fs of prefix.fewShots) {
    if (fs.length > 0) parts.push(fs);
  }
  if (prefix.env.length > 0) parts.push(prefix.env);
  if (prefix.opening !== undefined && prefix.opening.length > 0) {
    parts.push(`### 此刻\n\n${prefix.opening}`);
  }
  return parts.join("\n\n");
}

/**
 * Serialize an `ActorPrompt` into the flat string that DeepSeek's
 * completion endpoint receives. Byte-identical to the pre-refactor
 * string-concat output for equivalent inputs.
 *
 * Cache discipline (the "stable cached prompt snapshots" MVP goal). The
 * static prefix (`joinStaticPrefix`) is the ONE guaranteed cache-stable
 * region: it is frozen at session start — no sessionId / timestamps /
 * per-turn state, see static-prefix.ts — and is always emitted as the
 * byte-identical HEAD of the prompt, so the provider's prompt cache hits it
 * every turn. Everything AFTER it is dynamic and only ever appended, never
 * prepended: the `### 记录：先前` recap (changes only at compaction —
 * `recapBoundaryIndex` indexes the full append-only record, so it stays a
 * stable key), the record body, then the tail. The record body itself uses
 * token-optimizations — diff compression (`compressDiffs`), bridge-output
 * compaction (`compactBridgeOutput`), prior-turn-thought filtering
 * (`priorTurnLength`) — that REWRITE earlier bytes per turn and so are NOT
 * cache-stable: a deliberate token-vs-cache trade-off BELOW the cached floor.
 * Invariant (test-enforced): never add per-turn-varying content to the static
 * prefix — it would fragment the one region the cache depends on. See
 * docs/superpowers/specs/2026-06-20-actor-prompt-cache-discipline.md.
 */
export function serializeActorPrompt(doc: ActorPrompt): string {
  const prefixStr = joinStaticPrefix(doc.staticPrefix);
  const recordStr = serializeRecordWithAttachment({
    record: doc.record,
    priorTurnLength: doc.priorTurnLength,
    attachedMetaThink: doc.attachedMetaThink,
    surface: doc.metaThinkSurface,
    // Default: compress diffs in the serialized record so the LLM
    // doesn't see the full 200-line patch every turn.
    compressDiffs: doc.compressDiffs ?? true,
    // Default: compact contiguous system runs.
    compactBridgeOutput: doc.compactBridgeOutput ?? true,
    // Beat firing sets this instead of the two flags above: fresh
    // window (after the prior dispatch's marker) verbatim, older
    // content default-optimized.
    verbatimSinceLastDispatch: doc.verbatimSinceLastDispatch ?? false,
    boundary: doc.recapBoundaryIndex ?? 0,
    lang: doc.lang ?? "zh",
  });
  const tailParts: string[] = [];
  if (doc.formatHint !== undefined && doc.formatHint.length > 0) {
    tailParts.push(doc.formatHint);
  }
  // For COMPLETE open tags (`（我 想）` / `（我 说）`), append `\n`
  // so the prompt mirrors the corpus format where the body starts
  // on a fresh line:
  //
  //   （我 说）
  //   <body>
  //   （/我 说）
  //
  // Without the trailing newline the model often emits something
  // like `（我 想）：<body>` — adding a stray `:` separator the
  // corpus never has (user-reported 2026-05-23). A PARTIAL tag such as
  // the former single-phase BRANCH_OPEN_TAG `（我 ` (the model completed
  // it itself to pick the surface; that path was removed 2026-09-03)
  // gets no trailing newline.
  //
  // `openTagSuffix` (if any) starts the body — it appears AFTER
  // the trailing newline, on the same line where the model's
  // continuation would otherwise begin.
  const openTagIsComplete = doc.openTag.endsWith("）");
  const openTagBase = openTagIsComplete ? `${doc.openTag}\n` : doc.openTag;
  const openTagWithSuffix =
    doc.openTagSuffix !== undefined && doc.openTagSuffix.length > 0
      ? `${openTagBase}${doc.openTagSuffix}`
      : openTagBase;
  tailParts.push(openTagWithSuffix);
  const tail = tailParts.join("\n");

  // Compose the body. Empty sub-strings shouldn't introduce extra
  // blank lines; the pre-refactor code always joined on `\n\n`.
  const bodyParts: string[] = [];
  if (prefixStr.length > 0) bodyParts.push(prefixStr);
  if (doc.recap !== undefined && doc.recap.trim().length > 0) {
    bodyParts.push(`### 记录：先前\n\n${doc.recap.trim()}`);
  }
  if (recordStr.length > 0) bodyParts.push(recordStr);
  if (doc.replayBlock !== undefined && doc.replayBlock.length > 0) {
    bodyParts.push(doc.replayBlock);
  }
  if (tail.length > 0) bodyParts.push(tail);
  return bodyParts.join("\n\n");
}
