import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PendingPermissionApproval,
  type PermissionRequest,
  ProjectCommandRuleStore,
  ruleDisplay,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import { OverlayAskResolver } from "./overlay-ask-resolver.js";

function makeRequest(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "req-1",
    call: { id: "call-1", tool: "write_new_file", input: { path: "a.ts" } },
    reason: "write a new file",
    risk: "workspace_write",
    ...over,
  };
}

function makeResolver(
  opts: { cacheable?: boolean; rules?: ProjectCommandRuleStore } = {},
): {
  resolver: OverlayAskResolver;
  pending: PendingPermissionApproval[];
  cleared: string[];
} {
  const pending: PendingPermissionApproval[] = [];
  const cleared: string[] = [];
  const resolver = new OverlayAskResolver({
    setPendingOverlay: (o) => pending.push(o),
    clearOverlay: (id) => cleared.push(id),
    cache: {
      has: () => false,
      add: () => {},
      isCacheable: () => opts.cacheable ?? false,
      clear: () => {},
      size: () => 0,
      list: () => [],
    } as unknown as import("@herta/core").SessionApprovalCache,
    ...(opts.rules !== undefined ? { rules: opts.rules } : {}),
  });
  return { resolver, pending, cleared };
}

describe("OverlayAskResolver.present — payload enrichment", () => {
  it("carries tool + summary, no command for non-run_command tools", () => {
    const { resolver, pending } = makeResolver();
    void resolver.present(makeRequest(), new AbortController().signal);
    expect(pending).toHaveLength(1);
    const p = pending[0];
    expect(p?.tool).toBe("write_new_file");
    expect(p?.summary).toBe("write a new file");
    expect(p?.command).toBeUndefined();
    expect(p?.risk).toBe("workspace_write");
  });

  it("derives command (argv joined) for run_command", () => {
    const { resolver, pending } = makeResolver();
    void resolver.present(
      makeRequest({
        call: {
          id: "c",
          tool: "run_command",
          input: { argv: ["npm", "install", "left-pad"] },
        },
        risk: "network",
      }),
      new AbortController().signal,
    );
    expect(pending[0]?.command).toBe("npm install left-pad");
  });

  it("minimal contract (ADR 0040): bash asks carry the command line verbatim, and rule-eligible ones the derived project rule", () => {
    const dir = mkdtempSync(join(tmpdir(), "herta-oar-bash-"));
    try {
      const rules = new ProjectCommandRuleStore(() => dir);
      const { resolver, pending } = makeResolver({ rules });
      void resolver.present(
        makeRequest({
          call: {
            id: "c",
            tool: "bash",
            input: { command: "cd /e/ws && node scripts/check.mjs --all" },
          },
          code: "command_ask_interpreter",
          // The bash RULE derived this (the model's cd-to-root prefix dropped).
          argv: ["node", "scripts/check.mjs", "--all"],
        }),
        new AbortController().signal,
      );
      expect(pending[0]?.command).toBe(
        "cd /e/ws && node scripts/check.mjs --all",
      );
      expect(pending[0]?.projectRule).toBe(
        ruleDisplay({
          argvPrefix: ["node", "scripts/check.mjs"],
          anyArgs: true,
        }),
      );
      // A multi-program line carries no argv → no rule offered, command still shown.
      void resolver.present(
        makeRequest({
          call: {
            id: "c2",
            tool: "bash",
            input: { command: "git add -A && git commit -m x" },
          },
          code: "command_ask_unknown",
        }),
        new AbortController().signal,
      );
      expect(pending[1]?.command).toBe("git add -A && git commit -m x");
      expect(pending[1]?.projectRule).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries the ask-class code so the GUI can localize the summary line", () => {
    // User bug 2026-07-23: without the code, the panel showed the raw
    // English rule reason ("unrecognized command — review carefully") in
    // zh sessions. The code rides the overlay; reason stays the fallback.
    const { resolver, pending } = makeResolver();
    void resolver.present(
      makeRequest({ code: "command_ask_unknown" }),
      new AbortController().signal,
    );
    expect(pending[0]?.code).toBe("command_ask_unknown");

    const { resolver: r2, pending: p2 } = makeResolver();
    void r2.present(makeRequest(), new AbortController().signal);
    expect(p2[0]?.code).toBeUndefined();
  });

  it("carries the other ask classes of a chained line (codes) — only when there is more than one", () => {
    const { resolver, pending } = makeResolver();
    void resolver.present(
      makeRequest({
        code: "command_ask_network",
        codes: ["command_ask_network", "command_ask_process"],
      }),
      new AbortController().signal,
    );
    expect(pending[0]?.codes).toEqual([
      "command_ask_network",
      "command_ask_process",
    ]);
    const { resolver: r2, pending: p2 } = makeResolver();
    void r2.present(
      makeRequest({ code: "command_ask_vcs", codes: ["command_ask_vcs"] }),
      new AbortController().signal,
    );
    expect(p2[0]?.codes).toBeUndefined();
  });

  it("carries files when present", () => {
    const { resolver, pending } = makeResolver();
    void resolver.present(
      makeRequest({ files: ["a.ts", "b.ts"] }),
      new AbortController().signal,
    );
    expect(pending[0]?.files).toEqual(["a.ts", "b.ts"]);
  });

  it("carries the diff so the GUI can show what changes before deciding", () => {
    const { resolver, pending } = makeResolver();
    const diff = "--- a/a.ts\n+++ b/a.ts\n-old\n+new";
    void resolver.present(makeRequest({ diff }), new AbortController().signal);
    expect(pending[0]?.diff).toBe(diff);
  });

  it("carries cacheable from cache.isCacheable — gates the GUI 'always allow' button", () => {
    // The overlay's cacheable flag mirrors the eventual cache.add() eligibility
    // so the GUI never offers a "session" choice that would silently no-op
    // (audit T3.4 follow-up).
    const yes = makeResolver({ cacheable: true });
    void yes.resolver.present(makeRequest(), new AbortController().signal);
    expect(yes.pending[0]?.cacheable).toBe(true);

    const no = makeResolver({ cacheable: false });
    void no.resolver.present(makeRequest(), new AbortController().signal);
    expect(no.pending[0]?.cacheable).toBe(false);
  });
});

describe("OverlayAskResolver — project command rules (ADR 0030)", () => {
  function withStore(
    fn: (s: ProjectCommandRuleStore, root: string) => void,
  ): void {
    const root = mkdtempSync(join(tmpdir(), "herta-oar-rules-"));
    try {
      fn(new ProjectCommandRuleStore(() => root), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function nodeRequest(
    over: Partial<PermissionRequest> = {},
  ): PermissionRequest {
    return makeRequest({
      call: {
        id: "c",
        tool: "run_command",
        input: { argv: ["node", "src/index.mjs", "sample.txt"] },
      },
      code: "command_ask_interpreter",
      ...over,
    });
  }

  it("carries projectRule (display form) for a derivable eligible ask", () => {
    withStore((rules) => {
      const { resolver, pending } = makeResolver({ rules });
      void resolver.present(nodeRequest(), new AbortController().signal);
      expect(pending[0]?.projectRule).toBe("node src/index.mjs:*");
    });
  });

  it("omits projectRule for non-eligible codes and non-derivable shapes", () => {
    withStore((rules) => {
      // Destructive ask class — never rule-eligible, whatever the argv.
      const destructive = makeResolver({ rules });
      void destructive.resolver.present(
        nodeRequest({ code: "command_ask_destructive" }),
        new AbortController().signal,
      );
      expect(destructive.pending[0]?.projectRule).toBeUndefined();

      // Eligible code but underivable shape (interpreter eval flag).
      const evalFlag = makeResolver({ rules });
      void evalFlag.resolver.present(
        nodeRequest({
          call: {
            id: "c",
            tool: "run_command",
            input: { argv: ["node", "-e", "x"] },
          },
        }),
        new AbortController().signal,
      );
      expect(evalFlag.pending[0]?.projectRule).toBeUndefined();

      // No store wired (pre-0030 resolvers) — never offered.
      const noStore = makeResolver();
      void noStore.resolver.present(
        nodeRequest(),
        new AbortController().signal,
      );
      expect(noStore.pending[0]?.projectRule).toBeUndefined();
    });
  });

  it("persistence 'always' saves the re-derived rule; later asks auto-allow silently", async () => {
    const root = mkdtempSync(join(tmpdir(), "herta-oar-rules-"));
    try {
      const rules = new ProjectCommandRuleStore(() => root);
      const first = makeResolver({ rules });
      const p1 = first.resolver.present(
        nodeRequest(),
        new AbortController().signal,
      );
      expect(
        first.resolver.resolveExternal({
          requestId: "req-1",
          decision: "allow",
          persistence: "always",
        }),
      ).toEqual({ ok: true });
      await expect(p1).resolves.toBe("allow");
      expect(rules.list().map(ruleDisplay)).toEqual(["node src/index.mjs:*"]);

      // Same script, DIFFERENT args: silent allow, no overlay surfaced.
      const second = makeResolver({ rules });
      const d2 = await second.resolver.present(
        makeRequest({
          call: {
            id: "c2",
            tool: "run_command",
            input: { argv: ["node", "src/index.mjs", "other.txt"] },
          },
          code: "command_ask_interpreter",
        }),
        new AbortController().signal,
      );
      expect(d2).toBe("allow");
      expect(second.pending).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a matching rule NEVER short-circuits a non-eligible ask class", () => {
    withStore((rules) => {
      rules.add({ argvPrefix: ["node", "src/index.mjs"], anyArgs: true });
      // Same argv, but the live classifier said destructive (hypothetically —
      // e.g. a hand-edited rules file trying to cover a different tier).
      const { resolver, pending } = makeResolver({ rules });
      void resolver.present(
        nodeRequest({ code: "command_ask_destructive" }),
        new AbortController().signal,
      );
      // Overlay surfaced — the rule did not auto-allow.
      expect(pending).toHaveLength(1);
    });
  });

  it("persistence 'always' on an underivable request no-ops (nothing persisted)", async () => {
    const root = mkdtempSync(join(tmpdir(), "herta-oar-rules-"));
    try {
      const rules = new ProjectCommandRuleStore(() => root);
      const { resolver } = makeResolver({ rules });
      const p = resolver.present(
        nodeRequest({
          call: {
            id: "c",
            tool: "run_command",
            input: { argv: ["node", "-e", "x"] },
          },
        }),
        new AbortController().signal,
      );
      resolver.resolveExternal({
        requestId: "req-1",
        decision: "allow",
        persistence: "always",
      });
      await expect(p).resolves.toBe("allow"); // the one-time allow still stands
      expect(rules.list()).toEqual([]); // but nothing was persisted
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persistence 'always' no longer writes the session cache", () => {
    withStore((rules) => {
      const added: string[] = [];
      const pending: PendingPermissionApproval[] = [];
      const resolver = new OverlayAskResolver({
        setPendingOverlay: (o) => pending.push(o),
        clearOverlay: () => {},
        cache: {
          has: () => false,
          add: (tool: string) => added.push(tool),
          isCacheable: () => true,
          clear: () => {},
          size: () => 0,
          list: () => [],
        } as unknown as import("@herta/core").SessionApprovalCache,
        rules,
      });
      void resolver.present(nodeRequest(), new AbortController().signal);
      resolver.resolveExternal({
        requestId: "req-1",
        decision: "allow",
        persistence: "always",
      });
      expect(added).toEqual([]); // project persist ≠ task cache write
    });
  });
});

describe("OverlayAskResolver.present — interrupt during a pending gate (audit finding 4)", () => {
  // Pressing Stop while the ApprovalPanel is up is an ABORT, not a decision.
  // This used to resolve "deny", fabricating a user denial that entered the
  // report's residualRisks and the next dispatch's working history (the
  // ADR-0010 poisoned-history class). It must reject with an AbortError —
  // settled (no runBrief wedge), overlay cleared (renderer unlocks), and no
  // permission.resolved / permission_denied downstream.

  it("rejects with AbortError and clears the overlay on abort", async () => {
    const { resolver, cleared } = makeResolver();
    const ac = new AbortController();
    const promise = resolver.present(makeRequest(), ac.signal);
    ac.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(cleared).toEqual(["req-1"]);
    // The pending slot is released: a stale click after the abort is refused.
    expect(
      resolver.resolveExternal({ requestId: "req-1", decision: "allow" }),
    ).toEqual({ ok: false, reason: "no_pending_overlay" });
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { resolver, pending } = makeResolver();
    const ac = new AbortController();
    ac.abort();
    await expect(
      resolver.present(makeRequest(), ac.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    // No overlay was ever surfaced.
    expect(pending).toHaveLength(0);
  });

  it("a user resolution before the abort wins the race", async () => {
    const { resolver } = makeResolver();
    const ac = new AbortController();
    const promise = resolver.present(makeRequest(), ac.signal);
    const r = resolver.resolveExternal({
      requestId: "req-1",
      decision: "allow",
    });
    expect(r).toEqual({ ok: true });
    ac.abort();
    await expect(promise).resolves.toBe("allow");
  });
});

describe("OverlayAskResolver — automatic review replaces workspace trust (ADR 0064 amendment 2026-10-10)", () => {
  const writeRequest = (): PermissionRequest =>
    makeRequest({
      call: {
        id: "c",
        tool: "bash",
        input: { command: "mkdir -p src && cat > src/a.mjs <<'EOF'\nx\nEOF" },
      },
      code: "command_ask_write",
      codes: ["command_ask_write", "command_ask_fs"],
      undoable: true,
    });
  const vcsRequest = (): PermissionRequest =>
    makeRequest({
      call: { id: "c", tool: "bash", input: { command: "git commit -m x" } },
      code: "command_ask_vcs",
      argv: ["git", "commit", "-m", "x"],
      programs: ["git"],
    });

  it("offers 「开启自动审核」 on an undoable write, and an 'auto_review' resolution turns it on for the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "herta-overlay-review-"));
    try {
      const rules = new ProjectCommandRuleStore(() => root);
      const { resolver, pending } = makeResolver({ rules });
      expect(resolver.autoReviewOn).toBe(false);
      const p1 = resolver.present(writeRequest(), new AbortController().signal);
      expect(pending[0]?.offerAutoReview).toBe(true);
      const r = resolver.resolveExternal({
        requestId: "req-1",
        decision: "allow",
        persistence: "auto_review",
      });
      expect(r).toEqual({ ok: true });
      await expect(p1).resolves.toBe("allow");
      expect(rules.autoReview()).toBe(true);
      expect(resolver.autoReviewOn).toBe(true);
      // The next undoable write runs — no card, no review.
      await expect(
        resolver.present(writeRequest(), new AbortController().signal),
      ).resolves.toBe("allow");
      expect(pending).toHaveLength(1);
      // A git commit trust used to let through is no longer let through:
      // with no reviewer mounted, it is the card, and nothing to offer.
      void resolver.present(vcsRequest(), new AbortController().signal);
      expect(pending).toHaveLength(2);
      expect(pending[1]?.offerAutoReview).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("without a reviewer, a command's card does not offer it — it would change nothing there", () => {
    const root = mkdtempSync(join(tmpdir(), "herta-overlay-review-"));
    try {
      const rules = new ProjectCommandRuleStore(() => root);
      const { resolver, pending } = makeResolver({ rules });
      void resolver.present(vcsRequest(), new AbortController().signal);
      expect(pending[0]?.offerAutoReview).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the host's default turns it on in the managed sandbox until the owner chooses", async () => {
    const root = mkdtempSync(join(tmpdir(), "herta-overlay-review-"));
    try {
      const rules = new ProjectCommandRuleStore(() => root);
      let sandbox = true;
      const pending: PendingPermissionApproval[] = [];
      const resolver = new OverlayAskResolver({
        setPendingOverlay: (o) => pending.push(o),
        clearOverlay: () => {},
        cache: {
          has: () => false,
          add: () => {},
          isCacheable: () => false,
          clear: () => {},
          size: () => 0,
          list: () => [],
        } as unknown as import("@herta/core").SessionApprovalCache,
        rules,
        defaultAutoReview: () => sandbox,
      });
      await expect(
        resolver.present(writeRequest(), new AbortController().signal),
      ).resolves.toBe("allow");
      expect(pending).toHaveLength(0);
      sandbox = false;
      void resolver.present(writeRequest(), new AbortController().signal);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.offerAutoReview).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
