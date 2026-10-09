import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
  type AgentEvent,
  countDiffLinesFor,
  type EventBus,
  type PermissionRule,
  type RulePermissionEngine,
  type RuleVerdict,
  type ToolCallRequest,
  type ToolContext,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { resolveSafePath } from "../path-safety.js";
import {
  applyHunks,
  computeUnifiedDiff,
  parsePatch,
  validateHunks,
} from "./engine.js";
import { editFileInputSchema } from "./schema.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SNIFF_BYTES = 4096;

export interface EditFileRuleDeps {
  bus?: EventBus<AgentEvent>;
}

export function makeEditFileRule(deps: EditFileRuleDeps = {}): PermissionRule {
  return async (
    call: ToolCallRequest,
    ctx: ToolContext,
  ): Promise<RuleVerdict> => {
    const parsed = editFileInputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        kind: "deny",
        code: "invalid_input",
        reason: formatInputIssues(parsed.error),
      };
    }
    const { path, hunks } = parsed.data;

    const safe = await resolveSafePath(ctx.workspaceRoot, path, {
      mutation: true,
    });
    if (!safe.ok) {
      return { kind: "deny", code: safe.code, reason: safe.message };
    }

    let info: Stats;
    try {
      info = await stat(safe.resolved);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        return {
          kind: "deny",
          code: "not_found",
          reason: `not found: ${safe.relative}`,
        };
      }
      return {
        kind: "deny",
        code: "read_failed",
        reason: (err as Error).message ?? "stat failed",
      };
    }
    if (!info.isFile()) {
      return {
        kind: "deny",
        code: "invalid_input",
        reason: `not a file: ${safe.relative}`,
      };
    }
    if (info.size > MAX_FILE_BYTES) {
      return {
        kind: "deny",
        code: "file_too_large",
        reason: `${info.size} bytes > cap ${MAX_FILE_BYTES}`,
      };
    }

    let buf: Buffer;
    try {
      buf = await readFile(safe.resolved);
    } catch (err: unknown) {
      return {
        kind: "deny",
        code: "read_failed",
        reason: (err as Error).message ?? "read failed",
      };
    }
    const sniff = buf.subarray(0, Math.min(SNIFF_BYTES, buf.length));
    if (sniff.includes(0)) {
      return {
        kind: "deny",
        code: "binary_file",
        reason: "NUL byte detected in first 4KB",
      };
    }

    const sha256 = createHash("sha256").update(buf).digest("hex");
    const ledgerEntry = ctx.reads.get(safe.resolved);
    if (!ledgerEntry) {
      return {
        kind: "deny",
        code: "read_required",
        reason: `call read_file on ${safe.relative} before patching`,
      };
    }
    if (ledgerEntry.sha256 !== sha256) {
      return {
        kind: "deny",
        code: "stale_read",
        reason: `${safe.relative} changed since last read; re-read and rebuild hunks`,
      };
    }

    const parsedHunks = parsePatch(hunks);
    if (!parsedHunks.ok) {
      return {
        kind: "deny",
        code: parsedHunks.code,
        reason: parsedHunks.message,
      };
    }
    const before = buf.toString("utf-8");
    const validated = validateHunks(before, parsedHunks.hunks);
    if (!validated.ok) {
      return {
        kind: "deny",
        code: validated.code,
        reason: validated.message,
      };
    }

    const after = applyHunks(before, parsedHunks.hunks);
    const diff = computeUnifiedDiff(before, after, safe.relative);

    if (deps.bus) {
      deps.bus.publish({
        type: "patch.preview",
        layer: "backend",
        diff,
        files: [safe.relative],
      });
    }

    const addCount = countLines(diff, "+");
    const delCount = countLines(diff, "-");
    const reason = `writes ${safe.relative} (${parsedHunks.hunks.length} hunks, +${addCount}/-${delCount} lines)`;

    return {
      kind: "ask",
      reason,
      risk: "workspace_write",
      code: "edit_file_ask",
      diff,
      files: [safe.relative],
      // An editor keeps what it replaces (ADR 0074).
      undoable: true,
    };
  };
}

function countLines(diff: string, prefix: "+" | "-"): number {
  return countDiffLinesFor(diff, prefix);
}

export function registerEditFileRule(
  engine: RulePermissionEngine,
  deps: EditFileRuleDeps = {},
): void {
  engine.registerRule("edit_file", makeEditFileRule(deps));
}
