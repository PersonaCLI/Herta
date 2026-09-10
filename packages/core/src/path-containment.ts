import nodePath from "node:path";

/**
 * Path containment, the ONE rule (2026-09-11, the post-0.1.5 refactor
 * pass). Eight guards across tools, core, knowledge and the desktop main
 * process each decided "is this path inside that root?" their own way —
 * three semantics between them: a `startsWith(root + sep)` prefix test
 * (exact case everywhere, with or without the root itself counting), a
 * `relative()`-based test (`..`-prefix / absolute means outside), and a
 * hand-folded lowercase prefix on win32. All were correct where they stood;
 * they disagreed only on case, and only on Windows.
 *
 * The policy here is the platform's own, which is what `path.relative`
 * implements: on win32 a path differing from the root only in case IS the
 * same file (drive letters, NTFS names), so it counts as inside; on POSIX
 * case is exact. Both inputs are resolved to absolute paths first; symlinks
 * are NOT followed — a guard that must judge where a link LANDS realpaths
 * before asking (path-safety, the workspace reader), as before.
 *
 * `strict` excludes the root itself: "below the root", for the guards that
 * delete or serve a derived child and must never act on the root.
 */
export interface PathContainmentOptions {
  readonly strict?: boolean;
}

/** The subset of `node:path` the rule needs — injectable so both platform
 *  flavours are tested on one machine. */
export interface PathApi {
  readonly resolve: (...segments: string[]) => string;
  readonly relative: (from: string, to: string) => string;
  readonly isAbsolute: (p: string) => boolean;
  readonly sep: string;
}

export function isPathInsideWith(
  api: PathApi,
  root: string,
  target: string,
  opts: PathContainmentOptions = {},
): boolean {
  const rel = api.relative(api.resolve(root), api.resolve(target));
  if (rel === "") return opts.strict !== true;
  // `..` alone or `..<sep>…` climbs out; `..foo` is a name (a sibling of
  // nothing — a child called `..foo`), which the old `startsWith("..")`
  // tests read as an escape. An absolute remainder is another drive.
  return (
    rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel)
  );
}

/** `target` is `root` itself (unless `strict`) or below it, by the
 *  platform's own case rule. */
export function isPathInside(
  root: string,
  target: string,
  opts: PathContainmentOptions = {},
): boolean {
  return isPathInsideWith(nodePath, root, target, opts);
}
