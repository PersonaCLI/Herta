import { mkdirSync } from "node:fs";
import { ExecutionReportBuilder } from "../bridge/report-builder.js";
import type {
  AgentExecutionReport,
  HertaToAgentBrief,
  RunCommandData,
  TestRunSummary,
} from "../bridge/types.js";
import type { EventBus } from "../event-bus.js";
import { FindingsLedger } from "../findings-ledger.js";
import type { MemoryManager } from "../memory-manager.js";
import { CALL_ERROR_DENY_CODES } from "../permission-deny-codes.js";
import type { PermissionEngine, RiskLevel } from "../permission-engine.js";
import { ReadLedger } from "../read-ledger.js";
import { countDiffLines } from "../text/diff-lines.js";
import type { ToolRegistry } from "../tool-registry.js";
import { TranscriptStore } from "../transcript-store.js";
import type { AgentEvent } from "../types/events.js";
import type { ProviderAdapter } from "../types/provider.js";
import type {
  BackendContextBuilder,
  RepoContextSnapshot,
} from "./backend-context-builder.js";
import { runBackendTurnLoop } from "./backend-turn-loop.js";
import { BackgroundHost } from "./background-host.js";
import type { BackendPromptBudget } from "./context-budget.js";
import {
  currentJournalHost,
  DISPATCH_JOURNAL_VERSION,
  DispatchJournal,
  hashFile,
  markJournalOpen,
  readDispatchJournal,
} from "./dispatch-journal.js";
import { planResume, type ResumePlan } from "./journal-seal.js";
import { renderScopedMemory } from "./scoped-memory.js";
import { type UndoSegment, UndoStore } from "./undo-store.js";

/**
 * Tools whose SUCCESS argues that the task advanced (audit 2026-07-24, 1.2).
 * Read-only and bookkeeping tools — read_file, search_text, glob,
 * git_status, git_diff, command_output — execute successfully
 * while changing nothing, so counting them as completion evidence let a
 * backend that merely investigated report 完成.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "edit_file",
  "write_new_file",
  "run_command",
  "command_stop",
  "memory_save",
  // Minimal contract (ADR 0040): `bash` counts like run_command (exit 0
  // only, see below); the editor counts only for its writing commands —
  // a `view` is a read and proves nothing (the result data says which).
  "bash",
  "str_replace_editor",
]);

/** The two shell-shaped tools whose result data is RunCommandData. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["run_command", "bash"]);
/** The three file-writing tools whose result data carries relPath + diff. */
const WRITING_TOOLS: ReadonlySet<string> = new Set([
  "edit_file",
  "write_new_file",
  "str_replace_editor",
]);

export interface CodingAgentRuntimeDeps {
  sessionId: string;
  provider: ProviderAdapter;
  tools: ToolRegistry;
  permissions: PermissionEngine;
  backendBuilder: BackendContextBuilder;
  bus: EventBus<AgentEvent>;
  clock: () => Date;
  workspaceRoot: string;
  memory: MemoryManager;
  /** Working-set prompt budget override (ADR 0025 slice 2); defaults to
   *  DEFAULT_BACKEND_PROMPT_BUDGET in the turn loop. */
  budget?: BackendPromptBudget;
  /**
   * Snapshot of the workspace's version-control state, taken at brief START
   * and again at brief END to attribute what this dispatch changed.
   *
   * INJECTED because the probe needs git and core cannot import `@herta/tools`
   * (tools already depends on core). Absent, or returning null, and the report
   * simply falls back to the editors' own harvest, exactly as before.
   */
  repoProbe?: (signal?: AbortSignal) => Promise<RepoSnapshot | null>;
  /**
   * The files a committed range `fromHead..toHead` touched, or null when the
   * range cannot be attributed (toHead does not descend from fromHead —
   * rebase/amend/reset — or git could not answer). Injected for the same
   * reason as `repoProbe`.
   *
   * Added 2026-08-26 (git-dev lab): the probe's HEAD-moved refusal fired on
   * every brief that ended in a commit — the NORMAL ending of a git brief —
   * so shell-written files vanished from `changedFiles` all over again the
   * moment the model committed them. A new HEAD that DESCENDS from the old
   * one is this dispatch's own forward work (commits, merges) and is
   * attributable; anything else keeps the honest refusal.
   */
  repoRangeDiff?: (
    fromHead: string,
    toHead: string,
    signal?: AbortSignal,
  ) => Promise<readonly RepoRangeFile[] | null>;
  /**
   * The richer repo description rendered into the backend frame's repo-
   * snapshot section (ADR 0049 §2): branch, upstream ±counts, in-progress
   * state, bounded dirty set, recent subjects. Injected for the same reason
   * as `repoProbe`; gathered once at brief START in parallel with the
   * baseline. Absent, or returning null, and the frame simply omits the
   * section — byte-identical to before.
   */
  repoContext?: (signal?: AbortSignal) => Promise<RepoContextSnapshot | null>;
  /**
   * The steer source (ADR 0063): user messages sent while a brief runs,
   * drained by the turn loop at the top of each iteration. Owned by the
   * session (it accepts the text and projects it into the record); the
   * runtime only threads it into the loop's handle. Absent: no steer ever
   * reaches the loop — the CLI and tests.
   */
  pendingUserInput?: () => readonly string[];
  /**
   * Where this session keeps its run journal (ADR 0071 §1.1; see
   * `dispatchJournalPath`). Each dispatch replaces it. Absent (the CLI,
   * tests): no journal is kept.
   */
  journalPath?: string;
  /**
   * Where this session keeps what 板砖's editors replace (ADR 0074; see
   * `undoStoreDir`). Each dispatch and each continuation is a segment, keyed
   * by the record length it began at — so a run given none keeps nothing.
   * Absent (the CLI, tests): no undo store.
   */
  undoDir?: string;
  /** The execution contract this stack runs (ADR 0040), recorded in the
   *  journal so a resumed run can tell whether it still applies. */
  contract?: string;
}

/** What the workspace's VCS looked like at one instant. */
export interface RepoSnapshot {
  /** HEAD's commit id, or null on an unborn branch / no repo. */
  readonly head: string | null;
  /** Workspace-relative paths that differ from HEAD (staged, unstaged or
   *  untracked). */
  readonly dirty: readonly string[];
}

/** One file a committed range touched (see `repoRangeDiff`). */
export interface RepoRangeFile {
  readonly path: string;
  readonly kind: "created" | "modified" | "deleted";
}

export interface RunBriefOptions {
  signal?: AbortSignal;
  scopedRepoInstructions?: string;
  /**
   * The frame's project-memory text. UNDEFINED (the production dispatch)
   * means the runtime recalls the store itself at brief start and renders
   * it (`renderScopedMemory`, ADR 0060); a string — even `""` — is taken as
   * the caller's decision and no recall happens.
   */
  scopedMemory?: string;
  /**
   * User-only message history threaded by the actor. The backend reads
   * this as task context in place of the deprecated brief framing.
   * Required for non-trivial dispatches; defaults to `[]` (degrades to
   * a contract-only prompt, useful in test fixtures).
   */
  userMessages?: ReadonlyArray<{ text: string }>;
  /** How many older user messages the caller's caps elided from
   *  `userMessages` (ADR 0025 slice 2); surfaces as an honest elision
   *  note in the serialized history. Defaults to 0. */
  omittedUserMessages?: number;
  /** Pre-rendered recent dialogue since the last dispatch (referent resolution). */
  recentDialogue?: string;
  /** Pre-rendered prior-dispatch working history. */
  workingHistory?: string;
  /** The session's interaction language (ADR 0016). Threaded to the backend
   *  builder so an EN session gets an English backend prompt; absent → "zh". */
  lang?: "zh" | "en";
  /** The session record's length when this run was dispatched, recorded in
   *  the journal: the seal's second gate (ADR 0071 §1.2). */
  recordLength?: number;
}

export interface ResumeBriefOptions {
  signal?: AbortSignal;
  /** The session record's length when the run was continued, recorded on
   *  the journal's `resume` entry: the seal's record gate for this segment
   *  (ADR 0071 §1.2). */
  recordLength?: number;
}

interface PendingPermission {
  tool: string;
  risk: RiskLevel;
}

/**
 * Silent coding-agent runtime per ADR 0007 / D6. Long-lived infrastructure
 * (provider, tools, permissions, backend builder, bus, memory) is owned by
 * the instance; per-brief state (transcript, read ledger, journal,
 * background host) is reset on every `runBrief` call. The runtime never speaks to the user
 * and never role-plays Herta — it returns a structured `AgentExecutionReport`.
 */
export class CodingAgentRuntime {
  private readonly deps: CodingAgentRuntimeDeps;
  private briefInFlight = false;

  constructor(deps: CodingAgentRuntimeDeps) {
    this.deps = deps;
  }

  /** The repo snapshot, or null when there is no probe, no repo, or the probe
   *  failed. Never throws: attribution is a nicety and must not fail a brief. */
  private async probeRepo(signal?: AbortSignal): Promise<RepoSnapshot | null> {
    if (this.deps.repoProbe === undefined) return null;
    try {
      return await this.deps.repoProbe(signal);
    } catch {
      return null;
    }
  }

  /** The frame's repo snapshot, or null when there is no describer, no repo,
   *  or the probe failed. Same never-throws contract as `probeRepo`: prompt
   *  context is a nicety and must not fail a brief. */
  private async describeRepo(
    signal?: AbortSignal,
  ): Promise<RepoContextSnapshot | null> {
    if (this.deps.repoContext === undefined) return null;
    try {
      return await this.deps.repoContext(signal);
    } catch {
      return null;
    }
  }

  /**
   * The frame's project-memory text (ADR 0060): everything the store holds,
   * rendered newest-last under the count/char caps — or `""` when the store
   * is empty or could not be read. Same never-throws contract as `probeRepo`:
   * memory is P2 context, and a corrupt or unreadable store must cost the
   * brief its hints, not the brief.
   */
  private async recallScopedMemory(lang: "zh" | "en"): Promise<string> {
    try {
      const items = await this.deps.memory.recall({});
      return renderScopedMemory(items, lang);
    } catch {
      return "";
    }
  }

  /** The committed range's files, or null when unattributable (non-descendant
   *  move, no injected differ, git failure). Same never-throws contract as
   *  `probeRepo` and for the same reason. */
  private async rangeDiff(
    fromHead: string,
    toHead: string,
    signal?: AbortSignal,
  ): Promise<readonly RepoRangeFile[] | null> {
    if (this.deps.repoRangeDiff === undefined) return null;
    try {
      return await this.deps.repoRangeDiff(fromHead, toHead, signal);
    } catch {
      return null;
    }
  }

  runBrief(
    brief: HertaToAgentBrief,
    opts: RunBriefOptions = {},
  ): Promise<AgentExecutionReport> {
    return this.run(brief, opts, null);
  }

  /**
   * Continue a run the app exited during, or the user stopped (ADR 0071
   * §1.5), from its journal: the same base frame, the conversation with every
   * open step closed and the harness's note after it, the findings that
   * took effect, the files already changed. It appends to the
   * same journal under a `resume` entry. Nothing is re-run.
   *
   * Rejects with `kind: "resume_unavailable"` when the journal holds no run
   * that can be continued, or one started under another contract (its calls
   * name that contract's tools).
   */
  async resumeBrief(opts: ResumeBriefOptions): Promise<AgentExecutionReport> {
    const unavailable = (why: string): Error =>
      Object.assign(new Error(`cannot continue this run: ${why}`), {
        kind: "resume_unavailable" as const,
      });
    if (this.deps.journalPath === undefined) throw unavailable("no journal");
    const entries = await readDispatchJournal(this.deps.journalPath);
    const plan =
      entries === null
        ? null
        : await planResume(entries, hashFile, this.deps.clock());
    if (plan === null) throw unavailable("no interrupted run in the journal");
    if (plan.start.contract !== this.deps.contract) {
      throw unavailable(
        `it ran under the ${plan.start.contract ?? "unknown"} contract`,
      );
    }
    return this.run(
      plan.start.brief,
      {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.recordLength !== undefined
          ? { recordLength: opts.recordLength }
          : {}),
      },
      plan,
    );
  }

  private async run(
    brief: HertaToAgentBrief,
    opts: RunBriefOptions,
    resume: ResumePlan | null,
  ): Promise<AgentExecutionReport> {
    if (this.briefInFlight) {
      // A real Error, not an AgentError literal (audit 2026-07-10, finding
      // 22): the plain object had no stack and failed `instanceof Error`, so
      // generic `err instanceof Error ? … : String(err)` handlers rendered
      // "[object Object]". The `kind` property keeps the bridge's AgentError
      // duck-typing working unchanged.
      throw Object.assign(new Error("brief already in progress"), {
        kind: "internal" as const,
      });
    }
    this.briefInFlight = true;
    // The run's journal (ADR 0071 §1.1), opened once the frame's inputs are
    // known. Every transcript append reaches it through `onAppend`.
    let journal: DispatchJournal | undefined;
    // The undo store (ADR 0074 §1), opened beside it.
    let undo: UndoStore | undefined;
    let undoSegment: UndoSegment | undefined;
    try {
      // Ensure the managed sandbox exists before any tool runs. A fresh
      // session whose first @板砖 action is read-only (e.g. `git status`)
      // would otherwise run with cwd = a not-yet-created workspace dir and
      // get ENOENT. Idempotent.
      mkdirSync(this.deps.workspaceRoot, { recursive: true });

      // What the user said while this run worked (ADR 0063 steers), for the
      // working state: a steer sits in a transcript group the budget trim can
      // drop (working-state.ts).
      const steers: string[] = [];
      const transcript = new TranscriptStore({
        onAppend: (message) => {
          void journal?.append({ kind: "message", message });
          if (message.role === "user") steers.push(message.text);
        },
      });
      const reads = new ReadLedger();
      const bg = new BackgroundHost();
      const findings = new FindingsLedger();

      const builder = new ExecutionReportBuilder(brief.taskId);
      // A continued run starts where its journal left off (ADR 0071 §1.5).
      // The read ledger stays empty: the model reads a file again before it
      // edits it, and the freshness rule does the rest.
      if (resume !== null) {
        transcript.seed(resume.messages);
        // The earlier segments' steers; the last seeded message is the
        // harness's resume note, not the user's.
        for (const m of resume.messages.slice(0, -1)) {
          if (m.role === "user") steers.push(m.text);
        }
        for (const f of resume.findings) {
          findings.add(f);
          builder.addEvidence({
            kind: "finding",
            summary: f.claim,
            source: f.cites.join(", "),
          });
        }
      }
      const pendingPermissions = new Map<string, PendingPermission>();
      let failed = false;
      /** The KIND of the last turn.failed — `"interrupted"` distinguishes a
       *  deliberate stop from a real failure (audit 2026-07-24, 1.4). */
      let lastErrorKind: string | undefined;
      // Report-integrity trackers (板砖 review 2026-07-04):
      // - changedByPath: files harvested from SUCCESSFUL mutation results
      //   only. The old source was `patch.preview` — which permission RULES
      //   publish BEFORE the user decides — so a denied (or post-approval
      //   failed) edit still entered `changedFiles`, the done-marker read
      //   `完成 · 1 file`, and the false fact flowed into the next
      //   dispatch's working history (ADR 0010 poisoned). Map keyed by path
      //   so a file edited twice counts once (latest wins).
      // - okEvidence: only successful tool results argue for "completed" —
      //   a run whose sole evidence is `denied`/failures must not claim it.
      // - deniedPermissions: makes the `blocked` status reachable.
      // "deleted" only ever arrives from the committed-range attribution
      // (2026-08-26) — no editor can delete, which is exactly why the range
      // matters: the highest-blast-radius operation was the one the report
      // was structurally blind to.
      const changedByPath = new Map<
        string,
        {
          path: string;
          kind: "created" | "modified" | "deleted";
          diffSummary: string;
        }
      >();
      // For undo (ADR 0074 §2): whether a command ran, and the paths the
      // attribution below credits to commands rather than an editor. Undo
      // restores only what the editors wrote; these are what it names as
      // left alone.
      let commandRan = false;
      let commandsAttributed = false;
      const commandPaths = new Set<string>();
      let okEvidence = 0;
      let deniedPermissions = 0;
      // A continued run's report speaks for the whole task: the files
      // changed before the interruption count (ADR 0071 §1.5). Their diff is
      // not kept, so no line totals are claimed for them.
      for (const f of resume?.changedFiles ?? []) {
        changedByPath.set(f.path, {
          path: f.path,
          kind: f.kind,
          diffSummary: "changed before the interruption",
        });
      }

      // The dispatch BASELINE. `changedByPath` above only ever learns about a
      // path from one of the three editors, and `bash` is not one of them — so
      // on the DEFAULT (minimal) contract every `sed -i`, heredoc, `mv`, `rm`,
      // formatter and codemod contributed nothing, and a commission that did
      // real work reported `完成 · 0 个文件`. Neither editor can delete at all,
      // so the highest-blast-radius operation was the one the attribution was
      // structurally blind to.
      //
      // Taken at START as well as END, and the difference is what this
      // dispatch is credited with. Without the start snapshot an end-only
      // status would report the USER's own pre-existing uncommitted work as
      // 板砖's — the same lie inverted.
      // The frame's repo snapshot (ADR 0049 §2) rides the same instant —
      // gathered in parallel; every wrapper swallows its own failures. The
      // project-memory recall (ADR 0060) joins them: one small file read
      // per dispatch, skipped when the caller already decided the text.
      // A continued run rebuilds its base frame from the journal: the same
      // inputs, so the same prompt (ADR 0071 §1.5). Only the baseline is
      // taken afresh — it is what this segment is credited against.
      const frameIn = resume?.start.frame;
      const lang = frameIn?.lang ?? opts.lang ?? "zh";
      const [baseline, repoContext, recalledMemory] = await Promise.all([
        this.probeRepo(opts.signal),
        frameIn !== undefined
          ? Promise.resolve(frameIn.repoContext ?? null)
          : this.describeRepo(opts.signal),
        frameIn !== undefined
          ? Promise.resolve(frameIn.scopedMemory)
          : opts.scopedMemory === undefined
            ? this.recallScopedMemory(lang)
            : Promise.resolve(opts.scopedMemory),
      ]);

      const absorb = (event: AgentEvent): void => {
        // Backend-layer only (audit 2026-07-10 §6): the per-session bus is
        // shared with the actor layer. Today no actor-layer event of the
        // absorbed types fires during a brief, but a future actor-layer
        // tool.call.finished / permission.* would silently contaminate this
        // report — filter at the subscription, not by luck.
        if (event.layer !== "backend") return;
        type WithTestRun = { testRun?: TestRunSummary };
        switch (event.type) {
          case "tool.call.finished": {
            // A recorded finding is the backend's own conclusion, not a tool
            // receipt (ADR 0039): its own evidence kind, so the done marker
            // can list conclusions apart from receipts — and it argues for
            // 完成 on a brief whose deliverable IS the conclusion (the 1.2
            // rule below excludes read-only tools because they only prove
            // execution; a cited finding is a delivered result).
            if (event.tool === "report_finding" && event.result.ok) {
              const data = event.result.data as unknown as
                | { claim?: unknown; cites?: unknown }
                | undefined;
              const claim =
                typeof data?.claim === "string"
                  ? data.claim
                  : event.result.summary;
              const cites = Array.isArray(data?.cites)
                ? data.cites.filter((c): c is string => typeof c === "string")
                : [];
              builder.addEvidence({
                kind: "finding",
                summary: claim,
                source: cites.join(", "),
              });
              okEvidence += 1;
              break;
            }
            builder.addEvidence({
              kind: "tool",
              summary: event.result.summary,
              source: event.id,
            });
            // Only tools that CHANGE something count toward a completion
            // claim (audit 2026-07-24, 1.2). `ToolResult.ok` means the tool
            // EXECUTED, not that the task advanced — so read_file, glob,
            // search_text, git_status and friends all argued for
            // "completed", and a backend that read three files and said "that
            // function doesn't exist here, I can't do this" reported 完成.
            // That marker is durable, Herta reads it as ground truth
            // (supervisor rule 9), and it re-enters the next dispatch's
            // workingHistory as the fact 完成.
            //
            // run_command carries the same trap one level down: the tool
            // returns ok:true for EVERY exit code (running the command is
            // what succeeded), so a failing build was completion evidence.
            // It argues for 完成 only at exit 0 — a non-zero exit or a
            // background start (exitCode null) proves nothing about the
            // task, only about the shell.
            if (event.result.ok && MUTATING_TOOLS.has(event.tool)) {
              const exit = COMMAND_TOOLS.has(event.tool)
                ? (event.result.data as unknown as RunCommandData | undefined)
                    ?.exitCode
                : event.tool === "str_replace_editor"
                  ? // Only a WRITE argues for completion; `view` is a read.
                    (event.result.data as unknown as { wrote?: unknown })
                      ?.wrote === true
                    ? 0
                    : undefined
                  : 0;
              if (exit === 0) okEvidence += 1;
            }
            // A command that ran and could write — not a read, a test, a
            // version query (ADR 0074 §2; `git status` in a folder with no
            // repository was reported as an unknown change, live 2026-10-07),
            // nor one whose only writes went to files undo holds.
            const commandData = COMMAND_TOOLS.has(event.tool)
              ? (event.result.data as unknown as RunCommandData | undefined)
              : undefined;
            if (
              COMMAND_TOOLS.has(event.tool) &&
              event.result.ok &&
              commandData?.readOnly !== true &&
              commandData?.writesAccounted !== true
            ) {
              commandRan = true;
            }
            // The files its redirections wrote are written files, as an
            // editor's are (ADR 0074 amendment, 2026-10-08): the report lists
            // them, and the git attribution below no longer credits them to
            // commands — undo restores them. Whatever the command's exit:
            // they are on disk either way.
            for (const w of commandData?.redirectWrites ?? []) {
              changedByPath.set(w.relPath, {
                path: w.relPath,
                kind: w.created ? "created" : "modified",
                diffSummary: `+${w.added} -${w.removed}`,
              });
            }
            if (COMMAND_TOOLS.has(event.tool) && event.result.ok) {
              const data = event.result.data as unknown as
                | WithTestRun
                | undefined;
              if (data?.testRun !== undefined) {
                builder.addTest(data.testRun);
              }
            }
            if (WRITING_TOOLS.has(event.tool) && event.result.ok) {
              const data = event.result.data as unknown as
                | { relPath?: unknown; diff?: unknown; created?: unknown }
                | undefined;
              const path =
                typeof data?.relPath === "string" ? data.relPath : undefined;
              if (path !== undefined) {
                changedByPath.set(path, {
                  path,
                  kind:
                    event.tool === "write_new_file" || data?.created === true
                      ? "created"
                      : "modified",
                  diffSummary:
                    typeof data?.diff === "string"
                      ? summarizeDiff(data.diff)
                      : event.result.summary,
                });
              }
            }
            if (event.result.ok === false && event.result.error !== undefined) {
              builder.addResidualRisk(
                `Tool ${event.id} failed: ${event.result.error.message}`,
              );
            }
            break;
          }
          case "permission.requested": {
            pendingPermissions.set(event.request.id, {
              tool: event.request.call.tool,
              risk: event.request.risk,
            });
            break;
          }
          case "permission.resolved": {
            const pending = pendingPermissions.get(event.id);
            // "blocked" (rule-deny) has no matching permission.requested —
            // the event carries its own tool; risk stays "unknown" (the
            // engine denied outright without classifying a risk level).
            const tool = pending?.tool ?? event.tool ?? event.id;
            const risk = pending?.risk ?? "unknown";
            builder.addPermission({
              tool,
              risk,
              decision: event.decision,
              summary: `${tool} ${event.decision}`,
            });
            // Blocked counts like denied for the status gate (finding 6): a
            // run whose mutations were refused — by the user OR by policy —
            // must not report 完成. The intent has always named MUTATIONS
            // (git-dev lab 2026-08-26): a withheld READ (the reader guard
            // refusing a `.git`/`.herta` probe the model then routed around)
            // and a call error capped fully completed briefs at 部分完成. A
            // call error is a rule-deny whose same change, asked correctly,
            // would be allowed — a malformed argument, an edit anchor that
            // does not match, a file not read first (the one set that says
            // which codes: permission-deny-codes.ts, ADR 0047 amendment
            // 2026-09-29). A user deny carries its risk on the request; a
            // rule-deny carries it on the event; anything without a stated
            // risk or a decided code still counts, conservatively.
            if (event.decision === "deny" || event.decision === "blocked") {
              const refusedRisk =
                event.decision === "deny" ? pending?.risk : event.risk;
              const withheldRead = refusedRisk === "workspace_read";
              const callError =
                event.decision === "blocked" &&
                event.code !== undefined &&
                CALL_ERROR_DENY_CODES.has(event.code);
              if (!withheldRead && !callError) deniedPermissions += 1;
            }
            pendingPermissions.delete(event.id);
            break;
          }
          default:
            break;
        }
      };

      // Subscribe via bus.onAny so we observe events published directly
      // by tools/permission rules (e.g. patch.preview) in addition to the
      // ones yielded by the turn loop. The turn loop's emit() also routes
      // through the bus, so this single subscription is the canonical
      // channel for absorb.
      const unsubscribe = this.deps.bus.onAny(absorb);

      const turnDeps = {
        sessionId: this.deps.sessionId,
        provider: this.deps.provider,
        tools: this.deps.tools,
        permissions: this.deps.permissions,
        backendBuilder: this.deps.backendBuilder,
        transcript,
        bg,
        findings,
        bus: this.deps.bus,
        clock: this.deps.clock,
        workspaceRoot: this.deps.workspaceRoot,
        reads,
        memory: this.deps.memory,
        ...(this.deps.budget !== undefined ? { budget: this.deps.budget } : {}),
        // Read only once old iterations have been dropped (working-state.ts).
        workingState: () => ({
          changedFiles: [...changedByPath.values()],
          background: bg
            .list()
            .filter((p) => p.isRunning())
            .map((p) => ({ id: p.id, command: p.argv.join(" ") })),
          findings: findings.all(),
          steers,
        }),
      };
      const handle = {
        signal: opts.signal ?? new AbortController().signal,
        userMessages: frameIn?.userMessages ?? opts.userMessages ?? [],
        omittedUserMessages:
          frameIn?.omittedUserMessages ?? opts.omittedUserMessages ?? 0,
        scopedRepoInstructions:
          frameIn?.scopedRepoInstructions ?? opts.scopedRepoInstructions ?? "",
        scopedMemory: recalledMemory,
        recentDialogue: frameIn?.recentDialogue ?? opts.recentDialogue ?? "",
        workingHistory: frameIn?.workingHistory ?? opts.workingHistory ?? "",
        lang,
        ...(repoContext !== null ? { repoContext } : {}),
        ...(this.deps.pendingUserInput !== undefined
          ? { takePendingUserInput: this.deps.pendingUserInput }
          : {}),
      };

      if (this.deps.journalPath !== undefined && resume !== null) {
        // The same journal, continued: the closers a stopped run still owed,
        // then the `resume` entry that opens this segment — both durable
        // before any step runs.
        journal = await DispatchJournal.reopen(this.deps.journalPath, {
          live: true,
        });
        for (const c of resume.newClosers) {
          await journal.append({ kind: "closer", ...c });
        }
        try {
          await journal.appendDurable({
            kind: "resume",
            at: this.deps.clock().toISOString(),
            ...(opts.recordLength !== undefined
              ? { recordLength: opts.recordLength }
              : {}),
          });
          await markJournalOpen(this.deps.journalPath, true);
        } catch {
          // A failed journal refuses every step with a side effect (the
          // loop's fail-closed rule); the run itself goes on.
        }
      } else if (this.deps.journalPath !== undefined) {
        journal = await DispatchJournal.begin(this.deps.journalPath, {
          kind: "start",
          v: DISPATCH_JOURNAL_VERSION,
          taskId: brief.taskId,
          at: this.deps.clock().toISOString(),
          ...(this.deps.contract !== undefined
            ? { contract: this.deps.contract }
            : {}),
          ...(opts.recordLength !== undefined
            ? { recordLength: opts.recordLength }
            : {}),
          workspaceRoot: this.deps.workspaceRoot,
          host: currentJournalHost(),
          brief,
          frame: {
            userMessages: handle.userMessages,
            omittedUserMessages: handle.omittedUserMessages,
            scopedRepoInstructions: handle.scopedRepoInstructions,
            scopedMemory: handle.scopedMemory,
            recentDialogue: handle.recentDialogue,
            workingHistory: handle.workingHistory,
            lang,
            ...(repoContext !== null ? { repoContext } : {}),
          },
        });
        if (!journal.failed) {
          await markJournalOpen(this.deps.journalPath, true);
        }
      }
      // This run is a segment of the undo store: its writers leave what they
      // replace there, under the record length it began at. Best effort:
      // the store never fails the run.
      if (this.deps.undoDir !== undefined && opts.recordLength !== undefined) {
        undo = await UndoStore.open(this.deps.undoDir);
        undoSegment = undo.openSegment(opts.recordLength, brief.taskId);
      }
      const turnDepsWithJournal = {
        ...turnDeps,
        ...(journal !== undefined ? { journal } : {}),
        ...(undoSegment !== undefined ? { undo: undoSegment.undo } : {}),
      };

      let stoppedBackground = 0;
      try {
        for await (const event of runBackendTurnLoop(
          turnDepsWithJournal,
          brief,
          handle,
        )) {
          if (event.type === "turn.failed") {
            failed = true;
            // Keep the KIND, not just the fact (audit 2026-07-24, 1.4). The
            // loop already separates an interrupt from an internal failure;
            // collapsing both into `failed` is what made a user's Stop read
            // as "板砖 broke".
            lastErrorKind = event.error.kind;
            // Why the run ended leads the risks, so the done-marker's first
            // five keep it (2026-09-29 long-run study, proposal 1).
            builder.addResidualRisk(
              event.error.kind === "interrupted"
                ? `Turn interrupted: ${event.error.message}`
                : event.error.kind === "step_limit"
                  ? `Turn stopped: ${event.error.message}`
                  : `Turn failed: ${event.error.message}`,
              { leading: true },
            );
          }
        }
      } finally {
        unsubscribe();
        // No unmanaged backgrounding (ADR 0025 slice 4): whatever the model
        // left running dies with the brief — on success, failure, AND abort
        // (this finally runs when the loop throws).
        stoppedBackground = await bg.stopAll();
      }
      if (stoppedBackground > 0) {
        builder.addResidualRisk(
          `${stoppedBackground} background command(s) still running at brief end were stopped`,
          { leading: true },
        );
      }

      // Attribute anything the editors did not report — shell writes, moves,
      // deletes — by diffing the workspace against the START snapshot. When
      // HEAD moved FORWARD (the new head descends from the old one — 板砖
      // committed or merged, the normal ending of a git brief), the committed
      // range is this dispatch's own work and attributes too (2026-08-26; the
      // blanket refusal below used to fire on nearly every git brief and
      // swallowed shell-written files the moment the model committed them).
      if (baseline !== null) {
        const after = await this.probeRepo(opts.signal);
        const range =
          after === null ||
          after.head === baseline.head ||
          baseline.head === null ||
          after.head === null
            ? null
            : await this.rangeDiff(baseline.head, after.head, opts.signal);
        if (
          after !== null &&
          (after.head === baseline.head || range !== null)
        ) {
          commandsAttributed = true;
          const wasDirty = new Set(baseline.dirty);
          for (const f of range ?? []) {
            // Already dirty before the brief: partly the user's edit, even
            // if this dispatch committed it — outside this mechanism's
            // reach, and the carried note below says so.
            if (wasDirty.has(f.path)) continue;
            if (changedByPath.has(f.path)) continue;
            changedByPath.set(f.path, {
              path: f.path,
              kind: f.kind,
              diffSummary: "changed and committed during this dispatch",
            });
            commandPaths.add(f.path);
          }
          for (const path of after.dirty) {
            // Already dirty before the brief: outside this mechanism's reach.
            // The report says so rather than claiming it.
            if (wasDirty.has(path)) continue;
            if (changedByPath.has(path)) continue; // an editor already named it
            changedByPath.set(path, {
              path,
              kind: "modified",
              diffSummary: "changed via a command (no per-file diff)",
            });
            commandPaths.add(path);
          }
          const carried = baseline.dirty.filter((p) => !changedByPath.has(p));
          if (carried.length > 0) {
            builder.addResidualRisk(
              `${carried.length} file(s) were already modified before this dispatch and are not attributed to it: ${carried.slice(0, 5).join(", ")}${carried.length > 5 ? ", …" : ""}`,
              { leading: true },
            );
          }
        } else if (after !== null && after.head !== baseline.head) {
          // HEAD moved somewhere the old head cannot reach (rebase, amend,
          // reset, history rewrite) — or the range could not be read. "Dirty
          // vs HEAD" no longer describes the same tree at both ends; say
          // that instead of computing a difference that means nothing.
          builder.addResidualRisk(
            "HEAD moved during this dispatch, so file changes could not be attributed by comparing against the starting commit",
            { leading: true },
          );
        }
      }

      // What the commands changed, for undo (ADR 0074 §2): the attribution's
      // paths when there was one; otherwise only that commands ran.
      if (undoSegment !== undefined) {
        if (commandsAttributed) {
          if (commandPaths.size > 0) {
            await undoSegment.noteCommands([...commandPaths]);
          }
        } else if (commandRan) {
          await undoSegment.noteCommands(null);
        }
      }

      // Flush the applied-write harvest (deduped by path) into the report.
      for (const file of changedByPath.values()) {
        builder.addChangedFile(file);
      }

      if (failed) {
        // An interrupt is a distinct ending, not a failure (1.4). So is the
        // step limit: the run stopped where it stood, and it can be
        // continued like an interrupted one (2026-09-29, proposal 3).
        builder.setStatus(
          lastErrorKind === "interrupted" || lastErrorKind === "step_limit"
            ? "interrupted"
            : "failed",
        );
        if (lastErrorKind === "step_limit") builder.setEndedBy("step_limit");
      } else {
        const partialReport = this.peekReport(builder);
        // tests[] carries failing runs too (that is its job — the report
        // must show them). Only a PASS argues for 完成; a run whose sole
        // evidence is a failing suite is `partial`, exactly like the
        // all-failures comment below says. (The exit-0 gate on okEvidence
        // already covers non-test commands.)
        const hasOkEvidence =
          okEvidence > 0 ||
          partialReport.tests.some((t) => t.status === "passed") ||
          partialReport.changedFiles.length > 0;
        if (deniedPermissions > 0) {
          // A refusal is a FIRST-CLASS term, not a tie-breaker (audit
          // 2026-07-24, 1.3). It used to decide ONLY when nothing landed,
          // and otherwise fell straight through to the completed/partial
          // split with no denial term at all — so a PARTIALLY refused run
          // (model edits file A with approval, user denies file B) reported
          // 完成: the machine claim both the user and Herta read said work
          // they had explicitly refused was done, the denial surviving only
          // as a residual-risk line. A refusal now CAPS the status.
          //
          // "Landed" is mutations/verification — deliberately NOT
          // `hasOkEvidence`, which would call a run that only READ things
          // "partial" instead of 受阻 (and see 1.2 on that counting
          // generally).
          const landed =
            partialReport.changedFiles.length > 0 ||
            partialReport.tests.length > 0;
          builder.setStatus(landed ? "partial" : "blocked");
        } else {
          // Only SUCCESSFUL tool results (or harvested tests/files) argue
          // for completion; a run whose evidence is all failures reports
          // partial rather than claiming success.
          builder.setStatus(hasOkEvidence ? "completed" : "partial");
        }
      }

      const report = builder.build();
      // The run ended, whatever its status: the journal says so, so a later
      // open does not take it for a run the app died in (ADR 0071 §1.2).
      if (journal !== undefined) {
        await journal.append({
          kind: "end",
          status: report.status,
          // A continued run is told why this one stopped (journal-seal.ts).
          ...(report.endedBy === "step_limit"
            ? { cause: "step-limit" as const }
            : {}),
        });
        // Its processes were stopped above (`bg.stopAll`): nothing for a
        // relaunch to reap (ADR 0071 §1.6).
        if (this.deps.journalPath !== undefined) {
          await markJournalOpen(this.deps.journalPath, false);
        }
      }
      return report;
    } finally {
      await journal?.close();
      await undo?.close();
      this.briefInFlight = false;
    }
  }

  private peekReport(builder: ExecutionReportBuilder): AgentExecutionReport {
    return builder.setStatus("partial").build();
  }
}

/**
 * The `+N -M` a changed file reports. Through the ONE diff-line counter
 * (`text/diff-lines.ts`): this used to be a fifth private copy with the
 * exact defect that counter was written to fix — a deleted line whose text
 * begins with `--` (YAML front matter, a markdown rule, an SQL comment)
 * read as a `---` header and was dropped, so the done marker under-counted
 * work the record presents as ground truth. Exported for the test.
 */
export function summarizeDiff(diff: string): string {
  const { add, del } = countDiffLines(diff);
  return `+${add} -${del}`;
}
