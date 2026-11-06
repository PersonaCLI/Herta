import { useCallback } from "react";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type { SessionStore } from "../../store/session-store.js";

/**
 * The card's 撤销 (ADR 0074 §4): take the latest turn's edits back. One at a
 * time, idle only — the same guards as the rewind, and main checks both
 * again. What came back shows on its own: main appends the `→ 系统` line to
 * the record and withdraws the offer, and the card reads both. Only a
 * refusal needs saying here. The chat's row and the 完整记录 tab both offer
 * it, so the busy flag is the store's: with one each, the second press was
 * answered `turn_in_progress` and read as a failed undo (N8).
 */
export function useUndoTurn(sessionStore: SessionStore): {
  readonly handleUndo: () => Promise<void>;
  readonly undoBusy: boolean;
} {
  const t = useT();
  const undoBusy = useSessionSelector((s) => s.undoBusy);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionStore is stable; `t` is the varying input
  const handleUndo = useCallback(async () => {
    const now = sessionStore.getSnapshot();
    if (now.undoBusy || now.rewindUndo === "busy" || now.status !== "idle") {
      return;
    }
    sessionStore.setUndoBusy(true);
    try {
      const r = await sessionStore.undoTurnEdits("latest");
      if (r !== null && !r.ok) {
        sessionStore.setComposerNotice(t("workspace.undoFailed"));
      }
    } finally {
      sessionStore.setUndoBusy(false);
    }
  }, [t]);
  return { handleUndo, undoBusy };
}
