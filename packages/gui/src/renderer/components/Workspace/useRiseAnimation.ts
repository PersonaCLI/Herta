import { useCallback, useEffect, useRef } from "react";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { beginMorphFlight, endMorphFlight } from "./morph-flight.js";

export interface RiseOpts {
  readonly el: HTMLElement;
  readonly from: { readonly left: number; readonly top: number };
  readonly to: { readonly left: number; readonly top: number };
  readonly durationMs: number;
  readonly easing: (t: number) => number;
  readonly onSettle?: () => void;
  /** "top" (default): interpolate the top edge — the original behavior.
   *  "bottom": interpolate the BOTTOM edge; per frame
   *  `top = bottom(t) − currentHeight`, where the target bottom is
   *  re-derived from the live `el.offsetHeight` (`to.top + height`). Height
   *  added mid-flight therefore extends the bubble UPWARD — its bottom can
   *  never descend into the composer — and at t=1 the top lands exactly on
   *  `to.top` (the flow slot), so the settle swap stays seamless. Used by
   *  the incoming Herta-bubble morph, whose text streams (and grows the
   *  clone) while it flies.
   *
   *  Upward only as far as the slot (2026-10-07): the top never rises above
   *  `to.top`. Above the slot is the row before it — a reply that started
   *  right under the 板砖 row and filled several lines in flight (a held
   *  backlog drains at up to 180 chars/s) grew straight up over that row.
   *  Growth past the slot extends the bottom instead, as the real bubble's
   *  does. */
  readonly anchor?: "top" | "bottom";
  /** Re-read the landing slot every frame instead of trusting `to` (rAF
   *  path only; `to` is the first frame's answer and the fallback when this
   *  returns null). After the flight settles, the clone keeps tracking it
   *  until `cancel()` — the owner's hand-off hold parks it in place for a
   *  while, and the slot may move during it.
   *
   *  For a flight whose slot moves under it (2026-10-07): the incoming rise
   *  used to freeze the conversation's follow for the whole flight so its
   *  once-measured slot held still, and a reply that began at a full pane
   *  then grew below the fold for 760ms — the page caught up in one jump
   *  after the hand-off. Tracking lets the follow run. */
  readonly liveTo?: () => {
    readonly left: number;
    readonly top: number;
  } | null;
  /** Polled when the rAF flight reaches its natural end: while it returns
   *  true, the flight HOLDS at its target instead of settling (deferred-fix
   *  2026-07-31). The incoming rise aims at the POST-climb slot, but its
   *  760ms clock and the damped climb's are independent — a fast first
   *  token could end the flight while the climb was still carrying the real
   *  slot toward the aimed position, and the settle swap dropped the bubble
   *  onto the not-yet-arrived slot (worst case, a reservation-sized jump).
   *  Holding costs nothing structural: every teardown path (cancel, resize
   *  settle, unmount) still ends the flight, and the climb's own lifecycle
   *  — converge, runaway cap, or user takeover — always flips the
   *  predicate. rAF path only; the composited path is pure travel and
   *  nothing it waits on exists. */
  readonly holdSettle?: () => boolean;
  /** Container whose content-box WIDTH moving the landing slot should
   *  settle the flight early, exactly like a window resize (deferred-fix
   *  2026-07-31): the 220ms sidebar collapse, the connect-rail slide, and
   *  the topic-rail gutter easing in all re-wrap or shift the centered flow
   *  with no window resize event, and the clone landed at the pre-reflow
   *  slot. Width only — the flow's HEIGHT grows on every streamed line, and
   *  settling on that would kill every flight mid-stream. */
  readonly watchWidthOf?: Element;
  /**
   * CSS easing equivalent to `easing`. Supplying it upgrades an
   * `anchor: "top"` flight to a WAAPI transform animation — handed to the
   * COMPOSITOR, so it keeps moving through a blocked main thread instead of
   * freezing with it. Without it (or for `anchor: "bottom"`, which must react
   * to live height) the flight runs on rAF, still writing transform.
   *
   * It cannot be derived: `easing` is an arbitrary function. Pass the twin of
   * the curve you passed above — {@link E_OUT_CUBIC} for `easeOutCubic`.
   */
  readonly cssEasing?: string;
}

/** CSS twin of {@link easeOutCubic}, for `cssEasing`. Same constant
 *  useConnectMorph's WAAPI flight uses. */
export const E_OUT_CUBIC = "cubic-bezier(0.215, 0.61, 0.355, 1)";

export interface RiseAnimation {
  start(opts: RiseOpts): void;
  cancel(): void;
}

/** Cubic/quartic ease-out curves used by the message morph. */
export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
export const easeOutQuart = (t: number): number => 1 - (1 - t) ** 4;

/** Linear-progress point where the bottom-anchored rise begins easing from
 *  the anti-lurch clamp toward the true resting bottom, so a bubble that grew
 *  past the rise distance settles onto the slot continuously instead of
 *  snapping at the end. */
const BOTTOM_SETTLE_BLEND_START = 0.75;

/**
 * Animates an element from `from` to `to`, imperatively (no per-frame React
 * state). Under prefers-reduced-motion the element is placed at `to`
 * immediately with no animation at all.
 *
 * ## FLIP inversion, not per-frame left/top
 *
 * The element is positioned at its DESTINATION and displaced back to `from`
 * with a transform; the flight then runs that transform to zero. Landing is
 * therefore exact by construction — the settle writes no position at all —
 * and no frame of the flight invalidates layout.
 *
 * This replaces per-frame `left`/`top` writes (user 2026-07-30: the send
 * animations "obviously drop frames" on a low-config PC). Measured on the
 * built renderer at 6× CPU throttle over the 240-block fixture, the
 * left/top version delivered 17fps with a 33ms median frame for the morph
 * alone, most of the cost being layout+paint of a shadowed bubble over a
 * 17,000px document once per frame.
 *
 * It is the same migration useConnectMorph made on 2026-07-13 for the
 * composer→button rise, for the same reason, and it carries that commit's
 * conclusion on the "never transform text" rule: the rule guards against
 * SCALING, which resamples glyph rasters. A translate hands the layer's
 * existing texture to the compositor unscaled, so carried text stays crisp.
 */
export function useRiseAnimation(): RiseAnimation {
  const reduced = useReducedMotion();
  const frame = useRef<number | null>(null);
  // Removes the flight's window-resize listener (audit 2026-07-10); set per
  // start(), cleared by settle/cancel/unmount.
  const removeResize = useRef<(() => void) | null>(null);
  /** Tears down the WAAPI flight (composited path) — detaches onfinish first
   *  so cancelling cannot fire the settle. */
  const cancelWaapi = useRef<(() => void) | null>(null);
  /** Whether THIS hook currently holds a flight open in the global counter
   *  (see morph-flight.ts). A boolean rather than counting calls, so no path —
   *  cancel-inside-start, resize settle then unmount — can close a flight
   *  twice or leave one open. */
  const flightOpen = useRef(false);

  /** Balanced counter close; safe to call on any teardown path. */
  const closeFlight = useCallback((): void => {
    if (!flightOpen.current) return;
    flightOpen.current = false;
    endMorphFlight();
  }, []);

  const cancel = useCallback((): void => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    cancelWaapi.current?.();
    cancelWaapi.current = null;
    removeResize.current?.();
    removeResize.current = null;
    closeFlight();
  }, [closeFlight]);

  // Cancel any in-flight rAF loop when the owning component unmounts mid-rise.
  // `cancel` is a stable useCallback, so this only fires its cleanup on unmount.
  useEffect(() => cancel, [cancel]);

  const start = useCallback(
    (opts: RiseOpts): void => {
      cancel();
      const { el, from, to, durationMs, easing, onSettle } = opts;
      const anchor = opts.anchor ?? "top";
      const startBottom = from.top + el.offsetHeight;
      /** Where the flight lands: `to`, or the slot as `liveTo` reads it
       *  this frame (the last good read when it has none). */
      let aimed: { left: number; top: number } = to;
      const aim = (): { left: number; top: number } => {
        const live = opts.liveTo?.();
        if (live !== undefined && live !== null) aimed = live;
        return aimed;
      };
      /** The base position: the destination as known at start, re-based
       *  once at the landing when the destination moved (`liveTo`). */
      const base = { left: to.left, top: to.top };
      /** Absolute position → the transform that puts the element there, given
       *  its base position. Rounded, so glyphs land on whole pixels. */
      const place = (l: number, t: number): void => {
        el.style.transform = `translate3d(${Math.round(l - base.left)}px, ${Math.round(t - base.top)}px, 0)`;
      };
      // Base position is the DESTINATION for the whole flight (see the FLIP
      // note above): every frame is a displacement from where it lands.
      el.style.left = `${Math.round(to.left)}px`;
      el.style.top = `${Math.round(to.top)}px`;
      if (reduced) {
        el.style.transform = "none";
        el.classList.remove("is-moving");
        el.classList.add("is-settled");
        onSettle?.();
        return;
      }
      el.classList.remove("is-settled");
      el.classList.add("is-moving");
      // Declared AFTER the reduced-motion return above: that path never flies,
      // so it must never open a flight the aura would then throttle for.
      flightOpen.current = true;
      beginMorphFlight();
      const started = performance.now();
      // anchor:"bottom": track the eased bottom edge so height growth (streaming
      // text adding lines) extends the TOP upward rather than pushing the bottom
      // down into the composer. The bottom is clamped to never exceed its
      // previous frame value — if liveTargetBottom grows (height grew), the
      // eased path temporarily exceeds lastBottom and the clamp holds it steady
      // until easing catches up…or the rise ends (then the settle-blend
      // converges it to the slot).
      // Terminal path shared by natural completion and the resize settle.
      // Dropping the transform IS the landing: the base left/top already are
      // the destination, so there is no final position write to get wrong (and
      // no rounding residue to reveal at the hand-off).
      const finish = (): void => {
        // Order is load-bearing (pinned by the resize test): the WAAPI flight
        // runs with fill:forwards, so the animation must be CANCELLED before
        // the landing transform is written — the other way round, the fill
        // overrides the write and the clone freezes displaced at `from`.
        cancelWaapi.current?.();
        cancelWaapi.current = null;
        if (opts.liveTo !== undefined) {
          // The slot moved under the flight: land where it is NOW — the one
          // base write of a tracked flight.
          const at = aim();
          base.left = at.left;
          base.top = at.top;
          el.style.left = `${Math.round(at.left)}px`;
          el.style.top = `${Math.round(at.top)}px`;
        }
        el.style.transform = "none";
        el.classList.remove("is-moving");
        el.classList.add("is-settled");
        frame.current = null;
        removeResize.current?.();
        removeResize.current = null;
        // Before onSettle, which commits the hand-off and may start the NEXT
        // flight (the incoming rise follows the outgoing one): closing after
        // would decrement that new flight's own count.
        closeFlight();
        // A tracked clone stays on its slot through the hand-off hold, until
        // cancel(). Scheduled BEFORE onSettle, so a flight that onSettle
        // starts cancels this loop rather than racing it.
        if (opts.liveTo !== undefined) {
          const track = (): void => {
            const at = aim();
            place(at.left, at.top);
            frame.current = requestAnimationFrame(track);
          };
          frame.current = requestAnimationFrame(track);
        }
        onSettle?.();
      };
      // A viewport resize mid-flight reflows the conversation column and
      // moves the once-measured landing slot (audit 2026-07-10) — the clone
      // would land a few px off its flow position. Re-measuring mid-flight
      // is fragile; instead settle IMMEDIATELY: onSettle swaps the clone for
      // the real flow element, which the fresh layout positions correctly.
      const onResize = (): void => {
        if (frame.current !== null) {
          cancelAnimationFrame(frame.current);
          frame.current = null;
        }
        finish();
      };
      window.addEventListener("resize", onResize);
      // Same settle for a CONTAINER reflow (see watchWidthOf). The observer
      // always delivers once on observe() — that baseline delivery must not
      // settle a fresh flight, so the first width is recorded, and only a
      // subsequent ≥1px change fires.
      let watched: ResizeObserver | null = null;
      if (
        opts.watchWidthOf !== undefined &&
        typeof ResizeObserver !== "undefined"
      ) {
        let baseline: number | null = null;
        watched = new ResizeObserver((entries) => {
          const w = entries[entries.length - 1]?.contentRect.width;
          if (w === undefined) return;
          if (baseline === null) {
            baseline = w;
            return;
          }
          if (Math.abs(w - baseline) < 1) return;
          onResize();
        });
        watched.observe(opts.watchWidthOf);
      }
      removeResize.current = () => {
        window.removeEventListener("resize", onResize);
        watched?.disconnect();
      };

      // ── the composited path ──────────────────────────────────────────────
      // A top-anchored flight with a CSS easing is pure travel: nothing about
      // it depends on anything that can change mid-flight, so hand it to the
      // compositor and let it run there. On a slow machine this is the whole
      // point — the main thread WILL block during a send (measured: 1.1–1.6s
      // of long tasks inside the 1.8s window, mostly style/layout/paint for
      // the committed turn), and a compositor animation keeps moving through
      // exactly that. Mirrors useConnectMorph's WAAPI flight.
      if (
        anchor === "top" &&
        opts.cssEasing !== undefined &&
        typeof el.animate === "function"
      ) {
        place(from.left, from.top); // committed before the animation replaces it
        const anim = el.animate(
          [
            {
              transform: `translate3d(${Math.round(from.left - to.left)}px, ${Math.round(from.top - to.top)}px, 0)`,
            },
            { transform: "translate3d(0px, 0px, 0)" },
          ],
          { duration: durationMs, easing: opts.cssEasing, fill: "forwards" },
        );
        anim.onfinish = finish;
        cancelWaapi.current = () => {
          anim.onfinish = null;
          anim.cancel();
        };
        return;
      }

      // ── the reactive path ────────────────────────────────────────────────
      // `anchor: "bottom"` re-derives its target from the element's LIVE
      // height every frame (streaming text grows the clone), so it cannot be
      // precomputed into keyframes. It still writes transform rather than
      // left/top, so it no longer invalidates layout per frame.
      // persists across rAF frames; anti-lurch baseline
      let lastBottom = startBottom;
      const step = (nowTs: number): void => {
        const raw = Math.min(1, (nowTs - started) / durationMs);
        const e = easing(raw);
        const dest = aim();
        const left = from.left + (dest.left - from.left) * e;
        if (anchor === "bottom") {
          const h = el.offsetHeight;
          const liveTargetBottom = dest.top + h;
          const clampedBottom = Math.min(
            startBottom + (liveTargetBottom - startBottom) * e,
            lastBottom,
          );
          // Over the final portion of the rise, blend the clamped (anti-lurch)
          // bottom toward the TRUE resting bottom (dest.top + h) so the bubble
          // settles onto the slot continuously. Without this, large height
          // growth (> rise distance) freezes the clamped bottom for the whole
          // flight and the final place() snaps the top to the slot — a hard
          // jump. The blend distributes that convergence across the last
          // (1 - BOTTOM_SETTLE_BLEND_START) of the rise instead.
          const blend =
            raw <= BOTTOM_SETTLE_BLEND_START
              ? 0
              : (raw - BOTTOM_SETTLE_BLEND_START) /
                (1 - BOTTOM_SETTLE_BLEND_START);
          const bottom =
            clampedBottom + (liveTargetBottom - clampedBottom) * blend;
          // monotonic tracks the clamp, not the blend, so the anti-lurch
          // guarantee in the pre-blend region is unaffected.
          lastBottom = Math.min(lastBottom, clampedBottom);
          // Never above the slot (2026-10-07): what lies above it is the
          // previous row, and the clamp above would otherwise grow the clone
          // up over it — see `anchor`.
          place(left, Math.max(bottom - h, dest.top));
        } else {
          place(left, from.top + (dest.top - from.top) * e);
        }
        if (raw < 1) {
          frame.current = requestAnimationFrame(step);
          return;
        }
        if (opts.holdSettle?.() === true) {
          // Park exactly on the target (the aimed slot) and keep the frame
          // loop alive; the flow scrolls beneath the overlay-held clone
          // until the predicate clears. Height growth during the hold
          // extends the clone downward from the slot top — matching the
          // real bubble it will swap for.
          place(dest.left, dest.top);
          frame.current = requestAnimationFrame(step);
          return;
        }
        finish();
      };
      frame.current = requestAnimationFrame(step);
    },
    [reduced, cancel, closeFlight],
  );

  return { start, cancel };
}
