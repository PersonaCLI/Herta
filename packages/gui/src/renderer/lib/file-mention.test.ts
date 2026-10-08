import { describe, expect, it } from "vitest";
import {
  brickAhead,
  brickComplete,
  findMentionQuery,
  insertBrick,
  insertMention,
  mentionItems,
  openingPaths,
  rankPaths,
} from "./file-mention.js";

describe("@-file mentions (ADR 0072 §2)", () => {
  it("finds the @query the caret sits in — anywhere in the text, only after a boundary", () => {
    expect(findMentionQuery("看看 @src/pa", 10)).toEqual({
      start: 3,
      query: "src/pa",
    });
    // Mid-text: the query runs to the caret, not past it.
    expect(findMentionQuery("@src/parser.ts 改一下", 4)).toEqual({
      start: 0,
      query: "src",
    });
    expect(findMentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    // An e-mail address is not a mention; neither is text after a space.
    expect(findMentionQuery("me@host", 7)).toBeNull();
    expect(findMentionQuery("@src parser", 11)).toBeNull();
    expect(findMentionQuery("abc", 3)).toBeNull();
    expect(findMentionQuery("", 0)).toBeNull();
  });

  it("offers @板砖 while the query can still become the token", () => {
    expect(brickAhead("", "zh")).toBe(true);
    expect(brickAhead("板", "zh")).toBe(true);
    expect(brickAhead("板砖", "zh")).toBe(true);
    expect(brickAhead("src", "zh")).toBe(false);
    // EN: "b", "br", "Bri" may still become @brick; "bu" cannot.
    expect(brickAhead("Bri", "en")).toBe(true);
    expect(brickAhead("bu", "en")).toBe(false);
    // A zh session has no "brick" token.
    expect(brickAhead("b", "zh")).toBe(false);
  });

  it("ranks the file name first, then the path, then an in-order match; shorter wins a tie", () => {
    const paths = [
      "packages/core/src/parser/tokens.ts",
      "src/parser.ts",
      "docs/parsers.md",
      "test/parser.test.ts",
      "src/pa-r-ser-x.ts",
      "README.md",
    ];
    expect(rankPaths(paths, "parser")).toEqual([
      "src/parser.ts",
      "docs/parsers.md",
      "test/parser.test.ts",
      "packages/core/src/parser/tokens.ts",
      "src/pa-r-ser-x.ts",
    ]);
    expect(rankPaths(paths, "SRC\\PARSER")).toEqual([
      "src/parser.ts",
      "packages/core/src/parser/tokens.ts",
      "src/pa-r-ser-x.ts",
    ]);
    expect(rankPaths(paths, "")).toEqual([]);
    // In order across a FOLDER's letters is noise for a bare file query
    // (live check 2026-09-29): p-a-r-s-e-r is spread over this path.
    expect(rankPaths(["packages/core/src/errors.ts"], "parser")).toEqual([]);
    expect(rankPaths(paths, "zzz")).toEqual([]);
    expect(
      rankPaths(
        Array.from({ length: 20 }, (_, i) => `f${i}.ts`),
        "f",
      ),
    ).toHaveLength(8);
  });

  it("replaces @query with the plain path and one space, and puts the caret after it", () => {
    expect(insertMention("看看 @src/pa", 3, 10, "src/parser.ts")).toEqual({
      text: "看看 src/parser.ts ",
      caret: 17,
    });
    // Mid-text, before an existing space: no second space.
    expect(insertMention("@src 改一下", 0, 4, "src/parser.ts")).toEqual({
      text: "src/parser.ts 改一下",
      caret: 14,
    });
  });

  it("a path with whitespace goes in backticks, so where it ends is not left to the reader (review 2026-09-30)", () => {
    expect(insertMention("看看 @des", 3, 7, "docs/design notes.md")).toEqual({
      text: "看看 `docs/design notes.md` ",
      caret: 26,
    });
  });
});

describe("what a bare @ and a query offer (owner 2026-10-08)", () => {
  const FILES = ["README.md", "build.ts", "src/parser.ts", "docs/parsers.md"];

  it("a bare @ offers @板砖 first, then files — not the token alone", () => {
    expect(mentionItems("", "zh", FILES)).toEqual([
      { kind: "brick" },
      { kind: "file", path: "README.md" },
      { kind: "file", path: "build.ts" },
      { kind: "file", path: "src/parser.ts" },
      { kind: "file", path: "docs/parsers.md" },
    ]);
  });

  it("the files being worked on come first; one no longer listed is not offered", () => {
    expect(
      mentionItems("", "zh", FILES, ["docs/parsers.md", "gone.ts"]).slice(1, 3),
    ).toEqual([
      { kind: "file", path: "docs/parsers.md" },
      { kind: "file", path: "README.md" },
    ]);
    expect(openingPaths(FILES, ["build.ts", "build.ts"], 2)).toEqual([
      "build.ts",
      "README.md",
    ]);
  });

  it("a query that can still be the token offers it AND its matching files", () => {
    expect(mentionItems("b", "en", FILES)).toEqual([
      { kind: "brick" },
      { kind: "file", path: "build.ts" },
    ]);
    // zh has no "brick": files only.
    expect(mentionItems("b", "zh", FILES)).toEqual([
      { kind: "file", path: "build.ts" },
    ]);
    expect(mentionItems("pars", "zh", FILES)[0]).toEqual({
      kind: "file",
      path: "src/parser.ts",
    });
  });

  it("the token typed out offers nothing, and with no listing the token is offered alone", () => {
    expect(brickComplete("板砖", "zh")).toBe(true);
    expect(brickComplete("Brick", "en")).toBe(true);
    expect(brickComplete("brick", "zh")).toBe(false);
    expect(mentionItems("板砖", "zh", FILES)).toEqual([]);
    expect(mentionItems("brick", "en", ["brick.ts"])).toEqual([]);
    expect(mentionItems("", "zh", null)).toEqual([{ kind: "brick" }]);
    expect(mentionItems("src", "zh", null)).toEqual([]);
  });

  it("completing the token replaces @query with @板砖, no space after", () => {
    expect(insertBrick("整理 @板", 3, 5, "板砖")).toEqual({
      text: "整理 @板砖",
      caret: 6,
    });
    expect(insertBrick("@b fix", 0, 2, "brick")).toEqual({
      text: "@brick fix",
      caret: 6,
    });
  });
});
