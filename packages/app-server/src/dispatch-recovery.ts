import { open, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  currentJournalHost,
  DispatchJournal,
  type DispatchJournalEntry,
  hashFile,
  type JournalHost,
  type JournalProcessFate,
  journalLastAlive,
  type LastTurnEnd,
  markJournalOpen,
  openDispatch,
  planSeal,
  readDispatchJournal,
  readJournalIndex,
  type SealPlan,
  type TerminalRecord,
  type TerminalRecordBlock,
} from "@herta/core";
import { buildCrashMarker } from "@herta/herta";
import {
  killProcesses,
  listMsysProcesses,
  listProcesses,
  type MsysRow,
  msysGroupWinpids,
  type ProcessRow,
  processTree,
  SAME_PROCESS_WINDOW_MS,
  sameProcessStart,
} from "@herta/tools";

/**
 * Recovering a 板砖 run the app exited during (ADR 0071 §1.2, §1.6): the
 * seal a session's open runs, the reaper a launch runs, and the drop a
 * rewind runs. Everything here is best effort around the session: a
 * failure leaves the session as it would have been without it.
 */

/** Reading processes — injectable, so the tests need not spawn. */
export interface ProcessProbe {
  /** Every running process; rejects when the table cannot be read. */
  processes(): Promise<readonly ProcessRow[]>;
  /** MSYS's own table, through the `ps` a journal recorded; rejects when it
   *  cannot be read. */
  msysProcesses(ps: string): Promise<readonly MsysRow[]>;
  /** End these processes. */
  kill(pids: readonly number[]): Promise<void>;
  /** Whether a pid runs at all (a cheap first check). */
  alive(pid: number): boolean;
  /** This process, as a journal names its host. */
  self(): JournalHost;
  /** Whose rules the table follows — parent ids (Windows) or process groups
   *  (POSIX). The machine's own when absent; a test's table names its rules,
   *  or it passes on one platform by chance (CI 2026-09-30). */
  readonly platform?: NodeJS.Platform;
}

export const systemProcessProbe: ProcessProbe = {
  processes: listProcesses,
  msysProcesses: listMsysProcesses,
  kill: killProcesses,
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM: it runs, as someone else.
      return (err as { code?: unknown }).code === "EPERM";
    }
  },
  self: currentJournalHost,
};

/**
 * Whose run a journal holds. "self": this process wrote it. "other": another
 * live process — a second app sharing the sessions — is running it; hands
 * off. "gone": its process is dead. "unknown": its pid runs and could not be
 * checked; treated as "other".
 */
export async function hostState(
  host: JournalHost | undefined,
  probe: ProcessProbe,
): Promise<"self" | "other" | "gone" | "unknown"> {
  if (host === undefined) return "gone";
  const me = probe.self();
  if (host.pid === me.pid) {
    return sameProcessStart(host.startedAt, me.startedAt) ? "self" : "gone";
  }
  if (!probe.alive(host.pid)) return "gone";
  try {
    const row = (await probe.processes()).find((r) => r.pid === host.pid);
    if (row === undefined) return "gone";
    return sameProcessStart(host.startedAt, row.startedAt) ? "other" : "gone";
  } catch {
    return "unknown";
  }
}

function lastTerminalMarker(record: TerminalRecord): number {
  for (let i = record.length - 1; i >= 0; i -= 1) {
    const b = record[i];
    if (
      b?.kind === "system" &&
      (b.role === "done-marker" || b.role === "noop-marker")
    ) {
      return i;
    }
  }
  return -1;
}

export interface SealedOpen {
  readonly record: TerminalRecord;
  readonly lastTurnEnd: LastTurnEnd;
  readonly plan: SealPlan;
}

/**
 * Seal the session's run if the app exited during it (ADR 0071 §1.2). Runs
 * once per open, before anything else touches the session. Null — nothing
 * written — unless BOTH halves of the gate hold: the journal's run never
 * ended, and the record has no terminal marker since that run began. A
 * clean reload, a session sealed before, and a run still unwinding in this
 * process or live in another all come back null.
 *
 * Order, so a seal cut short is finished by the next open: the closers
 * into the journal, then the marker and `turn_end interrupted` into the
 * record, then the journal's `end`.
 */
export async function sealOpenDispatch(opts: {
  readonly journalPath: string;
  readonly record: TerminalRecord;
  readonly persister: {
    appendBlock(block: TerminalRecordBlock): void;
    appendTurnEnd?(
      outcome: "completed" | "interrupted" | "failed",
      at: string,
    ): void;
  };
  readonly now?: () => Date;
  readonly probe?: ProcessProbe;
}): Promise<SealedOpen | null> {
  const probe = opts.probe ?? systemProcessProbe;
  const entries = await readDispatchJournal(opts.journalPath);
  if (entries === null) return null;
  const open = openDispatch(entries);
  if (open === null) return null;
  const at = open.recordLength;
  if (at === undefined) return null;
  if (DispatchJournal.isLive(opts.journalPath)) return null;
  // The record ends before the run began: its rows were withdrawn, or a
  // power cut took a tail the fsynced journal kept (review 2026-09-30). No
  // marker can stand where no user block does; the run is dropped as a
  // rewind drops it, so it is neither sealed nor offered later.
  if (opts.record.length < at) {
    await dropWithdrawnJournal(opts.journalPath, opts.record.length).catch(
      () => undefined,
    );
    return null;
  }
  const host = await hostState(open.start.host, probe);
  if (host === "other" || host === "unknown") return null;
  // A marker already ends the run but the journal has no `end`: a seal cut
  // short after its marker, before its last line. Finished now, or the run
  // would read as open forever and never be offered (review 2026-09-30).
  if (lastTerminalMarker(opts.record) >= at) {
    const journal = await DispatchJournal.reopen(opts.journalPath);
    try {
      await journal.append({
        kind: "end",
        status: "interrupted",
        cause: "app-exit",
      });
    } finally {
      await journal.close();
    }
    return null;
  }

  const plan = await planSeal(entries, hashFile);
  if (plan === null) return null;

  const journal = await DispatchJournal.reopen(opts.journalPath);
  try {
    for (const call of plan.calls) {
      if (call.journaled) continue;
      await journal.append({
        kind: "closer",
        callId: call.callId,
        outcome: call.outcome,
        result: call.result,
      });
    }
    if (journal.failed) return null;

    const stamp = (opts.now ?? (() => new Date()))().toISOString();
    const marker = {
      ...buildCrashMarker({
        steps: plan.calls.map((c) => ({ step: c.step, outcome: c.outcome })),
        changedFiles: plan.changedFiles,
      }),
      at: stamp,
    };
    opts.persister.appendBlock(marker);
    try {
      opts.persister.appendTurnEnd?.("interrupted", stamp);
    } catch {
      // The marker already ends the run for every reader; a missing
      // turn_end costs at most one regenerate check on the next open.
    }
    await journal.append({
      kind: "end",
      status: "interrupted",
      cause: "app-exit",
    });
    const record = [...opts.record, marker];
    return {
      record,
      lastTurnEnd: { outcome: "interrupted", atBlockCount: record.length },
      plan,
    };
  } finally {
    await journal.close();
  }
}

export interface ReapSummary {
  /** Journals whose processes were checked. */
  readonly journals: number;
  readonly fates: ReadonlyArray<{ pid: number; fate: JournalProcessFate }>;
}

/**
 * The launch reaper (ADR 0071 §1.6): for each journal the open index lists,
 * end the processes its run left running — a recorded process still running
 * AS THAT PROCESS (same pid, same start time), and whatever descends from
 * it (`processTree`: a launcher that exited with the app leaves the shell
 * and command it started) — and record what became of each. A run live in
 * this process or in another app is left alone. Each checked journal leaves
 * the index; one that could not be checked stays for the next launch.
 */
export async function reapOrphanedDispatches(
  journalDir: string,
  probe: ProcessProbe = systemProcessProbe,
): Promise<ReapSummary> {
  const fates: Array<{ pid: number; fate: JournalProcessFate }> = [];
  let journals = 0;
  // One read of the process table for the whole launch.
  let tableRead: Promise<readonly ProcessRow[]> | null = null;
  const rows = (): Promise<readonly ProcessRow[]> => {
    tableRead ??= probe.processes();
    return tableRead;
  };
  for (const name of await readJournalIndex(journalDir)) {
    const path = join(journalDir, name);
    if (DispatchJournal.isLive(path)) continue;
    const entries = await readDispatchJournal(path);
    if (entries === null) {
      await markJournalOpen(path, false);
      continue;
    }
    const start = entries[0]?.kind === "start" ? entries[0] : undefined;
    const host = await hostState(start?.host, probe);
    if (host !== "gone") continue;

    const targets = leftBehind(entries);
    const found: Array<{ pid: number; fate: JournalProcessFate }> = [];
    if (targets.length > 0) {
      let table: readonly ProcessRow[] | null;
      try {
        table = await rows();
      } catch {
        table = null;
      }
      // The latest moment the run's app is known to have lived: a child of a
      // process that is gone is ours only if it started before that.
      const notAfter = journalLastAlive(entries);
      for (const t of targets) {
        if (table === null) {
          found.push({ pid: t.pid, fate: "unverified" });
          continue;
        }
        const tree = await reachable(table, t, probe, notAfter);
        if (tree.length === 0) {
          // Neither it nor anything it started still runs.
          found.push({ pid: t.pid, fate: "gone" });
          continue;
        }
        try {
          await probe.kill(tree);
          found.push({ pid: t.pid, fate: "ended" });
        } catch {
          found.push({ pid: t.pid, fate: "unverified" });
        }
      }
      // The process queries took a while: if the session was opened and its
      // run continued meanwhile, the journal is a live run's now — its
      // entries belong to the new segment and its listing is the new run's
      // (review 2026-09-30). The fates are still returned; the journal is
      // left as it is.
      if (DispatchJournal.isLive(path)) {
        journals += 1;
        fates.push(...found);
        continue;
      }
      const journal = await DispatchJournal.reopen(path);
      for (const f of found) {
        await journal.append({ kind: "reap", pid: f.pid, fate: f.fate });
      }
      await journal.close();
    }
    journals += 1;
    fates.push(...found);
    if (found.every((f) => f.fate !== "unverified")) {
      await markJournalOpen(path, false);
    }
  }
  return { journals, fates };
}

interface LeftBehind {
  readonly pid: number;
  readonly startedAt: number;
  readonly msys?: { readonly pgid: number; readonly ps: string };
}

/**
 * What still runs of a recorded process: the process and its descendants
 * (`processTree`), and for an MSYS shell every member of its process group
 * — Cygwin's fork/exec leaves a command's Windows parent dead, so only
 * MSYS's own table leads there. A member must be no older than the shell,
 * and its own descendants come along. `notAfter` bounds a child of a
 * process that is gone (see `processTree`); a group member of a shell that
 * is gone is bounded the same way, since MSYS reuses its pids too.
 */
async function reachable(
  table: readonly ProcessRow[],
  t: LeftBehind,
  probe: ProcessProbe,
  notAfter?: number,
): Promise<number[]> {
  const opts = notAfter === undefined ? {} : { notAfter };
  const platform = probe.platform ?? process.platform;
  const found = new Set(processTree(table, t, platform, opts));
  if (t.msys !== undefined) {
    let msys: readonly MsysRow[] = [];
    try {
      msys = await probe.msysProcesses(t.msys.ps);
    } catch {
      // No MSYS table: what the Windows table reached is all there is.
    }
    const byPid = new Map(table.map((r) => [r.pid, r]));
    const shell = byPid.get(t.pid);
    const shellRuns =
      shell !== undefined && sameProcessStart(shell.startedAt, t.startedAt);
    const bound =
      !shellRuns && notAfter !== undefined
        ? notAfter + SAME_PROCESS_WINDOW_MS
        : Number.POSITIVE_INFINITY;
    for (const winpid of msysGroupWinpids(msys, {
      pgid: t.msys.pgid,
      winpid: t.pid,
    })) {
      const row = byPid.get(winpid);
      if (
        row === undefined ||
        row.startedAt + SAME_PROCESS_WINDOW_MS < t.startedAt ||
        row.startedAt > bound
      ) {
        continue;
      }
      for (const pid of processTree(table, row, platform, opts)) found.add(pid);
    }
  }
  return [...found];
}

/** Processes a journal's run started that have neither exited nor been
 *  checked by a relaunch. */
function leftBehind(entries: readonly DispatchJournalEntry[]): LeftBehind[] {
  const done = new Set<number>();
  for (const e of entries) {
    if (e.kind === "exit" || e.kind === "reap") done.add(e.pid);
  }
  const out: LeftBehind[] = [];
  for (const e of entries) {
    if (e.kind === "spawn" && !done.has(e.pid)) {
      out.push({
        pid: e.pid,
        startedAt: e.startedAt,
        ...(e.msys !== undefined ? { msys: e.msys } : {}),
      });
      done.add(e.pid);
    }
  }
  return out;
}

/**
 * A rewind that withdrew the turn a run belongs to deletes the run's
 * journal (ADR 0071 §1.1), so it is never sealed or continued — unless its
 * processes still wait for the reaper, which needs it.
 *
 * A rewind that withdrew only a 继续 turn (review 2026-09-30) cuts the
 * journal back to the segment before it: the continuation's `resume` and
 * everything after it go, so the run reads as it did before the 继续 — its
 * last `end` is the interrupted one again, and the offer returns. Keeping
 * the whole journal left the withdrawn segment's `end` in place, so the
 * offer never came back, and its messages would have been replayed by the
 * next 继续. The same exception holds: a withdrawn segment whose processes
 * still wait for the reaper is kept whole.
 */
export async function dropWithdrawnJournal(
  journalPath: string,
  recordLength: number,
): Promise<void> {
  const entries = await readDispatchJournal(journalPath);
  const start = entries?.[0];
  if (entries === null || start?.kind !== "start") return;
  if (start.recordLength === undefined) return;
  if (DispatchJournal.isLive(journalPath)) return;
  const listed = (await readJournalIndex(dirname(journalPath))).includes(
    basename(journalPath),
  );
  if (start.recordLength > recordLength) {
    if (listed && leftBehind(entries).length > 0) return;
    await unlink(journalPath).catch(() => undefined);
    if (listed) await markJournalOpen(journalPath, false);
    return;
  }
  const cut = entries.findIndex(
    (e) =>
      e.kind === "resume" &&
      e.recordLength !== undefined &&
      e.recordLength > recordLength,
  );
  if (cut === -1) return;
  if (listed && leftBehind(entries.slice(cut)).length > 0) return;
  await rewriteJournal(journalPath, entries.slice(0, cut)).catch(
    () => undefined,
  );
}

/** The journal's file replaced by these entries: written beside it, synced,
 *  renamed over — a cut is never seen half done. */
async function rewriteJournal(
  journalPath: string,
  entries: readonly DispatchJournalEntry[],
): Promise<void> {
  const tmp = `${journalPath}.rewind`;
  await writeFile(tmp, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
  const handle = await open(tmp, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, journalPath);
}
