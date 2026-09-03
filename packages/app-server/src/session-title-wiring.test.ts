/**
 * Title generation wiring in SessionImpl: after the first user turn, a flash
 * chat call produces a title that is persisted (sidecar) and emitted as a
 * TitleEvent. Generation is one-shot and best-effort.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CompletionEvent,
  type CompletionProviderAdapter,
  type CompletionRequest,
  type ProviderAdapter,
  type ProviderEvent,
  readSessionTitle,
  type TerminalRecord,
  V2RecordPersister,
  writeSessionTitle,
} from "@herta/core";
import type { MetaThinkCorpus } from "@herta/herta";
import { describe, expect, it } from "vitest";
import {
  buildRecentTitleInput,
  SessionImpl,
  turnErrorPayload,
} from "./session.js";
import {
  isThoughtPrompt,
  stubChatProvider,
  stubThoughtStream,
} from "./testing/stub-providers.js";
import type { AppServerConfig, TitleEvent } from "./types.js";

function emptyMetaThinkCorpus(): MetaThinkCorpus {
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
  return { preThink: { ...blank }, preSpeak: { ...blank } };
}

function mkConfig(): AppServerConfig {
  const root = mkdtempSync(join(tmpdir(), "herta-title-wiring-"));
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

/** A chat provider that always yields the same events (any call count). */
function alwaysChat(events: readonly ProviderEvent[]): ProviderAdapter {
  return {
    streamChat() {
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
}

/** A completion provider that answers every thought prompt with the canned
 *  thought and every speech prompt with the same speech (any call count). */
function alwaysActor(deltas: readonly string[]): CompletionProviderAdapter {
  return {
    streamCompletion(request: CompletionRequest) {
      if (isThoughtPrompt(request)) return stubThoughtStream();
      return (async function* () {
        for (const d of deltas)
          yield { type: "text-delta", text: d } satisfies CompletionEvent;
        yield { type: "finish", reason: "stop" } satisfies CompletionEvent;
      })();
    },
  };
}

const ROUTER = alwaysChat([
  { type: "text-delta", text: "默认" },
  { type: "finish", reason: "stop" },
]);
const ACTOR_DELTAS = ["你好。", "（/我 说）"] as const;

async function mkSession(
  cfg: AppServerConfig,
  sessionId: string,
  titleProvider: ProviderAdapter,
  initialRecord?: TerminalRecord,
): Promise<SessionImpl> {
  const persister = V2RecordPersister.forNewSession({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    startedAt: new Date(),
    transcriptDir: cfg.transcriptDir,
  });
  return SessionImpl.create({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    effectiveWorkspace: cfg.workspaceRoot,
    isDefaultWorkspace: false,
    config: cfg,
    persister,
    ...(initialRecord !== undefined ? { initialRecord } : {}),
    deps: {
      providerOverrides: {
        actor: alwaysActor(ACTOR_DELTAS),
        router: ROUTER,
        title: titleProvider,
      },
      staticPrefixOverride: { bio: "[test-bio]", env: "", fewShots: [] },
      metaThinkOverride: emptyMetaThinkCorpus(),
      supervisorReferenceOverride: "",
    },
  });
}

async function nextTitle(session: SessionImpl): Promise<TitleEvent> {
  for await (const ev of session.subscribeTitle()) return ev;
  throw new Error("title stream closed without an event");
}

describe("SessionImpl — title generation", () => {
  it("generates, persists, and emits a title after the first turn", async () => {
    const cfg = mkConfig();
    const sessionId = randomUUID();
    const titleStub = stubChatProvider([
      {
        events: [
          { type: "text-delta", text: "测试标题" },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const session = await mkSession(cfg, sessionId, titleStub);
    const evPromise = nextTitle(session); // subscribe before the turn

    await session.submitText("hi");
    await session.whenTitleSettled();

    expect(session.title).toBe("测试标题");
    expect(readSessionTitle(cfg.transcriptDir, sessionId)).toBe("测试标题");
    expect(await evPromise).toEqual({
      kind: "title",
      sessionId,
      title: "测试标题",
      // The first title IS the first topic boundary, anchored at the title
      // window's first user block (2026-07-12, topic rail).
      topic: {
        title: "测试标题",
        anchorIndex: 0,
        anchorText: "hi",
        at: expect.any(String),
        // Record length when the topic was born — [user, thought, speech]
        // (2026-07-30; the thought block since the always-think rhythm,
        // 2026-09-03). What makes a rewind of THIS turn able to withdraw the
        // topic, which the anchor cannot express once a re-entry retitle
        // anchors it in old history. See pruneTopics.
        bornAtLength: 3,
      },
    });
    expect(session.topics).toHaveLength(1);
    await session.close();
  });

  it("a rewind broadcasts the PRUNED topic history with the truncated record", async () => {
    // The renderer must not have to work the pruning out for itself (user
    // 2026-07-30): a topic anchored in surviving history but born in the
    // withdrawn turn looks alive from there, so the rail kept its tick. The
    // server owns the rule and now says the answer on the wire.
    const cfg = mkConfig();
    const sessionId = randomUUID();
    const titleStub = stubChatProvider([
      {
        events: [
          { type: "text-delta", text: "会被撤回的话题" },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const session = await mkSession(cfg, sessionId, titleStub);
    await session.submitText("hi");
    await session.whenTitleSettled();
    expect(session.topics).toHaveLength(1);

    const resets: Array<{
      record: unknown[];
      topics?: readonly unknown[];
    }> = [];
    const done = (async () => {
      for await (const ev of session.subscribeRecord()) {
        if (ev.kind === "reset") {
          resets.push({ record: [...ev.record], topics: ev.topics });
          return;
        }
      }
    })();

    const result = await session.rewindLastTurn();
    expect(result.ok).toBe(true);
    await done;

    expect(resets).toHaveLength(1);
    expect(resets[0]?.record).toEqual([]);
    // Carried, and empty: the only topic was born in the turn just withdrawn.
    expect(resets[0]?.topics).toEqual([]);
    expect(session.topics).toEqual([]);
    await session.close();
  });

  it("a rewind mid-generation drops the late title — no ghost topic, no resurrected title (review 2026-07-31)", async () => {
    // Title generation fires at turn end and runs while the session is IDLE
    // — exactly when rewindLastTurn is allowed. Pre-fix, a title landing
    // after the rewind re-set this._title for the withdrawn exchange and
    // appended a topic whose post-rewind bornAtLength made it immune to
    // pruneTopics — a permanent ghost tick in the rail.
    const cfg = mkConfig();
    const sessionId = randomUUID();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const slowTitle: ProviderAdapter = {
      streamChat() {
        return (async function* () {
          await gate;
          yield { type: "text-delta", text: "幽灵话题" } as ProviderEvent;
          yield { type: "finish", reason: "stop" } as ProviderEvent;
        })();
      },
    };
    const session = await mkSession(cfg, sessionId, slowTitle);
    await session.submitText("hi");
    // Generation is in flight (fire-and-forget, parked on the gate) when the
    // rewind lands — the currentTurn guard cannot catch it.
    const result = await session.rewindLastTurn();
    expect(result.ok).toBe(true);
    release?.();
    await session.whenTitleSettled();
    // The late result described a withdrawn window: dropped whole.
    expect(session.title).toBeNull();
    expect(session.topics).toEqual([]);
    expect(readSessionTitle(cfg.transcriptDir, sessionId) ?? null).toBeNull();
    await session.close();
  });

  it("resume prunes a sidecar that outlived its record — no user turn left drops title and topics (review 2026-07-31)", async () => {
    // Rewind-to-empty deliberately skips the sidecar rewrite ("the next
    // title write starts it fresh") — but that write never comes if the app
    // closes first, and pre-fix the resume resurrected the withdrawn title
    // and dead rail ticks, then re-persisted them with the next real write.
    const cfg = mkConfig();
    const sessionId = randomUUID();
    writeSessionTitle(cfg.transcriptDir, sessionId, "被撤回的标题", [
      {
        title: "被撤回的标题",
        anchorIndex: 0,
        anchorText: "hi",
        at: new Date().toISOString(),
        bornAtLength: 2,
      },
    ]);
    const session = await mkSession(
      cfg,
      sessionId,
      stubChatProvider([]),
      [], // the rewound-to-empty record this sidecar outlived
    );
    expect(session.title).toBeNull();
    expect(session.topics).toEqual([]);
    await session.close();
  });

  it("resume prunes dead topics but keeps a title its record still supports, re-anchoring it", async () => {
    const cfg = mkConfig();
    const sessionId = randomUUID();
    writeSessionTitle(cfg.transcriptDir, sessionId, "还活着的标题", [
      // Anchored and born beyond the surviving record — dead.
      {
        title: "还活着的标题",
        anchorIndex: 5,
        anchorText: "later",
        at: new Date().toISOString(),
        bornAtLength: 9,
      },
    ]);
    const session = await mkSession(cfg, sessionId, stubChatProvider([]), [
      { kind: "user", text: "hi" },
      { kind: "herta", surface: "speech", text: "你好。" },
    ] as TerminalRecord);
    expect(session.title).toBe("还活着的标题");
    // The dead topic is gone; the surviving title re-anchors at the first
    // surviving user block, same as a pre-history sidecar.
    expect(session.topics).toEqual([
      expect.objectContaining({ title: "还活着的标题", anchorIndex: 0 }),
    ]);
    await session.close();
  });

  it("does not regenerate the title within the periodic window (under K turns)", async () => {
    const cfg = mkConfig();
    const sessionId = randomUUID();
    let calls = 0;
    const counting: ProviderAdapter = {
      streamChat() {
        calls += 1;
        const n = calls;
        return (async function* () {
          yield { type: "text-delta", text: `标题${n}` };
          yield { type: "finish", reason: "stop" };
        })();
      },
    };
    const session = await mkSession(cfg, sessionId, counting);

    await session.submitText("hi");
    await session.whenTitleSettled();
    expect(calls).toBe(1);

    await session.submitText("again");
    await session.whenTitleSettled();
    expect(calls).toBe(1); // still within the periodic window
    expect(session.title).toBe("标题1");
    await session.close();
  });

  it("re-titles periodically on a long session", async () => {
    const cfg = mkConfig();
    const sessionId = randomUUID();
    let calls = 0;
    const counting: ProviderAdapter = {
      streamChat() {
        calls += 1;
        const n = calls;
        return (async function* () {
          yield { type: "text-delta", text: `标题${n}` };
          yield { type: "finish", reason: "stop" };
        })();
      },
    };
    const session = await mkSession(cfg, sessionId, counting);

    // Turn 1 generates the initial title (resets the counter); the next
    // re-title lands RETITLE_EVERY_N_TURNS (6) turns later → turn 7.
    for (let i = 0; i < 7; i++) {
      await session.submitText(`msg ${i}`);
      await session.whenTitleSettled();
    }
    expect(calls).toBe(2);
    expect(session.title).toBe("标题2");
    await session.close();
  });

  it("bounds initial-title retries when the model keeps yielding nothing", async () => {
    const cfg = mkConfig();
    const sessionId = randomUUID();
    let calls = 0;
    const alwaysEmpty: ProviderAdapter = {
      streamChat() {
        calls += 1;
        return (async function* () {
          yield { type: "text-delta", text: "   " }; // sanitizes to null
          yield { type: "finish", reason: "stop" };
        })();
      },
    };
    const session = await mkSession(cfg, sessionId, alwaysEmpty);

    for (let i = 0; i < 5; i++) {
      await session.submitText(`m ${i}`);
      await session.whenTitleSettled();
    }
    expect(session.title).toBeNull();
    expect(calls).toBe(3); // capped at MAX_INITIAL_TITLE_ATTEMPTS, not 5
    await session.close();
  });

  it("stays untitled when the model yields no usable title", async () => {
    const cfg = mkConfig();
    const sessionId = randomUUID();
    const titleStub = stubChatProvider([
      {
        events: [
          { type: "text-delta", text: "   " },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const session = await mkSession(cfg, sessionId, titleStub);

    await session.submitText("hi");
    await session.whenTitleSettled();

    expect(session.title).toBeNull();
    expect(readSessionTitle(cfg.transcriptDir, sessionId)).toBeUndefined();
    await session.close();
  });

  it("re-titles a reopened session on the first new turn", async () => {
    const cfg = mkConfig();
    const sessionId = randomUUID();
    const titleStub = stubChatProvider([
      {
        events: [
          { type: "text-delta", text: "新标题" },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const persister = V2RecordPersister.forNewSession({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      startedAt: new Date(),
      transcriptDir: cfg.transcriptDir,
    });
    // Reopen a session that already has a title (loads as initialTitle).
    // The loaded record must carry the user turn the title came from: a
    // titled session always has one (buildRecentTitleInput returns null
    // without it), and a sidecar title with NO surviving user turn is now
    // deliberately dropped as outliving its record (review 2026-07-31).
    writeSessionTitle(cfg.transcriptDir, sessionId, "旧标题");
    const session = await SessionImpl.create({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      effectiveWorkspace: cfg.workspaceRoot,
      isDefaultWorkspace: false,
      config: cfg,
      persister,
      initialRecord: [
        { kind: "user", text: "旧对话" },
        { kind: "herta", surface: "speech", text: "嗯。" },
      ] as TerminalRecord,
      deps: {
        providerOverrides: {
          actor: alwaysActor(ACTOR_DELTAS),
          router: ROUTER,
          title: titleStub,
        },
        staticPrefixOverride: { bio: "[test-bio]", env: "", fewShots: [] },
        metaThinkOverride: emptyMetaThinkCorpus(),
        supervisorReferenceOverride: "",
      },
    });

    expect(session.title).toBe("旧标题"); // before any new turn
    await session.submitText("hi"); // first new turn → re-title
    await session.whenTitleSettled();
    expect(session.title).toBe("新标题");
    expect(readSessionTitle(cfg.transcriptDir, sessionId)).toBe("新标题");
    await session.close();
  });

  it("a re-title shows the model the incumbent title; an exact copy adds no topic tick (owner 2026-08-11)", async () => {
    // Same-topic re-entry, pre-contract: the model regenerated from scratch
    // and a PARAPHRASE of the old title counted as a topic change — title
    // churn plus a ghost tick on the rail. With the incumbent in the prompt,
    // "still on topic" is expressible as an exact copy, and appendTopic's
    // exact-match dedup swallows it.
    const cfg = mkConfig();
    const sessionId = randomUUID();
    writeSessionTitle(cfg.transcriptDir, sessionId, "排查解析报错");
    const systems: string[] = [];
    const copying: ProviderAdapter = {
      streamChat(frame: Parameters<ProviderAdapter["streamChat"]>[0]) {
        systems.push("stableSystem" in frame ? frame.stableSystem : "");
        return (async function* () {
          yield {
            type: "text-delta",
            text: "排查解析报错",
          } satisfies ProviderEvent;
          yield { type: "finish", reason: "stop" } satisfies ProviderEvent;
        })();
      },
    };
    const session = await mkSession(cfg, sessionId, copying, [
      { kind: "user", text: "帮我看下解析报错" },
      { kind: "herta", surface: "speech", text: "看了。" },
    ] as TerminalRecord);
    // The sidecar had no topic history — resume synthesizes the first entry.
    expect(session.topics).toHaveLength(1);

    await session.submitText("还有一处也炸了"); // re-entry re-title
    await session.whenTitleSettled();

    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain("当前标题：排查解析报错");
    expect(systems[0]).toContain("一字不改");
    // The copy re-derived the same title: kept, and NO second topic entry.
    expect(session.title).toBe("排查解析报错");
    expect(session.topics).toHaveLength(1);
    await session.close();
  });

  it("the initial title's prompt carries no incumbent contract", async () => {
    const cfg = mkConfig();
    const sessionId = randomUUID();
    const systems: string[] = [];
    const capturing: ProviderAdapter = {
      streamChat(frame: Parameters<ProviderAdapter["streamChat"]>[0]) {
        systems.push("stableSystem" in frame ? frame.stableSystem : "");
        return (async function* () {
          yield { type: "text-delta", text: "新标题" } satisfies ProviderEvent;
          yield { type: "finish", reason: "stop" } satisfies ProviderEvent;
        })();
      },
    };
    const session = await mkSession(cfg, sessionId, capturing);
    await session.submitText("hi");
    await session.whenTitleSettled();
    expect(systems).toHaveLength(1);
    expect(systems[0]).not.toContain("当前标题");
    await session.close();
  });
});

describe("buildRecentTitleInput", () => {
  it("returns null for a record with no user turn", () => {
    expect(buildRecentTitleInput([], 2)).toBeNull();
    expect(
      buildRecentTitleInput(
        [{ kind: "herta", surface: "speech", text: "hi" }] as TerminalRecord,
        2,
      ),
    ).toBeNull();
  });

  it("uses the single exchange when there is only one", () => {
    const rec: TerminalRecord = [
      { kind: "user", text: "U1" },
      { kind: "herta", surface: "speech", text: "H1" },
    ];
    expect(buildRecentTitleInput(rec, 2)).toEqual({
      userText: "U1",
      hertaText: "H1",
      startIndex: 0,
    });
  });

  it("windows to the last N exchanges", () => {
    const rec: TerminalRecord = [
      { kind: "user", text: "U1" },
      { kind: "herta", surface: "speech", text: "H1" },
      { kind: "user", text: "U2" },
      { kind: "herta", surface: "speech", text: "H2" },
      { kind: "user", text: "U3" },
      { kind: "herta", surface: "speech", text: "H3" },
    ];
    expect(buildRecentTitleInput(rec, 2)).toEqual({
      userText: "U2\nU3",
      hertaText: "H2\nH3",
      // The window's first user block — a title change anchors its topic here.
      startIndex: 2,
    });
  });
});

describe("turnErrorPayload (official DeepSeek error codes, 2026-07-12)", () => {
  it("carries a numeric provider status through to the failed event", () => {
    const err = Object.assign(new Error("402 Insufficient Balance"), {
      name: "ProviderError",
      status: 402,
    });
    expect(turnErrorPayload(err)).toEqual({
      code: "ProviderError",
      message: "402 Insufficient Balance",
      status: 402,
    });
  });

  it("omits a missing or non-numeric status; stringifies non-Errors", () => {
    expect(turnErrorPayload(new TypeError("fetch failed"))).toEqual({
      code: "TypeError",
      message: "fetch failed",
    });
    const weird = Object.assign(new Error("x"), { status: "402" });
    expect(turnErrorPayload(weird)).not.toHaveProperty("status");
    expect(turnErrorPayload("boom")).toEqual({
      code: "unknown",
      message: "boom",
    });
  });
});
