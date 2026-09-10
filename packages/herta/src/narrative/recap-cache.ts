import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { recapCachePath, writeFileAtomicSync } from "@herta/core";
import type { RecapCache } from "./session-recap.js";

function cacheDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".herta", "compaction");
}

/** The sidecar path, from core — `deleteSessionFiles` removes this same file
 *  when a session is deleted (audit BL8), so the two must not drift. */
function cacheFile(workspaceRoot: string, sessionId: string): string {
  return recapCachePath(workspaceRoot, sessionId);
}

export function readRecapCache(
  workspaceRoot: string,
  sessionId: string,
): RecapCache | null {
  try {
    const raw = readFileSync(cacheFile(workspaceRoot, sessionId), "utf8");
    const p = JSON.parse(raw) as RecapCache;
    if (
      typeof p.boundaryIndex !== "number" ||
      typeof p.recapText !== "string"
    ) {
      return null;
    }
    return {
      boundaryIndex: p.boundaryIndex,
      recapText: p.recapText,
      // Legacy sidecars (pre-lang schema, wrote a dead `model` field) read
      // as "zh": every cache written before the field existed came from a
      // zh session. The runtime discards a lang-mismatched cache on read.
      lang: p.lang === "en" ? "en" : "zh",
      advancesSinceRederive:
        typeof p.advancesSinceRederive === "number"
          ? p.advancesSinceRederive
          : 0,
    };
  } catch {
    return null;
  }
}

/** Remove a session's recap sidecar (missing file is a no-op). Called on
 *  rewind when the truncated record no longer validates the cached
 *  boundary — validate-on-first-use would discard it anyway, but deleting
 *  keeps a knowably-stale file from outliving the record state it
 *  described. */
export function deleteRecapCache(
  workspaceRoot: string,
  sessionId: string,
): void {
  try {
    unlinkSync(cacheFile(workspaceRoot, sessionId));
  } catch {
    // ENOENT and friends: nothing to invalidate.
  }
}

export function writeRecapCache(
  workspaceRoot: string,
  sessionId: string,
  cache: RecapCache,
): void {
  mkdirSync(cacheDir(workspaceRoot), { recursive: true });
  // fsync'd: the cache must survive a power loss intact or not at all — a
  // renamed-but-empty file would read as "no cache" and cost a re-derive.
  writeFileAtomicSync(
    cacheFile(workspaceRoot, sessionId),
    `${JSON.stringify(cache, null, 2)}\n`,
    { fsync: true },
  );
}
