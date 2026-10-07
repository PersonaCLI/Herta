import { useCallback, useRef, useState } from "react";
import { useT } from "../../i18n/LocaleProvider.js";
import type { SessionStore } from "../../store/session-store.js";

/**
 * The card's 撤销 (ADR 0074 §4): take the latest turn's edits back. One at a
 * time, idle only — the same guards as the rewind, and main checks both
 * again. What came back shows on its own: main appends the `→ 系统` line to
 * the record and withdraws the offer, and the card reads both. Only a
 * refusal needs saying here.
 */
export function useUndoTurn(sessionStore: SessionStore): {
  readonly handleUndo: () => Promise<void>;
  readonly undoBusy: boolean;
} {
  const t = useT();
  const [undoBusy, setUndoBusy] = useState(false);
  const busy = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionStore is stable; `t` is the varying input
  const handleUndo = useCallback(async () => {
    if (busy.current) return;
    if (sessionStore.getSnapshot().status !== "idle") return;
    busy.current = true;
    setUndoBusy(true);
    try {
      const r = await sessionStore.undoTurnEdits("latest");
      if (r !== null && !r.ok) {
        sessionStore.setComposerNotice(t("workspace.undoFailed"));
      }
    } finally {
      busy.current = false;
      setUndoBusy(false);
    }
  }, [t]);
  return { handleUndo, undoBusy };
}
