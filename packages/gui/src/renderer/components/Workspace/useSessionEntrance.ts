// The session-switch entrance: landing (re-pin at the bottom, or leave the
// landing to a requested search jump), dropping the leaving session's turn
// travel, and the staggered fade-in of the visible rows. Extracted from
// Conversation.tsx on 2026-09-03 (owner's request: the file hosted five state
// machines). One LAYOUT effect, the last in Conversation's order, plus the
// entrance timer it self-clears.

import { useLayoutEffect, useRef } from "react";
import type { SessionStore } from "../../store/session-store.js";
import {
  ENTRANCE_DURATION_MS,
  ENTRANCE_STAGGER_MS,
  planStaggerEntrance,
} from "./conversation-entrance.js";
import type { ConversationScroll } from "./useConversationScroll.js";

export function useSessionEntrance(opts: {
  readonly scroll: ConversationScroll;
  readonly sessionId: string | null;
  readonly reduced: boolean;
  readonly sessionStore: SessionStore;
}): void {
  const { scroll, sessionId, reduced, sessionStore } = opts;

  // Session-switch stagger entrance (SPEC 2026-06-20-session-switch-transition).
  // On a genuine switch between two sessions, the newly-loaded conversation's
  // VISIBLE rows settle in with a staggered fade + upward drift; rows scrolled
  // out of view above just snap to their final state — no point animating unseen
  // content, and it keeps the cascade short on long threads. Runs on a switch
  // between sessions AND on entering one from the connect screen; skipped on a
  // blanking reset (→ no session), a same-session re-open, and reduced motion.
  // Imperative because it needs post-layout measurement of which rows
  // are visible; it doesn't fight React (the styles sit on record rows that have
  // no `style` prop, and self-clear once the cascade finishes).
  const prevSessionId = useRef<string | null>(null);
  const entranceTimer = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scroll` is the engine handle (useConversationScroll's result, stable per biome.json) passed through this hook, not a varying input
  useLayoutEffect(() => {
    const prev = prevSessionId.current;
    prevSessionId.current = sessionId;
    // Animate any change INTO a session — a switch between two sessions, OR
    // entering one from the connect screen (prev null → session). Skip a
    // blanking reset (→ no session) and a same-session re-open.
    if (sessionId === null || prev === sessionId) {
      // A blanking reset (current session deleted → connect page) still
      // clears the pin/chip state — Conversation stays mounted behind the
      // connect screen, so a live 回到底部 chip otherwise floats over it
      // (user bug 2026-07-24). No scroll or entrance cascade: there is no
      // session to land in.
      if (sessionId === null && prev !== null) {
        scroll.rePin();
        scroll.dropTurnTravel();
        scroll.cancelJumpPoll();
      }
      return;
    }
    // Any session change cancels a topic-jump poll left over from the one we
    // are leaving (audit 2026-07-24, M4).
    scroll.cancelJumpPoll();
    // Entering a session normally lands pinned at the bottom (even under
    // reduced motion, where the entrance cascade below is skipped) — UNLESS
    // it was opened from a search hit, which asked for a specific turn
    // (2026-07-27). Both used to run: this re-pinned and scrolled to the end
    // while the jump scrolled elsewhere from an async continuation, so the
    // landing came down to which won.
    //
    // The store read is reliable because the request is issued BEFORE
    // `openSession` (see SessionItem) and `onReset` preserves it — so by the
    // time this fires on the session change, the intent is already recorded.
    const jumpRequested =
      sessionStore.getSnapshot().pendingJump?.sessionId === sessionId;
    // The headroom belongs to a turn YOU sent, in the session you sent it
    // from. Arriving somewhere new lands at the real bottom, as it always
    // has — reserving space under someone else's last turn would read as a
    // rendering fault, not as room for an answer.
    //
    // A climb owed to a flight in the session we are LEAVING must not fire in
    // the one we are entering — the flight's clone unmounts on the switch, and
    // its settle effect would otherwise travel this session's scroller. A
    // climb already RUNNING is worse: flags alone don't stop its rAF loop.
    scroll.dropTurnTravel();
    if (!jumpRequested) {
      scroll.rePin();
      scroll.scrollToBottom();
    }
    if (reduced) return;
    const container = scroll.scrollRef.current;
    if (container === null) return;
    const rowEls = Array.from(
      container.querySelectorAll<HTMLElement>(
        ".message-row, .activity-line-group",
      ),
    );
    if (rowEls.length === 0) return;
    if (entranceTimer.current !== null) {
      window.clearTimeout(entranceTimer.current);
      entranceTimer.current = null;
    }
    // Rows are reused across switches (keyed by index): clear any stale entrance
    // styles before measuring. The getBoundingClientRect reads below force the
    // reflow that lets re-applying the same keyframe restart cleanly.
    for (const el of rowEls) {
      el.style.animation = "";
      el.style.animationDelay = "";
    }
    const cr = container.getBoundingClientRect();
    const plan = planStaggerEntrance({
      rows: rowEls.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top - cr.top, bottom: r.bottom - cr.top };
      }),
      viewport: { top: 0, bottom: cr.height },
      staggerMs: ENTRANCE_STAGGER_MS,
    });
    let maxDelay = 0;
    const animated: HTMLElement[] = [];
    plan.forEach((delay, idx) => {
      const el = rowEls[idx];
      if (el === undefined) return;
      el.style.animation = `conv-switch-in ${ENTRANCE_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both`;
      el.style.animationDelay = `${delay}ms`;
      animated.push(el);
      if (delay > maxDelay) maxDelay = delay;
    });
    entranceTimer.current = window.setTimeout(
      () => {
        for (const el of animated) {
          el.style.animation = "";
          el.style.animationDelay = "";
        }
        entranceTimer.current = null;
      },
      ENTRANCE_DURATION_MS + maxDelay + 80,
    );
    return () => {
      if (entranceTimer.current !== null) {
        window.clearTimeout(entranceTimer.current);
        entranceTimer.current = null;
      }
    };
    // sessionStore is provider-stable; it is a dep only because the
    // stand-down check reads the pending jump straight off the snapshot.
  }, [sessionId, reduced, sessionStore]);
}
