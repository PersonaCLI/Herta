import { describe, expect, it } from "vitest";
import { classifyShellCommandDetailed } from "./shell-classifier.js";
import { makeMsysPaths, type ShellPaths } from "./shell-paths.js";
import { execTakesOverShell } from "./shell-takeover.js";

// 2026-11-19, measured on the real shell: `exec <program>` replaced it (state
// lost, or the call held until its timeout) and `exec >file` moved its own
// output, the end-of-call line with it.

const WIN = process.platform === "win32";
const WS = WIN ? "E:\\repo" : "/home/u/repo";
const paths: ShellPaths = WIN
  ? makeMsysPaths("C:\\Users\\u\\AppData\\Local\\Temp")
  : {
      toNative: (p) => (p.startsWith("/") ? p : null),
      toShell: (p) => p,
      tmpNative: null,
    };
const found = (line: string) =>
  execTakesOverShell(
    classifyShellCommandDetailed(line, { workspaceRoot: WS, paths }).steps ??
      [],
    line,
  );

describe("execTakesOverShell — an exec that would take the persistent shell over", () => {
  it("a program replaces the shell", () => {
    for (const line of [
      "exec bash",
      "exec sleep 30",
      "exec -a name node server.js",
      "exec -l bash",
      "cd sub && exec npm start",
    ]) {
      expect(found(line), line).toMatchObject({ replaces: true });
    }
  });

  it("moving descriptor 1 takes the shell's own output", () => {
    for (const line of [
      "exec >out.txt",
      "exec 1>out.txt",
      "exec >>log.txt",
      "exec &>all.txt",
      "exec >&2",
      "exec 1>&-",
    ]) {
      expect(found(line), line).toMatchObject({ replaces: false });
    }
  });

  it("descriptors 0, 2 and others, a named one, and no exec at all are left alone", () => {
    for (const line of [
      "exec 2>err.txt",
      "exec 3>three.txt",
      "exec <in.txt",
      "exec 2>&1",
      "exec {fd}>f.txt",
      "echo exec bash",
      "npm run exec",
      // Quoted text is not a command, beside a real exec or not.
      'echo "exec >log"',
      'echo "x; exec >log"; exec 2>err.txt',
    ]) {
      expect(found(line), line).toBeNull();
    }
  });
});
