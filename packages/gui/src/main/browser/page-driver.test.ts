import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageDriver, PageInstrument } from "./page-driver.js";

/** 板砖's steps on a page whose debugger is faked (ADR 0083 §6–§8; review
 *  2026-10-30): a dialog, a page that never answers, a scrolled view, a
 *  step that leaves the machine. */

interface Sent {
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

function fakePage(start = "http://localhost:5173/login") {
  const messages = new EventEmitter();
  const state = {
    url: start,
    sent: [] as Sent[],
    /** A page that never answers an evaluate: a script that does not stop. */
    busy: false,
    dialogOpen: false,
    wentBack: false,
    history: [
      { url: "https://github.com/acme/app/settings", title: "Settings" },
      { url: start, title: "Acme" },
    ],
    /** Where a load lands: a redirect, when it differs. */
    lands: (url: string): string => url,
    top: 0,
  };
  let release: (() => void) | null = null;
  const values = (expr: string): unknown => {
    if (expr.startsWith("__herta.viewport"))
      return { width: 800, height: 600, dpr: 1, left: 0, top: state.top };
    return {
      lines: 'e1 button "Sign in"',
      count: 1,
      shown: 1,
      full: 'e1 button "Sign in"',
    };
  };
  const dbg = {
    attach() {},
    detach() {},
    on(event: string, fn: (...args: unknown[]) => void) {
      messages.on(event, fn);
    },
    async sendCommand(method: string, params?: Record<string, unknown>) {
      state.sent.push({ method, ...(params !== undefined ? { params } : {}) });
      switch (method) {
        case "Page.getFrameTree":
          return { frameTree: { frame: { id: "F" } } };
        case "Page.createIsolatedWorld":
          return { executionContextId: 7 };
        case "Page.handleJavaScriptDialog":
          state.dialogOpen = false;
          release?.();
          messages.emit("message", {}, "Page.javascriptDialogClosed", {});
          return {};
        case "Page.captureScreenshot":
          return { data: "" };
        case "Runtime.evaluate": {
          const expr = String(params?.expression ?? "");
          if (!expr.startsWith("__herta.")) return {};
          if (state.busy) return new Promise(() => {});
          // While a dialog is up, the page evaluates nothing.
          if (state.dialogOpen)
            await new Promise<void>((r) => {
              release = r;
            });
          return { result: { value: values(expr) } };
        }
        default:
          return {};
      }
    },
  };
  const wc = Object.assign(new EventEmitter(), {
    debugger: dbg,
    getURL: () => state.url,
    getTitle: () => "Acme",
    isDestroyed: () => false,
    async loadURL(url: string) {
      state.url = state.lands(url);
      setTimeout(() => wc.emit("did-stop-loading"), 0);
    },
    reload() {
      setTimeout(() => wc.emit("did-stop-loading"), 0);
    },
    navigationHistory: {
      canGoBack: () => true,
      canGoForward: () => false,
      getActiveIndex: () => 1,
      getEntryAtIndex: (i: number) => state.history[i],
      goBack() {
        state.wentBack = true;
        state.url = state.history[0]?.url ?? "";
        setTimeout(() => wc.emit("did-stop-loading"), 0);
      },
      goForward() {},
    },
  });
  const instrument = new PageInstrument(wc as unknown as WebContents);
  const page = { wc: wc as unknown as WebContents, instrument };
  const driver = new PageDriver("s1", {
    live: () => page,
    existing: () => page,
    opened: () => {},
  });
  const openDialog = (message: string): void => {
    state.dialogOpen = true;
    messages.emit("message", {}, "Page.javascriptDialogOpening", {
      type: "alert",
      message,
    });
  };
  return { driver, instrument, state, openDialog };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What a step came to, or "hung" when it is still waiting after a second. */
const within = (p: Promise<unknown>) =>
  Promise.race([
    p.then(
      (v) => ({ ok: v }),
      (e: unknown) => ({ err: e }),
    ),
    sleep(1000).then(() => "hung" as const),
  ]);

afterEach(() => {
  vi.useRealTimers();
});

describe("a dialog, or a page that never answers, cannot hold a step", () => {
  it("a dialog left open when a step starts is dismissed and reported, and the step reads the page", async () => {
    const { driver, state, openDialog } = fakePage();
    // The sign-in page's fetch failed after the click's step was over.
    openDialog("Login failed");
    const r = await within(
      driver.read({ mode: "text" }, new AbortController().signal),
    );
    expect(r).not.toBe("hung");
    expect(r).toMatchObject({ ok: { text: 'e1 button "Sign in"' } });
    expect(state.sent.map((s) => s.method)).toContain(
      "Page.handleJavaScriptDialog",
    );
    const log = await driver.read(
      { mode: "console" },
      new AbortController().signal,
    );
    expect(log.text).toContain("dialog (alert) dismissed: Login failed");
  });

  it("a dialog that opens during a step is the step's", async () => {
    const { driver, instrument, openDialog } = fakePage();
    const r = await within(
      instrument.during(new AbortController().signal, async () => {
        openDialog("Are you sure?");
        return driver.read({ mode: "text" }, new AbortController().signal);
      }),
    );
    expect(r).not.toBe("hung");
  });

  it("a run's next step, on the same signal, is still a step after the last one's tail", async () => {
    const { driver, state, openDialog } = fakePage();
    const run = new AbortController();
    await driver.read({ mode: "text" }, run.signal);
    // The next step starts inside the last one's 150 ms tail; a dialog
    // opens after that tail is over, while the step still waits.
    const next = within(
      (async () => {
        state.dialogOpen = true;
        const step = driver.read({ mode: "text" }, run.signal);
        await sleep(200);
        openDialog("Saved");
        return step;
      })(),
    );
    expect(await next).not.toBe("hung");
  });

  it("Stop ends a step on a page that never answers", async () => {
    const { driver, state } = fakePage();
    state.busy = true;
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 20);
    const r = await within(driver.read({ mode: "text" }, stop.signal));
    expect(r).toMatchObject({ err: { name: "AbortError" } });
  });

  it("a page that never answers fails the step after 10 s", async () => {
    vi.useFakeTimers();
    const { driver, state } = fakePage();
    state.busy = true;
    const step = driver.read({ mode: "text" }, new AbortController().signal);
    const settled = step.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await settled).toMatchObject({ code: "unavailable" });
  });
});

describe("a screenshot of a scrolled page", () => {
  it("clips where the view is, not the top of the document", async () => {
    const { driver, state } = fakePage();
    // A click scrolled its element into the middle of a long page.
    state.top = 1500;
    await driver.screenshot({}, new AbortController().signal);
    await driver.screenshot(
      { region: { x: 10, y: 20, width: 100, height: 50 } },
      new AbortController().signal,
    );
    const clips = state.sent
      .filter((s) => s.method === "Page.captureScreenshot")
      .map((s) => s.params?.clip);
    expect(clips).toEqual([
      { x: 0, y: 1500, width: 800, height: 600, scale: 1 },
      { x: 10, y: 1520, width: 100, height: 50, scale: 1 },
    ]);
  });
});

describe("a step never reads a page off this machine (§7)", () => {
  it("back past the app is refused before it goes", async () => {
    const { driver, state } = fakePage();
    const r = await within(
      driver.navigate({ go: "back" }, new AbortController().signal),
    );
    expect(r).toMatchObject({ err: { code: "off_loopback" } });
    expect(String((r as { err: Error }).err.message)).toContain("github.com");
    expect(String((r as { err: Error }).err.message)).not.toContain("settings");
    expect(state.wentBack).toBe(false);
  });

  it("a load that redirects off the machine reads nothing there", async () => {
    const { driver, state } = fakePage();
    state.lands = () => "https://accounts.example.com/signin?next=%2F";
    const evaluated = (): number =>
      state.sent.filter((s) =>
        String(s.params?.expression ?? "").startsWith("__herta.snapshot"),
      ).length;
    const before = evaluated();
    const r = await within(
      driver.navigate({ url: "localhost:5173/" }, new AbortController().signal),
    );
    expect(r).toMatchObject({ err: { code: "off_loopback" } });
    expect(String((r as { err: Error }).err.message)).toContain(
      "accounts.example.com",
    );
    expect(String((r as { err: Error }).err.message)).not.toContain("signin");
    expect(evaluated()).toBe(before);
  });
});
