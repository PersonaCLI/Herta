import { describe, expect, it } from "vitest";
import {
  outlineTitleFor,
  type PdfTextItem,
  pdfBlocks,
  pdfPieces,
} from "./pdf-pieces.js";

/** A line of text at a baseline, in one item, ending the line. */
const line = (str: string, base: number, size = 10): PdfTextItem => ({
  str,
  base,
  size,
  hasEOL: true,
});

describe("pdfBlocks (ADR 0078 amendment 2026-10-21)", () => {
  it("lines close together are one block; a paragraph gap starts the next", () => {
    const blocks = pdfBlocks([
      line("First paragraph, line one", 100),
      line("first paragraph, line two", 112),
      line("Second paragraph", 140),
    ]);
    expect(blocks.map((b) => b.text)).toEqual([
      "First paragraph, line one\nfirst paragraph, line two",
      "Second paragraph",
    ]);
    expect(blocks[0]?.top).toBe(90);
  });

  it("a change of type size is a cut: the heading is its own block", () => {
    const blocks = pdfBlocks([
      line("A heading", 60, 18),
      line("Body text under it", 76),
      line("more body", 88),
    ]);
    expect(blocks.map((b) => b.text)).toEqual([
      "A heading",
      "Body text under it\nmore body",
    ]);
  });

  it("items on one baseline join into one line", () => {
    const blocks = pdfBlocks([
      { str: "Hello ", base: 100, size: 10 },
      { str: "world", base: 100.2, size: 10, hasEOL: true },
    ]);
    expect(blocks.map((b) => b.text)).toEqual(["Hello world"]);
  });

  it("two columns side by side share their bands; a band's text reads the first column, then the next", () => {
    // Content order: the left column, then the right.
    const blocks = pdfBlocks([
      line("left one", 100),
      line("left two", 112),
      line("right one", 100),
      line("right two", 112),
    ]);
    expect(blocks.map((b) => b.text)).toEqual([
      "left one\nleft two\nright one\nright two",
    ]);
  });

  it("a page with no text has no blocks", () => {
    expect(pdfBlocks([{ str: "  ", base: 10, size: 10 }])).toEqual([]);
  });
});

describe("pdfPieces", () => {
  const page = (
    n: number,
    top: number,
    blocks: Parameters<typeof pdfPieces>[0][number]["blocks"],
  ) => ({
    page: n,
    top,
    height: 200,
    scale: 1,
    blocks,
  });

  it("covers the window whole: cuts at the middle between blocks and of the gap between pages", () => {
    const bands = pdfPieces(
      [
        page(1, 16, [
          { top: 20, bottom: 60, text: "a" },
          { top: 100, bottom: 150, text: "b" },
        ]),
        page(2, 230, [{ top: 20, bottom: 80, text: "c" }]),
      ],
      0,
      446,
    );
    expect(bands.map((b) => [b.page, b.text, b.top, b.top + b.height])).toEqual(
      [
        [1, "a", 0, 96],
        [1, "b", 96, 223],
        [2, "c", 223, 446],
      ],
    );
  });

  it("a page not read yet, or with no text, is one band", () => {
    const bands = pdfPieces([page(1, 0, null), page(2, 214, [])], 0, 414);
    expect(bands.map((b) => [b.page, b.text])).toEqual([
      [1, null],
      [2, ""],
    ]);
  });

  it("a sliver — a page number alone — joins its neighbour", () => {
    const bands = pdfPieces(
      [
        page(1, 0, [
          { top: 20, bottom: 120, text: "body" },
          { top: 180, bottom: 186, text: "3" },
        ]),
      ],
      0,
      200,
    );
    expect(bands.map((b) => b.text)).toEqual(["body\n3"]);
  });
});

describe("outlineTitleFor", () => {
  it("the last entry that starts on or before the page", () => {
    const outline = [
      { page: 1, title: "Intro" },
      { page: 3, title: "Method" },
      { page: 3, title: "Method · Data" },
      { page: 7, title: "Results" },
    ];
    expect(outlineTitleFor(outline, 1)).toBe("Intro");
    expect(outlineTitleFor(outline, 5)).toBe("Method · Data");
    expect(outlineTitleFor([], 5)).toBeUndefined();
  });
});
