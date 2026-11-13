import { type CSSProperties, useId } from "react";
import type { BanzhuanDeviceState } from "../../hooks/useDeviceState.js";

export interface BanzhuanDemoCardProps {
  readonly state: BanzhuanDeviceState;
  /** The state's colour. The ring, its glow and the disc behind the device
   *  take it, so the drawing shows the legend's own swatch. */
  readonly led: string;
  /** Hovering the card pauses the demo cycle. The parent owns the timer. */
  readonly onHoverChange?: (hovering: boolean) => void;
}

/* The drawing sits on the pane's 132 × 165 box, one unit to a CSS pixel.
   The front face is the rectangle 27,34 – 87,136 with 11 px corners, drawn
   in its true shape so the ring on it stays a circle; the thickness runs
   back along ONE direction, (17, −10), and every receding line follows it. */

/** The device's silhouette, closed: what the masks cut out. */
const HULL =
  "M32.42 35.52A11 11 0 0 0 27 45V125A11 11 0 0 0 38 136H76A11 11 0 0 0 81.58 134.48L98.58 124.48A11 11 0 0 0 104 115V35A11 11 0 0 0 93 24H55A11 11 0 0 0 49.42 25.52Z";
/** The same silhouette as the heavy line, with a dot cut into the left edge
 *  and a gap in the top one. */
const OUTLINE =
  "M32.42 35.52A11 11 0 0 0 27 45V91.4M27 94.2L27 94.2M27 97V125A11 11 0 0 0 38 136H76A11 11 0 0 0 81.58 134.48L98.58 124.48A11 11 0 0 0 104 115V35A11 11 0 0 0 93 24H80.08M77.04 24H55A11 11 0 0 0 49.42 25.52L32.42 35.52";
/** The side face, for its faint tint. */
const SIDE =
  "M83.78 37.22L100.78 27.22A11 11 0 0 1 104 35V115A11 11 0 0 1 98.58 124.48L81.58 134.48A11 11 0 0 0 87 125V45A11 11 0 0 0 83.78 37.22Z";
/** The front face's top and right edges, then the edge between the top and
 *  the side. They stop short of the outline. */
const EDGES = "M40.4 34H76A11 11 0 0 1 87 45V122.6M84.12 37.02L97.38 29.22";
/** The device's stepped seam, round onto the side, and the two dashes of
 *  its label. */
const DETAILS =
  "M30.2 109H61C62.9 109 64 108.4 65.2 107L71.4 100C72.6 98.6 73.7 98 75.6 98H87L102.3 89M36 122.5H48M52 122.5H56";

/**
 * The 板砖 device as a line drawing, for the Settings lifecycle demo (ADR
 * 0057 §2.4, amended 2026-11-13). It is the pane's own picture of the device
 * the rail shows lit: its silhouette, its seam and the ring on its face,
 * drawn in the theme's ink (`currentColor`) with one colour, the state's, on
 * the ring. Inline SVG and CSS only: the pane opens no WebGL context and
 * loads no image. `state` is driven by `useDemoDeviceCycle` in the parent
 * pane and picks the motion (`.settings-bz-card[data-state]` in
 * reference-ux.css). The card is `aria-hidden`: the synced caption and the
 * legend carry the meaning for AT.
 */
export function BanzhuanDemoCard({
  state,
  led,
  onHoverChange,
}: BanzhuanDemoCardProps): JSX.Element {
  // Mask ids are document-global, and useId() may hold a ":", which is not
  // valid inside url(#…).
  const uid = useId().replace(/:/g, "");
  const behind = `${uid}-behind`;
  const floor = `${uid}-floor`;
  return (
    <section
      className="settings-bz-card"
      data-state={state}
      style={{ "--bz-led": led } as CSSProperties}
      aria-hidden="true"
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <svg
        className="bz-art"
        viewBox="0 0 132 165"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          {/* What stands behind the device shows only outside it… */}
          <mask
            id={behind}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="132"
            height="165"
          >
            <rect width="132" height="165" fill="#fff" />
            <path d={HULL} fill="#000" />
          </mask>
          {/* …and the floor's lines stop a little short of its outline. */}
          <mask
            id={floor}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="132"
            height="165"
          >
            <rect width="132" height="165" fill="#fff" />
            <path
              d={HULL}
              fill="#000"
              stroke="#000"
              strokeWidth="6"
              strokeLinejoin="round"
            />
          </mask>
        </defs>
        <g mask={`url(#${behind})`}>
          <circle className="bz-art-back" cx="65.5" cy="78" r="57" />
        </g>
        <g mask={`url(#${floor})`}>
          <ellipse
            className="bz-art-detail"
            cx="65.5"
            cy="131.5"
            rx="56"
            ry="12.5"
          />
          <path
            className="bz-art-detail bz-art-ripple"
            d="M21.5 144.7A64 16 0 0 0 109.5 144.7"
          />
        </g>
        <path className="bz-art-tint" d={SIDE} />
        <path className="bz-art-edge" d={EDGES} />
        <path className="bz-art-detail" d={DETAILS} />
        <path className="bz-art-outline" d={OUTLINE} />
        <circle className="bz-art-detail" cx="57" cy="61" r="12.8" />
        <circle className="bz-art-glow" cx="57" cy="61" r="8" />
        <circle className="bz-art-led" cx="57" cy="61" r="8" />
        <circle
          className="bz-art-spin"
          cx="57"
          cy="61"
          r="8"
          pathLength="100"
        />
      </svg>
    </section>
  );
}
