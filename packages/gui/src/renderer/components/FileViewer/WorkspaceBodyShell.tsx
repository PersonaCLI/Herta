import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { FileViewerPanel } from "./FileViewerPanel.js";
import { useFileViewerState } from "./file-viewer-context.js";

/** The docked slides' length — MUST match `--dur-morph` in
 *  reference-ux.css (the grid-template-columns transition the slides ride).
 *  The `viewer-opening` / `viewer-closing` holds end on that transition's
 *  own end event; the timer floor below covers the cases that fire none
 *  (reduced motion runs no transition; a divider drag mid-slide cancels
 *  it). */
export const DOCK_SLIDE_MS = 800;
/** The floor sits well past the slide: a busy main thread delays the grid
 *  transition's end, and dropping a hold before the track has reached its
 *  rest would snap the rail into a half-open slot — the very glitch the
 *  holds exist to prevent. Under reduced motion the extra beat is
 *  invisible (the absolute box IS the track's geometry). */
export const DOCK_HOLD_FLOOR_MS = DOCK_SLIDE_MS * 2;
type SlidePhase = "idle" | "opening" | "closing";

/**
 * The `.workspace-body` grid, viewer-aware (ADR 0050 §3). Owns the one
 * measurement (a ResizeObserver on its own content box — window resizes,
 * sidebar toggles and maximize all land here) and the class/var pair the
 * CSS keys on: `viewer-docked` (mode A — third track opens, rail parks)
 * or `viewer-overlay` (threshold fallback — absolute sheet, nothing
 * reflows), with `--viewer-w` carrying the panel width either way.
 *
 * Plus one of `viewer-opening` / `viewer-closing` for exactly the docked
 * slides (owner 2026-09-11, two reports): opening, the panel was sized by
 * its track on every frame, so its text re-wrapped as the track widened;
 * closing, the rail's compositor-driven slide ran over its main-thread
 * slot and, on a busy frame, the cards "appeared in the middle, got pushed
 * to the edge, then jumped back". While a hold is on, the CSS takes the
 * panel (opening) and the rail (both) out of the grid at their rest
 * geometry and slides them by transform on the track's own clock; the
 * hold drops on the grid's own transitionend, so the hand-over to the
 * track-sized steady state lands on the frame the slide finishes.
 */
export function WorkspaceBodyShell({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const v = useFileViewerState();
  const ref = useRef<HTMLDivElement | null>(null);
  const setBodyWidth = v?.setBodyWidth;
  const docked = v?.open === true && v.docked;

  // Layout effect, not effect: the hold must be on the FIRST painted frame
  // beside the docked class change, or that frame lays the panel out in a
  // 0px track (opening) / snaps the rail into a 0px slot (closing).
  const [phase, setPhase] = useState<SlidePhase>("idle");
  const wasDocked = useRef(false);
  useLayoutEffect(() => {
    const was = wasDocked.current;
    wasDocked.current = docked;
    // Only a docked EDGE is a slide; tab changes while open re-run nothing.
    if (docked === was) return;
    const el = ref.current;
    setPhase(docked ? "opening" : "closing");
    const done = (): void => setPhase("idle");
    // The rail's transform and the conversation's margin end on the same
    // clock and their events bubble through here — only the grid's own
    // track transition is the slide.
    const onEnd = (e: TransitionEvent): void => {
      if (e.target === el && e.propertyName === "grid-template-columns") done();
    };
    el?.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(done, DOCK_HOLD_FLOOR_MS);
    return () => {
      el?.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
    };
  }, [docked]);

  useEffect(() => {
    const el = ref.current;
    if (el === null || setBodyWidth === undefined) return;
    // Content-box width (the grid's own sizing base — padding excluded),
    // one source for both signals below.
    const measure = (): void => {
      const cs = getComputedStyle(el);
      const w =
        el.getBoundingClientRect().width -
        (Number.parseFloat(cs.paddingLeft) || 0) -
        (Number.parseFloat(cs.paddingRight) || 0);
      if (w > 0) setBodyWidth(w);
    };
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number" && w > 0) setBodyWidth(w);
    });
    ro.observe(el);
    // Belt-and-braces beside the observer (owner 2026-08-31: a
    // maximize→restore left the width un-reclamped): a window resize
    // re-measures directly, so the clamp can never depend on a single
    // delivery path. The CSS min() cap in the grid template is the hard
    // floor either way.
    window.addEventListener("resize", measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [setBodyWidth]);

  const cls =
    v?.open === true ? (v.docked ? " viewer-docked" : " viewer-overlay") : "";
  const hold = phase === "idle" ? "" : ` viewer-${phase}`;
  const style = {
    "--viewer-w": `${v?.widthPx ?? 0}px`,
  } as CSSProperties;
  return (
    <div ref={ref} className={`workspace-body${cls}${hold}`} style={style}>
      {children}
      <FileViewerPanel />
    </div>
  );
}
