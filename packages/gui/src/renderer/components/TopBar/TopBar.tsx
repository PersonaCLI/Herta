import { type Ref, useEffect, useRef, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useApprovalPending } from "../../hooks/useApprovalPending.js";
import {
  shallowEqualObjects,
  useSessionSelector,
} from "../../hooks/useSessionSelector.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { isRepeatClick } from "../../lib/repeat-click.js";
import { useShortcut } from "../../lib/shortcut-registry.js";
import { TitleText } from "../TitleText.js";
import { Tooltip } from "../Tooltip/Tooltip.js";
import { NewSessionIcon, PanelToggleIcon, SearchIcon } from "./icons.js";

export interface TopBarProps {
  /** Current sidebar collapsed state — drives the toggle's aria-expanded. */
  readonly collapsed: boolean;
  readonly onToggleCollapse: () => void;
  /** True while the session-search field is open — drives the active style. */
  readonly searchActive: boolean;
  readonly onToggleSearch: () => void;
  /** Forwarded to the search button so the parent can return focus to it
   *  when the search field closes. */
  readonly searchButtonRef?: Ref<HTMLButtonElement>;
}

/**
 * The persistent full-width control strip at the top of the app card. Holds
 * the panel-toggle, search, and new-session buttons, followed by the active
 * session's title (typewriter reveal via TitleText). Because it spans both
 * grid columns and lives outside the collapsing sidebar, its controls stay
 * visible when the sidebar is collapsed (no floating overlay). The bar itself
 * is a window drag region; only the buttons opt out via CSS so they stay
 * clickable.
 */
export function TopBar(props: TopBarProps): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const gatePending = useApprovalPending();
  // Double-click guard: createSession has no server-side idempotency, so two
  // rapid clicks created two sessions (racing opening voices + an orphaned
  // empty card). Latched until the create IPC settles.
  const creating = useRef(false);
  // Mid-turn guard (2026-07-12): creating a session closes — and INTERRUPTS
  // — the active one, same destructiveness as a sidebar switch, so the same
  // two-step applies: the first click mid-turn ARMS (the tooltip carries the
  // warning, the icon tints), a second click within the window proceeds.
  // Auto-disarms on the timer or when the turn ends.
  const NEW_ARM_RESET_MS = 4000;
  const turnInFlight = useSessionSelector((s) => s.status !== "idle");
  const [newArmed, setNewArmed] = useState(false);
  const newArmTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (newArmTimer.current !== null)
        window.clearTimeout(newArmTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (turnInFlight) return;
    if (newArmTimer.current !== null) {
      window.clearTimeout(newArmTimer.current);
      newArmTimer.current = null;
    }
    setNewArmed(false);
  }, [turnInFlight]);
  const armNew = (): void => {
    setNewArmed(true);
    if (newArmTimer.current !== null) window.clearTimeout(newArmTimer.current);
    newArmTimer.current = window.setTimeout(() => {
      newArmTimer.current = null;
      setNewArmed(false);
    }, NEW_ARM_RESET_MS);
  };
  /** The button's press, and Ctrl/⌘+N's (ADR 0082): the same guards. */
  const newSession = (): void => {
    if (creating.current || gatePending) return;
    if (turnInFlight && !newArmed) {
      armNew();
      return;
    }
    if (newArmTimer.current !== null) {
      window.clearTimeout(newArmTimer.current);
      newArmTimer.current = null;
    }
    setNewArmed(false);
    creating.current = true;
    // A failed create answers null (main points the window at whatever the
    // host has open); a rejected invoke is caught so it never surfaces as
    // an unhandled rejection.
    void bridge
      .createSession({})
      .catch(() => null)
      .finally(() => {
        creating.current = false;
      });
  };
  useShortcut("newSession", () => {
    newSession();
    return true;
  });
  // A tray "New Chat" was refused mid-turn (2026-07-13): main fronted the
  // window and signalled the refusal — arm the icon the way a first direct
  // click would, so the refusal explains itself here too.
  const navNewSeq = useSessionSelector((s) =>
    s.navBlock !== null && s.navBlock.target === null ? s.navBlock.seq : 0,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: seq is the trigger; the guards are read fresh
  useEffect(() => {
    if (navNewSeq === 0) return;
    if (gatePending || !turnInFlight) return;
    armNew();
  }, [navNewSeq]);
  // Deliberately NOT deriveTitle(record): the title must not echo the user's
  // first message. It shows the placeholder until the generated title lands,
  // then types it in. Selector-based so the bar doesn't re-render per delta.
  const { title, titleAnimate, sessionId } = useSessionSelector(
    (s) => ({
      title: s.title,
      titleAnimate: s.titleAnimate,
      sessionId: s.sessionId,
    }),
    shallowEqualObjects,
  );
  return (
    <div className="topbar" data-testid="topbar">
      <Tooltip
        label={t("topbar.toggleSidebar")}
        keys="toggleSidebar"
        align="start"
      >
        <button
          type="button"
          className="sidebar-header-icon"
          aria-label={t("topbar.toggleSidebar")}
          aria-expanded={!props.collapsed}
          onClick={props.onToggleCollapse}
        >
          <PanelToggleIcon />
        </button>
      </Tooltip>
      <Tooltip label={t("topbar.search")} keys="searchSessions" align="start">
        <button
          ref={props.searchButtonRef}
          type="button"
          className={`sidebar-header-icon${props.searchActive ? " is-active" : ""}`}
          aria-label={t("topbar.search")}
          onClick={props.onToggleSearch}
        >
          <SearchIcon />
        </button>
      </Tooltip>
      <Tooltip
        label={
          gatePending
            ? t("topbar.resolveApprovalFirst")
            : newArmed
              ? t("session.switchInterrupts")
              : t("topbar.newSession")
        }
        keys="newSession"
        align="start"
      >
        <button
          type="button"
          className={`sidebar-header-icon${newArmed ? " is-armed" : ""}`}
          aria-label={t("topbar.newSession")}
          disabled={gatePending}
          onClick={(e) => {
            // The second click of a double-click is never the arm's confirm:
            // it interrupted the reply the arm exists to protect (UX review
            // 2026-09-22, item 3). A fresh click after the tint confirms.
            if (isRepeatClick(e)) return;
            newSession();
          }}
        >
          <NewSessionIcon />
        </button>
      </Tooltip>
      {/* The active session's title. Rendered ONLY when there is a session —
          on the connect screen (no session) the bar shows just the controls and
          must never show an "Untitled" placeholder, which used to leak in when
          the sidebar was collapsed (user 2026-06-20). With a session it fades out
          while the sidebar is open (the title is already visible there as the
          highlighted card) and fades back in when the sidebar collapses (user
          2026-06-14). Pure visual fade (opacity); the h1 stays a navigable
          heading for screen readers. */}
      {sessionId !== null && (
        <h1 className={`topbar-title${props.collapsed ? "" : " is-tucked"}`}>
          <TitleText
            text={title ?? t("session.untitled")}
            placeholder={t("session.untitled")}
            animate={titleAnimate && title !== null}
          />
        </h1>
      )}
    </div>
  );
}
