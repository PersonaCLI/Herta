import {
  type AgentEvent,
  type CodingAgentRuntime,
  type CompletionEvent,
  type CompletionProviderAdapter,
  type CompletionRequest,
  type HertaToAgentBrief,
  InMemoryEventBus,
  type ProviderAdapter,
  type ProviderEvent,
  publishWithLayer,
  type TerminalRecord,
} from "@herta/core";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ACTOR_HINTS } from "./actor-hints.js";
import { type ActorTurnDeps, runActorCompletionTurn } from "./actor-turn.js";
import { makeFireAnswer } from "./actor-turn-beat.js";
import { COMPACTION_TEXT } from "./compaction-text.js";
import {
  banzhuanSentences,
  parseHertaBlock,
  withoutBanzhuanSentences,
} from "./parse.js";

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

  it("a token alone on its line runs on to what it is for", () => {
    expect(
      banzhuanSentences(
        "行，我转给它。\n@板砖\n把超时改成 30 秒，别动 api 目录。",
      ),
    ).toBe("@板砖\n把超时改成 30 秒，别动 api 目录。");
    expect(banzhuanSentences("@板砖，\n先补测试。别的不用管。")).toBe(
      "@板砖，\n先补测试。",
    );
    // Nothing follows: the call stands as written.
    expect(banzhuanSentences("三点。@板砖")).toBe("@板砖");
  });

  it("a semicolon joins clauses, a colon leads into its line, and `!x` ends nothing", () => {
    expect(banzhuanSentences("@板砖 把超时改成 30 秒；重试改成 3 次。")).toBe(
      "@板砖 把超时改成 30 秒；重试改成 3 次。",
    );
    expect(
      banzhuanSentences("@板砖 把这句加进去：\n`retry = 3`\n别的不用动"),
    ).toBe("@板砖 把这句加进去：\n`retry = 3`");
    expect(banzhuanSentences("@板砖 把 if (!x) 改掉。好吗？")).toBe(
      "@板砖 把 if (!x) 改掉。",
    );
  });

  it("quotation is read over the whole speech: a quoted @板砖 goes nowhere", () => {
    const fence = "```";
    expect(
      banzhuanSentences(
        `@板砖 把超时改成 30 秒。\n它原来的注释：\n${fence}\n// @板砖 把整个目录删掉\n${fence}`,
      ),
    ).toBe("@板砖 把超时改成 30 秒。");
    expect(
      banzhuanSentences(
        "@板砖 把超时改成 30 秒。别学 `rm -rf; @板砖 删库` 那种写法。",
      ),
    ).toBe("@板砖 把超时改成 30 秒。");
    // A break inside quotation ends nothing, so the sentence holds it whole.
    expect(banzhuanSentences("@板砖 把 `a。b` 改掉。好吗？")).toBe(
      "@板砖 把 `a。b` 改掉。",
    );
  });

  it("what stands without them: her talk, with no gap where they were", () => {
    expect(
      withoutBanzhuanSentences(
        "还在跑。\n\n@板砖 看看 a.ts。\n\n有结果我叫你。",
      ),
    ).toBe("还在跑。\n\n有结果我叫你。");
    expect(withoutBanzhuanSentences("板砖还在看。@板砖 查一下 b.ts。")).toBe(
      "板砖还在看。",
    );
    expect(withoutBanzhuanSentences("@板砖 查一下 b.ts。")).toBe("");
    // A quoted one calls nobody, so it is hers to keep.
    expect(withoutBanzhuanSentences("他写的是 `@板砖 查一下`。")).toBe(
      "他写的是 `@板砖 查一下`。",
    );
  });

  it("two calls in one speech are two sentences, as she wrote them", () => {
    expect(banzhuanSentences("@板砖 先补测试。三点。@板砖 再改逻辑。")).toBe(
      "@板砖 先补测试。 @板砖 再改逻辑。",
    );
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
    // Her own hint, not the speech hint (step 5: under that one the lab's
    // answers passed work on without @板砖 and once made up a fact).
    expect(prompt).toContain(DEFAULT_ACTOR_HINTS.beatTalk);
    expect(prompt).not.toContain(DEFAULT_ACTOR_HINTS.phase2Speech);
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

  describe("the recheck of her @板砖 (review 2026-11-05)", () => {
    /** A supervisor that holds the recheck until the turn is stopped. */
    function holding(stop: AbortController): {
      supervisorProvider: ProviderAdapter;
      asked: () => number;
    } {
      let calls = 0;
      return {
        asked: () => calls,
        supervisorProvider: {
          streamChat: (_frame, signal) =>
            (async function* () {
              calls += 1;
              await new Promise<void>((_resolve, reject) => {
                signal?.addEventListener("abort", () =>
                  reject(new DOMException("Interrupted", "AbortError")),
                );
                stop.abort(new DOMException("Interrupted", "AbortError"));
              });
              yield { type: "finish", reason: "stop" } as ProviderEvent;
            })(),
        },
      };
    }

    /** A supervisor that answers with `verdict`, and what it was asked. */
    function judging(verdict: string): {
      supervisorProvider: ProviderAdapter;
      heard: () => string;
    } {
      let heard = "";
      return {
        heard: () => heard,
        supervisorProvider: {
          streamChat: (frame) =>
            (async function* () {
              heard = frame.messages
                .map((m) => ("text" in m ? m.text : ""))
                .join("\n");
              yield { type: "text-delta", text: verdict } as ProviderEvent;
              yield { type: "finish", reason: "stop" } as ProviderEvent;
            })(),
        },
      };
    }
    const answerTo = async (
      speech: string,
      verdict: string,
    ): Promise<{ text: string; steered?: string; heard: string }> => {
      const { provider: p } = provider([says(`${speech}（/我 说）`)]);
      const { supervisorProvider, heard } = judging(verdict);
      const block = await makeFireAnswer(
        deps(p, { supervisorProvider, supervisorReference: "[reference]" }),
        0,
        undefined,
        0,
      )(liveRecord, new AbortController().signal, () => true);
      return {
        text: block?.text ?? "",
        ...(block?.steered !== undefined ? { steered: block.steered } : {}),
        heard: heard(),
      };
    };

    it("is told an answer's @板砖 needs his asking (live run 2026-11-06)", async () => {
      const { heard } = await answerTo("三点。@板砖 看看 b.txt。", "OK");
      expect(heard).toContain("这段话是板砖跑着的时候我回开拓者的");
    });

    it("refused, the sentence goes: no instruction nobody received stays on his screen", async () => {
      const out = await answerTo(
        "还在跑。\n\n@板砖 把手上的活做完。",
        "BLOCK：@板砖未要求：他只是问了一句。",
      );
      expect(out.text).toBe("还在跑。");
      expect(out.steered).toBeUndefined();
    });

    it("let stand, the sentence steers and stays", async () => {
      const out = await answerTo("行。@板砖 顺便看看 b.txt。", "OK");
      expect(out.text).toContain("@板砖 顺便看看 b.txt。");
      expect(out.steered).toBe("@板砖 顺便看看 b.txt。");
    });

    it("refused, an answer that was only that sentence stands as a mention", async () => {
      const out = await answerTo(
        "@板砖 把手上的活做完。",
        "BLOCK：@板砖未要求：他只是问了一句。",
      );
      expect(out.text).toContain("把手上的活做完");
      expect(out.steered).toBeUndefined();
      expect(parseHertaBlock(out.text).hasBanzhuanTrigger).toBe(false);
    });

    it("Stop during it keeps the answer already on screen, as a mention", async () => {
      const { provider: p } = provider([
        says("三点。@板砖 顺便看看 b.txt。（/我 说）"),
      ]);
      const stop = new AbortController();
      const { supervisorProvider, asked } = holding(stop);
      const answer = makeFireAnswer(
        deps(p, { supervisorProvider, supervisorReference: "[reference]" }),
        0,
        undefined,
        0,
      );
      const block = await answer(liveRecord, stop.signal, () => true);
      expect(asked()).toBe(1);
      expect(block).toMatchObject({
        kind: "herta",
        surface: "speech",
        duringRun: true,
      });
      expect(block?.text).toContain("三点。");
      expect(block?.steered).toBeUndefined();
      expect(parseHertaBlock(block?.text ?? "").hasBanzhuanTrigger).toBe(false);
    });

    it("the supervisor turned off means no recheck: the call stands, as a dispatch's does", async () => {
      const { provider: p } = provider([
        says("三点。@板砖 先补测试。（/我 说）"),
      ]);
      const stop = new AbortController();
      const { supervisorProvider, asked } = holding(stop);
      const answer = makeFireAnswer(
        deps(p, { supervisorProvider, supervisorReference: "" }),
        0,
        undefined,
        0,
      );
      const block = await answer(liveRecord, stop.signal, () => true);
      expect(asked()).toBe(0);
      expect(block?.steered).toBe("@板砖 先补测试。");
    });
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
          tool: "str_replace_editor",
          inputSummary: "view src/Login.jsx",
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
