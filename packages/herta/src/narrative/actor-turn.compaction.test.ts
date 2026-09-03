import {
  type AgentEvent,
  type CodingAgentRuntime,
  type CompletionEvent,
  type CompletionProviderAdapter,
  type CompletionRequest,
  type HertaToAgentBrief,
  InMemoryEventBus,
  type TerminalRecord,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import { type ActorTurnDeps, runActorCompletionTurn } from "./actor-turn.js";
import {
  type CompactionConfig,
  DEFAULT_COMPACTION_CONFIG,
  type RecapCache,
} from "./session-recap.js";
import type { RecapRuntime } from "./session-recap-runtime.js";

async function* streamOf(
  events: CompletionEvent[],
): AsyncGenerator<CompletionEvent> {
  for (const e of events) yield e;
}

/**
 * Prompt-capturing fake actor provider. The turn feeds the serialized
 * `ActorPrompt` to `streamCompletion`; we keep every prompt string so the
 * tests can assert on what the recap threading produced. Every turn thinks
 * then speaks (2026-09-03): a thought prompt (it ends with the forced
 * `（我 想）` tag) gets a trivial thought and the forced-speech prompt a
 * trivial speech, so the turn finishes in one think → speak cycle — exactly
 * two prompts.
 */
function mkProvider(): {
  provider: CompletionProviderAdapter;
  prompts: string[];
} {
  const prompts: string[] = [];
  const provider: CompletionProviderAdapter = {
    streamCompletion(req: CompletionRequest): AsyncIterable<CompletionEvent> {
      prompts.push(req.prompt);
      const text = req.prompt.endsWith("（我 想）\n")
        ? "想想看。（/我 想）"
        : "好。（/我 说）";
      return streamOf([
        { type: "text-delta", text },
        { type: "finish", reason: "stop" },
      ]);
    },
  };
  return { provider, prompts };
}

function mkDeps(
  provider: CompletionProviderAdapter,
  recap?: RecapRuntime,
): ActorTurnDeps {
  const bus = new InMemoryEventBus<AgentEvent>();
  const noopRuntime: CodingAgentRuntime = {
    runBrief: async (brief: HertaToAgentBrief) =>
      ({
        taskId: brief.taskId,
        status: "completed",
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }) as never,
  } as unknown as CodingAgentRuntime;
  return {
    provider,
    model: "deepseek-v4-completion",
    staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
    bus,
    runtimeFactory: () => noopRuntime,
    signal: new AbortController().signal,
    // Required since 2026-09-03; the neutral mood, no meta-think attachment.
    intentState: "默认",
    ...(recap !== undefined ? { recap } : {}),
  };
}

/**
 * Tiny config that forces compaction on a short record: a 30-token context
 * window with zero buffer (threshold 30) is exceeded by any non-trivial
 * record, and the recent-window settings keep only the newest turn verbatim
 * so the older turns fall below the boundary (boundary > 0).
 */
const TINY_COMPACT_CONFIG: CompactionConfig = {
  ...DEFAULT_COMPACTION_CONFIG,
  contextWindowTokens: 30,
  bufferFraction: 0,
  recentWindowTokens: 5,
  minRecentTurns: 1,
  maxRecentWindowTokens: 1000,
};

/** In-memory RecapRuntime that counts summarize calls and stores the cache. */
function mkRecapRuntime(): RecapRuntime & { summarizeCalls: number } {
  let cache: RecapCache | null = null;
  const rt = {
    config: TINY_COMPACT_CONFIG,
    guide: "",
    bio: "",
    consecutiveFailures: 0,
    skippedWhileOpen: 0,
    summarizeCalls: 0,
    summarize: async () => {
      rt.summarizeCalls += 1;
      return "我记得之前聊过的事";
    },
    cacheRead: () => cache,
    cacheWrite: (c: RecapCache) => {
      cache = c;
    },
  };
  return rt;
}

/** Several prior user/herta-speech turns — enough to exceed the tiny
 *  threshold and leave the oldest turn below the recap boundary. */
function priorRecord(): TerminalRecord {
  return [
    { kind: "user", text: "第一段：我们聊过流萤的设定细节很久了对吧" },
    { kind: "herta", surface: "speech", text: "嗯，那段我记得，挺长的。" },
    { kind: "user", text: "第二段：后来又说到瓦尔特的安排和时间线" },
    { kind: "herta", surface: "speech", text: "对，时间线那块确实绕。" },
    { kind: "user", text: "第三段：还有关于差分机的那些技术问题" },
    { kind: "herta", surface: "speech", text: "技术细节我都还在脑子里。" },
  ];
}

describe("runActorCompletionTurn — long-session compaction wiring", () => {
  it("threads the per-turn recap into the actor prompt and drops compacted turns", async () => {
    const { provider, prompts } = mkProvider();
    const recapRt = mkRecapRuntime();
    const deps = mkDeps(provider, recapRt);
    const state = { record: priorRecord() };

    await runActorCompletionTurn(state, "现在呢？", deps);

    // Two prompts — the thought phase, then the forced speech. The recap is
    // computed ONCE per turn and threaded into every prompt the turn builds.
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      // Recap section is rendered.
      expect(prompt).toContain("### 记录：先前");
      expect(prompt).toContain("我记得之前聊过的事");
      // The oldest turn was compacted away (its index < recapBoundaryIndex).
      expect(prompt).not.toContain("第一段：我们聊过流萤的设定细节很久了对吧");
    }
    // Summarize was invoked exactly once for the turn (computed once).
    expect(recapRt.summarizeCalls).toBe(1);
  });

  it("control: with no recap runtime the prompt keeps the oldest turn and has no 记录：先前 section", async () => {
    const { provider, prompts } = mkProvider();
    const deps = mkDeps(provider); // recap undefined
    const state = { record: priorRecord() };

    await runActorCompletionTurn(state, "现在呢？", deps);

    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain("第一段：我们聊过流萤的设定细节很久了对吧");
      expect(prompt).not.toContain("### 记录：先前");
    }
  });
});
