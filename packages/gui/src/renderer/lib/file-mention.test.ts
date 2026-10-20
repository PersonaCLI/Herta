import { describe, expect, it } from "vitest";
import {
  brickAhead,
  brickComplete,
  chipAt,
  chipify,
  expandChips,
  findChipSpans,
  findMentionQuery,
  insertBrick,
  insertChip,
  listedFolders,
  mentionItems,
  openingPaths,
  pruneChips,
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
    ).toHaveLength(12);
  });
});

describe("what a bare @ and a query offer (owner 2026-10-08)", () => {
  const FILES = ["README.md", "build.ts", "src/parser.ts", "docs/parsers.md"];

  it("a bare @ offers @板砖 first, then the top-level folders and the files — not the token alone", () => {
    expect(mentionItems("", "zh", FILES)).toEqual([
      { kind: "brick" },
      { kind: "file", path: "docs", dir: true },
      { kind: "file", path: "src", dir: true },
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
      { kind: "file", path: "docs", dir: true },
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

describe("file chips (ADR 0072 amendment 2026-10-20)", () => {
  it("a pick becomes an @<name> token and a chip that stands for its path", () => {
    expect(insertChip("看看 @pars", 3, 8, "src/parser.ts", false)).toEqual({
      text: "看看 @parser.ts ",
      caret: 14,
      chip: { name: "parser.ts", path: "src/parser.ts" },
    });
    expect(insertChip("@pa", 0, 3, "packages/", true).chip).toEqual({
      name: "packages",
      path: "packages",
      dir: true,
    });
  });

  it("finds the tokens; a name character on either side means it is not one", () => {
    const chips = [{ name: "a.ts", path: "src/a.ts" }];
    expect(findChipSpans("看@a.ts里 @a.ts", chips)).toEqual([
      { start: 1, end: 6, chip: chips[0] },
    ]);
    expect(findChipSpans("x@a.ts @a.tsx", chips)).toEqual([]);
  });

  it("two chips of one name match their tokens in the order they went in", () => {
    const one = { name: "index.ts", path: "a/index.ts" };
    const two = { name: "index.ts", path: "b/index.ts" };
    const spans = findChipSpans("@index.ts 和 @index.ts", [one, two]);
    expect(spans.map((s) => s.chip.path)).toEqual(["a/index.ts", "b/index.ts"]);
  });

  it("sends each token as its path and lists the paths; a folder keeps its slash, whitespace its ticks", () => {
    expect(
      expandChips("看 @a.ts 和 @docs 里的 @design notes.md", [
        { name: "a.ts", path: "src/a.ts" },
        { name: "docs", path: "docs", dir: true },
        { name: "design notes.md", path: "docs/design notes.md" },
      ]),
    ).toEqual({
      text: "看 src/a.ts 和 docs/ 里的 `docs/design notes.md`",
      mentions: ["src/a.ts", "docs/", "docs/design notes.md"],
    });
  });

  it("a token edited away takes its chip; an untouched list is the same list", () => {
    const chips = [
      { name: "a.ts", path: "src/a.ts" },
      { name: "b.ts", path: "src/b.ts" },
    ];
    expect(pruneChips("@a.ts and @b.ts", chips)).toBe(chips);
    expect(pruneChips("@a.ts and @b.t", chips)).toEqual([chips[0]]);
  });

  it("the caret at a token's end, or inside it, is on the chip", () => {
    const spans = findChipSpans("x @a.ts y", [
      { name: "a.ts", path: "src/a.ts" },
    ]);
    expect(chipAt(spans, 2)).toBeNull();
    expect(chipAt(spans, 4)?.chip.path).toBe("src/a.ts");
    expect(chipAt(spans, 7)?.chip.path).toBe("src/a.ts");
  });

  it("a sent message comes back as chips (the ↑ recall)", () => {
    expect(chipify("看 src/a.ts 和 docs/", ["src/a.ts", "docs/"])).toEqual({
      text: "看 @a.ts 和 @docs",
      chips: [
        { name: "a.ts", path: "src/a.ts" },
        { name: "docs", path: "docs", dir: true },
      ],
    });
  });

  it("the folders of a listing, shallowest first", () => {
    expect(listedFolders(["a/b/c.ts", "a/d.ts", "e/f.ts", "g.ts"])).toEqual([
      "a",
      "e",
      "a/b",
    ]);
  });
});
