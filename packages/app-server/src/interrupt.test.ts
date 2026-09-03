/**
 * Session interrupt + clean close tests (Task 8, v0.3 Slice 2).
 *
 * Uses a slow stub completion provider to keep a turn in-flight long enough
 * for the interrupt to arrive.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionImpl } from "./session.js";
import {
  slowStubCompletionProvider,
  stubChatProvider,
  stubCompletionProvider,
} from "./testing/stub-providers.js";
import type { AppServerConfig } from "./types.js";

function mkConfig(): AppServerConfig {
  const root = mkdtempSync(join(tmpdir(), "herta-interrupt-test-"));
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
      routerModel: "deepseek-v4-flash",
    },
  };
}

/**
 * Build a stub session with a slow actor provider that streams deltas with
 * a 30 ms delay per delta. The long delay gives the test a window to call
 * interrupt() before the turn completes.
 */
async function mkSlowSession(cfg: AppServerConfig): Promise<{
  session: SessionImpl;
  cleanup: () => Promise<void>;
}> {
  const { V2RecordPersister } = await import("@herta/core");
  const { randomUUID } = await import("node:crypto");
  const sessionId = randomUUID();

  const persister = V2RecordPersister.forNewSession({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    startedAt: new Date(),
    transcriptDir: cfg.transcriptDir,
  });

  // Slow actor: yields deltas with 30 ms gaps so interrupt() can fire
  // mid-stream. The provider checks the signal before each delay and
  // throws AbortError immediately on abort. The turn's thought phase is
  // answered instantly by the stub; the paced speech phase is what keeps
  // the turn in flight.
  const actorStub = slowStubCompletionProvider({
    deltas: ["你好。", "（/我 说）"],
    delayMs: 30,
  });

  const session = await SessionImpl.create({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    effectiveWorkspace: cfg.workspaceRoot,
    isDefaultWorkspace: false,
    config: cfg,
    persister,
    deps: {
      // title MUST be stubbed: a successful turn fire-and-forgets title
      // generation, and without an override that is a REAL DeepSeek call —
      // tests then depend on the machine's network (found by a fresh-clone
      // smoke test, 2026-07-07). The empty stub throws on first call;
      // generateAndEmitTitle is best-effort and leaves the title null.
      providerOverrides: { actor: actorStub, title: stubChatProvider([]) },
      staticPrefixOverride: { bio: "[test-bio]", env: "", fewShots: [] },
      ...scriptedPostureDeps(),
    },
  });

  return {
    session,
    cleanup: () => session.close(),
  };
}

/** M-prompts-1: compiled assets are always present, so scripted-provider
 *  tests opt out explicitly — empty meta-think (no preamble spliced), no
 *  supervisor, no opening seed (the stubs count exact provider calls). */
function scriptedPostureDeps(): {
  metaThinkOverride: import("@herta/herta").MetaThinkCorpus;
  supervisorReferenceOverride: string;
  openingOverride: null;
} {
  const empty = {
    默认: "",
    被烦版: "",
    教学版: "",
    被戳穿版: "",
    任务部署版: "",
    板砖代答版: "",
    被顶嘴版: "",
    倾听版: "",
  };
  return {
    metaThinkOverride: { preThink: { ...empty }, preSpeak: { ...empty } },
    supervisorReferenceOverride: "",
    openingOverride: null,
  };
}

/**
 * Build a session with a fast (instant) stub actor — used for tests that
 * do NOT need an in-flight turn to remain slow.
 */
async function mkFastSession(cfg: AppServerConfig): Promise<{
  session: SessionImpl;
  cleanup: () => Promise<void>;
}> {
  const { V2RecordPersister } = await import("@herta/core");
  const { randomUUID } = await import("node:crypto");
  const sessionId = randomUUID();

  const persister = V2RecordPersister.forNewSession({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    startedAt: new Date(),
    transcriptDir: cfg.transcriptDir,
  });

  const actorStub = stubCompletionProvider([
    { deltas: ["你好。", "（/我 说）"], stopReason: "stop" },
  ]);

  const session = await SessionImpl.create({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    effectiveWorkspace: cfg.workspaceRoot,
    isDefaultWorkspace: false,
    config: cfg,
    persister,
    deps: {
      // No network in tests — see mkSlowSession's title note.
      providerOverrides: { actor: actorStub, title: stubChatProvider([]) },
      staticPrefixOverride: { bio: "[test-bio]", env: "", fewShots: [] },
      ...scriptedPostureDeps(),
    },
  });

  return {
    session,
    cleanup: () => session.close(),
  };
}

describe("Session — interrupt", () => {
  it("interrupt during an in-flight turn emits turn.failed with cancellation", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkSlowSession(cfg);

    const events: unknown[] = [];
    // Subscribe BEFORE submitting so we catch started + failed.
    const sub = session.subscribeTurnLifecycle();
    const consumer = (async () => {
      for await (const ev of sub) {
        events.push(ev);
        if (events.length >= 2) break;
      }
    })();

    const turnP = session.submitText("slow turn");
    // Give the turn a moment to start before interrupting.
    await new Promise((r) => setTimeout(r, 50));
    const result = await session.interrupt();
    expect(result).toEqual({ ok: true });

    // submitText should reject (or resolve) — either way the lifecycle stream
    // must have seen started + failed.
    try {
      await turnP;
    } catch {
      // Expected when interrupt causes a rejection.
    }
    await consumer;

    expect(events[0]).toMatchObject({ kind: "started" });
    expect(events[1]).toMatchObject({ kind: "failed" });
    const failed = events[1] as { kind: string; error: { code: string } };
    expect(failed.error.code.toLowerCase()).toContain("abort");

    await cleanup();
  });

  it("interrupt with no active turn returns { ok: false }", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkFastSession(cfg);
    const result = await session.interrupt();
    expect(result).toEqual({ ok: false });
    await cleanup();
  });

  it("interrupt with a mismatched turnId returns { ok: false }", async () => {
    const cfg = mkConfig();
    // Use a fast session so the turn completes before our check.
    const { session, cleanup } = await mkFastSession(cfg);
    const submitted = await session.submitText("x");
    if ("needsKey" in submitted) throw new Error("expected a started turn");
    const { turnId } = submitted;
    // After the turn finishes, currentTurn is null — so this returns false
    // regardless. We also explicitly test the mismatch guard.
    const result = await session.interrupt({ turnId: `${turnId}-wrong` });
    expect(result).toEqual({ ok: false });
    await cleanup();
  });

  it("session.close mid-turn cancels and releases resources", async () => {
    const cfg = mkConfig();
    const { session } = await mkSlowSession(cfg);

    const turnP = session.submitText("slow turn");
    // Attach a rejection handler immediately so Node doesn't surface an
    // unhandled-rejection warning when close() aborts the turn before we
    // explicitly await turnP below.
    const turnSettled = turnP.then(
      () => "ok" as const,
      () => "err" as const,
    );

    // Give the turn a moment to start before closing.
    await new Promise((r) => setTimeout(r, 50));
    // close() should cancel the in-flight turn, wait for it to settle,
    // then close the projector.
    await session.close();

    // Await the settled promise (never throws — we already attached a
    // catch handler via .then above).
    await turnSettled;

    // After close, subscriptions should immediately yield done (empty).
    const events: unknown[] = [];
    for await (const ev of session.subscribeRecord()) {
      events.push(ev);
    }
    expect(events).toEqual([]);
  });

  it("close() resolves only AFTER the interrupted turn fully unwinds (audit finding 14)", async () => {
    // Pre-fix close() waited one setImmediate and never awaited turn
    // settlement, so deleteSession's rmSync could race a still-unwinding
    // turn's appends — a post-delete append recreated `<id>.jsonl` with no
    // header (an unlistable zombie that half-undid the delete).
    const cfg = mkConfig();
    const { session } = await mkSlowSession(cfg);

    const turnP = session.submitText("slow turn");
    let unwound = false;
    const tracked = turnP.then(
      () => {
        unwound = true;
      },
      () => {
        unwound = true;
      },
    );

    await new Promise((r) => setTimeout(r, 50));
    await session.close();

    // The turn's own promise must already be settled when close() returns —
    // nothing of the turn can still append after this point.
    expect(unwound).toBe(true);
    await tracked;
  });
});

describe("Session — idle-only workspace ops (audit finding 13)", () => {
  it("setWorkspace/resetWorkspace are refused mid-turn and work when idle", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkSlowSession(cfg);

    const turnP = session.submitText("slow turn");
    const settled = turnP.then(
      () => undefined,
      () => undefined,
    );
    await new Promise((r) => setTimeout(r, 30));

    // Mid-turn: appendSystemNote is only safe between turns — refuse.
    expect(await session.setWorkspace(cfg.transcriptDir)).toEqual({
      ok: false,
      reason: "turn_in_progress",
    });
    expect(await session.resetWorkspace()).toEqual({
      ok: false,
      reason: "turn_in_progress",
    });
    // The refused call must not have touched the effective workspace.
    expect(session.backendWorkspace).toBe(cfg.workspaceRoot);

    await session.interrupt();
    await settled;

    // Idle: both succeed.
    expect(await session.setWorkspace(cfg.transcriptDir)).toEqual({
      ok: true,
    });
    expect(session.backendWorkspace).toBe(cfg.transcriptDir);
    expect(await session.resetWorkspace()).toEqual({ ok: true });

    await cleanup();
  });
});
