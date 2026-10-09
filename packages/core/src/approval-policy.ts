import {
  deriveProjectCommandRule,
  isRuleEligibleAskCode,
  type ProjectCommandRuleStore,
  ruleDisplay,
} from "./project-command-rules.js";
import {
  permissionCacheScope,
  type SessionApprovalCache,
} from "./session-approval-cache.js";
import type { PermissionRequest } from "./types/events.js";
import { undoableWrite } from "./undoable-write.js";

/** Policy options (ADR 0064 amendment 2026-10-10, ADR 0075). */
export interface ApprovalPolicyOpts {
  /** Whether automatic review is on by default in the CURRENT workspace
   *  when the owner has not chosen: the session's managed sandbox is
   *  (nothing of theirs is in it), a real project is not. A provider — the
   *  workspace can move mid-session. Absent → off by default (the CLI). */
  readonly defaultAutoReview?: () => boolean;
  /** Whether a mounted reviewer would take this request (a command it may
   *  judge). Absent → no reviewer: turning review on then only lets the
   *  undoable writes through. */
  readonly reviewable?: (request: PermissionRequest) => boolean;
}

/**
 * The part of a permission ask that is POLICY, not presentation (D4): which
 * asks never reach the user because a task-scoped remember (ADR 0026) or a
 * persisted project rule (ADR 0030) already covers them, which persistence
 * offers the surface may show, and what a granted persistence writes back.
 *
 * Both user-facing resolvers — the CLI's `CachingAskResolver` (stdout
 * prompt) and the app-server's `OverlayAskResolver` (GUI overlay) — carried
 * their own copy of this until 2026-08-19, and every audit fix to the policy
 * (T3.4 scoped cache keys, BL15 cwd-scoped rules, ADR 0040 bash argv) had to
 * land twice. One policy object; the resolvers only render and await.
 *
 * Every decision re-derives from the LIVE request: a caller can never pass a
 * rule shape of its own, and the rule-eligibility gate (`isRuleEligibleAskCode`)
 * runs on the ask code the rule authored, so a hand-edited rules file can
 * never cover a destructive/network/reader ask.
 */
export class ApprovalPolicy {
  constructor(
    private readonly cache: SessionApprovalCache,
    private readonly rules?: ProjectCommandRuleStore,
    private readonly opts: ApprovalPolicyOpts = {},
  ) {}

  /**
   * Whether automatic review is on in this workspace: the owner's explicit
   * choice in the permissions file, else the host's default for the
   * workspace kind. Without a rule store there is nowhere to record a
   * choice, so only the default applies.
   */
  autoReviewOn(): boolean {
    const explicit = this.rules?.autoReview() ?? null;
    if (explicit !== null) return explicit;
    return this.opts.defaultAutoReview?.() === true;
  }

  /**
   * Decide before prompting. `auto` → the ask is already covered (the surface
   * may note it, e.g. the CLI's dim auto-allow line); `ask` → prompt, showing
   * only the persistence choices that would actually take effect.
   */
  preflight(request: PermissionRequest): ApprovalPreflight {
    const tool = request.call.tool;
    const risk = request.risk;
    // The per-call scope: argv[0] for commands, the constant task scope for
    // file writes (audit T3.4 / ADR 0026). A remember covers only that
    // binary / that task's writes, never the whole risk class.
    const scope = permissionCacheScope(request);
    if (this.cache.has(tool, risk, scope)) {
      return { kind: "auto", via: "cache", scope };
    }

    // With automatic review on, a request whose every change undo can take
    // back runs without a review (ADR 0064 amendment 2026-10-10). The record
    // still shows the row and the diff; only the card is skipped.
    const on = this.autoReviewOn();
    const undoable = undoableWrite(request);
    if (on && undoable) {
      return { kind: "auto", via: "undoable_write", scope };
    }

    // Project-rule hit (ADR 0030): persistent auto-allow, gated on the LIVE
    // ask code being rule-eligible. The cwd is part of the grant (audit BL15)
    // — the same `node src/index.mjs` in a different directory is a
    // different script.
    const argv = commandArgv(request);
    const cwd = commandCwd(request);
    const eligible = argv !== null && isRuleEligibleAskCode(request.code);
    if (eligible && this.rules?.matches(argv, cwd) === true) {
      return { kind: "auto", via: "project_rule", scope, argv };
    }

    // Offer "remember" only when the eventual cache.add() would actually
    // store this tuple (same key), and the project-rule choice only when a
    // rule is derivable from this exact argv — a button/option that would
    // silently no-op and re-prompt must not appear (audit T3.4 follow-up).
    const derived =
      eligible && this.rules !== undefined
        ? deriveProjectCommandRule(argv)
        : null;
    return {
      kind: "ask",
      scope,
      showRemember: this.cache.isCacheable(tool, risk, scope),
      projectRule: derived === null ? undefined : ruleDisplay(derived),
      // Offer turning automatic review on only where it would take effect:
      // it is off, there is a store to record the choice in, and the
      // request is one it would let through or hand to the reviewer.
      showAutoReview:
        !on && this.rules !== undefined && this.reviewTakes(request),
    };
  }

  /**
   * Write back a granted persistence. Re-derives from the live request like
   * `preflight` — never trusts caller-supplied shapes. Non-derivable
   * requests no-op (the cache's own guards also refuse an uncacheable tuple).
   */
  commit(request: PermissionRequest, persistence: ApprovalPersistence): void {
    if (persistence === "once") return;
    if (persistence === "auto_review") {
      // The choice is the WORKSPACE's, not this request's — and only where
      // it would take effect (`showAutoReview`): never from a card no
      // review could ever answer.
      if (this.rules !== undefined && this.reviewTakes(request)) {
        this.rules.setAutoReview(true);
      }
      return;
    }
    if (persistence === "session") {
      this.cache.add(
        request.call.tool,
        request.risk,
        permissionCacheScope(request),
      );
      return;
    }
    // "always" → project rule (ADR 0030).
    if (this.rules === undefined) return;
    const argv = commandArgv(request);
    if (argv === null || !isRuleEligibleAskCode(request.code)) return;
    const rule = deriveProjectCommandRule(argv);
    if (rule !== null) this.rules.add({ ...rule, cwd: commandCwd(request) });
  }

  /** Automatic review would answer this request: an undoable write, or a
   *  command a mounted reviewer may judge. */
  private reviewTakes(request: PermissionRequest): boolean {
    return undoableWrite(request) || this.opts.reviewable?.(request) === true;
  }
}

/** How long a granted allow should outlive this one ask. `auto_review` is
 *  not about this ask at all: it turns automatic review on for the
 *  workspace, and allows this one. */
export type ApprovalPersistence = "once" | "session" | "always" | "auto_review";

export type ApprovalPreflight =
  | {
      readonly kind: "auto";
      readonly via: "cache" | "project_rule" | "undoable_write";
      readonly scope: string | undefined;
      /** The matched command argv (project-rule hits only). */
      readonly argv?: readonly string[];
    }
  | {
      readonly kind: "ask";
      readonly scope: string | undefined;
      /** Offer the task-scoped remember choice. */
      readonly showRemember: boolean;
      /** Display form of the rule an "always" grant would persist; undefined
       *  → hide the project-rule choice. */
      readonly projectRule: string | undefined;
      /** Offer turning automatic review on: it is off here, and it would
       *  answer this request. */
      readonly showAutoReview: boolean;
    };

/**
 * The argv of a command permission request, or null for other tools /
 * malformed input. Fail-closed: any non-string token → null.
 * - `run_command` → the call's own argv.
 * - `bash` (minimal contract, ADR 0040) → the RULE's derived effective argv
 *   (the single program after the `cd <workspace> &&` prefix) — the same
 *   shape run_command carries, so rule derivation / matching are one code
 *   path. Absent → not rule-eligible.
 */
export function commandArgv(request: PermissionRequest): string[] | null {
  if (request.call.tool === "bash") {
    const argv = request.argv;
    return argv !== undefined && argv.length > 0 ? [...argv] : null;
  }
  if (request.call.tool !== "run_command") return null;
  const input = request.call.input;
  if (typeof input !== "object" || input === null) return null;
  const argv = (input as { argv?: unknown }).argv;
  if (!Array.isArray(argv) || argv.length === 0) return null;
  if (!argv.every((a): a is string => typeof a === "string")) return null;
  return argv;
}

/** The call's cwd (workspace-relative, model-supplied), or undefined for the
 *  workspace root — `run_command`'s own default (audit BL15). */
export function commandCwd(request: PermissionRequest): string | undefined {
  const input = request.call.input;
  if (typeof input !== "object" || input === null) return undefined;
  const cwd = (input as { cwd?: unknown }).cwd;
  return typeof cwd === "string" ? cwd : undefined;
}
