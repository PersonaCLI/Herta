/**
 * 继续 end to end (ADR 0071 §1.4–§1.5): a session whose 板砖 run the app
 * exited during is sealed and opened; the offer stands; pressing 继续 runs a
 * `resume` turn — the run continues from its journal, then Herta comments —
 * and the offer is gone after it.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchJournalDir,
  dispatchJournalPath,
  type ProviderAdapter,
  readDispatchJournal,
  readSessionFile,
  V2RecordPersister,
} from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { sealOpenDispatch } from "./dispatch-recovery.js";
import { SessionImpl } from "./session.js";
import {
  stubChatProvider,
  stubCompletionProvider,
} from "./testing/stub-providers.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";
import type { AppServerConfig, ResumeEvent } from "./types.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await removeTmpDir(d);
});

function mkConfig(): AppServerConfig {
  const root = mkdtempSync(join(tmpdir(), "herta-resume-e2e-"));
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

/** A chat provider that remembers each request it was sent. */
function capturing(inner: ProviderAdapter): ProviderAdapter & {
  frames: unknown[];
} {
  const frames: unknown[] = [];
  return {
    frames,
    streamChat(frame, signal) {
      frames.push(frame);
      return inner.streamChat(frame, signal);
    },
  };
}

/** A session on disk whose last dispatch the user STOPPED (its marker in
 *  the 中断 state), with its journal — or not — beside it. */
async function stoppedSession(
  cfg: AppServerConfig,
  journal: { contract: string; workspaceRoot?: string } | null,
): Promise<SessionImpl> {
  const sessionId = "stopped";
  const persister = V2RecordPersister.forNewSession({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    startedAt: new Date(),
    transcriptDir: cfg.transcriptDir,
  });
  const blocks = [
    { kind: "user" as const, text: "跑一下测试" },
    {
      kind: "herta" as const,
      surface: "speech" as const,
      text: "@板砖 跑一下测试",
    },
    {
      kind: "system" as const,
      label: "差分协处理器" as const,
      body: "中断",
      role: "done-marker" as const,
      markerSummary: {
        kind: "done" as const,
        state: "interrupted" as const,
        fileCount: 0,
        riskCount: 0,
      },
    },
  ];
  for (const b of blocks) persister.appendBlock(b);
  persister.appendTurnEnd("interrupted", new Date().toISOString());
  if (journal !== null) {
    mkdirSync(dispatchJournalDir(cfg.transcriptDir), { recursive: true });
    writeFileSync(
      dispatchJournalPath(cfg.transcriptDir, sessionId),
      `${[
        {
          kind: "start",
          v: 1,
          taskId: "t",
          at: "2026-09-28T10:00:00.000Z",
          contract: journal.contract,
          recordLength: 2,
          ...(journal.workspaceRoot !== undefined
            ? { workspaceRoot: journal.workspaceRoot }
            : {}),
          brief: { taskId: "t" },
          frame: {
            userMessages: [{ text: "跑一下测试" }],
            omittedUserMessages: 0,
            scopedMemory: "",
            recentDialogue: "",
            workingHistory: "",
            lang: "zh",
          },
        },
        { kind: "end", status: "interrupted" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );
  }
  const loaded = readSessionFile(join(cfg.transcriptDir, `${sessionId}.jsonl`));
  return SessionImpl.create({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    effectiveWorkspace: cfg.workspaceRoot,
    isDefaultWorkspace: false,
    config: cfg,
    persister: V2RecordPersister.forResume({
      sessionFile: join(cfg.transcriptDir, `${sessionId}.jsonl`),
    }),
    initialRecord: loaded.record,
    ...(loaded.lastTurnEnd !== undefined
      ? { lastTurnEnd: loaded.lastTurnEnd }
      : {}),
    deps: {
      providerOverrides: {
        actor: stubCompletionProvider([]),
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

describe("the 继续 offer (ADR 0071 §1.4)", () => {
  it("stands after a Stop, as after a crash", async () => {
    const session = await stoppedSession(mkConfig(), { contract: "minimal" });
    try {
      expect(session.resumable).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("is not made for a session with no journal (older than ADR 0071), nor for a run under another contract or in another workspace", async () => {
    const old = await stoppedSession(mkConfig(), null);
    // A run on the standard tool set, from a build that still had it (ADR
    // 0086): its calls name tools that no longer exist.
    const other = await stoppedSession(mkConfig(), { contract: "standard" });
    // The run's workspace was changed since (review 2026-09-30): continuing
    // it here would run the old run's paths in the new place.
    const moved = await stoppedSession(mkConfig(), {
      contract: "minimal",
      workspaceRoot: join(mkConfig().workspaceRoot, "elsewhere"),
    });
    try {
      expect(old.resumable).toBe(false);
      expect(other.resumable).toBe(false);
      expect(moved.resumable).toBe(false);
      expect(await old.continueInterrupted()).toEqual({ unavailable: true });
    } finally {
      await old.close();
      await other.close();
      await moved.close();
    }
  });
});

describe("继续 (ADR 0071 §1.4–§1.5)", () => {
  it("a crashed run is continued from its journal by a resume turn, and the offer ends", async () => {
    const cfg = mkConfig();
    const sessionId = "resume-e2e";
    const persister = V2RecordPersister.forNewSession({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      startedAt: new Date(),
      transcriptDir: cfg.transcriptDir,
    });
    persister.appendBlock({ kind: "user", text: "跑一下测试" });
    persister.appendBlock({
      kind: "herta",
      surface: "speech",
      text: "@板砖 跑一下测试",
    });
    persister.appendBlock({
      kind: "system",
      label: "差分协处理器",
      body: "Running npm test",
    });
    // The run the app exited during: 板砖 asked for `npm test`, it was
    // dispatched, nothing came back.
    const journalPath = dispatchJournalPath(cfg.transcriptDir, sessionId);
    mkdirSync(dispatchJournalDir(cfg.transcriptDir), { recursive: true });
    writeFileSync(
      journalPath,
      `${[
        {
          kind: "start",
          v: 1,
          taskId: "task-resume",
          at: "2026-09-28T10:00:00.000Z",
          contract: "minimal",
          recordLength: 2,
          workspaceRoot: cfg.workspaceRoot,
          brief: { taskId: "task-resume" },
          frame: {
            userMessages: [{ text: "跑一下测试" }],
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
              {
                id: "c1",
                tool: "bash",
                input: { command: "npm test" },
              },
            ],
          },
        },
        { kind: "dispatch", callIds: ["c1"] },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")}\n`,
    );

    // What the host does on open: seal, then build the session on it.
    const sessionFile = join(cfg.transcriptDir, `${sessionId}.jsonl`);
    const loaded = readSessionFile(sessionFile);
    const resumed = V2RecordPersister.forResume({ sessionFile });
    const sealed = await sealOpenDispatch({
      journalPath,
      record: loaded.record,
      persister: resumed,
    });
    expect(sealed).not.toBeNull();

    const backend = capturing(
      stubChatProvider([
        {
          events: [
            { type: "text-delta", text: "checked; nothing to redo." },
            { type: "finish", reason: "stop" },
          ],
        },
      ]),
    );
    const session = await SessionImpl.create({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      effectiveWorkspace: cfg.workspaceRoot,
      isDefaultWorkspace: false,
      config: cfg,
      persister: resumed,
      initialRecord: sealed?.record ?? [],
      ...(sealed !== null ? { lastTurnEnd: sealed.lastTurnEnd } : {}),
      deps: {
        providerOverrides: {
          actor: stubCompletionProvider([
            {
              deltas: ["接着跑完了，这次没重跑什么。（/我 说）"],
              stopReason: "stop",
            },
          ]),
          backend,
          title: stubChatProvider([]),
        },
        staticPrefixOverride: { bio: "[test-bio]", env: "", fewShots: [] },
        metaThinkOverride: emptyMetaThinkCorpus(),
        supervisorReferenceOverride: "",
        openingOverride: null,
      },
    });
    try {
      expect(session.resumable).toBe(true);
      const offers: ResumeEvent[] = [];
      void (async () => {
        for await (const e of session.subscribeResume()) offers.push(e);
      })();

      const r = await session.continueInterrupted();
      expect("turnId" in r).toBe(true);

      // The record reads as a conversation: the 中断 marker, the user asking
      // to continue, the continued run's end, Herta's word on it.
      const record = session.record;
      const markerAt = record.findIndex(
        (b) => b.kind === "system" && b.markerSummary?.crashed === true,
      );
      expect(markerAt).toBe(3);
      expect(record[4]).toMatchObject({
        kind: "user",
        text: "继续",
        resume: true,
      });
      // The continued segment did no work (the scripted model found nothing
      // to redo), so it ends on the no-output marker, as any such dispatch.
      const tail = record.slice(5);
      expect(
        tail.some(
          (b) =>
            b.kind === "system" &&
            (b.role === "done-marker" || b.role === "noop-marker"),
        ),
      ).toBe(true);
      expect(record.at(-1)).toMatchObject({ kind: "herta", surface: "speech" });

      // The backend continued the same conversation: the call closed by the
      // seal, then the note — not a fresh brief.
      const sent = JSON.stringify(backend.frames[0] ?? {});
      expect(sent).toContain("app_exit_outcome_unknown");
      expect(sent).toContain("应用意外退出");

      // The journal: the seal's end, then this segment.
      const kinds = ((await readDispatchJournal(journalPath)) ?? []).map(
        (e) => e.kind,
      );
      expect(kinds.slice(-4)).toEqual(["end", "resume", "message", "end"]);

      // The offer is gone, and said so.
      expect(session.resumable).toBe(false);
      expect(offers).toContainEqual({ kind: "offer", resumable: false });
      // Nothing more to continue.
      expect(await session.continueInterrupted()).toEqual({
        unavailable: true,
      });
    } finally {
      await session.close();
    }
  });
});
