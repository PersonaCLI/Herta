/**
 * What the composer attaches to the session the window shows (ADR 0033,
 * ADR 0048 §4): the file picker, documents read into the record with
 * their progress, pictures staged for the next message, and taking either
 * back. They were handlers inside the session service's closure (review
 * 2026-11-10, moved 2026-11-25).
 *
 * Each is bound to the session the window shows: a call that names another
 * session (a switch racing the invoke) is refused, and each refusal the
 * session gives gets its own words.
 */
import type { SessionHost } from "@herta/app-server";
import { type BrowserWindow, dialog, type ipcMain } from "electron";
import { CMD, EVT } from "../preload/channels.js";
import { createAttachProgressRelay } from "./attach-progress-relay.js";

export interface AttachmentIpcDeps {
  /** The session service's registrar: it records the channel for dispose. */
  readonly handle: typeof ipcMain.handle;
  /** The host, null before bootstrap. */
  readonly host: () => SessionHost | null;
  /** To the window, for a document's read progress. */
  readonly send: (channel: string, payload: unknown) => void;
  /** The window the file picker belongs to. */
  readonly win: BrowserWindow;
}

export function registerAttachmentHandlers(deps: AttachmentIpcDeps): void {
  const { handle, host, send, win } = deps;
  handle(CMD.pickAttachments, async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ["openFile", "multiSelections"],
    });
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths;
  });
  handle(
    CMD.attachFiles,
    async (_e, sessionId: string, paths: readonly string[]) => {
      const s = host()?.activeSession ?? null;
      if (s === null || s.sessionId !== sessionId) {
        return { ok: false as const, message: "no matching active session" };
      }
      if (s.attachFiles === undefined) {
        return { ok: false as const, message: "attachments unavailable" };
      }
      // The pending row's hairline (2026-10-01): each file's pages and
      // transcripts as they go, throttled per file, the last always sent.
      const relay = createAttachProgressRelay((p) =>
        send(EVT.attachProgress, { sessionId, ...p }),
      );
      let r: Awaited<ReturnType<typeof s.attachFiles>>;
      try {
        r = await s.attachFiles(paths, relay.push);
      } finally {
        relay.flush();
      }
      if (r.ok) return { ok: true as const };
      // Each refusal gets its own words: "a turn is in progress" is a
      // retry-in-a-moment, "too many files" is a do-something-different.
      return {
        ok: false as const,
        message:
          r.reason === "turn_in_progress"
            ? "a turn is in progress"
            : r.reason === "too_many"
              ? "too many files at once"
              : "no files",
      };
    },
  );
  handle(
    CMD.stageImages,
    async (
      _e,
      sessionId: string,
      inputs: readonly {
        readonly path?: string;
        readonly bytes?: Uint8Array;
        readonly name?: string;
      }[],
    ) => {
      const s = host()?.activeSession ?? null;
      if (s === null || s.sessionId !== sessionId) {
        return { ok: false as const, message: "no matching active session" };
      }
      if (s.stageImages === undefined) {
        return { ok: false as const, message: "attachments unavailable" };
      }
      const r = await s.stageImages(inputs);
      if (r.ok)
        return { ok: true as const, staged: r.staged, rejected: r.rejected };
      return {
        ok: false as const,
        message:
          r.reason === "turn_in_progress"
            ? "a turn is in progress"
            : r.reason === "too_many_images"
              ? "five images per message"
              : "no files",
      };
    },
  );
  handle(CMD.unstageImage, async (_e, sessionId: string, id: string) => {
    const s = host()?.activeSession ?? null;
    if (s === null || s.sessionId !== sessionId) return false;
    return (await s.unstageImage?.(id)) ?? false;
  });
  handle(CMD.removeAttachment, async (_e, sessionId: string, path: string) => {
    const s = host()?.activeSession ?? null;
    if (s === null || s.sessionId !== sessionId) {
      return { ok: false as const, message: "no matching active session" };
    }
    if (s.removeAttachment === undefined) {
      return { ok: false as const, message: "attachments unavailable" };
    }
    const r = await s.removeAttachment(path);
    if (r.ok) return { ok: true as const };
    return {
      ok: false as const,
      message:
        r.reason === "turn_in_progress"
          ? "a turn is in progress"
          : r.reason === "in_use"
            ? "file in use"
            : "attachment not found",
    };
  });
}
