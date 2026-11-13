import { useId } from "react";

/**
 * The 板砖 device ring — the ellipse stack + its gradient/filter defs that sit
 * behind the agent device image and recolor per state (via the
 * `.agent-ring.is-<state>` rules). Drawn by `DeviceGlow` as the rail card's
 * no-WebGL fallback (was inlined in DeviceCard.tsx). Lifted verbatim
 * from packages/gui/src/renderer/reference/UX_v5.html .agent-ring > svg.
 *
 * The gradient/filter ids are made unique per instance (`useId`) so two rings on
 * the page at once don't collide on document-global `url(#id)` references.
 * (That was the Settings demo card over the rail's, until the demo became a
 * line drawing of its own on 2026-11-13.)
 */
export function RingSVG(): JSX.Element {
  // useId() may contain ":" which is invalid inside an SVG url(#…) fragment.
  const uid = useId().replace(/:/g, "");
  const blueGlassFill = `${uid}-blueGlassFill`;
  const ringFaceTint = `${uid}-ringFaceTint`;
  const softBlueDiskGlow = `${uid}-softBlueDiskGlow`;
  const hotInnerRingGlow = `${uid}-hotInnerRingGlow`;
  return (
    <svg
      viewBox="0 0 100 105"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={blueGlassFill} cx="50%" cy="46%" r="58%">
          <stop offset="0%" stopColor="#4E77FF" stopOpacity="0.62" />
          <stop offset="46%" stopColor="#4F82FF" stopOpacity="0.42" />
          <stop offset="72%" stopColor="#48BAFF" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#48BAFF" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={ringFaceTint} cx="50%" cy="50%" r="52%">
          <stop offset="0%" stopColor="#6D8FFF" stopOpacity="0.22" />
          <stop offset="66%" stopColor="#4F8DFF" stopOpacity="0.10" />
          <stop offset="100%" stopColor="#4F8DFF" stopOpacity="0" />
        </radialGradient>
        <filter
          id={softBlueDiskGlow}
          x="-100%"
          y="-100%"
          width="300%"
          height="300%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="5.2" result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="0 0 0 0 0.16 0 0 0 0 0.43 0 0 0 0 1 0 0 0 0.78 0"
            result="blueBlur"
          />
          <feMerge>
            <feMergeNode in="blueBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter
          id={hotInnerRingGlow}
          x="-120%"
          y="-120%"
          width="340%"
          height="340%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="2.2" result="tight" />
          <feGaussianBlur stdDeviation="6.0" result="wide" />
          <feColorMatrix
            in="wide"
            type="matrix"
            values="0 0 0 0 0.20 0 0 0 0 0.74 0 0 0 0 1 0 0 0 0.82 0"
            result="cyanWide"
          />
          <feColorMatrix
            in="tight"
            type="matrix"
            values="0 0 0 0 0.72 0 0 0 0 1 0 0 0 0 1 0 0 0 0.96 0"
            result="whiteTight"
          />
          <feMerge>
            <feMergeNode in="cyanWide" />
            <feMergeNode in="whiteTight" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <ellipse
        cx="50"
        cy="52.5"
        rx="43.8"
        ry="46.5"
        fill={`url(#${blueGlassFill})`}
        filter={`url(#${softBlueDiskGlow})`}
        opacity="0.94"
      />
      <ellipse
        cx="50"
        cy="52.5"
        rx="33.0"
        ry="35.0"
        fill={`url(#${ringFaceTint})`}
        opacity="0.86"
      />
      <ellipse
        cx="50"
        cy="52.5"
        rx="45.2"
        ry="48.2"
        fill="none"
        stroke="#4D86FF"
        strokeWidth="5.8"
        opacity="0.42"
      />
      <ellipse
        cx="50"
        cy="52.5"
        rx="43.2"
        ry="46.2"
        fill="none"
        stroke="#70D8FF"
        strokeWidth="2.2"
        opacity="0.55"
      />
      <ellipse
        cx="50"
        cy="52.5"
        rx="31.5"
        ry="33.6"
        fill="none"
        stroke="#62E5FF"
        strokeWidth="8.0"
        opacity="0.82"
        filter={`url(#${hotInnerRingGlow})`}
      />
      <ellipse
        cx="50"
        cy="52.5"
        rx="31.5"
        ry="33.6"
        fill="none"
        stroke="#F4FFFF"
        strokeWidth="4.4"
        opacity="0.98"
      />
      <ellipse
        cx="50"
        cy="52.5"
        rx="31.5"
        ry="33.6"
        fill="none"
        stroke="#B9FFFF"
        strokeWidth="1.4"
        opacity="1"
      />
    </svg>
  );
}
