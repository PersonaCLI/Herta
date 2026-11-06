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
  listeners: Record<string, ((...args: unknown[]) => void)[]>;
  inserted: string[];
  loaded: string[];
  openHandler: ((d: { url: string }) => { action: string }) | null;
}

const h = vi.hoisted(() => ({
  views: [] as { webContents: FakeContents }[],
  /** What went to the system browser. */
  opened: [] as string[],
  /** One of 板砖's steps runs on the page. */
  stepping: false,
  /** The Trailblazer has just pressed or typed on it. */
  gesture: false,
  /** What a step was stopped from going to. */
  refused: [] as string[],
}));

vi.mock("electron", () => {
  class WebContentsView {
    readonly webContents = {
      focused: false,
      destroyed: false,
      closed: 0,
      listeners: {} as Record<string, ((...args: unknown[]) => void)[]>,
      inserted: [] as string[],
      loaded: [] as string[],
      openHandler: null as ((d: { url: string }) => { action: string }) | null,
      setWindowOpenHandler(
        fn: (d: { url: string }) => { action: string },
      ): void {
        this.openHandler = fn;
      },
      on(name: string, listener: (...args: unknown[]) => void) {
        this.listeners[name] = [...(this.listeners[name] ?? []), listener];
      },
      insertCSS(css: string) {
        this.inserted.push(css);
        return Promise.resolve("key");
      },
      loadURL(url: string) {
        this.loaded.push(url);
        return Promise.resolve();
      },
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
    shell: {
      openExternal: async (url: string) => {
        h.opened.push(url);
      },
    },
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
    get stepping(): boolean {
      return h.stepping;
    }
    takeGesture(): boolean {
      const was = h.gesture;
      h.gesture = false;
      return was;
    }
    noteRefused(url: string): void {
      h.refused.push(url);
    }
    detach(): void {}
  },
}));

const { CMD } = await import("../../preload/channels.js");
const { chromiumSandboxOff, PageHost, registerPageHandlers } = await import(
  "./page-host.js"
);
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
  h.opened.length = 0;
  h.refused.length = 0;
  h.gesture = false;
  h.stepping = false;
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

describe("with Chromium's sandbox off, an outside page opens in the system browser (review H2)", () => {
  /** A navigation event as Electron hands it; true when it was stopped. */
  const fire = (page: FakeContents, name: string, url: string): boolean => {
    let stopped = false;
    const event = {
      preventDefault: () => {
        stopped = true;
      },
      url,
      isMainFrame: true,
    };
    for (const l of page.listeners[name] ?? []) l(event, url);
    return stopped;
  };

  it("a typed address off this machine goes to the system browser, a local one loads", () => {
    const w = fakeWindow();
    const host = new PageHost(w.win, events, false, true);
    host.navigate("s1", { url: "github.com/acme/app" });
    expect(h.opened).toEqual(["https://github.com/acme/app"]);
    expect(h.views).toHaveLength(0);
    host.navigate("s1", { url: "localhost:5173" });
    expect(h.views[0]?.webContents.loaded).toEqual(["http://localhost:5173/"]);
    expect(h.opened).toHaveLength(1);
    host.dispose();
  });

  it("a link, a redirect or a new window off this machine is stopped and sent out, one a moment", () => {
    const w = fakeWindow();
    const host = new PageHost(w.win, events, false, true);
    host.navigate("s1", { url: "localhost:5173" });
    const page = h.views[0]?.webContents as FakeContents;
    h.gesture = true;
    expect(fire(page, "will-navigate", "https://news.example.com/a")).toBe(
      true,
    );
    expect(h.opened).toEqual(["https://news.example.com/a"]);
    // A redirect loop right after: stopped, and no second tab.
    expect(fire(page, "will-redirect", "https://news.example.com/b")).toBe(
      true,
    );
    expect(h.opened).toHaveLength(1);
    vi.advanceTimersByTime(1500);
    h.gesture = true;
    expect(page.openHandler?.({ url: "https://docs.example.com/" })).toEqual({
      action: "deny",
    });
    expect(h.opened).toEqual([
      "https://news.example.com/a",
      "https://docs.example.com/",
    ]);
    // On this machine the page goes on as before.
    expect(fire(page, "will-navigate", "http://127.0.0.1:5173/login")).toBe(
      false,
    );
    host.dispose();
  });

  it("an outside page 板砖's step leads to is stopped, and the system browser stays shut", () => {
    const w = fakeWindow();
    const host = new PageHost(w.win, events, false, true);
    host.navigate("s1", { url: "localhost:5173" });
    const page = h.views[0]?.webContents as FakeContents;
    h.stepping = true;
    expect(fire(page, "will-navigate", "https://github.com/login")).toBe(true);
    expect(h.opened).toEqual([]);
    // …and the step is told, so it does not read as one that worked (M5).
    expect(h.refused).toEqual(["https://github.com/login"]);
    host.dispose();
  });

  it("a page that moves on its own opens no tab: only a gesture does, and one (M7)", () => {
    const w = fakeWindow();
    const host = new PageHost(w.win, events, false, true);
    host.navigate("s1", { url: "localhost:5173" });
    const page = h.views[0]?.webContents as FakeContents;
    expect(fire(page, "will-navigate", "https://ads.example.com/a")).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(fire(page, "will-navigate", "https://ads.example.com/b")).toBe(true);
    expect(h.opened).toEqual([]);
    expect(h.refused).toEqual([]);
    // Their own click, during a read of 板砖's, goes through.
    h.stepping = true;
    h.gesture = true;
    expect(fire(page, "will-navigate", "https://docs.example.com/")).toBe(true);
    expect(h.opened).toEqual(["https://docs.example.com/"]);
    expect(h.refused).toEqual([]);
    host.dispose();
  });

  it("a frame's redirect off this machine is stopped, with no tab (M6)", () => {
    const w = fakeWindow();
    const host = new PageHost(w.win, events, false, true);
    host.navigate("s1", { url: "localhost:5173" });
    const page = h.views[0]?.webContents as FakeContents;
    h.gesture = true;
    let stopped = false;
    for (const l of page.listeners["will-redirect"] ?? []) {
      l(
        {
          isMainFrame: false,
          preventDefault: () => {
            stopped = true;
          },
        },
        "https://tracker.example.com/pixel",
      );
    }
    expect(stopped).toBe(true);
    expect(h.opened).toEqual([]);
    host.dispose();
  });

  it("with the sandbox on, an outside page loads in the page as before", () => {
    const w = fakeWindow();
    const host = new PageHost(w.win, events, false);
    host.navigate("s1", { url: "github.com/acme/app" });
    const page = h.views[0]?.webContents as FakeContents;
    expect(page.loaded).toEqual(["https://github.com/acme/app"]);
    expect(fire(page, "will-navigate", "https://news.example.com/a")).toBe(
      false,
    );
    expect(h.opened).toEqual([]);
    host.dispose();
  });

  it("reads the sandbox as off from the switch, the argument or the environment", () => {
    const no = () => false;
    expect(chromiumSandboxOff(["herta"], no, {})).toBe(false);
    expect(chromiumSandboxOff(["herta", "--no-sandbox"], no, {})).toBe(true);
    expect(chromiumSandboxOff([], (n) => n === "no-sandbox", {})).toBe(true);
    expect(chromiumSandboxOff([], no, { ELECTRON_DISABLE_SANDBOX: "1" })).toBe(
      true,
    );
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
