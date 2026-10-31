/**
 * Inline outline icons for the TopBar controls.
 *
 * Rendered inline (NOT via `<img>`) so CSS can drive `stroke-width` and
 * `color` on hover / focus / active — a raster PNG or an SVG loaded through
 * `<img>` is opaque to CSS and can't be re-stroked. See
 * `.sidebar-header-icon-svg` in `reference-ux.css` for the rest→hover
 * transition (light grey → deepened dark, 1.5 → 2 stroke).
 *
 * Paths are the Heroicons-style outline glyphs from
 * `reference_UX_design/icons/*_outline.svg`. Stroke width is intentionally
 * NOT set as an attribute here — CSS owns it so hover can change it.
 */

function IconSvg(props: {
  readonly dataIcon: string;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <svg
      className="sidebar-header-icon-svg"
      data-icon={props.dataIcon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  );
}

export function PanelToggleIcon(): JSX.Element {
  return (
    <IconSvg dataIcon="panel-toggle">
      <path d="M9 4.5v15m-4.875 0h15.75c.621 0 1.125-.504 1.125-1.125V5.625c0-.621-.504-1.125-1.125-1.125H4.125C3.504 4.5 3 5.004 3 5.625v12.75c0 .621.504 1.125 1.125 1.125Z" />
    </IconSvg>
  );
}

export function SearchIcon(): JSX.Element {
  return (
    <IconSvg dataIcon="search">
      <path d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
    </IconSvg>
  );
}

/** The browser's page tab (ADR 0083 §2): a globe. */
export function GlobeIcon(): JSX.Element {
  return (
    <IconSvg dataIcon="globe">
      <path d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
    </IconSvg>
  );
}

export function NewSessionIcon(): JSX.Element {
  return (
    <IconSvg dataIcon="new-session">
      <path d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
    </IconSvg>
  );
}

/**
 * Flow's button (ADR 0084): a radio sending. Its own svg rather than
 * `IconSvg`, because its two waves are separate paths: while an issue is
 * being gathered, or a new one waits unread, they pulse outward in turn
 * (owner 2026-10-31: "dynamic, since it is like a radio"). At rest it takes
 * the shared grey → dark, 1.5 → 2 stroke on hover, as every icon here does.
 */
export function FlowRadioIcon(props: { readonly live: boolean }): JSX.Element {
  return (
    <svg
      className={`sidebar-header-icon-svg flow-radio${props.live ? " is-live" : ""}`}
      data-icon="flow"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        className="flow-radio-core"
        cx="12"
        cy="12"
        r="1.6"
        fill="currentColor"
      />
      <path
        className="flow-radio-wave flow-radio-wave--near"
        d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6"
      />
      <path
        className="flow-radio-wave flow-radio-wave--far"
        d="M5.4 18.6a9.4 9.4 0 0 1 0-13.2M18.6 5.4a9.4 9.4 0 0 1 0 13.2"
      />
    </svg>
  );
}
