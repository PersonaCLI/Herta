// The supervisor judgment hint — one of the five state machines
// Conversation.tsx hosted; extracted on 2026-09-03 at the owner's request.
// Shows the 伽马风暴 row only when a judgment is pending AND the visible
// reveal has actually stalled. State: `showSupervisorHold` plus the stall
// clock (`lastGrowRef`). Effect: the poll while a judgment is pending. Also
// owns `onRevealGrow`, the reveal's growth signal, since that is what stamps
// the clock (it then hands the growth to the scroll engine).

import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationScroll } from "./useConversationScroll.js";

// How long the VISIBLE reveal must sit still (no revealed-text growth) during
// a pending supervisor judgment before the 伽马风暴 row appears. Keyed to the
// reveal, not the judgment (user 2026-07-10): the supervisor starts the moment
// generation completes, but the paced reveal often has a BACKLOG still typing
// — visible progress needs no explanation. Only a genuinely stuck cursor earns
// the hint. Hiding is immediate on the verdict.
export const SUPERVISOR_HINT_DELAY_MS = 2000;
// Poll cadence for the stall check above (a ref timestamp, not state, tracks
// growth — polling avoids per-frame re-renders).
const SUPERVISOR_HOLD_POLL_MS = 250;

export function useSupervisorHold(opts: {
  readonly supervisorChecking: boolean;
  readonly scroll: ConversationScroll;
}) {
  const { supervisorChecking, scroll } = opts;

  // Supervisor judgment hint (bug 4, 2026-07-09; stall-gated 2026-07-10):
  // while the verdict is pending the paced reveal HOLDS its tail, so a slow
  // judgment reads as a frozen cursor. The row shows only when the judgment
  // is pending AND the visible reveal has actually STALLED — the supervisor
  // runs while the reveal is often still draining its backlog, and a moving
  // cursor needs no explanation. `lastGrowRef` is stamped by every reveal
  // growth frame (see onGrow below); a cheap poll compares it against the
  // stall window. Hiding is immediate on phase:end (verdict landed → the
  // reveal resumes or retracts).
  const lastGrowRef = useRef(0);
  const [showSupervisorHold, setShowSupervisorHold] = useState(false);
  useEffect(() => {
    if (!supervisorChecking) {
      setShowSupervisorHold(false);
      return;
    }
    // Start the stall clock at judgment start, not at the last pre-judgment
    // growth — the check often begins while the reveal is mid-drain.
    lastGrowRef.current = Date.now();
    const id = window.setInterval(() => {
      setShowSupervisorHold(
        Date.now() - lastGrowRef.current >= SUPERVISOR_HINT_DELAY_MS,
      );
    }, SUPERVISOR_HOLD_POLL_MS);
    return () => window.clearInterval(id);
  }, [supervisorChecking]);
  // The reveal's growth signal: stamps the stall clock, lights the jump chip
  // for an unpinned reader, then follows the pinned autoscroll (the original
  // onGrow behavior).
  // Both engine intents are stable callbacks, so the handler keeps its
  // identity for the life of the session.
  const { noteNewBelow, scrollToEndIfPinned } = scroll;
  const onRevealGrow = useCallback((): void => {
    lastGrowRef.current = Date.now();
    noteNewBelow();
    scrollToEndIfPinned();
  }, [noteNewBelow, scrollToEndIfPinned]);

  return { showSupervisorHold, onRevealGrow };
}
