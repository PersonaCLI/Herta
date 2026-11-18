import { describe, expect, it } from "vitest";
import { noexecCommand } from "./noexec.js";
import { classifyShellCommandDetailed } from "./shell-classifier.js";
import { makeMsysPaths, type ShellPaths } from "./shell-paths.js";

// Review 2026-11-10: `set -n` held a bash call open until its timeout and
// lost the shell. The line is refused before it is sent.

const WIN = process.platform === "win32";
const WS = WIN ? "E:\\repo" : "/home/u/repo";
const paths: ShellPaths = WIN
  ? makeMsysPaths("C:\\Users\\u\\AppData\\Local\\Temp")
  : {
      toNative: (p) => (p.startsWith("/") ? p : null),
      toShell: (p) => p,
      tmpNative: null,
    };
const found = (line: string): string | null =>
  noexecCommand(
    classifyShellCommandDetailed(line, { workspaceRoot: WS, paths }).steps ??
      [],
  );

describe("noexecCommand — the line that would stop the shell running anything", () => {
  it("finds set -n, -o noexec and a cluster with n, wherever the line has it", () => {
    for (const line of [
      "set -n",
      "set -o noexec",
      "set -en",
      "set -eo noexec",
      "echo hi; set -n; echo never",
      "if true; then set -n; fi",
      "cd src && set -n",
    ]) {
      expect(found(line), line).not.toBeNull();
    }
  });

  it("leaves every other set, and set -n as text or as another program's option", () => {
    for (const line of [
      "set -euo pipefail",
      "set -e",
      "set +n",
      "set +o noexec",
      "set -o pipefail",
      "set -- -n",
      "set -- a b",
      "echo set -n",
      "bash -n script.sh",
      "grep -n set file.txt",
      "sort -n list.txt",
    ]) {
      expect(found(line), line).toBeNull();
    }
  });
});
