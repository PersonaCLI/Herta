import { useEffect, useRef } from "react";
import {
  SHORTCUTS,
  type ShortcutDef,
  type ShortcutGroup,
} from "../../../shared/shortcuts.js";
import type { MessageKey } from "../../i18n/keys.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { OVERLAY_Z, useModalOverlay } from "../../lib/overlay-stack.js";
import { KeyCaps } from "../common/KeyCaps.js";

/** The columns, as the owner adopted them (ADR 0082 §7). */
const COLUMNS: readonly (readonly ShortcutGroup[])[] = [
  ["sessions", "window"],
  ["composer", "approval"],
];

function Group(props: { readonly group: ShortcutGroup }): JSX.Element {
  const t = useT();
  const rows: readonly ShortcutDef[] = SHORTCUTS.filter(
    (s) => s.group === props.group,
  );
  return (
    <section className="shortcuts-group">
      <h3 className="shortcuts-group__label">
        {t(`shortcut.group.${props.group}` as MessageKey)}
      </h3>
      {rows.map((s) => (
        <div key={s.id} className="shortcuts-row">
          <span>{t(`shortcut.${s.id}` as MessageKey)}</span>
          <KeyCaps keys={s.keys} />
        </div>
      ))}
    </section>
  );
}

/**
 * The keyboard cheat sheet (ADR 0082 §7): every key the app answers, from
 * the one table. A modal card over Settings and the lightbox; Escape, Ctrl+/
 * (the dispatcher's toggle) or a click outside closes it, and the focus goes
 * back where it was.
 */
export function ShortcutsSheet(props: {
  readonly open: boolean;
  readonly onClose: () => void;
}): JSX.Element | null {
  const t = useT();
  const isTop = useModalOverlay("shortcuts", props.open, OVERLAY_Z.shortcuts);
  const cardRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  // Into the card on open; back to the opener on close.
  useEffect(() => {
    if (!props.open) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    cardRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [props.open]);

  useEffect(() => {
    if (!props.open || !isTop) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      // Nothing inside takes the focus: Tab stays on the card.
      if (e.key === "Tab") {
        e.preventDefault();
        cardRef.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, isTop]);

  if (!props.open) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop only catches a press outside the card — the pointer's way out; Escape (above) is the keyboard's
    <div
      className="shortcuts-backdrop"
      data-testid="shortcuts-sheet"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        ref={cardRef}
        className="shortcuts-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        tabIndex={-1}
      >
        <div className="shortcuts-card__head">
          <h2 id="shortcuts-title" className="shortcuts-card__title">
            {t("shortcut.title")}
          </h2>
          <span className="shortcuts-card__hint">
            {t("shortcut.hint")}
            <KeyCaps id="showShortcuts" />
          </span>
        </div>
        <div className="shortcuts-card__cols">
          {COLUMNS.map((groups) => (
            <div key={groups.join("-")}>
              {groups.map((g) => (
                <Group key={g} group={g} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
