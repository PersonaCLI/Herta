// Timing constants shared by more than one of the conversation's state
// machines — the two message morphs (useOutgoingMorph / useIncomingMorph) and
// the scroll engine's send glide (useConversationScroll). Machine-private
// timings stay with their machine. Extracted from Conversation.tsx on
// 2026-09-03 (owner's request: the file hosted five state machines); the
// public ones are re-exported from Conversation.tsx so import paths hold.

// The composer "glass" frost should only read while the bubble is lifting off
// the input — not for the bubble's whole rise. Drop it shortly after the lift
// so the composer isn't dimmed for the full travel.
export const GLASS_MS = 150;

// How long the send glide owns the scroller (turn headroom, 2026-07-29).
// Chromium's smooth scroll runs a few hundred ms for a pane-sized move; this
// is the outer bound after which control returns to geometry and the landing
// is re-asserted.
export const GLIDE_WINDOW_MS = 700;
/** Travel time of the outgoing send rise. The page's climb into the reserved
 *  room waits for this flight to land (2026-07-30), so the send's fallback
 *  release has to outlast it — hence a named constant rather than a literal at
 *  the `rise.start` call. */
export const OUTGOING_FLIGHT_MS = 860;

/** How long the PARKED clone holds after landing before the swap, so its
 *  flight shadows can fade out on screen (CSS `.morph-clone.is-settled`) —
 *  unmounting on the settle commit popped them off with no transition (owner
 *  2026-08-27: "the shadow suddenly disappeared"). The clone sits exactly on
 *  the slot, so the hold is invisible except for the fade. Matches
 *  `--morph-shadow-duration` in reference-ux.css. */
export const SHADOW_SETTLE_MS = 320;
