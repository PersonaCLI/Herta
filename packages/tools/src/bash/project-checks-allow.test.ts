import { describe, expect, it } from "vitest";
import { classifyCommand } from "../run-command/classifier.js";
import { classifyShellCommandDetailed } from "./shell-classifier.js";
import { makeMsysPaths, type ShellPaths } from "./shell-paths.js";

// Owner 2026-11-16, from the review of 2026-11-10: four of the project's own
// checks still asked as "unrecognized command" every time, and a find that
// only reads landed in the one class no automatic review can answer.

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

describe("a find that only reads asks as a read, which a review can answer (owner 2026-11-16)", () => {
  it("-exec of wc, grep, cat, head or ls", () => {
    for (const line of [
      "find . -name '*.ts' -exec wc -l {} +",
      "find src -name '*.js' -exec grep -l TODO {} \\;",
      "find . -type f -exec ls -l {} +",
      "find . -name '*.md' -exec head -n 3 {} \\;",
      "find . -execdir cat {} +",
      // Leaving `.herta` out of the walk is not reaching into it.
      "find . -not -path './.herta/*' -exec wc -l {} +",
    ]) {
      expect(verdict(line), line).toMatchObject({
        kind: "ask",
        code: "command_ask_recursive_read",
      });
    }
  });

  it("is judged as a plain find is: a start outside the workspace, a credential, -L", () => {
    // The realpath half of the reader guard runs only on a line that allows,
    // so the classifier reads the operands of one that asks.
    for (const line of [
      "find .. -exec cat {} +",
      "find . -exec cat ~/.ssh/id_rsa \\;",
      "find . -exec grep -f ~/.ssh/id_rsa {} +",
      "find . -exec cat .env \\;",
      "find . -name '*.pem' -exec cat {} +",
      "find -L . -exec cat {} +",
    ]) {
      expect(verdict(line), line).toMatchObject({
        kind: "ask",
        code: "command_ask_reader_path",
      });
    }
  });

  it("a find that reads inside .herta or the harness's home is refused, as before", () => {
    for (const line of [
      "find .herta -exec cat {} +",
      "find src .herta -exec wc -l {} +",
      `find ${WIN ? "E:/repo" : "/home/u/repo"}/.herta -exec cat {} +`,
      "find ~/.herta -exec cat {} +",
    ]) {
      expect(kind(line), line).toBe("block");
    }
  });

  it("an -exec group with no end is not one that only reads", () => {
    expect(verdict("find . -exec wc")).toMatchObject({
      code: "command_ask_harness_state",
    });
  });

  it("anything that deletes, writes or runs another program stays in the owner-only class", () => {
    for (const line of [
      "find . -delete",
      "find . -exec rm {} +",
      "find . -exec cat {} + -delete",
      "find . -exec sh -c 'cat $1' _ {} \\;",
      "find . -name x -exec grep -l y {} \\; -exec rm {} \\;",
      "find . -ok cat {} \\;",
    ]) {
      expect(verdict(line), line).toMatchObject({
        kind: "ask",
        code: "command_ask_harness_state",
      });
    }
  });

  it("a writing find into .herta is still refused outright", () => {
    expect(kind("find .herta -exec rm {} +")).toBe("block");
    expect(kind("find .herta -fprint list.txt")).not.toBe("allow");
  });
});

describe("what the test script is handed beyond its plain run (owner 2026-11-20)", () => {
  it("a flag that writes or loads a file asks, by npm after -- or by pnpm at once", () => {
    for (const line of [
      "pnpm test -- -u",
      "pnpm test -u",
      "npm t -- -u",
      "npm test -- --coverage",
      "pnpm test -- --coverage.enabled",
      "npm test -- --reporter ./my-reporter.js",
      "pnpm run test -- --config other.config.js",
      "npm test -- --require ./hook.js",
      "pnpm --filter web test -- -u",
      "npm test --prefix pkg -- -u",
    ]) {
      expect(verdict(line), line).toMatchObject({
        kind: "ask",
        code: "command_ask_script",
      });
    }
  });

  it("filters, printing reporters, watch mode and npm's own flags still run", () => {
    for (const line of [
      "npm test",
      "npm test -- parser",
      "pnpm test -- -t parses",
      "npm test -- --reporter=verbose",
      "pnpm test --watch",
      "pnpm typecheck --watch",
      "npm test -u",
    ]) {
      expect(kind(line), line).toBe("allow");
    }
  });
});

describe("a fix handed to the lint script (owner 2026-11-20)", () => {
  it("--fix and --write ask: the rewrite goes round the editor's diff and undo", () => {
    for (const line of [
      "pnpm lint --fix",
      "npm run lint -- --fix",
      "pnpm run lint --write",
      "pnpm lint -- --fix",
    ]) {
      expect(verdict(line), line).toMatchObject({
        kind: "ask",
        code: "command_ask_script",
      });
    }
  });

  it("the plain lint run, and its other flags, still run", () => {
    for (const line of [
      "pnpm lint",
      "npm run lint",
      "pnpm lint --max-warnings 0",
      "npm run lint -- --quiet",
    ]) {
      expect(kind(line), line).toBe("allow");
    }
  });
});
