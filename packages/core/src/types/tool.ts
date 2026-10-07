export interface ToolCallRequest {
  id: string;
  tool: string;
  input: unknown;
  /**
   * Set when the model's `arguments` string was not valid JSON, so `input`
   * could not be recovered (it is `{}` in that case — never trust it).
   *
   * The provider used to THROW here, which killed the whole turn
   * non-retryably and discarded every tool call already executed in it. That
   * is the wrong shape for this failure: unlike a dead socket, a mis-escaped
   * argument is something the model can see and fix, and the loop already
   * contains the neighbouring case — an uncaught tool crash comes back as a
   * `tool_crashed` result the model reads and works around (ADR 0025 slice
   * 5). The live trigger was `grep -o ".\{0,40\}checksum.\{0,60\}"`: `\{` is
   * a legal BRE escape and an illegal JSON one, and the class is wide — `\d`,
   * `\w`, `\s`, `\+`, `\(` are all invalid JSON escapes, so any regex written
   * into a string argument could end a brief (measured 1/12 on prompts that
   * invite one, 2026-08-13).
   *
   * A call carrying this MUST NOT be executed and MUST NOT be sent to the
   * permission engine — there is no parsed input to check.
   */
  malformedArgs?: { raw: string; parseError: string };
}

export interface ToolResult<O = unknown> {
  ok: boolean;
  data?: O;
  error?: { code: string; message: string; retryable: boolean };
  suggestion?: string;
  summary: string;
  /**
   * When set, the MODEL sees exactly this text as the tool message — not
   * `summary` + JSON(`data`). `summary`/`data`/`error` remain the harness
   * surfaces (record projection, report absorber, evidence). Introduced
   * for the minimal contract (ADR 0040): `bash` and `str_replace_editor`
   * are trained-shape tools whose model-facing output is plain text
   * (command output, `cat -n` views, the classic error strings), while the
   * harness still needs structured exit codes / diffs for the record.
   * Bounded by the tool (≤ 16K chars); the oversized-result persistence
   * keys off `data`, so a tool that sets this keeps `data` small.
   */
  modelText?: string;
  /**
   * Pictures this tool result puts in front of the model (ADR 0048 slice 3).
   *
   * The transcript stays provider-neutral: WHERE an image may ride is a wire
   * fact, not a harness one. DeepSeek (like OpenAI) accepts images in `user`
   * messages only, so the translator emits the tool message as text and then
   * a synthetic user message carrying these parts. A provider that allowed
   * images inside a tool result would place them differently from the same
   * field.
   *
   * Only set by a vision-capable stack: a model without vision answers 400 to
   * an image part, so the tool that produces these is mounted only when the
   * backend model can read one.
   */
  images?: readonly ToolResultImage[];
}

/** One picture handed to the model, with the path it came from so the record
 *  and any later citation name a real file rather than an opaque blob. */
export interface ToolResultImage {
  /** `data:image/png;base64,…` */
  readonly dataUri: string;
  /** Workspace-relative path of the source file. */
  readonly path: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: unknown;
}

import type { BackgroundHost } from "../backend/background-host.js";
import type { EventBus } from "../event-bus.js";
import type { FindingsLedger } from "../findings-ledger.js";
import type { MemoryManager } from "../memory-manager.js";
import type { ReadLedger } from "../read-ledger.js";
import type { AgentEvent } from "./events.js";

export interface ToolContext {
  sessionId: string;
  signal: AbortSignal;
  workspaceRoot: string;
  reads: ReadLedger;
  /** Per-brief managed background commands (ADR 0025 slice 4). */
  bg: BackgroundHost;
  bus: EventBus<AgentEvent>;
  memory: MemoryManager;
  /** Per-brief conclusions recorded via `report_finding` (ADR 0039).
   *  Optional so the many hand-built test contexts need not carry one; the
   *  turn loop always supplies it. */
  findings?: FindingsLedger;
  /** This call's view of the run's journal (ADR 0071 §1.1). Absent when the
   *  run keeps none (the CLI, tests). */
  journal?: ToolCallJournal;
  /** Where a writer leaves what it replaces, so the user can take the turn's
   *  edits back (ADR 0074). Absent when the run keeps no undo store. */
  undo?: ToolCallUndo;
}

/**
 * What a writer hands the undo store (ADR 0074 §1) right before a file is
 * replaced: its absolute path, its bytes now (null for a file being
 * created) and the sha256 it will have.
 */
export interface ToolCallUndo {
  /** Best effort: NEVER rejects. A capture that fails marks the turn
   *  incomplete and the write goes ahead — undo is a convenience, and 板砖's
   *  work does not wait on it. */
  captureWrite(w: {
    path: string;
    before: Buffer | null;
    after: string;
  }): Promise<void>;
}

/**
 * What a tool records in the run's journal (ADR 0071 §1.1), so a run the
 * app died in can be sealed: a file write is decided by its hashes, and a
 * process left running is ended at relaunch.
 */
export interface ToolCallJournal {
  /** Before a file is replaced: the absolute path, its sha256 before (null
   *  for a new file) and the sha256 it will have after. Durable before it
   *  resolves; REJECTS when it could not be recorded — the tool must then
   *  not write (answer `journalUnavailableResult`). */
  recordWrite(w: {
    path: string;
    before: string | null;
    after: string;
  }): Promise<void>;
  /** After a process started (best effort). */
  recordSpawn(s: {
    pid: number;
    command: string;
    role: "foreground" | "background" | "shell";
    /** An MSYS shell's process group and the `ps` that lists it — how a
     *  relaunch reaches what the shell started (ADR 0071 §1.6). */
    msys?: { pgid: number; ps: string };
  }): void;
  /** When a recorded process ended (best effort). */
  recordExit(pid: number): void;
}

export type ProgressFn = (event: { id: string; message: string }) => void;

/** A running command's output, a chunk at a time as it arrives (ADR 0073):
 *  the live view only — the result still carries what the model and the
 *  record get. */
export type OutputFn = (chunk: string) => void;

export interface HertaTool {
  name: string;
  /**
   * True = the tool mutates no file/process/store state and is safe to
   * run concurrently with other read-only tools. Consulted by the turn
   * loop's parallel-batch partitioner (ADR 0025 slice 5): consecutive
   * read-only calls in one model iteration execute concurrently;
   * anything unmarked stays strictly serial. Default: absent = serial.
   */
  readOnly?: boolean;
  schema(): ToolSchema;
  /**
   * The one-line record header for a call (`Running <this>`, `Writing
   * <this>`) when the tool knows something the loop's generic
   * `summarizeInput` cannot: the minimal contract's `bash` (ADR 0040)
   * knows how ITS shell spells the workspace (`/tmp/…` for a %TEMP%
   * checkout under MSYS, `/e/…` for a drive) and can drop the model's
   * `cd <workspace> &&` prefix in every spelling. Optional; a returned
   * `undefined` (or a throw) falls back to `summarizeInput`, and the loop
   * applies the same single-line cap either way.
   */
  summarize?(
    input: unknown,
    ctx: { workspaceRoot: string },
  ): string | undefined;
  /**
   * Whether the call runs tests, read from its input at dispatch by the same
   * detector that later turns its result into a test row (ADR 0073
   * amendment 2026-10-08). The trace card reads a recognised test run as 验证
   * whatever its command looks like, and must know it from the op row on: the
   * result row lands seconds later behind Herta's beats, and the card used to
   * re-sort its nodes when it did. A fact about the command, not a claim
   * about the run: nothing is decided by it (D4). Optional; a throw is false.
   */
  runsTests?(input: unknown): boolean;
  run(
    call: ToolCallRequest,
    ctx: ToolContext,
    progress: ProgressFn,
    /** Absent where nothing watches (tests, direct calls). */
    output?: OutputFn,
  ): Promise<ToolResult>;
}
