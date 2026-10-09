import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type {
  AgentEvent,
  EventBus,
  PermissionRule,
  RulePermissionEngine,
  RuleVerdict,
  ToolCallRequest,
  ToolContext,
} from "@herta/core";
import { PersistentShell, SHELL_BG_ID } from "../bash/persistent-shell.js";
import { type ShellPaths, shellPathsFor } from "../bash/shell-paths.js";
import { computeUnifiedDiff } from "../edit-file/engine.js";
import { formatInputIssues } from "../input-issues.js";
import {
  countDiffLines,
  MAX_FILE_BYTES,
  planEdit,
  resolveEditorPath,
} from "./engine.js";
import { strReplaceEditorInputSchema } from "./schema.js";
import { STR_REPLACE_EDITOR_SUGGESTIONS } from "./suggestions.js";

export interface StrReplaceEditorRuleDeps {
  bus?: EventBus<AgentEvent>;
  bashPath: string | null;
}

/** A rule deny whose message the model sees verbatim (trained strings).
 *  `read` marks a refused `view` — a withheld read, not a refused mutation,
 *  so it does not cap the run's status (ADR 0047 §2, as the reader guards). */
function deny(code: string, message: string, read = false): RuleVerdict {
  const suggestion = STR_REPLACE_EDITOR_SUGGESTIONS[code];
  return {
    kind: "deny",
    code,
    reason: message,
    modelText: message,
    ...(suggestion !== undefined ? { suggestion } : {}),
    ...(read ? { risk: "workspace_read" as const } : {}),
  };
}

/**
 * Permission rule for `str_replace_editor` (ADR 0040) — mirrors edit_file /
 * write_new_file: `view` allows after path safety; `create` / `str_replace`
 * / `insert` compute the diff, publish `patch.preview` (so the record shows
 * the change, D7) and ASK as a workspace write with the diff attached.
 *
 * Read-before-edit, this contract's reading of the rule (documented in the
 * ADR): `str_replace` is CONTENT-ANCHORED — the edit applies only if
 * `old_str` matches exactly once in the file AS IT IS ON DISK AT APPLY
 * TIME, which is a stronger freshness check for the edited region than a
 * whole-file hash; `insert` addresses a LINE NUMBER, which is only
 * meaningful relative to a specific view, so it requires a prior view of
 * the file whose hash still matches (else `view_required` / `stale_view`).
 */
export function makeStrReplaceEditorRule(
  deps: StrReplaceEditorRuleDeps,
): PermissionRule {
  const paths: ShellPaths = shellPathsFor(deps.bashPath);
  return async (
    call: ToolCallRequest,
    ctx: ToolContext,
  ): Promise<RuleVerdict> => {
    const parsed = strReplaceEditorInputSchema.safeParse(call.input);
    if (!parsed.success) {
      const message = formatInputIssues(parsed.error);
      return { kind: "deny", code: "invalid_input", reason: message };
    }
    const input = parsed.data;
    const shell = ctx.bg.getInternal(SHELL_BG_ID);
    const wsShell =
      shell instanceof PersistentShell
        ? shell.workspaceShellPath
        : paths.toShell(ctx.workspaceRoot);
    const target = await resolveEditorPath(
      input.path,
      ctx,
      paths,
      wsShell,
      input.command === "view",
    );
    if (!target.ok)
      return deny(target.code, target.message, input.command === "view");
    if (input.command === "view") return { kind: "allow" };

    if (input.command === "create") {
      if (typeof input.file_text !== "string") {
        return deny(
          "invalid_input",
          "Parameter `file_text` is required for command: create",
        );
      }
      try {
        await stat(target.resolved);
        return deny(
          "create_exists",
          `File already exists at: ${target.display}. Cannot overwrite files using command \`create\`.`,
        );
      } catch {
        // absent — good
      }
      const diff = computeUnifiedDiff("", input.file_text, target.relative);
      deps.bus?.publish({
        type: "patch.preview",
        layer: "backend",
        diff,
        files: [target.relative],
      });
      return {
        kind: "ask",
        reason: `creates ${target.relative} (${countDiffLines(diff, "+")} lines)`,
        risk: "workspace_write",
        code: "str_replace_editor_ask",
        diff,
        files: [target.relative],
        // An editor keeps what it replaces (ADR 0074).
        undoable: true,
      };
    }

    // str_replace / insert: the file as it is on disk NOW.
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(target.resolved);
    } catch {
      return deny(
        "not_found",
        `The path ${target.display} does not exist. Please provide a valid path.`,
      );
    }
    if (info.isDirectory()) {
      return deny(
        "invalid_input",
        `The path ${target.display} is a directory and only the \`view\` command can be used on directories`,
      );
    }
    if (info.size > MAX_FILE_BYTES) {
      return deny(
        "file_too_large",
        `The file ${target.display} is too large to edit (${info.size} bytes > ${MAX_FILE_BYTES}).`,
      );
    }
    let buf: Buffer;
    try {
      buf = await readFile(target.resolved);
    } catch (err: unknown) {
      return deny(
        "read_failed",
        `Could not read ${target.display}: ${(err as Error).message ?? "read failed"}`,
      );
    }
    if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) {
      return deny(
        "binary_file",
        `The file ${target.display} is binary and cannot be edited with this tool.`,
      );
    }
    if (input.command === "insert") {
      const sha = createHash("sha256").update(buf).digest("hex");
      const entry = ctx.reads.get(target.resolved);
      if (!entry) {
        return deny(
          "view_required",
          `Please \`view\` ${target.display} before using \`insert\` — insert_line refers to the line numbers of a view.`,
        );
      }
      if (entry.sha256 !== sha) {
        return deny(
          "stale_view",
          `${target.display} changed since you last viewed it; view it again and recompute insert_line.`,
        );
      }
    }
    const before = buf.toString("utf-8");
    const plan = planEdit(input, before, target.display, target.relative);
    if (!plan.ok) return deny(plan.code, plan.message);
    deps.bus?.publish({
      type: "patch.preview",
      layer: "backend",
      diff: plan.diff,
      files: [target.relative],
    });
    return {
      kind: "ask",
      reason: `writes ${target.relative} (${input.command}, +${countDiffLines(plan.diff, "+")}/-${countDiffLines(plan.diff, "-")} lines)`,
      risk: "workspace_write",
      code: "str_replace_editor_ask",
      diff: plan.diff,
      files: [target.relative],
      // An editor keeps what it replaces (ADR 0074).
      undoable: true,
    };
  };
}

export function registerStrReplaceEditorRule(
  engine: RulePermissionEngine,
  deps: StrReplaceEditorRuleDeps,
): void {
  engine.registerRule("str_replace_editor", makeStrReplaceEditorRule(deps));
}
