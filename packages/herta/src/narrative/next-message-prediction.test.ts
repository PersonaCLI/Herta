import { createHash } from "node:crypto";
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
  trailblazerNotesOf,
} from "./next-message-prediction.js";
import { promptAssetsFor } from "./prompt-assets.js";

/** The zero-width space the serializer breaks `@板砖` with. */
const ZWSP = String.fromCodePoint(0x200b);

// A message that set 板砖 to work: enough to go on.
const RECORD: TerminalRecord = [
  { kind: "user", text: "@板砖 帮我写个五子棋吧" },
  { kind: "system", label: "差分协处理器", body: "Writing gomoku.mjs" },
  { kind: "herta", surface: "speech", text: "写好了，测试也兜住了。" },
];

// Plain talk: two exchanges, no 板砖 anywhere.
const CHAT: TerminalRecord = [
  { kind: "user", text: "在吗？" },
  { kind: "herta", surface: "speech", text: "在。说吧。" },
  { kind: "user", text: "你今天在研究什么？" },
  { kind: "herta", surface: "speech", text: "模拟宇宙的新位面，你不会懂的。" },
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

const deps = (p: CompletionProviderAdapter, record = RECORD) => ({
  provider: p,
  model: "m",
  record,
  lang: "zh" as const,
});
const signal = () => new AbortController().signal;

describe("predictNextUserMessage (composer predictions, owner 2026-10-10)", () => {
  it("opens the Trailblazer's next block after the record, with the voice note right before it", async () => {
    const p = provider("再给 AI 加一档「地狱」难度？");
    const text = await predictNextUserMessage(deps(p), signal());
    expect(text).toBe("再给 AI 加一档「地狱」难度？");
    const req = p.requests[0];
    expect(
      req?.prompt.endsWith(`${PREDICTION_HINT.work.zh}\n（开拓者 说）\n`),
    ).toBe(true);
    // The frame, then the recent turns in the record's own grammar.
    expect(req?.prompt.startsWith(PREDICTION_FRAME.work.zh)).toBe(true);
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

  it("in plain talk, a line that calls 板砖 is no prediction", async () => {
    const p = provider("@板砖 把新位面跑一遍");
    expect(await predictNextUserMessage(deps(p, CHAT), signal())).toBeNull();
    expect(p.requests[0]?.prompt.startsWith(PREDICTION_FRAME.chat.zh)).toBe(
      true,
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
    expect(acceptPrediction("  行，先这样。  ", RECORD, "work")).toBe(
      "行，先这样。",
    );
    for (const short of ["哈哈哈", "ok", "啊？"])
      expect(acceptPrediction(short, RECORD, "work")).toBe(short);
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
      "xxx",
      "……",
      "？！",
      "@板砖 帮我写个五子棋吧", // the last thing already said
    ]) {
      expect(
        acceptPrediction(raw, RECORD, "work"),
        JSON.stringify(raw),
      ).toBeNull();
    }
  });

  it("drops a message the window already holds, with or without its call", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "@板砖 帮我写个 hello.mjs" },
      { kind: "system", label: "差分协处理器", body: "Writing hello.mjs" },
      { kind: "herta", surface: "speech", text: "写好了。" },
      { kind: "user", text: "你觉得写得怎么样？" },
      { kind: "herta", surface: "speech", text: "能跑。" },
    ];
    for (const raw of [
      "帮我写个 hello.mjs",
      `@${ZWSP}板砖  帮我写个 hello.mjs`,
      "你觉得写得怎么样？",
    ])
      expect(acceptPrediction(raw, record, "work"), raw).toBeNull();
    expect(acceptPrediction("@板砖 再写个 hello.py", record, "work")).toBe(
      "@板砖 再写个 hello.py",
    );
  });

  it("cuts at a tag the provider streamed past", () => {
    expect(
      acceptPrediction(
        "跑一下全部测试（/开拓者 说）\n（我 说）",
        RECORD,
        "work",
      ),
    ).toBe("跑一下全部测试");
  });

  it("calls 板砖 only where 板砖 is at work — a quoted one is no call", () => {
    expect(acceptPrediction("@板砖 再跑一遍", CHAT, "work")).toBe(
      "@板砖 再跑一遍",
    );
    expect(acceptPrediction("@板砖 再跑一遍", CHAT, "chat")).toBeNull();
    expect(acceptPrediction("`@板砖` 是谁？", CHAT, "chat")).toBe(
      "`@板砖` 是谁？",
    );
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
    const prompt = predictionPrompt(record, "zh");
    expect(prompt?.mode).toBe("work");
    const text = prompt?.text ?? "";
    for (const kept of [
      "跑一下测试",
      "回二",
      "第三句",
      "回三",
      "第四句",
      "回四",
      "npm test",
    ])
      expect(text, kept).toContain(kept);
    for (const dropped of ["开场白", "第一句", "回一", "内心独白"])
      expect(text, dropped).not.toContain(dropped);
    // The two rows are ONE digest block, under the compaction header.
    // (The frame names the label once itself.)
    expect(
      text.slice(PREDICTION_FRAME.work.zh.length).split("→ 差分协处理器"),
    ).toHaveLength(2);
    expect(text).toContain("历史已压缩");
    expect(text.startsWith(PREDICTION_FRAME.work.zh)).toBe(true);
    expect(text.endsWith(`${PREDICTION_HINT.work.zh}\n（开拓者 说）\n`)).toBe(
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
    const text =
      predictionPrompt(
        [
          { kind: "user", text: "@板砖 说说看" },
          ...rows,
          { kind: "herta", surface: "speech", text: long },
        ],
        "zh",
      )?.text ?? "";
    expect(text).toContain("结尾。");
    expect(text).not.toContain("开头");
    expect(text).toContain(`step-${MAX_RUN_LINES * 2 - 1}.sh`);
    expect(text).not.toContain("step-0.sh");
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

describe("predictionPrompt — 板砖's prompt or plain talk (owner 2026-10-11)", () => {
  it("plain talk never names 板砖", () => {
    for (const lang of ["zh", "en"] as const) {
      const prompt = predictionPrompt(CHAT, lang);
      expect(prompt?.mode).toBe("chat");
      expect(prompt?.text, lang).not.toContain("板砖");
      expect(prompt?.text, lang).not.toContain("差分协处理器");
    }
    // The work prompt does — it is how the Trailblazer puts 板砖 to work.
    expect(PREDICTION_HINT.work.zh).toContain("@板砖");
    expect(PREDICTION_FRAME.work.en).toContain("@板砖");
  });

  it("a message that called 板砖 is work even before a row of his lands", () => {
    expect(
      predictionPrompt(
        [...CHAT, { kind: "user", text: "@板砖 看看 src" }],
        "zh",
      )?.mode,
    ).toBe("work");
  });

  it("work that has scrolled out of the window is plain talk again", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "@板砖 写个 hello.mjs" },
      { kind: "system", label: "差分协处理器", body: "Writing hello.mjs" },
      { kind: "herta", surface: "speech", text: "写好了。" },
      ...CHAT,
      { kind: "user", text: "听起来挺无聊的。" },
      { kind: "herta", surface: "speech", text: "那是你的问题。" },
    ];
    const prompt = predictionPrompt(record, "zh");
    expect(prompt?.mode).toBe("chat");
    expect(prompt?.text).not.toContain("hello.mjs");
  });
});

describe("her page on the Trailblazer (owner 2026-10-11)", () => {
  const PAGE =
    "### 记录：关于开拓者\n\n有些夜晚的细节我已经不记得了，但关于这位开拓者，有几件事沉了下来：\n\n这小鬼总在深夜来，开口先问在吗。";
  const FEIAN = "### 废案_00：终端外侧的噪声\n\n正文";

  it("is read out of the prefix by its title, without the title line", () => {
    expect(trailblazerNotesOf([FEIAN, PAGE], "zh")).toBe(
      "有些夜晚的细节我已经不记得了，但关于这位开拓者，有几件事沉了下来：\n\n这小鬼总在深夜来，开口先问在吗。",
    );
    expect(trailblazerNotesOf([FEIAN], "zh")).toBeUndefined();
    // A page the prefix could not read is a placeholder, not a page.
    expect(
      trailblazerNotesOf(["[### 记录：关于开拓者.txt 读取失败]"], "zh"),
    ).toBeUndefined();
    // Each language reads its own page.
    expect(trailblazerNotesOf([PAGE], "en")).toBeUndefined();
    expect(
      trailblazerNotesOf(
        ["### 记录：About the Trailblazer\n\nThey come late."],
        "en",
      ),
    ).toBe("They come late.");
  });

  it("sits between the frame and the turns, word for word — and is absent when there is none", () => {
    const notes = "这小鬼总在深夜来。";
    expect(predictionPrompt(RECORD, "zh", notes)?.text).toContain(
      `${PREDICTION_FRAME.work.zh}\n\n〔大黑塔在自己的记录里写过：\n${notes}〕\n\n（开拓者 说）`,
    );
    expect(predictionPrompt(RECORD, "zh")?.text).not.toContain("记录里写过");
  });

  it("the bond line follows her bio's 第六章 — an edit there fails here until RELATION is re-read from it", () => {
    const chapter = (bio: string, from: string, to: string): string => {
      const at = bio.indexOf(from);
      expect(at, from).toBeGreaterThanOrEqual(0);
      return bio.slice(at, bio.indexOf(to, at));
    };
    const sha = (text: string): string =>
      createHash("sha256").update(text).digest("hex").slice(0, 16);
    expect(
      {
        zh: sha(
          chapter(
            promptAssetsFor("zh").hertaBio,
            "第六章：关于开拓者",
            "\n第七章：",
          ),
        ),
        en: sha(
          chapter(
            promptAssetsFor("en").hertaBio,
            "Chapter 6: About the Trailblazer",
            "\nChapter 7:",
          ),
        ),
      },
      "HertaBio's 第六章 changed: re-read RELATION in next-message-prediction.ts against it, then update these hashes",
    ).toEqual({ zh: "1b2a13ed33abf787", en: "cf25f9690a18918f" });
  });
});
