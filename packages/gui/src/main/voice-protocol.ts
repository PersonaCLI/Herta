import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { VOICE_SCHEME } from "../shared/voice.js";
import { resolveVoiceFilePath } from "./voice-path.js";

/**
 * Hard cap on a served clip (16 MB ≈ half an hour of 64 kbps Opus — far
 * beyond any real cue). The voice root is user-owned content, so this is a
 * runaway/DoS backstop, not an access control: a stray huge file is refused
 * (404, uniform with missing) instead of being read whole into the main
 * process's memory.
 */
const MAX_CLIP_BYTES = 16 * 1024 * 1024;

/** Content type by clip extension. Shipped clips are Ogg/Opus (`.opus`,
 *  2026-07-16 cutover); `.wav` stays mapped so a user-supplied master under a
 *  custom voice root still plays. Anything else is refused by the caller. */
function clipContentType(filePath: string): string | null {
  if (/\.opus$/i.test(filePath)) return "audio/ogg";
  if (/\.wav$/i.test(filePath)) return "audio/wav";
  return null;
}

/**
 * The `herta-voice` scheme's privileges, declared with every other scheme's
 * in one call (`schemes.ts`). `stream` + `supportFetchAPI` let `<audio>` load
 * and seek; `secure`/`standard` keep it a well-behaved app scheme.
 */
export const VOICE_SCHEME_ENTRY: Electron.CustomScheme = {
  scheme: VOICE_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    stream: true,
    supportFetchAPI: true,
  },
};

/**
 * Register the `herta-voice` request handler. Call once, AFTER app ready.
 * Serves audio clips from `voiceRoot` (the caller resolves it packaged-aware
 * via `resolveVoiceRoot` — bundled resources when packaged, the workspace's
 * `data/voice` in dev), guarded against path traversal by
 * `resolveVoiceFilePath` and restricted to known clip extensions (see
 * clipContentType), refusing anything over `MAX_CLIP_BYTES` (via stat).
 *
 * The validated path is then served by DELEGATING to Chromium's own file
 * loader (`net.fetch(file://…)`, headers forwarded) rather than returning a
 * buffered `Response`: the media pipeline needs a SEEKABLE source — for
 * Ogg/Opus it reads the file's TAIL to learn the duration — and a buffered
 * body leaves `<audio>` with `duration: Infinity` and a stalled pipeline
 * (found live, 2026-07-16 opus cutover; hand-rolled 206 Range slices did not
 * heal it either — WAV never exposed this because its duration is in the
 * header). Only the content-type is overridden (file:// guesses none for
 * `.opus`). Missing / oversized / not-a-file / unknown extension → 404,
 * malformed URL → 400 (best-effort: voice is non-essential, so a bad clip
 * never crashes the app).
 */
export function registerVoiceProtocol(voiceRoot: string): void {
  protocol.handle(VOICE_SCHEME, async (request) => {
    const filePath = resolveVoiceFilePath(request.url, voiceRoot);
    if (filePath === null) return new Response("bad request", { status: 400 });
    const contentType = clipContentType(filePath);
    if (contentType === null) return new Response("not found", { status: 404 });
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > MAX_CLIP_BYTES) {
        return new Response("not found", { status: 404 });
      }
      const fileRes = await net.fetch(pathToFileURL(filePath).toString(), {
        headers: request.headers, // forward Range etc. to the file loader
        bypassCustomProtocolHandlers: true,
      });
      const headers = new Headers(fileRes.headers);
      headers.set("content-type", contentType);
      return new Response(fileRes.body, {
        status: fileRes.status,
        headers,
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}
