import { describe, expect, it } from "vitest";
import { nameQuotedPages, quotedPageUrls } from "./quoted-pages.js";

/** The pages a message quotes at its front (ADR 0084 §9). */

const post = [
  "〔引用 https://nodejs.org/en/blog/release/v24 · Node.js 24 is out〕",
  "```",
  "Node.js · 2026-10-30",
  "",
  "A new major.",
  "```",
].join("\n");
const file = ["〔引用 src/calc.js:9–14〕", "```js", "div(a, b)", "```"].join(
  "\n",
);

describe("quotedPageUrls", () => {
  it("reads each leading post quote's URL, past a file quote", () => {
    expect(quotedPageUrls(`${file}\n\n${post}\n\n这个怎么样？`)).toEqual([
      "https://nodejs.org/en/blog/release/v24",
    ]);
  });

  it("an English header, and one with no title", () => {
    expect(
      quotedPageUrls("〔Quote https://a.dev/x?q=1〕\n```\nbody\n```"),
    ).toEqual(["https://a.dev/x?q=1"]);
  });

  it("a header after the words, or over no closed fence, is text", () => {
    expect(quotedPageUrls(`看看这个\n\n${post}`)).toEqual([]);
    expect(
      quotedPageUrls("〔引用 https://a.dev/x · T〕\n```\nnever closed"),
    ).toEqual([]);
  });
});

describe("nameQuotedPages", () => {
  it("names the URL in the header, and leaves the rest as written", () => {
    const text = `${file}\n\n${post}\n\n这个怎么样？`;
    const named = nameQuotedPages(text, (url) => `网页 ${new URL(url).host}`);
    expect(named).toContain("〔引用 网页 nodejs.org · Node.js 24 is out〕");
    expect(named).not.toContain("https://");
    expect(named).toContain("〔引用 src/calc.js:9–14〕");
    expect(named.endsWith("这个怎么样？")).toBe(true);
  });

  it("a message with no quoted page comes back as it was", () => {
    const text = "see https://a.dev/x";
    expect(nameQuotedPages(text, () => "?")).toBe(text);
  });
});
