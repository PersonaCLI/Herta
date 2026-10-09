import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentEvent,
  EventBus,
  PermissionRule,
  RulePermissionEngine,
  RuleVerdict,
  ToolCallRequest,
  ToolContext,
} from "@herta/core";
import { computeUnifiedDiff } from "../edit-file/engine.js";
import { formatInputIssues } from "../input-issues.js";
import { resolveSafePath } from "../path-safety.js";
import { writeNewFileInputSchema } from "./schema.js";

const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

export interface WriteNewFileRuleDeps {
  bus?: EventBus<AgentEvent>;
}

export function makeWriteNewFileRule(
  deps: WriteNewFileRuleDeps = {},
): PermissionRule {
  return async (
    call: ToolCallRequest,
    ctx: ToolContext,
  ): Promise<RuleVerdict> => {
    const parsed = writeNewFileInputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        kind: "deny",
        code: "invalid_input",
        reason: formatInputIssues(parsed.error),
      };
    }
    const { path, content } = parsed.data;

    const safe = await resolveSafePath(ctx.workspaceRoot, path, {
      mutation: true,
    });
    if (!safe.ok) {
      return { kind: "deny", code: safe.code, reason: safe.message };
    }

    let info: Stats | null = null;
    try {
      info = await stat(safe.resolved);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      // ENOTDIR: a path component is a file, not a directory (e.g. writing
      // `file.txt/child`). POSIX (Linux/macOS) surfaces this on the target
      // stat; Windows instead returns ENOENT here and the parent check below
      // reports it. Normalize both to parent_invalid so the deny code is
      // deterministic across platforms (Linux-CI parity fix, 2026-07-09).
      if (code === "ENOTDIR") {
        return {
          kind: "deny",
          code: "parent_invalid",
          reason: `parent path is not a directory: ${dirname(safe.resolved)}`,
        };
      }
      if (code !== "ENOENT") {
        return {
          kind: "deny",
          code: "read_failed",
          reason: (err as Error).message ?? "stat failed",
        };
      }
    }
    if (info !== null) {
      return {
        kind: "deny",
        code: "file_exists",
        reason: `${safe.relative} already exists${info.isDirectory() ? " (directory)" : ""}`,
      };
    }

    const parentDir = dirname(safe.resolved);
    if (parentDir !== safe.resolved) {
      try {
        const parentInfo = await stat(parentDir);
        if (!parentInfo.isDirectory()) {
          return {
            kind: "deny",
            code: "parent_invalid",
            reason: `parent path is not a directory: ${parentDir}`,
          };
        }
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        // ENOTDIR here means the grandparent is a file — same parent_invalid
        // class as the isDirectory() check above.
        if (code === "ENOTDIR") {
          return {
            kind: "deny",
            code: "parent_invalid",
            reason: `parent path is not a directory: ${parentDir}`,
          };
        }
        if (code !== "ENOENT") {
          return {
            kind: "deny",
            code: "read_failed",
            reason: (err as Error).message ?? "parent stat failed",
          };
        }
      }
    }

    const byteLength = Buffer.byteLength(content, "utf-8");
    if (byteLength > MAX_CONTENT_BYTES) {
      return {
        kind: "deny",
        code: "file_too_large",
        reason: `${byteLength} bytes > cap ${MAX_CONTENT_BYTES}`,
      };
    }

    const diff = computeUnifiedDiff("", content, safe.relative);
    if (deps.bus) {
      deps.bus.publish({
        type: "patch.preview",
        layer: "backend",
        diff,
        files: [safe.relative],
      });
    }

    return {
      kind: "ask",
      reason: `creates ${safe.relative} (${byteLength} bytes)`,
      risk: "workspace_write",
      code: "write_new_file_ask",
      diff,
      files: [safe.relative],
      // An editor keeps what it replaces (ADR 0074).
      undoable: true,
    };
  };
}

export function registerWriteNewFileRule(
  engine: RulePermissionEngine,
  deps: WriteNewFileRuleDeps = {},
): void {
  engine.registerRule("write_new_file", makeWriteNewFileRule(deps));
}
