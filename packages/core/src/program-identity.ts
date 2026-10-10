/**
 * What a command's first word says about what it will run — the sets the
 * task-scoped approval cache (ADR 0026) and the classifier share.
 *
 * These lived with ADR 0030's project command rules, which derived and
 * matched persisted allow rules by the same shapes. The rules were removed
 * on 2026-10-10 (automatic review answers a recurring command now); the
 * sets stay, because the cache needs the same distinctions: bare `node`
 * would cover `node -e '<anything>'`, a wrapper would cover whatever it
 * wraps.
 */

/** Script interpreters. Bare argv[0] is an arbitrary-code grant, but
 *  interpreter + workspace script path constrains WHAT runs to a file the
 *  record's diffs track. The run_command classifier uses the SAME set to
 *  give these an honest `command_ask_interpreter` class instead of
 *  「未识别的命令」 — one source, so classification and caching can't drift. */
export const SCRIPT_INTERPRETERS: ReadonlySet<string> = new Set([
  "node",
  "nodejs",
  "python",
  "python3",
  "ruby",
  "perl",
  "deno",
  "bun",
  "ts-node",
  "tsx",
]);

/** Programs that run what their arguments say. Shells and `-c`-style
 *  wrappers execute arbitrary bodies; env/xargs/sudo-alikes exec their
 *  arguments; npx/make fetch or dispatch code the argv doesn't name. A
 *  remembered approval of any of these is an arbitrary-execution grant, so
 *  the task cache never keys one (audit 2026-08-05, S5: approving
 *  `timeout 600 npm run build` silently pre-approved `timeout 5 node -e
 *  '<payload>'` for the rest of the task). */
export const RUNS_ITS_ARGUMENTS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "cmd",
  "powershell",
  "pwsh",
  "env",
  "xargs",
  "npx",
  "make",
  "sudo",
  "doas",
  "pkexec",
  "nice",
  "nohup",
  "timeout",
  "time",
  "stdbuf",
]);

/** argv[0] normalized for SET MEMBERSHIP checks only (dir + `.exe` stripped,
 *  lowercased). */
export function binaryBasename(a0: string): string {
  const base = a0.split(/[\\/]/).pop() ?? a0;
  return base.toLowerCase().replace(/\.exe$/, "");
}

const ABSOLUTE_OR_HOME = /^([A-Za-z]:|[\\/]|~)/;

function escapesWorkspace(operand: string): boolean {
  return (
    ABSOLUTE_OR_HOME.test(operand) ||
    operand === ".." ||
    operand.includes("../") ||
    operand.includes("..\\")
  );
}

/**
 * The pinned `<interpreter> <workspace-script>` an argv runs —
 * `["node", "scripts/stats.mjs"]` — or null: not an interpreter, a flag
 * operand (`-e`, `-c`, `-m`, `--eval`), or a script outside the workspace.
 * The script path is what constrains what runs.
 */
export function pinnedScript(
  argv: readonly unknown[],
): readonly [string, string] | null {
  if (!argv.every((a): a is string => typeof a === "string")) return null;
  const [a0, a1] = argv;
  if (a0 === undefined || !SCRIPT_INTERPRETERS.has(binaryBasename(a0)))
    return null;
  if (
    a1 === undefined ||
    a1.length === 0 ||
    a1.startsWith("-") ||
    escapesWorkspace(a1)
  )
    return null;
  return [a0, a1];
}
