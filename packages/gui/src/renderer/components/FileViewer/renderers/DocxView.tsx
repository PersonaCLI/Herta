import { renderAsync } from "docx-preview";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n/LocaleProvider.js";
import {
  boundQuoteText,
  type ComposerQuote,
} from "../../../lib/quote-format.js";
import {
  type DocxStyle,
  docxBlocks,
  docxSections,
  headingStyleClasses,
} from "../docx-pieces.js";
import type { ViewerAnchor } from "../file-viewer-context.js";
import { type MaskPiece, PieceMask, type PieceQuoting } from "../PieceQuote.js";

let docxQuoteSeq = 0;

/**
 * A Word document in the panel (ADR 0054 §4): docx-preview renders the
 * package into the container as flowing pages — styles, numbering,
 * tables, embedded pictures (base64 URLs, so nothing leaves the sandbox),
 * headers and footers. `ignoreWidth` because a fixed Letter/A4 page is
 * wider than the panel; the page keeps its margins and flows at the
 * panel's width instead. Links are inert (the scroller swallows clicks on
 * anchors); `will-navigate` remains the backstop.
 *
 * Piece quoting (ADR 0078 amendment 2026-10-29): with the switch on, the
 * mask cuts the page into sections (`docx-pieces.ts`), and a quote counts
 * the paragraphs it came from (`unit: "para"`), titled by its heading.
 */
export function DocxView({
  bytes,
  piece,
  anchor,
}: {
  readonly bytes: Uint8Array;
  readonly piece?: PieceQuoting | undefined;
  /** A Word quote's label opens its first paragraph (`unit: "para"`). */
  readonly anchor?: ViewerAnchor | undefined;
}): JSX.Element {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"rendering" | "done" | "failed">(
    "rendering",
  );
  /** The heading styles' classes, from the document's own styles. */
  const headings = useRef<ReadonlySet<string>>(new Set());
  /** The numbered blocks, read once per render at the first need. */
  const blocks = useRef<ReturnType<typeof docxBlocks> | null>(null);
  /** Renders finished: the anchor is applied to each new one. */
  const [rendered, setRendered] = useState(0);

  useEffect(() => {
    const body = bodyRef.current;
    const styles = styleRef.current;
    if (body === null || styles === null) return;
    let alive = true;
    setState("rendering");
    headings.current = new Set();
    blocks.current = null;
    body.replaceChildren();
    styles.replaceChildren();
    renderAsync(bytes, body, styles, {
      className: "docx",
      inWrapper: true,
      ignoreWidth: true,
      ignoreHeight: true,
      ignoreFonts: false,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      useBase64URL: true,
      renderChanges: false,
      trimXmlDeclaration: true,
    }).then(
      (doc: unknown) => {
        if (!alive) return;
        const parsed = (doc as { stylesPart?: { styles?: DocxStyle[] } })
          ?.stylesPart?.styles;
        headings.current = headingStyleClasses(parsed ?? []);
        blocks.current = null;
        setRendered((n) => n + 1);
        setState("done");
      },
      () => {
        if (alive) setState("failed");
      },
    );
    return () => {
      alive = false;
    };
  }, [bytes]);

  const blocksNow = useCallback((): ReturnType<typeof docxBlocks> => {
    const body = bodyRef.current;
    if (body === null) return [];
    blocks.current ??= docxBlocks(body, headings.current);
    return blocks.current;
  }, []);

  // A quote's label opened this document: its first paragraph comes into
  // view, once per anchor and render. Not once per anchor alone, as the PDF
  // does (ADR 0078 amendment 2026-10-22): a label's new target makes the
  // panel read the file again, and docx-preview draws the page anew, so the
  // scroll taken on the old page was lost with it and the document opened
  // at the top (seen in the dev app, 2026-10-29). Nothing but a new read
  // renders again, so a resize still never pulls the reader back.
  const anchored = useRef<{ anchor: ViewerAnchor; render: number } | null>(
    null,
  );
  useEffect(() => {
    if (anchor === undefined || state !== "done") return;
    const at = anchored.current;
    if (at !== null && at.anchor === anchor && at.render === rendered) return;
    const block = blocksNow()[anchor.from - 1];
    if (block === undefined) return;
    anchored.current = { anchor, render: rendered };
    block.el.scrollIntoView({ block: "start" });
  }, [anchor, state, rendered, blocksNow]);

  // The pieces: each section laid from its first block, its seam halfway
  // through the gap before it.
  const measurePieces = useCallback((): readonly MaskPiece[] => {
    const host = hostRef.current;
    if (host === null) return [];
    const all = blocksNow();
    const sections = docxSections(all);
    if (sections.length === 0) return [];
    const box = host.getBoundingClientRect();
    const tops = sections.map((s, k) => {
      if (k === 0) return 0;
      const prev = all[s.from - 2]?.el.getBoundingClientRect();
      const here = all[s.from - 1]?.el.getBoundingClientRect();
      if (prev === undefined || here === undefined) return 0;
      return (prev.bottom + here.top) / 2 - box.top;
    });
    return sections.map((s, k) => {
      const top = tops[k] ?? 0;
      const bottom = tops[k + 1] ?? box.height;
      return {
        top,
        height: Math.max(0, bottom - top),
        from: s.from,
        to: s.to,
        ...(s.title !== undefined ? { title: s.title } : {}),
      };
    });
  }, [blocksNow]);

  // One quote per run: its paragraphs' text, a blank line apart, titled by
  // the heading its first section opens with.
  const quotePieces = useCallback(
    (runs: readonly (readonly MaskPiece[])[]): void => {
      if (piece === undefined) return;
      const all = blocksNow();
      const quotes: ComposerQuote[] = runs.flatMap((run) => {
        const first = run[0];
        const last = run[run.length - 1];
        if (first === undefined || last === undefined) return [];
        const text = all
          .slice(first.from - 1, last.to)
          .map((b) => b.text)
          .join("\n\n");
        if (text.trim().length === 0) return [];
        docxQuoteSeq += 1;
        return [
          {
            id: `qd${Date.now().toString(36)}-${docxQuoteSeq}`,
            path: piece.path,
            from: first.from,
            to: last.to,
            unit: "para" as const,
            ...(first.title !== undefined ? { title: first.title } : {}),
            text: boundQuoteText(text, piece.lang),
          },
        ];
      });
      if (quotes.length > 0) piece.onQuote(quotes);
      else piece.onNoText?.();
    },
    [piece, blocksNow],
  );

  return (
    <div className="file-viewer__body">
      <div
        ref={scrollRef}
        className="file-viewer__scroll file-viewer__docx"
        onClickCapture={(e) => {
          if ((e.target as Element).closest("a") !== null) e.preventDefault();
        }}
      >
        {state === "rendering" && (
          <p className="file-viewer__notice">{t("viewer.rendering")}</p>
        )}
        {state === "failed" && (
          <p className="file-viewer__notice">{t("viewer.renderFailed")}</p>
        )}
        <div ref={styleRef} hidden={state === "failed"} />
        <div ref={hostRef} className="file-viewer__doc-host">
          <div ref={bodyRef} hidden={state === "failed"} />
          {piece !== undefined && state === "done" && (
            <PieceMask
              enabled={piece.enabled}
              hostRef={hostRef}
              scrollerRef={scrollRef}
              measure={measurePieces}
              onQuote={quotePieces}
              resetKey={bytes}
            />
          )}
        </div>
      </div>
    </div>
  );
}
