import { describe, expect, it } from "vitest";
import type {
  TerminalRecord,
  TerminalRecordBlock,
} from "../types/terminal-record.js";
import {
  blockWeight,
  jumpRange,
  opensTurn,
  pageEnd,
  pageStart,
  RECORD_WINDOW_WEIGHT,
  type RecordRange,
  recordWeight,
  turnStartAtOrBefore,
  windowAround,
  windowStart,
} from "./record-window.js";

const user = (text = "u", extra: object = {}): TerminalRecordBlock => ({
  kind: "user",
  text,
  ...extra,
});
const speech = (extra: object = {}): TerminalRecordBlock => ({
  kind: "herta",
  surface: "speech",
  text: "h",
  ...extra,
});
const thought: TerminalRecordBlock = {
  kind: "herta",
  surface: "thought",
  text: "t",
};
const step: TerminalRecordBlock = {
  kind: "system",
  label: "差分协处理器",
  body: "Reading a.ts",
};

/** One turn: a message, a dispatch, `steps` of 板砖's rows, a verdict. */
const turn = (steps: number): TerminalRecord => [
  user(),
  speech(),
  ...Array.from({ length: steps }, () => step),
  speech(),
];

describe("the chat's window weighs what the chat draws (ADR 0085 amendment 2026-11-05)", () => {
  it("a message or a speech weighs ten; a run's step, a thought or a steer one", () => {
    expect(blockWeight(user())).toBe(10);
    expect(blockWeight(user("t", { duringRun: true }))).toBe(10);
    expect(blockWeight(speech())).toBe(10);
    expect(blockWeight(step)).toBe(1);
    expect(blockWeight(thought)).toBe(1);
    expect(blockWeight(user("s", { steer: true }))).toBe(1);
    expect(recordWeight(turn(5))).toBe(35);
  });

  it("only a message that opens a turn opens a turn", () => {
    expect(opensTurn(user())).toBe(true);
    expect(opensTurn(user("s", { steer: true }))).toBe(false);
    expect(opensTurn(user("t", { duringRun: true }))).toBe(false);
    expect(opensTurn(speech())).toBe(false);
    expect(opensTurn(step)).toBe(false);
    expect(opensTurn(undefined)).toBe(false);
  });

  it("the owner's session: 264 blocks, a handful of messages, nothing folds", () => {
    const record: TerminalRecord = [
      ...turn(60),
      ...turn(60),
      ...turn(60),
      ...turn(72),
    ];
    expect(record.length).toBe(264);
    expect(windowStart(record, 2000)).toBe(0);
  });

  it("a window starts at a message that opens a turn, never inside a run", () => {
    const record: TerminalRecord = [...turn(100), ...turn(100), ...turn(100)];
    // Enough weight is reached inside the middle turn's run; the window
    // takes the whole turn.
    const start = windowStart(record, 150);
    expect(start).toBe(103);
    expect(record[start]).toEqual(user());
  });

  it("talk and a steer inside a run are not where a window may start", () => {
    const record: TerminalRecord = [
      user("opens"),
      speech(),
      step,
      user("talk", { duringRun: true }),
      speech({ duringRun: true }),
      user("steer", { steer: true }),
      step,
      speech(),
    ];
    expect(windowStart(record, 5)).toBe(0);
  });

  it("with less weight than the budget, the window is the whole record", () => {
    expect(windowStart(turn(5), 2000)).toBe(0);
    expect(windowStart([], 2000)).toBe(0);
  });

  it("pages older blocks back from `end`, and lands on a turn", () => {
    const record: TerminalRecord = [...turn(100), ...turn(100), ...turn(100)];
    expect(windowStart(record, 50, 206)).toBe(103);
    expect(windowStart(record, 50, 103)).toBe(0);
  });

  it("walks a cut back to the turn that holds it", () => {
    const record: TerminalRecord = [...turn(4), ...turn(4)];
    expect(turnStartAtOrBefore(record, 9)).toBe(7);
    expect(turnStartAtOrBefore(record, 7)).toBe(7);
    expect(turnStartAtOrBefore(record, 5)).toBe(0);
  });

  describe("a page of older blocks", () => {
    const record: TerminalRecord = Array.from({ length: 2000 }, () =>
      turn(1),
    ).flat();
    const end = 4000;

    it("is a budget of weight back, capped at a window's", () => {
      expect(pageStart(record, 50, end)).toBe(windowStart(record, 50, end));
      expect(pageStart(record, 1e9, end)).toBe(
        windowStart(record, RECORD_WINDOW_WEIGHT, end),
      );
    });
  });

  describe("a page of later blocks", () => {
    // Turns of 4 blocks weighing 31: a message, a dispatch, a step, a verdict.
    const record: TerminalRecord = Array.from({ length: 2000 }, () =>
      turn(1),
    ).flat();

    it("is a budget of weight forward, and ends where a turn opens", () => {
      // 50 of weight is passed inside the second turn; the page ends at the
      // third, never inside one.
      expect(pageEnd(record, 50, 0)).toBe(8);
      expect(pageEnd(record, 31, 0)).toBe(4);
      expect(pageEnd(record, 1, 400)).toBe(404);
      expect(opensTurn(record[pageEnd(record, 777, 1200)])).toBe(true);
    });

    it("ends at the record's end when that comes first", () => {
      expect(pageEnd(record, 1e9, 0)).toBe(record.length);
      expect(pageEnd(record, 50, record.length - 4)).toBe(record.length);
      expect(pageEnd(record, 50, record.length)).toBe(record.length);
      expect(pageEnd([], 50, 0)).toBe(0);
    });

    it("never splits one long turn, whatever it weighs", () => {
      const long: TerminalRecord = [...turn(5000), ...turn(1)];
      expect(pageEnd(long, 100, 0)).toBe(5003);
    });
  });

  describe("a jump (owner 2026-11-12)", () => {
    // 6 400 turns of 4 blocks: the size the review measured the old slice at.
    const record: TerminalRecord = Array.from({ length: 6400 }, () =>
      turn(1),
    ).flat();
    const tail: RecordRange = {
      start: windowStart(record, RECORD_WINDOW_WEIGHT),
      end: record.length,
    };
    const weigh = (r: RecordRange): number =>
      recordWeight(record.slice(r.start, r.end));

    it("near the window, brings the gap: the two join", () => {
      const target = tail.start - 40; // ten turns back
      const r = jumpRange(record, tail, target) as RecordRange;
      expect(r).toEqual({ start: target, end: tail.start });
      // A block inside a turn reaches the message that opens it.
      expect(jumpRange(record, tail, target + 2)).toEqual(r);
    });

    it("far from the window, brings a window of its own instead of the gap", () => {
      const r = jumpRange(record, tail, 8) as RecordRange;
      // The old answer was everything from block 8 to the window: 25 000
      // blocks. This one is a window's weight, give or take a turn.
      expect(r.end).toBeLessThan(tail.start);
      expect(weigh(r)).toBeLessThanOrEqual(RECORD_WINDOW_WEIGHT + 31);
      expect(weigh(r)).toBeGreaterThanOrEqual(RECORD_WINDOW_WEIGHT / 2);
      expect(r.start).toBeLessThanOrEqual(8);
      expect(r.end).toBeGreaterThan(8);
      expect(opensTurn(record[r.end])).toBe(true);
    });

    it("lands with some of what came before above the target, and most of the window after it", () => {
      const target = 12_000;
      const r = jumpRange(record, tail, target) as RecordRange;
      expect(opensTurn(record[r.start])).toBe(true);
      const before = recordWeight(record.slice(r.start, target));
      const after = recordWeight(record.slice(target, r.end));
      expect(before).toBeGreaterThanOrEqual(RECORD_WINDOW_WEIGHT / 4);
      expect(before).toBeLessThan(RECORD_WINDOW_WEIGHT / 4 + 31);
      expect(after).toBeGreaterThanOrEqual((RECORD_WINDOW_WEIGHT * 3) / 4);
      expect(after).toBeLessThan((RECORD_WINDOW_WEIGHT * 3) / 4 + 31);
    });

    it("the border between the two answers is a window's weight of gap", () => {
      const turns = (n: number): number => tail.start - n * 4;
      // 64 turns weigh 1 984, 65 weigh 2 015.
      expect(jumpRange(record, tail, turns(64))?.end).toBe(tail.start);
      expect(jumpRange(record, tail, turns(64))?.start).toBe(turns(64));
      const far = jumpRange(record, tail, turns(65)) as RecordRange;
      expect(far.start).toBeLessThan(turns(65));
      expect(far.end).toBeLessThanOrEqual(tail.start);
    });

    it("from a window that stands away from the end: forward too, near and far", () => {
      const held: RecordRange = { start: 400, end: 800 };
      // Near: the page starts where the window ends and runs past the target.
      const near = jumpRange(record, held, 1000) as RecordRange;
      expect(near.start).toBe(800);
      expect(near.end).toBeGreaterThan(1000);
      expect(opensTurn(record[near.end])).toBe(true);
      // Far: a window of its own, after the one held.
      const far = jumpRange(record, held, 20_000) as RecordRange;
      expect(far.start).toBeGreaterThan(800);
      expect(far.start).toBeLessThanOrEqual(20_000);
      expect(far.end).toBeGreaterThan(20_000);
      // Each side lands on a turn, so each may run one turn (31) over.
      expect(weigh(far)).toBeLessThanOrEqual(RECORD_WINDOW_WEIGHT + 2 * 31);
      // Far, near the record's end: the window runs to the end.
      expect(jumpRange(record, held, record.length - 2)?.end).toBe(
        record.length,
      );
      // Back from it, the same two answers as from the tail.
      expect(jumpRange(record, held, 380)).toEqual({ start: 380, end: 400 });
    });

    it("answers nothing for a block the window holds, or one that is no block", () => {
      expect(jumpRange(record, tail, tail.start)).toBeNull();
      expect(jumpRange(record, tail, record.length - 1)).toBeNull();
      for (const to of [-1, record.length, 1.5, Number.NaN, Infinity]) {
        expect(jumpRange(record, tail, to), String(to)).toBeNull();
      }
      expect(jumpRange(record, tail, "8" as unknown as number)).toBeNull();
      expect(jumpRange([], { start: 0, end: 0 }, 0)).toBeNull();
    });

    it("a window that is no part of the record is answered as if the chat held nothing", () => {
      const around = windowAround(record, 12_000);
      for (const have of [
        { start: 5, end: 2 },
        { start: -1, end: 10 },
        { start: 0, end: record.length + 1 },
        { start: 0.5, end: 10 },
        { start: Number.NaN, end: 10 },
      ]) {
        expect(jumpRange(record, have, 12_000), JSON.stringify(have)).toEqual(
          around,
        );
      }
    });

    it("a short record: the window around a block is all of it", () => {
      const short: TerminalRecord = [...turn(3), ...turn(3)];
      expect(windowAround(short, 7)).toEqual({ start: 0, end: short.length });
    });
  });
});
