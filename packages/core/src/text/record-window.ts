import type {
  TerminalRecord,
  TerminalRecordBlock,
} from "../types/terminal-record.js";

/**
 * The chat's window over the record, measured by what the chat draws (ADR
 * 0085 amendment 2026-11-05).
 *
 * The record keeps every row of 板砖's runs, and the chat draws each run as
 * one row. Counted in blocks, a few runs in a short conversation passed the
 * live trim's bound and folded it behind 「加载更早的 64 条记录」, and the click
 * brought back a handful of messages. So a block is weighed by what it costs
 * the chat: a message or a speech draws a row of its own, and a step inside a
 * run costs only its bytes.
 *
 * A window starts at a message that opens a turn, or at the record's start,
 * and never inside a turn: a run cut in half has the wrong step count on its
 * row and half a 完整记录.
 */
const ROW_WEIGHT = 10;
const STEP_WEIGHT = 1;

/** What a window is brought down to: 200 messages, or 2 000 steps, or the
 *  mix. A real step is under 1 KB, so a payload stays near 2 MB. */
export const RECORD_WINDOW_WEIGHT = 2000;

/** Past this a window trims while the reader follows the live end. */
export const RECORD_WINDOW_TRIM_AT = 2600;

export function blockWeight(block: TerminalRecordBlock): number {
  if (block.kind === "user")
    return block.steer === true ? STEP_WEIGHT : ROW_WEIGHT;
  if (block.kind === "herta" && block.surface === "speech") return ROW_WEIGHT;
  return STEP_WEIGHT;
}

export function recordWeight(blocks: TerminalRecord): number {
  let weight = 0;
  for (const b of blocks) weight += blockWeight(b);
  return weight;
}

/** A message that opens a turn. A steer and talk during a run are inside
 *  the turn that holds the run. */
export function opensTurn(block: TerminalRecordBlock | undefined): boolean {
  return (
    block?.kind === "user" && block.steer !== true && block.duringRun !== true
  );
}

/**
 * Where a window ending at `end` starts: the latest message that opens a turn
 * with at least `budget` of weight from it to `end`. With less than that in
 * the record, 0 — the window is all of it.
 */
export function windowStart(
  record: TerminalRecord,
  budget: number,
  end: number = record.length,
): number {
  let weight = 0;
  for (let i = end - 1; i >= 0; i--) {
    const block = record[i] as TerminalRecordBlock;
    weight += blockWeight(block);
    if (weight >= budget && opensTurn(block)) return i;
  }
  return 0;
}

/** The latest message that opens a turn at or before `index`, or 0. */
export function turnStartAtOrBefore(
  record: TerminalRecord,
  index: number,
): number {
  for (let i = index; i > 0; i--) {
    if (opensTurn(record[i])) return i;
  }
  return 0;
}
