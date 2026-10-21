import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { appMenuTemplate, DEV_ONLY_ROLES } from "./app-menu.js";

/** Every role anywhere in a template, submenus included. */
function roles(items: readonly MenuItemConstructorOptions[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.role !== undefined) out.push(item.role);
    if (Array.isArray(item.submenu)) out.push(...roles(item.submenu));
  }
  return out;
}

/** Every item anywhere in a template, submenus included. */
function items(
  list: readonly MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (const item of list) {
    out.push(item);
    if (Array.isArray(item.submenu)) out.push(...items(item.submenu));
  }
  return out;
}

describe("appMenuTemplate (UX review 2026-09-22, item 7)", () => {
  it("a packaged build carries no reload and no developer tools, on every platform", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const all = roles(appMenuTemplate({ platform, isPackaged: true }));
      for (const role of DEV_ONLY_ROLES) expect(all).not.toContain(role);
    }
  });

  it("keeps editing, zoom, full screen and the window roles — macOS needs the Edit menu for Cmd+C", () => {
    const mac = roles(
      appMenuTemplate({ platform: "darwin", isPackaged: true }),
    );
    expect(mac).toEqual(
      expect.arrayContaining([
        "about",
        "hide",
        "quit",
        "editMenu",
        "zoomIn",
        "zoomOut",
        "resetZoom",
        "togglefullscreen",
        "windowMenu",
      ]),
    );
    const win = roles(appMenuTemplate({ platform: "win32", isPackaged: true }));
    expect(win).toEqual(
      expect.arrayContaining(["quit", "editMenu", "minimize"]),
    );
    expect(win).not.toContain("appMenu");
  });

  it("Settings… (Ctrl/⌘+,) and Close (Ctrl/⌘+W) are accelerators on every platform, with the shortcut table's keys (ADR 0082 §2)", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      let opened = 0;
      let closed = 0;
      const all = items(
        appMenuTemplate({
          platform,
          isPackaged: true,
          onOpenSettings: () => {
            opened += 1;
          },
          onCloseRequested: () => {
            closed += 1;
          },
        }),
      );
      const settings = all.find((i) => i.accelerator === "CmdOrCtrl+,");
      const close = all.find((i) => i.accelerator === "CmdOrCtrl+W");
      expect(settings?.label).toBe("Settings…");
      expect(close?.label).toBe("Close");
      // Electron passes (menuItem, window, event); the items ignore them.
      (settings?.click as (() => void) | undefined)?.();
      (close?.click as (() => void) | undefined)?.();
      expect([opened, closed]).toEqual([1, 1]);
      // The close ROLE gave way to the item: the renderer decides between
      // closing the viewer's tab and closing the app (see App.tsx).
      expect(roles(all)).not.toContain("close");
      expect(roles(all)).not.toContain("fileMenu");
    }
  });

  it("macOS keeps Settings… in the app menu and Close in File, where a Mac has them (platform review 2026-09-23)", () => {
    const template = appMenuTemplate({ platform: "darwin", isPackaged: true });
    const app = template[0];
    const appItems = Array.isArray(app?.submenu) ? app.submenu : [];
    expect(appItems.some((i) => i.label === "Settings…")).toBe(true);
    const file = template.find((m) => m.label === "File");
    const fileItems = Array.isArray(file?.submenu) ? file.submenu : [];
    expect(fileItems.map((i) => i.label)).toEqual(["Close"]);
  });

  it("a development build gets the same menu plus reload and the developer tools, under Developer", () => {
    const dev = appMenuTemplate({ platform: "win32", isPackaged: false });
    const developer = dev.find((m) => m.label === "Developer");
    expect(roles(developer === undefined ? [] : [developer])).toEqual([
      "reload",
      "forceReload",
      "toggleDevTools",
    ]);
    expect(items(dev).some((i) => i.accelerator === "CmdOrCtrl+W")).toBe(true);
  });
});
