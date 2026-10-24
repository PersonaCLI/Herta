import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyProbeFailure,
  describeRepoContext,
  describeRepoOutcome,
  detectInProgressState,
  diffCommittedRange,
  probeRepoState,
  resolveGitDir,
} from "./repo-probe.js";

// Every describe below carries a 60 s timeout, the git-fixture budget the
// rest of this package uses: under the full suite's load a fixture that
// pushes to and prunes a bare origin took 23 s on Windows (the "gone
// upstream" case, 2026-09-17 and 09-18 — 2 s alone), and a 20 s budget
// reported the file red with every assertion green.
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
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

describe.skipIf(!GIT_AVAILABLE)("probeRepoState", { timeout: 60_000 }, () => {
  const git = (dir: string, ...a: string[]) =>
    spawnSync("git", a, { cwd: dir, encoding: "utf8" });

  function seeded(): string {
    const dir = mkDir("probe-");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@t");
    git(dir, "config", "user.name", "T");
    git(dir, "config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "a.ts"), "one\n");
    writeFileSync(join(dir, "b.ts"), "two\n");
    writeFileSync(join(dir, "gone.ts"), "three\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    return dir;
  }

  it("returns null on abort instead of throwing through its own contract", async () => {
    // `spawnGit` REJECTS on abort — correctly, since an interrupt is not a
    // tool failure — so a user's Stop landing mid-probe threw straight past
    // "returns null rather than throwing for every cannot-tell case". One
    // caller happened to wrap it; the invariant must not depend on that.
    const dir = seeded();
    const ac = new AbortController();
    ac.abort();
    await expect(probeRepoState(dir, ac.signal)).resolves.toBeNull();
  });

  it("separates what the dispatch changed from what was already dirty", async () => {
    const dir = seeded();
    // The USER has uncommitted work before the dispatch starts.
    writeFileSync(join(dir, "a.ts"), "one\nuser edit\n");
    const before = await probeRepoState(dir);
    expect(before?.dirty).toEqual(["a.ts"]);

    // 板砖 works through the SHELL — no editor tool involved, and one of these
    // is a DELETE, which no editor can even express.
    writeFileSync(join(dir, "b.ts"), "two\nbanzhuan\n");
    writeFileSync(join(dir, "new.ts"), "created\n");
    unlinkSync(join(dir, "gone.ts"));

    const after = await probeRepoState(dir);
    expect(after?.head).toBe(before?.head);
    const wasDirty = new Set(before?.dirty ?? []);
    const attributed = (after?.dirty ?? []).filter((p) => !wasDirty.has(p));
    expect(attributed.sort()).toEqual(["b.ts", "gone.ts", "new.ts"]);
    expect(attributed).not.toContain("a.ts");
  });

  it("reports an unborn branch as head null rather than failing", async () => {
    const dir = mkDir("probe-unborn-");
    git(dir, "init", "-q", "-b", "main");
    const snap = await probeRepoState(dir);
    expect(snap).not.toBeNull();
    expect(snap?.head).toBeNull();
  });

  it("returns null outside a repo, and never throws", async () => {
    await expect(probeRepoState(mkDir("probe-plain-"))).resolves.toBeNull();
    await expect(
      probeRepoState(join(mkDir("probe-gone-"), "no-such-dir")),
    ).resolves.toBeNull();
  });

  it("counts both sides of a rename as changed", async () => {
    const dir = seeded();
    const before = await probeRepoState(dir);
    git(dir, "mv", "a.ts", "renamed.ts");
    const after = await probeRepoState(dir);
    const wasDirty = new Set(before?.dirty ?? []);
    const attributed = (after?.dirty ?? []).filter((p) => !wasDirty.has(p));
    // The new path exists and the old one is gone — both are changes.
    expect(attributed.sort()).toEqual(["a.ts", "renamed.ts"]);
  });
});

describe("detectInProgressState (fs only, no git needed)", () => {
  it("names each transient state, rebase first, and null when clean", () => {
    const gitDir = mkDir("state-");
    expect(detectInProgressState(gitDir)).toBeNull();
    writeFileSync(join(gitDir, "MERGE_HEAD"), "abc\n");
    expect(detectInProgressState(gitDir)).toBe("merge");
    // A conflicted rebase stop can leave other heads around too — rebase wins.
    mkdirSync(join(gitDir, "rebase-merge"));
    expect(detectInProgressState(gitDir)).toBe("rebase");
    rmSync(join(gitDir, "rebase-merge"), { recursive: true });
    rmSync(join(gitDir, "MERGE_HEAD"));
    writeFileSync(join(gitDir, "CHERRY_PICK_HEAD"), "abc\n");
    expect(detectInProgressState(gitDir)).toBe("cherry-pick");
    rmSync(join(gitDir, "CHERRY_PICK_HEAD"));
    writeFileSync(join(gitDir, "BISECT_LOG"), "log\n");
    expect(detectInProgressState(gitDir)).toBe("bisect");
  });

  it("returns null (not a throw) on a nonexistent dir", () => {
    expect(detectInProgressState(join(mkDir("state-gone-"), "nope"))).toBe(
      null,
    );
  });
});

describe.skipIf(!GIT_AVAILABLE)("resolveGitDir", { timeout: 60_000 }, () => {
  const git = (dir: string, ...a: string[]) =>
    spawnSync("git", a, { cwd: dir, encoding: "utf8" });

  it("finds the .git dir from the root and from a subdirectory", () => {
    const dir = mkDir("gitdir-");
    git(dir, "init", "-q", "-b", "main");
    const sub = join(dir, "src");
    mkdirSync(sub);
    expect(resolveGitDir(dir)).toBe(join(dir, ".git"));
    expect(resolveGitDir(sub)).toBe(join(dir, ".git"));
  });

  it("follows a worktree's gitdir pointer file", () => {
    const dir = mkDir("gitdir-wt-");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@t");
    git(dir, "config", "user.name", "T");
    git(dir, "config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "a.ts"), "one\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    const wt = join(dir, "wt");
    git(dir, "worktree", "add", "-q", wt, "-b", "side");
    const resolved = resolveGitDir(wt);
    // The linked worktree's private git dir, where its own transient state
    // (MERGE_HEAD, rebase-merge) lives. Git writes the pointer with forward
    // slashes even on Windows — compare separator-agnostically.
    expect(resolved?.replaceAll("\\", "/")).toContain(".git/worktrees");
  });

  it("returns null outside any repo", () => {
    expect(resolveGitDir(mkDir("gitdir-plain-"))).toBeNull();
  });
});

describe.skipIf(!GIT_AVAILABLE)(
  "describeRepoContext",
  // 60s: each test spawns a dozen real git processes plus the probe's four,
  // and under full-suite load individual spawns have been observed at 3.5s+
  // (the 2026-07-05 flake class) — 20s tripped on the first full-suite run.
  { timeout: 60_000 },
  () => {
    const git = (dir: string, ...a: string[]) =>
      spawnSync("git", a, { cwd: dir, encoding: "utf8" });

    function seeded(): string {
      const dir = mkDir("ctx-");
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "t@t");
      git(dir, "config", "user.name", "T");
      git(dir, "config", "commit.gpgsign", "false");
      writeFileSync(join(dir, "a.ts"), "one\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "init: seed");
      return dir;
    }

    it("describes a clean seeded repo", async () => {
      const dir = seeded();
      const ctx = await describeRepoContext(dir);
      expect(ctx).not.toBeNull();
      // Git spells the top level with forward slashes; the temp dir may not.
      expect(ctx?.root.replaceAll("\\", "/").toLowerCase()).toBe(
        dir.replaceAll("\\", "/").toLowerCase(),
      );
      expect(ctx?.prefix).toBe("");
      expect(ctx?.gitDir).toBe(join(dir, ".git"));
      expect(ctx?.branch).toBe("main");
      expect(ctx?.detached).toBe(false);
      expect(ctx?.headShort).toMatch(/^[0-9a-f]{4,}$/);
      expect(ctx?.upstream).toBeNull();
      expect(ctx?.defaultBranch).toBeNull();
      expect(ctx?.inProgress).toBeNull();
      expect(ctx?.dirty).toEqual([]);
      expect(ctx?.dirtyTotal).toBe(0);
      expect(ctx?.recentSubjects).toHaveLength(1);
      expect(ctx?.recentSubjects[0]).toContain("init: seed");
    });

    it("a subfolder workspace reports the root, its prefix, and git's root-relative paths (ADR 0058 amendment)", async () => {
      const dir = seeded();
      const sub = join(dir, "packages", "gui");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "x.ts"), "x\n");
      writeFileSync(join(dir, "a.ts"), "one\nedited\n");
      const ctx = await describeRepoContext(sub);
      expect(ctx?.prefix).toBe("packages/gui/");
      expect(ctx?.root.replaceAll("\\", "/").toLowerCase()).toBe(
        dir.replaceAll("\\", "/").toLowerCase(),
      );
      expect(ctx?.gitDir).toBe(join(dir, ".git"));
      const paths = ctx?.dirty.map((f) => f.path).sort();
      expect(paths).toEqual(["a.ts", "packages/gui/x.ts"]);
    });

    it("carries up to ten recent subjects for the card, newest first (ADR 0058 §5.4)", async () => {
      const dir = seeded();
      for (let i = 1; i <= 11; i += 1) {
        git(dir, "commit", "-q", "--allow-empty", "-m", `step ${i}`);
      }
      const ctx = await describeRepoContext(dir);
      expect(ctx?.recentSubjects).toHaveLength(10);
      expect(ctx?.recentSubjects[0]).toMatch(/^[0-9a-f]{4,} step 11$/);
      expect(ctx?.recentSubjects[9]).toContain("step 2");
    });

    it("carries the dirty set with porcelain codes and an honest total", async () => {
      const dir = seeded();
      writeFileSync(join(dir, "a.ts"), "one\nedited\n");
      writeFileSync(join(dir, "new.ts"), "created\n");
      const ctx = await describeRepoContext(dir);
      expect(ctx?.dirtyTotal).toBe(2);
      const byPath = new Map(ctx?.dirty.map((f) => [f.path, f]));
      expect(byPath.get("a.ts")?.y).toBe("M");
      expect(byPath.get("new.ts")?.x).toBe("?");
    });

    it("reports upstream, ahead/behind, and the default branch when set", async () => {
      const dir = seeded();
      const origin = mkDir("ctx-origin-");
      git(origin, "init", "-q", "--bare");
      git(dir, "remote", "add", "origin", origin);
      git(dir, "push", "-q", "-u", "origin", "main");
      // Set origin/HEAD locally — what a clone gets for free.
      git(
        dir,
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      );
      writeFileSync(join(dir, "b.ts"), "two\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "ahead work");
      const ctx = await describeRepoContext(dir);
      expect(ctx?.upstream).toBe("origin/main");
      expect(ctx?.ahead).toBe(1);
      expect(ctx?.behind).toBe(0);
      expect(ctx?.defaultBranch).toBe("main");
    });

    it("reports an unborn branch honestly", async () => {
      const dir = mkDir("ctx-unborn-");
      git(dir, "init", "-q", "-b", "main");
      const ctx = await describeRepoContext(dir);
      expect(ctx?.branch).toBe("main");
      expect(ctx?.headShort).toBeNull();
      expect(ctx?.detached).toBe(false);
      expect(ctx?.recentSubjects).toEqual([]);
    });

    it("reports a detached HEAD as detached, not as a branch", async () => {
      const dir = seeded();
      git(dir, "checkout", "-q", "--detach");
      const ctx = await describeRepoContext(dir);
      expect(ctx?.detached).toBe(true);
      expect(ctx?.branch).toBeNull();
      expect(ctx?.headShort).not.toBeNull();
    });

    it("sees a merge in progress with its conflict set", async () => {
      const dir = seeded();
      git(dir, "checkout", "-qb", "side");
      writeFileSync(join(dir, "a.ts"), "side version\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "side edit");
      git(dir, "checkout", "-q", "main");
      writeFileSync(join(dir, "a.ts"), "main version\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "main edit");
      const merge = git(dir, "merge", "side");
      expect(merge.status).not.toBe(0); // conflicted, mid-flight
      const ctx = await describeRepoContext(dir);
      expect(ctx?.inProgress).toBe("merge");
      expect(ctx?.conflicted).toEqual(["a.ts"]);
    });

    it("returns null outside a repo and on abort, never throwing", async () => {
      await expect(
        describeRepoContext(mkDir("ctx-plain-")),
      ).resolves.toBeNull();
      const ac = new AbortController();
      ac.abort();
      await expect(
        describeRepoContext(seeded(), ac.signal),
      ).resolves.toBeNull();
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  "diffCommittedRange",
  // 60s like the other git-fixture describes (2026-08-31): under full-suite
  // contention on Windows these spawn-heavy cases run at 14s+ alone and blew
  // the 20s cap, taking a temp-dir EBUSY with them on cleanup.
  { timeout: 60_000 },
  () => {
    const git = (dir: string, ...a: string[]) =>
      spawnSync("git", a, { cwd: dir, encoding: "utf8" });
    const head = (dir: string) =>
      git(dir, "rev-parse", "HEAD").stdout?.trim() ?? "";

    function seeded(): string {
      const dir = mkDir("range-");
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "t@t");
      git(dir, "config", "user.name", "T");
      git(dir, "config", "commit.gpgsign", "false");
      writeFileSync(join(dir, "a.ts"), "one\n");
      writeFileSync(join(dir, "gone.ts"), "three\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "init");
      return dir;
    }

    it("attributes a forward range — add, modify, delete, and a rename as delete+create", async () => {
      const dir = seeded();
      const from = head(dir);
      writeFileSync(join(dir, "a.ts"), "one\nmore\n");
      writeFileSync(join(dir, "new.ts"), "created\n");
      unlinkSync(join(dir, "gone.ts"));
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "work");
      git(dir, "mv", "a.ts", "renamed.ts");
      git(dir, "commit", "-qm", "rename");
      const to = head(dir);

      const range = await diffCommittedRange(dir, from, to);
      expect(range).not.toBeNull();
      const byPath = new Map(range?.map((f) => [f.path, f.kind]));
      // --no-renames: the rename is honestly a delete + a create.
      expect(byPath.get("a.ts")).toBe("deleted");
      expect(byPath.get("renamed.ts")).toBe("created");
      expect(byPath.get("new.ts")).toBe("created");
      expect(byPath.get("gone.ts")).toBe("deleted");
    });

    it("returns null when the new head does not descend from the old (amend)", async () => {
      const dir = seeded();
      writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "work");
      const from = head(dir);
      git(dir, "commit", "-q", "--amend", "-m", "work, amended");
      const to = head(dir);
      expect(to).not.toBe(from);
      await expect(diffCommittedRange(dir, from, to)).resolves.toBeNull();
    });

    it("rejects anything that is not a commit id — an option can never reach argv", async () => {
      const dir = seeded();
      const to = head(dir);
      await expect(
        diffCommittedRange(dir, "--ext-diff", to),
      ).resolves.toBeNull();
      await expect(diffCommittedRange(dir, to, "HEAD~1")).resolves.toBeNull();
    });

    it("returns null on abort and outside a repo, never throwing", async () => {
      const dir = seeded();
      const h = head(dir);
      const ac = new AbortController();
      ac.abort();
      await expect(
        diffCommittedRange(dir, h, h, ac.signal),
      ).resolves.toBeNull();
      await expect(
        diffCommittedRange(mkDir("range-plain-"), h, h),
      ).resolves.toBeNull();
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  "describeRepoContext — a gone upstream (ADR 0058 §7)",
  { timeout: 60_000 },
  () => {
    const git = (dir: string, ...a: string[]) =>
      spawnSync("git", a, { cwd: dir, encoding: "utf8" });

    it("names the upstream as gone and marks every recent commit unpushed", async () => {
      const dir = mkDir("ctx-gone-");
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "t@t");
      git(dir, "config", "user.name", "T");
      git(dir, "config", "commit.gpgsign", "false");
      writeFileSync(join(dir, "a.ts"), "one\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "init");
      const origin = mkDir("ctx-gone-origin-");
      git(origin, "init", "-q", "--bare");
      git(origin, "config", "receive.denyDeleteCurrent", "ignore");
      git(dir, "remote", "add", "origin", origin);
      git(dir, "push", "-q", "-u", "origin", "main");
      git(dir, "commit", "-q", "--allow-empty", "-m", "after the merge");
      // The everyday case: the PR merged, its branch deleted on the remote.
      git(dir, "push", "-q", "origin", "--delete", "main");
      git(dir, "fetch", "-q", "--prune");
      const ctx = await describeRepoContext(dir);
      expect(ctx?.upstream).toBe("origin/main");
      expect(ctx?.upstreamGone).toBe(true);
      expect(ctx?.recentCommits.map((c) => c.unpushed)).toEqual([true, true]);
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  "describeRepoOutcome — absent is definite, transient is not (ADR 0058 §7.6)",
  { timeout: 60_000 },
  () => {
    it("a plain directory and a missing one are absent; an abort is transient; a repository is a repo", async () => {
      const plain = mkDir("outcome-plain-");
      expect(await describeRepoOutcome(plain)).toEqual({ kind: "absent" });
      expect(
        await describeRepoOutcome(join(mkDir("outcome-gone-"), "no-such-dir")),
      ).toEqual({ kind: "absent" });
      const ac = new AbortController();
      ac.abort();
      expect(await describeRepoOutcome(plain, ac.signal)).toEqual({
        kind: "transient",
        reason: "aborted",
      });
      const repo = mkDir("outcome-repo-");
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      const out = await describeRepoOutcome(repo);
      expect(out.kind).toBe("repo");
      if (out.kind === "repo") expect(out.repo.branch).toBe("main");
    });

    it("classifies a spawn failure: not-a-repo, no git and a vanished workspace are absent; a timeout, a failing command and anything else are transient", () => {
      expect(
        classifyProbeFailure({ ok: false, code: "not_a_repo", message: "" }),
      ).toBe("absent");
      expect(
        classifyProbeFailure({
          ok: false,
          code: "spawn_failed",
          message: "",
          cause: "git_not_found",
        }),
      ).toBe("absent");
      expect(
        classifyProbeFailure({
          ok: false,
          code: "spawn_failed",
          message: "",
          cause: "workspace_missing",
        }),
      ).toBe("absent");
      expect(
        classifyProbeFailure({ ok: false, code: "git_timeout", message: "" }),
      ).toBe("transient");
      expect(
        classifyProbeFailure({
          ok: false,
          code: "git_failed",
          message: "",
          exitCode: 128,
          stderr: "index.lock exists",
        }),
      ).toBe("transient");
      expect(
        classifyProbeFailure({
          ok: false,
          code: "spawn_failed",
          message: "",
          cause: "other",
        }),
      ).toBe("transient");
    });
  },
);
