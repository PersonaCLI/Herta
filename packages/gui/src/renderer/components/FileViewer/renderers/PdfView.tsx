import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n/LocaleProvider.js";
import {
  boundQuoteText,
  type ComposerQuote,
} from "../../../lib/quote-format.js";
import type { ViewerAnchor } from "../file-viewer-context.js";
import { type MaskPiece, PieceMask, type PieceQuoting } from "../PieceQuote.js";
import {
  outlineTitleFor,
  type PdfBlock,
  type PdfPagePlace,
  type PdfPiece,
  type PdfTextItem,
  pdfBlocks,
  pdfPieces,
} from "../pdf-pieces.js";

/**
 * A PDF in the panel (ADR 0054 §4): pdf.js with its worker (the one CSP
 * directive this ADR opened), pages rendered to canvas at the panel's
 * width, lazily as they scroll into view, re-rendered when the width
 * changes. pdf.js 5+ compiles nothing with `new Function` (its v4
 * `isEvalSupported` switch is gone), so the packaged CSP's missing
 * unsafe-eval costs it nothing. The loading task, not the document, owns
 * teardown — `task.destroy()` on unmount cancels a load in flight and
 * releases a loaded document.
 *
 * Piece quoting (ADR 0078 amendment 2026-10-21): with the switch on, each
 * page's text is read as the page comes near the viewport and grouped into
 * paragraph blocks (`pdf-pieces.ts`); the mask lays them as bands over the
 * pages, and a quote carries the pages it came from (`unit: "page"`) and
 * the outline entry it falls under.
 */
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Pages rendered above this count are throttled to what is on screen;
 *  a placeholder of the right size stands in for the rest. */
const RENDER_MARGIN = "600px";

interface PageInfo {
  readonly index: number;
  readonly width: number;
  readonly height: number;
}

interface OutlineEntry {
  readonly page: number;
  readonly title: string;
}

/** A page's text as the grouping reads it: each item's baseline through
 *  the page's own viewport, so a cropped or rotated page lands right. */
async function readBlocks(
  doc: pdfjs.PDFDocumentProxy,
  index: number,
): Promise<PdfBlock[]> {
  const page = await doc.getPage(index);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: PdfTextItem[] = [];
  for (const it of content.items) {
    if (!("str" in it)) continue;
    const t = it.transform as number[];
    const [, base] = vp.convertToViewportPoint(t[4] ?? 0, t[5] ?? 0);
    items.push({
      str: it.str,
      base: base ?? 0,
      size: Math.hypot(t[2] ?? 0, t[3] ?? 0) || it.height,
      hasEOL: it.hasEOL,
    });
  }
  return pdfBlocks(items);
}

/** An outline destination's page, 1-based, or null when it names none. */
async function destPage(
  doc: pdfjs.PDFDocumentProxy,
  dest: unknown,
): Promise<number | null> {
  try {
    const explicit =
      typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return null;
    const ref: unknown = explicit[0];
    if (typeof ref === "number") return ref + 1;
    if (ref === null || typeof ref !== "object") return null;
    return (
      (await doc.getPageIndex(
        ref as Parameters<pdfjs.PDFDocumentProxy["getPageIndex"]>[0],
      )) + 1
    );
  } catch {
    return null;
  }
}

/** The outline flattened to where each entry starts, by page (the sort is
 *  stable, so entries on one page keep the outline's order). */
async function readOutline(
  doc: pdfjs.PDFDocumentProxy,
): Promise<OutlineEntry[]> {
  const out: OutlineEntry[] = [];
  type Node = { title: string; dest: unknown; items?: Node[] };
  const walk = async (nodes: readonly Node[] | null): Promise<void> => {
    for (const n of nodes ?? []) {
      const page = await destPage(doc, n.dest);
      const title = n.title.trim();
      if (page !== null && title.length > 0) out.push({ page, title });
      await walk(n.items ?? null);
    }
  };
  try {
    await walk((await doc.getOutline()) as unknown as Node[] | null);
  } catch {
    // No outline, or one pdf.js cannot read: quotes go without a title.
  }
  return out.sort((a, b) => a.page - b.page);
}

let pdfQuoteSeq = 0;

export function PdfView({
  bytes,
  piece,
  anchor,
}: {
  readonly bytes: Uint8Array;
  readonly piece?: PieceQuoting | undefined;
  /** A PDF quote's label opens its first page (`unit: "page"`). */
  readonly anchor?: ViewerAnchor | undefined;
}): JSX.Element {
  const t = useT();
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<readonly PageInfo[]>([]);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** Each page's blocks once read; a page in flight is not in it. */
  const blocks = useRef(new Map<number, PdfBlock[]>());
  const reading = useRef(new Set<number>());
  const outline = useRef<readonly OutlineEntry[]>([]);
  /** The bands the mask was last laid with: what each piece quotes. */
  const bands = useRef<readonly PdfPiece[]>([]);

  // Open the document once per bytes; page sizes come from the first page
  // (mixed-size documents refine per page when they render).
  useEffect(() => {
    let alive = true;
    setDoc(null);
    setPages([]);
    setFailed(false);
    blocks.current = new Map();
    reading.current = new Set();
    outline.current = [];
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      disableAutoFetch: true,
    });
    void task.promise.then(
      async (d) => {
        if (!alive) return;
        const infos: PageInfo[] = [];
        for (let i = 1; i <= d.numPages; i++) {
          // Sizes for every page: getPage is cheap (the content stream is
          // not parsed until render) and a mixed deck otherwise jumps.
          const p = await d.getPage(i);
          if (!alive) return;
          const vp = p.getViewport({ scale: 1 });
          infos.push({ index: i, width: vp.width, height: vp.height });
        }
        setDoc(d);
        setPages(infos);
        void readOutline(d).then((o) => {
          if (alive) outline.current = o;
        });
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
      void task.destroy();
    };
  }, [bytes]);

  // Fit-to-width: the scroller's inner width minus the page gutter.
  // clientWidth excludes the vertical scrollbar, which only appears once
  // the pages have their height — and a ResizeObserver does not fire for
  // it (the box itself did not change) — so re-measure when the pages land
  // too, or the first layout is 10px too wide and scrolls sideways.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const measure = (): void => setWidth(el.clientWidth);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && pages.length > 0) setWidth(el.clientWidth);
  }, [pages.length]);

  // A quote's label opened this PDF: its first page comes into view.
  useEffect(() => {
    if (anchor === undefined || pages.length === 0 || width === 0) return;
    hostRef.current
      ?.querySelector<HTMLElement>(`[data-page="${anchor.from}"]`)
      ?.scrollIntoView({ block: "start" });
  }, [anchor, pages.length, width]);

  /** Read a page's text once, as it comes near the viewport. */
  const readText = useCallback(
    (index: number): void => {
      if (doc === null) return;
      if (blocks.current.has(index) || reading.current.has(index)) return;
      reading.current.add(index);
      const map = blocks.current;
      void readBlocks(doc, index)
        .then(
          (b) => map.set(index, b),
          () => map.set(index, []),
        )
        .finally(() => reading.current.delete(index));
    },
    [doc],
  );
  const readOn = piece?.enabled === true ? readText : undefined;

  // The pieces: the bands over the pages near the viewport (a screen above
  // and below), from each page's blocks.
  const measurePieces = useCallback((): readonly MaskPiece[] => {
    const host = hostRef.current;
    const scroller = scrollRef.current;
    if (host === null || scroller === null) return [];
    const lo = scroller.scrollTop - scroller.clientHeight;
    const hi = scroller.scrollTop + scroller.clientHeight * 2;
    const all = Array.from(host.querySelectorAll<HTMLElement>("[data-page]"));
    const places: PdfPagePlace[] = [];
    let before: HTMLElement | undefined;
    let after: HTMLElement | undefined;
    for (const el of all) {
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (bottom < lo) {
        before = el;
        continue;
      }
      if (top > hi) {
        after ??= el;
        continue;
      }
      const page = Number(el.dataset.page);
      const info = pages[page - 1];
      if (info === undefined) continue;
      places.push({
        page,
        top,
        height: el.offsetHeight,
        scale: el.offsetWidth / info.width,
        blocks: blocks.current.get(page) ?? null,
      });
    }
    const first = places[0];
    const last = places[places.length - 1];
    if (first === undefined || last === undefined) return [];
    const top =
      before === undefined
        ? 0
        : (before.offsetTop + before.offsetHeight + first.top) / 2;
    const bottom =
      after === undefined
        ? host.offsetHeight
        : (last.top + last.height + after.offsetTop) / 2;
    const laid = pdfPieces(places, top, bottom);
    bands.current = laid;
    return laid.map((b, i) => ({
      top: b.top,
      height: b.height,
      from: i + 1,
      to: i + 1,
    }));
  }, [pages]);

  // One quote per run: its pages, its text in reading order, and the
  // outline entry its first page falls under. A page whose text was not
  // read yet is read now; a run with no text at all (a scan) quotes nothing.
  const quotePieces = useCallback(
    (runs: readonly (readonly MaskPiece[])[]): void => {
      if (piece === undefined || doc === null) return;
      const laid = bands.current;
      void (async () => {
        const quotes: ComposerQuote[] = [];
        for (const run of runs) {
          const parts: PdfPiece[] = run.flatMap((m) => {
            const b = laid[m.from - 1];
            return b === undefined ? [] : [b];
          });
          const texts: string[] = [];
          for (const b of parts) {
            let text = b.text;
            if (text === null) {
              const read =
                blocks.current.get(b.page) ??
                (await readBlocks(doc, b.page).catch(() => []));
              blocks.current.set(b.page, read);
              text = read.map((x) => x.text).join("\n\n");
            }
            if (text.trim().length > 0) texts.push(text);
          }
          const firstPart = parts[0];
          const lastPart = parts[parts.length - 1];
          if (
            texts.length === 0 ||
            firstPart === undefined ||
            lastPart === undefined
          )
            continue;
          const title = outlineTitleFor(outline.current, firstPart.page);
          pdfQuoteSeq += 1;
          quotes.push({
            id: `qp${Date.now().toString(36)}-${pdfQuoteSeq}`,
            path: piece.path,
            from: firstPart.page,
            to: lastPart.page,
            unit: "page",
            ...(title !== undefined ? { title } : {}),
            text: boundQuoteText(texts.join("\n\n"), piece.lang),
          });
        }
        if (quotes.length > 0) piece.onQuote(quotes);
        else piece.onNoText?.();
      })();
    },
    [piece, doc],
  );

  if (failed) {
    return (
      <div className="file-viewer__body">
        <p className="file-viewer__notice">{t("viewer.renderFailed")}</p>
      </div>
    );
  }
  const pageW = Math.max(120, width - 32);
  return (
    <div className="file-viewer__body">
      <div ref={scrollRef} className="file-viewer__scroll file-viewer__pdf">
        {doc === null ? (
          <p className="file-viewer__notice">{t("viewer.rendering")}</p>
        ) : (
          <div ref={hostRef} className="file-viewer__pdf-host">
            {pages.map((p) => (
              <PdfPage
                key={p.index}
                doc={doc}
                info={p}
                width={pageW}
                onNear={readOn}
              />
            ))}
            {piece !== undefined && (
              <PieceMask
                enabled={piece.enabled}
                hostRef={hostRef}
                scrollerRef={scrollRef}
                measure={measurePieces}
                onQuote={quotePieces}
                resetKey={doc}
              />
            )}
          </div>
        )}
      </div>
      {pages.length > 0 && (
        <p className="file-viewer__notice file-viewer__pdf-meta">
          {t("viewer.pdfPages", { n: pages.length })}
        </p>
      )}
    </div>
  );
}

function PdfPage({
  doc,
  info,
  width,
  onNear,
}: {
  readonly doc: pdfjs.PDFDocumentProxy;
  readonly info: PageInfo;
  readonly width: number;
  /** The page came near the viewport (piece quoting reads its text). */
  readonly onNear?: ((index: number) => void) | undefined;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const scale = width / info.width;
  const height = Math.round(info.height * scale);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setVisible(e.isIntersecting);
      },
      { rootMargin: RENDER_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (visible) onNear?.(info.index);
  }, [visible, onNear, info.index]);

  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let alive = true;
    let task: pdfjs.RenderTask | null = null;
    void doc.getPage(info.index).then(
      (page) => {
        if (!alive) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: scale * dpr });
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const ctx = canvas.getContext("2d");
        if (ctx === null) return;
        task = page.render({ canvas, canvasContext: ctx, viewport });
        task.promise.catch(() => undefined);
      },
      () => undefined,
    );
    return () => {
      alive = false;
      task?.cancel();
    };
  }, [visible, doc, info.index, scale, width, height]);

  return (
    <div
      ref={ref}
      className="file-viewer__pdf-page"
      style={{ width, height }}
      data-page={info.index}
    >
      {visible && <canvas ref={canvasRef} />}
    </div>
  );
}
