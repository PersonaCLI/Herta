/**
 * The browser page (ADR 0083): the shapes main and the renderer share, and
 * the pure rules for where a page may go. The page is a main-owned
 * `WebContentsView` laid over the viewer panel's page tab; the renderer
 * reports where the tab is, main places the view there.
 */

/** Where the page tab's content area is, in the renderer's CSS pixels. */
export interface PageBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What the page tab's header shows. */
export interface PageState {
  readonly sessionId: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** A move the Trailblazer asks of the page: an address typed into the URL
 *  bar (main reads it, never trusting the renderer), or a history step. */
export type PageNavigation =
  | { readonly url: string }
  | { readonly go: "back" | "forward" | "reload" | "stop" };

/** The schemes a page may be at (ADR 0083 §8): `http`, `https` and
 *  `about:blank`. `file:`, `chrome:`, `devtools:`, `javascript:` and the
 *  rest are refused, whoever asks. */
export function pageUrlAllowed(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** A host this machine answers for itself: `localhost`, `*.localhost`,
 *  127.0.0.0/8 and `::1` (ADR 0083 §7). Not ADR 0080's `isLocalHost`, which
 *  counts the LAN as local — right for refusing a fetch, wrong for letting
 *  a browser in. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return v4 !== null && Number(v4[1]) === 127;
}

/**
 * What the URL bar's text opens, or null: a full `http(s)` URL as it is; a
 * bare loopback host (`localhost:5173/login`, `127.0.0.1:3000`) over http,
 * as a dev server speaks; any other bare host with a dot over https. A
 * word with no dot is not an address — there is no search engine here.
 */
export function typedPageUrl(text: string): string | null {
  const raw = text.trim();
  if (raw.length === 0 || /\s/.test(raw)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^about:/i.test(raw)) {
    return pageUrlAllowed(raw) ? new URL(raw).href : null;
  }
  const host = raw.split(/[/?#]/, 1)[0] ?? "";
  const name = host.startsWith("[") ? host : host.replace(/:\d+$/, "");
  let candidate: string;
  if (isLoopbackHost(name)) candidate = `http://${raw}`;
  else if (name.includes(".")) candidate = `https://${raw}`;
  else return null;
  try {
    const u = new URL(candidate);
    return pageUrlAllowed(u.href) && u.hostname.length > 0 ? u.href : null;
  } catch {
    return null;
  }
}
