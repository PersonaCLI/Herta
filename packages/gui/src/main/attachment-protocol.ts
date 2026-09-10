import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isPathInside } from "@herta/core";
import { net, protocol } from "electron";
import { ATTACHMENT_SCHEME } from "../shared/attachment-image.js";

/**
 * Serve attachment IMAGES to the renderer (ADR 0048 §4).
 *
 * The renderer is sandboxed away from the filesystem on purpose, so it cannot
 * read a stored picture to draw it. The alternative — shipping every image to
 * the renderer as a base64 data URI — would put a megabyte of text in the
 * record stream per picture and again on every reload. A custom scheme keeps
 * the bytes on disk and lets Chromium stream and cache them.
 *
 * Deliberately NARROWER than the voice scheme it is modelled on:
 *
 * - only paths under `.herta/attachments/` resolve, so this cannot become a
 *   read-any-file primitive for a compromised renderer;
 * - only the image types the ingest actually stores are served, by EXTENSION
 *   and only after `sniffImage` accepted the bytes at attach time;
 * - the root is read fresh per request from the caller's holder, because the
 *   backend workspace can change while the app is running.
 *
 * Every refusal is a uniform 404: a renderer probing for files learns nothing
 * from the difference between "outside the root", "wrong type" and "missing".
 */

/** Hard cap on a served image. The ingest's own store ceiling is 64 MB; this
 *  is the runaway backstop for a file that got there another way. */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

/** The prefix a request must resolve inside. Attachments live under the
 *  session directories below it (ADR 0033). */
const ATTACHMENT_PREFIX = ".herta/attachments/";

function imageContentType(filePath: string): string | null {
  if (/\.png$/i.test(filePath)) return "image/png";
  if (/\.jpe?g$/i.test(filePath)) return "image/jpeg";
  if (/\.gif$/i.test(filePath)) return "image/gif";
  if (/\.webp$/i.test(filePath)) return "image/webp";
  if (/\.bmp$/i.test(filePath)) return "image/bmp";
  return null;
}

/**
 * Map a `herta-attachment://file/<relPath>` URL to an on-disk path under
 * `workspaceRoot`, or null when it is malformed, escapes the root, or points
 * outside the attachment directory.
 *
 * Pure (node:path only) so it unit-tests without electron — the guard is the
 * security-relevant half of this file and deserves tests that run everywhere.
 */
export function resolveAttachmentPath(
  requestUrl: string,
  workspaceRoot: string,
): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(new URL(requestUrl).pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (rel.length === 0) return null;
  // Check the CLAIM before resolving: a path that does not even say it is an
  // attachment is refused without touching the filesystem.
  if (!rel.replace(/\\/g, "/").startsWith(ATTACHMENT_PREFIX)) return null;

  const root = resolve(workspaceRoot);
  const target = resolve(root, rel);
  if (!isPathInside(root, target)) return null;
  // …and check it again on the RESOLVED path, so a traversal that lands back
  // inside the root but outside the attachment tree (`.herta/attachments/../../x`)
  // is refused too.
  const attachmentRoot = resolve(root, ATTACHMENT_PREFIX);
  if (!isPathInside(attachmentRoot, target, { strict: true })) return null;
  return target;
}

/**
 * Declare the scheme privileged. MUST run BEFORE `app.whenReady` (Electron
 * requires privileged schemes registered at that point).
 */
export function registerAttachmentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ATTACHMENT_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

/**
 * Register the request handler. Call once, AFTER app ready. `workspaceRoot`
 * is a getter, not a value: the backend workspace can change mid-session, and
 * a captured root would serve stale paths (or none) afterwards.
 */
export function registerAttachmentProtocol(workspaceRoot: () => string): void {
  protocol.handle(ATTACHMENT_SCHEME, async (request) => {
    const filePath = resolveAttachmentPath(request.url, workspaceRoot());
    if (filePath === null) return new Response("not found", { status: 404 });
    const contentType = imageContentType(filePath);
    if (contentType === null) return new Response("not found", { status: 404 });
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) {
        return new Response("not found", { status: 404 });
      }
      const fileRes = await net.fetch(pathToFileURL(filePath).toString(), {
        bypassCustomProtocolHandlers: true,
      });
      const headers = new Headers(fileRes.headers);
      headers.set("content-type", contentType);
      return new Response(fileRes.body, { status: fileRes.status, headers });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
