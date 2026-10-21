import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ShortcutId } from "../../../shared/shortcuts.js";
import { KeyCaps } from "../common/KeyCaps.js";

export interface TooltipProps {
  readonly label: string;
  /** Optional muted second line (ADR 0033: the attach hint names the supported
   *  formats). A separate line rather than one long label because the pill is
   *  `white-space: nowrap` — appending detail to the label makes one very wide
   *  pill, while a subline keeps the primary action scannable. */
  readonly sub?: string;
  /** The command's keys, after the label (ADR 0082 §8). */
  readonly keys?: ShortcutId;
  readonly placement?: "top" | "bottom";
  readonly align?: "start" | "center" | "end";
  /**
   * Render the pill into `document.body`, positioned `fixed` from the
   * trigger's rect, instead of absolutely inside the wrap.
   *
   * For triggers that live inside a clipping or scrolling container. The
   * in-flow pill is a child of whatever contains the trigger, so it is subject
   * to every ancestor's overflow, mask and paint order — and the attachment
   * row's ✕ sits inside the activity history panel inside the conversation
   * scroller, where the pill was cut off twice in a row by two different
   * causes. Lifting it out of the flow removes the whole class rather than the
   * instance: nothing can clip an element that is not inside it.
   *
   * Opt-in, because the in-flow path is simpler and correct for the toolbar
   * buttons that have used it since 2026-06-13.
   */
  readonly portal?: boolean;
  readonly children: ReactNode;
}

/** Matches the CSS hover-reveal delay so the portal path feels identical to
 *  the in-flow one (which gets it from `transition-delay`). */
const HOVER_DELAY_MS = 400;
/** Below the trigger unless the viewport bottom is closer than this. */
const FLIP_THRESHOLD_PX = 56;
const GAP_PX = 6;

export function Tooltip(props: TooltipProps): JSX.Element {
  const placement = props.placement ?? "bottom";
  const align = props.align ?? "center";
  // Dismiss on interaction: CSS :hover keeps the tooltip up after a click
  // because the cursor is still over the control. Like Codex/Claude, once the
  // user acts on the control the hint should vanish and stay gone until the
  // pointer leaves and returns (user 2026-06-13). pointerdown suppresses
  // immediately (before the click resolves); pointerleave re-arms it.
  const [suppressed, setSuppressed] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);
  // Portal-only: the in-flow path is driven entirely by CSS :hover.
  const [fixedAt, setFixedAt] = useState<{
    left: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  const clearTimer = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  // Clear a pending reveal if the row unmounts mid-hover. Reads the ref
  // directly rather than closing over `clearTimer`, which is a new function
  // every render — listing it as a dep would re-run this on each one.
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  // Close an open portal pill on any scroll or resize (review #4). Its
  // position is captured ONCE at open and it is `position: fixed`, so a wheel
  // scroll of the conversation while hovering left the pill floating detached
  // at stale viewport coords — the in-flow pill moved with its row for free.
  // Closing (rather than re-measuring per frame) matches what a tooltip is:
  // scrolled away means no longer being asked about. Capture phase, because
  // the conversation scroller's scroll event does not bubble to window.
  useEffect(() => {
    if (fixedAt === null) return;
    const close = (): void => setFixedAt(null);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, { capture: true });
      window.removeEventListener("resize", close);
    };
  }, [fixedAt]);

  const openPortal = (): void => {
    const el = wrapRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    const roomBelow = window.innerHeight - r.bottom;
    // Anchoring the flipped pill by `bottom` avoids having to know its height
    // before it renders — no measure pass, no first-frame jump.
    setFixedAt(
      placement === "top" || roomBelow < FLIP_THRESHOLD_PX
        ? {
            left: Math.round(r.left + r.width / 2),
            bottom: Math.round(window.innerHeight - r.top + GAP_PX),
          }
        : {
            left: Math.round(r.left + r.width / 2),
            top: Math.round(r.bottom + GAP_PX),
          },
    );
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the span is a transparent wrapper — the interactive element is the CHILD control, and these handlers only observe its bubbled pointer/focus events to time the pill. Making the span itself focusable/interactive would add a second tab stop for no control.
    <span
      ref={wrapRef}
      className={`tooltip-wrap tooltip-${placement} tooltip-align-${align}${
        suppressed ? " is-suppressed" : ""
      }`}
      onPointerDown={() => {
        setSuppressed(true);
        clearTimer();
        setFixedAt(null);
      }}
      onPointerEnter={
        props.portal === true
          ? () => {
              clearTimer();
              timer.current = window.setTimeout(openPortal, HOVER_DELAY_MS);
            }
          : undefined
      }
      onPointerLeave={() => {
        setSuppressed(false);
        clearTimer();
        setFixedAt(null);
      }}
      // Keyboard parity (review #4): the in-flow pill reveals on
      // `:has(:focus-visible)` in CSS; the portal path has to do it in JS or
      // tabbing to the control shows nothing. Immediate, no hover delay —
      // reaching a control by keyboard is already deliberate.
      onFocus={props.portal === true ? openPortal : undefined}
      onBlur={
        props.portal === true
          ? () => {
              clearTimer();
              setFixedAt(null);
            }
          : undefined
      }
    >
      {props.children}
      {props.portal !== true && (
        <span
          className={`tooltip${props.keys !== undefined ? " has-keys" : ""}`}
          role="tooltip"
        >
          {props.label}
          {props.keys !== undefined && <KeyCaps id={props.keys} />}
          {props.sub !== undefined && (
            <span className="tooltip-sub">{props.sub}</span>
          )}
        </span>
      )}
      {props.portal === true &&
        fixedAt !== null &&
        !suppressed &&
        createPortal(
          <span
            className={`tooltip tooltip--portal${props.keys !== undefined ? " has-keys" : ""}`}
            role="tooltip"
            style={{
              left: `${fixedAt.left}px`,
              ...(fixedAt.top !== undefined ? { top: `${fixedAt.top}px` } : {}),
              ...(fixedAt.bottom !== undefined
                ? { bottom: `${fixedAt.bottom}px` }
                : {}),
            }}
          >
            {props.label}
            {props.keys !== undefined && <KeyCaps id={props.keys} />}
            {props.sub !== undefined && (
              <span className="tooltip-sub">{props.sub}</span>
            )}
          </span>,
          document.body,
        )}
    </span>
  );
}
