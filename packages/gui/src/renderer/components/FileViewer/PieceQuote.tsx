import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useT } from "../../i18n/LocaleProvider.js";
import { OVERLAY_Z, topOverlayZ } from "../../lib/overlay-stack.js";
import { boundQuoteText, type ComposerQuote } from "../../lib/quote-format.js";

/**
 * Piece quoting (ADR 0078): with the switch on, a pointer resting on the
 * page lays a mask over it, cut into the document's own pieces; the
 * Trailblazer picks pieces and quotes them into the composer. The page
 * itself never moves.
 */

/** Locked by the owner's tuner (ADR 0078, 2026-10-13). */
export const PIECE_REST_MS = 1_200;

/** `.piece-mask`'s opacity transition: a hidden mask lets its pieces go
 *  after it. */
export const MASK_FADE_MS = 280;

const STORE_KEY = "herta.viewer.pieceQuote";

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORE_KEY) !== "0";
  } catch {
    return true;
  }
}

/** The header switch: on by default, remembered across launches (the
 *  sidebar's and the viewer width's own storage). */
export function usePieceQuoting(): readonly [boolean, () => void] {
  const [enabled, setEnabled] = useState<boolean>(readEnabled);
  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORE_KEY, next ? "1" : "0");
      } catch {
        // storage can be unavailable; the switch still works this session
      }
      return next;
    });
  }, []);
  return [enabled, toggle];
}

/** Icon B (抽出一块): the middle band pulled out while on, slid back into
 *  line while off — the CSS moves it (`.piece-quote-icon.is-off`). */
export function PieceQuoteIcon({ on }: { readonly on: boolean }): JSX.Element {
  return (
    <svg
      className={`piece-quote-icon${on ? "" : " is-off"}`}
      width="13"
      height="13"
      viewBox="0 0 13 13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.5" y="1.5" width="8" height="3" rx="1" />
      <rect
        className="piece-quote-icon__mid"
        x="3.5"
        y="5"
        width="8"
        height="3"
        rx="1"
      />
      <rect x="1.5" y="8.5" width="8" height="3" rx="1" />
    </svg>
  );
}

/** What a view needs to offer piece quoting: the switch, the file's
 *  workspace-relative path, the session's language, and where quotes go. */
export interface PieceQuoting {
  readonly enabled: boolean;
  readonly path: string;
  readonly lang: "zh" | "en";
  readonly onQuote: (quotes: readonly ComposerQuote[]) => void;
  /** The picked pieces held no text to quote — a scanned PDF's pages
   *  (ADR 0078 amendment 2026-10-21): say so, never do nothing. */
  readonly onNoText?: () => void;
}

/** One piece of the mask: where it lies on the host, and what it quotes. */
export interface MaskPiece {
  readonly top: number;
  readonly height: number;
  readonly from: number;
  readonly to: number;
  readonly title?: string;
}

/** Selected indices as contiguous runs, in page order. */
export function runsOf(selected: ReadonlySet<number>): number[][] {
  const sorted = [...selected].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const i of sorted) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last[last.length - 1] === i - 1) last.push(i);
    else runs.push([i]);
  }
  return runs;
}

/**
 * The mask. Lives inside the host (a positioned box that scrolls with the
 * content) and covers it whole. Shown after the pointer rests still on the
 * host for `PIECE_REST_MS`; a held button or a live text selection keeps it
 * away. Leaving, scrolling or Escape fades it unless pieces are picked.
 */
export function PieceMask({
  enabled,
  hostRef,
  scrollerRef,
  measure,
  onQuote,
  resetKey,
}: {
  readonly enabled: boolean;
  readonly hostRef: RefObject<HTMLElement | null>;
  readonly scrollerRef: RefObject<HTMLElement | null>;
  /** The pieces as laid out now — measured when the mask appears. */
  readonly measure: () => readonly MaskPiece[];
  /** Each contiguous run of picked pieces, in page order. */
  readonly onQuote: (runs: readonly (readonly MaskPiece[])[]) => void;
  /** The content's identity: a new file clears the mask. */
  readonly resetKey: unknown;
}): JSX.Element | null {
  const t = useT();
  const [shown, setShown] = useState(false);
  const [pieces, setPieces] = useState<readonly MaskPiece[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [pillAt, setPillAt] = useState<{ top: number; left: number } | null>(
    null,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<{
    start: number;
    base: ReadonlySet<number>;
    add: boolean;
  } | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const release = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = useCallback((force: boolean) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (!force && selectedRef.current.size > 0) return;
    setSelected(new Set());
    setShown(false);
    // A hidden mask kept every piece mounted — thousands of boxes on a long
    // file, under every later render (release review 2026-10-13). They go
    // once the fade is over; the next rest measures them again.
    if (release.current !== null) clearTimeout(release.current);
    release.current = setTimeout(() => {
      release.current = null;
      setPieces([]);
    }, MASK_FADE_MS);
  }, []);
  useEffect(
    () => () => {
      if (release.current !== null) clearTimeout(release.current);
    },
    [],
  );

  // A new file, or the switch turned off: nothing stays.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the trigger
  useEffect(() => {
    hide(true);
  }, [resetKey, enabled, hide]);

  // The rest that shows the mask.
  useEffect(() => {
    const host = hostRef.current;
    const scroller = scrollerRef.current;
    if (!enabled || host === null) return undefined;
    const onMove = (e: PointerEvent): void => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      if (shownRef.current || (e.buttons ?? 0) !== 0) return;
      const sel = window.getSelection();
      if (sel !== null && !sel.isCollapsed && host.contains(sel.anchorNode))
        return;
      timer.current = setTimeout(() => {
        timer.current = null;
        if (release.current !== null) clearTimeout(release.current);
        release.current = null;
        setPieces(measure());
        setShown(true);
      }, PIECE_REST_MS);
    };
    const onLeave = (): void => hide(false);
    const onScroll = (): void => {
      if (shownRef.current) hide(false);
      else if (timer.current !== null) clearTimeout(timer.current);
    };
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      scroller?.removeEventListener("scroll", onScroll);
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [enabled, hostRef, scrollerRef, measure, hide]);

  // Escape clears and fades — and only that (ADR 0082 §11). In the capture
  // phase, ahead of the viewer's own Escape (which would close the viewer
  // too), and marked so neither the viewer nor the run's stop takes it. Not
  // under a dialog that owns the keyboard (Settings, the cheat sheet…).
  useEffect(() => {
    if (!shown) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const z = topOverlayZ();
      if (z !== null && z > OVERLAY_Z.approval) return;
      e.preventDefault();
      hide(true);
    };
    const onUp = (): void => {
      drag.current = null;
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("pointerup", onUp);
    };
  }, [shown, hide]);

  // The pill rides under the last picked piece, at the visible right edge.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const last = Math.max(-1, ...selected);
    const piece = pieces[last];
    if (selected.size === 0 || piece === undefined || scroller === null) {
      setPillAt(null);
      return;
    }
    const host = hostRef.current;
    const maxTop = (host?.offsetHeight ?? 0) - 36;
    setPillAt({
      top: Math.max(0, Math.min(piece.top + piece.height - 6, maxTop)),
      left: scroller.scrollLeft + scroller.clientWidth - 12,
    });
  }, [selected, pieces, hostRef, scrollerRef]);

  const apply = (i: number): void => {
    const d = drag.current;
    if (d === null) return;
    const next = new Set(d.base);
    for (let k = Math.min(d.start, i); k <= Math.max(d.start, i); k++) {
      if (d.add) next.add(k);
      else next.delete(k);
    }
    setSelected(next);
  };

  if (!enabled) return null;
  return (
    <div
      className={`piece-mask${shown ? " is-shown" : ""}`}
      aria-hidden={!shown}
      data-testid="piece-mask"
    >
      {pieces.map((p, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: pieces are positional
          key={i}
          className={`piece-mask__piece${selected.has(i) ? " is-selected" : ""}`}
          style={{
            top: p.top + (i > 0 ? 1 : 0),
            height: Math.max(
              0,
              p.height - (i > 0 ? 1 : 0) - (i < pieces.length - 1 ? 1 : 0),
            ),
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            drag.current = {
              start: i,
              base: new Set(selected),
              add: !selected.has(i),
            };
            apply(i);
          }}
          onPointerEnter={() => apply(i)}
        />
      ))}
      {pillAt !== null && (
        <div
          className="piece-mask__pill"
          style={{ top: pillAt.top, left: pillAt.left }}
        >
          <span className="piece-mask__count">
            {t("viewer.piece.selected", { n: selected.size })}
          </span>
          <button
            type="button"
            className="piece-mask__quote"
            onClick={() => {
              onQuote(
                runsOf(selected).map((run) =>
                  run.flatMap((i) =>
                    pieces[i] !== undefined ? [pieces[i]] : [],
                  ),
                ),
              );
              hide(true);
            }}
          >
            {t("viewer.piece.quote")}
          </button>
          <button
            type="button"
            className="piece-mask__clear"
            aria-label={t("viewer.piece.clear")}
            onClick={() => hide(true)}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 13 13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M3 3l7 7M10 3l-7 7" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

let quoteSeq = 0;

/**
 * The quotes a set of picked runs makes (ADR 0078 §4): one per run, its
 * lines from the source as the file has them — trailing blank lines off the
 * end, the whole held to the quote bounds.
 */
export function quotesFromRuns(
  runs: readonly (readonly MaskPiece[])[],
  lines: readonly string[],
  path: string,
  lang: "zh" | "en",
  fence?: string,
): ComposerQuote[] {
  return runs.flatMap((run) => {
    const first = run[0];
    const last = run[run.length - 1];
    if (first === undefined || last === undefined) return [];
    const from = first.from;
    let to = Math.min(last.to, lines.length);
    while (to > from && (lines[to - 1] ?? "").trim().length === 0) to -= 1;
    quoteSeq += 1;
    return [
      {
        id: `q${Date.now().toString(36)}-${quoteSeq}`,
        path,
        from,
        to,
        ...(first.title !== undefined ? { title: first.title } : {}),
        text: boundQuoteText(lines.slice(from - 1, to).join("\n"), lang),
        ...(fence !== undefined ? { fence } : {}),
      },
    ];
  });
}
