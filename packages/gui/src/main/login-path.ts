import { execFile } from "node:child_process";
import { basename } from "node:path";

/**
 * macOS login-shell PATH recovery (audit 2026-08-05, S7; ADR 0032, amended
 * 2026-09-23).
 *
 * A `.app` launched from Finder, Spotlight, or the Dock inherits launchd's
 * environment, not a shell's — PATH is roughly
 * `/usr/bin:/bin:/usr/sbin:/sbin`. Nothing a developer installed is on it:
 * Homebrew (`/opt/homebrew/bin`), nvm/fnm/volta node, pyenv, cargo, rustup,
 * or ripgrep. The same app launched from a terminal works perfectly, which is
 * exactly why this survives casual testing — and why CI cannot catch it
 * either: `mac-build.yml` starts the binary from a bash step that already has
 * the runner's full PATH.
 *
 * The consequences inside Herta are quiet rather than loud:
 *   - 板砖's shell starts with the inherited env, so `npm test` /
 *     `node script.js` / `cargo build` fail as "command not found" for a
 *     user whose terminal runs them fine.
 *
 * So the harness recovers the PATH the user's shell would have, once, at
 * startup. This is HARNESS-set: it does not touch — and must not be confused
 * with — the model-facing `env` allowlist in tools/run-command/env-guard.ts.
 * The model still cannot set PATH; the app simply starts with the right one.
 *
 * Explicitly NOT fixed by running commands through a login shell: that would
 * reopen the shell-body classification class (audit S4) for every command.
 *
 * The 2026-09-23 amendment (the pre-release platform review): the first cut
 * asked `-lc` only, which reads `.zprofile` but not `.zshrc` — where nvm,
 * fnm, conda, pyenv and bun install themselves — and it APPENDED the shell's
 * entries after launchd's, so `/usr/bin/python3` (Apple's) shadowed the
 * user's Homebrew one. Now an interactive login shell is asked too, its answer
 * is read between markers, and the shell's order leads.
 *
 * Linux too (the same day, the first AppImage): a desktop launch gets the
 * session's environment, built from `.profile`, and misses what `.bashrc`
 * sets up. Same probe; the terminal test there is stdin being a TTY.
 */

/** The non-interactive ask: fast, reads the login files only. */
const LOGIN_PROBE_TIMEOUT_MS = 2000;
/** The interactive ask: slower (a `.zshrc` loading nvm takes ~1 s), bounded
 *  so a hanging rc file cannot hold startup past this. Runs in PARALLEL with
 *  the login ask, so this is the whole worst case. */
const INTERACTIVE_PROBE_TIMEOUT_MS = 3000;

/** Entries worth keeping even if the login shell never answers — the common
 *  Homebrew prefixes, which is where `rg`/`node` usually live on a Mac. */
const DARWIN_FALLBACK = ["/opt/homebrew/bin", "/usr/local/bin"];

/** The PATH is printed between these, so whatever an rc file prints (a motd,
 *  a prompt theme's instant-prompt, "[oh-my-zsh] Would you like to update?")
 *  never glues itself onto an entry. */
const BEGIN = "__HERTA_PATH_BEGIN__";
const END = "__HERTA_PATH_END__";

/** One command every probed shell reads the same way: `printf` repeats its
 *  format per argument, so the markers and PATH land on lines of their own.
 *  fish 3 joins a path variable with `:` inside double quotes, like POSIX
 *  shells, so `"$PATH"` is the same string there. */
const PRINT_PATH = `printf '%s\\n' '${BEGIN}' "$PATH" '${END}'`;

/** Shells that understand `-l`, `-i`, `-c` and the command above. Anything
 *  else (nushell, xonsh, elvish, tcsh…) is not asked in its own syntax: the
 *  platform's default shell is (zsh on macOS, bash on Linux), which still
 *  reads the user's own rc files for that shell. */
const PROBEABLE_SHELLS = new Set(["zsh", "bash", "sh", "dash", "ksh", "fish"]);

export type ProbeMode = "login" | "interactive";

export interface LoginPathDeps {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Started from a terminal (stdin is a TTY): the PATH is already the
   *  shell's and nothing needs recovering. The only reliable signal on
   *  Linux, where a desktop launch's PATH is not launchd's tell-tale four
   *  entries; macOS also keeps its PATH-shape check. */
  readonly launchedFromTerminal?: boolean;
  /** Injected for tests; defaults to spawning the real shell. Returns the
   *  RAW stdout (markers included) or null on failure/timeout. */
  readonly probe?: (shell: string, mode: ProbeMode) => Promise<string | null>;
}

/** The PATH between the markers, or null when the output does not carry
 *  both (a shell that died in its rc file, an `exec` into another shell). */
export function parseProbeOutput(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  const begin = lines.lastIndexOf(BEGIN);
  if (begin < 0 || lines[begin + 2] !== END) return null;
  const path = (lines[begin + 1] ?? "").trim();
  return path.length > 0 ? path : null;
}

/** Ask a real shell. Exported so a POSIX test can run the exact command
 *  through a real bash / sh — the quoting is the part a fake cannot check. */
export function runShellProbe(
  shell: string,
  mode: ProbeMode,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      shell,
      [mode === "interactive" ? "-ilc" : "-lc", PRINT_PATH],
      {
        timeout:
          mode === "interactive"
            ? INTERACTIVE_PROBE_TIMEOUT_MS
            : LOGIN_PROBE_TIMEOUT_MS,
        windowsHide: true,
      },
      (err, stdout) => {
        // A non-zero exit can still have printed the PATH (an rc file whose
        // LAST command failed) — the markers decide, not the exit code. A
        // timeout kills the shell, and whatever it printed is discarded.
        if (err !== null && err.killed === true) {
          resolve(null);
          return;
        }
        resolve(typeof stdout === "string" ? stdout : null);
      },
    );
    // An rc file that prompts ("update oh-my-zsh? [Y/n]") reads EOF and moves
    // on instead of waiting out the timeout.
    child.stdin?.end();
    child.once("error", () => resolve(null));
  });
}

/** Merge `extra` into `base`, preserving base order and dropping duplicates
 *  and empties. Exported for testing. */
export function mergePath(
  base: string | undefined,
  extra: readonly string[],
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...(base ?? "").split(":"), ...extra]) {
    const entry = p.trim();
    if (entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.join(":");
}

/** The shell to ask: the user's own when it speaks the probe's syntax, else
 *  the platform's default one (zsh on macOS, bash on Linux). */
export function probeShell(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = "darwin",
): string {
  const shell = env.SHELL;
  if (shell !== undefined && PROBEABLE_SHELLS.has(basename(shell))) {
    return shell;
  }
  return platform === "linux" ? "/bin/bash" : "/bin/zsh";
}

/**
 * The PATH the app should run with, or null when nothing should change.
 * Never throws and never blocks longer than the interactive probe's timeout.
 */
export async function resolveLoginPath(
  deps: LoginPathDeps,
): Promise<string | null> {
  const darwin = deps.platform === "darwin";
  // Linux too since 2026-09-23 (the first AppImage): a desktop launcher or a
  // file-manager double-click hands the app the SESSION's environment, which
  // `.profile` built — and `.bashrc`, where nvm, pyenv, conda and cargo put
  // themselves, is not part of it.
  if (!darwin && deps.platform !== "linux") return null;
  if (deps.launchedFromTerminal === true) return null;
  const current = deps.env.PATH;
  // macOS: a PATH carrying anything beyond the launchd defaults was
  // inherited from a shell (or already repaired) and needs no help.
  const looksInherited =
    darwin &&
    current?.split(":").some((p) => {
      const e = p.trim();
      return (
        e.length > 0 &&
        e !== "/usr/bin" &&
        e !== "/bin" &&
        e !== "/usr/sbin" &&
        e !== "/sbin"
      );
    });
  if (looksInherited === true) return null;

  const shell = probeShell(deps.env, deps.platform);
  const probe = deps.probe ?? runShellProbe;
  const ask = (mode: ProbeMode): Promise<string | null> =>
    probe(shell, mode)
      .then((out) => (out === null ? null : parseProbeOutput(out)))
      .catch(() => null);
  // Both at once: the interactive answer is the complete one (it has read
  // `.zshrc`), the login answer is the floor when an rc file hangs or exits.
  const [interactive, login] = await Promise.all([
    ask("interactive"),
    ask("login"),
  ]);
  const fromShell = interactive ?? login;
  const inherited = (current ?? "").split(":");
  // Linux has no well-known prefix to fall back on: without an answer, the
  // session's PATH stands as it is.
  if (!darwin && fromShell === null) return null;
  // The shell's order LEADS — it is the order the user's terminal resolves
  // commands in — and the inherited entries it lacks follow (on Linux these
  // include the AppImage's own `$APPDIR` entries, now at the back where they
  // shadow nothing). On macOS the Homebrew prefixes lead when the shell never
  // answered, as `brew shellenv` would.
  const fallback = darwin ? DARWIN_FALLBACK : [];
  const merged =
    fromShell !== null
      ? mergePath(fromShell, [...inherited, ...fallback])
      : mergePath(fallback.join(":"), inherited);
  return merged === (current ?? "") ? null : merged;
}

/**
 * Applies the recovered PATH to this process, so every child spawned later
 * (板砖's shell, the repository probe) inherits it. Call once at launch; the
 * session service's bootstrap waits for it before it starts any child
 * (`SettingsHooks.pathReady`).
 */
export async function applyLoginPath(
  deps: LoginPathDeps,
  setPath: (value: string) => void = (v) => {
    process.env.PATH = v;
  },
): Promise<string | null> {
  const next = await resolveLoginPath(deps);
  if (next !== null) setPath(next);
  return next;
}

/**
 * The character encoding a Finder-launched child needs (2026-09-23). launchd
 * gives the app no `LANG` / `LC_*` at all, so every child 板砖 runs — Ruby
 * (CocoaPods, fastlane), Perl, `sort`, `wc -m` — falls back to the C locale:
 * CocoaPods refuses to run ("requires your terminal to be using UTF-8") and
 * byte-counting tools miscount Chinese. Terminal.app sets a locale for its
 * shells, which is why none of this shows from a terminal.
 *
 * `LC_CTYPE=UTF-8` is the least that fixes it: the encoding only, no claim
 * about language or region (a guessed `zh_CN.UTF-8` would change messages
 * and collation). It is the value Terminal itself uses when its "set locale
 * environment variables" option is off, and macOS ships that locale. Darwin
 * only — glibc has no locale named `UTF-8`. Returns the variables to set,
 * empty when any locale variable is already present.
 */
export function launchLocaleEnv(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  if (platform !== "darwin") return {};
  const present = (k: string): boolean => (env[k] ?? "").length > 0;
  if (present("LANG") || present("LC_ALL") || present("LC_CTYPE")) return {};
  return { LC_CTYPE: "UTF-8" };
}
