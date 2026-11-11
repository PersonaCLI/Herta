import { describe, expect, it } from "vitest";
import { COMMAND_TOOLS, WRITING_TOOLS } from "./tool-kinds.js";

describe("tool kinds, said once (review 2026-11-10)", () => {
  it("names both contracts' tools: a tool added to one is added here", () => {
    expect([...COMMAND_TOOLS].sort()).toEqual(["bash", "run_command"]);
    expect([...WRITING_TOOLS].sort()).toEqual([
      "edit_file",
      "str_replace_editor",
      "write_new_file",
    ]);
  });

  it("no tool is both", () => {
    for (const tool of COMMAND_TOOLS)
      expect(WRITING_TOOLS.has(tool)).toBe(false);
  });
});
