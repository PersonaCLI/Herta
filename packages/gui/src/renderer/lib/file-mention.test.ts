import { describe, expect, it } from "vitest";
import {
  addChipAt,
  brickAhead,
  brickComplete,
  chipAt,
  chipify,
  chipifyPicks,
  chipsAfterEdit,
  expandChips,
  findChipSpans,
  findMentionQuery,
  insertBrick,
  insertChip,
  insertPickChip,
  listedFolders,
  mentionItems,
  openingPaths,
  type PagePick,
  pickLine,
  picksIn,
  pruneChips,
  rankPaths,
  withoutChip,
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

  it("two chips of one name match their tokens in the registry's order", () => {
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
      picks: [],
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

  it("an edit placed by the caret takes the chip it touched — of two same-name chips, the right one (release review 2026-10-22)", () => {
    const a = { name: "index.ts", path: "a/index.ts" };
    const b = { name: "index.ts", path: "b/index.ts" };
    const both = [a, b];
    const prev = "@index.ts @index.ts ";
    // The first token and its space selected and deleted: the caret at 0.
    const left = chipsAfterEdit(prev, "@index.ts ", 0, both);
    expect(left).toEqual([b]);
    expect(expandChips("@index.ts ", left).text).toBe("b/index.ts ");
    // The same text, the second deleted: the caret at 10.
    expect(chipsAfterEdit(prev, "@index.ts ", 10, both)).toEqual([a]);
    // A name character typed after the first token breaks that one only.
    expect(chipsAfterEdit(prev, "@index.tsx @index.ts ", 10, both)).toEqual([
      b,
    ]);
    // Typing in front moves the tokens and keeps every chip.
    expect(chipsAfterEdit(prev, "看 @index.ts @index.ts ", 2, both)).toBe(both);
  });

  it("Backspace over a chip, or its menu's Remove, takes that chip and no other of its name", () => {
    const a = { name: "index.ts", path: "a/index.ts" };
    const b = { name: "index.ts", path: "b/index.ts" };
    expect(withoutChip([a, b], a)).toEqual([b]);
    const both = [a, b];
    expect(withoutChip(both, { ...a })).toBe(both);
  });

  it("a pick goes into the registry in the text's order: picked in front of a same-name chip, each keeps its path", () => {
    const a = { name: "index.ts", path: "a/index.ts" };
    const b = { name: "index.ts", path: "b/index.ts" };
    // b was picked first; now `@ind` at the start is picked as a/index.ts.
    const before = "@ind @index.ts ";
    const next = insertChip(before, 0, 4, "a/index.ts", false);
    const chips = addChipAt([b], findChipSpans(before, [b]), 0, next.chip);
    expect(next.text).toBe("@index.ts @index.ts ");
    expect(expandChips(next.text, chips).text).toBe("a/index.ts b/index.ts ");
    expect(addChipAt([b], findChipSpans(before, [b]), 15, a)).toEqual([b, a]);
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

  it("the ↑ recall gives each occurrence its own chip, in order, and only where the path stands alone (release review 2026-10-22)", () => {
    const x = { name: "x.ts", path: "src/x.ts" };
    expect(chipify("比较 src/x.ts 和 src/x.ts", ["src/x.ts"])).toEqual({
      text: "比较 @x.ts 和 @x.ts",
      chips: [x, x],
    });
    expect(chipify("看 docs/README.md 和 README.md", ["README.md"])).toEqual({
      text: "看 docs/README.md 和 @README.md",
      chips: [{ name: "README.md", path: "README.md" }],
    });
    expect(chipify("src/ 下的 src/foo.ts", ["src/"])).toEqual({
      text: "@src 下的 src/foo.ts",
      chips: [{ name: "src", path: "src", dir: true }],
    });
    // Two files of one name come back in the order they were sent.
    const back = chipify("b/index.ts 对比 a/index.ts", [
      "b/index.ts",
      "a/index.ts",
    ]);
    expect(expandChips(back.text, back.chips).text).toBe(
      "b/index.ts 对比 a/index.ts",
    );
  });

  it("a full stop after a chip ends the sentence, not the name; a name that goes on is not the chip (release review 2026-10-22)", () => {
    const readme = { name: "README.md", path: "docs/README.md" };
    expect(findChipSpans("see @README.md.", [readme])).toEqual([
      { start: 4, end: 14, chip: readme },
    ]);
    expect(expandChips("see @README.md.", [readme]).text).toBe(
      "see docs/README.md.",
    );
    expect(findChipSpans("see @README.md.bak", [readme])).toEqual([]);
    expect(findChipSpans("see @README.md..", [readme])).toEqual([]);
    expect(chipify("see docs/README.md.", ["docs/README.md"])).toEqual({
      text: "see @README.md.",
      chips: [readme],
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

describe("elements picked on the page (ADR 0083 §4)", () => {
  const raw = {
    element: 'button "Sign in"',
    route: "localhost:5173/login",
    html: '<button class="cta">\n  Sign in\n</button>',
  };
  const pick: PagePick = {
    element: raw.element,
    route: raw.route,
    line: pickLine(raw),
  };

  it("a pick's line: route, element and HTML on one line", () => {
    expect(pick.line).toBe(
      'localhost:5173/login · button "Sign in" · <button class="cta"> Sign in </button>',
    );
    expect(pickLine({ ...raw, html: "" })).toBe(
      'localhost:5173/login · button "Sign in"',
    );
  });

  it("lands as a token at the caret and goes as its line, recorded as a pick", () => {
    const placed = insertPickChip(
      "this does nothing",
      4,
      "按钮「Sign in」",
      pick,
    );
    expect(placed.text).toBe("this @按钮「Sign in」 does nothing");
    expect(placed.caret).toBe("this @按钮「Sign in」 ".length);
    expect(findChipSpans(placed.text, [placed.chip])).toHaveLength(1);
    const sent = expandChips(placed.text, [placed.chip]);
    expect(sent.text).toBe(`this ${pick.line} does nothing`);
    expect(sent.picks).toEqual([pick]);
    expect(sent.mentions).toEqual([]);
  });

  it("a line that came back as words is still a pick, and comes back as its chip", () => {
    const words = `again: ${pick.line}`;
    expect(picksIn(words, [pick, { ...pick, line: "elsewhere" }])).toEqual([
      pick,
    ]);
    expect(picksIn("nothing here", [pick])).toEqual([]);
    const back = chipifyPicks(words, [pick], () => "按钮「Sign in」");
    expect(back.text).toBe("again: @按钮「Sign in」");
    expect(back.chips).toEqual([
      { name: "按钮「Sign in」", path: pick.line, pick },
    ]);
  });
});
