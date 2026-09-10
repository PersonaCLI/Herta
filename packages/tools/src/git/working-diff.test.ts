import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeWorkingDiff } from "./working-diff.js";

const GIT_AVAILABLE = (() => {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function mkDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe.skipIf(!GIT_AVAILABLE)(
  "describeWorkingDiff (ADR 0059 §5)",
  { timeout: 60_000 },
  () => {
    const git = (dir: string, ...a: string[]) =>
      spawnSync("git", a, { cwd: dir, encoding: "utf8" });

    function seeded(): string {
      const dir = mkDir("wdiff-");
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "t@t");
      git(dir, "config", "user.name", "Tester");
      git(dir, "config", "commit.gpgsign", "false");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"), "one\ntwo\n");
      writeFileSync(join(dir, "gone.ts"), "x\ny\ny\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "init");
      return dir;
    }

    it("a tracked edit: staged and unstaged together against HEAD, with counts", async () => {
      const dir = seeded();
      writeFileSync(join(dir, "src", "a.ts"), "one\nthree\n");
      git(dir, "add", "src/a.ts");
      writeFileSync(join(dir, "src", "a.ts"), "one\nthree\nfour\n");
      const d = await describeWorkingDiff(dir, "src/a.ts");
      expect(d).not.toBeNull();
      expect(d?.untracked).toBe(false);
      expect(d?.missing).toBe(false);
      expect(d?.added).toBe(2);
      expect(d?.deleted).toBe(1);
      expect(d?.patch).toContain("-two");
      expect(d?.patch).toContain("+three");
      expect(d?.patch).toContain("+four");
      expect(d?.patchTruncated).toBe(false);
    });

    it("a file whose name begins with `-` is a file, not an option — every spawn puts the path after `--` (2026-09-10)", async () => {
      const dir = seeded();
      writeFileSync(join(dir, "-c"), "dash\n");
      const d = await describeWorkingDiff(dir, "-c");
      expect(d).not.toBeNull();
      expect(d?.untracked).toBe(true);
      expect(d?.added).toBe(1);
      expect(d?.patch).toContain("+dash");
      // NUL can never be an argument.
      expect(await describeWorkingDiff(dir, "a\0b")).toBeNull();
    });

    it("an untracked file is a whole addition; a staged-new file reads against HEAD", async () => {
      const dir = seeded();
      writeFileSync(join(dir, "notes.txt"), "scratch\nmore\n");
      const u = await describeWorkingDiff(dir, "notes.txt");
      expect(u?.untracked).toBe(true);
      expect(u?.added).toBe(2);
      expect(u?.deleted).toBe(0);
      expect(u?.patch).toContain("+scratch");
      writeFileSync(join(dir, "src", "new.ts"), "created\n");
      git(dir, "add", "src/new.ts");
      const s = await describeWorkingDiff(dir, "src/new.ts");
      expect(s?.untracked).toBe(false);
      expect(s?.added).toBe(1);
      expect(s?.patch).toContain("+created");
    });

    it("a deleted tracked file is missing and reads as a deletion", async () => {
      const dir = seeded();
      unlinkSync(join(dir, "gone.ts"));
      const d = await describeWorkingDiff(dir, "gone.ts");
      expect(d?.missing).toBe(true);
      expect(d?.untracked).toBe(false);
      expect(d?.deleted).toBe(3);
      expect(d?.patch).toContain("-x");
    });

    it("an unchanged tracked file answers an empty patch, not null", async () => {
      const dir = seeded();
      const d = await describeWorkingDiff(dir, "src/a.ts");
      expect(d?.patch).toBe("");
      expect(d?.added).toBe(0);
      expect(d?.deleted).toBe(0);
    });

    it("a repository with no commits yet shows every file whole", async () => {
      const dir = mkDir("wdiff-unborn-");
      git(dir, "init", "-q", "-b", "main");
      writeFileSync(join(dir, "first.ts"), "a\nb\n");
      git(dir, "add", "first.ts");
      const d = await describeWorkingDiff(dir, "first.ts");
      expect(d?.added).toBe(2);
      expect(d?.patch).toContain("+a");
    });

    it("answers null for an option-shaped path, an unknown untracked path, and outside a repo", async () => {
      const dir = seeded();
      await expect(describeWorkingDiff(dir, "--no-index")).resolves.toBeNull();
      await expect(describeWorkingDiff(dir, "")).resolves.toBeNull();
      await expect(describeWorkingDiff(dir, "nope.txt")).resolves.toBeNull();
      const plain = mkDir("wdiff-plain-");
      writeFileSync(join(plain, "x.txt"), "x\n");
      await expect(describeWorkingDiff(plain, "x.txt")).resolves.toBeNull();
    });
  },
);
