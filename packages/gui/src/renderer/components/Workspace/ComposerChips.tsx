/**
 * How the composer draws its file chips (ADR 0072 amendment 2026-10-20):
 * the highlight layer's text with each chip in place, and a chip's menu.
 * Split out of Composer.tsx (review 2026-11-10, moved 2026-11-27); the
 * composer still owns the chips and decides when the menu opens.
 */
import { Fragment, useEffect, useRef } from "react";
import type { useT } from "../../i18n/LocaleProvider.js";
import { renderBanzhuanText } from "../../lib/banzhuan-text.js";
import { FileTypeIcon, PickIcon } from "../../lib/file-icons.js";
import type { ChipSpan, FileChip } from "../../lib/file-mention.js";

/**
 * The highlight layer's text with its chips drawn (ADR 0072 amendment
 * 2026-10-20). A chip keeps its token's glyphs — the `@` turns invisible and
 * the type icon sits over it, the name keeps its letters — so every
 * character holds the width the textarea gives it and the caret stays put.
 */
export function renderWithChips(
  text: string,
  spans: readonly ChipSpan[],
  lang: "zh" | "en",
): JSX.Element[] | ReturnType<typeof renderBanzhuanText> {
  if (spans.length === 0) return renderBanzhuanText(text, "composer", lang);
  const out: JSX.Element[] = [];
  let at = 0;
  spans.forEach((s, i) => {
    if (s.start > at) {
      out.push(
        <Fragment key={`t${at}`}>
          {renderBanzhuanText(text.slice(at, s.start), "composer", lang)}
        </Fragment>,
      );
    }
    out.push(
      <span key={`c${s.start}`} className="composer-chip" data-chip={i}>
        <span className="composer-chip__at">
          @
          {s.chip.pick !== undefined ? (
            <PickIcon className="composer-chip__icon" />
          ) : (
            <FileTypeIcon
              path={s.chip.path}
              dir={s.chip.dir === true}
              className="composer-chip__icon"
            />
          )}
        </span>
        {text.slice(s.start + 1, s.end)}
      </span>,
    );
    at = s.end;
  });
  if (at < text.length) {
    out.push(
      <Fragment key={`t${at}`}>
        {renderBanzhuanText(text.slice(at), "composer", lang)}
      </Fragment>,
    );
  }
  return out;
}

/** A file chip's menu (ADR 0072 amendment 2026-10-20): copy its path three
 *  ways, open it, show it in the file manager, or take it out. It opens
 *  above the chip — the composer sits at the window's bottom edge. Pressing
 *  an item keeps the caret where it was. */
export function ChipMenu(props: {
  readonly chip: FileChip;
  readonly left: number;
  readonly bottom: number;
  readonly copyOpen: boolean;
  readonly onCopyOpen: (open: boolean) => void;
  readonly t: ReturnType<typeof useT>;
  readonly onCopyRelative: () => void;
  readonly onCopyAbsolute: () => void;
  readonly onCopyName: () => void;
  readonly onOpenViewer?: () => void;
  readonly onOpenDefault?: () => void;
  readonly onReveal?: () => void;
  readonly onRemove: () => void;
  /** Opened from the keyboard: focus the first item (ADR 0082 §10). */
  readonly takeFocus: boolean;
  /** Close and give the caret back (Tab). */
  readonly onDismiss: () => void;
}): JSX.Element {
  const { t } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  /** → opened Copy: its first item takes the focus once it renders. */
  const intoSub = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first item takes the focus once, on open
  useEffect(() => {
    if (props.takeFocus)
      rootRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]')
        ?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!props.copyOpen || !intoSub.current) return;
    intoSub.current = false;
    subRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]')
      ?.focus({ preventScroll: true });
  }, [props.copyOpen]);
  /** The items of one menu level, in order. */
  const levelItems = (inSub: boolean): HTMLElement[] =>
    Array.from(
      (inSub ? subRef.current : rootRef.current)?.querySelectorAll<HTMLElement>(
        inSub
          ? ':scope > [role="menuitem"]'
          : ':scope > [role="menuitem"], :scope > .composer-chip-menu__sub-wrap > [role="menuitem"]',
      ) ?? [],
    );
  const item = (label: string, onPick: () => void, extra = ""): JSX.Element => (
    <button
      type="button"
      role="menuitem"
      className={`composer-chip-menu__item${extra}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
    >
      {label}
    </button>
  );
  return (
    <div
      ref={rootRef}
      className="composer-chip-menu"
      role="menu"
      aria-label={props.chip.name}
      style={{ left: props.left, bottom: props.bottom }}
      onKeyDown={(e) => {
        const target = e.target;
        const inSub =
          target instanceof Node && subRef.current?.contains(target) === true;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const items = levelItems(inSub);
          const i = items.indexOf(target as HTMLElement);
          const n = items.length;
          if (n === 0) return;
          const next = e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n;
          items[next]?.focus({ preventScroll: true });
          return;
        }
        if (e.key === "ArrowRight" && target === copyRef.current) {
          e.preventDefault();
          intoSub.current = true;
          props.onCopyOpen(true);
          return;
        }
        if (e.key === "ArrowLeft" && inSub) {
          e.preventDefault();
          props.onCopyOpen(false);
          copyRef.current?.focus({ preventScroll: true });
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          props.onDismiss();
        }
      }}
    >
      {props.chip.pick === undefined && (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: hover only opens the submenu; the Copy button inside is its keyboard and click control. */}
          <div
            className="composer-chip-menu__sub-wrap"
            onMouseEnter={() => props.onCopyOpen(true)}
            onMouseLeave={() => props.onCopyOpen(false)}
          >
            <button
              ref={copyRef}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={props.copyOpen}
              className="composer-chip-menu__item has-sub"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => props.onCopyOpen(!props.copyOpen)}
            >
              {t("composer.chip.copy")}
              <span className="composer-chip-menu__chevron" aria-hidden="true">
                ›
              </span>
            </button>
            {props.copyOpen && (
              <div
                ref={subRef}
                className="composer-chip-menu composer-chip-menu--sub"
                role="menu"
              >
                {item(t("composer.chip.copyRelative"), props.onCopyRelative)}
                {item(t("composer.chip.copyAbsolute"), props.onCopyAbsolute)}
                {item(t("composer.chip.copyName"), props.onCopyName)}
              </div>
            )}
          </div>
          {props.onOpenViewer !== undefined &&
            item(t("composer.chip.openViewer"), props.onOpenViewer)}
          {props.onOpenDefault !== undefined &&
            item(t("composer.chip.openDefault"), props.onOpenDefault)}
          {props.onReveal !== undefined &&
            item(t("composer.chip.reveal"), props.onReveal)}
          <div className="composer-chip-menu__sep" aria-hidden="true" />
        </>
      )}
      {item(t("composer.chip.remove"), props.onRemove, " is-danger")}
    </div>
  );
}
