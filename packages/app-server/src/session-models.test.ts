import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CompletionProviderAdapter,
  type CompletionRequest,
  V2RecordPersister,
} from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { SessionImpl } from "./session.js";
import { createSessionHost } from "./session-host.js";
import {
  stubChatProvider,
  stubCompletionProvider,
} from "./testing/stub-providers.js";
import { removeTmpDir } from "./testing/tmp-workspace.js";
import type { AppServerConfig, SessionModels } from "./types.js";

/**
 * The model and the effort apply without a restart (ADR 0081): the host's
 * live choice reaches a session's next turn, and a session created after a
 * change starts from it.
 */

const tmpDirs: string[] = [];
const sessions: SessionImpl[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const d of tmpDirs.splice(0)) await removeTmpDir(d);
});

function mkConfig(): AppServerConfig {
  const root = mkdtempSync(join(tmpdir(), "herta-models-test-"));
  tmpDirs.push(root);
  return {
    workspaceRoot: root,
    transcriptDir: join(root, ".herta", "transcript", "v2"),
    projectMemoryDir: join(root, ".herta", "memory"),
    userMemoryDir: join(root, ".herta", "user-memory"),
    narrativeDir: join(root, ".herta", "narrative"),
    providers: {
      deepseekApiKey: "sk-test",
      actorModel: "deepseek-v4-pro",
      backendModel: "deepseek-flash",
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

/** The stub actor, noting the model of every completion call. */
function recording(
  inner: CompletionProviderAdapter,
  seen: string[],
): CompletionProviderAdapter {
  return {
    streamCompletion(req: CompletionRequest, signal: AbortSignal) {
      seen.push(req.model);
      return inner.streamCompletion(req, signal);
    },
  };
}

async function mkSession(
  models: () => SessionModels,
  seen: string[],
): Promise<SessionImpl> {
  const cfg = mkConfig();
  const sessionId = randomUUID();
  const session = await SessionImpl.create({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    effectiveWorkspace: cfg.workspaceRoot,
    isDefaultWorkspace: false,
    config: cfg,
    models,
    persister: V2RecordPersister.forNewSession({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      startedAt: new Date(),
      transcriptDir: cfg.transcriptDir,
    }),
    deps: {
      providerOverrides: {
        actor: recording(
          stubCompletionProvider([
            { deltas: ["好。（/我 说）"], stopReason: "stop" },
            { deltas: ["再好。（/我 说）"], stopReason: "stop" },
          ]),
          seen,
        ),
        router: stubChatProvider([
          {
            events: [
              { type: "text-delta", text: "默认" },
              { type: "finish", reason: "stop" },
            ],
          },
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

describe("Session — the live model (ADR 0081)", () => {
  it("Herta's next turn reads the model as it stands, with no restart", async () => {
    let live: SessionModels = {
      actorModel: "deepseek-v4-pro",
      backendModel: "deepseek-flash",
    };
    const seen: string[] = [];
    const session = await mkSession(() => live, seen);
    await session.submitText("在吗");
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["deepseek-v4-pro"]));
    seen.length = 0;
    live = { ...live, actorModel: "deepseek-flash" };
    await session.submitText("还在吗");
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["deepseek-flash"]));
  });
});

describe("SessionHost.setModels (ADR 0081)", () => {
  it("merges a partial change and keeps the rest", () => {
    const host = createSessionHost(mkConfig());
    // A host built from the config holds its choice; a partial update keeps
    // the fields it leaves out. Observed through a later session's getter —
    // here through the host's own state, which every session reads.
    host.setModels({ thinking: "max" });
    host.setModels({ actorModel: "deepseek-flash" });
    const held = (
      host as unknown as { modelsHolder: { current: SessionModels } }
    ).modelsHolder.current;
    expect(held).toEqual({
      actorModel: "deepseek-flash",
      backendModel: "deepseek-flash",
      thinking: "max",
    });
    host.dispose();
  });
});
