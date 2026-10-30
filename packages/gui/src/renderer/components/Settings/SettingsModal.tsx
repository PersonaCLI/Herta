import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import type { MessageKey } from "../../i18n/keys.js";
import { useT } from "../../i18n/LocaleProvider.js";
import {
  OVERLAY_Z,
  topOverlay,
  useModalOverlay,
} from "../../lib/overlay-stack.js";
import { runShortcut } from "../../lib/shortcut-registry.js";
import { KeyCaps, useMacKeys } from "../common/KeyCaps.js";
import { FlowIcon } from "../Flow/FlowPanel.js";
import { BanzhuanSettings } from "./BanzhuanSettings.js";
import { DeepSeekSettings } from "./DeepSeekSettings.js";
import { DreamSettings } from "./DreamSettings.js";
import { FlowSettings } from "./FlowSettings.js";
import { LanguageSettings } from "./LanguageSettings.js";
import { primeSettings } from "./settings-snapshot.js";
import { UpdateSettings } from "./UpdateSettings.js";
import { VoiceSettings } from "./VoiceSettings.js";
import { WindowSettings } from "./WindowSettings.js";

const EXIT_MS = 180;

export interface SettingsModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const VolumeIcon = (): JSX.Element => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M11 5 6 9H3v6h3l5 4z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.5 6a9 9 0 0 1 0 12" />
  </svg>
);

const CloseIcon = (): JSX.Element => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 18 18 6M6 6l12 12" />
  </svg>
);

const MoonIcon = (): JSX.Element => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

// The DeepSeek whale mark (reference_UX_design/icons/DeepseekIcon.svg) — a
// single filled path, recolored via currentColor to match the nav.
const DeepSeekIcon = (): JSX.Element => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="currentColor"
    fillRule="evenodd"
    aria-hidden="true"
  >
    <path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" />
  </svg>
);

// 语言: a 文 over an A — the translate mark (owner 2026-09-16: the globe
// read as a browser icon). The 文 is its tick, bar and the two crossing
// falling strokes; the A carries its crossbar; the two sit on a diagonal.
const LanguageIcon = (): JSX.Element => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M8 2.5V5M3 5h10M11 8.5 4 15M5 8.5c1 2.6 3 4.9 6 6.4" />
    <path d="m13.5 21 4.25-9.5L22 21M15.1 17.4h5.3" />
  </svg>
);

// A simple cpu/chip mark for the 差分协处理器 (coprocessor) section.
const ChipIcon = (): JSX.Element => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
  </svg>
);

// A download-arrow glyph for the Update section (2026-07-10).
const UpdateIcon = (): JSX.Element => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" />
    <path d="M4.5 19.5h15" />
  </svg>
);

// A window/panel glyph for the Window section (close-to-tray etc.).
const WindowIcon = (): JSX.Element => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
    <path d="M3.5 9h17" />
  </svg>
);

/**
 * Grouped nav (user feedback 2026-07-06 — the flat five-item list read as a
 * random listing): 通用 (how the app behaves) → 黑塔 (her voice and downtime)
 * → 引擎 (the model + coding backend). Every open lands on the first item of
 * the first group.
 *
 * `rows`: the pane's option rows scroll inside a fixed-height pane (its
 * `.settings-rows` list; see `.settings-content.has-rows` in the CSS). Said
 * here, not derived in CSS with `:has(> .settings-rows)`: that rule made
 * every send in the conversation restyle ~400 elements, Settings closed and
 * all — 10–28 ms at 4× CPU, just before the send's first frame (measured
 * 2026-09-24). A test holds this flag to what each pane renders.
 */
const GROUPS = [
  {
    labelKey: "nav.group.general" satisfies MessageKey,
    items: [
      {
        key: "language",
        labelKey: "nav.language" satisfies MessageKey,
        Icon: LanguageIcon,
        Pane: LanguageSettings,
        rows: false,
      },
      {
        key: "window",
        labelKey: "nav.window" satisfies MessageKey,
        Icon: WindowIcon,
        Pane: WindowSettings,
        rows: false,
      },
      {
        key: "update",
        labelKey: "nav.update" satisfies MessageKey,
        Icon: UpdateIcon,
        Pane: UpdateSettings,
        rows: false,
      },
    ],
  },
  {
    labelKey: "nav.group.herta" satisfies MessageKey,
    items: [
      {
        key: "voice",
        labelKey: "nav.voice" satisfies MessageKey,
        Icon: VolumeIcon,
        Pane: VoiceSettings,
        rows: true,
      },
      {
        key: "dream",
        labelKey: "nav.dream" satisfies MessageKey,
        Icon: MoonIcon,
        Pane: DreamSettings,
        rows: false,
      },
      {
        key: "flow",
        labelKey: "nav.flow" satisfies MessageKey,
        Icon: FlowIcon,
        Pane: FlowSettings,
        rows: true,
      },
    ],
  },
  {
    labelKey: "nav.group.engine" satisfies MessageKey,
    items: [
      {
        key: "deepseek",
        labelKey: "nav.deepseek" satisfies MessageKey,
        Icon: DeepSeekIcon,
        Pane: DeepSeekSettings,
        rows: false,
      },
      {
        key: "banzhuan",
        labelKey: "nav.coprocessor" satisfies MessageKey,
        Icon: ChipIcon,
        Pane: BanzhuanSettings,
        rows: true,
      },
    ],
  },
] as const;
// Explicit spread, not GROUPS.flatMap: flatMap widens the `as const` tuples
// to a plain array, losing both the literal `key` union and the guaranteed
// non-empty [0] that the section fallback below relies on.
const SECTIONS = [
  ...GROUPS[0].items,
  ...GROUPS[1].items,
  ...GROUPS[2].items,
] as const;
type Section = (typeof SECTIONS)[number]["key"];

/**
 * The Settings modal: a frosted full-window backdrop + a centered card with a
 * left section nav and a right content pane. Opened by the sidebar-foot Settings
 * button. Closes on Escape, an outside click, and the X. Focus moves into the
 * card on open and returns to the trigger on close. The nav is GROUPED —
 * 通用 (Language, Window), 黑塔 (Voice, Dream), 引擎 (DeepSeek, Coprocessor)
 * (SPEC 2026-06-23 settings-modal; regrouped per user feedback 2026-07-06).
 */
export function SettingsModal({
  open,
  onClose,
}: SettingsModalProps): JSX.Element | null {
  const t = useT();
  const { bridge } = useHertaBridge();
  // Prime the panes' last-known values (settings-snapshot.ts): once when the
  // app starts — this component is mounted, closed, from launch — and again
  // on every open, so each pane's FIRST frame shows the stored state instead
  // of a default it corrects a few frames later (owner 2026-09-18). A pane
  // mounts on a nav click, which no hand makes before these reads answer.
  useEffect(() => {
    primeSettings(bridge);
  }, [bridge]);
  useEffect(() => {
    if (open) primeSettings(bridge);
  }, [open, bridge]);
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const [section, setSection] = useState<Section>("voice");
  const active = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0];
  const cardRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  // True while THIS open has taken focus, so the restore below runs only on
  // a real open→close — never on the initial mount (which would otherwise
  // focus the sidebar Settings button on app launch), and once per close.
  const focusTaken = useRef(false);

  // Mount on open; keep mounted through the exit animation, then unmount.
  useEffect(() => {
    if (open) {
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (mounted) {
      setLeaving(true);
      const t = setTimeout(() => {
        setMounted(false);
        setLeaving(false);
      }, EXIT_MS);
      return () => clearTimeout(t);
    }
  }, [open, mounted]);

  // Every open starts on the first section — never remember the last-viewed
  // one (the component stays mounted while closed, so `section` would otherwise
  // persist). useLayoutEffect resets it before paint, so even reopening during
  // the close animation (still mounted) shows the first section with no flash.
  useLayoutEffect(() => {
    if (open) setSection(SECTIONS[0].key);
  }, [open]);

  // Focus the card on open; restore focus to the trigger on close — falling
  // back to the sidebar Settings button if the prior focus was lost to <body>.
  //
  // Keyed on `mounted` as well as `open`: from the closed state the card
  // does not exist in the flush that sees `open` — the mount effect above
  // only schedules it, and `if (!mounted) return null` renders nothing — so
  // a focus keyed on `open` alone found no card, the trap never engaged, and
  // Tab walked the workspace behind the backdrop (UX review 2026-09-22,
  // item 10). The restore is gated on `focusTaken`, so it never fires on the
  // initial mount and fires once per close.
  useEffect(() => {
    if (open && mounted && !focusTaken.current) {
      focusTaken.current = true;
      prevFocus.current = document.activeElement as HTMLElement | null;
      // No scroll on either hand-over: the card animates in, and what held
      // focus before may sit in a part of the window that is sliding.
      cardRef.current?.focus({ preventScroll: true });
    } else if (!open && focusTaken.current) {
      focusTaken.current = false;
      const prev = prevFocus.current;
      if (prev && prev !== document.body && document.contains(prev)) {
        prev.focus?.({ preventScroll: true });
      } else {
        document
          .querySelector<HTMLElement>(".sidebar-settings")
          ?.focus?.({ preventScroll: true });
      }
    }
  }, [open, mounted]);

  // Overlay-stack registration: only the TOPMOST overlay owns Escape, so
  // closing Settings can never also feed the keypress to the approval panel
  // (which treats Escape as DENY) behind the backdrop.
  const isTop = useModalOverlay("settings", open, OVERLAY_Z.settings);
  const mac = useMacKeys();
  /** Whether Settings was the topmost overlay when the current press began.
   *  A ref, not the effect's own variable: the press that closes a dialog
   *  above re-runs the effect mid-press, and the answer must survive it. */
  const pressOnTop = useRef(true);

  // Escape (close) + Tab (focus trap) + outside-click close, only while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (!isTop) return; // a higher overlay (e.g. a card menu) owns Escape
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || cardRef.current === null) return;
      // Keep Tab within the modal (aria-modal makes the background inert for AT;
      // this stops sighted keyboard focus from escaping behind the backdrop).
      // Disabled elements are skipped: focus() on a disabled control silently
      // no-ops, which would let Tab fall through the trap.
      const f = Array.from(
        cardRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !(el as HTMLButtonElement).disabled);
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === cardRef.current)) {
        e.preventDefault();
        // focus-scrolls: Tab navigation — the control must come into view.
        last?.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        // focus-scrolls: Tab navigation — the control must come into view.
        first?.focus();
      }
    };
    const onDown = (e: MouseEvent): void => {
      // App chrome is not "outside the modal" (audit 2026-07-24, M1). The
      // caption buttons live at z-4000 OUTSIDE `.app`'s stacking context, so
      // they are the only thing clickable over an open modal — by design —
      // and minimizing/maximizing the window read as a dismiss-click.
      if ((e.target as Element | null)?.closest?.(".window-controls")) return;
      // A dialog above Settings (the cheat sheet its nav foot opens) owns
      // its own clicks: a press there — inside it, or on its backdrop, which
      // closes it — is not a dismiss of Settings. Decided by who was on top
      // when the press BEGAN (`onPress`, capture phase): the sheet's close
      // lands in React before the press reaches the document, so by then
      // Settings is on top again and the backdrop press read as outside it
      // (owner 2026-10-21: both closed).
      if (!pressOnTop.current) return;
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onPress = (): void => {
      pressOnTop.current = topOverlay() === "settings";
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPress, { capture: true });
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPress, { capture: true });
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose, isTop]);

  if (!mounted) return null;

  return (
    <div className={`settings-backdrop${leaving ? " is-out" : ""}`}>
      <div
        ref={cardRef}
        className="settings-card"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.dialogAria")}
        tabIndex={-1}
      >
        <nav className="settings-nav" aria-label={t("settings.sectionsAria")}>
          {/* The list keeps its block layout (its labels' margins collapse as
              before); the nav around it is a column, so the shortcuts row
              below rests at its foot. */}
          <div className="settings-nav-list">
            <p className="settings-nav-eyebrow">{t("settings.eyebrow")}</p>
            {GROUPS.map((g) => (
              <Fragment key={g.labelKey}>
                <p className="settings-nav-group-label">{t(g.labelKey)}</p>
                {g.items.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    className={`settings-nav-item${section === s.key ? " is-active" : ""}`}
                    aria-current={section === s.key}
                    onClick={() => setSection(s.key)}
                  >
                    <s.Icon />
                    <span>{t(s.labelKey)}</span>
                  </button>
                ))}
              </Fragment>
            ))}
          </div>
          {/* Where the cheat sheet can be found (owner 2026-10-21, option A of
              the mockup): a quiet row at the nav's foot, seen from every
              section; a press opens the sheet over Settings (ADR 0082
              amendment 2026-10-21). */}
          <button
            type="button"
            className="settings-nav-foot"
            aria-keyshortcuts={mac ? "Meta+/" : "Control+/"}
            onClick={() => runShortcut("showShortcuts")}
          >
            <span>{t("settings.shortcuts")}</span>
            <KeyCaps id="showShortcuts" decorative />
          </button>
        </nav>
        <div className={`settings-content${active.rows ? " has-rows" : ""}`}>
          <button
            type="button"
            className="settings-close"
            aria-label={t("settings.closeAria")}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
          <h2 className="settings-section-title">{t(active.labelKey)}</h2>
          <active.Pane />
        </div>
      </div>
    </div>
  );
}
