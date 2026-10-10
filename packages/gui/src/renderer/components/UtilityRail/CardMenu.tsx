import type { AutoReviewState } from "@herta/app-server";
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useT } from "../../i18n/LocaleProvider.js";
import { OVERLAY_Z, useModalOverlay } from "../../lib/overlay-stack.js";
import {
  getHoverTip,
  hideHoverTip,
  hoverTipProps,
  showHoverTip,
} from "../common/hover-tip.js";

/** Only the device card remains — the voice card was retired when the tide
 *  wave moved above the composer (glass-wave merge, 2026-07-05). */
export type CardKind = "device";

/** Render a filesystem path with a `<wbr>` break opportunity after each
 *  separator, so a long path wraps at folder boundaries instead of
 *  char-by-char. The full path is still one string in `textContent`. */
function breakablePath(path: string): JSX.Element[] {
  const parts = path.split(/(?<=[\\/])/).filter((p) => p.length > 0);
  return parts.map((part, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: positional segments of a stable path string
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 && <wbr />}
    </Fragment>
  ));
}

/** How long the copy icon reads "copied" (or "failed") before it resets. */
const COPIED_MS = 1500;

/** Copy the workspace path (owner 2026-10-08). Its tip says what happened
 *  — re-shown over the icon with the outcome, the icon turning to a check
 *  — and a write the platform refuses is said, not swallowed. */
function CopyPathButton(props: { readonly path: string }): JSX.Element {
  const t = useT();
  const [outcome, setOutcome] = useState<"idle" | "copied" | "failed">("idle");
  const label = t(
    outcome === "copied"
      ? "card.pathCopied"
      : outcome === "failed"
        ? "card.copyFailed"
        : "card.copyPath",
  );
  useEffect(() => {
    if (outcome === "idle") return;
    const id = window.setTimeout(() => {
      setOutcome("idle");
      // The outcome's tip goes with it; a tip some other element raised
      // meanwhile stays.
      if (getHoverTip()?.text === label) hideHoverTip();
    }, COPIED_MS);
    return () => window.clearTimeout(id);
  }, [outcome, label]);
  const say = (button: Element, next: "copied" | "failed"): void => {
    setOutcome(next);
    showHoverTip(
      button,
      t(next === "copied" ? "card.pathCopied" : "card.copyFailed"),
    );
  };
  return (
    <button
      type="button"
      className={`card-menu-copy${outcome === "copied" ? " is-copied" : ""}`}
      aria-label={label}
      {...hoverTipProps(label)}
      onClick={(e) => {
        const button = e.currentTarget;
        const write = navigator.clipboard?.writeText(props.path);
        if (write === undefined) {
          say(button, "failed");
          return;
        }
        void write.then(
          () => say(button, "copied"),
          () => say(button, "failed"),
        );
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {outcome === "copied" ? (
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        ) : (
          <>
            <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
            <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
          </>
        )}
      </svg>
    </button>
  );
}

/** Leave-animation duration; keep in sync with the `cardMenuOut` keyframe in
 *  reference-ux.css. The menu stays mounted this long after closing so the exit
 *  animation can play, then unmounts. */
const MENU_EXIT_MS = 120;

export interface CardMenuProps {
  readonly cardKind: CardKind;
  readonly activeWorkspace?: string;
  readonly isDefault?: boolean;
  readonly onSetWorkspace?: () => void;
  readonly onResetWorkspace?: () => void;
  /** Open the workspace folder in the OS file manager. `undefined` leaves
   *  the path as plain text (the bridge cannot open it — the demo). */
  readonly onOpenWorkspace?: () => void;
  readonly errorText?: string;
  /** Automatic review (ADR 0075, which replaced workspace trust).
   *  PRESENTATIONAL, like everything else here: DeviceCard owns the bridge
   *  and passes it down. `undefined` hides the row (the bridge lacks the
   *  surface) — that keeps this component renderable with no
   *  HertaBridgeProvider, which its own test file relies on (CI 2026-08-04). */
  readonly review?: AutoReviewState;
  readonly onSetAutoReview?: (on: boolean) => void;
  /** Fired when the menu OPENS — DeviceCard re-fetches the review state on
   *  it, so a choice made on a card mid-commission shows up without a
   *  remount. */
  readonly onOpen?: () => void;
}

export function CardMenu(props: CardMenuProps): JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // The menu itself lives OUTSIDE the card (2026-09-17): `.device-card`
  // clips its overflow for the frost and the scene, and once a switch row
  // and the then-rules list joined it, the menu ran past the card's bottom
  // edge and was cut
  // off. It is rendered through a portal at the body, fixed at the ⋯
  // button's bottom-right corner, so the card's clip never reaches it.
  const menuRef = useRef<HTMLDivElement>(null);
  const [floatStyle, setFloatStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!mounted) return undefined;
    const place = (): void => {
      const button =
        rootRef.current?.querySelector<HTMLElement>(".card-menu-button");
      if (button === null || button === undefined) return;
      const r = button.getBoundingClientRect();
      setFloatStyle({
        top: r.bottom + 4,
        right: Math.max(8, window.innerWidth - r.right),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [mounted]);

  // Tell the parent to refresh on open. Deliberately keyed on `open` alone:
  // onOpen is called for the open EDGE, and a parent that re-creates the
  // callback each render must not re-trigger a fetch.
  const onOpenRef = useRef(props.onOpen);
  onOpenRef.current = props.onOpen;
  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);
  // Only the topmost overlay owns Escape (overlay-stack.ts): closing this
  // menu must consume the keypress, not ALSO close a settings modal below it
  // or deny a pending approval.
  const isTop = useModalOverlay("card-menu", open, OVERLAY_Z.cardMenu);
  // Dismiss on an outside click or Escape — previously the menu only closed
  // by toggling the ⋯ button, so it lingered when the user clicked elsewhere.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      // The floating menu is not a DOM descendant of the button's root —
      // a click inside it must not count as outside.
      if (
        rootRef.current !== null &&
        !rootRef.current.contains(target) &&
        !(menuRef.current?.contains(target) ?? false)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && isTop) {
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, isTop]);
  // Mount/exit animation: enter is a CSS keyframe that plays on mount; on close
  // we keep the node mounted (with `is-leaving`) until the exit animation ends,
  // then unmount.
  useEffect(() => {
    if (open) {
      setMounted(true);
      return undefined;
    }
    const t = window.setTimeout(() => setMounted(false), MENU_EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open]);
  // The menu is a portal at the body, so Tab from ⋯ never reaches it: its
  // first action takes focus on open, the arrows walk the enabled buttons,
  // and a keyboard close (Escape above, Tab below) hands focus back to ⋯ —
  // as the sidebar's SessionMenu does (UX review 2026-09-22, item 25).
  // The first ITEM, not the first button: the path and its copy icon sit
  // above the items, and a focus landing on them would raise their tip the
  // moment the menu opened (the arrows still reach them).
  useEffect(() => {
    if (!open || !mounted) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>(".card-menu-item:not(:disabled)")
      ?.focus({ preventScroll: true });
  }, [open, mounted]);
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Tab") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus({ preventScroll: true });
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? []),
    ];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "ArrowDown"
        ? (at + 1) % items.length
        : (at - 1 + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  };
  // The device card becomes an actionable workspace menu only when the
  // workspace handlers are wired (DeviceCard always passes them). Without
  // them it stays a static info tooltip.
  const isWorkspaceMenu =
    props.cardKind === "device" && props.onSetWorkspace !== undefined;
  return (
    <div className="card-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="card-menu-button"
        aria-label={t("card.deviceInfoAria")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {mounted &&
        createPortal(
          isWorkspaceMenu ? (
            <div
              ref={menuRef}
              className={`card-menu-tooltip card-menu-tooltip--floating${open ? "" : " is-leaving"}`}
              style={floatStyle}
              role="menu"
              onKeyDown={onMenuKey}
            >
              <div className="card-menu-current">
                <span className="card-menu-label">
                  {props.isDefault
                    ? t("card.workspaceDefault")
                    : t("card.workspace")}
                </span>
                {/* The path opens the folder, and the icon beside it copies
                    it (owner 2026-10-08: it could be neither clicked nor
                    copied). It wraps at its separators and is always shown
                    whole, so its tip names the action, not the path. */}
                {props.activeWorkspace !== undefined &&
                props.onOpenWorkspace !== undefined ? (
                  <button
                    type="button"
                    className="card-menu-path is-action"
                    {...hoverTipProps(t("card.openFolder"))}
                    // The menu stays: the folder opens in another window,
                    // and a refusal is said here, in the error row.
                    onClick={() => props.onOpenWorkspace?.()}
                  >
                    {breakablePath(props.activeWorkspace)}
                  </button>
                ) : (
                  <span className="card-menu-path">
                    {props.activeWorkspace !== undefined
                      ? breakablePath(props.activeWorkspace)
                      : "—"}
                  </span>
                )}
                {props.activeWorkspace !== undefined && (
                  <CopyPathButton path={props.activeWorkspace} />
                )}
              </div>
              <div className="card-menu-divider" />
              <button
                type="button"
                className="card-menu-item"
                onClick={() => {
                  // Close first: "Set workspace…" opens the OS folder dialog,
                  // and a menu left hanging under it read as stuck (and invited
                  // a second click queueing a second dialog).
                  setOpen(false);
                  props.onSetWorkspace?.();
                }}
              >
                {t("card.setWorkspace")}
              </button>
              <button
                type="button"
                className="card-menu-item"
                disabled={props.isDefault === true}
                onClick={() => {
                  setOpen(false);
                  props.onResetWorkspace?.();
                }}
              >
                {t("card.resetDefault")}
              </button>
              {props.review !== undefined && (
                <>
                  <div className="card-menu-divider" />
                  <div className="card-menu-review">
                    <span className="card-menu-label">
                      {t("card.autoReview")}
                    </span>
                    <span className="card-menu-review-state">
                      {props.review.on
                        ? t("card.autoReviewOn")
                        : t("card.autoReviewOff")}
                    </span>
                    <button
                      type="button"
                      className="card-menu-item card-menu-review-toggle"
                      onClick={() =>
                        props.onSetAutoReview?.(props.review?.on !== true)
                      }
                    >
                      {props.review.on
                        ? t("card.autoReviewDisable")
                        : t("card.autoReviewEnable")}
                    </button>
                  </div>
                </>
              )}
              {props.errorText !== undefined && (
                <div className="card-menu-error" role="alert">
                  {props.errorText}
                </div>
              )}
            </div>
          ) : (
            <div
              ref={menuRef}
              className={`card-menu-tooltip card-menu-tooltip--floating${open ? "" : " is-leaving"}`}
              style={floatStyle}
              role="tooltip"
            >
              {t("card.deviceInfo")}
            </div>
          ),
          document.body,
        )}
    </div>
  );
}
