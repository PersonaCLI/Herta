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
 * The POLICY (cache / undoable-write short-circuits, which persistence choices
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
  type SessionApprovalCache,
  type WorkspacePermissions,
} from "@herta/core";
import {
  type ReviewDeps,
  requestCommand,
  reviewBeforeCard,
  reviewTakes,
} from "./auto-review.js";

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
   * The workspace's permission choices (`.herta/permissions.json`): whether
   * automatic review is on. Written when a request resolves with
   * persistence "auto_review". Optional: a hand-built test resolver without
   * one has only the host's default.
   */
  readonly permissions?: WorkspacePermissions;
  /**
   * Whether automatic review is on by default in the CURRENT workspace
   * (ADR 0064 amendment 2026-10-10): the session's managed sandbox is, a
   * real project is not. A provider — the workspace can move mid-session.
   * Absent → off by default.
   */
  readonly defaultAutoReview?: () => boolean;
  /**
   * The automatic reviewer (ADR 0075), when one is mounted. Asked before the
   * card, only where automatic review is on in the CURRENT workspace; its
   * allow or deny settles the request without a card, and anything else
   * shows the card.
   */
  readonly review?: ReviewDeps;
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
    this.policy = new ApprovalPolicy(deps.cache, deps.permissions, {
      ...(deps.defaultAutoReview !== undefined
        ? { defaultAutoReview: deps.defaultAutoReview }
        : {}),
      ...(deps.review !== undefined ? { reviewable: reviewTakes } : {}),
    });
  }

  /** The policy's view of automatic review — the session's switch reads it
   *  here so the two never disagree. */
  get autoReviewOn(): boolean {
    return this.policy.autoReviewOn();
  }

  /** A new user message: the reviewer's brake lifts (ADR 0075). */
  resetReviewBrake(): void {
    this.deps.review?.reviewer.resetBrake();
  }

  present(request: PermissionRequest, signal: AbortSignal): Promise<AskAnswer> {
    // Cache / undoable-write hit: no overlay.
    const pre = this.policy.preflight(request);
    if (pre.kind === "auto") return Promise.resolve("allow");
    const review = this.deps.review;
    if (review !== undefined && this.policy.autoReviewOn()) {
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
    review: ReviewDeps,
    request: PermissionRequest,
    pre: Extract<ApprovalPreflight, { kind: "ask" }>,
    signal: AbortSignal,
  ): Promise<AskAnswer> {
    let answer: AskAnswer | null;
    try {
      answer = await reviewBeforeCard(review, request, signal);
    } catch {
      // Only an abort rejects: the card's own abort contract applies.
      throw gateAbortError();
    }
    return answer ?? this.surface(request, pre, signal);
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
        command: requestCommand(request),
        diff: request.diff,
        files: request.files,
        // Gate the GUI "always allow (session)" button: only offer it when a
        // remembered choice would actually be cached for this request (the
        // policy uses the SAME (tool, risk, scope) the eventual cache.add()
        // will use), so the button never appears for a choice that would
        // silently no-op and re-prompt (audit T3.4 follow-up; mirrors the
        // CLI showRemember gate).
        cacheable: pre.showRemember,
        // Same contract for 「开启自动审核」: only when automatic review is
        // off and would answer this request.
        ...(pre.showAutoReview ? { offerAutoReview: true } : {}),
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
   * short-circuit until the brief ends. Persistence "auto_review" turns
   * automatic review on for the workspace. Both re-derive from the pending
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
    readonly persistence?: "once" | "session" | "auto_review";
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
