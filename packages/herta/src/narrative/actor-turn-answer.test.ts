import {
  type AgentEvent,
  type CodingAgentRuntime,
  type CompletionEvent,
  type CompletionProviderAdapter,
  type CompletionRequest,
  type HertaToAgentBrief,
  InMemoryEventBus,
  publishWithLayer,
  type TerminalRecord,
} from "@herta/core";
import { describe, expect, it, vi } from "vitest";
import { type ActorTurnDeps, runActorCompletionTurn } from "./actor-turn.js";
import { makeFireAnswer } from "./actor-turn-beat.js";
import { COMPACTION_TEXT } from "./compaction-text.js";
import { banzhuanSentences, parseHertaBlock } from "./parse.js";

async function* streamOf(
  events: CompletionEvent[],
): AsyncGenerator<CompletionEvent> {
  for (const e of events) yield e;
}
const says = (text: string): CompletionEvent[] => [
  { type: "text-delta", text },
  { type: "finish", reason: "stop" },
];

/** Thoughts answer themselves; every other call takes the next script. */
function provider(scripts: CompletionEvent[][]): {
  provider: CompletionProviderAdapter;
  prompts: string[];
} {
  const prompts: string[] = [];
  let i = 0;
  return {
    prompts,
    provider: {
      streamCompletion(req: CompletionRequest) {
        if (req.prompt.endsWith("（我 想）\n"))
          return streamOf(says("想想。（/我 想）"));
        prompts.push(req.prompt);
        return streamOf(scripts[i++] ?? [{ type: "finish", reason: "stop" }]);
      },
    },
  };
}

function deps(
  p: CompletionProviderAdapter,
  extra: Partial<ActorTurnDeps> = {},
): ActorTurnDeps {
  return {
    provider: p,
    model: "deepseek-v4-completion",
    staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
    bus: new InMemoryEventBus<AgentEvent>(),
    runtimeFactory: () => ({}) as CodingAgentRuntime,
    signal: new AbortController().signal,
    intentState: "默认",
    ...extra,
  };
}

const liveRecord: TerminalRecord = [
  { kind: "user", text: "修一下登录" },
  { kind: "herta", surface: "speech", text: "@板砖 查一下登录" },
  {
    kind: "system",
    label: "差分协处理器",
    body: "Reading src/Login.jsx",
    digest: { kind: "op", verb: "Reading", arg: "src/Login.jsx" },
  },
  { kind: "user", text: "周末那个会几点？", duringRun: true },
];

describe("banzhuanSentences — what reaches 板砖 of her answer", () => {
  it("the sentences that carry a live @板砖, not her talk around them", () => {
    expect(
      banzhuanSentences("三点。@板砖 先补测试，再改逻辑。别的不用管。"),
    ).toBe("@板砖 先补测试，再改逻辑。");
    expect(banzhuanSentences("三点。\n@板砖 停一下")).toBe("@板砖 停一下");
    // A quoted token is a mention.
    expect(banzhuanSentences("我说的是 `@板砖`，不是叫它。")).toBe("");
  });
});

describe("makeFireAnswer — her answer to talk during a run", () => {
  it("answers over the run's live form, the talk last, and commits a `duringRun` speech", async () => {
    const { provider: p, prompts } = provider([says("三点，别吵。（/我 说）")]);
    const answer = makeFireAnswer(deps(p), 0, undefined, 0);
    const block = await answer(
      liveRecord,
      new AbortController().signal,
      () => true,
    );
    expect(block).toEqual({
      kind: "herta",
      surface: "speech",
      text: "三点，别吵。",
      duringRun: true,
    });
    const prompt = prompts[0] ?? "";
    expect(prompt).toContain(COMPACTION_TEXT.zh.runLive(1));
    expect(prompt.lastIndexOf("周末那个会几点？")).toBeGreaterThan(
      prompt.indexOf(COMPACTION_TEXT.zh.runLive(1)),
    );
    expect(prompt.endsWith("（我 说）\n")).toBe(true);
  });

  it("a live @板砖 while the run can take it names the sentence that steers; after the run it is a mention", async () => {
    const { provider: p } = provider([
      says("三点。@板砖 先补测试。（/我 说）"),
      says("三点。@板砖 先补测试。（/我 说）"),
    ]);
    const answer = makeFireAnswer(deps(p), 0, undefined, 0);
    const live = await answer(
      liveRecord,
      new AbortController().signal,
      () => true,
    );
    expect(live?.steered).toBe("@板砖 先补测试。");
    expect(parseHertaBlock(live?.text ?? "").hasBanzhuanTrigger).toBe(true);
    const over = await answer(
      liveRecord,
      new AbortController().signal,
      () => false,
    );
    expect(over?.steered).toBeUndefined();
    expect(parseHertaBlock(over?.text ?? "").hasBanzhuanTrigger).toBe(false);
  });
});

describe("a turn with talk during its run (ADR 0085 step 3)", () => {
  it("talk reaches her mid-run, she answers it in the record, and her verdict follows the run", async () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    const runtime = {
      runBrief: async (brief: HertaToAgentBrief) => {
        publishWithLayer(bus, "backend", {
          type: "turn.started",
          userText: "task",
        } as never);
        publishWithLayer(bus, "backend", {
          type: "tool.call.started",
          id: "c1",
          tool: "read_file",
          inputSummary: "src/Login.jsx",
        } as never);
        bus.publish({
          type: "user.talk",
          layer: "actor",
          id: "t1",
          text: "周末那个会几点？",
        });
        for (let i = 0; i < 6; i++) await tick();
        return {
          taskId: brief.taskId,
          status: "completed",
          evidence: [],
          changedFiles: [],
          tests: [],
          permissions: [],
          residualRisks: [],
        } as never;
      },
    } as unknown as CodingAgentRuntime;
    const steerBackend = vi.fn();
    const { provider: p } = provider([
      says("行。@板砖 查一下登录为什么没反应。（/我 说）"),
      says("三点。（/我 说）"),
      says("查完了，登录那块没动过。（/我 说）"),
    ]);
    const result = await runActorCompletionTurn(
      { record: [] },
      "登录没反应",
      deps(p, { bus, runtimeFactory: () => runtime, steerBackend }),
    );
    const speech = result.record.flatMap((b) =>
      b.kind === "herta" && b.surface === "speech"
        ? [`${b.duringRun === true ? "answer" : "speech"}:${b.text}`]
        : b.kind === "user"
          ? [`${b.duringRun === true ? "talk" : "user"}:${b.text}`]
          : [],
    );
    expect(speech).toEqual([
      "user:登录没反应",
      "speech:行。@板砖 查一下登录为什么没反应。",
      "talk:周末那个会几点？",
      "answer:三点。",
      "speech:查完了，登录那块没动过。",
    ]);
    expect(steerBackend).not.toHaveBeenCalled();
  });
});
