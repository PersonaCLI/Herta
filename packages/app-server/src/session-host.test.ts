import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSessionFile,
  V2RecordPersister,
  writeSessionTitle,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  createSessionHost,
  makeLifecycleSerializer,
  wrapSessionForDreamActivity,
} from "./session-host.js";
import type { AppServerConfig, Session } from "./types.js";

function mkConfig(): AppServerConfig {
  const root = mkdtempSync(join(tmpdir(), "herta-app-server-test-"));
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

    expect(r).toEqual({ ok: true, wasActive: false });
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

    expect(r).toEqual({ ok: true, wasActive: true });
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
    expect(calls.note).toBe(3);
    // tick fires in a detached microtask right after each wrapped call.
    await Promise.resolve();
    expect(calls.tick).toBe(3);

    // Non-turn methods pass through untouched.
    await wrapped.interrupt();
    expect(calls.note).toBe(3);
  });
});
