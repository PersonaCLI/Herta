import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchJournalDir,
  dispatchJournalPath,
  readSessionFile,
  readSessionTitle,
  readSessionTopics,
  V2RecordPersister,
  writeSessionTitle,
} from "@herta/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionHost,
  makeLifecycleSerializer,
  wrapSessionForDreamActivity,
} from "./session-host.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";
import type { AppServerConfig, Session } from "./types.js";

/** Every workspace mkConfig() makes, removed after the test that made it —
 *  a suite run used to leave one `herta-app-server-test-*` per call under
 *  %TEMP% (tens of thousands by 2026-09-16). Same pattern as
 *  session-wiring.test.ts. Each test here closes its own session before it
 *  ends, so nothing still writes into the tree being removed — but a
 *  reopened session's repository probe runs `git` with THIS workspace as
 *  its cwd (the legacy fallback), and close() does not wait for that child;
 *  removeTmpDir waits it out. */
const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await removeTmpDir(d);
});

function mkConfig(): AppServerConfig {
  const root = mkdtempSync(join(tmpdir(), "herta-app-server-test-"));
  tmpDirs.push(root);
  return {
    workspaceRoot: root,
    transcriptDir: join(root, ".herta", "transcript", "v2"),
    projectMemoryDir: join(root, ".herta", "memory"),
    userMemoryDir: join(root, ".herta", "user-memory"),
    narrativeDir: join(root, ".herta", "narrative"),
    providers: {
      deepseekApiKey: "sk-test",
      actorModel: "deepseek-v4-base",
      backendModel: "deepseek-v4-chat",
      routerModel: "deepseek-flash",
    },
  };
}

describe("createSessionHost — skeleton", () => {
  it("returns a SessionHost with no active session", () => {
    const host = createSessionHost(mkConfig());
    expect(host.activeSession).toBeNull();
  });

  it("listSessions on an empty transcriptDir returns []", () => {
    const host = createSessionHost(mkConfig());
    expect(host.listSessions()).toEqual([]);
  });

  it("closeActiveSession is idempotent when no session is active", async () => {
    const host = createSessionHost(mkConfig());
    await host.closeActiveSession();
    await host.closeActiveSession();
    expect(host.activeSession).toBeNull();
  });

  it("rejects an AppServerConfig with a non-absolute workspaceRoot", () => {
    expect(() =>
      createSessionHost({ ...mkConfig(), workspaceRoot: "relative/path" }),
    ).toThrow(/absolute/i);
  });

  it("accepts an empty deepseekApiKey (no-key onboarding is deferred to submit)", () => {
    const cfg = mkConfig();
    expect(() =>
      createSessionHost({
        ...cfg,
        providers: { ...cfg.providers, deepseekApiKey: "" },
      }),
    ).not.toThrow();
  });

  it("setDeepSeekKey updates the live key with no throw", () => {
    const cfg = mkConfig();
    const host = createSessionHost({
      ...cfg,
      providers: { ...cfg.providers, deepseekApiKey: "" },
    });
    expect(() => host.setDeepSeekKey("sk-live")).not.toThrow();
    host.dispose();
  });
});

// ── openSession happy-path ────────────────────────────────────────────────
//
// Design doc §9.1 listed "openSession loads a pre-existing JSONL into
// record state correctly" as a required session-host test. It was
// implicitly exercised by the e2e test but had no dedicated unit
// coverage until this Slice 2.1 follow-up.

describe("createSession — per-session interaction language", () => {
  it("persists the created lang into the header, so a reopen pins to it", async () => {
    const cfg = mkConfig();
    const host = createSessionHost(cfg);
    const session = await host.createSession({ lang: "en" });
    const file = join(cfg.transcriptDir, `${session.sessionId}.jsonl`);
    // Written into the header at creation → survives to the reopen, where the
    // host prefers meta.lang over the caller's (possibly since-changed) global.
    expect(readSessionFile(file).meta.lang).toBe("en");
    await host.closeActiveSession();
  });

  it("omits lang from the header when the caller does not resolve one", async () => {
    const cfg = mkConfig();
    const host = createSessionHost(cfg);
    const session = await host.createSession({});
    const file = join(cfg.transcriptDir, `${session.sessionId}.jsonl`);
    expect(readSessionFile(file).meta.lang).toBeUndefined();
    await host.closeActiveSession();
  });
});

describe("openSession — load pre-existing JSONL", () => {
  it("opens a session by id and restores the record from disk", async () => {
    const cfg = mkConfig();

    // Pre-write a JSONL with one user block by using the persister
    // directly — bypasses the actor turn loop entirely so the test
    // doesn't need provider stubs.
    const sessionId = "test-session-load";
    const persister = V2RecordPersister.forNewSession({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      startedAt: new Date(),
      transcriptDir: cfg.transcriptDir,
      // Fixed clock so the persister's per-block `at` stamp is deterministic.
      now: () => "2026-06-18T09:30:00.000Z",
    });
    persister.appendBlock({ kind: "user", text: "hello from disk" });

    const host = createSessionHost(cfg);
    const session = await host.openSession({ sessionId });

    expect(session.sessionId).toBe(sessionId);
    expect(host.activeSession).toBe(session);
    expect(session.record).toHaveLength(1);
    // The persisted block carries the stamped `at`, restored from disk.
    expect(session.record[0]).toEqual({
      kind: "user",
      text: "hello from disk",
      at: "2026-06-18T09:30:00.000Z",
    });

    await host.closeActiveSession();
  });

  it("seals a 板砖 run the app exited during, once (ADR 0071 §1.2)", async () => {
    const cfg = mkConfig();
    const sessionId = "test-session-crashed";
    const persister = V2RecordPersister.forNewSession({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      startedAt: new Date(),
      transcriptDir: cfg.transcriptDir,
    });
    persister.appendBlock({ kind: "user", text: "run the tests" });
    persister.appendBlock({
      kind: "herta",
      surface: "speech",
      text: "@板砖 run the tests",
    });
    persister.appendBlock({
      kind: "system",
      label: "差分协处理器",
      body: "Running npm test",
    });
    const journalPath = dispatchJournalPath(cfg.transcriptDir, sessionId);
    mkdirSync(dispatchJournalDir(cfg.transcriptDir), { recursive: true });
    writeFileSync(
      journalPath,
      `${[
        {
          kind: "start",
          v: 1,
          taskId: "t1",
          at: "2026-09-28T10:00:00.000Z",
          recordLength: 2,
          workspaceRoot: cfg.workspaceRoot,
          brief: { taskId: "t1" },
          frame: {
            userMessages: [{ text: "run the tests" }],
            omittedUserMessages: 0,
            scopedMemory: "",
            recentDialogue: "",
            workingHistory: "",
            lang: "zh",
          },
        },
        {
          kind: "message",
          message: {
            role: "assistant",
            text: "",
            ts: "2026-09-28T10:00:01.000Z",
            toolCalls: [
              { id: "c1", tool: "run_command", input: { command: "npm test" } },
            ],
          },
        },
        { kind: "dispatch", callIds: ["c1"] },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );

    const host = createSessionHost(cfg);
    const session = await host.openSession({ sessionId });
    expect(session.record).toHaveLength(4);
    expect(session.record.at(-1)).toMatchObject({
      role: "done-marker",
      body: "中断 · 应用意外退出",
      evidenceDetail: "↳ 中断时: run_command npm test — 结果未知",
    });
    await host.closeActiveSession();

    // Reopened: sealed once, nothing more.
    const again = await host.openSession({ sessionId });
    expect(again.record).toHaveLength(4);
    expect(
      readSessionFile(join(cfg.transcriptDir, `${sessionId}.jsonl`))
        .lastTurnEnd,
    ).toEqual({ outcome: "interrupted", atBlockCount: 4 });
    await host.closeActiveSession();
  });

  it("closes the prior active session before opening", async () => {
    const cfg = mkConfig();

    // Pre-write a session file we'll open later.
    const sessionId = "test-session-load-prior";
    const persister = V2RecordPersister.forNewSession({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      startedAt: new Date(),
      transcriptDir: cfg.transcriptDir,
    });
    persister.appendBlock({ kind: "user", text: "stored" });

    const host = createSessionHost(cfg);

    // Create a fresh session first.
    const first = await host.createSession({});
    expect(host.activeSession).toBe(first);

    // Opening the pre-existing session must close `first` first.
    const second = await host.openSession({ sessionId });
    expect(host.activeSession).toBe(second);
    expect(second.sessionId).toBe(sessionId);
    expect(second.record).toHaveLength(1);
    expect(first.sessionId).not.toBe(second.sessionId);

    await host.closeActiveSession();
  });

  it("a create that cannot write its transcript fails with the open session STILL open (UX review 2026-09-22, item 6)", async () => {
    // Closing first left the host with nothing open while the window still
    // showed the closed session: every send went nowhere.
    const host = createSessionHost(mkConfig());
    const first = await host.createSession({});
    const spy = vi
      .spyOn(V2RecordPersister, "forNewSession")
      .mockImplementationOnce(() => {
        throw new Error("EACCES: permission denied");
      });
    try {
      await expect(host.createSession({})).rejects.toThrow(/EACCES/);
      expect(host.activeSession).toBe(first);
    } finally {
      spy.mockRestore();
    }
    await host.closeActiveSession();
  });

  it("a corrupt file fails the open but leaves the active session pointed", async () => {
    const cfg = mkConfig();

    // A MID-FILE corrupt line (not a tolerated truncated tail): a fused
    // garbage line followed by a valid block → readSessionFile throws
    // corrupt-line. The failed open must not tear down the active session.
    const sessionId = "test-session-corrupt";
    const persister = V2RecordPersister.forNewSession({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      startedAt: new Date(),
      transcriptDir: cfg.transcriptDir,
    });
    persister.appendBlock({ kind: "user", text: "u1" });
    const file = join(cfg.transcriptDir, `${sessionId}.jsonl`);
    appendFileSync(file, '{"fused-garbage\n', "utf8");
    persister.appendBlock({ kind: "user", text: "u2" });

    const host = createSessionHost(cfg);
    const first = await host.createSession({});

    await expect(host.openSession({ sessionId })).rejects.toMatchObject({
      name: "SessionFileError",
      code: "corrupt-line",
    });
    expect(host.activeSession).toBe(first);

    await host.closeActiveSession();
  });

  it("listSessions surfaces a session's title sidecar", () => {
    const cfg = mkConfig();
    const sessionId = "test-session-titled";
    V2RecordPersister.forNewSession({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      startedAt: new Date(),
      transcriptDir: cfg.transcriptDir,
    }).appendBlock({ kind: "user", text: "hi" });
    writeSessionTitle(cfg.transcriptDir, sessionId, "排查失踪引用");

    const host = createSessionHost(cfg);
    const entry = host.listSessions().find((s) => s.sessionId === sessionId);
    expect(entry?.title).toBe("排查失踪引用");
  });

  it("listSessions surfaces the last user message", () => {
    const cfg = mkConfig();
    const sessionId = "test-session-lastuser";
    const persister = V2RecordPersister.forNewSession({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      startedAt: new Date(),
      transcriptDir: cfg.transcriptDir,
    });
    persister.appendBlock({ kind: "user", text: "first" });
    persister.appendBlock({ kind: "herta", surface: "speech", text: "ok" });
    persister.appendBlock({ kind: "user", text: "where we left off" });

    const host = createSessionHost(cfg);
    const entry = host.listSessions().find((s) => s.sessionId === sessionId);
    expect(entry?.lastUserText).toBe("where we left off");
  });
});

describe("deleteSession", () => {
  it("removes an inactive session's files (wasActive=false)", async () => {
    const cfg = mkConfig();
    const sessionId = "to-delete-inactive";
    V2RecordPersister.forNewSession({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      startedAt: new Date(),
      transcriptDir: cfg.transcriptDir,
    }).appendBlock({ kind: "user", text: "bye" });
    writeSessionTitle(cfg.transcriptDir, sessionId, "旧标题");
    const host = createSessionHost(cfg);
    expect(existsSync(join(cfg.transcriptDir, `${sessionId}.jsonl`))).toBe(
      true,
    );

    const r = await host.deleteSession(sessionId);

    expect(r).toEqual({ ok: true, wasActive: false, removed: true });
    expect(existsSync(join(cfg.transcriptDir, `${sessionId}.jsonl`))).toBe(
      false,
    );
    expect(existsSync(join(cfg.transcriptDir, `${sessionId}.title.json`))).toBe(
      false,
    );
    // The host had no active session — still none after deleting.
    expect(host.activeSession).toBeNull();
  });

  it("closes + clears the active session, then deletes its files (wasActive=true)", async () => {
    const cfg = mkConfig();
    const host = createSessionHost(cfg);
    const active = await host.createSession({});
    expect(host.activeSession).toBe(active);

    const r = await host.deleteSession(active.sessionId);

    expect(r).toEqual({ ok: true, wasActive: true, removed: true });
    expect(host.activeSession).toBeNull();
    expect(
      existsSync(join(cfg.transcriptDir, `${active.sessionId}.jsonl`)),
    ).toBe(false);
  });

  it("deleteSession removes the session's managed backend workspace dir", async () => {
    const host = createSessionHost(mkConfig());
    const s = await host.createSession({});
    const wsDir = join(homedir(), ".herta", "workspaces", s.sessionId);
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "x.txt"), "x");
    await host.deleteSession(s.sessionId);
    expect(existsSync(wsDir)).toBe(false);
  });
});

// ── Rename and export (ADR 0072 §3) ──────────────────────────────────────

function persistClosedSession(
  cfg: AppServerConfig,
  sessionId: string,
  blocks: Parameters<V2RecordPersister["appendBlock"]>[0][],
  lang?: "zh" | "en",
): void {
  const persister = V2RecordPersister.forNewSession({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    startedAt: new Date(),
    transcriptDir: cfg.transcriptDir,
    ...(lang !== undefined ? { lang } : {}),
  });
  for (const b of blocks) persister.appendBlock(b);
}

describe("renameSession", () => {
  it("names a closed session's CURRENT topic: the title and the last topic, earlier topics kept", async () => {
    const cfg = mkConfig();
    const sessionId = "to-rename";
    persistClosedSession(cfg, sessionId, [
      { kind: "user", text: "hi" },
      { kind: "user", text: "later" },
    ]);
    const topics = [
      { title: "第一个话题", anchorIndex: 0, anchorText: "hi", at: "t1" },
      { title: "旧标题", anchorIndex: 1, anchorText: "later", at: "t2" },
    ];
    writeSessionTitle(cfg.transcriptDir, sessionId, "旧标题", topics);
    const host = createSessionHost(cfg);

    const r = await host.renameSession?.(sessionId, "  新的\n名字  ");

    expect(r).toEqual({ ok: true, title: "新的 名字" });
    expect(readSessionTitle(cfg.transcriptDir, sessionId)).toBe("新的 名字");
    expect(readSessionTopics(cfg.transcriptDir, sessionId)).toEqual([
      topics[0],
      { ...topics[1], title: "新的 名字" },
    ]);
    // What the sidebar lists.
    expect(host.listSessions()[0]?.title).toBe("新的 名字");
  });

  it("renames the open session through its titler once it has a message, and refuses while it has none — nothing to anchor a topic at (review 2026-09-30)", async () => {
    const cfg = mkConfig();
    const host = createSessionHost(cfg);
    // A fresh session: a name kept here would show on the sidebar's card
    // and be dropped by the next open, which keeps no title without a
    // user turn. Refused, and nothing written.
    const fresh = await host.createSession({});
    expect(await host.renameSession?.(fresh.sessionId, "我起的名字")).toEqual({
      ok: false,
    });
    expect(
      existsSync(join(cfg.transcriptDir, `${fresh.sessionId}.title.json`)),
    ).toBe(false);
    await host.closeActiveSession();

    persistClosedSession(cfg, "spoken", [{ kind: "user", text: "hi" }]);
    const s = await host.openSession({ sessionId: "spoken" });
    const r = await host.renameSession?.(s.sessionId, "我起的名字");
    expect(r?.ok).toBe(true);
    expect(r?.ok === true && r.title).toBe("我起的名字");
    expect(s.title).toBe("我起的名字");
    expect(readSessionTitle(cfg.transcriptDir, s.sessionId)).toBe("我起的名字");
    await host.closeActiveSession();
  });

  it("refuses an empty name and a session that does not exist, writing nothing", async () => {
    const cfg = mkConfig();
    persistClosedSession(cfg, "real", [{ kind: "user", text: "hi" }]);
    const host = createSessionHost(cfg);

    expect(await host.renameSession?.("real", "   ")).toEqual({ ok: false });
    expect(await host.renameSession?.("ghost", "名字")).toEqual({ ok: false });
    expect(existsSync(join(cfg.transcriptDir, "real.title.json"))).toBe(false);
    expect(existsSync(join(cfg.transcriptDir, "ghost.title.json"))).toBe(false);
  });

  it("caps a long name", async () => {
    const cfg = mkConfig();
    persistClosedSession(cfg, "long", [{ kind: "user", text: "hi" }]);
    const host = createSessionHost(cfg);
    const r = await host.renameSession?.("long", "名".repeat(200));
    expect(r?.ok && [...r.title].length).toBe(80);
  });
});

describe("readSessionForExport", () => {
  it("reads a closed session as the window shows it: no thoughts, no evidence sections", async () => {
    const cfg = mkConfig();
    const sessionId = "to-export";
    persistClosedSession(
      cfg,
      sessionId,
      [
        { kind: "user", text: "hi" },
        { kind: "herta", surface: "thought", text: "（想）" },
        { kind: "herta", surface: "speech", text: "你好。" },
        {
          kind: "system",
          label: "差分协处理器",
          body: "完成",
          role: "done-marker",
          evidenceDetail: "↳ 输出:\n很长的输出",
          evidence: [{ kind: "output", text: "很长的输出" }],
        },
      ],
      "en",
    );
    writeSessionTitle(cfg.transcriptDir, sessionId, "导出的会话");
    const host = createSessionHost(cfg);

    const src = await host.readSessionForExport?.(sessionId);

    expect(src?.title).toBe("导出的会话");
    expect(src?.lang).toBe("en");
    expect(src?.record.map((b) => b.kind)).toEqual(["user", "herta", "system"]);
    const marker = src?.record[2];
    expect(marker).toMatchObject({ kind: "system", body: "完成" });
    expect(marker).not.toHaveProperty("evidenceDetail");
    expect(marker).not.toHaveProperty("evidence");
    expect(host.activeSession).toBeNull();
  });

  it("leaves out a title the record no longer supports, as the window does", async () => {
    const cfg = mkConfig();
    persistClosedSession(cfg, "rewound", []);
    writeSessionTitle(cfg.transcriptDir, "rewound", "被撤回的标题");
    const host = createSessionHost(cfg);
    expect((await host.readSessionForExport?.("rewound"))?.title).toBeNull();
  });

  it("reads the open session from memory, and answers null for one that cannot be read", async () => {
    const cfg = mkConfig();
    const host = createSessionHost(cfg);
    const s = await host.createSession({ lang: "zh" });
    const src = await host.readSessionForExport?.(s.sessionId);
    expect(src?.sessionId).toBe(s.sessionId);
    expect(src?.lang).toBe("zh");
    expect(await host.readSessionForExport?.("ghost")).toBeNull();
    await host.closeActiveSession();
  });
});

// ── Dream material gate ───────────────────────────────────────────────────
//
// hasEnoughDreamMaterial is the net-new glue the cadence change introduces: it
// sources the "since" anchor from the persisted manifest, filters sessions by
// file mtime, reads only the touched transcripts, and applies the material
// rule. The pure halves are unit-tested in readiness.test.ts; these tests pin
// the host wiring end-to-end with real session files whose mtimes straddle a
// real manifest `lastRunAt`. (hasEnoughDreamMaterial is private; reached here
// through a structural cast — runtime access is unaffected by TS visibility.)

function writeSession(
  cfg: AppServerConfig,
  sessionId: string,
  hertaTurns: number,
  mtime: Date,
  lang?: "zh" | "en",
): void {
  const persister = V2RecordPersister.forNewSession({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    startedAt: new Date(),
    transcriptDir: cfg.transcriptDir,
    ...(lang !== undefined ? { lang } : {}),
  });
  persister.appendBlock({ kind: "user", text: "q" });
  for (let i = 0; i < hertaTurns; i++) {
    persister.appendBlock({ kind: "herta", surface: "speech", text: `r${i}` });
  }
  // Stamp the transcript's mtime — listSessions derives lastActivityAt from it.
  utimesSync(join(cfg.transcriptDir, `${sessionId}.jsonl`), mtime, mtime);
}

function writeDreamManifest(
  cfg: AppServerConfig,
  lastRunAt: string,
  lang: "zh" | "en" = "zh",
): void {
  const dreamDir = join(
    cfg.workspaceRoot,
    ".herta",
    lang === "en" ? "dream-en" : "dream",
  );
  mkdirSync(dreamDir, { recursive: true });
  writeFileSync(
    join(dreamDir, "manifest.json"),
    JSON.stringify({ version: 1, episodes: [], created: [], lastRunAt }),
    "utf8",
  );
}

function materialGate(cfg: AppServerConfig): boolean {
  const host = createSessionHost(cfg) as unknown as {
    hasEnoughDreamMaterial(): boolean;
  };
  return host.hasEnoughDreamMaterial();
}

describe("hasEnoughDreamMaterial (host wiring)", () => {
  it("fires on one long-enough session modified since the last pass", () => {
    const cfg = mkConfig();
    writeDreamManifest(cfg, "2026-06-10T00:00:00.000Z");
    writeSession(cfg, "long-new", 25, new Date("2026-06-15T00:00:00.000Z"));
    expect(materialGate(cfg)).toBe(true);
  });

  it("excludes a long session last modified BEFORE the last pass", () => {
    const cfg = mkConfig();
    writeDreamManifest(cfg, "2026-06-10T00:00:00.000Z");
    writeSession(cfg, "long-old", 25, new Date("2026-06-05T00:00:00.000Z"));
    expect(materialGate(cfg)).toBe(false);
  });

  it("treats every session as new when no manifest exists (since = 0)", () => {
    const cfg = mkConfig();
    for (let i = 0; i < 5; i++) {
      writeSession(cfg, `short-${i}`, 1, new Date("2026-06-15T00:00:00.000Z"));
    }
    expect(materialGate(cfg)).toBe(true); // 5 new sessions ≥ minNewSessions
  });

  it("with no key it is closed before anything is read — the pass could not run (dream review 2026-09-22, finding 11)", () => {
    const cfg = mkConfig();
    writeDreamManifest(cfg, "2026-06-10T00:00:00.000Z");
    writeSession(cfg, "long-new", 25, new Date("2026-06-15T00:00:00.000Z"));
    expect(
      materialGate({
        ...cfg,
        providers: { ...cfg.providers, deepseekApiKey: "" },
      }),
    ).toBe(false);
  });

  it("does not fire on too few short new sessions", () => {
    const cfg = mkConfig();
    writeDreamManifest(cfg, "2026-06-10T00:00:00.000Z");
    for (let i = 0; i < 4; i++) {
      writeSession(cfg, `few-${i}`, 3, new Date("2026-06-15T00:00:00.000Z"));
    }
    expect(materialGate(cfg)).toBe(false); // 4 < 5 and none ≥ 25 turns
  });
});

// ── Dream cadence anchor (audit 2026-07-16) ─────────────────────────────────
//
// lastDreamPassAtMs anchors the cadence on the OLDEST present language:
// run-dream-pass withholds `lastRunAt` on a transport abort so the trigger
// retries, and the previous MAX over zh+en let the OTHER language's completed
// pass advance the anchor anyway — cooldown-locking the aborted language's
// unconsumed episodes. (Private; reached through a structural cast like
// hasEnoughDreamMaterial above.)

function passAnchor(cfg: AppServerConfig): number | null {
  const host = createSessionHost(cfg) as unknown as {
    lastDreamPassAtMs(): number | null;
  };
  return host.lastDreamPassAtMs();
}

describe("lastDreamPassAtMs (cadence anchor)", () => {
  const T_OLD = "2026-06-01T00:00:00.000Z";
  const T_NEW = "2026-06-10T00:00:00.000Z";
  const at = new Date("2026-06-15T00:00:00.000Z");

  it("keeps the anchor OLD when en aborted after zh completed (MIN, not MAX)", () => {
    const cfg = mkConfig();
    writeSession(cfg, "s-zh", 2, at, "zh");
    writeSession(cfg, "s-en", 2, at, "en");
    // zh completed in the fresh run; en's abort left its lastRunAt at T_OLD.
    writeDreamManifest(cfg, T_NEW, "zh");
    writeDreamManifest(cfg, T_OLD, "en");
    expect(passAnchor(cfg)).toBe(Date.parse(T_OLD));
  });

  it("a present language with NO manifest (never completed) → null (fire-eligible)", () => {
    const cfg = mkConfig();
    writeSession(cfg, "s-zh", 2, at, "zh");
    writeSession(cfg, "s-en", 2, at, "en");
    // A brand-new EN corpus must not wait out zh's cooldown.
    writeDreamManifest(cfg, T_NEW, "zh");
    expect(passAnchor(cfg)).toBeNull();
  });

  it("ignores the OTHER language's manifest when only one language is present", () => {
    const cfg = mkConfig();
    writeSession(cfg, "s-zh", 2, at, "zh");
    // Only zh sessions: the en corpus (with no completed pass) must neither
    // null the anchor nor (were it fresher) advance it.
    writeDreamManifest(cfg, T_NEW, "zh");
    expect(passAnchor(cfg)).toBe(Date.parse(T_NEW));
  });

  it("legacy headers (no lang) count as zh", () => {
    const cfg = mkConfig();
    writeSession(cfg, "s-legacy", 2, at); // no lang in the header
    writeDreamManifest(cfg, T_NEW, "zh");
    expect(passAnchor(cfg)).toBe(Date.parse(T_NEW));
  });

  it("empty workspace behaves as {zh}: null with no manifest, zh's anchor with one", () => {
    const cfg = mkConfig();
    expect(passAnchor(cfg)).toBeNull();
    writeDreamManifest(cfg, T_OLD, "zh");
    expect(passAnchor(cfg)).toBe(Date.parse(T_OLD));
  });

  it("both languages completed → the MINIMUM of the two anchors", () => {
    const cfg = mkConfig();
    writeSession(cfg, "s-zh", 2, at, "zh");
    writeSession(cfg, "s-en", 2, at, "en");
    writeDreamManifest(cfg, T_OLD, "zh");
    writeDreamManifest(cfg, T_NEW, "en");
    expect(passAnchor(cfg)).toBe(Date.parse(T_OLD));
  });
});

// ── lifecycle serialization (audit 2026-07-10, finding 11) ───────────────────

describe("makeLifecycleSerializer", () => {
  it("runs ops strictly in call order — op B never starts before op A settles", async () => {
    const serialize = makeLifecycleSerializer();
    const log: string[] = [];
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const a = serialize(async () => {
      log.push("a:start");
      await gateA;
      log.push("a:end");
      return "a";
    });
    const b = serialize(async () => {
      log.push("b:start");
      return "b";
    });
    // Give B every chance to jump the queue.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log).toEqual(["a:start"]);
    releaseA();
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(log).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("a rejected op propagates to its caller without poisoning the chain", async () => {
    const serialize = makeLifecycleSerializer();
    const failing = serialize(async () => {
      throw new Error("boom");
    });
    const after = serialize(async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    expect(await after).toBe("ok");
  });
});

describe("host lifecycle serialization", () => {
  it("concurrent openSession calls settle in call order — the LAST call ends active", async () => {
    const cfg = mkConfig();
    const mkFile = (id: string): void => {
      const p = V2RecordPersister.forNewSession({
        sessionId: id,
        workspaceRoot: cfg.workspaceRoot,
        startedAt: new Date(),
        transcriptDir: cfg.transcriptDir,
      });
      p.appendBlock({ kind: "user", text: id });
    };
    mkFile("racer-a");
    mkFile("racer-b");
    const host = createSessionHost(cfg);
    // Fire both without awaiting. Pre-fix each op assigned `_active` as it
    // resolved, so a slow A landing after B routed every later IPC to A
    // while the renderer pointed at B (and B leaked un-closed).
    const [a, b] = await Promise.all([
      host.openSession({ sessionId: "racer-a" }),
      host.openSession({ sessionId: "racer-b" }),
    ]);
    expect(a.sessionId).toBe("racer-a");
    expect(b.sessionId).toBe("racer-b");
    expect(host.activeSession?.sessionId).toBe("racer-b");
    await host.closeActiveSession();
  });
});

// ── dream-activity wrapping (audit 2026-07-10, finding 21) ──────────────────

describe("wrapSessionForDreamActivity", () => {
  it("notes activity for every turn-running entry point, not just submitText", async () => {
    const calls = { note: 0, tick: 0 };
    const trigger = {
      noteActivity: () => {
        calls.note += 1;
      },
      tick: () => {
        calls.tick += 1;
      },
    };
    const fake = {
      submitText: async () => ({ turnId: "t" }),
      regenerateLastReplyIfOrphaned: async () => undefined,
      playOpening: async () => undefined,
      interrupt: async () => ({ ok: false }),
    } as unknown as Session;
    const wrapped = wrapSessionForDreamActivity(fake, trigger);

    await wrapped.submitText("hi");
    await wrapped.regenerateLastReplyIfOrphaned?.();
    await wrapped.playOpening?.();
    // Both ends of each call count (dream review 2026-09-22, finding 2).
    expect(calls.note).toBe(6);
    // tick fires in a detached microtask right after each wrapped call.
    await Promise.resolve();
    expect(calls.tick).toBe(3);

    // Non-turn methods pass through untouched.
    await wrapped.interrupt();
    expect(calls.note).toBe(6);
  });

  it("a turn's END restarts the idle clock — a long run never ends into a pass the moment the reply lands (dream review 2026-09-22, finding 2)", async () => {
    const stamps: string[] = [];
    let release!: () => void;
    const turn = new Promise<void>((r) => {
      release = r;
    });
    const trigger = {
      noteActivity: () => {
        stamps.push("note");
      },
      tick: () => {
        stamps.push("tick");
      },
    };
    const fake = {
      submitText: async () => {
        stamps.push("turn-start");
        await turn;
        stamps.push("turn-end");
        return { turnId: "t" };
      },
    } as unknown as Session;
    const wrapped = wrapSessionForDreamActivity(fake, trigger);
    const p = wrapped.submitText("a long 板砖 run");
    release();
    await p;
    await Promise.resolve();
    expect(stamps).toEqual(["note", "turn-start", "turn-end", "note", "tick"]);
  });
});

// ADR 0064 amendment 2026-11-12. The choice lived in the workspace
// (`.herta/permissions.json`) and was read as found, so a folder that arrived
// with the file had automatic review on with no choice by the owner.
describe("the automatic-review choice is kept outside the workspace", () => {
  /** A folder the session works in, removed with the rest. */
  function folder(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  }
  /** A folder that arrives holding the OLD per-workspace file. */
  function folderWithOldFile(autoReview: boolean): string {
    const d = folder("herta-review-old-");
    mkdirSync(join(d, ".herta"), { recursive: true });
    writeFileSync(
      join(d, ".herta", "permissions.json"),
      JSON.stringify({ version: 1, autoReview }),
    );
    return d;
  }
  const withStore = (cfg: AppServerConfig): AppServerConfig => ({
    ...cfg,
    reviewChoicesFile: join(
      folder("herta-review-home-"),
      ".herta",
      "review-choices.json",
    ),
  });

  it("a choice is written to the one file and nothing into the workspace, and the next launch reads it back", async () => {
    const cfg = withStore(mkConfig());
    const ws = folder("herta-review-ws-");
    const host = createSessionHost(cfg);
    const session = await host.createSession({ backendWorkspace: ws });
    expect((await session.getAutoReview?.())?.explicit).toBeNull();
    expect((await session.setAutoReview?.(true))?.explicit).toBe(true);
    expect(existsSync(join(ws, ".herta", "permissions.json"))).toBe(false);
    expect(existsSync(cfg.reviewChoicesFile as string)).toBe(true);
    const sessionId = session.sessionId;
    await host.closeActiveSession();

    const again = createSessionHost(cfg);
    const reopened = await again.openSession({ sessionId });
    const state = await reopened.getAutoReview?.();
    expect(state?.explicit).toBe(true);
    expect(state?.on).toBe(true);
    await again.closeActiveSession();
  });

  it("a folder that arrives with the old file in it has no choice: review is off there until the owner says", async () => {
    const cfg = withStore(mkConfig());
    const cloned = folderWithOldFile(true);
    const host = createSessionHost(cfg);
    const session = await host.createSession({ backendWorkspace: cloned });
    const state = await session.getAutoReview?.();
    expect(state?.explicit).toBeNull();
    expect(state?.on).toBe(false);
    await host.closeActiveSession();
  });

  it("the old files of the workspaces this host's own records name are carried over once, before the first session reads the store", async () => {
    // An earlier build: no store, the session's record names its workspace.
    const earlier = mkConfig();
    const known = folderWithOldFile(true);
    const before = createSessionHost(earlier);
    const sessionId = (await before.createSession({ backendWorkspace: known }))
      .sessionId;
    await before.closeActiveSession();

    // This build's first launch.
    const cfg = withStore(earlier);
    const host = createSessionHost(cfg);
    const reopened = await host.openSession({ sessionId });
    expect((await reopened.getAutoReview?.())?.explicit).toBe(true);
    // The old file is left where it was, and is never read again.
    expect(existsSync(join(known, ".herta", "permissions.json"))).toBe(true);

    // A folder that turns up afterwards gets nothing from its own file.
    const later = folderWithOldFile(true);
    const next = await host.createSession({ backendWorkspace: later });
    expect((await next.getAutoReview?.())?.explicit).toBeNull();
    await host.closeActiveSession();

    // Nor on the launch after that, when a record does name it.
    const third = createSessionHost(cfg);
    const again = await third.openSession({ sessionId: next.sessionId });
    expect((await again.getAutoReview?.())?.explicit).toBeNull();
    await third.closeActiveSession();
  });

  it("deleting a session drops the choice made for its managed workspace: the folder goes, and the choice is no longer inside it", async () => {
    const cfg = withStore(mkConfig());
    const host = createSessionHost(cfg);
    // No workspace named: the session gets its own managed one.
    const session = await host.createSession({});
    const state = await session.setAutoReview?.(false);
    expect(state?.isDefaultWorkspace).toBe(true);
    const stored = (): Record<string, unknown> =>
      JSON.parse(readFileSync(cfg.reviewChoicesFile as string, "utf8"))
        .workspaces;
    expect(Object.keys(stored())).toHaveLength(1);
    // A picked folder's choice is not the session's to take with it.
    const picked = folder("herta-review-kept-");
    await session.setWorkspace(picked);
    await session.setAutoReview?.(true);
    expect(Object.keys(stored())).toHaveLength(2);

    await host.deleteSession(session.sessionId);
    const left = stored();
    expect(Object.keys(left)).toHaveLength(1);
    expect(Object.values(left)).toEqual([{ autoReview: true }]);
  });
});
