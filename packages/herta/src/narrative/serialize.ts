import {
  isSystemBlockLabel,
  type TerminalRecord,
  type TerminalRecordBlock,
} from "@herta/core";
import { findLastDispatchBoundary } from "./backend-record-slices.js";
import {
  type AttachmentFolds,
  compactRecordForPrompt,
  decideAttachmentFolds,
  foldAttachments,
} from "./compact-record.js";
import {
  collapseLongDiffs,
  resolveDiffPromptMaxLines,
} from "./diff-collapse.js";
import { escapeUserText } from "./escape.js";
import type { PromptLang } from "./prompt-lang.js";
import { nameMentionedPaths, systemRowForHerta } from "./record-voice.js";

/**
 * Serializer options for the prompt-side projection of a TerminalRecord.
 *
 * `compressDiffs` (N6b, 2026-05-23): when omitted or true (default), long
 * `\`\`\`diff … \`\`\`` fenced regions in system block bodies are
 * collapsed via `collapseLongDiffs` so multi-hundred-line patches don't
 * eat the LLM's context window. When false, the body is passed through
 * verbatim — beat firing uses this so Herta sees the FULL diff for her
 * in-turn reaction.
 *
 * `compactBridgeOutput` (compaction, 2026-05-24): see the field's JSDoc
 * below.
 */
export interface SerializeOptions {
  readonly compressDiffs?: boolean;
  /**
   * When omitted or true (default), `compactRecordForPrompt` runs
   * over the record before serialization, collapsing contiguous
   * runs of ≥2 system blocks into one `[历史已压缩 · 板砖]` summary.
   *
   * Composes cleanly with `compressDiffs`: compaction runs first
   * and replaces source system blocks with a summary whose body
   * has no ```diff fences; `collapseLongDiffs` then applies to
   * each block's body — a no-op for the summary, still applies
   * to any singleton system block left after compaction.
   *
   * See docs/superpowers/specs/2026-05-24-narrative-compaction-design.md §3, §6.2.
   */
  readonly compactBridgeOutput?: boolean;
  /**
   * Beat mode (M-projection-1, 2026-07-04). When true, the record is
   * split at the last dispatch boundary (the PRIOR `@板砖` run's
   * done/noop-marker): blocks at or before it serialize with the
   * DEFAULT token optimizations (diffs compressed, system runs
   * compacted), while blocks after it — the conversation since, plus
   * the CURRENT invocation's fresh board output — serialize verbatim.
   *
   * This replaces the beat path's old blanket
   * `{ compressDiffs: false, compactBridgeOutput: false }`: the N6b /
   * compaction opt-outs were meant to show the beat the full output of
   * the invocation that JUST fired it, but applied globally they also
   * un-compressed every EARLIER dispatch's diffs and board output into
   * every beat prompt — pure token waste that grew with each dispatch,
   * and slower beat TTFT exactly where latency shows (the beat should
   * land while the board output is still on screen).
   *
   * With no prior dispatch in the window the whole record is the fresh
   * window and serializes verbatim — byte-identical to the old flags.
   * When set, `compressDiffs` / `compactBridgeOutput` are ignored (the
   * per-region treatment above is the whole point).
   *
   * One lane is exempt from "verbatim" (ADR 0033 §6g amendment,
   * 2026-09-22): the ATTACHMENT fold. The opt-outs were written for the
   * current run's diffs and board output; an attachment is the user's
   * document, and its fold is a window counted over the whole record.
   * Applied blanket-verbatim to the fresh window, the beat re-inflated
   * every head excerpt the main turn had already folded — up to ~4K chars
   * per document per beat, a prompt that stopped matching the turn's at
   * the document rather than at the current run, and a beat that could
   * quote what Herta's next turn cannot read (the hazard §6g exists to
   * keep out). The fold is now decided ONCE over the whole record and
   * applied to both halves: the head (whose compaction would otherwise
   * decide from the head alone) and the tail (which is otherwise
   * verbatim). Attachments fold in a beat exactly as in the main turn —
   * a document inside its window, the one the dispatch is about, stays
   * verbatim in both.
   */
  readonly verbatimSinceLastDispatch?: boolean;
  /**
   * Session interaction language, used ONLY for the harness's elision
   * markers — the compaction header, the no-output digest, the excerpt
   * elision note, the diff-suppression footer (`compaction-text.ts`).
   * Record grammar and operation verbs are canonical and unaffected, so
   * omitting this changes nothing structural. Default `zh`.
   */
  readonly lang?: PromptLang;
}

/**
 * Render a single TerminalRecordBlock as a chunk of narrative text.
 * Output does NOT include trailing blank-line separators — callers (e.g.
 * `serializeTerminalRecord`) join blocks with the appropriate spacing.
 *
 * For `system` blocks, `\`\`\`diff … \`\`\`` fenced regions are
 * collapsed by default (N6, 2026-05-23) — the LLM sees the first
 * ~20 lines + a "N more lines suppressed" footer. The full diff
 * stays in `TerminalRecord` and the JSONL transcript on disk.
 * Tunable via `HERTA_DIFF_PROMPT_MAX_LINES`. Beat firing opts out
 * via `compressDiffs: false` so Herta sees the full diff when
 * reacting to a fresh patch (N6b, 2026-05-23).
 *
 * SPEC v0.2 §5.
 */
export function serializeBlock(
  block: TerminalRecordBlock,
  opts?: SerializeOptions,
): string {
  switch (block.kind) {
    case "user":
      // A path mentioned with the composer's `@` reads as its name (ADR
      // 0072 amendment 2026-10-20): the chip the user saw.
      return `（开拓者 说）\n${escapeUserText(nameMentionedPaths(block.text, block.mentions))}\n（/开拓者 说）`;
    case "herta": {
      const [openTag, closeTag] =
        block.surface === "thought"
          ? ["（我 想）", "（/我 想）"]
          : ["（我 说）", "（/我 说）"];
      const body = `${openTag}\n${block.text}\n${closeTag}`;
      // Self-correction prose annotation (N8b, 2026-05-23): when the
      // speech block was committed via the supervisor-veto retry
      // path, prepend the veto reason as `——<text>` prose before
      // the speech envelope. Reads as a Herta-voice aside ("I caught
      // myself on X, then said Y") — gives future-turn prompts
      // persistent memory of the correction without the awkward
      // `→ 系统` label that earlier N8 attempt produced. Only
      // emitted for speech surface; thoughts can't be vetoed by
      // the supervisor (only speeches go through supervision).
      if (
        block.surface === "speech" &&
        block.selfCorrection !== undefined &&
        block.selfCorrection.length > 0
      ) {
        return `——${block.selfCorrection}\n\n${body}`;
      }
      return body;
    }
    case "system": {
      let body =
        opts?.compressDiffs === false
          ? block.body
          : collapseLongDiffs(
              block.body,
              resolveDiffPromptMaxLines(),
              opts?.lang ?? "zh",
              "herta",
            );
      // Append fuller evidence (command output tail / done-marker roll-up)
      // for the prompt ONLY. The CLI renderer ignores evidenceDetail (it
      // reads block.body); this is the Herta-side overlay (D7), mirroring
      // the selfCorrection prepend in the herta arm above.
      if (
        block.evidenceDetail !== undefined &&
        block.evidenceDetail.length > 0
      ) {
        body = `${body}\n${block.evidenceDetail}`;
      }
      const fence = "`".repeat(fenceLengthFor(body));
      return `→ ${block.label}\n\n${fence}text\n${body}\n${fence}`;
    }
  }
}

/**
 * Render an entire TerminalRecord as the prompt-ready narrative string
 * DeepSeek's completion API consumes. Blocks are joined by a single
 * blank line, matching the corpus convention (see .herta/narrative/).
 *
 * The output does NOT include the trailing `（我 说）` open-tag that the
 * completion call appends — that lives in the actor turn loop (Slice 5)
 * because it varies between primary actor turns and in-turn beats.
 *
 * `opts.compressDiffs` (default true) controls whether `\`\`\`diff …
 * \`\`\`` fenced regions in system block bodies are collapsed. See
 * `serializeBlock`'s JSDoc for the rationale.
 *
 * `opts.compactBridgeOutput` (default true) controls whether contiguous
 * runs of ≥2 system blocks are projected to one `[历史已压缩 · 板砖]`
 * summary block via `compactRecordForPrompt`. See the option's JSDoc
 * for the asymmetric beat opt-out.
 *
 * SPEC v0.2 §6.2.
 */
export function serializeTerminalRecord(
  record: TerminalRecord,
  opts?: SerializeOptions,
): string {
  // Forged-label guard (D7 / SPEC §5.3): every LLM-facing projection of the
  // record funnels through this function — the actor turn prompt, beats, the
  // supervisor, the trigger recheck, the intent router, and the recap
  // summarizer — so this is the ONE runtime trust boundary where a system
  // block whose label is not canonical (e.g. a forged "板砖") is dropped
  // before it can reach a prompt. TypeScript forbids constructing one, but
  // record content can arrive from disk or model-adjacent code paths —
  // defense in depth. Runs BEFORE compaction so a forged block can't smuggle
  // its body into a compaction summary either. (This guard used to live in
  // @herta/core's projectForHerta, which nothing called — moved here, to the
  // funnel, 2026-07-04.)
  const guarded = record.filter(
    (b) => b.kind !== "system" || isSystemBlockLabel(b.label),
  );
  if (opts?.verbatimSinceLastDispatch === true) {
    // Beat mode: default optimizations up to the prior dispatch's marker,
    // verbatim after it. boundary is -1 with no prior dispatch → empty head,
    // whole record verbatim. The head's trailing done-marker keeps its
    // State-1 pass-through treatment inside compactRecordForPrompt (no
    // herta block follows it WITHIN the head) — one bounded roll-up block,
    // accepted so the marker's outcome stays legible to the beat.
    const boundary = findLastDispatchBoundary(guarded);
    const lang = opts?.lang ?? "zh";
    // The attachment fold is decided over the WHOLE record before the split
    // (ADR 0033 §6g amendment): its window counts user turns and later
    // mentions on both sides of the boundary, so neither half may decide
    // from what it alone can see. See the option's JSDoc.
    const attachmentFolds = decideAttachmentFolds(guarded);
    const head = renderRun(guarded.slice(0, boundary + 1), {
      compress: true,
      compact: true,
      lang,
      attachmentFolds,
    });
    const tail = renderRun(guarded.slice(boundary + 1), {
      compress: false,
      compact: false,
      lang,
      attachmentFolds,
    });
    return [head, tail].filter((s) => s.length > 0).join("\n\n");
  }
  return renderRun(guarded, {
    compress: opts?.compressDiffs !== false,
    compact: opts?.compactBridgeOutput !== false,
    lang: opts?.lang ?? "zh",
  });
}

/**
 * Shared projection tail: optional compaction, then per-block render.
 * `attachmentFolds` (beat mode) carries the whole-record fold decisions
 * into whichever projection this piece gets: the compaction takes them in
 * place of its own, and an otherwise-verbatim piece applies just that lane.
 */
function renderRun(
  blocks: TerminalRecord,
  treatment: {
    compress: boolean;
    compact: boolean;
    lang: PromptLang;
    attachmentFolds?: AttachmentFolds;
  },
): string {
  const projected = treatment.compact
    ? compactRecordForPrompt(blocks, {
        lang: treatment.lang,
        ...(treatment.attachmentFolds !== undefined
          ? { attachmentFolds: treatment.attachmentFolds }
          : {}),
      })
    : // Uncompacted, an attachment still reads as she would remember it
      // (ADR 0079): with no fold decided, every one is fresh.
      foldAttachments(
        blocks,
        treatment.attachmentFolds ?? new Map(),
        treatment.lang,
      );
  return projected
    .flatMap((b): TerminalRecordBlock[] => {
      // 板砖's rows read as her notes (ADR 0079 §2); a row with nothing for
      // her drops out.
      if (b.kind !== "system") return [b];
      const row = systemRowForHerta(b, treatment.lang);
      return row === null ? [] : [row];
    })
    .map((b) =>
      serializeBlock(b, {
        compressDiffs: treatment.compress,
        lang: treatment.lang,
      }),
    )
    .join("\n\n");
}

/**
 * CommonMark fence escalation: the outer fence must be longer than any
 * backtick run inside the body so the body cannot accidentally close the
 * outer fence. Minimum fence length is 3. Exported for the supervisor's
 * candidate fencing (slice 2) — same escalation, same reason.
 */
export function fenceLengthFor(body: string): number {
  const runs = body.match(/`+/g);
  if (runs === null) return 3;
  let longest = 0;
  for (const run of runs) {
    if (run.length > longest) longest = run.length;
  }
  return Math.max(3, longest + 1);
}
