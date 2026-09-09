import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  screen,
  session,
  shell,
} from "electron";
import hertaIcon from "../../resources/herta-icon.png?asset";
import { CMD, EVT } from "../preload/channels.js";
import { isAllowedExternalUrl } from "../shared/links.js";
import {
  readGlobalSettings,
  resolveInitialLocale,
  updateGlobalSettings,
  type WindowStateSnapshot,
} from "./app-global-settings.js";
import {
  registerAssetProtocol,
  registerAssetScheme,
  resolveDeviceSceneRoot,
} from "./asset-protocol.js";
import {
  registerAttachmentProtocol,
  registerAttachmentScheme,
} from "./attachment-protocol.js";
import { buildCsp } from "./csp.js";
import { applyLoginPath } from "./login-path.js";
import { installChromiumFetch } from "./net-transport.js";
import {
  appWorkspaceRoot,
  createSessionService,
  type SessionService,
} from "./session-service.js";
import { type AppTray, createAppTray } from "./tray.js";
import {
  appVersion,
  createUpdateService,
  type UpdateService,
} from "./update-service.js";
import { resolveVoiceRoot } from "./voice-path.js";
import {
  registerVoiceProtocol,
  registerVoiceScheme,
} from "./voice-protocol.js";
import { applyWindowsPath } from "./win-path.js";
import { captureWindowState, restoreWindowBounds } from "./window-state.js";

// Privileged-scheme registration MUST happen before app ready (Electron
// requirement), so the `herta-voice` audio scheme, the `herta-attachment`
// image scheme (ADR 0048) and the `herta-asset` scene-asset scheme (ADR
// 0057) are declared at module load.
registerVoiceScheme();
registerAttachmentScheme();
registerAssetScheme();

/**
 * The dev-server URL — ONLY in a non-packaged build (audit 2026-08-05, S2).
 *
 * `ELECTRON_RENDERER_URL` was read straight from the environment with no
 * `app.isPackaged` gate, while the sibling update-feed override IS gated. A
 * packaged app launched with that variable set (a doctored shortcut, any
 * local process that can shape the environment) loaded an attacker-chosen
 * origin into the main window — and the preload attaches unconditionally, so
 * `contextBridge.exposeInMainWorld("herta", …)` handed that page all 60+ IPC
 * channels. It could submitText, self-approve its own permission gate (the
 * pending requestId is delivered to the renderer), setWorkspace, and REPLACE
 * the API key. It could not read the key back — `getDeepSeekKeyStatus`
 * returns only `{set, encrypted}`.
 *
 * Resolved ONCE at module scope, and used both for the load AND by the two
 * `will-navigate` allowlists — re-reading `process.env` inside those handlers
 * would leave navigation attacker-controlled even with the load gated.
 *
 * Precondition is local code execution as the same user, which is why this
 * was not a blocker; the project rated the strictly weaker `HERTA_UPDATE_URL`
 * variant Tier 1, so the posture here matches that.
 */
const devRendererUrl = app.isPackaged
  ? undefined
  : process.env.ELECTRON_RENDERER_URL;

/** True when `url` belongs to the dev server — ORIGIN comparison, not a
 *  prefix test (audit BL21): `startsWith` would accept
 *  `http://localhost:5173.evil.com`. Dead code in a correctly packaged build,
 *  where `devRendererUrl` is undefined. */
function isDevRendererUrl(url: string): boolean {
  if (devRendererUrl === undefined) return false;
  try {
    return new URL(url).origin === new URL(devRendererUrl).origin;
  } catch {
    return false;
  }
}

/** The packaged renderer's own file:// URL — the ONLY file navigation the
 *  main window may perform (will-navigate pin, audit 2026-07-10 §6). */
const appFileUrlExact = pathToFileURL(
  join(__dirname, "../renderer/index.html"),
).href;

// Global navigation posture (audit T3.7): the same guards are attached to
// the main window at creation, but per-window wiring means any FUTURE
// webContents — a second window, a webview, anything a later feature adds —
// would start life unguarded and someone would have to remember. This
// covers every webContents the app ever creates: child windows denied,
// navigation pinned to the app's own URL. A surface that genuinely needs
// more must opt in explicitly where it is created.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    // Same gated constant + origin compare as the main window's handler:
    // re-reading process.env here would leave navigation attacker-controlled
    // even with the LOAD gated (audit S2), and `startsWith` would accept
    // `http://localhost:5173.evil.com` (audit BL21).
    const allowed =
      isDevRendererUrl(url) || url.split(/[?#]/, 1)[0] === appFileUrlExact;
    if (!allowed) event.preventDefault();
  });
});

/** The single main window + its session service (single-window app). */
let mainWindow: BrowserWindow | null = null;
let mainService: SessionService | null = null;
/** Held module-level: a GC'd Tray silently vanishes from the OS tray. */
let tray: AppTray | null = null;
/** Auto-update service (2026-07-10): check on launch + every 4h, background
 *  differential download, install-on-quit; Settings drives manual checks +
 *  restart-now. Held module-level (one per app, not per window). */
let updateService: UpdateService | null = null;
/** Close-to-tray override (user 2026-07-04): the window close button HIDES
 *  the app to the tray; only an explicit exit (tray menu, OS/app quit) may
 *  actually close the window. This flag flips when a real quit begins. */
let quitRequested = false;
/** Settings → Window: whether the close button hides to the tray (default —
 *  the original behavior) or actually quits. Seeded from the persisted
 *  global settings at ready; live-updated via the session service's
 *  onCloseToTrayChanged hook, so a toggle applies to the very next close. */
let closeToTray = true;

/** Restore + focus the main window (recreating it if it was destroyed). */
function showMainWindow(): void {
  const win = mainWindow;
  if (win === null || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Real exit, via the same flush path as a pre-tray window close: closing
 *  the window sets `pendingDispose` (session flush), `window-all-closed`
 *  quits, and `before-quit` holds until the flush settles. Direct quits
 *  (the updater's quitAndInstall, Cmd+Q, OS logout) skip the window-close
 *  step, so `before-quit` now starts the dispose eagerly for those shapes
 *  (audit 2026-07-10, finding 7) — the close-first route here remains
 *  preferred for its orderly renderer teardown, not for the hold. */
function requestExit(): void {
  quitRequested = true;
  const win = mainWindow;
  if (win !== null && !win.isDestroyed()) win.close();
  else app.quit();
}

// Single-instance lock: two processes would write the same workspace .herta
// transcripts, the same userData key store, and the same app settings —
// silent last-writer-wins corruption. The second launch exits; the first
// gets `second-instance` and surfaces its window instead (which may be
// hidden to the tray — showMainWindow covers hidden, minimized, and gone).
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

/** Native window background per theme (night mode 2026-07-13): the beat a
 *  cold launch / resize shows before the renderer paints. Light matches the
 *  splash near-white; dark matches the dark shell. "system" follows the OS
 *  via nativeTheme. */
function windowBackgroundFor(theme: "light" | "dark" | "system"): string {
  const dark =
    theme === "dark" || (theme === "system" && nativeTheme.shouldUseDarkColors);
  return dark ? "#0d1116" : "#eef6f9";
}

function applyWindowBackground(
  win: BrowserWindow,
  theme: "light" | "dark" | "system",
): void {
  win.setBackgroundColor(windowBackgroundFor(theme));
}

/** Window-geometry persistence (2026-07-13): the last captured state — seeded
 *  from GlobalSettings before the window is created, refreshed by the
 *  geometry listeners below, written back debounced (and immediately on
 *  close, with before-quit holding exit until the write settles). A user who
 *  works maximized/fullscreen relaunches straight into that. */
let lastWindowState: WindowStateSnapshot | null = null;
/** The persisted theme, read at boot — the window constructs already tinted
 *  (previously a fire-and-forget read re-tinted a beat after creation). */
let lastTheme: "light" | "dark" | "system" = "system";
let windowStateTimer: NodeJS.Timeout | null = null;
/** In-flight settings write for the window state — before-quit awaits it so
 *  a maximize-then-quit can't lose the final capture. */
let pendingStateWrite: Promise<void> | null = null;

function persistWindowState(): void {
  const snap = lastWindowState;
  if (snap === null) return;
  // Serialized RMW (audit 2026-07-13 T1.4): this is the high-frequency
  // producer — unqueued, a mid-drag flush raced the Settings hooks and one
  // write clobbered the other's field.
  pendingStateWrite = updateGlobalSettings(app.getPath("userData"), (s) => ({
    ...s,
    windowState: snap,
  })).catch(() => undefined);
}

function scheduleWindowStatePersist(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  lastWindowState = captureWindowState(win);
  if (windowStateTimer !== null) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    windowStateTimer = null;
    persistWindowState();
  }, 750);
}

function createWindow(): BrowserWindow {
  // Reopen with the geometry the user left (2026-07-13): saved normal
  // bounds — position dropped if no longer on any display — with
  // maximized/fullscreen replayed after creation.
  // The PRIMARY display goes first: with no saved state the window opens
  // there, and restoreWindowBounds fits both the size and the minimum to
  // whichever work area it picks. getAllDisplays() is unordered, so passing
  // it alone left the fallback display arbitrary.
  const primaryArea = screen.getPrimaryDisplay().workArea;
  const bounds = restoreWindowBounds(lastWindowState ?? undefined, [
    primaryArea,
    ...screen
      .getAllDisplays()
      .map((d) => d.workArea)
      .filter((a) => a !== primaryArea),
  ]);
  const win = new BrowserWindow({
    // Carries width/height/x/y AND minWidth/minHeight — one object, so the
    // size and the floor cannot drift apart (they were separate literals
    // here, which is how the floor came to exceed small displays).
    ...bounds,
    // Start at the SPLASH surface for the stored theme, not the body's cyan:
    // on a cold first launch the window paints `backgroundColor` for a beat —
    // while the renderer process spins up and the bundle loads — before React
    // mounts the opening splash. Themed at construction since 2026-07-13
    // (the theme is read before createWindow), so a dark launch no longer
    // flashes the light base either.
    backgroundColor: windowBackgroundFor(lastTheme),
    // Frameless with CUSTOM caption buttons (SPEC v0.3 §5.1.1, revised
    // 2026-07-06): the window is chromeless and the renderer draws its own
    // min/max/close (WindowControls.tsx) wired through the window:* IPC
    // below. The former titleBarOverlay was dropped because its
    // Chromium-drawn buttons show hover tooltips that cannot be disabled —
    // and on Windows they DOUBLE (a classic Win32 tip layered on
    // Chromium's; user report 2026-07-06). Known trade-off: no Windows 11
    // Snap Layouts flyout on the maximize button. The renderer's
    // transparent .titlebar-drag strip provides the draggable region; on
    // macOS "hidden" still yields the native inset traffic lights and the
    // renderer skips its custom buttons.
    titleBarStyle: "hidden",
    // Window/taskbar icon (user 2026-07-06): the rounded Herta icon, bundled
    // from resources/ (reference_UX_design/ never ships). The future
    // installer icon comes from the same file via the packager config.
    icon: hertaIcon,
    webPreferences: {
      // `.cjs`, explicitly (audit T3.6): a SANDBOXED renderer only loads
      // CJS preload scripts — the type:module default (index.mjs) silently
      // fails to attach and window.herta comes up undefined. The preload
      // build pins `format: "cjs"` (electron.vite.config.ts); a wrong
      // extension here fails the same silent way.
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Renderer M1 closed (audit T3.6): the preload uses only
      // sandbox-provided APIs (contextBridge, ipcRenderer,
      // process.platform), and electron-vite bundles it self-contained —
      // nothing needed the unsandboxed renderer. Verified live: boot,
      // bridge IPC (list/create/delete/theme), the herta-voice:// protocol,
      // and WebGL all behave identically sandboxed.
      sandbox: true,
      // The opening voice autoplays at session start (before any user gesture);
      // without this, Chromium's default policy blocks autoplay-with-audio.
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  // Replay the saved display mode. Fullscreen wins over maximized (they can
  // both be true — a maximized window taken fullscreen).
  if (lastWindowState?.fullScreen === true) {
    win.setFullScreen(true);
  } else if (lastWindowState?.maximized === true) {
    win.maximize();
  }
  // Track geometry/mode changes for the next launch (debounced persist; the
  // close handler below flushes immediately).
  win.on("resize", () => scheduleWindowStatePersist(win));
  win.on("move", () => scheduleWindowStatePersist(win));
  win.on("maximize", () => scheduleWindowStatePersist(win));
  win.on("unmaximize", () => scheduleWindowStatePersist(win));
  win.on("enter-full-screen", () => scheduleWindowStatePersist(win));
  win.on("leave-full-screen", () => scheduleWindowStatePersist(win));

  // Navigation guards: rendered content includes model-generated text — no
  // anchor or window.open may ever navigate this window away from the app or
  // spawn an unconfigured child window (no preload, inherited privileges).
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    // Pinned to the app's OWN index.html, not any file:// URL (audit
    // 2026-07-10 §6): the broad scheme match would have let a crafted
    // anchor navigate this privileged window to an arbitrary local file.
    // Unexploitable today (bubbles render no anchors) — defense-in-depth.
    const allowed =
      isDevRendererUrl(url) || url.split(/[?#]/, 1)[0] === appFileUrlExact;
    if (!allowed) event.preventDefault();
  });

  if (devRendererUrl !== undefined) {
    void win.loadURL(devRendererUrl);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // Own the SessionHost for this window's renderer. start() on
  // did-finish-load so the initial session:reset is not dropped before the
  // renderer subscribes; dispose() on close. The dispose promise is tracked so
  // `before-quit` can hold app exit until the session flushes (a window close
  // mid-stream raced `app.quit()` against the async closeActiveSession —
  // persistence inside it could be truncated).
  const service = createSessionService(win.webContents, win, {
    // Settings → Language: the tray tooltip is OS-rendered on hover, so it
    // must be re-pushed when the locale changes (user 2026-07-04 — it stayed
    // 黑塔 after switching to English until restart).
    onLocaleChanged: () => tray?.refreshTooltip(),
    // Settings → Window: live-apply the close-to-tray flag.
    onCloseToTrayChanged: (enabled) => {
      closeToTray = enabled;
    },
    // Settings → Update: live-apply the automatic-update toggle (cancels or
    // restarts the update service's check cycle; manual checks unaffected).
    onAutoUpdateChanged: (enabled) => {
      updateService?.setAutoEnabled(enabled);
    },
    // Settings → Window appearance: retint the NATIVE window background —
    // the pre-paint/resize surface CSS can't cover (night mode 2026-07-13).
    onThemeChanged: (theme) => {
      // Keep native surfaces (tray menu, dialogs) on the app's theme, not
      // the OS default — set before the retint so a "system" background
      // resolves against the fresh source.
      nativeTheme.themeSource = theme;
      applyWindowBackground(win, theme);
    },
  });
  win.webContents.on("did-finish-load", () => {
    void service.start();
  });
  // Close-to-tray: the caption close button hides the window (the session —
  // and any streaming turn — keeps running; the tray is the way back in).
  // A real quit (tray Exit, OS shutdown, app.quit) sets `quitRequested`
  // first, so this guard steps aside and the close proceeds into the normal
  // dispose/flush path below. Settings → Window can turn the behavior off
  // (`closeToTray` false → the close button quits like a normal app, via
  // the same window-all-closed → before-quit flush hold).
  win.on("close", (event) => {
    // Final geometry capture + immediate flush (the debounced write may
    // still be pending; a maximize-then-close must not lose the last
    // state). before-quit awaits pendingStateWrite on real quits.
    lastWindowState = captureWindowState(win);
    if (windowStateTimer !== null) {
      clearTimeout(windowStateTimer);
      windowStateTimer = null;
    }
    persistWindowState();
    if (!quitRequested && closeToTray) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) {
      mainWindow = null;
      mainService = null;
    }
    pendingDispose = service.dispose().catch(() => undefined);
  });

  // Maximize-state → renderer (drives the custom max/restore glyph).
  win.on("maximize", () => {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(EVT.windowMaximized, true);
    }
  });
  win.on("unmaximize", () => {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(EVT.windowMaximized, false);
    }
  });

  registerWindowControlHandlers();
  registerUpdateHandlers();

  mainWindow = win;
  mainService = service;
  return win;
}

/** Update IPC (2026-07-10). Idempotent and re-run per createWindow for the
 *  same reason as the window controls: the session service's dispose()
 *  sweeps removeHandler over every CMD channel, so a window recreate must
 *  restore these. The handlers read the module-level service and no-op
 *  safely before it exists (the lazy electron-updater import). */
function registerUpdateHandlers(): void {
  ipcMain.removeHandler(CMD.updateCheck);
  ipcMain.removeHandler(CMD.updateRestart);
  ipcMain.removeHandler(CMD.updateStatus);
  ipcMain.removeHandler(CMD.appVersion);
  ipcMain.removeHandler(CMD.openExternal);
  ipcMain.handle(CMD.updateCheck, async () => {
    await updateService?.checkNow();
  });
  // An https link to an allowlisted host (`shared/links.ts`) opens in the
  // OS browser — the netdisk mirror when the update feed is out of reach
  // (2026-09-09). Anything else is refused here, not merely hidden in the
  // renderer: the renderer is not trusted with an "open any URL" door.
  ipcMain.handle(CMD.openExternal, async (_e, url: unknown) => {
    if (typeof url !== "string" || !isAllowedExternalUrl(url)) return;
    await shell.openExternal(url);
  });
  ipcMain.handle(CMD.updateRestart, () => {
    updateService?.restartAndInstall();
  });
  ipcMain.handle(
    CMD.updateStatus,
    () => updateService?.current() ?? { phase: "idle" },
  );
  ipcMain.handle(CMD.appVersion, () => appVersion());
}

/** Custom caption-button IPC (acts on the current window). Idempotent and
 *  re-run per createWindow: the session service's dispose() sweeps
 *  removeHandler over every CMD channel (including windowIsMaximized), so a
 *  window recreate (macOS activate after all windows closed) must be able
 *  to re-register cleanly without accumulating `on` listeners.
 *  `windowClose` calls win.close(), so the close-to-tray guard above applies
 *  exactly as it did for the native button. */
function registerWindowControlHandlers(): void {
  ipcMain.removeAllListeners(CMD.windowMinimize);
  ipcMain.removeAllListeners(CMD.windowToggleMaximize);
  ipcMain.removeAllListeners(CMD.windowClose);
  ipcMain.removeHandler(CMD.windowIsMaximized);
  ipcMain.on(CMD.windowMinimize, () => {
    const win = mainWindow;
    if (win !== null && !win.isDestroyed()) win.minimize();
  });
  ipcMain.on(CMD.windowToggleMaximize, () => {
    const win = mainWindow;
    if (win === null || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on(CMD.windowClose, () => {
    const win = mainWindow;
    if (win !== null && !win.isDestroyed()) win.close();
  });
  ipcMain.handle(CMD.windowIsMaximized, () => {
    const win = mainWindow;
    return win !== null && !win.isDestroyed() && win.isMaximized();
  });
}

/** The most recent window's in-flight dispose — awaited by before-quit. */
let pendingDispose: Promise<void> | null = null;

void app.whenReady().then(async () => {
  // Read the per-user settings BEFORE creating the window (2026-07-13; was
  // fire-and-forget): the close-to-tray flag, the theme (the window now
  // constructs already tinted — no light flash on a dark launch), and the
  // saved window geometry/mode all shape the first frame. The read is a
  // few ms of local IO; a failure falls back to the defaults.
  const s = await readGlobalSettings(app.getPath("userData")).catch(
    () => ({}) as Awaited<ReturnType<typeof readGlobalSettings>>,
  );
  // Deny every renderer permission request (audit BL22). Electron grants them
  // by default, and this renderer asks for none: its only `navigator.` use is
  // `navigator.language`, and `new Audio(herta-voice://…)` needs no
  // permission. So a blanket deny costs nothing today and means a future
  // dependency cannot quietly acquire the camera, the microphone, geolocation
  // or notifications on a window that also holds the app's IPC bridge.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, done) => {
    done(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  // Content-Security-Policy (audit BL2). Injected here rather than as a <meta>
  // tag so dev and packaged can differ — Vite needs eval and its HMR socket,
  // the shipped app needs neither. `connect-src 'none'` when packaged is the
  // directive that matters: the renderer never talks to the network (the
  // DeepSeek call lives in this process), so an injected script has nowhere to
  // send a transcript.
  {
    const csp = buildCsp({
      isPackaged: app.isPackaged,
      indexHtmlPath: join(__dirname, "../renderer/index.html"),
      ...(devRendererUrl !== undefined ? { devOrigin: devRendererUrl } : {}),
    });
    session.defaultSession.webRequest.onHeadersReceived((details, done) => {
      // Documents only. Every request on this session passes through here,
      // including the DeepSeek calls that installChromiumFetch() below routes
      // through Chromium — stamping a page policy onto an SSE response would
      // be meaningless at best, and this keeps the two features from having
      // to reason about each other. CSP is delivered on the document; its
      // sub-resources are already governed by it.
      if (details.resourceType !== "mainFrame") {
        done({});
        return;
      }
      done({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [csp],
        },
      });
    });
  }

  // Provider egress through Chromium, not Node (audit S3) — installed before
  // the session service so every provider it constructs picks it up, and
  // before the first key validation, which is otherwise the first request the
  // app makes. Gets the OS proxy configuration and the OS trust store, which
  // is what a corporate laptop needs and undici does not have.
  installChromiumFetch();

  // macOS PATH recovery (audit S7) — BEFORE createWindow, because the session
  // service and the cached `rg` probe both inherit whatever PATH exists when
  // they first spawn, and detectRg() caches its answer for the process
  // lifetime. A Finder-launched .app otherwise has only launchd's minimal
  // PATH, so run_command cannot find node/npm/cargo and search silently
  // downgrades to the JS walker. No-op off darwin and when launched from a
  // terminal; bounded so a slow rc file cannot delay startup.
  await applyLoginPath({ platform: process.platform, env: process.env });
  // Windows PATH recovery (ADR 0044) — same seam, same reason: the app
  // inherits Explorer's PATH snapshot, so a node/git installed after that
  // snapshot resolves in every fresh terminal but not here. Appends the
  // registry's machine+user PATH entries; never removes or reorders what was
  // inherited. No-op off win32; bounded by the reg-query timeouts.
  await applyWindowsPath({ platform: process.platform, env: process.env });
  closeToTray = s.closeToTray ?? true;
  lastTheme = s.theme ?? "system";
  // Native surfaces (tray context menu, system dialogs) follow Chromium's
  // theme source, not the renderer's CSS — without this, a dark app on a
  // light-mode OS pops a white tray menu. The pref enum maps 1:1 onto
  // themeSource, and the renderer only consults prefers-color-scheme while
  // the pref is "system" (when the source is also "system"), so overriding
  // it for explicit light/dark can't feed back into theme resolution.
  nativeTheme.themeSource = lastTheme;
  lastWindowState = s.windowState ?? null;
  // Serve voice clips over herta-voice:// — from the bundled resources copy
  // when packaged, from the workspace's data/voice in dev (2026-07-06).
  registerVoiceProtocol(
    resolveVoiceRoot({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      workspaceRoot: appWorkspaceRoot(),
    }),
  );
  // Serve attachment images over herta-attachment:// (ADR 0048). The root is
  // a GETTER: attachments live under the BACKEND workspace, which the user
  // can change mid-session, and a captured root would serve stale paths
  // afterwards. Falls back to the app workspace before any session exists.
  registerAttachmentProtocol(
    () => mainService?.backendWorkspace() ?? appWorkspaceRoot(),
  );
  // Serve the 3D device card's bundled assets over herta-asset:// (ADR 0057):
  // Vite copies src/renderer/public into out/renderer, which is what the
  // package carries; an `electron-vite dev` run never populates that copy,
  // so the source directory is the fallback root.
  registerAssetProtocol(
    resolveDeviceSceneRoot([
      join(__dirname, "../renderer/device-scene"),
      join(__dirname, "../../src/renderer/public/device-scene"),
    ]),
  );
  createWindow();
  // Auto-update: created after the window so state pushes have a target.
  // The electron-updater import is deferred to here (require-time) so a dev
  // run without the packaged app-update.yml never touches it unless the
  // dry-run override is set.
  {
    // Dev-only (audit 2026-07-13 T1.3): the override is a private-repo
    // dry-run lever. Honoring it in a PACKAGED build let anyone who could
    // set an env var for the launch (malicious shortcut, local process)
    // point the feed anywhere — and the override also disables the
    // update-service dev gate, so autoInstallOnAppQuit would run whatever
    // that feed served.
    const feedOverride = app.isPackaged
      ? undefined
      : process.env.HERTA_UPDATE_URL;
    // Lazy import keeps electron-updater out of the dev startup path.
    void import("electron-updater")
      .then(async ({ default: pkg }) => {
        const { autoUpdater } = pkg;
        // The persisted Settings → Update toggle seeds the automatic cycle
        // (default on); later changes live-apply via onAutoUpdateChanged.
        const settings = await readGlobalSettings(app.getPath("userData"));
        updateService = createUpdateService({
          updater: autoUpdater,
          isPackaged: app.isPackaged,
          autoEnabled: settings.autoUpdate ?? true,
          ...(feedOverride !== undefined && feedOverride !== ""
            ? { feedUrlOverride: feedOverride }
            : {}),
          send: (state) => {
            const win = mainWindow;
            if (win !== null && !win.isDestroyed()) {
              win.webContents.send(EVT.update, state);
            }
          },
        });
        registerUpdateHandlers();
        updateService.start();
      })
      .catch((err) => {
        // A failed import/bootstrap must not become an unhandledRejection —
        // the app just runs without auto-update (manual checks report idle).
        console.error("[herta] update service bootstrap failed:", err);
      });
  }
  tray = createAppTray({
    listSessions: () => mainService?.listSessions() ?? [],
    openSession: async (id) => {
      await mainService?.openSessionFromMain(id);
    },
    newChat: async () => {
      await mainService?.createSessionFromMain();
    },
    showWindow: showMainWindow,
    requestExit,
    getLocale: async () => {
      const s = await readGlobalSettings(app.getPath("userData"));
      return resolveInitialLocale(s, app.getLocale());
    },
  });
  app.on("activate", () => {
    // macOS dock click: recreate if gone, otherwise surface the (possibly
    // hidden-to-tray) existing window.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Hold quit until the closing session's dispose settles (bounded — a hung
// flush must not wedge exit). Without this, app.quit() raced the async
// closeActiveSession fired on window close.
let quitHeld = false;
app.on("before-quit", (event) => {
  // An app/OS-initiated quit (Cmd+Q, logout, updater) reaches the window's
  // close handler next — flip the close-to-tray override FIRST or that
  // handler would preventDefault + hide, silently cancelling the quit.
  quitRequested = true;
  if (quitHeld) return;
  // Quit paths that arrive BEFORE the window closed — the updater's
  // quitAndInstall (重启并更新), Cmd+Q, OS logout — found pendingDispose
  // still null here (it was assigned only in win.on("closed"), which has
  // not fired yet on these shapes), so the flush hold below never engaged
  // and the exit raced the session flush: clicking restart-and-update
  // mid-turn could truncate the transcript (audit 2026-07-10, finding 7).
  // Start the dispose eagerly; the closed-handler's later dispose() call
  // is an idempotent no-op, and requestExit's window-close route is
  // unaffected (its dispose is already pending by the time quit begins).
  if (pendingDispose === null && mainService !== null) {
    const service = mainService;
    pendingDispose = service.dispose().catch(() => undefined);
  }
  // Eager window-state capture, the geometry twin of the eager dispose above
  // (audit 2026-07-13 T1.1): on these same direct-quit shapes the window's
  // close handler has not run yet, so pendingStateWrite was still null and
  // the flush hold awaited nothing — a maximize within the 750ms debounce
  // window lost the final geometry. The window is still alive at before-quit
  // time; capture and start the write now so the hold below has something to
  // await. The close handler's later capture of the same state is harmless
  // (writes are serialized).
  const w = mainWindow;
  if (w !== null && !w.isDestroyed()) {
    lastWindowState = captureWindowState(w);
    if (windowStateTimer !== null) {
      clearTimeout(windowStateTimer);
      windowStateTimer = null;
    }
    persistWindowState();
  }
  if (pendingDispose === null && pendingStateWrite === null) return;
  quitHeld = true;
  event.preventDefault();
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, 3000);
  });
  const flushes = Promise.allSettled([
    pendingDispose ?? Promise.resolve(),
    // The window-state write fired by the close handler — a maximize-then-
    // quit must not lose the final geometry capture (2026-07-13).
    pendingStateWrite ?? Promise.resolve(),
  ]);
  void Promise.race([flushes, timeout]).finally(() => {
    pendingDispose = null;
    pendingStateWrite = null;
    app.quit();
  });
});

// Remove the tray icon promptly at exit (Windows otherwise leaves a ghost
// icon in the tray until the next hover sweep).
app.on("will-quit", () => {
  tray?.destroy();
  tray = null;
});
