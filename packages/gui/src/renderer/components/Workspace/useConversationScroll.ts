import { useCallback, useEffect, useRef, useState } from "react";
import { GLIDE_WINDOW_MS, OUTGOING_FLIGHT_MS } from "./conversation-timing.js";
import { type ScrollGlideHandle, startScrollGlide } from "./scroll-glide.js";
import {
  headroomFor,
  needsRoom,
  preGlideScrollTop,
  releasedExtent,
  targetExtentFor,
} from "./turn-headroom.js";
import { useScrollEdges } from "./useScrollEdges.js";

// How close to the bottom (px) still counts as "pinned" for autoscroll —
// generous enough that sub-pixel scroll rounding and the fog strip never
// unpin, small enough that one wheel notch upward does.
const PIN_THRESHOLD_PX = 48;

/**
 * The conversation scroller's engine: pinned autoscroll (follow the stream
 * only while the reader is at the bottom), the jump-to-latest chip state,
 * turn headroom (a send reserves room; a growing reply eats spacer instead
 * of moving anything — turn-headroom.ts), the damped send glide
 * (scroll-glide.ts), and the morph-flight stand-downs the two clone rises
 * need. Moved out of `Conversation` verbatim on 2026-08-19 (ADR 0041): it
 * was ~450 lines of refs, callbacks and four effects that shared nothing
 * with the rest of the component except the two clone flags it takes here.
 * Effect order is unchanged (the hook is called where the first of these
 * lines used to be, and no other effect sat inside the moved range).
 *
 * Reworked on 2026-09-03 (owner's request — Conversation.tsx hosted five
 * state machines, and this hook handed back a bag of ~29 raw refs the
 * component wrote directly): every ref is now PRIVATE, and callers get an
 * intent surface instead — `rePin` / `releasePin` / `followSend` /
 * `noteNewBelow` / `dropTurnTravel` … — plus the DOM anchors the JSX needs.
 * The flag choreography each intent performs is byte-for-byte what the
 * component's effects used to write inline. The 回到底部 chip's click
 * (`jumpToLatest`) and the unmount cleanup of the jump timers moved in
 * from Conversation.tsx with it. Effect order inside is unchanged.
 */
export function useConversationScroll(opts: {
  /** The outgoing send morph's clone (null when none is in flight). */
  outgoingClone: { text: string } | null;
  /** Whether the incoming reply morph's clone is in flight. */
  incomingClone: boolean;
  /** prefers-reduced-motion: the chip's hop and the send's climb are
   *  instant under it. */
  reduced: boolean;
}) {
  const { outgoingClone, incomingClone, reduced } = opts;
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fog = useScrollEdges(scrollRef);

  /**
   * Put the view at the scroller's TRUE bottom.
   *
   * Not `endRef.scrollIntoView({block:"end"})`, which is what every one of
   * these sites used to do and is subtly not the same thing: `scrollIntoView`
   * aligns the ELEMENT with the scrollport's edge, and the scroller's bottom
   * padding (--approval-reserve, which the approval panel publishes) lies
   * inside the scrollport — so aligning `endRef` leaves that padding
   * unscrolled and lands short of the bottom by exactly the reserve.
   *
   * That shortfall was the approval-panel drift (user 2026-07-30, measured):
   * with a reservation held, the panel opening scrolled the pinned view 200px
   * short of the bottom, the resulting scroll event let the ratchet read it as
   * the reader stepping out of the reserved room and SPEND 200px of it, and the
   * anchored message walked down — then again when the panel closed and the
   * shrinking extent clamped the scroll. 399px over two steps, none of it
   * recoverable, because a spent reservation does not come back.
   *
   * `scrollHeight - clientHeight` is the bottom by definition, padding and all.
   */
  const scrollToBottom = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight - el.clientHeight;
  }, []);

  // ── Pinned autoscroll ──────────────────────────────────────────────────
  // Follow the stream to the bottom ONLY while the user is already there.
  // The old unconditional scrollIntoView fired on every reveal frame, so
  // scrolling up to reread during a streaming reply was impossible — the
  // pane snapped back to the bottom ~60×/s. `pinned` flips false when the
  // user scrolls away from the bottom and true when they return — by
  // scrolling, or by a layout change that lands them there with no scroll
  // event (`rederivePin` below); sending a message and switching sessions
  // re-pin explicitly (your own actions always land you at the bottom).
  const pinnedRef = useRef(true);
  // Jump-to-latest chip (2026-07-11): `pinnedRef` mirrored as STATE plus
  // "new content arrived below" together mount the 回到底部 chip. The ref
  // stays the per-frame source of truth (scroll handler and reveal frames
  // read it without re-rendering); the state exists only for the chip.
  const [pinnedState, setPinnedState] = useState(true);
  const [newBelow, setNewBelow] = useState(false);
  // True from a chip click until the smooth glide reaches the bottom (or the
  // fallback timeout fires) — growth DURING the glide must not re-light the
  // chip, and scrollToEndIfPinned must not snap over the glide.
  const jumpingRef = useRef(false);
  // True while the unpin came from a DISCLOSURE (activity-history / diff
  // expand), not from the user scrolling away (user bug 2026-07-24: expand
  // the 板砖 row while Herta's bubble streams → every reveal frame lit the
  // chip although the reader never left the bottom). A synthetic unpin keeps
  // the follow OFF (its whole purpose) but must not light the chip; the
  // FIRST real scroll event hands control back to geometry and re-arms the
  // chip machinery. loadEarlier / jumpToTopic unpin through `releasePin` —
  // their unpins are user navigation and keep lighting the chip as before.
  const syntheticUnpinRef = useRef(false);
  const jumpTimerRef = useRef<number | null>(null);
  /** Handle for the topic-jump's anchor poll, so a session change can cancel
   *  a still-pending tick (audit 2026-07-24, M4). */
  const jumpPollRef = useRef<number | null>(null);
  // Frozen while a morph clone is in flight: both rises measure their landing
  // slot ONCE at flight start, so scrolling the container mid-flight (e.g. the
  // first streaming tokens growing the hidden slot) moves the slot out from
  // under the clone — a visible jump at hand-off. The settle effect below
  // catches the scroll up once the clone lands.
  const morphInFlightRef = useRef(false);
  /** True while the SEND glide is carrying the view to the newly reserved
   *  bottom (turn headroom). Every frame of it fires a scroll event that
   *  geometry reads, correctly, as "away from the bottom" — and unpinning
   *  there is wrong twice over: the reader never left (we moved them), and
   *  it disarms the follow that is supposed to land them. Left unguarded it
   *  also loses the landing outright, since content growing mid-glide (the
   *  first tokens, an interrupted turn's rows) moves the bottom out from
   *  under a native smooth scroll that cannot retarget: the glide stops
   *  short, pinned is false, and nothing corrects it. */
  const glidingRef = useRef(false);
  /** A send reserved room and left its climb for the flight's settle
   *  (2026-07-30). Consumed by `runPendingGlide`. */
  const pendingGlideRef = useRef(false);
  /** Where the park put the scroller, so its own settle-write's scroll event
   *  is distinguishable from the reader's hand (see the scroll handler). */
  const parkedScrollTopRef = useRef(0);
  /** The running damped climb (scroll-glide.ts), for teardown: a session
   *  switch or a newer glide must stop the rAF loop, not just flip flags —
   *  a loop left running writes scrollTop against whatever is on screen. */
  const scrollGlideRef = useRef<ScrollGlideHandle | null>(null);
  // Unmount mid-climb: the loop holds `el` alive and keeps scrolling it.
  useEffect(
    () => () => {
      scrollGlideRef.current?.cancel();
      scrollGlideRef.current = null;
    },
    [],
  );
  /** Indirection so the scroll handler (installed once, above the headroom
   *  block) can reach a callback declared below it. Assigned every render;
   *  the handler only ever calls the current one. */
  const ratchetHeadroomRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onScroll = (): void => {
      // Our own glide, not the reader's hand — leave every flag alone and
      // let the settle catch-up finish the job.
      if (glidingRef.current) {
        // …unless this is the PARK window (flight in the air, climb queued,
        // no glide running): nothing of ours is writing the scroller then,
        // so a scroll that isn't the park's own settle-write is the reader —
        // and they outrank the queued climb (review 2026-07-31: a wheel
        // during the flight was silently ignored, pin/ratchet skipped, and
        // the climb then dragged the reader straight back down). Hand
        // everything back and let this event be processed like any scroll.
        const parked =
          pendingGlideRef.current &&
          scrollGlideRef.current === null &&
          Math.abs(el.scrollTop - parkedScrollTopRef.current) > 1;
        if (!parked) return;
        pendingGlideRef.current = false;
        glidingRef.current = false;
        jumpingRef.current = false;
        if (jumpTimerRef.current !== null) {
          window.clearTimeout(jumpTimerRef.current);
          jumpTimerRef.current = null;
        }
      }
      // Scrolling up SPENDS reserved room (turn-headroom.ts). Runs before
      // the pin test below and writes the spacer synchronously, so the
      // geometry that test reads is post-release: having eaten 100px of a
      // 500px blank leaves you at the new bottom, still pinned — not
      // "100px away from the bottom", which is what it would look like if
      // the two ran the other way round.
      if (!jumpingRef.current) ratchetHeadroomRef.current();
      // Any real scroll ends a synthetic (disclosure) unpin — geometry is
      // in charge again, and the chip may light on later growth.
      syntheticUnpinRef.current = false;
      const pinned =
        el.scrollTop + el.clientHeight >= el.scrollHeight - PIN_THRESHOLD_PX;
      pinnedRef.current = pinned;
      setPinnedState(pinned);
      if (pinned) {
        jumpingRef.current = false;
        setNewBelow(false);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  // Your own actions (sending, entering a session, the jump chip) re-pin
  // explicitly — one helper so ref, state, and the chip stay in sync.
  const rePin = useCallback((): void => {
    pinnedRef.current = true;
    setPinnedState(true);
    setNewBelow(false);
    syntheticUnpinRef.current = false;
    // A send glide belongs to the turn that started it; anything that
    // re-pins (the next send, entering a session) ends it, or its handler
    // stand-down would outlive it and swallow the reader's own scrolling.
    // The CANCEL matters as much as the flag (review 2026-07-30): a damped
    // climb is a live rAF loop, and one left running would keep dragging
    // the scroller under the next send's parked flight.
    glidingRef.current = false;
    scrollGlideRef.current?.cancel();
    scrollGlideRef.current = null;
  }, []);
  // Expanding collapsed row content (a diff disclosure, an activity history)
  // unpins via context: the growth lands BELOW the toggle without any scroll
  // event, so `pinnedRef` would stay stale-true and the next follow trigger
  // (window resize, streamed block, status row) would yank the viewport to
  // the conversation's end, past the just-expanded content — the "expands
  // upward" read (user 2026-07-14). See ConversationPin.tsx.
  const unpin = useCallback((): void => {
    // Already away from the bottom by their own doing (a scroll, a topic
    // jump, load-earlier): the disclosure changes nothing about where they
    // are, and marking THIS unpin synthetic would silence the chip for
    // growth below a reader who genuinely left — the 2026-08-10 rule in
    // reverse (expand-then-scroll keeps the chip; so must scroll-then-expand).
    if (!pinnedRef.current) return;
    pinnedRef.current = false;
    setPinnedState(false);
    // Disclosure unpin, not a user scroll — suppress the jump chip until a
    // real scroll event hands control back to geometry (see syntheticUnpinRef).
    syntheticUnpinRef.current = true;
  }, []);
  /** User navigation away from the bottom (load-earlier, a topic jump):
   *  drops the pin so the append-follow cannot yank the view when the
   *  prepend lands, and — unlike the disclosure `unpin` — leaves
   *  `syntheticUnpinRef` alone, so the chip keeps lighting for growth
   *  below a reader who genuinely left. */
  const releasePin = useCallback((): void => {
    pinnedRef.current = false;
    setPinnedState(false);
  }, []);
  /** Re-derive the pin from GEOMETRY after a layout change that fires no
   *  scroll event. The scroll handler was the only place `pinned` was ever
   *  recomputed, so a change that put an unpinned reader at the bottom
   *  without scrolling — a disclosure collapsing under them, the pane
   *  growing on a maximize, the approval reserve going away — left
   *  `pinnedRef` stale-false and the chip's `newBelow` stale-true: the
   *  回到底部 chip stayed up over a bubble that was entirely on screen, and
   *  the follow stayed off (owner 2026-09-02: scrolled up while Herta
   *  speaks, expand a 板砖 detail row, collapse it — the chip never left).
   *  Only the unpinned→pinned direction: growth cannot bring a reader TO
   *  the bottom, and pinned→unpinned is the disclosure unpin's job. Stands
   *  down for a chip glide / jump, which own the pin until they land. */
  const rederivePin = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null || pinnedRef.current) return;
    if (glidingRef.current || jumpingRef.current) return;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - PIN_THRESHOLD_PX)
      return;
    pinnedRef.current = true;
    setPinnedState(true);
    setNewBelow(false);
    syntheticUnpinRef.current = false;
  }, []);
  /** New content arrived below: light the 回到底部 chip — but only for a
   *  reader who is away from the bottom by their own doing (not a
   *  disclosure unpin) and not mid-jump (growth DURING the chip's glide must
   *  not re-light it). The reveal's growth frames and appended blocks both
   *  come through here. */
  const noteNewBelow = useCallback((): void => {
    if (
      !pinnedRef.current &&
      !jumpingRef.current &&
      !syntheticUnpinRef.current
    ) {
      setNewBelow(true);
    }
  }, []);
  // The chip's click: glide back to the latest content. The scroll handler
  // re-pins when the glide lands at the bottom; `jumpingRef` keeps mid-glide
  // growth from re-lighting the chip, with a timeout fallback for a glide
  // interrupted by the user wheeling away.
  const jumpToLatest = useCallback((): void => {
    jumpingRef.current = true;
    setNewBelow(false);
    if (jumpTimerRef.current !== null)
      window.clearTimeout(jumpTimerRef.current);
    jumpTimerRef.current = window.setTimeout(() => {
      jumpTimerRef.current = null;
      jumpingRef.current = false;
    }, 1000);
    const el = scrollRef.current;
    if (el === null) return;
    // The TRUE bottom, for the same reason `scrollToBottom` exists: aligning
    // `endRef` leaves the approval reserve unscrolled, so with a gate open the
    // chip would land short of the bottom, leave the chip's own condition
    // still true, and spend reserved room on the way (2026-07-30). Smooth is
    // native here — this is a short hop the reader asked for, not the send's
    // page-sized climb (scroll-glide.ts).
    el.scrollTo({
      top: el.scrollHeight - el.clientHeight,
      behavior: reduced ? "auto" : "smooth",
    });
  }, [reduced]);
  // ── Turn headroom (2026-07-29) ─────────────────────────────────────────
  // A send that needs room fixes a target scrollable EXTENT; the spacer
  // below the flow is whatever is left of it, so "the bottom" is "your
  // message at the top of the pane" and a growing reply eats spacer instead
  // of moving anything. See turn-headroom.ts. Kept OUT of React state
  // deliberately — measured from layout and written back to layout at the
  // same moments the pinned follow already runs, and a state round-trip
  // would put a paint between the two.
  const headroomRef = useRef<HTMLDivElement>(null);
  /** The held extent, or null when nothing is reserved. Survives the turn
   *  that set it: a short answer leaves room still open, and the NEXT
   *  message lands in that room rather than scrolling to make more. */
  const headroomExtentRef = useRef<number | null>(null);
  /** The newest user row's offset from the top of the scrollable content. */
  const measureAnchorTop = useCallback((): number | null => {
    const el = scrollRef.current;
    if (el === null) return null;
    const rows = el.querySelectorAll<HTMLElement>(".user-row");
    const anchor = rows[rows.length - 1];
    if (anchor === undefined) return null;
    return (
      anchor.getBoundingClientRect().top -
      el.getBoundingClientRect().top +
      el.scrollTop
    );
  }, []);
  /** The flow's height EXCLUDING the reservation, in `scrollHeight` units —
   *  what the spacer is sized against. Only ever read while an extent is
   *  held, which only happens on a pane the content fills, so the
   *  `scrollHeight >= clientHeight` clamp cannot distort it there. */
  const measureContentHeight = useCallback((): number => {
    const el = scrollRef.current;
    const spacer = headroomRef.current;
    if (el === null) return 0;
    return el.scrollHeight - (spacer?.offsetHeight ?? 0);
  }, []);
  /** The bottom of the real content, in the scroller's content coordinates.
   *  The spacer is the last thing in the flow, so its top edge IS that
   *  bottom — and unlike anything derived from `scrollHeight`, it stays
   *  honest on a conversation too short to fill the pane. */
  const measureContentBottom = useCallback((): number => {
    const el = scrollRef.current;
    const spacer = headroomRef.current;
    if (el === null || spacer === null) return 0;
    return (
      spacer.getBoundingClientRect().top -
      el.getBoundingClientRect().top +
      el.scrollTop
    );
  }, []);
  /** Armed by the live-window trim just before it shrinks the record: the
   *  next sync slides the extent down instead of letting the trimmed rows'
   *  height reappear as blank (see the trim effect). */
  const headroomRebaseRef = useRef(false);
  /** Returns the height DELTA it wrote to the spacer (0 when nothing
   *  changed), so a caller that needs the post-sync bottom can derive it
   *  from geometry read BEFORE the write instead of re-reading after —
   *  the re-read forced a second layout on every reveal frame that was
   *  actively consuming the reservation (perf review 2026-07-31). */
  const syncHeadroom = useCallback((): number => {
    const spacer = headroomRef.current;
    if (spacer === null) return 0;
    let extent = headroomExtentRef.current;
    // Mirrored onto the node: the reservation is invisible by nature (it is
    // empty space), so "is it holding" is otherwise only answerable by
    // reading a ref in a debugger. Also what the wiring tests assert, since
    // jsdom has no layout and every measured height there is 0.
    spacer.dataset.armed = extent === null ? "false" : "true";
    if (extent === null) {
      // A stale rebase (extent released between arming and this sync) must
      // not survive to re-anchor some FUTURE reservation.
      headroomRebaseRef.current = false;
      if (spacer.style.height !== "0px") {
        // The previous write is the spacer's height — no layout read needed
        // (the spacer has no transition, by design).
        const prev = Number.parseInt(spacer.style.height, 10) || 0;
        spacer.style.height = "0px";
        return -prev;
      }
      return 0;
    }
    const current = spacer.offsetHeight;
    const contentHeight = measureContentHeight();
    // The extent is a content-coordinate total, and a trim removed content
    // ABOVE it — left as-is, headroomFor would hand the trimmed rows' height
    // to the spacer as fresh blank and the pinned view would park on empty
    // pane (review 2026-07-31). This first post-shrink sync sees the
    // shrunken content with the spacer still at its pre-trim size, so
    // content + current IS the slid-down extent that keeps the visible blank
    // exactly as it was.
    if (headroomRebaseRef.current) {
      headroomRebaseRef.current = false;
      extent = contentHeight + current;
      headroomExtentRef.current = extent;
    }
    const next = headroomFor({
      targetExtent: extent,
      contentHeight,
    });
    // Sub-pixel churn would write style on every reveal frame for nothing.
    if (Math.abs(next - current) >= 1) {
      spacer.style.height = `${next}px`;
      return next - current;
    }
    return 0;
  }, [measureContentHeight]);
  /** Spend reserved room as the reader scrolls up out of it. Cheap in the
   *  common case — once the extent is spent (null) or the reader is at the
   *  bottom, this is two property reads and a return, which is all it does
   *  for the whole life of a session that never scrolls back. Only the
   *  short phase of actively eating the blank pays for a layout. */
  const ratchetHeadroom = useCallback((): void => {
    const el = scrollRef.current;
    const extent = headroomExtentRef.current;
    if (el === null || extent === null) return;
    // At the bottom of the CURRENT layout, nothing is being spent — whatever
    // the stored extent says about where the bottom used to be. Room is spent
    // by scrolling UP out of it, and a view sitting at the bottom has not.
    //
    // This guard is the second half of the approval-panel drift (user
    // 2026-07-30). The panel's reserve going away SHRINKS the scroller under a
    // pinned view, so the browser clamps scrollTop down — a scroll event the
    // reader did not cause, arriving before the spacer has re-synced, so the
    // test below compared a fresh scroll position against a stale extent and
    // spent 200px of room the reader never left. Unrecoverable, too: a spent
    // reservation does not come back. Measured, both directions, in the
    // scratchpad approval-drift lab.
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - PIN_THRESHOLD_PX)
      return;
    if (el.scrollTop + el.clientHeight >= extent) return;
    headroomExtentRef.current = releasedExtent({
      extent,
      scrollTop: el.scrollTop,
      viewport: el.clientHeight,
      contentHeight: measureContentHeight(),
    });
    syncHeadroom();
  }, [measureContentHeight, syncHeadroom]);
  ratchetHeadroomRef.current = ratchetHeadroom;
  const scrollToEndIfPinned = useCallback((): void => {
    const el = scrollRef.current;
    // Whether this call may move the scroller — the three stand-downs that
    // always gated the scroll write below, evaluated UP FRONT so a call that
    // cannot scroll skips the bottom read too (perf 2026-08-25). This runs
    // on every reveal growth frame, and for an unpinned reader that read was
    // the last forced layout left on the reveal path — paid per frame for a
    // value the unpinned branch never used. The guard covers exactly the
    // scroll and its read; the sync below stays unconditional.
    //
    // Suppressing the scroll mid-morph: a clone measured its landing slot at
    // flight start, and scrolling moves that slot; the settle re-runs this.
    // Mid-glide: the climb IS the follow, re-deriving the live bottom every
    // frame, and an instant snap here would cut its damped tail short (the
    // incoming clone's settle lands exactly in this window).
    const canScroll =
      el !== null &&
      pinnedRef.current &&
      !morphInFlightRef.current &&
      !glidingRef.current;
    // One forced layout per scrolling call (perf review 2026-07-31): while a
    // reply is eating the reservation, every reveal frame used to run read →
    // spacer write → scrollHeight RE-read, and the post-write re-read forced
    // a second layout each frame. Read the bottom first (this read after the
    // reveal's text commit is the one unavoidable layout), let the sync do
    // its clean-layout reads and its write, and derive the post-sync bottom
    // from the spacer delta. A scrollTop assignment past the real bottom is
    // clamped by the scroller, so the derivation needs no safety re-read.
    const preBottom = canScroll ? el.scrollHeight - el.clientHeight : 0;
    // The SYNC deliberately runs THROUGH every stand-down — the guard above
    // must never grow to cover it. Mid-morph (deferred-fix 2026-07-31):
    // while a reservation holds, growth eats spacer and scrollHeight stays
    // constant — which is exactly what keeps the clones' measured slots
    // still. Standing the sync down there let text streamed during the
    // incoming flight inflate the bottom instead: the climb chased it past
    // the anchored gap and snapped back at the hand-off, and the incoming
    // rise's owedScroll over-counted by the same growth, aiming the clone a
    // few lines too high. Mid-glide, a stale spacer would feed the climb a
    // bottom past the anchored position. Unpinned (a disclosure unpin can
    // hold a reservation open), the spacer must keep tracking growth or
    // re-pinning would land on stale blank. With no reservation armed the
    // sync touches no layout at all (style reads/writes only), so the
    // unpinned common case pays nothing here either.
    const delta = syncHeadroom();
    if (!canScroll) return;
    el.scrollTop = Math.max(0, preBottom + delta);
  }, [syncHeadroom]);
  /** Take the scroller for a DAMPED climb to the bottom (scroll-glide.ts;
   *  user 2026-07-30 — the native smooth scroll spends a pane-sized move at
   *  constant speed and reads mechanical). The handler stands down
   *  (glidingRef) and the chip cannot light on growth that arrives before we
   *  land. No release timer: the glide retargets the live bottom every frame
   *  — the drift a timer existed to re-assert cannot accumulate — and its
   *  own lifecycle ends it (converged, runaway cap, wheel takeover). */
  const beginGlide = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    scrollGlideRef.current?.cancel();
    glidingRef.current = true;
    jumpingRef.current = true;
    if (jumpTimerRef.current !== null) {
      window.clearTimeout(jumpTimerRef.current);
      jumpTimerRef.current = null;
    }
    const release = (reassert: boolean): void => {
      scrollGlideRef.current = null;
      jumpingRef.current = false;
      glidingRef.current = false;
      if (reassert) scrollToEndIfPinned();
    };
    scrollGlideRef.current = startScrollGlide(el, {
      // Converged at the live bottom — one exact re-assert (headroom sync +
      // pin) now that the catch-ups above stood down for the duration.
      onDone: () => release(true),
      // The reader took the wheel: geometry rules again, nothing re-asserted
      // — their very next scroll event runs the ratchet and the pin test.
      onUserTakeover: () => release(false),
    });
  }, [scrollToEndIfPinned]);
  /** The climb a send deferred until its bubble had landed (2026-07-30).
   *  Returns whether it took over, so the settle's catch-up can leave the
   *  scroller alone when it did. */
  const runPendingGlide = useCallback((): boolean => {
    if (!pendingGlideRef.current) return false;
    pendingGlideRef.current = false;
    // The spacer may have been resized while the flight was in the air (the
    // reply's first blocks land during it), so re-measure before travelling.
    syncHeadroom();
    beginGlide();
    return true;
  }, [beginGlide, syncHeadroom]);
  /** Your own send lands you at the bottom — the body of the send effect
   *  that used to live in Conversation (see useTurnFollow for the trigger
   *  and the history of why it only re-pins a reader who was already AT the
   *  bottom). `flightArmed`: whether the outgoing morph will fly a clone for
   *  this send, which decides whether the climb into reserved room is handed
   *  to the flight's settle or travels now. */
  const followSend = useCallback(
    (flightArmed: boolean): void => {
      // A DISCLOSURE unpin is not "reading history" (owner 2026-08-10). Opening
      // an activity history or a detail pane unpins on purpose — the follow must
      // not yank the viewport past what was just opened — but the reader is
      // still sitting at the bottom, and sending IS a request to see their own
      // message. Treated as scrolled-away it lost both halves of the send at
      // once: no flight (the clone declines to fly into a blind spot) and the
      // jump chip lit while the reader had never left. `syntheticUnpinRef` is
      // cleared by the first real scroll event, so a reader who expands and THEN
      // scrolls away is genuinely reading history and still gets the chip.
      if (!pinnedRef.current && !syntheticUnpinRef.current) {
        // Reading history. The message still lands in the flow below; the chip
        // says so. No re-pin, no headroom reservation (its measurements describe
        // an anchor that is off screen), no travel — and the detection effect
        // above has already declined to fly a clone into the same blind spot.
        setNewBelow(true);
        return;
      }
      rePin();
      // Fix the extent BEFORE the scroll, so "the end" is already the anchored
      // position when we land there — one scroll, not a jump followed by a
      // correction. The morph clone mounts on the next commit and measures a
      // slot that is final in both axes.
      //
      // The question is what the reader can SEE: is there already blank pane
      // under the conversation for this answer to land in? A short previous
      // answer leaves most of its reservation unused, and re-anchoring there
      // scrolled the thread up to make room that was already on screen (user
      // 2026-07-29). Holding the extent instead drops this message into that
      // blank without moving anything, and only re-fixes it once the answers
      // have actually eaten the room.
      //
      // LATCHED here, for this turn. Asked continuously, a growing reply would
      // cross the threshold mid-answer and reserve underneath it — a jump,
      // from a decision that belongs to the moment you pressed send.
      const el = scrollRef.current;
      const anchorTop = measureAnchorTop();
      const reserve =
        el !== null &&
        anchorTop !== null &&
        needsRoom({
          contentBottom: measureContentBottom(),
          maxScroll: el.scrollHeight - el.clientHeight,
          viewport: el.clientHeight,
        });
      if (reserve && el !== null && anchorTop !== null) {
        headroomExtentRef.current = targetExtentFor({
          anchorTop,
          viewport: el.clientHeight,
        });
      }
      syncHeadroom();
      // Making room moves the view a long way — most of a pane — so it GLIDES.
      // An instant landing reads as the page having been replaced rather than
      // scrolled (user 2026-07-29). Landing in room that already existed has
      // nothing to travel, and keeps the immediate landing it always had.
      const glide = reserve && !reduced;
      // ONE MOVE AT A TIME (user 2026-07-30). The climb and the bubble's flight
      // used to start together, so the page slid upward while the bubble was
      // still crossing it — two motions competing for the same eye, and the
      // flight had to aim at a slot that was moving. Sequenced: park at the
      // bottom of the REAL content, where the message lands flush against the
      // bottom edge with the reserved room still off screen, and hand the climb
      // to the flight's settle (see runPendingGlide).
      if (glide && el !== null && flightArmed) {
        pendingGlideRef.current = true;
        // The scroller is OURS from here until the climb lands, and saying so
        // before parking is load-bearing: parking is a scroll AWAY from the
        // bottom, and the scroll handler's ratchet reads exactly that as the
        // reader stepping out of the reserved room and spends it (measured live
        // 2026-07-30 — the reservation evaporated on the park and the climb then
        // had 0px to travel). The fallback release covers a flight that never
        // settles; `beginGlide` replaces it with the real window when the climb
        // actually starts.
        glidingRef.current = true;
        jumpingRef.current = true;
        if (jumpTimerRef.current !== null) {
          window.clearTimeout(jumpTimerRef.current);
        }
        jumpTimerRef.current = window.setTimeout(() => {
          jumpTimerRef.current = null;
          jumpingRef.current = false;
          glidingRef.current = false;
          pendingGlideRef.current = false;
          scrollToEndIfPinned();
        }, OUTGOING_FLIGHT_MS + GLIDE_WINDOW_MS);
        el.scrollTop = preGlideScrollTop({
          contentBottom: measureContentBottom(),
          viewport: el.clientHeight,
        });
        // Record the parked position (post-assignment, so it carries the
        // browser's clamp): the scroll handler treats any OTHER position seen
        // during the park as the reader taking over.
        parkedScrollTopRef.current = el.scrollTop;
        return;
      }
      // Nothing is going to fly (no overlay/composer, or reduced motion), so
      // there is no settle to wait for: travel now, as it always did.
      if (glide) beginGlide();
      else scrollToBottom();
    },
    [
      reduced,
      rePin,
      measureAnchorTop,
      measureContentBottom,
      syncHeadroom,
      scrollToEndIfPinned,
      beginGlide,
      scrollToBottom,
    ],
  );
  // Bug 2026-07-09 (sidebar-toggle vertical shift): the grid-column
  // animations (220ms sidebar collapse, 800ms connect rail slide) re-wrap
  // any bubble narrower than its fixed cap, changing heights ABOVE the
  // scroll position; with overflow-anchor:none the browser keeps scrollTop,
  // so the visible content slides up. Re-pin the bottom through container
  // resizes: a pinned view stays pinned frame-by-frame across the
  // transition; unpinned readers keep their scrollTop (no forced jump).
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    let lastHeight = el.clientHeight;
    /** Last content-box height per observed child (the flow wrapper), for
     *  the shrink test below. */
    const lastChildHeight = new Map<Element, number>();
    const ro = new ResizeObserver((entries) => {
      // Two signals share the observer (2026-09-02). The scroller's OWN box
      // (a viewport resize, the approval reserve) runs the follow below, as
      // it always has. Its direct children — the flow wrapper, the same
      // level useScrollEdges watches — report content changes, of which
      // only a SHRINK matters here: a disclosure collapsing can land an
      // unpinned reader at the bottom with no scroll event (rederivePin),
      // while growth never can — and growth arrives on every reveal frame,
      // so that branch is one number compare and nothing else. A callback
      // with no entries (the tests' fake observer) is the scroller path.
      const list: readonly ResizeObserverEntry[] = Array.isArray(entries)
        ? entries
        : [];
      let scroller = list.length === 0;
      let shrank = false;
      for (const entry of list) {
        if (entry.target === el) {
          scroller = true;
          continue;
        }
        const h = entry.contentRect.height;
        const prev = lastChildHeight.get(entry.target);
        lastChildHeight.set(entry.target, h);
        if (prev !== undefined && h < prev) shrank = true;
      }
      // Before the follow, so a resize that lands an unpinned reader at the
      // bottom is followed in the same frame.
      if (scroller || shrank) rederivePin();
      if (!scroller) return;
      // Viewport-delta re-derive (deferred-fix 2026-07-31): an armed extent
      // baked in the send-time viewport — `anchorTop − GAP + viewport` — so
      // a maximize mid-hold left the anchored message viewport-delta below
      // its gap, and a restore-from-maximized could leave a spacer TALLER
      // than the pane (a wholly blank screen until the ratchet spent it).
      // Adding the height delta restores the contract at any size, and
      // because `maxScroll = extent − viewport` is invariant under it, the
      // pinned view doesn't move and no scroll correction is needed. Width
      // changes (sidebar toggle) deliberately don't touch the extent.
      const h = el.clientHeight;
      if (h !== lastHeight) {
        if (headroomExtentRef.current !== null) {
          headroomExtentRef.current += h - lastHeight;
        }
        lastHeight = h;
      }
      scrollToEndIfPinned();
    });
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [scrollToEndIfPinned, rederivePin]);
  morphInFlightRef.current = outgoingClone !== null || incomingClone;
  // Settle catch-up: growth frozen during the flight scrolls into view the
  // moment the last clone lands — or, when the send deferred its climb into the
  // reserved room, the OUTGOING landing is where that climb starts
  // (2026-07-30). Keyed on the clone unmounting rather than called from
  // onSettle, so the real bubble is already back on screen: the clone lives in
  // the overlay and does not scroll with the flow, so travelling before the
  // hand-off would carry the page out from under a message that was still a
  // clone.
  //
  // The climb waits for the OUTGOING clone only (review 2026-07-30). Gating it
  // on both let a fast first delta steal it: the incoming clone mounted during
  // the outgoing flight, the park's fallback timer outlived neither and
  // cleared the pending climb, and the eventual both-down catch-up landed the
  // page with an INSTANT snap — plus a hand-off mismatch, since the incoming
  // rise had aimed at the post-climb slot via owedScroll. Climbing under the
  // incoming flight is exactly what that compensation exists for.
  useEffect(() => {
    if (outgoingClone !== null) return;
    if (runPendingGlide()) return;
    if (!incomingClone) scrollToEndIfPinned();
  }, [outgoingClone, incomingClone, scrollToEndIfPinned, runPendingGlide]);
  // Unmount: the chip's glide fallback and the topic jump's anchor poll are
  // this hook's timers (moved in from Conversation.tsx on 2026-09-03; it sat
  // among the chip effects there — an unmount-only cleanup, so its place in
  // the effect order carries nothing).
  useEffect(
    () => () => {
      if (jumpTimerRef.current !== null)
        window.clearTimeout(jumpTimerRef.current);
      if (jumpPollRef.current !== null)
        window.clearTimeout(jumpPollRef.current);
    },
    [],
  );

  // ── Intent surface (2026-09-03) ────────────────────────────────────────
  // What the rest of Conversation may ask of the scroller. The refs above
  // stay private: every caller that used to write them says WHAT it wants,
  // and the flag choreography lives here, once. Each body is exactly the
  // lines the caller used to run inline.
  /** Scrolled away from the bottom by their own doing — a scroll, a topic
   *  jump, load-earlier. A disclosure unpin does NOT count (owner
   *  2026-08-10): the reader is still sitting at the bottom. The outgoing
   *  morph and `followSend` must agree on this, or the send hands its
   *  travel to a flight that was never armed. */
  const isReadingHistory = useCallback(
    (): boolean => !pinnedRef.current && !syntheticUnpinRef.current,
    [],
  );
  const isPinned = useCallback((): boolean => pinnedRef.current, []);
  const isGliding = useCallback((): boolean => glidingRef.current, []);
  const isJumping = useCallback((): boolean => jumpingRef.current, []);
  const isMorphInFlight = useCallback(
    (): boolean => morphInFlightRef.current,
    [],
  );
  /** A topic-jump anchor poll has been scheduled and not cancelled. (The
   *  handle is only ever cleared by a cancel, not by the tick firing —
   *  preserved as it was.) */
  const hasJumpPoll = useCallback(
    (): boolean => jumpPollRef.current !== null,
    [],
  );
  const hasHeadroom = useCallback(
    (): boolean => headroomExtentRef.current !== null,
    [],
  );
  /** Scroll still owed by a running send climb (0 when none is running):
   *  every pixel of it lifts the incoming clone's landing slot by one, so
   *  the incoming rise aims at where the slot WILL be. */
  const owedScroll = useCallback((): number => {
    const pane = scrollRef.current;
    return pane === null || !glidingRef.current
      ? 0
      : Math.max(0, pane.scrollHeight - pane.clientHeight - pane.scrollTop);
  }, []);
  /** Arm one tick of the topic jump's anchor poll (a TIMER, deliberately
   *  not rAF — see useTopicJump). */
  const scheduleJumpPoll = useCallback(
    (tick: () => void, delayMs: number): void => {
      jumpPollRef.current = window.setTimeout(tick, delayMs);
    },
    [],
  );
  /** Cancel a still-pending anchor poll tick (audit 2026-07-24, M4). */
  const cancelJumpPoll = useCallback((): void => {
    if (jumpPollRef.current !== null) {
      window.clearTimeout(jumpPollRef.current);
      jumpPollRef.current = null;
    }
  }, []);
  /** Drop a chip glide / park in progress: the jump flag and its fallback
   *  timer (session transients — see useRecordWindow). */
  const cancelJump = useCallback((): void => {
    jumpingRef.current = false;
    if (jumpTimerRef.current !== null) {
      window.clearTimeout(jumpTimerRef.current);
      jumpTimerRef.current = null;
    }
  }, []);
  /** Flag the next sync to slide an armed extent down past a trim (see
   *  `headroomRebaseRef` and the pinned trim in useRecordWindow). */
  const armHeadroomRebase = useCallback((): void => {
    if (headroomExtentRef.current !== null) {
      headroomRebaseRef.current = true;
    }
  }, []);
  /** Release a held reservation, spacer and all, in the calling commit. */
  const releaseHeadroom = useCallback((): void => {
    if (headroomExtentRef.current !== null) {
      headroomExtentRef.current = null;
      syncHeadroom();
    }
  }, [syncHeadroom]);
  /** Entering (or blanking to) another session: the reservation, the
   *  parked/pending climb and a RUNNING climb all belonged to the turn you
   *  sent in the session you are leaving — see useSessionEntrance. */
  const dropTurnTravel = useCallback((): void => {
    headroomExtentRef.current = null;
    glidingRef.current = false;
    pendingGlideRef.current = false;
    scrollGlideRef.current?.cancel();
    scrollGlideRef.current = null;
    syncHeadroom();
  }, [syncHeadroom]);

  return {
    // DOM anchors for the JSX, and the fog edges.
    endRef,
    scrollRef,
    headroomRef,
    fog,
    // The chip's render inputs (state mirrors of the private refs).
    pinnedState,
    newBelow,
    // Intents.
    scrollToBottom,
    scrollToEndIfPinned,
    rePin,
    unpin,
    releasePin,
    noteNewBelow,
    jumpToLatest,
    followSend,
    isReadingHistory,
    isPinned,
    isGliding,
    isJumping,
    isMorphInFlight,
    hasJumpPoll,
    hasHeadroom,
    owedScroll,
    scheduleJumpPoll,
    cancelJumpPoll,
    cancelJump,
    armHeadroomRebase,
    releaseHeadroom,
    dropTurnTravel,
  };
}

/** The engine handle the conversation's other hooks take. */
export type ConversationScroll = ReturnType<typeof useConversationScroll>;
