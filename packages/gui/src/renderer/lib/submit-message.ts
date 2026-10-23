import type { HertaBridge, StagedImageInfo } from "../ipc/bridge-types.js";
import type { SessionStore } from "../store/session-store.js";
import type { PagePick } from "./file-mention.js";
import { journeyMark, journeyMarkAfterPaint } from "./journey.js";

/**
 * Send a user message: optimistically echo it, then dispatch to the backend.
 * If the backend reports no DeepSeek key is set (`needsKey`), open the no-key
 * onboarding card holding this text (the saved key re-submits it). Shared by
 * the Composer and the KeyPrompt's re-send so the no-key handling lives in one
 * place.
 *
 * `submitText` resolves at TURN END for a real turn (so the `.then` lands late
 * and is a no-op by then — the real user block long since replaced the echo),
 * but resolves IMMEDIATELY in the no-key case (the session pre-checks the key
 * before running anything).
 */
export function submitMessage(
  bridge: HertaBridge,
  store: SessionStore,
  text: string,
  /** Pictures staged in the composer that ride THIS message (ADR 0048 §4).
   *  Their record blocks land right after the user block. The full infos
   *  (not just ids) so the optimistic echo can show them, and so the no-key
   *  and rejection paths can hand them back — their staged copies survive
   *  both (only a successful submit's `commit` consumes them). */
  staged?: readonly StagedImageInfo[],
  /** Where the outgoing clone lifts off from, in viewport pixels, when the
   *  message did not leave the composer's input — a held message (ADR 0063)
   *  flies from its own card. Absent: the composer's input, as ever. */
  launch?: { readonly left: number; readonly top: number },
  /** Paths mentioned with the composer's `@` (ADR 0072 amendment
   *  2026-10-20): recorded on the user block, drawn as chips. */
  mentions?: readonly string[],
  /** Elements picked on the page (ADR 0083 §4): their lines are in the
   *  text; the user block records them, drawn as chips. */
  picks?: readonly PagePick[],
): void {
  journeyMark("send:start");
  // Armed BEFORE the echo lands: the conversation's outgoing morph reads it
  // on the same edge that mounts the flying clone.
  store.armLaunch(launch ?? null);
  store.markPendingUser(text, staged, mentions, picks);
  journeyMarkAfterPaint("send:echo-painted");
  const ids =
    staged !== undefined && staged.length > 0
      ? staged.map((s) => s.id)
      : undefined;
  bridge
    .submitText(
      text,
      ids,
      mentions !== undefined && mentions.length > 0 ? mentions : undefined,
      picks !== undefined && picks.length > 0 ? picks : undefined,
    )
    .then(
      (result) => {
        if (result && "needsKey" in result) {
          store.requestKeyPrompt(text, staged);
        }
      },
      () => {
        // Rejection path (audit 2026-07-10): `session.submitText` can throw the
        // single-turn invariant BEFORE emitting any lifecycle event (e.g. the
        // narrow idle-frame window while the opening seed / orphan-reply turn
        // is claiming the session), so no turn.started/failed safety net will
        // ever clear the optimistic echo — the phantom user bubble stuck until
        // the next successful turn. Withdraw the echo and restore the text to
        // the composer (pictures included) so nothing the user staged is lost.
        store.withdrawPendingUser(text, staged);
      },
    );
}
