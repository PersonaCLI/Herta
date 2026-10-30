import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessProbe } from "./dispatch-recovery.js";
import { reapOrphanedServers, ServerJournal } from "./server-recovery.js";

/** The launcher's servers across an app exit (ADR 0083 §5): ended at the
 *  next launch, and the session they served told. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function journalFile(): string {
  const d = mkdtempSync(join(tmpdir(), "herta-servers-"));
  dirs.push(d);
  return join(d, "journal", "servers.json");
}

/** A process table: pid → start time, or [start, parent]. */
function probe(
  running: Record<number, number | [number, number]>,
  opts: { fails?: boolean } = {},
): ProcessProbe & { killed: number[] } {
  const killed: number[] = [];
  const rows = Object.entries(running).map(([pid, v]) => ({
    pid: Number(pid),
    ppid: Array.isArray(v) ? v[1] : 0,
    startedAt: Array.isArray(v) ? v[0] : v,
  }));
  return {
    killed,
    processes: async () => {
      if (opts.fails === true) throw new Error("no table");
      return rows;
    },
    msysProcesses: async () => [],
    kill: async (pids) => {
      killed.push(...pids);
    },
    alive: (pid) => running[pid] !== undefined,
    self: () => ({ pid: 1, startedAt: 0 }),
    platform: "win32",
  };
}

describe("the server journal and the launch reaper", () => {
  it("ends what a dead app's servers left running, with their children, and owes the session a note once", async () => {
    const file = journalFile();
    // The app that ran them (pid 500) is gone.
    const old = new ServerJournal(file, { pid: 500, startedAt: 1_000 });
    await old.spawned({
      pid: 900,
      startedAt: 50_000,
      name: "web",
      sessionId: "s1",
    });
    await old.spawned({
      pid: 901,
      startedAt: 60_000,
      name: "api",
      sessionId: "s1",
    });
    await old.spawned({
      pid: 902,
      startedAt: 70_000,
      name: "docs",
      sessionId: "s2",
    });
    await old.exited(901);
    const p = probe({
      900: 50_000,
      // vite's child of web's npm.
      950: [51_000, 900],
      // docs' pid now belongs to another program.
      902: 999_999,
    });
    const { ended } = await reapOrphanedServers(file, p);
    expect(ended).toBe(1);
    expect(p.killed.sort()).toEqual([900, 950]);
    const now = new ServerJournal(file, { pid: 1, startedAt: 0 });
    expect(await now.takeReaped("s1")).toEqual(["web"]);
    expect(await now.takeReaped("s1")).toEqual([]);
    expect(await now.takeReaped("s2")).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")).running).toEqual([]);
  });

  it("of a server that is gone, ends only the children that started while its app was alive (review 2026-10-30)", async () => {
    const file = journalFile();
    const old = new ServerJournal(file, { pid: 600, startedAt: 1_000 });
    const t0 = Date.now() - 60_000;
    await old.spawned({
      pid: 930,
      startedAt: t0,
      name: "web",
      sessionId: "s1",
    });
    const hours = 3 * 3600_000;
    const p = probe({
      // web's own child, still running after web went.
      960: [t0 + 1_000, 930],
      // 930 was reused after the app died; this is that program's child.
      961: [Date.now() + hours, 930],
    });
    expect((await reapOrphanedServers(file, p)).ended).toBe(1);
    expect(p.killed).toEqual([960]);
  });

  it("leaves a live app's servers alone, and keeps what it could not check", async () => {
    const file = journalFile();
    const live = new ServerJournal(file, { pid: 700, startedAt: 2_000 });
    await live.spawned({
      pid: 910,
      startedAt: 80_000,
      name: "web",
      sessionId: "s1",
    });
    // The app at 700 still runs, as the process that wrote it.
    const p = probe({ 700: 2_000, 910: 80_000 });
    expect((await reapOrphanedServers(file, p)).ended).toBe(0);
    expect(p.killed).toEqual([]);

    const gone = new ServerJournal(file, { pid: 800, startedAt: 3_000 });
    await gone.spawned({
      pid: 920,
      startedAt: 90_000,
      name: "api",
      sessionId: "s3",
    });
    // The table cannot be read: nothing ended, nothing forgotten.
    expect(
      (await reapOrphanedServers(file, probe({ 700: 2_000 }, { fails: true })))
        .ended,
    ).toBe(0);
    const running = JSON.parse(readFileSync(file, "utf8")).running as {
      pid: number;
    }[];
    expect(running.map((r) => r.pid).sort()).toEqual([910, 920]);
  });
});
