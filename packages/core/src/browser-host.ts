/**
 * The browser seam 板砖's page steps run on (ADR 0083 §6): one page per app
 * session, which the Trailblazer watches in the viewer.
 *
 * Declared here, implemented by the desktop's main process (the page it
 * owns), injected into `@herta/tools` — the shape the web client set (ADR
 * 0080): the tool package depends on core only. The CLI has no page and
 * mounts none of the tools.
 */

/**
 * Why a page step failed, in the words the tools turn into a result:
 *
 *  - `no_page` — nothing is open yet: navigate first;
 *  - `off_loopback` — the page's address is not on this machine (the
 *    Trailblazer may have gone anywhere); the first slice reads and acts on
 *    loopback only;
 *  - `scheme` — an address that is not http(s) or about:blank;
 *  - `stale_ref` — a ref from a snapshot that has ended (a navigation, the
 *    Trailblazer's own input, a newer read);
 *  - `no_ref` — no element has that ref in the current snapshot;
 *  - `timeout` — the page did not finish loading in 15 s;
 *  - `load_failed` — the address could not be reached (refused, DNS);
 *  - `password_refused` — typing into a password field off loopback;
 *  - `unavailable` — the page went away or the debugger failed.
 */
export type BrowserFailure =
  | "no_page"
  | "off_loopback"
  | "scheme"
  | "stale_ref"
  | "no_ref"
  | "timeout"
  | "load_failed"
  | "password_refused"
  | "unavailable";

export class BrowserHostError extends Error {
  readonly code: BrowserFailure;

  constructor(code: BrowserFailure, message: string) {
    super(message);
    this.name = "BrowserHostError";
    this.code = code;
  }
}

/** The page's interactive elements, each line `e12 button "Sign in"`, in
 *  document order, bounded by the caller's budget. */
export interface PageElements {
  readonly lines: string;
  /** How many interactive elements the page has in all. */
  readonly count: number;
  /** How many lines `lines` holds (fewer than `count` when cut). */
  readonly shown: number;
}

/** Where the page is and what 板砖 can act on there. */
export interface PageView {
  readonly url: string;
  readonly title: string;
  readonly elements: PageElements;
  /** Console errors and uncaught exceptions since the step began. */
  readonly consoleErrors: readonly string[];
}

export interface PageNavigated extends PageView {
  /** The main document's HTTP status; null for about:blank or a history
   *  step served from cache. */
  readonly status: number | null;
}

export type PageNavigation =
  | { readonly url: string }
  | { readonly go: "back" | "forward" | "reload" };

export type PageReadRequest =
  | {
      readonly mode: "tree";
      /** Only this element's subtree. */
      readonly ref?: string;
      /** Every element with a role, not only those that can be acted on. */
      readonly all?: boolean;
    }
  | { readonly mode: "find"; readonly query: string }
  | { readonly mode: "text" }
  | {
      readonly mode: "console";
      readonly onlyErrors?: boolean;
      readonly pattern?: string;
    }
  | { readonly mode: "network" };

/** What a read found. `text` is bounded by the host; `full`, when the mode
 *  has more than it shows, is the whole of it for the store. */
export interface PageRead {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly full?: string;
  /** Items found in all (elements, matches, messages, requests). */
  readonly count: number;
  readonly truncated: boolean;
}

export type PageAction =
  | {
      readonly action: "click";
      readonly ref?: string;
      readonly x?: number;
      readonly y?: number;
    }
  | {
      readonly action: "type";
      readonly text: string;
      readonly ref?: string;
      readonly x?: number;
      readonly y?: number;
      /** Press Enter after the text. */
      readonly submit?: boolean;
    }
  | { readonly action: "key"; readonly key: string }
  | {
      readonly action: "scroll";
      readonly direction: "up" | "down";
      /** Screens to scroll; one by default. */
      readonly amount?: number;
      readonly ref?: string;
    }
  | {
      readonly action: "select";
      readonly ref: string;
      /** A select box's option, by its text or value; absent for a
       *  checkbox or radio, which is toggled. */
      readonly value?: string;
    }
  | {
      readonly action: "resize";
      readonly preset: "phone" | "tablet" | "desktop";
      readonly scheme?: "light" | "dark";
    };

export interface PageActed extends PageView {
  /** The element the step acted on, as `button "Sign in"`; absent for a
   *  key, a scroll of the page, a resize, or a position. */
  readonly target?: string;
  /** The address changed during the step. */
  readonly navigated: boolean;
  /** A click or a type landed on something else than the element asked
   *  for: what it hit, as `button "Close"`. */
  readonly hit?: string;
  /** The step typed into a password field (the record masks it). */
  readonly password?: boolean;
}

export interface PageShot {
  /** PNG bytes. */
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface BrowserHost {
  /** The app session the page belongs to: the store's folder. */
  readonly sessionKey: string;
  /** The page's address now, or null with no page: what the rules judge. */
  currentUrl(): string | null;
  navigate(to: PageNavigation, signal: AbortSignal): Promise<PageNavigated>;
  read(req: PageReadRequest, signal: AbortSignal): Promise<PageRead>;
  act(req: PageAction, signal: AbortSignal): Promise<PageActed>;
  /** The viewport, or a region of it in the page's CSS pixels. */
  screenshot(
    req: {
      readonly region?: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
      };
    },
    signal: AbortSignal,
  ): Promise<PageShot>;
}

/** A host this machine answers for itself: `localhost`, `*.localhost`,
 *  127.0.0.0/8 and `::1` (ADR 0083 §7). Not ADR 0080's `isLocalHost`,
 *  which counts the LAN as local — right for refusing a fetch, wrong for
 *  letting a browser in. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return v4 !== null && Number(v4[1]) === 127;
}

/** An http(s) address on this machine, or about:blank. */
export function isLoopbackUrl(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const u = new URL(url);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      isLoopbackHost(u.hostname)
    );
  } catch {
    return false;
  }
}

/** The op verbs of the page steps' rows (ADR 0083 §10). */
export type BrowserOpVerb =
  | "Opening page"
  | "Reading page"
  | "Finding on page"
  | "Reading console"
  | "Reading network"
  | "Clicking"
  | "Typing"
  | "Pressing"
  | "Scrolling"
  | "Choosing"
  | "Resizing page"
  | "Taking screenshot";

const BROWSER_OP_VERBS: ReadonlySet<string> = new Set<BrowserOpVerb>([
  "Opening page",
  "Reading page",
  "Finding on page",
  "Reading console",
  "Reading network",
  "Clicking",
  "Typing",
  "Pressing",
  "Scrolling",
  "Choosing",
  "Resizing page",
  "Taking screenshot",
]);

export function isBrowserOpVerb(verb: string): verb is BrowserOpVerb {
  return BROWSER_OP_VERBS.has(verb);
}

const ACT_VERB: Readonly<Record<string, BrowserOpVerb>> = {
  click: "Clicking",
  type: "Typing",
  key: "Pressing",
  scroll: "Scrolling",
  select: "Choosing",
  resize: "Resizing page",
};

/**
 * The verb of a page step's op row, from its tool and the summary the tool
 * wrote for the call (its mode or action leads), or null for any other
 * tool. The record projection and the desktop's live feed both read it, so
 * a live step and the row that replaces it name the same verb. A summary
 * not yet known (arguments still streaming) reads as the tool's commonest
 * step.
 */
export function browserOpVerb(
  tool: string,
  summary = "",
): BrowserOpVerb | null {
  const word = /^\S*/.exec(summary)?.[0] ?? "";
  switch (tool) {
    case "browser_navigate":
      return "Opening page";
    case "browser_read":
      return word === "find"
        ? "Finding on page"
        : word === "console"
          ? "Reading console"
          : word === "network"
            ? "Reading network"
            : "Reading page";
    case "browser_act":
      return ACT_VERB[word] ?? "Clicking";
    case "browser_screenshot":
      return "Taking screenshot";
    default:
      return null;
  }
}

/** A page step's op-row argument: the summary less the mode or action word
 *  its verb already says — a navigation keeps its address whole. */
export function browserOpArg(tool: string, summary: string): string {
  const s = summary.trim();
  return tool === "browser_navigate" ? s : s.replace(/^\S*\s*/, "");
}
