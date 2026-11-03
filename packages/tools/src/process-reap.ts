import { execFile } from "node:child_process";

/**
 * Finding and ending the processes a run left behind when the app exited
 * (ADR 0071 §1.6). A pid alone is not an identity — the OS reuses them —
 * so a process is only ever ended when it is the one the run started (same
 * pid, same start time), or descends from it.
 *
 * Descent, not just the recorded pid: the pid a run records is often a
 * launcher. Git for Windows' `bin\bash.exe` starts `usr\bin\bash.exe` and
 * exited with the app, leaving the real shell and the command it was
 * running (seen live, 2026-09-28). An orphan keeps its dead parent's id
 * (Windows) or its process group (POSIX), which is how it is found.
 *
 * Asynchronous throughout: this runs on the desktop app's main thread
 * (ADR 0068).
 */

/** How far apart the journal's start time and the OS's may be and still
 *  name the same process. The journal stamps a spawn just after it returns,
 *  and `ps` reports whole seconds; a reused pid starting within this window
 *  of the original is not a practical case. */
export const SAME_PROCESS_WINDOW_MS = 5_000;

/** How long one process-table query may take. */
const QUERY_TIMEOUT_MS = 20_000;

/** True when two start times name the same process. */
export function sameProcessStart(a: number, b: number): boolean {
  return Math.abs(a - b) <= SAME_PROCESS_WINDOW_MS;
}

/** One running process: its parent's id (which an orphan keeps), its
 *  process group (POSIX), and when it started (epoch ms). */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid?: number;
  readonly startedAt: number;
}

/** Every running process. Rejects when the table cannot be read, so the
 *  caller can tell "gone" from "could not check". `timeoutMs` bounds the
 *  query (20 s when absent): on Windows it is a PowerShell start and a WMI
 *  read, seconds even on a quiet machine, and a test that runs it beside a
 *  loaded suite gives it longer. */
export async function listProcesses(
  opts: { readonly timeoutMs?: number } = {},
): Promise<ProcessRow[]> {
  const timeoutMs = opts.timeoutMs ?? QUERY_TIMEOUT_MS;
  return process.platform === "win32"
    ? windowsProcesses(timeoutMs)
    : posixProcesses(timeoutMs);
}

async function windowsProcesses(timeoutMs: number): Promise<ProcessRow[]> {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object " +
    "{ '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
  const out = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    undefined,
    timeoutMs,
  );
  if (out.code !== 0) {
    throw new Error(`the process query failed (exit ${out.code})`);
  }
  const rows: ProcessRow[] = [];
  for (const line of out.stdout.split(/\r?\n/)) {
    const m = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
    if (m !== null) {
      rows.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        startedAt: Number(m[3]),
      });
    }
  }
  if (rows.length === 0) throw new Error("the process query answered nothing");
  return rows;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

async function posixProcesses(timeoutMs: number): Promise<ProcessRow[]> {
  // `lstart` in the C locale: `Mon Sep 28 20:14:41 2026`, local time.
  const out = await run(
    "ps",
    ["-A", "-o", "pid=,ppid=,pgid=,lstart="],
    { ...process.env, LC_ALL: "C" },
    timeoutMs,
  );
  if (out.code !== 0) {
    throw new Error(`the process query failed (exit ${out.code})`);
  }
  const rows: ProcessRow[] = [];
  for (const line of out.stdout.split("\n")) {
    const m =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(
        line,
      );
    if (m === null) continue;
    const month = MONTHS.indexOf(m[4] as string);
    if (month < 0) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      startedAt: new Date(
        Number(m[9]),
        month,
        Number(m[5]),
        Number(m[6]),
        Number(m[7]),
        Number(m[8]),
      ).getTime(),
    });
  }
  if (rows.length === 0) throw new Error("the process query answered nothing");
  return rows;
}

/**
 * The running processes that are, or descend from, the process a run
 * recorded (`pid`, started at `startedAt`). Empty when nothing of it runs.
 *
 * - The recorded process itself, when its pid still runs AS it (start time).
 * - Windows: everything below it by parent id. A parent's death does not
 *   rewrite its children's parent id, so a launcher that exited still leads
 *   to what it started. Each child must have started after its parent, and
 *   when the parent's pid now names a later process, before that one — its
 *   own children are someone else's.
 *   A parent that is GONE has one more bound, `notAfter`: the pid may have
 *   been held in between by a process that started children of its own and
 *   exited — Windows reuses pids fast, and hours may pass before the
 *   relaunch — so a child of a dead parent is taken only when it started
 *   while the run's app was still alive (review 2026-09-30). A child the
 *   launcher started after the app died is left alone: that is the safe
 *   direction, and the launcher itself is caught when it still runs.
 *   Once a node is found running, its own children need no such bound: it
 *   has held its pid since it started.
 * - POSIX: the members of its process group (the run's commands are group
 *   leaders, and an orphan keeps its group) that started after it — unless
 *   the pid now names a later process, which the kernel only allows once
 *   the group is empty. A leader that is GONE takes the same `notAfter`
 *   bound: the kernel hands its pid out again once the group empties, and a
 *   later leader that took it, formed its own group and exited leaves
 *   members that look exactly like ours (CI 2026-09-30 — the morning's bound
 *   had reached only the Windows walk).
 */
export function processTree(
  rows: readonly ProcessRow[],
  root: { readonly pid: number; readonly startedAt: number },
  platform: NodeJS.Platform = process.platform,
  opts: { readonly notAfter?: number } = {},
): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const holder = byPid.get(root.pid);
  const rootRuns =
    holder !== undefined && sameProcessStart(holder.startedAt, root.startedAt);
  const reused = holder !== undefined && !rootRuns;
  const notAfter =
    opts.notAfter === undefined
      ? Number.POSITIVE_INFINITY
      : opts.notAfter + SAME_PROCESS_WINDOW_MS;

  if (platform !== "win32") {
    if (reused) return [];
    const found = rows
      .filter(
        (r) =>
          r.pgid === root.pid &&
          r.startedAt + SAME_PROCESS_WINDOW_MS >= root.startedAt &&
          (rootRuns || r.startedAt <= notAfter),
      )
      .map((r) => r.pid);
    if (rootRuns && !found.includes(root.pid)) found.unshift(root.pid);
    return found;
  }

  const children = new Map<number, ProcessRow[]>();
  for (const r of rows) {
    if (r.pid === r.ppid) continue;
    const list = children.get(r.ppid) ?? [];
    list.push(r);
    children.set(r.ppid, list);
  }
  const found: number[] = rootRuns ? [root.pid] : [];
  const seen = new Set<number>(found);
  const walk = (pid: number, startedAt: number): void => {
    const now = byPid.get(pid);
    const runs =
      now !== undefined && sameProcessStart(now.startedAt, startedAt);
    // The pid now names a process that is not ours: children it started
    // after it began are its own.
    const reusedAt =
      now !== undefined && !runs ? now.startedAt : Number.POSITIVE_INFINITY;
    for (const c of children.get(pid) ?? []) {
      if (seen.has(c.pid)) continue;
      if (c.startedAt + SAME_PROCESS_WINDOW_MS < startedAt) continue;
      if (c.startedAt >= reusedAt) continue;
      if (!runs && c.startedAt > notAfter) continue;
      seen.add(c.pid);
      found.push(c.pid);
      walk(c.pid, c.startedAt);
    }
  };
  walk(root.pid, root.startedAt);
  return found;
}

/** End these processes. Windows: one `taskkill /F` for all of them (a pid
 *  already gone is the outcome wanted). POSIX: SIGKILL each. Rejects only
 *  when the kill could not be attempted. */
export async function killProcesses(pids: readonly number[]): Promise<void> {
  if (pids.length === 0) return;
  if (process.platform === "win32") {
    const out = await run("taskkill", [
      "/F",
      ...pids.flatMap((p) => ["/PID", String(p)]),
    ]);
    // 128: a listed process was already gone.
    if (out.code !== 0 && out.code !== 128) {
      throw new Error(`taskkill failed (exit ${out.code})`);
    }
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function run(
  file: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = QUERY_TIMEOUT_MS,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1 << 24,
        ...(env !== undefined ? { env } : {}),
      },
      (err, stdout) => {
        if (err === null) {
          resolve({ code: 0, stdout });
          return;
        }
        const code = (err as { code?: unknown }).code;
        // A number is the program's exit code: it ran. Anything else
        // (ENOENT, a timeout's kill) means it did not answer.
        if (typeof code === "number") resolve({ code, stdout });
        else reject(err);
      },
    );
  });
}
