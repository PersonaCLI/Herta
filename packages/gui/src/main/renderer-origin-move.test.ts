import { describe, expect, it } from "vitest";
import { entriesToMove, moveIsOwed } from "./renderer-origin-move.js";

/** What the interface kept under `file:`, carried to its own origin once
 *  (owner 2026-11-12). The window work is checked in the built app; these
 *  are its two decisions. */

describe("moveIsOwed", () => {
  it("a profile that held storage and has not been moved is owed a move", () => {
    expect(moveIsOwed({ moved: false, attempts: 0 }, true)).toBe("move");
    expect(moveIsOwed({ moved: false, attempts: 2 }, true)).toBe("move");
  });

  it("a profile that never held any has nothing to carry: no hidden window", () => {
    expect(moveIsOwed({ moved: false, attempts: 0 }, false)).toBe("nothing");
  });

  it("is done once moved, and given up after three tries", () => {
    expect(moveIsOwed({ moved: true, attempts: 1 }, true)).toBe("done");
    expect(moveIsOwed({ moved: false, attempts: 3 }, true)).toBe("done");
    expect(moveIsOwed({ moved: true, attempts: 0 }, false)).toBe("done");
  });
});

describe("entriesToMove", () => {
  it("keeps every string pair, in order", () => {
    expect(
      entriesToMove([
        ["herta-theme-resolved", "dark"],
        ["herta.voice.volume", "0.4"],
        ["empty", ""],
      ]),
    ).toEqual([
      ["herta-theme-resolved", "dark"],
      ["herta.voice.volume", "0.4"],
      ["empty", ""],
    ]);
  });

  it("drops anything that is not one", () => {
    expect(
      entriesToMove([
        ["ok", "1"],
        ["n", 2],
        [3, "x"],
        ["only-key"],
        ["a", "b", "c"],
        null,
        "pair",
      ]),
    ).toEqual([["ok", "1"]]);
    expect(entriesToMove(null)).toEqual([]);
    expect(entriesToMove({ a: "b" })).toEqual([]);
  });
});
