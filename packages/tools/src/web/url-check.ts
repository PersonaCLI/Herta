import { isIP } from "node:net";
import { TOKEN_SECRET_PATTERNS } from "../run-command/redactor.js";

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

/** A parameter name's words: split at `_`, `-`, `.` and camelCase. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[\s_.-]+/u)
    .filter((w) => w.length > 0);
}

const SECRET_LAST_WORDS = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "apikey",
  "credential",
  "credentials",
  "signature",
  "sig",
]);
/** The words that make a `…key` name a secret one; a `publicKey` or a
 *  `sortKey` is not. */
const SECRET_KEY_KINDS = new Set([
  "api",
  "access",
  "private",
  "secret",
  "client",
  "auth",
  "account",
  "master",
  "subscription",
  "license",
  "app",
]);

/** A query parameter named for a credential: its last word is one
 *  (`access_token`, `X-Amz-Signature`, `client_secret`), a secret kind of
 *  key (`api_key`, `x-api-key`), or `key` / `auth` alone. A word that only
 *  starts like one is not: `tokenizer`, `secretary`. */
export function credentialParamName(name: string): boolean {
  const words = nameWords(name);
  const last = words[words.length - 1];
  if (last === undefined) return false;
  if (SECRET_LAST_WORDS.has(last)) return true;
  if (words.length === 1 && (last === "key" || last === "auth")) return true;
  return last === "key" && SECRET_KEY_KINDS.has(words[words.length - 2] ?? "");
}

/** An `sk-` key, not a slug: a run of 20 or more after the prefix, with
 *  digits in it and a stretch of 12 or more between its dashes. A key is
 *  random; `/sk-some-long-slug-name-here` and `/sk-2024-release-notes` are
 *  words. */
function skKeyShaped(text: string): boolean {
  for (const m of text.matchAll(/\bsk-[A-Za-z0-9_-]{20,}/gu)) {
    const body = m[0].slice(3);
    const digits = body.replace(/\D/gu, "").length;
    const longest = Math.max(...body.split(/[-_]/u).map((s) => s.length));
    if (digits >= 3 && longest >= 12) return true;
  }
  return false;
}

/** A token's shape anywhere in the text, by the redactor's known prefixes —
 *  `sk-` read as above, and no `Bearer` (a URL holds no spaces). */
function tokenShaped(text: string): boolean {
  if (skKeyShaped(text)) return true;
  return TOKEN_SECRET_PATTERNS.some(
    ({ kind, re }) =>
      kind !== "api_key" &&
      kind !== "bearer" &&
      new RegExp(re.source).test(text),
  );
}

/** An env file's line carried in a URL: a name ENDING in a credential stem,
 *  then `=` and a value (`DEEPSEEK_API_KEY=…`). The stem must end the
 *  name: `tokenizer=gpt2` is not one. */
const ENV_LINE =
  /[A-Za-z0-9_]*(?:API_?KEY|ACCESS_KEY|SECRET(?:_KEY)?|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY)\s*=\s*[^\s&#]/iu;

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Whether a URL carries something credential-shaped (ADR 0080 §2): a
 *  parameter named for a credential, with a value; a token's shape anywhere
 *  in it; or an env line — read decoded, so `%3D` hides nothing, and the
 *  fragment counts. Release review 2026-10-22: the shell redactor's rules,
 *  run over the whole URL, refused `?tokenizer=gpt2`, `?secretary=…` and a
 *  `/sk-…` slug — public pages 板砖 was sent to read. */
export function credentialShapedUrl(url: URL): boolean {
  for (const [name, value] of url.searchParams) {
    if (value.trim().length > 0 && credentialParamName(name)) return true;
  }
  const text = decoded(url.href);
  return tokenShaped(text) || ENV_LINE.test(text);
}

/**
 * What the harness checks before a URL leaves (ADR 0080 §2), in place of an
 * approval: http(s) only, at most 2 048 chars, no `user:pass@`, not a local
 * host, nothing credential-shaped (`credentialShapedUrl` — a token, a
 * parameter named for a credential, a JWT, an env line).
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
  if (credentialShapedUrl(url)) return { ok: false, reason: "secret" };
  return { ok: true, url };
}
