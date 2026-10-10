import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V2RecordPersister } from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { SessionImpl } from "./session.js";
import {
  stubChatProvider,
  stubCompletionProvider,
} from "./testing/stub-providers.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";
import type { AppServerConfig, TurnLifecycleEvent } from "./types.js";

/** The zero-width space the serializer breaks `@板砖` with. */
const ZWSP = String.fromCodePoint(0x200b);

/**
 * Composer predictions (owner 2026-10-10): after a submitted turn finishes,
 * the session asks the driver for the Trailblazer's likely next message and
 * offers it as a `predicted` turn event — user-side chrome, never the record.
 */

const tmpDirs: string[] = [];
const sessions: SessionImpl[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const d of tmpDirs.splice(0)) await removeTmpDir(d);
});

function mkConfig(): AppServerConfig {
  const root = mkdtempSync(join(tmpdir(), "herta-prediction-test-"));
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

const blank = {
  默认: "",
  被烦版: "",
  教学版: "",
  被戳穿版: "",
  任务部署版: "",
  板砖代答版: "",
  被顶嘴版: "",
  倾听版: "",
};

async function mkSession(
  predictions: boolean | undefined,
  scripts: readonly string[],
): Promise<SessionImpl> {
  const cfg = mkConfig();
  const sessionId = randomUUID();
  const session = await SessionImpl.create({
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
    ...(predictions !== undefined
      ? { composerPredictions: () => predictions }
      : {}),
    deps: {
      providerOverrides: {
        // The turn's speech, then (when asked) the prediction.
        actor: stubCompletionProvider(
          scripts.map((s) => ({ deltas: [s], stopReason: "stop" as const })),
        ),
        router: stubChatProvider([
          {
            events: [
              { type: "text-delta", text: "默认" },
              { type: "finish", reason: "stop" },
            ],
          },
        ]),
        title: stubChatProvider([]),
      },
      staticPrefixOverride: { bio: "[test-bio]", env: "", fewShots: [] },
      metaThinkOverride: { preThink: { ...blank }, preSpeak: { ...blank } },
      supervisorReferenceOverride: "",
      openingLeadMs: 0,
      openingOverride: null,
      repoDescriber: async () => ({ kind: "absent" }),
      repoWatcher: () => () => undefined,
      commitDescriber: async () => null,
      workingDiffDescriber: async () => null,
      logDescriber: async () => null,
      branchesDescriber: async () => null,
    },
  });
  sessions.push(session);
  return session;
}

async function turnEvents(
  session: SessionImpl,
  text: string,
  until: (e: TurnLifecycleEvent) => boolean,
): Promise<TurnLifecycleEvent[]> {
  const events: TurnLifecycleEvent[] = [];
  const done = (async () => {
    for await (const e of session.subscribeTurnLifecycle()) {
      events.push(e);
      if (until(e)) break;
    }
  })();
  await session.submitText(text);
  await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
  return events;
}

describe("Session — composer predictions (owner 2026-10-10)", () => {
  it("after a finished turn, offers the Trailblazer's likely next line", async () => {
    const session = await mkSession(true, [
      "写好了。（/我 说）",
      `@${ZWSP}板砖 再加个悔棋（/开拓者 说）`,
    ]);
    const events = await turnEvents(
      session,
      "@板砖 帮我写个五子棋",
      (e) => e.kind === "predicted",
    );
    expect(events.map((e) => e.kind)).toEqual([
      "started",
      "finished",
      "predicted",
    ]);
    const predicted = events.at(-1);
    expect(predicted).toMatchObject({
      kind: "predicted",
      text: "@板砖 再加个悔棋",
    });
    // The record holds the turn, never the prediction.
    expect(session.record.at(-1)).toMatchObject({
      kind: "herta",
      surface: "speech",
      text: "写好了。",
    });
  });

  it("makes no call with the switch off, or when the host offers none", async () => {
    for (const setting of [false, undefined]) {
      // One script only: a prediction call would find none and throw.
      const session = await mkSession(setting, ["好。（/我 说）"]);
      const events = await turnEvents(
        session,
        "在吗",
        (e) => e.kind === "finished",
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(events.map((e) => e.kind)).toEqual(["started", "finished"]);
    }
  });
});
