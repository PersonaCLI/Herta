import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Atomic file replacement, the ONE way (2026-09-11, the post-0.1.5 refactor
 * pass). Fourteen copies of "write a temp beside the target, rename it over"
 * lived across core, tools, knowledge, herta and the desktop main process —
 * two byte-identical, two with a FIXED temp name (two writers racing on the
 * same file could publish one's half-written bytes under the other's
 * rename), the rest each with their own naming and their own cleanup.
 *
 * Contract: readers see the previous file or the whole new one, never a
 * torn one; a process killed mid-write leaves at most a stray temp, never a
 * half file. The temp is created exclusively (`wx`) under a per-process
 * unique name in the target's directory (rename is atomic only within one
 * filesystem), removed on any failure, and the ORIGINAL error is rethrown —
 * callers keep whatever they did with `err.code`. `fsync` (default off)
 * flushes the temp's data before the rename for the two callers that want
 * durability across power loss (the recap cache, the dream manifest); the
 * rename alone is what defends against a process kill, the dominant crash.
 * Callers create the directory; this does not.
 */
export interface AtomicWriteOptions {
  readonly fsync?: boolean;
}

/**
 * The rename, tried again where Windows refuses it for a moment (review
 * 2026-11-10).
 *
 * On Windows a rename over an existing file fails with EPERM, EACCES or
 * EBUSY while another process holds the target open: an antivirus scanning
 * what was just written, OneDrive syncing the folder, the search indexer.
 * The hold lasts milliseconds. One refusal lost the write: a saved project
 * fact, a recap, a session's sidecar. The rename is tried again on those
 * three codes, six times in about 0.4 s, and then the last error is thrown
 * as before. Elsewhere those codes mean what they say, and nothing waits.
 */
const RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 25, 50, 100, 200];
const HELD_BY_ANOTHER = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface RenameRetryOptions {
  /** The rename to call (a test's, or a caller's own `fs`). */
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly platform?: NodeJS.Platform;
  /** The waits between tries; one more try than waits. */
  readonly delaysMs?: readonly number[];
}

export async function renameWithRetry(
  from: string,
  to: string,
  opts: RenameRetryOptions = {},
): Promise<void> {
  const doRename = opts.rename ?? rename;
  const delays =
    (opts.platform ?? process.platform) === "win32"
      ? (opts.delaysMs ?? RENAME_RETRY_DELAYS_MS)
      : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await doRename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      const wait = delays[attempt];
      if (
        wait === undefined ||
        code === undefined ||
        !HELD_BY_ANOTHER.has(code)
      ) {
        throw err;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }
}

let seq = 0;

/** A unique temp path beside `target`: hidden, pid + counter + random, so
 *  two writers in one process, two processes, and two writes in the same
 *  millisecond all land on different names. */
function tempPathFor(target: string): string {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${seq}.${rand}.tmp`,
  );
}

export function writeFileAtomicSync(
  target: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): void {
  const tmp = tempPathFor(target);
  try {
    writeFileSync(tmp, data, { encoding: "utf8", flag: "wx" });
    if (opts.fsync === true) {
      try {
        const fd = openSync(tmp, "r+");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        // fsync unsupported or refused — rename-only atomicity remains.
      }
    }
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the temp is already gone, or undeletable — nothing left to do
    }
    throw err;
  }
}

export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const tmp = tempPathFor(target);
  try {
    await writeFile(tmp, data, { encoding: "utf8", flag: "wx" });
    if (opts.fsync === true) {
      try {
        const fh = await open(tmp, "r+");
        try {
          await fh.sync();
        } finally {
          await fh.close();
        }
      } catch {
        // fsync unsupported or refused — rename-only atomicity remains.
      }
    }
    await renameWithRetry(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
