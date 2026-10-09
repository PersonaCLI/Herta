import { type ReviewDeps, reviewBeforeCard } from "@herta/app-server/wiring";
import {
  ApprovalPolicy,
  type AskAnswer,
  type AskResolver,
  type PermissionRequest,
  type ProjectCommandRuleStore,
  type SessionApprovalCache,
} from "@herta/core";
import type { CliAskResolver } from "./permission-prompt.js";
import type { Style } from "./style.js";

/**
 * AskResolver wrapper that short-circuits permission prompts when the
 * (tool, risk, scope) tuple was previously approved with "yes-and-remember"
 * (the 'a' option) in this task, or when a persisted PROJECT command rule
 * covers the argv (the 'p' option, ADR 0030). On either hit, returns
 * "allow" immediately and writes a dim auto-allow marker so the user can
 * see their earlier choice is still in effect.
 *
 * The policy itself — what counts as covered, which choices to offer, what
 * a grant writes back — is `@herta/core`'s `ApprovalPolicy`, shared with the
 * app-server's overlay resolver; this class only renders and awaits.
 *
 * ADR 0075: with a reviewer mounted and the workspace opted in
 * (`/permissions auto-review on`), the reviewer answers before the prompt —
 * the same step the desktop takes (`reviewBeforeCard`). Its decisions are
 * silent, as on the desktop (owner, 2026-10-09); a card verdict or any
 * failure shows the prompt as before.
 */
export class CachingAskResolver implements AskResolver {
  private readonly policy: ApprovalPolicy;

  constructor(
    private readonly inner: CliAskResolver,
    cache: SessionApprovalCache,
    private readonly stdout: NodeJS.WritableStream,
    private readonly style: Style,
    rules?: ProjectCommandRuleStore,
    private readonly review?: ReviewDeps,
  ) {
    this.policy = new ApprovalPolicy(cache, rules);
  }

  async present(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<AskAnswer> {
    const pre = this.policy.preflight(request);
    if (pre.kind === "auto") {
      const tool = request.call.tool;
      const risk = request.risk;
      const note =
        pre.via === "cache"
          ? `${pre.scope === undefined ? `${tool} ${risk}` : `${tool} ${pre.scope} ${risk}`} (cached for this task)`
          : pre.via === "project_rule"
            ? `project rule covers ${(pre.argv ?? []).join(" ")}`
            : `${tool} ${risk} (workspace trust)`;
      this.stdout.write(this.style.dim(`  auto-allow: ${note}\n`));
      return "allow";
    }
    if (this.review !== undefined) {
      const answer = await reviewBeforeCard(this.review, request, signal);
      if (answer !== null) return answer;
    }

    const outcome = await this.inner.presentDetailed(request, signal, {
      showRemember: pre.showRemember,
      ...(pre.projectRule !== undefined
        ? { projectRule: pre.projectRule }
        : {}),
      ...(pre.showTrust ? { showTrust: true } : {}),
    });
    if (outcome === "allow_remember") {
      this.policy.commit(request, "session");
      return "allow";
    }
    if (outcome === "allow_project") {
      this.policy.commit(request, "always");
      return "allow";
    }
    if (outcome === "allow_trust") {
      this.policy.commit(request, "trust");
      return "allow";
    }
    return outcome === "allow" ? "allow" : "deny";
  }
}
