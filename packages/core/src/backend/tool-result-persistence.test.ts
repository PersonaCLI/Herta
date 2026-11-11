import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolResult } from "../types/tool.js";
import {
  PERSIST_PAGE_LINES,
  PERSIST_PREVIEW_CHARS,
  PERSIST_RESULT_THRESHOLD_CHARS,
  pageable,
  persistOversizedResult,
} from "./tool-result-persistence.js";

let ws: string | undefined;
afterEach(() => {
  if (ws !== undefined) rmSync(ws, { recursive: true, force: true });
  ws = undefined;
});

function mkWs(): string {
  ws = mkdtempSync(join(tmpdir(), "herta-persist-"));
  return ws;
}

const small: ToolResult = {
  ok: true,
  summary: "read x.ts",
  data: { content: "short" },
};

describe("persistOversizedResult", () => {
  it("passes small results through untouched, no file written", () => {
    const root = mkWs();
    const out = persistOversizedResult({
      result: small,
      workspaceRoot: root,
      taskId: "t1",
      callId: "c1",
    });
    expect(out.persistedPath).toBeUndefined();
    expect(out.transcriptResult).toBe(small);
  });

  it("persists an oversized payload and stores preview + path in the transcript variant", () => {
    const root = mkWs();
    const big = "z".repeat(PERSIST_RESULT_THRESHOLD_CHARS + 5_000);
    const result: ToolResult = {
      ok: true,
      summary: "diff of everything",
      data: { diff: big },
    };
    const out = persistOversizedResult({
      result,
      workspaceRoot: root,
      taskId: "task-abc",
      callId: "call_01",
    });
    expect(out.persistedPath).toBe(".herta/tool-results/task-abc/call_01.txt");
    // File holds the FULL serialized payload.
    const onDisk = readFileSync(
      join(root, ".herta", "tool-results", "task-abc", "call_01.txt"),
      "utf8",
    );
    expect(onDisk).toContain(big);
    // Transcript variant: same ok/summary, bounded data with pointer.
    const t = out.transcriptResult;
    expect(t.ok).toBe(true);
    expect(t.summary).toBe("diff of everything");
    const data = t.data as {
      persisted: boolean;
      path: string;
      preview: string;
      note: string;
    };
    expect(data.persisted).toBe(true);
    expect(data.path).toBe(out.persistedPath);
    expect(data.preview.length).toBe(PERSIST_PREVIEW_CHARS);
    expect(data.note).toContain("read_file");
  });

  // Review 2026-11-10, second pass: the file was one line of JSON, so the
  // note's "offset/limit" could not page it.
  it("writes a file's content as the lines it is, so the pointer can be paged", () => {
    const root = mkWs();
    const source = Array.from(
      { length: 2_000 },
      (_, i) => `${i + 1}\tconst v${i} = "q${i}"; // line ${i + 1}`,
    );
    const result: ToolResult = {
      ok: true,
      summary: "read big.ts",
      data: {
        path: "src/big.ts",
        totalLines: 2_000,
        content: source.join("\n"),
      },
    };
    const out = persistOversizedResult({
      result,
      workspaceRoot: root,
      taskId: "t",
      callId: "c",
    });
    const onDisk = readFileSync(
      join(root, ".herta", "tool-results", "t", "c.txt"),
      "utf8",
    ).split("\n");
    // Every source line is a line of the file, unescaped.
    const from = onDisk.indexOf("== data.content ==");
    expect(from).toBeGreaterThan(0);
    expect(onDisk.slice(from + 1, from + 1 + 2_000)).toEqual(source);
    // The head is still the payload, with the content pointed at.
    const head = JSON.parse(onDisk.slice(0, from - 1).join("\n"));
    expect(head.data.path).toBe("src/big.ts");
    expect(head.data.content).toBe(
      '(2000 lines, below under "== data.content ==")',
    );
    const data = out.transcriptResult.data as { lines: number; note: string };
    expect(data.lines).toBe(onDisk.length - 1);
    expect(data.note).toContain(`${data.lines} lines`);
    expect(data.note).toContain(`limit of ${PERSIST_PAGE_LINES} lines`);
    // A page of that size is not itself oversized.
    const page = onDisk
      .slice(from + 1, from + 1 + PERSIST_PAGE_LINES)
      .join("\n");
    expect(JSON.stringify({ data: { content: page } }).length).toBeLessThan(
      PERSIST_RESULT_THRESHOLD_CHARS,
    );
  });

  it("pageable lifts only strings with lines to page, wherever they sit", () => {
    const diff = `--- a\n+++ b\n${"+x\n".repeat(100)}`;
    const text = pageable({
      data: {
        files: [
          { path: "a.ts", diff },
          { path: "b.ts", diff: "short\none" },
        ],
        blob: "z".repeat(5_000),
      },
      error: { code: "boom" },
    });
    expect(text).toContain("\n== data.files[0].diff ==\n--- a\n+++ b\n+x\n");
    // A short string and a string of one long line stay in the JSON.
    expect(text).toContain('"diff": "short\\none"');
    expect(text).toContain(`"blob": "${"z".repeat(5_000)}"`);
    expect(text).toContain('"code": "boom"');
    expect(text.endsWith("\n")).toBe(true);
  });

  it("keeps error + suggestion on an oversized failure result", () => {
    const root = mkWs();
    const result: ToolResult = {
      ok: false,
      summary: "failed big",
      data: { partial: "y".repeat(PERSIST_RESULT_THRESHOLD_CHARS + 100) },
      error: { code: "boom", message: "kaput", retryable: false },
      suggestion: "try smaller",
    };
    const out = persistOversizedResult({
      result,
      workspaceRoot: root,
      taskId: "t",
      callId: "c",
    });
    expect(out.persistedPath).toBeDefined();
    expect(out.transcriptResult.error?.code).toBe("boom");
    expect(out.transcriptResult.suggestion).toBe("try smaller");
  });

  it("sanitizes hostile call ids into safe filenames", () => {
    const root = mkWs();
    const result: ToolResult = {
      ok: true,
      summary: "big",
      data: { x: "q".repeat(PERSIST_RESULT_THRESHOLD_CHARS + 1) },
    };
    const out = persistOversizedResult({
      result,
      workspaceRoot: root,
      taskId: "..",
      callId: "../../etc/passwd",
    });
    // All-dot stems neutralize to "call"; separators collapse to
    // underscores — everything stays inside .herta/tool-results/.
    expect(out.persistedPath).toBe(
      ".herta/tool-results/call/.._.._etc_passwd.txt",
    );
    expect(
      readFileSync(
        join(root, ".herta", "tool-results", "call", ".._.._etc_passwd.txt"),
        "utf8",
      ).length,
    ).toBeGreaterThan(PERSIST_RESULT_THRESHOLD_CHARS);
  });

  it("passes through unbounded on a write failure instead of breaking the turn", () => {
    const root = mkWs();
    // Make `.herta` a FILE so mkdir of .herta/tool-results fails.
    writeFileSync(join(root, ".herta"), "not a dir", "utf8");
    const result: ToolResult = {
      ok: true,
      summary: "big",
      data: { x: "q".repeat(PERSIST_RESULT_THRESHOLD_CHARS + 1) },
    };
    const out = persistOversizedResult({
      result,
      workspaceRoot: root,
      taskId: "t",
      callId: "c",
    });
    expect(out.persistedPath).toBeUndefined();
    expect(out.transcriptResult).toBe(result);
  });
});
