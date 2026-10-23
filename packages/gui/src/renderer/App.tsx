import { type ReactNode, useEffect, useRef, useState } from "react";
import { HoverTipLayer } from "./components/common/HoverTipLayer.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import {
  FileViewerProvider,
  useFileViewerState,
} from "./components/FileViewer/file-viewer-context.js";
import { WorkspaceBodyShell } from "./components/FileViewer/WorkspaceBodyShell.js";
import { OpeningAscii } from "./components/Opening/OpeningAscii.js";
import { KeyPrompt } from "./components/Settings/KeyPrompt.js";
import { SettingsModal } from "./components/Settings/SettingsModal.js";
import { ShortcutsSheet } from "./components/Shortcuts/ShortcutsSheet.js";
import { Sidebar } from "./components/Sidebar/Sidebar.js";
import { TopBar } from "./components/TopBar/TopBar.js";
import { UtilityRail } from "./components/UtilityRail/UtilityRail.js";
import {
  ErrorWindowControls,
  WindowControls,
} from "./components/WindowControls.js";
import { Workspace } from "./components/Workspace/Workspace.js";
import {
  HertaBridgeProvider,
  useHertaBridge,
} from "./context/HertaBridgeContext.js";
import { useDisconnected } from "./hooks/useDisconnected.js";
import { useSessionSelector } from "./hooks/useSessionSelector.js";
import { useSidebarCollapsed } from "./hooks/useSidebarCollapsed.js";
import { useVoiceCues } from "./hooks/useVoiceCues.js";
import { useWindowFullScreen } from "./hooks/useWindowFullScreen.js";
import { useWindowHidden } from "./hooks/useWindowHidden.js";
import { useWindowSnap } from "./hooks/useWindowSnap.js";
import { LocaleProvider, useT } from "./i18n/LocaleProvider.js";
import { en } from "./i18n/messages/en.js";
import { zh } from "./i18n/messages/zh.js";
import type { HertaBridge, Locale } from "./ipc/bridge-types.js";
import { journeyMarkAfterPaint } from "./lib/journey.js";
import {
  OVERLAY_Z,
  overlayOpenAbove,
  topOverlayZ,
} from "./lib/overlay-stack.js";
import {
  runShortcut,
  useShortcut,
  useShortcutDispatcher,
} from "./lib/shortcut-registry.js";
import { initTheme } from "./lib/theme.js";
import { ReferenceView } from "./ReferenceView.js";

function isReferenceMode(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.location.hash === "#reference" ||
    new URLSearchParams(window.location.search).has("ref")
  );
}

/** Centered "Herta could not start" panel shared by the bootstrap-error
 *  and missing-bridge paths. */
function ErrorScreen(props: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="app app-error" data-testid="app-error">
      <div className="app-error-panel">{props.children}</div>
    </div>
  );
}

/** Fallback for a render-phase crash anywhere under the Workbench (audit
 *  2026-07-13 T2.2): the existing ErrorScreen styling plus a reload — the
 *  session record is on disk, so a reload fully recovers. Rendered inside
 *  LocaleProvider (the boundary wraps Workbench only), so useT is safe. */
function WorkbenchCrashScreen({
  error,
}: {
  readonly error: Error;
}): JSX.Element {
  const t = useT();
  return (
    <ErrorScreen>
      <h2>{t("app.crashTitle")}</h2>
      <p>
        <code>{error.message}</code>
      </p>
      <p>{t("app.crashBody")}</p>
      <button
        type="button"
        className="app-error-reload"
        onClick={() => window.location.reload()}
      >
        {t("app.crashReload")}
      </button>
    </ErrorScreen>
  );
}

function Workbench({ booting }: { readonly booting: boolean }): JSX.Element {
  const t = useT();
  // Selector-based: the Workbench is the APP ROOT — subscribing to the whole
  // snapshot here re-rendered the entire tree (sidebar, top bar, rail…) on
  // every streaming delta. It only needs these two fields.
  const error = useSessionSelector((s) => s.error);
  const sessionId = useSessionSelector((s) => s.sessionId);
  const disconnected = useDisconnected();
  // Autoplay server voice cues (opening voice now; more later).
  useVoiceCues();
  // Launch lands directly on the connect screen — that's the INITIAL state, not
  // a connected→disconnected transition, so it must appear static (no rail /
  // composer slide, no button morph). `everConnected` latches true the first
  // time a session is active; until then a disconnected render is the launch
  // state and gets `is-launch-static`, which snaps those transitions. After the
  // user has connected once, later disconnects animate as before (user
  // 2026-06-20). The morph itself is gated separately in useConnectMorph.
  const [everConnected, setEverConnected] = useState(false);
  useEffect(() => {
    if (sessionId !== null && !everConnected) setEverConnected(true);
  }, [sessionId, everConnected]);
  const launchStatic = disconnected && !everConnected;
  // macOS draws its traffic lights INSIDE our frameless window's top-left
  // (titleBarStyle "hidden"), on top of whatever the renderer puts there —
  // and the topbar's first icons sat exactly under them (seen in the native
  // screencapture of run 31188467986; CDP shots cannot show it, they capture
  // web contents without the OS chrome). WindowControls already returns null
  // on darwin, but that only drops OUR buttons on the right; nothing was
  // reserving the left. See .app.is-mac .topbar in reference-ux.css.
  const { bridge } = useHertaBridge();
  const isMac = bridge.platform === "darwin";
  // …except in full screen, where macOS hides the lights (2026-09-23).
  const fullScreen = useWindowFullScreen();
  // Pauses the ambient infinite animations (device aura/ring, shimmers,
  // carets) while the window is hidden/tray'd — see the is-window-hidden
  // block in reference-ux.css (2026-07-11).
  const windowHidden = useWindowHidden();
  // Veils the edge-anchored surfaces (composer footer, utility rail) for a
  // beat around a maximize/restore snap — the OS crossfade-zoom otherwise
  // shows them doubled (user 2026-07-14). See .is-window-snap in
  // reference-ux.css.
  const windowSnap = useWindowSnap();
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // The application menu's Settings… (Cmd+, on macOS since 2026-09-23;
  // Ctrl+, everywhere, ADR 0082). From over the cheat sheet, the sheet
  // gives way. Over the key prompt, the lightbox or a menu it does nothing:
  // Settings opened BEHIND them and took the focus from the visible one
  // (release review 2026-10-22), as Ctrl+W already knew.
  useEffect(
    () =>
      bridge.onOpenSettings?.(() => {
        if (overlayOpenAbove(OVERLAY_Z.approval, ["shortcuts", "settings"]))
          return;
        setShortcutsOpen(false);
        setSettingsOpen(true);
      }),
    [bridge],
  );
  // The keyboard (ADR 0082): one listener for the whole app, and the
  // commands that belong to the workbench itself.
  useShortcutDispatcher(isMac);
  // A key pressed while the browser page has the focus reaches main first
  // (ADR 0083 §3): an app command comes back here and runs as its key would.
  useEffect(
    () => bridge.onPageCommand?.((id) => void runShortcut(id)),
    [bridge],
  );
  useShortcut("showShortcuts", () => {
    setShortcutsOpen((v) => !v);
    return true;
  });
  useShortcut("toggleSidebar", () => {
    // Collapsing hides whatever in the sidebar holds the focus, and the focus
    // fell to the page, where the next Escape stopped the run (release review
    // 2026-10-22). It goes to the top bar's search button first; the search
    // and its words stay as they were.
    const active = document.activeElement;
    if (!collapsed && active instanceof Element && active.closest(".sidebar"))
      searchButtonRef.current?.focus({ preventScroll: true });
    toggleCollapsed();
    return true;
  });

  const closeSearch = (): void => {
    setSearchOpen(false);
    setQuery("");
    // Return keyboard focus to the search trigger (it's always mounted in the
    // top bar) so closing via Escape doesn't drop focus to <body>.
    searchButtonRef.current?.focus({ preventScroll: true });
  };
  const toggleSearch = (): void => {
    if (searchOpen) {
      closeSearch();
      return;
    }
    setSearchOpen(true);
    // Opening search while collapsed expands the sidebar so the filtered
    // list is actually visible (not a dead search over a hidden list).
    if (collapsed) toggleCollapsed();
  };
  // Ctrl+K opens the search, or takes the caret back to it when open — in
  // a collapsed sidebar too, which it expands first: the hidden field took
  // no focus, and Ctrl+K did nothing (release review 2026-10-22).
  const focusSearchOnExpand = useRef(false);
  useShortcut("searchSessions", () => {
    if (!searchOpen) toggleSearch();
    else if (collapsed) {
      focusSearchOnExpand.current = true;
      toggleCollapsed();
    } else searchInputRef.current?.focus({ preventScroll: true });
    return true;
  });
  useEffect(() => {
    if (collapsed || !focusSearchOnExpand.current) return;
    focusSearchOnExpand.current = false;
    searchInputRef.current?.focus({ preventScroll: true });
  }, [collapsed]);

  if (error !== null) {
    return (
      <ErrorScreen>
        <h2>{t("app.cantStart")}</h2>
        <p>{error}</p>
        <p>{t("app.cantStartBody")}</p>
      </ErrorScreen>
    );
  }
  return (
    <div
      className={`app${collapsed ? " sidebar-collapsed" : ""}${disconnected ? " is-disconnected" : ""}${launchStatic ? " is-launch-static" : ""}${booting ? " is-booting" : ""}${windowHidden ? " is-window-hidden" : ""}${windowSnap ? " is-window-snap" : ""}${isMac ? " is-mac" : ""}${fullScreen ? " is-fullscreen" : ""}`}
    >
      <TopBar
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
        searchActive={searchOpen}
        onToggleSearch={toggleSearch}
        searchButtonRef={searchButtonRef}
      />
      <Sidebar
        searchOpen={searchOpen}
        query={query}
        onQueryChange={setQuery}
        onCloseSearch={closeSearch}
        onOpenSettings={() => setSettingsOpen(true)}
        searchInputRef={searchInputRef}
      />
      <FileViewerProvider>
        <CloseRequests />
        <WorkspaceBodyShell>
          <Workspace />
          <UtilityRail />
        </WorkspaceBodyShell>
      </FileViewerProvider>
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <KeyPrompt />
      <ShortcutsSheet
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />
      {/* The one hover tip, above everything it may anchor to. */}
      <HoverTipLayer />
    </div>
  );
}

/**
 * Ctrl/⌘+W (ADR 0082 §2): the menu's Close asks the renderer, which closes
 * the viewer's active tab when the viewer is open and the window otherwise
 * (`windowClose`, the close-to-tray path). Under an overlay that owns the
 * keyboard (Settings, the cheat sheet…) it does nothing — closing the window
 * from inside a dialog would surprise.
 */
function CloseRequests(): null {
  const { bridge } = useHertaBridge();
  const viewer = useFileViewerState();
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
  useEffect(
    () =>
      bridge.onCloseRequested?.(() => {
        const z = topOverlayZ();
        if (z !== null && z > OVERLAY_Z.approval) return;
        const v = viewerRef.current;
        if (v?.open === true) {
          v.closeTab(v.active);
          return;
        }
        bridge.windowClose();
      }),
    [bridge],
  );
  return null;
}

function navigatorLocale(): Locale {
  if (typeof navigator === "undefined") return "en";
  return navigator.language?.startsWith("zh") ? "zh" : "en";
}

export interface AppProps {
  /** Defaults to window.herta; tests inject a mock bridge. */
  readonly bridge?: HertaBridge;
}

export function App(props: AppProps = {}): JSX.Element {
  const bridge = props.bridge ?? window.herta;
  const [refMode, setRefMode] = useState(() => isReferenceMode());
  const [splashDone, setSplashDone] = useState(false);
  const [splashFading, setSplashFading] = useState(false);
  // Hide the workbench while the opening splash plays, so its bootstrap (the
  // connected→disconnected settle, the async layout) never shows through the
  // frosted glass. Reveal it (fade in) the moment the splash starts fading out,
  // so the settled connect screen emerges from the frost rather than popping in.
  const booting = !splashFading && !splashDone;

  // Seed from the OS (navigator) for the first paint, then reconcile with the
  // persisted value from main. The boot splash hides the workbench while this
  // resolves, so a seed→stored swap is never visible.
  const [locale, setLocale] = useState<Locale>(() => navigatorLocale());
  useEffect(() => {
    if (bridge === undefined) return;
    let alive = true;
    void bridge.getLocale().then((l) => {
      if (alive) setLocale(l);
    });
    return () => {
      alive = false;
    };
  }, [bridge]);

  // Appearance (night-mode slice 2): stamp <html data-theme> from the
  // persisted preference; the boot splash covers the resolve, like locale.
  useEffect(() => {
    if (bridge === undefined) return;
    void initTheme(bridge);
  }, [bridge]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (): void => setRefMode(isReferenceMode());
    window.addEventListener("hashchange", handler);
    window.addEventListener("popstate", handler);
    return () => {
      window.removeEventListener("hashchange", handler);
      window.removeEventListener("popstate", handler);
    };
  }, []);

  // Remove the index.html cold-start splash (#boot-splash) once React has
  // painted: by then the opening overlay (or an error/ref screen) is covering,
  // so the body's cyan gradient it was hiding becomes the frosted .app backdrop
  // instead of a cold-start flash. useEffect (post-paint), not layout, so the
  // overlay is already on screen when it goes.
  useEffect(() => {
    document.getElementById("boot-splash")?.remove();
    journeyMarkAfterPaint("launch:app-painted");
  }, []);

  // Frameless-window drag strip (SPEC v0.3 §5.1.1). Full-width, sits
  // behind the card (z-index 0) so it only catches drags in the green
  // margin; the OS draws native min/max/close on top at the right.
  // Rendered in both reference and normal modes so the window is always
  // movable.
  const titleBar = <div className="titlebar-drag" aria-hidden="true" />;

  if (import.meta.env.DEV && refMode) {
    return (
      <>
        {titleBar}
        <ReferenceView />
      </>
    );
  }

  // The preload exposes window.herta; if it failed to load, bridge is
  // undefined. Render a diagnosable error screen rather than crashing in
  // the store constructor (which would leave a blank window).
  if (bridge === undefined) {
    const m = locale === "zh" ? zh : en;
    const bridgeParts = m["app.bridgeUnavailable"].split("{bridge}");
    return (
      <>
        {titleBar}
        <ErrorScreen>
          <h2>{m["app.cantStart"]}</h2>
          <p>
            {bridgeParts[0]}
            <code>window.herta</code>
            {bridgeParts[1] ?? ""}
          </p>
          <p>{m["app.bridgeUnavailableBody"]}</p>
        </ErrorScreen>
        {/* Last, like WindowControls below: its no-drag rect must come after
            the drag strip's. */}
        <ErrorWindowControls closeLabel={m["window.closeBtn"]} />
      </>
    );
  }

  return (
    <>
      {titleBar}
      <LocaleProvider
        locale={locale}
        // State only: the Language pane persists the choice itself, so a
        // failed write can snap the UI back and say so (UX review
        // 2026-09-22, item 17).
        onLocaleChange={setLocale}
      >
        <HertaBridgeProvider bridge={bridge}>
          {/* Render-crash containment (audit 2026-07-13 T2.2): a throw in
              any row/panel renderer used to unmount the whole root — blank
              window, restart-only. The fallback keeps the frame + reload. */}
          <ErrorBoundary
            label="workbench"
            fallback={(error) => <WorkbenchCrashScreen error={error} />}
          >
            <Workbench booting={booting} />
          </ErrorBoundary>
          {/* Custom caption buttons — replaces the native titleBarOverlay
              (its tooltips could not be disabled and doubled on Windows;
              user 2026-07-06). Rendered LAST deliberately: Chromium applies
              app-region rects in document order, so this no-drag rect must
              come after every drag rect (.titlebar-drag AND .topbar inside
              Workbench) or a later drag re-covers the corner and the OS
              swallows the buttons' mouse events (the 2nd dead-buttons bug). */}
          <WindowControls />
        </HertaBridgeProvider>
      </LocaleProvider>
      {!splashDone && (
        <OpeningAscii
          onFadeStart={() => {
            setSplashFading(true);
            journeyMarkAfterPaint("launch:revealed");
          }}
          onDone={() => {
            setSplashDone(true);
            journeyMarkAfterPaint("launch:interactive");
          }}
        />
      )}
    </>
  );
}
