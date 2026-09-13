import type { SessionMetadata } from "@herta/app-server";
import { Menu, nativeImage, Tray } from "electron";
import type { Locale } from "./app-global-settings.js";
import {
  buildTrayMenuTemplate,
  renderTrayIconBitmap,
  trayLabels,
} from "./tray-menu.js";

export interface AppTrayDeps {
  /** Newest-first metadata for the Recent section (empty until bootstrap). */
  listSessions(): readonly SessionMetadata[];
  /** Activate an existing session (same last-click-wins path as the sidebar). */
  openSession(sessionId: string): Promise<void>;
  /** Create + activate a fresh session (tray "New Chat"). */
  newChat(): Promise<void>;
  /** Restore + focus the (possibly hidden-to-tray) main window. */
  showWindow(): void;
  /** Real exit — the close-to-tray override must NOT apply here. */
  requestExit(): void;
  /** Persisted UI locale; the menu is rebuilt per open so a language switch
   *  in Settings applies to the very next right-click. */
  getLocale(): Promise<Locale>;
  /** `process.platform`. Injectable because the Linux / other split below is
   *  the whole point of the menu wiring and the electron module cannot load
   *  under the node test environment. */
  readonly platform?: NodeJS.Platform;
}

export interface AppTray {
  /** Re-resolve the persisted locale and update the hover tooltip. Called
   *  at creation and by the Settings → Language apply path — the tooltip is
   *  rendered by the OS on hover (no menu open involved), so it must be
   *  pushed on change; per-open re-resolution only covers the MENU labels. */
  refreshTooltip(): void;
  /** Rebuild and re-attach the tray's menu. Load-bearing on Linux, where the
   *  attached menu IS the menu (below); a no-op elsewhere, where the menu is
   *  built per open. Called at creation, on a locale change, after the menu's
   *  own actions, and when the window hides to the tray. */
  refreshMenu(): void;
  destroy(): void;
}

/**
 * The tray image, per platform.
 *
 * Windows: the colored badge at 32px, as before.
 *
 * macOS: the menu bar wants a TEMPLATE image — black-and-alpha only, which
 * the OS then tints for the light/dark menu bar and for the highlighted
 * state. Shipping the colored badge there would render a dark blob that
 * ignores the menu bar's appearance. Two differences beyond the color:
 *   - the glyph is KNOCKED OUT (alpha 0) rather than painted white, since a
 *     template's opaque pixels all become one color — the "H." reads as a
 *     cutout in the badge silhouette;
 *   - the 32px bitmap is added as an @2x representation of a 16pt image, so
 *     it stays crisp on Retina AND fits the ~22pt menu bar (a plain 32px
 *     nativeImage would be interpreted as 32pt and get scaled down).
 * NOT verifiable on this machine — the macOS CI screenshot captures the full
 * screen including the menu bar, which is where this gets checked.
 */
function buildTrayIcon(size: number): Electron.NativeImage {
  if (process.platform !== "darwin") {
    return nativeImage.createFromBitmap(renderTrayIconBitmap(size), {
      width: size,
      height: size,
    });
  }
  const img = nativeImage.createEmpty();
  img.addRepresentation({
    scaleFactor: 2,
    width: size,
    height: size,
    buffer: renderTrayIconBitmap(size, { template: true }),
  });
  img.setTemplateImage(true);
  return img;
}

/**
 * System-tray affordance (user 2026-07-04): the window close button hides to
 * the tray instead of quitting (index.ts owns that), and this tray is then
 * the app's persistent presence — left-click reopens the window; right-click
 * shows Recent sessions / New Chat / Open / Exit, Codex-style.
 *
 * TWO menu models, because the platforms do not share one:
 *
 * - macOS / Windows: the menu is built FRESH on every right-click
 *   (popUpContextMenu, not a static setContextMenu) so the Recent list always
 *   reflects the current sessions without any invalidation bookkeeping.
 * - Linux: neither works. `popUpContextMenu` and the `click` /
 *   `right-click` events are darwin/win32 in Electron; a StatusNotifier host
 *   (waybar, GNOME's AppIndicator extension, KDE) renders whatever menu the
 *   item EXPORTS, and shows it on activation. Without `setContextMenu` the
 *   exported menu is empty — the icon then has no menu at all, which is what
 *   the first Linux build shipped (2026-09-13). So Linux attaches one, and
 *   `refreshMenu()` re-attaches it at the moments the Recent list can have
 *   moved.
 */
export function createAppTray(deps: AppTrayDeps): AppTray {
  const hostRendersMenu = (deps.platform ?? process.platform) === "linux";
  const size = 32;
  const icon = buildTrayIcon(size);
  const tray = new Tray(icon);
  const refreshTooltip = (): void => {
    void deps
      .getLocale()
      .then((l) => tray.setToolTip(trayLabels(l).tooltip))
      .catch(() => tray.setToolTip(trayLabels("en").tooltip));
  };
  refreshTooltip();

  const show = (): void => deps.showWindow();
  tray.on("click", show);
  tray.on("double-click", show);

  /** The menu as of NOW — the locale read is its only async part. */
  const buildMenu = async (): Promise<Menu> => {
    let locale: Locale = "en";
    try {
      locale = await deps.getLocale();
    } catch {
      // settings unreadable → English labels; the menu still works.
    }
    const labels = trayLabels(locale);
    const template = buildTrayMenuTemplate(deps.listSessions(), labels, {
      // Opening a session / starting a chat from the tray also SHOWS the
      // window — the tray is a launcher, not a headless console; the
      // renderer adopts the activation via the session:reset it receives.
      onOpenSession: (id) => {
        deps.showWindow();
        afterAction(deps.openSession(id));
      },
      onNewChat: () => {
        deps.showWindow();
        afterAction(deps.newChat());
      },
      onShow: show,
      onExit: () => deps.requestExit(),
    });
    return Menu.buildFromTemplate(template);
  };

  const refreshMenu = (): void => {
    if (!hostRendersMenu || tray.isDestroyed()) return;
    void buildMenu()
      .then((menu) => {
        if (!tray.isDestroyed()) tray.setContextMenu(menu);
      })
      .catch(() => {
        // Keep the previous menu rather than blank the icon's.
      });
  };

  /** Run a menu action, then re-attach: opening or creating a session moves
   *  the Recent order, and on Linux what is attached is what gets shown. */
  const afterAction = (work: Promise<void>): void => {
    void work.then(refreshMenu, refreshMenu);
  };

  refreshMenu();
  // Registered on every platform; only darwin/win32 ever emit it (the Linux
  // host opens the attached menu itself).
  tray.on("right-click", () => {
    void buildMenu().then((menu) => tray.popUpContextMenu(menu));
  });

  return {
    refreshTooltip,
    refreshMenu,
    destroy: () => tray.destroy(),
  };
}
