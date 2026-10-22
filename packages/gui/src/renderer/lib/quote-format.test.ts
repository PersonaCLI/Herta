import { describe, expect, it } from "vitest";
import {
  boundQuoteText,
  type ComposerQuote,
  composeQuotedMessage,
  formatQuote,
  joinHeld,
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

describe("a PDF quote counts pages (ADR 0078 amendment 2026-10-21)", () => {
  const PAGE: ComposerQuote = {
    id: "qp",
    path: "docs/paper.pdf",
    from: 3,
    to: 4,
    unit: "page",
    title: "Method · Data",
    text: "The data came from two sources.",
  };

  it("the label is the path and the pages, in the message's language", () => {
    expect(quoteLabel(PAGE, "zh")).toBe("docs/paper.pdf · 第 3–4 页");
    expect(quoteLabel(PAGE, "en")).toBe("docs/paper.pdf · pp. 3–4");
    expect(quoteLabel({ ...PAGE, to: 3 }, "en")).toBe("docs/paper.pdf · p. 3");
    expect(quoteLabel({ ...PAGE, to: 3 }, "zh")).toBe(
      "docs/paper.pdf · 第 3 页",
    );
  });

  it("the header reads back — page part and a title that holds its own ' · '", () => {
    for (const lang of ["zh", "en"] as const) {
      const message = composeQuotedMessage([PAGE], "讲讲", lang);
      expect(message.split("\n")[0]).toBe(
        lang === "zh"
          ? "〔引用 docs/paper.pdf · 第 3–4 页 · Method · Data〕"
          : "〔Quote docs/paper.pdf · pp. 3–4 · Method · Data〕",
      );
      const [q] = parseLeadingQuotes(message).quotes;
      expect(q).toMatchObject({
        path: "docs/paper.pdf",
        from: 3,
        to: 4,
        unit: "page",
        title: "Method · Data",
        text: PAGE.text,
      });
    }
  });

  it("comes back as a page quote", () => {
    const back = quotesBack(composeQuotedMessage([PAGE], "", "en"));
    expect(back.quotes[0]).toMatchObject({ unit: "page", from: 3, to: 4 });
  });

  it("a line quote still reads as lines", () => {
    const [q] = parseLeadingQuotes(
      composeQuotedMessage([{ ...DIV, title: "A · B" }], "", "zh"),
    ).quotes;
    expect(q).toMatchObject({
      path: "src/calc.js",
      from: 9,
      to: 14,
      title: "A · B",
    });
    expect(q?.unit).toBeUndefined();
  });
});

describe("quotes held twice, a title that reads like a page, a cut emoji (release review 2026-10-22)", () => {
  const ADD: ComposerQuote = {
    id: "q2",
    path: "src/calc.js",
    from: 1,
    to: 2,
    text: "export function add(a, b) {\n  return a + b;",
    fence: "js",
  };

  it("a second hold keeps both messages' quotes in front, so both come back as chips and the card shows labels", () => {
    const joined = joinHeld(
      composeQuotedMessage([DIV], "first", "zh"),
      composeQuotedMessage([ADD], "second", "zh"),
    );
    const back = quotesBack(joined);
    expect(back.quotes.map((q) => [q.from, q.to])).toEqual([
      [9, 14],
      [1, 2],
    ]);
    expect(back.rest).toBe("first\n\nsecond");
    expect(quotedMessagePreview(joined)).not.toContain("```");
    // Quotes alone in the second; plain words as before.
    expect(
      quotesBack(joinHeld("first", composeQuotedMessage([ADD], "", "zh"))),
    ).toMatchObject({ rest: "first" });
    expect(joinHeld("a", "b")).toBe("a\n\nb");
  });

  it("a line quote whose title reads like a page stays a line quote; a PDF quote with a title is still a page quote", () => {
    for (const [lang, title] of [
      ["zh", "第 2 页"],
      ["en", "p. 3"],
      ["zh", "第 2 页 · 小结"],
    ] as const) {
      const msg = composeQuotedMessage([{ ...DIV, title }], "看这里", lang);
      const q = parseLeadingQuotes(msg).quotes[0];
      expect(q, title).toMatchObject({
        path: "src/calc.js",
        from: 9,
        to: 14,
        title,
      });
      expect(q?.unit, title).toBeUndefined();
    }
    const paper = composeQuotedMessage(
      [
        {
          id: "p",
          path: "docs/paper.pdf",
          from: 3,
          to: 3,
          unit: "page",
          title: "Intro",
          text: "x",
        },
      ],
      "",
      "zh",
    );
    expect(parseLeadingQuotes(paper).quotes[0]).toMatchObject({
      path: "docs/paper.pdf",
      from: 3,
      unit: "page",
      title: "Intro",
    });
  });

  it("the bound never cuts a character in half", () => {
    const out = boundQuoteText(`a${"😀".repeat(4100)}`, "zh");
    // encodeURIComponent throws on a lone surrogate.
    expect(() => encodeURIComponent(out)).not.toThrow();
    expect(out.length).toBeLessThan(8_100);
  });
});
