import { join, resolve } from "node:path";
import { isPathInside } from "@herta/core";

/** On-disk root for voice assets, under the workspace: `<workspaceRoot>/data/voice`
 *  (renamed from 语音 2026-07-06 — ASCII-safe paths for the installed app;
 *  the CATEGORY dirs inside keep their Chinese names, they are semantic
 *  particle tokens matched against Herta's speech, not path config). */
export function voiceRootFor(workspaceRoot: string): string {
  return join(workspaceRoot, "data", "voice");
}

/**
 * Resolve the voice-asset root for THIS process (user decision 2026-07-06:
 * the clips ship inside the package; canon corpus and the knowledge DB do
 * not). A packaged app serves the bundled copy from its resources dir —
 * the upcoming packager config copies `data/voice` → `<resources>/voice`
 * (electron-builder `extraResources: [{ from: "data/voice", to: "voice" }]`).
 * Dev keeps reading straight from the workspace. Pure (caller injects
 * `app.isPackaged` / `process.resourcesPath`) so it unit-tests without
 * electron.
 */
export function resolveVoiceRoot(opts: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly workspaceRoot: string;
}): string {
  return opts.isPackaged
    ? join(opts.resourcesPath, "voice")
    : voiceRootFor(opts.workspaceRoot);
}

/**
 * Map a `herta-voice://clip/<category>/<file>` request URL to an on-disk file
 * under `voiceRoot`, or `null` when the URL is malformed or escapes the root.
 *
 * The URL's pathname (after the `clip` authority) is the percent-encoded
 * `<category>/<file>` path. We decode it and resolve against `voiceRoot`, then
 * enforce a path-traversal guard: the resolved path MUST stay under the root
 * (blocks `..` escapes and absolute-path injection). Pure (node:path only) so it
 * is unit-testable without electron.
 */
export function resolveVoiceFilePath(
  requestUrl: string,
  voiceRoot: string,
): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(new URL(requestUrl).pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (rel.length === 0) return null;
  const root = resolve(voiceRoot);
  const target = resolve(root, rel);
  if (!isPathInside(root, target)) return null;
  return target;
}
