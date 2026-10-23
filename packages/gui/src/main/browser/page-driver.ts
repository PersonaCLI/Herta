import {
  type BrowserHost,
  BrowserHostError,
  isLoopbackUrl,
  type PageActed,
  type PageAction,
  type PageElements,
  type PageNavigated,
  type PageNavigation,
  type PageRead,
  type PageReadRequest,
  type PageShot,
} from "@herta/core";
import type { WebContents } from "electron";
import {
  type Located,
  READ_SCRIPT,
  type ReadElements,
} from "./page-read-script.js";

/** The elements a navigation or an action shows 板砖 (ADR 0083 §6). */
const STEP_BUDGET = 4000;
/** A read's own budget. */
const READ_BUDGET = 8000;
const CONSOLE_BUDGET = 2000;
/** A navigation waits this long, an action's aftermath this long. */
const NAV_TIMEOUT_MS = 15_000;
const SETTLE_MAX_MS = 5000;
const NETWORK_QUIET_MS = 500;
/** Messages and requests kept per page. */
const BUFFER = 200;

/** Device widths for `resize` (ADR 0083 §6). */
const PRESETS = {
  phone: { width: 375, height: 812, mobile: true },
  tablet: { width: 768, height: 1024, mobile: true },
} as const;

/** The keys `key` presses, as the debugger's input events name them. */
const KEYS: Readonly<
  Record<string, { code: string; vk: number; text?: string }>
> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  " ": { code: "Space", vk: 32, text: " " },
};

interface ConsoleEntry {
  readonly seq: number;
  readonly level: "error" | "warning" | "info";
  readonly text: string;
}

interface RequestEntry {
  method: string;
  path: string;
  type: string;
  status: number | null;
  failed: string | null;
  start: number;
  ms: number | null;
}

type Cdp = Electron.Debugger;

const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
};

const remoteText = (arg: {
  value?: unknown;
  description?: string;
  type?: string;
}): string => {
  if (arg.value !== undefined)
    return typeof arg.value === "string"
      ? arg.value
      : JSON.stringify(arg.value);
  return arg.description ?? arg.type ?? "";
};

/**
 * One page's instrument (ADR 0083 §6, §9): the debugger session, the console
 * and network as they happen, the isolated world the read script lives in,
 * and whether 板砖's refs still stand. Attached when the page is made, for
 * its whole life.
 */
export class PageInstrument {
  private readonly cdp: Cdp;
  private world: number | null = null;
  private consoleSeq = 0;
  private consoleRead = 0;
  private readonly console: ConsoleEntry[] = [];
  private readonly requests = new Map<string, RequestEntry>();
  private readonly order: string[] = [];
  private inflight = 0;
  private lastBusy = 0;
  private loading = false;
  /** 板砖's refs end at a navigation and at the Trailblazer's own input
   *  (§9); a new read gives fresh ones. */
  private refsLive = false;
  /** Dispatching 板砖's own input: the Trailblazer's is everything else. */
  private driving = 0;
  private mainFrame: string | null = null;
  status: number | null = null;

  constructor(private readonly wc: WebContents) {
    this.cdp = wc.debugger;
    try {
      this.cdp.attach("1.3");
    } catch {
      // Attached already (a second instrument would be a bug); the
      // messages still arrive.
    }
    this.cdp.on("message", (_e, method, params) =>
      this.onMessage(method, params as Record<string, unknown>),
    );
    for (const domain of ["Page", "Runtime", "Network", "Log"])
      void this.cdp.sendCommand(`${domain}.enable`).catch(() => undefined);
    void this.cdp
      .sendCommand("Page.getFrameTree")
      .then((t) => {
        this.mainFrame = (
          t as { frameTree: { frame: { id: string } } }
        ).frameTree.frame.id;
      })
      .catch(() => undefined);
    wc.on("did-start-loading", () => {
      this.loading = true;
      this.lastBusy = Date.now();
    });
    wc.on("did-stop-loading", () => {
      this.loading = false;
      this.lastBusy = Date.now();
    });
    wc.on("did-navigate", (_e, _url, code) => {
      this.status = code > 0 ? code : null;
      this.refsLive = false;
    });
    wc.on("did-navigate-in-page", () => {
      this.refsLive = false;
    });
    // The Trailblazer's own press or key ends 板砖's refs.
    wc.on("input-event", (_e, input) => {
      if (this.driving > 0) return;
      if (
        input.type === "mouseDown" ||
        input.type === "keyDown" ||
        input.type === "rawKeyDown"
      )
        this.refsLive = false;
    });
  }

  private onMessage(method: string, p: Record<string, unknown>): void {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const type = String(p.type);
        const args = (p.args as Parameters<typeof remoteText>[0][]) ?? [];
        const level =
          type === "error" || type === "assert"
            ? "error"
            : type === "warning"
              ? "warning"
              : "info";
        this.pushConsole(level, args.map(remoteText).join(" "));
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails as {
          text?: string;
          exception?: { description?: string };
        };
        const text = d.exception?.description ?? d.text ?? "uncaught exception";
        this.pushConsole("error", text.split("\n").slice(0, 3).join(" | "));
        break;
      }
      case "Log.entryAdded": {
        const e = p.entry as { level?: string; text?: string; url?: string };
        if (e.level === "error")
          this.pushConsole(
            "error",
            `${e.text ?? ""}${e.url !== undefined ? ` (${pathOf(e.url)})` : ""}`,
          );
        break;
      }
      case "Page.javascriptDialogOpening": {
        // Mid-step, 板砖's: dismissed and reported. Otherwise the
        // Trailblazer's to answer (§8).
        if (this.driving > 0) {
          void this.cdp
            .sendCommand("Page.handleJavaScriptDialog", { accept: false })
            .catch(() => undefined);
          this.pushConsole(
            "warning",
            `dialog (${String(p.type)}) dismissed: ${String(p.message ?? "")}`,
          );
        }
        break;
      }
      case "Runtime.executionContextsCleared":
        this.world = null;
        break;
      case "Runtime.executionContextDestroyed":
        if (p.executionContextId === this.world) this.world = null;
        break;
      case "Page.frameNavigated": {
        const f = p.frame as { id: string; parentId?: string };
        if (f.parentId === undefined) {
          this.mainFrame = f.id;
          this.world = null;
          this.refsLive = false;
        }
        break;
      }
      case "Network.requestWillBeSent": {
        const id = String(p.requestId);
        const r = p.request as { method: string; url: string };
        if (!this.requests.has(id)) {
          this.order.push(id);
          this.inflight += 1;
        }
        this.requests.set(id, {
          method: r.method,
          path: pathOf(r.url),
          type: String(p.type ?? "Other"),
          status: null,
          failed: null,
          start: Date.now(),
          ms: null,
        });
        while (this.order.length > BUFFER) {
          const old = this.order.shift() as string;
          this.requests.delete(old);
        }
        this.lastBusy = Date.now();
        break;
      }
      case "Network.responseReceived": {
        const r = this.requests.get(String(p.requestId));
        if (r !== undefined)
          r.status = (p.response as { status: number }).status;
        break;
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        const r = this.requests.get(String(p.requestId));
        if (r !== undefined && r.ms === null) {
          r.ms = Date.now() - r.start;
          this.inflight = Math.max(0, this.inflight - 1);
          if (method === "Network.loadingFailed")
            r.failed = p.canceled === true ? "canceled" : String(p.errorText);
        }
        this.lastBusy = Date.now();
        break;
      }
      default:
    }
  }

  private pushConsole(level: ConsoleEntry["level"], text: string): void {
    this.consoleSeq += 1;
    this.console.push({
      seq: this.consoleSeq,
      level,
      text: text.slice(0, 500),
    });
    if (this.console.length > BUFFER) this.console.shift();
  }

  /** Where the console stands now: errors after this mark belong to the
   *  step that started here. */
  mark(): number {
    return this.consoleSeq;
  }

  errorsSince(mark: number): string[] {
    return this.console
      .filter((c) => c.seq > mark && c.level === "error")
      .map((c) => c.text);
  }

  /** The console since the last console read (§6). */
  readConsole(onlyErrors: boolean, pattern: string | undefined): PageRead {
    const fresh = this.console.filter(
      (c) =>
        c.seq > this.consoleRead &&
        (!onlyErrors || c.level === "error") &&
        (pattern === undefined || c.text.includes(pattern)),
    );
    this.consoleRead = this.consoleSeq;
    const lines = fresh.map((c) => `[${c.level}] ${c.text}`);
    const text = lines.join("\n");
    return {
      url: this.wc.getURL(),
      title: this.wc.getTitle(),
      text: text.slice(0, CONSOLE_BUDGET),
      ...(text.length > CONSOLE_BUDGET ? { full: text } : {}),
      count: fresh.length,
      truncated: text.length > CONSOLE_BUDGET,
    };
  }

  /** The last requests, failures marked (§6): no headers, no bodies. */
  readNetwork(): PageRead {
    const lines = this.order
      .map((id) => this.requests.get(id))
      .filter((r): r is RequestEntry => r !== undefined)
      .map(
        (r) =>
          `${r.failed !== null || (r.status ?? 0) >= 400 ? "✗ " : ""}${r.method} ${r.path} ${r.failed ?? r.status ?? "…"} ${r.type.toLowerCase()}${r.ms !== null ? ` ${r.ms}ms` : ""}`,
      );
    const text = lines.join("\n");
    return {
      url: this.wc.getURL(),
      title: this.wc.getTitle(),
      text: text.slice(-READ_BUDGET),
      ...(text.length > READ_BUDGET ? { full: text } : {}),
      count: lines.length,
      truncated: text.length > READ_BUDGET,
    };
  }

  /** Run one of the read script's functions in the isolated world. */
  async call<T>(fn: string, ...args: unknown[]): Promise<T> {
    const world = await this.ensureWorld();
    const expression = `__herta.${fn}(${args.map((a) => JSON.stringify(a ?? null)).join(", ")})`;
    const r = (await this.cdp.sendCommand("Runtime.evaluate", {
      expression,
      contextId: world,
      returnByValue: true,
    })) as { result: { value?: unknown }; exceptionDetails?: unknown };
    if (r.exceptionDetails !== undefined)
      throw new BrowserHostError("unavailable", "the page could not be read");
    return r.result.value as T;
  }

  private async ensureWorld(): Promise<number> {
    if (this.world !== null) return this.world;
    let frame = this.mainFrame;
    if (frame === null) {
      const t = (await this.cdp.sendCommand("Page.getFrameTree")) as {
        frameTree: { frame: { id: string } };
      };
      frame = t.frameTree.frame.id;
      this.mainFrame = frame;
    }
    const w = (await this.cdp.sendCommand("Page.createIsolatedWorld", {
      frameId: frame,
      worldName: "herta-read",
    })) as { executionContextId: number };
    await this.cdp.sendCommand("Runtime.evaluate", {
      expression: READ_SCRIPT,
      contextId: w.executionContextId,
    });
    this.world = w.executionContextId;
    return w.executionContextId;
  }

  /** A fresh snapshot: new refs, which stand until the page changes. */
  async snapshot(
    all: boolean,
    budget: number,
    root?: string,
  ): Promise<ReadElements> {
    const r = await this.call<ReadElements | { missing: true }>(
      "snapshot",
      all,
      root ?? null,
      budget,
    );
    if ("missing" in r)
      throw new BrowserHostError(
        this.refsLive ? "no_ref" : "stale_ref",
        `${root} is not an element of the page now`,
      );
    this.refsLive = true;
    return r;
  }

  async find(query: string): Promise<ReadElements> {
    const r = await this.call<ReadElements>("find", query, 20, READ_BUDGET);
    this.refsLive = true;
    return r;
  }

  /** The element a ref names, scrolled into view: where to press. */
  async locate(ref: string): Promise<Extract<Located, { x: number }>> {
    if (!this.refsLive)
      throw new BrowserHostError(
        "stale_ref",
        `${ref} belongs to a page that has changed since it was read`,
      );
    const r = await this.call<Located>("locate", ref);
    if ("missing" in r)
      throw new BrowserHostError("no_ref", `no element is ${ref}`);
    if ("stale" in r)
      throw new BrowserHostError(
        "stale_ref",
        `${ref} is no longer on the page`,
      );
    return r;
  }

  /** 板砖's own input: dispatched through the debugger, and not counted as
   *  the Trailblazer's. */
  async drive<T>(run: () => Promise<T>): Promise<T> {
    this.driving += 1;
    try {
      return await run();
    } finally {
      // The page's own events for this input arrive just after.
      setTimeout(() => {
        this.driving -= 1;
      }, 150);
    }
  }

  async click(x: number, y: number): Promise<void> {
    await this.drive(async () => {
      await this.cdp.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
      });
      for (const type of ["mousePressed", "mouseReleased"])
        await this.cdp.sendCommand("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          clickCount: 1,
        });
    });
  }

  async insertText(text: string): Promise<void> {
    await this.drive(() =>
      this.cdp.sendCommand("Input.insertText", { text }).then(() => undefined),
    );
  }

  async key(key: string): Promise<void> {
    const named = KEYS[key];
    const ch = key.length === 1 ? key : null;
    if (named === undefined && ch === null)
      throw new BrowserHostError(
        "no_ref",
        `${key} is not a key this step presses`,
      );
    const code =
      named?.code ??
      (/[a-z]/i.test(ch as string)
        ? `Key${(ch as string).toUpperCase()}`
        : /[0-9]/.test(ch as string)
          ? `Digit${ch}`
          : "");
    const vk = named?.vk ?? (ch as string).toUpperCase().charCodeAt(0);
    const text = named?.text ?? ch ?? undefined;
    await this.drive(async () => {
      await this.cdp.sendCommand("Input.dispatchKeyEvent", {
        type: text !== undefined ? "keyDown" : "rawKeyDown",
        key,
        code,
        windowsVirtualKeyCode: vk,
        ...(text !== undefined ? { text } : {}),
      });
      await this.cdp.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode: vk,
      });
    });
  }

  async wheel(x: number, y: number, deltaY: number): Promise<void> {
    await this.drive(() =>
      this.cdp
        .sendCommand("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: 0,
          deltaY,
        })
        .then(() => undefined),
    );
  }

  async emulate(
    preset: "phone" | "tablet" | "desktop",
    scheme?: "light" | "dark",
  ): Promise<void> {
    if (preset === "desktop")
      await this.cdp.sendCommand("Emulation.clearDeviceMetricsOverride");
    else {
      const p = PRESETS[preset];
      await this.cdp.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: p.width,
        height: p.height,
        deviceScaleFactor: 0,
        mobile: p.mobile,
      });
    }
    if (scheme !== undefined)
      await this.cdp.sendCommand("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: scheme }],
      });
    this.refsLive = false;
  }

  /** The view in the page's CSS pixels, as one PNG (§6): a screenshot's
   *  pixels and a click's x/y are the same units. */
  async capture(region?: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<PageShot> {
    const vp = await this.call<{ width: number; height: number; dpr: number }>(
      "viewport",
    );
    const clip = region ?? { x: 0, y: 0, width: vp.width, height: vp.height };
    const r = (await this.cdp.sendCommand("Page.captureScreenshot", {
      format: "png",
      clip: { ...clip, scale: 1 / (vp.dpr || 1) },
    })) as { data: string };
    return {
      png: new Uint8Array(Buffer.from(r.data, "base64")),
      width: Math.round(clip.width),
      height: Math.round(clip.height),
    };
  }

  /** After an action: a navigation it started, or half a second of network
   *  quiet, at most five seconds (§6). */
  async settle(signal: AbortSignal): Promise<void> {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 50));
    while (Date.now() - start < SETTLE_MAX_MS) {
      if (signal.aborted) return;
      const quiet = !this.loading && this.inflight === 0;
      if (quiet && Date.now() - this.lastBusy >= NETWORK_QUIET_MS) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  detach(): void {
    try {
      this.cdp.detach();
    } catch {
      // gone with the page
    }
  }
}

/** The page side of `BrowserHost` (ADR 0083 §6), for one app session. Main
 *  owns the page; this runs 板砖's named steps on it and nothing else. */
export class PageDriver implements BrowserHost {
  constructor(
    readonly sessionKey: string,
    private readonly page: {
      /** The session's page and its instrument, made if it has none, and
       *  kept on the window (shown or parked) so it lays out and can be
       *  captured. */
      readonly live: () => { wc: WebContents; instrument: PageInstrument };
      /** The page, when it has one, without making it. */
      readonly existing: () => {
        wc: WebContents;
        instrument: PageInstrument;
      } | null;
      /** 板砖 opened a page: show it to the Trailblazer. */
      readonly opened: () => void;
    },
  ) {}

  currentUrl(): string | null {
    const p = this.page.existing();
    if (p === null || p.wc.isDestroyed()) return null;
    return p.wc.getURL() || null;
  }

  private here(): { wc: WebContents; instrument: PageInstrument } {
    const p = this.page.existing();
    if (p === null || p.wc.isDestroyed())
      throw new BrowserHostError("no_page", "no page is open yet");
    const url = p.wc.getURL();
    if (url !== "" && !isLoopbackUrl(url))
      throw new BrowserHostError(
        "off_loopback",
        `the page is at ${pathOf(url)}, not on this machine`,
      );
    return p;
  }

  private async elements(i: PageInstrument): Promise<PageElements> {
    try {
      const e = await i.snapshot(false, STEP_BUDGET);
      return { lines: e.lines, count: e.count, shown: e.shown };
    } catch {
      return { lines: "", count: 0, shown: 0 };
    }
  }

  async navigate(
    to: PageNavigation,
    signal: AbortSignal,
  ): Promise<PageNavigated> {
    let url: string | null = null;
    if ("url" in to) {
      const raw = to.url.trim();
      url =
        /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z0-9.-]+:\d/i.test(raw)
          ? raw
          : `http://${raw}`;
      if (!/^https?:\/\//i.test(url) && url !== "about:blank")
        throw new BrowserHostError("scheme", "only http(s) addresses open");
      if (!isLoopbackUrl(url))
        throw new BrowserHostError(
          "off_loopback",
          `${pathOf(url)} is not on this machine`,
        );
    } else {
      const have = this.page.existing();
      if (have === null)
        throw new BrowserHostError("no_page", "no page is open yet");
      const h = have.wc.navigationHistory;
      if (
        (to.go === "back" && !h.canGoBack()) ||
        (to.go === "forward" && !h.canGoForward())
      )
        throw new BrowserHostError(
          "no_page",
          `there is no page to go ${to.go} to`,
        );
    }
    const { wc, instrument } = this.page.live();
    this.page.opened();
    const mark = instrument.mark();
    instrument.status = null;
    const done = new Promise<void>((resolve, reject) => {
      const stop = (): void => {
        cleanup();
        resolve();
      };
      const fail = (
        _e: unknown,
        code: number,
        desc: string,
        _u: string,
        isMain: boolean,
      ): void => {
        if (!isMain || code === -3) return;
        cleanup();
        reject(
          new BrowserHostError("load_failed", `the page did not load: ${desc}`),
        );
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new BrowserHostError(
            "timeout",
            "the page did not finish loading in 15 s",
          ),
        );
      }, NAV_TIMEOUT_MS);
      const abort = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        wc.off("did-stop-loading", stop);
        wc.off("did-fail-load", fail);
        signal.removeEventListener("abort", abort);
      };
      wc.on("did-stop-loading", stop);
      wc.on("did-fail-load", fail);
      signal.addEventListener("abort", abort, { once: true });
    });
    if (url !== null) void wc.loadURL(url).catch(() => undefined);
    else if (!("url" in to)) {
      const h = wc.navigationHistory;
      if (to.go === "back") h.goBack();
      else if (to.go === "forward") h.goForward();
      else wc.reload();
    }
    await done;
    if (signal.aborted)
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      status: instrument.status,
      elements: await this.elements(instrument),
      consoleErrors: instrument.errorsSince(mark),
    };
  }

  async read(req: PageReadRequest, _signal: AbortSignal): Promise<PageRead> {
    const { wc, instrument } = this.here();
    const view = (e: ReadElements): PageRead => ({
      url: wc.getURL(),
      title: wc.getTitle(),
      text: e.lines,
      ...(e.shown < e.count || e.full.length > e.lines.length
        ? { full: e.full }
        : {}),
      count: e.count,
      truncated: e.shown < e.count,
    });
    switch (req.mode) {
      case "tree":
        return view(
          await instrument.snapshot(req.all === true, READ_BUDGET, req.ref),
        );
      case "find":
        return view(await instrument.find(req.query));
      case "text": {
        const t = await instrument.call<ReadElements>("text", READ_BUDGET);
        return { ...view(t), truncated: t.count > READ_BUDGET };
      }
      case "console":
        return instrument.readConsole(req.onlyErrors === true, req.pattern);
      default:
        return instrument.readNetwork();
    }
  }

  async act(req: PageAction, signal: AbortSignal): Promise<PageActed> {
    const { wc, instrument } = this.here();
    const before = wc.getURL();
    const mark = instrument.mark();
    let target: string | undefined;
    let hit: string | undefined;
    let password = false;
    const at = async (
      ref: string | undefined,
      x: number | undefined,
      y: number | undefined,
    ): Promise<{ x: number; y: number }> => {
      if (ref !== undefined) {
        const l = await instrument.locate(ref);
        target = l.target;
        if (l.hit !== null) hit = l.hit;
        password = l.password;
        return { x: l.x, y: l.y };
      }
      if (x === undefined || y === undefined)
        throw new BrowserHostError("no_ref", "give a ref, or x and y");
      const there = await instrument.call<{
        target: string;
        password: boolean;
      } | null>("at", x, y);
      if (there !== null) {
        target = there.target;
        password = there.password;
      }
      return { x, y };
    };
    switch (req.action) {
      case "click": {
        const p = await at(req.ref, req.x, req.y);
        await instrument.click(p.x, p.y);
        break;
      }
      case "type": {
        const p = await at(req.ref, req.x, req.y);
        if (password && !isLoopbackUrl(wc.getURL()))
          throw new BrowserHostError(
            "password_refused",
            "a password is typed only on this machine's pages",
          );
        await instrument.click(p.x, p.y);
        await instrument.insertText(req.text);
        if (req.submit === true) await instrument.key("Enter");
        break;
      }
      case "key":
        await instrument.key(req.key);
        break;
      case "scroll": {
        const vp = await instrument.call<{ width: number; height: number }>(
          "viewport",
        );
        const p =
          req.ref !== undefined
            ? await at(req.ref, undefined, undefined)
            : { x: vp.width / 2, y: vp.height / 2 };
        const screens = req.amount ?? 1;
        await instrument.wheel(
          p.x,
          p.y,
          (req.direction === "up" ? -1 : 1) * vp.height * screens * 0.85,
        );
        break;
      }
      case "select": {
        const l = await instrument.locate(req.ref);
        target = l.target;
        if (l.select) {
          if (req.value === undefined)
            throw new BrowserHostError(
              "no_ref",
              "a select box needs the option to choose",
            );
          const r = await instrument.call<{
            chosen: string | null;
            options?: string[];
          }>("choose", req.ref, req.value);
          if (r.chosen === null)
            throw new BrowserHostError(
              "no_ref",
              `no option ${JSON.stringify(req.value)}${r.options !== undefined ? `; the options are ${r.options.join(", ")}` : ""}`,
            );
        } else {
          if (l.hit !== null) hit = l.hit;
          await instrument.click(l.x, l.y);
        }
        break;
      }
      default:
        await instrument.emulate(req.preset, req.scheme);
    }
    await instrument.settle(signal);
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      ...(target !== undefined ? { target } : {}),
      ...(hit !== undefined ? { hit } : {}),
      ...(password ? { password: true } : {}),
      navigated: wc.getURL() !== before,
      elements: await this.elements(instrument),
      consoleErrors: instrument.errorsSince(mark),
    };
  }

  async screenshot(
    req: { region?: { x: number; y: number; width: number; height: number } },
    _signal: AbortSignal,
  ): Promise<PageShot> {
    const { instrument } = this.here();
    return instrument.capture(req.region);
  }
}
