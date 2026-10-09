import {
  type CommandConsequence,
  type RepoInProgressState,
  type RiskLevel,
  SCRIPT_INTERPRETERS,
} from "@herta/core";
import { isCredentialPath } from "../credential-denylist.js";
import { patchTargetPaths } from "./patch-targets.js";

export type Verdict =
  | { kind: "allow" }
  | {
      kind: "ask";
      risk: RiskLevel;
      reason: string;
      code: string;
      /** Consequence note for the card (ADR 0049 §5) — display-only, never
       *  part of the tier decision. */
      consequence?: CommandConsequence;
    }
  | { kind: "block"; reason: string; code: "command_blocked" };

/** Home, every way a shell spells it (platform review 2026-09-23: the `$HOME`
 *  spellings of `rm -rf ~` dropped from block to an ordinary ask). Compared
 *  after `rootForm`, so the trailing `/`, `/*` spellings need no entries. */
const HOME_PATHS = new Set(["~", "$HOME", "${HOME}"]);

/**
 * A root or home spelling reduced to its bare form: runs of `/` collapsed and
 * every trailing `/`, `/.` and `/*` stripped, so `/`, `//*`, `~//` and
 * `$HOME/.` compare as ``, ``, `~` and `$HOME`. Matching exact strings let
 * each extra slash walk `rm -rf` from the block tier down to an ask (probe
 * 2026-09-23).
 *
 * `~name` (another user's home) is deliberately NOT here: cmd and PowerShell
 * never expand it, so on Windows `del ~WRL0001.tmp` names Word's temp file —
 * and a block has no override. `rm -rf ~bob` stays a destructive ask, asked
 * every time.
 */
function rootForm(a: string): string {
  let s = a.replace(/\/{2,}/g, "/");
  for (;;) {
    const next = s.replace(/\/(?:\.|\*)?$/, "");
    if (next === s) return s;
    s = next;
  }
}

/** System-root-ish paths across platforms. Windows shells name roots as
 *  `C:\` / `C:/` / bare `\`, never `/` — the decoded shell bodies below hand
 *  these to the catastrophic check, so the POSIX-only set was a blind spot. */
function isSystemRootPath(a: string): boolean {
  const bare = rootForm(a);
  if (a !== "" && (bare === "" || HOME_PATHS.has(bare))) return true;
  if (/^[A-Za-z]:[\\/]?\*?$/.test(a)) return true;
  return a === "\\" || a === "\\*" || a === "\\\\";
}

/**
 * `rm`'s recursive + force, however the flags are clustered (platform review
 * 2026-09-23): only the exact `-rf` / `-fr` / `-Rf` / `-fR` tokens and the
 * separate `-r -f` used to count, so `rm -rfv /` and `rm -Rfi ~` dropped from
 * the block tier to an ordinary ask (and past the destructive ask, which
 * shares this helper). A short-option cluster carries every letter in it;
 * option parsing ends at `--`.
 */
function hasRecursiveForce(argv: readonly string[]): boolean {
  let r = false;
  let f = false;
  for (const a of argv.slice(1)) {
    if (a === "--") break;
    if (a === "--recursive") r = true;
    else if (a === "--force") f = true;
    else if (/^-[A-Za-z]+$/.test(a)) {
      if (/[rR]/.test(a)) r = true;
      if (a.includes("f")) f = true;
    }
  }
  return r && f;
}

/**
 * Word-split a shell body for the BLOCK scan — quote-aware.
 *
 * This used to whitespace-split and then strip quotes off each token, which
 * tore a QUOTED inner command into pieces: `bash -c "sh -c 'rm -rf /'"` became
 * `[bash, -c, sh, -c, rm, -rf, /]`, so `extractShellReentry` read the body as
 * the single word `sh` and the catastrophic payload never re-entered the scan.
 * The no-override block tier degraded to a user-approvable ask (codex study
 * 2026-08-24; the same class the 2026-07-10 `cmd /c` and 2026-08-05 `&&`
 * findings closed in other spellings).
 *
 * Keeping a quoted run together is the whole point: the body must survive as
 * ONE token so the re-entry can recurse into it.
 */
function shellBodyTokens(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  const s = body.trim();
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
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
        out.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out.filter((t) => t.length > 0);
}

/** How a wrapper program's own arguments are laid out before the command it
 *  goes on to execute. */
interface WrapperSpec {
  /** Flags that consume the NEXT word as their value (`sudo -u root …`). */
  valueFlags?: ReadonlySet<string>;
  /** Bare operands the wrapper eats before the command (`timeout 5 …`). */
  operands?: number;
  /** Leading `K=V` words belong to the wrapper (`env FOO=bar …`). */
  assignments?: boolean;
}

/**
 * Programs whose job is to run ANOTHER program. Peeling them is what lets the
 * catastrophic check see the real command underneath (codex study 2026-08-24;
 * cf. Codex's recursive wrapper peel in `is_dangerous_command.rs`).
 *
 * Block tier only, and peeling only ever ESCALATES: a benign payload never
 * upgrades a wrapper to allow, exactly as `extractShellReentry` is documented
 * to work. Widening the ALLOW tier through these wrappers would be a different
 * decision — `sudo npm test` must not become a silent allow — so the ask/allow
 * classifier deliberately still sees `sudo` itself and asks.
 */
const EXEC_WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map<
  string,
  WrapperSpec
>([
  ["sudo", { valueFlags: new Set(["-u", "-g", "-p", "-C", "-U", "-t", "-r"]) }],
  ["doas", { valueFlags: new Set(["-u", "-C", "-a"]) }],
  ["pkexec", { valueFlags: new Set(["--user"]) }],
  [
    "env",
    { valueFlags: new Set(["-u", "--unset", "-C", "-S"]), assignments: true },
  ],
  ["nice", { valueFlags: new Set(["-n", "--adjustment"]) }],
  ["ionice", { valueFlags: new Set(["-c", "-n", "-p"]) }],
  ["nohup", {}],
  ["setsid", {}],
  ["stdbuf", { valueFlags: new Set(["-i", "-o", "-e"]) }],
  [
    "timeout",
    {
      valueFlags: new Set(["-k", "-s", "--signal", "--kill-after"]),
      operands: 1,
    },
  ],
  [
    "xargs",
    {
      valueFlags: new Set([
        "-n",
        "-P",
        "-I",
        "-i",
        "-d",
        "-s",
        "-E",
        "-a",
        "-L",
        "--max-args",
        "--max-procs",
        "--replace",
        "--delimiter",
      ]),
    },
  ],
  ["command", { valueFlags: new Set() }],
  ["builtin", {}],
  ["time", {}],
  // Second batch (red team 2026-08-24): every one of these reached ask with a
  // CACHEABLE scope while carrying a catastrophic payload.
  ["su", { valueFlags: new Set(["-c", "-s", "-l", "--command", "--shell"]) }],
  ["runuser", { valueFlags: new Set(["-u", "-c", "-s"]) }],
  ["chroot", { valueFlags: new Set(["--userspec", "--groups"]), operands: 1 }],
  ["strace", { valueFlags: new Set(["-o", "-e", "-p", "-s"]) }],
  ["ltrace", { valueFlags: new Set(["-o", "-e", "-p", "-s"]) }],
  ["watch", { valueFlags: new Set(["-n", "--interval", "-d"]) }],
  ["flock", { valueFlags: new Set(["-w", "--timeout", "-E"]), operands: 1 }],
  ["script", { valueFlags: new Set(["-c", "--command", "-f", "-t"]) }],
  ["taskset", { valueFlags: new Set(["-c", "-p"]), operands: 1 }],
  [
    "unshare",
    { valueFlags: new Set(["--map-user", "--map-group", "-S", "-G"]) },
  ],
  ["busybox", { operands: 1 }],
  ["proot", { valueFlags: new Set(["-r", "-b", "-w"]) }],
]);

/** Bounded wrapper peel: the command a chain of exec-wrappers ends up running,
 *  or null when the head was not a wrapper. */
function peelExecWrappers(tokens: readonly string[]): string[] | null {
  let cur: readonly string[] = tokens;
  let peeled = false;
  for (let round = 0; round < 4 && cur.length > 0; round += 1) {
    const spec = EXEC_WRAPPERS.get(interpreterName(cur[0] as string));
    if (spec === undefined) break;
    let i = 1;
    let operands = spec.operands ?? 0;
    while (i < cur.length) {
      const t = cur[i] as string;
      if (t === "--") {
        i += 1;
        break;
      }
      if (t.startsWith("-") && t.length > 1) {
        i += 1;
        if (spec.valueFlags?.has(t) === true && i < cur.length) i += 1;
        continue;
      }
      if (spec.assignments === true && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        i += 1;
        continue;
      }
      if (operands > 0) {
        operands -= 1;
        i += 1;
        continue;
      }
      break;
    }
    if (i >= cur.length) break; // wrapper with no command behind it
    cur = cur.slice(i);
    peeled = true;
  }
  return peeled ? [...cur] : null;
}

/** A variable whose NAME says it holds a location, so `ls $HOME` is a path
 *  claim even without a separator — unlike `sed -n $p`. */
const PATHISH_VAR =
  /\$\{?(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PWD|OLDPWD|TMP|TEMP|TMPDIR|XDG_[A-Z_]+|SystemRoot|windir|ProgramData|ProgramFiles[A-Za-z()0-9]*)\}?/i;

/** Escape-hatch guard for allow-listed read-only commands: their ARGUMENTS
 *  took no path check at all, so absolute/parent-escaping paths and
 *  credential files rode the auto-allow. Returns an `ask` verdict when an
 *  arg looks like it leaves the workspace or names credential material
 *  (via the shared credential denylist — same set read_file enforces,
 *  now segment-aware so `cat .ssh/config` is caught); null → the caller's
 *  allow stands. Deliberately shallow (no fs access — the classifier is
 *  synchronous and cwd-relative args stay allowed). The fs-based half — an
 *  innocent-basename symlink whose realpath leaves the repo — is caught by
 *  the async checkReaderArgvPaths (reader-guard.ts) in the rule/tool, which
 *  the classifier structurally cannot see (audit T3.4). */
function readerArgvGuard(
  argv: readonly string[],
  live = false,
): Verdict | null {
  for (const raw of argv.slice(1)) {
    // A path GLUED to an option is still a path. Skipping every `-`-prefixed
    // token wholesale meant `wc --files0-from=/…/.ssh/id_rsa`,
    // `grep -f/…/id_rsa .`, `pytest --basetemp=/outside`, `go test -o=/…` and
    // `node --test --redirect-warnings=/…` all read as inert flags (red team
    // round 3). Unglue the value and judge THAT; a flag with no path-shaped
    // value is still skipped.
    let a = raw;
    if (raw.startsWith("-")) {
      const eq = raw.indexOf("=");
      const value =
        eq > 0
          ? raw.slice(eq + 1)
          : /^-[A-Za-z]/.test(raw) && raw.length > 2
            ? raw.slice(2)
            : "";
      if (value.length === 0 || !/[\\/~]|^\.{1,2}$|^\$/.test(value)) continue;
      a = value;
    }
    // Windows-style switches (`tasklist //FI …`, `where /R …`) are flags, not
    // absolute paths. UPPERCASE only: the first spelling of this rule accepted
    // any letters and so swallowed `ls //etc`, which is the very thing the
    // comment claimed it would not do.
    if (/^\/\/[A-Z]+$|^\/[A-Z]$/.test(a)) continue;
    // Match a Windows drive prefix WITH OR WITHOUT a separator: `E:.env` is
    // DRIVE-RELATIVE (resolves against drive E's cwd, i.e. the workspace) yet
    // has no separator, so it slipped the old `X:[\/]` form and read a
    // workspace credential unprompted (audit T3.4 review).
    const absolute = /^([A-Za-z]:|[\\/]|~)/.test(a);
    const parentEscape = a === ".." || a.includes("../") || a.includes("..\\");
    // An operand the guard cannot evaluate is not an operand the guard may
    // pass (red team 2026-08-24). Each spelling below read as an ordinary
    // in-workspace relative path and defeated both this check and the async
    // realpath half, which skips operands that do not resolve.
    //
    // Scoped to tokens that can actually BE a path: a bare `$p` is a sed
    // script and `^第[0-9]*篇` is a grep pattern, and treating those as paths
    // made six honest commands ask. So a variable counts only with a path
    // separator or a path-ish name, and a plain glob is left to the credential
    // denylist (which knows `.env*` from `*.ts`) rather than asked about here.
    const unknowable =
      a.includes("__SUBST__") ||
      (live && /[$`]/.test(a) && (/[\\/]/.test(a) || PATHISH_VAR.test(a))) ||
      (/\{[^}]*,[^}]*\}/.test(a) && /[\\/]|\.\./.test(a));
    if (absolute || parentEscape || unknowable || isCredentialPath(a)) {
      return {
        kind: "ask",
        risk: "workspace_read",
        code: "command_ask_reader_path",
        reason: unknowable
          ? `read-only command targets a path the harness cannot resolve statically: ${a}`
          : `read-only command targets a sensitive or out-of-workspace path: ${a}`,
      };
    }
  }
  return null;
}

/** Allow-listed readers that take FILE-PATH operands (content or listing
 *  disclosure). Excludes echo/pwd/date/whoami/true/false, whose args are not
 *  read targets — realpath-checking them would false-deny e.g.
 *  `echo /etc/hostname`. Consumed by readerPathCandidates. */
const PATH_READER_CMDS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "diff",
  "od",
  "hexdump",
  "xxd",
  "file",
  "stat",
  "du",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "tac",
  "rev",
  "paste",
  "comm",
  "grep",
  "rg",
  "ripgrep",
  "find",
  // Text filters (textFilterVerdict): their non-flag operands that EXIST
  // are files (a sed script / sort key / cut list resolves to nothing and
  // is skipped by the existing-file check).
  "sort",
  "uniq",
  "cut",
  "nl",
  "sed",
]);

/** The non-flag path operands of a file-reading allow-listed command, or null
 *  when argv[0] is not such a command. The async reader guard realpaths each
 *  candidate that ACTUALLY EXISTS and denies any whose real target leaves the
 *  workspace or names credential material — so grep/find PATTERN operands
 *  (which don't resolve to files) are skipped and never cause a false deny.
 *  Tokens after `--` are operands even if they start with `-`. */
export function readerPathCandidates(argv: readonly string[]): string[] | null {
  const a0 = argv[0];
  if (typeof a0 !== "string" || !PATH_READER_CMDS.has(a0)) return null;
  const out: string[] = [];
  let afterDashDash = false;
  for (const a of argv.slice(1)) {
    if (afterDashDash) {
      out.push(a);
      continue;
    }
    if (a === "--") {
      afterDashDash = true;
      continue;
    }
    if (a.startsWith("-")) continue; // flags (and unparseable flag-values)
    out.push(a);
  }
  return out;
}

/** 2026-07-10 audit (finding 2a): `grep -r PATTERN .` rode the reader
 *  auto-allow — readerArgvGuard checks only argv PATHS, and `.` is neither
 *  absolute nor parent-escaping — then grep recursed into `.env` itself,
 *  composing with the redactor's gaps into a zero-prompt credential exfil
 *  chain. A recursive content read can't be path-guarded synchronously (the
 *  classifier does no fs access), so it prompts instead; `search_text` is
 *  the sanctioned recursive reader (per-file denylist + redaction). Plain rg
 *  stays allowed — its defaults skip hidden and ignored files — but flags
 *  that defeat those filters prompt. `find` discloses names, not contents,
 *  and keeps its existing guard. */
function recursiveContentRead(argv: readonly string[]): Verdict | null {
  const a0 = argv[0] as string;
  let hit = false;
  if (a0 === "grep") {
    let prev = "";
    for (const a of argv.slice(1)) {
      if (
        a === "--recursive" ||
        a === "--dereference-recursive" ||
        a === "--directories=recurse" ||
        (prev === "-d" && a === "recurse") ||
        /^-[A-Za-z]*[rR][A-Za-z]*$/.test(a)
      ) {
        hit = true;
        break;
      }
      prev = a;
    }
  } else if (a0 === "rg" || a0 === "ripgrep") {
    for (const a of argv.slice(1)) {
      if (
        a === "--hidden" ||
        a === "--unrestricted" ||
        a === "--binary" ||
        a.startsWith("--no-ignore") ||
        // `-L`/`--follow` defeat ripgrep's default of NOT following symlinks,
        // so recursion escapes the repo through an in-workspace directory
        // symlink — the operand-only reader guard never sees those
        // transitively-discovered files (audit T3.4 review). `[uL]` also
        // catches bundled `-Ln`/`-nL`.
        a === "--follow" ||
        /^-[a-zA-Z]*[uL][a-zA-Z]*$/.test(a)
      ) {
        hit = true;
        break;
      }
    }
  }
  if (!hit) return null;
  return {
    kind: "ask",
    risk: "workspace_read",
    code: "command_ask_recursive_read",
    reason: `${a0} recursive/unfiltered content read bypasses the credential denylist — prefer search_text`,
  };
}

/** Print-only sed scripts: a line/range print — `10,25p`, `5p`, `$p`,
 *  `3,$p` — exactly the idiom the bash tool's description suggests. Any
 *  other script (`s///`, `d`, `w file`, `e cmd`, …) is not classified here. */
const SED_PRINT_SCRIPT = /^\s*(\d+|\$)?(\s*,\s*(\d+|\$))?\s*p\s*$/;
const SED_READ_FLAGS = new Set([
  "-n",
  "--quiet",
  "--silent",
  "-E",
  "-r",
  "--regexp-extended",
  "-s",
  "--separate",
  "-u",
  "--unbuffered",
  "-z",
  "--null-data",
  "--posix",
]);

/**
 * Pure text filters (2026-08-17, minimal contract follow-up). The bash
 * model composes pipelines — `find src -type f | sort`, `git log | head`,
 * `sed -n 10,25p file` (the tool's own description suggests that idiom) —
 * and every `sort` / `sed` segment prompted as "unrecognized command", so
 * the 极简 mode asked several times per brief for reads the standard
 * contract's tools do silently. These read stdin/files and print. The
 * shapes that WRITE or EXECUTE stay on the ask path: `sort -o`/`--output`,
 * `sort --compress-program`, `uniq IN OUT` (a second operand is the
 * output), `sed -i`, `sed -f`, sed scripts other than a line-range print
 * (`w`/`e` commands, `s///w`). Returns null when argv[0] is not one of
 * these, or when the shape is not the read-only one — the caller's later
 * phases (the generic ask) then apply.
 */
function textFilterVerdict(
  argv: readonly string[],
  live = false,
): Verdict | null {
  const a0 = argv[0] as string;
  const writeAsk = (reason: string): Verdict => ({
    kind: "ask",
    risk: "workspace_write",
    code: "command_ask_write",
    reason,
  });
  if (a0 === "sort") {
    for (const a of argv.slice(1)) {
      if (a === "--output" || a.startsWith("--output=")) {
        return writeAsk("sort --output writes a file");
      }
      if (a.startsWith("--compress-program")) {
        return writeAsk("sort --compress-program runs a program");
      }
      // Bundled short flags: `-o FILE`, `-uo FILE`, `-oFILE`.
      if (/^-[a-zA-Z]*o/.test(a)) return writeAsk("sort -o writes a file");
    }
    return readerArgvGuard(argv, live) ?? { kind: "allow" };
  }
  if (a0 === "uniq") {
    let operands = 0;
    for (const a of argv.slice(1)) if (!a.startsWith("-")) operands += 1;
    if (operands >= 2) return writeAsk("uniq with an OUTPUT operand");
    return readerArgvGuard(argv, live) ?? { kind: "allow" };
  }
  if (a0 === "cut" || a0 === "tr" || a0 === "nl") {
    return readerArgvGuard(argv, live) ?? { kind: "allow" };
  }
  if (a0 === "sed") {
    const scripts: string[] = [];
    for (let i = 1; i < argv.length; i += 1) {
      const a = argv[i] as string;
      if (SED_READ_FLAGS.has(a)) continue;
      if (a === "-e" || a === "--expression") {
        const s = argv[i + 1];
        if (s === undefined) return null;
        scripts.push(s);
        i += 1;
        continue;
      }
      if (a.startsWith("--expression=")) {
        scripts.push(a.slice("--expression=".length));
        continue;
      }
      if (a === "--") break; // the rest are file operands
      // -i / --in-place / -f / -ne bundles / anything else: not the read
      // shape — the generic ask stays.
      if (a.startsWith("-")) return null;
      if (scripts.length === 0) scripts.push(a);
      // later operands are files (guarded below)
    }
    if (scripts.length === 0) return null;
    if (!scripts.every((s) => SED_PRINT_SCRIPT.test(s))) return null;
    return readerArgvGuard(argv, live) ?? { kind: "allow" };
  }
  return null;
}

const SH_FAMILY = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Not shells themselves, but they hand a shell command string to one. */
const COMMAND_STRING_WRAPPERS = new Set(["su", "runuser", "script"]);
const POWERSHELL_FAMILY = new Set(["powershell", "pwsh"]);

/** Deletion commands Windows shells reach for; `Remove-Item -Recurse -Force
 *  C:\` is `rm -rf /` in a different coat. `ri` is the PowerShell alias. */
const WINDOWS_DELETE_CMDS = new Set([
  "remove-item",
  "ri",
  "rd",
  "rmdir",
  "del",
  "erase",
]);

/** Normalize an interpreter argv[0]: basename, lowercase, `.exe` stripped —
 *  `C:\Windows\System32\cmd.exe` and `CMD` both classify as `cmd`. */
function interpreterName(a0: string): string {
  const base = a0.split(/[\\/]/).pop() ?? a0;
  return base.toLowerCase().replace(/\.exe$/, "");
}

type Reentry =
  | { kind: "body"; via: string; body: string }
  | { kind: "refused"; via: string; reason: string };

/** 2026-07-10 audit (finding 3): shell re-entry matched ONLY `sh`/`bash`
 *  with argv[1] === "-c" exactly, so wrapping a catastrophic command in
 *  `cmd /c`, `powershell -Command`, `bash -lc`, or an -EncodedCommand
 *  payload downgraded the no-override BLOCK tier to a user-approvable ASK.
 *  This extracts the inner command for any known interpreter so the block
 *  check can re-enter it. Extraction only ever ESCALATES to block — a benign
 *  body never upgrades the wrapper to allow (shell chaining inside the body
 *  is exactly what the argv contract exists to avoid). */
function extractShellReentry(argv: readonly string[]): Reentry | null {
  if (argv.length === 0) return null;
  const name = interpreterName(argv[0] as string);

  if (SH_FAMILY.has(name)) {
    // POSIX shells bundle short options (`-lc`, `-xec`); the command string
    // is the first operand after the option group when any bundle had `c`.
    let sawC = false;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i] as string;
      if (a === "--") continue;
      // A shell also takes its script on STDIN, and `<<<` puts a string
      // there: `bash <<< 'rm -rf /'` runs exactly what `bash -c` would, and
      // recognising only `-c` let it through as a plain ask (red team round 3).
      if (a === "<<<") {
        const body = argv[i + 1];
        return typeof body === "string" && body.length > 0
          ? { kind: "body", via: `${name} <<<`, body }
          : null;
      }
      if (/^-[A-Za-z]+$/.test(a)) {
        if (a.includes("c")) sawC = true;
        continue;
      }
      return sawC ? { kind: "body", via: `${name} -c`, body: a } : null;
    }
    return null;
  }

  // Wrappers that take their payload as the VALUE of `-c` rather than as
  // following operands, so the operand-style peel cannot reach it:
  // `su -c 'rm -rf /'`, `runuser -u root -c '…'`, `script -qec '…' /dev/null`.
  if (COMMAND_STRING_WRAPPERS.has(name)) {
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i] as string;
      if (a === "-c" || a === "--command") {
        const body = argv[i + 1];
        return typeof body === "string" && body.length > 0
          ? { kind: "body", via: `${name} -c`, body }
          : null;
      }
      // Bundled short options (`-qec`) and an attached value (`-c'…'`).
      if (/^-[A-Za-z]+$/.test(a) && a.includes("c")) {
        const body = argv[i + 1];
        return typeof body === "string" && body.length > 0
          ? { kind: "body", via: `${name} -c`, body }
          : null;
      }
    }
    return null;
  }

  if (name === "cmd") {
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i] as string;
      // `//c` is how a bash on Windows passes `/c` past its path conversion
      // — and how 板砖 spells it. Matching `/c` alone left the body unread,
      // so `cmd //c "rd /s /q C:\"` asked where `cmd /c` blocked (ADR 0075
      // step 1, 2026-10-09).
      if (/^(?:\/\/?|-)[ckCK]$/.test(a)) {
        return {
          kind: "body",
          via: "cmd /c",
          body: argv.slice(i + 1).join(" "),
        };
      }
    }
    return null;
  }

  if (POWERSHELL_FAMILY.has(name)) {
    for (let i = 1; i < argv.length; i++) {
      const raw = argv[i] as string;
      // `-Command`, `/Command`, and the MSYS spelling `//Command`.
      const m = /^(?:-|\/\/?)([A-Za-z]+)$/.exec(raw);
      if (m === null) continue;
      const flag = (m[1] as string).toLowerCase();
      // PowerShell accepts any unambiguous parameter PREFIX (`-c`, `-com`,
      // `-enc`, …) — match by prefix, not by exact spelling.
      if ("encodedcommand".startsWith(flag)) {
        const b64 = argv[i + 1];
        if (typeof b64 !== "string" || b64.length === 0) {
          return {
            kind: "refused",
            via: name,
            reason: `${name} -EncodedCommand without a payload`,
          };
        }
        // PowerShell encodes the command as base64 over UTF-16LE.
        // Buffer.from(_, "base64") never throws (invalid input is silently
        // skipped), so gate on the decode LOOKING like a command: an empty
        // or control-character-ridden decode is an opaque payload — refuse
        // it rather than classify garbage.
        const decoded = Buffer.from(b64, "base64").toString("utf16le");
        const looksBinary = Array.from(decoded).some((ch) => {
          const c = ch.charCodeAt(0);
          return c < 32 && c !== 9 && c !== 10 && c !== 13;
        });
        if (decoded.trim().length === 0 || looksBinary) {
          return {
            kind: "refused",
            via: name,
            reason: `${name} -EncodedCommand payload does not decode to a command`,
          };
        }
        return {
          kind: "body",
          via: `${name} -EncodedCommand`,
          body: decoded,
        };
      }
      if ("command".startsWith(flag)) {
        return {
          kind: "body",
          via: `${name} -Command`,
          body: argv.slice(i + 1).join(" "),
        };
      }
    }
    return null;
  }

  return null;
}

/**
 * The command's IDENTITY for the block / destructive tiers: basename,
 * lowercased, `.exe` stripped — the same normalization `interpreterName`
 * applies to shell re-entry.
 *
 * Audit 2026-08-05 (BL1): these branches used to compare the RAW argv[0],
 * some of them case-sensitively, so the tier depended on spelling —
 * `shutdown` blocked but `/sbin/shutdown` did not, and `rm` blocked but
 * `/bin/rm` and `RM` did not. The misses landed on `command_ask_unknown`,
 * which (unlike `command_ask_destructive`) is BOTH cacheable and
 * rule-eligible, so a path-qualified spelling was weaker in two tiers at
 * once.
 *
 * Deliberately NOT used by the Phase 5 ALLOW list: normalizing there would
 * make a planted `/tmp/evil/git` match the read-only allow tier. Allow must
 * keep matching the raw argv[0]; only the refusing tiers normalize.
 */
function commandIdentity(a0: string): string {
  return interpreterName(a0);
}

function isCatastrophic(argv: readonly string[]): {
  hit: boolean;
  reason: string;
} {
  if (argv.length === 0) return { hit: false, reason: "" };
  const raw = argv[0] as string;
  // `a0` is the normalized identity everywhere below; `raw` is kept only for
  // the human-readable reason strings.
  const a0 = commandIdentity(raw);

  // `find <system root> -delete` empties the machine just as `rm -rf /` does,
  // and dispatching this tier on argv[0] alone meant it arrived as an ordinary
  // approval card — one click from the same outcome (red team 2026-08-24).
  // The repo already accepts this equivalence: WINDOWS_DELETE_CMDS exists
  // because `Remove-Item -Recurse -Force C:\` is `rm -rf /` in another coat.
  if (a0 === "find") {
    const destructive = argv.some(
      (a) => a === "-delete" || a === "-exec" || a === "-execdir",
    );
    if (destructive) {
      for (const a of argv.slice(1)) {
        if (a.startsWith("-")) continue;
        if (isSystemRootPath(a)) {
          return {
            hit: true,
            reason: `find with a delete/exec action on system path: ${a}`,
          };
        }
      }
    }
  }

  if (a0 === "rm" && hasRecursiveForce(argv)) {
    for (const a of argv.slice(1)) {
      if (isSystemRootPath(a)) {
        return { hit: true, reason: `rm -rf on system path: ${a}` };
      }
    }
  }
  if (WINDOWS_DELETE_CMDS.has(a0)) {
    for (const a of argv.slice(1)) {
      if (isSystemRootPath(a)) {
        return { hit: true, reason: `${raw} on system path: ${a}` };
      }
    }
  }
  if (a0.startsWith("mkfs")) {
    return { hit: true, reason: `mkfs variant: ${raw}` };
  }
  if (a0 === "format" && /^[A-Za-z]:$/.test(argv[1] ?? "")) {
    return { hit: true, reason: `volume format: ${argv[1]}` };
  }
  if (a0 === "dd") {
    for (const a of argv) {
      if (typeof a === "string" && a.startsWith("of=/dev/")) {
        return { hit: true, reason: `dd write to raw device: ${a}` };
      }
    }
  }
  if (
    a0 === "shutdown" ||
    a0 === "reboot" ||
    a0 === "halt" ||
    a0 === "poweroff" ||
    a0 === "stop-computer" ||
    a0 === "restart-computer"
  ) {
    return { hit: true, reason: `system control: ${raw}` };
  }
  if (a0 === "init" && (argv[1] === "0" || argv[1] === "6")) {
    return { hit: true, reason: `init runlevel: ${argv[1]}` };
  }
  const posix = posixCatastrophe(a0, argv);
  if (posix !== null) return { hit: true, reason: posix };
  return { hit: false, reason: "" };
}

/** `diskutil` verbs that destroy data or a partition map. Lowercased. */
const DISKUTIL_DESTROY = new Set([
  "erasedisk",
  "erasevolume",
  "zerodisk",
  "randomdisk",
  "secureerase",
  "partitiondisk",
  "splitpartition",
  "mergepartitions",
  "reformat",
]);
/** `diskutil apfs …` verbs that destroy a container or volume. */
const DISKUTIL_APFS_DESTROY = new Set([
  "deletecontainer",
  "deletevolume",
  "deletevolumegroup",
  "erasevolume",
]);

/**
 * Where a program's SUBCOMMAND sits, past the options it takes in front of it:
 * `security [-hilqv] [-p prompt] <command>` and `diskutil [quiet] <verb>`.
 * Reading `args[0]` let `security -q dump-keychain` and `diskutil quiet
 * eraseDisk …` out of the block tier (probe 2026-09-23).
 */
function subcommandAt(id: string, args: readonly string[]): number {
  let i = 0;
  if (id === "security") {
    while (i < args.length) {
      const t = args[i] as string;
      if (t === "--") return i + 1;
      if (!t.startsWith("-")) break;
      // `-p` takes the prompt as the next word, clustered or not (`-qp x`).
      i += /^-[A-Za-z]*p$/.test(t) ? 2 : 1;
    }
  } else if (id === "diskutil" && (args[0] ?? "").toLowerCase() === "quiet") {
    i = 1;
  }
  return i;
}
/** `systemctl` / `loginctl` verbs that stop or restart the machine. */
const POWER_VERBS = new Set(["poweroff", "reboot", "halt", "kexec"]);
/** `systemctl` / `loginctl` options that take the NEXT word as their value —
 *  only those whose value is required, so a flag is never mistaken for one
 *  and allowed to hide the verb behind it. */
const SYSTEMCTL_VALUE_OPTS = new Set([
  "-t",
  "--type",
  "-p",
  "--property",
  "-P",
  "-H",
  "--host",
  "-M",
  "--machine",
  "-n",
  "--lines",
  "-o",
  "--output",
  "-s",
  "--signal",
  "--state",
  "--root",
  "--image",
  "--kill-whom",
  "--kill-value",
  "--job-mode",
  "--what",
  "--timestamp",
  "--message",
  "--when",
  "--boot-loader-entry",
  "--boot-loader-menu",
  "--reboot-argument",
  "--check-inhibitors",
  "--preset-mode",
  "--drop-in",
]);

/**
 * The verb: the first word that is neither an option nor an option's value,
 * lowercased (review 2026-09-23). Taking any argument as the verb blocked
 * `systemctl status reboot` and a heredoc line of prose; taking the first
 * non-dash word read `systemctl -t service …`'s `service` as the verb.
 */
function firstOperand(
  args: readonly string[],
  valueOpts: ReadonlySet<string>,
): string {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--") return (args[i + 1] ?? "").toLowerCase();
    if (a.startsWith("-") && a.length > 1) {
      if (valueOpts.has(a)) i += 1;
      continue;
    }
    return a.toLowerCase();
  }
  return "";
}

/**
 * The macOS and Linux members of the block tier (platform review 2026-09-23).
 * The tier named `mkfs`, `dd of=/dev/…` and `shutdown`, and everything below
 * fell through to `command_ask_unknown` — an ordinary, cacheable,
 * rule-eligible approval card, one click from an erased disk or a leaked
 * keychain. CLAUDE.md's Block list ("mkfs, raw block-device writes …,
 * credential exfiltration, shutdown/reboot") is the policy; these are its
 * spellings on the other two platforms:
 *
 *   - disk destruction: `diskutil erase*|zeroDisk|partitionDisk…` and its
 *     `apfs delete*`, `newfs_*` (macOS's mkfs), and on a `/dev/` device:
 *     `wipefs` that erases, `blkdiscard`, `sgdisk --zap*`, `shred`;
 *   - power: `systemctl|loginctl poweroff|reboot|halt|kexec` as the verb;
 *   - keychain secrets: `security find-*-password -w|-g` (prints the
 *     password), `security dump-keychain`, `security export` (exports keys).
 */
function posixCatastrophe(a0: string, argv: readonly string[]): string | null {
  const args = argv.slice(1);
  const at = subcommandAt(a0, args);
  const sub = (args[at] ?? "").toLowerCase();
  if (a0 === "diskutil") {
    if (DISKUTIL_DESTROY.has(sub)) return `diskutil ${args[at]}: erases a disk`;
    if (
      sub === "apfs" &&
      DISKUTIL_APFS_DESTROY.has((args[at + 1] ?? "").toLowerCase())
    ) {
      return `diskutil apfs ${args[at + 1]}: deletes a container or volume`;
    }
  }
  if (a0.startsWith("newfs")) return `newfs variant: ${argv[0]}`;
  // The block-device tools block on a DEVICE, as `dd of=/dev/…` and `shred`
  // always did: `wipefs -a build/disk.img` and `sgdisk --zap-all disk.img`
  // are routine in an image-build repo (review 2026-09-23) and stay asks.
  const onDevice = args.some((a) => a.startsWith("/dev/"));
  if (a0 === "wipefs" && onDevice) {
    // `wipefs /dev/x` alone only LISTS signatures; -a / -o erase them — unless
    // `-n` / `--no-act` makes the whole run a dry run.
    const short = (letters: RegExp): boolean =>
      args.some((a) => /^-[A-Za-z]+$/.test(a) && letters.test(a));
    const erases =
      args.some(
        (a) => a === "--all" || a === "--offset" || a.startsWith("--offset="),
      ) || short(/[ao]/);
    const dryRun = args.includes("--no-act") || short(/n/);
    if (erases && !dryRun) return "wipefs erasing filesystem signatures";
  }
  if (a0 === "blkdiscard" && onDevice) {
    return "blkdiscard discards every block on a device";
  }
  if (
    a0 === "sgdisk" &&
    onDevice &&
    args.some(
      (a) =>
        a === "--zap" ||
        a === "--zap-all" ||
        (/^-[A-Za-z]+$/.test(a) && /[zZ]/.test(a)),
    )
  ) {
    return "sgdisk --zap destroys a partition table";
  }
  if (a0 === "shred" && onDevice) return "shred on a raw device";
  if (a0 === "systemctl" || a0 === "loginctl") {
    const verb = firstOperand(args, SYSTEMCTL_VALUE_OPTS);
    if (POWER_VERBS.has(verb)) return `system control: ${a0} ${verb}`;
  }
  if (a0 === "security") {
    if (
      (sub === "find-generic-password" || sub === "find-internet-password") &&
      args.some(
        (a) => a === "-w" || a === "-g" || /^-[A-Za-z]*[wg][A-Za-z]*$/.test(a),
      )
    ) {
      return `security ${args[at]} prints a keychain password`;
    }
    if (sub === "dump-keychain") return "security dump-keychain";
    if (sub === "export") return "security export writes keychain items out";
  }
  return null;
}

/**
 * Split a shell body into its individual commands on `;`, `&&`, `||`, `|`,
 * `&` and newlines — WITHOUT splitting inside quotes.
 *
 * Audit 2026-08-05 (S4): `classifyShellBody` whitespace-tokenized the whole
 * body and checked it once, and every catastrophic branch keys on the FIRST
 * token — so `bash -c "cd /tmp && rm -rf /"` traced to a plain ask. That is a
 * BLOCK→ASK downgrade of the no-override tier, the same class as the
 * 2026-07-10 finding 3, moved from the wrapper to the body separator.
 *
 * Splitting the TOKEN stream does not work: `cd /tmp;rm -rf /` tokenizes to
 * the glued `/tmp;rm`, so the separator has to be found in the raw string
 * with no whitespace requirement. Quote tracking is what keeps
 * `echo "a; shutdown"` from being blocked — the block tier has no override,
 * so a false positive there is a hard failure with no way past it.
 */
export function splitShellSegments(body: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  // A backslash-newline is a LINE CONTINUATION — bash joins the two halves
  // into one command. Splitting on the newline regardless meant
  // `rm \<newline>-rf /` was scanned as two harmless fragments and the
  // catastrophic check never saw a whole command (red team round 3).
  const joined = body.replace(/\\\r?\n/g, " ");
  for (let i = 0; i < joined.length; i += 1) {
    const ch = joined[i] as string;
    const prev = i > 0 ? joined[i - 1] : "";
    if (quote !== null) {
      current += ch;
      // A backslash-escaped quote does not close the string (POSIX single
      // quotes take no escapes, but treating them alike only ever keeps the
      // segment together, which is the safe direction here).
      if (ch === quote && prev !== "\\") quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && prev !== "\\") {
      quote = ch;
      current += ch;
      continue;
    }
    // `>|` is the clobber redirect, not a pipe. Cut here, its target became
    // the second "program" of a pipeline — `echo x >| .herta/permissions.json`
    // classified as running a workspace program, past every write guard
    // (review 2026-09-30).
    if (ch === "|" && prev === ">") {
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * git's own options, which come BEFORE the subcommand. The ones listed here
 * take their value as a SEPARATE argument, so locating the subcommand means
 * stepping over two tokens, not one. (`--git-dir=x` and friends carry their
 * value inline and need no entry.)
 */
const GIT_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--exec-path",
  "--config-env",
  "--attr-source",
]);

/**
 * Where the subcommand actually is — `git -C sub reset --hard` puts it at 3,
 * not 1.
 *
 * Every destructive check used to read `argv[1]`, so one leading global option
 * hid the subcommand from all of them at once and `git -C subdir clean -fd`
 * classified as an ordinary repository change. `-C` is exactly how an agent
 * works on a sub-repository, so this was not a corner.
 *
 * Returns null when there is no subcommand at all (`git --version`).
 */
function gitSubcommandIndex(argv: readonly string[]): number | null {
  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (typeof a !== "string") return null;
    if (!a.startsWith("-")) return i;
    i += GIT_GLOBAL_VALUE_FLAGS.has(a) ? 2 : 1;
  }
  return null;
}

/**
 * True when a short-option CLUSTER carries `letter` — `-fd`, `-fdx`, `-df` all
 * carry `f`.
 *
 * Exact-token matching is why `git clean -f` was caught and `git clean -fd` was
 * not, which is precisely backwards: bare `-f` will not remove a directory, so
 * the spelling the harness recognised is the one nobody types. Case matters —
 * `git branch -m` renames, `-M` force-renames.
 */
function hasShortFlag(args: readonly string[], letter: string): boolean {
  return args.some(
    (a) =>
      a.length > 1 &&
      a.startsWith("-") &&
      !a.startsWith("--") &&
      /^-[A-Za-z]+$/.test(a) &&
      a.includes(letter),
  );
}

/** `systemctl` verbs that only look. */
const SYSTEMCTL_READ = new Set([
  "status",
  "show",
  "cat",
  "help",
  "list-units",
  "list-unit-files",
  "list-timers",
  "list-sockets",
  "list-dependencies",
  "list-jobs",
  "is-active",
  "is-enabled",
  "is-failed",
  "is-system-running",
  "get-default",
  "show-environment",
  "list-machines",
  "list-paths",
  "list-automounts",
]);
/** `systemctl --user` verbs that run, stop or reload the user's OWN services
 *  — everyday dev on Linux, left an ordinary ask (review 2026-09-23).
 *  Enabling, masking, editing or linking a unit is autostart and persistence,
 *  and stays a system change even under `--user`. */
const SYSTEMCTL_USER_RUN = new Set([
  "start",
  "stop",
  "restart",
  "reload",
  "try-restart",
  "reload-or-restart",
  "try-reload-or-restart",
  "kill",
  "reset-failed",
  "daemon-reload",
]);
/** `launchctl` subcommands that only look. */
const LAUNCHCTL_READ = new Set([
  "list",
  "print",
  "print-cache",
  "print-disabled",
  "version",
  "help",
  "blame",
  "getenv",
  "error",
  "managerpid",
  "manageruid",
  "managername",
  "procinfo",
  "hostinfo",
]);
/** `security` subcommands that only look. The password lookups are here
 *  because the secret-printing forms (`-w` / `-g`) never get this far — they
 *  are blocked in `posixCatastrophe`; what remains prints metadata. */
const SECURITY_READ = new Set([
  "find-certificate",
  "find-identity",
  "find-key",
  "find-generic-password",
  "find-internet-password",
  "list-keychains",
  "list-smartcards",
  "show-keychain-info",
  "verify-cert",
  "dump-trust-settings",
  "help",
]);

/** Whether a `security` subcommand only looks (review 2026-09-23). */
function securityOnlyLooks(sub: string, rest: readonly string[]): boolean {
  if (SECURITY_READ.has(sub)) return true;
  // `default-keychain` / `login-keychain` PRINT unless `-s` sets one.
  if (sub === "default-keychain" || sub === "login-keychain") {
    return !rest.some((a) => /^-[A-Za-z]*s[A-Za-z]*$/.test(a));
  }
  // `security cms -D -i x.mobileprovision` decodes a provisioning profile —
  // the standard iOS step. Signing or encrypting uses a keychain identity.
  if (sub === "cms") {
    return rest.includes("-D") && !rest.some((a) => /^-[SEC]$/.test(a));
  }
  if (sub === "authorizationdb") return (rest[0] ?? "") === "read";
  return false;
}
/** `defaults` options that take the next word as their value. */
const DEFAULTS_VALUE_OPTS = new Set(["-host"]);
/** `spctl` flags that change Gatekeeper's policy. */
const SPCTL_WRITE = new Set([
  "--master-disable",
  "--master-enable",
  "--global-disable",
  "--global-enable",
  "--add",
  "--remove",
  "--enable",
  "--disable",
  "--reset-default",
]);

/**
 * Commands that change the MACHINE rather than the workspace — Gatekeeper,
 * launch agents, the keychain, cron, other apps (platform review 2026-09-23).
 * They landed on `command_ask_unknown`, which is cacheable and rule-eligible:
 * the task cache keys on the PROGRAM, so approving a harmless `defaults read`
 * waved every later `defaults write` in that brief through with no card, and
 * one "always allow" on a `defaults write` saved `defaults write:*`, which
 * covered every domain for good. Their own class
 * (`command_ask_system`, danger styling) is asked every time — it is absent
 * from RULE_ELIGIBLE_ASK_CODES, and the session cache only keeps
 * `workspace_write`. `osascript` in particular can type into and drive any
 * app the user has granted automation, including a keychain prompt.
 *
 * The look-only forms (`defaults read`, `crontab -l`, `spctl --status`,
 * `systemctl status`, `security find-certificate`, `xattr -l`) stay where
 * they were. Returns the card's reason, or null.
 */
function systemAlteringShape(
  id: string,
  argv: readonly string[],
): string | null {
  const args = argv.slice(1);
  const verb = (args.find((a) => !a.startsWith("-")) ?? "").toLowerCase();
  const cluster = (letters: RegExp): boolean =>
    args.some((a) => /^-[A-Za-z]+$/.test(a) && letters.test(a));
  switch (id) {
    case "osascript":
      return "osascript drives other apps (AppleScript / JXA)";
    case "tccutil":
      return "tccutil resets privacy permissions";
    case "csrutil":
      return verb === "status" ? null : `csrutil ${verb || args.join(" ")}`;
    case "launchctl":
      return LAUNCHCTL_READ.has(verb) ? null : `launchctl ${args.join(" ")}`;
    case "defaults": {
      // `defaults -host <name> write …`: the host is not the verb.
      const v = firstOperand(args, DEFAULTS_VALUE_OPTS);
      return v === "write" || v === "delete" || v === "import" || v === "rename"
        ? `defaults ${v} changes app or system preferences`
        : null;
    }
    case "crontab": {
      // `crontab -l` (optionally `-u <user>`) only lists. Anything else —
      // -e, -r, -i, a file operand, or bare `crontab` reading stdin —
      // replaces the table.
      const rest = args.filter(
        (a, i) => a !== "-l" && a !== "-u" && args[i - 1] !== "-u",
      );
      return args.includes("-l") && rest.length === 0
        ? null
        : `crontab ${args.join(" ")}`.trim();
    }
    case "spctl":
      return args.some((a) => SPCTL_WRITE.has(a))
        ? `spctl ${args.join(" ")} changes Gatekeeper policy`
        : null;
    case "xattr":
      return cluster(/[dcw]/)
        ? `xattr ${args.join(" ")} (e.g. removing the quarantine flag)`
        : null;
    case "systemctl": {
      const v = firstOperand(args, SYSTEMCTL_VALUE_OPTS);
      if (v === "" || SYSTEMCTL_READ.has(v)) return null;
      if (args.includes("--user") && SYSTEMCTL_USER_RUN.has(v)) return null;
      return `systemctl ${args.join(" ")}`;
    }
    case "security": {
      const at = subcommandAt(id, args);
      return securityOnlyLooks(
        (args[at] ?? "").toLowerCase(),
        args.slice(at + 1),
      )
        ? null
        : `security ${args[at] ?? ""} changes the keychain or trust settings`.trim();
    }
    // Windows (ADR 0075 step 1): its flags are `/x`, which a bash spells
    // `//x`; `winFlag` reads both.
    case "setx":
      return "setx changes environment variables for every later session";
    case "schtasks": {
      const v = args.map(winFlag).find((a) => a.startsWith("/"));
      return v === undefined || v === "/query"
        ? null
        : `schtasks ${v} changes scheduled tasks`;
    }
    case "reg": {
      const v = (args[0] ?? "").toLowerCase();
      return v === "" || REG_READ.has(v)
        ? null
        : `reg ${v} changes the registry`;
    }
    case "sc": {
      const v = (args.find((a) => !a.startsWith("\\\\")) ?? "").toLowerCase();
      return v === "" || SC_READ.has(v) ? null : `sc ${v} changes a service`;
    }
    case "netsh":
      return args.some((a) => a.toLowerCase() === "show")
        ? null
        : `netsh ${args.join(" ")} changes network settings`;
    case "wmic":
      return args.some((a) =>
        ["call", "create", "delete", "set"].includes(a.toLowerCase()),
      )
        ? `wmic ${args.join(" ")} changes the system`
        : null;
    case "bcdedit":
      return args.length === 0 || args.map(winFlag).every((a) => a === "/enum")
        ? null
        : "bcdedit changes the boot configuration";
    case "set-executionpolicy":
      return "Set-ExecutionPolicy changes which scripts PowerShell will run";
    case "register-scheduledtask":
    case "new-service":
    case "set-service":
      return `${argv[0]} changes scheduled tasks or services`;
    case "new-itemproperty":
    case "set-itemproperty":
      return args.some((a) => /^(hk(cu|lm|cr|u|cc):|registry::)/i.test(a))
        ? `${argv[0]} changes the registry`
        : null;
    default:
      return null;
  }
}

/** A Windows flag as the program reads it: `//x` (a bash's spelling, past
 *  its path conversion) is `/x`; case does not matter. */
function winFlag(a: string): string {
  return a.replace(/^\/\//, "/").toLowerCase();
}

/** `reg` verbs that only read (`export` writes a .reg FILE, not the registry). */
const REG_READ: ReadonlySet<string> = new Set(["query", "export", "compare"]);
/** `sc` verbs that only read. */
const SC_READ: ReadonlySet<string> = new Set([
  "query",
  "queryex",
  "qc",
  "qdescription",
  "qfailure",
  "qprivs",
  "qsidtype",
  "getdisplayname",
  "getkeyname",
  "enumdepend",
  "sdshow",
]);

/** Running as another, higher user. The command itself is classified too
 *  (`innerEscalation`); this is the class when it says nothing worse. */
const PRIVILEGE_WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "pkexec",
  "runas",
  "gsudo",
]);

/** Classes no reviewer may ever be handed and no rule may cover, most
 *  severe first: what a wrapper or a shell body is found to run, when it is
 *  one of these, is the line's class. */
const ESCALATING_CODES: readonly string[] = [
  "command_ask_destructive",
  "command_ask_system",
  "command_ask_opaque",
  "command_ask_download_exec",
  "command_ask_network",
  "command_ask_outside",
  "command_ask_harness_state",
  "command_ask_git_internals",
];

/**
 * What the line's own text does not show (ADR 0075 step 1): a shell that
 * runs its input, a body computed when it runs, a command PowerShell
 * decodes, `eval`. Null for a line the harness can read.
 */
function opaqueShape(
  id: string,
  argv: readonly string[],
  reentry: Reentry | null,
): string | null {
  if (id === "eval") return "eval runs a command assembled when it runs";
  if (id === "iex" || id === "invoke-expression") {
    return "Invoke-Expression runs a command assembled when it runs";
  }
  if (reentry?.kind === "body") {
    if (reentry.via.endsWith("-EncodedCommand")) {
      const shown = reentry.body.replace(/\s+/g, " ").trim();
      return `${reentry.via} hides its command; it decodes to: ${shown.length > 160 ? `${shown.slice(0, 159)}…` : shown}`;
    }
    // `__SUBST__` is the bash lane's stand-in for a substitution it has
    // pulled out to classify on its own.
    if (/\$\(|`|__SUBST__/.test(reentry.body)) {
      return `${reentry.via} runs a command computed when it runs`;
    }
    return null;
  }
  // A POSIX shell with no `-c` body and no script: it runs its input — a
  // pipe, a heredoc — which the harness never reads.
  if (SH_FAMILY.has(id)) {
    const args = argv.slice(1);
    if (args.length === 1 && /^--?(version|help)$/.test(args[0] as string)) {
      return null;
    }
    const script = args.find((a) => !a.startsWith("-"));
    if (script === undefined) {
      return `${id} runs whatever its input feeds it — the harness does not read it`;
    }
  }
  return null;
}

/**
 * The line's class when what it wraps is worse than the wrapper (ADR 0075
 * step 1): an exec-wrapper's command (`timeout 60 npx -y …`, `sudo rm -rf
 * …`) and every command of a shell body (`cmd //c "npx -y …"`, `bash -c
 * "terraform destroy …"`) are classified in their own right. Only a class
 * in ESCALATING_CODES is taken — a harmless inside never lends the wrapper
 * an allow — and the most severe one found wins. Bounded by the re-entry
 * depth cap, past which the block tier has already failed closed.
 */
function innerEscalation(
  argv: readonly string[],
  reentry: Reentry | null,
  opts: ClassifyCommandOpts | undefined,
  depth: number,
): Verdict | null {
  if (depth >= MAX_REENTRY_DEPTH) return null;
  const found: Array<{
    verdict: Extract<Verdict, { kind: "ask" }>;
    via: string;
  }> = [];
  const take = (v: Verdict, via: string): void => {
    if (v.kind === "ask" && ESCALATING_CODES.includes(v.code)) {
      found.push({ verdict: v, via });
    }
  };
  const peeled = peelExecWrappers(argv);
  if (peeled !== null && peeled.length > 0) {
    take(
      classifyCommandTiers(peeled, opts, depth + 1),
      interpreterName(argv[0] as string),
    );
  }
  if (reentry?.kind === "body") {
    for (const segment of splitShellSegments(reentry.body)) {
      const tokens = shellBodyTokens(segment);
      if (tokens.length === 0) continue;
      take(
        classifyCommandTiers(
          tokens,
          { shell: true, unresolved: true },
          depth + 1,
        ),
        reentry.via,
      );
    }
  }
  if (found.length === 0) return null;
  found.sort(
    (a, b) =>
      ESCALATING_CODES.indexOf(a.verdict.code) -
      ESCALATING_CODES.indexOf(b.verdict.code),
  );
  const top = found[0] as (typeof found)[number];
  return { ...top.verdict, reason: `${top.via}: ${top.verdict.reason}` };
}

/** A program that fetches a package and runs it (ADR 0075 step 1) — the
 *  download is the point, so it is never "unknown". Null otherwise. */
function downloadExecShape(id: string, argv: readonly string[]): string | null {
  const args = argv.slice(1);
  const sub = args[0];
  if (args.length === 1 && /^(--version|-v|-V)$/.test(sub as string)) {
    return null;
  }
  if (id === "npx" || id === "pnpx" || id === "bunx" || id === "uvx") {
    if (
      id === "npx" &&
      args.some((a) => a === "--no-install" || a === "--no")
    ) {
      return null;
    }
    return `${id} fetches a package when it is not installed, then runs it`;
  }
  if (id === "npm" && (sub === "exec" || sub === "x")) {
    return `npm ${sub} fetches a package when it is not installed, then runs it`;
  }
  if ((id === "pnpm" || id === "yarn") && sub === "dlx") {
    return `${id} dlx fetches a package and runs it`;
  }
  if (id === "bun" && sub === "x") return "bun x fetches a package and runs it";
  if (id === "pipx" && sub === "run")
    return "pipx run fetches a package and runs it";
  if (id === "uv" && sub === "tool" && args[1] === "run") {
    return "uv tool run fetches a package and runs it";
  }
  if (
    id === "go" &&
    sub === "run" &&
    args
      .slice(1)
      .some((a) => !a.startsWith("-") && !a.startsWith(".") && a.includes("@"))
  ) {
    return "go run of a module at a version fetches it and runs it";
  }
  if (id === "deno" && args.some((a) => /^(https?:|npm:|jsr:)/.test(a))) {
    return "deno fetches a remote module and runs it";
  }
  return null;
}

/** Programs whose work is talking to another machine. */
const REMOTE_PROGRAMS: ReadonlySet<string> = new Set([
  "ssh",
  "scp",
  "sftp",
  "telnet",
  "ftp",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "gh",
  "aws",
  "az",
  "gcloud",
  "kubectl",
  "helm",
  "terraform",
  "tofu",
  "bitsadmin",
  "invoke-webrequest",
  "iwr",
  "invoke-restmethod",
  "irm",
  "start-bitstransfer",
]);

/** The network, beyond the fetchers classified above it (ADR 0075 step 1).
 *  Null for a local use of the same program. */
function networkShape(id: string, argv: readonly string[]): string | null {
  const args = argv.slice(1);
  const sub = args.find((a) => !a.startsWith("-"));
  // `curl.exe`, `/usr/bin/wget`: the plain spellings were classified above,
  // with their loopback allow; these reach the network all the same.
  if (id === "curl" || id === "wget") return `${id} network call`;
  if (REMOTE_PROGRAMS.has(id)) {
    if (
      args.length === 1 &&
      /^(--version|-v|version|--help|help)$/.test(args[0] as string)
    ) {
      return null;
    }
    return `${argv[0]} reaches another machine`;
  }
  if (
    id === "rsync" &&
    args.some(
      (a) =>
        a.startsWith("rsync://") ||
        (/^[^-/\\.][^/\\]*:/.test(a) && !/^[A-Za-z]:[\\/]/.test(a)),
    )
  ) {
    return "rsync to or from another machine";
  }
  if (
    id === "certutil" &&
    args.some(
      (a) => /^(-|\/\/?)(urlcache|verifyctl)$/i.test(a) || /^https?:/i.test(a),
    )
  ) {
    return "certutil downloads a file";
  }
  if (
    (id === "docker" || id === "podman") &&
    sub !== undefined &&
    ["pull", "push", "login", "run", "create", "build", "search"].includes(sub)
  ) {
    return `${id} ${sub} reaches a registry`;
  }
  // Publishing to a package registry (2026-10-09): `npm publish` was
  // `unknown`. `yarn npm publish` is Berry's spelling.
  if (["npm", "pnpm", "yarn", "bun"].includes(id) && sub !== undefined) {
    const verb =
      id === "yarn" && sub === "npm"
        ? args.filter((a) => !a.startsWith("-"))[1]
        : sub;
    if (
      verb !== undefined &&
      [
        "publish",
        "unpublish",
        "deprecate",
        "dist-tag",
        "owner",
        "access",
      ].includes(verb)
    ) {
      return `${id} ${verb} changes what the package registry serves`;
    }
  }
  return null;
}

/** Tools whose ordinary verb destroys: wiping files past recovery, tearing
 *  down infrastructure, pruning containers (ADR 0075 step 1). */
function destructiveToolShape(
  id: string,
  argv: readonly string[],
): string | null {
  const args = argv.slice(1);
  const sub = args.find((a) => !a.startsWith("-"));
  if (id === "shred" || id === "wipe" || id === "srm") {
    return `${id} overwrites files so they cannot be recovered`;
  }
  if (id === "cipher" && args.some((a) => /^\/\/?w/i.test(a))) {
    return "cipher /w wipes free space";
  }
  if ((id === "terraform" || id === "tofu") && sub === "destroy") {
    return `${id} destroy tears down the infrastructure it manages`;
  }
  if (
    (id === "terraform" || id === "tofu") &&
    sub === "apply" &&
    args.some((a) => a === "-auto-approve" || a === "--auto-approve")
  ) {
    return `${id} apply -auto-approve changes infrastructure without its own review`;
  }
  if (id === "kubectl" && args.includes("delete")) {
    return `kubectl delete removes cluster resources`;
  }
  if (
    id === "helm" &&
    (args.includes("uninstall") || args.includes("delete"))
  ) {
    return "helm uninstall removes a release";
  }
  if (id === "docker" || id === "podman") {
    const second = args.filter((a) => !a.startsWith("-"))[1];
    if (sub === "rm" || sub === "rmi")
      return `${id} ${sub} removes containers or images`;
    if (
      sub !== undefined &&
      ["system", "image", "container", "volume", "network", "builder"].includes(
        sub,
      ) &&
      (second === "prune" || second === "rm")
    ) {
      return `${id} ${sub} ${second} deletes what it names`;
    }
  }
  if (id === "dropdb") return "dropdb deletes a database";
  return null;
}

/** A container that mounts a host path outside the workspace, or runs with
 *  the host's privileges (ADR 0075 step 1). Null otherwise. */
function containerShape(
  id: string,
  argv: readonly string[],
  live: boolean,
): Verdict | null {
  if (id !== "docker" && id !== "podman") return null;
  const args = argv.slice(1);
  const sub = args.find((a) => !a.startsWith("-"));
  if (sub !== "run" && sub !== "create") return null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (
      a === "--privileged" ||
      /^--(pid|net|network|ipc|uts|userns)=host$/.test(a) ||
      a.startsWith("--cap-add")
    ) {
      return {
        kind: "ask",
        risk: "workspace_destructive",
        code: "command_ask_system",
        reason: `${id} ${sub} ${a} gives the container the host's privileges`,
      };
    }
    let spec: string | null = null;
    if (a === "-v" || a === "--volume") spec = args[i + 1] ?? null;
    else if (a.startsWith("--volume=")) spec = a.slice("--volume=".length);
    let host: string | null = null;
    if (spec !== null) {
      const drive = /^([A-Za-z]:[\\/][^:]*)/.exec(spec);
      host = drive !== null ? (drive[1] as string) : (spec.split(":")[0] ?? "");
    }
    if (a === "--mount" || a.startsWith("--mount=")) {
      const m =
        a === "--mount" ? (args[i + 1] ?? "") : a.slice("--mount=".length);
      const src = /(?:^|,)(?:source|src)=([^,]*)/.exec(m);
      host = src !== null ? (src[1] as string) : null;
    }
    // A named volume (`data:/data`) is no host path.
    if (host !== null && host.length > 0 && /[\\/~.$]/.test(host)) {
      if (escapesWorkspaceOperand(host, live)) return outsideAsk(id, host);
    }
  }
  return null;
}

/**
 * git shapes that DISCARD uncommitted work or REWRITE history, described so
 * the card says which — or null for the ordinary repository changes, which
 * stay `command_ask_vcs`.
 *
 * Why this is its own tier rather than prose in a prompt. `command_ask_vcs` is
 * rule-eligible, so approving ONE benign git line with "always allow in this
 * project" persists `{argvPrefix:['git','checkout'], anyArgs:true}` — and that
 * rule then covers `git checkout -- .`, which throws away everything the user
 * has not committed, with no card, in that project, forever. Reproduced end to
 * end on 2026-08-25. Moving these to `command_ask_destructive` shuts both
 * persistence doors at once: the class is absent from RULE_ELIGIBLE_ASK_CODES,
 * and `SessionApprovalCache.isCacheable` only ever caches `workspace_write`.
 *
 * Uncommitted work is the one thing the harness cannot get back, and it cannot
 * tell "precious" from "scratch" — so the ask class is the only place that
 * judgement can live (D4).
 *
 * Deliberately NOT here, and pinned by tests that say so: `git stash pop`
 * (RESTORES work), `git branch -d` (refuses an unmerged branch), and the
 * everyday `add`/`commit`/`merge`/`fetch`/`pull`/`mv`/`rm`/`checkout -b`,
 * so ADR 0030's `git commit:*` rules still derive exactly as before.
 */
function destructiveGitShape(
  argv: readonly string[],
): { reason: string; consequence: CommandConsequence } | null {
  const at = gitSubcommandIndex(argv);
  if (at === null) return null;
  const sub = argv[at] as string;
  const rest = argv.slice(at + 1);
  const has = (...flags: string[]) => rest.some((a) => flags.includes(a));

  // ── discards uncommitted work ──
  if (sub === "checkout" || sub === "switch") {
    // Creating or moving to a branch is ordinary; PATH mode overwrites files
    // from the index or a commit. `--` is the unambiguous marker; a bare `.`
    // or a path operand with no branch-creating flag is the same thing.
    const creating = has("-b", "-B", "-c", "-C", "--orphan", "--guess");
    // A tree-ish FOLLOWED BY operands is path mode too, and it is the spelling
    // an agent reaches for to revert one file (`git checkout main src/x.ts`,
    // `git checkout HEAD~1 notes.md`). Reading only `--` and a bare `.` left
    // it on the rule-eligible tier, where a remembered `git checkout:*` then
    // auto-approved it with no card — the very door this tier exists to shut.
    const operands = rest.filter((a) => !a.startsWith("-"));
    const pathMode =
      rest.includes("--") ||
      (!creating &&
        (operands.length >= 2 || rest.some((a) => a === "." || a === "*")));
    if (pathMode) {
      return {
        reason: `git ${sub} in path mode overwrites uncommitted changes in those paths`,
        consequence: "discards_uncommitted",
      };
    }
    // A SINGLE operand stays ordinary, deliberately: `git checkout main` and
    // `git checkout main.ts` are the same string shape, and git itself decides
    // by asking whether the name resolves as a ref — which this classifier
    // cannot do. Guessing either way is wrong, so the residue is handled where
    // it can be handled honestly: `deriveProjectCommandRule` refuses to hand
    // `checkout`/`switch`/`restore` a `:*` wildcard, so an ambiguous operand
    // asks every time instead of riding a grant earned by a different one.
    return null;
  }
  if (sub === "restore") {
    // `--staged` alone only unstages; anything else rewrites the worktree.
    const stagedOnly = has("--staged", "-S") && !has("--worktree", "-W");
    if (!stagedOnly)
      return {
        reason: "git restore overwrites uncommitted changes",
        consequence: "discards_uncommitted",
      };
    return null;
  }
  if (sub === "stash" && (rest[0] === "drop" || rest[0] === "clear")) {
    return {
      reason: `git stash ${rest[0]} deletes stashed work`,
      consequence: "deletes_stash",
    };
  }

  // ── rewrites history or a ref ──
  if (sub === "commit" && has("--amend")) {
    return {
      reason: "git commit --amend rewrites the last commit",
      consequence: "rewrites_local_history",
    };
  }
  if (sub === "rebase" && rest[0] !== "--abort" && rest[0] !== "--quit") {
    return {
      reason: "git rebase rewrites history",
      consequence: "rewrites_local_history",
    };
  }
  if (sub === "push" && has("-f", "--force")) {
    return {
      reason: "git push --force overwrites the remote branch",
      consequence: "rewrites_remote_history",
    };
  }
  if (sub === "push" && rest.some((a) => a.startsWith("--force-with-lease"))) {
    return {
      reason: "git push --force-with-lease overwrites the remote branch",
      consequence: "rewrites_remote_history",
    };
  }
  if (
    // NOT `--delete`/`-d`: that refuses an unmerged branch, and the 2026-08-25
    // decision pinned it as ordinary. Only the FORCING spellings land here.
    sub === "branch" &&
    (has("--force") ||
      hasShortFlag(rest, "D") ||
      hasShortFlag(rest, "M") ||
      hasShortFlag(rest, "f"))
  ) {
    return {
      reason:
        "git branch -D/-M/-f force-deletes, force-renames or moves a branch",
      consequence: "rewrites_local_history",
    };
  }
  if (
    sub === "tag" &&
    (has("--delete", "--force") ||
      hasShortFlag(rest, "d") ||
      hasShortFlag(rest, "f"))
  ) {
    return {
      reason: "git tag -d/-f deletes or moves a tag",
      consequence: "rewrites_local_history",
    };
  }
  if (sub === "update-ref" && has("-d", "--delete")) {
    return {
      reason: "git update-ref -d deletes a ref",
      consequence: "rewrites_local_history",
    };
  }
  if (sub === "reflog" && rest[0] === "expire") {
    return {
      reason: "git reflog expire discards the recovery log",
      consequence: "rewrites_local_history",
    };
  }
  if (sub === "filter-branch" || sub === "filter-repo") {
    return {
      reason: `git ${sub} rewrites the whole history`,
      consequence: "rewrites_local_history",
    };
  }
  return null;
}

/**
 * A commit-concluding git shape while a merge/rebase/cherry-pick/revert is
 * mid-flight CONCLUDES that operation — an ordinary-looking `git commit`
 * card can close out the user's half-finished merge with the backend's
 * edits inside (ADR 0049 §5). The probe is LAZY and supplied by the caller
 * (only rules know the effective cwd); no caller, no note. Display-only.
 */
function concludesInProgressOperation(
  argv: readonly string[],
  opts: ClassifyCommandOpts | undefined,
): boolean {
  if (opts?.repoInProgress === undefined) return false;
  const at = gitSubcommandIndex(argv);
  if (at === null) return false;
  const sub = argv[at];
  const rest = argv.slice(at + 1);
  const concluding =
    sub === "commit" ||
    ((sub === "merge" ||
      sub === "rebase" ||
      sub === "cherry-pick" ||
      sub === "revert") &&
      rest.includes("--continue"));
  if (!concluding) return false;
  try {
    return opts.repoInProgress() !== null;
  } catch {
    return false;
  }
}

/** How many interpreter layers the block scan will unwrap before it refuses
 *  to keep guessing. */
const MAX_REENTRY_DEPTH = 3;

/** `find` predicates that RUN a program or WRITE a file for every match —
 *  the whole family, not the two spellings that were enumerated first. */
const FIND_ACTION_PREDICATES: ReadonlySet<string> = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

/**
 * Options that turn an allow-listed program into an arbitrary-program
 * launcher, a file writer, or a config-injection vector — keyed by the
 * program the allow tier trusts.
 *
 * Every entry is a knob the harness's mental model of that program did not
 * account for: "git grep searches the tracked set" is true of its READS and
 * silent about the pager it spawns; "npm test runs the workspace's tests" was
 * never enforced by anything; `node --test`'s deny-list enumerated the
 * module-loading flags it knew. Matched as an exact token or as `--flag=value`
 * (both spellings shipped, and for `node --env-file` the space form asked
 * while the `=` form allowed).
 */
const ESCAPE_HATCH_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map<
  string,
  ReadonlySet<string>
>([
  // ADR 0064 L1 readers with a writing or list-reading knob.
  [
    "file",
    new Set(["-C", "--compile", "-m", "--magic-file", "-f", "--files-from"]),
  ],
  ["xxd", new Set(["-r", "-revert"])],
  ["md5sum", new Set(["-c", "--check"])],
  ["sha1sum", new Set(["-c", "--check"])],
  ["sha256sum", new Set(["-c", "--check"])],
  [
    "git",
    new Set([
      "-O",
      "--open-files-in-pager", // git grep: runs a command on the matches
      "--output", // git diff/log/show: writes an arbitrary file
      "--output-indicator-new",
      "--contents", // git blame: reads an arbitrary file
      "--upload-pack",
      "--receive-pack",
      "--exec-path",
      // The external-diff / textconv family: each runs a command named by
      // repo config, so a line that first appends to `.git/config` and then
      // reads with one of these is arbitrary execution (red team round 3).
      "--ext-diff",
      "--textconv",
      "--no-textconv",
    ]),
  ],
  ["rg", new Set(["--pre", "--hostname-bin"])],
  ["grep", new Set(["--devices"])],
  [
    "npm",
    new Set([
      "--prefix",
      "-C",
      "--script-shell",
      "--node-options",
      "--userconfig",
      "--globalconfig",
      "--ignore-scripts=false",
    ]),
  ],
  [
    "pnpm",
    new Set([
      "--prefix",
      "-C",
      "--dir",
      "--script-shell",
      "--use-node-version",
    ]),
  ],
  ["yarn", new Set(["--cwd", "--use-yarnrc"])],
  ["cargo", new Set(["--config", "--manifest-path", "--target-dir"])],
  ["go", new Set(["-exec", "-toolexec", "-overlay", "-o"])],
  [
    "node",
    new Set([
      "--test-reporter",
      "--env-file",
      "--env-file-if-exists",
      "--conditions",
      "--watch-path",
    ]),
  ],
  [
    "pytest",
    new Set(["-p", "--pyargs", "--rootdir", "-c", "--co", "--basetemp"]),
  ],
  // Text filters that can be pointed at a file list or an output path.
  ["sort", new Set(["--files0-from", "--output", "--compress-program", "-o"])],
  ["wc", new Set(["--files0-from"])],
  ["du", new Set(["--files0-from"])],
]);

/** A token carrying a shell expansion the classifier cannot resolve, so any
 *  deny-list decision made by reading argv LITERALLY is unsound. */
function hasUnresolvedExpansion(argv: readonly string[]): boolean {
  return argv.slice(1).some(isUnresolvable);
}

function isUnresolvable(a: string): boolean {
  return (
    a.includes("${") ||
    a.includes("$(") ||
    a.includes("`") ||
    // `$1`, `$@`, `$*`, `$?`, `$#`, `$!`, `$-` expand to text the harness
    // never saw, exactly like `$HOME` — but requiring an IDENTIFIER after the
    // `$` said they were already resolved. `set -- /etc/passwd` then `cat "$1"`
    // is two allow-tier commands, and a persistent shell carries the
    // positionals from the first into the second.
    LIVE_PARAMETER.test(a) ||
    /\{[^}]*,[^}]*\}/.test(a)
  );
}

/** A parameter expansion of ANY kind, not only the `$name` spelling. */
const LIVE_PARAMETER = /\$[A-Za-z_0-9@*?#!$-]/;

/**
 * What the classifier cannot resolve about the PROGRAM NAME — so it cannot
 * know what will run at all.
 *
 * `${x:-rm} -rf /`, `{rm,-rf,/}` and `/bin/r?` each reached the ask tier only
 * because no rule recognised them, and landed on `command_ask_unknown`, which
 * is both cacheable and rule-eligible. An unknowable program is the one thing
 * that must never be either.
 */
export function unresolvedProgramName(a0: string): string | null {
  if (/[$`]/.test(a0)) return "a variable or command substitution";
  if (/\{[^}]*,[^}]*\}/.test(a0)) return "a brace expansion";
  if (/[*?]|\[[^\]]*\]/.test(a0)) return "a glob";
  return null;
}

/**
 * Programs whose ARGUMENTS cannot change what they do to the machine.
 *
 * The allow tier is earned by reading a command; these are the few where
 * there is nothing in the arguments left to read. Everything else must be
 * able to account for its operands before it may skip the approval card.
 */
const ARG_INDEPENDENT_PROGRAMS: ReadonlySet<string> = new Set([
  "echo",
  "true",
  "false",
  ":",
  "pwd",
  "date",
  "whoami",
  "hostname",
  "uname",
  "sleep",
  "printenv",
  "id",
  "tty",
]);

/**
 * git's CONFIG flags, which set arbitrary repo config on the command line and
 * can therefore name a program for git to run.
 *
 * They only mean that BEFORE the subcommand — `git -c k=v diff`. After it they
 * belong to the subcommand and mean something else entirely, which is how a
 * first pass turned the everyday `git switch -c feature/x` into an ask.
 */
const GIT_CONFIG_FLAGS: ReadonlySet<string> = new Set([
  "-c",
  "--config-env",
  "--exec-path",
]);

/** A git config flag used BEFORE the subcommand, or null. */
function gitConfigFlag(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (!a.startsWith("-")) return null; // reached the subcommand
    if (GIT_CONFIG_FLAGS.has(a)) return a;
    const eq = a.indexOf("=");
    if (eq > 0 && GIT_CONFIG_FLAGS.has(a.slice(0, eq))) return a.slice(0, eq);
  }
  return null;
}

/** The escape-hatch flag an argv carries for its own program, or null. */
function escapeHatchFlag(
  argv: readonly string[],
  shell: boolean,
): string | null {
  const program = interpreterName(argv[0] as string);
  if (program === "git") {
    const cfg = gitConfigFlag(argv);
    if (cfg !== null) return cfg;
  }
  const flags = ESCAPE_HATCH_FLAGS.get(program);
  if (flags === undefined) return null;
  // A deny-list read against literal tokens cannot survive expansion: bash
  // turns `${x:--r}` and `{-O./pager.sh,needle}` into the very flags this
  // list exists to catch, and every literal comparison below misses them
  // (red team round 3). For a program whose safety rests on such a list, an
  // unresolvable token is itself the finding — under a shell, at least; an
  // argv spawned with shell:false expands nothing.
  if (shell && hasUnresolvedExpansion(argv))
    return "an unresolved shell expansion";
  for (const a of argv.slice(1)) {
    if (flags.has(a)) return a;
    const eq = a.indexOf("=");
    if (eq > 0 && flags.has(a.slice(0, eq))) return a.slice(0, eq);
    // Attached short-option value: `git grep -Ocurl`, `-O'sh -c "…"'`.
    if (a.length > 2 && a.startsWith("-") && !a.startsWith("--")) {
      const short = a.slice(0, 2);
      if (flags.has(short)) return short;
    }
  }
  return null;
}

/** Block-tier scan of a whole shell body — every segment, exec-wrappers
 *  peeled, nested interpreters unwrapped. Shared with the minimal contract's
 *  shell-string classifier (ADR 0040), which layers the ask/allow tiers on
 *  top. */
export function classifyShellBody(
  body: string,
  depth = 0,
): { hit: boolean; reason: string } {
  if (body.includes(":(){")) {
    return { hit: true, reason: "fork bomb pattern" };
  }
  // A patch inside the body's own text — a heredoc fed to `git apply` —
  // whose target is `.herta`. The tokenizer sees heredoc text as data, so the
  // one place the raw body is still whole judges it (review 2026-09-30).
  if (patchTargetPaths(body).some(pathTouchesHerta)) {
    return {
      hit: true,
      reason:
        "a patch in the command's text writes into .herta — the harness's own state; no command may change it",
    };
  }
  // EVERY command in the body, not just the first (audit S4).
  for (const segment of splitShellSegments(body)) {
    const tokens = shellBodyTokens(segment);
    if (tokens.length === 0) continue;
    // The segment as written, and the command it runs once exec-wrappers are
    // peeled off (`sudo`/`env`/`timeout`/`nice`/`xargs`/`command` …). Both are
    // checked: peeling only ever escalates.
    const candidates: Array<readonly string[]> = [tokens];
    const unwrapped = peelExecWrappers(tokens);
    if (unwrapped !== null && unwrapped.length > 0) candidates.push(unwrapped);

    for (const cand of candidates) {
      const direct = isCatastrophic(cand);
      if (direct.hit) return direct;
      // Nested wrapping (`cmd /c "powershell -Command shutdown /s"`) unwraps
      // one interpreter per level; the depth cap bounds a crafted chain.
      const nested = extractShellReentry(cand);
      if (nested === null) continue;
      if (nested.kind === "refused") {
        return { hit: true, reason: nested.reason };
      }
      if (depth < MAX_REENTRY_DEPTH) {
        const inner = classifyShellBody(nested.body, depth + 1);
        if (inner.hit) return inner;
        continue;
      }
      // At the cap with an interpreter still to unwrap: FAIL CLOSED. The scan
      // cannot see what runs down there, and "cannot see" must not read as
      // "nothing catastrophic" — that is the one direction a block tier is
      // never allowed to guess in. Legitimate work never nests shells this
      // deep (codex study 2026-08-24; cf. Codex's depth-capped peel).
      return {
        hit: true,
        reason: `shell nesting deeper than the classifier can inspect (via ${nested.via})`,
      };
    }
  }
  return { hit: false, reason: "" };
}

/** `shell: true` when a SHELL will expand this argv before running it — the
 *  minimal contract's `bash`. `run_command` spawns argv directly (shell:false),
 *  where an unexpanded `$VAR` is literal text and must not be treated as an
 *  expansion. */
export interface ClassifyCommandOpts {
  shell?: boolean;
  /** Whether the shell will actually PERFORM an expansion in this command —
   *  the caller decides, because quoting settles it and only the caller still
   *  has the raw text (`sed -n '$p'` expands nothing). Defaults to false, so
   *  `run_command`'s literal argv is never treated as expanding. */
  unresolved?: boolean;
  /** LAZY probe for a repo operation mid-flight at the command's effective
   *  cwd (ADR 0049 §5) — supplied by callers that know the cwd, called only
   *  when the argv is a commit-concluding git shape, so non-git commands pay
   *  nothing. Feeds the `concludes_in_progress_operation` consequence note;
   *  absent → the note is simply never attached. */
  repoInProgress?: () => RepoInProgressState | null;
  /** The caller's judgment of what a WRITE would touch (2026-09-30): the
   *  classifier names the operands a command writes, only the caller can
   *  resolve them (its workspace, its cwd, its links). A denial from either
   *  side turns the verdict into a block. Absent → no such check. */
  writeGuard?: WriteGuard;
}

/** See `ClassifyCommandOpts.writeGuard`. `path` and `body` return a denial
 *  reason, or null to let the verdict stand. */
export interface WriteGuard {
  /** One operand the command WRITES, as it appears in the argv. */
  path(operand: string): string | null;
  /** A shell body the argv hands to another shell (`bash -c "…"`,
   *  `cmd /c …`): its redirects and operands are text no argv parse reaches. */
  body(body: string): string | null;
  /** True when the operand names the directory that HOLDS the harness's
   *  state — the workspace root, however spelled — so a walk started there
   *  reaches `.herta`. A caller without it gets no reach ask. */
  holds?(operand: string): boolean;
  /** The paths a patch file WRITES, read now; null when the file cannot be
   *  read (absent, too large, stdin, a token the caller cannot resolve). */
  patch?(file: string): readonly string[] | null;
  /** True when writing the operand lands inside a repository's `.git`
   *  beneath the workspace (`gitInternalsWrite`). A caller without it gets
   *  no git-internals ask for written operands. */
  gitInternal?(operand: string): boolean;
}

/** The ask class of a line whose reach into `.herta` the guard cannot
 *  bound (see `harnessReach`): never reviewed, never rule-eligible. */
export const HARNESS_STATE_ASK_CODE = "command_ask_harness_state";

/**
 * The ask class of a change to what git RUNS later (2026-10-09): a write
 * into a repository's `.git` (hooks, config, internals), and a repo-local
 * `git config` key whose value is a command or loads more config
 * (`core.hooksPath`, `core.fsmonitor`, `alias.*`, `filter.*`,
 * `include.path`, …). Each was a plain write or vcs class, which workspace
 * trust answered with no card, while the command it plants runs behind
 * `git commit` or an allowed `git status`. Risk `workspace_destructive`:
 * never cached, never rule-eligible; a review scores it high.
 */
export const GIT_INTERNALS_ASK_CODE = "command_ask_git_internals";

function gitInternalsAsk(reason: string): Verdict {
  return {
    kind: "ask",
    risk: "workspace_destructive",
    code: GIT_INTERNALS_ASK_CODE,
    reason,
  };
}

export function classifyCommand(
  argv: readonly string[],
  opts?: ClassifyCommandOpts,
): Verdict {
  const verdict = classifyCommandTiers(argv, opts);
  const guard = opts?.writeGuard;
  if (guard === undefined || verdict.kind === "block") return verdict;
  // The harness's own state is not command-writable (2026-09-30): whatever
  // tier the command earned, a write into it is refused outright — the same
  // hard line the editors draw, since a card for it would be one click from
  // the agent granting itself rules or trust.
  for (const operand of writtenOperands(argv)) {
    const denial = guard.path(operand);
    if (denial !== null) {
      return { kind: "block", code: "command_blocked", reason: denial };
    }
  }
  const reentry = extractShellReentry(argv);
  if (reentry?.kind === "body") {
    const denial = guard.body(reentry.body);
    if (denial !== null) {
      return { kind: "block", code: "command_blocked", reason: denial };
    }
  }
  if (verdict.kind === "ask") {
    return (
      harnessReach(argv, guard) ??
      gitInternalsReach(argv, verdict, guard, reentry) ??
      verdict
    );
  }
  return verdict;
}

/** A `.git` path segment in shell text: `.git/hooks`, `.git\config`,
 *  `./.git`, a bare `.git` operand. */
const GIT_DIR_IN_TEXT = /(?:^|[\s"'=/\\(;&|])\.git(?:[/\\\s"';&|)]|$)/;

/**
 * A written operand inside a repository's `.git` (2026-10-09): its own
 * class when the verdict was one trust or the cache could answer — `cp x
 * .git/hooks/pre-commit` was `_fs`, `sed -i … .git/config` was `_write`. A
 * verdict already outside that tier (destructive, outside, …) keeps its own
 * label. Null when no written operand is there, or the guard cannot judge.
 */
function gitInternalsReach(
  argv: readonly string[],
  verdict: Extract<Verdict, { kind: "ask" }>,
  guard: WriteGuard,
  reentry: ReturnType<typeof extractShellReentry>,
): Verdict | null {
  if (guard.gitInternal === undefined) return null;
  if (verdict.risk !== "workspace_write") return null;
  const into = writtenOperands(argv).find(
    (o) => o !== "" && guard.gitInternal?.(o) === true,
  );
  if (into !== undefined) {
    return gitInternalsAsk(
      `${interpreterName(argv[0] ?? "")} changes ${into}, inside .git — git runs its hooks and reads its config later`,
    );
  }
  // A body handed to another shell is text no argv parse reaches (`bash -c
  // "echo x > .git/hooks/pre-commit"`): naming `.git` is enough, as naming
  // `.herta` is for the state guard.
  if (reentry?.kind === "body" && GIT_DIR_IN_TEXT.test(reentry.body)) {
    return gitInternalsAsk(
      `${reentry.via} is handed a command that names .git — git runs its hooks and reads its config later`,
    );
  }
  return null;
}

/**
 * A command whose written paths the argv does not name but which CAN reach
 * the harness's state (review 2026-09-30): `find` with an action predicate
 * started from the directory that holds `.herta`, and `git apply` / `git am`
 * of a patch, whose targets are inside the patch. A patch the guard can read
 * is judged path by path — a `.herta` target blocks, like any written
 * operand. One it cannot read, and a find from the root, ASK in a class trust
 * never covers and no rule derives from: the user sees the line every time.
 * Null when the line is neither shape, or the guard cannot judge it.
 */
function harnessReach(
  argv: readonly string[],
  guard: WriteGuard,
): Verdict | null {
  const id = interpreterName(argv[0] ?? "");
  if (id === "find") {
    if (guard.holds === undefined) return null;
    const action = argv.find((a) => FIND_ACTION_PREDICATES.has(a));
    if (action === undefined) return null;
    const start = findStartPoints(argv.slice(1)).find(
      (s) => guard.holds?.(s) === true,
    );
    if (start === undefined) return null;
    return {
      kind: "ask",
      risk: "workspace_write",
      code: HARNESS_STATE_ASK_CODE,
      reason: `find from ${start} with ${action} reaches .herta — the harness's own state — and what it touches there cannot be told from the line`,
    };
  }
  if (id === "git") {
    const sub = gitSubcommandIndex(argv);
    const name = sub === null ? undefined : argv[sub];
    if (sub === null || (name !== "apply" && name !== "am")) return null;
    const rest = argv.slice(sub + 1);
    // The read-only forms apply nothing — unless `--apply` turns them back.
    if (
      rest.some((a) => APPLY_READ_ONLY_FLAGS.has(a)) &&
      !rest.includes("--apply")
    ) {
      return null;
    }
    const unreadable: Verdict = {
      kind: "ask",
      risk: "workspace_write",
      code: HARNESS_STATE_ASK_CODE,
      reason: `git ${name} of a patch the harness could not read — it may write into .herta, the harness's own state`,
    };
    const files = patchOperands(rest);
    if (files.length === 0 || guard.patch === undefined) return unreadable;
    for (const file of files) {
      const targets = guard.patch(file);
      if (targets === null) return unreadable;
      for (const target of targets) {
        const denial = guard.path(target);
        if (denial !== null) {
          return { kind: "block", code: "command_blocked", reason: denial };
        }
      }
    }
  }
  return null;
}

const APPLY_READ_ONLY_FLAGS: ReadonlySet<string> = new Set([
  "--check",
  "--stat",
  "--numstat",
  "--summary",
]);

/** `find`'s start points: the operands before the first expression word.
 *  None spelled means the current directory, as find itself takes it. */
function findStartPoints(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a.startsWith("-") || a === "(" || a === "!" || a === ")") break;
    out.push(a);
  }
  return out.length === 0 ? ["."] : out;
}

/** `git apply` / `git am` operands that are patch files. The options that
 *  take a separate value are stepped over; a bare `-` is stdin, which the
 *  guard cannot read — as it should not. */
function patchOperands(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--directory" || a === "--include" || a === "--exclude") {
      i += 1;
      continue;
    }
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a === "-" || !a.startsWith("-")) out.push(a);
  }
  return out;
}

function pathTouchesHerta(p: string): boolean {
  return p.split(/[\\/]/).some((s) => s.toLowerCase() === ".herta");
}

/** Verbs whose every non-flag operand is a path they create, change, move or
 *  remove. `cp`/`install` sources are only read, but a copy OUT of `.herta`
 *  has no honest use a reader tool does not serve, and naming the destination
 *  alone would miss `-t DIR` spellings. */
const PATH_WRITING_VERBS: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "mkdir",
  "touch",
  "cp",
  "mv",
  "ln",
  "rename",
  "install",
  "truncate",
  "chmod",
  "chown",
  "chgrp",
  "tee",
  "del",
  "erase",
  "rd",
  "remove-item",
  "ri",
]);

/**
 * The operands a command WRITES, as written in its argv — for the caller's
 * write guard (2026-09-30). Precise per program rather than every operand, so
 * a `.herta` that is only TEXT — `sed -i 's/.herta/x/' README.md` — is not
 * mistaken for a target:
 *   - the path-writing verbs above: every non-flag operand, `--opt=value`
 *     values included;
 *   - `sed` in place: the files after the script;
 *   - `sort -o FILE` / `--output[=]FILE`; `uniq IN OUT`: OUT;
 *   - `find` with an action predicate: its start points, and the file a
 *     `-fprint*` / `-fls` writes;
 *   - `dd of=FILE`.
 */
export function writtenOperands(argv: readonly string[]): string[] {
  const id = interpreterName(argv[0] ?? "");
  const args = argv.slice(1);
  const nonFlag = (a: string): boolean => !(a.startsWith("-") && a.length > 1);
  if (PATH_WRITING_VERBS.has(id)) {
    const out: string[] = [];
    for (const a of args) {
      if (a === "--") continue;
      if (a.startsWith("--") && a.includes("=")) {
        out.push(a.slice(a.indexOf("=") + 1));
        continue;
      }
      if (nonFlag(a)) out.push(a);
    }
    return out;
  }
  if (id === "sed") {
    const inPlace = args.some(
      (a) =>
        a === "--in-place" ||
        a.startsWith("--in-place=") ||
        /^-[a-zA-Z]*i/.test(a),
    );
    if (!inPlace) return [];
    let scriptGiven = false;
    const files: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i] as string;
      if (a === "-e" || a === "--expression" || a === "-f" || a === "--file") {
        scriptGiven = true;
        i += 1;
        continue;
      }
      if (a.startsWith("--expression=") || a.startsWith("--file=")) {
        scriptGiven = true;
        continue;
      }
      if (a === "--") {
        files.push(...args.slice(i + 1));
        break;
      }
      if (!nonFlag(a)) continue;
      if (!scriptGiven) {
        scriptGiven = true; // the first operand is the script
        continue;
      }
      files.push(a);
    }
    return files;
  }
  if (id === "sort") {
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i] as string;
      if (a === "--output" || a === "-o") return [args[i + 1] ?? ""];
      if (a.startsWith("--output=")) return [a.slice("--output=".length)];
      // Lazy: in `-uoFILE` the FIRST `o` opens the value.
      const bundled = /^-[a-zA-Z]*?o(.*)$/.exec(a);
      if (bundled !== null && !a.startsWith("--")) {
        return [
          bundled[1] !== "" ? (bundled[1] as string) : (args[i + 1] ?? ""),
        ];
      }
    }
    return [];
  }
  if (id === "uniq") {
    const operands = args.filter(nonFlag);
    return operands.length >= 2 ? [operands[1] as string] : [];
  }
  if (id === "find") {
    if (!args.some((a) => FIND_ACTION_PREDICATES.has(a))) return [];
    const out = findStartPoints(args);
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i] as string;
      if (
        a === "-fprint" ||
        a === "-fprint0" ||
        a === "-fprintf" ||
        a === "-fls"
      ) {
        const file = args[i + 1];
        if (file !== undefined) out.push(file);
      }
    }
    return out;
  }
  if (id === "dd") {
    return args
      .filter((a) => a.startsWith("of="))
      .map((a) => a.slice("of=".length));
  }
  if (id === "git") return gitWrittenOperands(argv);
  return [];
}

/**
 * The few git shapes that write a path the argv NAMES — none is the
 * repository's own content (that stays `command_ask_vcs`); each is a place
 * on disk git creates or fills: a checkout-index prefix, a new worktree or
 * repository, an archive, a bundle, format-patch's output directory, and the
 * `--directory` an apply prepends to every path in the patch (review
 * 2026-09-30: `git checkout-index --prefix=.herta/` planted files with a
 * plain vcs card).
 */
function gitWrittenOperands(argv: readonly string[]): string[] {
  const sub = gitSubcommandIndex(argv);
  if (sub === null) return [];
  const rest = argv.slice(sub + 1);
  switch (argv[sub]) {
    case "apply":
      return optionValues(rest, ["--directory"]);
    case "checkout-index":
      return optionValues(rest, ["--prefix"]);
    case "worktree":
      return rest[0] === "add" ? firstPathOperand(rest.slice(1)) : [];
    case "init":
      return firstPathOperand(rest);
    case "archive":
      return optionValues(rest, ["-o", "--output"]);
    case "bundle":
      return rest[0] === "create" ? firstPathOperand(rest.slice(1)) : [];
    case "format-patch":
      return optionValues(rest, ["-o", "--output-directory"]);
    case "config": {
      // The file a config WRITE lands in (2026-10-09): `git config --file
      // .herta/permissions.json k v` wrote the harness's rules with a vcs
      // card. A read of it writes nothing.
      const c = parseGitConfig(rest);
      return c.read || c.file === null ? [] : [c.file];
    }
    default:
      return [];
  }
}

/** The values of `--name=V`, `--name V`, `-oV` and `-o V`. */
function optionValues(
  args: readonly string[],
  names: readonly string[],
): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    for (const n of names) {
      if (a === n) {
        const v = args[i + 1];
        if (v !== undefined) out.push(v);
        i += 1;
        break;
      }
      if (n.startsWith("--") ? a.startsWith(`${n}=`) : a.startsWith(n)) {
        const v = a.slice(n.length + (n.startsWith("--") ? 1 : 0));
        if (v.length > 0) out.push(v);
        break;
      }
    }
  }
  return out;
}

function firstPathOperand(args: readonly string[]): string[] {
  const first = args.find(
    (a) => a !== "--" && !(a.startsWith("-") && a.length > 1),
  );
  return first === undefined ? [] : [first];
}

function classifyCommandTiers(
  argv: readonly string[],
  opts?: ClassifyCommandOpts,
  depth = 0,
): Verdict {
  // Whether an expansion in this argv is LIVE (a shell will perform it). The
  // caller settles it, because quoting decides and only the caller still has
  // the raw text. `run_command` passes nothing: its argv is spawned with
  // shell:false and expands nothing at all.
  const live = opts?.unresolved === true;
  if (argv.length === 0) {
    return {
      kind: "block",
      code: "command_blocked",
      reason: "empty argv",
    };
  }
  const a0 = argv[0] as string;

  // PHASE 1 — block (direct argv)
  const direct = isCatastrophic(argv);
  if (direct.hit) {
    return {
      kind: "block",
      code: "command_blocked",
      reason: direct.reason,
    };
  }
  // PHASE 1 — block (shell-body re-entry, any known interpreter)
  const reentry = extractShellReentry(argv);
  if (reentry?.kind === "refused") {
    return {
      kind: "block",
      code: "command_blocked",
      reason: reentry.reason,
    };
  }
  if (reentry?.kind === "body") {
    const inside = classifyShellBody(reentry.body);
    if (inside.hit) {
      return {
        kind: "block",
        code: "command_blocked",
        reason: `${reentry.via} body: ${inside.reason}`,
      };
    }
  }

  // PHASE 2 — ASK destructive
  // Normalized identity, same reasoning as the block tier (audit BL1): a
  // path-qualified `/bin/rm -rf build/` must not slip past the destructive
  // ask into the cacheable, rule-eligible unknown class.
  const id = commandIdentity(a0);

  // PHASE 1b — WHAT IT HIDES (ADR 0075 step 1, 2026-10-09)
  //
  // The replay found obfuscated execution, downloads, persistence and
  // destruction all filed as `command_ask_unknown`: asked, so nothing ran
  // unseen, but the card read 「未识别的命令」, a project rule could be
  // offered, and a reviewer of the unknown class would have been handed
  // them. Three looks, each only ever ESCALATING:
  //   - a command whose text the harness cannot read at all is opaque;
  //   - a wrapper's command and a shell body are classified in their own
  //     right, and a dangerous class found there is the line's class;
  //   - running as another, higher user is a system change.
  const hidden = opaqueShape(id, argv, reentry);
  if (hidden !== null) {
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_opaque",
      reason: hidden,
    };
  }
  const inner = innerEscalation(argv, reentry, opts, depth);
  if (inner !== null) return inner;
  if (PRIVILEGE_WRAPPERS.has(id)) {
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_system",
      reason: `${id} runs ${argv.slice(1).join(" ")} with elevated privileges`,
    };
  }

  if (id === "rm" && hasRecursiveForce(argv)) {
    // Say where it reaches (2026-10-09): "inside repo" was printed for
    // `rm -rf ../shared-lib/dist` and `rm -rf "$TMPDIR/x"` too, on the card
    // and to the reviewer alike.
    const away = outsideOperand(argv, live);
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_destructive",
      reason:
        away === null
          ? `rm -rf inside the workspace: ${argv.slice(1).join(" ")}`
          : `rm -rf reaches outside the workspace, or a path the line does not resolve: ${away}`,
    };
  }
  const gitSub = id === "git" ? gitSubcommandIndex(argv) : null;
  const gitSubName = gitSub === null ? null : (argv[gitSub] as string);
  const gitSubArgs = gitSub === null ? [] : argv.slice(gitSub + 1);
  if (gitSubName === "reset" && gitSubArgs.includes("--hard")) {
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_destructive",
      reason: "git reset --hard",
      consequence: "discards_uncommitted",
    };
  }
  if (
    gitSubName === "clean" &&
    (gitSubArgs.includes("--force") || hasShortFlag(gitSubArgs, "f"))
  ) {
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_destructive",
      reason: "git clean -f deletes untracked files",
      consequence: "deletes_untracked",
    };
  }
  if (id === "git") {
    const destructiveGit = destructiveGitShape(argv);
    if (destructiveGit !== null) {
      return {
        kind: "ask",
        risk: "workspace_destructive",
        code: "command_ask_destructive",
        reason: destructiveGit.reason,
        consequence: destructiveGit.consequence,
      };
    }
  }
  if (id === "chmod") {
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_destructive",
      reason: `chmod: ${argv.slice(1).join(" ")}`,
    };
  }
  // Through exec-wrappers too (`sudo defaults write …`, `env osascript …`):
  // this class is never remembered, so peeling can only escalate the card.
  const peeled = peelExecWrappers(argv);
  const system =
    systemAlteringShape(id, argv) ??
    (peeled === null || peeled.length === 0
      ? null
      : systemAlteringShape(commandIdentity(peeled[0] as string), peeled));
  if (system !== null) {
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_system",
      reason: system,
    };
  }
  const container = containerShape(id, argv, live);
  if (container !== null) return container;
  const wipe = destructiveToolShape(id, argv);
  if (wipe !== null) {
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_destructive",
      reason: wipe,
    };
  }

  // PHASE 3 — ASK network
  if (a0 === "curl" || a0 === "wget") {
    // A fetch of the LOOPBACK address is the model poking the server it just
    // started, not the network (ADR 0064 L1; permission lab 2026-09-16: every
    // `curl` in the server briefs was `localhost:4642`). Allowed only when
    // every URL is loopback and every flag is one that neither reads nor
    // writes a file — anything else is the network ask it always was.
    if (loopbackFetchOnly(a0, argv, live)) return { kind: "allow" };
    return {
      kind: "ask",
      risk: "network",
      code: "command_ask_network",
      reason: `${a0} network call`,
    };
  }
  if (
    (a0 === "npm" || a0 === "pnpm") &&
    (argv[1] === "install" || argv[1] === "add" || argv[1] === "i")
  ) {
    return {
      kind: "ask",
      risk: "network",
      code: "command_ask_network",
      reason: `${a0} ${argv[1]}`,
    };
  }
  if (a0 === "pip" && argv[1] === "install") {
    return {
      kind: "ask",
      risk: "network",
      code: "command_ask_network",
      reason: "pip install",
    };
  }
  if (a0 === "cargo" && argv[1] === "install") {
    return {
      kind: "ask",
      risk: "network",
      code: "command_ask_network",
      reason: "cargo install",
    };
  }
  if (a0 === "go" && argv[1] === "install") {
    return {
      kind: "ask",
      risk: "network",
      code: "command_ask_network",
      reason: "go install",
    };
  }
  const fetchRun = downloadExecShape(id, argv);
  if (fetchRun !== null) {
    return {
      kind: "ask",
      risk: "network",
      code: "command_ask_download_exec",
      reason: fetchRun,
    };
  }
  const remote = networkShape(id, argv);
  if (remote !== null) {
    return {
      kind: "ask",
      risk: "network",
      code: "command_ask_network",
      reason: remote,
    };
  }

  // PHASE 4 — ASK workspace_write (redirection inside any shell body)
  if (reentry?.kind === "body" && /(?<!\\)>>?/.test(reentry.body)) {
    return {
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_write",
      reason: `${reentry.via} with redirection`,
    };
  }
  // `find`'s action predicates. This tested exactly two strings, so the four
  // siblings that also spawn a process or write a file were invisible and fell
  // through to the Phase-5 `find` allow: `-execdir` made find a general
  // arbitrary-program launcher with no card at all, and `-fprintf` overwrote
  // any file (red team 2026-08-24). Enumerating two members of a family is how
  // that family gets used.
  if (a0 === "find") {
    const action = argv.find((a) => FIND_ACTION_PREDICATES.has(a));
    if (action !== undefined) {
      return {
        kind: "ask",
        risk: "workspace_write",
        code: "command_ask_write",
        reason: `find with ${action} — it runs a command or writes a file for every match`,
      };
    }
  }

  // An allow-listed program carrying one of its own escape hatches is not the
  // program the allow tier was written for. Checked ONCE here, ahead of every
  // Phase-5 branch, so a new allow entry cannot forget it (red team
  // 2026-08-24: `git grep -Ocurl`, `git diff --output=/c/…/evil.bat`,
  // `git blame --contents ~/.ssh/id_rsa`, `rg --pre ./x.sh`,
  // `npm test --prefix ../evil`, `cargo test --config build.rustc-wrapper=…`,
  // `go test -exec 'sh -c …'`, `node --test --test-reporter ./r.mjs` —
  // all allow, all arbitrary execution or arbitrary file access).
  const hatch = escapeHatchFlag(
    argv,
    opts?.shell === true && opts.unresolved === true,
  );
  if (hatch !== null) {
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_opaque",
      reason: `${interpreterName(a0)} ${hatch} runs or loads something the harness cannot see — review it`,
    };
  }

  // ── PHASE 4b — AN ALLOW MUST BE EARNED (ADR 0045, the inversion) ──
  //
  // Everything past this point can return `allow`, which runs with NO approval
  // card at all. The tier therefore may only rest on tokens the classifier
  // actually READ. Three sweeps of this file found 83 ways to hand it a token
  // that was never read; the rule below stops the CLASS rather than the
  // instances — whatever the next unmodelled construct turns out to be, it
  // arrives as an ask instead of an allow.
  //
  // Only under a SHELL. `run_command` spawns an argv with shell:false, so a
  // `$HOME` in its arguments is the four literal characters and expands to
  // nothing — gating on it there would be a pure false positive.
  //
  // Deliberately not the block tier either: refusing outright would be
  // unappealable and these are honest shapes most of the time. The user sees
  // the verbatim command and decides.
  // The PROGRAM NAME is checked unconditionally, ahead of that gate. A glob
  // never sets `unresolved` — it needs no shell variable — so `/bin/r? -rf /`
  // skipped this and landed on the rule-eligible, cacheable
  // `command_ask_unknown` while its bare spelling blocked. Nothing legitimate
  // spells a program with `*`, `?` or a bracket class, and under shell:false
  // such a name simply does not exist, so there is no honest command to lose.
  const unresolvedHead = unresolvedProgramName(a0);
  if (unresolvedHead !== null) {
    return {
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_unresolved",
      reason: `the program name is ${unresolvedHead} — the harness cannot tell what would run`,
    };
  }
  if (opts?.shell === true && opts.unresolved === true) {
    if (
      !ARG_INDEPENDENT_PROGRAMS.has(interpreterName(a0)) &&
      hasUnresolvedExpansion(argv)
    ) {
      return {
        kind: "ask",
        risk: "workspace_read",
        code: "command_ask_unresolved",
        reason:
          "an argument expands to something the harness cannot read, so it cannot vouch for what this touches",
      };
    }
  }

  // PHASE 5 — ALLOW
  if (
    (a0 === "npm" || a0 === "pnpm") &&
    (argv[1] === "test" ||
      (argv[1] === "run" && (argv[2] === "test" || argv[2] === "lint")))
  ) {
    return { kind: "allow" };
  }
  // The node test runner and version queries (permission lab 2026-08-17):
  // `node --test test/` was 12 of 65 asks in 15 briefs — the 极简 model runs
  // tests through node directly, not `npm test`, and each run prompted as
  // 「解释器执行脚本」. It runs the workspace's test files the way `npm test`
  // does (which is allowed); the arbitrary-code shapes (`-e`/`--eval`/`-p`/
  // `--print`, an `--import`/`-r` preload, a script path) stay asks.
  // `node --version` / `npm -v` execute nothing.
  // The deny regex below is anchored at `^` against LITERAL tokens, so an
  // expansion that produces `-r` (`${x:--r}`, `{-r,./evil.cjs}`) walks past it
  // and node preloads the module — arbitrary code, zero cards (red team round
  // 3). An argv this branch cannot read literally is one it cannot clear.
  if (
    (a0 === "node" || a0 === "nodejs") &&
    argv[1] === "--test" &&
    !(opts?.unresolved === true && hasUnresolvedExpansion(argv)) &&
    !argv.some((a) =>
      /^(-e|--eval|-p|--print|--import|-r|--require|--loader|--experimental-loader)(=|$)/.test(
        a,
      ),
    )
  ) {
    return readerArgvGuard(argv, live) ?? { kind: "allow" };
  }
  if (
    ["node", "nodejs", "npm", "pnpm", "npx", "git"].includes(a0) &&
    argv.length === 2 &&
    (argv[1] === "--version" || argv[1] === "-v" || argv[1] === "-V")
  ) {
    return { kind: "allow" };
  }
  // `node --check <file>` parses without executing (the model's syntax
  // check after a write) — a read, guarded like one.
  if (
    (a0 === "node" || a0 === "nodejs") &&
    (argv[1] === "--check" || argv[1] === "-c") &&
    argv.length === 3
  ) {
    return readerArgvGuard(argv, live) ?? { kind: "allow" };
  }
  // Read-only process / port listings — the server-flow briefs check whether
  // the thing they started is up and which pid owns the port; today's
  // 「未识别的命令」 on `ps aux | grep` / `netstat -ano` was noise. None of
  // these change anything; the KILLING commands are classified below.
  if (
    [
      "ps",
      "pgrep",
      "netstat",
      "ss",
      "tasklist",
      "lsof",
      "uptime",
      "df",
      "free",
      "uname",
      "which",
      "where",
    ].includes(a0)
  ) {
    // The one allow branch written without a reader guard, so `where /R
    // C:\Users\victim *.pem` enumerated a stranger's private keys unprompted
    // (red team 2026-08-24). Name disclosure is the same class find's
    // `-L`/`-follow` ask already exists for.
    return readerArgvGuard(argv, live) ?? { kind: "allow" };
  }
  // These three ran the workspace's tests — as long as the operands ARE the
  // workspace. Each was an unconditional allow with no path check at all, so
  // `pytest ../evil` imported and executed arbitrary Python from outside it,
  // and cargo/go compiled and ran an out-of-tree manifest.
  if (a0 === "pytest") return readerArgvGuard(argv, live) ?? { kind: "allow" };
  if (
    a0 === "cargo" &&
    (argv[1] === "test" || argv[1] === "build" || argv[1] === "check")
  ) {
    return readerArgvGuard(argv, live) ?? { kind: "allow" };
  }
  if (a0 === "go" && argv[1] === "test") {
    return readerArgvGuard(argv, live) ?? { kind: "allow" };
  }
  // git pointed at a repository elsewhere (2026-10-09): `-C ../other`,
  // `--git-dir`, `--work-tree` outside the workspace. Every subcommand below
  // would otherwise be judged as if it acted on this repository — `vcs`,
  // which trust answers with no card.
  if (gitSub !== null) {
    const elsewhere = gitRepoElsewhere(argv.slice(1, gitSub), live);
    if (elsewhere !== null) return outsideAsk("git", elsewhere);
  }
  // `git config` that only READS (ADR 0064 L1): `--get`/`--list` forms, or a
  // bare key. A value operand, an unset/add/edit flag, or a `--file`/`--blob`
  // source is a write or a read of somewhere else, judged next.
  if (a0 === "git" && gitSubName === "config" && gitConfigReads(gitSubArgs)) {
    return { kind: "allow" };
  }
  if (gitSubName === "config") {
    const config = gitConfigVerdict(gitSubArgs, live);
    if (config !== null) return config;
  }
  if (
    a0 === "git" &&
    typeof argv[1] === "string" &&
    [
      "status",
      "diff",
      "log",
      "show",
      "branch",
      "rev-parse",
      "ls-files",
      "grep",
      "blame",
      "stash", // only `git stash list` / `show` — see below
    ].includes(argv[1])
  ) {
    // `git diff --no-index <p1> <p2>` is git's arbitrary-filesystem compare —
    // it works outside any repo and, against /dev/null, prints a whole file
    // verbatim. That is a zero-prompt read of ANY path (credentials, out of
    // repo) the reader guard cannot see (git is not a reader). ASK: the
    // displayed paths are visible, so the user can knowingly approve/deny
    // (audit T3.4 review). Regular git diff/show stay repo-confined → allow.
    if (argv[1] === "diff" && argv.includes("--no-index")) {
      return {
        kind: "ask",
        risk: "workspace_read",
        code: "command_ask_reader_path",
        reason:
          "git diff --no-index reads arbitrary filesystem paths — review the targets",
      };
    }
    // `git grep` searches TRACKED files (the index / working tree of what is
    // committed) — the same confinement `git show` has, and the search the
    // 极简 model should reach for over `grep -r` (which asks: it can read an
    // ignored .env). Its escape hatches ask: `--no-index` (whole tree),
    // `--untracked` / `--no-exclude-standard` (ignored files back in).
    if (
      argv[1] === "grep" &&
      argv.some(
        (a) =>
          a === "--no-index" ||
          a === "--untracked" ||
          a === "--no-exclude-standard",
      )
    ) {
      return {
        kind: "ask",
        risk: "workspace_read",
        code: "command_ask_recursive_read",
        reason:
          "git grep outside the tracked set can read ignored/untracked files — prefer plain git grep",
      };
    }
    // `git stash` mutates unless it is `list` / `show`.
    if (argv[1] === "stash" && !(argv[2] === "list" || argv[2] === "show")) {
      return {
        kind: "ask",
        risk: "workspace_write",
        code: "command_ask_vcs",
        reason: `git ${argv.slice(1, 3).join(" ")} changes the working tree`,
      };
    }
    // `git branch` LISTS (no operand, or the query flags); a name operand
    // creates, and -d/-D/-m/-M/-c/-C/-u… mutate.
    if (argv[1] === "branch") {
      const rest = argv.slice(2);
      const mutatingFlag = rest.some((a) =>
        /^-[dDmMcCu]$|^--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|track)(=|$)/.test(
          a,
        ),
      );
      const queryFlag = rest.some((a) =>
        /^(-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--sort=.*|--format=.*)$/.test(
          a,
        ),
      );
      const positional = rest.some((a) => !a.startsWith("-"));
      if (mutatingFlag || (positional && !queryFlag)) {
        return {
          kind: "ask",
          risk: "workspace_write",
          code: "command_ask_vcs",
          reason: `git branch ${rest.join(" ")} changes branches`,
        };
      }
    }
    return { kind: "allow" };
  }
  // Every other git subcommand changes the repository or the working tree
  // (commit, add, checkout, switch, merge, rebase, mv, rm, tag, push, pull,
  // fetch, cherry-pick, revert, apply, restore, …). The harness KNOWS it is
  // git; 「未识别的命令」 read as ignorance on the card (permission lab
  // 2026-08-17: git lines were 3 of the 14 unknowns). Same tier, same
  // rule-eligibility as unknown (`git commit:*` project rules still derive),
  // an honest class. Network-touching subcommands are still git (the remote
  // is the repo's own); the destructive shapes were classified above.
  // The subcommands that reach the REMOTE are the network, not the working
  // tree (ADR 0064 L1): a push that leaves the machine is not a change the
  // working tree keeps, and must not be scored as one. The destructive
  // shapes (`push --force`, history rewrites) were classified above.
  if (
    a0 === "git" &&
    gitSubName !== null &&
    reachesRemote(gitSubName, gitSubArgs)
  ) {
    return {
      kind: "ask",
      risk: "network",
      code: "command_ask_network",
      reason: `git ${gitSubName} reaches the remote`,
    };
  }
  if (a0 === "git" && typeof argv[1] === "string") {
    return {
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_vcs",
      reason: `git ${argv[1]} changes the repository`,
      // A plain `git commit` (or `--continue`) mid-merge/rebase concludes
      // the user's half-finished operation — the card should say so
      // (ADR 0049 §5; note only, the tier is unchanged).
      ...(concludesInProgressOperation(argv, opts)
        ? { consequence: "concludes_in_progress_operation" as const }
        : {}),
    };
  }
  if (a0 === "grep" || a0 === "rg" || a0 === "ripgrep") {
    return (
      recursiveContentRead(argv) ??
      readerArgvGuard(argv, live) ?? { kind: "allow" }
    );
  }
  if (a0 === "find") {
    // `-L`/`-follow` dereference symlinks during traversal, so `find` escapes
    // the repo through an in-workspace directory symlink and discloses
    // out-of-workspace/credential file NAMES — the operand-only reader guard
    // never sees the walked tree (audit T3.4 review). ASK (the flag is
    // visible in the command).
    if (argv.includes("-L") || argv.includes("-follow")) {
      return {
        kind: "ask",
        risk: "workspace_read",
        code: "command_ask_reader_path",
        reason:
          "find -L/-follow dereferences symlinks during traversal, escaping the workspace guard",
      };
    }
    return readerArgvGuard(argv, live) ?? { kind: "allow" };
  }
  const filter = textFilterVerdict(argv, live);
  if (filter !== null) return filter;
  if (
    [
      "ls",
      "cat",
      "head",
      "tail",
      "wc",
      "echo",
      "printf",
      "true",
      "false",
      "pwd",
      "date",
      "whoami",
      // Plain readers the lab kept filing as unknown (ADR 0064 L1): dumps,
      // checksums, metadata, and string filters. `file` and `xxd` carry
      // escape hatches (`file -C` compiles a magic file, `xxd -r` writes)
      // that ESCAPE_HATCH_FLAGS turns into asks ahead of this branch.
      "od",
      "hexdump",
      "xxd",
      "file",
      "stat",
      "du",
      "md5sum",
      "sha1sum",
      "sha256sum",
      "tac",
      "rev",
      "paste",
      "comm",
      "basename",
      "dirname",
    ].includes(a0)
  ) {
    return readerArgvGuard(argv, live) ?? { kind: "allow" };
  }

  // PHASE 6 — DEFAULT
  // The shapes the lab kept filing under 「未识别的命令」 that the harness can
  // name (ADR 0064 L1): `diff` and `npm ls` are reads; `tee` and `sed -i`
  // are writes to the files they name; `npm run <script>` is a project
  // script; a `./bin/x` is a workspace program. A named class is an honest
  // card today and the unit the trust tier can cover tomorrow.
  const named = namedProgramVerdict(id, argv, live);
  if (named !== null) return named;

  // Known script interpreters get an HONEST ask class before the generic
  // fallback (owner 2026-08-04): `node src/index.mjs` is not "unrecognized" —
  // the harness knows exactly what it is, and asks because an interpreter
  // executes code the argv only names indirectly. The distinct code lets the
  // approval surface say so (and gates project-rule derivation, ADR 0030)
  // instead of the prompt reading as ignorance. Same ask tier, same risk —
  // only the classification is more truthful.
  //
  // Three shapes since ADR 0064, because the trust tier covers only the
  // first: a WORKSPACE script (`node src/cli.mjs`), whose code the record's
  // diffs track; INLINE code (`node -e …`, `python -`, `python -m x`), which
  // no diff ever showed; and a script OUTSIDE the workspace.
  if (SCRIPT_INTERPRETERS.has(interpreterName(a0))) {
    const shape = interpreterShape(argv, live);
    if (shape.kind === "inline") {
      // `-m` names a module, not code (2026-10-09): `python -m build` read
      // as "inline code".
      const m = argv.indexOf("-m");
      return {
        kind: "ask",
        risk: "workspace_write",
        code: "command_ask_interpreter_inline",
        reason:
          m > 0 && argv[m + 1] !== undefined
            ? `${a0} -m runs the module ${argv[m + 1]}, whose code the record never showed — review it`
            : `${a0} runs inline code the record never showed — review it`,
      };
    }
    if (shape.kind === "outside") {
      return outsideAsk(a0, shape.script);
    }
    return {
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_interpreter",
      reason: `${a0} executes a script — review the script path and arguments`,
    };
  }
  // Honest classes for the plain filesystem and process verbs (permission
  // lab 2026-08-17: `rm -f notes.json`, `mkdir -p scripts`, `kill 574` were
  // 「未识别的命令」 — the harness knows exactly what they are). Same tier,
  // same risk as before; the card can say what the line does, and the
  // rule/cache layers key on the code:
  //   - delete (rm / rmdir / unlink, the non-recursive-force shapes — `-rf`
  //     was classified destructive above): NOT rule-eligible, like write.
  //   - process (kill / pkill / killall / taskkill): NOT rule-eligible.
  //   - fs (mkdir / touch / cp / mv / ln / rename): rule-eligible exactly as
  //     unknown was, so nothing that could be persisted before cannot now.
  // The filesystem verbs split on WHERE they act (ADR 0064 L1): an operand
  // outside the workspace — absolute, `..`, `~`, or unknowable under a live
  // shell — is its own class, so `cp secrets /tmp/x` is never scored as a
  // workspace-local copy on the strength of `cp` being "fs".
  const cmdDelete = cmdDeleteShape(id, argv, live);
  if (cmdDelete !== null) return cmdDelete;
  if (id === "rm" || id === "rmdir" || id === "unlink") {
    const out = outsideOperand(argv, live);
    if (out !== null) return outsideAsk(id, out);
    return {
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_delete",
      reason: `${id} deletes: ${argv.slice(1).join(" ")}`,
    };
  }
  if (["kill", "pkill", "killall", "taskkill"].includes(id)) {
    return {
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_process",
      reason: `${id} ends processes: ${argv.slice(1).join(" ")}`,
    };
  }
  if (["mkdir", "touch", "cp", "mv", "ln", "rename"].includes(id)) {
    const out = outsideOperand(argv, live);
    if (out !== null) return outsideAsk(id, out);
    return {
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_fs",
      reason: `${id}: ${argv.slice(1).join(" ")}`,
    };
  }
  // A program that lives IN the workspace — `./bin/x`, `scripts/run.sh` —
  // named by a relative path with a separator and no escape. The harness
  // knows what it is (a file the record's diffs track) even if not what it
  // does; rule-eligible like an interpreter script (ADR 0064 L1).
  if (isWorkspaceLocalProgram(a0, live)) {
    return {
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_local_exec",
      reason: `runs a workspace program: ${a0}`,
    };
  }
  return {
    kind: "ask",
    risk: "workspace_write",
    code: "command_ask_unknown",
    reason: "unrecognized command — review carefully",
  };
}

// ───────────────────────── ADR 0064 L1 helpers ─────────────────────────

/** A path operand that leaves the workspace: absolute, home, drive, a `..`
 *  escape, or — under a live shell — one the harness cannot read. In the
 *  bash lane in-workspace absolute paths were relativized before this, so
 *  an absolute here IS outside; run_command's argv is not relativized, so
 *  there an in-workspace absolute path asks under this class too (an
 *  honest ask, a less precise label). */
function escapesWorkspaceOperand(a: string, live: boolean): boolean {
  if (a.includes("__SUBST__")) return true;
  if (live && /[$`]/.test(a)) return true;
  // cmd's own expansion (`%TEMP%\x`, `%USERPROFILE%`, `%ProgramFiles(x86)%`):
  // a place the harness cannot resolve from the line (2026-10-09).
  if (/%[A-Za-z_][\w()]*%/.test(a)) return true;
  if (/^([A-Za-z]:|[\\/]|~)/.test(a)) return true;
  return a === ".." || a.includes("../") || a.includes("..\\") || a === "...";
}

/** The first non-flag operand that escapes the workspace, or null. */
function outsideOperand(argv: readonly string[], live: boolean): string | null {
  for (const a of argv.slice(1)) {
    if (a === "--") continue;
    if (a.startsWith("-") && a.length > 1) continue;
    if (escapesWorkspaceOperand(a, live)) return a;
  }
  return null;
}

/** A cmd switch: `/s`, `/q`, `/a:h`. */
const CMD_SWITCH = /^\/[A-Za-z?](?::\S*)?$/;

/**
 * cmd's own delete commands, as a cmd body runs them (2026-10-09): `del` /
 * `erase` delete files, `rd` — and `rmdir` given a cmd switch — directories.
 * They were `unknown`, so `cmd //c "del /s /q %TEMP%\*"` read as
 * unrecognised. Judged like `rm`: a target the line cannot place inside the
 * workspace (absolute, `..`, `%TEMP%`) is outside; `/s` reaches the whole
 * tree beneath, rm -rf's class; anything else is a delete. The catastrophic
 * targets (`rd /s /q C:\`) blocked before this.
 */
function cmdDeleteShape(
  id: string,
  argv: readonly string[],
  live: boolean,
): Verdict | null {
  const args = argv.slice(1);
  const cmdForm =
    id === "del" ||
    id === "erase" ||
    id === "rd" ||
    (id === "rmdir" && args.some((a) => CMD_SWITCH.test(a)));
  if (!cmdForm) return null;
  const targets = args.filter((a) => !CMD_SWITCH.test(a));
  const out = targets.find((t) => escapesWorkspaceOperand(t, live));
  if (out !== undefined) return outsideAsk(id, out);
  if (args.some((a) => a.toLowerCase() === "/s")) {
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_destructive",
      reason: `${id} /s deletes through the whole tree: ${targets.join(" ")}`,
    };
  }
  return {
    kind: "ask",
    risk: "workspace_write",
    code: "command_ask_delete",
    reason: `${id} deletes: ${targets.join(" ")}`,
  };
}

function outsideAsk(program: string, operand: string): Verdict {
  return {
    kind: "ask",
    risk: "workspace_write",
    code: "command_ask_outside",
    reason: `${program} touches a path outside the workspace: ${operand}`,
  };
}

/** `./x`, `bin/x`, `scripts/run.sh`: a relative path WITH a separator that
 *  stays inside the workspace. A bare word is a PATH lookup (unknown); an
 *  absolute path or a `..` is outside; an expansion is unresolvable. */
function isWorkspaceLocalProgram(a0: string, live: boolean): boolean {
  if (!/[\\/]/.test(a0)) return false;
  if (escapesWorkspaceOperand(a0, live)) return false;
  return !/[*?[\]{}$`]/.test(a0);
}

/** Flags of curl that neither read nor write a file. Fail closed: a flag not
 *  here (or one that takes a file) keeps the network ask. */
const CURL_INERT_FLAGS: ReadonlySet<string> = new Set([
  "-s",
  "--silent",
  "-S",
  "--show-error",
  "-i",
  "--include",
  "-I",
  "--head",
  "-L",
  "--location",
  "-f",
  "--fail",
  "--fail-with-body",
  "-v",
  "--verbose",
  "-N",
  "--no-buffer",
  "-k",
  "--insecure",
  "--compressed",
  "-4",
  "-6",
  "-g",
  "--globoff",
  "--http1.1",
  "--http2",
  "--no-progress-meter",
]);
/** curl flags whose VALUE is inline text (never a file). `-d @file`,
 *  `--cookie file`, `-F name=@file` and every output/upload/config flag are
 *  deliberately absent — the value must not name a file. */
const CURL_INERT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-X",
  "--request",
  "-H",
  "--header",
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "--json",
  "-w",
  "--write-out",
  "-m",
  "--max-time",
  "--connect-timeout",
  "--retry",
  "--retry-delay",
  "--retry-all-errors",
  "-A",
  "--user-agent",
  "-e",
  "--referer",
  "-u",
  "--user",
]);
const WGET_INERT_FLAGS: ReadonlySet<string> = new Set([
  "-q",
  "--quiet",
  "-nv",
  "--no-verbose",
  "-S",
  "--server-response",
  "--spider",
  "-4",
  "-6",
  "--no-check-certificate",
]);
const WGET_INERT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-t",
  "--tries",
  "-T",
  "--timeout",
  "--method",
  "--header",
  "--post-data",
  "--body-data",
  "--user-agent",
  "-U",
]);
const LOOPBACK_URL =
  /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i;

/**
 * Every URL the command names is loopback and every flag is one of the
 * inert ones: a local smoke test. A value that could be a FILE (`@…`, a
 * cookie file, `-o`), a URL the harness cannot read (an expansion), or a
 * flag it does not know all fall through to the network ask.
 */
function loopbackFetchOnly(
  a0: string,
  argv: readonly string[],
  live: boolean,
): boolean {
  const inert = a0 === "curl" ? CURL_INERT_FLAGS : WGET_INERT_FLAGS;
  const inertValue =
    a0 === "curl" ? CURL_INERT_VALUE_FLAGS : WGET_INERT_VALUE_FLAGS;
  let urls = 0;
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (live && /[$`]/.test(a)) return false;
    if (a.includes("__SUBST__")) return false;
    if (a === "--") continue;
    if (a.startsWith("-") && a.length > 1) {
      // `--flag=value` and `-Xvalue` spellings.
      const eq = a.indexOf("=");
      const name = eq > 0 && a.startsWith("--") ? a.slice(0, eq) : a;
      if (inert.has(name)) continue;
      // A bundle of short flags (`-sS`, `-sSL`, `-si`): every letter must be
      // an inert flag of its own; a value-taking letter in a bundle is not
      // modelled and fails closed.
      if (/^-[a-zA-Z]{2,}$/.test(a)) {
        if ([...a.slice(1)].every((ch) => inert.has(`-${ch}`))) continue;
        return false;
      }
      if (inertValue.has(name)) {
        const value =
          eq > 0 && a.startsWith("--") ? a.slice(eq + 1) : argv[++i];
        if (value === undefined || value.startsWith("@")) return false;
        continue;
      }
      // wget's `-O -` (stdout) is inert; `-O file` is a write.
      if (a0 === "wget" && (a === "-O" || a === "--output-document")) {
        if (argv[i + 1] === "-") {
          i += 1;
          continue;
        }
        return false;
      }
      if (a0 === "wget" && a === "-O-") continue;
      // curl's `-o /dev/null` (the status-code idiom, with `-w`) discards the
      // body; any other output target is a file write.
      if (a0 === "curl" && (a === "-o" || a === "--output")) {
        if (/^(\/dev\/null|NUL|nul)$/.test(argv[i + 1] ?? "")) {
          i += 1;
          continue;
        }
        return false;
      }
      return false;
    }
    if (!LOOPBACK_URL.test(a)) return false;
    urls += 1;
  }
  return urls > 0;
}

const GIT_CONFIG_READ_FLAGS: ReadonlySet<string> = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--list",
  "-l",
  "--global",
  "--local",
  "--system",
  "--worktree",
  "--show-origin",
  "--show-scope",
  "--name-only",
  "--type",
  "--bool",
  "--int",
  "--null",
  "-z",
]);

/** `git config` arguments that only read: read flags plus at most one bare
 *  operand (the key). Anything else — a second operand (a value), an
 *  editing flag, another file — is not a read. */
function gitConfigReads(subArgs: readonly string[]): boolean {
  let operands = 0;
  let listing = false;
  for (const a of subArgs) {
    if (a.startsWith("-")) {
      const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      if (!GIT_CONFIG_READ_FLAGS.has(name)) return false;
      if (name === "--list" || name === "-l") listing = true;
      continue;
    }
    operands += 1;
  }
  return listing ? operands === 0 : operands === 1;
}

/** The first of git's repository-selecting global options (`-C`,
 *  `--git-dir`, `--work-tree`, as `--opt V` or `--opt=V`) whose value leaves
 *  the workspace, or null. `globals` is argv between `git` and the
 *  subcommand. */
function gitRepoElsewhere(
  globals: readonly string[],
  live: boolean,
): string | null {
  for (let i = 0; i < globals.length; i += 1) {
    const a = globals[i] as string;
    let value: string | undefined;
    if (a === "-C" || a === "--git-dir" || a === "--work-tree") {
      value = globals[i + 1];
      i += 1;
    } else if (a.startsWith("--git-dir=") || a.startsWith("--work-tree=")) {
      value = a.slice(a.indexOf("=") + 1);
    }
    if (value !== undefined && escapesWorkspaceOperand(value, live))
      return value;
  }
  return null;
}

/**
 * Repo-local `git config` keys whose value is data, not a command git runs
 * later (2026-10-09). Fail closed: any other key — `core.hooksPath`,
 * `core.fsmonitor`, `core.sshCommand`, `core.pager`, `core.editor`,
 * `alias.*`, `filter.*`, `diff.*.textconv`, `merge.*.driver`,
 * `credential.helper`, `include.path`, `http.sslVerify`, … — asks as
 * `command_ask_git_internals`. Section and variable names are
 * case-insensitive in git.
 */
const GIT_CONFIG_INERT_KEY =
  /^(?:user\.(?:name|email|signingkey)|core\.(?:autocrlf|eol|filemode|ignorecase|quotepath|safecrlf|longpaths|symlinks|precomposeunicode|whitespace|abbrev)|init\.defaultbranch|pull\.(?:rebase|ff)|push\.(?:default|autosetupremote|followtags)|fetch\.(?:prune|prunetags)|merge\.(?:ff|conflictstyle)|rebase\.(?:autosquash|autostash|updaterefs)|commit\.(?:gpgsign|verbose)|tag\.gpgsign|gpg\.format|log\.(?:date|decorate)|diff\.(?:renames|algorithm|colormoved|mnemonicprefix)|status\.(?:short|branch|showuntrackedfiles)|branch\.\S+\.(?:remote|merge|rebase|pushremote|description)|remote\.\S+\.(?:url|pushurl|fetch|push|prune|tagopt)|submodule\.\S+\.(?:url|path|branch)|color\.\S+|advice\.\S+|i18n\.\S+)$/i;

/** `git config` options that take a value (`--opt V` or `--opt=V`). */
const GIT_CONFIG_VALUE_OPTS: ReadonlySet<string> = new Set([
  "-f",
  "--file",
  "--blob",
  "--type",
  "--default",
  "--comment",
  "--value",
]);
const GIT_CONFIG_READ_MODES: ReadonlySet<string> = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--get-color",
  "--get-colorbool",
  "--list",
  "-l",
]);
const GIT_CONFIG_INERT_OPTS: ReadonlySet<string> = new Set([
  "--global",
  "--system",
  "--local",
  "--worktree",
  "--add",
  "--replace-all",
  "--show-origin",
  "--show-scope",
  "--name-only",
  "--null",
  "-z",
  "--bool",
  "--int",
  "--bool-or-int",
  "--path",
  "--expiry-date",
  "--no-type",
  "--includes",
  "--no-includes",
  "--fixed-value",
  "--all",
  "--regexp",
  "--url",
]);

/** A `git config` call, parsed for what it would change. Fail closed: an
 *  option it does not know makes the call a `rewrite`. */
interface GitConfigCall {
  read: boolean;
  scope: "global" | "system" | "local";
  file: string | null;
  key: string | null;
  removes: boolean;
  /** `--edit`, `--rename-section`, or an unknown option: changes the line
   *  does not name. */
  rewrites: boolean;
}

function parseGitConfig(subArgs: readonly string[]): GitConfigCall {
  const call: GitConfigCall = {
    read: false,
    scope: "local",
    file: null,
    key: null,
    removes: false,
    rewrites: false,
  };
  let readMode = false;
  let writeMode = false;
  const operands: string[] = [];
  for (let i = 0; i < subArgs.length; i += 1) {
    const a = subArgs[i] as string;
    if (a === "--") {
      operands.push(...subArgs.slice(i + 1));
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      operands.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (GIT_CONFIG_VALUE_OPTS.has(name)) {
      const value = name === a ? subArgs[i + 1] : a.slice(eq + 1);
      if (name === a) i += 1;
      if (name === "-f" || name === "--file") call.file = value ?? "";
      continue;
    }
    if (name === "--global") call.scope = "global";
    else if (name === "--system") call.scope = "system";
    if (GIT_CONFIG_READ_MODES.has(name)) readMode = true;
    else if (
      name === "--unset" ||
      name === "--unset-all" ||
      name === "--remove-section"
    ) {
      call.removes = true;
      writeMode = true;
    } else if (
      name === "--edit" ||
      name === "-e" ||
      name === "--rename-section"
    ) {
      call.rewrites = true;
      writeMode = true;
    } else if (name === "--add" || name === "--replace-all") writeMode = true;
    else if (!GIT_CONFIG_INERT_OPTS.has(name)) call.rewrites = true;
  }
  // git 2.46's subcommand form: `git config set|unset|get|list|edit …`.
  const sub = operands[0];
  if (
    sub !== undefined &&
    [
      "set",
      "unset",
      "get",
      "list",
      "edit",
      "rename-section",
      "remove-section",
    ].includes(sub)
  ) {
    if (sub === "get" || sub === "list") call.read = !writeMode;
    if (sub === "unset" || sub === "remove-section") call.removes = true;
    if (sub === "edit" || sub === "rename-section") call.rewrites = true;
    if (sub === "set") call.key = operands[1] ?? null;
    return call;
  }
  call.key = operands[0] ?? null;
  call.read =
    !writeMode && !call.rewrites && (readMode || operands.length <= 1);
  return call;
}

/**
 * What a `git config` call that is not a plain read changes (2026-10-09),
 * or null to leave it the `vcs` it was:
 *   - `--file`/`-f` outside the workspace → outside (a write — or a read —
 *     of any file, in config form);
 *   - `--global` / `--system` writes → system: the user's (or every user's)
 *     git settings, read by every repository, `core.hooksPath` included;
 *   - a repo-local key that is a command git runs later, or loads more
 *     config, and `--edit` / `--rename-section` → git internals.
 * Removing a key, and setting one that is data, stay vcs.
 */
function gitConfigVerdict(
  subArgs: readonly string[],
  live: boolean,
): Verdict | null {
  const c = parseGitConfig(subArgs);
  if (
    c.file !== null &&
    (c.file === "" || escapesWorkspaceOperand(c.file, live))
  )
    return outsideAsk("git config", c.file === "" ? "--file" : c.file);
  if (c.read) return null;
  if (c.scope === "global" || c.scope === "system") {
    return {
      kind: "ask",
      risk: "workspace_destructive",
      code: "command_ask_system",
      reason:
        c.scope === "global"
          ? "git config --global changes the user's git settings, which every repository reads"
          : "git config --system changes the machine's git settings, which every user's repositories read",
    };
  }
  if (c.rewrites) {
    return gitInternalsAsk(
      "git config changes keys the line does not name — one may be a command git runs later",
    );
  }
  if (c.removes || c.key === null) return null;
  if (GIT_CONFIG_INERT_KEY.test(c.key)) return null;
  return gitInternalsAsk(
    `git config ${c.key} sets something git runs or loads later — the line does not show what will run`,
  );
}

/** git subcommands that reach the remote (ADR 0064 L1) — the network tier. */
function reachesRemote(sub: string, subArgs: readonly string[]): boolean {
  if (["push", "fetch", "pull", "clone", "ls-remote"].includes(sub))
    return true;
  if (sub === "remote") {
    return subArgs.some((a) => a === "update" || a === "prune");
  }
  if (sub === "submodule") {
    return subArgs.some((a) => a === "update" || a === "add" || a === "sync");
  }
  return false;
}

/** Interpreter flags that carry CODE (or select a module) rather than name
 *  a workspace script. */
const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-c",
  "--command",
  "-m",
  "-i",
  "--interactive",
  "--input-type",
  "-",
]);

/** How an interpreter invocation names what it runs (ADR 0064 L1). */
function interpreterShape(
  argv: readonly string[],
  live: boolean,
):
  | { kind: "script"; script: string }
  | { kind: "outside"; script: string }
  | { kind: "inline" } {
  const name = interpreterName(argv[0] as string);
  let i = 1;
  // deno / bun take a SUBCOMMAND first: `deno run x.ts`, `bun test`.
  if ((name === "deno" || name === "bun") && argv.length > 1) {
    const sub = argv[1] as string;
    if (["eval", "repl", "x", "exec"].includes(sub)) return { kind: "inline" };
    if (["run", "test"].includes(sub)) i = 2;
  }
  for (; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === "--") {
      i += 1;
      break;
    }
    const flag =
      a.startsWith("--") && a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (INLINE_CODE_FLAGS.has(flag)) return { kind: "inline" };
    if (a.startsWith("-") && a.length > 1) continue;
    break;
  }
  const script = argv[i];
  if (script === undefined) return { kind: "inline" }; // a REPL
  if (escapesWorkspaceOperand(script, live)) {
    return { kind: "outside", script };
  }
  return { kind: "script", script };
}

/** A sed script made only of line-address substitutions, deletes and prints
 *  — the shapes that touch nothing but the addressed file. The `e` flag or
 *  command (runs the pattern space!), `w`/`W`/`r`/`R` file commands, `-f`
 *  script files and any spelling this cannot parse stay unknown. */
const SED_ADDR = "(?:\\d+|\\$|/(?:\\\\.|[^/])*/)";
const SED_SAFE_COMMAND = new RegExp(
  `^\\s*(?:${SED_ADDR}(?:,${SED_ADDR})?\\s*)?(?:s/(?:\\\\.|[^/])*/(?:\\\\.|[^/])*/[gipI0-9]*|y/(?:\\\\.|[^/])*/(?:\\\\.|[^/])*/|d|p)\\s*$`,
);
function isSafeSedScript(script: string): boolean {
  // Split on `;` only where it is not inside an s/// body: a body may hold a
  // `;`, and then the split produces a piece the regex refuses — which is
  // the safe direction (the command stays unknown).
  return script.split(";").every((piece) => SED_SAFE_COMMAND.test(piece));
}

/** The lab's recurring 「未识别的命令」 shapes, named (ADR 0064 L1). Null
 *  when `argv` is none of them. */
function namedProgramVerdict(
  id: string,
  argv: readonly string[],
  live: boolean,
): Verdict | null {
  const writeAsk = (files: readonly string[], what: string): Verdict => {
    for (const f of files) {
      if (escapesWorkspaceOperand(f, live)) return outsideAsk(id, f);
    }
    return {
      kind: "ask",
      risk: "workspace_write",
      code: "command_ask_write",
      reason: `${what} ${files.join(", ")}`,
    };
  };
  if (id === "diff") {
    return readerArgvGuard(argv, live) ?? { kind: "allow" };
  }
  if (id === "tee") {
    const files = argv
      .slice(1)
      .filter((a) => !(a.startsWith("-") && a.length > 1));
    if (files.length === 0) return { kind: "allow" }; // stdout only
    return writeAsk(files, "tee writes");
  }
  if (id === "sed") {
    const inPlace = argv
      .slice(1)
      .some(
        (a) =>
          a === "--in-place" ||
          a.startsWith("--in-place=") ||
          /^-[a-zA-Z]*i/.test(a),
      );
    if (!inPlace) return null;
    const scripts: string[] = [];
    const files: string[] = [];
    for (let i = 1; i < argv.length; i += 1) {
      const a = argv[i] as string;
      if (a === "-e" || a === "--expression") {
        const s = argv[++i];
        if (s === undefined) return null;
        scripts.push(s);
        continue;
      }
      if (a.startsWith("--expression=")) {
        scripts.push(a.slice("--expression=".length));
        continue;
      }
      if (a === "-f" || a === "--file" || a.startsWith("--file=")) return null;
      if (a === "--") {
        files.push(...argv.slice(i + 1));
        break;
      }
      if (a.startsWith("-") && a.length > 1) continue;
      if (scripts.length === 0) scripts.push(a);
      else files.push(a);
    }
    // An empty operand is not a file the harness can name — stay unknown.
    if (scripts.length === 0 || files.length === 0) return null;
    if (files.some((f) => f.trim().length === 0)) return null;
    if (!scripts.every(isSafeSedScript)) return null;
    return writeAsk(files, "sed -i edits");
  }
  if (id === "npm" || id === "pnpm" || id === "yarn") {
    const sub = argv[1];
    if (sub === "ls" || sub === "list" || sub === "ll") {
      return readerArgvGuard(argv, live) ?? { kind: "allow" };
    }
    if (sub === "run" || sub === "run-script") {
      const script = argv.slice(2).find((a) => !a.startsWith("-"));
      if (script === undefined) return { kind: "allow" }; // lists the scripts
      return {
        kind: "ask",
        risk: "workspace_write",
        code: "command_ask_script",
        reason: `${id} run ${script} runs a project script`,
      };
    }
    if (sub === "start" || sub === "stop" || sub === "restart") {
      return {
        kind: "ask",
        risk: "workspace_write",
        code: "command_ask_script",
        reason: `${id} ${sub} runs a project script`,
      };
    }
  }
  return null;
}
