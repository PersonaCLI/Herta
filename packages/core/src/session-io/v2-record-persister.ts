import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  truncateSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomicSync } from "../atomic-write.js";
import type { TerminalRecordBlock } from "../types/terminal-record.js";

export interface ForNewSessionOpts {
  /** Per-session unique id; becomes the filename stem. */
  sessionId: string;
  /** Absolute workspace root, recorded in the header. */
  workspaceRoot: string;
  /** Optional backend cwd, recorded in the header when provided. */
  backendWorkspace?: string;
  /** Interaction language the session was created under. Persisted in the
   *  header so a reopen pins the session to its BIRTH language rather than
   *  adopting the current global preference, and so the dream pass can scope
   *  a workspace's history by language. Absent on legacy / CLI headers →
   *  callers fall back to the current global preference. */
  lang?: "zh" | "en";
  /** Session start time, recorded in the header. */
  startedAt: Date;
  /** Directory holding `<sessionId>.jsonl`. Created if missing. */
  transcriptDir: string;
  /** Clock for per-block `at` stamps. Defaults to the wall clock; tests inject
   *  a fixed value for deterministic JSONL output. */
  now?: () => string;
}

export interface ForResumeOpts {
  /** Absolute path of an existing session file to append to. */
  sessionFile: string;
  /** Clock for per-block `at` stamps. Defaults to the wall clock. */
  now?: () => string;
}

const wallClock = (): string => new Date().toISOString();

/*
 * The two rewrites, by bytes (review 2026-11-10, second pass).
 *
 * A rewind and an attachment removal each decoded the whole file to a
 * string, split it, parsed EVERY line as JSON to tell a block from a meta
 * line, joined it and wrote all of it back, synchronously on the desktop's
 * main thread: about 10 ms a megabyte, 411 ms for a 47 MB session. Neither
 * needs any of that. A rewind drops the file's end, so it finds the byte
 * where the first withdrawn block starts and truncates there; nothing is
 * rewritten. A replacement changes one line, so it writes the bytes before
 * it, the new line and the bytes after it.
 *
 * What a line is can be told without parsing it. The persister writes
 * `_kind` FIRST on every meta line, so a line that opens `{"_kind":` is
 * one; and a line in which the key is never spelled cannot carry it, so it
 * is a block. Only a line that spells `"_kind"` somewhere else — a block
 * whose text says it, as a transcript about this file does — is parsed,
 * and classified exactly as before.
 */
const NEWLINE = 0x0a;
const META_PREFIX = Buffer.from('{"_kind":');
const META_KEY = Buffer.from('"_kind"');

interface LineRange {
  readonly start: number;
  /** Exclusive, and not counting the line break. */
  readonly end: number;
  /** The file's last bytes, with no line break after them: what a failed
   *  append leaves. */
  readonly partial: boolean;
}

/** The non-empty lines after the header, as byte ranges. A file with no
 *  whole header line has none: it is the reader's to report. */
function* linesAfterHeader(buf: Buffer): Generator<LineRange> {
  let start = buf.indexOf(NEWLINE) + 1;
  if (start === 0) return;
  while (start < buf.length) {
    const nl = buf.indexOf(NEWLINE, start);
    const end = nl === -1 ? buf.length : nl;
    if (end > start) yield { start, end, partial: nl === -1 };
    if (nl === -1) return;
    start = nl + 1;
  }
}

/** Whether a line carries a top-level `_kind`; "corrupt" when only parsing
 *  could say and it does not parse. */
function lineKind(buf: Buffer, line: LineRange): "meta" | "block" | "corrupt" {
  const { start, end } = line;
  if (
    !line.partial &&
    end - start >= META_PREFIX.length &&
    buf.compare(
      META_PREFIX,
      0,
      META_PREFIX.length,
      start,
      start + META_PREFIX.length,
    ) === 0
  ) {
    return "meta";
  }
  // A fragment may be cut anywhere, so it is always parsed.
  if (!line.partial && !buf.subarray(start, end).includes(META_KEY)) {
    return "block";
  }
  try {
    const parsed = JSON.parse(buf.toString("utf8", start, end)) as {
      _kind?: unknown;
    };
    return parsed._kind === undefined ? "block" : "meta";
  } catch {
    return "corrupt";
  }
}

/**
 * Repair the one corruption a crash can leave behind: the process died
 * mid-append, so the file ends in a partial JSON fragment with no trailing
 * newline. `readSessionFile` tolerates that fragment only while it is the
 * LAST line — the next append would fuse new bytes onto it, turning a
 * recoverable truncated tail into a mid-file corrupt line that makes the
 * whole session permanently unreadable. Truncate back to the last complete
 * line before any resume-append instead.
 *
 * The rewrite is atomic (temp + rename, same pattern as
 * `truncateToBlockCount`) so a crash during the heal cannot worsen the file.
 * A file with no newline at all (partial header) is left untouched —
 * `readSessionFile` reports bad-header and the caller surfaces it.
 */
/** True for an empty file or one whose last byte is `\n`. Throws ENOENT. */
function endsWithNewlineOrIsEmpty(sessionFile: string): boolean {
  const fd = openSync(sessionFile, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const last = Buffer.allocUnsafe(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

function healTrailingPartialLine(sessionFile: string): void {
  // Fast path: a clean shutdown always leaves a trailing newline — ONE byte
  // answers that. This used to read and decode the whole transcript (tens of
  // megabytes for a long session) on every resume, right after
  // `readSessionFile` had read the same file, to look at its last character
  // (perf audit 2026-09-20). `\n` is 0x0A in UTF-8 and never a continuation
  // byte, so the last byte decides it exactly as `endsWith("\n")` did.
  try {
    if (endsWithNewlineOrIsEmpty(sessionFile)) return;
  } catch (err) {
    // No file on disk → nothing to heal (a fresh session writes its own header).
    if ((err as { code?: string }).code === "ENOENT") return;
    throw err;
  }
  // The rare path: a crash left a fragment. Now the whole file is wanted.
  const raw = readFileSync(sessionFile, "utf8");
  if (raw.length === 0 || raw.endsWith("\n")) return;
  const lastNewline = raw.lastIndexOf("\n");
  if (lastNewline === -1) return; // partial header — leave for readSessionFile
  writeFileAtomicSync(sessionFile, raw.slice(0, lastNewline + 1));
  console.warn(
    `V2RecordPersister: healed truncated trailing line in ${sessionFile} (${raw.length - lastNewline - 1} chars dropped)`,
  );
}

/**
 * Synchronous append-only JSONL persister for one v0.2 session.
 *
 * File layout:
 *   line 1     : `{"_kind":"session_meta","version":1,...}` header
 *   lines 2+   : one TerminalRecordBlock per line, JSON-serialized
 *
 * Two construction modes:
 *   - `forNewSession` writes the header eagerly on construction.
 *   - `forResume` opens an existing file and appends without rewriting line 1.
 *
 * I/O is synchronous on purpose. Per-call latency is microseconds; ordering
 * must match TerminalRecord order without async interleaving. Exceptions
 * (disk full, permission denied) propagate to the caller — the turn fails
 * loud rather than silently dropping history. This matches the v0.1
 * `createJsonlPersister` precedent.
 *
 * SPEC v0.2 Slice 7b §4, §5.
 */
export class V2RecordPersister {
  /**
   * A previous append threw part-way, so the file may end in a partial line
   * (audit 2026-08-05, S10).
   *
   * `healTrailingPartialLine` used to run ONLY at resume, while the hazard it
   * documents — "the next append would fuse new bytes onto it, turning a
   * recoverable truncated tail into a mid-file corrupt line that makes the
   * whole session permanently unreadable" — is reachable inside a single
   * process too. A failing `appendFileSync` (disk full, quota, a transient
   * EBUSY) can write some bytes before throwing, and the persister is NOT
   * discarded on throw: the error propagates up to session.ts, which then
   * appends a `turn_end` line on the SAME persister and swallows its own
   * failure. That second write is what fuses the line.
   *
   * A fused line is fatal even as the file's last line: it ends with a
   * newline, so `trailingEmpty` is true and read-session-file's tolerant
   * last-line branch does not fire — it throws `corrupt-line` and the GUI
   * reports the code with no repair path. The session becomes permanently
   * unopenable.
   *
   * One boolean, checked on the hot path; the heal (a read + rewrite) only
   * runs after a write actually failed. Deliberately not a stat/read on every
   * append.
   */
  private dirty = false;

  private constructor(
    public readonly sessionFile: string,
    private readonly now: () => string,
  ) {}

  /**
   * The single append path. Heals a partial tail left by a previously failed
   * append BEFORE writing, and marks the persister dirty if this write throws
   * so the next one repairs it.
   */
  private append(line: string): void {
    if (this.dirty) {
      // Best-effort: if the heal itself fails there is nothing better to do
      // than attempt the append and let it surface.
      try {
        healTrailingPartialLine(this.sessionFile);
        this.dirty = false;
      } catch {
        /* fall through — the append below reports the real problem */
      }
    }
    try {
      appendFileSync(this.sessionFile, line, "utf8");
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }

  static forNewSession(opts: ForNewSessionOpts): V2RecordPersister {
    mkdirSync(opts.transcriptDir, { recursive: true });
    const sessionFile = join(opts.transcriptDir, `${opts.sessionId}.jsonl`);
    // Defensive: ensure the parent dir of the eventual file exists.
    mkdirSync(dirname(sessionFile), { recursive: true });
    const header = {
      _kind: "session_meta",
      version: 1,
      sessionId: opts.sessionId,
      startedAt: opts.startedAt.toISOString(),
      workspaceRoot: opts.workspaceRoot,
      ...(opts.backendWorkspace !== undefined
        ? { backendWorkspace: opts.backendWorkspace }
        : {}),
      ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
    };
    appendFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf8");
    return new V2RecordPersister(sessionFile, opts.now ?? wallClock);
  }

  static forResume(opts: ForResumeOpts): V2RecordPersister {
    // Restore the append invariant (file ends in exactly one "\n", complete
    // lines only) BEFORE the first append — see healTrailingPartialLine.
    healTrailingPartialLine(opts.sessionFile);
    return new V2RecordPersister(opts.sessionFile, opts.now ?? wallClock);
  }

  /** Append a record block, stamping a wall-clock `at` when the block lacks
   *  one (so the persisted record carries a per-block timestamp the GUI can
   *  render on reload). An already-stamped block is written verbatim. */
  appendBlock(block: TerminalRecordBlock): void {
    const stamped =
      block.at === undefined ? { ...block, at: this.now() } : block;
    this.append(`${JSON.stringify(stamped)}\n`);
  }

  /** Append a structured workspace_set meta line. The effective backend
   *  workspace becomes this path; survives resume (read-session-file picks
   *  the latest). `at` is an ISO timestamp. */
  appendWorkspaceSet(path: string, at: string): void {
    const line = JSON.stringify({ _kind: "workspace_set", path, at });
    this.append(`${line}\n`);
  }

  /**
   * Append a `turn_end` meta line recording HOW a turn ended (audit
   * 2026-07-24, 1.6).
   *
   * Resume-recovery regenerates a reply for a session whose record ends on a
   * user block, reading that shape as "the reply was lost to a mid-stream
   * app-close". But an INTERRUPTED turn (and a provider-failed one) leaves a
   * byte-identical file: the user block is flushed at the loop head and
   * persisted before the abort. Without a durable record of the ending, a
   * turn the user deliberately killed is indistinguishable from a crash — so
   * reopening the session silently re-ran it, spending an API call and, when
   * the text carried `@板砖`, dispatching the coding backend at repo scope.
   *
   * A meta line (not a block) so block indices — which rewind, topic anchors
   * and the sink cursor all count — are untouched.
   */
  appendTurnEnd(
    outcome: "completed" | "interrupted" | "failed",
    at: string,
  ): void {
    const line = JSON.stringify({ _kind: "turn_end", outcome, at });
    this.append(`${line}\n`);
  }

  /**
   * Truncate the persisted record to its first `keepBlockCount` blocks, dropping
   * every block (and any interleaved `workspace_set` metadata) after them. The
   * header (line 1) is always preserved. Used by the rewind feature to withdraw
   * the latest turn's blocks from disk.
   *
   * Block lines are `TerminalRecordBlock` JSON (no `_kind`); meta lines carry a
   * `_kind` (`session_meta` / `workspace_set`). Only block lines are counted, so
   * `keepBlockCount` matches the in-memory `TerminalRecord` length the driver
   * keeps. A `workspace_set` from inside the withdrawn span is dropped with it
   * (on resume, `read-session-file` falls back to the prior workspace).
   *
   * Nothing is rewritten: the file is shortened at the byte where the first
   * withdrawn block's line starts, so it ends, as before, on a whole line.
   */
  truncateToBlockCount(keepBlockCount: number): void {
    let buf: Buffer;
    try {
      buf = readFileSync(this.sessionFile);
    } catch (err) {
      // No file on disk yet → nothing persisted to truncate.
      if ((err as { code?: string }).code === "ENOENT") return;
      throw err;
    }
    let blockCount = 0;
    let cut: number | undefined;
    let unfinished = false;
    for (const line of linesAfterHeader(buf)) {
      const kind = lineKind(buf, line);
      // Corrupt/partial trailing line — stop; never keep past a bad line.
      if (kind === "corrupt") {
        cut = line.start;
        break;
      }
      // The cut is the first WITHDRAWN BLOCK, so classify before cutting
      // (audit 2026-07-10 §6): with the count check first, a meta line (e.g.
      // `workspace_set`) sitting exactly at the boundary — after the last
      // kept block, before the first withdrawn one — was dropped too, and a
      // resume reverted the workspace. A meta line physically before the
      // first withdrawn block was written before the withdrawn span and
      // belongs to the kept era; meta INSIDE the span still drops with it.
      // (Masked today only because appendWorkspaceSet call sites append a
      // → 系统 note block immediately after the meta line.)
      if (kind === "block" && blockCount >= keepBlockCount) {
        cut = line.start;
        break;
      }
      if (kind === "block") blockCount += 1;
      // A whole line that is kept but was never ended: end it, as the
      // rewrite this replaces did, or the next append would join it.
      if (line.partial) unfinished = true;
    }
    if (cut !== undefined) {
      if (cut >= buf.length) return;
      try {
        truncateSync(this.sessionFile, cut);
      } catch {
        // A file system that will not shorten a file in place: write the
        // kept bytes the way this always did.
        writeFileAtomicSync(this.sessionFile, buf.subarray(0, cut));
      }
      return;
    }
    if (unfinished) appendFileSync(this.sessionFile, "\n", "utf8");
  }

  /**
   * Replace the block at `blockIndex` (0-based over BLOCK lines only, matching
   * the in-memory `TerminalRecord` index) with `block`, leaving every other
   * line — header, meta, and all other blocks — byte-identical.
   *
   * The one mutation this append-only file supports, added for attachment
   * removal (ADR 0033, 2026-08-10). Deliberately a REPLACE and not a delete:
   * dropping a line would shift every later block index, and rewind, topic
   * anchors and the sink cursor all count those. Replacing keeps the count
   * exact, so nothing downstream has to know this happened.
   *
   * Atomic (temp + rename, same as `truncateToBlockCount`) so a crash
   * mid-write cannot leave a half-rewritten transcript. A `blockIndex` past
   * the end is a no-op rather than an error: the caller resolved it from a
   * record that a concurrent rewind may since have shortened.
   */
  replaceBlockAt(blockIndex: number, block: TerminalRecordBlock): void {
    let buf: Buffer;
    try {
      buf = readFileSync(this.sessionFile);
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return;
      throw err;
    }
    let blockCount = 0;
    for (const line of linesAfterHeader(buf)) {
      const kind = lineKind(buf, line);
      if (kind === "corrupt") return; // never rewrite past a bad line
      if (kind === "meta") continue;
      if (blockCount !== blockIndex) {
        blockCount += 1;
        continue;
      }
      let parsed: { at?: unknown };
      try {
        parsed = JSON.parse(buf.toString("utf8", line.start, line.end)) as {
          at?: unknown;
        };
      } catch {
        return;
      }
      // Keep the line's original timestamp when the replacement carries
      // none (2026-08-17): the in-memory record never holds `at` (it is
      // stamped here on append), so a replaced block used to lose it and
      // a removed attachment reloaded with no time. The event happened
      // when it happened; withdrawal does not move it.
      const stamped =
        block.at === undefined && typeof parsed.at === "string"
          ? { ...block, at: parsed.at }
          : block;
      // The bytes before the line, the new line, the bytes after it — the
      // line break included, or one supplied where the line had none.
      writeFileAtomicSync(
        this.sessionFile,
        Buffer.concat([
          buf.subarray(0, line.start),
          Buffer.from(JSON.stringify(stamped), "utf8"),
          line.partial ? Buffer.from("\n") : buf.subarray(line.end),
        ]),
      );
      return;
    }
  }
}
