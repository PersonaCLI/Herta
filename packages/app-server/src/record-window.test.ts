import type { TerminalRecord } from "@herta/core";
import { RECORD_WINDOW_WEIGHT } from "@herta/core/record-window";
import { describe, expect, it } from "vitest";
import { recordTail } from "./record-window.js";

/** Messages only: each opens a turn and weighs 10. */
function blocks(n: number): TerminalRecord {
  return Array.from({ length: n }, (_, i) => ({
    kind: "user" as const,
    text: `m${i}`,
  }));
}

describe("recordTail", () => {
  it("returns a short record whole, start 0 (same reference)", () => {
    const r = blocks(3);
    const tail = recordTail(r, 100);
    expect(tail.start).toBe(0);
    expect(tail.record).toBe(r);
  });

  it("slices the trailing window with its absolute start", () => {
    const r = blocks(7);
    const tail = recordTail(r, 30);
    expect(tail.start).toBe(4);
    expect(tail.record.map((b) => (b.kind === "user" ? b.text : ""))).toEqual([
      "m4",
      "m5",
      "m6",
    ]);
  });

  it("a record exactly at the bound is whole", () => {
    const r = blocks(5);
    expect(recordTail(r, 50)).toEqual({ record: r, start: 0 });
  });

  it("defaults to RECORD_WINDOW_WEIGHT: 200 messages", () => {
    const r = blocks(RECORD_WINDOW_WEIGHT / 10 + 10);
    const tail = recordTail(r);
    expect(tail.start).toBe(10);
    expect(tail.record).toHaveLength(RECORD_WINDOW_WEIGHT / 10);
  });

  it("a conversation with long runs comes back whole: 板砖's rows do not fold it", () => {
    const step = {
      kind: "system" as const,
      label: "差分协处理器" as const,
      body: "Reading a.ts",
    };
    const turn: TerminalRecord = [
      { kind: "user", text: "修一下" },
      { kind: "herta", surface: "speech", text: "@板砖 修" },
      ...Array.from({ length: 300 }, () => step),
      { kind: "herta", surface: "speech", text: "好了" },
    ];
    const r = [...turn, ...turn];
    expect(r.length).toBeGreaterThan(200);
    expect(recordTail(r)).toEqual({ record: r, start: 0 });
  });
});
