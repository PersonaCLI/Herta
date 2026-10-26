import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import {
  ensureHertaGitignore,
  type LaunchEntry,
  type ServerHost,
  ServerHostError,
  type ServerLogs,
  type ServerStarted,
  type ServerStarter,
  type ServerState,
  type ServerStatus,
} from "@herta/core";
import { childProcessEnv } from "../child-env.js";
import { LiveOutput } from "../run-command/live-output.js";
import { killProcessTree, LeftoverGroup } from "../run-command/runner.js";
import { resolveWindowsShim } from "../run-command/shim-wrapper.js";
import { entryCommand } from "./launch-file.js";

/** Where the servers' logs go, workspace-relative (ADR 0083 §5). */
export const SERVER_LOG_DIR = ".herta/logs/servers";
/** A server is ready when its port answers, within this bound. */
export const READY_TIMEOUT_MS = 60_000;
/** Each stream's share of a log, as for command logs. */
const LOG_CAP_BYTES = 1024 * 1024;
/** What `dev_server logs` can still read back, per server. */
const RING_MAX_CHARS = 256 * 1024;
const PROBE_EVERY_MS = 300;
const PROBE_TIMEOUT_MS = 1_000;
const KILL_GRACE_MS = 3_000;
/** The end of a log a failure carries. */
const TAIL_LINES = 20;
const TAIL_CHARS = 1_500;

/** Does anything answer HTTP on this port, on loopback (either family)? */
export async function portAnswers(
  port: number,
  secure = false,
): Promise<boolean> {
  const one = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const req = (secure ? httpsRequest : httpRequest)(
        {
          host,
          port,
          path: "/",
          method: "GET",
          timeout: PROBE_TIMEOUT_MS,
          // A dev server's certificate is its own (§8).
          ...(secure ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          res.resume();
          resolve(true);
        },
      );
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.on("error", () => resolve(false));
      req.end();
    });
  const [v4, v6] = await Promise.all([one("127.0.0.1"), one("::1")]);
  return v4 || v6;
}

export interface LauncherOptions {
  /** A server's pid at spawn — the relaunch journal (ADR 0083 §5: ended
   *  and reported at relaunch, as ADR 0071 does for a run's processes). */
  readonly onSpawn?: (s: {
    readonly pid: number;
    readonly name: string;
    readonly startedAt: number;
  }) => void;
  /** …and when it ended. */
  readonly onExit?: (pid: number) => void;
  /** Any server's state changed. */
  readonly onChange?: (status: ServerStatus) => void;
  readonly readyTimeoutMs?: number;
  /** Injectable for tests. */
  readonly probe?: (port: number, secure: boolean) => Promise<boolean>;
  readonly now?: () => Date;
}

interface Running {
  readonly entry: LaunchEntry;
  readonly by: ServerStarter;
  readonly child: ChildProcess;
  readonly logPath: string;
  readonly log: WriteStream;
  readonly closed: Promise<void>;
  /** What the command backgrounded before it exited (see `stopRunning`). */
  readonly leftover: LeftoverGroup;
  state: ServerState;
  exitCode?: number | null;
  stopping: boolean;
  ring: string;
  total: number;
  dropped: number;
}

/**
 * One session's dev servers (ADR 0083 §5): a third owner of processes,
 * beside a brief's `BackgroundHost` and the persistent shell. It keeps ADR
 * 0025's rule — no unmanaged backgrounding — by listing, logging and
 * stopping every server it starts; the session's owner stops them all when
 * the session goes, the workspace moves or the app quits.
 *
 * It runs what it is handed. Whether an entry may run is decided before
 * (the `dev_server` rule; the Trailblazer's Run), never here.
 */
export class Launcher implements ServerHost {
  private readonly servers = new Map<string, Running>();

  constructor(private readonly opts: LauncherOptions = {}) {}

  list(): readonly ServerStatus[] {
    return [...this.servers.values()].map((s) => this.statusOf(s));
  }

  status(name: string): ServerStatus | null {
    const s = this.servers.get(name);
    return s === undefined ? null : this.statusOf(s);
  }

  async start(
    entry: LaunchEntry,
    opts: { readonly by: ServerStarter; readonly signal?: AbortSignal },
  ): Promise<ServerStarted> {
    const mine = this.servers.get(entry.name);
    if (
      mine !== undefined &&
      (mine.state === "starting" || mine.state === "ready")
    ) {
      return { status: this.statusOf(mine), already: true };
    }
    const secure = entry.url.startsWith("https:");
    const probe = this.opts.probe ?? portAnswers;
    // A port that already answers is a server already running — the
    // Trailblazer's own terminal, say: not started twice (§5).
    if (await probe(entry.port, secure)) {
      return {
        status: {
          name: entry.name,
          state: "ready",
          port: entry.port,
          url: entry.url,
          command: entryCommand(entry),
          by: opts.by,
          logPath: "",
        },
        already: true,
      };
    }
    // The .cmd shims on Windows, wrapped exactly as run_command does —
    // after the rule judged the entry's own argv.
    const shim = resolveWindowsShim([entry.command, ...entry.args]);
    if (shim.kind === "unsafe_args") {
      throw new ServerHostError(
        "unsafe_args",
        `cannot start ${entry.command} on Windows safely: an argument holds a shell metacharacter (${shim.offending})`,
      );
    }
    const now = (this.opts.now ?? (() => new Date()))();
    const stamp = now.toISOString().replace(/[-:]/gu, "").replace(/\..*$/u, "");
    const logPath = `${SERVER_LOG_DIR}/${entry.name}-${stamp}.log`;
    await mkdir(join(entry.workspace, SERVER_LOG_DIR), { recursive: true });
    ensureHertaGitignore(entry.workspace);
    const log = createWriteStream(join(entry.workspace, logPath), {
      flags: "a",
    });
    log.on("error", () => undefined);
    log.write(
      `=== herta dev server log ===\nname: ${entry.name}\ncommand: ${entryCommand(entry)}\ncwd: ${entry.cwd}\nstarted: ${now.toISOString()}\n\n`,
    );

    const [program, ...args] = shim.argv;
    const child = spawn(program as string, args, {
      cwd: entry.cwd,
      shell: false,
      // Its own process group on POSIX, so a stop reaches its workers.
      ...(process.platform === "win32" ? {} : { detached: true }),
      stdio: ["ignore", "pipe", "pipe"],
      env: childProcessEnv(),
      windowsHide: true,
    });
    const spawned = await new Promise<boolean>((resolve) => {
      child.once("spawn", () => resolve(true));
      child.once("error", () => resolve(false));
    });
    if (!spawned || child.pid === undefined) {
      log.end(`could not start ${entry.command}\n`);
      throw new ServerHostError(
        "spawn_failed",
        `could not start ${entry.command} — is it installed, and on PATH?`,
      );
    }

    let settle: () => void = () => undefined;
    const running: Running = {
      entry,
      by: opts.by,
      child,
      logPath,
      log,
      closed: new Promise<void>((r) => {
        settle = r;
      }),
      leftover: new LeftoverGroup(),
      state: "starting",
      stopping: false,
      ring: "",
      total: 0,
      dropped: 0,
    };
    this.servers.set(entry.name, running);
    const pid = child.pid;
    this.opts.onSpawn?.({ pid, name: entry.name, startedAt: now.getTime() });
    this.wireOutput(running);
    child.on("close", (code) => {
      running.leftover.noteExit(pid);
      running.state = running.stopping ? "stopped" : "exited";
      running.exitCode = code;
      running.log.end(
        `\n=== ${running.stopping ? "stopped" : `exited (${code ?? "signal"})`} ===\n`,
      );
      this.opts.onExit?.(pid);
      this.changed(running);
      settle();
    });
    this.changed(running);

    // Ready when its port answers; not ready if it ends first, or the bound
    // passes, or the step is stopped — the last two stop it too.
    const deadline =
      Date.now() + (this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
    for (;;) {
      if (running.state !== "starting") {
        // A command that backgrounded the server and exited: what it left
        // must not hold the port behind a server listed as exited.
        running.leftover.kill();
        throw new ServerHostError(
          "exited",
          `${entry.name} exited${running.exitCode != null ? ` with code ${running.exitCode}` : ""} before port ${entry.port} answered`,
          tail(running.ring),
        );
      }
      if (opts.signal?.aborted === true) {
        await this.stopRunning(running);
        throw new ServerHostError(
          "aborted",
          `the start of ${entry.name} was stopped`,
        );
      }
      if (await probe(entry.port, secure)) break;
      if (Date.now() >= deadline) {
        await this.stopRunning(running);
        throw new ServerHostError(
          "timeout",
          `${entry.name}'s port ${entry.port} did not answer within ${Math.round((this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000)} s; it was stopped`,
          tail(running.ring),
        );
      }
      await Promise.race([
        new Promise((r) => setTimeout(r, PROBE_EVERY_MS)),
        running.closed,
      ]);
    }
    // The port answered — unless what answered is gone already.
    if (running.state !== "starting") {
      throw new ServerHostError(
        "exited",
        `${entry.name} exited before port ${entry.port} answered`,
        tail(running.ring),
      );
    }
    running.state = "ready";
    this.changed(running);
    return { status: this.statusOf(running), already: false };
  }

  logs(name: string, sinceByte: number): ServerLogs | null {
    const s = this.servers.get(name);
    if (s === undefined) return null;
    const from = Math.max(sinceByte, s.dropped);
    return {
      name,
      text: s.ring.slice(Math.max(0, from - s.dropped)),
      nextByte: s.total,
      elidedBytes: from - sinceByte,
      state: s.state,
      ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
    };
  }

  async stop(name: string): Promise<ServerStatus | null> {
    const s = this.servers.get(name);
    if (s === undefined) return null;
    await this.stopRunning(s);
    return this.statusOf(s);
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.servers.values()].map((s) => this.stopRunning(s)),
    );
  }

  /**
   * Stops the server and whatever its command left in its process group —
   * also once the command itself has exited: `sh -c 'srv &'` ends at once,
   * and stopping skipped it while `srv` ran on (Mac findings 2026-10-24,
   * item 9).
   */
  private async stopRunning(s: Running): Promise<void> {
    if (s.state !== "starting" && s.state !== "ready") {
      s.leftover.kill();
      return;
    }
    s.stopping = true;
    killProcessTree(s.child);
    await Promise.race([
      s.closed,
      new Promise<void>((r) => setTimeout(r, KILL_GRACE_MS)),
    ]);
  }

  /** Both streams into the log, redacted line by line and capped per
   *  stream, and into the ring `dev_server logs` reads. */
  private wireOutput(s: Running): void {
    const stream = (
      from: NodeJS.ReadableStream | null,
      label: string,
    ): void => {
      let logged = 0;
      let capped = false;
      const out = new LiveOutput((text) => {
        const line = `${text}\n`;
        this.remember(s, line);
        if (capped) return;
        logged += Buffer.byteLength(line);
        if (logged > LOG_CAP_BYTES) {
          capped = true;
          s.log.write(`… (${label} past ${LOG_CAP_BYTES} bytes: not logged)\n`);
          return;
        }
        s.log.write(line);
      });
      from?.setEncoding?.("utf8");
      from?.on("data", (chunk: string | Buffer) => out.push(String(chunk)));
      from?.on("end", () => out.flush());
    };
    stream(s.child.stdout, "stdout");
    stream(s.child.stderr, "stderr");
  }

  private remember(s: Running, text: string): void {
    s.ring += text;
    s.total += text.length;
    if (s.ring.length > RING_MAX_CHARS) {
      const drop = s.ring.length - RING_MAX_CHARS;
      s.ring = s.ring.slice(drop);
      s.dropped += drop;
    }
  }

  private changed(s: Running): void {
    this.opts.onChange?.(this.statusOf(s));
  }

  private statusOf(s: Running): ServerStatus {
    return {
      name: s.entry.name,
      state: s.state,
      port: s.entry.port,
      url: s.entry.url,
      command: entryCommand(s.entry),
      by: s.by,
      ...(s.child.pid !== undefined ? { pid: s.child.pid } : {}),
      logPath: s.logPath,
      ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
    };
  }
}

/** The end of a log: its last lines, bounded. */
function tail(ring: string): string {
  const lines = ring.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
  return lines.length > TAIL_CHARS ? `…${lines.slice(-TAIL_CHARS)}` : lines;
}
