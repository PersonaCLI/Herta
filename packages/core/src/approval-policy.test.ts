import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalPolicy } from "./approval-policy.js";
import { SessionApprovalCache } from "./session-approval-cache.js";
import type { PermissionRequest } from "./types/events.js";
import { WorkspacePermissions } from "./workspace-permissions.js";

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
function mkPermissions(): WorkspacePermissions {
  const dir = mkdtempSync(join(tmpdir(), "herta-approval-policy-"));
  tmpDirs.push(dir);
  return new WorkspacePermissions(() => dir);
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

  it("a remembered command no longer outlives the task: there is no project rule (ADR 0030 removed, 2026-10-10)", () => {
    const policy = new ApprovalPolicy(
      new SessionApprovalCache(),
      mkPermissions(),
    );
    const pre = policy.preflight(cmdReq(["npm", "run", "build"]));
    expect(pre.kind).toBe("ask");
    expect(pre).not.toHaveProperty("projectRule");
  });
});

describe("ApprovalPolicy — automatic review (ADR 0064 amendment 2026-10-10)", () => {
  // An undoable write: the rule marked it, and every class is a write class.
  const undoable = (over: Partial<PermissionRequest> = {}) =>
    writeReq({ code: "edit_file_ask", undoable: true, ...over });
  const cmd = (code: string, over: Partial<PermissionRequest> = {}) =>
    cmdReq(["git", "commit", "-m", "x"], { code, ...over });

  it("is off by default; an undoable write then asks and offers turning it on", () => {
    const permissions = mkPermissions();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), permissions);
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
    const permissions = mkPermissions();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), permissions, {
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
    expect(permissions.autoReview()).toBeNull();
    policy.commit(cmd("command_ask_vcs"), "auto_review");
    expect(permissions.autoReview()).toBe(true);
  });

  it("on: only an undoable write skips the review; everything trust used to cover asks", () => {
    const permissions = mkPermissions();
    const policy = new ApprovalPolicy(new SessionApprovalCache(), permissions);
    policy.commit(undoable(), "auto_review");
    expect(permissions.autoReview()).toBe(true);
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
    const permissions = mkPermissions();
    let sandbox = true;
    const policy = new ApprovalPolicy(new SessionApprovalCache(), permissions, {
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
    permissions.setAutoReview(false);
    expect(policy.autoReviewOn()).toBe(false);
    const pre = policy.preflight(undoable());
    if (pre.kind !== "ask") throw new Error("unreachable");
    expect(pre.showAutoReview).toBe(true);
    permissions.setAutoReview(null);
    expect(policy.autoReviewOn()).toBe(true);
  });
});
