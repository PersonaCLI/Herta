import type {
  CompletionEvent,
  CompletionProviderAdapter,
  CompletionRequest,
  TerminalRecord,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  acceptPrediction,
  MAX_REPLY_CHARS,
  MAX_RUN_LINES,
  PREDICTION_FRAME,
  PREDICTION_HINT,
  predictionPrompt,
  predictNextUserMessage,
} from "./next-message-prediction.js";

/** The zero-width space the serializer breaks `@板砖` with. */
const ZWSP = String.fromCodePoint(0x200b);

// A message that set 板砖 to work: enough to go on.
const RECORD: TerminalRecord = [
  { kind: "user", text: "@板砖 帮我写个五子棋吧" },
  { kind: "system", label: "差分协处理器", body: "Writing gomoku.mjs" },
  { kind: "herta", surface: "speech", text: "写好了，测试也兜住了。" },
];

function provider(
  reply: string | Error,
): CompletionProviderAdapter & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    streamCompletion(req: CompletionRequest): AsyncIterable<CompletionEvent> {
      requests.push(req);
      return (async function* () {
        if (reply instanceof Error) throw reply;
        yield { type: "text-delta", text: reply } as const;
        yield { type: "finish", reason: "stop" } as const;
      })();
    },
  };
}

const deps = (p: CompletionProviderAdapter) => ({
  provider: p,
  model: "m",
  record: RECORD,
  lang: "zh" as const,
});
const signal = () => new AbortController().signal;

describe("predictNextUserMessage (composer predictions, owner 2026-10-10)", () => {
  it("opens the Trailblazer's next block after the record, with the voice note right before it", async () => {
    const p = provider("大黑塔，再给 AI 加一档「地狱」难度？");
    const text = await predictNextUserMessage(deps(p), signal());
    expect(text).toBe("大黑塔，再给 AI 加一档「地狱」难度？");
    const req = p.requests[0];
    expect(req?.prompt.endsWith(`${PREDICTION_HINT.zh}\n（开拓者 说）\n`)).toBe(
      true,
    );
    // The frame, then the recent turns in the record's own grammar.
    expect(req?.prompt.startsWith(PREDICTION_FRAME.zh)).toBe(true);
    expect(req?.prompt).toContain(
      "（我 说）\n写好了，测试也兜住了。\n（/我 说）",
    );
    expect(req?.stop).toContain("（/开拓者 说）");
    expect(req?.stop).toContain("（我 说）");
  });

  it("gives back the @板砖 the serializer broke for the prompt", async () => {
    const p = provider(`@${ZWSP}板砖 把悔棋也补个测试`);
    expect(await predictNextUserMessage(deps(p), signal())).toBe(
      "@板砖 把悔棋也补个测试",
    );
  });

  it("a provider failure is no prediction; an abort rejects", async () => {
    expect(
      await predictNextUserMessage(deps(provider(new Error("down"))), signal()),
    ).toBeNull();
    const ac = new AbortController();
    ac.abort();
    const aborting: CompletionProviderAdapter = {
      streamCompletion: (): AsyncIterable<CompletionEvent> => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new DOMException("aborted", "AbortError")),
        }),
      }),
    };
    await expect(
      predictNextUserMessage(deps(aborting), ac.signal),
    ).rejects.toThrow();
  });
});

describe("acceptPrediction", () => {
  it("keeps one short typed line", () => {
    expect(acceptPrediction("  行，先这样。  ", RECORD)).toBe("行，先这样。");
  });

  it("drops what no user would type", () => {
    for (const raw of [
      "",
      "   ",
      "第一行\n第二行",
      "很".repeat(61),
      "〔提示〕好的",
      "（展示照片）",
      "[沉默]",
      "@板砖 帮我写个五子棋吧", // the last thing already said
    ]) {
      expect(acceptPrediction(raw, RECORD), JSON.stringify(raw)).toBeNull();
    }
  });

  it("cuts at a tag the provider streamed past", () => {
    expect(
      acceptPrediction("跑一下全部测试（/开拓者 说）\n（我 说）", RECORD),
    ).toBe("跑一下全部测试");
  });
});

describe("predictionPrompt — the last few turns, 板砖's runs folded, with guidance (owner 2026-10-10)", () => {
  it("reads the last 3 messages, her spoken replies and 板砖's runs as one digest each — no thoughts", () => {
    const record: TerminalRecord = [
      { kind: "herta", surface: "speech", text: "开场白。" },
      { kind: "user", text: "第一句" },
      { kind: "herta", surface: "speech", text: "回一" },
      { kind: "user", text: "@板砖 跑一下测试" },
      { kind: "herta", surface: "thought", text: "内心独白" },
      { kind: "system", label: "差分协处理器", body: "Running npm test" },
      { kind: "system", label: "差分协处理器", body: "Reading src/a.ts" },
      { kind: "herta", surface: "speech", text: "回二" },
      { kind: "user", text: "第三句" },
      { kind: "herta", surface: "speech", text: "回三" },
      { kind: "user", text: "第四句" },
      { kind: "herta", surface: "speech", text: "回四" },
    ];
    const prompt = predictionPrompt(record, "zh") ?? "";
    for (const kept of [
      "跑一下测试",
      "回二",
      "第三句",
      "回三",
      "第四句",
      "回四",
      "npm test",
    ])
      expect(prompt, kept).toContain(kept);
    for (const dropped of ["开场白", "第一句", "回一", "内心独白"])
      expect(prompt, dropped).not.toContain(dropped);
    // The two rows are ONE digest block, under the compaction header.
    // (The frame names the label once itself.)
    expect(
      prompt.slice(PREDICTION_FRAME.zh.length).split("→ 差分协处理器"),
    ).toHaveLength(2);
    expect(prompt).toContain("历史已压缩");
    expect(prompt.startsWith(PREDICTION_FRAME.zh)).toBe(true);
    expect(prompt.endsWith(`${PREDICTION_HINT.zh}\n（开拓者 说）\n`)).toBe(
      true,
    );
  });

  it("a long reply keeps its end, and a long run its header and last lines", () => {
    const long = `开头${"很".repeat(MAX_REPLY_CHARS)}结尾。`;
    const rows: TerminalRecord = Array.from(
      { length: MAX_RUN_LINES * 2 },
      (_, i) => ({
        kind: "system" as const,
        label: "差分协处理器" as const,
        body: `Running step-${i}.sh`,
      }),
    );
    const prompt =
      predictionPrompt(
        [
          { kind: "user", text: "@板砖 说说看" },
          ...rows,
          { kind: "herta", surface: "speech", text: long },
        ],
        "zh",
      ) ?? "";
    expect(prompt).toContain("结尾。");
    expect(prompt).not.toContain("开头");
    expect(prompt).toContain(`step-${MAX_RUN_LINES * 2 - 1}.sh`);
    expect(prompt).not.toContain("step-0.sh");
  });

  it("with nothing to continue from — one message, no work of 板砖's — there is no prompt", () => {
    expect(
      predictionPrompt(
        [{ kind: "herta", surface: "speech", text: "开场白。" }],
        "zh",
      ),
    ).toBeNull();
    expect(
      predictionPrompt(
        [
          { kind: "user", text: "在吗？" },
          { kind: "herta", surface: "speech", text: "在。说吧。" },
        ],
        "zh",
      ),
    ).toBeNull();
    // One message that set 板砖 to work is enough.
    expect(
      predictionPrompt(
        [
          { kind: "user", text: "@板砖 写个 hello.mjs" },
          { kind: "system", label: "差分协处理器", body: "Writing hello.mjs" },
          { kind: "herta", surface: "speech", text: "写好了。" },
        ],
        "zh",
      ),
    ).not.toBeNull();
  });
});
