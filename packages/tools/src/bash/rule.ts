import type {
  AgentEvent,
  EventBus,
  PermissionRule,
  RulePermissionEngine,
  RuleVerdict,
  ToolCallRequest,
  ToolContext,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import type { SafePathDenied } from "../path-safety.js";
import {
  checkReaderArgvPaths,
  checkReadPaths,
} from "../run-command/reader-guard.js";
import { previewHeredocWrites } from "./heredoc-write.js";
import { PersistentShell, SHELL_BG_ID } from "./persistent-shell.js";
import { readRedirectTargets, writesUndoable } from "./redirect-writes.js";
import { bashInputSchema } from "./schema.js";
import {
  classifyShellCommandDetailed,
  effectivePrograms,
  peelReaderHead,
  singleProgramArgv,
  tokenize,
} from "./shell-classifier.js";
import { type ShellPaths, shellPathsFor } from "./shell-paths.js";

export interface BashRuleDeps {
  /** The bash binary the tool runs; used only for path-spelling awareness. */
  bashPath: string | null;
  /** For `patch.preview` when the command is a heredoc file write — the
   *  record then shows the write as a diff, exactly like edit_file's rule. */
  bus?: EventBus<AgentEvent>;
}

/**
 * Permission rule for the minimal contract's `bash` (ADR 0040, D4): the
 * shell-string classifier decides block / ask / allow; on allow, the
 * allow-listed READER segments get the same async realpath guard
 * run_command applies (an innocent-basename symlink whose target leaves the
 * repo, or names a credential, is a hard deny — TOCTOU re-check happens
 * again inside the tool before execution).
 */
export function makeBashRule(deps: BashRuleDeps): PermissionRule {
  const paths: ShellPaths = shellPathsFor(deps.bashPath);
  return async (
    call: ToolCallRequest,
    ctx: ToolContext,
  ): Promise<RuleVerdict> => {
    const parsed = bashInputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        kind: "deny",
        code: "invalid_input",
        reason: formatInputIssues(parsed.error),
      };
    }
    const shell = ctx.bg.getInternal(SHELL_BG_ID);
    const cwd =
      shell instanceof PersistentShell ? shell.cwd : ctx.workspaceRoot;
    const { verdict, codes, steps } = classifyShellCommandDetailed(
      parsed.data.command,
      {
        workspaceRoot: ctx.workspaceRoot,
        paths,
        cwd,
      },
    );
    if (verdict.kind === "block") {
      return { kind: "deny", code: verdict.code, reason: verdict.reason };
    }
    if (verdict.kind === "ask") {
      // The effective program (ADR 0040): lets the approval cache scope this
      // ask by argv[0] like run_command's (the cache applies its own
      // interpreter/shell exclusion, and keys a script-pinned
      // `node scripts/x.mjs`) — only when the line really runs one program
      // (see singleProgramArgv); otherwise every call re-prompts.
      const scopeOpts = { workspaceRoot: ctx.workspaceRoot, paths, cwd };
      const argv = singleProgramArgv(parsed.data.command, scopeOpts);
      // For the task CACHE only: the distinct programs of a chained line
      // (`git add && git commit && git status` → ["git"]).
      const programs = effectivePrograms(parsed.data.command, scopeOpts);
      // Everything the line changes is held for undo (ADR 0064 amendment
      // 2026-10-10): with automatic review on, it runs without a review.
      // Read from the line's own text and its targets as they are now; the
      // tool reads the targets again when it runs.
      const undoable =
        verdict.risk === "workspace_write" &&
        writesUndoable(
          parsed.data.command,
          scopeOpts,
          await readRedirectTargets(parsed.data.command, scopeOpts),
        );
      // A heredoc file write (`cat > src/x <<'EOF' … EOF`, the contract's
      // file-write idiom) is previewed like a file write: the diff the write
      // would produce reaches the ask (the card folds the body out of the
      // command box and offers the diff instead) and the record (D7 — the
      // same patch preview edit_file's rule publishes). The ask class becomes
      // the write it is; the line's other asks keep their reasons.
      const preview = await previewHeredocWrites(
        parsed.data.command,
        scopeOpts,
      );
      if (preview !== null) {
        if (preview.diff.length > 0) {
          deps.bus?.publish({
            type: "patch.preview",
            layer: "backend",
            diff: preview.diff,
            files: preview.files,
          });
        }
        const code =
          verdict.risk === "workspace_write"
            ? "command_ask_write"
            : verdict.code;
        // The write class leads; the line's other classes follow (deduped).
        const allCodes = [
          code,
          ...(codes ?? []).filter(
            (c) => c !== code && c !== "command_ask_write",
          ),
        ];
        return {
          kind: "ask",
          reason: `${preview.summary}; ${verdict.reason}`,
          risk: verdict.risk,
          code,
          ...(allCodes.length > 1 ? { codes: allCodes } : {}),
          ...(preview.diff.length > 0 ? { diff: preview.diff } : {}),
          files: preview.files,
          ...(argv !== null ? { argv } : {}),
          ...(programs !== null && programs.length > 0 ? { programs } : {}),
          ...(verdict.consequence !== undefined
            ? { consequence: verdict.consequence }
            : {}),
          ...(undoable ? { undoable: true as const } : {}),
          cwd,
        };
      }
      return {
        kind: "ask",
        reason: verdict.reason,
        risk: verdict.risk,
        code: verdict.code,
        ...(codes !== undefined && codes.length > 1 ? { codes } : {}),
        ...(argv !== null ? { argv } : {}),
        ...(programs !== null && programs.length > 0 ? { programs } : {}),
        ...(verdict.consequence !== undefined
          ? { consequence: verdict.consequence }
          : {}),
        ...(undoable ? { undoable: true as const } : {}),
        cwd,
      };
    }
    // allow → realpath what every command of the line reads (async guard).
    const denial = await checkLineReads(ctx.workspaceRoot, steps ?? []);
    if (denial !== null) {
      // A refused READ (2026-08-26): the reader guard only runs on
      // read-classified segments, so this deny withholds information, not
      // a mutation — the status gate must not cap a completed brief on it.
      return {
        kind: "deny",
        code: denial.code,
        reason: denial.message,
        risk: "workspace_read",
      };
    }
    return { kind: "allow" };
  };
}

/**
 * What an allowed line READS, realpath-ed (audit T3.4): each command's
 * reader operands and its `<` input redirects, whose target the tokenizer
 * keeps out of the words (Mac findings 2026-10-24, item 4: `cat < notes`
 * read through a link the guard refused for `cat notes`). The commands are
 * the classifier's `steps` — substitution bodies, unrolled loop items, each
 * from the directory a `cd` before it moved to — never the raw line, which
 * hid all three from this check. The first denial, or null. The rule asks
 * it, and the tool asks again just before the line runs, against a link
 * swapped in between.
 *
 * The words are peeled the same way the CLASSIFIER peels them. They were
 * not, and the two layers disagreeing about where the command starts was
 * enough to switch this guard off entirely: `time cat out/win.ini` (or
 * `{ cat …; }`, `if cat …`, `! cat …`, `command cat …`) handed
 * checkReaderArgvPaths a first word of `time`, which is not a
 * PATH_READER_CMD, so it returned no candidates — and the junction-escape
 * this guard exists for (audit T3.4) went unchecked behind one harmless
 * extra word (red team 2026-08-24).
 */
export async function checkLineReads(
  workspaceRoot: string,
  steps: ReadonlyArray<{ text: string; cwd: string }>,
): Promise<SafePathDenied | null> {
  for (const { text, cwd } of steps) {
    const { words, redirects } = tokenize(text);
    if (words.length > 0) {
      const denial = await checkReaderArgvPaths(
        workspaceRoot,
        cwd,
        peelReaderHead(words),
      );
      if (denial !== null) return denial;
    }
    const inputs = redirects
      .filter((r) => r.kind === "in")
      .map((r) => r.target);
    const denial = await checkReadPaths(
      workspaceRoot,
      cwd,
      inputs,
      (path) => `input redirect < ${path}`,
    );
    if (denial !== null) return denial;
  }
  return null;
}

export function registerBashRule(
  engine: RulePermissionEngine,
  deps: BashRuleDeps,
): void {
  engine.registerRule("bash", makeBashRule(deps));
}
