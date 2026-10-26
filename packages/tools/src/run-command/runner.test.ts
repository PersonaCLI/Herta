import { describe, expect, it, vi } from "vitest";
import { LeftoverGroup, runCommand } from "./runner.js";

const POSIX = process.platform !== "win32";

const opts = (overrides: Partial<Parameters<typeof runCommand>[1]> = {}) => ({
  cwd: process.cwd(),
  timeoutMs: 5_000,
  signal: new AbortController().signal,
  maxBytesPerStream: 1_048_576,
  ...overrides,
});

describe.skipIf(!POSIX)("runCommand — POSIX", () => {
  it("runs `true` with exit 0", async () => {
    const r = await runCommand(["true"], opts());
    expect(r.cause).toBe("exited");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBe(0);
    expect(r.stderr.length).toBe(0);
  });

  it("runs `false` with exit 1", async () => {
    const r = await runCommand(["false"], opts());
    expect(r.cause).toBe("exited");
    expect(r.exitCode).toBe(1);
  });

  it("captures stdout from echo", async () => {
    const r = await runCommand(["sh", "-c", "echo hello"], opts());
    expect(r.cause).toBe("exited");
    expect(r.stdout.toString("utf-8")).toBe("hello\n");
  });

  it("captures stderr separately", async () => {
    const r = await runCommand(["sh", "-c", "echo err >&2"], opts());
    expect(r.cause).toBe("exited");
    expect(r.stderr.toString("utf-8")).toBe("err\n");
  });

  it("times out after timeoutMs", async () => {
    const r = await runCommand(["sleep", "5"], opts({ timeoutMs: 100 }));
    expect(r.cause).toBe("timeout");
    expect(r.timedOut).toBe(true);
  });

  it("aborts when external signal fires", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r = await runCommand(["sleep", "5"], opts({ signal: ac.signal }));
    expect(r.cause).toBe("aborted");
  });

  it("respects cwd", async () => {
    const r = await runCommand(["pwd"], opts({ cwd: "/tmp" }));
    expect(r.cause).toBe("exited");
    const out = r.stdout.toString("utf-8").trim();
    expect(out.endsWith("/tmp")).toBe(true);
  });

  it("caps stdout at maxBytesPerStream", async () => {
    const r = await runCommand(
      ["sh", "-c", "yes hello | head -c 200000"],
      opts({ maxBytesPerStream: 50_000 }),
    );
    expect(r.cause).toBe("exited");
    expect(r.stdout.length).toBeLessThanOrEqual(50_000);
    expect(r.stdoutBytes).toBeGreaterThanOrEqual(200_000);
  });

  it("returns not_found for nonexistent binary", async () => {
    const r = await runCommand(["this-binary-does-not-exist-9f7a4c2e"], opts());
    expect(r.cause).toBe("not_found");
  });
});

// Cross-platform (node is always available — it's running this test).
describe("runCommand — stream flush and timeout capture", () => {
  const node = process.execPath;

  it("captures a large final write flushed after process exit", async () => {
    // Regression for the exit-vs-close race: `exit` fires when the
    // process ends, but pipe `data` events for a big last write can
    // arrive after it. Resolving on `exit` silently truncated the tail.
    const size = 300_000;
    const r = await runCommand(
      [node, "-e", `process.stdout.write("x".repeat(${size}))`],
      opts(),
    );
    expect(r.cause).toBe("exited");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBe(size);
  });

  it("keeps output buffered before a timeout kill", async () => {
    // Generous timeoutMs: under full-suite load a node child can take
    // >500ms just to COLD-START, and a kill that lands before the -e
    // script runs captures "" (flaked 2026-07-04). 4s gives the write
    // ample margin while the spin keeps the process alive to be killed.
    const r = await runCommand(
      [
        node,
        "-e",
        'process.stdout.write("partial-marker\\n"); setInterval(() => {}, 1000)',
      ],
      opts({ timeoutMs: 4_000 }),
    );
    expect(r.cause).toBe("timeout");
    expect(r.timedOut).toBe(true);
    expect(r.stdout.toString("utf-8")).toContain("partial-marker");
  }, 20_000);
});

// Both platforms now (audit BL5). Windows fells the tree with `taskkill /T`;
// POSIX spawns detached and signals the process GROUP. Before BL5 the POSIX
// half used spawn's built-in `signal` kill, which reached only the direct
// child — so this test was Windows-gated and the POSIX orphan went unnoticed.
describe("runCommand — process-tree kill", () => {
  {
    const node = process.execPath;

    it("kills the whole process tree on timeout, not just the direct child (audit finding 15, BL5)", async () => {
      // Pre-fix, spawn's `signal` option terminated only the direct child;
      // grandchildren (rustc under cargo, pytest-xdist workers) were orphaned
      // on every timeout/abort.
      const script = [
        'const { spawn } = require("node:child_process");',
        'const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'process.stdout.write("GRANDCHILD:" + g.pid + ";");',
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const r = await runCommand(
        [node, "-e", script],
        opts({ timeoutMs: 4_000 }),
      );
      expect(r.cause).toBe("timeout");
      const pidStr = r.stdout.toString("utf-8").match(/GRANDCHILD:(\d+);/)?.[1];
      if (!pidStr) throw new Error("grandchild pid was not captured");
      const pid = Number(pidStr);
      // The tree kill is asynchronous (taskkill on Windows; the group signal
      // still has to be reaped on POSIX) — poll briefly.
      let alive = true;
      for (let i = 0; i < 50 && alive; i++) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch {
          alive = false;
        }
      }
      if (alive) {
        // Don't leave the orphan running when the assertion fails.
        try {
          process.kill(pid);
        } catch {}
      }
      expect(alive).toBe(false);
    }, 20_000);
  }
});

describe("LeftoverGroup — what a command left in its process group (Mac findings 2026-10-24, item 9)", () => {
  /** A fake POSIX: `process.kill(-pgid, 0)` answers from `alive`; a real
   *  signal empties the group. */
  function fakeGroups(alive: Set<number>) {
    const signals: Array<[number, string | number | undefined]> = [];
    const real = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    const spy = vi
      .spyOn(process, "kill")
      .mockImplementation((pid: number, sig?: string | number) => {
        signals.push([pid, sig]);
        if (!alive.has(-pid)) throw new Error("ESRCH");
        if (sig !== 0) alive.delete(-pid);
        return true;
      });
    return {
      signals,
      restore: () => {
        spy.mockRestore();
        if (real !== undefined)
          Object.defineProperty(process, "platform", real);
      },
    };
  }

  it("keeps a group with a member, ends it on kill, and forgets it", () => {
    const alive = new Set([4242]);
    const fake = fakeGroups(alive);
    try {
      const left = new LeftoverGroup();
      left.noteExit(4242);
      expect(left.alive()).toBe(true);
      left.kill();
      expect(fake.signals).toContainEqual([-4242, "SIGKILL"]);
      expect(left.alive()).toBe(false);
    } finally {
      fake.restore();
    }
  });

  it("never keeps an empty group, and forgets one that empties on its own", () => {
    const alive = new Set([7]);
    const fake = fakeGroups(alive);
    try {
      const empty = new LeftoverGroup();
      empty.noteExit(99); // nothing left in group 99
      expect(empty.alive()).toBe(false);
      const later = new LeftoverGroup();
      later.noteExit(7);
      alive.delete(7); // the server stops by itself
      expect(later.alive()).toBe(false);
      // A pid reused for a new group after that is never signalled.
      alive.add(7);
      later.kill();
      expect(fake.signals).not.toContainEqual([-7, "SIGKILL"]);
    } finally {
      fake.restore();
    }
  });
});
