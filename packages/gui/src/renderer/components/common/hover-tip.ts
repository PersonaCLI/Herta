/**
 * The app's own hover tip (owner 2026-09-09: the commit rows showed the OS
 * tooltip, a foreign object on the glass). One tip at a time, kept here as
 * a tiny store; `HoverTipLayer` renders it in a fixed box above the anchor
 * so no scroll container clips it, and `hoverTipProps` hands an element
 * the handlers that show it after a short dwell and hide it at once — plain
 * props, not a hook, so a row inside a list can carry them. Text only — a
 * commit subject, a path — never markup.
 */
export interface HoverTipState {
  readonly text: string;
  /** The anchor's viewport rectangle at show time. */
  readonly anchor: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

/** Dwell before the tip appears — the OS's own feel, minus its look. */
export const HOVER_TIP_DELAY_MS = 350;

let current: HoverTipState | null = null;
/** The one pending dwell — there is one pointer. */
let pending: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
function notify(): void {
  for (const l of listeners) l();
}

/**
 * While a tip shows, its anchor is watched for leaving the DOM (2026-09-10):
 * React dispatches no mouseleave for an element it removes, so a tip over
 * a commit row that a terminal's commit pushed off the list stayed pinned
 * at the row's old rectangle until another tipped element was entered.
 * One observer on the document's tree, alive only while a tip is up.
 */
let anchorWatch: MutationObserver | null = null;
function watchAnchor(anchor: Element): void {
  anchorWatch?.disconnect();
  anchorWatch = null;
  if (typeof MutationObserver === "undefined") return;
  const observer = new MutationObserver(() => {
    if (anchor.isConnected) return;
    hideHoverTip();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  anchorWatch = observer;
}
function unwatchAnchor(): void {
  anchorWatch?.disconnect();
  anchorWatch = null;
}

export function getHoverTip(): HoverTipState | null {
  return current;
}

export function subscribeHoverTip(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function showHoverTip(anchor: Element, text: string): void {
  // A row that left the DOM during the dwell (the card's rows animate
  // out) has no rectangle to anchor to.
  if (!anchor.isConnected) return;
  const r = anchor.getBoundingClientRect();
  current = {
    text,
    anchor: { left: r.left, top: r.top, width: r.width, height: r.height },
  };
  watchAnchor(anchor);
  notify();
}

export function hideHoverTip(): void {
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
  unwatchAnchor();
  if (current === null) return;
  current = null;
  notify();
}

/** Arm the tip for `anchor` after the dwell; a leave before then cancels. */
export function armHoverTip(anchor: Element, text: string): void {
  if (pending !== null) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    showHoverTip(anchor, text);
  }, HOVER_TIP_DELAY_MS);
}

/** The handlers that give an element the app's tip in place of a native
 *  `title`: a dwell on hover, at once on keyboard focus, gone the moment
 *  the pointer or focus leaves. Empty text → no handlers at all. */
export function hoverTipProps(text: string): {
  readonly onMouseEnter?: (e: React.MouseEvent<Element>) => void;
  readonly onMouseLeave?: () => void;
  readonly onFocus?: (e: React.FocusEvent<Element>) => void;
  readonly onBlur?: () => void;
} {
  if (text.length === 0) return {};
  return {
    onMouseEnter: (e) => armHoverTip(e.currentTarget, text),
    onMouseLeave: hideHoverTip,
    onFocus: (e) => showHoverTip(e.currentTarget, text),
    onBlur: hideHoverTip,
  };
}
