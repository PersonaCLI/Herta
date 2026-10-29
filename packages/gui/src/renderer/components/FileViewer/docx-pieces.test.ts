import { describe, expect, it } from "vitest";
import {
  docxBlocks,
  docxBlockText,
  docxSections,
  headingStyleClasses,
} from "./docx-pieces.js";

/** Word's pieces (ADR 0078 amendment 2026-10-29). */

describe("headingStyleClasses — which paragraph styles are headings", () => {
  it("by built-in name or outline level, inherited through basedOn; docx-preview's class spelling", () => {
    const classes = headingStyleClasses([
      { id: "Heading1", name: "heading 1", target: "p" },
      { id: "Title", name: "Title", target: "p" },
      // A Chinese template's ids, and a custom style based on a heading.
      {
        id: "2",
        name: "heading 2",
        target: "p",
        paragraphProps: { outlineLevel: 1 },
      },
      { id: "MyChapter", name: "My Chapter", basedOn: "2", target: "p" },
      {
        id: "Outlined Item",
        name: "x",
        target: "p",
        paragraphProps: { outlineLevel: 0 },
      },
      // Body text, a character style, outline level 9 (body).
      { id: "Normal", name: "Normal", target: "p" },
      { id: "Heading1Char", name: "Heading 1 Char", target: "span" },
      {
        id: "Body9",
        name: "b",
        target: "p",
        paragraphProps: { outlineLevel: 9 },
      },
    ]);
    expect([...classes].sort()).toEqual(
      [
        "docx_2",
        "docx_heading1",
        "docx_mychapter",
        "docx_outlined-item",
        "docx_title",
      ].sort(),
    );
  });
});

describe("docxSections — the owner's 大块: a heading and what follows it", () => {
  const b = (text: string, heading = false) => ({ text, heading });

  it("a preamble of its own; a heading with nothing before the next joins it", () => {
    expect(
      docxSections([
        b("封面说明"),
        b("1 引言", true),
        b("本研究……"),
        b("2 研究方法", true),
        b("2.1 数据", true),
        b("样本取自……"),
        b("Name\tValue"),
        b("3 结果", true),
        b("……"),
      ]),
    ).toEqual([
      { from: 1, to: 1 },
      { from: 2, to: 3, title: "1 引言" },
      { from: 4, to: 7, title: "2 研究方法" },
      { from: 8, to: 9, title: "3 结果" },
    ]);
  });

  it("no heading styles: one piece per block, never the whole document", () => {
    expect(docxSections([b("甲方"), b("乙方"), b("第一条")])).toEqual([
      { from: 1, to: 1 },
      { from: 2, to: 2 },
      { from: 3, to: 3 },
    ]);
    expect(docxSections([])).toEqual([]);
  });

  it("a title is one line, bounded", () => {
    const [s] = docxSections([b(`第一章\n${"长".repeat(200)}`, true)]);
    expect(s?.title).toMatch(/^第一章 长+…$/);
    expect(s?.title?.length).toBe(120);
  });
});

describe("docxBlocks / docxBlockText — what the page numbers, and its text", () => {
  function page(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = `<div class="docx-wrapper"><section class="docx"><header><p>Header</p></header><article>${html}</article><footer><p>Footer</p></footer></section></div>`;
    return root;
  }

  it("paragraphs and tables in the body, numbered; empty ones and headers/footers are not", () => {
    const root = page(
      `<p class="docx_heading1">Title</p><p></p><p>One<span> </span>two<br>three</p><table><tr><td><p>Name</p></td><td><p>Value</p></td></tr><tr><td><p>alpha</p></td><td><p>1</p></td></tr></table><p> </p>`,
    );
    const blocks = docxBlocks(root, new Set(["docx_heading1"]));
    expect(blocks.map((x) => [x.text, x.heading])).toEqual([
      ["Title", true],
      ["One\ttwo\nthree", false],
      ["Name\tValue\nalpha\t1", false],
    ]);
    expect(docxBlockText(blocks[2]?.el as Element)).toBe(
      "Name\tValue\nalpha\t1",
    );
  });

  it("a page break's second page continues the count", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="docx-wrapper"><section class="docx"><article><p>a</p></article></section><section class="docx"><article><p>b</p></article></section></div>';
    expect(docxBlocks(root, new Set()).map((x) => x.text)).toEqual(["a", "b"]);
  });
});
