/**
 * The viewer's reads of the session's workspace and its doors to the OS
 * (ADR 0050, 0054, 0059, 0072, 0080): a file as text or bytes, the file
 * list behind the composer's `@`, one commit, one working-tree diff, a page
 * of history, the branches, and opening a file, its folder or a recorded web
 * page. They were handlers inside the session service's closure (review
 * 2026-11-10, moved 2026-11-25) and read nothing of it but the host.
 *
 * Every handler is bound to the session the window shows: a call that names
 * another session (a switch racing the invoke) is refused. A path is jailed
 * to that session's EFFECTIVE backend workspace, the tree the record's file
 * names live in, before anything reads it or hands it to the shell.
 */
import type { LogQuery, SessionHost } from "@herta/app-server";
import {
  isGitReadTimeout,
  isSafeRefName,
  MAX_LOG_LIMIT,
  MAX_LOG_QUERY_CHARS,
} from "@herta/tools";
import { type ipcMain, shell } from "electron";
import { CMD } from "../preload/channels.js";
import { isRecordedWebUrl } from "../shared/links.js";
import { runsWhenOpened } from "./open-guard.js";
import {
  readWorkspaceBytesBounded,
  readWorkspaceFileBounded,
  resolveInsideWorkspace,
} from "./read-workspace-file.js";
import { listWorkspaceFiles } from "./workspace-files.js";

/**
 * The history tab's query as the IPC door accepts it (ADR 0059 §6):
 * integer paging, a branch-shaped `ref` (the same rule the reader
 * applies, so a refused shape never reaches a spawn), a bounded `query`.
 * Null for anything else. Exported for tests.
 */
export function sanitizeLogQuery(raw: unknown): LogQuery | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const skip = r.skip;
  const limit = r.limit;
  if (
    typeof skip !== "number" ||
    !Number.isInteger(skip) ||
    skip < 0 ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit <= 0 ||
    limit > MAX_LOG_LIMIT
  ) {
    return null;
  }
  const out: { skip: number; limit: number; ref?: string; query?: string } = {
    skip,
    limit,
  };
  if (r.ref !== undefined) {
    if (typeof r.ref !== "string" || !isSafeRefName(r.ref)) return null;
    out.ref = r.ref;
  }
  if (r.query !== undefined) {
    if (typeof r.query !== "string") return null;
    const q = r.query.trim();
    if (q.length > MAX_LOG_QUERY_CHARS) return null;
    if (q.length > 0) out.query = q;
  }
  return out;
}

export interface WorkspaceReadIpcDeps {
  /** The session service's registrar: it records the channel for dispose. */
  readonly handle: typeof ipcMain.handle;
  /** The host, null before bootstrap: a handler then answers as it does
   *  for no session. */
  readonly host: () => SessionHost | null;
}

export function registerWorkspaceReadHandlers(
  deps: WorkspaceReadIpcDeps,
): void {
  const { handle, host } = deps;
  // The file-viewer panel (ADR 0050): a bounded read jailed to the
  // session's EFFECTIVE backend workspace — the tree the record's file
  // names actually live in. Session-bound like every other command.
  handle(CMD.readWorkspaceFile, async (_e, sessionId: string, path: string) => {
    const s = host()?.activeSession ?? null;
    if (s === null || s.sessionId !== sessionId) {
      return { ok: false as const, reason: "no_session" as const };
    }
    return readWorkspaceFileBounded(s.backendWorkspace, path);
  });
  // The composer's @-mention list (ADR 0072 §2): the files of the same
  // workspace, listed asynchronously and bounded (workspace-files.ts).
  handle(CMD.listWorkspaceFiles, async (_e, sessionId: string) => {
    const s = host()?.activeSession ?? null;
    if (s === null || s.sessionId !== sessionId) return null;
    return listWorkspaceFiles(s.backendWorkspace);
  });
  // The rich kinds' read (ADR 0054 §2): the whole file as bytes for the
  // renderers that parse it themselves — same jail, 64 MB ceiling.
  handle(
    CMD.readWorkspaceBytes,
    async (_e, sessionId: string, path: string) => {
      const s = host()?.activeSession ?? null;
      if (s === null || s.sessionId !== sessionId) {
        return { ok: false as const, reason: "no_session" as const };
      }
      return readWorkspaceBytesBounded(s.backendWorkspace, path);
    },
  );
  // The viewer's commit tab (ADR 0059): one commit of the session's
  // repository, read by the session against its effective workspace.
  // The id is checked here too — a hex commit id and nothing else ever
  // reaches a git argv (the session's reader checks again).
  handle(
    CMD.readWorkspaceCommit,
    async (_e, sessionId: string, ref: string) => {
      const s = host()?.activeSession ?? null;
      if (s === null || s.sessionId !== sessionId) {
        return { ok: false as const, reason: "no_session" as const };
      }
      if (typeof ref !== "string" || !/^[0-9a-f]{4,64}$/.test(ref)) {
        return { ok: false as const, reason: "not_found" as const };
      }
      const commit = (await s.describeCommit?.(ref)) ?? null;
      if (isGitReadTimeout(commit)) {
        return { ok: false as const, reason: "timeout" as const };
      }
      return commit === null
        ? { ok: false as const, reason: "not_found" as const }
        : { ok: true as const, commit };
    },
  );
  // The viewer's diff tab (ADR 0059 §5): one path's working-tree change
  // against HEAD. The SAME jail as the file reads decides the path —
  // the session's reader diffs an untracked file against /dev/null, so
  // an outside-resolving name must never reach it. A tracked file
  // deleted from the tree has no inode and still has a diff: `missing`
  // passes its in-workspace spelling through.
  handle(CMD.readWorkspaceDiff, async (_e, sessionId: string, path: string) => {
    const s = host()?.activeSession ?? null;
    if (s === null || s.sessionId !== sessionId) {
      return { ok: false as const, reason: "no_session" as const };
    }
    const r = await resolveInsideWorkspace(s.backendWorkspace, path);
    if (r.kind === "outside") {
      return { ok: false as const, reason: "outside_workspace" as const };
    }
    const relative = r.kind === "ok" ? r.relative : r.relative;
    if (relative === undefined || relative.length === 0) {
      return { ok: false as const, reason: "not_found" as const };
    }
    const diff = (await s.describeWorkingDiff?.(relative)) ?? null;
    if (isGitReadTimeout(diff)) {
      return { ok: false as const, reason: "timeout" as const };
    }
    return diff === null
      ? { ok: false as const, reason: "not_found" as const }
      : { ok: true as const, diff };
  });
  // The viewer's log tab (ADR 0059 §6): a page of a ref's history,
  // optionally filtered. Every field is checked at the door — paging
  // numbers are integers, the ref has a branch's shape (the reader
  // checks again and hands git `--end-of-options`), the query is a
  // bounded string — and the reader bounds the limit again.
  handle(CMD.readWorkspaceLog, async (_e, sessionId: string, raw: unknown) => {
    const s = host()?.activeSession ?? null;
    if (s === null || s.sessionId !== sessionId) {
      return { ok: false as const, reason: "no_session" as const };
    }
    const opts = sanitizeLogQuery(raw);
    if (opts === null) {
      return { ok: false as const, reason: "not_found" as const };
    }
    const page = (await s.describeLog?.(opts)) ?? null;
    if (isGitReadTimeout(page)) {
      return { ok: false as const, reason: "timeout" as const };
    }
    return page === null
      ? { ok: false as const, reason: "not_found" as const }
      : { ok: true as const, page };
  });
  // The history tab's read-only branch picker (ADR 0059 §6).
  handle(CMD.readWorkspaceBranches, async (_e, sessionId: string) => {
    const s = host()?.activeSession ?? null;
    if (s === null || s.sessionId !== sessionId) {
      return { ok: false as const, reason: "no_session" as const };
    }
    const branches = (await s.describeBranches?.()) ?? null;
    if (isGitReadTimeout(branches)) {
      return { ok: false as const, reason: "timeout" as const };
    }
    return branches === null
      ? { ok: false as const, reason: "not_found" as const }
      : { ok: true as const, branches };
  });
  // A web page the session's record names (ADR 0080 §5): opened in the OS
  // browser only when it appears in THIS session's web rows — the
  // renderer is not trusted with an "open any URL" door.
  handle(CMD.openWebPage, async (_e, sessionId: string, url: unknown) => {
    const s = host()?.activeSession ?? null;
    if (s === null || s.sessionId !== sessionId) return false;
    if (typeof url !== "string" || !isRecordedWebUrl(url, s.record))
      return false;
    await shell.openExternal(url);
    return true;
  });
  // A file chip's 在资源管理器中显示 (ADR 0072 amendment 2026-10-20): the
  // same jail as the viewer's 打开 — an outside-resolving name never
  // reaches the shell.
  handle(
    CMD.revealWorkspaceFile,
    async (_e, sessionId: string, path: string) => {
      const s = host()?.activeSession ?? null;
      if (s === null || s.sessionId !== sessionId) return false;
      const r = await resolveInsideWorkspace(s.backendWorkspace, path);
      if (r.kind !== "ok") return false;
      shell.showItemInFolder(r.abs);
      return true;
    },
  );
  // The viewer's 打开: hand the jailed path to the OS default app. The
  // same resolution as the read — an outside-resolving name never
  // reaches shell.openPath. Nor does a file the OS would RUN when opened
  // (a program, a script, a shortcut): that one is shown in its folder
  // instead, so a file 板砖 wrote is never one click from running with
  // nothing asked (`open-guard.ts`, review 2026-11-10).
  handle(CMD.openWorkspaceFile, async (_e, sessionId: string, path: string) => {
    const s = host()?.activeSession ?? null;
    if (s === null || s.sessionId !== sessionId) return false;
    const r = await resolveInsideWorkspace(s.backendWorkspace, path);
    if (r.kind !== "ok") return false;
    if (await runsWhenOpened(r.abs)) {
      shell.showItemInFolder(r.abs);
      return true;
    }
    return (await shell.openPath(r.abs)) === "";
  });
}
