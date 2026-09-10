import { relative, resolve } from "node:path";
import { isPathInside, type RiskLevel } from "@herta/core";
import { isCredentialPath } from "../credential-denylist.js";
import { detectInProgressState, resolveGitDir } from "../git/repo-probe.js";
import { gitDirShapeWriteDenial } from "../path-safety.js";
import {
  classifyCommand,
  classifyShellBody,
  splitShellSegments,
  unresolvedProgramName,
  type Verdict,
} from "../run-command/classifier.js";
import { findDisallowedEnvKey } from "../run-command/env-guard.js";
import type { ShellPaths } from "./shell-paths.js";

/**
 * Allow / Ask / Block for a whole shell COMMAND STRING (ADR 0040, D4).
 *
 * The argv classifier (`classifyCommand`) already knows the tiers for one
 * program; the minimal contract hands the model a shell, so a call is a
 * pipeline of programs plus shell syntax. This decomposes the string into
 * what actually runs and takes the WORST tier:
 *
 *   1. block scan of the raw body (catastrophic commands, fork bomb, nested
 *      interpreters) — `classifyShellBody`, no override;
 *   2. heredoc bodies stripped (data, not commands); `$(…)` / backtick
 *      substitutions extracted and classified as commands of their own;
 *   3. each `;` / `&&` / `||` / `|` / newline segment tokenized shell-style
 *      (quotes, escapes), leading `VAR=value` assignments removed and their
 *      KEYS put through the run_command env denylist, then:
 *        - `cd`/`pushd`: a target that leaves the workspace (absolute
 *          outside, `..`, `~`, `-`, a variable) ASKS — the persistent shell
 *          keeps relative-path reasoning honest only inside the workspace;
 *        - `source`/`.`/`eval`/`exec` ASK (they run text the classifier
 *          cannot see);
 *        - builtins that RUN, ASSIGN or EVALUATE something are handled one by
 *          one — `command`/`builtin` peeled, `trap`/`alias` recursed into,
 *          `jobs -x` peeled, `hash -p` asked, `readonly`/`local`/`printf -v`/
 *          `read` routed through the env allow-list, `let`/`[[` scanned for
 *          substitutions that arithmetic would expand (see STATE_BUILTINS);
 *        - genuinely inert builtins (`set`, `unset`, `shopt`, `exit`, `true`,
 *          `:`, `echo`, `pwd`…) allow;
 *        - everything else → `classifyCommand(argv)` after ABSOLUTE PATHS
 *          INSIDE THE WORKSPACE are rewritten relative (the model spells
 *          `/e/repo/src/x` because that is what `pwd` printed; the reader
 *          guard would otherwise ask on every one);
 *   4. output redirections (`>`, `>>`, `>|`, `&>`) to anything but
 *      `/dev/null` ASK as workspace writes; `<` from a credential/outside
 *      path ASKS as a read.
 *
 * Aggregation: any block → block; else any ask → ONE ask carrying the
 * highest risk and the joined reasons (the user sees the whole command in
 * the prompt anyway); else allow. `code` follows the highest-risk ask so
 * ADR 0030 project rules (`command_ask_unknown` / `_interpreter`) can still
 * be derived when that is the only ask in the line.
 */
export interface ShellClassifyOpts {
  workspaceRoot: string;
  /** Path spelling of the shell (MSYS on Windows). */
  paths: ShellPaths;
  /** The shell's current cwd (native); relative paths resolve against it. */
  cwd?: string;
}

const RISK_RANK: Record<RiskLevel, number> = {
  workspace_read: 1,
  workspace_write: 2,
  network: 3,
  workspace_destructive: 4,
};

/**
 * Builtins that only touch shell state — allowed once nothing above them in
 * `classifySegment` claimed the segment first.
 *
 * The INVARIANT this set is supposed to encode is: *this word runs no command,
 * assigns no variable, and evaluates no arithmetic.* It was written as a flat
 * name list and quietly accumulated members that do all three, each of which
 * then reached allow with `argv[1..]` completely unread (2026-08-24, codex
 * study and the red team that followed it):
 *
 *   - `command`, `builtin`  — exec-wrappers; REMOVED, peeled via EXEC_PEELS.
 *   - `trap`                — stores an action the shell runs later; REMOVED,
 *                             recursed via classifyAction.
 *   - `jobs -x`, `hash -p`  — exec / re-point a command name.
 *   - `readonly`, `local`   — assign, exactly like `export`.
 *   - `printf -v`, `read`   — assign.
 *   - `let`, `[[`, `test`   — evaluate arithmetic, which expands (and so RUNS)
 *                             a command substitution even inside single
 *                             quotes.
 *
 * The last four groups keep their membership because their ordinary spellings
 * really are inert; each is intercepted ABOVE this check and only falls
 * through to it once the dangerous shape has been ruled out. Anything added
 * here in future must satisfy the invariant in all of its argument forms, not
 * just its common one.
 */
const STATE_BUILTINS = new Set([
  "export",
  "unset",
  "set",
  "shopt",
  "alias",
  "unalias",
  "declare",
  "typeset",
  "local",
  "readonly",
  "exit",
  "return",
  "true",
  "false",
  ":",
  "test",
  "[",
  "[[",
  "printf",
  "echo",
  "read",
  "wait",
  "jobs",
  "fg",
  "bg",
  "type",
  "hash",
  "umask",
  "ulimit",
  "times",
  "history",
  "let",
  "getopts",
  "shift",
  "break",
  "continue",
  "pwd",
  "dirs",
  "popd",
  "help",
  "sleep",
]);

/** Builtins that execute text the classifier cannot see. */
const OPAQUE_BUILTINS = new Set(["source", ".", "eval", "exec"]);

/**
 * The OPTION forms of each state builtin that are known to be inert
 * (ADR 0045, the inversion). `null` means "no option of this builtin can make
 * it run, assign, or evaluate anything", so its flags need no enumeration.
 *
 * Every builtin bypass found in three sweeps arrived as an OPTION nobody had
 * modelled — `command`'s payload, `trap`'s action, `jobs -x`, `hash -p`,
 * `printf -v`, `read`'s target, `let`'s expression. Listing the safe forms and
 * asking about the rest inverts that: a flag we have never considered is a
 * question for the user, not a silent allow.
 */
const INERT_BUILTIN_FLAGS: ReadonlyMap<string, ReadonlySet<string> | null> =
  new Map<string, ReadonlySet<string> | null>([
    // Options cannot make these exec or assign.
    ["set", null],
    ["shopt", null],
    ["ulimit", null],
    ["umask", null],
    ["true", null],
    ["false", null],
    [":", null],
    ["test", null],
    ["[", null],
    ["[[", null],
    ["let", null],
    ["read", null], // its assignment targets are checked above
    ["printf", null], // `-v` is checked above
    ["getopts", null],
    ["shift", null],
    ["exit", null],
    ["return", null],
    ["break", null],
    ["continue", null],
    ["times", null],
    ["sleep", null],
    ["wait", null],
    ["fg", null],
    ["bg", null],
    // Enumerated: these have an option that DOES change what runs later.
    ["unset", new Set(["-v", "-f", "-n"])],
    ["export", new Set(["-p", "-f", "-n"])],
    ["readonly", new Set(["-p", "-f", "-a", "-A"])],
    ["local", new Set(["-a", "-A", "-i", "-n", "-r", "-x", "-p"])],
    [
      "declare",
      new Set([
        "-a",
        "-A",
        "-i",
        "-n",
        "-r",
        "-x",
        "-p",
        "-f",
        "-F",
        "-g",
        "-l",
        "-u",
        "-t",
        "-c",
      ]),
    ],
    [
      "typeset",
      new Set([
        "-a",
        "-A",
        "-i",
        "-n",
        "-r",
        "-x",
        "-p",
        "-f",
        "-F",
        "-g",
        "-l",
        "-u",
        "-t",
        "-c",
      ]),
    ],
    ["alias", new Set(["-p"])],
    ["unalias", new Set(["-a"])],
    // `echo` runs nothing whatever its flags, and `echo '---'` is the model's
    // standard separator — enumerating its options only produced false asks.
    ["echo", null],
    ["type", new Set(["-a", "-t", "-P", "-p", "-f"])],
    ["hash", new Set(["-r", "-l", "-t", "-d"])], // `-p` is checked above
    ["jobs", new Set(["-l", "-p", "-n", "-r", "-s"])], // `-x` is checked above
    ["history", new Set(["-c", "-d", "-a", "-n", "-r", "-w", "-p", "-s"])],
    ["pwd", new Set(["-L", "-P"])],
    ["dirs", new Set(["-c", "-l", "-p", "-v"])],
    ["popd", new Set(["-n"])],
    ["help", new Set(["-d", "-m", "-s"])],
  ]);

/** The first option of `name` that is not on its inert list, or null. Short
 *  bundles (`jobs -lp`) are checked letter by letter; `-3` / `+2` are counts,
 *  not options. */
function unmodelledBuiltinFlag(
  name: string,
  words: readonly string[],
): string | null {
  if (!INERT_BUILTIN_FLAGS.has(name)) return null;
  const inert = INERT_BUILTIN_FLAGS.get(name);
  if (inert === null || inert === undefined) return null;
  for (const w of words.slice(1)) {
    // Only an OPTION SHAPE counts: one or two dashes then a letter. `---` and
    // `---README---` are separator strings the model prints, `-` and `--` are
    // conventional operands, `-5`/`+2` are counts. Treating any leading dash
    // as a flag made `echo '---'` ask (measured on the permission lab corpus).
    if (!/^--?[A-Za-z]/.test(w) && !/^\+[A-Za-z]/.test(w)) continue;
    if (inert.has(w)) continue;
    if (/^-[A-Za-z]+$/.test(w)) {
      const bad = [...w.slice(1)].find((c) => !inert.has(`-${c}`));
      if (bad === undefined) continue;
      return `-${bad}`;
    }
    return w;
  }
  return null;
}

/** Redirection operators (with an optional fd prefix stripped by caller). */
const OUT_REDIRECT = /^(&>>?|\d*>{1,2}\|?)$/;

export interface ShellVerdictDetail {
  verdict: Verdict;
  /** Segments actually classified (for tests / diagnostics). */
  segments: string[];
  /** For an ask: the DISTINCT ask-class codes of every asking segment,
   *  highest-risk first (the verdict's `code` is the first). A chained line
   *  is the minimal contract's normal shape, and `kill 574; curl localhost`
   *  labelled only 「该命令会访问网络」 hid the kill (permission lab
   *  2026-08-17) — the card names the rest from this. */
  codes?: string[];
}

export function classifyShellCommand(
  body: string,
  opts: ShellClassifyOpts,
): Verdict {
  return classifyShellCommandDetailed(body, opts).verdict;
}

export function classifyShellCommandDetailed(
  body: string,
  opts: ShellClassifyOpts,
): ShellVerdictDetail {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return {
      verdict: {
        kind: "block",
        code: "command_blocked",
        reason: "empty command",
      },
      segments: [],
    };
  }

  // 1. block scan on the raw body (fork bomb, catastrophic, nested wrappers)
  const blocked = classifyShellBody(trimmed);
  if (blocked.hit) {
    return {
      verdict: {
        kind: "block",
        code: "command_blocked",
        reason: blocked.reason,
      },
      segments: [],
    };
  }

  // 2. strip heredoc bodies; pull substitutions out as their own commands.
  // A body with an UNQUOTED delimiter is expanded by bash, so its
  // substitutions are commands too and get classified alongside the outer
  // ones (the body's plain text is still data, not a command).
  const { text: withoutHeredocs, expanded } = splitHeredocs(trimmed);
  const { text, inner } = extractSubstitutions(withoutHeredocs);
  const heredocInner = expanded.flatMap((b) => extractSubstitutions(b).inner);
  const segments = [
    ...splitShellSegments(normalizeFdRedirects(text)),
    ...[...inner, ...heredocInner].flatMap((s) =>
      splitShellSegments(normalizeFdRedirects(s)),
    ),
  ];

  const asks: Array<Extract<Verdict, { kind: "ask" }>> = [];
  const segmentCodes = new Set<string>();
  const classified: string[] = [];
  // A `cd` INSIDE the workspace moves the cwd for the segments after it on
  // this line (`cd src/lib; cd ../../test` is fine; `cd src && cd ../..` is
  // not) — the classifier follows the shell as far as it can see.
  let cwd = opts.cwd ?? opts.workspaceRoot;
  for (const segment of segments) {
    const seg = segment.trim();
    if (seg.length === 0) continue;
    classified.push(seg);
    const r = classifySegment(seg, { ...opts, cwd });
    if (r.verdict.kind === "block")
      return { verdict: r.verdict, segments: classified };
    if (r.verdict.kind === "ask") asks.push(r.verdict);
    // Intra-segment classes too, not just the one `combine` promoted.
    for (const c of r.codes ?? []) segmentCodes.add(c);
    if (r.cwd !== undefined) cwd = r.cwd;
  }
  if (asks.length === 0)
    return { verdict: { kind: "allow" }, segments: classified };
  // Highest risk wins; reasons joined (deduped) so the prompt says it all.
  asks.sort((a, b) => RISK_RANK[b.risk] - RISK_RANK[a.risk]);
  const top = asks[0] as Extract<Verdict, { kind: "ask" }>;
  const reasons = [...new Set(asks.map((a) => a.reason))];
  // The promoted code of each segment FIRST (highest risk leads), then any
  // other class raised inside a segment that `combine` did not promote.
  const codes = [...new Set([...asks.map((a) => a.code), ...segmentCodes])];
  // Same preference as `combine`: the highest-risk segment's note, else any.
  const consequence = asks.find(
    (a) => a.consequence !== undefined,
  )?.consequence;
  return {
    verdict: {
      kind: "ask",
      risk: top.risk,
      code: top.code,
      reason: reasons.join("; "),
      ...(consequence !== undefined ? { consequence } : {}),
    },
    segments: classified,
    codes,
  };
}

/**
 * The single program a command line really runs, as argv — or null.
 *
 * Feeds the approval cache and ADR 0030 project rules for `bash` the way
 * run_command's argv does. Deliberately narrow (fail-closed): after dropping
 * leading `cd`/`pushd` segments whose target is the WORKSPACE ROOT itself
 * (the model's habit; a cd into a subdirectory would change what a
 * cwd-scoped rule means, so it disqualifies), exactly ONE segment may
 * remain, with no command substitution, no redirect that leaves the
 * workspace, and a non-empty argv. In-workspace absolute paths are
 * relativized so the argv is the one a run_command call would carry.
 */
export function singleProgramArgv(
  body: string,
  opts: ShellClassifyOpts,
): string[] | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  const { text, inner } = extractSubstitutions(stripHeredocBodies(trimmed));
  if (inner.length > 0) return null;
  const segments = splitShellSegments(normalizeFdRedirects(text))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const root = resolve(opts.workspaceRoot);
  let i = 0;
  while (i < segments.length) {
    const seg = (segments[i] as string).replace(/^[({\s]+/, "");
    const { words } = tokenize(seg);
    const name = words[0]?.toLowerCase();
    if ((name === "cd" || name === "pushd") && words.length === 2) {
      const dest = destinationOf(words[1] as string, { ...opts, cwd: root });
      if (dest !== null && resolve(dest) === root) {
        i += 1;
        continue;
      }
    }
    break;
  }
  const rest = segments.slice(i);
  if (rest.length !== 1) return null;
  const seg = (rest[0] as string)
    .replace(/^[({\s]+/, "")
    .replace(/[)}\s]+$/, "");
  const { words, redirects } = tokenize(seg);
  for (const r of redirects) {
    if (r.kind === "out" && isDevNull(r.target)) continue;
    if (leavesWorkspace(r.target, { ...opts, cwd: root })) return null;
  }
  if (words.length === 0) return null;
  const head = words[0] as string;
  if (PREFIX_KEYWORDS.has(head)) return null;
  // A head that runs, arms, or resolves something ELSE means the argv the user
  // would be granting is not the argv that runs. Fail closed rather than
  // derive a rule for the wrong program: `trap 'mkdir -p build' EXIT` approved
  // "for this task" silently covered `trap 'cp ~/.ssh/id_rsa build/k' EXIT`,
  // because both scoped to "trap" (red team 2026-08-24).
  if (
    SCOPE_OPAQUE_HEADS.has(basename(head)) ||
    isDefinitionHead(words) ||
    unresolvedProgramName(head) !== null
  )
    return null;
  return words.map((w, idx) =>
    idx === 0 ? w : relativizeInsideWorkspace(w, { ...opts, cwd: root }),
  );
}

/** Allow-listed readers and shell builtins that never make a line a
 *  DIFFERENT program for cache-scoping purposes: `git add && git commit &&
 *  echo done && git status` is a "git" line. (Their own asks, if any, are
 *  workspace_read and the cache only remembers workspace_write — a
 *  remembered "git" can never cover them.) */
let scopeNoiseSet: Set<string> | null = null;
function scopeNoise(): Set<string> {
  // Lazy: PREFIX_KEYWORDS / STANDALONE_KEYWORDS are declared further down
  // (module init order), and this is only consulted at call time.
  scopeNoiseSet ??= new Set([
    ...STATE_BUILTINS,
    ...PREFIX_KEYWORDS,
    ...STANDALONE_KEYWORDS,
    ...EXEC_PEELS,
    "function",
    "trap",
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "grep",
    "date",
    "whoami",
    "cd",
    "pushd",
  ]);
  // `rg` and `find` were here on the premise that "their own asks, if any, are
  // workspace_read and the cache only remembers workspace_write". That premise
  // died once `find -execdir` and `rg --pre` were understood as EXEC wrappers:
  // erased from the scope, they let a co-located `git commit` supply the
  // cacheable write tier and carried arbitrary execution in under it
  // (red team 2026-08-24). They are programs now, not noise.
  return scopeNoiseSet;
}

/**
 * The distinct program identities a command line runs — for the approval
 * cache's scope only (ADR 0040; see `permissionCacheScope`). Null when the
 * line cannot be characterized: command substitution, or an output redirect
 * that leaves the workspace. Readers/builtins are noise (see SCOPE_NOISE);
 * a `cd` anywhere is fine here (the task cache, like run_command's argv[0]
 * scope, is cwd-independent) — rules use `singleProgramArgv` instead.
 */
export function effectivePrograms(
  body: string,
  opts: ShellClassifyOpts,
): string[] | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;
  const { text, inner } = extractSubstitutions(stripHeredocBodies(trimmed));
  if (inner.length > 0) return null;
  const programs: string[] = [];
  const root = resolve(opts.workspaceRoot);
  for (const raw of splitShellSegments(normalizeFdRedirects(text))) {
    const seg = raw
      .replace(/^[({\s]+/, "")
      .replace(/[)}\s]+$/, "")
      .trim();
    if (seg.length === 0) continue;
    const { words, redirects } = tokenize(seg);
    for (const r of redirects) {
      if (r.kind === "out" && isDevNull(r.target)) continue;
      if (leavesWorkspace(r.target, { ...opts, cwd: root })) return null;
    }
    // Same head peel the classifier applies, so the scope names the program
    // that RUNS: `command curl …` is a curl line, not a "command" line.
    let ws = words;
    for (let peel = 0; peel <= 4; peel += 1) {
      while (ws.length > 0 && PREFIX_KEYWORDS.has(ws[0] as string))
        ws = ws.slice(1);
      const h = ws[0];
      if (h === undefined) break;
      if (basename(h) === "function") {
        ws = ws.slice(ws.length > 1 ? 2 : 1);
        continue;
      }
      if (EXEC_PEELS.has(basename(h))) {
        let rest = ws.slice(1);
        while (rest.length > 0 && /^-[pvV]+$/.test(rest[0] as string))
          rest = rest.slice(1);
        if (rest.length === 0) break;
        ws = rest;
        continue;
      }
      break;
    }
    const a0 = ws[0];
    if (a0 === undefined) continue;
    const name = basename(a0);
    // The whole LINE is uncharacterizable if any segment runs something the
    // head does not name — otherwise `git commit -m wip && find ~ -execdir rm
    // -rf {} +` scoped to "git" and rode a remembered `git` approval with no
    // card at all.
    if (
      SCOPE_OPAQUE_HEADS.has(name) ||
      isDefinitionHead(ws) ||
      unresolvedProgramName(a0) !== null
    )
      return null;
    if (scopeNoise().has(name)) continue;
    if (!programs.includes(a0)) programs.push(a0);
  }
  return programs;
}

// ───────────────────────── segment classification ─────────────────────────

/** Control-flow words that PREFIX a command (`if cmd`, `while ! cmd`,
 *  `time cmd`, `{ cmd`) — skipped so the command behind them classifies. */
const PREFIX_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "time",
  "{",
  "}",
]);
/** Control-flow words that ARE the whole segment (or head an iteration
 *  header) — no program runs from them; their bodies are separate segments.
 *
 *  `function` was here until 2026-08-24 and should never have been: it heads a
 *  DEFINITION whose body is a command, and `function git { curl … ; }` was
 *  therefore allowed outright — then the next allow-tier `git` ran the body.
 *  It is peeled in `classifySegment` now (keyword + name), so what follows
 *  classifies. */
const STANDALONE_KEYWORDS = new Set([
  "fi",
  "done",
  "esac",
  "for",
  "select",
  "case",
  "in",
]);
/** Builtins that evaluate ARITHMETIC, where bash expands an array subscript —
 *  and therefore runs a command substitution inside it — regardless of the
 *  quoting that hid it from `extractSubstitutions`. */
const ARITHMETIC_BUILTINS = new Set(["let", "[[", "((", "test", "["]);
/** Exec-wrappers the ask/allow tier peels: they run the command behind them,
 *  so the tier must be that command's. (`sudo`/`env`/`timeout` and friends are
 *  deliberately NOT here — peeling them at this tier would turn `sudo npm
 *  test` into a silent allow. They keep asking; the BLOCK scan peels them.) */
const EXEC_PEELS = new Set(["command", "builtin"]);
/** Guards the `trap`/`alias` recursion below. */
const MAX_ACTION_DEPTH = 3;
/**
 * Heads whose line must yield NO cache scope and NO persisted rule.
 *
 * What these have in common is that the program a user would think they are
 * granting is not what actually runs: a wrapper runs its payload, an arming
 * builtin runs text later, a definition rebinds a name. A remembered
 * approval keyed on the head therefore covers arbitrary different payloads —
 * the most severe class the 2026-08-24 red team found, because it turns ONE
 * honest approval into a standing grant. Returning null (no scope) is always
 * the safe answer here; a plausible-but-wrong name is not.
 */
const SCOPE_OPAQUE_HEADS = new Set([
  ...EXEC_PEELS,
  "function",
  "trap",
  "alias",
  "jobs",
  "hash",
  "readonly",
  "local",
  "declare",
  "typeset",
  "export",
  "printf",
  "read",
  "let",
  "[[",
  "((",
  "case",
  "for",
  "select",
  "eval",
  "source",
  ".",
  "exec",
  // Wrapper programs: the payload is the argument, not the head.
  "sudo",
  "doas",
  "pkexec",
  "su",
  "runuser",
  "env",
  "nice",
  "ionice",
  "nohup",
  "setsid",
  "stdbuf",
  "timeout",
  "xargs",
  "watch",
  "flock",
  "script",
  "chroot",
  "strace",
  "ltrace",
  "taskset",
  "unshare",
  "busybox",
  "time",
  // Taken out of scopeNoise() when `-execdir` / `--pre` were understood as
  // exec knobs — but removing them from "noise" only made them NAME the
  // scope. They have to be opaque: a remembered `find` covered
  // `find . -execdir sh -c 'curl …|sh' {} ;`.
  "find",
  "rg",
]);

interface SegmentVerdict {
  verdict: Verdict;
  /** New cwd for later segments when this one was an in-workspace `cd`. */
  cwd?: string;
  /**
   * Every DISTINCT ask class this segment raised — the verdict's own `code` is
   * only the highest-risk one.
   *
   * `combine` collapses a segment's asks into one verdict, so a single segment
   * that does two things used to surface only the louder one: with
   * `GIT_SEQUENCE_EDITOR=… git rebase -i`, the destructive rebase outranked
   * the env-escalation ask and the card stopped naming it. That is the same
   * information loss the cross-segment `codes` channel was added to fix on
   * 2026-08-17 (`kill 574; curl localhost` labelled only 「访问网络」).
   */
  codes?: string[];
}

/** One segment's answer, carrying every ask class it raised. */
function segmentVerdict(
  asks: ReadonlyArray<Extract<Verdict, { kind: "ask" }>>,
  cwd?: string,
): SegmentVerdict {
  const codes = [...new Set(asks.map((a) => a.code))];
  return {
    verdict: combine([...asks]),
    ...(codes.length > 0 ? { codes } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

/** The env-key rule is run_command's ALLOW-list (fail closed): a key that
 *  is not on it asks — the user sees `FOO=bar cmd` and decides. */
function envAsk(verb: string, key: string): Extract<Verdict, { kind: "ask" }> {
  return {
    kind: "ask",
    risk: "workspace_write",
    code: "command_ask_env",
    reason: `${verb} the environment variable ${key} (not on the run_command env allow-list — review it)`,
  };
}

function classifySegment(
  rawSeg: string,
  opts: ShellClassifyOpts,
  depth = 0,
): SegmentVerdict {
  // subshell / group punctuation glued to the segment: `(cd x`, `ls)`.
  //
  // Only UNBALANCED trailing punctuation is group syntax. Stripping it
  // unconditionally ate the closing brace of a brace EXPANSION when it was the
  // last word, so `cat {/etc/passwd,x}` and `node --test {-r,./evil.cjs}` were
  // left as un-closed fragments that no brace rule could recognise (red team
  // rounds 2-3).
  let seg = rawSeg.replace(/^[({\s]+/, "").trim();
  while (/[)}]$/.test(seg)) {
    const close = seg.at(-1) as string;
    const open = close === ")" ? "(" : "{";
    const opens = seg.split(open).length - 1;
    const closes = seg.split(close).length - 1;
    if (closes <= opens) break;
    seg = seg.slice(0, -1).trim();
  }
  if (seg.length === 0) return { verdict: { kind: "allow" } };
  const tokenized = tokenize(seg);
  let { words } = tokenized;
  const { assignments, redirects } = tokenized;

  // Collected BEFORE the head peel, so every exit below — including the
  // control-flow ones — carries the segment's redirect and assignment asks.
  // A `for … done > <path>` returned from the standalone branch before the
  // redirect loop ever ran, so a loop could write the user's Startup folder
  // with no card (red team round 3).
  const asks: Array<Extract<Verdict, { kind: "ask" }>> = [];
  // env assignments (prefix `K=V …` or bare `K=V`)
  const env: Record<string, string> = {};
  for (const a of assignments) env[a.key] = a.value;
  // `${VAR:=value}` / `${VAR=value}` ASSIGN too, and they are ordinary WORDS —
  // so they never reached the assignment table and the env allow-list was
  // never consulted. With `set -a` in the same line that exports them, which
  // made `: ${GIT_CONFIG_VALUE_0:=touch PWNED}; git diff` and
  // `: ${NODE_OPTIONS:=--require ./e.js}; npm test` arbitrary execution
  // behind an allow-tier command (red team round 3).
  // Scanned over the RAW segment, not the words: the value may contain spaces
  // (`${NODE_OPTIONS:=--require ./e.js}`), which tokenization splits across
  // two words and would hide the closing brace from a per-word match.
  for (const m of seg.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):?=([^}]*)\}/g)) {
    env[m[1] as string] = m[2] ?? "";
  }
  if (Object.keys(env).length > 0) {
    const bad = findDisallowedEnvKey(env);
    if (bad !== null) asks.push(envAsk("sets", bad));
  }
  // redirections
  for (const r of redirects) {
    if (r.kind === "out") {
      if (isDevNull(r.target)) continue;
      // Bare-repo shape guard (ADR 0049 §6): a redirect completing the
      // HEAD+objects/+refs/ triple (or feeding a shaped directory's hooks)
      // is the write half of an arbitrary-execution pair — the actual write
      // happens inside bash where path-safety cannot intercept it, so the
      // guard lives at classification, block tier like the credential
      // denylist. The editors' write lane has the same guard in
      // resolveSafePath.
      const shapeDenial = redirectGitShapeDenial(r.target, opts);
      if (shapeDenial !== null) {
        return {
          verdict: {
            kind: "block",
            code: "command_blocked",
            reason: shapeDenial,
          },
        };
      }
      const outside = leavesWorkspace(r.target, opts);
      asks.push({
        kind: "ask",
        risk: "workspace_write",
        code: "command_ask_write",
        reason: outside
          ? `redirects output outside the workspace: ${r.target}`
          : `redirects output to ${r.target}`,
      });
    } else if (r.kind === "in") {
      if (leavesWorkspace(r.target, opts) || isCredentialPath(r.target)) {
        asks.push({
          kind: "ask",
          risk: "workspace_read",
          code: "command_ask_reader_path",
          reason: `reads a sensitive or out-of-workspace path: ${r.target}`,
        });
      }
    }
  }

  // Peel every wrapper word off the head until what is left is the command
  // that actually runs. Single-pass stripping was the shape of two bypasses:
  // `function` ended the walk with a verdict of its own, and `command` was
  // waved through as a state builtin (codex study 2026-08-24).
  let standalone = false;
  for (let peel = 0; peel <= MAX_ACTION_DEPTH + 3; peel += 1) {
    while (words.length > 0 && PREFIX_KEYWORDS.has(words[0] as string)) {
      words = words.slice(1);
    }
    const head = words[0];
    if (head === undefined) break;
    if (STANDALONE_KEYWORDS.has(head)) {
      standalone = true;
      break;
    }
    // `case x in pattern) cmd ;;` — the pattern label rides the command word
    if (/\)$/.test(head) && words.length > 1) {
      words = words.slice(1);
      continue;
    }
    const headName = basename(head);
    // `function NAME { body` / `function NAME() { body` — drop the keyword and
    // the name it binds; the body behind them is what runs.
    if (headName === "function") {
      words = words.slice(words.length > 1 ? 2 : 1);
      continue;
    }
    // POSIX definition, every spacing: `git(){ … }`, `git() { … }`, and
    // `git () { … }` — the last one puts `()` in its OWN word, which both the
    // `)$` rule and the glued regex missed, so the head stayed the bare
    // program name and the definition classified (and SCOPED) as if it were a
    // real `git` invocation (red team round 3).
    if (/^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{?$/.test(head) && words.length > 1) {
      words = words.slice(1);
      continue;
    }
    if (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(head) &&
      /^\(\)\s*\{?$/.test(words[1] ?? "") &&
      words.length > 2
    ) {
      words = words.slice(2);
      continue;
    }
    if (EXEC_PEELS.has(headName)) {
      let rest = words.slice(1);
      let query = false;
      while (rest.length > 0 && /^-[pvV]+$/.test(rest[0] as string)) {
        if (/[vV]/.test(rest[0] as string)) query = true;
        rest = rest.slice(1);
      }
      // `command -v git` asks WHERE git is; it runs nothing.
      if (query) return { verdict: { kind: "allow" } };
      if (rest.length === 0) break;
      words = rest;
      continue;
    }
    break;
  }
  if (standalone) {
    const kw = basename(words[0] as string);
    // `for x in LIST` / `select x in LIST`: the ITERATION LIST is the set of
    // operands the body will act on, and it was classified NOWHERE — the
    // comment claimed "their bodies are separate segments", which is true and
    // says nothing about the list. `for f in /c/Users/victim/.ssh/*; do cat
    // $f; done` therefore allowed (red team 2026-08-24).
    if (kw === "for" || kw === "select") {
      const inIdx = words.indexOf("in");
      if (inIdx >= 0) {
        for (const t of words.slice(inIdx + 1)) {
          if (t === "do" || t === ";") break;
          if (leavesWorkspace(t, opts) || isCredentialPath(t)) {
            asks.push({
              kind: "ask",
              risk: "workspace_read",
              code: "command_ask_reader_path",
              reason: `iterates over a sensitive or out-of-workspace path: ${t}`,
            });
          }
        }
      }
      return segmentVerdict(asks);
    }
    // `case X in PATTERN) CMD ;;` — later branches split off on `;;`, but the
    // FIRST one rides the same segment as the keyword, so it was never
    // classified. Take the raw text after the pattern label (not the
    // re-joined tokens, which would lose the quoting a nested `-c` needs).
    if (kw === "case") {
      const close = seg.indexOf(")");
      const branch = close >= 0 ? seg.slice(close + 1).trim() : "";
      if (branch.length > 0) {
        const inner = classifyAction(branch, opts, depth, "case branch");
        if (inner.kind === "block") return { verdict: inner };
        if (inner.kind === "ask") asks.push(inner);
      }
    }
    return segmentVerdict(asks);
  }

  // redirections
  if (words.length === 0) {
    // bare assignment or bare redirect
    return segmentVerdict(asks);
  }
  const a0 = words[0] as string;
  const name = basename(a0);

  // ADR 0045, the inversion — checked BEFORE the per-builtin handlers below,
  // because several of them return early and would otherwise skip it.
  const unmodelled = unmodelledBuiltinFlag(name, words);
  if (unmodelled !== null) {
    asks.push({
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_unresolved",
      reason: `${name} ${unmodelled} is an option the harness has not accounted for — review it`,
    });
  }

  // `export K=V` also goes through the env allow-list.
  // `readonly` and `local` assign exactly the same way and were NOT routed
  // here, so `readonly PATH=/tmp/evil:$PATH` and `local BASH_ENV=./h.sh` were
  // allowed outright — and in a PERSISTENT shell that poisons every later
  // command's resolution (red team 2026-08-24).
  if (
    name === "export" ||
    name === "declare" ||
    name === "typeset" ||
    name === "readonly" ||
    name === "local"
  ) {
    const env: Record<string, string> = {};
    for (const w of words.slice(1)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w);
      if (m) env[m[1] as string] = m[2] as string;
    }
    const bad = Object.keys(env).length > 0 ? findDisallowedEnvKey(env) : null;
    if (bad !== null) asks.push(envAsk("exports", bad));
    return segmentVerdict(asks);
  }

  if (name === "cd" || name === "pushd") {
    // Skip `cd`'s own options (`-P`, `-L`, `-e`, `-@`, `--`, and `pushd -n`).
    // Reading words[1] blindly took the OPTION as the destination: `cd -P
    // /c/Users/victim` resolved "-P" to an in-workspace path, so the escape
    // was allowed AND the tracked cwd became `<workspace>/-P`, which made
    // every later relative operand on the line look local too (red team
    // 2026-08-24).
    let ti = 1;
    while (
      ti < words.length &&
      /^-[a-zA-Z@]*$|^--$/.test(words[ti] as string)
    ) {
      const w = words[ti] as string;
      ti += 1;
      if (w === "--") break;
      if (w === "-") {
        ti -= 1; // `cd -` is the previous directory, not an option
        break;
      }
    }
    const target = words[ti];
    if (
      target === undefined ||
      target === "~" ||
      target === "-" ||
      target.startsWith("~/") ||
      /[$`]/.test(target)
    ) {
      asks.push(cdAsk(target ?? "(home)"));
      return segmentVerdict(asks);
    }
    const dest = destinationOf(target, opts);
    if (dest === null) {
      asks.push(cdAsk(target));
      return segmentVerdict(asks);
    }
    return segmentVerdict(asks, dest);
  }

  if (OPAQUE_BUILTINS.has(name)) {
    asks.push({
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_interpreter",
      reason: `${name} runs text the harness cannot classify — review it`,
    });
    return segmentVerdict(asks);
  }

  // `trap ACTION SIGSPEC` — the shell runs ACTION later, and the persistent
  // shell of the minimal contract DOES exit, so `trap 'rm -rf /' EXIT` was a
  // real deferred payload sitting behind an allow (codex study 2026-08-24).
  // Classify the action as the command it is; a reset/ignore/query runs
  // nothing.
  if (name === "trap") {
    // Skip trap's own options — `trap -- 'rm -rf /' EXIT` put `--` in this
    // slot and the action went unread.
    let ai = 1;
    while (ai < words.length && /^-[plP-]$/.test(words[ai] as string)) {
      const w = words[ai] as string;
      ai += 1;
      if (w === "--") break;
      if (w === "-") {
        ai -= 1; // `trap - EXIT` resets the handler
        break;
      }
    }
    const action = words[ai];
    if (
      action === undefined ||
      action === "-" ||
      action.trim().length === 0 ||
      /^-[plP]$/.test(action)
    ) {
      return segmentVerdict(asks);
    }
    const inner = classifyAction(action, opts, depth, `trap ${action}`);
    if (inner.kind === "block") return { verdict: inner };
    if (inner.kind === "ask") asks.push(inner);
    return segmentVerdict(asks);
  }

  // `alias name=value` stores command text the shell substitutes later.
  // Weaker than `trap`/`function` (this shell runs `--noprofile --norc` over
  // pipes, so it is non-interactive and expands no aliases until someone runs
  // `shopt -s expand_aliases`) — but the value is still command text nobody
  // was looking at, and the enabling shopt is itself allow-tier.
  if (name === "alias") {
    for (const w of words.slice(1)) {
      const eq = w.indexOf("=");
      if (eq <= 0) continue; // `alias` / `alias name` are queries
      const value = w.slice(eq + 1).trim();
      if (value.length === 0) continue;
      const inner = classifyAction(value, opts, depth, `alias ${w}`);
      if (inner.kind === "block") return { verdict: inner };
      if (inner.kind === "ask") asks.push(inner);
    }
    return segmentVerdict(asks);
  }

  // ── builtins that DO take a command, a variable, or an expression ──
  //
  // STATE_BUILTINS means "runs no command of its own, assigns no variable,
  // evaluates no arithmetic". These members violated it and were allowed with
  // argv[1..] unread (red team 2026-08-24). Each is handled rather than
  // removed, so the honest spelling of each still allows.

  // `jobs -x CMD [args]` substitutes jobspecs and then EXECS CMD — an
  // undocumented-looking but fully documented exec wrapper.
  if (name === "jobs") {
    const xi = words.indexOf("-x");
    if (xi >= 0 && words.length > xi + 1) {
      const inner = classifyAction(
        words.slice(xi + 1).join(" "),
        opts,
        depth,
        "jobs -x",
      );
      if (inner.kind === "block") return { verdict: inner };
      if (inner.kind === "ask") asks.push(inner);
    }
    return segmentVerdict(asks);
  }

  // `hash -p FILE NAME` points NAME at FILE for the rest of the session, so a
  // later allow-tier `git` runs whatever was planted. Same class as poisoning
  // PATH, hence the env ask.
  if (name === "hash" && words.includes("-p")) {
    asks.push({
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_env",
      reason: `hash -p re-points a command name at ${words[words.indexOf("-p") + 1] ?? "a file"} for the rest of the session — later commands would run it instead`,
    });
    return segmentVerdict(asks);
  }

  // `printf -v VAR` and `read [-r] VAR …` both ASSIGN, so their targets go
  // through the same env allow-list an `export` would.
  if (name === "printf" || name === "read") {
    const targets: string[] = [];
    if (name === "printf") {
      const vi = words.indexOf("-v");
      if (vi >= 0 && words.length > vi + 1)
        targets.push(words[vi + 1] as string);
    } else {
      let seenFormat = false;
      for (let i = 1; i < words.length; i += 1) {
        const w = words[i] as string;
        if (w.startsWith("-")) {
          // `-p PROMPT`, `-d DELIM`, `-n N`, `-N N`, `-t T`, `-u FD`, `-a ARR`
          if (/^-[pdnNtua]$/.test(w)) i += 1;
          continue;
        }
        if (!seenFormat && name !== "read") {
          seenFormat = true;
          continue;
        }
        targets.push(w);
      }
    }
    const env: Record<string, string> = {};
    for (const t of targets) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) env[t] = "";
    }
    const bad = Object.keys(env).length > 0 ? findDisallowedEnvKey(env) : null;
    if (bad !== null) asks.push(envAsk("assigns", bad));
    return segmentVerdict(asks);
  }

  // Arithmetic evaluation expands array subscripts, so a command substitution
  // RUNS even inside single quotes — `let 'y[$(curl …)]=1'` executed with no
  // card because extractSubstitutions passes single-quoted spans through
  // verbatim. Re-scan the raw segment for substitutions the outer pass could
  // not see.
  if (ARITHMETIC_BUILTINS.has(name)) {
    for (const sub of substitutionsInsideQuotes(seg)) {
      const inner = classifyAction(sub, opts, depth, `${name} ${sub}`);
      if (inner.kind === "block") return { verdict: inner };
      if (inner.kind === "ask") asks.push(inner);
    }
    return segmentVerdict(asks);
  }

  if (STATE_BUILTINS.has(name)) return segmentVerdict(asks);

  // Everything else: the argv classifier, with in-workspace absolute paths
  // rewritten relative so `cat /e/repo/src/x` classifies as `cat src/x`.
  const argv = words.map((w, i) =>
    i === 0 ? w : relativizeInsideWorkspace(w, opts),
  );
  // `shell: true` — this argv is about to be EXPANDED by bash, so the
  // inversion's unresolved-token rules apply here and only here. `unresolved`
  // is computed from the RAW segment because quoting decides it and the words
  // above have already lost their quotes.
  const v = classifyCommand(argv, {
    shell: true,
    unresolved: hasLiveExpansion(seg),
    // Lazy in-progress probe at the segment's effective cwd (ADR 0049 §5) —
    // consulted only for commit-concluding git shapes.
    repoInProgress: () => {
      const gitDir = resolveGitDir(opts.cwd ?? opts.workspaceRoot);
      return gitDir === null ? null : detectInProgressState(gitDir);
    },
  });
  if (v.kind === "block") return { verdict: v };
  if (v.kind === "ask") asks.push(v);
  return segmentVerdict(asks);
}

/** Native path a `cd` target lands on when it stays inside the workspace;
 *  null when it leaves (or cannot be resolved as a path). */
function destinationOf(token: string, opts: ShellClassifyOpts): string | null {
  const t = token.replace(/^["']|["']$/g, "");
  const native = opts.paths.toNative(t);
  if (native !== null)
    return isPathInside(opts.workspaceRoot, native) ? native : null;
  if (/^[\\/]/.test(t)) return null;
  const resolved = resolveNative(opts.cwd ?? opts.workspaceRoot, t);
  return isPathInside(opts.workspaceRoot, resolved) ? resolved : null;
}

/** A `cd` that leaves the workspace. WRITE risk and its own class
 *  (2026-08-17): the classifier cannot follow relative paths after it, so
 *  everything later on the line may read OR write outside the workspace —
 *  the permission lab saw `cd .. && cp -r ws ws-copy` labelled by its `cp`
 *  ("filesystem operation") with the escape only in the raw reason. As a
 *  write-tier ask it competes for the top label and reads as what it is. */
function cdAsk(target: string): Extract<Verdict, { kind: "ask" }> {
  return {
    kind: "ask",
    risk: "workspace_write",
    code: "command_ask_cwd_escape",
    reason: `cd leaves the workspace: ${target} — later relative paths would resolve outside it`,
  };
}

/**
 * `$( … )` / backtick spans that `extractSubstitutions` deliberately skipped
 * because they sit inside single quotes.
 *
 * Normally that skip is correct — single quotes make a substitution inert.
 * Inside an ARITHMETIC evaluation they are not inert: bash expands array
 * subscripts, so `let 'y[$(cmd)]=1'` runs `cmd`. Only the arithmetic builtins
 * consult this.
 */
function substitutionsInsideQuotes(segment: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] as string;
    const isDollar = ch === "$" && segment[i + 1] === "(";
    if (!isDollar && ch !== "`") continue;
    if (ch === "`") {
      const j = segment.indexOf("`", i + 1);
      if (j === -1) break;
      const inner = segment.slice(i + 1, j).trim();
      if (inner.length > 0) out.push(inner);
      i = j;
      continue;
    }
    let depth = 0;
    let j = i + 1;
    for (; j < segment.length; j += 1) {
      const c = segment[j];
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const inner = segment.slice(i + 2, j).trim();
    if (inner.length > 0) out.push(inner);
    i = j;
  }
  return out;
}

/**
 * Strip the control-flow and wrapper words off a segment's head, so a caller
 * sees the command that actually runs.
 *
 * Exported because the ASYNC reader guard (bash/rule.ts) must start where the
 * classifier starts. When it did not, `time cat out/win.ini` was enough to
 * disable it — the guard looked up `time` in its reader table, found nothing,
 * and checked no paths at all.
 */
export function peelReaderHead(words: readonly string[]): string[] {
  let ws = [...words];
  for (let peel = 0; peel <= 6; peel += 1) {
    while (ws.length > 0 && PREFIX_KEYWORDS.has(ws[0] as string))
      ws = ws.slice(1);
    const head = ws[0];
    if (head === undefined) break;
    const name = basename(head);
    if (name === "function" && ws.length > 1) {
      ws = ws.slice(2);
      continue;
    }
    if (EXEC_PEELS.has(name) && ws.length > 1) {
      let rest = ws.slice(1);
      while (rest.length > 0 && /^-[pvV]+$/.test(rest[0] as string))
        rest = rest.slice(1);
      if (rest.length === 0) break;
      ws = rest;
      continue;
    }
    break;
  }
  return ws;
}

/**
 * True when these words DEFINE a function rather than invoke a program —
 * every spacing of the POSIX form (`f(){`, `f() {`, `f () {`).
 *
 * A definition rebinds a name, so the program a scope would report is not what
 * anything runs. Both scope functions must refuse it, not just the classifier.
 */
function isDefinitionHead(words: readonly string[]): boolean {
  const head = words[0];
  if (head === undefined) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*\(\)/.test(head)) return true;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(head) && /^\(\)/.test(words[1] ?? "");
}

/**
 * Does this segment contain an expansion the shell will actually PERFORM?
 *
 * Quoting decides. Single quotes suppress every expansion, so `sed -n '$p' a`
 * passes bash the two literal characters `$p` — a sed script, not a variable.
 * The tokenizer strips quotes before the classifier sees a word, which loses
 * exactly the fact that matters, so this reads the RAW segment instead.
 * Getting it wrong in the safe direction still costs a card on a very common
 * idiom, which is how it was caught (permission-lab replay).
 */
function hasLiveExpansion(seg: string): boolean {
  // Brace expansion is decided by whether the BRACES are quoted, never by
  // whether the elements are: bash expands `{'a','b'}` exactly as it expands
  // `{a,b}`. Testing the raw text with a quote-hostile character class read
  // the quoted spelling as inert, so `git grep {'-O./x.sh','needle'} .` — the
  // pager flag, i.e. arbitrary execution — reached allow while its unquoted
  // twin correctly asked. Tracking the structure during the walk decides it
  // the way the shell does, and drops the old false positive on a fully
  // single-quoted `'{a,b}'`, which bash passes through untouched.
  let braceDepth = 0;
  let braceComma = false;
  for (let i = 0; i < seg.length; i += 1) {
    const ch = seg[i] as string;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "'") {
      const end = seg.indexOf("'", i + 1);
      i = end === -1 ? seg.length : end;
      continue;
    }
    if (ch === "$" && seg[i + 1] === "'") {
      // ANSI-C literal: decoded by tokenize, expands nothing.
      i = findAnsiCEnd(seg, i + 2);
      continue;
    }
    if (ch === '"') {
      // Double quotes still expand parameters — walk INTO them. They do NOT
      // brace-expand, so the brace state deliberately does not move here.
      const end = seg.indexOf('"', i + 1);
      const inner = seg.slice(i + 1, end === -1 ? seg.length : end);
      if (LIVE_IN_DOUBLE_QUOTES.test(inner)) return true;
      i = end === -1 ? seg.length : end;
      continue;
    }
    if (ch === "`") return true;
    if (ch === "$" && LIVE_AFTER_DOLLAR.test(seg[i + 1] ?? "")) return true;
    if (ch === "{") braceDepth += 1;
    else if (ch === "," && braceDepth > 0) braceComma = true;
    else if (ch === "}" && braceDepth > 0) {
      if (braceComma) return true;
      braceDepth -= 1;
    }
  }
  return false;
}

/**
 * What may follow `$` and still expand.
 *
 * Requiring an IDENTIFIER here declared the positional and special parameters
 * already resolved, so `set -- /etc/passwd; cat "$1"` was two allow-tier
 * commands reading an arbitrary file — and a persistent shell carries the
 * positionals from the first into the second.
 */
const LIVE_AFTER_DOLLAR = /[{(A-Za-z_0-9@*?#!$-]/;

/** The same set, for the inside of a double-quoted run. */
const LIVE_IN_DOUBLE_QUOTES = /\$\{|\$\(|`|\$[A-Za-z_0-9@*?#!$-]/;

/** Program identity of an argv[0]: basename, lowercased, `.exe` stripped. */
function basename(a0: string): string {
  return (
    a0
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, "") ?? a0
  );
}

/**
 * Classify command text a builtin STORES for the shell to run later
 * (`trap`'s action, an `alias` value) — the same tiers the text would get if
 * it had been typed directly.
 *
 * Fails CLOSED at the depth cap: text the harness stopped following is not
 * text the harness may call safe.
 */
function classifyAction(
  text: string,
  opts: ShellClassifyOpts,
  depth: number,
  label: string,
): Verdict {
  if (depth >= MAX_ACTION_DEPTH) {
    return {
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_interpreter",
      reason: `${label} — stored command text nested deeper than the harness follows; review it`,
    };
  }
  const blocked = classifyShellBody(text);
  if (blocked.hit) {
    return { kind: "block", code: "command_blocked", reason: blocked.reason };
  }
  const { text: outer, inner } = extractSubstitutions(stripHeredocBodies(text));
  const segments = [
    ...splitShellSegments(normalizeFdRedirects(outer)),
    ...inner.flatMap((s) => splitShellSegments(normalizeFdRedirects(s))),
  ];
  const asks: Array<Extract<Verdict, { kind: "ask" }>> = [];
  for (const raw of segments) {
    const s = raw.trim();
    if (s.length === 0) continue;
    const r = classifySegment(s, opts, depth + 1);
    if (r.verdict.kind === "block") return r.verdict;
    if (r.verdict.kind === "ask") asks.push(r.verdict);
  }
  return combine(asks);
}

function combine(asks: Array<Extract<Verdict, { kind: "ask" }>>): Verdict {
  if (asks.length === 0) return { kind: "allow" };
  asks.sort((a, b) => RISK_RANK[b.risk] - RISK_RANK[a.risk]);
  const top = asks[0] as Extract<Verdict, { kind: "ask" }>;
  // Highest-risk ask's consequence preferred; any ask's as fallback — a note
  // is information, and dropping it because a louder ask had none would be
  // the same loss the `codes` channel exists to prevent.
  const consequence = asks.find(
    (a) => a.consequence !== undefined,
  )?.consequence;
  return {
    kind: "ask",
    risk: top.risk,
    code: top.code,
    reason: [...new Set(asks.map((a) => a.reason))].join("; "),
    ...(consequence !== undefined ? { consequence } : {}),
  };
}

// ───────────────────────── path helpers ─────────────────────────

function isDevNull(target: string): boolean {
  return target === "/dev/null" || target === "NUL" || target === "nul";
}

/** True when a path token resolves outside the workspace (absolute outside,
 *  `..` escape, `~`); relative paths resolve against the shell cwd. */
function leavesWorkspace(token: string, opts: ShellClassifyOpts): boolean {
  const t = token.replace(/^["']|["']$/g, "");
  if (t.startsWith("~")) return true;
  // A variable or substitution is UNKNOWABLE, and this returned false for it —
  // reading "I cannot tell" as "it stays inside". That is the one direction a
  // containment check may not guess in: `cat $HOME/.config/gh/hosts.yml` and
  // `npm test > $HOME/.bashrc` both rode it (red team 2026-08-24). Unknowable
  // now means treated as leaving, which costs an approval card on the honest
  // `> $LOG` and buys the guarantee back.
  if (/[$`]/.test(t)) return true;
  const native = opts.paths.toNative(t);
  if (native !== null) return !isPathInside(opts.workspaceRoot, native);
  if (/^[\\/]/.test(t)) return true; // some other absolute spelling
  const base = opts.cwd ?? opts.workspaceRoot;
  const resolved = resolveNative(base, t);
  return !isPathInside(opts.workspaceRoot, resolved);
}

/** Bare-repo shape denial for an out-redirect target (ADR 0049 §6), or null.
 *  Unknowable targets (variables, substitutions, unmappable spellings) stay
 *  null — they already ask as leaving the workspace; the guard fires only on
 *  a literal in-workspace path it can resolve. */
function redirectGitShapeDenial(
  token: string,
  opts: ShellClassifyOpts,
): string | null {
  const t = token.replace(/^["']|["']$/g, "");
  if (/[$`]/.test(t)) return null;
  let native = opts.paths.toNative(t);
  if (native === null) {
    if (/^[\\/]/.test(t)) return null; // unmappable absolute spelling
    native = resolveNative(opts.cwd ?? opts.workspaceRoot, t);
  }
  if (!isPathInside(opts.workspaceRoot, native)) return null;
  return gitDirShapeWriteDenial(opts.workspaceRoot, resolve(native));
}

/**
 * A path token as the WORKSPACE sees it: `{ native, relative }` when the
 * token (shell or native spelling, or relative to the shell cwd) resolves to
 * a location inside the workspace; null when it leaves it, is `~`, carries
 * a variable/substitution, or is not a path claim at all. Shared by the
 * heredoc-write preview (bash/heredoc-write.ts), which needs the same
 * answer the redirect classifier gives.
 */
export function resolveWorkspacePath(
  token: string,
  opts: ShellClassifyOpts,
): { native: string; relative: string } | null {
  const t = token.replace(/^["']|["']$/g, "");
  if (t.length === 0 || t.startsWith("~") || /[$`]/.test(t)) return null;
  const nativeAbs = opts.paths.toNative(t);
  const native =
    nativeAbs ??
    (/^[\\/]/.test(t)
      ? null
      : resolveNative(opts.cwd ?? opts.workspaceRoot, t));
  if (native === null || !isPathInside(opts.workspaceRoot, native)) return null;
  const rel = relativePath(opts.workspaceRoot, native);
  return { native, relative: rel === "" ? "." : rel };
}

/** `/e/repo/src/x` (or `E:\repo\src\x`) → `src/x` when inside the workspace;
 *  otherwise the token unchanged (so the argv classifier's own guards see
 *  the absolute form and ask). */
function relativizeInsideWorkspace(
  token: string,
  opts: ShellClassifyOpts,
): string {
  const native = opts.paths.toNative(token);
  if (native === null) return token;
  if (!isPathInside(opts.workspaceRoot, native)) return token;
  const rel = relativePath(opts.workspaceRoot, native);
  return rel === "" ? "." : rel;
}

function resolveNative(base: string, p: string): string {
  return resolve(base, p);
}
function relativePath(root: string, p: string): string {
  return relative(resolve(root), resolve(p)).split("\\").join("/");
}

// ───────────────────────── lexical helpers ─────────────────────────

/**
 * Remove heredoc BODIES (`<<WORD` … `WORD`), keep the command lines.
 *
 * The `<<` that opens a heredoc has to be a real redirection operator. Finding
 * it with a regex over the raw line was worse than imprecise, it was SILENTLY
 * LOSSY: any `<<` inside a quoted string or a comment started a heredoc that
 * never terminated, so every remaining line was dropped before segmentation
 * and never classified at all. `git grep -n "<<<<<<< HEAD"` followed by
 * anything — the shape a model reaches for while resolving a merge conflict —
 * discarded the rest of the command and returned allow (2026-08-24 red team).
 *
 * So: scan character by character with quote state, skip `#` comments, and
 * require a genuine `<<` that is not the `<<<` here-string operator.
 */
export function stripHeredocBodies(body: string): string {
  return splitHeredocs(body).text;
}

/**
 * Heredoc bodies removed, and the ones bash would EXPAND handed back.
 *
 * A quoted delimiter (`<<'EOF'`) makes the body literal text — that is the
 * case the "bodies are data, not commands" rule was written for. An UNQUOTED
 * delimiter (`<<EOF`) does not: bash expands the body, so a `$( … )` inside it
 * runs. Stripping both alike, before `extractSubstitutions` ever looked, meant
 * `cat <<EOF` / `$(rm -rf /)` / `EOF` classified as a plain `cat` (red team
 * round 3).
 */
function splitHeredocs(body: string): { text: string; expanded: string[] } {
  const lines = body.split("\n");
  const out: string[] = [];
  const expanded: string[] = [];
  let terminator: string | null = null;
  let stripTabs = false;
  let quotedDelimiter = false;
  let current: string[] = [];
  for (const line of lines) {
    if (terminator !== null) {
      const probe = stripTabs ? line.replace(/^\t+/, "") : line;
      if (probe === terminator) {
        if (!quotedDelimiter && current.length > 0)
          expanded.push(current.join("\n"));
        current = [];
        terminator = null;
      } else if (!quotedDelimiter) {
        current.push(line);
      }
      continue;
    }
    out.push(line);
    const opener = findHeredocOpener(line);
    if (opener !== null) {
      stripTabs = opener.stripTabs;
      terminator = opener.terminator;
      quotedDelimiter = opener.quoted;
    }
  }
  // An unterminated heredoc still had its lines consumed; keep whatever the
  // expandable one accumulated rather than dropping it silently.
  if (!quotedDelimiter && current.length > 0) expanded.push(current.join("\n"));
  return { text: out.join("\n"), expanded };
}

/** The heredoc `<<WORD` a line really opens (unquoted, uncommented, and not
 *  the `<<<` here-string), or null. */
function findHeredocOpener(
  line: string,
): { terminator: string; stripTabs: boolean; quoted: boolean } | null {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quote !== null) {
      if (ch === "\\" && quote === '"' && i + 1 < line.length) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    // An unquoted `#` at a word boundary starts a comment: nothing after it
    // is an operator.
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] as string)))
      return null;
    if (ch !== "<" || line[i + 1] !== "<") continue;
    // `<<<` is a here-string — its operand is data on the SAME line, and it
    // opens no body to strip.
    if (line[i + 2] === "<") {
      i += 2;
      continue;
    }
    const rest = line.slice(i + 2);
    const m =
      /^(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(rest);
    if (m === null) continue;
    const terminator = (m[2] ?? m[3] ?? m[4]) as string;
    if (terminator.length === 0) continue;
    // `<<'EOF'` / `<<"EOF"` (and `<<\EOF`) suppress expansion; a bare word
    // does not.
    const quoted =
      m[2] !== undefined || m[3] !== undefined || /^-?\s*\\/.test(rest);
    return { terminator, stripTabs: m[1] === "-", quoted };
  }
  return null;
}

/** Pull `$( … )` and backtick substitutions out (nesting-aware); the text
 *  keeps a placeholder so the outer command still classifies. */
export function extractSubstitutions(body: string): {
  text: string;
  inner: string[];
} {
  const inner: string[] = [];
  let text = "";
  let i = 0;
  let quote: "'" | '"' | null = null;
  while (i < body.length) {
    const ch = body[i] as string;
    const prev = i > 0 ? body[i - 1] : "";
    if (quote === "'") {
      text += ch;
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" && quote === null && prev !== "\\") {
      quote = "'";
      text += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && prev !== "\\") {
      quote = quote === '"' ? null : '"';
      text += ch;
      i += 1;
      continue;
    }
    // `$( … )` command substitution, and `<( … )` / `>( … )` PROCESS
    // substitution — all three run the text inside as a command. Process
    // substitution was missed until 2026-08-24, and it read as harmless twice
    // over: the body never classified, and the leftover `<` made the outer
    // command look like a redirect from a file (`cat <(curl …)` allowed).
    const isCmdSubst = ch === "$" && body[i + 1] === "(" && prev !== "\\";
    const isProcSubst =
      (ch === "<" || ch === ">") && body[i + 1] === "(" && prev !== "\\";
    if (isCmdSubst || isProcSubst) {
      // find the matching paren, nesting-aware
      let depth = 0;
      let j = i + 1;
      for (; j < body.length; j += 1) {
        const c = body[j];
        if (c === "(") depth += 1;
        else if (c === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const content = body.slice(i + 2, j);
      const nested = extractSubstitutions(content);
      inner.push(nested.text, ...nested.inner);
      text += "__SUBST__";
      i = j + 1;
      continue;
    }
    if (ch === "`" && prev !== "\\") {
      const j = body.indexOf("`", i + 1);
      if (j === -1) {
        text += ch;
        i += 1;
        continue;
      }
      inner.push(body.slice(i + 1, j));
      text += "__SUBST__";
      i = j + 1;
      continue;
    }
    text += ch;
    i += 1;
  }
  return { text, inner: inner.filter((s) => s.trim().length > 0) };
}

/** `2>&1`, `>&2`, `1>&2` are fd duplications, not writes; blank them so the
 *  segment splitter's `&` does not cut the line and the redirect scan does
 *  not read a target from them. */
export function normalizeFdRedirects(text: string): string {
  return text.replace(/\d*>&\d+/g, " ").replace(/&>\s*\/dev\/null/g, " ");
}

/** Index of the closing quote of an ANSI-C `$'…'` literal (backslash-aware). */
function findAnsiCEnd(s: string, from: number): number {
  for (let j = from; j < s.length; j += 1) {
    if (s[j] === "\\") {
      j += 1;
      continue;
    }
    if (s[j] === "'") return j;
  }
  return s.length;
}

/** The C escapes bash resolves inside `$'…'`. Anything unrecognized keeps its
 *  literal character, which is what bash does too. */
function decodeAnsiC(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) break;
    i += 1;
    if (n === "x" || n === "u" || n === "U") {
      const width = n === "x" ? 2 : n === "u" ? 4 : 8;
      const hex = body.slice(i + 1, i + 1 + width).match(/^[0-9a-fA-F]+/)?.[0];
      if (hex !== undefined && hex.length > 0) {
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += hex.length;
        continue;
      }
      out += n;
      continue;
    }
    const oct = /^[0-7]{1,3}/.exec(n + body.slice(i + 1, i + 3))?.[0];
    if (n >= "0" && n <= "7" && oct !== undefined) {
      out += String.fromCharCode(Number.parseInt(oct, 8));
      i += oct.length - 1;
      continue;
    }
    const simple: Record<string, string> = {
      n: "\n",
      t: "\t",
      r: "\r",
      a: "\x07",
      b: "\b",
      f: "\f",
      v: "\v",
      e: "\x1b",
      E: "\x1b",
      "\\": "\\",
      "'": "'",
      '"': '"',
    };
    out += simple[n] ?? n;
  }
  return out;
}

export interface Tokenized {
  words: string[];
  assignments: Array<{ key: string; value: string }>;
  redirects: Array<{ kind: "out" | "in"; target: string }>;
}

/** Shell-style word split of ONE simple command: quotes and backslash
 *  escapes honoured, leading `K=V` assignments separated, redirections
 *  pulled out with their targets. */
export function tokenize(segment: string): Tokenized {
  const raw: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  const s = segment.trim();
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] as string;
    // ANSI-C quoting: `$'…'` is a STRING LITERAL with C escapes, and bash
    // expands it before anything else sees it. Left undecoded, `$'\x72\x6d'`
    // reached the catastrophic check as the word `$\x72\x6d` (never `rm`) and
    // `cat $'.env'` never matched the credential denylist (red team round 3).
    if (ch === "$" && s[i + 1] === "'" && quote === null) {
      const end = findAnsiCEnd(s, i + 2);
      cur += decodeAnsiC(s.slice(i + 2, end));
      has = true;
      i = end;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      has = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (
        ch === "\\" &&
        i + 1 < s.length &&
        /["\\$`]/.test(s[i + 1] as string)
      ) {
        cur += s[i + 1];
        i += 1;
      } else cur += ch;
      has = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === "\\" && i + 1 < s.length) {
      cur += s[i + 1];
      has = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        raw.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    // split redirection operators glued to words: `>file`, `2>>x`, `<in`
    if (ch === ">" || ch === "<" || (ch === "&" && s[i + 1] === ">")) {
      // flush a preceding word unless it is a bare fd number
      if (has && !/^\d+$/.test(cur)) {
        raw.push(cur);
        cur = "";
        has = false;
      }
      let op = has ? cur : ""; // fd prefix
      cur = "";
      has = false;
      op += ch;
      if (ch === "&") {
        op += ">";
        i += 1;
      }
      if (s[i + 1] === ">" || (ch === "<" && s[i + 1] === "<")) {
        op += s[i + 1];
        i += 1;
        if (s[i + 1] === "<") {
          op += "<";
          i += 1;
        }
      }
      if (s[i + 1] === "|") {
        op += "|";
        i += 1;
      }
      raw.push(op);
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) raw.push(cur);

  const words: string[] = [];
  const assignments: Tokenized["assignments"] = [];
  const redirects: Tokenized["redirects"] = [];
  let leading = true;
  for (let i = 0; i < raw.length; i += 1) {
    const w = raw[i] as string;
    if (OUT_REDIRECT.test(w)) {
      const target = raw[i + 1];
      if (target !== undefined) redirects.push({ kind: "out", target });
      i += 1;
      leading = false;
      continue;
    }
    if (/^\d*<$/.test(w)) {
      const target = raw[i + 1];
      if (target !== undefined) redirects.push({ kind: "in", target });
      i += 1;
      leading = false;
      continue;
    }
    if (/^\d*<<-?$/.test(w) || w === "<<<") {
      // heredoc terminator word / here-string: data, not a path
      i += 1;
      leading = false;
      continue;
    }
    if (leading) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w);
      if (m) {
        assignments.push({ key: m[1] as string, value: m[2] as string });
        continue;
      }
      leading = false;
    }
    words.push(w);
  }
  return { words, assignments, redirects };
}
