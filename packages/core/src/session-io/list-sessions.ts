import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSessionTitle } from "./session-title-sidecar.js";

export interface SessionListEntry {
  sessionId: string;
  sessionFile: string;
  startedAt: string;
  workspaceRoot: string;
  backendWorkspace?: string;
  preview: string;
  mtime: Date;
  /** Generated session title from the title sidecar, if one exists. */
  title?: string;
  /** The LAST user message in the transcript (where the user left off),
   *  truncated. Undefined when the session has no user message yet. */
  lastUserText?: string;
  /** The interaction language this session was created under (header `lang`).
   *  Undefined for legacy (pre-persistence) headers, which are all Chinese —
   *  the sidebar treats absent as "zh". Lets each card localize its own
   *  preview (e.g. the 板砖→Brick alias) independent of the active session. */
  lang?: "zh" | "en";
}

export interface ListSessionsOpts {
  /** Absolute path of the transcript dir (typically `<workspace>/.herta/transcript/v2`). */
  transcriptDir: string;
  /** Current workspace root for filtering. */
  currentWorkspaceRoot: string;
  /** Default 10. */
  limit?: number;
  /** When true, do not filter by workspaceRoot. Default false. */
  allWorkspaces?: boolean;
}

const PREVIEW_MAX = 60;
const PREVIEW_SCAN_LINES = 5;
const LAST_USER_MAX = 140;

/** Bounded read windows (2026-07-12): the list needs only the file's HEAD
 *  (header + first-user preview) and, for the last user message, its TAIL —
 *  64KB of each rather than the whole file, so a multi-MB transcript no
 *  longer costs its full bytes per sidebar refresh.
 *
 *  The last user message is looked for BACKWARD from EOF in tail-sized
 *  steps, up to LAST_USER_SCAN_BYTES (2026-10-09). One step was the old
 *  "accepted degradation", and the owner met it: a single request followed
 *  by a run that wrote a few files (command text, diffs, two runs) left
 *  more than 64KB after the message, and the sidebar card showed no line at
 *  all. Most sessions still stop in the first step — the message is usually
 *  near the end. Past the budget, the last user message in the head window
 *  stands in: a message, if not the newest, rather than a blank card. */
const HEAD_SCAN_BYTES = 64 * 1024;
const TAIL_SCAN_BYTES = 64 * 1024;
const LAST_USER_SCAN_BYTES = 1024 * 1024;

/** Header-only listing reads just enough to cover the first line (the
 *  `session_meta` header); a header carries only ids + two workspace paths,
 *  so 16KB is far more than any real header line. A pathologically long
 *  header that overruns this window fails its JSON.parse and the file is
 *  skipped — same tolerance as every other malformed-header case. */
const HEADER_SCAN_BYTES = 16 * 1024;

/** Read `length` bytes at `position` as UTF-8. A window edge can split a
 *  multi-byte char; both callers tolerate it (the garbled piece lands in a
 *  partial line that is dropped or fails its JSON.parse). */
function readWindow(fd: number, position: number, length: number): string {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  return buf.toString("utf8", 0, n);
}

/** The text of a user block on `line`, or undefined. */
function userText(line: string): string | undefined {
  if (line === "") return undefined;
  try {
    const block = JSON.parse(line) as { kind?: string; text?: string };
    return block.kind === "user" && typeof block.text === "string"
      ? block.text
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The last user message of a file, read BACKWARD from EOF in tail-sized
 * steps until one is found, the start is reached, or `budget` bytes are
 * read. Steps are joined as BYTES and split at `\n` before decoding — a
 * newline byte never occurs inside a UTF-8 sequence — so a line, or a
 * multi-byte character, cut by a step's edge is carried whole into the
 * next step instead of decoded in two garbled halves.
 */
function lastUserBackward(
  fd: number,
  size: number,
  budget: number,
): string | undefined {
  let end = size;
  let carry = Buffer.alloc(0);
  let read = 0;
  while (end > 0 && read < budget) {
    const start = Math.max(0, end - TAIL_SCAN_BYTES);
    const buf = Buffer.alloc(end - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    read += n;
    let chunk = Buffer.concat([buf.subarray(0, n), carry]);
    if (start > 0) {
      // The first line may begin before this step: carry it back.
      const nl = chunk.indexOf(0x0a);
      if (nl === -1) {
        carry = chunk;
        end = start;
        continue;
      }
      carry = Buffer.from(chunk.subarray(0, nl));
      chunk = chunk.subarray(nl + 1);
    } else {
      carry = Buffer.alloc(0);
    }
    const lines = chunk.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = userText(lines[i] ?? "");
      if (text !== undefined) return text;
    }
    end = start;
  }
  return undefined;
}

interface ValidatedSessionHeader {
  sessionId: string;
  startedAt: string;
  workspaceRoot: string;
  backendWorkspace?: string;
  lang?: "zh" | "en";
}

/** Parse + validate a session file's first line as a v1 `session_meta`
 *  header. Returns null for a blank line, malformed JSON, or a header that
 *  fails the v1 shape check — every caller skips the file on null. Shared by
 *  the full listing and the header-only listing so the two can't drift on
 *  what counts as a valid header. */
function parseSessionHeader(firstLine: string): ValidatedSessionHeader | null {
  if (firstLine.length === 0) return null;
  let header: {
    _kind?: unknown;
    version?: unknown;
    sessionId?: unknown;
    startedAt?: unknown;
    workspaceRoot?: unknown;
    backendWorkspace?: unknown;
    lang?: unknown;
  };
  try {
    header = JSON.parse(firstLine);
  } catch {
    return null; // malformed header — skip
  }
  if (
    header._kind !== "session_meta" ||
    header.version !== 1 ||
    typeof header.sessionId !== "string" ||
    typeof header.startedAt !== "string" ||
    typeof header.workspaceRoot !== "string"
  ) {
    return null;
  }
  // Only "zh"/"en" are valid; a legacy/absent or stray value → undefined
  // (treated as zh downstream).
  const lang =
    header.lang === "zh" || header.lang === "en" ? header.lang : undefined;
  return {
    sessionId: header.sessionId,
    startedAt: header.startedAt,
    workspaceRoot: header.workspaceRoot,
    ...(typeof header.backendWorkspace === "string"
      ? { backendWorkspace: header.backendWorkspace }
      : {}),
    ...(lang !== undefined ? { lang } : {}),
  };
}

/**
 * Enumerate recent v0.2 session files.
 *
 * For each `*.jsonl` in `transcriptDir`, reads the first ~5 lines, parses
 * the header + first user block, builds a `SessionListEntry`. Skips
 * malformed files silently (they may be partial writes from older crashes).
 *
 * Filters by `currentWorkspaceRoot` unless `allWorkspaces: true`. Sorts by
 * mtime descending (newest first). Returns up to `limit` entries.
 *
 * **Performance (2026-07-12):** bounded reads — 64KB of the file's head
 * (header + preview) and, for larger files, 64KB of its tail (last user
 * message) — so a multi-MB transcript costs ~128KB per listing instead of
 * its full size. See HEAD_SCAN_BYTES for the accepted lastUserText
 * degradation. The spec §7 (R4) `.index.json` cache remains the next step
 * if 1000s of sessions ever make even this too hot.
 *
 * **Bounded to the limit (2026-09-03):** files are stat'd and sorted first,
 * and only as many are READ as the limit needs — the sidebar's refresh on
 * every session switch no longer opens every transcript on disk.
 *
 * **Unlimited results:** pass `limit: Number.POSITIVE_INFINITY` to return
 * every matching session. Used by Task 4's `/resume <prefix>` to collect all
 * candidates before client-side prefix-matching.
 *
 * SPEC v0.2 Slice 7b §5.
 */
export function listSessions(opts: ListSessionsOpts): SessionListEntry[] {
  const limit = opts.limit ?? 10;

  let files: string[];
  try {
    files = readdirSync(opts.transcriptDir).filter((f) => f.endsWith(".jsonl"));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  // Stat every file (cheap), sort newest-first, then READ only until the
  // limit is met (2026-09-03). Before this the head/tail windows, the JSON
  // parses and the title-sidecar open ran for every transcript on disk and
  // the limit was applied to the finished array — 400 transcripts cost 400
  // × (open + two reads + sidecar) of blocked main thread on every session
  // switch, for a sidebar that shows the newest 200. A file from another
  // workspace still has to be read to be recognised (the root is in its
  // header), so it costs its head and does not count.
  const stats: { sessionFile: string; mtime: Date; size: number }[] = [];
  for (const filename of files) {
    const sessionFile = join(opts.transcriptDir, filename);
    try {
      const st = statSync(sessionFile);
      stats.push({ sessionFile, mtime: st.mtime, size: st.size });
    } catch {
      // unreadable; skip
    }
  }
  // Stable, so equal mtimes keep directory order — the same order the
  // post-read sort produced before.
  stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const entries: SessionListEntry[] = [];
  for (const { sessionFile, mtime, size } of stats) {
    if (entries.length >= limit) break;
    let headLines: string[];
    let header: ValidatedSessionHeader | null;
    // The last user message found backward from EOF; undefined when the head
    // covers the whole file (small transcript) or none was found in budget.
    let lastFromEnd: string | undefined;
    try {
      const fd = openSync(sessionFile, "r");
      try {
        headLines = readWindow(fd, 0, Math.min(size, HEAD_SCAN_BYTES)).split(
          "\n",
        );
        header = parseSessionHeader(headLines[0] ?? "");
        // Only a file this workspace lists reads past its head: a foreign
        // one costs its head alone, as before.
        const listed =
          header !== null &&
          (opts.allWorkspaces === true ||
            header.workspaceRoot === opts.currentWorkspaceRoot);
        if (listed && size > HEAD_SCAN_BYTES) {
          lastFromEnd = lastUserBackward(fd, size, LAST_USER_SCAN_BYTES);
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    const lines = headLines.slice(0, PREVIEW_SCAN_LINES + 1);
    if (header === null) continue;
    if (
      opts.allWorkspaces !== true &&
      header.workspaceRoot !== opts.currentWorkspaceRoot
    ) {
      continue;
    }

    // Find first user block in the scanned lines.
    let preview = "(no user message)";
    for (let i = 1; i < lines.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: i is bounded by lines.length
      const line = lines[i]!;
      if (line === "") continue;
      try {
        const block = JSON.parse(line) as { kind?: string; text?: string };
        if (block.kind === "user" && typeof block.text === "string") {
          preview =
            block.text.length > PREVIEW_MAX
              ? `${block.text.slice(0, PREVIEW_MAX)}...`
              : block.text;
          break;
        }
      } catch {
        // ignore individual line parse errors
      }
    }

    // The LAST user block — the message the user most recently sent (where
    // they left off): found backward from EOF for a large file; otherwise —
    // and as the fallback past that scan's budget — the last one in the
    // head (minus the header; a head cut mid-line leaves a partial last
    // line, which fails its parse).
    let found = lastFromEnd;
    for (let i = headLines.length - 1; found === undefined && i >= 1; i--) {
      found = userText(headLines[i] ?? "");
    }
    const lastUserText =
      found === undefined
        ? undefined
        : found.length > LAST_USER_MAX
          ? `${found.slice(0, LAST_USER_MAX)}…`
          : found;

    const title = readSessionTitle(opts.transcriptDir, header.sessionId);
    entries.push({
      sessionId: header.sessionId,
      sessionFile,
      startedAt: header.startedAt,
      workspaceRoot: header.workspaceRoot,
      ...(header.backendWorkspace !== undefined
        ? { backendWorkspace: header.backendWorkspace }
        : {}),
      preview,
      mtime,
      ...(title !== undefined ? { title } : {}),
      ...(lastUserText !== undefined ? { lastUserText } : {}),
      ...(header.lang !== undefined ? { lang: header.lang } : {}),
    });
  }

  // Already newest-first and bounded: the read loop walked the sorted stats
  // and stopped at the limit.
  return entries;
}

/** A session reduced to just its header fields + mtime — everything the
 *  content-search path needs (session id + newest-first order) and nothing it
 *  discards. */
export interface SessionHeaderEntry {
  sessionId: string;
  workspaceRoot: string;
  startedAt: string;
  mtime: Date;
  lang?: "zh" | "en";
}

/**
 * Header-only sibling of {@link listSessions}: reads only each file's first
 * line (the `session_meta` header) plus its stat, applies the same workspace
 * filter, and sorts newest-first — but skips the preview scan, the 64KB tail
 * window (last-user-message), and the title-sidecar open that the full listing
 * pays for.
 *
 * This is the source for content search: `searchSessionTranscripts` uses only
 * `sessionId` and the newest-first order, then re-opens each transcript itself,
 * so every extra byte the full listing reads is pure per-keystroke waste. Same
 * best-effort tolerance as the full listing — an unreadable or malformed file
 * is skipped, never thrown.
 */
export function listSessionHeaders(
  opts: ListSessionsOpts,
): SessionHeaderEntry[] {
  const limit = opts.limit ?? 10;

  let files: string[];
  try {
    files = readdirSync(opts.transcriptDir).filter((f) => f.endsWith(".jsonl"));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const entries: SessionHeaderEntry[] = [];
  for (const filename of files) {
    const sessionFile = join(opts.transcriptDir, filename);
    let mtime: Date;
    let size: number;
    try {
      const st = statSync(sessionFile);
      mtime = st.mtime;
      size = st.size;
    } catch {
      continue; // unreadable; skip
    }
    let firstLine: string;
    try {
      const fd = openSync(sessionFile, "r");
      try {
        const window = readWindow(fd, 0, Math.min(size, HEADER_SCAN_BYTES));
        firstLine = window.split("\n", 1)[0] ?? "";
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    const header = parseSessionHeader(firstLine);
    if (header === null) continue;
    if (
      opts.allWorkspaces !== true &&
      header.workspaceRoot !== opts.currentWorkspaceRoot
    ) {
      continue;
    }
    entries.push({
      sessionId: header.sessionId,
      workspaceRoot: header.workspaceRoot,
      startedAt: header.startedAt,
      mtime,
      ...(header.lang !== undefined ? { lang: header.lang } : {}),
    });
  }

  entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return entries.slice(0, limit);
}
