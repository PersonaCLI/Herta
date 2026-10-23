import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { currentJournalHost, type JournalHost } from "@herta/core";
import { processTree } from "@herta/tools";
import {
  hostState,
  type ProcessProbe,
  systemProcessProbe,
} from "./dispatch-recovery.js";

/**
 * The launcher's servers across an app exit (ADR 0083 §5): "At relaunch they
 * are ended and reported", as ADR 0071 does for a run's processes. A
 * session's dev servers outlive its runs, so they are not in any run's
 * journal: this file records each one's pid while it runs, and which
 * sessions are owed a note about servers a relaunch ended.
 */

export interface ServerJournalRunning {
  readonly host: JournalHost;
  readonly pid: number;
  readonly startedAt: number;
  readonly name: string;
  readonly sessionId: string;
}

interface ServerJournalFile {
  readonly version: 1;
  readonly running: readonly ServerJournalRunning[];
  /** Servers a relaunch ended, by session, until the session hears. */
  readonly reaped: Readonly<Record<string, readonly string[]>>;
}

const EMPTY: ServerJournalFile = { version: 1, running: [], reaped: {} };

async function readJournal(file: string): Promise<ServerJournalFile> {
  try {
    const raw = JSON.parse(
      await readFile(file, "utf8"),
    ) as Partial<ServerJournalFile>;
    return {
      version: 1,
      running: Array.isArray(raw.running) ? raw.running : [],
      reaped:
        typeof raw.reaped === "object" && raw.reaped !== null ? raw.reaped : {},
    };
  } catch {
    return EMPTY;
  }
}

async function writeJournal(file: string, j: ServerJournalFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(j), "utf8");
  await rename(tmp, file);
}

/**
 * One app process's record of its servers. Writes are chained, so a start
 * and an exit in quick succession land in order; a failed write leaves the
 * file as it was (the reaper then finds less — never more than ran).
 */
export class ServerJournal {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly host: JournalHost = currentJournalHost(),
  ) {}

  spawned(s: {
    readonly pid: number;
    readonly startedAt: number;
    readonly name: string;
    readonly sessionId: string;
  }): Promise<void> {
    return this.update((j) => ({
      ...j,
      running: [
        ...j.running.filter((r) => r.pid !== s.pid),
        { host: this.host, ...s },
      ],
    }));
  }

  exited(pid: number): Promise<void> {
    return this.update((j) => ({
      ...j,
      running: j.running.filter((r) => r.pid !== pid),
    }));
  }

  /** The servers a relaunch ended in this session — once: the caller
   *  notes them in the session's record. */
  takeReaped(sessionId: string): Promise<readonly string[]> {
    let names: readonly string[] = [];
    return this.update((j) => {
      names = j.reaped[sessionId] ?? [];
      if (names.length === 0) return j;
      const { [sessionId]: _taken, ...rest } = j.reaped;
      return { ...j, reaped: rest };
    }).then(() => names);
  }

  private update(
    change: (j: ServerJournalFile) => ServerJournalFile,
  ): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        const now = await readJournal(this.file);
        const next = change(now);
        if (next !== now) await writeJournal(this.file, next);
      })
      .catch(() => undefined);
    return this.chain;
  }
}

/**
 * The launch reaper for the launcher's servers: each recorded server whose
 * app process is gone, and that still runs as that process (same pid, same
 * start time), is ended with what it started; the sessions it belonged to
 * are owed a note. A server of a live app — this one, or a second one
 * sharing the sessions — is left alone, as is one whose process table could
 * not be read (it stays for the next launch).
 */
export async function reapOrphanedServers(
  file: string,
  probe: ProcessProbe = systemProcessProbe,
): Promise<{ readonly ended: number }> {
  const j = await readJournal(file);
  if (j.running.length === 0) return { ended: 0 };
  const keep: ServerJournalRunning[] = [];
  const reaped: Record<string, string[]> = Object.fromEntries(
    Object.entries(j.reaped).map(([k, v]) => [k, [...v]]),
  );
  let ended = 0;
  let table: Awaited<ReturnType<ProcessProbe["processes"]>> | null = null;
  for (const r of j.running) {
    const host = await hostState(r.host, probe);
    if (host !== "gone") {
      keep.push(r);
      continue;
    }
    try {
      table ??= await probe.processes();
    } catch {
      keep.push(r);
      continue;
    }
    const tree = processTree(table, r, probe.platform ?? process.platform);
    if (tree.length === 0) continue;
    try {
      await probe.kill(tree);
    } catch {
      keep.push(r);
      continue;
    }
    ended += 1;
    const names = reaped[r.sessionId] ?? [];
    reaped[r.sessionId] = names;
    if (!names.includes(r.name)) names.push(r.name);
  }
  await writeJournal(file, { version: 1, running: keep, reaped });
  return { ended };
}
