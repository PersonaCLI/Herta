import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoReviewer } from "@herta/app-server/wiring";
import {
  type AskResolver,
  type PermissionRequest,
  ProjectCommandRuleStore,
  ruleDisplay,
  SessionApprovalCache,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import { MockReadable, MockWritable } from "../testing/mock-streams.js";
import { CachingAskResolver } from "./caching-ask-resolver.js";
import {
  CliAskResolver,
  type CliPromptOutcome,
  type PresentDetailedOptions,
} from "./permission-prompt.js";
import { makeStyle } from "./style.js";

const style = makeStyle({ enabled: false });

function mkReq(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "p1",
    call: { id: "c1", tool: "edit_file", input: { path: "x.txt" } },
    reason: "writes file",
    risk: "workspace_write",
    files: ["x.txt"],
    ...overrides,
  };
}

class FakeInner extends CliAskResolver {
  outcomes: CliPromptOutcome[] = [];
  optionsLog: PresentDetailedOptions[] = [];

  override async presentDetailed(
    _req: PermissionRequest,
    _sig: AbortSignal,
    opts: PresentDetailedOptions,
  ): Promise<CliPromptOutcome> {
    this.optionsLog.push(opts);
    const next = this.outcomes.shift();
    if (next === undefined) throw new Error("no scripted outcome");
    return next;
  }
}

function mkInner(): { inner: FakeInner; stdout: MockWritable } {
  const stdin = new MockReadable();
  const stdout = new MockWritable();
  const inner = new FakeInner(stdin, stdout, style);
  return { inner, stdout };
}

describe("CachingAskResolver", () => {
  it("cache miss for cacheable pair: calls inner with showRemember:true", async () => {
    const cache = new SessionApprovalCache();
    const { inner, stdout } = mkInner();
    inner.outcomes = ["allow"];
    const wrapper = new CachingAskResolver(inner, cache, stdout, style);
    const ac = new AbortController();
    const decision = await wrapper.present(mkReq(), ac.signal);
    expect(decision).toBe("allow");
    expect(inner.optionsLog).toEqual([{ showRemember: true }]);
    expect(cache.size()).toBe(0);
  });

  it("cache miss for non-cacheable pair: calls inner with showRemember:false", async () => {
    const cache = new SessionApprovalCache();
    const { inner, stdout } = mkInner();
    inner.outcomes = ["allow"];
    const wrapper = new CachingAskResolver(inner, cache, stdout, style);
    const ac = new AbortController();
    const decision = await wrapper.present(
      mkReq({ risk: "workspace_destructive" }),
      ac.signal,
    );
    expect(decision).toBe("allow");
    expect(inner.optionsLog).toEqual([{ showRemember: false }]);
  });

  it("inner returns allow_remember: caches the pair, returns allow upstream", async () => {
    const cache = new SessionApprovalCache();
    const { inner, stdout } = mkInner();
    inner.outcomes = ["allow_remember"];
    const wrapper = new CachingAskResolver(inner, cache, stdout, style);
    const ac = new AbortController();
    const decision = await wrapper.present(mkReq(), ac.signal);
    expect(decision).toBe("allow");
    // Keyed on the task scope (ADR 0026): the remember covers every file
    // write until the brief ends, both write tools included.
    expect(cache.has("edit_file", "workspace_write", "task")).toBe(true);
    expect(cache.has("write_new_file", "workspace_write", "task")).toBe(true);
  });

  it("cache hit: returns allow immediately without calling inner; prints marker", async () => {
    const cache = new SessionApprovalCache();
    cache.add("edit_file", "workspace_write", "task");
    const { inner, stdout } = mkInner();
    // outcomes intentionally empty — inner must NOT be called.
    const wrapper = new CachingAskResolver(inner, cache, stdout, style);
    const ac = new AbortController();
    const decision = await wrapper.present(mkReq(), ac.signal);
    expect(decision).toBe("allow");
    expect(inner.optionsLog).toEqual([]);
    expect(stdout.full()).toContain("auto-allow");
    expect(stdout.full()).toContain("edit_file");
    expect(stdout.full()).toContain("workspace_write");
    expect(stdout.full()).toContain("cached for this task");
  });

  it("inner returns allow (without remember): cache stays empty", async () => {
    const cache = new SessionApprovalCache();
    const { inner, stdout } = mkInner();
    inner.outcomes = ["allow"];
    const wrapper = new CachingAskResolver(inner, cache, stdout, style);
    const ac = new AbortController();
    await wrapper.present(mkReq(), ac.signal);
    expect(cache.size()).toBe(0);
  });

  it("inner returns deny: cache stays empty, returns deny", async () => {
    const cache = new SessionApprovalCache();
    const { inner, stdout } = mkInner();
    inner.outcomes = ["deny"];
    const wrapper = new CachingAskResolver(inner, cache, stdout, style);
    const ac = new AbortController();
    const decision = await wrapper.present(mkReq(), ac.signal);
    expect(decision).toBe("deny");
    expect(cache.size()).toBe(0);
  });

  it("cache hit only matches the same (tool, risk, scope) tuple", async () => {
    const cache = new SessionApprovalCache();
    cache.add("edit_file", "workspace_write", "x.txt");
    const { inner, stdout } = mkInner();
    inner.outcomes = ["deny"];
    const wrapper = new CachingAskResolver(inner, cache, stdout, style);
    const ac = new AbortController();
    // Different tool — cache miss, falls through to inner.
    const decision = await wrapper.present(
      mkReq({
        call: { id: "c2", tool: "write_new_file", input: {} },
      }),
      ac.signal,
    );
    expect(decision).toBe("deny");
    expect(inner.optionsLog.length).toBe(1);
  });

  it("a task-scope remember covers a DIFFERENT file within the same brief (ADR 0026)", async () => {
    // Deliberate owner decision 2026-07-24, replacing the T3.4 per-path key:
    // one remember covers every file write until the brief ends (the cache
    // is cleared at backend turn end by wireTaskScopedApprovalCache). Every
    // auto-approved write still projects its patch preview into the record.
    const cache = new SessionApprovalCache();
    cache.add("edit_file", "workspace_write", "task");
    const { inner, stdout } = mkInner();
    // outcomes intentionally empty — inner must NOT be called.
    const wrapper = new CachingAskResolver(inner, cache, stdout, style);
    const ac = new AbortController();
    const decision = await wrapper.present(
      mkReq({ files: [".github/workflows/ci.yml"] }),
      ac.signal,
    );
    expect(decision).toBe("allow");
    expect(inner.optionsLog).toEqual([]);
  });

  it("AskResolver interface compatibility (compile-time)", () => {
    // Type-only: ensure CachingAskResolver is assignable to AskResolver.
    const cache = new SessionApprovalCache();
    const { inner, stdout } = mkInner();
    const wrapper: AskResolver = new CachingAskResolver(
      inner,
      cache,
      stdout,
      style,
    );
    expect(typeof wrapper.present).toBe("function");
  });

  describe("run_command per-binary caching", () => {
    function mkRunReq(
      argv: unknown,
      risk: PermissionRequest["risk"] = "workspace_write",
    ): PermissionRequest {
      return mkReq({
        call: { id: "c1", tool: "run_command", input: { argv } },
        risk,
      });
    }

    it("cache hit on same binary skips the prompt", async () => {
      const cache = new SessionApprovalCache();
      cache.add("run_command", "workspace_write", "rustfmt");
      const { inner, stdout } = mkInner();
      // intentionally no scripted outcome — inner must NOT be called.
      const wrapper = new CachingAskResolver(inner, cache, stdout, style);
      const ac = new AbortController();
      const decision = await wrapper.present(
        mkRunReq(["rustfmt", "src/lib.rs"]),
        ac.signal,
      );
      expect(decision).toBe("allow");
      expect(inner.optionsLog).toEqual([]);
      expect(stdout.full()).toContain("auto-allow: run_command rustfmt");
    });

    it("cache miss: different binary prompts (and offers remember)", async () => {
      const cache = new SessionApprovalCache();
      cache.add("run_command", "workspace_write", "rustfmt");
      const { inner, stdout } = mkInner();
      inner.outcomes = ["allow"];
      const wrapper = new CachingAskResolver(inner, cache, stdout, style);
      const ac = new AbortController();
      const decision = await wrapper.present(
        mkRunReq(["gofmt", "-w", "main.go"]),
        ac.signal,
      );
      expect(decision).toBe("allow");
      // gofmt prompt is cacheable (workspace_write + binary)
      expect(inner.optionsLog).toEqual([{ showRemember: true }]);
    });

    it("inner returns allow_remember: caches under the binary, returns allow", async () => {
      const cache = new SessionApprovalCache();
      const { inner, stdout } = mkInner();
      inner.outcomes = ["allow_remember"];
      const wrapper = new CachingAskResolver(inner, cache, stdout, style);
      const ac = new AbortController();
      await wrapper.present(mkRunReq(["rustfmt", "x.rs"]), ac.signal);
      expect(cache.has("run_command", "workspace_write", "rustfmt")).toBe(true);
      expect(cache.has("run_command", "workspace_write", "gofmt")).toBe(false);
    });

    it("interpreters cache only by a PINNED workspace script — never by their bare name (audit T3.4 review; refined 2026-08-17)", async () => {
      const cache = new SessionApprovalCache();
      const { inner, stdout } = mkInner();
      inner.outcomes = ["allow_remember", "allow_remember"];
      const wrapper = new CachingAskResolver(inner, cache, stdout, style);
      const ac = new AbortController();
      // `python3 build.py` remembered covers `python3 build.py <args>` and
      // nothing else run through python — so the remember IS offered and
      // stored under the pinned pair (permission lab 2026-08-17: the same
      // pinned script re-asked three times in one brief).
      await wrapper.present(mkRunReq(["python3", "build.py"]), ac.signal);
      expect(inner.optionsLog).toEqual([{ showRemember: true }]);
      expect(cache.size()).toBe(1);
      expect(cache.list()).toEqual([
        "run_command:python3 build.py:workspace_write",
      ]);
      // The arbitrary-code shape is still never offered / never stored: a
      // `python3 -c` after the remember above still prompts.
      await wrapper.present(mkRunReq(["python3", "-c", "print(1)"]), ac.signal);
      expect(inner.optionsLog).toEqual([
        { showRemember: true },
        { showRemember: false },
      ]);
      expect(cache.size()).toBe(1);
    });

    it("destructive risk: shows [y/N] (no remember), never caches", async () => {
      const cache = new SessionApprovalCache();
      const { inner, stdout } = mkInner();
      inner.outcomes = ["allow_remember"];
      const wrapper = new CachingAskResolver(inner, cache, stdout, style);
      const ac = new AbortController();
      await wrapper.present(
        mkRunReq(["rm", "-rf", "x"], "workspace_destructive"),
        ac.signal,
      );
      // Even though inner returns allow_remember, cache stays empty
      // because the (tool, risk, binary) is not cacheable.
      expect(inner.optionsLog).toEqual([{ showRemember: false }]);
      expect(cache.size()).toBe(0);
    });

    it("project rules (ADR 0030): hit auto-allows with a marker; [p] persists; non-eligible codes never match", async () => {
      const root = mkdtempSync(join(tmpdir(), "herta-cli-rules-"));
      try {
        const rules = new ProjectCommandRuleStore(() => root);
        const nodeReq = (argv: string[], code?: string): PermissionRequest =>
          mkReq({
            call: { id: "c1", tool: "run_command", input: { argv } },
            code: code ?? "command_ask_interpreter",
          });

        // 1) Derivable + eligible: the prompt carries the rule display;
        //    allow_project persists it.
        const first = mkInner();
        first.inner.outcomes = ["allow_project"];
        const w1 = new CachingAskResolver(
          first.inner,
          new SessionApprovalCache(),
          first.stdout,
          style,
          rules,
        );
        const d1 = await w1.present(
          nodeReq(["node", "src/index.mjs", "sample.txt"]),
          new AbortController().signal,
        );
        expect(d1).toBe("allow");
        // The pinned script also makes the task-remember available (the
        // cache scopes by `node src/index.mjs`, 2026-08-17).
        // …and the workspace-trust grant is offered too (ADR 0064): a
        // workspace script is a class the tier covers, and this workspace
        // has not chosen yet.
        expect(first.inner.optionsLog).toEqual([
          {
            showRemember: true,
            projectRule: "node src/index.mjs:*",
            showTrust: true,
          },
        ]);
        expect(rules.list().map(ruleDisplay)).toEqual(["node src/index.mjs:*"]);

        // 2) Same script, different args: silent auto-allow, no prompt.
        const second = mkInner();
        const w2 = new CachingAskResolver(
          second.inner,
          new SessionApprovalCache(),
          second.stdout,
          style,
          rules,
        );
        const d2 = await w2.present(
          nodeReq(["node", "src/index.mjs", "other.txt"]),
          new AbortController().signal,
        );
        expect(d2).toBe("allow");
        expect(second.inner.optionsLog).toEqual([]);
        expect(second.stdout.full()).toContain(
          "auto-allow: project rule covers node src/index.mjs other.txt",
        );

        // 3) Matching argv but a NON-eligible ask class: prompts anyway, and
        //    offers no [p] (the rule cannot cross tiers).
        const third = mkInner();
        third.inner.outcomes = ["allow"];
        const w3 = new CachingAskResolver(
          third.inner,
          new SessionApprovalCache(),
          third.stdout,
          style,
          rules,
        );
        await w3.present(
          nodeReq(["node", "src/index.mjs"], "command_ask_destructive"),
          new AbortController().signal,
        );
        // (showRemember follows the RISK, which this fixture leaves at
        // workspace_write with a pinnable script — the point here is that no
        // projectRule is offered for the non-eligible class.)
        expect(third.inner.optionsLog).toEqual([{ showRemember: true }]);

        // 4) Eligible but underivable (eval flag): no [p] offered.
        const fourth = mkInner();
        fourth.inner.outcomes = ["allow"];
        const w4 = new CachingAskResolver(
          fourth.inner,
          new SessionApprovalCache(),
          fourth.stdout,
          style,
          rules,
        );
        await w4.present(
          nodeReq(["node", "-e", "x"]),
          new AbortController().signal,
        );
        // (The fixture hand-sets the interpreter class, which the trust tier
        // covers, so [t] is offered here — the real classifier would file
        // `node -e` under the inline class and offer nothing.)
        expect(fourth.inner.optionsLog).toEqual([
          { showRemember: false, showTrust: true },
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("missing/empty argv: falls through to non-cacheable behavior", async () => {
      const cache = new SessionApprovalCache();
      const { inner, stdout } = mkInner();
      inner.outcomes = ["allow"];
      const wrapper = new CachingAskResolver(inner, cache, stdout, style);
      const ac = new AbortController();
      // No argv at all
      await wrapper.present(
        mkReq({
          call: { id: "c1", tool: "run_command", input: {} },
        }),
        ac.signal,
      );
      // showRemember was false because we couldn't extract a binary.
      expect(inner.optionsLog).toEqual([{ showRemember: false }]);
    });
  });

  describe("workspace trust (ADR 0064)", () => {
    it("[t] turns trust on for the workspace; covered asks then auto-allow with a marker", async () => {
      const root = mkdtempSync(join(tmpdir(), "herta-cli-trust-"));
      try {
        const rules = new ProjectCommandRuleStore(() => root);
        const vcs = (): PermissionRequest =>
          mkReq({
            call: {
              id: "c1",
              tool: "run_command",
              input: { argv: ["git", "commit", "-m", "x"] },
            },
            code: "command_ask_vcs",
          });
        const first = mkInner();
        first.inner.outcomes = ["allow_trust"];
        const w1 = new CachingAskResolver(
          first.inner,
          new SessionApprovalCache(),
          first.stdout,
          style,
          rules,
        );
        await expect(
          w1.present(vcs(), new AbortController().signal),
        ).resolves.toBe("allow");
        expect(first.inner.optionsLog[0]).toMatchObject({ showTrust: true });
        expect(rules.trust()).toBe("workspace");

        const second = mkInner();
        const w2 = new CachingAskResolver(
          second.inner,
          new SessionApprovalCache(),
          second.stdout,
          style,
          rules,
        );
        await expect(
          w2.present(vcs(), new AbortController().signal),
        ).resolves.toBe("allow");
        expect(second.inner.optionsLog).toEqual([]);
        expect(second.stdout.full()).toContain("auto-allow:");
        expect(second.stdout.full()).toContain("workspace trust");
        // A network ask still prompts, and offers no [t] (already trusted).
        const third = mkInner();
        third.inner.outcomes = ["allow"];
        const w3 = new CachingAskResolver(
          third.inner,
          new SessionApprovalCache(),
          third.stdout,
          style,
          rules,
        );
        await w3.present(
          mkReq({
            call: {
              id: "c2",
              tool: "run_command",
              input: { argv: ["npm", "install", "x"] },
            },
            risk: "network",
            code: "command_ask_network",
          }),
          new AbortController().signal,
        );
        expect(third.inner.optionsLog).toEqual([{ showRemember: false }]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

describe("CachingAskResolver with the automatic reviewer (ADR 0075)", () => {
  const reply = (risk: string, auth: string, outcome: string) =>
    JSON.stringify({
      risk_level: risk,
      user_authorization: auth,
      outcome,
      rationale: "理由。",
    });
  const bash = (command: string): PermissionRequest =>
    mkReq({
      call: { id: "c1", tool: "bash", input: { command } },
      reason: "unrecognized command — review carefully",
      code: "command_ask_unknown",
      files: undefined,
    });

  function setup(answers: Array<string | Error>, enabled = true) {
    const sent: string[] = [];
    const reviewer = new AutoReviewer(async ({ user }) => {
      sent.push(user);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? reply("low", "high", "allow");
    });
    const { inner, stdout } = mkInner();
    const resolver = new CachingAskResolver(
      inner,
      new SessionApprovalCache(),
      stdout,
      style,
      undefined,
      {
        reviewer,
        enabled: () => enabled,
        userMessages: () => ["@板砖 跑一下测试。"],
        workspace: () => "/w",
      },
    );
    return { resolver, inner, stdout, sent };
  }
  const signal = () => new AbortController().signal;

  it("an allow settles with no prompt, and prints nothing", async () => {
    const { resolver, inner, stdout, sent } = setup([
      reply("low", "high", "allow"),
    ]);
    expect(await resolver.present(bash("make test"), signal())).toBe("allow");
    expect(inner.optionsLog).toHaveLength(0);
    expect(stdout.full()).toBe("");
    expect(sent[0]).toContain("跑一下测试");
  });

  it("a deny settles as the reviewer's, with its reason", async () => {
    const { resolver, inner } = setup([reply("medium", "low", "deny")]);
    expect(await resolver.present(bash("pnpm add left-pad"), signal())).toEqual(
      { decision: "deny", by: "reviewer", reason: "理由。" },
    );
    expect(inner.optionsLog).toHaveLength(0);
  });

  it("a failure, or a workspace not opted in, prompts as before", async () => {
    const failing = setup([new Error("down")]);
    failing.inner.outcomes.push("allow");
    expect(await failing.resolver.present(bash("make test"), signal())).toBe(
      "allow",
    );
    expect(failing.inner.optionsLog).toHaveLength(1);

    const off = setup([], false);
    off.inner.outcomes.push("deny");
    expect(await off.resolver.present(bash("make test"), signal())).toBe(
      "deny",
    );
    expect(off.sent).toHaveLength(0);
  });
});
