// Rewind the latest 开拓者 turn: the withdraw animation over the tail rows,
// the session-bound truncation, and the draft restore (text + pictures) into
// the composer. Extracted from Conversation.tsx on 2026-09-03 (owner's
// request: the file hosted five state machines). No effects — one async
// handler with a re-entry guard; its identity (deps [reduced, t, lang]) is
// what the bubble-row memo keys on, unchanged.

import { useCallback, useRef } from "react";
import type { TFn } from "../../i18n/LocaleProvider.js";
import type { HertaBridge } from "../../ipc/bridge-types.js";
import { dealiasBrickDraft } from "../../lib/banzhuan-mention.js";
import type { SessionStore } from "../../store/session-store.js";
import type { ConversationScroll } from "./useConversationScroll.js";

export function useRewindTurn(opts: {
  readonly bridge: HertaBridge;
  readonly sessionStore: SessionStore;
  readonly scroll: ConversationScroll;
  readonly reduced: boolean;
  readonly t: TFn;
  readonly lang: "zh" | "en";
}): () => Promise<void> {
  const { bridge, sessionStore, scroll, reduced, t, lang } = opts;

  // Rewind the latest 开拓者 turn: play a brief withdraw animation over the tail
  // rows (latest user row + everything below it), then ask the server to truncate
  // every record store. On success the reset event shrinks the record (the rows
  // unmount) and the withdrawn user text is staged back into the composer. The
  // animation is skipped under reduced motion (the truncation still happens).
  // Re-entry guard: the handler is async (220ms animation + IPC round-trip), so a
  // double-click could fire it twice and truncate two turns. One rewind at a time.
  const rewindingRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: bridge/sessionStore/scrollRef are stable; `reduced`, `t`, and `lang` are the varying inputs
  const handleRewind = useCallback(async () => {
    if (rewindingRef.current) return;
    // Idle-only, checked HERE rather than by withholding the handler
    // (2026-07-30). The gate used to be a `canRewind` prop computed from
    // `status`, which put the turn's status in the row memo's dependencies and
    // re-rendered every row in the session on every send — for a control that
    // belongs to one row. Visibility is now CSS (`.conversation-flow.is-busy`)
    // and this is the actual guard: a live turn must not be truncated
    // underneath itself.
    if (sessionStore.getSnapshot().status !== "idle") return;
    rewindingRef.current = true;
    // Bind the destructive call to the session the user clicked in. The 220ms
    // animation below can race a sidebar session switch; both the renderer
    // check after the await AND main's sessionId match prevent the rewind
    // from truncating the newly-active session's turn.
    const clickedSessionId = sessionStore.getSnapshot().sessionId;
    let withdrawing: HTMLElement[] = [];
    try {
      if (clickedSessionId === null) return;
      const container = scroll.scrollRef.current;
      if (container !== null && !reduced) {
        const rows = Array.from(
          container.querySelectorAll<HTMLElement>(
            ".message-row, .activity-line-group",
          ),
        );
        let lastUserRow = -1;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]?.classList.contains("user-row")) {
            lastUserRow = i;
            break;
          }
        }
        if (lastUserRow !== -1) {
          withdrawing = rows.slice(lastUserRow);
          for (const el of withdrawing) el.classList.add("is-withdrawing");
          await new Promise<void>((resolve) => setTimeout(resolve, 220));
        }
      }
      if (sessionStore.getSnapshot().sessionId !== clickedSessionId) {
        // Session switched during the animation — the rows we faded belong to
        // a record that is no longer on screen; nothing to truncate here.
        return;
      }
      const result = await bridge.rewindLastTurn(clickedSessionId);
      // Re-check AFTER the await too (audit 2026-07-10): main's sessionId
      // bind makes the truncation safe, but a session switch racing the
      // invoke reply could land the withdrawn text in the NEW session's
      // composer — the store now mirrors a different session. The rewind
      // itself succeeded; only the draft staging is session-bound.
      if (sessionStore.getSnapshot().sessionId !== clickedSessionId) {
        return;
      }
      if (result.ok) {
        // The record stores the wire token @板砖; an EN user typed/saw @Brick —
        // restore the draft in the form they sent (round-trip via the
        // composer's input alias, ADR 0015 §3). The withdrawn message's
        // pictures ride along: main restaged them (captions already paid
        // for), and the draft-adoption effect puts them back in the strip.
        sessionStore.requestComposerDraft(
          dealiasBrickDraft(result.userText, lang),
          result.editedFiles ? t("workspace.editsNotReverted") : null,
          result.images,
        );
      } else {
        // Truncation didn't happen (e.g. a turn started in the gap) — un-fade the
        // rows so they don't hang in the withdrawn state. On success the rows
        // unmount with the reset, carrying the class away.
        for (const el of withdrawing) el.classList.remove("is-withdrawing");
      }
    } catch {
      // A REJECTED invoke (audit 2026-07-24, M3). The driver truncates the
      // JSONL durable-first and unguarded, so a filesystem failure (locked
      // file, full disk, read-only dir — plausible on Windows with AV or a
      // sync client) rejects here. Without this arm the tail rows kept
      // `.is-withdrawing`, whose animation ends at opacity 0 with
      // pointer-events:none — the turn stayed on screen as an invisible,
      // un-clickable gap, and only a session switch revealed it was never
      // withdrawn. React never rewrites these imperative classes (the rows
      // are memo'd), so nothing else could clean them up.
      for (const el of withdrawing) el.classList.remove("is-withdrawing");
      if (sessionStore.getSnapshot().sessionId === clickedSessionId) {
        // A silent failed rewind is indistinguishable from a no-op.
        sessionStore.requestComposerDraft(null, t("workspace.rewindFailed"));
      }
    } finally {
      rewindingRef.current = false;
    }
  }, [reduced, t, lang]);

  return handleRewind;
}
