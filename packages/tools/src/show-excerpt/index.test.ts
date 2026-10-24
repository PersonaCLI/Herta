import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ShowExcerptData,
  ToolCallRequest,
  ToolContext,
  ToolResult,
} from "@herta/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globTool } from "../glob/index.js";
import { searchTextTool } from "../search-text/index.js";
import {
  MAX_EXCERPT_CHARS,
  MAX_EXCERPT_LINES,
  showExcerptTool,
} from "./index.js";

let root: string;
const recorded: Array<{ path: string; sha: string }> = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "show-excerpt-")));
  recorded.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function ctx(): ToolContext {
  return {
    workspaceRoot: root,
    reads: {
      record: (p: string, sha: string) => recorded.push({ path: p, sha }),
    },
    // search_text (used by the discovery test below) checks this per file.
    signal: new AbortController().signal,
  } as unknown as ToolContext;
}

const call = (input: unknown): ToolCallRequest =>
  ({ id: "c1", tool: "show_excerpt", input }) as ToolCallRequest;

const noopProgress = () => {};

const run = (input: unknown) =>
  showExcerptTool().run(call(input), ctx(), noopProgress) as Promise<
    ToolResult<ShowExcerptData>
  >;

function seed(name: string, lines: string[]): void {
  writeFileSync(join(root, name), `${lines.join("\n")}\n`, "utf8");
}

describe("show_excerpt", () => {
  it("returns the requested range VERBATIM, line-numbered", async () => {
    seed("a.txt", ["one", "two", "three", "four", "five"]);
    const r = await run({ path: "a.txt", fromLine: 2, toLine: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) throw new Error("expected ok + data");
    expect(r.data.range).toEqual([2, 4]);
    expect(r.data.totalLines).toBe(5);
    expect(r.data.excerpt).toBe("2\ttwo\n3\tthree\n4\tfour");
    expect(r.data.truncated).toBe(false);
    // The summary is what becomes the record row's argument.
    expect(r.summary).toBe("a.txt:2-4");
  });

  it("a bare path shows the head of the file, up to the excerpt bound (2026-09-18)", async () => {
    // The permission lab's most frequent tool failure: 9 of 37 show_excerpt
    // calls were a first call with only the path, rejected with "give either
    // `match` or `fromLine`" and corrected on the second call. The natural
    // first ask is "show me this file"; it now gets the head of the file.
    seed("a.txt", ["one", "two", "three", "four", "five"]);
    const r = await run({ path: "a.txt" });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) throw new Error("expected ok + data");
    expect(r.data.range).toEqual([1, 5]);
    expect(r.data.excerpt).toBe("1\tone\n2\ttwo\n3\tthree\n4\tfour\n5\tfive");
    // A long file: the head is the whole excerpt bound, flagged truncated.
    seed(
      "long.txt",
      Array.from({ length: 200 }, (_, i) => `L${i + 1}`),
    );
    const long = await run({ path: "long.txt" });
    if (!long.ok || long.data === undefined) throw new Error("expected ok");
    expect(long.data.range).toEqual([1, MAX_EXCERPT_LINES]);
    expect(long.data.truncated).toBe(true);
  });

  it("centres on a `match` with context lines each side", async () => {
    seed("log.txt", [
      "l1",
      "l2",
      "l3",
      "here is the WARNING line",
      "l5",
      "l6",
      "l7",
    ]);
    const r = await run({ path: "log.txt", match: "WARNING", context: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) throw new Error("expected ok + data");
    expect(r.data.range).toEqual([2, 6]);
    expect(r.data.excerpt).toContain("WARNING");
    expect(r.data.excerpt.startsWith("2\tl2")).toBe(true);
  });

  it("clamps context at the file's edges", async () => {
    seed("short.txt", ["hit", "b", "c"]);
    const r = await run({ path: "short.txt", match: "hit", context: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) throw new Error("expected ok + data");
    expect(r.data.range).toEqual([1, 3]);
  });

  it("bounds a huge span and says so", async () => {
    seed(
      "big.txt",
      Array.from({ length: 500 }, (_, i) => `line ${i + 1}`),
    );
    const r = await run({ path: "big.txt", fromLine: 1, toLine: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) throw new Error("expected ok + data");
    expect(r.data.truncated).toBe(true);
    expect(r.data.range[1] - r.data.range[0] + 1).toBeLessThanOrEqual(
      MAX_EXCERPT_LINES,
    );
  });

  it("the char cap cuts at a line boundary and the citation follows the cut", async () => {
    // As first shipped, the cap sliced the JOINED string: the excerpt lost
    // its tail but `range` and the summary kept naming the full span — and
    // the compaction digest a later turn keeps inherited the over-claim.
    // 60 lines × ~100 chars ≈ 6000 chars, so the 4000-char cap bites before
    // the line cap does.
    seed(
      "wide.txt",
      Array.from({ length: 80 }, (_, i) => `line ${i + 1} ${"x".repeat(90)}`),
    );
    const r = await run({ path: "wide.txt", fromLine: 1, toLine: 80 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) throw new Error("expected ok + data");
    expect(r.data.truncated).toBe(true);
    const [from, to] = r.data.range;
    expect(to).toBeLessThan(60); // the char cap bit, not just the line cap
    // Every line the citation claims is present IN FULL — the last numbered
    // row of the excerpt is the cited `to`, with its complete body.
    const rows = r.data.excerpt.split("\n");
    expect(rows).toHaveLength(to - from + 1);
    expect(rows[rows.length - 1]).toBe(
      `${String(to).padStart(2, " ")}\tline ${to} ${"x".repeat(90)}`,
    );
    expect(r.summary).toBe(`wide.txt:${from}-${to}`);
  });

  it("a single over-budget line cuts mid-line without splitting a surrogate pair", async () => {
    // A lone line wider than the whole char budget (minified source) is the
    // one case that still cuts inside a line. Astral chars (here 𝐀,
    // U+1D400) are two UTF-16 units — a blind slice can land between them
    // and leave a lone high surrogate, invalid once UTF-8-encoded for the
    // prompt or transcript.
    // The leading `a` matters: the numbered row is `1\ta𝐀𝐀…` — 3 units
    // before the pairs start — so the cap lands mid-pair. Without it the
    // prefix is 2 units and the cut falls on a pair boundary, exercising
    // nothing.
    seed("minified.txt", [`a${"𝐀".repeat(2100)}`]);
    const r = await run({ path: "minified.txt", fromLine: 1, toLine: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.data === undefined) throw new Error("expected ok + data");
    expect(r.data.truncated).toBe(true);
    expect(r.data.range).toEqual([1, 1]); // the partial line is still line 1
    // No lone surrogate at the cut…
    const last = r.data.excerpt.charCodeAt(r.data.excerpt.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    // …and the length proves the back-off actually fired: one unit UNDER
    // the cap, because the unit at the cap was the front half of a pair.
    expect(r.data.excerpt.length).toBe(MAX_EXCERPT_CHARS - 1);
  });

  it("records the read in the freshness ledger (showing IS reading)", async () => {
    seed("a.txt", ["x"]);
    await run({ path: "a.txt", fromLine: 1 });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a match that is not there fails rather than showing something else", async () => {
    seed("a.txt", ["x", "y"]);
    const r = await run({ path: "a.txt", match: "zzz" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe("not_found");
  });

  it("refuses to escape the workspace", async () => {
    const r = await run({ path: "../outside.txt", fromLine: 1 });
    expect(r.ok).toBe(false);
  });

  it("DOES excerpt a redacted command log (ADR 0036, amending ADR 0027 §5)", async () => {
    // §5 originally excluded ALL harness internals from this tool. The
    // persona E2E (2026-08-11) showed the one honest answer to "念给我听那
    // 行输出" is a bounded excerpt of the persisted receipt — the backend
    // tried three times and was denied. `.herta/logs/` passes redactSecrets
    // at capture, so quoting it surfaces nothing the redactor let through.
    // The file must EXIST here: the old pin asserted denial on a nonexistent
    // path, which not_found satisfied just as well — a vacuous pin.
    mkdirSync(join(root, ".herta", "logs"), { recursive: true });
    writeFileSync(
      join(root, ".herta", "logs", "run-abc.log"),
      "exit 0\np = 4.21e-22\nline three\n",
    );
    const r = await run({
      path: ".herta/logs/run-abc.log",
      fromLine: 2,
      toLine: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.excerpt).toContain("4.21e-22");
  });

  it("the log dir is LISTABLE and SEARCHABLE, so a receipt can be found before it is read", async () => {
    // ADR 0036 opened .herta/logs to reads BY FULL PATH, which is enough only
    // if you already know the filename — they are `<uuid>-call_NN_<op>.log`.
    // Both persona re-test arcs watched the backend guess and fail, and one
    // filled the gap by reciting the line from memory. The listing is a glob
    // rooted at the log dir since list_files left (2026-09-18, ADR 0067).
    mkdirSync(join(root, ".herta", "logs"), { recursive: true });
    writeFileSync(
      join(root, ".herta", "logs", "abc-call_00_xyz.log"),
      "exit 0\np = 4.21e-22\n",
    );
    const listed = (await globTool().run(
      {
        id: "l1",
        tool: "glob",
        input: { pattern: "*.log", path: ".herta/logs" },
      } as ToolCallRequest,
      ctx(),
      noopProgress,
    )) as ToolResult<{ files: Array<{ path: string }> }>;
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data?.files.some((e) => e.path.includes("call_00"))).toBe(
      true,
    );

    const found = (await searchTextTool().run(
      {
        id: "s1",
        tool: "search_text",
        input: { pattern: "4\\.21e-22", path: ".herta/logs" },
      } as ToolCallRequest,
      ctx(),
      noopProgress,
    )) as ToolResult<{ matches: Array<{ path: string }> }>;
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.data?.matches.length).toBeGreaterThan(0);
  });

  it("discovery stops at the log dir — .herta itself and tool-results stay denied", async () => {
    mkdirSync(join(root, ".herta", "tool-results"), { recursive: true });
    writeFileSync(join(root, ".herta", "tool-results", "c.json"), "{}\n");
    const listRoot = (await globTool().run(
      {
        id: "l2",
        tool: "glob",
        input: { pattern: "**/*", path: ".herta" },
      } as ToolCallRequest,
      ctx(),
      noopProgress,
    )) as ToolResult<unknown>;
    expect(listRoot.ok).toBe(false);
    if (listRoot.ok) return;
    expect(listRoot.error?.code).toBe("path_denied");

    const listResults = (await globTool().run(
      {
        id: "l3",
        tool: "glob",
        input: { pattern: "**/*", path: ".herta/tool-results" },
      } as ToolCallRequest,
      ctx(),
      noopProgress,
    )) as ToolResult<unknown>;
    expect(listResults.ok).toBe(false);
  });

  it("still does NOT present tool-results — the unredacted subtree (ADR 0027 §5 residue)", async () => {
    // The asymmetry IS the redaction boundary: run_command logs are
    // secret-redacted at capture; tool-results is written verbatim, so
    // excerpting it would turn unredacted bytes into user-facing text.
    // read_file keeps its navigation carve-out there; this tool does not.
    mkdirSync(join(root, ".herta", "tool-results"), { recursive: true });
    writeFileSync(
      join(root, ".herta", "tool-results", "call-1.json"),
      '{"raw": "verbatim"}\n',
    );
    const r = await run({
      path: ".herta/tool-results/call-1.json",
      fromLine: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe("path_denied");
  });

  it("DOES present a session attachment (ADR 0033)", async () => {
    // The deliberate other half of the test above. An attachment is user
    // content stored under a harness directory, not a harness internal, so a
    // document Herta can read but never quote back would answer half the
    // request. If these two ever agree, one carve-out has swallowed the other.
    mkdirSync(join(root, ".herta", "attachments", "s1"), { recursive: true });
    writeFileSync(
      join(root, ".herta", "attachments", "s1", "spec.md"),
      "# Spec\nline two\nline three\n",
    );
    const r = await run({
      path: ".herta/attachments/s1/spec.md",
      fromLine: 1,
      toLine: 2,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.excerpt).toContain("# Spec");
    expect(r.data?.excerpt).toContain("line two");
    expect(r.data?.relPath).toBe(".herta/attachments/s1/spec.md");
  });

  it("redacts secrets — its output reaches the record (review #4)", async () => {
    // Every other record-reaching producer redacts (run_command tails,
    // search_text results, attachment heads); this was the one open door:
    // 展示 a key-bearing file put the key in evidenceDetail, the GUI pane,
    // and the provider prompt verbatim.
    const KEY = `sk-or-v1-${"5".repeat(56)}`;
    seed("cfg.ts", [`const token = "${KEY}";`, "const port = 4300;"]);
    const r = await run({ path: "cfg.ts", fromLine: 1, toLine: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.excerpt).not.toContain(KEY);
    // `token = "…"` matches the env-assignment rule before the sk- pattern
    // ever runs — the marker KIND is the redactor's business, not this
    // test's. What matters is that a marker replaced the key.
    expect(r.data?.excerpt).toContain("[REDACTED:");
    // The rest of the excerpt is untouched — fidelity minus the secret.
    expect(r.data?.excerpt).toContain("const port = 4300;");
  });

  it("rejects a binary file", async () => {
    writeFileSync(join(root, "b.bin"), Buffer.from([0x41, 0x00, 0x42]));
    const r = await run({ path: "b.bin", fromLine: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe("binary_file");
  });

  it("a wrong range key is still named, not silently stripped (strict schema)", async () => {
    // A bare path is valid since 2026-09-18 (the head of the file), but a
    // misspelled range key must still fail loudly — the 2026-07-31 lesson.
    seed("a.txt", ["x"]);
    const r = await run({ path: "a.txt", from: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.code).toBe("invalid_input");
    expect(r.error?.message).toContain("from");
    expect(r.suggestion).toContain("usage:");
  });
});
