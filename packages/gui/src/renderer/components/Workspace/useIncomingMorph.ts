// The incoming rise-while-streaming morph — one of the five state machines
// Conversation.tsx hosted; extracted on 2026-09-03 at the owner's request. On
// the VISIBLE stream's null→value edge a clone that mirrors the live tokens
// rises from behind the composer to the streaming bubble's slot, which stays
// hidden until the landing hold ends. State: `incomingClone`, `hideStreaming`.
//
// Two hooks, deliberately, to keep Conversation's effect order byte-identical:
//   - `useIncomingMorph` owns the state, the refs and the FLIGHT effect, and is
//     called before the scroll engine (which reads its clone flag);
//   - `useIncomingMorphDetection` is the null→value edge that mounts the clone.
//     It keys on `visibleStreamingText`, the stream as the flow shows it, which
//     the in-flight indicator defines AFTER the engine — so it is called there,
//     exactly where the layout effect sat in Conversation.tsx.

import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { GLASS_MS, SHADOW_SETTLE_MS } from "./conversation-timing.js";
import { easeOutQuart, useRiseAnimation } from "./useRiseAnimation.js";

export function useIncomingMorph(opts: {
  readonly composerRef: RefObject<HTMLFormElement>;
  readonly overlayRef: RefObject<HTMLDivElement>;
  /** The `.conversation-flow` column — the flight watches its WIDTH. */
  readonly flowRef: RefObject<HTMLDivElement>;
  /** The scroll engine's `owedScroll` / `isGliding`, as getters: the engine
   *  is created AFTER this hook (it takes the clone flag this hook owns), so
   *  both are read at flight time — exactly what the inline effect did
   *  through the `scroll` const declared below it. */
  readonly owedScroll: () => number;
  readonly isGliding: () => boolean;
}) {
  const { composerRef, overlayRef, flowRef, owedScroll, isGliding } = opts;

  // Incoming rise-while-streaming morph: on the streamingText null→value edge,
  // mount a clone that mirrors the live tokens and rise it from behind the
  // composer to its resting slot (mirrors the outgoing morph). The flow
  // streaming bubble stays hidden until settle, where it keeps streaming.
  const incomingRise = useRiseAnimation();
  const incomingCloneRef = useRef<HTMLDivElement>(null);
  const streamingBubbleRef = useRef<HTMLDivElement>(null);
  const [incomingClone, setIncomingClone] = useState(false);
  const [hideStreaming, setHideStreaming] = useState(false);
  const prevStreaming = useRef<string | null>(null);
  /** Same landing hold as the outgoing flight (SHADOW_SETTLE_MS): only the
   *  float shadow fades here — the herta bubble keeps a rest-like shadow of
   *  its own — but the pop was the same class. The clone keeps mirroring
   *  the live tokens through the hold, exactly as it does through a
   *  glide-hold. */
  const incomingSettleTimer = useRef<number | null>(null);
  // (The detection layout effect — the null→value edge that mounts the clone —
  // is `useIncomingMorphDetection` below, called after the in-flight block: it
  // keys on `visibleStreamingText`, the stream as the flow shows it, which is
  // defined there.)

  // Animate once the incoming clone has mounted (same rationale as outgoing).
  // FLIP-style: measure the real streaming bubble's slot (held in layout via
  // visibility:hidden) for BOTH left and top, so the clone aligns with the
  // indented Herta column and rises to the bubble's actual resting slot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the clone mounting
  useEffect(() => {
    if (!incomingClone) return;
    const el = incomingCloneRef.current;
    const composer = composerRef.current;
    const overlay = overlayRef.current;
    const slot = streamingBubbleRef.current;
    if (el === null || composer === null || overlay === null || slot === null)
      return;
    const ws = overlay.getBoundingClientRect();
    const comp = composer.getBoundingClientRect();
    const dest = slot.getBoundingClientRect();
    const h = el.offsetHeight;
    const left = dest.left - ws.left; // align to the Herta column
    const startTop = comp.bottom - ws.top - h * 0.32; // behind the composer
    // The send's climb into the reserved room may still be running (2026-07-30):
    // it now starts at the outgoing flight's settle rather than at send, which
    // puts it squarely in the window where a first delta arrives. Every pixel
    // of scroll still owed lifts this slot by one, so aim at where it will be —
    // the compensation the outgoing flight no longer needs, moved to the flight
    // that now needs it. Zero whenever no scroll is pending, which keeps every
    // other path byte-identical.
    const targetTop = dest.top - ws.top - owedScroll(); // the real flow slot
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(startTop)}px`;
    el.classList.add("is-visible");
    composer.classList.add("is-glass");
    const glassTimer = window.setTimeout(() => {
      composer.classList.remove("is-glass");
    }, GLASS_MS);
    incomingRise.start({
      el,
      from: { left, top: startTop },
      to: { left, top: targetTop },
      durationMs: 760,
      easing: easeOutQuart,
      anchor: "bottom",
      // The aim above compensates for the climb still owed — but the two
      // clocks are independent, and a flight that ends mid-climb would swap
      // onto a slot still travelling toward the aimed position (deferred-fix
      // 2026-07-31: a fast first token made the bubble visibly drop at
      // hand-off, then get dragged back up). Hold at the aimed slot until
      // the climb's own lifecycle ends: converge (seamless swap), the
      // runaway cap, or a user takeover — all flip glidingRef, and every
      // cancel path (session switch, rePin, unmount) clears it too.
      holdSettle: () => isGliding(),
      // Same early settle on a flow width change as the outgoing flight.
      ...(flowRef.current !== null ? { watchWidthOf: flowRef.current } : {}),
      onSettle: () => {
        composer.classList.remove("is-glass");
        // Landing hold — see incomingSettleTimer.
        incomingSettleTimer.current = window.setTimeout(() => {
          incomingSettleTimer.current = null;
          setHideStreaming(false);
          setIncomingClone(false);
        }, SHADOW_SETTLE_MS);
      },
    });
    return () => window.clearTimeout(glassTimer);
  }, [incomingClone]);

  return {
    incomingCloneRef,
    streamingBubbleRef,
    incomingClone,
    hideStreaming,
    /** The pieces the detection half (below) drives. */
    edge: {
      rise: incomingRise,
      prevStreaming,
      incomingSettleTimer,
      setIncomingClone,
      setHideStreaming,
    },
  };
}

export type IncomingMorph = ReturnType<typeof useIncomingMorph>;

/**
 * The detection half of the incoming morph — see the file header for why it
 * is a separate hook. Call it once, after the in-flight indicator (which
 * defines `visibleStreamingText`).
 */
export function useIncomingMorphDetection(
  morph: IncomingMorph,
  opts: {
    /** The stream as the FLOW shows it (useInFlightIndicator). */
    readonly visibleStreamingText: string | null;
    readonly reduced: boolean;
    readonly retracting: boolean;
    readonly composerRef: RefObject<HTMLFormElement>;
    readonly overlayRef: RefObject<HTMLDivElement>;
  },
): void {
  const { visibleStreamingText, reduced, retracting, composerRef, overlayRef } =
    opts;
  const {
    rise: incomingRise,
    prevStreaming,
    incomingSettleTimer,
    setIncomingClone,
    setHideStreaming,
  } = morph.edge;

  // Detection: on the VISIBLE stream's null→value edge, mount the incoming
  // clone + hide the flow streaming bubble. The fixed width pins wrap so the
  // bubble doesn't reflow while it fills during the rise.
  // LAYOUT effect for the same reason as the outgoing detection above: the
  // hide flag must land before the browser paints the freshly-mounted flow
  // bubble, or it flashes at its resting slot for one frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the visibleStreamingText null→value edge
  useLayoutEffect(() => {
    const appeared =
      prevStreaming.current === null && visibleStreamingText !== null;
    prevStreaming.current = visibleStreamingText;
    if (visibleStreamingText === null) {
      incomingRise.cancel();
      if (incomingSettleTimer.current !== null) {
        window.clearTimeout(incomingSettleTimer.current);
        incomingSettleTimer.current = null;
      }
      setIncomingClone(false);
      setHideStreaming(false);
      composerRef.current?.classList.remove("is-glass");
      return;
    }
    // `retracting` is defensive: retry deltas buffer in retryText, so
    // streamingText can't do a null→value edge mid-retract.
    if (!appeared || retracting) return;
    const composer = composerRef.current;
    const overlay = overlayRef.current;
    if (composer === null || overlay === null || reduced) return;
    // The clone's size is driven by the shared measurer effect (it mirrors the
    // in-place bubble); here we only flag it active and hide the flow bubble
    // until the rise settles.
    setHideStreaming(true);
    setIncomingClone(true);
  }, [visibleStreamingText, reduced, retracting]);
}
