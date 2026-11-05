import { describe, expect, it } from "vitest";
import type {
  TerminalRecord,
  TerminalRecordBlock,
} from "../types/terminal-record.js";
import {
  blockWeight,
  opensTurn,
  pageStart,
  RECORD_WINDOW_WEIGHT,
  recordWeight,
  turnStartAtOrBefore,
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

    it("given a block to reach, goes back to its turn however far that is", () => {
      // Far past any window's weight, and past what the budget alone reaches.
      expect(pageStart(record, 50, end, 8)).toBe(8);
      expect(pageStart(record, 50, end, 9)).toBe(8);
      expect(pageStart(record, 50, end, 3)).toBe(0);
      expect(pageStart(record, 50, end, 0)).toBe(0);
    });

    it("ignores a `to` that is no index older than the page's end", () => {
      const plain = pageStart(record, 50, end);
      for (const to of [end, end + 1, -1, 1.5, Number.NaN, Infinity]) {
        expect(pageStart(record, 50, end, to), String(to)).toBe(plain);
      }
      const notANumber = "8" as unknown as number;
      expect(pageStart(record, 50, end, notANumber)).toBe(plain);
    });
  });
});
