import { isAbsolute, resolve } from "node:path";
import type {
  PermissionRule,
  RulePermissionEngine,
  RuleVerdict,
  ToolCallRequest,
  ToolContext,
} from "@herta/core";
import { detectInProgressState, resolveGitDir } from "../git/repo-probe.js";
import { formatInputIssues } from "../input-issues.js";
import {
  gitInternalsWrite,
  hertaStateWriteDenial,
  holdsWorkspace,
  namesHertaState,
  resolveSafePath,
} from "../path-safety.js";
import { classifyCommand, type WriteGuard } from "./classifier.js";
import { readPatchTargets } from "./patch-targets.js";
import { checkReaderArgvPaths } from "./reader-guard.js";
import { runCommandInputSchema } from "./schema.js";

/**
 * run_command's write guard (2026-09-30): the harness's own state (`.herta`)
 * is not command-writable. Operands resolve against the command's effective
 * cwd — which resolveSafePath already refuses inside `.herta`. The argv is
 * spawned without a shell, so a body only exists behind an explicit
 * `sh -c` / `cmd /c`, judged by its text; no glob is ever expanded. `holds`
 * is any directory the workspace sits under — a walk from there reaches
 * `.herta` — and `patch` reads a patch file where the operand says it is.
 */
export function runCommandWriteGuard(
  workspaceRoot: string,
  cwd: string,
): WriteGuard {
  const at = (operand: string): string =>
    isAbsolute(operand) ? resolve(operand) : resolve(cwd, operand);
  return {
    path: (operand) =>
      operand === "" ? null : hertaStateWriteDenial(workspaceRoot, at(operand)),
    // The workspace's own root does not count: a managed sandbox lives
    // under `~/.herta/workspaces`, and `cmd /c "cd <workspace> && …"` named
    // `.herta` and was refused (release review 2026-10-13).
    body: (body) =>
      namesHertaState(body, workspaceRoot)
        ? "hands a shell a command that names .herta — the harness's own state; no command may change it"
        : null,
    // As written or canonically: `find …/VERIFY/WS -delete` from another
    // case of the root reaches `.herta` all the same (Mac findings
    // 2026-10-24, item 3).
    holds: (operand) =>
      operand !== "" && holdsWorkspace(at(operand), resolve(workspaceRoot)),
    patch: (file) => (file === "" ? null : readPatchTargets(at(file))),
    gitInternal: (operand) =>
      operand !== "" && gitInternalsWrite(workspaceRoot, at(operand)),
  };
}

export function makeRunCommandRule(): PermissionRule {
  return async (
    call: ToolCallRequest,
    ctx: ToolContext,
  ): Promise<RuleVerdict> => {
    const parsed = runCommandInputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        kind: "deny",
        code: "invalid_input",
        reason: formatInputIssues(parsed.error),
      };
    }
    const { argv, cwd } = parsed.data;

    const safe = await resolveSafePath(ctx.workspaceRoot, cwd ?? ".");
    if (!safe.ok) {
      return { kind: "deny", code: safe.code, reason: safe.message };
    }

    const verdict = classifyCommand(argv, {
      // Lazy in-progress probe at the command's effective cwd (ADR 0049 §5)
      // — consulted only for commit-concluding git shapes.
      repoInProgress: () => {
        const gitDir = resolveGitDir(safe.resolved);
        return gitDir === null ? null : detectInProgressState(gitDir);
      },
      writeGuard: runCommandWriteGuard(ctx.workspaceRoot, safe.resolved),
    });
    if (verdict.kind === "block") {
      return {
        kind: "deny",
        code: verdict.code,
        reason: verdict.reason,
      };
    }
    if (verdict.kind === "allow") {
      // The classifier auto-allowed a reader after a TEXT-only argv check; an
      // innocent-basename symlink whose realpath leaves the repo or names a
      // credential slips that check (audit T3.4). Realpath the operands now
      // (the rule is async and has the effective cwd) and hard-deny a
      // disguised read — matching read_file.
      const readerDenial = await checkReaderArgvPaths(
        ctx.workspaceRoot,
        safe.resolved,
        argv,
      );
      if (readerDenial !== null) {
        // A refused READ (2026-08-26, same as the bash rule's reader guard):
        // withheld information, not a refused mutation — must not cap the
        // brief's status.
        return {
          kind: "deny",
          code: readerDenial.code,
          reason: readerDenial.message,
          risk: "workspace_read",
        };
      }
      return { kind: "allow" };
    }
    return {
      kind: "ask",
      reason: verdict.reason,
      risk: verdict.risk,
      code: verdict.code,
      ...(verdict.consequence !== undefined
        ? { consequence: verdict.consequence }
        : {}),
      cwd: safe.resolved,
    };
  };
}

export function registerRunCommandRule(engine: RulePermissionEngine): void {
  engine.registerRule("run_command", makeRunCommandRule());
}
