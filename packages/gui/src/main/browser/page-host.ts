import { redactSecrets } from "@herta/tools";
import {
  type BrowserWindow,
  type NativeImage,
  type Session,
  session,
  shell,
  WebContentsView,
} from "electron";
import {
  type PageBounds,
  type PageNavigation,
  type PageState,
  pageUrlAllowed,
  typedPageUrl,
} from "../../shared/browser-page.js";
import type { ShortcutId } from "../../shared/shortcuts.js";
import { PageDriver, PageInstrument } from "./page-driver.js";
import { appCommandForPageKey } from "./page-keys.js";

/** The page's own persistent partition, apart from the app's session
 *  (ADR 0083 §8): sign-ins persist across sessions, as in Claude Desktop. */
export const PAGE_PARTITION = "persist:herta-browser";

/** How many pages stay live across sessions (ADR 0083 §3). Past it, the
 *  page least recently shown is closed and only its address kept. */
export const MAX_LIVE_PAGES = 3;

/** The page's corner radius, the page tab body's own (reference-ux.css). */
const PAGE_RADIUS_PX = 10;

/** Where a parked page waits: on the window, outside what it shows. */
const PARK_X = -30_000;
/** A page 板砖 opens before the Trailblazer has shown it lays out at this
 *  size until the tab reports its own. */
const DEFAULT_SIZE = { width: 1024, height: 768 } as const;

/** The page partition, hardened once: every permission request denied
 *  (camera, microphone, location, notifications, clipboard read), and
 *  downloads cancelled (ADR 0083 §8). */
let pageSessionReady: Session | null = null;
export function pageSession(): Session {
  if (pageSessionReady !== null) return pageSessionReady;
  const s = session.fromPartition(PAGE_PARTITION);
  s.setPermissionRequestHandler((_wc, _perm, done) => done(false));
  s.setPermissionCheckHandler(() => false);
  s.on("will-download", (event) => event.preventDefault());
  pageSessionReady = s;
  return s;
}

interface LivePage {
  readonly view: WebContentsView;
  readonly instrument: PageInstrument;
  lastShown: number;
  size: { width: number; height: number };
}

/** How often the shown page's still frame is refreshed. A page taken off
 *  the window cannot be captured, so the frame a freeze shows is the last
 *  one taken while it was shown (spike, 2026-10-23). The capture is an
 *  async readback, ~6–8 ms; nothing is encoded until a freeze asks. */
const STILL_REFRESH_MS = 1500;

export interface PageHostEvents {
  /** The header's state changed (address, title, loading, history). */
  readonly state: (state: PageState) => void;
  /** An app command pressed inside the page, kept from it. */
  readonly command: (id: ShortcutId) => void;
  /** 板砖 opened a page: the Trailblazer is shown it. */
  readonly opened: (sessionId: string) => void;
  /** The Trailblazer picked an element (ADR 0083 §4), or the pick ended
   *  without one (`null`: Escape, a navigation, the picker turned off). */
  readonly picked?: (
    sessionId: string,
    pick: {
      readonly element: string;
      readonly route: string;
      readonly html: string;
    } | null,
  ) => void;
}

/**
 * The browser pages of one window (ADR 0083 §3). Main owns each page: one
 * `WebContentsView` per session, laid over the viewer's page tab where the
 * renderer reports it. When the tab is hidden the page is PARKED — still on
 * the window, outside what it shows — so it keeps its layout and 板砖 can
 * still capture it (a page off the window cannot be captured at all: spike,
 * 2026-10-23). Another session's page is taken off the window, and keeps
 * running. Closed with the session, the window or the app; past
 * `MAX_LIVE_PAGES` the least recently shown is closed and reloads from its
 * address when shown again.
 */
export class PageHost {
  private readonly pages = new Map<string, LivePage>();
  /** A closed page's address, so showing it again reloads it. */
  private readonly addresses = new Map<string, string>();
  private readonly drivers = new Map<string, PageDriver>();
  /** The page on the window, and whether it is laid over the tab (shown)
   *  or parked. */
  private onWindow: string | null = null;
  private placed = false;
  /** The shown page's latest still frame, kept as an image. */
  private still: { readonly id: string; readonly image: NativeImage } | null =
    null;
  private stillTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly win: BrowserWindow,
    private readonly events: PageHostEvents,
    private readonly mac: boolean,
  ) {}

  /** Lay the session's page over `bounds` (the renderer's CSS pixels). */
  show(sessionId: string, bounds: PageBounds): void {
    const page = this.pages.get(sessionId) ?? this.revive(sessionId);
    if (page === null) return;
    const z = this.win.webContents.getZoomFactor();
    const box = {
      x: Math.round(bounds.x * z),
      y: Math.round(bounds.y * z),
      width: Math.max(0, Math.round(bounds.width * z)),
      height: Math.max(0, Math.round(bounds.height * z)),
    };
    this.putOnWindow(sessionId, page);
    page.view.setBounds(box);
    page.size = { width: box.width, height: box.height };
    page.lastShown = Date.now();
    if (!this.placed) {
      this.placed = true;
      this.startStills(sessionId, page);
    }
  }

  /** The tab is hidden: the page is parked, and keeps running. */
  hide(): void {
    const id = this.onWindow;
    if (id === null || !this.placed) return;
    const page = this.pages.get(id);
    if (page === undefined) return;
    this.park(page);
  }

  /**
   * Park the shown page at once, and answer with its still frame (a JPEG
   * data URL) for the renderer to show in its place: an overlay opening
   * over the viewer, or the divider pressed. At once, because a native page
   * draws over any overlay, and under the pointer it takes the mouse from
   * the window (spike, 2026-10-23).
   */
  async freeze(): Promise<string | null> {
    const id = this.onWindow;
    const page = id === null ? undefined : this.pages.get(id);
    if (id === null || page === undefined || !this.placed) return null;
    let image = this.still?.id === id ? this.still.image : null;
    if (image === null)
      image = await page.view.webContents.capturePage().catch(() => null);
    if (this.onWindow === id && this.placed) this.park(page);
    if (image === null || image.isEmpty()) return null;
    return `data:image/jpeg;base64,${image.toJPEG(85).toString("base64")}`;
  }

  /** The driver 板砖's steps run on, for one session (ADR 0083 §6). */
  driverFor(sessionId: string): PageDriver {
    const have = this.drivers.get(sessionId);
    if (have !== undefined) return have;
    const driver = new PageDriver(sessionId, {
      live: () => {
        const page =
          this.pages.get(sessionId) ??
          this.revive(sessionId) ??
          this.create(sessionId);
        if (this.onWindow !== sessionId) {
          this.putOnWindow(sessionId, page);
          this.park(page);
        }
        return { wc: page.view.webContents, instrument: page.instrument };
      },
      existing: () => {
        const page = this.pages.get(sessionId);
        return page === undefined
          ? null
          : { wc: page.view.webContents, instrument: page.instrument };
      },
      opened: () => this.events.opened(sessionId),
    });
    this.drivers.set(sessionId, driver);
    return driver;
  }

  /** The current state of a session's page, or null when it has none. */
  state(sessionId: string): PageState | null {
    const page = this.pages.get(sessionId);
    return page === undefined ? null : stateOf(sessionId, page.view);
  }

  /** The Trailblazer's URL bar and buttons (§4): anywhere http(s) goes. */
  navigate(sessionId: string, to: PageNavigation): void {
    if ("url" in to) {
      const url = typedPageUrl(to.url);
      if (url === null) return;
      const page = this.pages.get(sessionId) ?? this.create(sessionId);
      void page.view.webContents.loadURL(url).catch(() => undefined);
      return;
    }
    const page = this.pages.get(sessionId);
    if (page === undefined) return;
    const wc = page.view.webContents;
    const history = wc.navigationHistory;
    if (to.go === "back" && history.canGoBack()) history.goBack();
    else if (to.go === "forward" && history.canGoForward()) history.goForward();
    else if (to.go === "reload") wc.reload();
    else if (to.go === "stop") wc.stop();
  }

  /** A dev server answers (ADR 0083 §5): the page tab opens on it — unless
   *  the page is already somewhere, which is the Trailblazer's place or
   *  板砖's, not the launcher's to move. */
  openOn(sessionId: string, url: string): void {
    const at = this.pages.get(sessionId)?.view.webContents.getURL() ?? "";
    if (at !== "" && at !== "about:blank") return;
    this.navigate(sessionId, { url });
    this.events.opened(sessionId);
  }

  /** The page's address in the OS browser — read here, never taken from
   *  the renderer, and only an http(s) one. */
  async openExternally(sessionId: string): Promise<void> {
    const url = this.pages.get(sessionId)?.view.webContents.getURL() ?? "";
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  }

  /** The session ended (closed, deleted): its page goes. */
  closeSession(sessionId: string): void {
    this.addresses.delete(sessionId);
    this.drivers.delete(sessionId);
    this.close(sessionId);
  }

  /** The Trailblazer's picker (ADR 0083 §4): on, a click in the page picks
   *  an element for the composer; off, or Escape, ends it. A navigation
   *  ends it too. */
  pick(sessionId: string, on: boolean): void {
    const page = this.pages.get(sessionId);
    if (page === undefined) {
      if (on) this.events.picked?.(sessionId, null);
      return;
    }
    if (!on) {
      void page.instrument.stopPick();
      this.events.picked?.(sessionId, null);
      return;
    }
    const wc = page.view.webContents;
    wc.once("did-navigate", () => {
      if (page.instrument.picking) this.pick(sessionId, false);
    });
    if (!wc.isFocused()) wc.focus();
    void page.instrument
      .startPick(({ element, html }) =>
        this.events.picked?.(sessionId, {
          element,
          route: routeOf(wc.getURL()),
          html: redactSecrets(html.replace(/\s+/g, " ").trim()).slice(0, 400),
        }),
      )
      .catch(() => this.events.picked?.(sessionId, null));
  }

  /** The Trailblazer closed the page tab (owner, 2026-10-23): the page
   *  ends, as a browser tab's does, and the tab opens next on the server
   *  list. 板砖's driver stays — its next navigation opens a page again. */
  closePage(sessionId: string): void {
    this.addresses.delete(sessionId);
    this.close(sessionId);
  }

  dispose(): void {
    this.stopStills();
    this.still = null;
    for (const id of [...this.pages.keys()]) this.close(id);
    this.addresses.clear();
    this.drivers.clear();
  }

  /** Put this session's page on the window, taking another's off. */
  private putOnWindow(sessionId: string, page: LivePage): void {
    if (this.onWindow === sessionId) return;
    if (this.onWindow !== null) this.takeOff(this.onWindow);
    this.win.contentView.addChildView(page.view);
    this.onWindow = sessionId;
    this.placed = false;
  }

  /** Off the window entirely: another session's turn. */
  private takeOff(sessionId: string): void {
    const page = this.pages.get(sessionId);
    if (this.onWindow === sessionId) {
      this.onWindow = null;
      this.placed = false;
      this.stopStills();
    }
    if (page === undefined) return;
    this.giveBackFocus(page);
    this.win.contentView.removeChildView(page.view);
  }

  /** Still on the window, outside what it shows, at its last size. */
  private park(page: LivePage): void {
    this.placed = false;
    this.stopStills();
    this.giveBackFocus(page);
    const size = page.size;
    page.view.setBounds({ x: PARK_X, y: 0, ...size });
  }

  /** A page out of sight keeps the keyboard if it had it, and every key
   *  then went to a page nobody could see — Escape could not close the
   *  cheat sheet opened over it (spike, 2026-10-23). The app takes it back. */
  private giveBackFocus(page: LivePage): void {
    const wc = page.view.webContents;
    if (
      !wc.isDestroyed() &&
      wc.isFocused() &&
      !this.win.webContents.isDestroyed()
    )
      this.win.webContents.focus();
  }

  private startStills(id: string, page: LivePage): void {
    this.stopStills();
    const take = (): void => {
      const wc = page.view.webContents;
      if (this.onWindow !== id || !this.placed || wc.isDestroyed()) return;
      void wc.capturePage().then(
        (image) => {
          if (this.onWindow === id && !image.isEmpty())
            this.still = { id, image };
        },
        () => undefined,
      );
    };
    setTimeout(take, 200);
    this.stillTimer = setInterval(take, STILL_REFRESH_MS);
  }

  private stopStills(): void {
    if (this.stillTimer !== null) clearInterval(this.stillTimer);
    this.stillTimer = null;
  }

  private close(sessionId: string): void {
    const page = this.pages.get(sessionId);
    if (page === undefined) return;
    if (this.onWindow === sessionId) this.takeOff(sessionId);
    if (this.still?.id === sessionId) this.still = null;
    this.pages.delete(sessionId);
    page.instrument.detach();
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
  }

  private revive(sessionId: string): LivePage | null {
    const url = this.addresses.get(sessionId);
    if (url === undefined) return null;
    this.addresses.delete(sessionId);
    const page = this.create(sessionId);
    void page.view.webContents.loadURL(url).catch(() => undefined);
    return page;
  }

  private create(sessionId: string): LivePage {
    const view = new WebContentsView({
      webPreferences: {
        session: pageSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // The same corners as the page tab's body (reference-ux.css).
    view.setBorderRadius(PAGE_RADIUS_PX);
    const wc = view.webContents;
    // A new window loads in the same tab, under the same rules (§8).
    wc.setWindowOpenHandler(({ url }) => {
      if (pageUrlAllowed(url)) void wc.loadURL(url).catch(() => undefined);
      return { action: "deny" };
    });
    const guard = (event: { preventDefault: () => void }, url: string) => {
      if (!pageUrlAllowed(url)) event.preventDefault();
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);
    wc.on("will-frame-navigate", (event) => {
      if (event.isMainFrame) guard(event, event.url);
    });
    const push = (): void => {
      if (!wc.isDestroyed()) this.events.state(stateOf(sessionId, view));
    };
    for (const name of [
      "did-start-loading",
      "did-stop-loading",
      "did-navigate",
      "did-navigate-in-page",
      "page-title-updated",
    ] as const) {
      wc.on(name as "did-stop-loading", push);
    }
    wc.on("before-input-event", (event, input) => {
      // Escape ends a pick in progress (ADR 0083 §4) and is kept from the
      // page while it does.
      if (
        input.type === "keyDown" &&
        input.key === "Escape" &&
        this.pages.get(sessionId)?.instrument.picking === true
      ) {
        event.preventDefault();
        this.pick(sessionId, false);
        return;
      }
      const id = appCommandForPageKey(input, this.mac);
      if (id === null) return;
      event.preventDefault();
      this.events.command(id);
    });
    const page: LivePage = {
      view,
      instrument: new PageInstrument(wc),
      lastShown: Date.now(),
      size: { ...DEFAULT_SIZE },
    };
    this.pages.set(sessionId, page);
    this.capLive(sessionId);
    return page;
  }

  /** Past the cap, the page least recently shown closes; its address is
   *  kept so that showing it again reloads it. */
  private capLive(keep: string): void {
    while (this.pages.size > MAX_LIVE_PAGES) {
      let oldest: [string, LivePage] | null = null;
      for (const entry of this.pages) {
        if (entry[0] === keep) continue;
        if (oldest === null || entry[1].lastShown < oldest[1].lastShown)
          oldest = entry;
      }
      if (oldest === null) return;
      const url = oldest[1].view.webContents.getURL();
      if (pageUrlAllowed(url) && url !== "about:blank")
        this.addresses.set(oldest[0], url);
      this.close(oldest[0]);
    }
  }
}

function stateOf(sessionId: string, view: WebContentsView): PageState {
  const wc = view.webContents;
  return {
    sessionId,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  };
}

/** A page's host, port and path — never its query (ADR 0083 §10). */
function routeOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}
