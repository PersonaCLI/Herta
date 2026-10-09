/**
 * OverlayAskResolver — implements @herta/core's AskResolver interface for
 * the app-server. Instead of writing to stdout (like CliAskResolver), it
 * pends an overlay state and emits an OverlayEvent { kind: "pending" }; the
 * awaited promise resolves when Session.resolveApproval is called.
 *
 * Single-slot contract: the RulePermissionEngine asks one permission question
 * at a time (sequential tool-loop). OverlayAskResolver therefore holds at
 * most one pending Promise. A second concurrent ask would overwrite the
 * pending slot — this cannot happen given the engine's sequential contract,
 * but resolveExternal will still return { ok: false, reason: "stale_request" }
 * if the requestId doesn't match (defense-in-depth).
 *
 * The POLICY (cache / project-rule short-circuits, which persistence choices
 * to offer, what a grant writes back) is `@herta/core`'s `ApprovalPolicy`,
 * shared with the CLI's resolver; this class only renders and awaits.
 *
 * v0.3 Slice 2 Task 6.
 */
import {
  ApprovalPolicy,
  type ApprovalPreflight,
  type AskAnswer,
  type AskResolver,
  abortError,
  type PendingPermissionApproval,
  type PermissionRequest,
  type ProjectCommandRuleStore,
  type SessionApprovalCache,
} from "@herta/core";
import {
  type AutoReviewer,
  type ReviewVerdict,
  reviewAnswer,
} from "./auto-review.js";
import type { AutoReviewNotice } from "./types.js";

export interface OverlayAskResolverDeps {
  /**
   * Called when an ask request lands and an overlay should be surfaced to
   * the user. SessionImpl writes this into the exposed `overlay` snapshot
   * and emits an OverlayEvent { kind: "pending" }.
   */
  readonly setPendingOverlay: (overlay: PendingPermissionApproval) => void;
  /**
   * Called when the resolver resolves (allow or deny) so SessionImpl can
   * clear the pending overlay state and emit OverlayEvent { kind: "resolved" }.
   */
  readonly clearOverlay: (requestId: string) => void;
  /**
   * Session-scoped approval cache. When a request resolves with
   * persistence "session", the (tool, risk) pair is written here.
   * Subsequent identical asks short-circuit to "allow" without
   * surfacing a new overlay.
   */
  readonly cache: SessionApprovalCache;
  /**
   * Project-scoped command allow rules (ADR 0030). Consulted before
   * surfacing a rule-eligible run_command ask (a match short-circuits to
   * "allow", silent like a cache hit — the operation still projects its
   * → 系统 blocks into the record); written when a request resolves with
   * persistence "always" (the reserved value the v0.3 design doc §7 left
   * for exactly this store). Optional so hand-built test resolvers keep
   * their pre-0030 behavior.
   */
  readonly rules?: ProjectCommandRuleStore;
  /**
   * Whether the CURRENT workspace trusts by default (ADR 0064): the
   * session's managed sandbox does, a real project does not. A provider —
   * the workspace can move mid-session. Absent → never by default.
   */
  readonly defaultTrust?: () => boolean;
  /**
   * The automatic reviewer (ADR 0075), when one is mounted. Asked before the
   * card, only where the CURRENT workspace opted in; its allow or deny
   * settles the request without a card, and anything else shows the card.
   */
  readonly review?: {
    readonly reviewer: AutoReviewer;
    /** The owner opted the current workspace in. */
    readonly enabled: () => boolean;
    /** The user's messages, oldest first — what authorizes. */
    readonly userMessages: () => readonly string[];
    /** The current backend workspace root. */
    readonly workspace: () => string;
    /** Every decision, and the brake engaging — the owner sees each one
     *  (user-only, never the record: D7). */
    readonly onReviewed: (notice: AutoReviewNotice) => void;
  };
}

export type ResolveExternalResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "stale_request" | "no_pending_overlay";
    };

/** Constructed (core's `abortError`, not `signal.reason`) so the name is
 *  ALWAYS "AbortError" — a reason-less abort() or a custom reason must not
 *  demote the interrupt to `permission_failed`. */
const gateAbortError = (): Error =>
  abortError("permission gate aborted by interrupt");

export class OverlayAskResolver implements AskResolver {
  private pending: {
    readonly requestId: string;
    readonly request: PermissionRequest;
    readonly resolve: (decision: "allow" | "deny") => void;
  } | null = null;

  private readonly policy: ApprovalPolicy;

  constructor(private readonly deps: OverlayAskResolverDeps) {
    this.policy = new ApprovalPolicy(deps.cache, deps.rules, {
      ...(deps.defaultTrust !== undefined
        ? { defaultTrust: deps.defaultTrust }
        : {}),
    });
  }

  /** The policy's view of workspace trust (ADR 0064) — the session's
   *  trust surface reads it here so the two never disagree. */
  get workspaceTrusted(): boolean {
    return this.policy.workspaceTrusted();
  }

  /** A new user message: the reviewer's brake lifts (ADR 0075). */
  resetReviewBrake(): void {
    this.deps.review?.reviewer.resetBrake();
  }

  present(request: PermissionRequest, signal: AbortSignal): Promise<AskAnswer> {
    // Cache / project-rule hit: short-circuit without surfacing an overlay.
    const pre = this.policy.preflight(request);
    if (pre.kind === "auto") return Promise.resolve("allow");
    const review = this.deps.review;
    if (review?.enabled() === true) {
      return this.reviewFirst(review, request, pre, signal);
    }
    return this.surface(request, pre, signal);
  }

  /**
   * ADR 0075: the reviewer answers in the owner's place, or the card shows.
   * An abort while it reviews rejects like an abort at the card — no
   * decision is fabricated either way.
   */
  private async reviewFirst(
    review: NonNullable<OverlayAskResolverDeps["review"]>,
    request: PermissionRequest,
    pre: Extract<ApprovalPreflight, { kind: "ask" }>,
    signal: AbortSignal,
  ): Promise<AskAnswer> {
    if (signal.aborted) throw gateAbortError();
    const command = extractCommand(request);
    let verdict: ReviewVerdict;
    try {
      verdict = await review.reviewer.review(
        {
          request,
          command,
          workspace: review.workspace(),
          userMessages: review.userMessages(),
        },
        signal,
      );
    } catch {
      if (signal.aborted) throw gateAbortError();
      verdict = { kind: "card", why: "error" };
    }
    if (signal.aborted) throw gateAbortError();
    if (verdict.kind === "card") return this.surface(request, pre, signal);
    const at = new Date().toISOString();
    review.onReviewed({
      requestId: request.id,
      tool: request.call.tool,
      command: command ?? null,
      decision: verdict.kind,
      reason: verdict.rationale,
      at,
    });
    if (verdict.braked) {
      review.onReviewed({
        requestId: request.id,
        tool: request.call.tool,
        command: null,
        decision: "paused",
        reason: "",
        at,
      });
    }
    return reviewAnswer(verdict);
  }

  /** Show the card and await the owner. */
  private surface(
    request: PermissionRequest,
    pre: Extract<ApprovalPreflight, { kind: "ask" }>,
    signal: AbortSignal,
  ): Promise<AskAnswer> {
    const requestId = request.id;
    // An interrupted turn must settle a pending ask — but as an ABORT, not a
    // decision. Two prior states of this code were both wrong:
    //   1. The signal was ignored: interrupt during a gate left this promise
    //      pending forever — runBrief never returned, the turn never cleared,
    //      and every later submit threw "a turn is already in progress" until
    //      an app restart.
    //   2. The hang fix settled with resolve("deny") — which FABRICATED a
    //      user decision: the loop emitted permission.resolved{deny} plus a
    //      permission_denied tool result ("User denied <tool>"), and the
    //      false denial entered the report's residualRisks, the done-marker's
    //      ↳ 风险 line, Herta's prompt, and the next dispatch's working
    //      history — the ADR-0010 poisoned-history class (audit 2026-07-10,
    //      finding 4).
    // Rejecting with an AbortError keeps the settle (no wedge: the turn loop
    // rethrows aborts, emits turn.failed{interrupted}, and runBrief returns a
    // failed report — the same convergence as an interrupt landing mid-tool)
    // while producing NO permission.resolved event and NO fabricated tool
    // result. The overlay still clears so the renderer unlocks.
    if (signal.aborted) return Promise.reject(gateAbortError());
    return new Promise<AskAnswer>((resolve, reject) => {
      const onAbort = (): void => {
        // Only if still the pending slot (a user resolution wins the race).
        if (this.pending?.requestId !== requestId) return;
        this.pending = null;
        this.deps.clearOverlay(requestId);
        reject(gateAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // Overwrite any previous pending slot (shouldn't happen in practice —
      // the engine is sequential — but clear defensively).
      this.pending = {
        requestId,
        request,
        resolve: (decision) => {
          signal.removeEventListener("abort", onAbort);
          resolve(decision);
        },
      };
      const overlay: PendingPermissionApproval = {
        kind: "pending-permission",
        requestId,
        risk: request.risk,
        tool: request.call.tool,
        summary: request.reason,
        code: request.code,
        ...(request.codes !== undefined && request.codes.length > 1
          ? { codes: request.codes }
          : {}),
        ...(request.consequence !== undefined
          ? { consequence: request.consequence }
          : {}),
        command: extractCommand(request),
        diff: request.diff,
        files: request.files,
        // Gate the GUI "always allow (session)" button: only offer it when a
        // remembered choice would actually be cached for this request (the
        // policy uses the SAME (tool, risk, scope) the eventual cache.add()
        // will use), so the button never appears for a choice that would
        // silently no-op and re-prompt (audit T3.4 follow-up; mirrors the
        // CLI showRemember gate).
        cacheable: pre.showRemember,
        // Same contract for the 「本项目允许」 button (ADR 0030): present only
        // when persistence:"always" would actually save this exact rule.
        projectRule: pre.projectRule,
        // And for 「信任此工作区」 (ADR 0064): only when the tier would
        // cover this class and the workspace does not trust yet.
        ...(pre.showTrust ? { trustable: true } : {}),
      };
      this.deps.setPendingOverlay(overlay);
    });
  }

  /**
   * Called by Session.resolveApproval. Resolves the awaited promise if the
   * requestId matches the pending slot.
   *
   * When decision is "allow" and persistence is "session", the (tool, risk)
   * pair is written to the task-scoped cache so subsequent identical asks
   * short-circuit until the brief ends. Persistence "always" instead persists
   * the derived PROJECT rule (ADR 0030) — the reserved value the v0.3 design
   * doc §7 left open now has its store. Both re-derive from the pending
   * request (never a caller-supplied shape) inside `ApprovalPolicy.commit`.
   *
   * Returns:
   * - { ok: true } — matched; promise resolved; overlay cleared via deps.
   * - { ok: false, reason: "no_pending_overlay" } — nothing is pending.
   * - { ok: false, reason: "stale_request" } — a different request is pending.
   */
  resolveExternal(opts: {
    readonly requestId: string;
    readonly decision: "allow" | "deny";
    readonly persistence?: "once" | "session" | "always" | "trust";
  }): ResolveExternalResult {
    if (this.pending === null) {
      return { ok: false, reason: "no_pending_overlay" };
    }
    if (this.pending.requestId !== opts.requestId) {
      return { ok: false, reason: "stale_request" };
    }
    const { requestId, request, resolve } = this.pending;
    this.pending = null;

    // Write to cache/store before resolving so the caller's .then() handler
    // immediately sees the entry on the next present() call.
    if (opts.decision === "allow" && opts.persistence !== undefined) {
      this.policy.commit(request, opts.persistence);
    }

    this.deps.clearOverlay(requestId);
    resolve(opts.decision);
    return { ok: true };
  }
}

/**
 * Build a display command string for a command permission request:
 * run_command's argv joined with spaces, or the minimal contract's `bash`
 * command line verbatim (ADR 0040 — the panel's console well wraps and
 * scrolls, so a multi-line heredoc shows whole; a user must SEE what they
 * approve, live GUI 2026-08-17 showed only "未识别的命令" with no command).
 * Returns undefined for other tools or malformed input — the panel then
 * shows only the summary.
 */
export function extractCommand(request: PermissionRequest): string | undefined {
  const input = request.call.input;
  if (typeof input !== "object" || input === null) return undefined;
  if (request.call.tool === "bash") {
    const command = (input as { command?: unknown }).command;
    return typeof command === "string" && command.trim().length > 0
      ? command
      : undefined;
  }
  if (request.call.tool !== "run_command") return undefined;
  const argv = (input as { argv?: unknown }).argv;
  if (!Array.isArray(argv) || argv.length === 0) return undefined;
  const parts = argv.filter((a): a is string => typeof a === "string");
  return parts.length > 0 ? parts.join(" ") : undefined;
}
