import { describe, expect, it } from "vitest";
import {
  COMMAND_TOOLS,
  JOURNAL_COMMAND_TOOLS,
  JOURNAL_WRITING_TOOLS,
  WRITING_TOOLS,
} from "./tool-kinds.js";

describe("tool kinds, said once (review 2026-11-10)", () => {
  it("names the tools 板砖 has, and nothing of the deleted set (ADR 0086)", () => {
    expect([...COMMAND_TOOLS]).toEqual(["bash"]);
    expect([...WRITING_TOOLS]).toEqual(["str_replace_editor"]);
  });

  it("the journal's seal also knows the names a journal on disk may hold", () => {
    expect([...JOURNAL_COMMAND_TOOLS].sort()).toEqual(["bash", "run_command"]);
    expect([...JOURNAL_WRITING_TOOLS].sort()).toEqual([
      "edit_file",
      "str_replace_editor",
      "write_new_file",
    ]);
    // Every tool 板砖 has is one a journal may name.
    for (const tool of COMMAND_TOOLS)
      expect(JOURNAL_COMMAND_TOOLS.has(tool)).toBe(true);
    for (const tool of WRITING_TOOLS)
      expect(JOURNAL_WRITING_TOOLS.has(tool)).toBe(true);
  });

  it("no tool is both", () => {
    for (const tool of JOURNAL_COMMAND_TOOLS)
      expect(JOURNAL_WRITING_TOOLS.has(tool)).toBe(false);
  });
});
