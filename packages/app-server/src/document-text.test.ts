import { describe, expect, it, vi } from "vitest";
import {
  extractDocumentText,
  MAX_OUTLINE_DEPTH,
  MAX_OUTLINE_ENTRIES,
  MAX_PDF_PAGES,
  sniffDocumentFormat,
  textOfWordprocessingXml,
  walkWordprocessingXml,
} from "./document-text.js";
import {
  docxHeading,
  docxParagraphs,
  makeDocx,
  makeNonWordZip,
  makeOleBytes,
  makePdf,
  type PdfBookmark,
} from "./testing/document-fixtures.js";

/** The zh page marker (the default), for the PDF expectations. */
const pg = (n: number): string => `── 第 ${n} 页 ──`;

describe("sniffDocumentFormat — extension AND magic (ADR 0038 §2)", () => {
  it(".pdf with the %PDF- header is pdf", () => {
    expect(sniffDocumentFormat("report.pdf", makePdf([["x"]]))).toEqual({
      kind: "pdf",
    });
    // Case-insensitive extension.
    expect(sniffDocumentFormat("REPORT.PDF", makePdf([["x"]]))).toEqual({
      kind: "pdf",
    });
  });

  it("tolerates leading junk before the header, as pdfjs does, within 1024 bytes", () => {
    const junk = Buffer.concat([Buffer.alloc(200, 0x20), makePdf([["x"]])]);
    expect(sniffDocumentFormat("a.pdf", junk)).toEqual({ kind: "pdf" });
    const tooFar = Buffer.concat([Buffer.alloc(2000, 0x20), makePdf([["x"]])]);
    expect(sniffDocumentFormat("a.pdf", tooFar)).toEqual({ kind: "none" });
  });

  it(".pdf without the header is not ours — falls to the text path", () => {
    expect(
      sniffDocumentFormat("notes.pdf", Buffer.from("just text\n", "utf8")),
    ).toEqual({ kind: "none" });
  });

  it(".docx with the zip signature is docx; with the OLE signature it is unsupported; otherwise none", () => {
    expect(sniffDocumentFormat("spec.docx", makeDocx(""))).toEqual({
      kind: "docx",
    });
    expect(sniffDocumentFormat("spec.docx", makeOleBytes())).toEqual({
      kind: "unsupported",
    });
    expect(sniffDocumentFormat("spec.docx", Buffer.from("plain"))).toEqual({
      kind: "none",
    });
  });

  it("legacy Office and sibling OOXML extensions are unsupported regardless of bytes", () => {
    for (const name of [
      "a.doc",
      "a.xls",
      "a.ppt",
      "a.xlsx",
      "a.pptx",
      "A.DOC",
    ]) {
      expect(sniffDocumentFormat(name, Buffer.from("anything"))).toEqual({
        kind: "unsupported",
      });
    }
  });

  it("everything else is none — the ordinary text path decides", () => {
    for (const name of ["a.md", "a.txt", "a.csv", "a", ".pdfx", "a.pdf.bak"]) {
      expect(sniffDocumentFormat(name, makePdf([["x"]]))).toEqual({
        kind: "none",
      });
    }
  });
});

describe("extractDocumentText — pdf", () => {
  it("loads pdfjs with neither a DOM nor the native canvas present — the packaged app's exact conditions", async () => {
    // pdfjs 6 evaluates `new DOMMatrix()` at module scope and would polyfill
    // it from @napi-rs/canvas; that package is excluded from the workspace
    // (root pnpm override) precisely so this test runs under the same
    // conditions as the installed app, where no node_modules exist. If either
    // stub in installRenderingGlobalStubs is removed, this is the test that
    // fails — not the first user to attach a PDF.
    expect(
      (globalThis as { navigator?: { userAgent?: string } }).navigator
        ?.userAgent ?? "",
    ).not.toMatch(/jsdom/i);
    let canvasResolvable = true;
    try {
      const { createRequire } = await import("node:module");
      createRequire(import.meta.url).resolve("@napi-rs/canvas");
    } catch {
      canvasResolvable = false;
    }
    expect(canvasResolvable).toBe(false);
    // …and the load is QUIET about it: pdfjs's module-scope `console.warn`
    // for the missing canvas is the designed state, not an error, and it
    // read as one in the launch log (owner 2026-09-03). This is the first
    // PDF load in this file, so the import happens inside the spy.
    const warned: string[] = [];
    const spy = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => {
        warned.push(String(args[0]));
      });
    try {
      const r = await extractDocumentText("pdf", makePdf([["still works"]]));
      expect(r).toEqual({ ok: true, text: `${pg(1)}\nstill works`, pages: 1 });
      // The filter is scoped to the import: what was console.warn before the
      // load (the spy) is console.warn again after it.
      expect(console.warn).toBe(spy);
    } finally {
      spy.mockRestore();
    }
    expect(warned.filter((w) => /napi-rs\/canvas|polyfill/.test(w))).toEqual(
      [],
    );
    // 30 s tier (2026-09-03): this is the file's FIRST pdfjs load — 3 MB of
    // engine through vitest's transform — and under full-suite contention
    // it took 7.4 s once today, against 0.36 s alone. The load is not slow;
    // the machine is busy (same class as the 2026-08-31 scanner guards).
  }, 30_000);

  it("extracts text with line breaks and a page count, every page opened by its marker line (2026-08-23)", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([["Hello (world)", "Second line"], ["Page two"]]),
    );
    expect(r).toEqual({
      ok: true,
      text: `${pg(1)}\nHello (world)\nSecond line\n\n${pg(2)}\nPage two`,
      pages: 2,
    });
    // The marker is localized by the session language and lives in core
    // (pageMarkerLine), so the three readers of the shape agree.
    const en = await extractDocumentText("pdf", makePdf([["x"], ["y"]]), {
      lang: "en",
    });
    expect(en.ok && en.text).toBe("── page 1 ──\nx\n\n── page 2 ──\ny");
  });

  it("a page with no text content is `empty` — the scanned-PDF case ADR 0033 §5 warned about; the markers alone do not make it a text file", async () => {
    const r = await extractDocumentText("pdf", makePdf([[], []]));
    expect(r).toEqual({ ok: false, reason: "empty", pages: 2 });
  });

  it("a PDF's bookmarks become the outline: page + that page's marker line, nested by depth, named and explicit dests alike", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([["one"], ["two", "more"], ["three"]], {
        bookmarks: [
          { title: "Chapter 1", page: 1 },
          {
            title: "Chapter 2",
            page: 2,
            named: true,
            items: [{ title: "  Section  2.1 ", page: 3 }],
          },
          { title: "No dest", page: 0 },
        ],
      }),
    );
    if (!r.ok) throw new Error(r.reason);
    // Page 1's marker is line 1; page 2 starts after "one" + blank = line 4;
    // page 3 after "two","more" + blank = line 8.
    expect(r.outline).toEqual([
      { level: 1, title: "Chapter 1", page: 1, line: 1 },
      { level: 1, title: "Chapter 2", page: 2, line: 4 },
      { level: 2, title: "Section 2.1", page: 3, line: 8 },
      { level: 1, title: "No dest", line: 1 },
    ]);
    const lines = r.text.split("\n");
    expect(lines[0]).toBe(pg(1));
    expect(lines[3]).toBe(pg(2));
    expect(lines[7]).toBe(pg(3));
  });

  it("a PDF without bookmarks carries no outline at all — absence is a fact, not an empty list", async () => {
    const r = await extractDocumentText("pdf", makePdf([["plain"]]));
    expect(r.ok && "outline" in r).toBe(false);
  });

  it("the outline is bounded in entries and depth", async () => {
    const deep = (d: number): PdfBookmark =>
      d > MAX_OUTLINE_DEPTH + 2
        ? { title: `d${d}`, page: 1 }
        : { title: `d${d}`, page: 1, items: [deep(d + 1)] };
    const many = Array.from({ length: MAX_OUTLINE_ENTRIES + 5 }, (_, i) => ({
      title: `e${i}`,
      page: 1,
    }));
    const r = await extractDocumentText(
      "pdf",
      makePdf([["p"]], { bookmarks: [deep(1), ...many] }),
    );
    if (!r.ok || r.outline === undefined) throw new Error("no outline");
    expect(Math.max(...r.outline.map((e) => e.level))).toBe(MAX_OUTLINE_DEPTH);
    expect(r.outline.length).toBe(MAX_OUTLINE_ENTRIES);
  });

  it("a password-protected file is `encrypted`, not a generic parse error", async () => {
    const r = await extractDocumentText(
      "pdf",
      makePdf([["secret"]], { encrypt: true }),
    );
    expect(r).toEqual({ ok: false, reason: "encrypted" });
  });

  it("garbage that passed the sniff is `parse_error`", async () => {
    const r = await extractDocumentText(
      "pdf",
      Buffer.from("%PDF-1.4\nthis is not a pdf body\n", "latin1"),
    );
    expect(r).toEqual({ ok: false, reason: "parse_error" });
  });

  it("over the page cap is refused whole with the page count (ADR 0038 §4)", async () => {
    const twelve = makePdf(Array.from({ length: 12 }, (_, i) => [`p${i + 1}`]));
    const r = await extractDocumentText("pdf", twelve, { maxPages: 10 });
    expect(r).toEqual({ ok: false, reason: "too_many_pages", pages: 12 });
    // At the cap exactly, it goes through.
    const ok = await extractDocumentText("pdf", twelve, { maxPages: 12 });
    expect(ok.ok).toBe(true);
    expect(MAX_PDF_PAGES).toBe(1000);
  });

  it("does not consume the caller's buffer (the ingest still hashes it)", async () => {
    const bytes = makePdf([["keep me"]]);
    const before = Buffer.from(bytes);
    await extractDocumentText("pdf", bytes);
    expect(bytes.equals(before)).toBe(true);
    expect(bytes.byteLength).toBe(before.byteLength);
  });

  it("Latin-1 text through WinAnsi decodes to the right characters", async () => {
    const r = await extractDocumentText("pdf", makePdf([["caf\xe9 na\xefve"]]));
    expect(r).toEqual({ ok: true, text: `${pg(1)}\ncafé naïve`, pages: 1 });
  });
});

describe("extractDocumentText — docx", () => {
  it("extracts paragraphs as lines and decodes entities", async () => {
    const r = await extractDocumentText(
      "docx",
      makeDocx(docxParagraphs(["Hello", "第二段 & <more>", 'quoted "x"'])),
    );
    expect(r).toEqual({
      ok: true,
      text: 'Hello\n第二段 & <more>\nquoted "x"',
    });
  });

  it("heading styles become the outline with the paragraph's line (2026-08-23): English ids, Chinese Word's bare numbers, Title, and an explicit outlineLvl", async () => {
    const body =
      docxHeading("Intro", { style: "Heading1" }) +
      docxParagraphs(["body one", "body two"]) +
      docxHeading("第二章", { style: "2" }) +
      docxHeading("Doc Title", { style: "Title" }) +
      // Body style with an explicit outline level wins over the style name.
      docxHeading("Forced", { style: "Normal", outlineLvl: 2 }) +
      // Not headings: TOC entries, a heading character style, body text.
      docxHeading("toc line", { style: "TOC1" }) +
      docxParagraphs(["plain"]);
    const r = await extractDocumentText("docx", makeDocx(body));
    if (!r.ok) throw new Error(r.reason);
    expect(r.text.split("\n")).toEqual([
      "Intro",
      "body one",
      "body two",
      "第二章",
      "Doc Title",
      "Forced",
      "toc line",
      "plain",
    ]);
    expect(r.outline).toEqual([
      { level: 1, title: "Intro", line: 1 },
      { level: 2, title: "第二章", line: 4 },
      { level: 1, title: "Doc Title", line: 5 },
      { level: 3, title: "Forced", line: 6 },
    ]);
  });

  it("a Word file without headings carries no outline; a break inside a paragraph still counts as a line", () => {
    const plain = walkWordprocessingXml(docxParagraphs(["a", "b"]));
    expect(plain.outline).toEqual([]);
    const xml =
      "<w:p><w:r><w:t>a</w:t><w:br/><w:t>b</w:t></w:r></w:p>" +
      docxHeading("H", { style: "Heading1" });
    expect(walkWordprocessingXml(xml).outline).toEqual([
      { level: 1, title: "H", line: 3 },
    ]);
  });

  it("an empty document is `empty`", async () => {
    expect(await extractDocumentText("docx", makeDocx(""))).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(
      await extractDocumentText("docx", makeDocx(docxParagraphs(["  ", ""]))),
    ).toEqual({ ok: false, reason: "empty" });
  });

  it("a zip without word/document.xml is `unsupported` (an .xlsx renamed .docx)", async () => {
    expect(await extractDocumentText("docx", makeNonWordZip())).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });

  it("a corrupt zip is `parse_error`", async () => {
    const broken = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(40, 0xff),
    ]);
    expect(await extractDocumentText("docx", broken)).toEqual({
      ok: false,
      reason: "parse_error",
    });
  });
});

describe("textOfWordprocessingXml — the walk", () => {
  it("emits tabs for w:tab and cell boundaries, newlines for w:br/w:cr, hyphen for w:noBreakHyphen", () => {
    const xml =
      "<w:p><w:r><w:t>a</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>" +
      "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>r1c1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>r1c2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
      "<w:p><w:r><w:t>non</w:t><w:noBreakHyphen/><w:t>breaking</w:t></w:r></w:p>";
    expect(textOfWordprocessingXml(xml)).toBe(
      "a\tb\nc\nr1c1\n\tr1c2\n\tnon-breaking",
    );
  });

  it("does not confuse w:t with w:tab/w:tbl/w:tc, nor w:p with w:pPr/w:pStyle", () => {
    const xml =
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Title </w:t></w:r></w:p>' +
      "<w:tbl><w:tblPr/><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>";
    expect(textOfWordprocessingXml(xml)).toBe("Title \ncell\n\t");
  });

  it("ignores field codes, tracked deletions and every non-w:t element", () => {
    const xml =
      "<w:p><w:r><w:instrText>PAGE</w:instrText></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:t>kept</w:t></w:r></w:p>";
    expect(textOfWordprocessingXml(xml)).toBe("kept");
  });

  it("decodes numeric references and refuses out-of-range code points", () => {
    const xml =
      "<w:p><w:r><w:t>&#x4E2D;&#25991;&amp;lt;&#x110000;</w:t></w:r></w:p>";
    expect(textOfWordprocessingXml(xml)).toBe("中文&lt;");
  });

  it("a self-closing w:t emits nothing and does not swallow what follows", () => {
    const xml = "<w:p><w:r><w:t/></w:r><w:r><w:t>after</w:t></w:r></w:p>";
    expect(textOfWordprocessingXml(xml)).toBe("after");
  });
});
