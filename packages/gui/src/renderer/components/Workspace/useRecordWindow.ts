// The windowed record's paging, trimming and viewport anchoring: load-earlier
// (a prepend, anchored so the visible content does not slide), the pinned and
// the unpinned live-window trims (a tail cut, anchored the same way), the
// reservation/anchor invalidation on a rewind, and the session-scoped
// transients the entrance effect predates. Extracted from Conversation.tsx on
// 2026-09-03 (owner's request: the file hosted five state machines). State:
// the two anchors (`prependAnchorRef`, `trimAnchorRef`) and the append
// baseline. Effects, in order: the prepend anchor consumer (layout), the
// pinned trim, the unpinned trim, the trim anchor consumer (layout), the
// rewind tail-shrink (layout), the session-transient clear — the same order
// they had, and the same three layout effects between the incoming morph's
// detection and the session entrance.

import type { TerminalRecord } from "@herta/app-server";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { SessionStore } from "../../store/session-store.js";
import type { ConversationScroll } from "./useConversationScroll.js";

// Unpinned live-window trim (2026-08-25). Deliberately laxer than the pinned
// 260→200: the reader is IN this history, so trims should be rare and only
// ever claim rows provably off-screen above. Begin considering a cut past
// this many mounted blocks…
export const UNPINNED_TRIM_AT = 500;
/** …never cut into the newest blocks (mirror of the pinned tail bound —
 *  scrolling back down must land on real history, not a paging button)… */
export const UNPINNED_TRIM_KEEP_TAIL = 200;
/** …and don't bother for cuts smaller than this (each trim costs a geometry
 *  read and a full-window commit; tiny ones would churn per append). */
export const UNPINNED_TRIM_MIN = 50;

export function useRecordWindow(opts: {
  readonly scroll: ConversationScroll;
  readonly sessionStore: SessionStore;
  readonly record: TerminalRecord;
  readonly recordStart: number;
  readonly sessionId: string | null;
}): { readonly loadEarlier: () => void } {
  const { scroll, sessionStore, record, recordStart, sessionId } = opts;

  // ── Load-earlier paging (long sessions, 2026-07-12) ─────────────────────
  // The store holds only the trailing window; recordStart > 0 means older
  // blocks exist on the main side. Clicking pages them in; the viewport is
  // ANCHORED across the prepend (content grows ABOVE the scroll position and
  // overflow-anchor is disabled on the pane, so scrollTop must be offset by
  // the height delta manually or the visible content slides away).
  const prependAnchorRef = useRef<{
    /** The window start at click time — the offset applies only to the
     *  prepend this click caused (recordStart strictly decreases); any other
     *  window change (rewind/heal reset) clears the anchor instead. */
    expectFrom: number;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  /** The prepend anchor's mirror, armed by the unpinned live-window trim
   *  below: rows leave ABOVE the scroll position, so scrollTop must slide
   *  down by the removed height or the visible content jumps. Same clearing
   *  discipline as prependAnchorRef (rewind, session switch). */
  const trimAnchorRef = useRef<{
    /** The window start at trim time — consumed only by the recordStart
     *  INCREASE this trim caused. */
    expectFrom: number;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scroll` is the engine handle (useConversationScroll's result, stable per biome.json) passed through this hook, not a varying input
  const loadEarlier = useCallback((): void => {
    const el = scroll.scrollRef.current;
    prependAnchorRef.current =
      el === null
        ? null
        : {
            expectFrom: sessionStore.getSnapshot().recordStart,
            scrollHeight: el.scrollHeight,
            scrollTop: el.scrollTop,
          };
    // Reading older history: drop the pin so the append-follow effect can't
    // yank the view to the bottom when the prepend lands.
    scroll.releasePin();
    void sessionStore.loadOlderBlocks();
  }, [sessionStore]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scroll` is the engine handle (useConversationScroll's result, stable per biome.json) passed through this hook, not a varying input
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (anchor === null) return;
    prependAnchorRef.current = null;
    if (recordStart >= anchor.expectFrom) return; // not this click's prepend
    const el = scroll.scrollRef.current;
    if (el === null) return;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [recordStart]);

  // Live-window trim (audit T3.5): live appends grow the windowed record
  // without bound — the 200-block tail bound (RECORD_TAIL_BLOCKS) applies
  // only to reset/open payloads — so a marathon sitting climbs mounted DOM
  // rows and per-commit reconcile cost forever. While the reader is PINNED
  // at the bottom, drop the window back to the tail bound once it runs 60
  // past it (hysteresis, not a per-block slice): the removed rows sit far
  // above the fold, the browser clamps scrollTop at the shrunken bottom
  // (still pinned), and "load earlier" pages them back on demand. Never
  // trims under an unpinned reader (they may be reading those rows — the
  // geometry-guarded sibling below owns that case) or while a morph clone
  // is measuring row slots (a shrinking flow would move its landing slot —
  // the same bug class the morphs just escaped).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scroll` is the engine handle (useConversationScroll's result, stable per biome.json) passed through this hook, not a varying input
  useEffect(() => {
    if (!scroll.isPinned() || scroll.isMorphInFlight()) return;
    if (record.length > 260) {
      // An armed reservation is a content-coordinate total; trimming rows
      // above it without sliding it down converts their height into spacer,
      // shoving the pinned view (streaming reply included) off the top
      // (review 2026-07-31). The height isn't knowable until the shrunken
      // flow lays out, so flag the next sync to rebase — the spacer keeps
      // its current size across the trim.
      scroll.armHeadroomRebase();
      sessionStore.trimRecordWindow(200);
    }
  }, [record, sessionStore]);

  // Unpinned live-window trim (2026-08-25): the T3.5 trim above stands down
  // while the reader is scrolled up, which left a marathon run under an
  // unpinned reader growing the mounted window without bound — every commit
  // re-grouping and reconciling every mounted row. This sibling claims only
  // rows the reader provably is not looking at: the cut lands on a user row
  // (`data-abs-index` rows are in flow order, so everything before one sits
  // strictly above it — and a user block always starts a fresh groupRecord
  // run, so survivors regroup identically) whose top sits at least one
  // viewport ABOVE the visible region, so a casual scroll-up never lands
  // straight on the load-earlier cliff. The viewport is anchored across the
  // commit by trimAnchorRef — the load-earlier prepend anchor in reverse —
  // so visible content does not move. Nothing is lost: "load earlier" pages
  // the dropped rows back on demand.
  //
  // Fires only on APPEND growth (the record END advancing): a load-earlier
  // prepend is the reader ASKING for old rows, so it must never trip a trim
  // however large it grows the window. Stands down whenever the scroll
  // geometry is spoken for — morph flights (clones measured their slots),
  // glides/jumps/parks (a scripted scroll is mid-travel), a pending
  // topic-jump poll (its anchor row must stay mounted), an armed headroom
  // reservation (a content-coordinate total the trim would shove), or an
  // unconsumed prepend/trim anchor. The residual unbounded case is a reader
  // camped mid-history for a whole marathon: rows from their viewport DOWN
  // to the live end can never be trimmed (the window is one contiguous
  // tail), so growth below the fold remains — this bounds everything above.
  const prevUnpinnedEndRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scroll` is the engine handle (useConversationScroll's result, stable per biome.json) passed through this hook, not a varying input
  useEffect(() => {
    const end = recordStart + record.length;
    const prevEnd = prevUnpinnedEndRef.current;
    prevUnpinnedEndRef.current = end;
    if (end <= prevEnd) return; // reset/rewind/trim/prepend — not append growth
    if (scroll.isPinned()) return; // the pinned trim above owns this
    if (record.length <= UNPINNED_TRIM_AT) return;
    if (
      scroll.isMorphInFlight() ||
      scroll.isGliding() ||
      scroll.isJumping() ||
      scroll.hasJumpPoll() ||
      scroll.hasHeadroom() ||
      prependAnchorRef.current !== null ||
      trimAnchorRef.current !== null
    ) {
      return;
    }
    const el = scroll.scrollRef.current;
    if (el === null) return;
    // Cheap pre-guard: with less than one viewport of content above the
    // fold, no margin-respecting cut exists — skip the DOM scan entirely.
    if (el.scrollTop <= el.clientHeight) return;
    const paneTop = el.getBoundingClientRect().top;
    const rows = el.querySelectorAll<HTMLElement>("[data-abs-index]");
    if (rows.length === 0) return;
    // Last user row whose top sits ≥ one viewport above the visible top.
    // Rows are in flow order, so their tops are monotonic: binary search,
    // ~10 rect reads (the TopicRail scrollspy lesson) — and at most one
    // forced layout, since nothing writes between reads.
    const limit = paneTop - el.clientHeight;
    let lo = 0;
    let hi = rows.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const row = rows[mid];
      if (row !== undefined && row.getBoundingClientRect().top <= limit) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found === -1) return;
    const cut = Number(rows[found]?.dataset.absIndex);
    if (!Number.isFinite(cut)) return;
    const trimCount = Math.min(
      cut - recordStart,
      record.length - UNPINNED_TRIM_KEEP_TAIL,
    );
    if (trimCount < UNPINNED_TRIM_MIN) return;
    trimAnchorRef.current = {
      expectFrom: recordStart,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    };
    sessionStore.trimRecordWindow(record.length - trimCount);
  }, [record, recordStart, sessionStore]);
  // Anchor consumption — the prepend consumer's mirror: the trimmed rows
  // left from ABOVE the scroll position, so scrollTop slides down by the
  // removed height in the same pre-paint pass (overflow-anchor is disabled
  // on the pane; nothing else compensates). Keyed on recordStart — a trim
  // strictly raises it, so the guard is the increase this trim caused.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scroll` is the engine handle (useConversationScroll's result, stable per biome.json) passed through this hook, not a varying input
  useLayoutEffect(() => {
    const anchor = trimAnchorRef.current;
    if (anchor === null) return;
    trimAnchorRef.current = null;
    if (recordStart <= anchor.expectFrom) return; // not this trim's commit
    const el = scroll.scrollRef.current;
    if (el === null) return;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [recordStart]);

  // A tail-shrink of the record is a rewind: the reservation belonged to the
  // withdrawn turn, so it leaves with it (review 2026-07-31 — "the headroom
  // belongs to a turn YOU sent", and that turn is gone). Left armed, the
  // spacer grew by exactly the withdrawn rows' height and the pinned follow
  // parked the view on blank pane. Layout effect: the spacer must shrink in
  // the same commit the rows unmount, not a paint later. Session switches
  // also pass through here when the next session is shorter — harmless, the
  // entrance effect below releases the extent regardless.
  const prevRecordEndRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scroll` is the engine handle (useConversationScroll's result, stable per biome.json) passed through this hook, not a varying input
  useLayoutEffect(() => {
    const end = recordStart + record.length;
    const prev = prevRecordEndRef.current;
    prevRecordEndRef.current = end;
    if (end < prev) {
      // A rewind also invalidates a still-armed load-earlier anchor (review
      // 2026-07-31): its saved geometry predates the truncation, and it can
      // survive here when the reset happens not to move recordStart (the
      // anchor-consuming effect keys on that alone). The trim anchor saves
      // the same kind of geometry — same discipline.
      prependAnchorRef.current = null;
      trimAnchorRef.current = null;
      scroll.releaseHeadroom();
    }
  }, [record, recordStart]);

  // Session-scoped transients the entrance effect predates (review
  // 2026-07-31, Class A): `jumpingRef` is cleared only by a scroll that
  // lands pinned, so a switch mid-jump or mid-park left it latched in the
  // NEW session, silently suppressing the jump chip until the reader
  // touched bottom once; the park's fallback timer could fire its
  // scrollToEndIfPinned up to ~1.5s into the next session; and a
  // load-earlier anchor that survived a failed fetch would apply its saved
  // offset against another session's geometry entirely.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the clear trigger, not an input
  useEffect(() => {
    scroll.cancelJump();
    prependAnchorRef.current = null;
    trimAnchorRef.current = null;
  }, [sessionId]);

  return { loadEarlier };
}
