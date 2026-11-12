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
 * row and half a 完整记录. It ends at the live end, or, after a far jump, at
 * a turn of its own (`jumpRange`, owner 2026-11-12).
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

/**
 * Where a page of older blocks ending at `end` starts: `budget` of weight
 * back, capped at a window's.
 */
export function pageStart(
  record: TerminalRecord,
  budget: number,
  end: number,
): number {
  return windowStart(record, Math.min(budget, RECORD_WINDOW_WEIGHT), end);
}

/**
 * Where a page of later blocks starting at `from` ends: the first message
 * that opens a turn with at least `budget` of weight before it, or the
 * record's end. Never inside a turn, like a window's start.
 */
export function pageEnd(
  record: TerminalRecord,
  budget: number,
  from: number,
): number {
  let weight = 0;
  for (let i = from; i < record.length; i++) {
    const block = record[i] as TerminalRecordBlock;
    if (i > from && weight >= budget && opensTurn(block)) return i;
    weight += blockWeight(block);
  }
  return record.length;
}

/** Blocks `[start, end)` of the record: a window, a page, or what a jump
 *  brings. */
export interface RecordRange {
  readonly start: number;
  readonly end: number;
}

function weightBetween(
  record: TerminalRecord,
  start: number,
  end: number,
): number {
  let weight = 0;
  for (let i = start; i < end; i++)
    weight += blockWeight(record[i] as TerminalRecordBlock);
  return weight;
}

/**
 * A window around block `target`: the turn that holds it, a quarter of the
 * budget before it and the rest from it on. The reader lands on the turn
 * with some of what led to it above, and reads on from there.
 */
export function windowAround(
  record: TerminalRecord,
  target: number,
  budget: number = RECORD_WINDOW_WEIGHT,
): RecordRange {
  const turn = turnStartAtOrBefore(record, target);
  const back = Math.floor(budget / 4);
  return {
    start: windowStart(record, back, turn),
    end: pageEnd(record, budget - back, turn),
  };
}

/**
 * What a jump to block `target` brings, given the window the chat holds
 * (owner 2026-11-12, amends the 2026-11-05 "a jump in one slice").
 *
 * That amendment answered a jump with everything between the target's turn
 * and the window, whatever it weighed, because the renderer cannot weigh
 * blocks it does not hold. It is main that answers, and main can: at 6 400
 * turns the slice to the first topic was 38 MB in one message and every row
 * of it mounted (review 2026-11-10, second pass).
 *
 * Within a window's weight of what the chat holds, the answer is still the
 * gap: it joins the window, and the reader scrolls between the two. Further
 * than that, it is a window of its own around the target, which the chat
 * shows in place of the one it had. The chat then stands away from the live
 * end until the reader pages or jumps back to it.
 *
 * Null when the target is no block of the record or the window already
 * holds it.
 */
export function jumpRange(
  record: TerminalRecord,
  have: RecordRange,
  target: number,
  budget: number = RECORD_WINDOW_WEIGHT,
): RecordRange | null {
  if (!Number.isInteger(target) || target < 0 || target >= record.length) {
    return null;
  }
  const sane =
    Number.isInteger(have.start) &&
    Number.isInteger(have.end) &&
    have.start >= 0 &&
    have.start <= have.end &&
    have.end <= record.length;
  // A window that is no part of this record (it crossed an IPC boundary):
  // answer as if the chat held nothing.
  if (!sane) return windowAround(record, target, budget);
  if (target >= have.start && target < have.end) return null;
  const turn = turnStartAtOrBefore(record, target);
  if (target < have.start) {
    if (weightBetween(record, turn, have.start) <= budget) {
      return { start: turn, end: have.start };
    }
    const around = windowAround(record, target, budget);
    return { start: around.start, end: Math.min(around.end, have.start) };
  }
  // Past the end of a window that stands away from the live end.
  const from = Math.max(turn, have.end);
  if (weightBetween(record, have.end, from) <= budget) {
    return {
      start: have.end,
      end: pageEnd(record, budget - Math.floor(budget / 4), from),
    };
  }
  const around = windowAround(record, target, budget);
  return { start: Math.max(around.start, have.end), end: around.end };
}
