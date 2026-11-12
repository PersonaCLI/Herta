import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "./testing/tmp-workspace.js";
import { walkDir } from "./walker.js";

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

async function collect(
  gen: AsyncIterable<{ path: string; type: "file" | "dir" }>,
) {
  const out: { path: string; type: "file" | "dir" }[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function canCreateDirSymlinks(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), "herta-symlink-probe-"));
  try {
    await mkdir(join(probe, "real"), { recursive: true });
    await symlink(join(probe, "real"), join(probe, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

describe("walkDir", () => {
  it("emits direct children when not recursive", async () => {
    ws = await mkTmpWorkspace({
      "a.txt": "a",
      "b.txt": "b",
      "sub/c.txt": "c",
    });
    const result = await collect(
      walkDir(ws.root, ws.root, { recursive: false }),
    );
    const paths = result.map((e) => e.path).sort();
    expect(paths).toEqual(["a.txt", "b.txt", "sub"]);
  });

  it("recurses when recursive: true", async () => {
    ws = await mkTmpWorkspace({
      "a.txt": "a",
      "sub/b.txt": "b",
      "sub/deep/c.txt": "c",
    });
    const result = await collect(
      walkDir(ws.root, ws.root, { recursive: true }),
    );
    const paths = result.map((e) => e.path).sort();
    expect(paths).toContain("a.txt");
    expect(paths).toContain("sub");
    expect(paths).toContain("sub/b.txt");
    expect(paths).toContain("sub/deep");
    expect(paths).toContain("sub/deep/c.txt");
  });

  it("applies the skip list and reports skipped names", async () => {
    ws = await mkTmpWorkspace({
      "src/foo.ts": "x",
      "node_modules/lib/index.js": "y",
      ".git/HEAD": "z",
      "dist/out.js": "q",
    });
    const skipped: string[] = [];
    const result = await collect(
      walkDir(ws.root, ws.root, {
        recursive: true,
        onSkipped: (name) => skipped.push(name),
      }),
    );
    const paths = result.map((e) => e.path);
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
    expect(paths.some((p) => p.startsWith("dist"))).toBe(false);
    expect(skipped.sort()).toEqual([".git", "dist", "node_modules"].sort());
  });

  it("respects maxEntries by short-circuiting", async () => {
    ws = await mkTmpWorkspace({
      "a.txt": "1",
      "b.txt": "2",
      "c.txt": "3",
      "d.txt": "4",
    });
    let count = 0;
    for await (const _ of walkDir(ws.root, ws.root, {
      recursive: false,
      maxEntries: 2,
    })) {
      count++;
    }
    expect(count).toBe(2);
  });

  it("aborts mid-walk when the signal fires (audit M4: interrupt lands within one entry)", async () => {
    ws = await mkTmpWorkspace({
      "a.txt": "1",
      "b.txt": "2",
      "c.txt": "3",
    });
    const ac = new AbortController();
    const iter = walkDir(ws.root, ws.root, {
      recursive: true,
      signal: ac.signal,
    })[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    ac.abort();
    await expect(iter.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not follow symlinks during recursion", async () => {
    const symlinkable = await canCreateDirSymlinks();
    if (!symlinkable) return; // Windows without admin
    ws = await mkTmpWorkspace({ "real/file.txt": "x" });
    await mkdir(join(ws.root, "loop"), { recursive: true });
    await symlink(join(ws.root, "loop"), join(ws.root, "loop/self"), "dir");
    const result = await collect(
      walkDir(ws.root, ws.root, { recursive: true, maxEntries: 100 }),
    );
    expect(result.length).toBeLessThan(50);
  });
});

describe("walkDir — gitignore (review 2026-11-10, second pass)", () => {
  const TREE = {
    ".gitignore": "out/\n*.log\n",
    "src/a.ts": "a",
    "src/b.log": "b",
    "src/.gitignore": "!b.log\nlocal.ts\n",
    "src/local.ts": "l",
    "out/big/1.js": "1",
    "out/big/2.js": "2",
    "top.log": "t",
  };
  const files = async (
    root: string,
    start: string,
    gitignore: boolean,
  ): Promise<string[]> =>
    (await collect(walkDir(root, start, { recursive: true, gitignore })))
      .filter((e) => e.type === "file")
      .map((e) => e.path)
      .sort();

  it("leaves out what is ignored and never enters an ignored directory", async () => {
    ws = await mkTmpWorkspace(TREE);
    expect(await files(ws.root, ws.root, true)).toEqual([
      ".gitignore",
      "src/.gitignore",
      "src/a.ts",
      "src/b.log",
    ]);
    // The directory itself is not yielded either.
    const all = await collect(
      walkDir(ws.root, ws.root, { recursive: true, gitignore: true }),
    );
    expect(all.some((e) => e.path === "out" || e.path.startsWith("out/"))).toBe(
      false,
    );
  });

  it("is off unless asked for: a listing still shows an ignored file", async () => {
    ws = await mkTmpWorkspace(TREE);
    const all = await files(ws.root, ws.root, false);
    expect(all).toContain("out/big/1.js");
    expect(all).toContain("top.log");
    expect(all).toContain("src/local.ts");
  });

  it("a walk that starts below the root obeys the files above it", async () => {
    ws = await mkTmpWorkspace(TREE);
    expect(await files(ws.root, join(ws.root, "src"), true)).toEqual([
      "src/.gitignore",
      "src/a.ts",
      "src/b.log",
    ]);
  });

  it("a walk started inside an ignored directory still reads it", async () => {
    ws = await mkTmpWorkspace(TREE);
    // `out/` names the directory, not what is in it: asked for by name, it
    // is searched, as git and ripgrep do.
    expect(await files(ws.root, join(ws.root, "out"), true)).toEqual([
      "out/big/1.js",
      "out/big/2.js",
    ]);
  });
});
