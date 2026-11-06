import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageDriver, PageInstrument, type RefCounter } from "./page-driver.js";

/** 板砖's steps on a page whose debugger is faked (ADR 0083 §6–§8; review
 *  2026-10-30): a dialog, a page that never answers, a scrolled view, a
 *  step that leaves the machine. */

interface Sent {
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

function fakePage(
  start = "http://localhost:5173/login",
  refCount?: RefCounter,
) {
  const messages = new EventEmitter();
  const state = {
    url: start,
    sent: [] as Sent[],
    /** A page that never answers an evaluate: a script that does not stop. */
    busy: false,
    /** A page that never answers inspect mode, answered by its renderer. */
    overlayHangs: false,
    /** A page that does not acknowledge a scroll. */
    wheelHangs: false,
    dialogOpen: false,
    wentBack: false,
    history: [
      { url: "https://github.com/acme/app/settings", title: "Settings" },
      { url: start, title: "Acme" },
    ],
    /** Where a load lands: a redirect, when it differs. */
    lands: (url: string): string => url,
    top: 0,
    /** What one of the read script's functions answers, by name. */
    answers: {} as Record<string, unknown>,
    /** Chromium's inspect mode: on, a press is a pick, not a click. */
    inspect: "none",
  };
  let release: (() => void) | null = null;
  const values = (expr: string): unknown => {
    const call = /^__herta\.(\w+)\(([\s\S]*)\)$/.exec(expr);
    const fn = call?.[1] ?? "";
    if (fn in state.answers) {
      const a = state.answers[fn];
      return typeof a === "function"
        ? a(...(JSON.parse(`[${call?.[2] ?? ""}]`) as unknown[]))
        : a;
    }
    if (expr.startsWith("__herta.viewport"))
      return { width: 800, height: 600, dpr: 1, left: 0, top: state.top };
    return {
      lines: 'e1 button "Sign in"',
      count: 1,
      shown: 1,
      full: 'e1 button "Sign in"',
      last: 1,
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
        case "Overlay.setInspectMode":
          if (state.overlayHangs) return new Promise(() => {});
          state.inspect = String(params?.mode);
          return {};
        case "Input.dispatchMouseEvent":
          if (params?.type === "mouseWheel" && state.wheelHangs)
            return new Promise(() => {});
          if (params?.type === "mousePressed" && state.inspect !== "none")
            messages.emit("message", {}, "Overlay.inspectNodeRequested", {
              backendNodeId: 42,
            });
          return {};
        case "DOM.resolveNode":
          return { object: { objectId: "node-42" } };
        case "Runtime.callFunctionOn":
          return {
            result: {
              value: { element: 'button "Sign in"', html: "<button>" },
            },
          };
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
  const instrument = new PageInstrument(wc as unknown as WebContents, refCount);
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
  /** A debugger message from the page's own view: the Trailblazer's. */
  const message = (method: string, params: Record<string, unknown>): void => {
    messages.emit("message", {}, method, params);
  };
  return { driver, instrument, state, openDialog, message, wc };
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

  it("Stop ends a press whose picker a hung page will not set aside (review 2026-11-05)", async () => {
    const { driver, instrument, state } = fakePage();
    await instrument.startPick(() => {});
    state.overlayHangs = true;
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 20);
    const r = await within(
      driver.act({ action: "click", x: 100, y: 200 }, stop.signal),
    );
    expect(r).toMatchObject({ err: { name: "AbortError" } });
  });

  it("Stop ends a scroll on a page that does not acknowledge it", async () => {
    const { instrument, state } = fakePage();
    state.wheelHangs = true;
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 20);
    const r = await within(
      instrument.during(stop.signal, () => instrument.wheel(1, 1, 100)),
    );
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

describe("ref numbers across reads and pages (review 2026-11-05)", () => {
  /** The read script, over a page of the given elements: refs count on from
   *  what main passes, and the page keeps the map of the latest read. */
  function readable(state: ReturnType<typeof fakePage>["state"], el: string[]) {
    let refs = new Map<string, string>();
    state.answers.snapshot = (
      all: boolean,
      _root: string | null,
      _budget: number,
      from?: number | null,
    ) => {
      refs = new Map();
      const names = all ? el : el.slice(1);
      const lines = names.map((name, i) => {
        const ref = `e${(from ?? 0) + i + 1}`;
        refs.set(ref, name);
        return `${ref} ${name}`;
      });
      const text = lines.join("\n");
      return {
        lines: text,
        count: lines.length,
        shown: lines.length,
        full: text,
        last: (from ?? 0) + lines.length,
      };
    };
    state.answers.locate = (ref: string) => {
      const target = refs.get(ref);
      return target === undefined
        ? { missing: true }
        : {
            x: 10,
            y: 10,
            target,
            hit: null,
            password: false,
            select: false,
            toggle: false,
          };
    };
  }
  const elements = ['link "Docs"', 'button "Delete account"', 'button "Save"'];

  it("two reads in one batch number on from each other, so a ref names one thing", async () => {
    const { driver, state } = fakePage();
    readable(state, elements);
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([
      driver.read({ mode: "tree", all: true }, signal),
      driver.read({ mode: "tree" }, signal),
    ]);
    expect(first.text.split("\n")[1]).toBe('e2 button "Delete account"');
    // Numbered from the same ref, e2 would be "Save" here.
    expect(second.text).toBe('e4 button "Delete account"\ne5 button "Save"');
    await expect(
      driver.act({ action: "click", ref: "e2" }, signal),
    ).rejects.toMatchObject({ code: "stale_ref" });
    expect(
      (await driver.act({ action: "click", ref: "e5" }, signal)).target,
    ).toBe('button "Save"');
  });

  it("a read that fails does not hold up the next", async () => {
    const { driver, state } = fakePage();
    readable(state, elements);
    const signal = new AbortController().signal;
    const answer = state.answers.snapshot;
    state.answers.snapshot = () => ({ missing: true });
    const failed = driver.read({ mode: "tree", ref: "e9" }, signal);
    state.answers.snapshot = answer;
    await failed.catch(() => undefined);
    expect((await driver.read({ mode: "tree" }, signal)).text).toContain(
      'button "Save"',
    );
  });

  it("a page closed and opened again counts on: an old ref clicks nothing", async () => {
    const count: RefCounter = { last: 0 };
    const first = fakePage(undefined, count);
    readable(first.state, elements);
    const signal = new AbortController().signal;
    expect((await first.driver.read({ mode: "tree" }, signal)).text).toContain(
      'e2 button "Save"',
    );
    const second = fakePage(undefined, count);
    readable(second.state, ['link "Docs"', 'button "Save"', 'link "Docs"']);
    expect((await second.driver.read({ mode: "tree" }, signal)).text).toBe(
      'e3 button "Save"\ne4 link "Docs"',
    );
    await expect(
      second.driver.act({ action: "click", ref: "e2" }, signal),
    ).rejects.toMatchObject({ code: "stale_ref" });
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

describe("the network-quiet wait (review 2026-10-30, M3)", () => {
  it("a request that outlives 200 newer ones still counts down when it ends", async () => {
    vi.useFakeTimers();
    const { instrument, message } = fakePage();
    const sent = (id: string) =>
      message("Network.requestWillBeSent", {
        requestId: id,
        request: { method: "GET", url: `http://localhost:5173/${id}.js` },
        type: "Script",
      });
    const done = (id: string) =>
      message("Network.loadingFinished", { requestId: id });
    // A Vite module burst: the first module is still loading while 200
    // newer ones come and go.
    sent("slow");
    for (let i = 0; i < 200; i += 1) {
      sent(`m${i}`);
      done(`m${i}`);
    }
    done("slow");
    let settled = false;
    void instrument.settle(new AbortController().signal).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(true);
  });
});

describe("an older read's ref names nothing (review 2026-10-30, M1)", () => {
  it("e1 was Sign in; after a newer read it fails as stale, not a click on Docs", async () => {
    const { driver, state } = fakePage();
    // The read script as a page whose one button changes between reads.
    let names = ['button "Sign in"'];
    let refs = new Map<string, string>();
    state.answers.snapshot = (
      _all: boolean,
      _root: string | null,
      _budget: number,
      from?: number | null,
    ) => {
      refs = new Map();
      const lines = names.map((name, i) => {
        const ref = `e${(from ?? 0) + i + 1}`;
        refs.set(ref, name);
        return `${ref} ${name}`;
      });
      const text = lines.join("\n");
      return {
        lines: text,
        count: lines.length,
        shown: lines.length,
        full: text,
        last: (from ?? 0) + lines.length,
      };
    };
    state.answers.locate = (ref: string) => {
      const target = refs.get(ref);
      return target === undefined
        ? { missing: true }
        : {
            x: 10,
            y: 10,
            target,
            hit: null,
            password: false,
            select: false,
            toggle: false,
          };
    };
    const signal = new AbortController().signal;
    expect((await driver.read({ mode: "tree" }, signal)).text).toBe(
      'e1 button "Sign in"',
    );
    names = ['button "Docs"'];
    expect((await driver.read({ mode: "tree" }, signal)).text).toBe(
      'e2 button "Docs"',
    );
    await expect(
      driver.act({ action: "click", ref: "e1" }, signal),
    ).rejects.toMatchObject({ code: "stale_ref" });
    expect(
      (await driver.act({ action: "click", ref: "e2" }, signal)).target,
    ).toBe('button "Docs"');
    await expect(
      driver.act({ action: "click", ref: "e99" }, signal),
    ).rejects.toMatchObject({ code: "no_ref" });
  });
});

describe("typing is masked where the text lands (review 2026-10-30, M6)", () => {
  it("a type by x/y on a wrapper that focuses a password field is masked", async () => {
    const { driver, state } = fakePage();
    state.answers.at = { target: 'div ""', password: false };
    state.answers.focusedPassword = true;
    const r = await driver.act(
      { action: "type", x: 100, y: 200, text: "hunter2" },
      new AbortController().signal,
    );
    expect(r.password).toBe(true);
  });

  it("a type that lands on a plain field is not", async () => {
    const { driver, state } = fakePage();
    state.answers.at = { target: 'textbox "Email"', password: false };
    state.answers.focusedPassword = false;
    const r = await driver.act(
      { action: "type", x: 100, y: 200, text: "me@example.com" },
      new AbortController().signal,
    );
    expect(r.password).toBeUndefined();
  });
});

describe("the Trailblazer's picker (review 2026-10-30, M2)", () => {
  it("板砖's click while a pick is on is a click, not their pick, and the pick stays on", async () => {
    const { driver, instrument, state } = fakePage();
    const picks: string[] = [];
    await instrument.startPick((p) => picks.push(p.element));
    state.answers.at = { target: 'button "Sign in"', password: false };
    await driver.act(
      { action: "click", x: 100, y: 200 },
      new AbortController().signal,
    );
    await sleep(10);
    expect(picks).toEqual([]);
    expect(instrument.picking).toBe(true);
    expect(state.inspect).toBe("searchForNode");
    const modes = state.sent
      .filter(
        (s) =>
          s.method === "Overlay.setInspectMode" ||
          (s.method === "Input.dispatchMouseEvent" &&
            s.params?.type === "mousePressed"),
      )
      .map((s) => String(s.params?.mode ?? s.params?.type));
    expect(modes).toEqual([
      "searchForNode",
      "none",
      "mousePressed",
      "searchForNode",
    ]);
  });

  it("the Trailblazer's own press still picks", async () => {
    const { instrument, state, message } = fakePage();
    const picks: string[] = [];
    await instrument.startPick((p) => picks.push(p.element));
    // Their press reaches the page's view, not 板砖's dispatch.
    message("Overlay.inspectNodeRequested", { backendNodeId: 42 });
    await sleep(10);
    expect(picks).toEqual(['button "Sign in"']);
    expect(instrument.picking).toBe(false);
    expect(state.inspect).toBe("none");
  });
});

describe("requests that will never finish (review 2026-11-05, M8)", () => {
  const started = (
    message: (m: string, p: Record<string, unknown>) => void,
  ) => {
    for (const id of ["a", "b", "c"]) {
      message("Network.requestWillBeSent", {
        requestId: id,
        request: { method: "GET", url: `http://localhost:5173/${id}.js` },
        type: "Script",
      });
    }
  };
  const settles = async (instrument: PageInstrument): Promise<boolean> => {
    let settled = false;
    void instrument.settle(new AbortController().signal).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    return settled;
  };

  it("end with their document", async () => {
    vi.useFakeTimers();
    const { instrument, message } = fakePage();
    started(message);
    message("Page.frameNavigated", { frame: { id: "main" } });
    expect(await settles(instrument)).toBe(true);
  });

  it("a frame's navigation leaves the page's alone", async () => {
    vi.useFakeTimers();
    const { instrument, message } = fakePage();
    started(message);
    message("Page.frameNavigated", { frame: { id: "ad", parentId: "main" } });
    expect(await settles(instrument)).toBe(false);
  });

  it("end with a crashed renderer", async () => {
    vi.useFakeTimers();
    const { instrument, message, wc } = fakePage();
    started(message);
    wc.emit("render-process-gone");
    expect(await settles(instrument)).toBe(true);
  });
});

describe("what the system browser may open for (review 2026-11-05, M7)", () => {
  it("the Trailblazer's press counts once, and not for long; 板砖's never", () => {
    vi.useFakeTimers();
    const { instrument, wc } = fakePage();
    wc.emit("input-event", {}, { type: "mouseDown" });
    expect(instrument.takeGesture()).toBe(true);
    expect(instrument.takeGesture()).toBe(false);
    wc.emit("input-event", {}, { type: "keyDown" });
    vi.advanceTimersByTime(1600);
    expect(instrument.takeGesture()).toBe(false);
    wc.emit("input-event", {}, { type: "mouseMove" });
    expect(instrument.takeGesture()).toBe(false);
  });
});

describe("a step never reads a page off this machine (§7)", () => {
  it("a step whose move was stopped fails, and names where it was going (review 2026-11-05, M5)", async () => {
    const { driver, instrument, state, wc } = fakePage();
    const load = wc.loadURL.bind(wc);
    wc.loadURL = async (url: string) => {
      instrument.noteRefused("https://accounts.example.com/signin?next=%2F");
      return load(url);
    };
    const r = await within(
      driver.navigate({ url: "localhost:5173/" }, new AbortController().signal),
    );
    expect(r).toMatchObject({ err: { code: "off_loopback" } });
    const told = String((r as { err: Error }).err.message);
    expect(told).toContain("accounts.example.com");
    expect(told).not.toContain("signin");
    void state;
  });

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
