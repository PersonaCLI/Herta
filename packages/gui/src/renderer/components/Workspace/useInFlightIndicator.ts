// The in-flight indicator — one of the five state machines Conversation.tsx
// hosted; extracted on 2026-09-03 at the owner's request. Owns the shared
// lifecycle of the recap-compaction row and the galaxy-travel row: the send
// arm, the minimum-visible hold, the quiet exit fade, the one loud hide, and
// the session clear. State: `showInFlight`, `inFlightExiting`, `sendArmed`.
// Effects, in order: arm on the pendingUser edge; disarm a send that never
// became a turn; the show/hold/exit driver; the exit-fade unmount; the loud
// hide on a new send morph; the session clear. Also derives what the flow
// shows from them: `inFlightPresent` (the successor UI's gate) and
// `visibleStreamingText` (the stream held back behind a still-fading row).

import { useEffect, useRef, useState } from "react";
import type { SessionStatus } from "../../store/session-store.js";
import type { OutgoingClone } from "./useOutgoingMorph.js";

// Small grace before the galaxy row APPEARS, so a long-session recap can lead.
// The primary fix is in the backend: compaction now runs BEFORE intent-routing,
// so `recap.compaction start` fires at turn-start and (with motion) lands well
// before the ~860ms send-morph settles → the recap row leads, no flash. This
// grace is the remaining safety net for the reduced-motion path, where there is
// no send-morph to cover the few-tens-of-ms event latency. Hiding is immediate.
//
// Raised 200→400 (user 2026-07-31): a fast first token lands 300–500ms after
// the settle, and a 200ms trigger put the row up just in time to be loud-cut
// mid-entrance — the "quick flash before 处理中" report. Waits that deserve
// the row are seconds long; starting it 200ms later costs nothing.
export const GALAXY_APPEAR_DELAY_MS = 400;

// Once the in-flight indicator IS up, it stays up this long. A @板砖 turn
// whose dispatch lands quickly used to flash it for under half a second before
// the coprocessor's own row replaced it (user 2026-07-30) — too short to read,
// so it registered as a glitch rather than as a message. 800ms covers the
// row's own 450ms entrance plus enough stillness to actually read it.
//
// The hold is deliberately NOT a blanket one: see `inFlightVisible` for why a
// stream or a morph still hides it in the same render.
export const IN_FLIGHT_MIN_VISIBLE_MS = 800;

// How long the row stays mounted fading OUT after a QUIET hide (user
// 2026-07-31: the galaxy→处理中 swap was a hard same-commit switch). Matches
// the .status-row.is-exiting CSS transition. Loud hides (a stream, a morph)
// still unmount in the same render — that boundary is load-bearing for the
// incoming-rise morph measurement (bug 2026-07-10) and stays instant.
export const IN_FLIGHT_EXIT_MS = 220;

export function useInFlightIndicator(opts: {
  readonly status: SessionStatus;
  readonly streamingText: string | null;
  readonly outgoingClone: OutgoingClone | null;
  readonly backendActive: boolean;
  readonly supervisorChecking: boolean;
  readonly pendingUser: string | null;
  readonly turnFailed: boolean;
  readonly reduced: boolean;
  readonly sessionId: string | null;
}) {
  const {
    status,
    streamingText,
    outgoingClone,
    backendActive,
    supervisorChecking,
    pendingUser,
    turnFailed,
    reduced,
    sessionId,
  } = opts;

  // Both in-flight indicators — the recap-compaction row and the galaxy-travel
  // row — share ONE lifecycle. What the user sees, in order, after a send:
  //
  //   the bubble flies (send morph) → the row ("消息正在穿越银河", or the
  //   recap row while compacting) → it stays up at least
  //   IN_FLIGHT_MIN_VISIBLE_MS → it fades out → whatever comes next mounts
  //   in its place: Herta's reply bubble, the 处理中… placeholder, or the
  //   turn-failed notice.
  //
  // Owner decision 2026-08-17 ("we are mimicking sending a message to the
  // space station"): the row shows on EVERY send, for at least the minimum,
  // regardless of how fast the other side answers. Before this, the row
  // appeared only if the wait outlasted a 400 ms grace, so a fast direct
  // @板砖 turn showed it on some sends and not others; and a reply or a
  // failure took it down in the same render, so a fast one could still cut
  // it to a sub-second flash. Now every hide reason except a NEW send is
  // "quiet": the row keeps its minimum, fades, and the successor UI defers
  // on `inFlightPresent` (处理中… already did; the streaming bubble and the
  // failure row now do too — that is what keeps the 2026-07-10 morph-slot
  // invariant: the incoming-rise morph measures its landing slot only after
  // the row is gone, because the bubble is not mounted until then).
  //
  // What still does NOT show it: a send that never became a turn (no
  // DeepSeek key → the key prompt takes the message; a rejected submit that
  // hands the text back to the composer) — nothing was sent, so nothing
  // travels. A turn that fails while the bubble is still flying (a 401/402
  // comes back in a few hundred ms) DOES show it: the message went out, then
  // the reply was lost — the notice follows the fade.
  //
  // Turns that are not sends (the opening seed, an orphan reply) keep the
  // older debounce: shown after GALAXY_APPEAR_DELAY_MS only if the wait is
  // still on — there is no "send" to honour and no morph to wait behind.
  //
  // "Wait is on" gates on "turn in flight" (status !== "idle"), NOT
  // status === "thinking" (bug 3, 2026-07-09): after a @板砖 run's
  // done-marker the turn stays in flight while Herta's synthesis completion
  // generates — often the longest silent wait of a delegation turn — but
  // `status` is a STALE "speaking" from the pre-dispatch speech.
  const inFlightSettled =
    status !== "idle" &&
    streamingText === null &&
    outgoingClone === null &&
    !backendActive &&
    !supervisorChecking;
  const [showInFlight, setShowInFlight] = useState(false);
  /** When the row actually became visible — the clock the minimum-visible hold
   *  is measured from. Null whenever it is down. */
  const inFlightShownAtRef = useRef<number | null>(null);
  /** True while the row is fading OUT after a quiet hide (user 2026-07-31:
   *  the swap to 处理中 was a hard same-commit switch). The row stays mounted
   *  without `is-shown` for IN_FLIGHT_EXIT_MS, then unmounts; the successor
   *  UI defers until the fade is done so the two hand off in place instead
   *  of stacking. */
  const [inFlightExiting, setInFlightExiting] = useState(false);
  /** A send is ARMED from the moment the user's message leaves the composer
   *  (the pendingUser echo appears) until the row it guarantees is up, or
   *  until it turns out no turn ever started. See the block comment. */
  const [sendArmed, setSendArmed] = useState(false);
  const prevPendingUserForArm = useRef<string | null>(null);
  useEffect(() => {
    const appeared =
      prevPendingUserForArm.current === null && pendingUser !== null;
    prevPendingUserForArm.current = pendingUser;
    if (appeared) setSendArmed(true);
  }, [pendingUser]);
  // A send that never became a turn: the echo is gone, nothing is in flight,
  // nothing failed — the key prompt took the message, or the submit was
  // rejected and the text went back to the composer. Disarm; no row.
  // (Ordering note: a REAL turn's status goes non-idle within milliseconds of
  // the send — the lifecycle event precedes the user block by the whole
  // router phase — so an idle status with the echo gone is not a race.)
  useEffect(() => {
    if (sendArmed && pendingUser === null && status === "idle" && !turnFailed) {
      setSendArmed(false);
    }
  }, [sendArmed, pendingUser, status, turnFailed]);
  /** The armed row may appear: the send morph has settled (or there was
   *  none) and the turn is real — in flight, or already failed. */
  const armedShow =
    sendArmed && outgoingClone === null && (status !== "idle" || turnFailed);
  useEffect(() => {
    const showNow = (): void => {
      inFlightShownAtRef.current = Date.now();
      setInFlightExiting(false); // a re-show mid-fade resumes the row
      setShowInFlight(true);
      // The send's promise is kept the moment the row is up — disarm HERE,
      // not when the timer is armed: a re-run of this effect (the wait-is-on
      // predicate flipping while the reduced-motion grace runs) cancels the
      // timer, and a still-armed send simply re-arms it.
      setSendArmed(false);
    };
    const shownAt = inFlightShownAtRef.current;
    if (shownAt === null) {
      // ── Row is down. Should it come up? ──
      if (armedShow) {
        // A send: show now (the morph already gave the recap event its lead;
        // under reduced motion there is no morph, so give it the same small
        // grace the non-send path uses — the minimum still applies after).
        if (!reduced) {
          showNow();
          return;
        }
        const id = window.setTimeout(showNow, GALAXY_APPEAR_DELAY_MS);
        return () => window.clearTimeout(id);
      }
      if (inFlightSettled) {
        // Not a send (opening / orphan reply): only if the wait outlasts the
        // grace — nothing promised a row here.
        const id = window.setTimeout(showNow, GALAXY_APPEAR_DELAY_MS);
        return () => window.clearTimeout(id);
      }
      setShowInFlight(false);
      return;
    }
    // ── Row is up. ──
    if (inFlightSettled) {
      // Its hide condition reversed inside the hold (a supervisor check
      // ending, a backend blip): keep it, keep its clock — the effect cleanup
      // already disarmed the pending exit.
      setInFlightExiting(false);
      setShowInFlight(true);
      return;
    }
    // The wait is over. If the row has not had its minimum yet, hold it for
    // the remainder instead of yanking it; either way it leaves through the
    // fade (reduced motion skips the fade — there is no transition to play).
    const beginExit = (): void => {
      // A hold timer can outlive the row: this effect doesn't re-run on a
      // session switch (settled is false on both sides of the reset) or on a
      // loud hide, and both clear the shown clock. Pre-exit-fade the stale
      // fire only re-wrote false state; entering the fade here would render
      // a 220ms ghost row in whatever context came next.
      if (inFlightShownAtRef.current === null) return;
      inFlightShownAtRef.current = null;
      setShowInFlight(false);
      if (!reduced) setInFlightExiting(true);
    };
    const remaining = IN_FLIGHT_MIN_VISIBLE_MS - (Date.now() - shownAt);
    if (remaining <= 0) {
      beginExit();
      return;
    }
    const id = window.setTimeout(beginExit, remaining);
    return () => window.clearTimeout(id);
  }, [inFlightSettled, armedShow, reduced]);
  // End of the exit fade → unmount. Keyed on the phase flag alone; a loud
  // event mid-fade clears the flag through the watcher below and this timer's
  // cleanup disarms it.
  useEffect(() => {
    if (!inFlightExiting) return;
    const id = window.setTimeout(
      () => setInFlightExiting(false),
      IN_FLIGHT_EXIT_MS,
    );
    return () => window.clearTimeout(id);
  }, [inFlightExiting]);
  // The one LOUD hide: a NEW send morph (the composer unlocks at idle, so a
  // fast next send can catch the previous row still holding or fading). The
  // new bubble's flight owns the screen; the row goes down in the same
  // render (`inFlightVisible` below) and this clears its state so the hold
  // cannot resurface it. The new send's own arm brings the row back at its
  // settle. (Streams and failures used to be loud too — see the block
  // comment for why they now wait out the minimum instead.)
  useEffect(() => {
    if (outgoingClone === null) return;
    if (!showInFlight && !inFlightExiting) return;
    inFlightShownAtRef.current = null;
    setShowInFlight(false);
    setInFlightExiting(false);
  }, [outgoingClone, showInFlight, inFlightExiting]);
  // The hold has no session identity (Class A, 2026-07-24 audit):
  // Conversation stays mounted across a switch, `inFlightSettled` is false on
  // both sides of the reset, and the loud watcher above sees only quiet in
  // the new session — so a hold armed by a fast turn-end rode into the next
  // session's entrance cascade for up to its remainder (review 2026-07-31).
  // The stale timer stays armed but only re-writes the same false state. The
  // send arm goes with it: the send belonged to the session you left.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the clear trigger, not an input
  useEffect(() => {
    inFlightShownAtRef.current = null;
    setShowInFlight(false);
    setInFlightExiting(false);
    setSendArmed(false);
    prevPendingUserForArm.current = null;
  }, [sessionId]);
  /** Is an in-flight row on screen right now? `showInFlight` is the whole
   *  story except for the one loud hide, which must be render-synchronous:
   *  a new send morph takes the row down in the same render (the state
   *  clears one commit later through the watcher above). */
  const inFlightVisible = showInFlight && outgoingClone === null;
  /** The exit fade, with the same render-synchronous loud-hide guard. */
  const inFlightExitingVisible = inFlightExiting && outgoingClone === null;
  /** Row mounted at all — visible or fading out. The successor UI (处理中…,
   *  the streaming bubble, the failure notice) defers on THIS, not on
   *  `inFlightVisible`, so nothing ever mounts under a still-fading row.
   *  For the streaming bubble that is also the 2026-07-10 morph-slot
   *  invariant: the incoming-rise morph measures its landing slot at mount,
   *  which now happens only after the row is gone. */
  const inFlightPresent = inFlightVisible || inFlightExitingVisible;
  /** The stream as the FLOW shows it: held back (null) while an in-flight
   *  row is still on screen, so Herta's reply enters after the row's fade
   *  instead of cutting it. The store's `streamingText` (status, device
   *  state, the wait-is-over signal above) is untouched — only the bubble
   *  and its rise morph wait. The reveal is paced anyway; it starts with a
   *  small backlog and types it out. */
  const visibleStreamingText = inFlightPresent ? null : streamingText;

  return {
    showInFlight,
    inFlightExiting,
    sendArmed,
    inFlightPresent,
    inFlightExitingVisible,
    visibleStreamingText,
  };
}
