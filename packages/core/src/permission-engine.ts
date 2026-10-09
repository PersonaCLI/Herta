import { randomUUID } from "node:crypto";
import type { PermissionRequest } from "./types/events.js";
import type { ToolCallRequest, ToolContext } from "./types/tool.js";

export type RiskLevel =
  | "workspace_read"
  | "workspace_write"
  | "workspace_destructive"
  | "network";

/**
 * What a command will do to work the harness cannot get back (ADR 0049 §5)
 * — a neutral machine code (D2) the display surfaces map to one localized
 * sentence on the approval card. INFORMATIONAL ONLY: never consulted by
 * verdicts, the approval cache, or rule derivation (the CC
 * destructive-command-warning pattern — the note explains, the tier
 * enforces).
 */
export type CommandConsequence =
  | "discards_uncommitted"
  | "deletes_untracked"
  | "deletes_stash"
  | "rewrites_local_history"
  | "rewrites_remote_history"
  | "concludes_in_progress_operation";

export type RuleVerdict =
  | { kind: "allow" }
  | {
      kind: "ask";
      reason: string;
      risk: RiskLevel;
      /** Stable machine code for the ask class (e.g. "command_ask_unknown").
       *  Renderers localize the user-facing summary by this code (the reason
       *  string stays the neutral-English machine contract per D2). */
      code?: string;
      diff?: string;
      files?: readonly string[];
      /** The EFFECTIVE program argv the RULE derived (ADR 0040), for tools
       *  whose input is not argv-shaped: the minimal contract's `bash` hands
       *  over the single program a command line really runs (after the
       *  model's `cd <workspace> &&` prefix) — `["git","commit","-m","x"]` —
       *  or nothing when the line runs several programs, an interpreter body
       *  or a redirect outside the workspace. The approval cache scopes by
       *  its argv[0] and ADR 0030 project rules derive from it, exactly as
       *  they do from run_command's argv. Absent for every other tool. */
      argv?: readonly string[];
      /** The distinct programs a multi-segment shell line runs (ADR 0040),
       *  readers/builtins excluded — for the task-scoped approval CACHE only
       *  (`git add && git commit && git status` is a "git" line the way a
       *  run_command `git commit` is). Rules never derive from this: a
       *  chained line has no single argv to pin. */
      programs?: readonly string[];
      /** Every DISTINCT ask class a chained line carries, `code` first
       *  (2026-08-17): the card labels the line by `code` (highest risk) and
       *  names the rest — `kill 574; curl localhost` is "network" AND
       *  "ends processes". Absent or length 1 → nothing extra to say. */
      codes?: readonly string[];
      /** One-sentence consequence note for the card (ADR 0049 §5); see
       *  {@link CommandConsequence}. Display-only, absent for most asks. */
      consequence?: CommandConsequence;
    }
  | {
      kind: "deny";
      reason: string;
      code?: string;
      /** Model-facing text for the refusal (ADR 0040): the minimal
       *  contract's rules answer in the trained shape's own strings, which
       *  the loop sends verbatim instead of `failed: <code>` + JSON. Absent
       *  → the loop's default rendering (unchanged for every other rule). */
      modelText?: string;
      /** The move that fixes the refusal (2026-09-18) — the corrective half
       *  every tool failure carries, for a rule-deny whose code the loop's
       *  own table does not know (an editor's `edit_not_found`, say). Wins
       *  over the loop's default suggestion when present. */
      suggestion?: string;
      /** The tier of what was REFUSED, when the rule can say (2026-08-26).
       *  A `workspace_read` refusal is a withheld read, not a refused
       *  mutation, and must not cap the brief's status — the git-dev lab
       *  caught the reader guard's `.git`/`.herta` denials capping fully
       *  completed briefs at 部分完成. Absent → the status gate stays
       *  conservative and counts the denial. */
      risk?: RiskLevel;
    };

export type PermissionRule = (
  call: ToolCallRequest,
  ctx: ToolContext,
) => RuleVerdict | Promise<RuleVerdict>;

/**
 * A denial an automatic reviewer gave in the owner's place (ADR 0075). The
 * loop sends the agent its reason, not "User denied", and says not to reach
 * the same outcome another way — an agent told no looks for a side door.
 */
export interface ReviewerDenial {
  readonly decision: "deny";
  readonly by: "reviewer";
  /** One sentence, in the language the reviewer wrote it. */
  readonly reason: string;
}

/** What an ask settles to: the owner's allow or deny, or a reviewer's
 *  denial. A reviewer's allow is a plain "allow". */
export type AskAnswer = "allow" | "deny" | ReviewerDenial;

export interface AskResolver {
  present(request: PermissionRequest, signal: AbortSignal): Promise<AskAnswer>;
}

export type PermissionDecision =
  | { kind: "allow" }
  | {
      kind: "ask";
      request: PermissionRequest;
      decision: Promise<AskAnswer>;
    }
  | {
      kind: "deny";
      reason: string;
      code?: string;
      modelText?: string;
      /** See RuleVerdict deny — the rule's own corrective hint. */
      suggestion?: string;
      /** See RuleVerdict deny — threaded so the status gate can tell a
       *  withheld read from a refused mutation. */
      risk?: RiskLevel;
    };

export interface PermissionEngine {
  check(call: ToolCallRequest, ctx: ToolContext): Promise<PermissionDecision>;
  resolve(requestId: string, decision: "allow" | "deny"): void;
}

export class NoopPermissionEngine implements PermissionEngine {
  async check(
    _call: ToolCallRequest,
    _ctx: ToolContext,
  ): Promise<PermissionDecision> {
    return { kind: "allow" };
  }
  resolve(_requestId: string, _decision: "allow" | "deny"): void {
    // unreachable in slice B
  }
}

export class RulePermissionEngine implements PermissionEngine {
  private readonly rules = new Map<string, PermissionRule>();
  private readonly ask: AskResolver;

  constructor(deps: { ask: AskResolver }) {
    this.ask = deps.ask;
  }

  registerRule(toolName: string, rule: PermissionRule): void {
    if (this.rules.has(toolName)) {
      throw new Error(`duplicate rule for tool: ${toolName}`);
    }
    this.rules.set(toolName, rule);
  }

  async check(
    call: ToolCallRequest,
    ctx: ToolContext,
  ): Promise<PermissionDecision> {
    const rule = this.rules.get(call.tool);
    const verdict: RuleVerdict = rule
      ? await rule(call, ctx)
      : { kind: "allow" };

    if (verdict.kind === "allow") return { kind: "allow" };
    if (verdict.kind === "deny") {
      return {
        kind: "deny",
        reason: verdict.reason,
        code: verdict.code,
        ...(verdict.modelText !== undefined
          ? { modelText: verdict.modelText }
          : {}),
        ...(verdict.suggestion !== undefined
          ? { suggestion: verdict.suggestion }
          : {}),
        ...(verdict.risk !== undefined ? { risk: verdict.risk } : {}),
      };
    }

    const id = randomUUID();
    const request: PermissionRequest = {
      id,
      call,
      reason: verdict.reason,
      risk: verdict.risk,
      code: verdict.code,
      diff: verdict.diff,
      files: verdict.files,
      ...(verdict.argv !== undefined ? { argv: verdict.argv } : {}),
      ...(verdict.programs !== undefined ? { programs: verdict.programs } : {}),
      ...(verdict.codes !== undefined ? { codes: verdict.codes } : {}),
      ...(verdict.consequence !== undefined
        ? { consequence: verdict.consequence }
        : {}),
    };
    const decision = this.ask.present(request, ctx.signal);
    return { kind: "ask", request, decision };
  }

  resolve(_requestId: string, _decision: "allow" | "deny"): void {
    // no-op; reserved for out-of-band resolution flows
  }
}
