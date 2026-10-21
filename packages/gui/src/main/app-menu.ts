import type { MenuItemConstructorOptions } from "electron";
import { accelerator, primaryKey } from "../shared/shortcuts.js";

/** Roles a packaged app must never carry: each one is a keyboard shortcut
 *  that reloads the window or opens the developer tools. */
export const DEV_ONLY_ROLES: ReadonlySet<string> = new Set([
  "reload",
  "forceReload",
  "toggleDevTools",
]);

/**
 * The application menu.
 *
 * The window is frameless (`titleBarStyle: "hidden"`), so no menu is ever
 * SEEN on Windows or Linux — but the installed menu's accelerators stay live.
 * Electron's default one let Ctrl+R reload the window mid-turn and
 * Ctrl+Shift+I open the developer tools on a window that holds the app's
 * whole IPC bridge (UX review 2026-09-22, item 7): a packaged build carries
 * none of those three roles. A development build gets them back, under
 * Developer (they are how the app is worked on). Editing, zoom, full screen
 * and minimize stay: on macOS the Edit menu is what makes Cmd+C / Cmd+V work
 * in a text field at all.
 *
 * Two of the app's own shortcuts are accelerators here, on every platform
 * (ADR 0082 §2), with the keys from the shortcut table:
 * - Settings… (Ctrl/⌘+,) — on macOS where every Mac app has it, the app
 *   menu (platform review 2026-09-23); elsewhere in File;
 * - Close (Ctrl/⌘+W) — the renderer decides: the viewer's tab when the
 *   viewer is open, the window otherwise. On macOS it lives in File, where a
 *   Mac has it; elsewhere in Window, where the close role was.
 *
 * The labels stay English like the role menus around them, which Electron
 * does not translate.
 */
export function appMenuTemplate(opts: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  /** The Settings… item's action. */
  readonly onOpenSettings?: () => void;
  /** The Close item's action. */
  readonly onCloseRequested?: () => void;
}): MenuItemConstructorOptions[] {
  const mac = opts.platform === "darwin";
  const settings: MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: accelerator(primaryKey("openSettings")),
    click: () => opts.onOpenSettings?.(),
  };
  const close: MenuItemConstructorOptions = {
    label: "Close",
    accelerator: accelerator(primaryKey("closeTab")),
    click: () => opts.onCloseRequested?.(),
  };
  const head: MenuItemConstructorOptions[] = mac
    ? [
        {
          label: "Herta",
          submenu: [
            { role: "about" },
            { type: "separator" },
            settings,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        { label: "File", submenu: [close] },
      ]
    : [
        {
          label: "File",
          submenu: [settings, { type: "separator" }, { role: "quit" }],
        },
      ];
  return [
    ...head,
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    mac
      ? { role: "windowMenu" }
      : { label: "Window", submenu: [{ role: "minimize" }, close] },
    ...(opts.isPackaged
      ? []
      : [
          {
            label: "Developer",
            submenu: [
              { role: "reload" },
              { role: "forceReload" },
              { role: "toggleDevTools" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]),
  ];
}
