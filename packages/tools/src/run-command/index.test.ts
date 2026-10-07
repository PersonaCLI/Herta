import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentEvent,
  BackgroundHost,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
} from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { runCommandTool } from "./index.js";

const POSIX = process.platform !== "win32";
let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

const noopProgress = () => {};

function ctxFor(workspaceRoot: string) {
  return {
    sessionId: "test-session",
    signal: new AbortController().signal,
    workspaceRoot,
    reads: new ReadLedger(),
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    memory: new NoopMemoryManager(),
  };
}

describe("runCommandTool — the live view (ADR 0073)", () => {
  it("streams stdout and stderr as whole lines, each stream on its own, redacted; the result is unchanged", async () => {
    ws = await mkTmpWorkspace({});
    const tool = runCommandTool();
    const chunks: string[] = [];
    const script = [
      "process.stdout.write('out 1\\nout ');",
      "setTimeout(() => {",
      "  process.stderr.write('err 1\\n');",
      "  process.stdout.write('2\\nSECRET_TOKEN=abc123\\n');",
      "}, 150);",
    ].join("");
    const r = await tool.run(
      {
        id: "call-live",
        tool: "run_command",
        input: { argv: [process.execPath, "-e", script] },
      },
      ctxFor(ws.root),
      noopProgress,
      (chunk) => chunks.push(chunk),
    );
    expect(r.ok).toBe(true);
    const seen = chunks.join("");
    // A stdout line split by the timer never splices with the stderr line.
    expect(seen).toContain("out 1\n");
    expect(seen).toContain("out 2\n");
    expect(seen).toContain("err 1\n");
    expect(seen).toContain("SECRET_TOKEN=[REDACTED:env_secret]\n");
    expect(seen).not.toContain("abc123");
    const data = r.data as { stdout: string; stderr: string };
    expect(data.stdout).toContain("out 1\nout 2\n");
    expect(data.stderr).toBe("err 1\n");
  });
});

describe.skipIf(!POSIX)("runCommandTool", () => {
  it("says whether the command was of a class that changes nothing — what undo leaves out of its note (ADR 0074 §2)", async () => {
    ws = await mkTmpWorkspace({});
    const tool = runCommandTool();
    const run = async (argv: string[]) => {
      const r = await tool.run(
        { id: "c", tool: "run_command", input: { argv } },
        ctxFor(ws.root),
        noopProgress,
      );
      return (r.data as { readOnly?: boolean } | undefined)?.readOnly;
    };
    expect(await run(["node", "-v"])).toBe(true);
    expect(await run(["mkdir", "made-here"])).toBe(false);
  });

  it("happy path: runs echo, returns stdout, writes log file", async () => {
    ws = await mkTmpWorkspace({});
    const tool = runCommandTool();
    const r = await tool.run(
      {
        id: "call-1",
        tool: "run_command",
        input: { argv: ["echo", "hi"] },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const data = r.data as {
      argv: string[];
      cwd: string;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      logPath: string;
      timedOut: boolean;
    };
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toBe("hi\n");
    expect(data.timedOut).toBe(false);
    expect(data.logPath).toBe(".herta/logs/test-session-call-1.log");
    const log = await readFile(join(ws.root, data.logPath), "utf-8");
    expect(log).toContain("=== herta run_command log ===");
    expect(log).toContain("hi\n");
  });

  it("execution backstop: denies a reader whose operand symlinks out of the workspace (audit T3.4)", async () => {
    ws = await mkTmpWorkspace({});
    const outside = `${ws.root}-exec-secret`;
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "id_rsa"), "PRIVATE KEY");
    await symlink(join(outside, "id_rsa"), join(ws.root, "notes.txt"));
    try {
      const tool = runCommandTool();
      const r = await tool.run(
        { id: "c", tool: "run_command", input: { argv: ["cat", "notes.txt"] } },
        ctxFor(ws.root),
        noopProgress,
      );
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error();
      expect(r.error?.code).toBe("path_outside_workspace");
      // The disguised credential's contents never reached the result.
      expect(JSON.stringify(r)).not.toContain("PRIVATE KEY");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("non-zero exit returns ok=true with the exit code", async () => {
    ws = await mkTmpWorkspace({});
    const tool = runCommandTool();
    const r = await tool.run(
      {
        id: "call-2",
        tool: "run_command",
        input: { argv: ["false"] },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const data = r.data as { exitCode: number };
    expect(data.exitCode).toBe(1);
  });

  it("times out", async () => {
    ws = await mkTmpWorkspace({});
    const tool = runCommandTool();
    const r = await tool.run(
      {
        id: "call-3",
        tool: "run_command",
        input: { argv: ["sleep", "5"], timeoutMs: 100 },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("timeout");
  });

  it("returns not_found for missing binary", async () => {
    ws = await mkTmpWorkspace({});
    const tool = runCommandTool();
    const r = await tool.run(
      {
        id: "call-4",
        tool: "run_command",
        input: { argv: ["this-binary-does-not-exist-9f7a4c2e"] },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("not_found");
  });

  it("returns path_denied for cwd in .git", async () => {
    ws = await mkTmpWorkspace({});
    const tool = runCommandTool();
    const r = await tool.run(
      {
        id: "call-5",
        tool: "run_command",
        input: { argv: ["echo", "hi"], cwd: ".git" },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("path_denied");
  });

  it("redacts secrets in stdout and log", async () => {
    ws = await mkTmpWorkspace({});
    const tool = runCommandTool();
    const r = await tool.run(
      {
        id: "call-6",
        tool: "run_command",
        input: { argv: ["sh", "-c", "echo AKIAIOSFODNN7EXAMPLE"] },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const data = r.data as { stdout: string; logPath: string };
    expect(data.stdout).toContain("[REDACTED:aws_access_key]");
    expect(data.stdout).not.toContain("AKIAIOSFODNN7EXAMPLE");
    const log = await readFile(join(ws.root, data.logPath), "utf-8");
    expect(log).toContain("[REDACTED:aws_access_key]");
    expect(log).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("truncates stdout when over 32KB and flags truncation", async () => {
    ws = await mkTmpWorkspace({});
    const tool = runCommandTool();
    const r = await tool.run(
      {
        id: "call-7",
        tool: "run_command",
        input: {
          argv: ["sh", "-c", "yes hello | head -c 50000"],
        },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const data = r.data as {
      stdout: string;
      stdoutTruncated: boolean;
      stdoutBytes: number;
    };
    expect(data.stdoutTruncated).toBe(true);
    expect(data.stdoutBytes).toBeGreaterThanOrEqual(50_000);
    expect(data.stdout).toContain("bytes elided");
  });

  it("rejects empty argv with invalid_input", async () => {
    ws = await mkTmpWorkspace({});
    const tool = runCommandTool();
    const r = await tool.run(
      { id: "call-8", tool: "run_command", input: { argv: [] } },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("invalid_input");
  });

  it("leaves data.testRun undefined for non-test commands", async () => {
    ws = await mkTmpWorkspace({});
    const tool = runCommandTool();
    const r = await tool.run(
      {
        id: "call-non-test",
        tool: "run_command",
        input: { argv: ["echo", "hi"] },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const data = r.data as { testRun?: { status: string; command: string } };
    expect(data.testRun).toBeUndefined();
  });

  it("populates data.testRun for test commands (failed when exit != 0)", async () => {
    // Empty workspace has no package.json → `pnpm test` exits non-zero.
    // Verifies the detector fires AND the failed-status path is correct.
    ws = await mkTmpWorkspace({});
    const tool = runCommandTool();
    const r = await tool.run(
      {
        id: "call-test",
        tool: "run_command",
        input: { argv: ["pnpm", "test"] },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    const data = r.data as {
      exitCode: number | null;
      testRun?: { status: string; command: string; summary: string };
    };
    expect(data.testRun).toBeDefined();
    expect(data.testRun?.command).toBe("pnpm test");
    expect(data.testRun?.status).toBe("failed");
    // Sanity: exit code should match the detector's failed verdict.
    expect(data.exitCode).not.toBe(0);
  });
});

// Cross-platform (node is always available — it's running this test).
describe("runCommandTool — timeout output capture", () => {
  it("attaches redacted partial output and writes the run log on timeout", async () => {
    // Regression: the timeout branch used to discard everything the
    // runner had buffered and skip the .herta/logs entry — exactly the
    // diagnostics a hung command leaves behind. timeoutMs is generous
    // because a node child can take >1s to cold-start under full-suite
    // load — a kill before the -e script runs captures nothing.
    ws = await mkTmpWorkspace({});
    const tool = runCommandTool();
    const r = await tool.run(
      {
        id: "call-timeout-partial",
        tool: "run_command",
        input: {
          argv: [
            process.execPath,
            "-e",
            'process.stdout.write("partial-marker\\n"); setInterval(() => {}, 1000)',
          ],
          timeoutMs: 4_000,
        },
      },
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("timeout");
    const data = r.data as
      | { stdout: string; logPath: string; timedOut: boolean }
      | undefined;
    expect(data).toBeDefined();
    if (data === undefined) throw new Error();
    expect(data.timedOut).toBe(true);
    expect(data.stdout).toContain("partial-marker");
    const log = await readFile(join(ws.root, data.logPath), "utf-8");
    expect(log).toContain("partial-marker");
  }, 20_000);
});

describe("runCommandTool runsTests (ADR 0073 amendment 2026-10-08)", () => {
  it("reads the argv its result's test row is detected on", () => {
    const tool = runCommandTool();
    expect(tool.runsTests?.({ argv: ["npm", "test"] })).toBe(true);
    expect(tool.runsTests?.({ argv: ["python", "-m", "pytest", "-q"] })).toBe(
      true,
    );
    expect(tool.runsTests?.({ argv: ["ls", "-la"] })).toBe(false);
    expect(tool.runsTests?.({ argv: "npm test" })).toBe(false);
    expect(tool.runsTests?.({ argv: ["npm", 1] })).toBe(false);
    expect(tool.runsTests?.({})).toBe(false);
  });
});
