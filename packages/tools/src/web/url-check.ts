import { isIP } from "node:net";
import { redactSecrets } from "../run-command/redactor.js";

/** A fetch URL longer than this is refused (ADR 0080 §2): tighter than the
 *  provider's 8 192, because a URL is the one way a fetch carries text out. */
export const MAX_FETCH_URL_CHARS = 2048;

export type UrlRefusal =
  | { readonly reason: "not_a_url" }
  | { readonly reason: "scheme" }
  | { readonly reason: "too_long" }
  | { readonly reason: "userinfo" }
  | { readonly reason: "local_host" }
  | { readonly reason: "secret" };

export type UrlCheck =
  | { readonly ok: true; readonly url: URL }
  | ({ readonly ok: false } & UrlRefusal);

function ipv4Private(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  return ipv4Private(parts[0] ?? 0, parts[1] ?? 0);
}

function privateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  // An IPv4 address carried in IPv6 (`::ffff:10.0.0.1`, `::ffff:a00:1`).
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped?.[1] !== undefined) {
    const inner = mapped[1];
    if (isIP(inner) === 4) return privateIpv4(inner);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
    if (hex?.[1] !== undefined && hex[2] !== undefined) {
      const hi = Number.parseInt(hex[1], 16);
      return ipv4Private(hi >> 8, hi & 0xff);
    }
    return true;
  }
  const first = Number.parseInt(h.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

/**
 * A host this machine reaches and the provider's fetcher does not:
 * loopback, private and link-local addresses, `localhost`, mDNS `.local`,
 * and single-label names an intranet resolves. DeepSeek's fetcher answers
 * 404 for every one of them (probe 2026-10-18); refusing first says why and
 * points at `curl`, which reads a loopback server without a card.
 */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const kind = isIP(host);
  if (kind === 4) return privateIpv4(host);
  if (kind === 6) return privateIpv6(host);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  return !host.includes(".");
}

/**
 * What the harness checks before a URL leaves (ADR 0080 §2), in place of an
 * approval: http(s) only, at most 2 048 chars, no `user:pass@`, not a local
 * host, nothing credential-shaped (the shell redactor's own patterns — a
 * token, a `key=` / `token=` parameter, a JWT).
 */
export function checkFetchUrl(raw: string): UrlCheck {
  const text = raw.trim();
  if (text.length > MAX_FETCH_URL_CHARS)
    return { ok: false, reason: "too_long" };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "not_a_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "scheme" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "userinfo" };
  }
  if (url.hostname === "" || isLocalHost(url.hostname)) {
    return { ok: false, reason: "local_host" };
  }
  if (redactSecrets(text) !== text) return { ok: false, reason: "secret" };
  return { ok: true, url };
}
