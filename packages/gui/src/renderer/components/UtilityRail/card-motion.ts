import type {
  ListTransitionOpts,
  TransitionRow,
} from "../../hooks/useListTransitions.js";

/**
 * How long a finished run's card stays on screen before it slides back.
 *
 * The retract is keyed to the DISPATCH ending (its done-marker), not to the
 * last row settling: the last row can settle a beat BEFORE the marker lands,
 * and retracting on it would pull the card away at exactly the moment the
 * outcome arrives. Holding past the end also lets the reader watch the
 * finished run settle. Sized like the device card's success flash (1800ms)
 * so the card leaving and the device's 完成 flash read as one gesture.
 */
export const CARD_HOLD_MS = 1800;

/**
 * The slide-back's duration — MUST match `.plan-card`'s transform transition
 * in reference-ux.css. A card unmounts this long after `open` goes false.
 *
 * Why unmount at all, when the card is already translated off-rail with
 * `content-visibility: hidden`: that hides the CONTENTS, but the element's own
 * padding box keeps its place in the rail's flex column — measured, a
 * retracted card left 48px of dead space (28px collapsed box + the 20px flex
 * gap) hanging under the device card for the rest of the session. Unmounting
 * only AFTER the slide has finished keeps the card's content on screen
 * throughout the animation, which is why this is a second phase.
 *
 * (`.plan-card` is the rail card family's chrome — the name outlived the plan
 * card itself, ADR 0073 — ridden by the repository and trace cards.)
 */
export const CARD_SLIDE_MS = 640;

/**
 * The rail cards' row motion (ADR 0058 §5.7), shared by the repository and
 * trace cards: a row that arrives eases in where it sits, a row that leaves
 * eases out where it was. Lengths MUST match `.plan-card__row.is-entering` /
 * `.is-leaving` in reference-ux.css.
 */
export const CARD_ROW_ENTER_MS = 300;
export const CARD_ROW_LEAVE_MS = 220;

/** The trace card's ticker line easing open under the node in flight and
 *  shut under the one that just finished (2026-10-08) — MUST match
 *  `.trace-node__slot`'s transition in reference-ux.css. */
export const CARD_TICKER_MS = 260;

/** How long the node in flight keeps a ticker it lost for a moment — the
 *  ticker's call switching to a queued draft and back (lab 2026-10-08, gaps
 *  of 15–170ms) — before letting it ease shut. */
export const CARD_TICKER_HOLD_MS = 250;

/** The hook options for a card: motion off under reduced motion, and off
 *  until the card's first content has been on screen (`settled`) — the
 *  card's own slide is its entrance; the rows move for CHANGES after it. */
export function cardRowMotion(
  reduced: boolean,
  settled: boolean,
): ListTransitionOpts {
  return {
    enterMs: CARD_ROW_ENTER_MS,
    leaveMs: CARD_ROW_LEAVE_MS,
    reduced: reduced || !settled,
  };
}

/** The class a row's phase adds; "" when settled. */
export function rowPhaseClass(phase: TransitionRow<unknown>["phase"]): string {
  return phase === "enter"
    ? " is-entering"
    : phase === "leave"
      ? " is-leaving"
      : "";
}
