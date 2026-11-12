import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  importLegacyChoices,
  legacyChoicesImported,
} from "../workspace-permissions.js";
import { sessionWorkspaces } from "./evidence-retention.js";

/**
 * Carry the automatic-review choices of the old per-workspace files over to
 * the one file outside every workspace — once per surface (ADR 0064
 * amendment 2026-11-12).
 *
 * The workspaces it looks in are the ones this installation's own session
 * records name: where each recorded session started, its backend's own
 * workspace, and every folder it was moved to (`sessionWorkspaces`). Those
 * are folders the owner used with this app while the old file was in force,
 * so carrying their choice over changes nothing that was not already true.
 * A folder is never looked in because it is open now: that a file is there
 * says nothing of who wrote it, which is the hole the move closed.
 *
 * Returns how many choices were carried over; 0 when the surface's one time
 * has passed. Never throws: a transcript directory that cannot be listed
 * imports nothing and leaves the surface unmarked, so the next start tries
 * again.
 */
export async function importLegacyReviewChoices(opts: {
  /** Where the choices are kept now (`reviewChoicesFileFor`). */
  readonly file: string;
  /** Whose one time this is: `"app-server"` (the desktop's session host) or
   *  `"cli"`. */
  readonly surface: string;
  /** Where this surface's `<sessionId>.jsonl` records live. */
  readonly transcriptDir: string;
}): Promise<number> {
  try {
    if (legacyChoicesImported(opts.file, opts.surface)) return 0;
    let names: string[];
    try {
      names = await readdir(opts.transcriptDir);
    } catch (err) {
      // No records yet is an answer: there is nothing to carry over.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return 0;
      names = [];
    }
    const workspaces = new Set<string>();
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      for (const root of await sessionWorkspaces(
        join(opts.transcriptDir, name),
      )) {
        workspaces.add(root);
      }
    }
    return importLegacyChoices({
      file: opts.file,
      surface: opts.surface,
      workspaces: [...workspaces],
    });
  } catch {
    return 0;
  }
}
