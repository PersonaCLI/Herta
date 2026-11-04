import type {
  SystemBlock,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import { buildCompactionBody, isAttachmentBlock } from "./compact-record.js";
import { COMPACTION_TEXT } from "./compaction-text.js";
import type { PromptLang } from "./prompt-lang.js";

/**
 * Her view of the record, a run at a time (ADR 0085 §3).
 *
 * What is stored keeps time order. What her prompt draws groups each of
 * 板砖's runs right after the （我 说） that dispatched it — its rows, the
 * steers it took, her checkpoints about it — and the talk that fell during
 * it follows: the Trailblazer's words to her (`duringRun`) with what came
 * with them, and her answers. Drawn in time order, a run is shredded between
 * lines of talk, and her book reads as two people talking over a scrolling
 * terminal (§3, Not taken).
 *
 * With no talk during any run — every record before the lanes (step 3) —
 * nothing moves: the input comes back as the same array, and the view is
 * byte-identical to the one before this existed.
 */
export interface RunGrouping {
  /** The record in her view's order: `===` the input when nothing moved. */
  readonly record: TerminalRecord;
  /** The run still working with talk after it, as `[start, end)` of
   *  `record`: it is drawn in its live form, and the talk after `end` runs
   *  to the record's end. Null when there is no such run. */
  readonly live: { readonly start: number; readonly end: number } | null;
}

interface Window {
  readonly start: number;
  /** Exclusive. */
  end: number;
  readonly talk: number[];
  open: boolean;
}

/**
 * A run opens at a coprocessor row and holds every block after it until its
 * terminal marker, or until a message that opens a turn (a run cut short
 * before the bridge wrote its marker). A steer is a message to 板砖, and
 * stays inside; `duringRun` talk, the attachments that came with it, and
 * her answers are moved after the run's last block.
 */
export function groupRunsForHerta(record: TerminalRecord): RunGrouping {
  const windows: Window[] = [];
  let open: Window | null = null;
  // Inside a talk message's pictures and files (ADR 0048: the record puts
  // them right after the message they came with).
  let withTalk = false;
  for (let i = 0; i < record.length; i++) {
    const b = record[i] as TerminalRecordBlock;
    if (open === null) {
      if (b.kind !== "system" || b.label !== "差分协处理器") continue;
      open = { start: i, end: record.length, talk: [], open: true };
      windows.push(open);
    }
    if (b.kind === "user") {
      withTalk = false;
      if (b.steer === true) continue;
      if (b.duringRun === true) {
        open.talk.push(i);
        withTalk = true;
        continue;
      }
      open.end = i;
      open.open = false;
      open = null;
      continue;
    }
    if (b.kind === "herta") {
      withTalk = false;
      if (b.duringRun === true) open.talk.push(i);
      continue;
    }
    if (withTalk && isAttachmentBlock(b)) {
      open.talk.push(i);
      continue;
    }
    withTalk = false;
    if (b.role === "done-marker" || b.role === "noop-marker") {
      open.end = i + 1;
      open.open = false;
      open = null;
    }
  }
  if (windows.every((w) => w.talk.length === 0)) {
    return { record, live: null };
  }

  const out: TerminalRecordBlock[] = [];
  let live: RunGrouping["live"] = null;
  let at = 0;
  for (const w of windows) {
    while (at < w.start) out.push(record[at++] as TerminalRecordBlock);
    const talk = new Set(w.talk);
    const start = out.length;
    for (let k = w.start; k < w.end; k++) {
      if (!talk.has(k)) out.push(record[k] as TerminalRecordBlock);
    }
    const end = out.length;
    for (const k of w.talk) out.push(record[k] as TerminalRecordBlock);
    if (w.open && w.talk.length > 0) live = { start, end };
    at = w.end;
  }
  while (at < record.length) out.push(record[at++] as TerminalRecordBlock);
  return { record: out, live };
}

/** How many of the run's newest steps stay verbatim in its live form. */
export const LIVE_RUN_VERBATIM_STEPS = 2;

/**
 * A run still working, drawn while the Trailblazer talks (ADR 0085 §3, the
 * owner's choice 2026-11-04: only then): its state named first; its earlier
 * steps folded in the history's grammar, a fold for each stretch between
 * the steers and her checkpoints; its newest steps, any step that failed and
 * any finding in full; the steers and her checkpoints where they fell, as
 * speech (owner 2026-11-04: "the same format as the 自传").
 *
 * The record never shows an approval (D7), so the state it names is
 * "running": a run waiting on one reads the same.
 */
export function liveRunForHerta(
  entries: readonly TerminalRecordBlock[],
  lang: PromptLang,
): TerminalRecordBlock[] {
  const t = COMPACTION_TEXT[lang];
  // Each system block's step: an op row opens one, and the patch preview
  // right before it is its own (the permission rule writes it first).
  const step = new Map<TerminalRecordBlock, number>();
  let n = -1;
  entries.forEach((b, i) => {
    if (b.kind !== "system") return;
    const next = entries[i + 1];
    const previewsNext =
      (b.digest?.kind === "patch" || b.digest?.kind === "skip") &&
      next?.kind === "system" &&
      next.digest?.kind === "op";
    const opensStep = b.digest?.kind === "op" && !isPreviewOf(entries[i - 1]);
    if (previewsNext || opensStep || n === -1) n += 1;
    step.set(b, n);
  });
  const steps = entries.filter(
    (b) => b.kind === "system" && b.digest?.kind === "op",
  ).length;
  const failed = new Set<number>();
  for (const [b, s] of step) if (b.kind === "system" && fails(b)) failed.add(s);
  const kept = (b: SystemBlock): boolean => {
    const s = step.get(b) ?? 0;
    return (
      s > n - LIVE_RUN_VERBATIM_STEPS ||
      failed.has(s) ||
      b.digest?.kind === "finding"
    );
  };

  const out: TerminalRecordBlock[] = [
    { kind: "system", label: "差分协处理器", body: t.runLive(steps) },
  ];
  let stretch: SystemBlock[] = [];
  const fold = (): void => {
    if (stretch.length === 0) return;
    const body = buildCompactionBody(stretch, lang, undefined, t.runLiveHeader);
    if (body.length > 0) out.push({ kind: "system", label: "系统", body });
    else out.push(...stretch);
    stretch = [];
  };
  for (const b of entries) {
    if (b.kind === "system" && !isAttachmentBlock(b) && !kept(b)) {
      stretch.push(b);
      continue;
    }
    fold();
    out.push(b);
  }
  fold();
  return out;
}

function isPreviewOf(b: TerminalRecordBlock | undefined): boolean {
  return (
    b?.kind === "system" &&
    (b.digest?.kind === "patch" || b.digest?.kind === "skip")
  );
}

/** A row that says its step failed: a refused or broken call, a command
 *  that exited non-zero or was killed, a test run that failed. */
function fails(b: SystemBlock): boolean {
  const d = b.digest;
  if (d === undefined) return false;
  if (d.kind === "tool-fail") return true;
  if (d.kind === "tests") return d.status === "failed";
  if (d.kind === "text") return d.exitCode !== undefined && d.exitCode !== 0;
  return false;
}
