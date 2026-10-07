import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { writeFileAtomic } from "../atomic-write.js";
import { isPathInside } from "../path-containment.js";
import type { UndoFileResult } from "../types/terminal-record.js";
import { type UndoSegmentView, undoBlobPath } from "./undo-store.js";

/**
 * Taking a turn's edits back (ADR 0074 §3): the harness's own code, never
 * the persona's, and never 板砖's (there is no revert tool).
 *
 * Each path is decided three ways by hashing the file as it stands:
 *  - as the turn left it (its last after) → its first bytes go back, or the
 *    file goes if the turn created it;
 *  - as it was before (its first before; missing for a created file) →
 *    nothing to do;
 *  - anything else → changed since 板砖 wrote it: left alone, NEVER
 *    overwritten, and named.
 */

export type { UndoFileResult };

export interface UndoOutcome {
  /** Per path (absolute), in first-write order. */
  readonly files: readonly {
    readonly path: string;
    readonly result: UndoFileResult;
  }[];
  /** What commands changed — never restored. `unknown`: commands ran and
   *  what they changed could not be read. */
  readonly commands: {
    readonly paths: readonly string[];
    readonly unknown: boolean;
  };
  /** Some bytes of these segments were never kept. */
  readonly incomplete: boolean;
}

/** Several segments as one span, oldest first: per path, the earliest
 *  segment's first before and the latest segment's last after. */
export function undoSpan(views: readonly UndoSegmentView[]): {
  readonly writes: readonly {
    path: string;
    before: string | null;
    after: string;
  }[];
  readonly commands: UndoOutcome["commands"];
  readonly incomplete: boolean;
} {
  const writes = new Map<
    string,
    { path: string; before: string | null; after: string }
  >();
  const paths = new Set<string>();
  let unknown = false;
  let incomplete = false;
  for (const v of [...views].sort((a, b) => a.seg - b.seg)) {
    for (const w of v.writes) {
      const prior = writes.get(w.path);
      writes.set(w.path, {
        path: w.path,
        before: prior === undefined ? w.before : prior.before,
        after: w.after,
      });
    }
    for (const p of v.commands.paths) paths.add(p);
    if (v.commands.unknown) unknown = true;
    if (v.incomplete || v.pruned) incomplete = true;
  }
  return {
    writes: [...writes.values()],
    commands: { paths: [...paths], unknown },
    incomplete,
  };
}

const sha256 = (b: Buffer): string =>
  createHash("sha256").update(b).digest("hex");

/** The file's hash as it stands; null when it does not exist; undefined
 *  when it cannot be read (a folder in its place, no permission). */
async function current(path: string): Promise<string | null | undefined> {
  try {
    return sha256(await readFile(path));
  } catch (err) {
    return (err as { code?: string }).code === "ENOENT" ? null : undefined;
  }
}

/** Take the span of `views` back in `workspaceRoot`. Never throws: every
 *  path gets a result, and a failure is one of them. */
export async function restoreUndo(
  dir: string,
  views: readonly UndoSegmentView[],
  workspaceRoot: string,
): Promise<UndoOutcome> {
  const span = undoSpan(views);
  const files: { path: string; result: UndoFileResult }[] = [];
  for (const w of span.writes) {
    files.push({
      path: w.path,
      result: await restoreOne(dir, w, workspaceRoot),
    });
  }
  return { files, commands: span.commands, incomplete: span.incomplete };
}

async function restoreOne(
  dir: string,
  w: { path: string; before: string | null; after: string },
  workspaceRoot: string,
): Promise<UndoFileResult> {
  if (!isPathInside(workspaceRoot, w.path, { strict: true })) {
    return "outside_workspace";
  }
  const now = await current(w.path);
  if (now === w.after) {
    if (w.before === null) {
      try {
        await rm(w.path, { force: true });
        return "deleted";
      } catch {
        return "failed";
      }
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(undoBlobPath(dir, w.before));
    } catch {
      return "not_kept";
    }
    // The blob is content-addressed: a store that lost or mangled it must
    // not put the wrong bytes back.
    if (sha256(bytes) !== w.before) return "not_kept";
    try {
      await writeFileAtomic(w.path, bytes);
      return "restored";
    } catch {
      return "failed";
    }
  }
  if (now === w.before) return "unchanged";
  return "changed_since";
}
