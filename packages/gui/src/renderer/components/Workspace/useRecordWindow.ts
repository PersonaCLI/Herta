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
import {
  RECORD_WINDOW_TRIM_AT,
  RECORD_WINDOW_WEIGHT,
  recordWeight,
  turnStartAtOrBefore,
  windowStart,
} from "@herta/core/record-window";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { type SessionStore, shownWindow } from "../../store/session-store.js";
import type { ConversationScroll } from "./useConversationScroll.js";

// Unpinned live-window trim (2026-08-25). Deliberately laxer than the pinned
// trim: the reader is IN this history, so trims should be rare and only ever
// claim rows provably off-screen above. Begin considering a cut past this
// window weight (`@herta/core/record-window`: what the chat draws, not how
// many rows 板砖 wrote)…
export const UNPINNED_TRIM_AT = 5000;
/** …never cut into the newest window (mirror of the pinned tail bound —
 *  scrolling back down must land on real history, not a paging button), and
 *  don't bother for cuts smaller than this many blocks (each trim costs a
 *  geometry read and a full-window commit; tiny ones would churn per
 *  append). */
export const UNPINNED_TRIM_MIN = 50;

export function useRecordWindow(opts: {
  readonly scroll: ConversationScroll;
  readonly sessionStore: SessionStore;
  readonly record: TerminalRecord;
  readonly recordStart: number;
  readonly sessionId: string | null;
  /** Counts returns to the latest (the store's `latestLandings`). */
  readonly latestLandings: number;
}): {
  readonly loadEarlier: () => void;
  readonly loadLater: () => void;
  readonly backToLatest: () => void;
} {
  const {
    scroll,
    sessionStore,
    record,
    recordStart,
    sessionId,
    latestLandings,
  } = opts;

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
  // The engine's predicates, intents and scroll anchor are stable (useCallback
  // with fixed deps / a ref): listing the ones each effect uses satisfies the
  // exhaustive-deps rule without adding a trigger anywhere.
  const {
    scrollRef,
    releasePin,
    isPinned,
    isMorphInFlight,
    isGliding,
    isJumping,
    hasJumpPoll,
    hasHeadroom,
    armHeadroomRebase,
    releaseHeadroom,
    rePin,
    scrollToBottom,
  } = scroll;
  const loadEarlier = useCallback((): void => {
    const el = scrollRef.current;
    prependAnchorRef.current =
      el === null
        ? null
        : {
            expectFrom: shownWindow(sessionStore.getSnapshot()).start,
            scrollHeight: el.scrollHeight,
            scrollTop: el.scrollTop,
          };
    // Reading older history: drop the pin so the append-follow effect can't
    // yank the view to the bottom when the prepend lands.
    releasePin();
    void sessionStore.loadOlderBlocks();
  }, [sessionStore, scrollRef, releasePin]);
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (anchor === null) return;
    prependAnchorRef.current = null;
    if (recordStart >= anchor.expectFrom) return; // not this click's prepend
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [recordStart, scrollRef]);

  // ── A window of history (owner 2026-11-12) ──────────────────────────────
  // After a far jump the chat shows a window of history in place of the
  // trailing one. Reading on from it pages LATER blocks in: they land below
  // the fold, so nothing has to be anchored, but the pin is dropped first so
  // the follow does not carry the reader to the end of the page they asked
  // for.
  const loadLater = useCallback((): void => {
    releasePin();
    void sessionStore.loadLaterBlocks();
  }, [sessionStore, releasePin]);
  // The chip's click while a window of history is on screen: the store
  // shows the trailing window again, and the landing below takes the reader
  // to its end.
  const backToLatest = useCallback((): void => {
    sessionStore.returnToLatest();
  }, [sessionStore]);
  // Each return lands pinned at the bottom, the way a session opens: the
  // window that was on screen is gone, so there is no place to keep. Layout
  // effect, so the swap and the landing are one paint. A session switch
  // re-baselines without landing; the entrance owns that.
  const landedRef = useRef<{ sid: string | null; n: number }>({
    sid: sessionId,
    n: latestLandings,
  });
  useLayoutEffect(() => {
    const prev = landedRef.current;
    landedRef.current = { sid: sessionId, n: latestLandings };
    if (prev.sid !== sessionId || latestLandings <= prev.n) return;
    prependAnchorRef.current = null;
    trimAnchorRef.current = null;
    rePin();
    scrollToBottom();
  }, [latestLandings, sessionId, rePin, scrollToBottom]);

  // Live-window trim (audit T3.5): live appends grow the windowed record
  // without bound — the tail bound applies only to reset/open payloads — so
  // a marathon sitting climbs mounted DOM rows and per-commit reconcile cost
  // forever. While the reader is PINNED at the bottom, drop the window back
  // to the tail bound once it runs well past it (hysteresis, not a per-block
  // slice): the removed rows sit far above the fold, the browser clamps
  // scrollTop at the shrunken bottom (still pinned), and "load earlier" pages
  // them back on demand. Weighed by what the chat draws, and cut at a turn
  // (ADR 0085 amendment 2026-11-05): counted in blocks, this folded a short
  // conversation the moment its runs passed 260 rows. Never
  // trims under an unpinned reader (they may be reading those rows — the
  // geometry-guarded sibling below owns that case) or while a morph clone
  // is measuring row slots (a shrinking flow would move its landing slot —
  // the same bug class the morphs just escaped).
  useEffect(() => {
    if (!isPinned() || isMorphInFlight()) return;
    if (recordWeight(record) <= RECORD_WINDOW_TRIM_AT) return;
    const cut = windowStart(record, RECORD_WINDOW_WEIGHT);
    if (cut === 0) return; // one long turn: nothing to cut at
    // An armed reservation is a content-coordinate total; trimming rows
    // above it without sliding it down converts their height into spacer,
    // shoving the pinned view (streaming reply included) off the top
    // (review 2026-07-31). The height isn't knowable until the shrunken
    // flow lays out, so flag the next sync to rebase — the spacer keeps
    // its current size across the trim.
    armHeadroomRebase();
    sessionStore.trimRecordWindow(record.length - cut);
  }, [record, sessionStore, isPinned, isMorphInFlight, armHeadroomRebase]);

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
  useEffect(() => {
    const end = recordStart + record.length;
    const prevEnd = prevUnpinnedEndRef.current;
    prevUnpinnedEndRef.current = end;
    if (end <= prevEnd) return; // reset/rewind/trim/prepend — not append growth
    if (isPinned()) return; // the pinned trim above owns this
    if (recordWeight(record) <= UNPINNED_TRIM_AT) return;
    if (
      isMorphInFlight() ||
      isGliding() ||
      isJumping() ||
      hasJumpPoll() ||
      hasHeadroom() ||
      prependAnchorRef.current !== null ||
      trimAnchorRef.current !== null
    ) {
      return;
    }
    const el = scrollRef.current;
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
    // Talk is a bubble too: back to the turn that holds it, so no run is cut.
    const trimCount = turnStartAtOrBefore(
      record,
      Math.min(cut - recordStart, windowStart(record, RECORD_WINDOW_WEIGHT)),
    );
    if (trimCount < UNPINNED_TRIM_MIN) return;
    trimAnchorRef.current = {
      expectFrom: recordStart,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
    };
    sessionStore.trimRecordWindow(record.length - trimCount);
  }, [
    record,
    recordStart,
    sessionStore,
    scrollRef,
    isPinned,
    isMorphInFlight,
    isGliding,
    isJumping,
    hasJumpPoll,
    hasHeadroom,
  ]);
  // Anchor consumption — the prepend consumer's mirror: the trimmed rows
  // left from ABOVE the scroll position, so scrollTop slides down by the
  // removed height in the same pre-paint pass (overflow-anchor is disabled
  // on the pane; nothing else compensates). Keyed on recordStart — a trim
  // strictly raises it, so the guard is the increase this trim caused.
  useLayoutEffect(() => {
    const anchor = trimAnchorRef.current;
    if (anchor === null) return;
    trimAnchorRef.current = null;
    if (recordStart <= anchor.expectFrom) return; // not this trim's commit
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  }, [recordStart, scrollRef]);

  // A tail-shrink of the record is a rewind: the reservation belonged to the
  // withdrawn turn, so it leaves with it (review 2026-07-31 — "the headroom
  // belongs to a turn YOU sent", and that turn is gone). Left armed, the
  // spacer grew by exactly the withdrawn rows' height and the pinned follow
  // parked the view on blank pane. Layout effect: the spacer must shrink in
  // the same commit the rows unmount, not a paint later. Session switches
  // also pass through here when the next session is shorter — harmless, the
  // entrance effect below releases the extent regardless.
  const prevRecordEndRef = useRef(0);
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
      releaseHeadroom();
    }
  }, [record, recordStart, releaseHeadroom]);

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

  return { loadEarlier, loadLater, backToLatest };
}
