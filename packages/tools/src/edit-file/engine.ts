export interface Hunk {
  search: string;
  replace: string;
}

export type ParsePatchResult =
  | { ok: true; hunks: Hunk[] }
  | { ok: false; code: "parse_failed"; message: string };

export type ValidateResult =
  | { ok: true }
  | {
      ok: false;
      code: "hunk_not_found" | "hunk_ambiguous" | "hunk_overlap";
      message: string;
    };

export function parsePatch(input: unknown): ParsePatchResult {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      code: "parse_failed",
      message: "hunks must be an array",
    };
  }
  if (input.length === 0) {
    return {
      ok: false,
      code: "parse_failed",
      message: "hunks must be non-empty",
    };
  }
  const hunks: Hunk[] = [];
  for (let i = 0; i < input.length; i++) {
    const h = input[i] as unknown;
    if (typeof h !== "object" || h === null) {
      return {
        ok: false,
        code: "parse_failed",
        message: `hunk[${i}] must be an object`,
      };
    }
    const rec = h as Record<string, unknown>;
    if (typeof rec.search !== "string") {
      return {
        ok: false,
        code: "parse_failed",
        message: `hunk[${i}].search must be a string`,
      };
    }
    if (typeof rec.replace !== "string") {
      return {
        ok: false,
        code: "parse_failed",
        message: `hunk[${i}].replace must be a string`,
      };
    }
    if (rec.search.length === 0) {
      return {
        ok: false,
        code: "parse_failed",
        message: `hunk[${i}].search must be non-empty`,
      };
    }
    hunks.push({ search: rec.search, replace: rec.replace });
  }
  return { ok: true, hunks };
}

interface ApplyTrace {
  hunkIndex: number;
  postStart: number;
  postEnd: number;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found < 0) return count;
    count += 1;
    idx = found + needle.length;
  }
}

export function validateHunks(
  content: string,
  hunks: ReadonlyArray<Hunk>,
): ValidateResult {
  let current = content;
  const replacementRanges: ApplyTrace[] = [];
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i] as Hunk;
    const occurrences = countOccurrences(current, h.search);
    if (occurrences === 0) {
      return {
        ok: false,
        code: "hunk_not_found",
        message: `hunk[${i}] search not found`,
      };
    }
    if (occurrences > 1) {
      return {
        ok: false,
        code: "hunk_ambiguous",
        message: `hunk[${i}] search matches ${occurrences} places; need 1`,
      };
    }
    const matchStart = current.indexOf(h.search);
    const matchEnd = matchStart + h.search.length;
    for (const r of replacementRanges) {
      const overlaps = !(matchEnd <= r.postStart || matchStart >= r.postEnd);
      if (overlaps) {
        return {
          ok: false,
          code: "hunk_overlap",
          message: `hunk[${i}] match overlaps hunk[${r.hunkIndex}] replacement region`,
        };
      }
    }
    const newPostStart = matchStart;
    const newPostEnd = matchStart + h.replace.length;
    const delta = h.replace.length - h.search.length;
    for (const r of replacementRanges) {
      if (r.postStart >= matchEnd) {
        r.postStart += delta;
        r.postEnd += delta;
      }
    }
    replacementRanges.push({
      hunkIndex: i,
      postStart: newPostStart,
      postEnd: newPostEnd,
    });
    current =
      current.slice(0, matchStart) + h.replace + current.slice(matchEnd);
  }
  return { ok: true };
}

export function applyHunks(
  content: string,
  hunks: ReadonlyArray<Hunk>,
): string {
  let current = content;
  for (const h of hunks) {
    const idx = current.indexOf(h.search);
    if (idx < 0) {
      throw new Error(
        "applyHunks invariant violated: hunk search missing — call validateHunks first",
      );
    }
    current =
      current.slice(0, idx) + h.replace + current.slice(idx + h.search.length);
  }
  return current;
}

export function computeUnifiedDiff(
  before: string,
  after: string,
  label: string,
): string {
  if (before === after) return "";
  // An empty side has no lines (2026-10-08): `"".split("\n")` is one empty
  // line, so every created file's diff ended by deleting it — a stray `-`
  // that counted as −1 on the file's stat.
  const lines = (text: string): string[] => {
    if (text.length === 0) return [];
    const all = text.split("\n");
    return text.endsWith("\n") ? all.slice(0, -1) : all;
  };
  const beforeNoTrail = lines(before);
  const afterNoTrail = lines(after);
  const body = diffBody(beforeNoTrail, afterNoTrail);
  const noNewlineBefore =
    before.length === 0 || before.endsWith("\n")
      ? ""
      : "\n\\ No newline at end of file";
  const noNewlineAfter =
    after.length === 0 || after.endsWith("\n")
      ? ""
      : "\n\\ No newline at end of file";
  const sourceHeader = before.length === 0 ? "--- /dev/null" : `--- a/${label}`;
  return [
    sourceHeader,
    `+++ b/${label}`,
    body + noNewlineBefore + noNewlineAfter,
  ].join("\n");
}

interface DiffOp {
  kind: "ctx" | "del" | "add";
  line: string;
}

/**
 * Cells of the LCS table this is willing to allocate.
 *
 * The table is `(n+1) x (m+1)` numbers, so the cost is QUADRATIC in file
 * length, and this runs inside the permission RULE — on the Electron main
 * process, while the user waits for the approval card the call was supposed to
 * produce. Measured on 2026-08-25: 4,000 lines is 123 MB and 383 ms; 20,000 is
 * ~3 GB and 30,000 is ~6.7 GB, i.e. the app is gone, and the last thing the
 * user sees is it dying instead of the diff they were about to judge.
 *
 * 2M cells is ~16 MB and a couple of hundred milliseconds — the point where a
 * preview stops being worth a main-process stall.
 */
const MAX_LCS_CELLS = 2_000_000;
/** Unchanged lines kept either side of the changed span once trimming starts. */
const TRIM_CONTEXT = 3;

/**
 * The diff body, computed within a bounded budget.
 *
 * Under the budget this is exactly the whole-file walk it has always been, so
 * ordinary edits are byte-identical to before. Over it, the identical head and
 * tail are peeled first — a one-line replacement in a 30,000-line file has a
 * tiny middle, which is the case that used to be fatal — and only the middle is
 * walked. If even the middle is too large, the span is emitted as one complete
 * replacement.
 *
 * The coarse form is deliberately NOT truncated: `countDiffLines` derives the
 * report's `+N -M` from this text, so dropping lines here would fabricate the
 * counts. Its size is linear in the file, which is survivable; the quadratic
 * allocation was the failure.
 */
function diffBody(a: string[], b: string[]): string {
  if (a.length * b.length <= MAX_LCS_CELLS) {
    return render(diffOps(a, b, longestCommonSubsequence(a, b)));
  }

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const headKeep = Math.min(TRIM_CONTEXT, prefix);
  const tailKeep = Math.min(TRIM_CONTEXT, suffix);

  const parts: string[] = [];
  // A `\ ` line is already part of this format ("\ No newline at end of file"),
  // so consumers tolerate it and `countDiffLines` ignores it.
  if (prefix - headKeep > 0) {
    parts.push(`\\ ${prefix - headKeep} unchanged lines omitted`);
  }
  for (const line of a.slice(prefix - headKeep, prefix)) parts.push(` ${line}`);

  if (midA.length * midB.length <= MAX_LCS_CELLS) {
    parts.push(
      render(diffOps(midA, midB, longestCommonSubsequence(midA, midB))),
    );
  } else {
    const refined = anchoredOps(midA, midB, 0);
    if (refined.coarse) {
      parts.push(
        "\\ part of this span was too large to align line by line — shown as one replacement",
      );
    }
    parts.push(render(refined.ops));
  }

  for (const line of a.slice(a.length - suffix, a.length - suffix + tailKeep)) {
    parts.push(` ${line}`);
  }
  if (suffix - tailKeep > 0) {
    parts.push(`\\ ${suffix - tailKeep} unchanged lines omitted`);
  }
  return parts.filter((s) => s.length > 0).join("\n");
}

/** How many times the anchor split may recurse before giving up on a gap. */
const MAX_ANCHOR_DEPTH = 4;

/**
 * Align a span too big for the LCS table by splitting it on lines that occur
 * exactly ONCE on each side (patience anchoring), then walking the gaps.
 *
 * Emitting the whole span as "delete everything, insert everything" is correct
 * as a rendering but LIES about magnitude, and `countDiffLines` derives the
 * `+N -M` that Herta narrates as ground truth from exactly this text. Measured
 * before this existed: a 3,000-line span sharing 1,500 lines reported
 * `+2999 -2999` where the true churn was `+1500 -1500`.
 *
 * A line unique on both sides can only correspond to itself, so anchors are
 * unambiguous; keeping the longest increasing run of them yields an alignment
 * no crossing match can improve on. Each gap is then small enough for the
 * exact walk, and the coarse form survives only for a span with no unique line
 * in common at all — where "one replacement" is the honest description.
 *
 * The residue is stated rather than hidden: in that last case the counts are
 * still the coarse ones, so a span sharing only REPEATED lines over-reports.
 * It over-reports, never under — and it is the case where nothing in the text
 * distinguishes one candidate alignment from another, so there is no better
 * number to give. The rendering says so on its own line.
 */
function anchoredOps(
  a: readonly string[],
  b: readonly string[],
  depth: number,
): { ops: DiffOp[]; coarse: boolean } {
  if (a.length * b.length <= MAX_LCS_CELLS) {
    return {
      ops: diffOps([...a], [...b], longestCommonSubsequence([...a], [...b])),
      coarse: false,
    };
  }
  const anchors = depth < MAX_ANCHOR_DEPTH ? uniqueCommonAnchors(a, b) : [];
  if (anchors.length === 0) {
    return {
      ops: [
        ...a.map((line): DiffOp => ({ kind: "del", line })),
        ...b.map((line): DiffOp => ({ kind: "add", line })),
      ],
      coarse: true,
    };
  }
  const ops: DiffOp[] = [];
  let coarse = false;
  let ai = 0;
  let bi = 0;
  for (const [aAt, bAt] of anchors) {
    const gap = anchoredOps(a.slice(ai, aAt), b.slice(bi, bAt), depth + 1);
    ops.push(...gap.ops);
    coarse = coarse || gap.coarse;
    ops.push({ kind: "ctx", line: a[aAt] as string });
    ai = aAt + 1;
    bi = bAt + 1;
  }
  const tail = anchoredOps(a.slice(ai), b.slice(bi), depth + 1);
  ops.push(...tail.ops);
  return { ops, coarse: coarse || tail.coarse };
}

/**
 * Positions of lines appearing exactly once in each side, kept as the longest
 * run that increases on BOTH sides (two anchors that cross cannot both hold).
 */
function uniqueCommonAnchors(
  a: readonly string[],
  b: readonly string[],
): Array<[number, number]> {
  const onlyOnce = (lines: readonly string[]): Map<string, number> => {
    const seen = new Map<string, number>();
    lines.forEach((line, i) => {
      seen.set(line, seen.has(line) ? -1 : i);
    });
    return seen;
  };
  const inA = onlyOnce(a);
  const inB = onlyOnce(b);
  const pairs: Array<[number, number]> = [];
  for (const [line, at] of inA) {
    if (at < 0) continue;
    const other = inB.get(line);
    if (other === undefined || other < 0) continue;
    pairs.push([at, other]);
  }
  pairs.sort((x, y) => x[0] - y[0]);

  // Longest strictly increasing subsequence by the b-coordinate (patience
  // sorting): O(n log n), and the tails array holds indices so the chain can
  // be walked back.
  const tails: number[] = [];
  const prev: number[] = new Array<number>(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i += 1) {
    const v = (pairs[i] as [number, number])[1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((pairs[tails[mid] as number] as [number, number])[1] < v)
        lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] as number;
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }
  const out: Array<[number, number]> = [];
  let k = tails.length > 0 ? (tails[tails.length - 1] as number) : -1;
  while (k >= 0) {
    out.push(pairs[k] as [number, number]);
    k = prev[k] as number;
  }
  return out.reverse();
}

function render(ops: readonly DiffOp[]): string {
  return ops
    .map((op) => {
      if (op.kind === "ctx") return ` ${op.line}`;
      if (op.kind === "del") return `-${op.line}`;
      return `+${op.line}`;
    })
    .join("\n");
}

function longestCommonSubsequence(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const dpRow = dp[i] as number[];
      const dpPrev = dp[i - 1] as number[];
      if (a[i - 1] === b[j - 1]) {
        dpRow[j] = (dpPrev[j - 1] as number) + 1;
      } else {
        const up = dpPrev[j] as number;
        const left = dpRow[j - 1] as number;
        dpRow[j] = up >= left ? up : left;
      }
    }
  }
  return dp;
}

function diffOps(a: string[], b: string[], dp: number[][]): DiffOp[] {
  const ops: DiffOp[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: "ctx", line: a[i - 1] as string });
      i -= 1;
      j -= 1;
      continue;
    }
    const up = ((dp[i - 1] as number[])[j] as number) ?? 0;
    const left = ((dp[i] as number[])[j - 1] as number) ?? 0;
    if (up >= left) {
      ops.push({ kind: "del", line: a[i - 1] as string });
      i -= 1;
    } else {
      ops.push({ kind: "add", line: b[j - 1] as string });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push({ kind: "del", line: a[i - 1] as string });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ kind: "add", line: b[j - 1] as string });
    j -= 1;
  }
  return ops.reverse();
}
