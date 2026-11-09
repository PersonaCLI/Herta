/**
 * Model-supplied child-environment guard (ADR 0025 slice 4; inverted to an
 * ALLOWLIST 2026-08-05 after audit finding S1).
 *
 * The `env` parameter exists so a command can get NODE_ENV/PORT-style knobs.
 * It must not become a tier-escalation channel: `run_command` tiers the
 * COMMAND (argv), and several allow-tier commands — `git status`, `git diff`,
 * `pytest`, `npm test` — run with NO approval card at all. Any env key that
 * changes how the child resolves, loads, or configures code turns those into
 * arbitrary execution that the user never sees.
 *
 * WHY AN ALLOWLIST. This was a denylist of ~22 keys plus LD_/DYLD_ prefixes,
 * and it was demonstrably incomplete. Proven on 2026-08-05 against the real
 * binary: `git diff` is unconditional allow-tier, and
 *
 *     GIT_CONFIG_COUNT=1
 *     GIT_CONFIG_KEY_0=diff.external
 *     GIT_CONFIG_VALUE_0=<attacker command>
 *
 * made it execute that command — no prompt anywhere in the path. The old list
 * enumerated git's EXEC-hook variables (GIT_SSH, GIT_PAGER, GIT_EXTERNAL_DIFF,
 * …) and simply did not contain the GIT_CONFIG_* family, which can set ANY git
 * config key including every one of those hooks. The same shape exists for
 * module search paths (PYTHONPATH + a planted sitecustomize.py under the
 * unconditional `pytest` allow, NODE_PATH, PERL5LIB, RUBYLIB, GEM_PATH,
 * CLASSPATH) and would exist for the next tool that grows a config-injection
 * variable.
 *
 * Enumerating loader/config-injection variables is provably non-exhaustive, so
 * the guard is inverted: only keys known to be inert are accepted, and the
 * default answer is no.
 *
 * ESCAPE HATCH, deliberately user-visible: a genuinely-needed exotic variable
 * can still be set through a shell form (`sh -c 'FOO=bar cmd'`), which is
 * interpreter/ask tier — so the user sees the whole thing on an approval card
 * before it runs. Capability is preserved; silent capability is not.
 */

/**
 * Environment keys that cannot influence how a child resolves, loads, or
 * configures code — only what it prints or which mode it runs in. Compared
 * case-insensitively (Windows env lookups fold case, so `path` IS PATH).
 *
 * Deliberately NOT here, with reasons, so nobody re-adds them casually:
 *   - GIT_* (any)      GIT_CONFIG_* sets arbitrary git config incl. exec hooks
 *   - PYTHONPATH,      module search paths — a planted module executes on
 *     NODE_PATH,       import, under commands that are allow-tier
 *     PERL5LIB, RUBYLIB, GEM_PATH, CLASSPATH
 *   - NODE_OPTIONS,    interpreter preload flags (--require, -e)
 *     PERL5OPT, RUBYOPT, JAVA_TOOL_OPTIONS
 *   - GOFLAGS          -toolexec runs an arbitrary program
 *   - npm_config_*     npm_config_script_shell replaces the shell
 *   - PATH-likes, LD_ and DYLD_ prefixes, BASH_ENV, PYTHONSTARTUP,
 *     PROMPT_COMMAND, COMSPEC
 */
const ALLOWED_ENV_KEYS = new Set(
  [
    // The documented use case: build/run mode and where a dev server binds.
    "NODE_ENV",
    "PORT",
    "HOST",
    // Test-runner behaviour.
    "CI",
    // Deterministic output: locale and timezone.
    "TZ",
    "LANG",
    "LC_ALL",
    // Output formatting — the usual reason a tool's output is unreadable.
    "NO_COLOR",
    "FORCE_COLOR",
    "TERM",
    // Log verbosity knobs that select namespaces/levels, not code.
    "DEBUG",
    "RUST_LOG",
    "RUST_BACKTRACE",
    // Python runtime behaviour (NOT PYTHONPATH / PYTHONSTARTUP).
    "PYTHONUNBUFFERED",
    "PYTHONDONTWRITEBYTECODE",
  ].map((k) => k.toUpperCase()),
);

/** The allowed set, for error messages and docs. */
export const allowedEnvKeys: readonly string[] = [...ALLOWED_ENV_KEYS].sort();

/**
 * Returns the first key that is NOT on the allowlist, or null when every key
 * is acceptable. Fail-closed by construction: an unrecognized key is refused
 * rather than reasoned about.
 */
export function findDisallowedEnvKey(
  env: Readonly<Record<string, string>>,
): string | null {
  for (const key of Object.keys(env)) {
    if (!ALLOWED_ENV_KEYS.has(key.toUpperCase())) return key;
  }
  return null;
}

/** Lower-case names some setups do export: a Cygwin-style shell's own temp
 *  variables, and Windows' spelling of its system directory. */
const LOWERCASE_ENV_NAMES = new Set(["tmp", "temp", "tmpdir", "windir"]);

/**
 * True when `name` reads as a script's own variable — `f`, `i`, `line`, `_` —
 * and not as one a program takes from its environment.
 *
 * For the sites that assign WITHOUT spelling `K=V`: a loop's variable,
 * `getopts`' target. `for f in a b c` is the most ordinary loop a model
 * writes, and a card about `f` would be one nobody reads. But the loop is an
 * assignment all the same, and to a variable the shell already exports it is
 * an assignment every later program sees: `for NODE_OPTIONS in
 * --require=./x.js; do npm test; done` ran with no card (review 2026-11-10).
 * So what such a site asks is whether the name could be one of those. The
 * environment's names are upper-case by convention; the lower-case ones are
 * few, and refused here by family — npm's `npm_config_*` / `npm_package_*`,
 * the `*_proxy` names, and the short list above.
 *
 * This widens nothing: `findDisallowedEnvKey` is untouched, a spelled `n=0`
 * asks as it did, and so does every export.
 */
export function isShellLocalName(name: string): boolean {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) return false;
  if (name.startsWith("npm_") || name.endsWith("_proxy")) return false;
  return !LOWERCASE_ENV_NAMES.has(name);
}
