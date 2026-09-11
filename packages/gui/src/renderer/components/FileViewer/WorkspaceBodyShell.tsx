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

/** The docked open slide's length — MUST match `--dur-morph` in
 *  reference-ux.css (the grid-template-columns transition the slide rides).
 *  The `viewer-opening` hold ends on that transition's own end event; this
 *  is the floor for the cases that fire none (reduced motion runs no
 *  transition; a divider drag mid-slide cancels it). */
export const DOCK_SLIDE_MS = 800;

/**
 * The `.workspace-body` grid, viewer-aware (ADR 0050 §3). Owns the one
 * measurement (a ResizeObserver on its own content box — window resizes,
 * sidebar toggles and maximize all land here) and the class/var pair the
 * CSS keys on: `viewer-docked` (mode A — third track opens, rail parks)
 * or `viewer-overlay` (threshold fallback — absolute sheet, nothing
 * reflows), with `--viewer-w` carrying the panel width either way.
 *
 * Plus `viewer-opening` for exactly the docked open slide (owner
 * 2026-09-11: the panel was sized by its track on every frame, so the
 * text re-wrapped as the track widened and settled only at the end —
 * Codex lays the panel out at its final width first and then slides it).
 * While the class is on, the CSS takes the panel out of the grid at its
 * final place and width and slides it in on the track's own clock; the
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
  // beside `viewer-docked`, or that frame lays the panel out in a 0px track.
  const [opening, setOpening] = useState(false);
  useLayoutEffect(() => {
    if (!docked) {
      setOpening(false);
      return;
    }
    const el = ref.current;
    setOpening(true);
    const done = (): void => setOpening(false);
    // The rail's transform and the conversation's margin end on the same
    // clock and their events bubble through here — only the grid's own
    // track transition is the slide.
    const onEnd = (e: TransitionEvent): void => {
      if (e.target === el && e.propertyName === "grid-template-columns") done();
    };
    el?.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(done, DOCK_SLIDE_MS + 100);
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
  const hold = opening ? " viewer-opening" : "";
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
