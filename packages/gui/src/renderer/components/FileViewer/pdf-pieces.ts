/**
 * A PDF page's pieces (ADR 0078 amendment 2026-10-21): its text lines, as
 * pdf.js reads them, grouped into paragraph-sized blocks; then every page's
 * blocks laid out as the mask's bands over the rendered pages. Pure: the
 * view hands in what pdf.js gave and where its pages sit.
 */

/** A pdf.js text item as the grouping reads it: its string, its baseline
 *  in page units down from the page's top edge (the view converts it
 *  through the page's viewport, so offsets and rotation are pdf.js's), its
 *  type size, and whether a line ends after it. */
export interface PdfTextItem {
  readonly str: string;
  readonly base: number;
  readonly size: number;
  readonly hasEOL?: boolean;
}

/** A block on its page, in page units measured down from the page's top
 *  edge (scale 1). */
export interface PdfBlock {
  readonly top: number;
  readonly bottom: number;
  readonly text: string;
}

interface Line {
  base: number;
  top: number;
  bottom: number;
  size: number;
  text: string;
}

/** The page's text as lines, in the content stream's order. Items whose
 *  baselines sit within half a glyph of each other are one line. */
function linesOf(items: readonly PdfTextItem[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const it of items) {
    const size = it.size > 0 ? it.size : 10;
    const base = it.base;
    if (it.str.length > 0) {
      if (cur !== null && Math.abs(base - cur.base) <= size * 0.5) {
        cur.text += it.str;
        cur.top = Math.min(cur.top, base - size);
        cur.bottom = Math.max(cur.bottom, base + size * 0.25);
        cur.size = Math.max(cur.size, size);
      } else {
        if (cur !== null) lines.push(cur);
        cur = {
          base,
          top: base - size,
          bottom: base + size * 0.25,
          size,
          text: it.str,
        };
      }
    }
    if (it.hasEOL === true && cur !== null) {
      lines.push(cur);
      cur = null;
    }
  }
  if (cur !== null) lines.push(cur);
  return lines.filter((l) => l.text.trim().length > 0);
}

/**
 * The page's text as paragraph-sized blocks, top to bottom, never
 * overlapping. The lines are taken top to bottom; a new block starts where
 * the gap above a line is wider than most of a line, or where the type size
 * changes (a heading). The mask cuts the page across, so columns side by
 * side share their bands: a block's text is every line whose middle falls
 * inside it, in the content's own order — the first column, then the next.
 */
export function pdfBlocks(items: readonly PdfTextItem[]): PdfBlock[] {
  const lines = linesOf(items);
  if (lines.length === 0) return [];
  const sorted = [...lines].sort((a, b) => a.top - b.top);
  const spans: Array<{ top: number; bottom: number }> = [];
  let prev: Line | null = null;
  for (const l of sorted) {
    const cur = spans[spans.length - 1];
    if (
      cur === undefined ||
      prev === null ||
      l.top - cur.bottom > prev.size * 0.6 ||
      Math.abs(l.size - prev.size) > prev.size * 0.2
    ) {
      spans.push({ top: l.top, bottom: l.bottom });
    } else {
      cur.bottom = Math.max(cur.bottom, l.bottom);
    }
    prev = l;
  }
  return spans.map((sp) => ({
    top: sp.top,
    bottom: sp.bottom,
    text: lines
      .filter((l) => {
        const mid = (l.top + l.bottom) / 2;
        return mid >= sp.top && mid <= sp.bottom;
      })
      .map((l) => l.text.trim())
      .join("\n"),
  }));
}

/** A rendered page as the mask sees it: where it sits on the host (px),
 *  its scale (px per page unit), and its blocks — null while its text is
 *  not read yet. */
export interface PdfPagePlace {
  readonly page: number;
  readonly top: number;
  readonly height: number;
  readonly scale: number;
  readonly blocks: readonly PdfBlock[] | null;
}

/** One band of the mask over a PDF. `text` null: the page's text is not
 *  read yet (it is read before quoting). */
export interface PdfPiece {
  readonly top: number;
  readonly height: number;
  readonly page: number;
  readonly text: string | null;
}

/** A band thinner than this joins its neighbour: a page number alone is a
 *  sliver no pointer can take. */
const MIN_BAND_PX = 12;

/**
 * The mask's bands over a run of consecutive pages, top to bottom, covering
 * `[top, bottom)` of the host whole: each page is cut at the middle of the
 * gaps around it, and inside a page at the middle between its blocks. A
 * page with no text — a scan — or one not yet read is one band. The view
 * passes the pages near the viewport only, so a long document never lays
 * thousands of pieces (the mask fades on any scroll anyway).
 */
export function pdfPieces(
  pages: readonly PdfPagePlace[],
  top: number,
  bottom: number,
): PdfPiece[] {
  const out: PdfPiece[] = [];
  pages.forEach((p, i) => {
    const prev = pages[i - 1];
    const next = pages[i + 1];
    const start =
      prev === undefined ? top : (prev.top + prev.height + p.top) / 2;
    const end = next === undefined ? bottom : (p.top + p.height + next.top) / 2;
    const blocks = p.blocks;
    if (blocks === null || blocks.length === 0) {
      out.push({
        top: start,
        height: Math.max(0, end - start),
        page: p.page,
        text: blocks === null ? null : "",
      });
      return;
    }
    // Each block's cut is the middle between it and the next.
    const spans: Array<{ top: number; bottom: number; text: string }> = [];
    for (const b of blocks) {
      const top = p.top + b.top * p.scale;
      const bottom = p.top + b.bottom * p.scale;
      const last = spans[spans.length - 1];
      if (last !== undefined && bottom - top < MIN_BAND_PX) {
        last.bottom = Math.max(last.bottom, bottom);
        last.text = `${last.text}\n${b.text}`;
        continue;
      }
      spans.push({ top, bottom, text: b.text });
    }
    // A sliver at the top folds into the block under it.
    const first = spans[0];
    const second = spans[1];
    if (
      first !== undefined &&
      second !== undefined &&
      first.bottom - first.top < MIN_BAND_PX
    ) {
      second.top = first.top;
      second.text = `${first.text}\n${second.text}`;
      spans.shift();
    }
    let at = start;
    spans.forEach((s, k) => {
      const after = spans[k + 1];
      const to = after === undefined ? end : (s.bottom + after.top) / 2;
      out.push({
        top: at,
        height: Math.max(0, to - at),
        page: p.page,
        text: s.text,
      });
      at = to;
    });
  });
  return out;
}

/** The outline entry a page falls under: the last one, in the outline's
 *  order, that starts on or before it. */
export function outlineTitleFor(
  outline: readonly { readonly page: number; readonly title: string }[],
  page: number,
): string | undefined {
  let found: string | undefined;
  for (const o of outline) if (o.page <= page) found = o.title;
  return found;
}
