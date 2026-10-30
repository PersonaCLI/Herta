import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { protocol } from "electron";

/**
 * Serve Flow's pictures to the renderer (ADR 0084 §8): the files the guarded
 * fetch kept under `<userData>/flow/images/<issueId>/`, at
 * `herta-flow://image/<issueId>/<n>.<ext>`.
 *
 * Narrower than the attachment scheme it is modelled on: the URL never names
 * a path, only an issue id and a card's file name, each matched whole by a
 * pattern before anything touches the disk. Every refusal is a uniform 404.
 */

export const FLOW_SCHEME = "herta-flow";
const FLOW_IMAGE_HOST = "image";
/** The guard keeps none larger (`fetchPreviewImage`). */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const ISSUE_ID = /^\d{4}-\d{2}-\d{2}-\d{1,3}$/;
const IMAGE_NAME = /^\d{1,2}\.(jpg|png|webp|gif|avif)$/;
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

/** A card's picture as the renderer loads it. */
export function flowImageUrl(issueId: string, name: string): string {
  return `${FLOW_SCHEME}://${FLOW_IMAGE_HOST}/${issueId}/${name}`;
}

/** The file a `herta-flow:` URL names and its type, or null for anything
 *  but an issue id and a picture's name. Pure, so the guard unit-tests
 *  without electron. */
export function resolveFlowImage(
  requestUrl: string,
  flowDir: string,
): { readonly file: string; readonly type: string } | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${FLOW_SCHEME}:` || url.hostname !== FLOW_IMAGE_HOST)
    return null;
  if (url.search !== "" || url.hash !== "") return null;
  const parts = url.pathname.split("/");
  if (parts.length !== 3 || parts[0] !== "") return null;
  const [, issueId = "", name = ""] = parts;
  if (!ISSUE_ID.test(issueId) || !IMAGE_NAME.test(name)) return null;
  const type = CONTENT_TYPES[name.slice(name.indexOf(".") + 1)];
  if (type === undefined) return null;
  return { file: join(flowDir, "images", issueId, name), type };
}

/** Declare the scheme privileged. MUST run before `app.whenReady`. */
export function registerFlowScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: FLOW_SCHEME,
      privileges: { standard: true, secure: true },
    },
  ]);
}

/** Register the request handler. Call once, after app ready. */
export function registerFlowProtocol(flowDir: string): void {
  protocol.handle(FLOW_SCHEME, async (request) => {
    const found = resolveFlowImage(request.url, flowDir);
    if (found === null) return new Response("not found", { status: 404 });
    try {
      const info = await stat(found.file);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES)
        return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(await readFile(found.file)), {
        headers: { "content-type": found.type },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
