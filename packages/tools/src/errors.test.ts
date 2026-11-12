import { describe, expect, it } from "vitest";
import { TOOL_ERROR_CODES, type ToolErrorCode } from "./errors.js";

describe("ToolErrorCode", () => {
  it("exposes all documented error codes", () => {
    expect(TOOL_ERROR_CODES).toEqual([
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
      // git can block forever on a credential prompt or an unreachable
      // remote, and one caller is a permission rule on the Electron main
      // process — the spawn is bounded now, so the timeout is its own code.
      "git_timeout",
      // An editor refuses a file whose bytes are not UTF-8 rather than
      // rewriting every one of them as U+FFFD (ADR 0045).
      "non_utf8_file",
      "not_a_repo",
    ]);
  });

  it("compiles with the type", () => {
    const code: ToolErrorCode = "not_found";
    expect(code).toBe("not_found");
  });
});
