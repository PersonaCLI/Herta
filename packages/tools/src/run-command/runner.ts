import { type ChildProcess, spawn } from "node:child_process";
import { childProcessEnv } from "../child-env.js";

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  maxBytesPerStream: number;
  /** Merged child environment (ADR 0025 slice 4); defaults to
   *  `childProcessEnv()` (process.env minus the AppImage launcher's entries).
   *  Callers must have vetted model-supplied keys through the env guard. */
  env?: NodeJS.ProcessEnv;
  /** The started process's pid, once it has one — the run's journal records
   *  it, so a relaunch can end a command the app died during (ADR 0071
   *  §1.6). */
  onSpawn?: (pid: number) => void;
  /** Each chunk as it arrives, from either stream, beyond the capture cap
   *  too — the live view (ADR 0073). Raw bytes; the caller decodes. */
  onOutput?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
}

/**
 * POSIX: whether process group `pgid` still has a member. A command started
 * with `detached: true` leads its own group, and what it BACKGROUNDS stays
 * in that group after it exits — `sh -c 'srv > log 2>&1 &'` ends at once and
 * leaves `srv` running there. Always false on Windows, which has no groups.
 */
export function groupAlive(pgid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The process group a detached child leaves behind (Mac findings
 * 2026-10-24, item 9): remembered at the child's exit only if a member is
 * alive then, so an id is never kept past its group's end for an unrelated
 * group to take over (the persistent shell's rule, review 2026-09-23); asked
 * again before every use, and forgotten once empty. Every POSIX system.
 */
export class LeftoverGroup {
  private pgid: number | null = null;

  /** At the child's exit: keep its group if something still runs there. */
  noteExit(pid: number | undefined): void {
    if (pid !== undefined && groupAlive(pid)) this.pgid = pid;
  }

  /** Whether something the child started still runs in its group. */
  alive(): boolean {
    if (this.pgid === null) return false;
    if (groupAlive(this.pgid)) return true;
    this.pgid = null;
    return false;
  }

  /** End what is left in the group; best-effort, then forgotten. */
  kill(): void {
    if (this.alive() && this.pgid !== null) {
      try {
        process.kill(-this.pgid, "SIGKILL");
      } catch {
        // emptied in between
      }
    }
    this.pgid = null;
  }
}

/**
 * Kill a child's WHOLE process tree. Windows has no process groups:
 * `child.kill()` terminates only the DIRECT child, orphaning
 * grandchildren (rustc under `cargo test`, a dev server's workers) —
 * there we use `taskkill /T /F`, with `child.kill()` as the fallback
 * when taskkill itself fails (an already-dead pid exits non-zero too;
 * killing a dead child is a harmless no-op). POSIX callers pass a
 * plain SIGKILL. Shared by the foreground timeout path and the
 * background command entries (ADR 0025 slice 4).
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (process.platform !== "win32") {
    // POSIX: signal the process GROUP (audit BL5). Both spawn sites pass
    // `detached: true`, which makes the child a group leader, so a negative
    // pid reaches its whole subtree — a bare child.kill() reaches only the
    // direct child and orphans `cargo test`'s rustc, pytest-xdist workers, a
    // dev server's children. Falls back to the direct kill if the group is
    // already gone (ESRCH) or the child never got a pid.
    if (pid === undefined) {
      child.kill("SIGKILL");
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead — killing a dead child is a no-op either way */
      }
    }
    return;
  }
  if (pid === undefined) return;
  try {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => child.kill());
    killer.on("close", (code) => {
      if (code !== 0) child.kill();
    });
  } catch {
    child.kill();
  }
}

export interface RawRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: Buffer;
  stdoutBytes: number;
  stderrBytes: number;
  durationMs: number;
  timedOut: boolean;
  cause: "exited" | "timeout" | "aborted" | "spawn_error" | "not_found";
  spawnError?: NodeJS.ErrnoException;
}

function combinedSignal(external: AbortSignal, timeoutMs: number): AbortSignal {
  const timer = AbortSignal.timeout(timeoutMs);
  return AbortSignal.any([external, timer]);
}

function isTimeoutReason(reason: unknown): boolean {
  if (
    reason !== null &&
    typeof reason === "object" &&
    "name" in reason &&
    (reason as { name?: unknown }).name === "TimeoutError"
  ) {
    return true;
  }
  return false;
}

export async function runCommand(
  argv: readonly string[],
  options: RunOptions,
): Promise<RawRunResult> {
  const start = process.hrtime.bigint();
  const signal = combinedSignal(options.signal, options.timeoutMs);

  return new Promise<RawRunResult>((resolve) => {
    let resolved = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutBuffered = 0;
    let stderrBuffered = 0;

    const finish = (
      partial: Omit<
        RawRunResult,
        "stdout" | "stderr" | "stdoutBytes" | "stderrBytes" | "durationMs"
      >,
    ) => {
      if (resolved) return;
      resolved = true;
      const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
      resolve({
        ...partial,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        stdoutBytes,
        stderrBytes,
        durationMs,
      });
    };

    // Neither platform kills a tree for free. Windows has no process groups,
    // so spawn's `signal` option terminates only the DIRECT child (2026-07-10
    // audit, finding 15) and we fell the tree with `taskkill /T`. POSIX HAS
    // groups but spawn's `signal` did not use them, so it orphaned
    // grandchildren just the same (audit BL5) — `detached: true` makes the
    // child a group leader and killProcessTree signals the negative pid.
    //
    // Side effect on POSIX, accepted: a detached child is in its own process
    // group, so a terminal Ctrl+C no longer reaches CLI-spawned children
    // directly. The CLI's own SIGINT handling aborts the run, which routes to
    // killProcessTree and takes the group down — the same path a timeout uses.
    const isWin = process.platform === "win32";

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0] as string, argv.slice(1), {
        cwd: options.cwd,
        shell: false,
        ...(isWin ? {} : { detached: true }),
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ?? childProcessEnv(),
        windowsHide: true,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const cause: RawRunResult["cause"] =
        e.code === "ENOENT" ? "not_found" : "spawn_error";
      finish({
        exitCode: null,
        signal: null,
        timedOut: false,
        cause,
        spawnError: e,
      });
      return;
    }

    if (child.pid !== undefined) options.onSpawn?.(child.pid);

    // Both platforms now route abort through killProcessTree — the `signal`
    // spawn option is gone, so this is the only path that stops a run.
    {
      const killTree = () => killProcessTree(child);
      if (signal.aborted) {
        killTree();
      } else {
        signal.addEventListener("abort", killTree, { once: true });
        child.on("close", () => signal.removeEventListener("abort", killTree));
      }
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (signal.aborted) {
        const cause: RawRunResult["cause"] = isTimeoutReason(signal.reason)
          ? "timeout"
          : "aborted";
        finish({
          exitCode: null,
          signal: null,
          timedOut: cause === "timeout",
          cause,
        });
        return;
      }
      const cause: RawRunResult["cause"] =
        err.code === "ENOENT" ? "not_found" : "spawn_error";
      finish({
        exitCode: null,
        signal: null,
        timedOut: false,
        cause,
        spawnError: err,
      });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      options.onOutput?.(chunk, "stdout");
      stdoutBytes += chunk.length;
      const remaining = options.maxBytesPerStream - stdoutBuffered;
      if (remaining <= 0) return;
      if (chunk.length <= remaining) {
        stdoutChunks.push(chunk);
        stdoutBuffered += chunk.length;
      } else {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBuffered += remaining;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      options.onOutput?.(chunk, "stderr");
      stderrBytes += chunk.length;
      const remaining = options.maxBytesPerStream - stderrBuffered;
      if (remaining <= 0) return;
      if (chunk.length <= remaining) {
        stderrChunks.push(chunk);
        stderrBuffered += chunk.length;
      } else {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBuffered += remaining;
      }
    });

    // `close`, not `exit`: exit fires when the PROCESS ends, but pipe `data`
    // events can still arrive after it for chatty processes — finishing there
    // silently dropped trailing stdout/stderr (the `↳ exit 0 · N lines`
    // block, the prompt tail, and the "full" .herta/logs entry all
    // under-reported, with no truncation flag). `close` fires once all stdio
    // streams have flushed.
    child.on("close", (code, sig) => {
      if (resolved) return;
      if (signal.aborted) {
        const cause: RawRunResult["cause"] = isTimeoutReason(signal.reason)
          ? "timeout"
          : "aborted";
        finish({
          exitCode: code,
          signal: sig,
          timedOut: cause === "timeout",
          cause,
        });
        return;
      }
      finish({
        exitCode: code,
        signal: sig,
        timedOut: false,
        cause: "exited",
      });
    });
  });
}
