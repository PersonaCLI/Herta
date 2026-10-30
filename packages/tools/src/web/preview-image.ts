import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkFetchUrl } from "./url-check.js";

/**
 * A page's own preview picture (`og:image`, else `twitter:image`), fetched
 * on this machine for a Flow post already chosen (ADR 0084 §8). The one
 * case ADR 0080's "Not taken: fetching on this machine" lets in, so every
 * step is guarded:
 *
 *  - the page's address passes `checkFetchUrl` and is https;
 *  - every address its host resolves to is public — not loopback, private,
 *    link-local, CGNAT, multicast or unspecified — and the connection is
 *    made to the checked address, so a second lookup cannot turn it inward;
 *  - at most three redirects, each checked the same way;
 *  - no cookies (a bare request: there is no jar to send);
 *  - the page is read only to `</head>`, at most 512 KB, and the tag found
 *    by a bounded scan, not a parser;
 *  - the picture is `image/jpeg|png|webp|gif|avif`, at most 2 MB, all within
 *    ten seconds.
 *
 * All of it is async (ADR 0068): the desktop runs it on the main process.
 */

export type PreviewRefusal =
  | "address"
  | "not_public"
  | "redirects"
  | "status"
  | "no_image"
  | "type"
  | "too_large"
  | "timeout"
  | "failed";

export type PreviewImage =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly type: string }
  | { readonly ok: false; readonly why: PreviewRefusal };

/** What a GET answered: its status, headers and body. */
export interface PreviewResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  /** Stop reading; the connection goes. */
  readonly close: () => void;
}

/** A GET of `url` to the checked `address`. Injected for tests. */
export type PreviewGet = (
  url: URL,
  address: { readonly address: string; readonly family: 4 | 6 },
  accept: string,
  signal: AbortSignal,
) => Promise<PreviewResponse>;

export type PreviewLookup = (
  hostname: string,
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

const PAGE_HEAD_BYTES = 512 * 1024;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEADLINE_MS = 10_000;
const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|avif)\b/i;

/** A public address: none of the ranges this machine's own network uses.
 *  198.18.0.0/15 stays allowed: a fake-IP proxy (Clash, sing-box — common
 *  where the owner works) answers every public name from it and carries the
 *  connection itself; refusing it refused every page on such a machine
 *  (2026-10-30). It is never a host on this machine's own network. */
export function publicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (isIP(ip) !== 6) return false;
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return publicAddress(v6.slice(7));
  return !(
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    /^fe[89ab]/.test(v6) ||
    v6.startsWith("ff") ||
    v6.startsWith("64:ff9b:") ||
    v6.startsWith("2001:db8")
  );
}

/** The checked address to connect to, or why there is none. */
async function checkedAddress(
  raw: string,
  lookup: PreviewLookup,
): Promise<
  | { readonly url: URL; readonly address: string; readonly family: 4 | 6 }
  | { readonly refused: PreviewRefusal }
> {
  const check = checkFetchUrl(raw);
  if (!check.ok || check.url.protocol !== "https:")
    return { refused: "address" };
  const host = check.url.hostname.replace(/^\[|\]$/g, "");
  const all = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host).catch(() => []);
  if (all.length === 0 || !all.every((a) => publicAddress(a.address)))
    return { refused: "not_public" };
  const first = all[0] as { address: string; family: number };
  return {
    url: check.url,
    address: first.address,
    family: first.family === 6 ? 6 : 4,
  };
}

/** GET with redirects followed by hand, each hop checked again. */
async function guardedGet(
  start: string,
  accept: string,
  deps: { readonly get: PreviewGet; readonly lookup: PreviewLookup },
  signal: AbortSignal,
): Promise<
  | { readonly res: PreviewResponse; readonly url: URL }
  | { readonly refused: PreviewRefusal }
> {
  let next = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = await checkedAddress(next, deps.lookup);
    if ("refused" in target) return target;
    const res = await deps.get(target.url, target, accept, signal);
    const location = res.headers.location;
    if (res.status >= 300 && res.status < 400 && location !== undefined) {
      res.close();
      next = new URL(location, target.url).toString();
      continue;
    }
    if (res.status !== 200) {
      res.close();
      return { refused: "status" };
    }
    return { res, url: target.url };
  }
  return { refused: "redirects" };
}

/** The preview tag in a page's head, resolved against the page. */
export function previewImageUrl(head: string, page: URL): string | null {
  for (const name of ["og:image:secure_url", "og:image", "twitter:image"]) {
    const tags = head.match(/<meta\b[^>]*>/gi) ?? [];
    for (const tag of tags) {
      const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (key?.toLowerCase() !== name) continue;
      const content = /\bcontent\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      if (content === undefined || content.trim() === "") continue;
      try {
        return new URL(content.trim().replace(/&amp;/g, "&"), page).toString();
      } catch {
        // a malformed tag: try the next
      }
    }
  }
  return null;
}

/** The page's preview picture, or why there is none. Rejects only with an
 *  abort of the caller's signal. */
export async function fetchPreviewImage(
  pageUrl: string,
  signal: AbortSignal,
  deps: {
    readonly get?: PreviewGet;
    readonly lookup?: PreviewLookup;
    readonly deadlineMs?: number;
  } = {},
): Promise<PreviewImage> {
  const get = deps.get ?? nodeGet;
  const lookup = deps.lookup ?? defaultLookup;
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(),
    deps.deadlineMs ?? DEADLINE_MS,
  );
  const onAbort = () => deadline.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const page = await guardedGet(
      pageUrl,
      "text/html",
      { get, lookup },
      deadline.signal,
    );
    if ("refused" in page) return { ok: false, why: page.refused };
    let head = "";
    const dec = new TextDecoder();
    let read = 0;
    for await (const chunk of page.res.body) {
      read += chunk.byteLength;
      head += dec.decode(chunk, { stream: true });
      if (/<\/head>/i.test(head) || read >= PAGE_HEAD_BYTES) break;
    }
    page.res.close();
    const src = previewImageUrl(head.slice(0, PAGE_HEAD_BYTES), page.url);
    if (src === null) return { ok: false, why: "no_image" };
    const img = await guardedGet(
      src,
      "image/*",
      { get, lookup },
      deadline.signal,
    );
    if ("refused" in img) return { ok: false, why: img.refused };
    const type = img.res.headers["content-type"] ?? "";
    if (!IMAGE_TYPES.test(type)) {
      img.res.close();
      return { ok: false, why: "type" };
    }
    const length = Number(img.res.headers["content-length"] ?? "0");
    if (length > IMAGE_MAX_BYTES) {
      img.res.close();
      return { ok: false, why: "too_large" };
    }
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of img.res.body) {
      size += chunk.byteLength;
      if (size > IMAGE_MAX_BYTES) {
        img.res.close();
        return { ok: false, why: "too_large" };
      }
      parts.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.byteLength;
    }
    return { ok: true, bytes, type: type.split(";")[0]?.trim() ?? type };
  } catch (err) {
    if (signal.aborted) throw err;
    return { ok: false, why: deadline.signal.aborted ? "timeout" : "failed" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

const defaultLookup: PreviewLookup = (hostname) =>
  dnsLookup(hostname, { all: true });

/** Node's https, connected to the checked address: `lookup` answers with it,
 *  so the hostname still names the certificate and the Host header. */
const nodeGet: PreviewGet = (url, address, accept, signal) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        headers: { accept, "user-agent": "Mozilla/5.0 (Herta Flow preview)" },
        signal,
        lookup: (_host, opts, cb) => {
          if ((opts as { all?: boolean }).all === true)
            (cb as unknown as (e: null, a: object[]) => void)(null, [
              { address: address.address, family: address.family },
            ]);
          else cb(null, address.address, address.family);
        },
      },
      (res) => {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers))
          headers[k] = Array.isArray(v) ? v.join(", ") : v;
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: res as AsyncIterable<Uint8Array>,
          close: () => res.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
