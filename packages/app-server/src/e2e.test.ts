/**
 * End-to-end scripted turn for @herta/app-server (Task 9, v0.3 Slice 2).
 *
 * Full @板砖 dispatch path:
 *   submitText("写一行到 a.ts")
 *     → actor emits herta block containing @板砖
 *     → backend bridge fires → backend calls write_new_file
 *     → RulePermissionEngine.check() → OverlayAskResolver.present() suspends
 *     → OverlayEvent { kind: "pending" } emitted
 *     → test resolves allow → backend writes a.ts
 *     → actor emits verdict herta block
 *     → turn.lifecycle finished
 *
 * Assertions:
 *   - Record sequence: user block, herta(thought), herta(@板砖) block, system
 *     blocks (差分协处理器 + 系统), herta(beat), herta(thought), herta(verdict)
 *     block — every main-loop speech is preceded by its thought (the
 *     always-think rhythm, 2026-09-03).
 *   - Exactly one OverlayEvent pending + one resolved.
 *   - TurnLifecycle started then finished (no failed).
 *   - JSONL on disk: header + one line per block committed by submitText.
 *   - a.ts was actually written to the tmpdir workspace.
 *
 * Emission model (post 2026-06-01 canonical-diff-sink fix):
 *   - All blocks reach record subscribers via BusActorStreamingSink.flushBlocks
 *     called at every block-append site in the actor turn + @板砖 bridge.
 *   - Blocks are emitted in canonical order (same as session.record / JSONL).
 *   - Each block is emitted exactly once — no double-emission window.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionImpl } from "./session.js";
import {
  stubChatProvider,
  stubCompletionProvider,
} from "./testing/stub-providers.js";
import type { AppServerConfig, OverlayEvent, RecordEvent } from "./types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** A completion adapter that throws on every call — a plain provider failure
 *  (bad key / 402 / dropped connection), NOT an abort. */
function throwingCompletionProvider(): {
  streamCompletion: () => AsyncIterable<never>;
} {
  return {
    streamCompletion(): AsyncIterable<never> {
      // biome-ignore lint/correctness/useYield: throw-only stream — the generator exists to raise from inside the async-iteration protocol
      return (async function* (): AsyncGenerator<never> {
        throw new Error("provider exploded (402 Insufficient Balance)");
      })();
    },
  };
}

function mkConfig(): AppServerConfig {
  const root = mkdtempSync(join(tmpdir(), "herta-e2e-test-"));
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
 * Build a fully-wired SessionImpl for the e2e test.
 *
 * Actor (completion) provider — three scripted speeches; the thought prompt
 * ahead of each main-loop speech is auto-answered by the stub:
 *   Speech 1: Herta's first speech contains @板砖, triggering the bridge.
 *   Speech 2: the in-turn beat the bridge fires on patch.preview.
 *   Speech 3: After the bridge completes, Herta emits a verdict.
 *
 * Backend (chat) provider — two scripted turns:
 *   Turn 1: write_new_file tool call for a.ts. This hits the
 *           RulePermissionEngine (registerWriteNewFileRule is set up by
 *           SessionImpl.create), which emits patch.preview on the bus and
 *           returns kind:"ask". The OverlayAskResolver suspends until the
 *           test calls resolveApproval.
 *   Turn 2: after approval, "done." text response.
 */
async function mkE2eSession(cfg: AppServerConfig): Promise<{
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

  // Actor: completion provider. The prompt forces the surface (`（我 想）` for
  // the thought phase, `（我 说）` for the speech), so a script is just the
  // body plus its close tag. @板砖 inside the first speech body triggers
  // invokeBanzhuanBridge. The second script is the beat fired by the
  // BeatPolicy when it sees the patch.preview event. The third is the verdict.
  //
  // Beat ordering (per BeatPolicy rules): the write_new_file permission rule
  // emits patch.preview on the bus before returning kind:"ask". The drain
  // task in invokeBanzhuanBridge picks this up and fires a beat via
  // makeFireBeat (a speech-surface prompt, no thought). After the bridge
  // completes, the main loop thinks again and speaks the verdict.
  const actorStub = stubCompletionProvider([
    {
      // Speech 1: Herta delegates to 板砖.
      deltas: ["@板砖 写一行到 a.ts。（/我 说）"],
      stopReason: "stop",
    },
    {
      // Speech 2: In-turn beat triggered by patch.preview event.
      // Beats are always speech surface. Short one-liner reaction.
      deltas: ["一行代码，看起来没问题。（/我 说）"],
      stopReason: "stop",
    },
    {
      // Speech 3: Main loop verdict after bridge completes.
      deltas: ["写完了，一行加进去了。（/我 说）"],
      stopReason: "stop",
    },
  ]);

  // Backend: chat provider.
  // Turn 1: model calls write_new_file. The permission rule fires (ask),
  //         bridge suspends at OverlayAskResolver.present().
  // Turn 2: after approval, model says done.
  const backendStub = stubChatProvider([
    {
      events: [
        {
          type: "tool-call-request",
          call: {
            id: "wf1",
            tool: "write_new_file",
            input: { path: "a.ts", content: "export const a = 1;\n" },
          },
        },
        { type: "finish", reason: "tool_calls" },
      ],
    },
    {
      events: [
        { type: "text-delta", text: "done." },
        { type: "finish", reason: "stop" },
      ],
    },
  ]);

  const session = await SessionImpl.create({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    effectiveWorkspace: cfg.workspaceRoot,
    isDefaultWorkspace: false,
    config: cfg,
    persister,
    deps: {
      providerOverrides: {
        actor: actorStub,
        backend: backendStub,
        // No network in tests: without a title override, a successful turn's
        // fire-and-forget title generation makes a REAL DeepSeek call. The
        // empty stub throws on call; title gen is best-effort → title null.
        title: stubChatProvider([]),
      },
      staticPrefixOverride: { bio: "[test-bio]", env: "", fewShots: [] },
      // M-prompts-1: the compiled assets are ALWAYS present now, so the
      // scripted-provider posture must opt out explicitly — an empty
      // meta-think corpus splices no preamble, no supervisor, and no
      // opening seed (the stub scripts count exact provider calls).
      metaThinkOverride: emptyMetaThinkCorpus(),
      supervisorReferenceOverride: "",
      openingOverride: null,
    },
  });

  return {
    session,
    cleanup: () => session.close(),
  };
}

function emptyMetaThinkCorpus(): import("@herta/herta").MetaThinkCorpus {
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
  return { preThink: { ...empty }, preSpeak: { ...empty } };
}

// ── test ─────────────────────────────────────────────────────────────────────

describe("failed turn — record re-alignment (audit 2026-07-24, H1)", () => {
  /**
   * A plain provider throw lands AFTER the actor flushed the user block, so
   * the block is on the user's screen and in the JSONL — but the driver
   * reverts to its pre-turn record. Pre-fix the three copies stayed split for
   * the rest of the session, and `rewindLastTurn` (index from the DRIVER,
   * truncation against the DISK) then withdrew the PREVIOUS turn and deleted
   * the failed message with it. The session now adopts the flushed record.
   */
  async function mkFailingSession(cfg: AppServerConfig): Promise<SessionImpl> {
    const { V2RecordPersister } = await import("@herta/core");
    const { randomUUID } = await import("node:crypto");
    const sessionId = randomUUID();
    return SessionImpl.create({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      effectiveWorkspace: cfg.workspaceRoot,
      isDefaultWorkspace: false,
      config: cfg,
      persister: V2RecordPersister.forNewSession({
        sessionId,
        workspaceRoot: cfg.workspaceRoot,
        startedAt: new Date(),
        transcriptDir: cfg.transcriptDir,
      }),
      deps: {
        providerOverrides: {
          actor: throwingCompletionProvider() as never,
          backend: stubChatProvider([]),
          title: stubChatProvider([]),
        },
        staticPrefixOverride: { bio: "[test-bio]", env: "", fewShots: [] },
        metaThinkOverride: emptyMetaThinkCorpus(),
        supervisorReferenceOverride: "",
        openingOverride: null,
      },
    });
  }

  it("records a turn_end marker so a failed turn is not mistaken for a crash (H1.6)", async () => {
    const cfg = mkConfig();
    const session = await mkFailingSession(cfg);
    try {
      await expect(session.submitText("这条会失败")).rejects.toThrow();
      // The record ends on a user block — byte-identical to a crash-orphaned
      // session. What distinguishes them is the recorded ending.
      const { readFileSync: read } = await import("node:fs");
      const { join: j } = await import("node:path");
      const { readdirSync } = await import("node:fs");
      const file = readdirSync(cfg.transcriptDir).find((f) =>
        f.endsWith(".jsonl"),
      );
      expect(file).toBeDefined();
      const lines = read(j(cfg.transcriptDir, file as string), "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const ends = lines.filter((l) => l._kind === "turn_end");
      expect(ends).toHaveLength(1);
      expect(ends[0]?.outcome).toBe("failed");
      // And the marker is a META line — block indices (rewind, topic anchors,
      // the sink cursor) are unaffected.
      const blocks = lines.filter((l) => l._kind === undefined);
      expect(blocks.filter((b) => b.kind === "user")).toHaveLength(1);

      // Resume-recovery must now REFUSE to regenerate: this turn ended, it
      // did not crash. Pre-fix the trailing user block alone re-ran it.
      await session.regenerateLastReplyIfOrphaned();
      expect(session.record.filter((b) => b.kind === "herta")).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  it("keeps the failed user block in the driver's record, so rewind targets IT", async () => {
    const cfg = mkConfig();
    const session = await mkFailingSession(cfg);
    try {
      await expect(session.submitText("这条会失败")).rejects.toThrow();

      // The block the user is looking at (and that disk holds) is now also
      // the driver's — all three copies agree.
      const record = session.record;
      const users = record.filter((b) => b.kind === "user");
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ kind: "user", text: "这条会失败" });

      // Rewind therefore withdraws the FAILED turn, not the one before it.
      const res = await session.rewindLastTurn();
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.userText).toBe("这条会失败");
      expect(session.record.filter((b) => b.kind === "user")).toHaveLength(0);
    } finally {
      await session.close();
    }
  });
});

describe("@herta/app-server — end-to-end scripted turn", () => {
  it("user message → @板砖 dispatch → approval → backend write → verdict", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkE2eSession(cfg);

    // ── Subscribe to all four channels BEFORE submitText ─────────────────
    // Subscriptions are eager (queue allocated at subscribe time), so
    // events emitted synchronously during submitText are buffered.

    // Collect record events. Break after we see the herta verdict block.
    // Each block in result.record is emitted exactly once via
    // BusActorStreamingSink.flushBlocks in canonical order.
    //
    // The actor speaks 3 times per turn (the two main-loop speeches are each
    // preceded by an auto-answered thought; the beat has none):
    //   Speech 1: @板砖 dispatch
    //   Speech 2: in-turn beat (triggered by patch.preview BeatPolicy rule)
    //   Speech 3: verdict
    // So we wait for 3 herta SPEECH blocks in the record stream.
    const isSpeechEvent = (e: RecordEvent): boolean =>
      e.kind === "block" &&
      e.block.kind === "herta" &&
      e.block.surface === "speech";
    const recordEvents: RecordEvent[] = [];
    let verdictSeen = false;
    const recordConsumer = (async () => {
      for await (const ev of session.subscribeRecord()) {
        recordEvents.push(ev);
        // Verdict is the third herta speech block in the stream
        // (dispatch + beat + verdict); thought blocks stream too but do
        // not count toward it.
        if (
          isSpeechEvent(ev) &&
          recordEvents.filter(isSpeechEvent).length >= 3
        ) {
          verdictSeen = true;
          break;
        }
      }
    })();

    // Overlay consumer: auto-resolve the first pending overlay.
    const overlayEvents: OverlayEvent[] = [];
    const overlayConsumer = (async () => {
      for await (const ev of session.subscribeOverlay()) {
        overlayEvents.push(ev);
        if (ev.kind === "pending") {
          // ev.overlay is ApprovalOverlayState { kind: "pending-permission", requestId }
          const overlay = ev.overlay as { requestId: string };
          // resolveApproval is async but we don't need to await it here —
          // the bridge's OverlayAskResolver.present() will unblock.
          session
            .resolveApproval({
              requestId: overlay.requestId,
              decision: "allow",
            })
            .catch(() => undefined); // suppress any rejection in cleanup
        }
        if (ev.kind === "resolved") break;
      }
    })();

    // Turn lifecycle.
    const turnEvents: { kind: string }[] = [];
    const turnConsumer = (async () => {
      for await (const ev of session.subscribeTurnLifecycle()) {
        turnEvents.push(ev);
        if (ev.kind === "finished" || ev.kind === "failed") break;
      }
    })();

    // ── Fire the turn ────────────────────────────────────────────────────
    await session.submitText("写一行到 a.ts");

    // Wait for all consumers to finish.
    await Promise.all([recordConsumer, overlayConsumer, turnConsumer]);

    // ── Turn lifecycle ───────────────────────────────────────────────────
    expect(turnEvents[0]).toMatchObject({ kind: "started" });
    expect(turnEvents[turnEvents.length - 1]).toMatchObject({
      kind: "finished",
    });
    expect(turnEvents.some((e) => e.kind === "failed")).toBe(false);

    // ── Overlay events ───────────────────────────────────────────────────
    // Exactly one pending + one resolved.
    const pendingOverlays = overlayEvents.filter((e) => e.kind === "pending");
    const resolvedOverlays = overlayEvents.filter((e) => e.kind === "resolved");
    expect(pendingOverlays).toHaveLength(1);
    expect(resolvedOverlays).toHaveLength(1);

    // ── Record sequence ──────────────────────────────────────────────────
    // After the canonical-diff-sink fix (2026-06-01), the live record stream
    // arrives in the SAME order as session.record / the JSONL: every block is
    // projected exactly once, in canonical order, by BusActorStreamingSink
    // .flushBlocks during the turn. Canonical order for this scripted turn:
    //   user → herta(thought) → herta(@板砖) → 系统(patch preview)
    //        → 差分协处理器(Writing) → herta(beat) → 差分协处理器(done-marker)
    //        → herta(thought) → herta(verdict)
    const blockEvents = recordEvents.filter(
      (e): e is Extract<RecordEvent, { kind: "block" }> => e.kind === "block",
    );
    const blocks = blockEvents.map((e) => e.block);

    // Exactly 9 blocks in the stream — canonical order, no duplicates.
    // (1 user + 2 thoughts + 3 speeches + 3 system.)
    expect(blocks).toHaveLength(9);

    const userBlocks = blocks.filter((b) => b.kind === "user");
    const thoughtBlocks = blocks.filter(
      (b) => b.kind === "herta" && b.surface === "thought",
    );
    const speechBlocks = blocks.filter(
      (b) => b.kind === "herta" && b.surface === "speech",
    );
    const systemBlocks = blocks.filter((b) => b.kind === "system");
    expect(userBlocks).toHaveLength(1);
    expect(thoughtBlocks).toHaveLength(2);
    expect(speechBlocks).toHaveLength(3);
    expect(systemBlocks).toHaveLength(3);

    // Dispatch block: first speech block, contains @板砖.
    const dispatchBlock = speechBlocks.find((b) =>
      (b as { text: string }).text.includes("@板砖"),
    );
    expect(dispatchBlock).toBeDefined();

    // The Writing block (role-less) appears exactly once — no double-publish.
    // The done-marker (synthesized off-bus, role:"done-marker") also reaches
    // the stream via flushBlocks.
    const writingBlocks = systemBlocks.filter(
      (b) =>
        (b as { label: string }).label === "差分协处理器" &&
        (b as { role?: string }).role === undefined,
    );
    const doneMarkers = systemBlocks.filter(
      (b) =>
        (b as { label: string }).label === "差分协处理器" &&
        (b as { role?: string }).role === "done-marker",
    );
    expect(writingBlocks).toHaveLength(1);
    expect(doneMarkers).toHaveLength(1);
    expect((doneMarkers[0] as { body: string }).body).toContain("完成");

    const previewBlocks = systemBlocks.filter(
      (b) =>
        (b as { label: string }).label === "系统" &&
        (b as { body: string }).body.includes("patch preview"),
    );
    expect(previewBlocks).toHaveLength(1);

    // Stream order == canonical record order: the stream's blocks are exactly
    // session.record, in order (no opening seed in this tmp workspace, so the
    // two are equal length). This is the core regression assertion for the
    // 2026-06-01 ordering fix. The streamed copies carry a render-only `at`
    // (stamped by the sink for the GUI) absent from the in-memory record;
    // normalize it out so this stays an ordering/content assertion.
    expect(blocks.map((b) => ({ ...b, at: undefined }))).toEqual(
      session.record,
    );

    // Spot-check the canonical positions the bug used to violate: the user
    // block is first, the turn's thought follows it, and the first backend
    // system block comes AFTER the @板砖 dispatch (herta) block — never
    // before it.
    const userIdx = blocks.findIndex((b) => b.kind === "user");
    const dispatchIdx = blocks.findIndex(
      (b) =>
        b.kind === "herta" &&
        b.surface === "speech" &&
        (b as { text: string }).text.includes("@板砖"),
    );
    const firstSystemIdx = blocks.findIndex((b) => b.kind === "system");
    expect(userIdx).toBe(0);
    expect(dispatchIdx).toBe(2);
    expect(firstSystemIdx).toBeGreaterThan(dispatchIdx);

    // Verdict block is the last speech block in the stream and must not
    // contain the @板砖 trigger.
    const verdictBlock = speechBlocks[speechBlocks.length - 1];
    expect(verdictBlock).toBeDefined();
    expect((verdictBlock as { text: string }).text).not.toContain("@板砖");

    // ── File written to disk ─────────────────────────────────────────────
    const writtenPath = join(cfg.workspaceRoot, "a.ts");
    expect(existsSync(writtenPath)).toBe(true);
    const writtenContent = readFileSync(writtenPath, "utf-8");
    expect(writtenContent).toContain("export const a = 1;");

    // ── JSONL on disk ────────────────────────────────────────────────────
    // The JSONL is written by the driver (persister.appendBlock) as each
    // block is appended during the turn — 9 blocks total:
    // user + herta(thought) + herta(@板砖) + system(系统/patch-preview) +
    // system(差分协处理器/Writing) + herta(beat) +
    // system(差分协处理器/done-marker) + herta(thought) + herta(verdict).
    // The done-marker is appended by invokeBanzhuanBridge at the end of the
    // backend run (after drainTask, before the actor's post-bridge verdict)
    // and is persisted like any other system block. The file also has a
    // session_meta header line, plus a trailing `turn_end` meta line
    // recording how the turn finished (audit 2026-07-24, 1.6).
    const sessionFile = join(cfg.transcriptDir, `${session.sessionId}.jsonl`);
    expect(existsSync(sessionFile)).toBe(true);
    const jsonlLines = readFileSync(sessionFile, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    // Assert on BLOCK lines so a future meta line doesn't make this brittle.
    const blockLines = jsonlLines.filter(
      (l) => (JSON.parse(l) as { _kind?: string })._kind === undefined,
    );
    expect(blockLines).toHaveLength(9);
    expect(
      jsonlLines.filter(
        (l) => (JSON.parse(l) as { _kind?: string })._kind === "turn_end",
      ),
    ).toHaveLength(1);

    // First line is the session_meta header.
    const header = JSON.parse(jsonlLines[0] ?? "{}") as { _kind: string };
    expect(header._kind).toBe("session_meta");

    // All non-meta lines are valid JSON block records.
    for (const line of blockLines) {
      const parsed = JSON.parse(line) as { kind: string };
      expect(["user", "herta", "system"]).toContain(parsed.kind);
    }

    // The record must be internally consistent: the JSONL block sequence
    // matches the session's in-memory record exactly.
    const jsonlBlocks = blockLines.map(
      (l) => JSON.parse(l) as { kind: string },
    );
    const sessionRecord = session.record;
    expect(jsonlBlocks.length).toBe(sessionRecord.length);
    for (let i = 0; i < jsonlBlocks.length; i++) {
      expect(jsonlBlocks[i]?.kind).toBe(sessionRecord[i]?.kind);
    }

    // Canonical block ordering for this scenario:
    //   user → herta(thought) → herta(@板砖) → 系统(patch preview) →
    //   差分协处理器(Writing) → herta(beat) → 差分协处理器(done-marker) →
    //   herta(thought) → herta(verdict)
    // The 系统 patch preview fires BEFORE the write_new_file permission
    // resolves (the rule emits patch.preview as part of its ask phase), and
    // the BeatPolicy classifies patch.preview as a beat trigger. But the beat
    // is DEFERRED past the permission prompt (the bridge's two-phase drain
    // never streams a beat while a permission is pending), so it fires only
    // after the user approves and the tool runs — i.e. AFTER the 差分协处理器
    // Writing block, not before it. This is the fix for the beat/prompt
    // ordering bug: pre-fix the beat landed before Writing (and raced the
    // [y/a/N] prompt on stdout in the CLI).
    //
    // The 差分协处理器 done-marker is appended by invokeBanzhuanBridge at the
    // END of the backend run (after drainTask drains the deferred beat),
    // BEFORE the actor's post-bridge loop thinks again and emits the verdict
    // herta block — so it lands between the beat and the verdict's thought
    // (index 6), not at the tail.
    const recordKinds = sessionRecord.map((b) => ({
      kind: b.kind,
      label: b.kind === "system" ? b.label : undefined,
      surface: b.kind === "herta" ? b.surface : undefined,
    }));
    const herta = (surface: "thought" | "speech") => ({
      kind: "herta",
      label: undefined,
      surface,
    });
    const system = (label: string) => ({
      kind: "system",
      label,
      surface: undefined,
    });
    expect(recordKinds).toEqual([
      { kind: "user", label: undefined, surface: undefined },
      herta("thought"),
      herta("speech"),
      system("系统"),
      system("差分协处理器"),
      herta("speech"),
      system("差分协处理器"),
      herta("thought"),
      herta("speech"),
    ]);

    // ── Done-marker block ────────────────────────────────────────────────
    // The bridge appends exactly one `差分协处理器` system block with
    // role:"done-marker" at the end of the backend run. Its body reports the
    // run completed (`完成 · …`). The evidenceDetail roll-up (Herta-only
    // overlay, never on the user's stdout per D7) is not asserted here.
    const doneMarker = sessionRecord.find(
      (b) =>
        b.kind === "system" && (b as { role?: string }).role === "done-marker",
    );
    expect(doneMarker).toBeDefined();
    expect((doneMarker as { body: string }).body).toContain("完成"); // scripted run completes

    // ── verdictSeen sanity check ─────────────────────────────────────────
    expect(verdictSeen).toBe(true);

    await cleanup();
    // Real I/O (tmpdir writes) + provider stubs; headroom for CI.
  }, 15_000);
});
