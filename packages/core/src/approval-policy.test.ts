import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalPolicy, commandArgv, commandCwd } from "./approval-policy.js";
import {
  ProjectCommandRuleStore,
  ruleDisplay,
} from "./project-command-rules.js";
import { SessionApprovalCache } from "./session-approval-cache.js";
import type { PermissionRequest } from "./types/events.js";

function writeReq(
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    id: "p1",
    call: { id: "c1", tool: "edit_file", input: { path: "x.txt" } },
    reason: "writes file",
    risk: "workspace_write",
    files: ["x.txt"],
    ...overrides,
  };
}

function cmdReq(
  argv: string[],
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    id: "p2",
    call: { id: "c2", tool: "run_command", input: { argv } },
    reason: "unknown command",
    risk: "workspace_write",
    code: "command_ask_unknown",
    ...overrides,
  };
}

const tmpDirs: string[] = [];
function mkRules(): ProjectCommandRuleStore {
  const dir = mkdtempSync(join(tmpdir(), "herta-approval-policy-"));
  tmpDirs.push(dir);
  return new ProjectCommandRuleStore(() => dir);
}
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

describe("ApprovalPolicy.preflight", () => {
  it("asks for a cacheable write and offers remember", () => {
    const policy = new ApprovalPolicy(new SessionApprovalCache());
    const pre = policy.preflight(writeReq());
    expect(pre.kind).toBe("ask");
    if (pre.kind !== "ask") throw new Error("unreachable");
    expect(pre.showRemember).toBe(true);
    expect(pre.projectRule).toBeUndefined();
  });

  it("does not offer remember for a destructive risk", () => {
    const policy = new ApprovalPolicy(new SessionApprovalCache());
    const pre = policy.preflight(writeReq({ risk: "workspace_destructive" }));
    expect(pre.kind).toBe("ask");
    if (pre.kind !== "ask") throw new Error("unreachable");
    expect(pre.showRemember).toBe(false);
  });

  it("auto-allows via the cache after a session commit", () => {
    const cache = new SessionApprovalCache();
    const policy = new ApprovalPolicy(cache);
    policy.commit(writeReq(), "session");
    const pre = policy.preflight(writeReq({ files: ["other.txt"] }));
    expect(pre).toMatchObject({ kind: "auto", via: "cache", scope: "task" });
  });

  it("a 'once' commit writes nothing", () => {
    const cache = new SessionApprovalCache();
    const policy = new ApprovalPolicy(cache);
    policy.commit(writeReq(), "once");
    expect(cache.size()).toBe(0);
    expect(policy.preflight(writeReq()).kind).toBe("ask");
  });

  it("offers the project rule only when one is derivable and a store exists", () => {
    const noRules = new ApprovalPolicy(new SessionApprovalCache());
    const pre1 = noRules.preflight(cmdReq(["npm", "run", "build"]));
    if (pre1.kind !== "ask") throw new Error("unreachable");
    expect(pre1.projectRule).toBeUndefined();

    const withRules = new ApprovalPolicy(new SessionApprovalCache(), mkRules());
    const pre2 = withRules.preflight(cmdReq(["npm", "run", "build"]));
    if (pre2.kind !== "ask") throw new Error("unreachable");
    expect(pre2.projectRule).toBe("npm run:*");
  });

  it("an 'always' commit persists the rule, cwd-scoped, and later matches", () => {
    const rules = mkRules();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), rules);
    policy.commit(
      cmdReq(["node", "scripts/x.mjs"], {
        call: {
          id: "c3",
          tool: "run_command",
          input: { argv: ["node", "scripts/x.mjs"], cwd: "sub" },
        },
      }),
      "always",
    );
    const sameCwd = policy.preflight(
      cmdReq(["node", "scripts/x.mjs", "--flag"], {
        call: {
          id: "c4",
          tool: "run_command",
          input: { argv: ["node", "scripts/x.mjs", "--flag"], cwd: "sub" },
        },
      }),
    );
    expect(sameCwd).toMatchObject({ kind: "auto", via: "project_rule" });
    // Audit BL15: the grant is scoped to the directory it was granted in.
    const otherCwd = policy.preflight(cmdReq(["node", "scripts/x.mjs"]));
    expect(otherCwd.kind).toBe("ask");
  });

  it("never lets a rule cover a non-rule-eligible ask code", () => {
    const rules = mkRules();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), rules);
    policy.commit(cmdReq(["npm", "run", "build"]), "always");
    expect(policy.preflight(cmdReq(["npm", "run", "build"]))).toMatchObject({
      kind: "auto",
      via: "project_rule",
    });
    const networkAsk = policy.preflight(
      cmdReq(["npm", "run", "build"], {
        code: "command_ask_network",
        risk: "network",
      }),
    );
    expect(networkAsk.kind).toBe("ask");
    // And an "always" on an ineligible code writes nothing.
    policy.commit(
      cmdReq(["curl", "http://x"], { code: "command_ask_network" }),
      "always",
    );
    expect(rules.list().map((r) => ruleDisplay(r))).toEqual(["npm run:*"]);
  });

  it("bash (minimal contract) uses the rule-derived argv", () => {
    const rules = mkRules();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), rules);
    const bashReq: PermissionRequest = {
      id: "p5",
      call: { id: "c5", tool: "bash", input: { command: "npm run build" } },
      reason: "unknown command",
      risk: "workspace_write",
      code: "command_ask_unknown",
      argv: ["npm", "run", "build"],
    };
    const pre = policy.preflight(bashReq);
    if (pre.kind !== "ask") throw new Error("unreachable");
    expect(pre.projectRule).toBe("npm run:*");
    policy.commit(bashReq, "always");
    expect(policy.preflight(bashReq)).toMatchObject({
      kind: "auto",
      via: "project_rule",
    });
  });
});

describe("commandArgv / commandCwd", () => {
  it("reads run_command argv and cwd, fail-closed on bad shapes", () => {
    expect(commandArgv(cmdReq(["git", "status"]))).toEqual(["git", "status"]);
    expect(
      commandArgv(
        cmdReq([], {
          call: { id: "c", tool: "run_command", input: { argv: ["a", 1] } },
        }),
      ),
    ).toBeNull();
    expect(commandArgv(writeReq())).toBeNull();
    expect(
      commandCwd(
        cmdReq([], {
          call: {
            id: "c",
            tool: "run_command",
            input: { argv: ["a"], cwd: "d" },
          },
        }),
      ),
    ).toBe("d");
    expect(commandCwd(cmdReq(["a"]))).toBeUndefined();
  });
});

describe("ApprovalPolicy — automatic review (ADR 0064 amendment 2026-10-10)", () => {
  // An undoable write: the rule marked it, and every class is a write class.
  const undoable = (over: Partial<PermissionRequest> = {}) =>
    writeReq({ code: "edit_file_ask", undoable: true, ...over });
  const cmd = (code: string, over: Partial<PermissionRequest> = {}) =>
    cmdReq(["git", "commit", "-m", "x"], { code, ...over });

  it("is off by default; an undoable write then asks and offers turning it on", () => {
    const rules = mkRules();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), rules);
    expect(policy.autoReviewOn()).toBe(false);
    const pre = policy.preflight(undoable());
    expect(pre.kind).toBe("ask");
    if (pre.kind !== "ask") throw new Error("unreachable");
    expect(pre.showAutoReview).toBe(true);
    // Without a reviewer, a command is nothing review would answer.
    const vcs = policy.preflight(cmd("command_ask_vcs"));
    if (vcs.kind !== "ask") throw new Error("unreachable");
    expect(vcs.showAutoReview).toBe(false);
    // Without a rule store there is nowhere to record the choice.
    const bare = new ApprovalPolicy(new SessionApprovalCache());
    const b = bare.preflight(undoable());
    if (b.kind !== "ask") throw new Error("unreachable");
    expect(b.showAutoReview).toBe(false);
  });

  it("with a reviewer, offers it on whatever the reviewer would take", () => {
    const rules = mkRules();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), rules, {
      reviewable: (r) => r.code !== "command_ask_harness_state",
    });
    const vcs = policy.preflight(cmd("command_ask_vcs"));
    if (vcs.kind !== "ask") throw new Error("unreachable");
    expect(vcs.showAutoReview).toBe(true);
    const owner = policy.preflight(cmd("command_ask_harness_state"));
    if (owner.kind !== "ask") throw new Error("unreachable");
    expect(owner.showAutoReview).toBe(false);
    // Committing on a request no review answers writes nothing.
    policy.commit(cmd("command_ask_harness_state"), "auto_review");
    expect(rules.autoReview()).toBeNull();
    policy.commit(cmd("command_ask_vcs"), "auto_review");
    expect(rules.autoReview()).toBe(true);
  });

  it("on: only an undoable write skips the review; everything trust used to cover asks", () => {
    const rules = mkRules();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), rules);
    policy.commit(undoable(), "auto_review");
    expect(rules.autoReview()).toBe(true);
    expect(policy.autoReviewOn()).toBe(true);
    expect(policy.preflight(undoable())).toMatchObject({
      kind: "auto",
      via: "undoable_write",
      scope: "task",
    });
    // A shell line the bash rule marked: a printer's write plus mkdir -p.
    expect(
      policy.preflight(
        cmd("command_ask_write", {
          codes: ["command_ask_write", "command_ask_fs"],
          undoable: true,
        }),
      ),
    ).toMatchObject({ kind: "auto", via: "undoable_write" });
    // What trust let through now goes to the reviewer (the resolver's step).
    for (const code of [
      "command_ask_vcs",
      "command_ask_delete",
      "command_ask_interpreter",
      "command_ask_local_exec",
      "command_ask_script",
      "command_ask_fs",
      "command_ask_write",
    ]) {
      const pre = policy.preflight(cmd(code));
      expect(pre.kind, code).toBe("ask");
      if (pre.kind !== "ask") throw new Error("unreachable");
      expect(pre.showAutoReview, code).toBe(false); // already on
    }
    // The mark alone is not enough: a class that is not a write never skips.
    for (const [code, risk] of [
      ["command_ask_delete", "workspace_write"],
      ["command_ask_network", "network"],
      ["command_ask_vcs", "workspace_write"],
    ] as const) {
      expect(
        policy.preflight(cmd(code, { risk, undoable: true })).kind,
        code,
      ).toBe("ask");
    }
    // Every class of a chained line must be a write class.
    expect(
      policy.preflight(
        cmd("command_ask_write", {
          codes: ["command_ask_write", "command_ask_vcs"],
          undoable: true,
        }),
      ).kind,
    ).toBe("ask");
    // An ask with NO class is never covered: earned, not assumed.
    expect(policy.preflight(writeReq({ undoable: true })).kind).toBe("ask");
  });

  it("the host's default applies until the owner chooses; an explicit choice beats it either way", () => {
    const rules = mkRules();
    let sandbox = true;
    const policy = new ApprovalPolicy(new SessionApprovalCache(), rules, {
      defaultAutoReview: () => sandbox,
    });
    expect(policy.autoReviewOn()).toBe(true);
    expect(policy.preflight(undoable())).toMatchObject({
      kind: "auto",
      via: "undoable_write",
    });
    // The workspace moved to a real project: the default flips with it.
    sandbox = false;
    expect(policy.autoReviewOn()).toBe(false);
    // The owner turned it OFF on the sandbox: explicit wins.
    sandbox = true;
    rules.setAutoReview(false);
    expect(policy.autoReviewOn()).toBe(false);
    const pre = policy.preflight(undoable());
    if (pre.kind !== "ask") throw new Error("unreachable");
    expect(pre.showAutoReview).toBe(true);
    rules.setAutoReview(null);
    expect(policy.autoReviewOn()).toBe(true);
  });
});
