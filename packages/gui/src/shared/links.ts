import { quotedPageUrls } from "@herta/core/quoted-pages";

/**
 * The few places outside the app a click may open (2026-09-09). The main
 * process opens ONLY these hosts through the OS browser (`shell:openExternal`
 * is allowlisted, not a general "open any URL" door), and the renderer
 * names the pages by these constants. The netdisk is the owner's mirror of
 * the installer for networks that cannot reach GitHub — the website's
 * download page carries the same link.
 */
export const NETDISK_URL =
  "https://pan.baidu.com/s/1k-47zy6TTDWl0OaT2WCFUg?pwd=y195";

/** Hosts the app will hand to the OS browser. */
export const EXTERNAL_HOSTS: ReadonlySet<string> = new Set([
  "pan.baidu.com",
  "github.com",
  "platform.minimaxi.com",
  "platform.deepseek.com",
]);

/** True when `url` is an https link to an allowlisted host. Pure. */
export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && EXTERNAL_HOSTS.has(parsed.hostname);
}

/**
 * The web pages a session's record names (ADR 0080 §5): every page 板砖
 * fetched and every search result it was shown. The second door to the OS
 * browser, beside the four hosts above — narrower than "any URL": main opens
 * a URL only when it appears in THIS session's own web rows, so the renderer
 * still cannot hand the shell an arbitrary link. A Flow post the Trailblazer
 * quoted (ADR 0084 §9) names its page in his own message, at its front
 * (`quotedPageUrls`): a link only a sent message, there in the record for
 * everyone to read, can add. Pure.
 */
export function recordedWebUrls(
  record: readonly {
    readonly kind: string;
    readonly text?: string;
    readonly digest?: { readonly kind: string; readonly url?: string };
    readonly evidence?: readonly {
      readonly kind: string;
      readonly url?: string;
      readonly items?: readonly unknown[];
    }[];
  }[],
): Set<string> {
  const urls = new Set<string>();
  for (const b of record) {
    if (b.kind === "user" && typeof b.text === "string")
      for (const url of quotedPageUrls(b.text)) urls.add(url);
    if (b.kind !== "system") continue;
    if (b.digest?.kind === "web-fetch" && typeof b.digest.url === "string")
      urls.add(b.digest.url);
    for (const s of b.evidence ?? []) {
      if (s.kind === "web-page" && typeof s.url === "string") urls.add(s.url);
      if (s.kind === "web-results") {
        for (const item of s.items ?? []) {
          const url = (item as { url?: unknown }).url;
          if (typeof url === "string") urls.add(url);
        }
      }
    }
  }
  return urls;
}

/** True when `url` is an http(s) link the session's record names. Pure. */
export function isRecordedWebUrl(
  url: string,
  record: Parameters<typeof recordedWebUrls>[0],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return recordedWebUrls(record).has(url);
}
