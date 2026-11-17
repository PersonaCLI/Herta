import { describe, expect, it } from "vitest";
import { classifyCommand } from "../run-command/classifier.js";
import { classifyShellCommandDetailed } from "./shell-classifier.js";
import { makeMsysPaths, type ShellPaths } from "./shell-paths.js";

// Owner 2026-11-16, from the review of 2026-11-10: four of the project's own
// checks still asked as "unrecognized command" every time.

const WIN = process.platform === "win32";
const WS = WIN ? "E:\\repo" : "/home/u/repo";
const INSIDE_ABS = WIN ? "/e/repo/pkg" : "/home/u/repo/pkg";
const paths: ShellPaths = WIN
  ? makeMsysPaths("C:\\Users\\u\\AppData\\Local\\Temp")
  : {
      toNative: (p) => (p.startsWith("/") ? p : null),
      toShell: (p) => p,
      tmpNative: null,
    };
const verdict = (line: string) =>
  classifyShellCommandDetailed(line, { workspaceRoot: WS, paths }).verdict;
const kind = (line: string) => verdict(line).kind;

describe("the project's own checks run without asking (owner 2026-11-16)", () => {
  it("pnpm typecheck, as pnpm lint", () => {
    for (const line of [
      "pnpm typecheck",
      "pnpm run typecheck",
      "npm run typecheck",
    ]) {
      expect(kind(line), line).toBe("allow");
    }
  });

  it("vitest run, with the flags that select and report", () => {
    for (const line of [
      "vitest run",
      "vitest run src/parser",
      'vitest run -t "parses dates"',
      "vitest run --testNamePattern=dates",
      "vitest run --reporter=verbose",
      "vitest run --reporter dot --bail",
      "vitest run --bail=1 --silent --passWithNoTests",
      "vitest run --project web --maxWorkers=2",
    ]) {
      expect(kind(line), line).toBe("allow");
    }
  });

  it("vitest asks when it loads a file, writes one, watches, or takes a flag not listed", () => {
    for (const line of [
      "vitest",
      "vitest watch",
      "vitest run --config ../other/vitest.config.ts",
      "vitest run --root ..",
      "vitest run --reporter ./my-reporter.mjs",
      "vitest run --reporter=html",
      "vitest run --reporter=json --outputFile=out.json",
      "vitest run -u",
      "vitest run --update",
      "vitest run --coverage",
      "vitest run --globalSetup ./setup.ts",
      "npx vitest run",
    ]) {
      expect(kind(line), line).toBe("ask");
    }
  });

  it("pnpm --filter <name> test, by package name", () => {
    for (const line of [
      "pnpm --filter @app/web test",
      "pnpm -F web test",
      "pnpm --filter=web run test",
      "pnpm --filter '@app/*' test",
      "pnpm --filter ...web test",
      "pnpm --filter web... test",
    ]) {
      expect(kind(line), line).toBe("allow");
    }
  });

  it("a path selector, or another script, still asks", () => {
    for (const line of [
      "pnpm --filter ./packages/web test",
      "pnpm --filter . test",
      "pnpm --filter .. test",
      "pnpm --filter '{../other}' test",
      "pnpm --filter '[origin/main]' test",
      "pnpm --filter web build",
      "pnpm --filter web exec node x.js",
    ]) {
      expect(kind(line), line).toBe("ask");
    }
  });

  it("npm test --prefix <dir> inside the workspace, in every spelling", () => {
    for (const line of [
      "npm test --prefix pkg",
      "npm --prefix pkg test",
      "npm test --prefix=pkg",
      "npm t --prefix pkg",
      "npm run test --prefix pkg",
      `npm test --prefix ${INSIDE_ABS}`,
      "pnpm -C pkg test",
      "pnpm --dir pkg run test",
      "pnpm test --prefix ./pkg",
    ]) {
      expect(kind(line), line).toBe("allow");
    }
  });

  it("a directory outside the workspace, another script or another hatch keeps asking", () => {
    for (const line of [
      "npm test --prefix ../other",
      "npm test --prefix /tmp/x",
      "npm test --prefix ..",
      "pnpm -C ../other test",
      "npm install --prefix pkg",
      "npm run build --prefix pkg",
      "npm test --prefix pkg --script-shell ./evil.sh",
      "npm test --prefix pkg --node-options=--require=./x.js",
      // Spellings the resolver cannot place as bash would: `~` is the home,
      // a variable or a pattern is whatever it expands to.
      "npm test --prefix ~",
      "npm test --prefix ~/x",
      "npm test --prefix=~/x",
      "npm test --prefix $DIR",
      "npm test --prefix 'p*'",
      // A test script inside the harness's state is not the project's.
      "npm test --prefix .herta",
      "npm test --prefix .herta/x",
    ]) {
      expect(kind(line), line).toBe("ask");
    }
    // The red team's line stays an ask, in its own class.
    expect(verdict("npm test --prefix ../evil")).toMatchObject({
      kind: "ask",
      code: "command_ask_opaque",
    });
  });

  it("without a caller that can resolve the directory, --prefix asks as before", () => {
    // `run_command`'s argv rule (a dev server's argv) has no cwd to resolve
    // against and passes no `insideWorkspace`.
    expect(classifyCommand(["npm", "test", "--prefix", "pkg"]).kind).toBe(
      "ask",
    );
    expect(
      classifyCommand(["npm", "test", "--prefix", "pkg"], {
        insideWorkspace: () => true,
      }).kind,
    ).toBe("allow");
    expect(
      classifyCommand(["npm", "test", "--prefix", "pkg"], {
        insideWorkspace: () => false,
      }).kind,
    ).toBe("ask");
  });
});
