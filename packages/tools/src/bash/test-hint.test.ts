import { minimalBackendContract } from "@herta/core";
import { describe, expect, it } from "vitest";
import { testRunnerExit } from "./index.js";

// Owner 2026-11-13. 板砖's prompt says, up front, where a test result is
// read: in the live run of that day it learned it from a note in the
// result, anew in 3 of 4 runs, and ran the tests twice each time. A prompt
// that says one thing while the reader does another would be worse than no
// prompt, so each thing the sentence says is held here against
// `testRunnerExit`, the reader itself.

const prompts = [
  minimalBackendContract("en", "/ws"),
  minimalBackendContract("zh", "/ws"),
];

describe("the prompt's sentence on where a test result is read", () => {
  it("is in both languages, with the same example and the same two warnings", () => {
    for (const prompt of prompts) {
      expect(prompt).toContain("npm test 2>&1 | tail -40");
      expect(prompt).toContain("; echo $?");
      expect(prompt).toContain("|| true");
    }
    expect(prompts[0]).toContain("in a call of their own, as its last command");
    expect(prompts[1]).toContain("单独跑一条命令，放在这一行的最后");
  });

  it("the example it gives as fine is read, by the runner's own stage", () => {
    expect(testRunnerExit("npm test 2>&1 | tail -40", 0, [1, 0])).toEqual({
      read: true,
      exit: 1,
    });
    expect(testRunnerExit("npm test 2>&1 | tail -40", 0, [0, 0])).toEqual({
      read: true,
      exit: 0,
    });
    // "As its last command", not its only one, and the other runner it names.
    expect(
      testRunnerExit("cd pkg && npm test 2>&1 | tail -40", 0, [1, 0]),
    ).toEqual({ read: true, exit: 1 });
    expect(testRunnerExit("node --test 2>&1 | tail -40", 0, [1, 0])).toEqual({
      read: true,
      exit: 1,
    });
    expect(testRunnerExit("npm test", 1, [1])).toEqual({
      read: true,
      exit: 1,
    });
  });

  it("the two endings it warns against are not read", () => {
    for (const line of [
      "npm test; echo $?",
      'npm test 2>&1 | tail -40; echo "$?"',
      // What 板砖 wrote in the live run, in three runs of four.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own `${PIPESTATUS[0]}`, not a template
      'npm test 2>&1 | tail -8; echo "EXIT=${PIPESTATUS[0]}"',
      "npm test || true",
      "npm test 2>&1 | tail -40 || true",
    ]) {
      expect(testRunnerExit(line, 0, [0]), line).toEqual({ read: false });
    }
  });

  it("'a call of their own': tests that share a call with a heredoc are not read either", () => {
    // Two of the live run's three unread lines wrote the test file and ran
    // the tests in one call.
    expect(
      testRunnerExit(
        "cat > test/t.test.mjs <<'EOF'\nimport 'node:test';\nEOF\nnpm test 2>&1 | tail -40",
        0,
        [0, 0],
      ),
    ).toEqual({ read: false });
  });
});
