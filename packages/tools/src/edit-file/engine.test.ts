import { describe, expect, it } from "vitest";
import {
  applyHunks,
  computeUnifiedDiff,
  parsePatch,
  validateHunks,
} from "./engine.js";

describe("parsePatch", () => {
  it("accepts a single well-formed hunk", () => {
    const r = parsePatch([{ search: "old", replace: "new" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.hunks).toEqual([{ search: "old", replace: "new" }]);
  });

  it("accepts multi-hunk arrays", () => {
    const r = parsePatch([
      { search: "a", replace: "A" },
      { search: "b", replace: "B" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("accepts empty replace (deletion)", () => {
    const r = parsePatch([{ search: "remove me\n", replace: "" }]);
    expect(r.ok).toBe(true);
  });

  it("rejects non-array input", () => {
    const r = parsePatch("not an array" as unknown);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("parse_failed");
  });

  it("rejects empty hunks array", () => {
    const r = parsePatch([]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("parse_failed");
  });

  it("rejects empty search", () => {
    const r = parsePatch([{ search: "", replace: "x" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("parse_failed");
  });

  it("rejects non-string fields", () => {
    const r = parsePatch([{ search: 1, replace: "x" }] as unknown);
    expect(r.ok).toBe(false);
  });
});

describe("validateHunks", () => {
  it("ok when each search appears exactly once", () => {
    const r = validateHunks("hello world", [
      { search: "world", replace: "earth" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("hunk_not_found when search absent", () => {
    const r = validateHunks("hello world", [{ search: "moon", replace: "x" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("hunk_not_found");
  });

  it("hunk_ambiguous when search appears multiple times", () => {
    const r = validateHunks("foo foo", [{ search: "foo", replace: "bar" }]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("hunk_ambiguous");
  });

  it("allows sequential hunks on disjoint regions", () => {
    const r = validateHunks("alpha beta gamma", [
      { search: "alpha", replace: "ALPHA" },
      { search: "gamma", replace: "GAMMA" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("hunk_overlap when a later search overlaps an earlier replacement region", () => {
    const before = "say small thing";
    const r = validateHunks(before, [
      { search: "small", replace: "BIG" },
      { search: "ay BIG", replace: "ay XXX" },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.code).toBe("hunk_overlap");
  });
});

describe("applyHunks", () => {
  it("applies a single hunk", () => {
    expect(
      applyHunks("hello world", [{ search: "world", replace: "earth" }]),
    ).toBe("hello earth");
  });

  it("applies multiple hunks in order", () => {
    expect(
      applyHunks("a b c", [
        { search: "a", replace: "A" },
        { search: "c", replace: "C" },
      ]),
    ).toBe("A b C");
  });

  it("preserves CRLF line endings", () => {
    expect(applyHunks("a\r\nb\r\nc\r\n", [{ search: "b", replace: "B" }])).toBe(
      "a\r\nB\r\nc\r\n",
    );
  });

  it("preserves trailing newline", () => {
    expect(applyHunks("hi\n", [{ search: "hi", replace: "hello" }])).toBe(
      "hello\n",
    );
  });

  it("supports deletion (empty replace)", () => {
    expect(
      applyHunks("a\nremove me\nb\n", [{ search: "remove me\n", replace: "" }]),
    ).toBe("a\nb\n");
  });
});

describe("computeUnifiedDiff", () => {
  it("returns empty string when before === after", () => {
    expect(computeUnifiedDiff("same", "same", "x.txt")).toBe("");
  });

  it("includes a/x.txt and b/x.txt headers", () => {
    const d = computeUnifiedDiff("alpha\n", "beta\n", "x.txt");
    expect(d).toContain("--- a/x.txt");
    expect(d).toContain("+++ b/x.txt");
  });

  it("a created file only adds, and an emptied one only deletes — no stray empty line (2026-10-08)", () => {
    // `"".split("\n")` is one empty line: every create ended in a `-`,
    // and the file's stat read −1.
    expect(computeUnifiedDiff("", "a\nb\n", "x.txt")).toBe(
      "--- /dev/null\n+++ b/x.txt\n+a\n+b",
    );
    expect(computeUnifiedDiff("a\n", "", "x.txt")).toBe(
      "--- a/x.txt\n+++ b/x.txt\n-a",
    );
  });

  it("marks deletions with - and additions with +", () => {
    const d = computeUnifiedDiff("alpha\n", "beta\n", "x.txt");
    expect(d).toContain("-alpha");
    expect(d).toContain("+beta");
  });

  it("is deterministic for identical inputs", () => {
    const a = computeUnifiedDiff("a\n", "b\n", "x.txt");
    const b = computeUnifiedDiff("a\n", "b\n", "x.txt");
    expect(a).toBe(b);
  });
});

describe("computeUnifiedDiff — new file (before is empty)", () => {
  it("emits --- /dev/null when before is empty and after is non-empty", () => {
    const d = computeUnifiedDiff("", "hello\n", "new.txt");
    expect(d).toContain("--- /dev/null");
    expect(d).toContain("+++ b/new.txt");
    expect(d).toContain("+hello");
    expect(d).not.toContain("--- a/new.txt");
  });

  it("does not emit a no-newline marker for the /dev/null source side", () => {
    const d = computeUnifiedDiff("", "hello\n", "new.txt");
    const beforeMarkerCount = (d.match(/\\ No newline at end of file/g) ?? [])
      .length;
    expect(beforeMarkerCount).toBe(0);
  });

  it("still emits +++ b/<label> with no-newline marker when after lacks trailing newline", () => {
    const d = computeUnifiedDiff("", "no-newline", "new.txt");
    expect(d).toContain("--- /dev/null");
    expect(d).toContain("+++ b/new.txt");
    expect(d).toContain("+no-newline");
    expect(d).toContain("\\ No newline at end of file");
  });

  it("preserves --- a/<label> when before is non-empty", () => {
    const d = computeUnifiedDiff("alpha\n", "beta\n", "x.txt");
    expect(d).toContain("--- a/x.txt");
    expect(d).not.toContain("--- /dev/null");
  });
});

/**
 * The LCS table is `(n+1) x (m+1)` numbers, and the permission RULE computes
 * this preview on the Electron MAIN process while the user waits for the
 * approval card. Measured 2026-08-25 before the bound: 4,000 lines = 123 MB and
 * 383 ms, quadratic, so ~6.7 GB at 30,000 — the app dies instead of showing the
 * diff it was asked for.
 */
describe("computeUnifiedDiff — bounded cost (2026-08-25)", () => {
  const lines = (n: number, f: (i: number) => string = (i) => `line ${i}`) =>
    `${Array.from({ length: n }, (_, i) => f(i)).join("\n")}\n`;
  const count = (d: string, p: "+" | "-") =>
    d.split("\n").filter((l) => l.startsWith(p) && !l.startsWith(p.repeat(3)))
      .length;

  it("a one-line edit in a huge file is cheap, focused and exact", () => {
    const before = lines(30_000);
    const after = before.replace("line 5000\n", "FIVE THOUSAND\n");
    const started = Date.now();
    const d = computeUnifiedDiff(before, after, "f.txt");
    // Generous by three orders of magnitude — the point is that it is not
    // quadratic, not that it hits a particular millisecond.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(count(d, "+")).toBe(1);
    expect(count(d, "-")).toBe(1);
    // The identical head and tail are peeled, with the omission stated.
    expect(d).toMatch(/\\ \d+ unchanged lines omitted/);
    expect(d.split("\n").length).toBeLessThan(40);
    expect(d).toContain("+FIVE THOUSAND");
    expect(d).toContain("-line 5000");
  });

  it("a wholesale rewrite falls back to one replacement — and stays EXACT", () => {
    // countDiffLines derives the report's +N -M from this text, so a truncated
    // fallback would fabricate the counts. It must stay complete.
    const before = lines(20_000, (i) => `old ${i}`);
    const after = lines(20_000, (i) => `new ${i}`);
    const d = computeUnifiedDiff(before, after, "f.txt");
    expect(d).toContain("too large to align");
    expect(count(d, "+")).toBe(20_000);
    expect(count(d, "-")).toBe(20_000);
  });

  it("a huge span with distinct lines is ALIGNED, not called one replacement", () => {
    // The coarse fallback emits every line of one side as a deletion and every
    // line of the other as an insertion, which is a fair RENDERING but lies
    // about magnitude — and `countDiffLines` derives the `+N -M` Herta narrates
    // as ground truth from exactly this text. Measured before anchoring: a
    // 3,000-line span sharing 1,500 lines reported +2999 -2999 against a true
    // churn of +1500 -1500.
    const a: string[] = [];
    const b: string[] = [];
    for (let i = 0; i < 1500; i += 1) {
      a.push(`function handler${i}() {`, `  return old${i};`);
      b.push(`function handler${i}() {`, `  return new${i};`);
    }
    const d = computeUnifiedDiff(
      `${a.join("\n")}\n`,
      `${b.join("\n")}\n`,
      "f.ts",
    );
    expect(d).not.toContain("too large to align");
    expect(count(d, "+")).toBe(1500);
    expect(count(d, "-")).toBe(1500);
  });

  it("a span sharing only REPEATED lines stays coarse, and says so", () => {
    // The honest residue: with no line unique on both sides there is nothing
    // to anchor on, so no alignment is better supported than any other. It
    // over-reports rather than under-, and the rendering states it.
    const a: string[] = [];
    const b: string[] = [];
    for (let i = 0; i < 1500; i += 1) {
      a.push("}", `a${i}`);
      b.push("}", `b${i}`);
    }
    const d = computeUnifiedDiff(
      `${a.join("\n")}\n`,
      `${b.join("\n")}\n`,
      "f.ts",
    );
    expect(d).toContain("too large to align");
  });

  it("below the budget nothing changes — still the whole-file walk", () => {
    const before = lines(300);
    const after = before.replace("line 10\n", "TEN\n");
    const d = computeUnifiedDiff(before, after, "f.txt");
    expect(d).not.toContain("unchanged lines omitted");
    expect(d.split("\n").filter((l) => l.startsWith(" ")).length).toBe(299);
    expect(count(d, "+")).toBe(1);
    expect(count(d, "-")).toBe(1);
  });
});
