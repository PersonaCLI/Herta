import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DispatchJournal,
  type DispatchJournalEntry,
  dispatchJournalDir,
  dispatchJournalPath,
  type JournalStartEntry,
  markJournalOpen,
  readDispatchJournal,
  readJournalIndex,
  readSessionFile,
  resumableRun,
  type TerminalRecordBlock,
  V2RecordPersister,
} from "@herta/core";
import { listProcesses } from "@herta/tools";
import { afterEach, describe, expect, it } from "vitest";
import {
  dropWithdrawnJournal,
  type ProcessProbe,
  reapOrphanedDispatches,
  sealOpenDispatch,
  systemProcessProbe,
} from "./dispatch-recovery.js";
import { spanEditedFiles } from "./session.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await removeTmpDir(d);
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The machine's own probe, with a patient process query. On Windows the
 *  query is a PowerShell start and a WMI read — seconds alone, and past the
 *  reaper's own 20 s in a loaded suite, where the reaper then rightly
 *  answered `unverified` (2026-11-03). The real tests check what the reaper
 *  does with a real table, not how fast the machine hands it over; their
 *  120 s budget is this minute and one for the rest. */
const patientProbe: ProcessProbe = {
  ...systemProcessProbe,
  processes: () => listProcesses({ timeoutMs: 60_000 }),
};

/** A process table: the running pids and their start times — and, for a
 *  process another started, `[startedAt, ppid, pgid]` (a group leader's
 *  descendants share its group). */
function probe(
  running: Record<number, number | [number, number, number]> = {},
  opts: {
    fails?: boolean;
    /** MSYS's table: [msys pid, pgid, winpid]. */
    msys?: Array<[number, number, number]>;
    /** Whose rules the table follows. A table that only makes sense under
     *  one platform's rules must say so — the parent-id walk's tests passed
     *  on Windows and failed on the Linux CI (2026-09-30). */
    platform?: NodeJS.Platform;
  } = {},
): ProcessProbe & { killed: number[] } {
  const killed: number[] = [];
  const rows = Object.entries(running).map(([pid, v]) => ({
    pid: Number(pid),
    ppid: Array.isArray(v) ? v[1] : 0,
    pgid: Array.isArray(v) ? v[2] : Number(pid),
    startedAt: Array.isArray(v) ? v[0] : v,
  }));
  return {
    killed,
    processes: async () => {
      if (opts.fails === true) throw new Error("no process query here");
      return rows;
    },
    msysProcesses: async () =>
      (opts.msys ?? []).map(([pid, pgid, winpid]) => ({
        pid,
        ppid: 1,
        pgid,
        winpid,
      })),
    kill: async (pids) => {
      killed.push(...pids);
    },
    alive: (pid) => running[pid] !== undefined,
    self: () => ({ pid: 1, startedAt: 0 }),
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
  };
}

const RECORD: TerminalRecordBlock[] = [
  { kind: "user", text: "fix a.ts" },
  { kind: "herta", surface: "thought", text: "…" },
  { kind: "herta", surface: "speech", text: "@板砖 fix a.ts" },
  { kind: "system", label: "差分协处理器", body: "Writing a.ts" },
];

/** A session whose app exited mid-dispatch: its record on disk (the
 *  dispatch began at block 3) and its journal, open. */
function crashed(
  entries: (ws: string) => DispatchJournalEntry[],
  record: TerminalRecordBlock[] = RECORD,
) {
  const root = mkdtempSync(join(tmpdir(), "herta-recovery-"));
  tmpDirs.push(root);
  const transcriptDir = join(root, "sessions");
  const ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  const persister = V2RecordPersister.forNewSession({
    sessionId: "s1",
    workspaceRoot: ws,
    startedAt: new Date("2026-09-28T10:00:00.000Z"),
    transcriptDir,
  });
  for (const b of record) persister.appendBlock(b);
  const journalPath = dispatchJournalPath(transcriptDir, "s1");
  mkdirSync(dispatchJournalDir(transcriptDir), { recursive: true });
  writeFileSync(
    journalPath,
    `${entries(ws)
      .map((e) => JSON.stringify(e))
      .join("\n")}\n`,
  );
  const sessionFile = join(transcriptDir, "s1.jsonl");
  return { root, ws, transcriptDir, journalPath, sessionFile };
}

function start(ws: string, over: Partial<JournalStartEntry> = {}) {
  return {
    kind: "start",
    v: 1,
    taskId: "t1",
    at: "2026-09-28T10:00:00.000Z",
    recordLength: 3,
    workspaceRoot: ws,
    host: { pid: 4242, startedAt: 1_000 },
    brief: { taskId: "t1" },
    frame: {
      userMessages: [{ text: "fix a.ts" }],
      omittedUserMessages: 0,
      scopedMemory: "",
      recentDialogue: "",
      workingHistory: "",
      lang: "zh",
    },
    ...over,
  } as const satisfies JournalStartEntry;
}

/** 板砖 asked for an edit of a.ts and a test run; the edit's bytes landed. */
const editThenTest = (ws: string): DispatchJournalEntry[] => {
  writeFileSync(join(ws, "a.ts"), "after");
  return [
    start(ws),
    {
      kind: "message",
      message: {
        role: "assistant",
        text: "",
        ts: "2026-09-28T10:00:01.000Z",
        toolCalls: [
          { id: "c1", tool: "edit_file", input: { path: "a.ts" } },
          { id: "c2", tool: "run_command", input: { command: "npm test" } },
        ],
      },
    },
    { kind: "dispatch", callIds: ["c1"] },
    {
      kind: "write",
      callId: "c1",
      path: join(ws, "a.ts"),
      before: sha("before"),
      after: sha("after"),
    },
  ];
};

function reopen(sessionFile: string) {
  const loaded = readSessionFile(sessionFile);
  return {
    ...loaded,
    persister: V2RecordPersister.forResume({ sessionFile }),
  };
}

describe("the seal on open (ADR 0071 §1.2)", () => {
  it("closes every open step, then writes the 中断 marker and turn_end interrupted", async () => {
    const s = crashed(editThenTest);
    const { record, persister } = reopen(s.sessionFile);
    const sealed = await sealOpenDispatch({
      journalPath: s.journalPath,
      record,
      persister,
      probe: probe(),
      now: () => new Date("2026-09-28T11:00:00.000Z"),
    });

    const marker = sealed?.record.at(-1);
    expect(marker).toMatchObject({
      kind: "system",
      label: "差分协处理器",
      role: "done-marker",
      body: "中断 · 1 个文件 · 应用意外退出",
      markerSummary: {
        kind: "done",
        state: "interrupted",
        fileCount: 1,
        riskCount: 0,
        crashed: true,
      },
      evidence: [
        {
          kind: "cutoff",
          steps: [
            { step: "edit_file a.ts", outcome: "write_applied" },
            { step: "run_command npm test", outcome: "not_started" },
          ],
        },
        { kind: "files", paths: ["a.ts"] },
      ],
    });
    expect(marker?.kind === "system" && marker.evidenceDetail).toBe(
      "↳ 中断时: edit_file a.ts — 已写入; run_command npm test — 未开始\n↳ 改动文件: a.ts",
    );

    // Rewinding past it warns that files changed (and are not reverted).
    expect(spanEditedFiles([marker as TerminalRecordBlock])).toBe(true);

    // On disk: the marker is the record's last block, and the turn ended.
    const after = readSessionFile(s.sessionFile);
    expect(after.record).toEqual(sealed?.record);
    expect(after.lastTurnEnd).toEqual({
      outcome: "interrupted",
      atBlockCount: RECORD.length + 1,
    });
    expect(sealed?.lastTurnEnd).toEqual(after.lastTurnEnd);

    // In the journal: a closer per open step, then the end.
    const tail = (await readDispatchJournal(s.journalPath))?.slice(-3);
    expect(tail?.map((e) => e.kind)).toEqual(["closer", "closer", "end"]);
    expect(tail?.[0]).toMatchObject({
      callId: "c1",
      outcome: "write_applied",
      result: { ok: true },
    });
    expect(tail?.[2]).toEqual({
      kind: "end",
      status: "interrupted",
      cause: "app-exit",
    });
  });

  it("a second open inserts nothing", async () => {
    const s = crashed(editThenTest);
    const first = reopen(s.sessionFile);
    await sealOpenDispatch({
      journalPath: s.journalPath,
      record: first.record,
      persister: first.persister,
      probe: probe(),
    });
    const bytes = readFileSync(s.sessionFile, "utf8");
    const second = reopen(s.sessionFile);
    expect(
      await sealOpenDispatch({
        journalPath: s.journalPath,
        record: second.record,
        persister: second.persister,
        probe: probe(),
      }),
    ).toBeNull();
    expect(readFileSync(s.sessionFile, "utf8")).toBe(bytes);
  });

  it("a clean reload inserts nothing: the run ended", async () => {
    const s = crashed((ws) => [
      ...editThenTest(ws),
      { kind: "end", status: "completed" },
    ]);
    const bytes = readFileSync(s.sessionFile, "utf8");
    const { record, persister } = reopen(s.sessionFile);
    expect(
      await sealOpenDispatch({
        journalPath: s.journalPath,
        record,
        persister,
        probe: probe(),
      }),
    ).toBeNull();
    expect(readFileSync(s.sessionFile, "utf8")).toBe(bytes);
  });

  it("the record's half of the gate: no seal when a marker already ends the run, or the run's rows were withdrawn", async () => {
    const withMarker = crashed(editThenTest, [
      ...RECORD,
      {
        kind: "system",
        label: "差分协处理器",
        body: "完成",
        role: "done-marker",
      },
    ]);
    const a = reopen(withMarker.sessionFile);
    expect(
      await sealOpenDispatch({
        journalPath: withMarker.journalPath,
        record: a.record,
        persister: a.persister,
        probe: probe(),
      }),
    ).toBeNull();

    const shorter = crashed(editThenTest, RECORD.slice(0, 2));
    const b = reopen(shorter.sessionFile);
    expect(
      await sealOpenDispatch({
        journalPath: shorter.journalPath,
        record: b.record,
        persister: b.persister,
        probe: probe(),
      }),
    ).toBeNull();

    // A journal without a record length (older) is never sealed.
    const noLength = crashed((ws) => [start(ws, { recordLength: undefined })]);
    const c = reopen(noLength.sessionFile);
    expect(
      await sealOpenDispatch({
        journalPath: noLength.journalPath,
        record: c.record,
        persister: c.persister,
        probe: probe(),
      }),
    ).toBeNull();
  });

  it("a seal cut short after its marker gets its end at the next open, so the run can still be offered (review 2026-09-30)", async () => {
    const s = crashed(editThenTest, [
      ...RECORD,
      {
        kind: "system",
        label: "差分协处理器",
        body: "中断",
        role: "done-marker",
      },
    ]);
    const a = reopen(s.sessionFile);
    const seal = () =>
      sealOpenDispatch({
        journalPath: s.journalPath,
        record: a.record,
        persister: a.persister,
        probe: probe(),
      });
    expect(await seal()).toBeNull();
    const entries = (await readDispatchJournal(s.journalPath)) ?? [];
    expect(entries.at(-1)).toEqual({
      kind: "end",
      status: "interrupted",
      cause: "app-exit",
    });
    expect(resumableRun(entries)).not.toBeNull();
    // Once: the next open finds the run ended and appends nothing.
    expect(await seal()).toBeNull();
    expect((await readDispatchJournal(s.journalPath))?.length).toBe(
      entries.length,
    );
  });

  it("a record that ends before the run began — a tail lost to a power cut — drops the journal rather than leave the run open forever (review 2026-09-30)", async () => {
    const s = crashed(editThenTest, RECORD.slice(0, 2));
    const b = reopen(s.sessionFile);
    expect(
      await sealOpenDispatch({
        journalPath: s.journalPath,
        record: b.record,
        persister: b.persister,
        probe: probe(),
      }),
    ).toBeNull();
    expect(existsSync(s.journalPath)).toBe(false);
  });

  it("a run another live app is running, or one that cannot be checked, is left alone", async () => {
    const s = crashed(editThenTest);
    const { record, persister } = reopen(s.sessionFile);
    // Pid 4242 runs, and started when the journal says: that app is alive.
    expect(
      await sealOpenDispatch({
        journalPath: s.journalPath,
        record,
        persister,
        probe: probe({ 4242: 1_500 }),
      }),
    ).toBeNull();
    expect(
      await sealOpenDispatch({
        journalPath: s.journalPath,
        record,
        persister,
        probe: {
          ...probe({ 4242: 1_500 }),
          processes: probe({}, { fails: true }).processes,
        },
      }),
    ).toBeNull();
    // Pid 4242 runs, but started an hour later: a reused pid; the run's
    // app is gone, and it is sealed.
    expect(
      await sealOpenDispatch({
        journalPath: s.journalPath,
        record,
        persister,
        probe: probe({ 4242: 3_600_000 }),
      }),
    ).not.toBeNull();
  });

  it("a run still unwinding in this process is left alone", async () => {
    const s = crashed(editThenTest);
    const live = await DispatchJournal.reopen(s.journalPath, { live: true });
    try {
      const { record, persister } = reopen(s.sessionFile);
      expect(
        await sealOpenDispatch({
          journalPath: s.journalPath,
          record,
          persister,
          probe: probe(),
        }),
      ).toBeNull();
    } finally {
      await live.close();
    }
  });

  it("a seal cut short after its closers is finished by the next open, without closing a step twice", async () => {
    const s = crashed((ws) => [
      ...editThenTest(ws),
      {
        kind: "closer",
        callId: "c2",
        outcome: "not_started",
        result: { ok: false, summary: "app exited: not started" },
      },
    ]);
    const { record, persister } = reopen(s.sessionFile);
    const sealed = await sealOpenDispatch({
      journalPath: s.journalPath,
      record,
      persister,
      probe: probe(),
    });
    expect(sealed?.plan.calls.map((c) => [c.callId, c.outcome])).toEqual([
      ["c1", "write_applied"],
      ["c2", "not_started"],
    ]);
    const closers = (await readDispatchJournal(s.journalPath))?.filter(
      (e) => e.kind === "closer",
    );
    expect(closers?.map((e) => e.kind === "closer" && e.callId)).toEqual([
      "c2",
      "c1",
    ]);
  });
});

describe("the launch reaper (ADR 0071 §1.6)", () => {
  const withProcesses = (ws: string): DispatchJournalEntry[] => [
    start(ws),
    {
      kind: "message",
      message: {
        role: "assistant",
        text: "",
        ts: "2026-09-28T10:00:01.000Z",
        toolCalls: [
          { id: "c1", tool: "run_command", input: { command: "npm run dev" } },
        ],
      },
    },
    { kind: "dispatch", callIds: ["c1"] },
    ...[11, 12, 13, 14].map(
      (pid): DispatchJournalEntry => ({
        kind: "spawn",
        callId: "c1",
        pid,
        startedAt: 10_000,
        command: "npm run dev",
        role: "background",
      }),
    ),
    { kind: "exit", pid: 14 },
  ];

  it("ends only a process that is still the one the run started; records every fate; unlists the journal", async () => {
    const s = crashed(withProcesses);
    await markJournalOpen(s.journalPath, true);
    // 11: still that process. 12: the pid now names a later process. 13:
    // not running. 14: exited while the run was alive.
    const p = probe({ 11: 10_400, 12: 900_000 });
    const summary = await reapOrphanedDispatches(
      dispatchJournalDir(s.transcriptDir),
      p,
    );
    expect(p.killed).toEqual([11]);
    expect(summary.fates).toEqual([
      { pid: 11, fate: "ended" },
      { pid: 12, fate: "gone" },
      { pid: 13, fate: "gone" },
    ]);
    const reaps = (await readDispatchJournal(s.journalPath))?.filter(
      (e) => e.kind === "reap",
    );
    expect(reaps).toHaveLength(3);
    expect(await readJournalIndex(dispatchJournalDir(s.transcriptDir))).toEqual(
      [],
    );
    // Reaped once: a second launch finds nothing to do.
    await markJournalOpen(s.journalPath, true);
    const again = await reapOrphanedDispatches(
      dispatchJournalDir(s.transcriptDir),
      probe({ 11: 10_400 }),
    );
    expect(again.fates).toEqual([]);
  });

  it("follows a launcher that exited with the app to the shell and the command it left running", async () => {
    // Seen live (2026-09-28): the recorded pid was Git for Windows'
    // bin\bash.exe, which died with the app; usr\bin\bash.exe and the
    // command under it did not.
    const s = crashed((ws) => [
      start(ws),
      {
        kind: "spawn",
        callId: "c1",
        pid: 11,
        startedAt: 10_000,
        command: "bash (persistent shell)",
        role: "shell",
      },
    ]);
    await markJournalOpen(s.journalPath, true);
    const p = probe(
      {
        21: [10_050, 11, 11], // the real shell; its launcher (11) is gone
        31: [60_000, 21, 11], // the command the shell was running
        41: [2_000, 11, 11], // older than the run's process: not its child
      },
      { platform: "win32" },
    );
    const summary = await reapOrphanedDispatches(
      dispatchJournalDir(s.transcriptDir),
      p,
    );
    expect(p.killed.sort()).toEqual([21, 31]);
    expect(summary.fates).toEqual([{ pid: 11, fate: "ended" }]);
  });

  it("a child of a gone launcher is ours only if it started while the app lived — a later holder of the pid may have started the rest (review 2026-09-30)", async () => {
    const s = crashed((ws) => [
      start(ws, { at: new Date(9_000).toISOString() }),
      {
        kind: "spawn",
        callId: "c1",
        pid: 11,
        startedAt: 10_000,
        command: "bash (persistent shell)",
        role: "shell",
      },
      // A process the run saw end: the app lived at least until then.
      { kind: "exit", pid: 12, at: 40_000 },
    ]);
    await markJournalOpen(s.journalPath, true);
    const p = probe(
      {
        21: [10_050, 11, 11], // the real shell, started while the app lived
        31: [900_000, 21, 21], // its command: the shell runs, so it is ours
        22: [400_000, 11, 11], // under the dead pid 11, long after: a stranger's
      },
      { platform: "win32" },
    );
    const summary = await reapOrphanedDispatches(
      dispatchJournalDir(s.transcriptDir),
      p,
    );
    expect(p.killed.sort()).toEqual([21, 31]);
    expect(summary.fates).toEqual([{ pid: 11, fate: "ended" }]);
  });

  it("on POSIX, a gone leader's group is ours only for members that started while the app lived (CI 2026-09-30)", async () => {
    // The kernel reuses pid 11 only once group 11 is empty; a later leader
    // that took it and exited leaves a group 11 of its own. The Linux CI
    // found the reaper killing that stranger.
    const s = crashed((ws) => [
      start(ws, { at: new Date(9_000).toISOString() }),
      {
        kind: "spawn",
        callId: "c1",
        pid: 11,
        startedAt: 10_000,
        command: "bash (persistent shell)",
        role: "shell",
      },
      { kind: "exit", pid: 12, at: 40_000 },
    ]);
    await markJournalOpen(s.journalPath, true);
    const p = probe(
      {
        21: [10_050, 1, 11], // the run's command, orphaned in group 11
        22: [400_000, 1, 11], // group 11 again, long after: a stranger's
      },
      { platform: "linux" },
    );
    const summary = await reapOrphanedDispatches(
      dispatchJournalDir(s.transcriptDir),
      p,
    );
    expect(p.killed).toEqual([21]);
    expect(summary.fates).toEqual([{ pid: 11, fate: "ended" }]);
  });

  it("leaves a journal alone that went live while it was checking — the session was opened and its run continued (review 2026-09-30)", async () => {
    const s = crashed(withProcesses);
    await markJournalOpen(s.journalPath, true);
    const p = probe({ 11: 10_400 });
    let held: DispatchJournal | null = null;
    const table = p.processes;
    p.processes = async () => {
      // The process query is slow; meanwhile the user pressed 继续 — the
      // continued run holds the journal live.
      held = await DispatchJournal.reopen(s.journalPath, { live: true });
      return table();
    };
    const summary = await reapOrphanedDispatches(
      dispatchJournalDir(s.transcriptDir),
      p,
    );
    // The dead run's orphan is still ended (it was verified as that
    // process), but nothing is written into what is now a live run's
    // journal, and it stays listed.
    expect(p.killed).toEqual([11]);
    expect(summary.fates.map((f) => f.fate)).toEqual(["ended", "gone", "gone"]);
    const entries = await readDispatchJournal(s.journalPath);
    expect(entries?.some((e) => e.kind === "reap")).toBe(false);
    expect(
      await readJournalIndex(dispatchJournalDir(s.transcriptDir)),
    ).toHaveLength(1);
    await (held as DispatchJournal | null)?.close();
  });

  it("reaches an MSYS shell's commands through its process group, where Windows' parent ids are broken", async () => {
    // Cygwin's fork/exec: the command's Windows parent (a forked bash) exited
    // once it exec'd, so no parent-id walk leads from the shell to it.
    const s = crashed((ws) => [
      start(ws),
      {
        kind: "spawn",
        callId: "c1",
        pid: 500,
        startedAt: 10_000,
        command: "bash (persistent shell)",
        role: "shell",
        msys: { pgid: 26, ps: "C:/git/usr/bin/ps.exe" },
      },
    ]);
    await markJournalOpen(s.journalPath, true);
    const p = probe(
      {
        500: 10_050, // the real shell
        600: [60_000, 999, 999], // `sleep`, its Windows parent long gone
        700: [2_000, 999, 999], // an old process that took a stale MSYS row
        800: [61_000, 600, 600], // a native child of the command
      },
      {
        msys: [
          [26, 26, 500],
          [32, 26, 600],
          [33, 26, 700],
          [40, 40, 900],
        ],
        platform: "win32",
      },
    );
    const summary = await reapOrphanedDispatches(
      dispatchJournalDir(s.transcriptDir),
      p,
    );
    expect(p.killed.sort((a, b) => a - b)).toEqual([500, 600, 800]);
    expect(summary.fates).toEqual([{ pid: 500, fate: "ended" }]);
  });

  it("kills nothing it cannot verify, and keeps the journal listed for the next launch", async () => {
    const s = crashed(withProcesses);
    await markJournalOpen(s.journalPath, true);
    const p = {
      ...probe({ 11: 10_400 }),
      processes: probe({}, { fails: true }).processes,
    };
    const summary = await reapOrphanedDispatches(
      dispatchJournalDir(s.transcriptDir),
      p,
    );
    expect(p.killed).toEqual([]);
    expect(summary.fates.map((f) => f.fate)).toEqual([
      "unverified",
      "unverified",
      "unverified",
    ]);
    expect(await readJournalIndex(dispatchJournalDir(s.transcriptDir))).toEqual(
      ["s1.jsonl"],
    );
  });

  it("leaves a run another live app is running alone", async () => {
    const s = crashed(withProcesses);
    await markJournalOpen(s.journalPath, true);
    const p = probe({ 4242: 1_000, 11: 10_400 });
    const summary = await reapOrphanedDispatches(
      dispatchJournalDir(s.transcriptDir),
      p,
    );
    expect(summary.journals).toBe(0);
    expect(p.killed).toEqual([]);
  });

  it("ends a real process by pid and start time, and leaves one whose start time does not match", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
        ...(process.platform === "win32" ? {} : { detached: true }),
      },
    );
    const other = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
        ...(process.platform === "win32" ? {} : { detached: true }),
      },
    );
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    try {
      const s = crashed((ws) => [
        start(ws, { host: undefined }),
        {
          kind: "spawn",
          callId: "c1",
          pid: child.pid as number,
          startedAt: Date.now(),
          command: "node",
          role: "background",
        },
        {
          kind: "spawn",
          callId: "c1",
          pid: other.pid as number,
          // An hour off: the pid does not name the run's process.
          startedAt: Date.now() - 3_600_000,
          command: "node",
          role: "background",
        },
      ]);
      await markJournalOpen(s.journalPath, true);
      const summary = await reapOrphanedDispatches(
        dispatchJournalDir(s.transcriptDir),
        patientProbe,
      );
      expect(summary.fates).toEqual([
        { pid: child.pid, fate: "ended" },
        { pid: other.pid, fate: "gone" },
      ]);
      await exited;
      expect(other.exitCode).toBeNull();
    } finally {
      child.kill();
      other.kill();
    }
  }, 120_000);

  it("ends what a real launcher left running after it exited", async () => {
    // The launcher starts a long-lived child, says its pid, and exits — as
    // Git for Windows' bash launcher does when the app dies under it. On
    // Windows a node process's plain children sit in its kill-on-close job
    // and die with it; the shell a launcher starts breaks away, so the child
    // here is detached there. On POSIX it stays in the launcher's group.
    const launcher = spawn(
      process.execPath,
      [
        "-e",
        [
          `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: ${process.platform === "win32"} });`,
          "c.unref();",
          "process.stdout.write(String(c.pid));",
          "setTimeout(() => process.exit(0), 300);",
        ].join(" "),
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        ...(process.platform === "win32" ? {} : { detached: true }),
      },
    );
    const launcherStarted = Date.now();
    let out = "";
    launcher.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    await new Promise<void>((resolve) =>
      launcher.once("exit", () => resolve()),
    );
    const left = Number(out);
    expect(Number.isInteger(left) && left > 0).toBe(true);
    try {
      expect(systemProcessProbe.alive(left)).toBe(true);
      const s = crashed((ws) => [
        start(ws, { host: undefined }),
        {
          kind: "spawn",
          callId: "c1",
          pid: launcher.pid as number,
          startedAt: launcherStarted,
          command: "bash (persistent shell)",
          role: "shell",
        },
      ]);
      await markJournalOpen(s.journalPath, true);
      const summary = await reapOrphanedDispatches(
        dispatchJournalDir(s.transcriptDir),
        patientProbe,
      );
      expect(summary.fates).toEqual([{ pid: launcher.pid, fate: "ended" }]);
      const until = Date.now() + 10_000;
      while (systemProcessProbe.alive(left) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(systemProcessProbe.alive(left)).toBe(false);
    } finally {
      try {
        process.kill(left);
      } catch {
        // ended by the reaper
      }
    }
  }, 120_000);
});

describe("a rewind drops a withdrawn run's journal (ADR 0071 §1.1)", () => {
  it("deletes it when the rewind withdrew the dispatch, keeps it otherwise", async () => {
    const s = crashed(editThenTest);
    await dropWithdrawnJournal(s.journalPath, 3);
    expect(existsSync(s.journalPath)).toBe(true);
    await dropWithdrawnJournal(s.journalPath, 2);
    expect(existsSync(s.journalPath)).toBe(false);
  });

  it("keeps it while its processes wait for the reaper", async () => {
    const s = crashed((ws) => [
      start(ws),
      {
        kind: "spawn",
        callId: "c1",
        pid: 11,
        startedAt: 1,
        command: "npm run dev",
        role: "background",
      },
    ]);
    await markJournalOpen(s.journalPath, true);
    await dropWithdrawnJournal(s.journalPath, 2);
    expect(existsSync(s.journalPath)).toBe(true);
  });

  // Review 2026-09-30: keeping the whole journal after a 继续 turn was
  // withdrawn left the continuation's `end` as the run's last, so the offer
  // never returned and a later 继续 would have replayed the withdrawn
  // segment's messages.
  const continued = (ws: string): DispatchJournalEntry[] => [
    ...editThenTest(ws),
    { kind: "end", status: "interrupted", cause: "app-exit" },
    // The 继续 submitted its user block as the sixth block, so its segment
    // starts at length 6, as the dispatch's did at 3.
    { kind: "resume", at: "2026-09-28T10:05:00.000Z", recordLength: 6 },
    {
      kind: "message",
      message: {
        role: "assistant",
        text: "done",
        ts: "2026-09-28T10:05:01.000Z",
        toolCalls: [],
      },
    },
    { kind: "end", status: "completed" },
  ];

  it("a rewind of a 继续 turn cuts the journal back to the segment before it, so the offer returns", async () => {
    const s = crashed(continued);
    // The continuation's own turn withdrawn: the record is back at the
    // 中断 marker, five blocks.
    await dropWithdrawnJournal(s.journalPath, 5);
    const entries = (await readDispatchJournal(s.journalPath)) ?? [];
    expect(entries.at(-1)).toEqual({
      kind: "end",
      status: "interrupted",
      cause: "app-exit",
    });
    expect(entries.some((e) => e.kind === "resume")).toBe(false);
    expect(resumableRun(entries)?.recordLength).toBe(3);
    // A rewind that leaves the continuation in place cuts nothing.
    await dropWithdrawnJournal(s.journalPath, 6);
    expect((await readDispatchJournal(s.journalPath))?.length).toBe(
      entries.length,
    );
    // And one past the dispatch itself still deletes the journal.
    await dropWithdrawnJournal(s.journalPath, 2);
    expect(existsSync(s.journalPath)).toBe(false);
  });

  it("keeps a withdrawn 继续 segment whole while its processes wait for the reaper", async () => {
    const s = crashed((ws) => [
      ...continued(ws).slice(0, -1),
      {
        kind: "spawn",
        callId: "c3",
        pid: 11,
        startedAt: 1,
        command: "npm run dev",
        role: "background",
      },
    ]);
    await markJournalOpen(s.journalPath, true);
    const before = (await readDispatchJournal(s.journalPath))?.length;
    await dropWithdrawnJournal(s.journalPath, 5);
    expect((await readDispatchJournal(s.journalPath))?.length).toBe(before);
  });
});
