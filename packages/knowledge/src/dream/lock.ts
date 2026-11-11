import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const LOCK_FILE = "pass.lock";

/** A lock older than this is presumed abandoned even if its pid looks alive
 *  (pid recycling): no healthy pass runs this long. Generous vs. the longest
 *  plausible pass (dozens of max-effort LLM calls). */
const STALE_LOCK_MS = 6 * 60 * 60_000; // 6 h

/** A lock file with nothing readable in it, written within this long, is a
 *  holder between creating it and writing its payload. */
const WRITING_MS = 5_000;

export interface DreamLock {
  release(): void;
}

interface LockPayload {
  pid?: number;
  at?: string;
  /** This acquisition's own mark: what `release` checks before it deletes. */
  id?: string;
}

/** Is the pid a live process? EPERM means "alive but not ours" — still alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone, or not removable now
  }
}

/**
 * What the lock file says. `gone`: it cannot be read now, because it was
 * released since the create failed or is being deleted (on Windows a file
 * pending deletion refuses the open). `writing`: it holds nothing readable
 * and is fresh, so its holder is between the create and the write. A
 * payload, possibly empty: read it as before.
 */
function readLock(path: string): LockPayload | "gone" | "writing" {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "gone";
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === "object") {
      return value as LockPayload;
    }
  } catch {
    // nothing readable: fresh, or left behind
  }
  try {
    // Either side of now: a file stamped ahead by a skewed clock must not
    // read as fresh for good.
    const age = Date.now() - statSync(path).mtimeMs;
    if (Math.abs(age) < WRITING_MS) return "writing";
  } catch {
    return "gone";
  }
  return {};
}

/** Delete the lock only while it is still this acquisition's. */
function releaseOwn(path: string, id: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    // Unreadable for now is not "someone else's": try, as before.
    removeQuietly(path);
    return;
  }
  try {
    if ((JSON.parse(raw) as LockPayload).id !== id) return;
  } catch {
    return; // not what this acquisition wrote
  }
  removeQuietly(path);
}

/**
 * Cross-process mutual exclusion for the Dream pass (the deferred G4 guard).
 * Without it, a manual `herta knowledge dream` racing the idle trigger can
 * double-reconsolidate the same record and last-writer-wins the manifest,
 * silently dropping the other pass's ledger entries (= lost dedup history).
 *
 * O_EXCL create of `pass.lock` in the dream dir, payload `{pid, at, id}`. A
 * lock whose holder pid is dead, whose payload is unreadable and no longer
 * fresh, or whose timestamp is older than STALE_LOCK_MS is stolen (unlink +
 * one retry). Returns undefined when a live holder owns the lock — the
 * caller should skip the pass.
 *
 * Two ways two processes held it at once, closed in the review of
 * 2026-11-10 (second pass; 19 overlaps in about 8,900 acquisitions by four
 * processes). The file is created empty and written next, and a rival that
 * read it in between took "unreadable" for "abandoned" and stole a live
 * lock: an unreadable lock is now a holder mid-write while it is fresh
 * (`WRITING_MS`). And `release` unlinked whatever lock was there, so a
 * holder whose lock had been stolen deleted the thief's: it now deletes
 * only the lock that carries its own `id`.
 *
 * Known residual race: two processes that BOTH observe the same stale lock can
 * both steal it (no atomic compare-and-delete exists). This needs a crashed
 * holder plus two simultaneous starts — strictly rarer than the unguarded race
 * this lock closes.
 */
export function acquireDreamLock(
  dreamDir: string,
  nowMs: number,
): DreamLock | undefined {
  mkdirSync(dreamDir, { recursive: true });
  const path = join(dreamDir, LOCK_FILE);
  const id = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx");
    } catch {
      // It exists, or cannot be created now: read what is there.
    }
    if (fd !== undefined) {
      let written = false;
      try {
        writeFileSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            at: new Date(nowMs).toISOString(),
            id,
          }),
        );
        written = true;
      } catch {
        // A lock with no payload would block every pass while it is fresh
        // and be stolen after: take it back instead.
      } finally {
        closeSync(fd);
      }
      if (!written) {
        removeQuietly(path);
        return undefined;
      }
      return { release: () => releaseOwn(path, id) };
    }
    const holder = readLock(path);
    if (holder === "gone") continue; // try the create again
    if (holder === "writing") return undefined; // a live holder, mid-write
    // Steal it only if the holder is provably gone or ancient.
    const at = Date.parse(holder.at ?? "");
    const ancient = Number.isNaN(at) || nowMs - at > STALE_LOCK_MS;
    const dead = typeof holder.pid !== "number" || !pidAlive(holder.pid);
    if (dead || ancient) {
      removeQuietly(path);
      continue;
    }
    return undefined; // live holder — skip this pass
  }
  return undefined;
}
