import type { Finding } from "../findings-ledger.js";
// The journal's names, not only the tools 板砖 has now: a journal written on
// the standard set (deleted, ADR 0086) is still sealed.
import {
  JOURNAL_COMMAND_TOOLS as COMMAND_TOOLS,
  JOURNAL_WRITING_TOOLS as WRITING_TOOLS,
} from "../tool-kinds.js";
import type { CutoffOutcome } from "../types/terminal-record.js";
import type { ToolCallRequest, ToolResult } from "../types/tool.js";
import type { Message } from "../types/transcript.js";
import type {
  DispatchJournalEntry,
  JournalProcessFate,
  JournalSpawnRole,
  JournalStartEntry,
} from "./dispatch-journal.js";

/**
 * Sealing a run the app exited during (ADR 0071 §1.2–§1.3): every call that
 * has no result is decided — by the harness, from the journal and the files
 * on disk, never by a prompt (D4) — and closed with a result the model reads
 * when the run is continued. Nothing is re-run.
 *
 * Pure apart from the injected file hash, so each row of §1.3 is a test.
 */

export interface SealedProcess {
  readonly callId: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly command: string;
  readonly role: JournalSpawnRole;
  /** Absent until a relaunch has checked it (§1.6). */
  readonly fate?: JournalProcessFate;
}

export interface SealedCall {
  readonly callId: string;
  readonly tool: string;
  /** The tool and its target, for the marker: `edit_file src/a.ts`. */
  readonly step: string;
  readonly outcome: CutoffOutcome;
  /** This call's processes the run left behind. */
  readonly processes: readonly SealedProcess[];
  /** The persisted result the model reads (§1.5). */
  readonly result: ToolResult;
  /** Already in the journal: an earlier seal wrote its closer and then
   *  stopped before the record had its marker. */
  readonly journaled: boolean;
}

/** An open run: the `start`, and where its latest segment begins (the
 *  `start`, or the `resume` of a continued run). */
export interface OpenDispatch {
  readonly start: JournalStartEntry;
  readonly segment: number;
  /** The record's length when the segment began — the seal's record gate. */
  readonly recordLength: number | undefined;
}

export interface SealPlan extends OpenDispatch {
  /** Every call of the latest segment that has no result, decided. */
  readonly calls: readonly SealedCall[];
  /** Workspace-relative files the segment changed: its finished writes and
   *  the open writes found applied. */
  readonly changedFiles: readonly string[];
  /** Processes the run left running (no `exit`), whichever call started
   *  them. */
  readonly processes: readonly SealedProcess[];
}

const STATE_TOOLS: ReadonlySet<string> = new Set(["report_finding"]);
const OUTCOMES: ReadonlySet<string> = new Set<CutoffOutcome>([
  "not_started",
  "read_interrupted",
  "write_applied",
  "write_not_applied",
  "write_changed_since",
  "state_not_applied",
  "outcome_unknown",
]);

/** The run when it is open — started or resumed, and not ended since —
 *  which is the journal's half of the seal's gate; else null. */
export function openDispatch(
  entries: readonly DispatchJournalEntry[],
): OpenDispatch | null {
  const first = entries[0];
  if (first?.kind !== "start") return null;
  let open = false;
  let segment = 0;
  let recordLength: number | undefined;
  entries.forEach((e, i) => {
    if (e.kind === "start" || e.kind === "resume") {
      open = true;
      segment = i;
      recordLength = e.recordLength;
    } else if (e.kind === "end") {
      open = false;
    }
  });
  return open ? { start: first, segment, recordLength } : null;
}

/**
 * Decide every open call of an open run. Null when the run is not open.
 * `hashFile` answers a file's sha256, or null when it does not exist; a
 * throw (the file cannot be read) leaves that write's outcome unknown.
 */
export async function planSeal(
  entries: readonly DispatchJournalEntry[],
  hashFile: (path: string) => Promise<string | null>,
): Promise<SealPlan | null> {
  const open = openDispatch(entries);
  if (open === null) return null;
  const { start } = open;
  const lang = start.frame.lang;
  const root = start.workspaceRoot;

  // The whole journal: processes outlive a segment.
  const spawns: SealedProcess[] = [];
  const exited = new Set<number>();
  const fates = new Map<number, JournalProcessFate>();
  for (const e of entries) {
    if (e.kind === "spawn") {
      spawns.push({
        callId: e.callId,
        pid: e.pid,
        startedAt: e.startedAt,
        command: e.command,
        role: e.role,
      });
    } else if (e.kind === "exit") {
      exited.add(e.pid);
    } else if (e.kind === "reap") {
      fates.set(e.pid, e.fate);
    }
  }
  const leftRunning = spawns
    .filter((s) => !exited.has(s.pid))
    .map((s) => {
      const fate = fates.get(s.pid);
      return fate !== undefined ? { ...s, fate } : s;
    });

  // The latest segment: its calls, what answered them, what they did.
  const calls: ToolCallRequest[] = [];
  const results = new Map<string, boolean>(); // callId → ok
  const closers = new Map<
    string,
    { outcome: CutoffOutcome; result: ToolResult }
  >();
  const dispatched = new Map<string, boolean>(); // callId → readOnly
  const writes = new Map<
    string,
    { path: string; before: string | null; after: string }
  >();
  for (const e of entries.slice(open.segment)) {
    switch (e.kind) {
      case "message":
        if (e.message.role === "assistant") {
          calls.push(...e.message.toolCalls);
        } else if (e.message.role === "tool") {
          results.set(e.message.toolCallId, e.message.result.ok);
        }
        break;
      case "closer":
        if (OUTCOMES.has(e.outcome)) {
          closers.set(e.callId, {
            outcome: e.outcome as CutoffOutcome,
            result: e.result,
          });
        }
        break;
      case "dispatch":
        for (const id of e.callIds) dispatched.set(id, e.readOnly === true);
        break;
      case "write":
        writes.set(e.callId, {
          path: e.path,
          before: e.before,
          after: e.after,
        });
        break;
      default:
        break;
    }
  }

  const sealed: SealedCall[] = [];
  const changed: string[] = [];
  for (const call of calls) {
    const w = writes.get(call.id);
    if (results.has(call.id)) {
      if (results.get(call.id) === true && w !== undefined) {
        changed.push(relativeTo(root, w.path));
      }
      continue;
    }
    // The shell's own processes are not the step's: a continued run is told
    // the shell restarted, once (planResume's note).
    const processes = leftRunning.filter(
      (p) => p.callId === call.id && p.role !== "shell",
    );
    const prior = closers.get(call.id);
    const outcome =
      prior?.outcome ?? (await decide(call, dispatched, w, hashFile));
    const path = w !== undefined ? relativeTo(root, w.path) : undefined;
    if (outcome === "write_applied" && path !== undefined) changed.push(path);
    sealed.push({
      callId: call.id,
      tool: call.tool,
      step: stepOf(call, path),
      outcome,
      processes,
      result:
        prior?.result ??
        closerResult(outcome, call.tool, path, processes, lang),
      journaled: prior !== undefined,
    });
  }

  return {
    ...open,
    calls: sealed,
    changedFiles: [...new Set(changed)],
    processes: leftRunning,
  };
}

async function decide(
  call: ToolCallRequest,
  dispatched: ReadonlyMap<string, boolean>,
  write: { path: string; before: string | null; after: string } | undefined,
  hashFile: (path: string) => Promise<string | null>,
): Promise<CutoffOutcome> {
  if (!dispatched.has(call.id)) return "not_started";
  if (dispatched.get(call.id) === true) return "read_interrupted";
  if (WRITING_TOOLS.has(call.tool)) {
    // The minimal contract's editor also views; a view writes nothing.
    if (
      call.tool === "str_replace_editor" &&
      (call.input as { command?: unknown } | null)?.command === "view"
    ) {
      return "read_interrupted";
    }
    // The rename only ever follows the entry, so no entry means no write.
    if (write === undefined) return "write_not_applied";
    let now: string | null;
    try {
      now = await hashFile(write.path);
    } catch {
      return "outcome_unknown";
    }
    if (now === write.after) return "write_applied";
    if (now === write.before) return "write_not_applied";
    return "write_changed_since";
  }
  if (STATE_TOOLS.has(call.tool)) return "state_not_applied";
  return "outcome_unknown";
}

/** `edit_file src/a.ts`, `run_command npm test`, or the bare tool name. */
function stepOf(call: ToolCallRequest, path: string | undefined): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const target =
    path ??
    (COMMAND_TOOLS.has(call.tool) && typeof input.command === "string"
      ? oneLine(input.command)
      : typeof input.path === "string"
        ? input.path
        : undefined);
  return target !== undefined && target.length > 0
    ? `${call.tool} ${target}`
    : call.tool;
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Why a run stopped: the app exited under it (the seal), the user pressed
 *  Stop, or it reached the step limit. A run the app exited during has its
 *  closers from the seal; the other two are closed when it is continued. */
export type StopCause = "app-exit" | "stop" | "step-limit";

/** The journal `end`'s cause, as a stop cause: no cause is the user's Stop. */
function causeOf(end: { readonly cause?: string }): StopCause {
  return end.cause === "app-exit" || end.cause === "step-limit"
    ? end.cause
    : "stop";
}

function closerResult(
  outcome: CutoffOutcome,
  tool: string,
  path: string | undefined,
  processes: readonly SealedProcess[],
  lang: "zh" | "en",
  cause: StopCause = "app-exit",
): ToolResult {
  const text = closerText(outcome, tool, path, processes, lang, cause);
  const what = cause === "app-exit" ? "app exited" : "run stopped";
  if (outcome === "write_applied") {
    return { ok: true, summary: `applied before the ${what}`, modelText: text };
  }
  return {
    ok: false,
    error: {
      code: `${cause === "app-exit" ? "app_exit" : "stopped"}_${outcome}`,
      message: text,
      retryable: false,
    },
    summary: `${what}: ${outcome.replaceAll("_", " ")}`,
    modelText: text,
  };
}

function closerText(
  outcome: CutoffOutcome,
  tool: string,
  path: string | undefined,
  processes: readonly SealedProcess[],
  lang: "zh" | "en",
  cause: StopCause,
): string {
  const file = path ?? (lang === "en" ? "the file" : "该文件");
  const command = COMMAND_TOOLS.has(tool);
  // When / before / after the interruption, in the cause's words (a Stop
  // and the step limit both stopped the run).
  const exited = cause === "app-exit";
  const zhWhen = exited ? "应用退出时" : "运行被停止时";
  const zhBefore = exited ? "应用退出前" : "运行被停止前";
  const zhAfter = exited ? "应用退出后" : "运行被停止后";
  const enWhen = exited ? "when the app exited" : "when the run was stopped";
  const enBefore = exited
    ? "before the app exited"
    : "before the run was stopped";
  const enAfter = exited ? "after the app exited" : "after the run was stopped";
  const zh: Record<CutoffOutcome, string> = {
    not_started: `${zhWhen}这一步还没有开始执行。如仍需要，重新调用。`,
    read_interrupted: `${zhWhen}这次读取没有完成。它没有副作用，需要时重新读取。`,
    write_applied: `${zhBefore}这次写入已经完成：${file} 现在是写入后的内容。不要重复这次修改。`,
    write_not_applied: `${zhBefore}这次写入没有落盘：${file} 仍是原来的内容。如仍需要，先重新读取再修改。`,
    write_changed_since: `${file} 的内容既不是写入前、也不是写入后的版本：${zhAfter}它被别处改动过。先读取它，不要覆盖那次改动；如果影响任务，用 report_finding 说明。`,
    state_not_applied: `${zhWhen}这一步没有生效（已完成的步骤都已恢复）。如仍需要，重新调用。`,
    outcome_unknown: command
      ? `${zhWhen}这条命令正在运行，结果未知，输出没有保留；它可能已经部分执行。不要直接重跑有副作用的命令：先检查它影响的状态（文件、git status、进程、端口），或只重跑只读、可重复执行的命令。`
      : `${zhWhen}这一步正在执行，结果未知；它可能已经部分生效。先确认它影响的状态，再决定是否重做。`,
  };
  const en: Record<CutoffOutcome, string> = {
    not_started: `This step had not started ${enWhen}. Call it again if it is still needed.`,
    read_interrupted: `This read did not finish ${enBefore}. It has no side effect; read again if needed.`,
    write_applied: `This write completed ${enBefore}: ${file} holds the written content. Do not repeat the change.`,
    write_not_applied: `This write did not reach the disk ${enBefore}: ${file} is unchanged. If it is still needed, read the file again before editing it.`,
    write_changed_since: `${file} is neither the version before this write nor the one after it: it was changed elsewhere ${enAfter}. Read it first and do not overwrite that change; if it matters to the task, say so with report_finding.`,
    state_not_applied: `This step did not take effect ${enWhen} (every finished step was restored). Call it again if it is still needed.`,
    outcome_unknown: command
      ? `This command was running ${enWhen}. Its outcome is unknown and its output was not kept; it may have partly run. Do not simply re-run a command with side effects: first check the state it touches (files, git status, processes, ports), or re-run only a read-only or idempotent command.`
      : `This step was running ${enWhen}; its outcome is unknown and it may have partly taken effect. Check the state it touches before deciding to redo it.`,
  };
  const base = (lang === "en" ? en : zh)[outcome];
  const lines = processes.map((p) => processLine(p, lang));
  return lines.length > 0 ? `${base}\n${lines.join("\n")}` : base;
}

/** A run that can be continued (ADR 0071 §1.4): it started, and its latest
 *  segment ended `interrupted` — sealed after the app exited, or stopped by
 *  the user. `recordLength` is the segment's own (its `start` or `resume`). */
export interface ResumableRun {
  readonly start: JournalStartEntry;
  readonly cause: StopCause;
  readonly recordLength: number | undefined;
}

export function resumableRun(
  entries: readonly DispatchJournalEntry[],
): ResumableRun | null {
  const first = entries[0];
  if (first?.kind !== "start") return null;
  let recordLength: number | undefined;
  let last: DispatchJournalEntry | undefined;
  for (const e of entries) {
    if (e.kind === "start" || e.kind === "resume") {
      recordLength = e.recordLength;
      last = e;
    } else if (e.kind === "end") {
      last = e;
    }
  }
  if (last?.kind !== "end" || last.status !== "interrupted") return null;
  return { start: first, cause: causeOf(last), recordLength };
}

/** What a continued run starts from (ADR 0071 §1.5). */
export interface ResumePlan extends ResumableRun {
  /** The conversation to continue: every message in order, each open call
   *  closed where it stood, then the harness's note. */
  readonly messages: readonly Message[];
  /** Closers decided now — a run the user stopped has none in its journal
   *  yet. The continued run writes them before its `resume` entry. */
  readonly newClosers: ReadonlyArray<{
    readonly callId: string;
    readonly outcome: CutoffOutcome;
    readonly result: ToolResult;
  }>;
  /** The conclusions already recorded. */
  readonly findings: readonly Finding[];
  /** Workspace-relative files already changed: finished writes, and open
   *  ones found applied. The continued run's report starts from them. */
  readonly changedFiles: ReadonlyArray<{
    readonly path: string;
    readonly kind: "created" | "modified";
  }>;
}

/**
 * Rebuild a run for continuing it. Null unless `resumableRun` holds. A call
 * still open (a run the user stopped mid-step) is decided exactly as the
 * seal decides, in the stop's words. Nothing is re-run.
 */
export async function planResume(
  entries: readonly DispatchJournalEntry[],
  hashFile: (path: string) => Promise<string | null>,
  at: Date,
): Promise<ResumePlan | null> {
  const run = resumableRun(entries);
  if (run === null) return null;
  const { start, cause } = run;
  const lang = start.frame.lang;
  const root = start.workspaceRoot;
  const ts = at.toISOString();

  const callsById = new Map<string, ToolCallRequest>();
  const writes = new Map<
    string,
    { path: string; before: string | null; after: string }
  >();
  const spawns: SealedProcess[] = [];
  const exited = new Set<number>();
  const fates = new Map<number, JournalProcessFate>();
  for (const e of entries) {
    if (e.kind === "message" && e.message.role === "assistant") {
      for (const c of e.message.toolCalls) callsById.set(c.id, c);
    } else if (e.kind === "write") {
      writes.set(e.callId, { path: e.path, before: e.before, after: e.after });
    } else if (e.kind === "spawn") {
      spawns.push({
        callId: e.callId,
        pid: e.pid,
        startedAt: e.startedAt,
        command: e.command,
        role: e.role,
      });
    } else if (e.kind === "exit") {
      exited.add(e.pid);
    } else if (e.kind === "reap") {
      fates.set(e.pid, e.fate);
    }
  }

  const messages: Message[] = [];
  const newClosers: Array<{
    callId: string;
    outcome: CutoffOutcome;
    result: ToolResult;
  }> = [];
  const outcomes = new Map<string, { ok: boolean; outcome?: CutoffOutcome }>();
  let segmentCalls: ToolCallRequest[] = [];
  let dispatched = new Map<string, boolean>();
  let lastEnd = -1;
  entries.forEach((e, i) => {
    if (e.kind === "end") lastEnd = i;
  });
  for (const [i, e] of entries.entries()) {
    switch (e.kind) {
      case "message":
        messages.push(e.message);
        if (e.message.role === "assistant") {
          segmentCalls.push(...e.message.toolCalls);
        } else if (e.message.role === "tool") {
          outcomes.set(e.message.toolCallId, { ok: e.message.result.ok });
        }
        break;
      case "closer":
        messages.push({
          role: "tool",
          toolCallId: e.callId,
          result: e.result,
          ts,
        });
        outcomes.set(e.callId, {
          ok: e.result.ok,
          ...(OUTCOMES.has(e.outcome)
            ? { outcome: e.outcome as CutoffOutcome }
            : {}),
        });
        break;
      case "dispatch":
        for (const id of e.callIds) dispatched.set(id, e.readOnly === true);
        break;
      case "end": {
        // The segment ends: any call it left without a result is closed
        // here, where it stood. Only the last segment can have one — a
        // continued run closes its predecessor's before resuming.
        const segmentCause = causeOf(e);
        for (const call of segmentCalls) {
          if (outcomes.has(call.id)) continue;
          const w = writes.get(call.id);
          const outcome = await decide(call, dispatched, w, hashFile);
          const path = w !== undefined ? relativeTo(root, w.path) : undefined;
          const result = closerResult(
            outcome,
            call.tool,
            path,
            [],
            lang,
            segmentCause,
          );
          messages.push({ role: "tool", toolCallId: call.id, result, ts });
          outcomes.set(call.id, { ok: result.ok, outcome });
          if (i === lastEnd) {
            newClosers.push({ callId: call.id, outcome, result });
          }
        }
        segmentCalls = [];
        dispatched = new Map();
        break;
      }
      default:
        break;
    }
  }

  // What still ran when the app exited, other than the shell itself — which
  // the note speaks of once. A stopped run's own cleanup ended its processes.
  const leftRunning =
    cause === "app-exit"
      ? spawns
          .filter((s) => !exited.has(s.pid) && s.role !== "shell")
          .map((s) => {
            const fate = fates.get(s.pid);
            return fate !== undefined ? { ...s, fate } : s;
          })
      : [];
  messages.push({
    role: "user",
    text: resumeNote(
      lang,
      cause,
      spawns.some((s) => s.role === "shell"),
      leftRunning.map((p) => processLine(p, lang)),
      // A stopped run's own cleanup ended what run_command had put in the
      // background; said, or the model asks command_output about a dead id
      // (review 2026-09-30). The seal's case lists each process instead.
      cause !== "app-exit" && spawns.some((s) => s.role === "background"),
    ),
    ts,
  });

  // State, from the calls that took effect.
  const findings: Finding[] = [];
  const changed = new Map<string, "created" | "modified">();
  for (const e of entries) {
    if (e.kind !== "message" || e.message.role !== "tool") continue;
    if (!e.message.result.ok) continue;
    const call = callsById.get(e.message.toolCallId);
    if (call?.tool === "report_finding") {
      const data = e.message.result.data as
        | { claim?: unknown; cites?: unknown }
        | undefined;
      if (typeof data?.claim === "string") {
        findings.push({
          claim: data.claim,
          cites: Array.isArray(data.cites)
            ? data.cites.filter((c): c is string => typeof c === "string")
            : [],
        });
      }
    }
  }
  for (const [callId, w] of writes) {
    const o = outcomes.get(callId);
    const applied =
      o?.outcome !== undefined ? o.outcome === "write_applied" : o?.ok === true;
    if (applied) {
      changed.set(
        relativeTo(root, w.path),
        w.before === null ? "created" : "modified",
      );
    }
  }

  return {
    ...run,
    messages,
    newClosers,
    findings,
    changedFiles: [...changed].map(([path, kind]) => ({ path, kind })),
  };
}

/** The harness's word to the model between the closed steps and its next
 *  turn (ADR 0071 §1.5). */
function resumeNote(
  lang: "zh" | "en",
  cause: StopCause,
  hadShell: boolean,
  processLines: readonly string[],
  backgroundEnded = false,
): string {
  const why: Record<StopCause, { zh: string; en: string }> = {
    "app-exit": { zh: "应用意外退出", en: "the app exited unexpectedly" },
    stop: { zh: "开拓者按了停止", en: "the user pressed Stop" },
    "step-limit": {
      zh: "达到了这次运行的步数上限",
      en: "the run reached its step limit",
    },
  };
  if (lang === "en") {
    return [
      `(The run was interrupted here: ${why[cause].en}. Each unfinished step above states its outcome; nothing was redone.`,
      hadShell
        ? "The shell has been restarted: its working directory and environment are back to their initial state, and commands it was running in the background have ended."
        : null,
      backgroundEnded
        ? "The commands started in the background have ended; their ids are no longer valid."
        : null,
      ...processLines,
      "Continue the task from where it stopped.)",
    ]
      .filter((l): l is string => l !== null)
      .join(" ");
  }
  return [
    `（运行在这里中断过：${why[cause].zh}。上面每个未完成的步骤都已写明结果，没有任何步骤被重做。`,
    hadShell
      ? "shell 已经重新启动：当前目录和环境变量都回到了初始状态，之前在后台运行的命令都已结束。"
      : null,
    backgroundEnded
      ? "之前放到后台运行的命令都已结束，它们的编号已失效。"
      : null,
    ...processLines,
    "请从中断的地方继续完成任务。）",
  ]
    .filter((l): l is string => l !== null)
    .join("");
}

/** One line about a process the run left running (§1.6). */
export function processLine(p: SealedProcess, lang: "zh" | "en"): string {
  const zh: Record<JournalProcessFate | "unchecked", string> = {
    ended: `进程 ${p.pid}（${p.command}）在应用重新启动时仍在运行，已被结束。`,
    gone: `进程 ${p.pid}（${p.command}）在应用重新启动时已不在运行。`,
    unverified: `无法确认进程 ${p.pid} 仍是这条命令（${p.command}），所以没有结束它；它可能仍在运行。`,
    unchecked: `进程 ${p.pid}（${p.command}）在应用退出时仍在运行，尚未检查。`,
  };
  const en: Record<JournalProcessFate | "unchecked", string> = {
    ended: `Process ${p.pid} (${p.command}) was still running at relaunch and was ended.`,
    gone: `Process ${p.pid} (${p.command}) was no longer running at relaunch.`,
    unverified: `Process ${p.pid} could not be confirmed to still be this command (${p.command}), so it was not ended; it may still be running.`,
    unchecked: `Process ${p.pid} (${p.command}) was running when the app exited and has not been checked.`,
  };
  return (lang === "en" ? en : zh)[p.fate ?? "unchecked"];
}

/** A journal path relative to the run's workspace, `/`-separated; the path
 *  as recorded when it lies elsewhere or the workspace is unknown. */
function relativeTo(root: string | undefined, path: string): string {
  if (root === undefined) return path;
  const norm = (s: string) => s.replaceAll("\\", "/");
  const r = norm(root).replace(/\/+$/, "");
  const p = norm(path);
  const inside =
    process.platform === "win32"
      ? p.toLowerCase().startsWith(`${r.toLowerCase()}/`)
      : p.startsWith(`${r}/`);
  return inside ? p.slice(r.length + 1) : path;
}
