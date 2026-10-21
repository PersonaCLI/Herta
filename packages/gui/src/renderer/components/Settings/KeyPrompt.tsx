import { useEffect, useRef, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { OVERLAY_Z, useModalOverlay } from "../../lib/overlay-stack.js";
import { submitMessage } from "../../lib/submit-message.js";

/**
 * No-key onboarding card. Appears the first time the user sends a message with
 * no DeepSeek key set (the backend returned `needsKey`, which opened it via the
 * store). Collecting a key applies it live and re-sends the held message — no
 * restart. Cancelling restores the message to the composer so it's never lost.
 */
export function KeyPrompt(): JSX.Element | null {
  const t = useT();
  const { bridge, sessionStore } = useHertaBridge();
  const needsKeyText = useSessionSelector((s) => s.needsKeyText);
  // Pictures held with the message (ADR 0048 §4): the key check refused
  // before their staged copies were consumed, so the re-send carries them
  // and a cancel returns them to the composer strip.
  const needsKeyImages = useSessionSelector((s) => s.needsKeyImages);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rejected, setRejected] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const open = needsKeyText !== null;
  // Only the topmost overlay owns Escape (see overlay-stack.ts) — this card
  // must not swallow-cancel while e.g. a card menu sits above it, nor let its
  // Escape leak to the approval panel's deny below.
  const isTop = useModalOverlay("key-prompt", open, OVERLAY_Z.keyPrompt);

  // One number per opening of the card: a verification answers into the
  // opening that asked, never a later one. The answer used to set
  // rejected/failed unconditionally — after "Not now" the next prompt opened
  // with a stale error over an empty field (UX review 2026-09-22, item 16).
  const openingSeq = useRef(0);

  // Focus the input on open; reset transient state when it closes.
  useEffect(() => {
    openingSeq.current += 1;
    if (open) {
      inputRef.current?.focus({ preventScroll: true });
    } else {
      setDraft("");
      setSaving(false);
      setFailed(false);
      setRejected(false);
    }
  }, [open]);

  // While open: Escape and an outside click both cancel (restore the held text
  // to the composer, then close). Re-runs each render so the handlers close over
  // the latest needsKeyText.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && isTop) {
        e.preventDefault();
        cancel();
      }
    };
    const onDown = (e: MouseEvent): void => {
      // App chrome is not "outside the card" (audit 2026-07-24, M1) — see
      // SettingsModal. Here the cost was higher: minimizing the window while
      // typing an API key CANCELLED the card, discarding the half-typed key
      // and dumping the held message back into the composer.
      if ((e.target as Element | null)?.closest?.(".window-controls")) return;
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        cancel();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  });

  if (!open) return null;

  function cancel(): void {
    // Read BOTH before clearKeyPrompt: the emit guard drops the images the
    // moment their carrier (needsKeyText) clears.
    const text = needsKeyText;
    const staged = needsKeyImages ?? undefined;
    sessionStore.clearKeyPrompt();
    if (text !== null) sessionStore.requestComposerDraft(text, null, staged);
  }

  function save(): void {
    const key = draft.trim();
    if (key.length === 0 || saving) return;
    const text = needsKeyText;
    const staged = needsKeyImages ?? undefined;
    const opening = openingSeq.current;
    setSaving(true);
    setFailed(false);
    setRejected(false);
    void bridge
      .setDeepSeekKey(key)
      .then((r) => {
        // The card closed (or closed and reopened) while the call was out:
        // the key was still saved, but nothing here is this answer's to set.
        if (openingSeq.current !== opening) return;
        setSaving(false);
        if (!r.ok) {
          // DeepSeek rejected the key — keep the card open so the user can fix
          // it; the held message stays put for the next attempt.
          setRejected(true);
          return;
        }
        // If the user cancelled (or a different prompt opened) DURING the
        // validation call, don't re-send: the key was still saved, but the
        // message is no longer ours to send. Compare against the live store, not
        // the render-time closure.
        if (sessionStore.getSnapshot().needsKeyText !== text) return;
        sessionStore.clearKeyPrompt();
        // Re-send the held message — the live key now lets the turn run.
        // The pictures ride it again: their staged ids are still valid.
        if (text !== null) submitMessage(bridge, sessionStore, text, staged);
      })
      .catch(() => {
        if (openingSeq.current !== opening) return;
        setFailed(true);
        setSaving(false);
      });
  }

  return (
    <div className="settings-backdrop">
      <div
        ref={cardRef}
        className="keyprompt-card"
        role="dialog"
        aria-modal="true"
        aria-label={t("keyprompt.title")}
      >
        <h2 className="keyprompt-title">{t("keyprompt.title")}</h2>
        <p className="keyprompt-body">{t("keyprompt.body")}</p>
        {/* The card asks for a key without ever saying where one comes from
            (audit BL19). Plain text, not a link: the renderer opens no
            external URLs by design, and a dead-looking anchor is worse than
            a domain the user can type. */}
        <p className="keyprompt-where">{t("keyprompt.where")}</p>
        <input
          ref={inputRef}
          type="password"
          className="settings-key-input"
          placeholder="sk-…"
          aria-label={t("deepseek.keyAria")}
          autoComplete="off"
          spellCheck={false}
          value={draft}
          disabled={saving}
          onChange={(e) => {
            setDraft(e.target.value);
            setRejected(false);
          }}
          onKeyDown={(e) => {
            // An IME's Enter confirms its candidate; it does not save
            // (ADR 0082 §11).
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
        />
        {rejected && (
          <p className="settings-note is-error">{t("deepseek.rejected")}</p>
        )}
        {failed && <p className="settings-note">{t("keyprompt.saveFail")}</p>}
        <div className="keyprompt-actions">
          <button type="button" className="keyprompt-cancel" onClick={cancel}>
            {t("keyprompt.notNow")}
          </button>
          <button
            type="button"
            className="settings-key-save"
            disabled={draft.trim().length === 0 || saving}
            onClick={save}
          >
            {saving ? t("deepseek.verifying") : t("keyprompt.saveSend")}
          </button>
        </div>
      </div>
    </div>
  );
}
