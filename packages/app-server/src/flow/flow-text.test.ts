import { describe, expect, it } from "vitest";
import {
  cleanArticle,
  cleanField,
  cut,
  inertMentions,
  normalizeTitle,
  normalizeUrl,
  parseJsonReply,
  plainText,
  siteName,
  unnameApp,
} from "./flow-text.js";

/** The text rules every field of an issue passes (ADR 0084 §5 step 4). */

describe("plainText", () => {
  it("strips Markdown links, emphasis, code and line markers, keeping the words", () => {
    expect(
      plainText(
        "# **Vite 7** is out — see [the post](https://vite.dev/blog) and `npm i vite`",
      ),
    ).toBe("Vite 7 is out — see the post and npm i vite");
    expect(plainText("![logo](x.png) _new_ and ~~old~~ *fast*")).toBe(
      "logo new and old fast",
    );
    expect(plainText("> quoted\n- bullet")).toBe("quoted bullet");
  });

  it("strips HTML, an escaped tag included", () => {
    expect(
      plainText("<b>bold</b> &lt;script&gt;x&lt;/script&gt; a&amp;b"),
    ).toBe("bold x a&b");
  });

  it("keeps paragraphs in a write-up and drops numbered markers there only", () => {
    expect(plainText("1. one\n\n\n\n2. two", true)).toBe("one\n\ntwo");
    expect(plainText("2. Node 24 lands")).toBe("2. Node 24 lands");
  });

  it("stays fast on a stray bracket or angle run", () => {
    const t0 = Date.now();
    plainText(`${"<".repeat(20_000)}x`);
    plainText(`${"[".repeat(20_000)}x`);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("inertMentions", () => {
  it("breaks @板砖 and @brick with a zero-width space and keeps the words", () => {
    expect(inertMentions("@板砖 go, @Brick too, mail@example.com")).toBe(
      "@​板砖 go, @​Brick too, mail@example.com",
    );
  });
});

describe("cleanField", () => {
  it("runs every rule, the cap last", () => {
    const out = cleanField(
      "**key** sk-abcdefghijklmnopqrstu @板砖 [x](http://y)",
      200,
    );
    expect(out).toBe("key [REDACTED:api_key] @​板砖 x");
    expect(Array.from(cleanField("一".repeat(300), 80))).toHaveLength(80);
    expect(cut("abcdef", 4)).toBe("abc…");
  });
});

describe("cleanArticle", () => {
  it("keeps headings, paragraphs, lists, bold and tables; takes out the rest", () => {
    const raw = [
      "# Genie 4",
      "",
      "Lead with **2 minutes** of play. <script>x()</script>",
      "",
      "## Specs",
      "",
      "* sound and picture ![img](https://x/i.png) [docs](https://x/d)",
      "",
      "| Model | Length |",
      "| --- | --- |",
      "| Genie 4 | 2 min |",
      "",
      "```js",
      "evil()",
      "```",
      "> quoted @brick",
    ].join("\n");
    expect(cleanArticle(raw, 2000)).toBe(
      [
        "### Genie 4",
        "",
        "Lead with **2 minutes** of play. x()",
        "",
        "### Specs",
        "",
        "- sound and picture docs",
        "",
        "| Model | Length |",
        "| --- | --- |",
        "| Genie 4 | 2 min |",
        "",
        "evil()",
        "",
        "quoted @\u200bbrick",
      ].join("\n"),
    );
  });

  it("caps at a block: a table goes whole or not at all, prose is cut", () => {
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(cleanArticle(`Lead.\n\n${table}`, 12)).toBe("Lead.");
    const long = cleanArticle(`### H\n\n${"d".repeat(500)}`, 200);
    expect(long.startsWith("### H\n\nddd")).toBe(true);
    expect(Array.from(long)).toHaveLength(200);
  });
});

describe("siteName", () => {
  it("decodes a hex-encoded site (the spike's finding)", () => {
    expect(siteName("766974656a73", "https://vite.dev/blog")).toBe("vitejs");
    expect(
      siteName(
        "4d6963726f736f667420446576656c6f70657220426c6f6773",
        "https://devblogs.microsoft.com/x",
      ),
    ).toBe("Microsoft Developer Blogs");
  });

  it("falls back to the host for hex that is not printable text, and for none", () => {
    expect(siteName("cafe", "https://www.example.com/a")).toBe("example.com");
    expect(siteName("0001", "https://example.org/a")).toBe("example.org");
    expect(siteName(null, "https://www.github.blog/x")).toBe("github.blog");
    expect(siteName("  ", "https://a.dev/")).toBe("a.dev");
  });

  it("leaves an ordinary name alone, odd-length hex-looking ones included", () => {
    expect(siteName("Vitest", "https://vitest.dev")).toBe("Vitest");
    expect(siteName("abc", "https://abc.xyz")).toBe("abc");
  });
});

describe("unnameApp", () => {
  it("turns the app named as the Trailblazer's into 'your project'", () => {
    expect(unnameApp("你的 HERTA 跑在 Electron 43 上", "zh")).toBe(
      "你的项目 跑在 Electron 43 上",
    );
    expect(unnameApp("your HERTA runs on Electron 43", "en")).toBe(
      "your project runs on Electron 43",
    );
  });

  it("drops a line that names Herta any other way", () => {
    expect(unnameApp("Herta is in the new banner", "en")).toBe("");
    expect(unnameApp("黑塔的新版本", "zh")).toBe("");
  });

  it("leaves lines without the name, and longer words containing it, alone", () => {
    expect(unnameApp("your acme-login is on Vite 6", "en")).toBe(
      "your acme-login is on Vite 6",
    );
    expect(unnameApp("hertaville uses Rust", "en")).toBe(
      "hertaville uses Rust",
    );
  });
});

describe("normalizeUrl / normalizeTitle", () => {
  it("drops the fragment, utm tags and a trailing slash", () => {
    expect(normalizeUrl("https://Vite.dev/blog/?utm_source=x&id=2#top")).toBe(
      "https://vite.dev/blog?id=2",
    );
    expect(normalizeUrl("https://a.dev/x/")).toBe(
      normalizeUrl("https://a.dev/x"),
    );
  });

  it("folds case, width and punctuation", () => {
    expect(normalizeTitle("Vite 7: Released!")).toBe(
      normalizeTitle("ＶＩＴＥ ７ — released"),
    );
  });
});

describe("parseJsonReply", () => {
  it("reads a bare, fenced or prefixed reply", () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('Here: ["x"] done')).toEqual(["x"]);
    expect(parseJsonReply("no json")).toBeUndefined();
  });
});
