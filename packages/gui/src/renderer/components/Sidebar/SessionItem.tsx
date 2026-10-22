import type { SessionMetadata } from "@herta/app-server";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useApprovalPending } from "../../hooks/useApprovalPending.js";
import { useLiveTitle } from "../../hooks/useLiveTitle.js";
import { usePresence } from "../../hooks/usePresence.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { useT } from "../../i18n/LocaleProvider.js";
import {
  aliasBanzhuanPlain,
  stripInlineCodeTicks,
} from "../../lib/banzhuan-mention.js";
import { journeyMark } from "../../lib/journey.js";
import { quotedMessagePreview } from "../../lib/quote-format.js";
import { isRepeatClick } from "../../lib/repeat-click.js";
import { TitleText } from "../TitleText.js";
import { TrashIcon } from "./icons.js";
import { PreviewText } from "./PreviewText.js";
import {
  SESSION_MENU_EXIT_MS,
  SessionMenu,
  type SessionMenuCloseReason,
} from "./SessionMenu.js";
import { runSessionExport } from "./session-markdown.js";

/** The card's brief notices after a menu action (ADR 0072 §3). */
type Notice = "exported" | "exportFailed" | "renameFailed";
const NOTICE_KEY = {
  exported: "session.exported",
  exportFailed: "session.exportFailed",
  renameFailed: "session.renameFailed",
} as const;
/** How long a notice stays, and its fade-out. */
const NOTICE_MS = 2400;
const NOTICE_EXIT_MS = 160;

export interface SessionItemProps {
  readonly session: SessionMetadata;
  readonly title: string;
  /** Search-time content snippet: this session matched the sidebar search by
   *  CONTENT, and the card shows this window of the matching dialogue as its
   *  preview line (so the user sees WHY it matched). */
  readonly searchSnippet?: string;
  /** Absolute record index of the matched turn. Present only on a search
   *  hit; opening the card then lands THERE instead of at the latest turn
   *  (2026-07-27 — the search found the moment, and the open threw it away). */
  readonly searchJumpIndex?: number;
}

export function SessionItem(props: SessionItemProps): JSX.Element {
  const t = useT();
  const { bridge, sessionStore, sessionListStore } = useHertaBridge();
  // Selector-based: every card re-rendering on every streaming delta (whole-
  // snapshot subscription) also re-ran the sidebar FLIP measure per token.
  const activeSessionId = useSessionSelector((s) => s.sessionId);
  const activationFirstUser = useSessionSelector((s) => s.activationFirstUser);
  // The ACTIVE session's turn state (2026-07-11): while a turn is in flight
  // the active row shows a live pulse, and clicking ANOTHER row becomes a
  // two-step confirm — switching closes the active session, which INTERRUPTS
  // the reply (and any running @板砖 task). One accidental click shouldn't
  // cut them; an armed second click may.
  const turnInFlight = useSessionSelector((s) => s.status !== "idle");
  // Presence-managed pulse dot: fades/slides in at turn start and back out
  // at turn end instead of popping (user 2026-07-11). 200ms exit ≥ the
  // CSS's 160ms collapse.
  const liveDot = usePresence(
    activeSessionId === props.session.sessionId && turnInFlight,
    200,
  );
  const gatePending = useApprovalPending();
  const live = useLiveTitle();

  const isActive = activeSessionId === props.session.sessionId;
  const pendingApproval = isActive && gatePending;
  // Type the title in only when it just arrived live for THIS session.
  const animate = live?.sessionId === props.session.sessionId;
  // Two-line only once a title exists; otherwise a single-line "Untitled" pill.
  const hasTitle =
    props.session.title !== undefined && props.session.title !== "";
  // Preview message: a search-time content snippet wins (it explains why the
  // card matched); otherwise the active session shows the FIRST message of
  // this activation (frozen) and others the last message before you left.
  const snippet = props.searchSnippet;
  const rawMessage =
    snippet ??
    (isActive
      ? (activationFirstUser ?? props.session.lastUserText ?? "")
      : (props.session.lastUserText ?? ""));
  // Localize the preview's 板砖 the same way the bubble does, but keyed on THIS
  // card's own interaction language (not the active session's) — so an EN
  // session's card shows @Brick like its bubbles, while a zh card stays 板砖.
  // A message that quotes the viewer's page shows its labels, not the fence
  // (ADR 0078 §7).
  const message = stripInlineCodeTicks(
    aliasBanzhuanPlain(
      quotedMessagePreview(rawMessage),
      props.session.lang ?? "zh",
    ),
  );
  // A snippet always shows, even on an untitled card — the match is the point.
  const showPreview = (hasTitle && message !== "") || snippet !== undefined;

  // The message row opens immediately for a disk-loaded titled card, or — for
  // a freshly generated (live) title — only after the title finishes typing
  // (TitleText.onRevealed), so it expands in sequence. Initialized from the
  // mount-time values so the disk card mounts already-open (no transition) and
  // the live card mounts collapsed (then animates).
  const [messageOpen, setMessageOpen] = useState(() => showPreview && !animate);

  // Two-step delete: trash → 确认删除 pill → delete. Cancelled by leaving the
  // card (focus-out) or pressing Escape; on mouse-leave the pill fades out and
  // resets to the trash shortly AFTER the fade completes (see the handlers
  // below).
  const [confirming, setConfirming] = useState(false);
  // Width-animation arm (user 2026-07-10): the pill mounts COLLAPSED
  // (max-width 0) and `is-open` lands one frame later, so it grows out of
  // the trash position instead of snapping to full width (which also
  // snapped the title's squeeze + right-edge fade mask). On leave, is-open
  // drops immediately → the pill shrinks while it fades, the title reclaims
  // its width continuously, and the delayed reset swaps in the trash once
  // both are done. Reduced motion opens instantly (the CSS snaps the width).
  const reduced = useReducedMotion();
  const [confirmOpen, setConfirmOpen] = useState(false);
  useEffect(() => {
    if (!confirming) {
      setConfirmOpen(false);
      return;
    }
    if (reduced) {
      setConfirmOpen(true);
      return;
    }
    const id = requestAnimationFrame(() => setConfirmOpen(true));
    return () => cancelAnimationFrame(id);
  }, [confirming, reduced]);
  // Tracks whether the pointer has genuinely left the card, so a spurious
  // onMouseEnter (fired when the trash <svg> is unmounted on click — React
  // rebuilds enter/leave from a detached relatedTarget) doesn't cancel the
  // confirm. Only a real leave → re-enter resets to the trash.
  const pointerOutside = useRef(false);
  // Post-shrink reset: the pill must stay MOUNTED through its exit
  // (unmounting instantly swapped in the trash while the pill was still
  // visible). Since 2026-07-10 the exit is `is-open` dropping: the pill
  // collapses to nothing (max-width 0 + zero padding + overflow hidden)
  // while a synchronized back-half fade runs — one driver, one duration, so
  // the fade can never outrun the shrink (the hover-reveal's independent
  // fade did, and read as a pop). The title reclaims its flex width
  // continuously. Once collapsed, swap in the trash: nothing visible
  // flashes (the trash is itself hover-hidden with the cursor gone, and the
  // keyed slot mounts it as a fresh node at opacity 0). Must exceed the
  // CSS exit — 240ms since 2026-07-13 (user: the 140ms exit still read as
  // an instant vanish even after the dark-contrast fix).
  const CONFIRM_LEAVE_RESET_MS = 260;
  const confirmLeaveTimer = useRef<number | null>(null);
  const cancelConfirmLeaveTimer = (): void => {
    if (confirmLeaveTimer.current !== null) {
      window.clearTimeout(confirmLeaveTimer.current);
      confirmLeaveTimer.current = null;
    }
  };
  useEffect(
    () => () => {
      if (confirmLeaveTimer.current !== null)
        window.clearTimeout(confirmLeaveTimer.current);
    },
    [],
  );

  // Transient "存档损坏" badge after a failed open: the main process reports a
  // structured SessionOpenFailure (corrupt archive) instead of silently
  // rejecting; the active session survives, so the only job here is telling
  // the user why the click did nothing. Clicking the badge dismisses it
  // immediately, restoring the trash (the recovery path) — the timer is only
  // the fallback for a user who never clicks (user feedback 2026-07-06).
  const OPEN_FAILED_RESET_MS = 4000;
  const [openFailed, setOpenFailed] = useState(false);
  const openFailedTimer = useRef<number | null>(null);
  const dismissOpenFailed = (): void => {
    if (openFailedTimer.current !== null) {
      window.clearTimeout(openFailedTimer.current);
      openFailedTimer.current = null;
    }
    setOpenFailed(false);
  };
  useEffect(
    () => () => {
      if (openFailedTimer.current !== null)
        window.clearTimeout(openFailedTimer.current);
    },
    [],
  );

  // Mid-turn switch guard: the first click on another row while a turn is in
  // flight ARMS (a warning badge takes the action slot); a second click
  // within the window switches — and interrupts — for real. Auto-disarms on
  // the timer or when the turn ends (the warning no longer applies).
  const SWITCH_ARM_RESET_MS = 4000;
  const [switchArmed, setSwitchArmed] = useState(false);
  // Enter/exit-animated presence (user 2026-07-11): the badge GROWS out of
  // the trash slot on arm and melts away on disarm — same width-driven move
  // as the 确认删除 pill — instead of mounting/unmounting with no motion.
  // 160ms exit ≥ the CSS's 140ms shrink.
  const arm = usePresence(switchArmed, 160);
  const switchArmTimer = useRef<number | null>(null);
  const disarmSwitch = (): void => {
    if (switchArmTimer.current !== null) {
      window.clearTimeout(switchArmTimer.current);
      switchArmTimer.current = null;
    }
    setSwitchArmed(false);
  };
  useEffect(
    () => () => {
      if (switchArmTimer.current !== null)
        window.clearTimeout(switchArmTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (turnInFlight) return;
    if (switchArmTimer.current !== null) {
      window.clearTimeout(switchArmTimer.current);
      switchArmTimer.current = null;
    }
    setSwitchArmed(false);
  }, [turnInFlight]);

  const armSwitch = (): void => {
    setSwitchArmed(true);
    if (switchArmTimer.current !== null)
      window.clearTimeout(switchArmTimer.current);
    switchArmTimer.current = window.setTimeout(() => {
      switchArmTimer.current = null;
      setSwitchArmed(false);
    }, SWITCH_ARM_RESET_MS);
  };

  // Full-title pop-out (user 2026-07-16): a long title dissolves into the
  // right-edge fade mask and hovering revealed nothing. When the pointer
  // RESTS on the card (hover intent) and the masked title actually
  // overflows, a fixed tip to the card's right shows the full title.
  // Portaled to <body>: the sidebar scroller clips and masks its contents
  // (and re-rasters on hover), so the tip must live outside it. It is a
  // label, not a control (pointer-events: none in CSS), and is aria-hidden —
  // the full title is already in the DOM text (the truncation is CSS-only),
  // so screen readers never lost it. Hidden again on leave / open-click /
  // any scroll / Escape; keyboard focus (focus-visible) shows it with no
  // delay, same overflow gate.
  const TIP_HOVER_MS = 450;
  const cardRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const [tipAt, setTipAt] = useState<{ top: number; left: number } | null>(
    null,
  );
  const tipTimer = useRef<number | null>(null);
  const closeTip = (): void => {
    if (tipTimer.current !== null) {
      window.clearTimeout(tipTimer.current);
      tipTimer.current = null;
    }
    setTipAt(null);
  };
  const openTipNow = (): void => {
    const titleEl = titleRef.current;
    const cardEl = cardRef.current;
    if (titleEl === null || cardEl === null || props.title === "") return;
    // Fits inside the mask (+1: fractional-width rounding) → nothing hidden.
    if (titleEl.scrollWidth <= titleEl.clientWidth + 1) return;
    const titleRect = titleEl.getBoundingClientRect();
    const cardRect = cardEl.getBoundingClientRect();
    setTipAt({
      top: Math.min(
        Math.max(titleRect.top + titleRect.height / 2, 8),
        window.innerHeight - 8,
      ),
      left: cardRect.right + 12,
    });
  };
  const armTip = (): void => {
    if (tipTimer.current !== null) window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => {
      tipTimer.current = null;
      openTipNow();
    }, TIP_HOVER_MS);
  };
  useEffect(
    () => () => {
      if (tipTimer.current !== null) window.clearTimeout(tipTimer.current);
    },
    [],
  );
  // Any scroll while open would leave the fixed tip floating at a stale
  // spot (the card scrolled away under it) — close instead of tracking.
  useEffect(() => {
    if (tipAt === null) return;
    const close = (): void => setTipAt(null);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", close, true);
  }, [tipAt]);

  // The session menu (ADR 0072 §3): rename, export — any session, open or
  // not, so it never switches (and never interrupts). Each item shows only
  // where the bridge has the surface; with neither the right-click is left
  // alone. `lastMenuAt` holds the spot through the menu's exit.
  // A rename names the current topic, and a session with no message has
  // none: the name would show on the card and vanish from the header at the
  // next open (review 2026-09-30). Main refuses it too; here the item is
  // simply not offered while the open session is still empty.
  const openAndEmpty = useSessionSelector(
    (s) =>
      s.sessionId === props.session.sessionId &&
      !s.record.some((b) => b.kind === "user"),
  );
  const canRename = bridge.renameSession !== undefined && !openAndEmpty;
  const canExport =
    bridge.readSessionForExport !== undefined &&
    bridge.saveSessionExport !== undefined;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const lastMenuAt = useRef({ x: 0, y: 0 });
  if (menuAt !== null) lastMenuAt.current = menuAt;
  const menu = usePresence(menuAt !== null, SESSION_MENU_EXIT_MS);
  const closeMenu = useCallback((reason: SessionMenuCloseReason): void => {
    setMenuAt(null);
    if (reason === "escape") cardRef.current?.focus({ preventScroll: true });
  }, []);

  // A brief notice in the action slot after an export or a failed rename.
  // It fades out rather than vanish; `lastNotice` holds the words meanwhile.
  const [notice, setNotice] = useState<Notice | null>(null);
  const lastNotice = useRef<Notice>("exported");
  if (notice !== null) lastNotice.current = notice;
  const noticePresence = usePresence(notice !== null, NOTICE_EXIT_MS);
  const noticeTimer = useRef<number | null>(null);
  const showNotice = (n: Notice): void => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice(n);
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, NOTICE_MS);
  };
  useEffect(
    () => () => {
      if (noticeTimer.current !== null)
        window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  // Rename in place: the title becomes a field. Enter or leaving the field
  // keeps what was typed; Escape keeps the old name. The name shows at once
  // and goes back if main could not keep it. It names the CURRENT topic
  // (owner 2026-09-30): the open session's rail takes the topics main
  // answers, and later retitles go on as before.
  const [editing, setEditing] = useState(false);
  const renameSettled = useRef(false);
  const renameField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) return;
    renameField.current?.focus({ preventScroll: true });
    renameField.current?.select();
  }, [editing]);
  const startRename = (): void => {
    if (!canRename) return;
    closeTip();
    setConfirming(false);
    renameSettled.current = false;
    setEditing(true);
  };
  const finishRename = (typed: string | null, refocus: boolean): void => {
    if (renameSettled.current) return;
    renameSettled.current = true;
    setEditing(false);
    if (refocus) cardRef.current?.focus({ preventScroll: true });
    const next = typed?.replace(/\s+/g, " ").trim() ?? "";
    const id = props.session.sessionId;
    const previous = props.session.title ?? null;
    if (next === "" || next === previous) return;
    const apply = (title: string | null): void => {
      sessionListStore.applyUserTitle(id, title);
      sessionStore.applyUserTitle(id, title);
    };
    apply(next);
    setMessageOpen(true);
    const failed = (): void => {
      apply(previous);
      showNotice("renameFailed");
    };
    void bridge.renameSession?.(id, next).then((r) => {
      if (!r.ok) {
        failed();
        return;
      }
      sessionListStore.applyUserTitle(id, r.title);
      sessionStore.applyUserTitle(id, r.title, r.topics);
    }, failed);
  };

  const exportSession = (): void => {
    void runSessionExport(bridge, props.session.sessionId).then((r) => {
      if (r === "saved") showNotice("exported");
      else if (r === "failed") showNotice("exportFailed");
      // The save dialog took the focus; a keyboard user comes back to the
      // card they exported, not to the page (review 2026-09-30).
      cardRef.current?.focus({ preventScroll: true });
    });
  };

  // A tray switch to THIS session was refused mid-turn (2026-07-13): main
  // fronted the window and signalled the refusal — arm the same badge a
  // first direct click would, so the refusal explains itself (and the
  // user's next click here confirms for real). Keyed on seq so a repeat
  // tray attempt re-arms/extends.
  const navBlockSeq = useSessionSelector((s) =>
    s.navBlock !== null && s.navBlock.target === props.session.sessionId
      ? s.navBlock.seq
      : 0,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: seq is the trigger; the guards are read fresh
  useEffect(() => {
    if (navBlockSeq === 0) return;
    if (isActive || gatePending || !turnInFlight) return;
    armSwitch();
  }, [navBlockSeq]);

  const open = (repeat = false): void => {
    // A repeat click (the second click of a double-click) is never a new
    // intent: the first click already opened, jumped or armed. Taking it as
    // the arm's confirm interrupted the running reply (UX review
    // 2026-09-22, item 3).
    if (repeat) return;
    closeTip();
    // isActive: re-opening the already-open session re-points forwarders and
    // sends a reset that wipes streamingText/status to idle while the turn
    // still runs in the host — the composer re-enabled mid-turn (a second
    // concurrent submit) and a double-click double-fired the orphan-reply
    // regeneration. There is nothing a re-open adds; ignore the click.
    const jumpTo = props.searchJumpIndex;
    if (gatePending) return;
    if (isActive) {
      // Re-opening the already-open session is still refused (see above) —
      // but a search hit inside the CURRENT session is pure navigation and
      // needs no open at all. Without this the click was a total no-op and
      // the one session you were already reading was the one you could not
      // jump within (2026-07-27).
      if (jumpTo !== undefined) {
        sessionStore.requestJump(props.session.sessionId, jumpTo);
      }
      return;
    }
    if (turnInFlight && !switchArmed) {
      armSwitch();
      return;
    }
    disarmSwitch();
    // BEFORE the open, deliberately: the reset preserves the request, and the
    // conversation entrance reads it on that reset to stand down instead of
    // scrolling to the latest turn. Requesting after the open resolved put it
    // a commit too late — the entrance had already landed at the bottom.
    if (jumpTo !== undefined) {
      sessionStore.requestJump(props.session.sessionId, jumpTo);
    }
    journeyMark("open-session:start");
    void bridge.openSession(props.session.sessionId).then((r) => {
      if (r === null || !("openError" in r)) return;
      // Nothing to land in — drop the request so it cannot fire against
      // whichever session is opened next.
      sessionStore.clearPendingJump();
      setOpenFailed(true);
      if (openFailedTimer.current !== null)
        window.clearTimeout(openFailedTimer.current);
      openFailedTimer.current = window.setTimeout(() => {
        openFailedTimer.current = null;
        setOpenFailed(false);
      }, OPEN_FAILED_RESET_MS);
    });
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: the card nests the delete <button>, and a <button> cannot contain another <button>; a div with role="button" + keyboard handlers is the correct accessible container here.
    <div
      ref={cardRef}
      data-testid="session-card"
      data-flip-key={props.session.sessionId}
      role="button"
      tabIndex={gatePending ? -1 : 0}
      aria-disabled={gatePending}
      className={`session-item${isActive ? " is-active" : ""}${
        pendingApproval ? " is-pending-approval" : ""
      }`}
      onClick={(e) => open(isRepeatClick(e))}
      onFocus={() => {
        // Keyboard focus reveals the tip immediately (mouse focus is
        // excluded — a click's focus would flash a tip open() removes).
        try {
          if (cardRef.current?.matches(":focus-visible")) openTipNow();
        } catch {
          // engine without :focus-visible (older jsdom) — no keyboard tip
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // Consumed only when the card had something to close — its 确认删除
          // or its tip. Otherwise the Escape is not the card's: it goes on,
          // and mid-turn it stops the run as it does anywhere outside a field
          // (ADR 0082 §5). Swallowed every time, a card the session keys had
          // left focused made Escape do nothing at all (release review
          // 2026-10-22). The approval panel denies only an Escape from inside
          // itself, so a card's never reaches it as a denial.
          const had = confirming || tipAt !== null;
          setConfirming(false);
          closeTip();
          if (had) {
            e.stopPropagation();
            e.preventDefault();
          }
          return;
        }
        if (e.key === "F2") {
          // Rename, as a file manager does (ADR 0072 §3).
          e.preventDefault();
          startRename();
          return;
        }
        if (
          (e.key === "ArrowDown" || e.key === "ArrowUp") &&
          !e.altKey &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.shiftKey
        ) {
          // The card above or below (ADR 0082 §10) — focus only; Enter opens.
          e.preventDefault();
          const cards = Array.from(
            cardRef.current
              ?.closest(".sidebar")
              ?.querySelectorAll<HTMLElement>('[data-testid="session-card"]') ??
              [],
          );
          const i = cards.indexOf(e.currentTarget);
          // focus-scrolls: arrow navigation — the card must come into view.
          cards[e.key === "ArrowDown" ? i + 1 : i - 1]?.focus();
          return;
        }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      onContextMenu={(e) => {
        if (!canRename && !canExport) return;
        e.preventDefault();
        closeTip();
        if (editing) return;
        // From the keyboard (the context-menu key, Shift+F10) there is no
        // pointer: open at the card's lower left instead.
        const r = cardRef.current?.getBoundingClientRect();
        setMenuAt(
          e.button !== 2 && r !== undefined
            ? { x: r.left + 12, y: r.bottom - 6 }
            : { x: e.clientX, y: e.clientY },
        );
      }}
      // Reset to the trash on a GENUINE re-hover, or shortly after leaving —
      // never synchronously ON leave. An immediate reset at leave swaps
      // confirm → trash while both are still visible, so the trash flashes as
      // it fades out; instead the 确认删除 pill fades out in place via the
      // hover-reveal opacity, and the delayed timer swaps it for the trash
      // once invisible (releasing the pill's flex width back to the title —
      // see CONFIRM_LEAVE_RESET_MS above). The `pointerOutside` guard ignores
      // the spurious enter fired on click.
      onMouseEnter={() => {
        cancelConfirmLeaveTimer();
        armTip();
        if (pointerOutside.current) {
          pointerOutside.current = false;
          setConfirming(false);
          // A genuine re-entry also clears a lingering damaged badge — the
          // hover-revealed trash takes its place, mirroring the confirm pill.
          dismissOpenFailed();
        }
      }}
      onMouseLeave={() => {
        pointerOutside.current = true;
        closeTip();
        if (confirming) {
          // Start the width shrink NOW (the pill collapses while it fades,
          // returning its flex width to the title continuously)…
          setConfirmOpen(false);
          cancelConfirmLeaveTimer();
          // …and swap in the trash only once both transitions are done.
          confirmLeaveTimer.current = window.setTimeout(() => {
            confirmLeaveTimer.current = null;
            setConfirming(false);
          }, CONFIRM_LEAVE_RESET_MS);
        }
        if (openFailed) {
          // Same post-fade reset as the confirm pill (user bug 2026-07-06:
          // the badge lingered on an unhovered card, then the 4 s fallback
          // swapped it for a trash that was itself hover-hidden — a sudden
          // pop). The hover-reveal fades the badge out in place; this timer
          // swaps in the trash once it is invisible. Replaces the pending
          // 4 s fallback — the leave IS the dismissal now.
          if (openFailedTimer.current !== null) {
            window.clearTimeout(openFailedTimer.current);
          }
          openFailedTimer.current = window.setTimeout(() => {
            openFailedTimer.current = null;
            setOpenFailed(false);
          }, CONFIRM_LEAVE_RESET_MS);
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setConfirming(false);
          closeTip();
        }
      }}
    >
      {tipAt !== null &&
        createPortal(
          <span
            className="session-title-tip"
            style={{ top: tipAt.top, left: tipAt.left }}
            aria-hidden="true"
          >
            {props.title}
          </span>,
          document.body,
        )}
      {menu.mounted && (
        <SessionMenu
          at={lastMenuAt.current}
          leaving={menuAt === null}
          {...(canRename ? { onRename: startRename } : {})}
          {...(canExport ? { onExport: exportSession } : {})}
          onClose={closeMenu}
        />
      )}
      <span className="session-item__title-row">
        <span
          className={`session-item__title${editing ? " is-editing" : ""}`}
          ref={titleRef}
        >
          {editing ? (
            <input
              ref={renameField}
              className="session-item__rename"
              aria-label={t("session.renameAria")}
              defaultValue={hasTitle ? props.title : ""}
              placeholder={t("session.untitled")}
              maxLength={80}
              spellCheck={false}
              // The card opens its session on a click and on Enter/Space;
              // none of that may reach it from the field.
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                // An IME's Enter picks a candidate; it is not the name.
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  finishRename(e.currentTarget.value, true);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  finishRename(null, true);
                }
              }}
              onBlur={(e) => finishRename(e.currentTarget.value, false)}
            />
          ) : (
            <TitleText
              text={props.title}
              placeholder={t("session.untitled")}
              animate={animate}
              onRevealed={() => {
                setMessageOpen(true);
                // Typed in once: a remount shows it as it stands.
                if (animate) {
                  sessionListStore.settleLiveTitle(props.session.sessionId);
                }
              }}
            />
          )}
        </span>
        {/* Live pulse: Herta is mid-reply in THIS (active) session — the
            peripheral signal whose click-side counterpart is the armed
            switch badge below. Presence-managed so it fades/slides in and
            out (its collapsed state also cancels the title-row gap, so the
            title never jumps sideways). */}
        {liveDot.mounted && (
          <span
            className={`session-item__live${liveDot.open ? " is-on" : ""}`}
            aria-hidden="true"
          >
            {/* A miniature SPEECH WAVE, not a dot (owner 2026-07-27, second
                round of the dot redesign): the steady dot read as dead, and
                a pulse would rejoin the identical-blink trio the redesign
                removed. The session with a turn in flight is the one where
                Herta is currently SPEAKING — so it wears the app's own voice
                vocabulary (the device card's waves, wave-engine) in
                sidebar-scale form: three bars breathing at staggered phases
                and slightly different periods, so the motion is organic
                rather than a metronome, and unmistakably not the LED's
                blink. */}
            <span className="session-item__live-wave">
              <span className="session-item__live-bar" />
              <span className="session-item__live-bar" />
              <span className="session-item__live-bar" />
            </span>
          </span>
        )}
        {/* Explicit keys on the slot controls (2026-07-10): the trash /
            confirm / damaged-badge are all <button>s in one JSX slot, so
            React REUSES the DOM node across swaps. With the pill fully
            opaque (its exit is the width shrink), the pill→trash swap
            flipped the SAME node's class to the hover-hidden trash — and
            its `transition: opacity 120ms` animated the inherited 1 → 0,
            flashing a fading trash on an unhovered card. Distinct keys
            force a fresh node per control: the trash mounts at opacity 0
            (its actionSwapIn scale-in is invisible, as its comment already
            notes) and reveals only on the next hover.
            The wrapper (user bug 2026-07-11): the slot's controls have
            DIFFERENT widths — invisible trash 19px, collapsed pill/badge
            0px — so the swaps flickered the row's layout (19 → 0 → 19
            through a pill exit). Harmless while only the masked title edge
            moved; the live dot made it a visible sideways jump. The
            action-slot wrapper floors the width at the trash's, so an
            "empty-looking" slot always measures the same. */}
        <span className="session-item__action-slot" data-testid="action-slot">
          {editing ? null : pendingApproval ? (
            <span key="badge-approval" className="session-item__badge">
              {t("session.pendingApproval")}
            </span>
          ) : noticePresence.mounted ? (
            // After a menu action (ADR 0072 §3): 已导出, or what failed.
            <span
              key="badge-notice"
              role="status"
              className={`session-item__badge session-item__badge--notice${
                lastNotice.current === "exported" ? "" : " is-error"
              }${notice === null ? " is-leaving" : ""}`}
            >
              {t(NOTICE_KEY[lastNotice.current])}
            </span>
          ) : openFailed ? (
            <button
              key="badge-openfailed"
              type="button"
              className="session-item__badge session-item__badge--dismiss"
              onClick={(e) => {
                e.stopPropagation(); // dismissing must not re-open the corrupt session
                dismissOpenFailed();
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {t("session.openFailed")}
            </button>
          ) : gatePending ? null : arm.mounted ? (
            // A SPAN, deliberately: the card's own onClick is the second
            // (confirming) click, so the badge must let clicks bubble through.
            // `is-open` drives the confirm-pill-style width grow/shrink; the
            // badge stays mounted through its 140ms melt-away on disarm.
            <span
              key="badge-switcharm"
              className={`session-item__badge session-item__badge--warn${
                arm.open ? " is-open" : ""
              }`}
            >
              {t("session.switchInterrupts")}
            </span>
          ) : confirming ? (
            <button
              key="confirm-del"
              type="button"
              className={`session-item__confirm-del${
                confirmOpen ? " is-open" : ""
              }`}
              onClick={(e) => {
                e.stopPropagation();
                // The pill mounts in the trash's own slot: a double-click on
                // the trash lands its second click here (UX review
                // 2026-09-22, item 3). Only a fresh click deletes.
                if (isRepeatClick(e)) return;
                void bridge.deleteSession(props.session.sessionId);
              }}
            >
              {/* Own span so the LABEL can fade on its own clock (user
                2026-07-10): on exit it dissolves at the START of the shrink
                — text sliding under the narrowing clip edge read rough —
                while the capsule keeps its back-half fade. */}
              <span className="session-item__confirm-del__text">
                {t("session.confirmDelete")}
              </span>
            </button>
          ) : (
            <button
              key="trash"
              type="button"
              data-testid="session-delete"
              className="session-item__trash"
              aria-label={t("session.deleteAria")}
              onClick={(e) => {
                e.stopPropagation();
                setConfirming(true);
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <TrashIcon />
            </button>
          )}
        </span>
      </span>
      {showPreview && (
        <span
          className={`session-item__preview-wrap${
            // A snippet forces the row open: it can arrive after mount (the
            // debounced scan), when the type-in gate has already passed.
            messageOpen || snippet !== undefined ? " is-open" : ""
          }`}
        >
          <PreviewText text={message} />
        </span>
      )}
    </div>
  );
}
