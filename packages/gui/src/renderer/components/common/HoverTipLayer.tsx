import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { getHoverTip, subscribeHoverTip } from "./hover-tip.js";

/** Room between the anchor and the tip, and from the viewport's edges. */
const GAP = 8;
const EDGE = 8;
const MAX_WIDTH = 360;

/** Where a tip `width` wide sits over an anchor centred at `centre`: centred
 *  on it, clamped inside the viewport. */
export function tipLeft(
  centre: number,
  width: number,
  viewport: number,
): number {
  return Math.max(EDGE, Math.min(viewport - EDGE - width, centre - width / 2));
}

/**
 * Mount once at the app root. Renders the current hover tip in a fixed box
 * above its anchor — below when the anchor sits too near the top — clamped
 * to the viewport's width. The text is the tip's whole content.
 *
 * The box fits its text, up to MAX_WIDTH (2026-10-08). It was always
 * MAX_WIDTH wide, made for commit subjects; once a status letter's meaning
 * (已修改) and the ↑↓ counts' wording took the app's tip instead of the OS's,
 * three characters sat in a 360px box reaching over the conversation. The
 * box's real width is read before paint and the box re-centred on it.
 */
export function HoverTipLayer(): JSX.Element | null {
  const tip = useSyncExternalStore(subscribeHoverTip, getHoverTip, () => null);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || tip === null) return;
    const centre = tip.anchor.left + tip.anchor.width / 2;
    el.style.left = `${tipLeft(centre, el.offsetWidth, window.innerWidth)}px`;
  }, [tip]);
  if (tip === null) return null;
  const { anchor } = tip;
  const maxWidth = Math.min(MAX_WIDTH, window.innerWidth - 2 * EDGE);
  // Placed for the widest box first; the layout effect re-centres it on the
  // width it actually has before anything is painted.
  const left = tipLeft(
    anchor.left + anchor.width / 2,
    maxWidth,
    window.innerWidth,
  );
  const below = anchor.top < 72;
  const style: React.CSSProperties = below
    ? { left, top: anchor.top + anchor.height + GAP, maxWidth }
    : { left, bottom: window.innerHeight - anchor.top + GAP, maxWidth };
  return (
    <div
      ref={ref}
      className={`hover-tip${below ? " is-below" : ""}`}
      role="tooltip"
      style={style}
    >
      {tip.text}
    </div>
  );
}
