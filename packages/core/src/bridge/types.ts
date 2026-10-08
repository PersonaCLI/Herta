/**
 * Actor-to-backend dispatch. Carries the bare minimum: an opaque task id
 * for tracing. The backend reconstructs its task context from the
 * `userMessages` history threaded through `BackendBuildInput`, NOT from
 * any framing the actor (Herta) writes.
 *
 * Pre-May 2026 this carried `userRequestQuoted` + `hertaInterpretation`
 * + `taskType` + `successCriteria` + `constraints`. That contract forced
 * Herta to wear two hats — speaker AND task framer — and the framer
 * half produced a bureaucratic LLM-written interpretation that the
 * backend then took as ground truth. Replaced with a zero-arg-ish
 * dispatch so Herta is a pure speaker and the agent reads the user's
 * actual words.
 */
export interface HertaToAgentBrief {
  taskId: string;
}

export interface ChangedFileSummary {
  path: string;
  kind: "created" | "modified" | "deleted";
  diffSummary: string;
}

export interface EvidenceItem {
  /** `finding` (ADR 0039): the backend's own cited conclusion, recorded via
   *  `report_finding` — `summary` is the claim, `source` the citations. The
   *  done marker lists these under `↳ 结论`, apart from tool receipts. */
  kind: "file" | "search" | "command" | "test" | "git" | "tool" | "finding";
  summary: string;
  source?: string;
}

export interface TestRunSummary {
  command: string;
  status: "passed" | "failed" | "skipped" | "not_run";
  summary: string;
}

/**
 * Result-data shape of the `run_command` tool. Lives in core (not
 * @herta/tools) because it is a cross-layer contract: the tool produces
 * it, and the bridge layer (@herta/herta's backend-bridge) reads it to
 * project command results into the terminal record. Keeping it here
 * keeps the package graph a DAG — @herta/herta must not depend on
 * @herta/tools (tools → knowledge → herta would close a reference
 * cycle; found 2026-07-05 when a stale-dist build broke on the cycle).
 * @herta/tools re-exports this type for its own consumers.
 */
export interface RunCommandData {
  argv: readonly string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  logPath: string;
  timedOut: boolean;
  /**
   * Populated when the command is a recognized test runner (npm/pnpm
   * test, pytest, cargo test, go test). The bridge layer's report
   * absorber picks this up to populate AgentExecutionReport.tests[].
   * Absent for non-test commands.
   */
  testRun?: TestRunSummary;
  /**
   * Managed background commands (ADR 0025 slice 4): `backgroundId` is
   * set on the run_command start result and on every command_output /
   * command_stop snapshot; `running` is true while the process is
   * alive. The bridge projects a "background … running" row instead of
   * an exit row when `running` is set.
   */
  backgroundId?: string;
  running?: boolean;
  /**
   * The command classified `allow` — a class that changes nothing a user
   * would take back: a read, a test, a version query, `git status`. Set by
   * the tool from the same classifier its permission rule ran. Undo (ADR
   * 0074 §2) leaves such a command out of what it names as not restored.
   */
  readOnly?: boolean;
  /**
   * The files the command wrote through its own redirections — `cat > f
   * <<'EOF' … EOF`, `printf … > f`, `tee f`: the `bash` contract's way of
   * writing a file — as found on disk before and after the run. What each
   * replaced went to the undo store (ADR 0074 amendment, 2026-10-08), so the
   * run counts them as written files, not as changes its commands made.
   * Absent when no redirection changed a file.
   */
  redirectWrites?: readonly RedirectWriteSummary[];
  /**
   * Those files are all the command can change: its writing parts only
   * print (`cat`, `printf`, `echo`, `tee`) and its other parts are
   * `allow`-class (a read, a test) or `mkdir -p` inside the workspace. Undo
   * then names no unknown command change for it.
   */
  writesAccounted?: boolean;
}

/** One file a command's redirection wrote — `RunCommandData.redirectWrites`. */
export interface RedirectWriteSummary {
  /** Workspace-relative, as the editors report a path. */
  readonly relPath: string;
  /** It did not exist before the command. */
  readonly created: boolean;
  /** The diff's line counts. */
  readonly added: number;
  readonly removed: number;
}

/**
 * Result-data shape of the `show_excerpt` tool (ADR 0027). Lives in core for
 * the same reason as {@link RunCommandData} — the tool produces it and the
 * bridge reads it, and @herta/herta must not depend on @herta/tools.
 */
export interface ShowExcerptData {
  /** The slice, line-numbered like read_file's content. Verbatim from disk:
   *  the harness cut it, so nothing paraphrased it on the way here. */
  excerpt: string;
  /** 1-based inclusive line range actually returned. */
  range: [number, number];
  totalLines: number;
  /** The requested span was clipped by the presentation bounds. */
  truncated: boolean;
  relPath: string;
}

/**
 * Result-data shape of the `search_text` tool. Here for the same reason as
 * the two above: since 2026-08-17 the bridge projects a search's hits into
 * the record (a bounded `↳ N matches` row with the matched lines in the
 * two-state evidence lane) — before that, a search's ONLY visible trace was
 * its op row, and 板砖's answer to "which lines mention X" reached nobody
 * unless it re-presented the lines with show_excerpt. Found in a real
 * session where it found 5 matches and Herta had to ask for them by name.
 */
export interface SearchMatch {
  path: string;
  line: number;
  /** The matched line, already secret-redacted (the tool redacts before
   *  matching, so context and match lines both come from redacted text). */
  content: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface SearchTextData {
  /** The pattern as the model wrote it — echoed so the record row can name
   *  what was searched without parsing the summary string. */
  pattern: string;
  matches: SearchMatch[];
  truncated: boolean;
}

/**
 * Result-data shape of the `digest_document` tool (ADR 0043), here for the
 * same reason as the two above. The tool's own module re-exports it.
 */
export interface DigestDocumentData {
  /** Workspace-relative source path (the attachment's stored text). */
  relPath: string;
  /** Workspace-relative `.digest.txt` sidecar path. */
  digestPath: string;
  chunks: number;
  /** Chunks whose summary call failed (their entry says so). */
  failed: number;
  /** The reduce step's overview — bounded, for the record's detail lane. */
  overview: string;
  /** True when an existing sidecar was returned without any model call. */
  cached: boolean;
}

export interface PermissionEventSummary {
  tool: string;
  /**
   * Risk label as classified by the deterministic permission engine.
   * Intentionally `string` (not the `RiskLevel` union from
   * permission-engine) to keep the bridge contract decoupled from
   * permission-engine internals.
   */
  risk: string;
  /**
   * `"allow"` and `"deny"` are user decisions; `"blocked"` is the
   * deterministic auto-deny case where no user prompt fired.
   */
  decision: "allow" | "deny" | "blocked";
  summary: string;
}

/**
 * How a 板砖 brief ENDED. `interrupted` is a first-class member (audit
 * 2026-07-24, 1.4): the turn loop already distinguishes a user abort from an
 * internal failure (`error.kind`), but the runtime collapsed every
 * `turn.failed` into one boolean, so pressing Stop was durably recorded as
 * 板砖 失败 — a lie the record kept, Herta narrated, and the next dispatch
 * inherited as a prior-run failure.
 */
export type ExecutionStatus =
  | "completed"
  | "blocked"
  | "failed"
  | "interrupted"
  | "partial";

/**
 * Structured report the backend returns to the actor. No model-written
 * `summary` field — Herta synthesizes her commentary from the concrete
 * artifacts below, not from a prose paraphrase the agent wrote about
 * itself. This is the load-bearing rule for "Herta is the self that uses
 * the agent, not a re-renderer of the agent's voice" (PHILOSOPHY §5).
 */
export interface AgentExecutionReport {
  taskId: string;
  status: ExecutionStatus;
  changedFiles: readonly ChangedFileSummary[];
  evidence: readonly EvidenceItem[];
  tests: readonly TestRunSummary[];
  permissions: readonly PermissionEventSummary[];
  residualRisks: readonly string[];
  /** Set when the run ended at the harness's step limit rather than at the
   *  model's own finish (2026-09-29): status `interrupted`, and continuable
   *  like one. Absent on every other ending. */
  endedBy?: "step_limit";
}
