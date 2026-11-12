import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isPathInside } from "@herta/core";
import { protocol } from "electron";

/**
 * The interface, served from a scheme of its own (owner 2026-11-12).
 *
 * The built interface was loaded as a `file:` page. On a `file:` page the
 * content policy's `'self'` is not "the app's own files": it matches every
 * `file:` URL, so `script-src 'self'` allowed any script file on the disk
 * (measured 2026-11-10, ADR 0054). The policy could not say what it meant.
 *
 * From `herta-app://app/` it can. The origin is the app's alone, this
 * handler is the only thing behind it, and it serves one directory: the
 * built interface inside the app bundle. `'self'` is then exactly those
 * files, for scripts, styles, fonts, pictures and the worker alike.
 *
 * Narrow in the way the asset scheme beside it is:
 *
 * - one host, one root directory, fixed for the life of the process;
 * - an extension allow-list: what a built interface holds, nothing else;
 * - the resolved path must sit under the root;
 * - every refusal is the same 404.
 *
 * Bodies are read whole (`readFile` reads inside the app archive): the
 * largest file is the main script, a few megabytes, and nothing here seeks.
 * Nothing is cached: a `file:` load read the disk every launch, and an
 * update must never be answered from an older copy.
 */

export const APP_SCHEME = "herta-app";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
/** The interface's document: the one address the window may be at. */
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;
/** A page with nothing on it, on the interface's origin. The one-time move
 *  of stored settings writes them here (`renderer-origin-move.ts`). */
export const APP_BLANK_URL = `${APP_ORIGIN}/blank`;

/** A runaway backstop, not an access control. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** What a built interface holds. Scripts are module scripts, which a
 *  standard scheme refuses without a script content type; a `file:` page
 *  was never asked for one. */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json"],
  [".map", "application/json"],
  [".wasm", "application/wasm"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".glb", "model/gltf-binary"],
  [".ktx2", "image/ktx2"],
]);

export function appContentType(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return null;
  return CONTENT_TYPES.get(filePath.slice(dot).toLowerCase()) ?? null;
}

/**
 * Map a `herta-app://app/<rel>` URL to a path under `root`, or null when
 * the URL is malformed, names another host, escapes the root, or has an
 * extension outside the allow-list. The bare origin is the document.
 *
 * Pure (node:path only) so the guard unit-tests without electron.
 */
export function resolveAppFilePath(
  requestUrl: string,
  root: string,
): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:`) return null;
  if (url.hostname !== APP_HOST) return null;
  if (url.username !== "" || url.password !== "" || url.port !== "") {
    return null;
  }
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (rel.length === 0) rel = "index.html";
  // Neither has any business in a bundled file's name, and a backslash is
  // a separator on Windows only, so the check below could read it
  // differently per platform.
  if (rel.includes("\0") || rel.includes("\\")) return null;
  if (appContentType(rel) === null) return null;
  const base = resolve(root);
  const target = resolve(base, rel);
  if (!isPathInside(base, target, { strict: true })) return null;
  return target;
}

/** True for the interface's own document, whatever query or fragment
 *  follows: the one address a navigation may go to. */
export function isAppDocumentUrl(url: string): boolean {
  return url.split(/[?#]/, 1)[0] === APP_INDEX_URL;
}

/**
 * The scheme's privileges, declared with every other scheme's in one call
 * (`schemes.ts`). `standard` gives the page a real origin, with storage of
 * its own; `secure` makes it a secure context, as a `file:` page was;
 * `supportFetchAPI` lets the page's own loaders ask for its own files. Not
 * `corsEnabled`: nothing on another origin has a reason to read the
 * interface's files.
 */
export const APP_SCHEME_ENTRY: Electron.CustomScheme = {
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
};

const notFound = (): Response => new Response("not found", { status: 404 });

/**
 * Register the handler. Call once, after app ready. `root` is the built
 * interface's directory. `csp` rides every document this serves: the policy
 * arrives with the page, from the one place that also decides what the page
 * may load.
 */
export function registerAppProtocol(root: string, csp: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405 });
    }
    if (request.url.split(/[?#]/, 1)[0] === APP_BLANK_URL) {
      return new Response("<!doctype html><title></title>", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          // Nothing loads from it; the main process writes to its storage.
          "content-security-policy": "default-src 'none'",
          "cache-control": "no-store",
        },
      });
    }
    const filePath = resolveAppFilePath(request.url, root);
    if (filePath === null) return notFound();
    const contentType = appContentType(filePath);
    if (contentType === null) return notFound();
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return notFound();
      const bytes = await readFile(filePath);
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": contentType,
          "content-length": String(bytes.byteLength),
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
          ...(contentType.startsWith("text/html")
            ? { "content-security-policy": csp }
            : {}),
        },
      });
    } catch {
      return notFound();
    }
  });
}
