import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ToolCallJournal, ToolCallUndo, ToolContext } from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { editFileTool } from "./edit-file/index.js";
import { runCommand } from "./run-command/runner.js";
import { strReplaceEditorTool } from "./str-replace-editor/index.js";
import { mkTmpWorkspace, type TmpWorkspace } from "./testing/tmp-workspace.js";
import { mkToolContext } from "./testing/tool-context.js";
import { writeNewFileTool } from "./write-new-file/index.js";

/** A journal that remembers what the file held when each write was
 *  recorded — the entry must come BEFORE the write lands. */
class FakeJournal implements ToolCallJournal {
  readonly writes: {
    path: string;
    before: string | null;
    after: string;
    onDiskThen: string | null;
  }[] = [];
  readonly spawns: { pid: number; command: string; role: string }[] = [];
  readonly exits: number[] = [];
  constructor(private readonly refuse = false) {}
  async recordWrite(w: {
    path: string;
    before: string | null;
    after: string;
  }): Promise<void> {
    this.writes.push({
      ...w,
      onDiskThen: existsSync(w.path) ? readFileSync(w.path, "utf8") : null,
    });
    if (this.refuse) throw new Error("ENOSPC: no space left on device");
  }
  recordSpawn(s: { pid: number; command: string; role: string }): void {
    this.spawns.push(s);
  }
  recordExit(pid: number): void {
    this.exits.push(pid);
  }
}

const sha = (s: string | Buffer): string =>
  createHash("sha256").update(s).digest("hex");
const noop = (): void => undefined;

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

function ctxWith(journal: FakeJournal): ToolContext {
  return { ...mkToolContext({ workspaceRoot: ws.root }), journal };
}

describe("every writer records the write in the run's journal first (ADR 0071)", () => {
  it("edit_file: the hash before and the hash after, recorded while the file still holds the old text", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\nbeta\n" });
    const abs = join(ws.root, "a.txt");
    const journal = new FakeJournal();
    const ctx = ctxWith(journal);
    ctx.reads.record(abs, sha("alpha\nbeta\n"));
    const r = await editFileTool().run(
      {
        id: "c1",
        tool: "edit_file",
        input: {
          path: "a.txt",
          hunks: [{ search: "alpha", replace: "ALPHA" }],
        },
      },
      ctx,
      noop,
    );
    expect(r.ok).toBe(true);
    expect(journal.writes).toEqual([
      {
        path: abs,
        before: sha("alpha\nbeta\n"),
        after: sha("ALPHA\nbeta\n"),
        onDiskThen: "alpha\nbeta\n",
      },
    ]);
    expect(sha(readFileSync(abs))).toBe(journal.writes[0]?.after);
  });

  it("edit_file: a write the journal cannot record is not performed", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\n" });
    const abs = join(ws.root, "a.txt");
    const ctx = ctxWith(new FakeJournal(true));
    ctx.reads.record(abs, sha("alpha\n"));
    const r = await editFileTool().run(
      {
        id: "c1",
        tool: "edit_file",
        input: {
          path: "a.txt",
          hunks: [{ search: "alpha", replace: "ALPHA" }],
        },
      },
      ctx,
      noop,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("journal_unavailable");
    expect(readFileSync(abs, "utf8")).toBe("alpha\n");
  });

  it("write_new_file: a new file has no hash before; refused, nothing is created", async () => {
    ws = await mkTmpWorkspace({});
    const journal = new FakeJournal();
    const ok = await writeNewFileTool().run(
      {
        id: "c1",
        tool: "write_new_file",
        input: { path: "n.txt", content: "hi" },
      },
      ctxWith(journal),
      noop,
    );
    expect(ok.ok).toBe(true);
    expect(journal.writes).toEqual([
      {
        path: join(ws.root, "n.txt"),
        before: null,
        after: sha("hi"),
        onDiskThen: null,
      },
    ]);
    const refused = await writeNewFileTool().run(
      {
        id: "c2",
        tool: "write_new_file",
        input: { path: "m.txt", content: "x" },
      },
      ctxWith(new FakeJournal(true)),
      noop,
    );
    expect(refused.error?.code).toBe("journal_unavailable");
    expect(existsSync(join(ws.root, "m.txt"))).toBe(false);
  });

  it("str_replace_editor: create and str_replace are recorded; a refused edit leaves the file and says why", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "foo\nbar\n" });
    const tool = strReplaceEditorTool({
      bashPath: null,
      workspaceShellPath: () => ws.root,
    });
    const journal = new FakeJournal();
    const created = await tool.run(
      {
        id: "c1",
        tool: "str_replace_editor",
        input: {
          command: "create",
          path: join(ws.root, "b.txt"),
          file_text: "new",
        },
      },
      ctxWith(journal),
      noop,
    );
    expect(created.ok).toBe(true);
    const edited = await tool.run(
      {
        id: "c2",
        tool: "str_replace_editor",
        input: {
          command: "str_replace",
          path: join(ws.root, "a.txt"),
          old_str: "bar",
          new_str: "BAR",
        },
      },
      ctxWith(journal),
      noop,
    );
    expect(edited.ok).toBe(true);
    expect(
      journal.writes.map((w) => [w.before, w.after, w.onDiskThen]),
    ).toEqual([
      [null, sha("new"), null],
      [sha("foo\nbar\n"), sha("foo\nBAR\n"), "foo\nbar\n"],
    ]);

    const refused = await tool.run(
      {
        id: "c3",
        tool: "str_replace_editor",
        input: {
          command: "str_replace",
          path: join(ws.root, "a.txt"),
          old_str: "foo",
          new_str: "FOO",
        },
      },
      ctxWith(new FakeJournal(true)),
      noop,
    );
    expect(refused.error?.code).toBe("journal_unavailable");
    expect(refused.modelText).toContain("not performed");
    expect(readFileSync(join(ws.root, "a.txt"), "utf8")).toBe("foo\nBAR\n");
  });
});

/** An undo store that remembers each capture, what the file held then, and
 *  where it fell among the journal's entries (the shared `log`). */
class FakeUndo implements ToolCallUndo {
  readonly captures: {
    path: string;
    before: Buffer | null;
    after: string;
    onDiskThen: Buffer | null;
  }[] = [];
  constructor(
    private readonly log: string[] = [],
    private readonly rejects = false,
  ) {}
  async captureWrite(w: {
    path: string;
    before: Buffer | null;
    after: string;
  }): Promise<void> {
    this.log.push("undo");
    this.captures.push({
      ...w,
      onDiskThen: existsSync(w.path) ? readFileSync(w.path) : null,
    });
    if (this.rejects) throw new Error("the store broke");
  }
}

/** A journal that notes its entries in the shared `log`. */
class LoggingJournal extends FakeJournal {
  constructor(
    private readonly log: string[],
    refuse = false,
  ) {
    super(refuse);
  }
  override async recordWrite(w: {
    path: string;
    before: string | null;
    after: string;
  }): Promise<void> {
    this.log.push("journal");
    return super.recordWrite(w);
  }
}

describe("every writer leaves what it replaces with the undo store (ADR 0074 §1)", () => {
  it("edit_file: the file's exact bytes, BOM and all, after the journal entry and before the write", async () => {
    const original = "﻿alpha\nbeta\n";
    ws = await mkTmpWorkspace({ "a.txt": original });
    const abs = join(ws.root, "a.txt");
    const log: string[] = [];
    const undo = new FakeUndo(log);
    const ctx = { ...ctxWith(new LoggingJournal(log)), undo };
    ctx.reads.record(abs, sha(Buffer.from(original, "utf8")));
    const r = await editFileTool().run(
      {
        id: "c1",
        tool: "edit_file",
        input: {
          path: "a.txt",
          hunks: [{ search: "alpha", replace: "ALPHA" }],
        },
      },
      ctx,
      noop,
    );
    expect(r.ok).toBe(true);
    expect(log).toEqual(["journal", "undo"]);
    expect(undo.captures).toHaveLength(1);
    const c = undo.captures[0];
    expect(c?.path).toBe(abs);
    expect(c?.before?.equals(Buffer.from(original, "utf8"))).toBe(true);
    expect(c?.onDiskThen?.equals(Buffer.from(original, "utf8"))).toBe(true);
    expect(c?.after).toBe(sha(readFileSync(abs)));
  });

  it("write_new_file and str_replace_editor's create hand over nothing before; its edits hand over the bytes they read", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "foo\nbar\n" });
    const undo = new FakeUndo();
    const ctx = { ...ctxWith(new FakeJournal()), undo };
    const fresh = await writeNewFileTool().run(
      {
        id: "c1",
        tool: "write_new_file",
        input: { path: "n.txt", content: "hello\n" },
      },
      ctx,
      noop,
    );
    expect(fresh.ok).toBe(true);
    const tool = strReplaceEditorTool({
      bashPath: null,
      workspaceShellPath: () => ws.root,
    });
    await tool.run(
      {
        id: "c2",
        tool: "str_replace_editor",
        input: {
          command: "create",
          path: join(ws.root, "b.txt"),
          file_text: "new",
        },
      },
      ctx,
      noop,
    );
    await tool.run(
      {
        id: "c3",
        tool: "str_replace_editor",
        input: {
          command: "str_replace",
          path: join(ws.root, "a.txt"),
          old_str: "bar",
          new_str: "BAR",
        },
      },
      ctx,
      noop,
    );
    expect(
      undo.captures.map((c) => [
        relative(ws.root, c.path).replaceAll("\\", "/"),
        c.before?.toString("utf8") ?? null,
        c.after,
      ]),
    ).toEqual([
      ["n.txt", null, sha("hello\n")],
      ["b.txt", null, sha("new")],
      ["a.txt", "foo\nbar\n", sha("foo\nBAR\n")],
    ]);
  });

  it("a write the journal refuses leaves nothing with the undo store", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\n" });
    const abs = join(ws.root, "a.txt");
    const undo = new FakeUndo();
    const ctx = { ...ctxWith(new FakeJournal(true)), undo };
    ctx.reads.record(abs, sha("alpha\n"));
    const r = await editFileTool().run(
      {
        id: "c1",
        tool: "edit_file",
        input: {
          path: "a.txt",
          hunks: [{ search: "alpha", replace: "ALPHA" }],
        },
      },
      ctx,
      noop,
    );
    expect(r.error?.code).toBe("journal_unavailable");
    expect(undo.captures).toEqual([]);
  });

  it("an undo store that fails never stops the write", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\n" });
    const abs = join(ws.root, "a.txt");
    const ctx = {
      ...ctxWith(new FakeJournal()),
      undo: new FakeUndo([], true),
    };
    ctx.reads.record(abs, sha("alpha\n"));
    const r = await editFileTool().run(
      {
        id: "c1",
        tool: "edit_file",
        input: {
          path: "a.txt",
          hunks: [{ search: "alpha", replace: "ALPHA" }],
        },
      },
      ctx,
      noop,
    );
    expect(r.ok).toBe(true);
    expect(readFileSync(abs, "utf8")).toBe("ALPHA\n");
  });

  it("with no journal (the CLI), the undo store still gets the capture", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "alpha\n" });
    const abs = join(ws.root, "a.txt");
    const undo = new FakeUndo();
    const ctx = { ...mkToolContext({ workspaceRoot: ws.root }), undo };
    ctx.reads.record(abs, sha("alpha\n"));
    const r = await editFileTool().run(
      {
        id: "c1",
        tool: "edit_file",
        input: {
          path: "a.txt",
          hunks: [{ search: "alpha", replace: "ALPHA" }],
        },
      },
      ctx,
      noop,
    );
    expect(r.ok).toBe(true);
    expect(undo.captures.map((c) => c.before?.toString("utf8"))).toEqual([
      "alpha\n",
    ]);
  });
});

describe("a started command's pid reaches the journal (ADR 0071 §1.6)", () => {
  it("the runner reports the pid once the process exists", async () => {
    ws = await mkTmpWorkspace({});
    const pids: number[] = [];
    const r = await runCommand([process.execPath, "-e", "0"], {
      cwd: ws.root,
      timeoutMs: 20_000,
      signal: new AbortController().signal,
      maxBytesPerStream: 1024,
      onSpawn: (pid) => pids.push(pid),
    });
    expect(r.exitCode).toBe(0);
    expect(pids).toHaveLength(1);
    expect(pids[0]).toBeGreaterThan(0);
  });
});

/** The tools package's own source files (vitest runs from the repo root or
 *  the package). */
function toolSources(): { file: string; text: string }[] {
  let root: string | undefined;
  for (const base of [".", "packages/tools"]) {
    const p = resolve(process.cwd(), base, "src");
    if (existsSync(join(p, "journal-write.ts"))) root = p;
  }
  if (root === undefined) throw new Error("tools/src not found from cwd");
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        out.push({
          file: relative(root as string, p).replaceAll("\\", "/"),
          text: readFileSync(p, "utf8"),
        });
      }
    }
  };
  walk(root);
  return out;
}

describe("no tool replaces a file unrecorded", () => {
  it("every file that calls writeFileAtomic also records the write", () => {
    const unrecorded = toolSources()
      .filter((s) => /\bwriteFileAtomic(Sync)?\(/.test(s.text))
      .filter(
        (s) =>
          !/\bjournalWrite</.test(s.text) && !/\bjournalWrite\(/.test(s.text),
      )
      .map((s) => s.file);
    expect(unrecorded).toEqual([]);
  });

  it("only the harness's own files are written by plain writeFile", () => {
    // A command's log, a document's digest, a test fixture: none of them is
    // the user's workspace. A new plain write anywhere else is a write the
    // journal cannot decide after a crash.
    const plain = toolSources()
      .filter((s) => /\bwriteFile(Sync)?\(/.test(s.text))
      .map((s) => s.file)
      .sort();
    expect(plain).toEqual([
      "digest-document/index.ts",
      "run-command/logger.ts",
      "testing/tmp-workspace.ts",
    ]);
  });
});
