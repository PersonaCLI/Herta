import type { TerminalRecord } from "@herta/core";
import { RECORD_WINDOW_WEIGHT, windowStart } from "@herta/core/record-window";

/**
 * What a full-record payload to the renderer carries (the reset snapshot on
 * open, the record-channel reset on rewind/heal). The renderer WINDOWS long
 * sessions (2026-07-12): it receives this tail, renders it, and pages older
 * blocks on demand over `session:recordSlice` — a 10MB session no longer
 * crosses IPC in one message or mounts thousands of DOM rows. Main always
 * keeps the full record (the actor's prompt, rewind, and the persist cursor
 * all need it); this is a VIEW bound only.
 *
 * The bound weighs what the chat draws, and lands on a turn: see
 * `@herta/core/record-window` (ADR 0085 amendment 2026-11-05).
 */
export interface RecordTail {
  /** The trailing window. */
  readonly record: TerminalRecord;
  /** Absolute index of `record[0]` in the full record — the count of OLDER
   *  blocks not included (0 = the window is the whole record). */
  readonly start: number;
}

/** The trailing window of `record` plus the absolute index it starts at. A
 *  record within the budget returns whole with start 0. */
export function recordTail(
  record: TerminalRecord,
  budget: number = RECORD_WINDOW_WEIGHT,
): RecordTail {
  const start = windowStart(record, budget);
  if (start === 0) return { record, start: 0 };
  return { record: record.slice(start), start };
}
