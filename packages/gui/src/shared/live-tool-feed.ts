import type { AgentEvent, SessionAgentEvent } from "@herta/app-server";
import { opVerbOf } from "./op-verb.js";
import { type JsonStringField, scanJsonStrings } from "./partial-json.js";

/**
 * One call's live view (ADR 0073): the step 板砖 is on — and, for a call
 * that streams, what it is producing: the file as the model writes it, the
 * command's output as it prints. The rail's trace card follows the newest
 * one: it stands in for the step until the record's own op row lands (the
 * record trails the backend while Herta speaks), and its ticker flows the
 * newest line.
 *
 * Display only. Nothing here enters the record, Herta's prompt or the
 * transcript: the record takes the finished call and the bounded result as
 * it always has (D7), and a view is gone when its run ends.
 */
export interface LiveToolView {
  /** The call's id — the one its `tool.call.started` carries. */
  readonly id: string;
  readonly tool: string;
  /** "writing": the model is still writing the call, and what shows is what
   *  it has written; "running": the call runs, and what shows is its
   *  output. An editor call stays "writing" — its content IS the call. */
  readonly stage: "writing" | "running";
  /** The call was dispatched: its op row is on its way to the record. */
  readonly started: boolean;
  /** The call finished (`ok` says how). */
  readonly done: boolean;
  readonly ok?: boolean;
  /** The call's summary as the record's op row carries it (its
   *  `tool.call.started` input summary) — once dispatched. */
  readonly summary?: string;
  /** The tool recognised a test run at dispatch, as the record's op row
   *  says (`runsTests`, ADR 0073 amendment 2026-10-08). */
  readonly runsTests?: true;
  /** The call produces a stream worth a ticker: an editor writing (not
   *  viewing), a shell line, a command's output. A read does not. */
  readonly streams: boolean;
  /** The file the call writes, once its arguments name it WHOLE — a path
   *  still streaming in is not shown half-spelled. */
  readonly path?: string;
  /** A command's line: the shell's `command` (first line, once written
   *  whole) while it is written, the record's own summary once it runs. */
  readonly commandLine?: string;
  /** "diff": every tail line starts with "+" or "-" (an edit's removed and
   *  added text); "text": the lines as they are. */
  readonly mode: "text" | "diff";
  /** The last lines, bounded (TAIL_LINES, TAIL_CHARS) — the focused view's
   *  only; the others carry none. */
  readonly tail: string;
  /** Lines in the whole text, not just the tail. */
  readonly lines: number;
  /** For a dispatched call that makes an op row (`opVerbOf`): its place
   *  among the run's op-making calls, 0-based — the index its row will have
   *  among the dispatch's op rows in the record. */
  readonly ordinal?: number;
}

/** What crosses to the renderer. */
export interface LiveToolSnapshot {
  /** The run's recent calls in the order they appeared (drafts last). */
  readonly views: readonly LiveToolView[];
  /** How many op-making calls the run has dispatched: a record with more
   *  op rows than this is AHEAD of the feed, not behind it. */
  readonly startedOps: number;
  /** The call most recently heard from — the one the ticker follows. */
  readonly focus?: string;
}

export const EMPTY_LIVE: LiveToolSnapshot = { views: [], startedOps: 0 };

/** Calls whose ARGUMENTS are worth watching as they stream: what an editor
 *  writes, and a shell line (a heredoc is a file being written). */
const DRAFT_TOOLS: ReadonlySet<string> = new Set([
  "str_replace_editor",
  "write_new_file",
  "edit_file",
  "bash",
]);
/** Calls whose OUTPUT streams while they run. */
const OUTPUT_TOOLS: ReadonlySet<string> = new Set(["bash", "run_command"]);

export const LIVE_FEED_INTERVAL_MS = 100;
export const TAIL_LINES = 40;
export const TAIL_CHARS = 6_000;
const LINE_CHARS = 400;
/** A command's output is kept to this much (its newest part) — enough for
 *  any tail; the rest is counted, not held. */
const OUTPUT_KEEP_CHARS = 32_768;
/** Calls kept per run: enough for the record to lag this many steps behind
 *  (it waits on Herta's beats) and still be caught up by the card. */
const KEEP_CALLS = 32;

interface CallState {
  readonly id: string;
  /** When the call first appeared in the run (draft or start). */
  readonly order: number;
  tool: string;
  ordinal: number | undefined;
  args: string;
  output: string;
  outputDroppedLines: number;
  stage: "writing" | "running";
  started: boolean;
  done: boolean;
  ok: boolean | undefined;
  commandLine: string | undefined;
  summary: string | undefined;
  runsTests: boolean;
  seq: number;
  /** The arguments' string values, as of `fieldsLen` characters. */
  fields: JsonStringField[];
  fieldsLen: number;
}

export interface LiveToolFeedOpts {
  readonly intervalMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** The feed starts while a run is already under way: it has not seen the
   *  run's earlier calls, so it numbers none until the next run starts. */
  readonly midRun?: boolean;
}

export interface LiveToolFeed {
  /** Every event of the session's raw agent stream. */
  push(e: SessionAgentEvent): void;
  /** Stop: no more emits, the pending one dropped. */
  close(): void;
}

/**
 * Folds the backend's live events — `tool.call.delta` (arguments as they
 * stream), `tool.call.output` (a command's output) — with the call
 * lifecycle into views, and emits them at most every `intervalMs`. The agent
 * wire does not carry those events (ADR 0068: signals, not payloads); this
 * sends what the card shows instead — the run's recent calls, one bounded
 * tail (the focused call's), ten times a second at most, never the raw
 * stream.
 *
 * The calls are kept, numbered, for the length of the run — not dropped as
 * the next one starts — because the record trails the backend by the
 * length of Herta's beats, and the card appends every call the record does
 * not have yet (lab 2026-09-30: dropping them made the timeline step back).
 */
export function createLiveToolFeed(
  emit: (snapshot: LiveToolSnapshot) => void,
  opts: LiveToolFeedOpts = {},
): LiveToolFeed {
  const intervalMs = opts.intervalMs ?? LIVE_FEED_INTERVAL_MS;
  const setTimer =
    opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ??
    ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const calls = new Map<string, CallState>();
  let seq = 0;
  let order = 0;
  let startedOps = 0;
  // Whether the ordinals can be trusted: a feed started while a run was
  // already under way (a re-point after a reload), or one that lost events,
  // has not seen every call the record numbers, so it numbers none until
  // the next run starts — the card then adds nothing rather than the wrong
  // step (review 2026-09-30).
  let numbering = opts.midRun !== true;
  let timer: unknown = null;
  let closed = false;
  /** Something was on screen: an empty snapshot must go out once. */
  let shown = false;

  const flush = (): void => {
    timer = null;
    if (closed) return;
    const ordered = [...calls.values()].sort((a, b) => a.order - b.order);
    let focus: CallState | undefined;
    for (const c of ordered)
      if (focus === undefined || c.seq > focus.seq) focus = c;
    const views = ordered.map((c) => viewOf(c, c === focus));
    if (views.length === 0 && !shown) return;
    shown = views.length > 0;
    emit({
      views,
      startedOps,
      ...(focus !== undefined ? { focus: focus.id } : {}),
    });
  };
  const dirty = (): void => {
    if (closed || timer !== null) return;
    timer = setTimer(flush, intervalMs);
  };
  const touch = (c: CallState): void => {
    seq += 1;
    c.seq = seq;
    dirty();
  };
  const clearAll = (): void => {
    startedOps = 0;
    if (calls.size === 0) return;
    calls.clear();
    dirty();
  };
  const create = (id: string, tool: string): CallState => {
    order += 1;
    const c = newCall(id, tool, order);
    calls.set(id, c);
    // Bounded: the oldest call of a long run has long reached the record.
    if (calls.size > KEEP_CALLS) {
      let oldest: CallState | undefined;
      for (const x of calls.values()) {
        if (oldest === undefined || x.order < oldest.order) oldest = x;
      }
      if (oldest !== undefined) calls.delete(oldest.id);
    }
    return c;
  };

  const push = (e: SessionAgentEvent): void => {
    if (closed) return;
    if (e.kind !== "agent") {
      // Events were lost: whatever the views say may be stale, and the count
      // has missed calls.
      clearAll();
      numbering = false;
      return;
    }
    const ev: AgentEvent = e.event;
    if (ev.layer !== "backend") return;
    switch (ev.type) {
      case "turn.started":
        clearAll();
        numbering = true;
        return;
      case "turn.finished":
      case "turn.failed":
        clearAll();
        return;
      case "tool.call.delta": {
        if (!DRAFT_TOOLS.has(ev.tool)) return;
        const c = calls.get(ev.id) ?? create(ev.id, ev.tool);
        c.args += ev.argsDelta;
        touch(c);
        return;
      }
      case "assistant.final": {
        // A draft the finished message does not carry (a retried or broken
        // inference) will never run.
        const ids = new Set(ev.message.toolCalls.map((t) => t.id));
        for (const c of [...calls.values()]) {
          if (!c.started && !ids.has(c.id)) {
            calls.delete(c.id);
            dirty();
          }
        }
        return;
      }
      case "tool.call.started": {
        // Every dispatched call gets a view, streaming or not: the record
        // trails the backend while Herta speaks, and the card follows the
        // step 板砖 is actually on — a read included.
        const c = calls.get(ev.id) ?? create(ev.id, ev.tool);
        if (!c.started) {
          const viewing =
            ev.tool === "str_replace_editor" &&
            /^view(\s|$)/.test(ev.inputSummary);
          // Numbered as the record will number its op row.
          if (numbering && opVerbOf(ev.tool, viewing) !== null) {
            c.ordinal = startedOps;
            startedOps += 1;
          }
        }
        c.started = true;
        c.summary = ev.inputSummary;
        c.runsTests = ev.runsTests === true;
        if (OUTPUT_TOOLS.has(ev.tool)) {
          c.stage = "running";
          if (ev.inputSummary.length > 0) c.commandLine = ev.inputSummary;
        }
        touch(c);
        return;
      }
      case "tool.call.output": {
        const c = calls.get(ev.id);
        if (c === undefined) return;
        c.stage = "running";
        c.output += ev.chunk;
        if (c.output.length > OUTPUT_KEEP_CHARS * 2) {
          const cut = c.output.length - OUTPUT_KEEP_CHARS;
          c.outputDroppedLines += countNewlines(c.output.slice(0, cut));
          c.output = c.output.slice(cut);
        }
        touch(c);
        return;
      }
      case "tool.call.finished": {
        const c = calls.get(ev.id);
        if (c === undefined) return;
        // A call the user did not allow never ran and has no row in the
        // record (D7: permission is user-only); the card must not draw it
        // as a failed step (review 2026-09-30).
        const code = ev.result.ok ? undefined : ev.result.error?.code;
        if (code === "permission_denied" || code === "permission_failed") {
          calls.delete(c.id);
          dirty();
          return;
        }
        c.done = true;
        c.ok = ev.result.ok;
        touch(c);
        return;
      }
      default:
        return;
    }
  };

  return {
    push,
    close() {
      closed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      calls.clear();
    },
  };
}

function newCall(id: string, tool: string, order: number): CallState {
  return {
    id,
    order,
    tool,
    ordinal: undefined,
    args: "",
    output: "",
    outputDroppedLines: 0,
    stage: "writing",
    started: false,
    done: false,
    ok: undefined,
    commandLine: undefined,
    summary: undefined,
    runsTests: false,
    seq: 0,
    fields: [],
    fieldsLen: 0,
  };
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n += 1;
  return n;
}

/** What a call shows. A call with no stream (a read, an editor `view`)
 *  shows only that it is a step; only the FOCUSED call carries its stream —
 *  the ticker follows one call, and a run keeps up to KEEP_CALLS. */
function viewOf(c: CallState, focused: boolean): LiveToolView {
  // Parsed once per growth of the arguments: a flush looks at every call
  // the run keeps, and a finished call's arguments no longer change.
  if (c.fieldsLen !== c.args.length) {
    c.fields = scanJsonStrings(c.args);
    c.fieldsLen = c.args.length;
  }
  const fields = c.fields;
  const first = (key: string): string | undefined =>
    fields.find((f) => f.key === key)?.value;
  const path = fields.find((f) => f.key === "path" && f.complete)?.value;
  const viewing =
    c.tool === "str_replace_editor" &&
    (first("command") === "view" || /^view(\s|$)/.test(c.summary ?? ""));
  const streams =
    (DRAFT_TOOLS.has(c.tool) || OUTPUT_TOOLS.has(c.tool)) && !viewing;
  // A command's line once the model has written it WHOLE — as a path: half
  // a line names the wrong command (`cd /c/…/e2b3` is not what runs; lab
  // 2026-09-30). A heredoc's first line completes long before its body.
  const command = fields.find((f) => f.key === "command");
  const commandLine =
    c.commandLine ??
    (c.tool === "bash" &&
    command !== undefined &&
    (command.complete || command.value.includes("\n"))
      ? firstLine(command.value)
      : undefined);
  const base = {
    id: c.id,
    tool: c.tool,
    stage: c.stage,
    started: c.started,
    done: c.done,
    ...(c.ok !== undefined ? { ok: c.ok } : {}),
    ...(c.summary !== undefined ? { summary: c.summary } : {}),
    ...(c.runsTests ? { runsTests: true as const } : {}),
    streams,
    ...(path !== undefined && path.length > 0 ? { path } : {}),
    ...(commandLine !== undefined ? { commandLine } : {}),
    ...(c.ordinal !== undefined ? { ordinal: c.ordinal } : {}),
  };
  if (!streams || !focused) {
    return { ...base, mode: "text", tail: "", lines: 0 };
  }

  if (c.stage === "running") {
    const { tail, lines } = boundTail(displayLines(c.output));
    return {
      ...base,
      mode: "text",
      tail,
      lines: lines + c.outputDroppedLines,
    };
  }

  switch (c.tool) {
    case "bash": {
      const { tail, lines } = boundTail(splitLines(first("command") ?? ""));
      return { ...base, mode: "text", tail, lines };
    }
    case "write_new_file": {
      const { tail, lines } = boundTail(splitLines(first("content") ?? ""));
      return { ...base, mode: "text", tail, lines };
    }
    case "edit_file": {
      // Hunk by hunk, in the order written: what goes, then what comes.
      const diff: string[] = [];
      for (const f of fields) {
        if (f.key === "search") diff.push(...prefix("-", f.value));
        else if (f.key === "replace") diff.push(...prefix("+", f.value));
      }
      const { tail, lines } = boundTail(diff);
      return { ...base, mode: "diff", tail, lines };
    }
    case "str_replace_editor": {
      const command = first("command");
      const fileText = first("file_text");
      if (command === "create" || fileText !== undefined) {
        const { tail, lines } = boundTail(splitLines(fileText ?? ""));
        return { ...base, mode: "text", tail, lines };
      }
      const diff: string[] = [];
      for (const f of fields) {
        if (f.key === "old_str") diff.push(...prefix("-", f.value));
        else if (f.key === "new_str") diff.push(...prefix("+", f.value));
      }
      const { tail, lines } = boundTail(diff);
      return { ...base, mode: "diff", tail, lines };
    }
    default:
      // run_command before its output: nothing yet.
      return { ...base, mode: "text", tail: "", lines: 0 };
  }
}

function firstLine(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const line = s.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 0 ? line : undefined;
}

/** A string's lines; an empty string has none. */
function splitLines(s: string): string[] {
  if (s.length === 0) return [];
  const lines = s.split("\n");
  // A trailing newline ends the last line; it does not start another.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Output lines as a terminal leaves them: a `\r` rewrites its line (a
 *  progress bar), so only what follows the last one stays. */
function displayLines(output: string): string[] {
  return splitLines(output).map((line) => {
    if (!line.includes("\r")) return line;
    const parts = line.split("\r").filter((p) => p.length > 0);
    return parts[parts.length - 1] ?? "";
  });
}

function prefix(sign: "+" | "-", value: string): string[] {
  return splitLines(value).map((l) => `${sign}${l}`);
}

function boundTail(all: readonly string[]): { tail: string; lines: number } {
  const lines = all.length;
  let kept = all
    .slice(-TAIL_LINES)
    .map((l) => (l.length > LINE_CHARS ? `${l.slice(0, LINE_CHARS)}…` : l));
  let size = kept.reduce((n, l) => n + l.length + 1, 0);
  while (size > TAIL_CHARS && kept.length > 1) {
    size -= (kept[0]?.length ?? 0) + 1;
    kept = kept.slice(1);
  }
  return { tail: kept.join("\n"), lines };
}
