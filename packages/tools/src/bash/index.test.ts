import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type AgentEvent,
  BackgroundHost,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
  RulePermissionEngine,
  type RunCommandData,
} from "@herta/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { findBash } from "./find-bash.js";

// Real bash processes: comfortably over the 5 s default when the suite runs
// alongside the runner/spawn tests.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

import { bashTool, registerBashRule, SHELL_BG_ID } from "./index.js";
import { PersistentShell } from "./persistent-shell.js";
import { bashJsonSchema, bashZodJsonSchema } from "./schema.js";

const BASH = findBash();
const d = describe.skipIf(BASH === null);

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});
const noopProgress = () => {};
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
const call = (command: string, id = "c1") => ({
  id,
  tool: "bash",
  input: { command },
});

describe("bash schema", () => {
  it("the hand-written wire schema and the zod schema agree on shape", () => {
    expect(bashJsonSchema.required).toEqual(["command"]);
    expect(Object.keys(bashJsonSchema.properties)).toEqual(["command"]);
    const zod = bashZodJsonSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(zod.properties ?? {})).toEqual(["command"]);
    expect(zod.required).toEqual(["command"]);
  });
});

d("bash tool (real bash)", () => {
  it("runs a command: model sees plain output, harness gets RunCommandData, log persisted, shell registered internal", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "hello\n" });
    const ctx = ctxFor(ws.root);
    const tool = bashTool({ bashPath: BASH as string });
    const r = await tool.run(call("cat a.txt; echo done"), ctx, noopProgress);
    expect(r.ok).toBe(true);
    expect(r.modelText).toBe("hello\ndone\n");
    const data = r.data as RunCommandData;
    expect(data.exitCode).toBe(0);
    expect(data.stdout).toBe("hello\ndone\n");
    expect(data.argv).toEqual(["cat a.txt; echo done"]);
    expect(existsSync(join(ws.root, data.logPath))).toBe(true);
    expect(r.summary).toMatch(/^ran `cat a\.txt; echo done` \(exit 0/);
    // The shell is an internal background entry: reaped by stopAll, invisible to the model.
    expect(ctx.bg.getInternal(SHELL_BG_ID)).toBeInstanceOf(PersistentShell);
    expect(ctx.bg.list()).toHaveLength(0);
    expect(await ctx.bg.stopAll()).toBe(0);
    expect(
      (ctx.bg.getInternal(SHELL_BG_ID) as PersistentShell).isRunning(),
    ).toBe(false);
  });

  it("streams the command's output to the live view — whole lines, redacted, no protocol lines — on the first call of a fresh shell and after (ADR 0073)", async () => {
    ws = await mkTmpWorkspace({});
    const ctx = ctxFor(ws.root);
    const tool = bashTool({ bashPath: BASH as string });
    const chunks: string[] = [];
    const r = await tool.run(
      call(
        "echo one; sleep 0.2; echo two; echo API_TOKEN=sk-abcdefghijklmnopqrst; printf 'tail-no-newline'",
      ),
      ctx,
      noopProgress,
      (chunk) => chunks.push(chunk),
    );
    expect(r.ok).toBe(true);
    const seen = chunks.join("");
    // (The wrapper's marker opens on a newline of its own, which ends an
    // unterminated last line — a display tail does not mind.)
    expect(seen).toBe(
      "one\ntwo\nAPI_TOKEN=[REDACTED:env_secret]\ntail-no-newline\n",
    );
    // Nothing of the shell's own protocol reaches the view.
    expect(seen).not.toContain("__HERTA_");
    // Streamed, not handed over at the end: the lines before the sleep came
    // in a chunk of their own.
    expect(chunks.length).toBeGreaterThan(1);
    // A second call on the same shell streams too, and only its own output.
    const second: string[] = [];
    await tool.run(call("echo three", "c2"), ctx, noopProgress, (c) =>
      second.push(c),
    );
    expect(second.join("")).toBe("three\n");
    await ctx.bg.stopAll();
  });

  it("says whether the command was of a class that changes nothing — what undo leaves out of its note (ADR 0074 §2)", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "x\n" });
    const ctx = ctxFor(ws.root);
    const tool = bashTool({ bashPath: BASH as string });
    const readOnly = async (command: string, id: string) =>
      (
        (await tool.run(call(command, id), ctx, noopProgress)).data as
          | RunCommandData
          | undefined
      )?.readOnly;
    expect(await readOnly("cat a.txt", "c1")).toBe(true);
    expect(await readOnly("git status", "c2")).toBe(true);
    expect(await readOnly("mkdir made-here", "c3")).toBe(false);
    await ctx.bg.stopAll();
  });

  it("a redirected write is captured for undo, named in the result, and a command that is nothing else says so (ADR 0074 amendment, 2026-10-08)", async () => {
    // 板砖 on this contract writes files with `cat > f <<'EOF'` and
    // `printf … > f`, never through an editor: undo saw none of it, so the
    // 撤销 chip never came.
    ws = await mkTmpWorkspace({ "notes.md": "one\n" });
    const captured: { path: string; before: Buffer | null; after: string }[] =
      [];
    const ctx = {
      ...ctxFor(ws.root),
      undo: {
        captureWrite: async (w: {
          path: string;
          before: Buffer | null;
          after: string;
        }) => {
          captured.push(w);
        },
      },
    };
    const tool = bashTool({ bashPath: BASH as string });
    const run = async (command: string, id: string) =>
      (await tool.run(call(command, id), ctx, noopProgress))
        .data as RunCommandData;
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");

    const over = await run("cat > notes.md <<'EOF'\nONE\nEOF", "c1");
    expect(over.redirectWrites).toEqual([
      { relPath: "notes.md", created: false, added: 1, removed: 1 },
    ]);
    expect(over.writesAccounted).toBe(true);
    expect(captured).toEqual([
      {
        path: realpathSync(join(ws.root, "notes.md")),
        before: Buffer.from("one\n"),
        after: sha("ONE\n"),
      },
    ]);

    const made = await run(
      "mkdir -p src && cat > src/new.mjs <<'EOF'\nexport const n = 1;\nEOF",
      "c2",
    );
    expect(made.redirectWrites).toEqual([
      { relPath: "src/new.mjs", created: true, added: 1, removed: 0 },
    ]);
    expect(made.writesAccounted).toBe(true);
    expect(captured[1]?.before).toBeNull();
    expect(readFileSync(join(ws.root, "src", "new.mjs"), "utf8")).toBe(
      "export const n = 1;\n",
    );

    // Something else that writes rides along: the write is still captured,
    // but the command is not only that.
    const mixed = await run("cat > a.txt <<'EOF'\nx\nEOF\ntouch b.txt", "c3");
    expect(mixed.redirectWrites?.map((w) => w.relPath)).toEqual(["a.txt"]);
    expect(mixed.writesAccounted).toBe(false);

    // A write that never happened is no write.
    const none = await run("false && cat > c.txt <<'EOF'\nx\nEOF", "c4");
    expect(none.redirectWrites).toBeUndefined();
    expect(captured).toHaveLength(3);

    // The live check's line (2026-10-08): no heredoc at all.
    const printed = await run("printf 'alpha\\nbeta\\n' > notes.md", "c5");
    expect(printed.redirectWrites).toEqual([
      { relPath: "notes.md", created: false, added: 2, removed: 1 },
    ]);
    expect(printed.writesAccounted).toBe(true);
    expect(captured[3]?.before?.toString()).toBe("ONE\n");
    expect(readFileSync(join(ws.root, "notes.md"), "utf8")).toBe(
      "alpha\nbeta\n",
    );
    await ctx.bg.stopAll();
  });

  it("non-zero exit is appended the trained way; state persists across calls in one brief", async () => {
    ws = await mkTmpWorkspace({});
    const ctx = ctxFor(ws.root);
    const tool = bashTool({ bashPath: BASH as string });
    await tool.run(
      call("export MARK=42; mkdir sub; cd sub", "c1"),
      ctx,
      noopProgress,
    );
    const r = await tool.run(
      call("echo $MARK; ls nope 2>&1; false", "c2"),
      ctx,
      noopProgress,
    );
    expect(r.ok).toBe(true);
    expect(r.modelText).toMatch(/^42\n/);
    expect(r.modelText).toMatch(/\[exit code: 1\]$/);
    expect((r.data as RunCommandData).exitCode).toBe(1);
    await ctx.bg.stopAll();
  });

  it("test evidence: a `node --test` segment yields a testRun the report can cite", async () => {
    ws = await mkTmpWorkspace({
      "t.test.mjs": "import test from 'node:test'; test('ok', () => {});\n",
    });
    const ctx = ctxFor(ws.root);
    const tool = bashTool({ bashPath: BASH as string });
    const r = await tool.run(call("node --test t.test.mjs"), ctx, noopProgress);
    expect(r.ok).toBe(true);
    const data = r.data as RunCommandData;
    expect(data.testRun?.status).toBe("passed");
    expect(data.testRun?.command).toBe("node --test t.test.mjs");
    await ctx.bg.stopAll();
  });

  it("the rule: allow-listed reads pass, writes/unknowns ask, catastrophes deny; the effective cwd follows the shell", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "x\n", "sub/b.txt": "y\n" });
    const ctx = ctxFor(ws.root);
    const engine = new RulePermissionEngine({
      ask: { present: async () => "allow" },
    });
    registerBashRule(engine, { bashPath: BASH });
    expect((await engine.check(call("cat a.txt"), ctx)).kind).toBe("allow");
    expect((await engine.check(call("echo x > a.txt"), ctx)).kind).toBe("ask");
    // The ask carries the effective argv (approval cache scope + ADR 0030
    // rules) when the line runs ONE program — even behind the model's
    // `cd <workspace> &&` prefix — and nothing otherwise.
    const wsShell = new PersistentShell({
      bashPath: BASH as string,
      workspaceRoot: ws.root,
    }).workspaceShellPath;
    const single = await engine.check(
      call(`cd ${wsShell} && git commit -m x`),
      ctx,
    );
    expect(single.kind).toBe("ask");
    if (single.kind === "ask") {
      expect(single.request.argv).toEqual(["git", "commit", "-m", "x"]);
    }
    const multi = await engine.check(
      call("git add -A && git commit -m x"),
      ctx,
    );
    expect(multi.kind).toBe("ask");
    if (multi.kind === "ask") {
      // No single argv (rules can't pin a chained line) …
      expect(multi.request.argv).toBeUndefined();
      // … but the task cache can still scope it by its one program.
      expect(multi.request.programs).toEqual(["git"]);
    }
    // An interpreter line still carries argv (ADR 0030 rules accept the
    // script-pinned shape); the CACHE excludes it separately.
    const interp = await engine.check(call("node scripts/x.mjs"), ctx);
    expect(interp.kind).toBe("ask");
    if (interp.kind === "ask") {
      expect(interp.request.argv).toEqual(["node", "scripts/x.mjs"]);
      expect(interp.request.code).toBe("command_ask_interpreter");
    }
    // A chained line carries every ask class it triggered, top first
    // (2026-08-17): the card labels by the first and names the rest.
    // (A loopback curl is a local smoke test and allows since ADR 0064 L1,
    // so the network half of this line has to reach a real host.)
    const chained = await engine.check(
      call("kill 574; sleep 0.5; curl -s https://example.com/health"),
      ctx,
    );
    expect(chained.kind).toBe("ask");
    if (chained.kind === "ask") {
      expect(chained.request.code).toBe("command_ask_network");
      expect(chained.request.codes).toEqual([
        "command_ask_network",
        "command_ask_process",
      ]);
    }
    const blocked = await engine.check(call("rm -rf /"), ctx);
    expect(blocked.kind).toBe("deny");
    // After the shell has cd'd into sub/, a relative read resolves there.
    const tool = bashTool({ bashPath: BASH as string });
    await tool.run(call("cd sub", "c9"), ctx, noopProgress);
    expect((await engine.check(call("cat b.txt"), ctx)).kind).toBe("allow");
    // …and a `..` read from there is still a workspace read (allowed by
    // realpath), while escaping the workspace asks.
    expect((await engine.check(call("cat ../a.txt"), ctx)).kind).toBe("ask");
    await ctx.bg.stopAll();
  });

  it("the rule and the tool let a read-only command reach an ATTACHMENT (ADR 0033) and the harness evidence, and nothing else under .herta (large-document lab 2026-08-23)", async () => {
    ws = await mkTmpWorkspace({
      ".herta/attachments/sid/report-ab12cd34.pdf.txt":
        "第1篇 · 甲\n正文甲\n第2篇 · 乙\n正文乙\n",
      ".herta/logs/run-1.log": "exit 0\n",
      ".herta/tool-results/t/c.json": "{}\n",
      ".herta/keys/deepseek": "sk-secret",
      ".herta/attachments/sid/id_rsa": "PRIVATE KEY",
    });
    const ctx = ctxFor(ws.root);
    const engine = new RulePermissionEngine({
      ask: { present: async () => "allow" },
    });
    registerBashRule(engine, { bashPath: BASH });
    const doc = ".herta/attachments/sid/report-ab12cd34.pdf.txt";
    // The whole reader toolkit a long document needs, allow-tier, no ask:
    for (const cmd of [
      `cat ${doc}`,
      `sed -n '1,2p' ${doc}`,
      `grep -n '^第[0-9]*篇' ${doc}`,
      `wc -l ${doc}`,
      `head -n 2 ${doc}`,
      "cat .herta/logs/run-1.log",
      "cat .herta/tool-results/t/c.json",
    ]) {
      expect((await engine.check(call(cmd), ctx)).kind, cmd).toBe("allow");
    }
    // …and the tool actually runs it (the execution-time backstop agrees).
    const tool = bashTool({ bashPath: BASH as string });
    const res = await tool.run(
      call(`grep -n '^第' ${doc}`, "c2"),
      ctx,
      noopProgress,
    );
    expect(res.ok).toBe(true);
    expect(res.modelText).toContain("1:第1篇 · 甲");
    expect(res.modelText).toContain("3:第2篇 · 乙");
    // The carve-out skips ONLY the structural `.herta` denial. The harness's
    // own key dir is not a carve-out, so it stays a hard deny; a
    // credential-shaped name planted inside the attachment dir is caught by
    // the textual guard first (ask — the user sees the real target), and the
    // realpath guard behind it would deny by basename regardless.
    const keys = await engine.check(call("cat .herta/keys/deepseek"), ctx);
    expect(keys.kind).toBe("deny");
    const planted = await engine.check(
      call("cat .herta/attachments/sid/id_rsa"),
      ctx,
    );
    expect(planted.kind).not.toBe("allow");
    await ctx.bg.stopAll();
  });

  it("the execution-time reader backstop peels the command head like the rule does — `time cat` through an escaping link is refused, not run", async () => {
    // The rule's allow and the tool's run are two moments; the second look
    // exists for a link that appears between them. It kept the un-peeled
    // spelling the rule gave up on 2026-08-24, so `time`, `command`, `!` in
    // front of a reader switched it off. The tool is called DIRECTLY here —
    // that is the window (the rule has already said yes).
    ws = await mkTmpWorkspace({ "a.txt": "inside\n" });
    const outside = `${ws.root}-sneak`;
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET\n");
    const ctx = ctxFor(ws.root);
    try {
      try {
        // "junction" needs no admin on Windows; ignored on POSIX.
        symlinkSync(outside, join(ws.root, "escape"), "junction");
      } catch {
        return; // environment cannot create directory links; skip
      }
      const tool = bashTool({ bashPath: BASH as string });
      // Anti-vacuous: the fixture really is an escape the bare guard sees.
      const bare = await tool.run(
        call("cat escape/secret.txt", "c1"),
        ctx,
        noopProgress,
      );
      expect(bare.ok).toBe(false);
      for (const [i, cmd] of [
        "time cat escape/secret.txt",
        "command cat escape/secret.txt",
        "! cat escape/secret.txt",
      ].entries()) {
        const r = await tool.run(call(cmd, `p${i}`), ctx, noopProgress);
        expect(r.ok, cmd).toBe(false);
        expect(r.error?.code, cmd).toBe("path_outside_workspace");
        expect(r.modelText ?? "", cmd).not.toContain("OUTSIDE-SECRET");
      }
    } finally {
      await ctx.bg.stopAll();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("the rule previews a heredoc file write like a file write: diff + files on the ask, code command_ask_write, patch.preview on the bus", async () => {
    ws = await mkTmpWorkspace({ "notes.md": "one\n" });
    const ctx = ctxFor(ws.root);
    const previews: Array<{ diff: string; files: readonly string[] }> = [];
    ctx.bus.on("patch.preview", (e) => {
      previews.push(e);
    });
    const engine = new RulePermissionEngine({
      ask: { present: async () => "allow" },
    });
    registerBashRule(engine, { bashPath: BASH, bus: ctx.bus });
    const cmd = [
      "mkdir -p src && cat > src/server.mjs <<'EOF'",
      "import http from 'node:http';",
      "console.log('mini-status');",
      "EOF",
    ].join("\n");
    const d = await engine.check(call(cmd), ctx);
    expect(d.kind).toBe("ask");
    if (d.kind === "ask") {
      // Was 「未识别的命令」 (mkdir won the tie) with the whole file inline as
      // the command; now the write it is, with the content as a diff.
      expect(d.request.code).toBe("command_ask_write");
      expect(d.request.files).toEqual(["src/server.mjs"]);
      expect(d.request.diff).toContain("+++ b/src/server.mjs");
      expect(d.request.diff).toContain("+console.log('mini-status');");
      expect(d.request.reason).toContain("creates src/server.mjs (2 lines)");
    }
    expect(previews).toHaveLength(1);
    expect(previews[0]?.files).toEqual(["src/server.mjs"]);
    // An append against the existing file diffs against it; a redirect
    // WITHOUT a heredoc keeps the plain redirect ask (no preview claimed).
    const app = await engine.check(
      call("cat >> notes.md <<'EOF'\ntwo\nEOF"),
      ctx,
    );
    if (app.kind === "ask") {
      expect(app.request.diff).toContain(" one");
      expect(app.request.diff).toContain("+two");
    }
    const plain = await engine.check(call("echo hi > notes.md"), ctx);
    expect(plain.kind).toBe("ask");
    if (plain.kind === "ask") {
      expect(plain.request.diff).toBeUndefined();
      expect(plain.request.code).toBe("command_ask_write");
    }
    await ctx.bg.stopAll();
  });

  it("summarize: the record header drops the model's `cd <workspace> &&` in the SHELL's own spelling (MSYS `/tmp/…` under %TEMP%), which the loop cannot derive", async () => {
    ws = await mkTmpWorkspace({});
    const tool = bashTool({ bashPath: BASH as string });
    const wsShell = new PersistentShell({
      bashPath: BASH as string,
      workspaceRoot: ws.root,
    }).workspaceShellPath;
    const ctx = { workspaceRoot: ws.root };
    expect(
      tool.summarize?.(
        { command: `cd ${wsShell} && git add -A && git commit -m x` },
        ctx,
      ),
    ).toBe("git add -A && git commit -m x");
    // Paths inside the workspace, shell-spelled, relativize too.
    expect(
      tool.summarize?.({ command: `sed -n 1,5p ${wsShell}/a.txt` }, ctx),
    ).toBe("sed -n 1,5p ./a.txt");
    // A cd into a subdirectory is information and stays.
    expect(
      tool.summarize?.({ command: `cd ${wsShell} && cd sub && ls` }, ctx),
    ).toBe("cd sub && ls");
    // Not a command → the loop's generic form takes over.
    expect(tool.summarize?.({ nope: 1 }, ctx)).toBeUndefined();
  });

  it("refuses an empty command with a model-facing message and no shell spawn", async () => {
    ws = await mkTmpWorkspace({});
    const ctx = ctxFor(ws.root);
    const tool = bashTool({ bashPath: BASH as string });
    const r = await tool.run(
      { id: "c1", tool: "bash", input: { command: "" } },
      ctx,
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.modelText).toContain("Parameter `command` is required");
    expect(ctx.bg.getInternal(SHELL_BG_ID)).toBeUndefined();
  });
});

describe("bash runsTests (ADR 0073 amendment 2026-10-08)", () => {
  // No shell: the hook reads the input, never runs it.
  const tool = bashTool({ bashPath: "bash" });

  it("recognises a test run anywhere in the line — past the 80-char record header too", () => {
    // The live lab's line: the test run sat beyond the header's cap, so the
    // trace card read it as 修改 until its test row landed.
    const long =
      "mkdir -p /tmp/negcheck && cp test_hello.py /tmp/negcheck/ && cd /tmp/negcheck && sed -i 's/hello/bye/' hello.py && python -m unittest test_hello";
    expect(long.length).toBeGreaterThan(80);
    expect(tool.runsTests?.({ command: long })).toBe(true);
    expect(tool.runsTests?.({ command: "cd sub && npm test" })).toBe(true);
  });

  it("says no to what the result's test row would not name", () => {
    expect(tool.runsTests?.({ command: "ls -la && cat a.txt" })).toBe(false);
    // Structural only: a script named like a test is just a script.
    expect(tool.runsTests?.({ command: "node test-server.mjs" })).toBe(false);
    expect(tool.runsTests?.({ nope: 1 })).toBe(false);
    expect(tool.runsTests?.(null)).toBe(false);
  });
});
