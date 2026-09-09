import { useSyncExternalStore } from "react";
import { getHoverTip, subscribeHoverTip } from "./hover-tip.js";

/** Room between the anchor and the tip, and from the viewport's edges. */
const GAP = 8;
const EDGE = 8;
const MAX_WIDTH = 360;

/**
 * Mount once at the app root. Renders the current hover tip in a fixed box
 * above its anchor — below when the anchor sits too near the top — clamped
 * to the viewport's width. The text is the tip's whole content.
 */
export function HoverTipLayer(): JSX.Element | null {
  const tip = useSyncExternalStore(subscribeHoverTip, getHoverTip, () => null);
  if (tip === null) return null;
  const { anchor } = tip;
  const width = Math.min(MAX_WIDTH, window.innerWidth - 2 * EDGE);
  const centre = anchor.left + anchor.width / 2;
  const left = Math.max(
    EDGE,
    Math.min(window.innerWidth - EDGE - width, centre - width / 2),
  );
  const below = anchor.top < 72;
  const style: React.CSSProperties = below
    ? { left, top: anchor.top + anchor.height + GAP, width }
    : { left, bottom: window.innerHeight - anchor.top + GAP, width };
  return (
    <div
      className={`hover-tip${below ? " is-below" : ""}`}
      role="tooltip"
      style={style}
    >
      {tip.text}
    </div>
  );
}
