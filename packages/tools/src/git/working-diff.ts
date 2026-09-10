import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { hardenedGitArgs, spawnGit } from "./spawn-git.js";

/**
 * One path's working-tree change against HEAD, for the viewer's diff tab
 * (ADR 0059 §5): staged and unstaged together — what a commit of this
 * path would contain. An UNTRACKED file has no HEAD side, so it is shown
 * as a whole addition (`diff --no-index` against `/dev/null`, which git
 * treats as the empty file on every platform); the same reading serves a
 * repository with no commits yet, where every file is new.
 *
 * `path` is WORKSPACE-relative — the caller (the GUI main process) has
 * already jailed it to the workspace (ADR 0050 §2), which is what keeps
 * the `--no-index` read from reaching a file outside it. A path that
 * could read as an option never reaches argv. Null, never a throw, for
 * everything git cannot answer.
 */
export interface WorkingDiff {
  /** The path as asked, workspace-relative. */
  readonly path: string;
  /** Not in the index: shown as a whole addition. */
  readonly untracked: boolean;
  /** Gone from the working tree (a deletion, staged or not). */
  readonly missing: boolean;
  /** Unified diff, no colour; a PREFIX when `patchTruncated`. */
  readonly patch: string;
  readonly patchTruncated: boolean;
  /** Lines added / deleted; null for a binary file. */
  readonly added: number | null;
  readonly deleted: number | null;
}

export const MAX_WORKING_DIFF_BYTES = 1024 * 1024;

export async function describeWorkingDiff(
  workspaceRoot: string,
  path: string,
  signal?: AbortSignal,
): Promise<WorkingDiff | null> {
  try {
    return await describe(workspaceRoot, path, signal);
  } catch {
    return null;
  }
}

const DIFF_OPTS: readonly string[] = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
];

async function describe(
  workspaceRoot: string,
  path: string,
  signal?: AbortSignal,
): Promise<WorkingDiff | null> {
  // Every spawn below places the path after `--`, so a name that begins
  // with `-` is a file, not an option (2026-09-10: the refusal here left a
  // file literally named `-c` unable to open its diff). NUL cannot be an
  // argument at all.
  if (path.length === 0 || path.includes("\0")) return null;
  const sig = signal ?? new AbortController().signal;
  const opts = { timeoutMs: 5_000 } as const;

  // Tracked or not, and whether HEAD exists at all — both decide which
  // diff is the honest one.
  const [listed, head] = await Promise.all([
    spawnGit(
      workspaceRoot,
      hardenedGitArgs(["ls-files", "--", path]),
      sig,
      opts,
    ),
    spawnGit(
      workspaceRoot,
      hardenedGitArgs(["rev-parse", "--verify", "--quiet", "HEAD"]),
      sig,
      { ...opts, allowExitCodes: [1] },
    ),
  ]);
  if (!listed.ok || !head.ok) return null;
  const untracked = listed.stdout.trim().length === 0;
  const unborn = head.exitCode !== 0;
  const missing = !existsSync(resolve(workspaceRoot, path));
  if (untracked && missing) return null;

  const wholeFile = untracked || unborn;
  const base = wholeFile
    ? ["--no-index", "--", "/dev/null", path]
    : ["-M", "HEAD", "--", path];
  // `--no-index` exits 1 to say "there were differences" — an answer.
  const exits = wholeFile ? { allowExitCodes: [1] } : {};
  const [patch, nums] = await Promise.all([
    spawnGit(
      workspaceRoot,
      hardenedGitArgs(["diff", ...DIFF_OPTS, ...base]),
      sig,
      { ...opts, ...exits, maxBufBytes: MAX_WORKING_DIFF_BYTES },
    ),
    spawnGit(
      workspaceRoot,
      hardenedGitArgs(["diff", "--numstat", ...DIFF_OPTS, ...base]),
      sig,
      { ...opts, ...exits },
    ),
  ]);
  if (!patch.ok || !nums.ok) return null;

  const [a = "", d = ""] = nums.stdout.trim().split("\t");
  const num = (s: string): number | null => {
    if (s === "-") return null;
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    path,
    untracked,
    missing,
    patch: patch.stdout,
    patchTruncated: patch.truncated,
    added: nums.stdout.length === 0 ? 0 : num(a),
    deleted: nums.stdout.length === 0 ? 0 : num(d),
  };
}
