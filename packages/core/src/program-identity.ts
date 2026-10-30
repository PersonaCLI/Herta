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

/** Programs whose job is to run ANOTHER program named by the words after
 *  their own options (`sudo rm …`, `timeout 5 node …`, `caffeinate -i npm
 *  …`). The ONE list: the run_command classifier's wrapper peel (its
 *  `EXEC_WRAPPERS` specs, a test holds the two equal), the bash lane's
 *  scope-opaque heads and the task cache all read it. Kept as three hand
 *  lists, they drifted — macOS's `caffeinate`, `arch` and `sandbox-exec` were
 *  in none, so `caffeinate rm -rf /` asked instead of blocking, and one
 *  remembered `caffeinate …` covered every later one (Mac findings
 *  2026-10-24, item 1); `watch`, `flock`, `strace` and the rest were peeled
 *  but cached by name. */
export const EXEC_WRAPPER_PROGRAMS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "pkexec",
  "env",
  "nice",
  "ionice",
  "nohup",
  "setsid",
  "stdbuf",
  "timeout",
  "xargs",
  "command",
  "builtin",
  "time",
  "su",
  "runuser",
  "chroot",
  "strace",
  "ltrace",
  "watch",
  "flock",
  "script",
  "taskset",
  "unshare",
  "busybox",
  "proot",
  // macOS (Mac findings 2026-10-24, item 1).
  "caffeinate",
  "arch",
  "sandbox-exec",
  // The pre-release review of 2026-10-30: each hid `rm -rf /` behind an
  // ask a remember could cover.
  "exec",
  "chrt",
  "unbuffer",
  "firejail",
  "nsenter",
  "systemd-run",
  "faketime",
  "fakeroot",
  "prlimit",
  "numactl",
  "bwrap",
  "valgrind",
  "xvfb-run",
  "ssh-agent",
  "wsl",
]);

/** Package managers (and direnv) whose subcommand runs the program named
 *  after it; the options of their own that take a value; the operands the
 *  subcommand takes first (`direnv exec DIR cmd`). */
const PACKAGE_RUNNERS: ReadonlyMap<
  string,
  {
    readonly subs: ReadonlySet<string>;
    readonly values: ReadonlySet<string>;
    readonly operands?: number;
  }
> = new Map([
  ["direnv", { subs: new Set(["exec"]), values: new Set(), operands: 1 }],
  [
    "pnpm",
    {
      subs: new Set(["exec", "dlx"]),
      values: new Set(["-C", "--dir", "--filter", "-F"]),
    },
  ],
  ["yarn", { subs: new Set(["exec", "dlx"]), values: new Set(["--cwd"]) }],
  [
    "npm",
    {
      subs: new Set(["exec", "x"]),
      values: new Set(["--prefix", "-w", "--workspace"]),
    },
  ],
  ["bun", { subs: new Set(["x"]), values: new Set(["--cwd"]) }],
]);

/**
 * The command a package manager's run-a-binary subcommand runs — `pnpm exec
 * rm -rf /` runs `rm -rf /` — or null for any other line. Read as a wrapper
 * by the block peel, and never a remember's scope: remembering `pnpm run
 * build` covered `pnpm exec rm -rf /` (review 2026-10-30). A `-c` body
 * (`npm exec -c '…'`) is not an argv: null, and other classes judge it.
 */
export function packageExecCommand(argv: readonly string[]): string[] | null {
  const a0 = argv[0];
  if (a0 === undefined) return null;
  const runner = PACKAGE_RUNNERS.get(binaryBasename(a0));
  if (runner === undefined) return null;
  let i = 1;
  while (i < argv.length && (argv[i] as string).startsWith("-")) {
    const flag = argv[i] as string;
    i += runner.values.has(flag) ? 2 : 1;
  }
  if (i >= argv.length || !runner.subs.has(argv[i] as string)) return null;
  i += 1;
  while (i < argv.length && (argv[i] as string).startsWith("-")) {
    const flag = argv[i] as string;
    i += 1;
    if (flag === "--") break;
    if (flag === "-c" || flag === "--call") return null;
    if (flag === "-p" || flag === "--package") i += 1;
  }
  i += runner.operands ?? 0;
  return i < argv.length ? argv.slice(i) : null;
}

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
  "npx",
  "make",
  ...EXEC_WRAPPER_PROGRAMS,
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
