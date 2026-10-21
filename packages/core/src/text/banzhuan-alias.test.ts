import { describe, expect, it } from "vitest";
import {
  aliasBrickInput,
  mapOutsideQuotation,
  quotationRanges,
} from "./banzhuan-alias.js";

const tick = "`";
const f3 = tick.repeat(3);
const f4 = tick.repeat(4);
const covered = (text: string, at: number): boolean =>
  quotationRanges(text).some(([s, e]) => s <= at && at < e);

describe("quotationRanges (ADR 0078 amendment 2026-10-21)", () => {
  it("a closed fenced block, fence lines included, and the inline spans outside it", () => {
    const text = `a ${tick}x${tick}\n${f3}ts\nb ${tick}y\n${f3}\nc ${tick}z${tick}`;
    const slices = quotationRanges(text).map(([s, e]) => text.slice(s, e));
    expect(slices).toEqual([
      `${tick}x${tick}`,
      `${f3}ts\nb ${tick}y\n${f3}`,
      `${tick}z${tick}`,
    ]);
  });

  it("a fence closes only on the same character, at least as long, with nothing after it", () => {
    const longer = `${f3}\nx\n${f4}\ny`;
    expect(quotationRanges(longer).map(([s, e]) => longer.slice(s, e))).toEqual(
      [`${f3}\nx\n${f4}`],
    );
    // Not closed: the text after the opening fence is outside quotation
    // (the fence's own backticks still pair as inline spans, as always).
    for (const text of [
      `${f4}\nx\n${f3}\ny`,
      `${f3}\nx\n~~~\ny`,
      `${f3}\nx\n${f3} not a close\ny`,
    ]) {
      expect(covered(text, text.lastIndexOf("y")), text).toBe(false);
    }
  });

  it("an unclosed fence quotes nothing after it", () => {
    const text = `${f3}\n@板砖`;
    expect(covered(text, text.indexOf("@"))).toBe(false);
  });
});

describe("aliasBrickInput — a quoted passage is not the user typing @brick", () => {
  it("leaves a fenced @brick alone and aliases the typed one", () => {
    const text = `${f3}\ncall @brick here\n${f3}\n@brick please`;
    expect(aliasBrickInput(text, "en")).toBe(
      `${f3}\ncall @brick here\n${f3}\n@板砖 please`,
    );
  });

  it("mapOutsideQuotation passes quotation through verbatim", () => {
    expect(
      mapOutsideQuotation(`a ${tick}a${tick} a`, (s) => s.toUpperCase()),
    ).toBe(`A ${tick}a${tick} A`);
  });
});
