import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { type BackgroundProcess, isPathInside } from "@herta/core";
import { type ShellPaths, shellPathsFor } from "./shell-paths.js";

/**
 * One persistent bash per brief (ADR 0040) — the trained shape's "state is
 * persistent across command calls": cwd, exported variables, functions and
 * background jobs survive from one `bash` call to the next inside a
 * commission, and die with it.
 *
 * Protocol: commands are written to the shell's stdin one at a time, each
 * wrapped in `{ … } </dev/null` (so a command that reads stdin cannot eat
 * the NEXT command) and followed by a marker line carrying the exit code,
 * a cwd-reset flag and `$PWD`. Output (stdout+stderr merged via `exec 2>&1`)
 * is everything before the marker. If the shell has `cd`'d out of the
 * workspace, the wrapper puts it back and says so — the permission
 * classifier reasons about relative paths against the workspace, and that
 * invariant must hold when the next command is classified.
 *
 * Timeout kills the whole process tree and the next call respawns a fresh
 * shell (state lost — the model is told). Registered with the brief's
 * BackgroundHost as an INTERNAL entry, so `stopAll()` at brief end reaps it
 * like any background process without reporting it as one.
 */
export interface ShellRunResult {
  /** Merged stdout+stderr, `\r\n` normalized, marker stripped, capped. */
  output: string;
  /** Total bytes observed before the cap. */
  outputBytes: number;
  capped: boolean;
  /** null on timeout or shell death. */
  exitCode: number | null;
  timedOut: boolean;
  shellExited: boolean;
  durationMs: number;
  /** Native cwd after the command (workspace when reset). */
  cwd: string;
  /** The command left the workspace; the shell was moved back. */
  cwdReset: boolean;
  /** This call spawned a fresh shell (first call, or after a reset). */
  freshShell: boolean;
}

export interface PersistentShellOpts {
  bashPath: string;
  workspaceRoot: string;
  /** Extra environment on top of the inherited one. */
  env?: Record<string, string>;
  /** Capture cap on merged output per command (default 1 MiB). */
  maxOutputBytes?: number;
}

/** BackgroundHost id under which the shell registers (internal). */
export const SHELL_BG_ID = "shell";

const DEFAULT_MAX_OUTPUT = 1_048_576;
const KILL_GRACE_MS = 3_000;

interface Waiter {
  marker: string;
  resolve: (r: Omit<ShellRunResult, "durationMs" | "freshShell">) => void;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  signal: AbortSignal | undefined;
  /** Bytes dropped from the FRONT while bounding a chatty command. */
  dropped: number;
  /** The shell process serving this command. */
  child: ChildProcess;
}

export class PersistentShell implements BackgroundProcess {
  readonly id = SHELL_BG_ID;
  readonly internal = true;
  readonly argv: readonly string[];
  readonly paths: ShellPaths;
  /** The shell's own spelling of the workspace (what `pwd` prints there). */
  private shellWs: string | null = null;
  private child: ChildProcess | null = null;
  private buf = "";
  private waiter: Waiter | null = null;
  private currentCwd: string;
  private spawnCount = 0;
  private readonly opts: Required<Omit<PersistentShellOpts, "env">> & {
    env: Record<string, string>;
  };

  constructor(opts: PersistentShellOpts) {
    this.opts = {
      bashPath: opts.bashPath,
      workspaceRoot: resolve(opts.workspaceRoot),
      env: opts.env ?? {},
      maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
    };
    this.argv = [opts.bashPath];
    this.paths = shellPathsFor(opts.bashPath);
    this.currentCwd = this.opts.workspaceRoot;
  }

  /** Native cwd the next command will start in. */
  get cwd(): string {
    return this.currentCwd;
  }

  /** How the shell spells the workspace (after the first spawn; before it,
   *  the best-effort mapping). */
  get workspaceShellPath(): string {
    return this.shellWs ?? this.paths.toShell(this.opts.workspaceRoot);
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  async kill(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null) return;
    await killTree(child);
    // Only a waiter still bound to THIS child fails; a fresh shell may
    // already be serving the next command by the time the kill settles.
    if (this.waiter?.child === child)
      this.failWaiter({ shellExited: true, timedOut: false });
  }

  private spawnShell(): void {
    this.spawnCount += 1;
    const isWin = process.platform === "win32";
    const bashDir = dirname(this.opts.bashPath);
    const gitRoot = dirname(bashDir);
    const extraPath = isWin
      ? [
          join(gitRoot, "usr", "bin"),
          join(gitRoot, "bin"),
          join(gitRoot, "mingw64", "bin"),
        ]
      : [];
    const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(extraPath.length > 0
        ? { PATH: [...extraPath, inheritedPath].join(isWin ? ";" : ":") }
        : {}),
      TERM: "dumb",
      PAGER: "cat",
      GIT_PAGER: "cat",
      // Never hang on a credential or editor prompt inside a headless shell.
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      PYTHONUNBUFFERED: "1",
      ...this.opts.env,
    };
    const child = spawn(this.opts.bashPath, ["--noprofile", "--norc"], {
      cwd: this.opts.workspaceRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // POSIX: own process group so a tree kill takes background jobs too.
      detached: !isWin,
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const onData = (chunk: string): void => {
      this.buf += chunk.replace(/\r\n/g, "\n");
      this.pump();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // Only THIS child's death fails a waiter that belongs to it — after a
    // timeout the old process may exit late, while a fresh shell is already
    // serving the next command.
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      if (this.waiter?.child === child)
        this.failWaiter({ shellExited: true, timedOut: false });
    });
    child.on("error", () => {
      if (this.child === child) this.child = null;
      if (this.waiter?.child === child)
        this.failWaiter({ shellExited: true, timedOut: false });
    });
    // Merge stderr into stdout in ORDER; remember the workspace spelling.
    child.stdin?.write('exec 2>&1\nset +o history\n__herta_ws="$(pwd)"\n');
    this.child = child;
    this.currentCwd = this.opts.workspaceRoot;
    if (this.shellWs === null) {
      // Ask once, synchronously, so `workspaceShellPath` is exact from the
      // first call (the model reads it in its prompt).
      try {
        const r = spawnSync(
          this.opts.bashPath,
          ["--noprofile", "--norc", "-c", "pwd"],
          {
            cwd: this.opts.workspaceRoot,
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
          },
        );
        const out = (r.stdout ?? "").trim().split(/\r?\n/)[0] ?? "";
        if (r.status === 0 && out.startsWith("/")) this.shellWs = out;
      } catch {
        // keep the mapping fallback
      }
    }
  }

  private failWaiter(how: { shellExited: boolean; timedOut: boolean }): void {
    const w = this.waiter;
    if (w === null) return;
    this.waiter = null;
    if (w.timer !== null) clearTimeout(w.timer);
    if (w.onAbort !== null && w.signal !== undefined)
      w.signal.removeEventListener("abort", w.onAbort);
    const output = this.buf;
    this.buf = "";
    w.resolve({
      output: output.replace(/\n$/, ""),
      outputBytes: Buffer.byteLength(output, "utf8"),
      capped: false,
      exitCode: null,
      timedOut: how.timedOut,
      shellExited: how.shellExited,
      cwd: this.currentCwd,
      cwdReset: false,
    });
  }

  private pump(): void {
    const w = this.waiter;
    if (w === null) return;
    const idx = this.buf.indexOf(w.marker);
    if (idx === -1) {
      // Bound memory while a chatty command runs (`yes`, a runaway log):
      // keep the last cap-worth plus a margin, count what was dropped.
      const limit = this.opts.maxOutputBytes + 4096;
      if (this.buf.length > limit) {
        const drop = this.buf.length - limit;
        w.dropped += Buffer.byteLength(this.buf.slice(0, drop), "utf8");
        this.buf = this.buf.slice(drop);
      }
      return;
    }
    const after = this.buf.slice(idx + w.marker.length);
    const m = /^:(-?\d+):([01]):([^\n]*)\n/.exec(after);
    if (m === null) return; // marker line not complete yet
    const rawOutput = this.buf.slice(0, idx).replace(/\n$/, "");
    this.buf = after.slice(m[0].length);
    this.waiter = null;
    if (w.timer !== null) clearTimeout(w.timer);
    if (w.onAbort !== null && w.signal !== undefined)
      w.signal.removeEventListener("abort", w.onAbort);
    const keptBytes = Buffer.byteLength(rawOutput, "utf8");
    const outputBytes = keptBytes + w.dropped;
    const capped = outputBytes > this.opts.maxOutputBytes;
    let output = rawOutput;
    if (keptBytes > this.opts.maxOutputBytes) {
      output = Buffer.from(rawOutput, "utf8")
        .subarray(keptBytes - this.opts.maxOutputBytes)
        .toString("utf8");
    }
    if (w.dropped > 0 || keptBytes > this.opts.maxOutputBytes) {
      output = `[earlier output dropped — ${outputBytes} bytes total, showing the last ${Math.min(keptBytes, this.opts.maxOutputBytes)}]\n${output}`;
    }
    const cwdReset = m[2] === "1";
    const pwdShell = m[3] as string;
    const native = this.paths.toNative(pwdShell);
    this.currentCwd =
      native !== null && isPathInside(this.opts.workspaceRoot, native)
        ? native
        : this.opts.workspaceRoot;
    w.resolve({
      output,
      outputBytes,
      capped,
      exitCode: Number(m[1]),
      timedOut: false,
      shellExited: false,
      cwd: this.currentCwd,
      cwdReset,
    });
  }

  /**
   * Run one command. Serialized: a second call while one is in flight waits
   * for it (the model calls tools one at a time anyway; the loop's parallel
   * batches only ever contain read-only tools, and bash is not one).
   */
  async run(
    command: string,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ShellRunResult> {
    while (this.waiter !== null) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const t0 = Date.now();
    let fresh = false;
    if (!this.isRunning()) {
      this.spawnShell();
      fresh = true;
    }
    const child = this.child;
    if (child === null || child.stdin === null) {
      return {
        output: "",
        outputBytes: 0,
        capped: false,
        exitCode: null,
        timedOut: false,
        shellExited: true,
        durationMs: Date.now() - t0,
        cwd: this.currentCwd,
        cwdReset: false,
        freshShell: fresh,
      };
    }
    const marker = `__HERTA_SH_${randomBytes(6).toString("hex")}__`;
    const result = await new Promise<
      Omit<ShellRunResult, "durationMs" | "freshShell">
    >((resolvePromise) => {
      const w: Waiter = {
        marker,
        resolve: resolvePromise,
        timer: null,
        onAbort: null,
        signal: opts.signal,
        dropped: 0,
        child,
      };
      w.timer = setTimeout(() => {
        // Timeout: the state is unknowable now — kill and let the next
        // call respawn. Deliver what was captured so far.
        this.waiter = null;
        const output = this.buf;
        this.buf = "";
        void this.kill();
        resolvePromise({
          output: output.replace(/\n$/, ""),
          outputBytes: Buffer.byteLength(output, "utf8"),
          capped: false,
          exitCode: null,
          timedOut: true,
          shellExited: false,
          cwd: this.opts.workspaceRoot,
          cwdReset: false,
        });
      }, opts.timeoutMs);
      if (opts.signal !== undefined) {
        w.onAbort = () => {
          this.waiter = null;
          if (w.timer !== null) clearTimeout(w.timer);
          const output = this.buf;
          this.buf = "";
          void this.kill();
          resolvePromise({
            output: output.replace(/\n$/, ""),
            outputBytes: Buffer.byteLength(output, "utf8"),
            capped: false,
            exitCode: null,
            timedOut: false,
            shellExited: true,
            cwd: this.opts.workspaceRoot,
            cwdReset: false,
          });
        };
        if (opts.signal.aborted) {
          w.onAbort();
          return;
        }
        opts.signal.addEventListener("abort", w.onAbort, { once: true });
      }
      this.waiter = w;
      // Group + stdin from /dev/null: a stdin-reading command cannot eat
      // the protocol line that follows. Heredocs still work — they are
      // read from the script text, not from the command's stdin.
      // `set +e +u` first: a `set -e` the model wrote in an earlier call must
      // not make THIS call's first non-zero status kill the shell (its own
      // `set -e` inside the command still applies within that command).
      const script = [
        "{",
        "set +e; set +u",
        command,
        "} </dev/null",
        `__herta_rc=$?; __herta_reset=0; case "$PWD/" in "$__herta_ws"/*) ;; *) cd "$__herta_ws" && __herta_reset=1 ;; esac; printf '\\n%s:%s:%s:%s\\n' '${marker}' "$__herta_rc" "$__herta_reset" "$PWD"`,
        "",
      ].join("\n");
      child.stdin?.write(script);
    });
    return { ...result, durationMs: Date.now() - t0, freshShell: fresh };
  }

  /** For tests / diagnostics. */
  get spawns(): number {
    return this.spawnCount;
  }
}

async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const closed = new Promise<void>((r) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      r();
      return;
    }
    child.once("exit", () => r());
    child.once("close", () => r());
  });
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: KILL_GRACE_MS,
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  await Promise.race([
    closed,
    new Promise<void>((r) => setTimeout(r, KILL_GRACE_MS)),
  ]);
}
