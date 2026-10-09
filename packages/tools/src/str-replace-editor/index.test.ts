import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentEvent,
  BackgroundHost,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
  RulePermissionEngine,
} from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { makeMsysPaths } from "../bash/shell-paths.js";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import {
  headerPath,
  registerStrReplaceEditorRule,
  strReplaceEditorTool,
} from "./index.js";

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});
const noopProgress = () => {};

/** Native-only path spelling (bashPath null): the model spells the workspace
 *  as Node does. On Windows also exercise the MSYS spelling separately. */
function ctxFor(workspaceRoot: string, reads = new ReadLedger()) {
  return {
    sessionId: "s",
    signal: new AbortController().signal,
    workspaceRoot,
    reads,
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    memory: new NoopMemoryManager(),
  };
}
const tool = () =>
  strReplaceEditorTool({ bashPath: null, workspaceShellPath: () => ws.root });
const call = (input: unknown) => ({
  id: "c1",
  tool: "str_replace_editor",
  input,
});
const abs = (rel: string) => join(ws.root, rel);

describe("str_replace_editor tool", () => {
  it("view: cat -n numbering, full and ranged, records the read ledger", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "one\ntwo\nthree\n" });
    const reads = new ReadLedger();
    const r = await tool().run(
      call({ command: "view", path: abs("a.txt") }),
      ctxFor(ws.root, reads),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    expect(r.modelText).toContain("Here's the content of");
    expect(r.modelText).toContain("(which has a total of 4 lines)");
    expect(r.modelText).toContain("     1\tone");
    expect(r.modelText).toContain("     3\tthree");
    expect(r.data).toMatchObject({
      command: "view",
      path: "a.txt",
      from: 1,
      to: 4,
    });
    expect(reads.get(abs("a.txt"))).toBeDefined();

    const ranged = await tool().run(
      call({ command: "view", path: abs("a.txt"), view_range: [2, 3] }),
      ctxFor(ws.root),
      noopProgress,
    );
    expect(ranged.modelText).toContain("with view_range=[2, 3]");
    expect(ranged.modelText).not.toContain("\tone");
    expect(ranged.modelText).toContain("     2\ttwo");
    expect(ranged.modelText).toContain("     3\tthree");

    const bad = await tool().run(
      call({ command: "view", path: abs("a.txt"), view_range: [9, 10] }),
      ctxFor(ws.root),
      noopProgress,
    );
    expect(bad.ok).toBe(false);
    expect(bad.modelText).toContain("Invalid `view_range`");
    expect(bad.modelText).toContain("[1, 4]");
  });

  it("view: a directory lists two levels deep, skipping hidden and node_modules", async () => {
    ws = await mkTmpWorkspace({
      "src/a.ts": "",
      "src/lib/b.ts": "",
      "src/lib/deep/c.ts": "",
      "node_modules/x/index.js": "",
      ".hidden": "",
      "README.md": "",
    });
    const r = await tool().run(
      call({ command: "view", path: ws.root }),
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    expect(r.modelText).toContain("up to 2 levels deep");
    expect(r.modelText).toContain("f\t");
    expect(r.modelText).toContain("/src/a.ts");
    expect(r.modelText).toContain("d\t");
    expect(r.modelText).toContain("/src/lib\n");
    // two levels = children + grandchildren of the root; lib's contents are level 3
    expect(r.modelText).not.toContain("/src/lib/b.ts");
    expect(r.modelText).not.toContain("deep/c.ts");
    // (the header names node_modules as excluded — the ENTRY must be absent)
    expect(r.modelText).not.toContain("/node_modules");
    expect(r.modelText).not.toContain(".hidden");
  });

  it("view: the trained error strings for missing paths and relative paths", async () => {
    ws = await mkTmpWorkspace({});
    const missing = await tool().run(
      call({ command: "view", path: abs("nope.txt") }),
      ctxFor(ws.root),
      noopProgress,
    );
    expect(missing.ok).toBe(false);
    expect(missing.modelText).toBe(
      `The path ${abs("nope.txt")} does not exist. Please provide a valid path.`,
    );
    const rel = await tool().run(
      call({ command: "view", path: "src/x.ts" }),
      ctxFor(ws.root),
      noopProgress,
    );
    expect(rel.ok).toBe(false);
    expect(rel.modelText).toContain("is not an absolute path");
    expect(rel.modelText).toContain(`Maybe you meant ${ws.root}/src/x.ts?`);
  });

  it("create: writes a new file (parents made), refuses to overwrite, reports a diff", async () => {
    ws = await mkTmpWorkspace({ "exists.txt": "x" });
    const r = await tool().run(
      call({
        command: "create",
        path: abs("deep/new.txt"),
        file_text: "hello\nworld\n",
      }),
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    expect(r.modelText).toBe(
      `New file created successfully at: ${abs("deep/new.txt")}`,
    );
    expect(r.data).toMatchObject({
      command: "create",
      relPath: "deep/new.txt",
      wrote: true,
      created: true,
    });
    expect(await readFile(abs("deep/new.txt"), "utf8")).toBe("hello\nworld\n");
    const dup = await tool().run(
      call({ command: "create", path: abs("exists.txt"), file_text: "y" }),
      ctxFor(ws.root),
      noopProgress,
    );
    expect(dup.ok).toBe(false);
    expect(dup.modelText).toContain(
      "Cannot overwrite files using command `create`",
    );
  });

  it("str_replace: unique match edits; missing / ambiguous use the trained strings; no prior view needed", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "foo\nbar\nfoo\nbaz\n" });
    const ambiguous = await tool().run(
      call({
        command: "str_replace",
        path: abs("a.txt"),
        old_str: "foo",
        new_str: "qux",
      }),
      ctxFor(ws.root),
      noopProgress,
    );
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.modelText).toBe(
      `No replacement was performed. Multiple occurrences of old_str \`foo\` in lines [1, 3]. Please ensure it is unique`,
    );
    const missing = await tool().run(
      call({
        command: "str_replace",
        path: abs("a.txt"),
        old_str: "nope",
        new_str: "x",
      }),
      ctxFor(ws.root),
      noopProgress,
    );
    expect(missing.ok).toBe(false);
    expect(missing.modelText).toBe(
      `No replacement was performed, old_str \`nope\` did not appear verbatim in ${abs("a.txt")}.`,
    );
    const ok = await tool().run(
      call({
        command: "str_replace",
        path: abs("a.txt"),
        old_str: "bar\nfoo",
        new_str: "BAR\nFOO",
      }),
      ctxFor(ws.root),
      noopProgress,
    );
    expect(ok.ok).toBe(true);
    expect(ok.modelText).toBe(
      `The file ${abs("a.txt")} has been edited successfully.`,
    );
    expect(ok.data).toMatchObject({
      command: "str_replace",
      relPath: "a.txt",
      wrote: true,
      created: false,
    });
    expect(await readFile(abs("a.txt"), "utf8")).toBe("foo\nBAR\nFOO\nbaz\n");
    expect((ok.data as { diff: string }).diff).toContain("-bar");
    expect((ok.data as { diff: string }).diff).toContain("+BAR");
  });

  it("insert: requires a fresh view (line numbers mean nothing otherwise), then inserts after the line", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "1\n2\n3\n" });
    const reads = new ReadLedger();
    const blind = await tool().run(
      call({
        command: "insert",
        path: abs("a.txt"),
        insert_line: 1,
        new_str: "1.5",
      }),
      ctxFor(ws.root, reads),
      noopProgress,
    );
    expect(blind.ok).toBe(false);
    expect(blind.error?.code).toBe("view_required");
    await tool().run(
      call({ command: "view", path: abs("a.txt") }),
      ctxFor(ws.root, reads),
      noopProgress,
    );
    const r = await tool().run(
      call({
        command: "insert",
        path: abs("a.txt"),
        insert_line: 1,
        new_str: "1.5",
      }),
      ctxFor(ws.root, reads),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    expect(await readFile(abs("a.txt"), "utf8")).toBe("1\n1.5\n2\n3\n");
    // A change under the model's feet (e.g. via bash) makes the view stale.
    await writeFile(abs("a.txt"), "changed\n");
    const stale = await tool().run(
      call({
        command: "insert",
        path: abs("a.txt"),
        insert_line: 0,
        new_str: "x",
      }),
      ctxFor(ws.root, reads),
      noopProgress,
    );
    expect(stale.ok).toBe(false);
    expect(stale.error?.code).toBe("stale_view");
    const range = await tool().run(
      call({
        command: "insert",
        path: abs("a.txt"),
        insert_line: 99,
        new_str: "x",
      }),
      ctxFor(ws.root, new ReadLedger()),
      noopProgress,
    );
    expect(range.error?.code).toBe("view_required");
  });

  it("jail: paths outside the workspace and .git internals are refused with a model-facing message", async () => {
    ws = await mkTmpWorkspace({ ".git/config": "[core]" });
    const outside = await tool().run(
      call({ command: "view", path: join(ws.root, "..", "elsewhere.txt") }),
      ctxFor(ws.root),
      noopProgress,
    );
    expect(outside.ok).toBe(false);
    expect(outside.modelText).toContain("outside the workspace");
    const git = await tool().run(
      call({ command: "view", path: abs(".git/config") }),
      ctxFor(ws.root),
      noopProgress,
    );
    expect(git.ok).toBe(false);
    expect(git.error?.code).toBe("path_denied");
  });

  it("forward-slash native spelling of the workspace resolves too", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "x\n" });
    const r = await tool().run(
      call({ command: "view", path: `${ws.root.replace(/\\/g, "/")}/a.txt` }),
      ctxFor(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
  });

  it("summarize: the record header is `<command> <workspace-relative path>` for any spelling inside the workspace; outside paths stay verbatim", async () => {
    ws = await mkTmpWorkspace({});
    const ctx = { workspaceRoot: ws.root };
    // Native, forward-slash, and (under MSYS) the shell's own spelling.
    const forward = ws.root.replace(/\\/g, "/");
    expect(
      tool().summarize?.(
        { command: "str_replace", path: abs("NOTES.md") },
        ctx,
      ),
    ).toBe("str_replace NOTES.md");
    expect(
      tool().summarize?.(
        { command: "view", path: `${forward}/src/a.ts`, view_range: [3, 9] },
        ctx,
      ),
    ).toBe("view src/a.ts:3-9");
    // MSYS `/tmp/…` — the case the loop's generic form cannot map (a
    // Windows-only spelling: `C:\…` is not a path to POSIX `node:path`).
    if (process.platform === "win32") {
      const msys = makeMsysPaths("C:\\Users\\u\\AppData\\Local\\Temp");
      expect(
        headerPath(
          "/tmp/lab/ws/src/a.ts",
          "C:\\Users\\u\\AppData\\Local\\Temp\\lab\\ws",
          msys,
        ),
      ).toBe("src/a.ts");
      expect(
        headerPath(
          "/tmp/other/x.ts",
          "C:\\Users\\u\\AppData\\Local\\Temp\\lab\\ws",
          msys,
        ),
      ).toBe("/tmp/other/x.ts");
    }
    // A relative path is already the header form; the root itself is ".".
    expect(tool().summarize?.({ command: "create", path: "b.txt" }, ctx)).toBe(
      "create b.txt",
    );
    expect(tool().summarize?.({ command: "view", path: ws.root }, ctx)).toBe(
      "view .",
    );
    // Outside the workspace: shown as written, never disguised as inside.
    const outside = join(ws.root, "..", "elsewhere.txt");
    expect(tool().summarize?.({ command: "view", path: outside }, ctx)).toBe(
      `view ${outside}`,
    );
    // Not a str_replace_editor input → generic fallback.
    expect(tool().summarize?.({ command: "create" }, ctx)).toBeUndefined();
  });

  // 2026-08-24 (codex study). This is the DEFAULT contract's editor, so the
  // whole-file U+FFFD rewrite landed here first. A legacy-encoded source has
  // no NUL, so the binary sniff passed it; every command in this tool writes
  // the whole file back from the decoded string.
  describe("non-UTF-8 files", () => {
    /** `/* 测试注释 *\/` in GBK + an ASCII line. No NUL byte anywhere. */
    const legacyBytes = () =>
      Buffer.concat([
        Buffer.from([
          0x2f, 0x2a, 0x20, 0xb2, 0xe2, 0xca, 0xd4, 0xd7, 0xa2, 0xca, 0xcd,
          0x20, 0x2a, 0x2f, 0x0a,
        ]),
        Buffer.from("int main(void){ return 0; }\n", "ascii"),
      ]);

    it("refuses to edit one, and leaves the bytes untouched", async () => {
      ws = await mkTmpWorkspace({ "legacy.c": "" });
      const original = legacyBytes();
      await writeFile(abs("legacy.c"), original);
      const r = await tool().run(
        call({
          command: "str_replace",
          path: abs("legacy.c"),
          // Touches only the ASCII line; the damage was never local to it.
          old_str: "return 0",
          new_str: "return 1",
        }),
        ctxFor(ws.root),
        noopProgress,
      );
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe("non_utf8_file");
      expect(await readFile(abs("legacy.c"))).toEqual(original);
    });

    it("preserves a UTF-8 BOM, and the ledger hashes what was WRITTEN", async () => {
      // A BOM is valid UTF-8, so this file is accepted and `lossy` is false —
      // and then the decoder eats the three bytes and the whole-file rewrite
      // never restores them. Same property as the refusal above: an editor
      // does not change bytes the edit never addressed.
      ws = await mkTmpWorkspace({ "conf.ps1": "" });
      await writeFile(
        abs("conf.ps1"),
        Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from('$port = 8080\nWrite-Host "端口配置"\n', "utf-8"),
        ]),
      );
      const ctx = ctxFor(ws.root);
      await tool().run(
        call({ command: "view", path: abs("conf.ps1") }),
        ctx,
        noopProgress,
      );
      const r = await tool().run(
        call({
          command: "str_replace",
          path: abs("conf.ps1"),
          old_str: "$port = 8080",
          new_str: "$port = 9090",
        }),
        ctx,
        noopProgress,
      );
      expect(r.ok).toBe(true);
      const after = await readFile(abs("conf.ps1"));
      expect(after.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
      expect(after.toString("utf-8")).toContain("端口配置");
      // The read ledger must hash the BYTES ON DISK, or the next edit fails
      // its own freshness check against our own write.
      const onDisk = createHash("sha256").update(after).digest("hex");
      expect(ctx.reads.get(abs("conf.ps1"))?.sha256).toBe(onDisk);
    });

    it("still VIEWS one, but says the text is lossy", async () => {
      ws = await mkTmpWorkspace({ "legacy.c": "" });
      await writeFile(abs("legacy.c"), legacyBytes());
      const r = await tool().run(
        call({ command: "view", path: abs("legacy.c") }),
        ctxFor(ws.root),
        noopProgress,
      );
      expect(r.ok).toBe(true);
      expect(r.summary).toContain("not valid UTF-8");
    });

    it("leaves ordinary UTF-8 files — including non-ASCII ones — alone", async () => {
      ws = await mkTmpWorkspace({ "u.txt": "α 测试 alpha\n" });
      const r = await tool().run(
        call({
          command: "str_replace",
          path: abs("u.txt"),
          old_str: "alpha",
          new_str: "ALPHA",
        }),
        ctxFor(ws.root),
        noopProgress,
      );
      expect(r.ok).toBe(true);
      expect(await readFile(abs("u.txt"), "utf-8")).toBe("α 测试 ALPHA\n");
    });
  });
});

describe("str_replace_editor rule", () => {
  it("view allows; writes ask with a diff and publish patch.preview; failures deny with model text", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\nbeta\n" });
    const bus = new InMemoryEventBus<AgentEvent>();
    const previews: string[] = [];
    bus.onAny((e) => {
      if (e.type === "patch.preview") previews.push(e.diff);
    });
    const engine = new RulePermissionEngine({
      ask: { present: async () => "allow" },
    });
    registerStrReplaceEditorRule(engine, { bus, bashPath: null });
    const ctx = ctxFor(ws.root);

    const view = await engine.check(
      call({ command: "view", path: abs("a.txt") }),
      ctx,
    );
    expect(view.kind).toBe("allow");

    const edit = await engine.check(
      call({
        command: "str_replace",
        path: abs("a.txt"),
        old_str: "alpha",
        new_str: "ALPHA",
      }),
      ctx,
    );
    expect(edit.kind).toBe("ask");
    if (edit.kind === "ask") {
      expect(edit.request.risk).toBe("workspace_write");
      expect(edit.request.code).toBe("str_replace_editor_ask");
      // An editor keeps what it replaces: no review needed (ADR 0064
      // amendment 2026-10-10).
      expect(edit.request.undoable).toBe(true);
      expect(edit.request.diff).toContain("+ALPHA");
      expect(edit.request.files).toEqual(["a.txt"]);
    }
    expect(previews).toHaveLength(1);

    const create = await engine.check(
      call({ command: "create", path: abs("new.txt"), file_text: "n\n" }),
      ctx,
    );
    expect(create.kind).toBe("ask");
    if (create.kind === "ask") expect(create.request.undoable).toBe(true);
    expect(previews).toHaveLength(2);

    const notFound = await engine.check(
      call({
        command: "str_replace",
        path: abs("a.txt"),
        old_str: "zzz",
        new_str: "y",
      }),
      ctx,
    );
    expect(notFound.kind).toBe("deny");
    if (notFound.kind === "deny") {
      expect(notFound.code).toBe("edit_not_found");
      expect(notFound.modelText).toContain("did not appear verbatim");
      // The corrective half (2026-09-18): the rule-deny names the move that
      // fixes it, and the turn loop's gate forwards it to the model.
      expect(notFound.suggestion).toContain("copy `old_str` verbatim");
    }
    const outside = await engine.check(
      call({
        command: "create",
        path: join(ws.root, "..", "x.txt"),
        file_text: "n",
      }),
      ctx,
    );
    expect(outside.kind).toBe("deny");
  });

  it("a `view` refused for its path is a withheld read; the same path refused for a write is not (ADR 0047 amendment 2026-09-29)", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\n" });
    const engine = new RulePermissionEngine({
      ask: { present: async () => "allow" },
    });
    registerStrReplaceEditorRule(engine, { bashPath: null });
    const ctx = ctxFor(ws.root);
    const outside = join(ws.root, "..", "x.txt");

    const view = await engine.check(
      call({ command: "view", path: outside }),
      ctx,
    );
    expect(view).toMatchObject({
      kind: "deny",
      code: "path_outside_workspace",
      risk: "workspace_read",
    });

    const write = await engine.check(
      call({ command: "create", path: outside, file_text: "n" }),
      ctx,
    );
    expect(write.kind).toBe("deny");
    if (write.kind === "deny") {
      expect(write.code).toBe("path_outside_workspace");
      expect(write.risk).toBeUndefined();
    }
  });
});
