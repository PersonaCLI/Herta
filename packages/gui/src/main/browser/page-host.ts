import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  type BrowserWindow,
  type NativeImage,
  type Session,
  screen,
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
import { appCommandForPageKey } from "./page-keys.js";

/** The page's own persistent partition, apart from the app's session
 *  (ADR 0083 §8): sign-ins persist across sessions, as in Claude Desktop. */
export const PAGE_PARTITION = "persist:herta-browser";

/** How many pages stay live across sessions (ADR 0083 §3). Past it, the
 *  page least recently shown is closed and only its address kept. */
export const MAX_LIVE_PAGES = 3;

/** The page's corner radius, the page tab body's own (reference-ux.css). */
const PAGE_RADIUS_PX = 10;

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
  lastShown: number;
}

/** How often the shown page's still frame is refreshed. A page taken off
 *  the window cannot be captured, so the frame a freeze shows is the last
 *  one taken while it was on (spike, 2026-10-23). The capture is an async
 *  readback, ~6–8 ms; nothing is encoded until a freeze asks for it. */
const STILL_REFRESH_MS = 1500;

export interface PageHostEvents {
  /** The header's state changed (address, title, loading, history). */
  readonly state: (state: PageState) => void;
  /** An app command pressed inside the page, kept from it. */
  readonly command: (id: ShortcutId) => void;
}

/**
 * The browser pages of one window (ADR 0083 §3). Main owns each page: one
 * `WebContentsView` per session, created on its first navigation, laid over
 * the viewer's page tab where the renderer reports it, detached — and left
 * running — when the tab is hidden or the session switches. Closed with the
 * session, the window or the app; past `MAX_LIVE_PAGES` the least recently
 * shown is closed and reloads from its address when shown again.
 */
export class PageHost {
  private readonly live = new Map<string, LivePage>();
  /** A closed page's address, so showing it again reloads it. */
  private readonly parked = new Map<string, string>();
  private attached: string | null = null;
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
    const page = this.live.get(sessionId) ?? this.revive(sessionId);
    if (page === null) return;
    if (this.attached !== null && this.attached !== sessionId) this.hide();
    const z = this.win.webContents.getZoomFactor();
    page.view.setBounds({
      x: Math.round(bounds.x * z),
      y: Math.round(bounds.y * z),
      width: Math.max(0, Math.round(bounds.width * z)),
      height: Math.max(0, Math.round(bounds.height * z)),
    });
    if (this.attached !== sessionId) {
      this.win.contentView.addChildView(page.view);
      this.attached = sessionId;
      this.startStills(sessionId, page);
      if (process.env.HERTA_PAGE_PROBE === "1") {
        const d = screen.getDisplayMatching(this.win.getBounds());
        probe(
          "show",
          0,
          ` · css ${JSON.stringify(bounds)} · zoom ${z} · content ${JSON.stringify(this.win.getContentBounds())} · display ${JSON.stringify(d.bounds)} x${d.scaleFactor}`,
        );
      }
    }
    page.lastShown = Date.now();
  }

  /** Take the shown page off the window; it keeps running. */
  hide(): void {
    const id = this.attached;
    this.attached = null;
    this.stopStills();
    if (id === null) return;
    const page = this.live.get(id);
    if (page === undefined) return;
    // A page taken off the window keeps the keyboard if it had it, and every
    // key then went to a page nobody could see — Escape could not close the
    // cheat sheet opened over it (spike, 2026-10-23). The app takes it back.
    const hadFocus =
      !page.view.webContents.isDestroyed() && page.view.webContents.isFocused();
    this.win.contentView.removeChildView(page.view);
    if (hadFocus && !this.win.webContents.isDestroyed())
      this.win.webContents.focus();
  }

  /**
   * Take the shown page off the window at once, and answer with its still
   * frame (a JPEG data URL) for the renderer to show in its place: an
   * overlay opening over the viewer, or the divider pressed. At once,
   * because a native page draws over any overlay, and under the pointer it
   * takes the mouse from the window (spike, 2026-10-23). The frame is the
   * last one taken while the page was on; with none yet, one is taken
   * first.
   */
  async freeze(): Promise<string | null> {
    const id = this.attached;
    const page = id === null ? undefined : this.live.get(id);
    if (id === null || page === undefined) return null;
    const t0 = performance.now();
    let image = this.still?.id === id ? this.still.image : null;
    if (image === null) {
      image = await page.view.webContents.capturePage().catch(() => null);
    }
    if (this.attached === id) this.hide();
    if (image === null || image.isEmpty()) return null;
    const url = `data:image/jpeg;base64,${image.toJPEG(85).toString("base64")}`;
    probe("freeze", performance.now() - t0);
    return url;
  }

  private startStills(id: string, page: LivePage): void {
    this.stopStills();
    const take = (): void => {
      const wc = page.view.webContents;
      if (this.attached !== id || wc.isDestroyed()) return;
      void wc.capturePage().then(
        (image) => {
          if (this.attached === id && !image.isEmpty())
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

  /** The current state of a session's page, or null when it has none. */
  state(sessionId: string): PageState | null {
    const page = this.live.get(sessionId);
    return page === undefined ? null : stateOf(sessionId, page.view);
  }

  navigate(sessionId: string, to: PageNavigation): void {
    if ("url" in to) {
      const url = typedPageUrl(to.url);
      if (url === null) return;
      const page = this.live.get(sessionId) ?? this.create(sessionId);
      void page.view.webContents.loadURL(url).catch(() => undefined);
      return;
    }
    const page = this.live.get(sessionId);
    if (page === undefined) return;
    const wc = page.view.webContents;
    const history = wc.navigationHistory;
    if (to.go === "back" && history.canGoBack()) history.goBack();
    else if (to.go === "forward" && history.canGoForward()) history.goForward();
    else if (to.go === "reload") wc.reload();
    else if (to.go === "stop") wc.stop();
  }

  /** The page's address in the OS browser — read here, never taken from
   *  the renderer, and only an http(s) one. */
  async openExternally(sessionId: string): Promise<void> {
    const url = this.live.get(sessionId)?.view.webContents.getURL() ?? "";
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  }

  /** The session ended (closed, deleted): its page goes. */
  closeSession(sessionId: string): void {
    this.parked.delete(sessionId);
    this.close(sessionId);
  }

  dispose(): void {
    this.stopStills();
    this.still = null;
    for (const id of [...this.live.keys()]) this.close(id);
    this.parked.clear();
  }

  private close(sessionId: string): void {
    const page = this.live.get(sessionId);
    if (page === undefined) return;
    if (this.attached === sessionId) this.hide();
    if (this.still?.id === sessionId) this.still = null;
    this.live.delete(sessionId);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
  }

  private revive(sessionId: string): LivePage | null {
    const url = this.parked.get(sessionId);
    if (url === undefined) return null;
    this.parked.delete(sessionId);
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
      const id = appCommandForPageKey(input, this.mac);
      if (id === null) return;
      event.preventDefault();
      this.events.command(id);
    });
    if (process.env.HERTA_PAGE_PROBE === "1") {
      wc.on("did-stop-loading", () => void probeAxTree(view));
    }
    const page: LivePage = { view, lastShown: Date.now() };
    this.live.set(sessionId, page);
    this.capLive(sessionId);
    return page;
  }

  /** Past the cap, the page least recently shown closes; its address is
   *  kept so that showing it again reloads it. */
  private capLive(keep: string): void {
    while (this.live.size > MAX_LIVE_PAGES) {
      let oldest: [string, LivePage] | null = null;
      for (const entry of this.live) {
        if (entry[0] === keep) continue;
        if (oldest === null || entry[1].lastShown < oldest[1].lastShown)
          oldest = entry;
      }
      if (oldest === null) return;
      const url = oldest[1].view.webContents.getURL();
      if (pageUrlAllowed(url) && url !== "about:blank")
        this.parked.set(oldest[0], url);
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

/** Spike measurements (ADR 0083 build step 1), only with HERTA_PAGE_PROBE=1:
 *  how long a still frame takes, and what Chromium's accessibility tree
 *  costs main — the wait, its size, and the longest the event loop stalled. */
function probe(what: string, ms: number, extra = ""): void {
  if (process.env.HERTA_PAGE_PROBE !== "1") return;
  console.log(`[page-probe] ${what} ${ms.toFixed(1)} ms${extra}`);
}

async function probeAxTree(view: WebContentsView): Promise<void> {
  const dbg = view.webContents.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
    const lag = monitorEventLoopDelay({ resolution: 1 });
    lag.enable();
    const t0 = performance.now();
    const tree = (await dbg.sendCommand("Accessibility.getFullAXTree")) as {
      nodes: unknown[];
    };
    const waited = performance.now() - t0;
    const t1 = performance.now();
    const text = JSON.stringify(tree);
    const walked = performance.now() - t1;
    lag.disable();
    probe(
      "ax-tree",
      waited,
      ` · ${tree.nodes.length} nodes · ${(text.length / 1024).toFixed(0)} KB · walk ${walked.toFixed(1)} ms · max loop stall ${(lag.max / 1e6).toFixed(1)} ms`,
    );
  } catch (err) {
    probe("ax-tree failed", 0, ` · ${String(err)}`);
  }
}
