import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

/**
 * Locate a POSIX shell for the minimal contract's `bash` tool (ADR 0040).
 *
 * Order:
 *   1. `HERTA_BASH` — explicit override (tests, unusual installs).
 *   2. On Windows: Git for Windows' bash next to the `git` on PATH
 *      (`<git root>\bin\bash.exe`, also `usr\bin`), then the usual install
 *      roots. `C:\Windows\System32\bash.exe` is deliberately SKIPPED — it is
 *      the WSL launcher, a different operating system with a different
 *      filesystem, not a shell over this workspace.
 *   3. On POSIX: `bash` on PATH, then the conventional absolute locations.
 *
 * Returns null when nothing usable exists. The session then has no backend
 * and says so (ADR 0086); nothing is fallen back to and nothing runs
 * half-configured.
 */
export function findBash(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.HERTA_BASH;
  if (override !== undefined && override.length > 0) {
    return existsSync(override) ? resolve(override) : null;
  }
  const isWin = process.platform === "win32";
  const pathEntries = (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .filter(Boolean);

  if (isWin) {
    // 2a. bash beside the git on PATH: git.exe lives in <root>\cmd or
    // <root>\bin (or a package-manager shim that points into one).
    for (const dir of pathEntries) {
      for (const name of ["git.exe", "git.cmd"]) {
        const git = join(dir, name);
        if (!existsSync(git)) continue;
        const root = dirname(dirname(git));
        for (const rel of ["bin\\bash.exe", "usr\\bin\\bash.exe"]) {
          const candidate = join(root, rel);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
    // 2b. a bash.exe on PATH that is NOT the System32 WSL launcher.
    for (const dir of pathEntries) {
      const candidate = join(dir, "bash.exe");
      if (existsSync(candidate) && !/\\system32\\?$/i.test(dir)) {
        return candidate;
      }
    }
    // 2c. conventional Git for Windows / scoop roots.
    const roots = [
      env.ProgramFiles !== undefined ? join(env.ProgramFiles, "Git") : null,
      env["ProgramFiles(x86)"] !== undefined
        ? join(env["ProgramFiles(x86)"] as string, "Git")
        : null,
      env.LOCALAPPDATA !== undefined
        ? join(env.LOCALAPPDATA, "Programs", "Git")
        : null,
      env.USERPROFILE !== undefined
        ? join(env.USERPROFILE, "scoop", "apps", "git", "current")
        : null,
    ].filter((r): r is string => r !== null);
    for (const root of roots) {
      for (const rel of ["bin\\bash.exe", "usr\\bin\\bash.exe"]) {
        const candidate = join(root, rel);
        if (existsSync(candidate)) return candidate;
      }
    }
    return null;
  }

  for (const dir of pathEntries) {
    const candidate = join(dir, "bash");
    if (existsSync(candidate)) return candidate;
  }
  for (const candidate of [
    "/bin/bash",
    "/usr/bin/bash",
    "/usr/local/bin/bash",
    "/opt/homebrew/bin/bash",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
