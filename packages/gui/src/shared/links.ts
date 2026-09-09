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
