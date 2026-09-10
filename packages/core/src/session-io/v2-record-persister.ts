import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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
function healTrailingPartialLine(sessionFile: string): void {
  let raw: string;
  try {
    raw = readFileSync(sessionFile, "utf8");
  } catch (err) {
    // No file on disk → nothing to heal (a fresh session writes its own header).
    if ((err as { code?: string }).code === "ENOENT") return;
    throw err;
  }
  // Fast path: clean shutdown always leaves a trailing newline.
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
   * The rewrite is atomic — a temp file is written then renamed over the session
   * file — so a crash mid-write never leaves a partially-rewritten transcript.
   */
  truncateToBlockCount(keepBlockCount: number): void {
    let raw: string;
    try {
      raw = readFileSync(this.sessionFile, "utf8");
    } catch (err) {
      // No file on disk yet → nothing persisted to truncate.
      if ((err as { code?: string }).code === "ENOENT") return;
      throw err;
    }
    const lines = raw.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const header = lines[0];
    if (header === undefined) return; // empty/headerless file → nothing to do
    const kept: string[] = [header];
    let blockCount = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.length === 0) continue;
      let parsed: { _kind?: string };
      try {
        parsed = JSON.parse(line) as { _kind?: string };
      } catch {
        // Corrupt/partial trailing line — stop; never keep past a bad line.
        break;
      }
      const isBlock = parsed._kind === undefined;
      // The cut is the first WITHDRAWN BLOCK, so parse before cutting (audit
      // 2026-07-10 §6): with the count check first, a meta line (e.g.
      // `workspace_set`) sitting exactly at the boundary — after the last
      // kept block, before the first withdrawn one — was dropped too, and a
      // resume reverted the workspace. A meta line physically before the
      // first withdrawn block was written before the withdrawn span and
      // belongs to the kept era; meta INSIDE the span still drops with it.
      // (Masked today only because appendWorkspaceSet call sites append a
      // → 系统 note block immediately after the meta line.)
      if (isBlock && blockCount >= keepBlockCount) break;
      kept.push(line);
      if (isBlock) blockCount += 1;
    }
    writeFileAtomicSync(this.sessionFile, `${kept.join("\n")}\n`);
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
    let raw: string;
    try {
      raw = readFileSync(this.sessionFile, "utf8");
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return;
      throw err;
    }
    const lines = raw.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    let blockCount = 0;
    let replaced = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.length === 0) continue;
      let parsed: { _kind?: string; at?: unknown };
      try {
        parsed = JSON.parse(line) as { _kind?: string; at?: unknown };
      } catch {
        break; // corrupt/partial tail — never rewrite past a bad line
      }
      if (parsed._kind !== undefined) continue; // meta line, not a block
      if (blockCount === blockIndex) {
        // Keep the line's original timestamp when the replacement carries
        // none (2026-08-17): the in-memory record never holds `at` (it is
        // stamped here on append), so a replaced block used to lose it and
        // a removed attachment reloaded with no time. The event happened
        // when it happened; withdrawal does not move it.
        const stamped =
          block.at === undefined && typeof parsed.at === "string"
            ? { ...block, at: parsed.at }
            : block;
        lines[i] = JSON.stringify(stamped);
        replaced = true;
        break;
      }
      blockCount += 1;
    }
    if (!replaced) return;
    writeFileAtomicSync(this.sessionFile, `${lines.join("\n")}\n`);
  }
}
