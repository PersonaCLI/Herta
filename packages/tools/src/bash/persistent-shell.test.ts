import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listProcesses, processTree } from "../process-reap.js";
import { removeTmpDir } from "../testing/tmp-workspace.js";
import { findBash } from "./find-bash.js";
import { PersistentShell } from "./persistent-shell.js";
import { makeMsysPaths, shellPathsFor } from "./shell-paths.js";

// Real bash processes: comfortably over the 5 s default under suite load; the
// hook budget covers removeTmpDir's patient teardown on Windows.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const BASH = findBash();
const d = describe.skipIf(BASH === null);

let ws: string;
let shell: PersistentShell;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "psh-")));
  shell = new PersistentShell({ bashPath: BASH as string, workspaceRoot: ws });
});
afterEach(async () => {
  await shell.kill();
  await removeTmpDir(ws);
});

d("PersistentShell (real bash)", () => {
  it.skipIf(process.platform !== "win32")(
    "says its own Windows pid — the shell under the launcher, above what it runs (ADR 0071 §1.6)",
    async () => {
      const said: number[] = [];
      const own = new PersistentShell({
        bashPath: BASH as string,
        workspaceRoot: ws,
        onShellPid: (pid) => said.push(pid),
      });
      try {
        const r = await own.run(
          "sleep 30 >/dev/null 2>&1 & cat /proc/$!/winpid",
          { timeoutMs: 10_000 },
        );
        // The protocol line never reaches a command's output.
        expect(r.output).not.toContain("__HERTA_PD_");
        const sleeper = Number(r.output.trim());
        expect(said).toHaveLength(1);
        const rows = await listProcesses();
        const shellRow = rows.find((row) => row.pid === said[0]);
        expect(shellRow).toBeDefined();
        // Windows' parent ids do not lead from the shell to the command
        // (Cygwin's fork/exec); MSYS's process group does.
        expect(said[0]).not.toBe(sleeper);
        expect(
          processTree(rows, {
            pid: said[0] as number,
            startedAt: shellRow?.startedAt as number,
          }),
        ).toContain(said[0]);
      } finally {
        await own.kill();
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "kill() ends a job the shell backgrounded, on Windows too (2026-09-28)",
    async () => {
      // `taskkill /T` from the launcher never reached it: the job's Windows
      // parent is a forked bash that exited on exec. A dev server started
      // with `&` outlived every brief.
      const r = await shell.run(
        "sleep 45 >/dev/null 2>&1 & cat /proc/$!/winpid",
        { timeoutMs: 10_000 },
      );
      const job = Number(r.output.trim());
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive(job)).toBe(true);
      try {
        await shell.kill();
        const until = Date.now() + 5_000;
        while (alive(job) && Date.now() < until) {
          await new Promise((res) => setTimeout(res, 100));
        }
        expect(alive(job)).toBe(false);
      } finally {
        if (alive(job)) process.kill(job);
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "kill() also ends what a shell that exited on its own left in its group",
    async () => {
      // `nohup`: a plain `&` job dies with the shell's exit; this one usually
      // does not, and then only the group still leads to it. Under a loaded
      // suite it sometimes goes down with the shell's launcher anyway — then
      // there is nothing left to end, and the test still holds kill() to
      // leaving nothing running and forgetting the group.
      const r = await shell.run(
        "nohup sleep 45 >/dev/null 2>&1 & cat /proc/$!/winpid",
        { timeoutMs: 10_000 },
      );
      const job = Number(r.output.trim());
      const exited = await shell.run("exit 1", { timeoutMs: 10_000 });
      expect(exited.shellExited).toBe(true);
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        // The exited shell's group is remembered whether or not the job
        // outlived it: only kill() can read MSYS to find out.
        expect(shell.isRunning()).toBe(true);
        await shell.kill();
        const until = Date.now() + 5_000;
        while (alive(job) && Date.now() < until) {
          await new Promise((res) => setTimeout(res, 100));
        }
        expect(alive(job)).toBe(false);
        expect(shell.isRunning()).toBe(false);
      } finally {
        if (alive(job)) process.kill(job);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "a job backgrounded before the shell EXITED is still counted and killed at brief end (2026-09-23)",
    async () => {
      // The dev-server shape: background it, then a later call ends the
      // shell (`set -e` + a failure, or a plain `exit`).
      const r = await shell.run("sleep 60 >/dev/null 2>&1 & echo $!", {
        timeoutMs: 10_000,
      });
      const jobPid = Number(r.output.trim());
      expect(jobPid).toBeGreaterThan(0);
      const exited = await shell.run("exit 1", { timeoutMs: 10_000 });
      expect(exited.shellExited).toBe(true);
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive(jobPid)).toBe(true);
      // The shell is gone, but what it started is not: the BackgroundHost
      // must still see this entry as running, or stopAll skips it.
      expect(shell.isRunning()).toBe(true);
      await shell.kill();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(alive(jobPid)).toBe(false);
      expect(shell.isRunning()).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "a shell that exits with nothing behind it, or that kill() ended, leaves no group id to reuse (review 2026-09-23)",
    async () => {
      const exited = await shell.run("exit 1", { timeoutMs: 10_000 });
      expect(exited.shellExited).toBe(true);
      // Nothing was backgrounded: the empty group is not remembered, so no
      // stale id sits there for a later, unrelated group to take over.
      expect(shell.isRunning()).toBe(false);
      await shell.run("true", { timeoutMs: 10_000 });
      expect(shell.isRunning()).toBe(true);
      await shell.kill();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(shell.isRunning()).toBe(false);
    },
  );

  it("runs a command, merges stderr in order, reports the exit code", async () => {
    // Natural output — the command's own trailing newline is kept. `(exit 3)`
    // in a subshell: a top-level `exit` really exits the shell (bash
    // semantics; the tool reports "[shell exited]" and respawns next call).
    const r = await shell.run("echo out; echo err 1>&2; (exit 3)", {
      timeoutMs: 10_000,
    });
    expect(r.output).toBe("out\nerr\n");
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.freshShell).toBe(true);
    expect(r.cwdReset).toBe(false);
  });

  it("keeps cwd, variables and functions across calls (the trained shape's persistence)", async () => {
    writeFileSync(join(ws, "a.txt"), "A\n");
    await shell.run(
      "mkdir sub && cd sub && export FOO=bar && f() { echo fn:$1; }",
      { timeoutMs: 10_000 },
    );
    const r = await shell.run("pwd; echo $FOO; f x; ls ../a.txt", {
      timeoutMs: 10_000,
    });
    expect(r.freshShell).toBe(false);
    expect(r.output.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/\/sub$/),
      "bar",
      "fn:x",
      "../a.txt",
    ]);
    expect(r.cwd).toBe(join(ws, "sub"));
    expect(shell.cwd).toBe(join(ws, "sub"));
  });

  it("a stdin-reading command cannot eat the next command (stdin is /dev/null)", async () => {
    const r = await shell.run("cat", { timeoutMs: 10_000 });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("");
    const r2 = await shell.run("echo still-alive", { timeoutMs: 10_000 });
    expect(r2.output).toBe("still-alive\n");
    expect(r2.freshShell).toBe(false);
  });

  it("heredocs work inside the wrapper (they read the script, not stdin)", async () => {
    const r = await shell.run(
      "cat > h.txt <<'EOF'\nline1\nline2\nEOF\ncat h.txt",
      { timeoutMs: 10_000 },
    );
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("line1\nline2\n");
  });

  it("a `set -e` in one call does not make the next call's first failure kill the shell", async () => {
    await shell.run("set -e; export A=1", { timeoutMs: 10_000 });
    const r = await shell.run("false; echo A=$A", { timeoutMs: 10_000 });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe("A=1\n");
    expect(r.freshShell).toBe(false);
  });

  it("puts the shell back into the workspace when a command leaves it, and says so", async () => {
    const r = await shell.run("cd .. && pwd", { timeoutMs: 10_000 });
    expect(r.cwdReset).toBe(true);
    expect(r.cwd).toBe(ws);
    const r2 = await shell.run("pwd", { timeoutMs: 10_000 });
    expect(
      shellPathsFor(BASH).toNative(r2.output.trim()) ?? r2.output.trim(),
    ).toBe(ws);
  });

  it("times out a hung command, kills the tree, and the next call gets a fresh shell", async () => {
    await shell.run("export KEEP=1", { timeoutMs: 10_000 });
    const r = await shell.run("echo before; sleep 30; echo after", {
      timeoutMs: 800,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.output).toContain("before");
    expect(shell.isRunning()).toBe(false);
    const r2 = await shell.run("echo KEEP=$KEEP", { timeoutMs: 10_000 });
    expect(r2.freshShell).toBe(true);
    expect(r2.output).toBe("KEEP=\n");
    expect(shell.spawns).toBe(2);
  });

  it("after a timeout, an exit or a kill, cwd says where the next command will run — the workspace, not a `cd` the lost shell took with it (release review 2026-10-22)", async () => {
    mkdirSync(join(ws, "sub"));
    await shell.run("cd sub", { timeoutMs: 10_000 });
    expect(shell.cwd).toBe(join(ws, "sub"));
    const r = await shell.run("sleep 30", { timeoutMs: 800 });
    expect(r.timedOut).toBe(true);
    expect(shell.cwd).toBe(ws);
    // The shell's own exit, and a kill, the same.
    await shell.run("cd sub", { timeoutMs: 10_000 });
    expect(shell.cwd).toBe(join(ws, "sub"));
    await shell.run("exit 3", { timeoutMs: 10_000 });
    expect(shell.cwd).toBe(ws);
    await shell.run("cd sub", { timeoutMs: 10_000 });
    await shell.kill();
    expect(shell.cwd).toBe(ws);
    // And it is where the next command does run.
    const next = await shell.run("pwd", { timeoutMs: 10_000 });
    expect(
      shellPathsFor(BASH as string).toNative(next.output.trim()) ??
        next.output.trim(),
    ).toBe(ws);
  });

  it("bounds a chatty command: keeps the tail, counts the total", async () => {
    const small = new PersistentShell({
      bashPath: BASH as string,
      workspaceRoot: ws,
      maxOutputBytes: 2_000,
    });
    try {
      const r = await small.run(
        "for i in $(seq 1 2000); do echo line-$i-xxxxxxxxxxxxxxxxxxxx; done",
        {
          timeoutMs: 20_000,
        },
      );
      expect(r.capped).toBe(true);
      expect(r.outputBytes).toBeGreaterThan(50_000);
      expect(r.output.length).toBeLessThan(2_400);
      expect(r.output).toContain("line-2000-");
      expect(r.output.startsWith("[earlier output dropped")).toBe(true);
    } finally {
      await small.kill();
    }
  });

  it("the pump looks only at the newest window, and the totals stay EXACT — several cuts, a marker behind megabytes, then an ordinary command (perf audit 2026-09-20)", async () => {
    // The pump used to search the whole buffer on every chunk (a flatten — a
    // copy — of everything received so far). It now tests the newest window
    // and trims in amortized steps; nothing about the RESULT may move.
    // 40 000 lines × 32 bytes (31 characters + the newline) = 1 280 000 bytes
    // through a 50 000-byte cap: many amortized cuts, the marker arriving
    // long after the first chunk.
    const small = new PersistentShell({
      bashPath: BASH as string,
      workspaceRoot: ws,
      maxOutputBytes: 50_000,
    });
    try {
      const r = await small.run(
        "for i in $(seq -w 1 40000); do echo line-$i-xxxxxxxxxxxxxxxxxxxx; done",
        { timeoutMs: 60_000 },
      );
      expect(r.exitCode).toBe(0);
      expect(r.capped).toBe(true);
      // Exact accounting: every byte is either kept or counted as dropped.
      expect(r.outputBytes).toBe(40_000 * 32);
      expect(r.output.startsWith("[earlier output dropped")).toBe(true);
      expect(
        r.output.trimEnd().endsWith("line-40000-xxxxxxxxxxxxxxxxxxxx"),
      ).toBe(true);
      const body = r.output.slice(r.output.indexOf("\n") + 1);
      expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(50_000);
      // The lines that survived are the LAST ones, contiguous and in order.
      const kept = body.split("\n").filter((l) => /^line-\d{5}-x+$/.test(l));
      expect(kept.length).toBeGreaterThan(1_500);
      const first = Number(kept[0]?.slice(5, 10));
      kept.forEach((l, i) => {
        expect(Number(l.slice(5, 10))).toBe(first + i);
      });
      // The shell is still in step: the next command's output is its own.
      const next = await small.run("echo after", { timeoutMs: 10_000 });
      expect(next.output).toBe("after\n");
      expect(next.capped).toBe(false);
    } finally {
      await small.kill();
    }
  }, 90_000);

  it("registers as an INTERNAL background process and kill() is idempotent", async () => {
    expect(shell.internal).toBe(true);
    expect(shell.id).toBe("shell");
    await shell.run("true", { timeoutMs: 10_000 });
    expect(shell.isRunning()).toBe(true);
    await shell.kill();
    await shell.kill();
    expect(shell.isRunning()).toBe(false);
  });

  it("knows how the shell spells the workspace", async () => {
    await shell.run("true", { timeoutMs: 10_000 });
    const spelled = shell.workspaceShellPath;
    const r = await shell.run("pwd", { timeoutMs: 10_000 });
    expect(r.output.trim()).toBe(spelled);
  });
});

// win32-only: makeMsysPaths builds on node:path `resolve`, whose drive-letter
// semantics exist only there — on the Linux CI runner `resolve("E:\\repo")`
// is a RELATIVE join against cwd and the expectations are meaningless
// (scheduled CI 2026-08-18: 1 failed with `/home/runner/…/E:\repo\src`).
// The mapping itself is unreachable off-Windows: shellPathsFor returns the
// identity mapping on POSIX.
describe.skipIf(process.platform !== "win32")(
  "shell paths (MSYS mapping, pure)",
  () => {
    const p = makeMsysPaths("C:\\Users\\u\\AppData\\Local\\Temp");
    it("maps drive, cygdrive, /tmp and native forms; rejects relative and MSYS-internal roots", () => {
      expect(p.toNative("/e/repo/src")).toBe("E:\\repo\\src");
      expect(p.toNative("/cygdrive/c/x")).toBe("C:\\x");
      expect(p.toNative("/tmp/lab/ws")).toBe(
        "C:\\Users\\u\\AppData\\Local\\Temp\\lab\\ws",
      );
      expect(p.toNative("E:/repo/a.ts")).toBe("E:\\repo\\a.ts");
      expect(p.toNative("src/a.ts")).toBeNull();
      expect(p.toNative("/usr/bin")).toBeNull();
      expect(p.toShell("E:\\repo\\src")).toBe("/e/repo/src");
      expect(p.toShell("C:\\Users\\u\\AppData\\Local\\Temp\\lab")).toBe(
        "/tmp/lab",
      );
    });
  },
);
