import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  BackgroundHost,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
  RulePermissionEngine,
} from "@herta/core";
import { FakeAskResolver } from "@herta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { makeRunCommandRule } from "./rule.js";

/** The rule behind an engine. The app asks it directly, for a dev server's
 *  argv (ADR 0083 §5); these tests ask it as a tool's rule was asked. */
const registerRunCommandRule = (engine: RulePermissionEngine): void =>
  engine.registerRule("run_command", makeRunCommandRule());

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

async function canCreateFileSymlinks(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), "herta-rule-symlink-probe-"));
  try {
    await writeFile(join(probe, "t.txt"), "x");
    await symlink(join(probe, "t.txt"), join(probe, "l.txt"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

function ctxFor(workspaceRoot: string) {
  return {
    sessionId: "s",
    signal: new AbortController().signal,
    workspaceRoot,
    reads: new ReadLedger(),
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    memory: new NoopMemoryManager(),
  };
}

// 60s: a dozen real git spawns; the 5s default tripped under full-suite
// load (the 2026-07-05 flake class).
describe("run_command permission rule — in-progress consequence (ADR 0049 §5)", {
  timeout: 60_000,
}, () => {
  it("a mid-merge `git commit` ask carries the note; a clean repo's does not", async () => {
    const { spawnSync } = await import("node:child_process");
    const gitAvailable = (() => {
      try {
        return (
          spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0
        );
      } catch {
        return false;
      }
    })();
    if (!gitAvailable) return;
    ws = await mkTmpWorkspace({});
    const git = (...a: string[]) =>
      spawnSync("git", a, { cwd: ws.root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "T");
    git("config", "commit.gpgsign", "false");
    await writeFile(join(ws.root, "a.ts"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "init");

    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const commit = {
      id: "1",
      tool: "run_command",
      input: { argv: ["git", "commit", "-m", "x"] },
    };

    // Clean repo: ordinary vcs ask, no note.
    const calm = await engine.check(commit, ctxFor(ws.root));
    expect(calm.kind).toBe("ask");
    if (calm.kind === "ask") {
      expect(calm.request.consequence).toBeUndefined();
    }

    // Manufacture a conflicted merge, mid-flight.
    git("checkout", "-qb", "side");
    await writeFile(join(ws.root, "a.ts"), "side\n");
    git("add", "-A");
    git("commit", "-qm", "side");
    git("checkout", "-q", "main");
    await writeFile(join(ws.root, "a.ts"), "main\n");
    git("add", "-A");
    git("commit", "-qm", "main");
    expect(git("merge", "side").status).not.toBe(0);

    const mid = await engine.check(commit, ctxFor(ws.root));
    expect(mid.kind).toBe("ask");
    if (mid.kind === "ask") {
      expect(mid.request.consequence).toBe("concludes_in_progress_operation");
      // Note only — the class is unchanged.
      expect(mid.request.code).toBe("command_ask_vcs");
    }
  });
});

describe("run_command permission rule", () => {
  it("allows allow-list commands", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      { id: "1", tool: "run_command", input: { argv: ["echo", "hi"] } },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("allow");
  });

  it("blocks catastrophic commands with command_blocked", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      { id: "1", tool: "run_command", input: { argv: ["rm", "-rf", "/"] } },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("command_blocked");
  });

  it("refuses a write into .herta — the harness's own state — at any tier (2026-09-30)", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    for (const argv of [
      ["cp", "evil.json", ".herta/permissions.json"],
      ["tee", ".herta/permissions.json"],
      ["rm", ".herta/permissions.json"],
      ["mkdir", "-p", "src/../.herta/rules"],
      ["sh", "-c", "echo x > .herta/permissions.json"],
      ["cp", "evil.json", join(ws.root, ".herta", "permissions.json")],
    ]) {
      const decision = await engine.check(
        { id: "1", tool: "run_command", input: { argv } },
        ctxFor(ws.root),
      );
      expect(decision.kind, argv.join(" ")).toBe("deny");
      if (decision.kind !== "deny") throw new Error();
      expect(decision.code).toBe("command_blocked");
    }
    // The honest neighbours still just ask.
    const honest = await engine.check(
      { id: "1", tool: "run_command", input: { argv: ["cp", "a", "b"] } },
      ctxFor(ws.root),
    );
    expect(honest.kind).toBe("ask");
  });

  it("asks for destructive with risk=workspace_destructive", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "run_command",
        input: { argv: ["git", "reset", "--hard"] },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error();
    expect(decision.request.risk).toBe("workspace_destructive");
  });

  it("asks for network with risk=network", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "run_command",
        input: { argv: ["curl", "https://example.com"] },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error();
    expect(decision.request.risk).toBe("network");
  });

  it("asks for unknown with risk=workspace_write", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "run_command",
        input: { argv: ["someUnknownThing"] },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error();
    expect(decision.request.risk).toBe("workspace_write");
  });

  it("denies with invalid_input for empty argv", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      { id: "1", tool: "run_command", input: { argv: [] } },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("invalid_input");
  });

  it("denies with path_denied when cwd is .git", async () => {
    ws = await mkTmpWorkspace({});
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      {
        id: "1",
        tool: "run_command",
        input: { argv: ["echo", "hi"], cwd: ".git" },
      },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("path_denied");
  });

  it("allows a reader over a real in-workspace file (no regression)", async () => {
    ws = await mkTmpWorkspace({ "notes.md": "hi" });
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    // Plain read, a grep with a PATTERN (not a path), and a nonexistent
    // operand all stay allow — the async guard only acts on existing files.
    for (const argv of [
      ["cat", "notes.md"],
      ["grep", "TODO", "notes.md"],
      ["cat", "does-not-exist.md"],
    ]) {
      const decision = await engine.check(
        { id: "1", tool: "run_command", input: { argv } },
        ctxFor(ws.root),
      );
      expect(decision.kind, argv.join(" ")).toBe("allow");
    }
  });

  it("lets a reader reach an attachment and the harness evidence, but not the rest of .herta (ADR 0033 carve-outs, 2026-08-23)", async () => {
    ws = await mkTmpWorkspace({
      ".herta/attachments/sid/spec-ab12cd34.docx.txt": "hi",
      ".herta/logs/run.log": "exit 0",
      ".herta/tool-results/t/c.json": "{}",
      ".herta/memory/project.jsonl": "{}",
    });
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    for (const path of [
      ".herta/attachments/sid/spec-ab12cd34.docx.txt",
      ".herta/logs/run.log",
      ".herta/tool-results/t/c.json",
    ]) {
      const decision = await engine.check(
        { id: "1", tool: "run_command", input: { argv: ["cat", path] } },
        ctxFor(ws.root),
      );
      expect(decision.kind, path).toBe("allow");
    }
    const memory = await engine.check(
      {
        id: "1",
        tool: "run_command",
        input: { argv: ["cat", ".herta/memory/project.jsonl"] },
      },
      ctxFor(ws.root),
    );
    expect(memory.kind).toBe("deny");
    if (memory.kind !== "deny") throw new Error();
    expect(memory.code).toBe("path_denied");
  });

  it("denies a reader whose innocent-named operand is a SYMLINK escaping the workspace (audit T3.4)", async () => {
    if (!(await canCreateFileSymlinks())) return; // Windows w/o Developer Mode
    ws = await mkTmpWorkspace({});
    const outside = `${ws.root}-secret`;
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "id_rsa"), "PRIVATE KEY");
    // An innocent basename that the TEXTUAL guard cannot see through.
    await symlink(join(outside, "id_rsa"), join(ws.root, "notes.txt"));
    try {
      const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
      registerRunCommandRule(engine);
      const decision = await engine.check(
        { id: "1", tool: "run_command", input: { argv: ["cat", "notes.txt"] } },
        ctxFor(ws.root),
      );
      expect(decision.kind).toBe("deny");
      if (decision.kind !== "deny") throw new Error();
      expect(decision.code).toBe("path_outside_workspace");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("denies a reader whose operand symlinks to an IN-workspace credential (audit T3.4)", async () => {
    if (!(await canCreateFileSymlinks())) return;
    ws = await mkTmpWorkspace({ id_rsa: "PRIVATE KEY" });
    // A convenience link inside the repo pointing at the repo's own key file.
    await symlink(join(ws.root, "id_rsa"), join(ws.root, "notes.txt"));
    const engine = new RulePermissionEngine({ ask: new FakeAskResolver() });
    registerRunCommandRule(engine);
    const decision = await engine.check(
      { id: "1", tool: "run_command", input: { argv: ["cat", "notes.txt"] } },
      ctxFor(ws.root),
    );
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error();
    expect(decision.code).toBe("path_denied");
  });
});
