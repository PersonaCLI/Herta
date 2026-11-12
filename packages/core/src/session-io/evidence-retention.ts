import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { isPathInside } from "../path-containment.js";

/**
 * How long a workspace keeps what its commands left (owner 2026-11-12).
 *
 * Every command writes its full output under `.herta/logs`, and every tool
 * result too large for the prompt is written under `.herta/tool-results`.
 * Nothing ever removed either: not time, and not deleting the session they
 * belonged to (review 2026-11-10, second pass). The rule now:
 *
 *   - a session's files go when the session is deleted
 *     (`removeSessionEvidence`, from `deleteSessionFiles`);
 *   - whatever is older than `EVIDENCE_KEEP_DAYS` goes at a sweep, made when
 *     a session opens the workspace (`sweepEvidence`).
 *
 * The record is not touched: it keeps its excerpts, and a row whose full log
 * has gone says so when it is opened.
 *
 * "Older than thirty days" is the machine's clock, and a clock set a month
 * ahead for one sweep would empty both folders. So a sweep deletes nothing
 * at first sight, as Flow's prune does not: it writes down what it found
 * expired, and a sweep `EVIDENCE_CONFIRM_MS` later removes what that mark
 * named and the clock still does. A mark from the future names nothing.
 */
export const EVIDENCE_KEEP_DAYS = 30;
const KEEP_MS = EVIDENCE_KEEP_DAYS * 24 * 60 * 60 * 1000;
/** Between a sweep finding something expired and a sweep removing it. Under
 *  a day, so an app opened at the same hour each morning finds the mark due. */
export const EVIDENCE_CONFIRM_MS = 20 * 60 * 60 * 1000;

const LOGS = [".herta", "logs"] as const;
const RESULTS = [".herta", "tool-results"] as const;
const MARK = [".herta", "retention.json"] as const;

/** A session id as the log writer leaves it in a file name. One that it
 *  would have rewritten is left to the sweep. */
const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A run id as the result store leaves it in a folder name. */
const RUN_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/;

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** A plain file's last-written time, or null for anything else: a link is
 *  never followed and never removed. */
async function fileTime(path: string): Promise<number | null> {
  try {
    const info = await lstat(path);
    return info.isFile() ? info.mtimeMs : null;
  } catch {
    return null;
  }
}

async function isRealDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

const META_PREFIX = Buffer.from('{"_kind":');

/**
 * The workspaces a session's file names: where it started, its backend's
 * own, and every one it was moved to. Meta lines only, found by their first
 * bytes, so a long record is not decoded to find them. Empty when the file
 * cannot be read.
 */
export async function sessionWorkspaces(
  sessionFile: string,
): Promise<string[]> {
  let buf: Buffer;
  try {
    buf = await readFile(sessionFile);
  } catch {
    return [];
  }
  const out = new Set<string>();
  let start = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl === -1 ? buf.length : nl;
    if (
      end - start > META_PREFIX.length &&
      buf.compare(
        META_PREFIX,
        0,
        META_PREFIX.length,
        start,
        start + META_PREFIX.length,
      ) === 0
    ) {
      try {
        const meta = JSON.parse(buf.toString("utf8", start, end)) as {
          _kind?: unknown;
          workspaceRoot?: unknown;
          backendWorkspace?: unknown;
          path?: unknown;
        };
        const found =
          meta._kind === "session_meta"
            ? [meta.workspaceRoot, meta.backendWorkspace]
            : meta._kind === "workspace_set"
              ? [meta.path]
              : [];
        for (const p of found) {
          if (typeof p === "string" && p.length > 0) out.add(p);
        }
      } catch {
        // not a line this can read
      }
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  return [...out];
}

/**
 * Remove one session's command logs, and the saved results of the runs
 * named, from the workspaces given. Returns how many entries went. Never
 * throws: what cannot be removed now is the sweep's.
 */
export async function removeSessionEvidence(opts: {
  readonly sessionId: string;
  readonly workspaceRoots: readonly string[];
  /** Run ids whose saved results belong to this session. */
  readonly runIds?: readonly string[];
}): Promise<number> {
  let removed = 0;
  const roots = [...new Set(opts.workspaceRoots.map((r) => resolve(r)))];
  for (const root of roots) {
    if (PLAIN_ID.test(opts.sessionId)) {
      const logs = join(root, ...LOGS);
      const prefix = `${opts.sessionId}-`;
      for (const name of await names(logs)) {
        if (!name.startsWith(prefix) || !name.endsWith(".log")) continue;
        const path = join(logs, name);
        if ((await fileTime(path)) === null) continue;
        try {
          await rm(path, { force: true });
          removed += 1;
        } catch {
          // held by another program: the sweep takes it later
        }
      }
    }
    const results = join(root, ...RESULTS);
    for (const runId of opts.runIds ?? []) {
      if (!RUN_ID.test(runId)) continue;
      const dir = resolve(results, runId);
      if (!isPathInside(results, dir, { strict: true })) continue;
      if (!(await isRealDir(dir))) continue;
      try {
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      } catch {
        // as above
      }
    }
  }
  return removed;
}

interface Mark {
  /** Files last written before this were expired … */
  readonly cutoff: number;
  /** … at this moment, by the clock. */
  readonly at: number;
}

async function readMark(root: string): Promise<Mark | null> {
  try {
    const raw = JSON.parse(await readFile(join(root, ...MARK), "utf8")) as {
      cutoff?: unknown;
      at?: unknown;
    };
    return typeof raw.cutoff === "number" &&
      Number.isFinite(raw.cutoff) &&
      typeof raw.at === "number" &&
      Number.isFinite(raw.at)
      ? { cutoff: raw.cutoff, at: raw.at }
      : null;
  } catch {
    return null;
  }
}

/** Every file the two folders hold, with the folder to remove once empty
 *  (a run's results folder; none for a log). */
async function evidenceFiles(
  root: string,
): Promise<{ path: string; time: number; emptyDir?: string }[]> {
  const out: { path: string; time: number; emptyDir?: string }[] = [];
  const logs = join(root, ...LOGS);
  for (const name of await names(logs)) {
    const path = join(logs, name);
    const time = await fileTime(path);
    if (time !== null) {
      if (name.endsWith(".log")) out.push({ path, time });
      continue;
    }
    // The dev servers' logs sit one folder down (`logs/servers`).
    if (name !== "servers" || !(await isRealDir(path))) continue;
    for (const inner of await names(path)) {
      const innerPath = join(path, inner);
      const innerTime = await fileTime(innerPath);
      if (innerTime !== null && inner.endsWith(".log")) {
        out.push({ path: innerPath, time: innerTime });
      }
    }
  }
  const results = join(root, ...RESULTS);
  for (const run of await names(results)) {
    const dir = join(results, run);
    if (!(await isRealDir(dir))) continue;
    for (const name of await names(dir)) {
      const path = join(dir, name);
      const time = await fileTime(path);
      if (time !== null) out.push({ path, time, emptyDir: dir });
    }
  }
  return out;
}

/**
 * Remove what a workspace's two folders have held for more than
 * `EVIDENCE_KEEP_DAYS`, once a later sweep confirms it (see the file's
 * head). Returns how many files went. Never throws.
 */
export async function sweepEvidence(
  workspaceRoot: string,
  now: number,
): Promise<number> {
  const root = resolve(workspaceRoot);
  const cutoff = now - KEEP_MS;
  let removed = 0;
  try {
    const files = await evidenceFiles(root);
    if (!files.some((f) => f.time < cutoff)) return 0;
    const held = await readMark(root);
    const mark = held !== null && held.at <= now ? held : null;
    const before =
      mark !== null && now - mark.at >= EVIDENCE_CONFIRM_MS
        ? Math.min(mark.cutoff, cutoff)
        : null;
    let waiting = false;
    const emptied = new Set<string>();
    for (const file of files) {
      if (file.time >= cutoff) continue;
      if (before === null || file.time >= before) {
        waiting = true;
        continue;
      }
      try {
        await rm(file.path, { force: true });
        removed += 1;
        if (file.emptyDir !== undefined) emptied.add(file.emptyDir);
      } catch {
        waiting = true;
      }
    }
    for (const dir of emptied) {
      // Only if nothing is left in it: `rmdir` refuses a folder with files.
      await rmdir(dir).catch(() => undefined);
    }
    // What is still expired waits from now. A mark not yet due stands.
    if (waiting && (mark === null || before !== null)) {
      await mkdir(join(root, ".herta"), { recursive: true });
      await writeFile(
        join(root, ...MARK),
        `${JSON.stringify({ cutoff, at: now } satisfies Mark)}\n`,
        "utf8",
      );
    }
  } catch {
    // a folder that cannot be read or a mark that cannot be written: later
  }
  return removed;
}

/** When each workspace was last swept by this process. */
const swept = new Map<string, number>();
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * `sweepEvidence`, at most once every six hours for a workspace, detached:
 * the caller is opening a session and does not wait. Returns the sweep when
 * one was started, for a test to await.
 */
export function sweepEvidenceSoon(
  workspaceRoot: string,
  now: number = Date.now(),
): Promise<number> | null {
  const root = resolve(workspaceRoot);
  const last = swept.get(root);
  if (last !== undefined && Math.abs(now - last) < SWEEP_EVERY_MS) return null;
  swept.set(root, now);
  return sweepEvidence(root, now).catch(() => 0);
}
