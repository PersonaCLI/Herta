// The pinned follow's triggers and the send's landing — the two effects that
// ask the scroll engine to move on behalf of the turn. Extracted from
// Conversation.tsx on 2026-09-03 (owner's request: the file hosted five state
// machines). No state of its own: the first effect is a list of "something
// below the flow changed" triggers; the second is the send edge, whose body
// (`followSend`) lives in the engine. Both sit at their original point of
// the effect order (after the topic jump's pending-jump consumer, before the
// record-window trims).

import type { TerminalRecord } from "@herta/app-server";
import { useEffect } from "react";
import type { SessionStatus } from "../../store/session-store.js";
import type { ConversationScroll } from "./useConversationScroll.js";

export function useTurnFollow(opts: {
  readonly scroll: ConversationScroll;
  /** The outgoing morph's verdict for this send (useOutgoingMorph). */
  readonly isFlightArmed: () => boolean;
  readonly reduced: boolean;
  readonly record: TerminalRecord;
  readonly pendingUser: string | null;
  readonly status: SessionStatus;
  readonly showInFlight: boolean;
  readonly inFlightExiting: boolean;
  readonly sendArmed: boolean;
  readonly showSupervisorHold: boolean;
  readonly backendActive: boolean;
  readonly recapCompacting: boolean;
}): void {
  const {
    scroll,
    isFlightArmed,
    reduced,
    record,
    pendingUser,
    status,
    showInFlight,
    inFlightExiting,
    sendArmed,
    showSupervisorHold,
    backendActive,
    recapCompacting,
  } = opts;

  // Follow appended blocks / status rows while pinned. The per-frame reveal
  // growth is followed via StreamingReply's onGrow (this component no longer
  // re-renders per frame, so it can't watch the fill from here). EVERY
  // conditionally-mounted row below the flow needs its trigger here, or it
  // mounts below the fold on a full pane (user bug 2026-07-11: the 伽马风暴
  // hold row appeared behind the composer while the galaxy row — covered by
  // showInFlight — scrolled into view; the turn-failed row rides its
  // `status` → idle edge).
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are intentional scroll triggers, not effect inputs
  useEffect(() => {
    scroll.scrollToEndIfPinned();
  }, [
    record,
    pendingUser,
    status,
    showInFlight,
    // The row leaves on its own timer, and its removal changes the flow's
    // height like any other row's — a pinned reader must follow that too; the
    // deferred successors (处理中, the failure notice, the reply bubble) mount
    // on that same edge, and on the send arm resolving.
    inFlightExiting,
    sendArmed,
    showSupervisorHold,
    backendActive,
    recapCompacting,
  ]);

  // Sending re-pins — but only for a reader who was already AT the bottom.
  // This fires on the commit BEFORE the morph clone mounts and measures, so
  // the slot rects the rise captures are post-scroll.
  //
  // It used to re-pin unconditionally ("your own send always lands you at the
  // bottom"), which yanked the pane out from under anyone reading history: type
  // a message while scrolled up in a long thread, press send, and the view
  // teleported to the end (user 2026-08-03). Sending is not a request to stop
  // reading. Scrolled up, the send now leaves the viewport exactly where it is
  // and lights the jump-to-bottom chip instead — the reader returns when they
  // choose to, and the chip is the affordance that already exists for it.
  //
  // The body — the reading-history test, the re-pin, the headroom
  // reservation, the park-or-glide — is the engine's `followSend`; `reduced`
  // stays a dep so the effect re-runs exactly when it always did.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scroll` / `isFlightArmed` are stable handles passed through this hook; `reduced` is read inside `followSend` and keeps its place as a trigger
  useEffect(() => {
    if (pendingUser === null) return;
    scroll.followSend(isFlightArmed());
  }, [pendingUser, reduced]);
}
