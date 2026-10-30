import type {
  CompletionEvent,
  CompletionProviderAdapter,
  CompletionRequest,
  ProviderAdapter,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  type FlowWordPost,
  flowJudgeVerdict,
  flowWordJudge,
  flowWordPrompt,
  hertaWordOn,
  inertFlowWord,
  normalizeFlowWord,
} from "./flow-word.js";

/** Herta's word on a Flow post (ADR 0084 §7, amended 2026-10-30). */

const post: FlowWordPost = {
  title: "GitHub Universe: Copilot Fusion launches as agents start 40% of PRs",
  site: "The Next Web",
  date: "2026-10-28T16:00:00+00:00",
  summary:
    "GitHub launched Copilot Fusion, wiring coding agents into issues, review and CI.",
  why: "你关注「AI coding agents」",
};

/** A completion provider that answers each call with the next line. */
function scripted(lines: readonly string[]): CompletionProviderAdapter & {
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  let n = 0;
  return {
    requests,
    async *streamCompletion(
      req: CompletionRequest,
    ): AsyncIterable<CompletionEvent> {
      requests.push(req);
      yield { type: "text-delta", text: lines[n++] ?? "" };
      yield { type: "finish", reason: "stop" };
    },
  };
}

const signal = () => new AbortController().signal;

describe("Flow's own frame (not her conversation prefix)", () => {
  it("the broadcast scene and its worked examples, then this post and her open speech", () => {
    const zh = flowWordPrompt(post, "zh");
    expect(zh.startsWith("### 记录：《星际和平播报》转播")).toBe(true);
    // The examples shape her answer as her 废案 few-shots shape her turns.
    expect(zh.match(/（我 说）\n[^\n]+\n（\/我 说）/g)?.length).toBe(4);
    expect(zh).toContain(
      `→ 播报：${post.title}（The Next Web · 2026-10-28）\n${post.summary}\n和开拓者的关系：${post.why}`,
    );
    expect(zh.endsWith("（我 说）\n")).toBe(true);
    // No terminal record: no 板砖 rows, no system notes, no user block.
    expect(zh).not.toContain("→ 差分协处理器");
    expect(zh).not.toContain("（开拓者 说）");
    const en = flowWordPrompt(post, "en");
    expect(en).toContain("→ Broadcast: GitHub Universe");
    expect(en).toContain("Why the Trailblazer:");
  });

  it("stops at the close mark, a blank line or the next block", async () => {
    const provider = scripted(["「发起」40%。合并了多少？"]);
    await hertaWordOn(post, { provider, model: "m", lang: "zh" }, signal());
    const stop = provider.requests[0]?.stop ?? [];
    for (const s of ["（/我 说）", "\n\n", "\n→"]) expect(stop).toContain(s);
  });
});

describe("the word's shape, checked by code", () => {
  it("strips a label prefix and a wrapping bracket", () => {
    expect(normalizeFlowWord("她批：这不叫新闻。", post, "zh")).toEqual({
      ok: true,
      word: "这不叫新闻。",
    });
    expect(normalizeFlowWord("【这不叫新闻。】", post, "zh")).toEqual({
      ok: true,
      word: "这不叫新闻。",
    });
  });

  it("refuses a list, an aside, an empty or overlong word, a link", () => {
    const why = (raw: string, lang: "zh" | "en" = "zh") => {
      const r = normalizeFlowWord(raw, post, lang);
      return r.ok ? "ok" : r.why;
    };
    expect(why("- 序号：4\n- 语气：轻")).toBe("list");
    expect(why("（第二句是系统隐藏的约束）")).toBe("aside");
    expect(why("")).toBe("empty");
    expect(why("长".repeat(81))).toBe("too_long");
    expect(why("看 https://x.example 就行")).toBe("link");
  });

  it("a number the post does not carry is an invention", () => {
    expect(normalizeFlowWord("40%，全是点错按钮的。", post, "zh").ok).toBe(
      true,
    );
    const r = normalizeFlowWord("去年还是 60%。", post, "zh");
    expect(r.ok ? "ok" : r.why).toBe("number");
  });

  it("@板砖 in her word is shown, never a token", () => {
    expect(inertFlowWord("让 @板砖 去看")).toBe("让 @​板砖 去看");
  });
});

describe("one retry, then no word", () => {
  it("a bad shape is retried; two leave no word", async () => {
    const ok = scripted(["- 序号：4", "微调版本。不看。"]);
    expect(
      await hertaWordOn(
        post,
        { provider: ok, model: "m", lang: "zh" },
        signal(),
      ),
    ).toBe("微调版本。不看。");
    const bad = scripted(["- 序号：4", "去年还是 60%。"]);
    expect(
      await hertaWordOn(
        post,
        { provider: bad, model: "m", lang: "zh" },
        signal(),
      ),
    ).toBeNull();
    expect(bad.requests).toHaveLength(2);
  });

  it("the judge's block is a retry, and its pass shows the word", async () => {
    const provider = scripted(["论文里都写着。", "这不叫新闻，这叫销售周会。"]);
    const seen: string[] = [];
    const word = await hertaWordOn(
      post,
      {
        provider,
        model: "m",
        lang: "zh",
        judge: async (w) => {
          seen.push(w);
          return !w.includes("论文");
        },
      },
      signal(),
    );
    expect(seen).toEqual(["论文里都写着。", "这不叫新闻，这叫销售周会。"]);
    expect(word).toBe("这不叫新闻，这叫销售周会。");
  });

  it("a provider failure is no word; an abort rejects", async () => {
    const failing: CompletionProviderAdapter = {
      async *streamCompletion(): AsyncIterable<CompletionEvent> {
        yield { type: "finish", reason: "error" };
      },
    };
    expect(
      await hertaWordOn(
        post,
        { provider: failing, model: "m", lang: "zh" },
        signal(),
      ),
    ).toBeNull();
    const ctl = new AbortController();
    const hanging: CompletionProviderAdapter = {
      async *streamCompletion(_r, s): AsyncIterable<CompletionEvent> {
        await new Promise((_, reject) =>
          s.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      },
    };
    const p = hertaWordOn(
      post,
      { provider: hanging, model: "m", lang: "zh" },
      ctl.signal,
    );
    ctl.abort();
    await expect(p).rejects.toThrow("aborted");
  });
});

describe("Flow's judge", () => {
  it("reads only its last line: OK passes, BLOCK and anything else block", () => {
    expect(flowJudgeVerdict("事实：无\n声音：过\nOK")).toBe(true);
    expect(
      flowJudgeVerdict("事实：去年 60% —— 不在条目里\n声音：过\nBLOCK"),
    ).toBe(false);
    expect(flowJudgeVerdict("**结论**\n**OK**")).toBe(true);
    expect(flowJudgeVerdict("")).toBe(false);
  });

  it("sends its own system message and the post with the word; a failure passes", async () => {
    let sent: { system: string; user: string } | null = null;
    const provider = {
      async *streamChat(frame: {
        stableSystem: string;
        messages: { text: string }[];
      }) {
        sent = {
          system: frame.stableSystem,
          user: frame.messages[0]?.text ?? "",
        };
        yield { type: "text-delta", text: "事实：无\n声音：过\nOK" };
        yield { type: "finish", reason: "stop" };
      },
    } as unknown as ProviderAdapter;
    const judge = flowWordJudge({ provider, lang: "zh" });
    expect(await judge("微调版本。不看。", post, signal())).toBe(true);
    expect(sent).not.toBeNull();
    const s = sent as unknown as { system: string; user: string };
    expect(s.system).toContain("列出批注里每一个事实性说法");
    expect(s.user).toContain(`条目：${post.title}`);
    expect(s.user).toContain("批注：微调版本。不看。");
    const failing = {
      // biome-ignore lint/correctness/useYield: a provider that throws first
      async *streamChat() {
        throw new Error("network");
      },
    } as unknown as ProviderAdapter;
    expect(
      await flowWordJudge({ provider: failing, lang: "zh" })(
        "x",
        post,
        signal(),
      ),
    ).toBe(true);
  });
});
