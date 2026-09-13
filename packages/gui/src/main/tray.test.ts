import type { SessionMetadata } from "@herta/app-server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AppTrayDeps, createAppTray } from "./tray.js";

/** What the electron mock records; the Tray/Menu fakes below push into it. */
interface FakeTray {
  handlers: Map<string, (...args: unknown[]) => void>;
  contextMenus: unknown[];
  popped: unknown;
  tooltip: string;
  destroyed: boolean;
}

const h = vi.hoisted(() => ({
  trays: [] as FakeTray[],
  menus: [] as unknown[],
}));

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: (template: unknown) => {
      const menu = { template };
      h.menus.push(menu);
      return menu;
    },
  },
  nativeImage: {
    createFromBitmap: () => ({ kind: "bitmap" }),
    createEmpty: () => ({
      addRepresentation: () => undefined,
      setTemplateImage: () => undefined,
    }),
  },
  Tray: class {
    readonly handlers = new Map<string, (...args: unknown[]) => void>();
    readonly contextMenus: unknown[] = [];
    popped: unknown = null;
    tooltip = "";
    destroyed = false;
    constructor(_icon: unknown) {
      h.trays.push(this as unknown as FakeTray);
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.handlers.set(event, listener);
      return this;
    }
    setContextMenu(menu: unknown): void {
      this.contextMenus.push(menu);
    }
    popUpContextMenu(menu?: unknown): void {
      this.popped = menu ?? "attached";
    }
    setToolTip(text: string): void {
      this.tooltip = text;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
    }
  },
}));

const tray = (): FakeTray => {
  const last = h.trays.at(-1);
  if (last === undefined) throw new Error("no tray was constructed");
  return last;
};

const labels = (menu: unknown): (string | undefined)[] =>
  (menu as { template: { label?: string }[] }).template.map((i) => i.label);

const meta = (sessionId: string): SessionMetadata =>
  ({
    sessionId,
    workspaceRoot: "/tmp",
    startedAt: "2026-09-13T00:00:00.000Z",
    lastActivityAt: "2026-09-13T00:00:00.000Z",
    lang: "en",
  }) as SessionMetadata;

const deps = (over: Partial<AppTrayDeps> = {}): AppTrayDeps => ({
  listSessions: () => [],
  openSession: async () => undefined,
  newChat: async () => undefined,
  showWindow: () => undefined,
  requestExit: () => undefined,
  getLocale: async () => "en",
  ...over,
});

beforeEach(() => {
  h.trays.length = 0;
  h.menus.length = 0;
});

describe("createAppTray (menu models per platform)", () => {
  it("linux: attaches the menu the StatusNotifier host draws", async () => {
    createAppTray(deps({ platform: "linux" }));
    await vi.waitFor(() => expect(tray().contextMenus.length).toBe(1));
    expect(labels(tray().contextMenus[0])).toContain("New Chat");
    expect(labels(tray().contextMenus[0])).toContain("Open Herta");
    expect(labels(tray().contextMenus[0])).toContain("Exit");
  });

  it("linux: a refresh re-attaches, and a menu action refreshes it", async () => {
    let sessions: SessionMetadata[] = [];
    const appTray = createAppTray(
      deps({ platform: "linux", listSessions: () => sessions }),
    );
    await vi.waitFor(() => expect(tray().contextMenus.length).toBe(1));
    expect(labels(tray().contextMenus[0])).not.toContain("Recent");

    appTray.refreshMenu();
    await vi.waitFor(() => expect(tray().contextMenus.length).toBe(2));

    // The menu's own New Chat action moves the Recent order, so it re-attaches.
    sessions = [meta("s1")];
    const template = (
      tray().contextMenus[1] as {
        template: { label?: string; click?: () => void }[];
      }
    ).template;
    template.find((item) => item.label === "New Chat")?.click?.();
    await vi.waitFor(() => expect(tray().contextMenus.length).toBe(3));
    expect(labels(tray().contextMenus[2])).toContain("Recent");
  });

  it("darwin: attaches nothing and pops the menu up per right-click", async () => {
    createAppTray(deps({ platform: "darwin" }));
    expect(tray().contextMenus).toEqual([]);
    tray().handlers.get("right-click")?.();
    await vi.waitFor(() => expect(tray().popped).not.toBeNull());
  });

  it("linux: a destroyed tray is left alone", async () => {
    const appTray = createAppTray(deps({ platform: "linux" }));
    await vi.waitFor(() => expect(tray().contextMenus.length).toBe(1));
    appTray.destroy();
    appTray.refreshMenu();
    expect(tray().contextMenus.length).toBe(1);
    expect(tray().destroyed).toBe(true);
  });

  it("pushes the OS-rendered tooltip in the persisted locale", async () => {
    createAppTray(deps({ platform: "linux", getLocale: async () => "zh" }));
    await vi.waitFor(() => expect(tray().tooltip).toBe("黑塔"));
  });
});
