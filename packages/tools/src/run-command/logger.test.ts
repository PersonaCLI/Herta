import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { type RunLogPayload, writeRunLog } from "./logger.js";

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

/** A complete RunLogPayload with sensible defaults; override per test. */
function payload(over: Partial<RunLogPayload> = {}): RunLogPayload {
  return {
    ts: "2026-05-03T00:00:00.000Z",
    cwd: ".",
    argv: ["echo", "hi"],
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 5,
    stdout: "hi\n",
    stderr: "",
    stdoutBytes: 3,
    stderrBytes: 0,
    stdoutCapped: false,
    stderrCapped: false,
    ...over,
  };
}

describe("writeRunLog", () => {
  it("writes the log file at .herta/logs/<sessionId>-<callId>.log", async () => {
    ws = await mkTmpWorkspace({});
    const path = await writeRunLog(ws.root, "sess-1", "call-1", payload());
    expect(path).toBe(".herta/logs/sess-1-call-1.log");
    const content = await readFile(join(ws.root, path), "utf-8");
    expect(content).toContain("=== herta command log ===");
    expect(content).toContain("sessionId: sess-1");
    expect(content).toContain("callId: call-1");
    expect(content).toContain('argv: ["echo","hi"]');
    expect(content).toContain("exitCode: 0");
    expect(content).toContain("=== stdout ===");
    expect(content).toContain("hi\n");
    expect(content).toContain("=== stderr ===");
  });

  it("marks a capped stream in the header (audit T3.4 advisory)", async () => {
    ws = await mkTmpWorkspace({});
    const path = await writeRunLog(
      ws.root,
      "s",
      "c",
      payload({
        stdout: "x".repeat(1000),
        stdoutBytes: 5_000_000,
        stdoutCapped: true,
      }),
    );
    const content = await readFile(join(ws.root, path), "utf-8");
    // The capped stream is self-describing; a complete stream is not marked.
    expect(content).toContain("=== stdout === (CAPPED — 5000000 total bytes");
    expect(content).toContain("=== stderr === (0 bytes)");
    expect(content).not.toContain("=== stderr === (CAPPED");
  });

  it("creates .herta/logs directory if missing", async () => {
    ws = await mkTmpWorkspace({});
    const path = await writeRunLog(
      ws.root,
      "s",
      "c",
      payload({ argv: ["true"], durationMs: 1, stdout: "", stdoutBytes: 0 }),
    );
    expect(path).toBe(".herta/logs/s-c.log");
    const content = await readFile(join(ws.root, path), "utf-8");
    expect(content).toContain("=== herta command log ===");
  });

  it("never lets a traversal callId escape .herta/logs (audit 2026-07-13 T2.4)", async () => {
    ws = await mkTmpWorkspace({});
    const path = await writeRunLog(
      ws.root,
      "sess-1",
      "../../../../tmp/evil",
      payload({ ts: "2026-07-13T00:00:00.000Z", stdout: "", stdoutBytes: 0 }),
    );
    // The returned relPath stays inside .herta/logs with no separators in
    // the filename, and the file actually lands there.
    expect(path.startsWith(".herta/logs/")).toBe(true);
    expect(path.slice(".herta/logs/".length)).toMatch(/^[A-Za-z0-9_-]+\.log$/);
    const content = await readFile(join(ws.root, path), "utf-8");
    expect(content).toContain("callId: ../../../../tmp/evil");
    // Two different hostile ids must not collide onto one log file.
    const other = await writeRunLog(
      ws.root,
      "sess-1",
      "../../../../tmp/evil2",
      payload({ ts: "2026-07-13T00:00:00.000Z", stdout: "", stdoutBytes: 0 }),
    );
    expect(other).not.toBe(path);
  });

  it("idempotent on a second call with different ids", async () => {
    ws = await mkTmpWorkspace({});
    await writeRunLog(
      ws.root,
      "s",
      "c1",
      payload({
        ts: "x",
        argv: ["a"],
        durationMs: 1,
        stdout: "",
        stdoutBytes: 0,
      }),
    );
    await writeRunLog(
      ws.root,
      "s",
      "c2",
      payload({
        ts: "y",
        argv: ["b"],
        durationMs: 1,
        stdout: "",
        stdoutBytes: 0,
      }),
    );
    const a = await readFile(join(ws.root, ".herta/logs/s-c1.log"), "utf-8");
    const b = await readFile(join(ws.root, ".herta/logs/s-c2.log"), "utf-8");
    expect(a).toContain('argv: ["a"]');
    expect(b).toContain('argv: ["b"]');
  });
});
