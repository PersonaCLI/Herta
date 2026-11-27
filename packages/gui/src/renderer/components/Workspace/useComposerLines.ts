/**
 * How many lines the composer shows for its draft, and how tall a line is
 * (owner 2026-11-03). Split out of Composer.tsx (review 2026-11-10, moved
 * 2026-11-27): the composer calls the hook where these lines were, so its
 * three effects run in the same place among the composer's own.
 */
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** The lines of a draft the composer shows before it scrolls (owner
 *  2026-11-03: "can not expand height when input multiple lines content"):
 *  two at rest — the textarea's own `rows` — growing a line at a time to
 *  eight. */
export const COMPOSER_MIN_LINES = 2;
export const COMPOSER_MAX_LINES = 8;

/** The lines the composer shows for a draft `contentPx` tall as wrapped. */
export function composerLines(contentPx: number, linePx: number): number {
  const lines = Math.round(contentPx / linePx);
  return Math.min(COMPOSER_MAX_LINES, Math.max(COMPOSER_MIN_LINES, lines));
}

/**
 * The input's line — 15px type at about 1.5 — as a whole number of device
 * pixels (owner 2026-11-03: as the composer grew or shrank, every other
 * line shook). At 22.5px a line on a 1x screen starts half a pixel off the
 * one above it; while the box's edge glides, odd and even lines snap to the
 * pixel grid at different moments. A line a whole number of device pixels
 * tall keeps every line on the same fraction, so they move as one.
 */
export function composerLinePx(dpr: number): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.round(22.5 * d) / d;
}

/** The draft's lines for the composer's height, from an unseen copy of
 *  the draft (`measureRef`), and the line's height in pixels. */
export function useComposerLines(text: string): {
  readonly measureRef: MutableRefObject<HTMLDivElement | null>;
  readonly inputLines: number;
  readonly linePx: number;
} {
  // The draft's lines, read from an unseen copy laid out at the textarea's
  // wrap width (`.composer-measure`): the textarea's own scrollHeight never
  // reports less than its box, so a shortened draft could not shrink it.
  // Every height of the composer, and the textarea's, grows by the lines
  // past two (`--composer-extra-lines`, reference-ux.css).
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [inputLines, setInputLines] = useState(COMPOSER_MIN_LINES);
  // The line follows the screen's pixel ratio: a window moved to another
  // display, or a zoom, changes it (`--composer-line`).
  const [linePx, setLinePx] = useState(() =>
    composerLinePx(window.devicePixelRatio),
  );
  useEffect(() => {
    let query: MediaQueryList | null = null;
    const watch = (): void => {
      setLinePx(composerLinePx(window.devicePixelRatio));
      query?.removeEventListener("change", watch);
      query =
        window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`) ??
        null;
      query?.addEventListener("change", watch);
    };
    watch();
    return () => query?.removeEventListener("change", watch);
  }, []);
  const measureLines = useCallback(() => {
    const el = measureRef.current;
    if (el === null) return;
    const line = Number.parseFloat(getComputedStyle(el).lineHeight) || linePx;
    setInputLines(composerLines(el.offsetHeight, line));
  }, [linePx]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is the re-measure trigger (the copy re-renders with it), not an input
  useLayoutEffect(() => {
    measureLines();
  }, [text, measureLines]);
  // A narrower window wraps the same draft onto more lines.
  useEffect(() => {
    const el = measureRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureLines());
    observer.observe(el);
    return () => observer.disconnect();
  }, [measureLines]);
  return { measureRef, inputLines, linePx };
}
