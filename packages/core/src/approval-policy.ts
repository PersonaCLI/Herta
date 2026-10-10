import {
  permissionCacheScope,
  type SessionApprovalCache,
} from "./session-approval-cache.js";
import type { PermissionRequest } from "./types/events.js";
import { undoableWrite } from "./undoable-write.js";
import type { WorkspacePermissions } from "./workspace-permissions.js";

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
 * asks never reach the user because a task-scoped remember (ADR 0026)
 * already covers them, or because automatic review is on and undo can take
 * the request back; which persistence choices the surface may offer; and
 * what a granted persistence writes back.
 *
 * Both user-facing resolvers — the CLI's `CachingAskResolver` (stdout
 * prompt) and the app-server's `OverlayAskResolver` (GUI overlay) — carried
 * their own copy of this until 2026-08-19, and every audit fix to the policy
 * (T3.4 scoped cache keys, ADR 0040 bash argv) had to land twice. One policy
 * object; the resolvers only render and await.
 *
 * Every decision re-derives from the LIVE request: a caller can never pass a
 * shape of its own. ADR 0030's persisted project rules were removed on
 * 2026-10-10: automatic review answers a recurring command now.
 */
export class ApprovalPolicy {
  constructor(
    private readonly cache: SessionApprovalCache,
    private readonly permissions?: WorkspacePermissions,
    private readonly opts: ApprovalPolicyOpts = {},
  ) {}

  /**
   * Whether automatic review is on in this workspace: the owner's explicit
   * choice in the permissions file, else the host's default for the
   * workspace kind. Without a store there is nowhere to record a choice, so
   * only the default applies.
   */
  autoReviewOn(): boolean {
    const explicit = this.permissions?.autoReview() ?? null;
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
    if (on && undoableWrite(request)) {
      return { kind: "auto", via: "undoable_write", scope };
    }

    // Offer "remember" only when the eventual cache.add() would actually
    // store this tuple (same key) — a button/option that would silently
    // no-op and re-prompt must not appear (audit T3.4 follow-up).
    return {
      kind: "ask",
      scope,
      showRemember: this.cache.isCacheable(tool, risk, scope),
      // Offer turning automatic review on only where it would take effect:
      // it is off, there is a store to record the choice in, and the
      // request is one it would let through or hand to the reviewer.
      showAutoReview:
        !on && this.permissions !== undefined && this.reviewTakes(request),
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
      if (this.permissions !== undefined && this.reviewTakes(request)) {
        this.permissions.setAutoReview(true);
      }
      return;
    }
    this.cache.add(
      request.call.tool,
      request.risk,
      permissionCacheScope(request),
    );
  }

  /** Automatic review would answer this request: an undoable write, or a
   *  command a mounted reviewer may judge. */
  private reviewTakes(request: PermissionRequest): boolean {
    return undoableWrite(request) || this.opts.reviewable?.(request) === true;
  }
}

/** How long a granted allow should outlive this one ask: this ask only,
 *  the rest of the task (ADR 0026), or — `auto_review`, not about this ask
 *  at all — automatic review turned on for the workspace, allowing this one. */
export type ApprovalPersistence = "once" | "session" | "auto_review";

export type ApprovalPreflight =
  | {
      readonly kind: "auto";
      readonly via: "cache" | "undoable_write";
      readonly scope: string | undefined;
    }
  | {
      readonly kind: "ask";
      readonly scope: string | undefined;
      /** Offer the task-scoped remember choice. */
      readonly showRemember: boolean;
      /** Offer turning automatic review on: it is off here, and it would
       *  answer this request. */
      readonly showAutoReview: boolean;
    };
