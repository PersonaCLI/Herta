import { createHash } from "node:crypto";
import { appendFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolCallUndo } from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import {
  readRedirectTargets,
  settleRedirectTargets,
  writesAccounted,
} from "./redirect-writes.js";
import { makeMsysPaths, type ShellPaths } from "./shell-paths.js";

const PATHS: ShellPaths = makeMsysPaths(null);

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});
const opts = (root: string) => ({
  workspaceRoot: root,
  paths: PATHS,
  cwd: root,
});

/** An undo store that keeps what it was handed. */
function recordingUndo(): ToolCallUndo & {
  readonly calls: { path: string; before: Buffer | null; after: string }[];
} {
  const calls: { path: string; before: Buffer | null; after: string }[] = [];
  return {
    calls,
    captureWrite: async (w) => {
      calls.push(w);
    },
  };
}
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

describe("a line's redirected writes are captured for undo (ADR 0074 amendment, 2026-10-08)", () => {
  it("a file a heredoc creates: nothing kept before, the hash it landed with after, reported created", async () => {
    ws = await mkTmpWorkspace({});
    const cmd =
      "mkdir -p src && cat > src/x.mjs <<'EOF'\nexport const x = 1;\nEOF";
    const targets = await readRedirectTargets(cmd, opts(ws.root));
    expect(targets.map((t) => [t.relative, t.before])).toEqual([
      ["src/x.mjs", null],
    ]);
    // What the shell does.
    await mkdir(join(ws.root, "src"), { recursive: true });
    await writeFile(join(ws.root, "src", "x.mjs"), "export const x = 1;\n");
    const undo = recordingUndo();
    expect(await settleRedirectTargets(targets, undo)).toEqual([
      { relPath: "src/x.mjs", created: true, added: 1, removed: 0 },
    ]);
    expect(undo.calls).toEqual([
      {
        // The key the editors use: the resolved real path.
        path: await realpath(join(ws.root, "src", "x.mjs")),
        before: null,
        after: sha("export const x = 1;\n"),
      },
    ]);
  });

  it("a file appended to or overwritten: the bytes it replaced are kept — by heredoc, printf or tee alike", async () => {
    ws = await mkTmpWorkspace({
      "notes.md": "one\ntwo\n",
      "b.txt": "b\n",
      "c.txt": "c\n",
    });
    // The live check's own line (2026-10-08): `printf … > f`, no heredoc.
    const targets = await readRedirectTargets(
      "cat >> notes.md <<'EOF'\nthree\nEOF\nprintf 'B\\n' > b.txt\necho C | tee c.txt",
      opts(ws.root),
    );
    expect(targets.map((t) => t.relative)).toEqual([
      "notes.md",
      "b.txt",
      "c.txt",
    ]);
    await appendFile(join(ws.root, "notes.md"), "three\n");
    await writeFile(join(ws.root, "b.txt"), "B\n");
    await writeFile(join(ws.root, "c.txt"), "C\n");
    const undo = recordingUndo();
    expect(await settleRedirectTargets(targets, undo)).toEqual([
      { relPath: "notes.md", created: false, added: 1, removed: 0 },
      { relPath: "b.txt", created: false, added: 1, removed: 1 },
      { relPath: "c.txt", created: false, added: 1, removed: 1 },
    ]);
    expect(undo.calls.map((c) => c.before?.toString())).toEqual([
      "one\ntwo\n",
      "b\n",
      "c\n",
    ]);
    expect(undo.calls[0]?.after).toBe(sha("one\ntwo\nthree\n"));
  });

  it("what landed is what counts: a body the shell expands, or a program's output, is captured as it came out", async () => {
    ws = await mkTmpWorkspace({});
    const targets = await readRedirectTargets(
      "cat > gen.txt <<EOF\n$HOME\nEOF\npython3 gen.py > out.txt",
      opts(ws.root),
    );
    expect(targets.map((t) => t.relative)).toEqual(["gen.txt", "out.txt"]);
    await writeFile(join(ws.root, "gen.txt"), "/home/u\n");
    await writeFile(join(ws.root, "out.txt"), "42\n");
    const undo = recordingUndo();
    await settleRedirectTargets(targets, undo);
    expect(undo.calls.map((c) => c.after)).toEqual([
      sha("/home/u\n"),
      sha("42\n"),
    ]);
  });

  it("nothing changed, nothing captured: a line that failed before writing, or wrote the same bytes", async () => {
    ws = await mkTmpWorkspace({ "same.txt": "x\n" });
    const targets = await readRedirectTargets(
      "false && cat > new.txt <<'EOF'\ny\nEOF\necho x > same.txt",
      opts(ws.root),
    );
    expect(targets.map((t) => t.relative)).toEqual(["new.txt", "same.txt"]);
    const undo = recordingUndo();
    expect(await settleRedirectTargets(targets, undo)).toEqual([]);
    expect(undo.calls).toEqual([]);
  });

  it("no target where the editors could not write either, nor one the text does not name", async () => {
    ws = await mkTmpWorkspace({});
    await writeFile(join(ws.root, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
    expect(
      await readRedirectTargets(
        [
          "cat > .herta/notes <<'EOF'\nx\nEOF",
          "echo x > blob.bin",
          "echo x > $OUT",
          "echo x > *.txt",
          "echo x > /dev/null",
          "echo x 2>&1",
        ].join("\n"),
        opts(ws.root),
      ),
    ).toEqual([]);
  });

  it("without an undo store the writes are still reported", async () => {
    ws = await mkTmpWorkspace({});
    const targets = await readRedirectTargets("echo x > a.txt", opts(ws.root));
    await writeFile(join(ws.root, "a.txt"), "x\n");
    expect(await settleRedirectTargets(targets, undefined)).toEqual([
      { relPath: "a.txt", created: true, added: 1, removed: 0 },
    ]);
  });
});

describe("writesAccounted: nothing else in the line can change a file", () => {
  it("the contract's idioms: a heredoc or printf write, `mkdir -p` first, the model's `cd <workspace> &&`, a test after", async () => {
    ws = await mkTmpWorkspace({});
    const o = opts(ws.root);
    const accounted = async (cmd: string): Promise<boolean> =>
      writesAccounted(cmd, o, await readRedirectTargets(cmd, o));
    expect(await accounted("cat > a.txt <<'EOF'\nx\nEOF")).toBe(true);
    expect(await accounted("printf 'alpha\\nbeta\\n' > notes.md")).toBe(true);
    expect(await accounted("echo x | tee a.txt > /dev/null")).toBe(true);
    expect(
      await accounted(
        "mkdir -p src/lib && cat > src/lib/x.mjs <<'EOF'\nx\nEOF",
      ),
    ).toBe(true);
    expect(
      await accounted(
        `cd ${PATHS.toShell(ws.root)} && cat > a.txt <<'EOF'\nx\nEOF`,
      ),
    ).toBe(true);
    expect(
      await accounted(
        "cat > a.test.mjs <<'EOF'\nx\nEOF\nnode --test a.test.mjs",
      ),
    ).toBe(true);
  });

  it("anything that could change another file, or a write it could not follow, is not", async () => {
    ws = await mkTmpWorkspace({ "b.txt": "b\n" });
    const o = opts(ws.root);
    const accounted = async (cmd: string): Promise<boolean> =>
      writesAccounted(cmd, o, await readRedirectTargets(cmd, o));
    // Another command that writes.
    expect(await accounted("cat > a.txt <<'EOF'\nx\nEOF\nrm b.txt")).toBe(
      false,
    );
    // A program writing its output: it may write more than that.
    expect(await accounted("python3 gen.py > out.txt")).toBe(false);
    // A heredoc fed to a program.
    expect(await accounted("python3 - <<'PY'\nopen('c','w')\nPY")).toBe(false);
    // A command substitution, in a body or in an argument.
    expect(await accounted("cat > a.txt <<EOF\n$(rm b.txt)\nEOF")).toBe(false);
    expect(await accounted("echo $(rm b.txt) > a.txt")).toBe(false);
    // A cd elsewhere first: the target is not where the scan looked.
    expect(await accounted("cd src && cat > a.txt <<'EOF'\nx\nEOF")).toBe(
      false,
    );
    // A mkdir that does more than make folders.
    expect(await accounted("mkdir -m 700 d && cat > d/a <<'EOF'\nx\nEOF")).toBe(
      false,
    );
    // A write it could not read first, or could not place.
    expect(await accounted("cat > .herta/x <<'EOF'\nx\nEOF")).toBe(false);
    expect(await accounted("echo x > a.txt; echo y > $OUT")).toBe(false);
    expect(await accounted("echo x > a.txt; echo y > /tmp/y")).toBe(false);
    // No write at all.
    expect(await accounted("touch a.txt")).toBe(false);
  });
});
