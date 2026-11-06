import { userInfo } from "node:os";
import { basename } from "node:path";

/**
 * A kill aimed at the app itself (2026-11-04). Every `kill`, `pkill`,
 * `killall` and `taskkill` asked as the same process class whatever it would
 * end, and an approved `taskkill /F /IM node.exe` ends the CLI that runs it;
 * an approved kill of the desktop's own pid closes the window mid-run. With
 * automatic review on, a review model is the one approving (ADR 0075).
 * Ending the app from inside it has no use the Trailblazer's own close does
 * not serve, so such a line is BLOCKED: no card, no review, no rule.
 *
 * What the harness knows about itself, read only when a line kills
 * something: its own pid, program name and command line; its parent's pid
 * (the shell that started the CLI, the dev server that started Electron);
 * and, on the desktop, Electron's other processes (killing a renderer blanks
 * the window). Ancestors above the parent, and a kill whose targets arrive
 * through a substitution, are not judged here: they ask as before. The two
 * pipes that are a kill by name (`pgrep x | xargs kill`, `Get-Process x |
 * Stop-Process`) are read as that kill by the classifier (`pipedKills`).
 *
 * Nothing a line says reaches a regular expression (review 2026-11-05). This
 * runs synchronously on the app's main thread and JavaScript's engine
 * backtracks: `pkill -f '(.+)+X'`, or `taskkill /IM` over thirty `*`, held it
 * for good, before any card and out of Stop's reach. A name test here is a
 * glob, walked forward over the text; a pattern a glob cannot say asks.
 */

/** One process that is this app. */
export interface HostProcess {
  readonly pid: number;
  /** This process itself: the parent of the persistent shell, so `$PPID`
   *  there names it. */
  readonly self?: true;
  /** Its program's file name, as a by-name kill matches it (`node.exe`,
   *  `Herta`). Unknown for the parent. */
  readonly name?: string;
  /** Its parent's pid, for `pkill -P`. */
  readonly ppid?: number;
  /** Its command line, as `pkill -f` matches it. */
  readonly commandLine?: string;
  /** The user it runs as, for `pkill -u`: known for this process, unknown
   *  for the others. */
  readonly user?: string;
  readonly uid?: number;
}

/** The processes that are this app, listed when a line kills something. */
export interface HostIdentity {
  processes(): readonly HostProcess[];
}

let helperPids: (() => readonly number[]) | null = null;

/** The desktop's main hands over Electron's other processes (renderers, the
 *  GPU and utility processes): they share the app's program name, and a kill
 *  of one by pid blanks the window. */
export function registerHostHelperPids(list: () => readonly number[]): void {
  helperPids = list;
}

/** This process, as the classifier's callers pass it. */
export function hostIdentity(): HostIdentity {
  return {
    processes(): readonly HostProcess[] {
      const name = basename(process.execPath);
      const out: HostProcess[] = [
        {
          pid: process.pid,
          self: true,
          name,
          ppid: process.ppid,
          commandLine: [process.execPath, ...process.argv.slice(1)].join(" "),
          ...ownUser(),
        },
      ];
      // Not on Windows: nothing re-parents a process there, so `process.ppid`
      // stays the starter's pid after it exits, and a block has no override
      // for whichever process gets that number next (review 2026-11-05, G7).
      if (process.ppid > 0 && process.platform !== "win32") {
        out.push({ pid: process.ppid });
      }
      let helpers: readonly number[] = [];
      try {
        helpers = helperPids?.() ?? [];
      } catch {
        // A list that cannot be read leaves the own pid and name, which still
        // catch the kills that matter most.
      }
      for (const pid of helpers) {
        if (pid === process.pid) continue;
        for (const helper of helperNames(name, process.platform)) {
          out.push({ pid, name: helper, ppid: process.pid });
        }
      }
      return out;
    },
  };
}

/** What Electron's other processes are called: the app's own name, but on a
 *  Mac, where they are separate programs in its bundle (G5). */
export function helperNames(name: string, platform: string): readonly string[] {
  if (platform !== "darwin") return [name];
  return ["", " (Renderer)", " (GPU)", " (Plugin)"].map(
    (kind) => `${name} Helper${kind}`,
  );
}

/** Who this process runs as; nothing when the system cannot say. */
function ownUser(): { user?: string; uid?: number } {
  const uid = process.getuid?.();
  try {
    return { user: userInfo().username, ...(uid !== undefined ? { uid } : {}) };
  } catch {
    return uid !== undefined ? { uid } : {};
  }
}

/** Why a line is refused, and the move that serves its purpose instead. */
export interface SelfKillDenial {
  readonly reason: string;
  readonly suggestion: string;
}

/** What a kill line selects: a test per process, and how it chose. */
interface Selector {
  readonly by: "pid" | "name" | "all";
  matches(p: HostProcess): boolean;
}

/** The kill programs this guard reads, by their lowercased base name. */
const KILL_PROGRAMS: ReadonlySet<string> = new Set([
  "kill",
  "pkill",
  "killall",
  "taskkill",
  "tskill",
  "stop-process",
  "spps",
]);

/**
 * The denial when `argv` (one command, exec-wrappers already peeled) would
 * end one of the host's processes; null when it would not, or when its
 * targets cannot be told from the line. `shell` says a shell expands the
 * line: then `$PPID` is the process that started the shell — the app.
 */
export function selfKillDenial(
  argv: readonly string[],
  host: HostIdentity,
  shell: boolean,
): SelfKillDenial | null {
  const a0 = argv[0];
  if (a0 === undefined) return null;
  // `./kill`, `scripts/pkill`: a program of the workspace that shares the
  // name, whatever its arguments are (review 2026-11-05).
  if (/[\\/]/.test(a0) && !/^(?:[\\/]|[A-Za-z]:[\\/])/.test(a0)) return null;
  const id = programName(a0);
  if (!KILL_PROGRAMS.has(id)) return null;
  const select = selectorFor(id, argv.slice(1).map(unquote), shell);
  if (select === null) return null;
  const hit = host.processes().find((p) => select.matches(p));
  if (hit === undefined) return null;
  const what =
    hit.name === undefined
      ? `pid ${hit.pid}, the process that started this app`
      : `pid ${hit.pid}, ${hit.name}`;
  return {
    reason: `${id} would end this app's own process (${what}) — the harness running you would close mid-run; no approval can allow it`,
    suggestion:
      select.by === "pid"
        ? "that pid belongs to this app: list the processes (tasklist / ps) and end the one you mean by its own pid; a dev server started with dev_server stops with dev_server"
        : "end the process you mean by its own pid (tasklist / ps lists them), not by a program name or user this app shares; a dev server started with dev_server stops with dev_server",
  };
}

function programName(a0: string): string {
  const base = a0.split(/[\\/]/).pop() ?? a0;
  return base.toLowerCase().replace(/\.exe$/, "");
}

function unquote(a: string): string {
  return a.replace(/^(["'])(.*)\1$/s, "$2");
}

/** PowerShell's `kill` is Stop-Process; one of its parameter names, spelled
 *  out, says which `kill` a line is. (`-n` is POSIX kill's signal flag.) */
const PS_KILL_WORD =
  /^-(?:id|name|processname|force|passthru|whatif|confirm|inputobject)(?::|$)/i;

function selectorFor(
  id: string,
  args: readonly string[],
  shell: boolean,
): Selector | null {
  if (id === "stop-process" || id === "spps") return powershellSelector(args);
  if (id === "kill") {
    return args.some((a) => PS_KILL_WORD.test(a))
      ? powershellSelector(args)
      : posixKillSelector(args, shell);
  }
  if (id === "pkill") return pkillSelector(args);
  if (id === "killall") return killallSelector(args);
  if (id === "taskkill") return taskkillSelector(args);
  if (id === "tskill") return tskillSelector(args);
  return null;
}

/** The program name without `.exe`, as POSIX tools and PowerShell show it. */
function stem(name: string): string {
  return name.replace(/\.exe$/i, "");
}

/** A name test against both spellings of a process's program name. */
function nameMatches(p: HostProcess, test: (s: string) => boolean): boolean {
  return p.name !== undefined && (test(p.name) || test(stem(p.name)));
}

function byPids(pids: readonly number[]): Selector | null {
  if (pids.length === 0) return null;
  const set = new Set(pids);
  return { by: "pid", matches: (p) => set.has(p.pid) };
}

function anyOf(selectors: ReadonlyArray<Selector | null>): Selector | null {
  const live = selectors.filter((s): s is Selector => s !== null);
  if (live.length === 0) return null;
  const by = live.some((s) => s.by === "all")
    ? "all"
    : live.some((s) => s.by === "name")
      ? "name"
      : "pid";
  return { by, matches: (p) => live.some((s) => s.matches(p)) };
}

/** Every process (`kill -1`, all a filter lets through). */
const EVERY: Selector = { by: "all", matches: () => true };

/** A process that runs as `who`: a name, a uid, or a word the shell fills in
 *  (`$USER`, `$(id -u)`), which is the shell's own user: the app's. A plain
 *  word that is another user reaches none of the app's processes, and when
 *  the app cannot say who it runs as the line asks (review 2026-11-05). */
function runsAs(who: string, p: HostProcess): boolean {
  // The shell lane reads a substitution as this placeholder.
  if (who.includes("__SUBST__") || !/^[\w.-]+$/.test(who)) return true;
  if (/^\d+$/.test(who)) return p.uid === Number(who);
  return p.user?.toLowerCase() === who.toLowerCase();
}

/** The processes of the users a line names. */
function byUsers(users: readonly string[]): Selector | null {
  if (users.length === 0) return null;
  return {
    by: "all",
    matches: (p) => users.some((who) => runsAs(who, p)),
  };
}

/** What every one of them selects; null when none selects anything. */
function allOf(selectors: ReadonlyArray<Selector | null>): Selector | null {
  const live = selectors.filter((s): s is Selector => s !== null);
  const first = live[0];
  if (first === undefined) return null;
  return { by: first.by, matches: (p) => live.every((s) => s.matches(p)) };
}

/** Signal 0 only asks whether a process is there: it ends nothing. */
function noSignal(value: string | undefined): boolean {
  return value === "0" || value === "-0" || value === "SIG0";
}

/** A test of one name or command line. */
type TextTest = (text: string) => boolean;

/** Any one character. */
const ONE = 1;
/** Any run of characters, none included. */
const RUN = 2;
/** A whole-string pattern: literal characters and those two. */
type Glob = ReadonlyArray<string | typeof ONE | typeof RUN>;

/**
 * Whether `glob` matches all of `text`. On a miss only the latest `RUN` takes
 * one more character, so the walk never returns past it: the time is at worst
 * the text's length times the pattern's, whatever the pattern.
 */
function globMatches(glob: Glob, text: string): boolean {
  let at = 0;
  let step = 0;
  let run = -1;
  let runEnd = 0;
  while (at < text.length) {
    const want = glob[step];
    if (want === RUN) {
      run = step;
      runEnd = at;
      step += 1;
    } else if (want === ONE || want === text[at]) {
      step += 1;
      at += 1;
    } else if (run < 0) {
      return false;
    } else {
      step = run + 1;
      runEnd += 1;
      at = runEnd;
    }
  }
  while (glob[step] === RUN) step += 1;
  return step === glob.length;
}

/** A `*` / `?` wildcard as a whole-string, case-insensitive test. */
function wildcard(pattern: string): TextTest {
  const glob = pattern
    .toLowerCase()
    .split("")
    .map((c) => (c === "*" ? RUN : c === "?" ? ONE : c));
  return (text) => globMatches(glob, text.toLowerCase());
}

/** A name spelled out in full: the whole of it, nothing read as a pattern. */
function literal(name: string, icase: boolean): TextTest {
  const want = icase ? name.toLowerCase() : name;
  return (text) => (icase ? text.toLowerCase() : text) === want;
}

/** Longer than any pattern a line means: `a|a|a|…` costs a walk per `|`. */
const PATTERN_CAP = 1024;

/** What a glob cannot say. `.`, a `^` that opens an alternative and a `$`
 *  that closes one are read before this is asked. */
const REGEX_SYNTAX: ReadonlySet<string> = new Set("^$*+?()[]{}");

/** A pattern's `|` alternatives; `\|` is not one. */
function alternatives(source: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\\") {
      i += 1;
    } else if (source[i] === "|") {
      out.push(source.slice(from, i));
      from = i + 1;
    }
  }
  out.push(source.slice(from));
  return out;
}

/** One `|` alternative as a glob; null when it says more than a glob can. */
function regexGlob(source: string, exact: boolean): Glob | null {
  const steps: Array<string | typeof ONE | typeof RUN> = [];
  const opens = source.startsWith("^");
  let closes = false;
  for (let i = opens ? 1 : 0; i < source.length; i += 1) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (c === "\\") {
      // `\.` is the dot itself. `\d`, `\b`, a trailing `\`: not a character.
      if (next === undefined || /[A-Za-z0-9]/.test(next)) return null;
      steps.push(next);
      i += 1;
    } else if (c === ".") {
      if (next === "?") return null;
      if (next === "+") steps.push(ONE);
      if (next === "*" || next === "+") {
        steps.push(RUN);
        i += 1;
      } else {
        steps.push(ONE);
      }
    } else if (c === "$" && i === source.length - 1) {
      closes = true;
    } else if (REGEX_SYNTAX.has(c)) {
      return null;
    } else {
      steps.push(c);
    }
  }
  if (!exact && !opens) steps.unshift(RUN);
  if (!exact && !closes) steps.push(RUN);
  return steps;
}

/**
 * A pattern the program reads as a regular expression (`pkill`, `killall -r`).
 * What such a line is written with reads as globs: `node.*vite`, `cli\.js`,
 * `vite|webpack`, `^node$`. A class, a group or a repeat of anything but `.`
 * does not, and null is "cannot tell": the line asks.
 */
function regex(
  pattern: string,
  exact: boolean,
  icase: boolean,
): TextTest | null {
  if (pattern.length > PATTERN_CAP) return null;
  const source = icase ? pattern.toLowerCase() : pattern;
  const globs: Glob[] = [];
  for (const alternative of alternatives(source)) {
    const glob = regexGlob(alternative, exact);
    if (glob === null) return null;
    globs.push(glob);
  }
  return (text) => {
    const subject = icase ? text.toLowerCase() : text;
    return globs.some((glob) => globMatches(glob, subject));
  };
}

// ── kill (POSIX, and the shells' builtin) ──────────────────────────────────

/** `$PPID`, `${PPID}`: under a shell, the process that started it. */
const PPID_WORD = /^-?\$(?:PPID|\{PPID\})$/;

function posixKillSelector(
  args: readonly string[],
  shell: boolean,
): Selector | null {
  let i = 0;
  let signal = false;
  for (; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--") {
      i += 1;
      break;
    }
    // Lists signals; ends nothing.
    if (a === "-l" || a === "-L" || a.startsWith("--list") || a === "--table") {
      return null;
    }
    if (a === "-s" || a === "-n" || a === "--signal") {
      i += 1;
      if (noSignal(args[i])) return null;
      signal = true;
      continue;
    }
    if (a.startsWith("--signal=") && noSignal(a.slice(9))) return null;
    // `-9` is the signal the first time and a process group after it
    // (`kill -9 -1` ends every process the user owns).
    if (/^-\d+$/.test(a)) {
      if (signal) break;
      if (noSignal(a)) return null;
      signal = true;
      continue;
    }
    // `-KILL`, `-SIGTERM`; MSYS's `-f` / `-W` (a Windows pid).
    if (/^-[A-Za-z]/.test(a)) {
      if (/^-[A-Z]/.test(a)) signal = true;
      continue;
    }
    break;
  }
  const pids: number[] = [];
  let all = false;
  let parent = false;
  for (const raw of args.slice(i)) {
    // Spelled as the shell passes it: `+4242`, or `' 4242'`, are 4242.
    const a = raw.trim();
    if (shell && PPID_WORD.test(a)) {
      parent = true;
      continue;
    }
    if (!/^[+-]?\d+$/.test(a)) continue;
    const n = Number(a);
    // `-1` is every process the user owns; any other negative number is a
    // process group, which a pid started from a shell leads. `0` is the
    // caller's own group: a command runs in one of its own, so it asks.
    if (n === -1) all = true;
    else pids.push(Math.abs(n));
  }
  return anyOf([
    all ? EVERY : null,
    parent ? { by: "pid", matches: (p) => p.self === true } : null,
    byPids(pids),
  ]);
}

// ── pkill ──────────────────────────────────────────────────────────────────

/** pkill's options that take a value, short and long. */
const PKILL_VALUE_OPTS: ReadonlySet<string> = new Set([
  "-g",
  "-G",
  "-P",
  "-s",
  "-t",
  "-u",
  "-U",
  "-F",
  "-q",
  "--signal",
  "--pgroup",
  "--group",
  "--parent",
  "--session",
  "--terminal",
  "--euid",
  "--uid",
  "--pidfile",
  "--ns",
  "--nslist",
  "--queue",
]);

const USER_OPTS: ReadonlySet<string> = new Set(["-u", "-U", "--euid", "--uid"]);

function pkillSelector(args: readonly string[]): Selector | null {
  let full = false;
  let exact = false;
  let icase = false;
  let invert = false;
  const users: string[] = [];
  const parents: number[] = [];
  let pattern: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--") {
      pattern ??= args[i + 1];
      break;
    }
    const long = a.startsWith("--");
    const eq = a.indexOf("=");
    const opt = long ? (eq < 0 ? a : a.slice(0, eq)) : a.slice(0, 2);
    if (a.startsWith("-") && PKILL_VALUE_OPTS.has(opt)) {
      const attached = long
        ? eq < 0
          ? undefined
          : a.slice(eq + 1)
        : a.length > 2
          ? a.slice(2)
          : undefined;
      const value = attached ?? args[i + 1] ?? "";
      if (attached === undefined) i += 1;
      if (opt === "--signal" && noSignal(value)) return null;
      if (USER_OPTS.has(opt)) users.push(...value.split(","));
      if (opt === "-P" || opt === "--parent") {
        for (const v of value.split(",")) {
          if (/^\d+$/.test(v)) parents.push(Number(v));
        }
      }
      continue;
    }
    if (a === "--full") full = true;
    else if (a === "--exact") exact = true;
    else if (a === "--ignore-case") icase = true;
    else if (a === "--inverse") invert = true;
    else if (noSignal(a)) return null;
    else if (long || /^-\d+$/.test(a) || /^-[A-Z]+$/.test(a)) {
      // A signal, or a long flag that selects nothing.
    } else if (/^-[a-z]+$/.test(a)) {
      for (const c of a.slice(1)) {
        if (c === "f") full = true;
        else if (c === "x") exact = true;
        else if (c === "i") icase = true;
        else if (c === "v") invert = true;
      }
    } else {
      pattern ??= a;
    }
  }
  const byParent: Selector | null =
    parents.length === 0
      ? null
      : {
          by: "pid",
          matches: (p) => p.ppid !== undefined && parents.includes(p.ppid),
        };
  // No pattern: every process of a user (`pkill -u me`), or of a parent.
  if (pattern === undefined) return allOf([byUsers(users), byParent]);
  const test = regex(pattern, exact, icase);
  if (test === null) return null;
  const named: Selector = {
    by: "name",
    matches: (p) => {
      const hit = full
        ? p.commandLine !== undefined && test(p.commandLine)
        : nameMatches(p, test);
      if (p.name === undefined && !full) return false;
      return invert ? !hit : hit;
    },
  };
  return allOf([named, byParent, byUsers(users)]);
}

// ── killall ────────────────────────────────────────────────────────────────

/** killall's options that take a value: psmisc's (Linux) and the BSD one's
 *  (macOS: `-t tty`, `-c name`). */
const KILLALL_VALUE_OPTS: ReadonlySet<string> = new Set([
  "-s",
  "-u",
  "-o",
  "-y",
  "-n",
  "-Z",
  "-t",
  "-c",
  "--signal",
  "--user",
  "--older-than",
  "--younger-than",
  "--ns",
  "--context",
]);

function killallSelector(args: readonly string[]): Selector | null {
  let regexp = false;
  let icase = false;
  const users: string[] = [];
  const names: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--") {
      names.push(...args.slice(i + 1));
      break;
    }
    const opt = a.startsWith("--") ? (a.split("=")[0] as string) : a;
    if (KILLALL_VALUE_OPTS.has(opt)) {
      const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
      if (!a.includes("=")) i += 1;
      if ((opt === "-s" || opt === "--signal") && noSignal(value)) return null;
      if ((opt === "-u" || opt === "--user") && value !== undefined)
        users.push(value);
      // BSD's `-c name`: only processes of that name.
      if (opt === "-c" && value !== undefined) names.push(value);
      continue;
    }
    if (a === "--regexp") regexp = true;
    else if (a === "--ignore-case") icase = true;
    else if (noSignal(a)) return null;
    else if (a.startsWith("--") || /^-\d+$/.test(a) || /^-[A-Z]{2,}$/.test(a)) {
      // A signal, or a long flag that selects nothing.
    } else if (/^-[A-Za-z]+$/.test(a)) {
      for (const c of a.slice(1)) {
        if (c === "r" || c === "m") regexp = true;
        else if (c === "I") icase = true;
      }
    } else {
      names.push(a);
    }
  }
  if (names.length === 0) return byUsers(users);
  const tests = names
    .map((n) => (regexp ? regex(n, false, icase) : literal(n, icase)))
    .filter((t): t is TextTest => t !== null);
  if (tests.length === 0) return null;
  return allOf([
    {
      by: "name",
      matches: (p) => nameMatches(p, (s) => tests.some((test) => test(s))),
    },
    byUsers(users),
  ]);
}

// ── taskkill / tskill (Windows) ────────────────────────────────────────────

/** A Windows switch in any spelling: `/PID`, `-pid`, and Git Bash's `//PID`
 *  (the doubled slash keeps MSYS from reading it as a path). */
function winSwitch(a: string): string | null {
  const m = /^(?:\/\/|\/|-)([A-Za-z]+)(?::.*)?$/s.exec(a);
  return m === null ? null : (m[1] as string).toLowerCase();
}

/** The value a switch carries itself: `/PID:4242`, `/FI:"PID eq 1"`. */
function attachedValue(a: string): string | null {
  const at = a.indexOf(":");
  return at === -1 ? null : unquote(a.slice(at + 1));
}

function taskkillSelector(args: readonly string[]): Selector | null {
  const pids: number[] = [];
  const images: TextTest[] = [];
  const filters: TaskkillFilter[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const sw = winSwitch(arg);
    if (sw === null) continue;
    const attached = attachedValue(arg);
    const value = attached ?? args[i + 1] ?? "";
    const before = i;
    if (sw === "s") {
      // Another machine's processes are not this app's.
      if (!/^(?:localhost|127\.0\.0\.1|\.)$/i.test(value)) return null;
      i += 1;
    } else if (sw === "u" || sw === "p") {
      i += 1;
    } else if (sw === "pid") {
      for (const v of value.split(",")) {
        if (/^\d+$/.test(v)) pids.push(Number(v));
      }
      i += 1;
    } else if (sw === "im") {
      images.push(wildcard(value));
      i += 1;
    } else if (sw === "fi") {
      filters.push(taskkillFilter(value));
      i += 1;
    }
    if (attached !== null) i = before;
  }
  const named: Selector | null =
    images.length === 0
      ? null
      : {
          by: "name",
          matches: (p) => nameMatches(p, (s) => images.some((test) => test(s))),
        };
  // With neither /PID nor /IM, the filters alone choose, from every process
  // — when one of them can be read. WINDOWTITLE, STATUS or MEMUSAGE alone says
  // nothing about the app: the line asks. A block has no override, and these
  // were refused with a reason that was not true (review 2026-11-05).
  const alone = pids.length === 0 && images.length === 0;
  if (alone && !filters.some((f) => f.read)) return null;
  const chosen = alone ? EVERY : anyOf([byPids(pids), named]);
  if (chosen === null) return null;
  return {
    by: chosen.by,
    matches: (p) => chosen.matches(p) && filters.every((f) => f.test(p)),
  };
}

/** A `/FI` filter: its test, and whether it was read at all. */
interface TaskkillFilter {
  readonly read: boolean;
  test(p: HostProcess): boolean;
}

const UNREAD_FILTER: TaskkillFilter = { read: false, test: () => true };

const FILTER_RELATIONS: ReadonlySet<string> = new Set([
  "eq",
  "ne",
  "gt",
  "lt",
  "ge",
  "le",
]);

/** One `/FI "NAME OP VALUE"` filter. A filter this guard does not read
 *  (STATUS, MEMUSAGE, WINDOWTITLE …) is taken to match: the process might
 *  pass it. */
function taskkillFilter(text: string): TaskkillFilter {
  const [name, relation, ...rest] = text.trim().split(/\s+/);
  const op = relation?.toLowerCase();
  if (name === undefined || op === undefined || rest.length === 0) {
    return UNREAD_FILTER;
  }
  const field = name.toLowerCase();
  const value = rest.join(" ");
  if (!FILTER_RELATIONS.has(op)) return UNREAD_FILTER;
  if (field === "imagename") {
    const test = wildcard(value);
    return {
      read: true,
      test: (p) => {
        // An unknown name (the parent's) is taken as not the one named, as
        // every name test here takes it.
        if (p.name === undefined) return op === "ne";
        const hit = nameMatches(p, test);
        return op === "ne" ? !hit : hit;
      },
    };
  }
  if (field === "username" && (op === "eq" || op === "ne")) {
    const who = value.split("\\").pop() ?? value;
    return {
      read: true,
      test: (p) => (op === "ne") !== runsAs(who, p),
    };
  }
  if (field === "pid" && /^\d+$/.test(value)) {
    const n = Number(value);
    const compare: Record<string, (pid: number) => boolean> = {
      eq: (pid) => pid === n,
      ne: (pid) => pid !== n,
      gt: (pid) => pid > n,
      lt: (pid) => pid < n,
      ge: (pid) => pid >= n,
      le: (pid) => pid <= n,
    };
    const test = compare[op];
    return test === undefined
      ? UNREAD_FILTER
      : { read: true, test: (p) => test(p.pid) };
  }
  return UNREAD_FILTER;
}

/** `tskill <pid | name> [/server:x] [/id:n] [/a] [/v]`. */
function tskillSelector(args: readonly string[]): Selector | null {
  if (args.some((a) => winSwitch(a) === "server")) return null;
  const target = args.find((a) => winSwitch(a) === null);
  if (target === undefined) return null;
  if (/^\d+$/.test(target)) return byPids([Number(target)]);
  const test = wildcard(target);
  return { by: "name", matches: (p) => nameMatches(p, test) };
}

// ── Stop-Process (PowerShell) ──────────────────────────────────────────────

/** A Stop-Process parameter this guard reads, from the prefixes PowerShell
 *  accepts for it; null for any other. */
function psParam(a: string): "id" | "name" | "whatif" | null {
  if (!a.startsWith("-") || a.length < 2) return null;
  const p = a.slice(1).toLowerCase();
  if (p === "id") return "id";
  if ("name".startsWith(p)) return "name";
  if (p.length >= 3 && "processname".startsWith(p)) return "name";
  if (p.length >= 2 && "whatif".startsWith(p)) return "whatif";
  return null;
}

function powershellSelector(args: readonly string[]): Selector | null {
  const pids: number[] = [];
  const names: TextTest[] = [];
  let param: "id" | "name" | null = null;
  // Stop-Process's first positional parameter is -Id.
  let positional = true;
  for (const word of args) {
    // `-Id:4242`: a parameter and its value in one word.
    const colon = word.startsWith("-") ? word.indexOf(":") : -1;
    const p = psParam(colon > 0 ? word.slice(0, colon) : word);
    if (p === "whatif") {
      if (colon <= 0 || !/^\$?false$/i.test(word.slice(colon + 1))) return null;
      continue;
    }
    if (p !== null) {
      param = p;
      positional = false;
      if (colon <= 0) continue;
    } else if (word.startsWith("-")) {
      param = null;
      continue;
    }
    const raw = p !== null ? word.slice(colon + 1) : word;
    const target = param ?? (positional ? "id" : null);
    if (target === null) continue;
    for (const v of raw.split(",").map(unquote)) {
      if (v === "") continue;
      // `[int]` as PowerShell reads it: `+4242`, and `0x1092`.
      if (target === "id" && /^(?:\+?\d+|0x[0-9a-f]+)$/i.test(v)) {
        pids.push(Number(v));
      }
      if (target === "name") names.push(wildcard(v));
    }
    // A list goes on while its words end in a comma.
    if (!raw.endsWith(",")) {
      param = null;
      positional = false;
    }
  }
  return anyOf([
    byPids(pids),
    names.length === 0
      ? null
      : {
          by: "name",
          matches: (p) => nameMatches(p, (s) => names.some((test) => test(s))),
        },
  ]);
}
