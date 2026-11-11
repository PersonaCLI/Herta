/**
 * Once per test run: say so when a package's build is older than its source
 * (review 2026-11-10).
 *
 * Each package exports its `dist`, and a test of one package imports the
 * others through it. `vitest run` builds nothing. So after an edit to
 * `packages/tools/src`, a test in `packages/core` or a lab script still ran
 * the tools of the last `pnpm build`, and passed or failed for code that was
 * no longer there. Nothing said so: the run looked like any other.
 *
 * This only warns. A stale build is sometimes what is wanted (a test of the
 * package just edited reads its own source and needs no build), and a check
 * that failed the run would be turned off the first time it was in the way.
 *
 * A package's last build is its `tsconfig.tsbuildinfo`, which `tsc -b`
 * rewrites whenever it compiles; its source is every file under `src` that
 * another package could import, so not a test and not a fixture.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The packages others import through `dist`. `cli` and `gui` are leaves. */
const BUILT_PACKAGES = [
  "core",
  "memory",
  "providers",
  "tools",
  "knowledge",
  "herta",
  "app-server",
] as const;

/** A save and a build in the same moment are not a stale build. */
const SLACK_MS = 2_000;

export interface StaleBuild {
  readonly pkg: string;
  /** The newest source file, relative to the package. */
  readonly file: string;
  /** How much newer than the build it is. */
  readonly behindMs: number;
}

function isImportable(name: string): boolean {
  return (
    /\.(ts|tsx)$/.test(name) &&
    !/\.test\.(ts|tsx)$/.test(name) &&
    !name.endsWith(".d.ts")
  );
}

function newestSource(dir: string): { file: string; mtimeMs: number } | null {
  let newest: { file: string; mtimeMs: number } | null = null;
  const walk = (at: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__fixtures__" && entry.name !== "node_modules") {
          walk(path);
        }
        continue;
      }
      if (!entry.isFile() || !isImportable(entry.name)) continue;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (newest === null || mtimeMs > newest.mtimeMs) {
        newest = { file: path, mtimeMs };
      }
    }
  };
  walk(dir);
  return newest;
}

/** The packages under `root` whose source is newer than their last build. A
 *  package that was never built is not listed: importing it fails by itself. */
export function staleBuilds(
  root: string,
  packages: readonly string[] = BUILT_PACKAGES,
): StaleBuild[] {
  const stale: StaleBuild[] = [];
  for (const pkg of packages) {
    const dir = join(root, "packages", pkg);
    const info = join(dir, "tsconfig.tsbuildinfo");
    if (!existsSync(info) || !existsSync(join(dir, "dist"))) continue;
    let builtMs: number;
    try {
      builtMs = statSync(info).mtimeMs;
    } catch {
      continue;
    }
    const newest = newestSource(join(dir, "src"));
    if (newest === null || newest.mtimeMs <= builtMs + SLACK_MS) continue;
    stale.push({
      pkg,
      file: relative(dir, newest.file).replace(/\\/g, "/"),
      behindMs: newest.mtimeMs - builtMs,
    });
  }
  return stale;
}

function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

export function staleBuildWarning(stale: readonly StaleBuild[]): string | null {
  if (stale.length === 0) return null;
  return [
    "",
    "⚠ Built output is older than the source in:",
    ...stale.map(
      (s) =>
        `    packages/${s.pkg}  (${s.file} is ${span(s.behindMs)} newer than its build)`,
    ),
    "  A test of ANOTHER package imports that build, not the source. Run `pnpm build` if this run should see the edit.",
    "",
  ].join("\n");
}

export default function warnStaleDist(): void {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const warning = staleBuildWarning(staleBuilds(root));
  if (warning !== null) console.warn(warning);
}
