import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The page host against a window that closes, and its IPC against a window
 * that is made again (Mac check, 2026-10-24: both threw in main). `electron`
 * is faked to the calls the host makes; the window fake throws as Electron's
 * does once destroyed — every getter, `contentView` and `webContents`
 * included.
 */
interface FakeContents {
  focused: boolean;
  destroyed: boolean;
  closed: number;
  listeners: Record<string, (() => void)[]>;
  inserted: string[];
}

const h = vi.hoisted(() => ({ views: [] as { webContents: FakeContents }[] }));

vi.mock("electron", () => {
  class WebContentsView {
    readonly webContents = {
      focused: false,
      destroyed: false,
      closed: 0,
      listeners: {} as Record<string, (() => void)[]>,
      inserted: [] as string[],
      setWindowOpenHandler: () => undefined,
      on(name: string, listener: () => void) {
        this.listeners[name] = [...(this.listeners[name] ?? []), listener];
      },
      insertCSS(css: string) {
        this.inserted.push(css);
        return Promise.resolve("key");
      },
      loadURL: async () => undefined,
      isDestroyed() {
        return this.destroyed;
      },
      isFocused() {
        return this.focused;
      },
      close() {
        this.closed += 1;
        this.destroyed = true;
      },
      getURL: () => "http://localhost:5180/",
    };
    constructor() {
      h.views.push(this);
    }
    setBorderRadius(): void {}
    setBounds(): void {}
  }
  return {
    WebContentsView,
    ipcMain: {},
    screen: {},
    shell: {},
    session: {
      fromPartition: () => ({
        setPermissionRequestHandler: () => undefined,
        setPermissionCheckHandler: () => undefined,
        on: () => undefined,
      }),
    },
  };
});

vi.mock("./page-driver.js", () => ({
  PageDriver: class {},
  PageInstrument: class {
    picking = false;
    detach(): void {}
  },
}));

const { CMD } = await import("../../preload/channels.js");
const { PageHost, registerPageHandlers } = await import("./page-host.js");
type PageIpc = import("./page-host.js").PageIpc;

function fakeWindow() {
  let destroyed = false;
  const gone = (): never => {
    throw new TypeError("Object has been destroyed");
  };
  const children: unknown[] = [];
  const contentView = {
    addChildView: (view: unknown) => children.push(view),
    removeChildView: (view: unknown) =>
      children.splice(children.indexOf(view), 1),
  };
  const webContents = {
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    focus: vi.fn(),
  };
  const win = {
    isDestroyed: () => destroyed,
    get contentView() {
      return destroyed ? gone() : contentView;
    },
    get webContents() {
      return destroyed ? gone() : webContents;
    },
  };
  return {
    win: win as never,
    children,
    appFocus: webContents.focus,
    close: () => {
      destroyed = true;
    },
  };
}

const events = {
  state: () => undefined,
  command: () => undefined,
  opened: () => undefined,
};
const BOX = { x: 0, y: 0, width: 360, height: 600 };

beforeEach(() => {
  vi.useFakeTimers();
  h.views.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the page host as its window closes (ADR 0083 §3)", () => {
  it("disposing after the window closed touches none of it, and still closes the page", () => {
    const w = fakeWindow();
    const host = new PageHost(w.win, events, true);
    host.navigate("s1", { url: "http://localhost:5180/" });
    host.show("s1", BOX);
    const page = h.views[0]?.webContents;
    expect(w.children).toHaveLength(1);
    // The page had the keys: handing them back must not reach a closed window
    // either.
    if (page !== undefined) page.focused = true;
    w.close();
    expect(() => host.dispose()).not.toThrow();
    expect(page?.closed).toBe(1);
  });

  it("closing a page on a live window still takes it off and gives the keys back", () => {
    const w = fakeWindow();
    const host = new PageHost(w.win, events, true);
    host.navigate("s1", { url: "http://localhost:5180/" });
    host.show("s1", BOX);
    const page = h.views[0]?.webContents;
    if (page !== undefined) page.focused = true;
    host.closePage("s1");
    expect(w.children).toHaveLength(0);
    expect(w.appFocus).toHaveBeenCalledTimes(1);
    expect(page?.closed).toBe(1);
  });
});

describe("the page's scrollbars (owner 2026-10-30)", () => {
  it("each document gets the app's scrollbar sheet: a thin thumb, no arrow buttons", () => {
    const w = fakeWindow();
    const host = new PageHost(w.win, events, true);
    host.navigate("s1", { url: "https://example.com/" });
    const page = h.views[0]?.webContents;
    for (const ready of page?.listeners["dom-ready"] ?? []) ready();
    for (const ready of page?.listeners["dom-ready"] ?? []) ready();
    expect(page?.inserted).toHaveLength(2);
    expect(page?.inserted[0]).toContain(
      "::-webkit-scrollbar-button { display: none",
    );
    host.dispose();
  });
});

/** `ipcMain` as Electron keeps it: a second handler on a channel throws,
 *  and `on` listeners add up. */
function fakeIpc() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const handlers = new Map<string, unknown>();
  const ipc = {
    on(channel: string, listener: (...args: unknown[]) => void) {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      return ipc;
    },
    handle(channel: string, listener: unknown) {
      if (handlers.has(channel))
        throw new Error(
          `Attempted to register a second handler for '${channel}'`,
        );
      handlers.set(channel, listener);
    },
    removeAllListeners(channel: string) {
      listeners.delete(channel);
      return ipc;
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  };
  return { ipc: ipc as unknown as PageIpc, listeners, handlers };
}

function fakePages() {
  return {
    show: vi.fn(),
    hide: vi.fn(),
    closePage: vi.fn(),
    pick: vi.fn(),
    navigate: vi.fn(),
    freeze: vi.fn(),
    state: vi.fn(),
    openExternally: vi.fn(),
  };
}

describe("the page IPC, registered again for a window made again (macOS Dock)", () => {
  it("replaces every channel's registration: nothing throws, nothing stacks", () => {
    const { ipc, listeners, handlers } = fakeIpc();
    const first = fakePages();
    const second = fakePages();
    registerPageHandlers(first as never, ipc);
    const channels = [...listeners.keys(), ...handlers.keys()].sort();
    expect(channels).toContain(CMD.pageClearData);
    expect(() => registerPageHandlers(second as never, ipc)).not.toThrow();
    expect([...listeners.keys(), ...handlers.keys()].sort()).toEqual(channels);
    for (const list of listeners.values()) expect(list).toHaveLength(1);
    // The closed window's pages are not called any more.
    listeners.get(CMD.pagePick)?.[0]?.(null, "s1", true);
    listeners.get(CMD.pageClose)?.[0]?.(null, "s1");
    expect(second.pick).toHaveBeenCalledWith("s1", true);
    expect(second.closePage).toHaveBeenCalledWith("s1");
    expect(first.pick).not.toHaveBeenCalled();
    expect(first.closePage).not.toHaveBeenCalled();
  });
});
