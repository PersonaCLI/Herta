// Topic-rail jump / jump-to-index: land on a topic's anchoring user block
// (paging older history in first when the anchor is outside the loaded
// window), and the search-result landing that reuses it via the store's
// pending jump. Extracted from Conversation.tsx on 2026-09-03 (owner's
// request: the file hosted five state machines). Effect: consume the pending
// jump once the requested session is on screen.

import { useCallback, useEffect } from "react";
import type { SessionStore } from "../../store/session-store.js";
import type { ConversationScroll } from "./useConversationScroll.js";

export function useTopicJump(opts: {
  readonly scroll: ConversationScroll;
  readonly sessionStore: SessionStore;
  readonly reduced: boolean;
  readonly pendingJump: { sessionId: string; blockIndex: number } | null;
  readonly sessionId: string | null;
}): (anchorIndex: number) => void {
  const { scroll, sessionStore, reduced, pendingJump, sessionId } = opts;

  // ── Topic-rail jump (2026-07-12) ─────────────────────────────────────────
  // Jump to a topic's anchoring user block. The anchor may be OLDER than the
  // loaded window — page history in first (bounded; bails if a fetch makes
  // no progress). Unpins up front so the prepends' append-follow effect can't
  // yank the view to the bottom mid-jump; the jump chip is the way back down.
  // The engine's intents and its scroll anchor are stable (useCallback with
  // fixed deps / a ref), so listing them keeps `jumpToTopic` as stable as
  // before while satisfying the exhaustive-deps rule.
  const { releasePin, scrollRef, scheduleJumpPoll } = scroll;
  const jumpToTopic = useCallback(
    (anchorIndex: number): void => {
      void (async () => {
        // Session-bound (audit 2026-07-24, M4). Both halves below are async
        // continuations that re-read LIVE global state, so after a session
        // switch mid-jump they acted on the NEW session: the loop paged B's
        // history (visible jank on arrival) and the poll smooth-scrolled B to
        // an arbitrary older message, fighting the entrance effect that had
        // just pinned it. Captured identity + re-check after every await —
        // the pattern handleRewind already uses.
        const jumpSessionId = sessionStore.getSnapshot().sessionId;
        releasePin();
        let guard = 0;
        while (
          sessionStore.getSnapshot().recordStart > anchorIndex &&
          guard < 60
        ) {
          guard += 1;
          const before = sessionStore.getSnapshot().recordStart;
          await sessionStore.loadOlderBlocks(
            Math.min(500, before - anchorIndex),
          );
          if (sessionStore.getSnapshot().sessionId !== jumpSessionId) return;
          if (sessionStore.getSnapshot().recordStart >= before) return; // no progress — bail
        }
        // Scroll once the anchor row exists: immediately when it is already
        // in the DOM (the common in-window case), else poll briefly for the
        // prepend's React commit. A TIMER, deliberately not rAF: rAF never
        // fires in a hidden/background window (found live in the website
        // demo pane, where a rAF-gated jump parked forever), while timers
        // run everywhere.
        const tryScroll = (attempt: number): void => {
          // The poll outlives the click: bail the moment the session changes,
          // and keep the handle so the session-entrance effect can cancel a
          // still-pending tick (M4 — it was previously stored nowhere, so
          // nothing could stop it).
          if (sessionStore.getSnapshot().sessionId !== jumpSessionId) return;
          const el = scrollRef.current?.querySelector(
            `[data-abs-index="${anchorIndex}"]`,
          );
          if (el !== null && el !== undefined) {
            el.scrollIntoView({
              block: "start",
              behavior: reduced ? "auto" : "smooth",
            });
            return;
          }
          if (attempt < 10) {
            scheduleJumpPoll(() => tryScroll(attempt + 1), 50);
          }
        };
        tryScroll(0);
      })();
    },
    [sessionStore, reduced, releasePin, scrollRef, scheduleJumpPoll],
  );

  // Search-result landing (2026-07-27): a sidebar card that matched by CONTENT
  // asks, via the store, to land on the matched turn instead of the latest —
  // the search knew the moment and the open used to throw it away. Reuses the
  // topic jump wholesale: it already pages older blocks in, waits for the row
  // to commit, and bails on a session switch. Consumed once, then cleared, so
  // a later record change cannot re-fire it.
  useEffect(() => {
    // Only once the REQUESTED session is the one on screen: the request is
    // made before `openSession`, so consuming it unconditionally would fire
    // against the transcript still displayed and jump in the wrong session
    // (whose guard would then bail on the switch, landing nowhere).
    if (pendingJump === null || pendingJump.sessionId !== sessionId) return;
    sessionStore.clearPendingJump();
    jumpToTopic(pendingJump.blockIndex);
  }, [pendingJump, sessionId, sessionStore, jumpToTopic]);

  return jumpToTopic;
}
