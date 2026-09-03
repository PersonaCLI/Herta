// Attachment take-back (ADR 0033): the per-path removal factory the activity
// rows' ✕ control calls. Extracted from Conversation.tsx on 2026-09-03
// (owner's request: the file hosted five state machines). One memo; its
// identity (deps [sessionId, bridge, sessionStore, t]) is what keeps the
// activity-row memo stable between turns, unchanged.

import { useMemo } from "react";
import type { TFn } from "../../i18n/LocaleProvider.js";
import type { HertaBridge } from "../../ipc/bridge-types.js";
import type { SessionStore } from "../../store/session-store.js";

export type RemoveAttachmentFactory = (path: string) => () => void;

export function useRemoveAttachment(opts: {
  readonly sessionId: string | null;
  readonly bridge: HertaBridge;
  readonly sessionStore: SessionStore;
  readonly t: TFn;
}): RemoveAttachmentFactory | undefined {
  const { sessionId, bridge, sessionStore, t } = opts;

  // Attachment take-back (ADR 0033, owner 2026-08-10). Undefined while a turn
  // runs or with no session — the removal rides the same out-of-turn record
  // write as the attach, so an ✕ that could only earn a refusal is not shown
  // at all. A FACTORY per stored path so ActivityStep holds no record state;
  // memoized on the two things it closes over, keeping the rows memo stable
  // between turns.
  //
  // NOT memoized on `status` (2026-09-03): it flips at send and at turn end,
  // and a factory whose identity changed with it re-rendered EVERY
  // historical ActivityBlock twice per turn — at exactly the heaviest
  // main-thread moment the app has (see the send-morph notes in
  // useOutgoingMorph). Like `handleRewind`, the guard reads the LIVE status
  // at click time from the store, and the control's visibility mid-turn is
  // CSS (`.conversation-flow.is-busy .activity-step__remove`).
  const removeAttachmentFactory = useMemo(() => {
    if (sessionId === null) return undefined;
    return (path: string) => () => {
      if (sessionStore.getSnapshot().status !== "idle") return;
      void bridge
        .removeAttachment(sessionId, path)
        .then((r) => {
          if (!r.ok) {
            sessionStore.setComposerNotice(
              t("activity.attachment.removeFailed"),
            );
          }
        })
        .catch(() =>
          sessionStore.setComposerNotice(t("activity.attachment.removeFailed")),
        );
    };
  }, [sessionId, bridge, sessionStore, t]);

  return removeAttachmentFactory;
}
