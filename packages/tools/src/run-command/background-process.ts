import { type ChildProcess, spawn } from "node:child_process";
import type { BackgroundProcess } from "@herta/core";
import { killProcessTree, LeftoverGroup } from "./runner.js";

const RING_MAX_BYTES = 256 * 1024;
const KILL_GRACE_MS = 3_000;

/**
 * A managed background command (ADR 0025 slice 4). Owns a spawned child,
 * keeps a bounded ring of its merged stdout+stderr for command_output to
 * read, and kills the whole tree on demand / at brief end. Output bytes
 * are counted continuously so command_output's `sinceByte` cursor is
 * stable even after the ring drops old bytes.
 */
export class SpawnedBackgroundProcess implements BackgroundProcess {
  readonly id: string;
  readonly argv: readonly string[];
  private readonly child: ChildProcess;
  private buf = Buffer.alloc(0);
  /** Total bytes ever observed (may exceed buf.length once the ring drops). */
  private totalBytes = 0;
  /** Bytes dropped off the FRONT of the ring (the cursor floor). */
  private droppedBytes = 0;
  private running = true;
  /** What the command backgrounded before it exited (`sh -c 'srv &'`). */
  private readonly leftover = new LeftoverGroup();
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private closePromise: Promise<void>;

  constructor(opts: {
    id: string;
    argv: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }) {
    this.id = opts.id;
    this.argv = opts.argv;
    this.child = spawn(opts.argv[0] as string, opts.argv.slice(1), {
      cwd: opts.cwd,
      shell: false,
      // Own process group on POSIX (audit BL5), so killProcessTree can signal
      // the whole subtree. A background dev server is exactly the case that
      // spawns workers, and reaping only the direct child left them running
      // after the brief ended.
      ...(process.platform === "win32" ? {} : { detached: true }),
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env,
      windowsHide: true,
    });

    const onChunk = (chunk: Buffer): void => {
      this.totalBytes += chunk.length;
      this.buf = Buffer.concat([this.buf, chunk]);
      if (this.buf.length > RING_MAX_BYTES) {
        const drop = this.buf.length - RING_MAX_BYTES;
        this.buf = this.buf.subarray(drop);
        this.droppedBytes += drop;
      }
    };
    this.child.stdout?.on("data", onChunk);
    this.child.stderr?.on("data", onChunk);

    this.closePromise = new Promise<void>((resolve) => {
      const settle = (code: number | null, sig: string | null): void => {
        if (!this.running) return;
        this.running = false;
        this.leftover.noteExit(this.child.pid);
        this.exitCode = code;
        this.exitSignal = sig;
        resolve();
      };
      this.child.on("close", (code, sig) => settle(code, sig));
      this.child.on("error", () => settle(null, null));
    });
  }

  /** The child's pid, once spawned (the run's journal records it). */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Resolves when the process has ended, however it ended. */
  closed(): Promise<void> {
    return this.closePromise;
  }

  /** Did the process fail to spawn at all (bad binary)? */
  spawnFailed(): Promise<boolean> {
    return new Promise((resolve) => {
      this.child.once("spawn", () => resolve(false));
      this.child.once("error", () => resolve(true));
    });
  }

  /**
   * The BackgroundHost's question at brief end: whether anything this
   * command started still runs — not whether the command itself does. A
   * `sh -c 'srv > log 2>&1 &'` exits at once, and `stopAll` skipped it while
   * `srv` held its port past the brief (Mac findings 2026-10-24, item 9).
   * `status()` still reports the command's own exit.
   */
  isRunning(): boolean {
    return this.running || this.leftover.alive();
  }

  status(): {
    running: boolean;
    exitCode: number | null;
    signal: string | null;
    totalBytes: number;
    droppedBytes: number;
  } {
    return {
      running: this.running,
      exitCode: this.exitCode,
      signal: this.exitSignal,
      totalBytes: this.totalBytes,
      droppedBytes: this.droppedBytes,
    };
  }

  /** Merged output from `sinceByte` onward. If the cursor points before
   *  the dropped floor, output starts at the floor and `elidedBytes`
   *  reports how many were skipped. */
  readSince(sinceByte: number): {
    text: string;
    nextByte: number;
    elidedBytes: number;
  } {
    const floor = this.droppedBytes;
    const from = Math.max(sinceByte, floor);
    const localStart = from - floor;
    const slice = this.buf.subarray(Math.max(0, localStart));
    return {
      text: slice.toString("utf-8"),
      nextByte: this.totalBytes,
      elidedBytes: from - sinceByte,
    };
  }

  async kill(): Promise<void> {
    if (!this.running) {
      this.leftover.kill();
      return;
    }
    killProcessTree(this.child);
    // Bounded wait: don't hang the brief's teardown on a wedged child.
    await Promise.race([
      this.closePromise,
      new Promise<void>((r) => setTimeout(r, KILL_GRACE_MS)),
    ]);
  }
}
