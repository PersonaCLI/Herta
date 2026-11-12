import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative as relativePath, sep } from "node:path";
import { GITIGNORE_MAX_BYTES, IgnoreStack } from "./gitignore.js";

export const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".herta",
  ".claude",
  "coverage",
]);

export interface WalkEntry {
  path: string;
  type: "file" | "dir";
}

export interface WalkOptions {
  recursive?: boolean;
  maxEntries?: number;
  onSkipped?: (name: string) => void;
  /** Interrupt support (audit M4, 2026-07-09): the walk checks this per
   *  directory and per entry, throwing the signal's reason (an AbortError)
   *  so a Ctrl-C lands within one entry instead of after the whole tree.
   *  Callers must let the throw propagate — the turn loop classifies it as
   *  `interrupted` (not `tool_failed`). */
  signal?: AbortSignal;
  /** Leave out what the workspace's `.gitignore` files ignore, and do not
   *  enter an ignored directory (`gitignore.ts`). Off by default: a listing
   *  by name still shows an ignored file. */
  gitignore?: boolean;
}

/** A directory's own `.gitignore`, or null when it has none it can use. */
async function readIgnoreFile(dir: string): Promise<string | null> {
  const file = join(dir, ".gitignore");
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > GITIGNORE_MAX_BYTES) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export async function* walkDir(
  workspaceRoot: string,
  startDir: string,
  opts: WalkOptions = {},
): AsyncGenerator<WalkEntry> {
  const recursive = opts.recursive ?? false;
  const max = opts.maxEntries ?? Number.POSITIVE_INFINITY;
  const reportSkipped = opts.onSkipped;
  const signal = opts.signal;
  const skippedSeen = new Set<string>();
  const relOf = (abs: string): string =>
    relativePath(workspaceRoot, abs).split(sep).join("/");

  let yielded = 0;

  // The `.gitignore` files above the start directory apply to it too: the
  // workspace root's, then each directory's on the way down. The start
  // directory's own is read when it is visited.
  let outer = IgnoreStack.EMPTY;
  const startRel = relOf(startDir);
  if (
    opts.gitignore === true &&
    startRel !== "" &&
    !startRel.startsWith("..")
  ) {
    let at = workspaceRoot;
    let atRel = "";
    for (const name of ["", ...startRel.split("/").slice(0, -1)]) {
      if (name !== "") {
        at = join(at, name);
        atRel = atRel === "" ? name : `${atRel}/${name}`;
      }
      signal?.throwIfAborted();
      const text = await readIgnoreFile(at);
      if (text !== null) outer = outer.with(atRel, text);
    }
  }

  async function* visit(
    dir: string,
    inherited: IgnoreStack,
  ): AsyncGenerator<WalkEntry> {
    if (yielded >= max) return;
    signal?.throwIfAborted();

    let ignore = inherited;
    if (opts.gitignore === true) {
      const text = await readIgnoreFile(dir);
      if (text !== null) ignore = ignore.with(relOf(dir), text);
    }

    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const dirent of dirents) {
      if (yielded >= max) return;
      signal?.throwIfAborted();

      const name = dirent.name;
      const abs = join(dir, name);

      if (dirent.isDirectory() && SKIP_DIR_NAMES.has(name)) {
        if (!skippedSeen.has(name)) {
          skippedSeen.add(name);
          reportSkipped?.(name);
        }
        continue;
      }

      let type: "file" | "dir";
      let isSymlink = false;
      if (dirent.isSymbolicLink()) {
        isSymlink = true;
        try {
          const s = await stat(abs);
          type = s.isDirectory() ? "dir" : "file";
        } catch {
          type = "file";
        }
      } else if (dirent.isDirectory()) {
        type = "dir";
      } else {
        type = "file";
      }

      const rel = relOf(abs);
      // A symlink is a file to git, whatever it points at.
      if (
        opts.gitignore === true &&
        ignore.ignores(rel, dirent.isDirectory())
      ) {
        continue;
      }
      yield { path: rel, type };
      yielded++;
      if (yielded >= max) return;

      if (recursive && type === "dir" && !isSymlink) {
        yield* visit(abs, ignore);
      }
    }
  }

  yield* visit(startDir, outer);
}
