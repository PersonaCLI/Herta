import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isPathInside } from "@herta/core";
import { protocol } from "electron";
import {
  DEVICE_SCENE_HOST,
  DEVICE_SCENE_SCHEME,
} from "../shared/device-scene.js";

/**
 * Serve the 3D device card's bundled assets to the renderer (ADR 0057 §3).
 *
 * three.js loads meshes, KTX2 atlases and the Basis transcoder over `fetch`.
 * The packaged renderer is a `file://` document under a CSP whose
 * `connect-src` was `'none'` (audit BL2) — and the obvious relaxation,
 * `'self'`, matches EVERY file: URL on a file: origin, which would hand an
 * injected script arbitrary local-file reads. So the assets ride a dedicated
 * scheme instead, and `connect-src` opens for that scheme alone.
 *
 * Deliberately narrow, like the attachment scheme it is modelled on:
 *
 * - one host (`device-scene`), one root directory (inside the app bundle),
 *   fixed for the process lifetime;
 * - an EXTENSION allowlist — only the types the scene actually loads;
 * - traversal-safe: the resolved path must sit under the root;
 * - every refusal is a uniform 404.
 *
 * Bodies are read whole (`readFile` is asar-aware) rather than delegated to
 * the file loader: the largest asset is under 1 MB and nothing here seeks.
 */

/** Runaway backstop, not an access control: the largest shipped asset is
 *  ~750 KB. */
const MAX_ASSET_BYTES = 16 * 1024 * 1024;

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".glb", "model/gltf-binary"],
  [".ktx2", "image/ktx2"],
  [".png", "image/png"],
  [".json", "application/json"],
  [".js", "text/javascript"],
  [".wasm", "application/wasm"],
]);

function assetContentType(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return null;
  return CONTENT_TYPES.get(filePath.slice(dot).toLowerCase()) ?? null;
}

/**
 * Map a `herta-asset://device-scene/<rel>` URL to a path under `root`, or
 * null when the URL is malformed, names another host, carries no path,
 * escapes the root, or has an extension outside the allowlist.
 *
 * Pure (node:path only) so the guard unit-tests without electron.
 */
export function resolveDeviceSceneAssetPath(
  requestUrl: string,
  root: string,
): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${DEVICE_SCENE_SCHEME}:`) return null;
  if (url.hostname !== DEVICE_SCENE_HOST) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (rel.length === 0) return null;
  // Refuse a NUL or a backslash before touching the filesystem: neither has
  // any business in an asset name, and a backslash would be a separator on
  // Windows only, so the traversal check below could read it differently
  // per platform.
  if (rel.includes("\0") || rel.includes("\\")) return null;
  if (assetContentType(rel) === null) return null;
  const base = resolve(root);
  const target = resolve(base, rel);
  if (!isPathInside(base, target, { strict: true })) return null;
  return target;
}

/**
 * Pick the on-disk asset root: the built renderer's copy when it exists
 * (packaged, or a dev launch of the built output), else the source public
 * directory (an `electron-vite dev` run serves the renderer from source and
 * never populates out/renderer). Returns null when neither exists — the
 * handler then answers 404 and the card keeps its flat renders.
 */
export function resolveDeviceSceneRoot(
  candidates: readonly string[],
): string | null {
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * Declare the scheme privileged. MUST run BEFORE `app.whenReady` (Electron
 * requires privileged schemes registered at that point). `supportFetchAPI`
 * is what lets three's loaders reach it; `standard` + `secure` keep it a
 * well-behaved app scheme; `corsEnabled` is load-bearing — the renderer is
 * a `file://` document, so every fetch to this scheme is CROSS-origin, and
 * without it Chromium refuses the request before the handler runs
 * ("Cross origin requests are only supported for protocol schemes: …";
 * found live 2026-09-06 in the built app, invisible in dev). The handler
 * answers with `access-control-allow-origin: *` to match: the scheme is
 * read-only bundle content, so any origin may read it.
 */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: DEVICE_SCENE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Register the request handler. Call once, AFTER app ready. `root` is fixed
 * for the process lifetime — the assets ship inside the bundle and never
 * move. A null root registers a handler that refuses everything, so a
 * misbuilt package degrades to the flat card instead of a broken scheme.
 */
export function registerAssetProtocol(root: string | null): void {
  protocol.handle(DEVICE_SCENE_SCHEME, async (request) => {
    if (root === null) return new Response("not found", { status: 404 });
    const filePath = resolveDeviceSceneAssetPath(request.url, root);
    if (filePath === null) return new Response("not found", { status: 404 });
    const contentType = assetContentType(filePath);
    if (contentType === null) return new Response("not found", { status: 404 });
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > MAX_ASSET_BYTES) {
        return new Response("not found", { status: 404 });
      }
      const bytes = await readFile(filePath);
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": contentType,
          "content-length": String(bytes.byteLength),
          // The file:// renderer is a foreign origin to this scheme (see
          // registerAssetScheme).
          "access-control-allow-origin": "*",
          // Immutable bundle content: let Chromium cache it for the session.
          "cache-control": "private, max-age=86400",
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
