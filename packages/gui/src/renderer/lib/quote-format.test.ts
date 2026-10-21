import { describe, expect, it } from "vitest";
import {
  boundQuoteText,
  type ComposerQuote,
  composeQuotedMessage,
  formatQuote,
  parseLeadingQuotes,
  QUOTE_MAX_LINES,
  quotedMessagePreview,
  quoteLabel,
  quotesBack,
} from "./quote-format.js";

const DIV: ComposerQuote = {
  id: "q1",
  path: "src/calc.js",
  from: 9,
  to: 14,
  text: "export function div(a, b) {\n  return a / b;\n}",
  fence: "js",
};

describe("quote-format (ADR 0078 §4–§7)", () => {
  it("labels a range, or a single line", () => {
    expect(quoteLabel(DIV)).toBe("src/calc.js:9–14");
    expect(quoteLabel({ path: "a.ts", from: 3, to: 3 })).toBe("a.ts:3");
  });

  it("a quote is a header and a fence, in the session's language", () => {
    expect(formatQuote(DIV, "zh")).toBe(
      "〔引用 src/calc.js:9–14〕\n```js\nexport function div(a, b) {\n  return a / b;\n}\n```",
    );
    expect(formatQuote({ ...DIV, title: "用法" }, "en").split("\n")[0]).toBe(
      "〔Quote src/calc.js:9–14 · 用法〕",
    );
  });

  it("the fence outgrows any backticks inside the quoted text", () => {
    const md = { ...DIV, text: "```js\nx\n```", fence: undefined };
    const out = formatQuote(md, "zh").split("\n");
    expect(out[1]).toBe("````");
    expect(out[out.length - 1]).toBe("````");
  });

  it("the message is the quotes first, then what was typed; quotes alone are a message", () => {
    expect(composeQuotedMessage([DIV], "  讲讲这段  ", "zh")).toBe(
      `${formatQuote(DIV, "zh")}\n\n讲讲这段`,
    );
    expect(composeQuotedMessage([DIV], "", "zh")).toBe(formatQuote(DIV, "zh"));
    expect(composeQuotedMessage([], "hi", "zh")).toBe("hi");
  });

  it("reads the quotes back off the front of a message, and leaves the rest", () => {
    const msg = composeQuotedMessage(
      [DIV, { ...DIV, id: "q2", from: 1, to: 1, title: "head", text: "x" }],
      "这两段有什么关系？",
      "zh",
    );
    const { quotes, rest } = parseLeadingQuotes(msg);
    expect(quotes.map((q) => [q.label, q.path, q.from, q.to, q.title])).toEqual(
      [
        ["src/calc.js:9–14", "src/calc.js", 9, 14, undefined],
        ["src/calc.js:1", "src/calc.js", 1, 1, "head"],
      ],
    );
    expect(quotes[0]?.text).toBe(DIV.text);
    expect(rest).toBe("这两段有什么关系？");
  });

  it("a header without a closed fence is ordinary text", () => {
    const msg = "〔引用 a.ts:1–2〕\n```\nnot closed";
    expect(parseLeadingQuotes(msg)).toEqual({ quotes: [], rest: msg });
    expect(parseLeadingQuotes("hello").quotes).toEqual([]);
  });

  it("a long quote is bounded, with a note of what was left out", () => {
    const text = Array.from(
      { length: QUOTE_MAX_LINES + 5 },
      (_, i) => `l${i}`,
    ).join("\n");
    const out = boundQuoteText(text, "zh").split("\n");
    expect(out).toHaveLength(QUOTE_MAX_LINES + 1);
    expect(out[out.length - 1]).toBe("……（另有 5 行未引用）");
    expect(boundQuoteText("short", "en")).toBe("short");
  });

  it("the sidebar's one line shows the labels and what was said, never the fence", () => {
    const msg = composeQuotedMessage([DIV], "为什么不判零？", "zh");
    expect(quotedMessagePreview(msg)).toBe(
      "〔src/calc.js:9–14〕 为什么不判零？",
    );
    expect(quotedMessagePreview(composeQuotedMessage([DIV], "", "en"))).toBe(
      "〔src/calc.js:9–14〕",
    );
    expect(quotedMessagePreview("hello")).toBe("hello");
    // The stored preview, cut inside the fence: the label, not the source.
    const stored = `${composeQuotedMessage([DIV], "为什么不判零？", "zh").slice(0, 40)}…`;
    expect(quotedMessagePreview(stored)).toBe("〔src/calc.js:9–14〕");
  });
});

describe("a quote never dispatches, and comes back as a chip (ADR 0078 amendment 2026-10-21)", () => {
  it("a heading that names @板砖 or @brick goes into the header with the token broken", () => {
    const header = formatQuote(
      { ...DIV, title: "@板砖 委派 and @Brick" },
      "zh",
    ).split("\n")[0];
    expect(header).not.toContain("@板砖");
    expect(header).not.toMatch(/@brick/i);
    expect(header).toContain("板砖 委派");
  });

  it("quotesBack: the leading quotes as composer quotes again, fence tag and all, and the rest", () => {
    const message = composeQuotedMessage(
      [DIV, { ...DIV, id: "q2", from: 20, to: 20, fence: undefined }],
      "为什么不判零？",
      "zh",
    );
    const back = quotesBack(message);
    expect(back.rest).toBe("为什么不判零？");
    expect(back.quotes.map((q) => [q.path, q.from, q.to, q.fence])).toEqual([
      ["src/calc.js", 9, 14, "js"],
      ["src/calc.js", 20, 20, undefined],
    ]);
    expect(back.quotes[0]?.text).toBe(DIV.text);
    expect(new Set(back.quotes.map((q) => q.id)).size).toBe(2);
  });

  it("quotesBack leaves a message alone when it has no quotes", () => {
    expect(quotesBack("just words")).toEqual({
      quotes: [],
      rest: "just words",
    });
  });
});
