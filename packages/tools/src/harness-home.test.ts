import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyShellCommandDetailed,
  type ShellClassifyOpts,
} from "./bash/shell-classifier.js";
import { makeMsysPaths, type ShellPaths } from "./bash/shell-paths.js";
import {
  harnessHomeWriteDenial,
  holdsHarnessHome,
  patternReachesHarnessHome,
} from "./path-safety.js";
import { runCommandWriteGuard } from "./run-command/rule.js";

// The owner's automatic-review choices live in the harness's home,
// `<home>/.herta/review-choices.json`, for every workspace (ADR 0064
// amendment 2026-11-12). No command may write there, however it spells the
// place — and a managed workspace, which lives under it, stays writable.

const paths: ShellPaths =
  process.platform === "win32"
    ? makeMsysPaths(tmpdir())
    : {
        toNative: (p) => (p.startsWith("/") ? p : null),
        toShell: (p) => p,
        tmpNative: null,
      };

let base: string;
let home: string;
let state: string;
let ws: string;
let managed: string;
beforeEach(async () => {
  // Real folders, canonically spelled: the guards realpath what exists.
  base = await realpath(await mkdtemp(join(tmpdir(), "harness-home-")));
  home = join(base, "home");
  state = join(home, ".herta");
  // A picked workspace that the home does not hold.
  ws = join(base, "project");
  managed = join(state, "workspaces", "abc");
  await mkdir(join(state, "memory"), { recursive: true });
  await mkdir(join(ws, "src"), { recursive: true });
  await mkdir(join(ws, ".herta"), { recursive: true });
  await mkdir(join(managed, "src"), { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("harnessHomeWriteDenial — the harness's home is not command-writable", () => {
  it("refuses the home's .herta: the choices file, anything beside it, the folder itself", () => {
    expect(
      harnessHomeWriteDenial(join(state, "review-choices.json"), home),
    ).toMatch(/harness's home folder/);
    expect(
      harnessHomeWriteDenial(join(state, "memory", "user.jsonl"), home),
    ).not.toBeNull();
    expect(
      harnessHomeWriteDenial(join(state, "new-file"), home),
    ).not.toBeNull();
    expect(harnessHomeWriteDenial(state, home)).not.toBeNull();
  });

  it("leaves the managed workspaces under it, and everything outside it, to the other rules", () => {
    expect(harnessHomeWriteDenial(join(managed, "out.txt"), home)).toBeNull();
    expect(
      harnessHomeWriteDenial(join(managed, ".herta", "p.json"), home),
    ).toBeNull();
    expect(harnessHomeWriteDenial(join(state, "workspaces"), home)).toBeNull();
    expect(harnessHomeWriteDenial(join(home, "notes.txt"), home)).toBeNull();
    expect(harnessHomeWriteDenial(home, home)).toBeNull();
    expect(harnessHomeWriteDenial(join(ws, "src", "a.ts"), home)).toBeNull();
    // A folder that merely has the name, elsewhere.
    expect(harnessHomeWriteDenial(join(ws, ".herta", "x"), home)).toBeNull();
  });

  it("reads a path as it lands: `..` out of a managed workspace, and a link from outside", async () => {
    expect(
      harnessHomeWriteDenial(
        join(managed, "..", "..", "review-choices.json"),
        home,
      ),
    ).not.toBeNull();
    await symlink(
      state,
      join(ws, "lnk"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      harnessHomeWriteDenial(join(ws, "lnk", "review-choices.json"), home),
    ).not.toBeNull();
    // A link INSIDE a managed workspace that points back up into the home.
    await symlink(
      state,
      join(managed, "up"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      harnessHomeWriteDenial(join(managed, "up", "review-choices.json"), home),
    ).not.toBeNull();
  });

  it.skipIf(process.platform !== "win32")(
    "another case of the path is the same place",
    () => {
      expect(
        harnessHomeWriteDenial(
          join(state, "review-choices.json").toUpperCase(),
          home,
        ),
      ).not.toBeNull();
    },
  );
});

describe("holdsHarnessHome — a walk started there reaches it", () => {
  it("the home's .herta, the home, and every folder above", () => {
    expect(holdsHarnessHome(state, home)).toBe(true);
    expect(holdsHarnessHome(home, home)).toBe(true);
    expect(holdsHarnessHome(base, home)).toBe(true);
    expect(holdsHarnessHome(dirname(base), home)).toBe(true);
  });

  it("nothing beside or below it", () => {
    expect(holdsHarnessHome(ws, home)).toBe(false);
    expect(holdsHarnessHome(join(state, "memory"), home)).toBe(false);
    expect(holdsHarnessHome(managed, home)).toBe(false);
    expect(holdsHarnessHome(join(home, "Documents"), home)).toBe(false);
  });
});

describe("patternReachesHarnessHome — a pattern bash would expand", () => {
  it("a segment that could be .herta, under bash's rule that a leading dot is spelled", () => {
    for (const p of [
      join(home, ".h*", "review-choices.json"),
      join(home, ".herta", "rev*"),
      join(home, ".h*"),
      join(home, ".[h]erta", "x"),
      join(home, ".her?a", "x"),
      join(home, ".*", "x"),
      // It could be a managed workspace — or the choices file's own folder.
      join(home, ".herta", "*", "x"),
    ]) {
      expect(patternReachesHarnessHome(p, home), p).toBe(true);
    }
  });

  it("not a pattern that cannot be it, and not the managed workspaces", () => {
    for (const p of [
      join(home, "*", "x"),
      join(home, "?herta", "x"),
      join(home, "Doc*", "x"),
      join(ws, ".h*", "x"),
      join(home, ".herta", "workspaces", "abc", "x"),
      join(home, ".herta", "workspaces", "a*", "x"),
      join(home, ".h*", "workspaces", "abc", "x"),
      base,
    ]) {
      expect(patternReachesHarnessHome(p, home), p).toBe(false);
    }
  });
});

describe("the shell classifier refuses every spelling of a write into the harness's home", () => {
  const classify = (line: string, over: Partial<ShellClassifyOpts> = {}) =>
    classifyShellCommandDetailed(line, {
      workspaceRoot: ws,
      paths,
      cwd: ws,
      home,
      ...over,
    });
  const codesOf = (line: string, over: Partial<ShellClassifyOpts> = {}) => {
    const r = classify(line, over);
    return r.verdict.kind === "ask"
      ? (r.codes ?? [r.verdict.code])
      : [r.verdict.kind];
  };
  const blocked = (line: string, over: Partial<ShellClassifyOpts> = {}) =>
    classify(line, over).verdict.kind === "block";
  const homeShell = () => paths.toShell(home);

  it("a write there is BLOCKED, named or not: absolute, through ~, through a pattern", () => {
    const h = homeShell();
    for (const line of [
      `echo x > ${h}/.herta/review-choices.json`,
      `echo x >> ${h}/.herta/review-choices.json`,
      `echo x > ${h}/.h*/review-choices.json`,
      `echo x > ${h}/.herta/rev*`,
      "echo x > ~/.herta/review-choices.json",
      "echo x > ~/.h*/review-choices.json",
      'echo x > "$HOME/.herta/review-choices.json"',
      `cp src/a.json ${h}/.herta/review-choices.json`,
      `tee ${h}/.herta/review-choices.json`,
      `rm -rf ${h}/.herta`,
      `rm ${h}/.herta/review-choices.json`,
      `mv ${h}/.herta ${h}/elsewhere`,
      "rm -rf ~/.herta",
    ]) {
      expect(blocked(line), line).toBe(true);
    }
  });

  it("a cd into it is the owner's alone, never an ordinary leave: literal, through ~, through a pattern", () => {
    const h = homeShell();
    for (const line of [
      "cd ~/.herta && echo x > review-choices.json",
      "cd ~/.h* && echo x > rev*",
      `cd ${h}/.herta && echo x > review-choices.json`,
      `cd ${h}/.h* && echo x > rev*`,
      `pushd ${h}/.herta`,
    ]) {
      expect(codesOf(line), line).toContain("command_ask_harness_state");
    }
  });

  it("a walk that starts at or above it asks as a reach into the harness's state", () => {
    const h = homeShell();
    expect(codesOf(`find ${h} -name '*.json' -delete`)).toContain(
      "command_ask_harness_state",
    );
    // Started inside it, the walk's own start is a write there: refused.
    expect(blocked(`find ${h}/.herta -type f -delete`)).toBe(true);
    // `find ~ … -delete` was already in the block tier (a system path).
    expect(blocked("find ~ -name '*.json' -delete")).toBe(true);
    // A walk that only reads is not this guard's.
    expect(codesOf(`find ${h} -name x`)).not.toContain(
      "command_ask_harness_state",
    );
  });

  it("ordinary lines are what they were", () => {
    expect(codesOf("cd src && ls")).toEqual(["allow"]);
    expect(codesOf("echo x > src/a.txt")).toEqual(["command_ask_write"]);
    expect(codesOf("cd .. && ls")).toEqual(["command_ask_cwd_escape"]);
    expect(blocked("echo x > .herta/permissions.json")).toBe(true);
    // The home itself is not the harness's: a write there leaves the
    // workspace, as before.
    expect(blocked(`echo x > ${homeShell()}/notes.txt`)).toBe(false);
    expect(codesOf(`echo x > ${homeShell()}/notes.txt`)).not.toContain(
      "command_ask_harness_state",
    );
  });

  it("a managed workspace, which lives under the home's .herta, works as any workspace", () => {
    const inManaged = { workspaceRoot: managed, cwd: managed };
    expect(codesOf("cd src && ls", inManaged)).toEqual(["allow"]);
    expect(codesOf("echo x > out.txt", inManaged)).toEqual([
      "command_ask_write",
    ]);
    expect(codesOf("echo x > src/a.txt", inManaged)).toEqual([
      "command_ask_write",
    ]);
    // Its own .herta is the workspace guard's, as before.
    expect(blocked("echo x > .herta/permissions.json", inManaged)).toBe(true);
    // One step up is the folder of the managed workspaces: an ordinary leave.
    expect(codesOf("cd .. && ls", inManaged)).toEqual([
      "command_ask_cwd_escape",
    ]);
    // Two steps up is the harness's home.
    expect(codesOf("cd ../.. && ls", inManaged)).toContain(
      "command_ask_harness_state",
    );
    expect(blocked("echo x > ../../review-choices.json", inManaged)).toBe(true);
    expect(blocked("cp out.txt ../../review-choices.json", inManaged)).toBe(
      true,
    );
  });
});

describe("the argv rule's guard knows the harness's home too (a dev server's argv)", () => {
  it("refuses a written operand there, and sees a walk from above it", () => {
    // The machine's own home: nothing is written, the paths are only read.
    const real = homedir();
    const guard = runCommandWriteGuard(ws, ws);
    expect(guard.path(join(real, ".herta", "review-choices.json"))).toMatch(
      /harness's home folder/,
    );
    expect(guard.path(join(ws, "src", "a.txt"))).toBeNull();
    expect(guard.holds?.(real)).toBe(true);
    expect(guard.holds?.(join(ws, "src"))).toBe(false);
  });
});
