/**
 * A Word document's pieces (ADR 0078 amendment 2026-10-29): sections, and
 * the paragraph numbers a quote's label counts.
 *
 * docx-preview draws every paragraph as a `<p>`, a heading too, with its
 * style as a class (`docx_heading1`; a Chinese template's `docx_1`). Which
 * styles are headings comes from the document's own styles, as docx-preview
 * parsed them. Pure, but for the DOM reads in `docxBlocks`.
 */

/** A style as docx-preview's parse returns it (`stylesPart.styles`). */
export interface DocxStyle {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly basedOn?: string | null;
  readonly target?: string | null;
  readonly paragraphProps?: { readonly outlineLevel?: number } | null;
}

/** docx-preview's own class spelling of a style id (`escapeClassName`). */
function styleClass(id: string, className: string): string {
  const escaped = id
    .replace(/[ .]+/g, "-")
    .replace(/[&]+/g, "and")
    .toLowerCase();
  return `${className}_${escaped}`;
}

/**
 * The classes of the paragraph styles that are headings: an outline level
 * of 0–8, the style's own or inherited through `basedOn`, or a built-in
 * heading's name (`heading 1`–`heading 9`, `Title`). styles.xml keeps the
 * English built-in names whatever language Word runs in.
 */
export function headingStyleClasses(
  styles: readonly DocxStyle[],
  className = "docx",
): Set<string> {
  const byId = new Map<string, DocxStyle>();
  for (const s of styles) if (s.id != null) byId.set(s.id, s);
  const levelOf = (s: DocxStyle): number | undefined => {
    let at: DocxStyle | undefined = s;
    for (let depth = 0; at !== undefined && depth < 10; depth += 1) {
      const level = at.paragraphProps?.outlineLevel;
      if (level !== undefined) return level;
      at = at.basedOn != null ? byId.get(at.basedOn) : undefined;
    }
    return undefined;
  };
  const out = new Set<string>();
  for (const s of styles) {
    if (s.id == null || s.target !== "p") continue;
    const level = levelOf(s);
    const named = /^(heading [1-9]|title)$/i.test(s.name ?? "");
    if ((level !== undefined && level >= 0 && level <= 8) || named) {
      out.add(styleClass(s.id, className));
    }
  }
  return out;
}

/** One numbered block of the page: a paragraph or a table with text. */
export interface DocxBlock {
  readonly text: string;
  readonly heading: boolean;
}

/** A piece: the paragraph numbers it covers, and its heading. */
export interface DocxSection {
  readonly from: number;
  readonly to: number;
  readonly title?: string;
}

/** A heading as a label's title: one line, bounded. */
function titleOf(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 120 ? `${one.slice(0, 119)}…` : one;
}

/**
 * The pieces (the owner's 大块, 2026-10-29): a section starts at each
 * heading and runs to the next. A heading with nothing of its own before
 * the next heading joins it, so `2 研究方法` stays with `2.1 数据` and no
 * piece is a heading alone. What comes before the first heading is a piece
 * of its own. A document with no heading styles — letters and contracts
 * often bold their headings instead — falls back to one piece per block,
 * never one piece for the whole document. Blocks are numbered from 1.
 */
export function docxSections(blocks: readonly DocxBlock[]): DocxSection[] {
  if (blocks.length === 0) return [];
  if (!blocks.some((b) => b.heading)) {
    return blocks.map((_, i) => ({ from: i + 1, to: i + 1 }));
  }
  const starts: number[] = [];
  blocks.forEach((b, i) => {
    if (i === 0) starts.push(0);
    else if (b.heading && blocks[i - 1]?.heading !== true) starts.push(i);
  });
  return starts.map((start, k) => {
    const end = (starts[k + 1] ?? blocks.length) - 1;
    const first = blocks[start];
    return {
      from: start + 1,
      to: end + 1,
      ...(first?.heading === true ? { title: titleOf(first.text) } : {}),
    };
  });
}

/** A run's text: tabs (docx-preview's em spaces) as tabs, line breaks as
 *  new lines. */
function inlineText(node: Node): string {
  if (node.nodeType === 3) return (node.nodeValue ?? "").replace(/ /g, "\t");
  if (node.nodeType !== 1) return "";
  if ((node as Element).tagName === "BR") return "\n";
  return Array.from(node.childNodes).map(inlineText).join("");
}

/** A block's text as a quote carries it: a paragraph's runs; a table a row
 *  per line, its cells apart by tabs. */
export function docxBlockText(el: Element): string {
  if (el.tagName === "TABLE") {
    const rows = Array.from((el as HTMLTableElement).rows ?? []);
    return rows
      .map((row) =>
        Array.from(row.cells)
          .map((cell) =>
            Array.from(cell.children)
              .map((c) => inlineText(c).replace(/\s+/g, " ").trim())
              .filter((t) => t.length > 0)
              .join(" "),
          )
          .join("\t"),
      )
      .join("\n")
      .trim();
  }
  return inlineText(el)
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * The page's numbered blocks, in order: each paragraph or table directly in
 * a page's body (`section.docx > article`) that holds text. Headers,
 * footers and notes sit outside the body and are not pieces; an empty
 * paragraph (Word's spacing) or a picture alone is not numbered.
 */
export function docxBlocks(
  root: Element,
  headingClasses: ReadonlySet<string>,
): (DocxBlock & { readonly el: HTMLElement })[] {
  const out: (DocxBlock & { readonly el: HTMLElement })[] = [];
  for (const article of Array.from(
    root.querySelectorAll("section.docx > article"),
  )) {
    for (const el of Array.from(article.children) as HTMLElement[]) {
      const text = docxBlockText(el);
      if (text.replace(/[\s  ]/g, "").length === 0) continue;
      const heading =
        el.tagName === "P" &&
        Array.from(el.classList).some((c) => headingClasses.has(c));
      out.push({ el, text, heading });
    }
  }
  return out;
}
