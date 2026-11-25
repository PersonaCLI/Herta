/**
 * The sidebar's session commands and the record's paging: the bounded
 * listing, transcript search, a page or a window of a long record, and
 * opening, creating, deleting, renaming and exporting a session, with the
 * checks each argument gets at the IPC boundary. They were handlers and
 * helpers of the session service (review 2026-11-10, moved 2026-11-25).
 *
 * Which session the window shows is the activation's business
 * (session-activation.ts): open, create and delete go through it, so the
 * last click wins here as it does from the tray.
 */
import { homedir } from "node:os";
import type { Session, SessionHost } from "@herta/app-server";
import {
  jumpRange,
  pageEnd,
  pageStart,
  RECORD_WINDOW_WEIGHT,
} from "@herta/core/record-window";
import { validateWorkspaceRoot } from "@herta/tools";
import { app, type BrowserWindow, dialog, type ipcMain } from "electron";
import { CMD } from "../preload/channels.js";
import type { SessionSnapshot } from "../renderer/ipc/bridge-types.js";
import type { SessionActivation } from "./session-activation.js";
import { createExportSaver } from "./session-export.js";

/** How many sessions the sidebar listing returns (audit BL11). Newest-first,
 *  so this is a recency window, not a truncation the user notices — search
 *  still reaches every transcript on disk. */
const SIDEBAR_LIST_LIMIT = 200;

/** A page of older blocks, for `session:recordSlice`: from what the chat was
 *  sent, stamps included. Exported for testing. */
export function recordPage(
  s: Session,
  before: number,
  count: number,
): { readonly start: number; readonly blocks: Session["record"] } {
  const record = s.shownRecord ?? s.record;
  const end = Math.min(before, record.length);
  const start = pageStart(record, count, end);
  return { start, blocks: record.slice(start, end) };
}

/**
 * A window of the record that is not a page of older blocks, for
 * `session:recordWindow` (owner 2026-11-12): what a jump brings, or a page
 * of later blocks for a chat that shows a window of history. From what the
 * chat was sent, like `recordPage`. `req` crossed an IPC boundary: anything
 * that is not one of the two requests, or names no block of this record, is
 * answered with nothing. Exported for testing.
 */
export function recordWindowFor(
  s: Session,
  req: unknown,
): { readonly start: number; readonly blocks: Session["record"] } {
  const none = { start: 0, blocks: [] };
  if (typeof req !== "object" || req === null) return none;
  const r = req as Record<string, unknown>;
  const record = s.shownRecord ?? s.record;
  if (r.kind === "later") {
    const after = r.after;
    const count = r.count;
    if (
      typeof after !== "number" ||
      typeof count !== "number" ||
      !Number.isInteger(after) ||
      !Number.isInteger(count) ||
      after < 0 ||
      after >= record.length ||
      count <= 0
    ) {
      return none;
    }
    const end = pageEnd(record, Math.min(count, RECORD_WINDOW_WEIGHT), after);
    return { start: after, blocks: record.slice(after, end) };
  }
  if (r.kind === "jump") {
    const { start, end, to } = r;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      typeof to !== "number"
    ) {
      return none;
    }
    const range = jumpRange(record, { start, end }, to);
    if (range === null) return none;
    return { start: range.start, blocks: record.slice(range.start, range.end) };
  }
  return none;
}

/** Session ids are host-minted UUIDs the renderer only echoes back, but they
 *  feed path joins (`<transcriptDir>/<id>.jsonl`, managed workspace dirs) on
 *  the other side of the IPC boundary — a compromised renderer must not turn
 *  them into a traversal (audit 2026-07-13 T1.2). Charset allowlist rather
 *  than a strict UUID shape so any legacy transcript stem keeps opening;
 *  every separator/drive/dot shape is rejected. Exported for testing. */
export function isSafeSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** IPC-boundary validation for CMD.create (audit 2026-07-13 T1.2): the
 *  renderer only ever sends `{}`, but `backendWorkspace` roots the silent
 *  板砖 backend and `workspaceRoot` roots the session — an unchecked
 *  override would bypass the D4 guard CMD.setWorkspace enforces via
 *  validateWorkspaceRoot. Returns the validated (resolved) opts, or null
 *  when a supplied override fails validation. Exported for testing. */
export function sanitizeCreateOpts(
  opts: unknown,
  home: string,
): { workspaceRoot?: string; backendWorkspace?: string } | null {
  if (opts === undefined || opts === null) return {};
  if (typeof opts !== "object") return null;
  const { workspaceRoot, backendWorkspace } = opts as {
    workspaceRoot?: unknown;
    backendWorkspace?: unknown;
  };
  const out: { workspaceRoot?: string; backendWorkspace?: string } = {};
  if (workspaceRoot !== undefined) {
    if (typeof workspaceRoot !== "string") return null;
    const r = validateWorkspaceRoot(workspaceRoot, { home });
    if (!r.ok) return null;
    out.workspaceRoot = r.resolved;
  }
  if (backendWorkspace !== undefined) {
    if (typeof backendWorkspace !== "string") return null;
    const r = validateWorkspaceRoot(backendWorkspace, { home });
    if (!r.ok) return null;
    out.backendWorkspace = r.resolved;
  }
  return out;
}

export interface SessionListIpcDeps {
  /** The session service's registrar: it records the channel for dispose. */
  readonly handle: typeof ipcMain.handle;
  /** The host, null before bootstrap: a handler then answers as it does
   *  for no session. */
  readonly host: () => SessionHost | null;
  /** Which session the window shows, and the calls that change it. */
  readonly activation: Pick<
    SessionActivation,
    "openAndPoint" | "createAndPoint" | "deleteAndReconcile"
  >;
  /** What the window is told of a session it now shows. */
  readonly snapshot: (s: Session) => SessionSnapshot;
  /** A session was deleted: what the window holds for it goes too. */
  readonly onDeleted: (sessionId: string) => void;
  /** The window the export's save dialog belongs to. */
  readonly win: BrowserWindow;
}

export function registerSessionListHandlers(deps: SessionListIpcDeps): void {
  const { handle, host, activation, snapshot, onDeleted, win } = deps;
  const { openAndPoint, createAndPoint } = activation;
  // Bounded at the IPC boundary (audit BL11). Unbounded, every sidebar
  // refresh ran a full synchronous listing — statSync, a 128KB read and a
  // sidecar open PER session — on the Electron main thread, and then handed
  // the renderer one DOM row per session ever created, with no windowing.
  // One number bounds both the main-thread scan and the row count; the
  // dream trigger's own internal listSessions() calls are untouched, since
  // they genuinely need every session.
  handle(
    CMD.list,
    () => host()?.listSessions({ limit: SIDEBAR_LIST_LIMIT }) ?? [],
  );
  // Transcript content search (sidebar). Bounded + best-effort in the
  // host; the renderer debounces keystrokes. Async since 2026-09-03: the
  // scan reads off the event loop chunk by chunk (a 50 MB transcript set
  // used to hold this thread ~0.5 s per keystroke), and a query that
  // extends the previous one reads only its hits.
  handle(CMD.search, (_e, query: string) =>
    typeof query === "string" ? (host()?.searchSessions(query) ?? []) : [],
  );
  // Long-session windowing: page OLDER record blocks into the renderer's
  // window. `before` is the absolute index the renderer's window currently
  // starts at; `count` is a weight (`@herta/core/record-window`), and the
  // slice returns that much ending there, back to a message that opens a
  // turn, with the absolute index it starts at.
  // Session-bound like every stateful command; a mismatch (switch racing
  // the invoke) returns an empty slice the store drops by its own staleness
  // guard anyway.
  handle(
    CMD.recordSlice,
    (_e, sessionId: string, before: number, count: number) => {
      const active = host()?.activeSession ?? null;
      if (
        active === null ||
        active.sessionId !== sessionId ||
        !Number.isInteger(before) ||
        !Number.isInteger(count) ||
        before <= 0 ||
        count <= 0
      ) {
        return { start: 0, blocks: [] };
      }
      return recordPage(active, before, count);
    },
  );
  // A jump's window or a page of later blocks (owner 2026-11-12): see
  // `recordWindowFor`. Session-bound the same way.
  handle(CMD.recordWindow, (_e, sessionId: string, req: unknown) => {
    const active = host()?.activeSession ?? null;
    if (active === null || active.sessionId !== sessionId) {
      return { start: 0, blocks: [] };
    }
    return recordWindowFor(active, req);
  });
  handle(CMD.open, async (_e, id: string) => {
    // Id shape gate BEFORE the transcript-path join in the host (audit
    // 2026-07-13 T1.2): a traversal id must never reach readSessionFile.
    if (!isSafeSessionId(id)) return null;
    const s = await openAndPoint(id);
    if (s === null) return null;
    if ("openError" in s) return s;
    return snapshot(s);
  });
  handle(CMD.create, async (_e, opts) => {
    const checked = sanitizeCreateOpts(opts, homedir());
    if (checked === null) return null;
    const s = await createAndPoint(checked);
    return s !== null ? snapshot(s) : null;
  });
  handle(CMD.deleteSession, async (_e, id: string) => {
    // Same id gate as CMD.open — deleteSession feeds rmSync path joins.
    if (!isSafeSessionId(id)) return { ok: false, wasActive: false };
    const result = await activation.deleteAndReconcile(id);
    if (result.ok) onDeleted(id);
    return result;
  });
  // Rename and export (ADR 0072 §3), from the sidebar's session menu —
  // any session, open or not. Same id gate: both join transcript paths.
  handle(CMD.renameSession, async (_e, id: string, title: string) => {
    if (!isSafeSessionId(id) || typeof title !== "string") {
      return { ok: false };
    }
    return (await host()?.renameSession?.(id, title)) ?? { ok: false };
  });
  handle(CMD.readSessionForExport, async (_e, id: string) => {
    if (!isSafeSessionId(id)) return null;
    return (await host()?.readSessionForExport?.(id)) ?? null;
  });
  const saveExport = createExportSaver({
    showSaveDialog: (opts) =>
      dialog.showSaveDialog(win, {
        defaultPath: opts.defaultPath,
        filters: opts.filters.map((f) => ({
          name: f.name,
          extensions: [...f.extensions],
        })),
      }),
    documentsDir: () => app.getPath("documents"),
  });
  handle(CMD.saveSessionExport, (_e, name: unknown, markdown: unknown) =>
    saveExport(name, markdown),
  );
}
