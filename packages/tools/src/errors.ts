import type { ToolResult } from "@herta/core";

/**
 * The one failed-`ToolResult` constructor. Five tools of the standard set
 * each carried a private `errResult` with a slightly different positional
 * shape until 2026-08-19 (ADR 0041 follow-up); this is the union of them,
 * and it outlived them (ADR 0086): `suggestion` and `summary` optional
 * (summary defaults to `failed: <code>`), `retryable` last and false by
 * default. `suggestion` is included only when given so the result shape is
 * identical to a hand-built object.
 */
export function errResult<T = unknown>(
  code: string,
  message: string,
  suggestion?: string,
  summary: string = `failed: ${code}`,
  retryable = false,
): ToolResult<T> {
  return {
    ok: false,
    error: { code, message, retryable },
    ...(suggestion !== undefined ? { suggestion } : {}),
    summary,
  };
}

export type ToolErrorCode =
  | "path_denied"
  | "path_outside_workspace"
  | "not_found"
  | "file_too_large"
  | "binary_file"
  | "invalid_input"
  | "read_failed"
  | "parse_failed"
  | "hunk_not_found"
  | "hunk_ambiguous"
  | "hunk_overlap"
  | "write_failed"
  | "command_blocked"
  | "timeout"
  | "spawn_failed"
  | "plan_invalid"
  | "unknown_plan_item"
  | "git_failed"
  | "git_timeout"
  | "non_utf8_file"
  | "not_a_repo";

export const TOOL_ERROR_CODES: readonly ToolErrorCode[] = [
  "path_denied",
  "path_outside_workspace",
  "not_found",
  "file_too_large",
  "binary_file",
  "invalid_input",
  "read_failed",
  "parse_failed",
  "hunk_not_found",
  "hunk_ambiguous",
  "hunk_overlap",
  "write_failed",
  "command_blocked",
  "timeout",
  "spawn_failed",
  "plan_invalid",
  "unknown_plan_item",
  "git_failed",
  "git_timeout",
  "non_utf8_file",
  "not_a_repo",
] as const;
