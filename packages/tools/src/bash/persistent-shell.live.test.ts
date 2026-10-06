import { describe, expect, it } from "vitest";
import { feedLiveLines, freshLiveLines } from "./persistent-shell.js";

/**
 * The live view's line rules (ADR 0073), fed the way a pipe delivers them:
 * in chunks that end ANYWHERE. A fixed expectation per stream, checked for
 * every way of cutting it in two and in three — what reaches the view must
 * not depend on where the operating system happened to split the output.
 *
 * The flake this pins (2026-10-07, a full-suite run on Windows): the
 * wrapper's printf opens the marker with a newline of its own, and a chunk
 * that ended right after that newline let it through as a blank line —
 * `echo three` showed "three\n\n".
 */
const MARKER = "__HERTA_SH_0123456789ab__";
const MARKER_LINE = `\n${MARKER}:0:0:/w\n`;
const WS_LINE = "__HERTA_WS_aaaaaaaaaaaa__:/c/w\n";
const PD_LINE = "__HERTA_PD_bbbbbbbbbbbb__:1:2:C:\\ps.exe\n";

function feed(chunks: readonly string[]): string {
  const st = freshLiveLines();
  return chunks.map((c) => feedLiveLines(st, c, MARKER)).join("");
}

function everySplit(stream: string): string[][] {
  const out: string[][] = [[stream]];
  for (let i = 1; i < stream.length; i += 1) {
    out.push([stream.slice(0, i), stream.slice(i)]);
    for (let j = i + 1; j < stream.length; j += 1) {
      out.push([stream.slice(0, i), stream.slice(i, j), stream.slice(j)]);
    }
  }
  return out;
}

describe("feedLiveLines — any chunking reads the same (ADR 0073)", () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ["output ending in a newline", `three\n${MARKER_LINE}`, "three\n"],
    [
      "output that ends with a blank line of its own",
      `three\n\n${MARKER_LINE}`,
      "three\n\n",
    ],
    ["an unterminated last line", `tail${MARKER_LINE}`, "tail\n"],
    ["a blank line inside the output", `a\n\nb\n${MARKER_LINE}`, "a\n\nb\n"],
    ["no output at all", MARKER_LINE, ""],
    [
      "a fresh shell's protocol lines ahead of the output",
      `${WS_LINE}${PD_LINE}one\n${MARKER_LINE}`,
      "one\n",
    ],
    ["whatever follows the marker line", `one\n${MARKER_LINE}late\n`, "one\n"],
  ];

  it.each(cases)("%s", (_label, stream, expected) => {
    for (const chunks of everySplit(stream)) {
      expect(feed(chunks), JSON.stringify(chunks)).toBe(expected);
    }
  });

  it("a held blank line still shows ahead of an over-long unterminated line (a progress bar)", () => {
    const bar = "x".repeat(5_000);
    expect(feed(["a\n\n", bar])).toBe(`a\n\n${bar}`);
  });
});
