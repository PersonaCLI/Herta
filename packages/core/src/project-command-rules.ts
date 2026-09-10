import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./atomic-write.js";

/**
 * Project-scoped command allow rules (ADR 0030).
 *
 * The task-scoped approval cache (ADR 0026) deliberately excludes generic
 * interpreters — remembering bare `node` would auto-approve `node -e
 * '<arbitrary code>'` — so every `node script.js` re-prompted on every
 * commission, labelled 「未识别的命令」. This module is the persistent,
 * user-authored escape valve, patterned on the reference harness's settings
 * allow-rules (re-derived, not copied): the approval prompt offers ONE
 * deterministic rule per ask (never an editable pattern), the user's explicit
 * click persists it under the WORKSPACE (`.herta/permissions.json`), and the
 * resolver consults the store before surfacing future asks.
 *
 * Safety boundaries (all deterministic harness code, per D4):
 * - Rules can only ever convert an ASK into an allow. The block tier ran
 *   before the resolver is consulted, and rules are matched ONLY when the
 *   live classifier verdict's code is rule-eligible (unknown / interpreter) —
 *   a hand-edited rule can never cover a destructive or network ask.
 * - Shells, command wrappers, and package-fetching runners are never
 *   derivable AND never matchable (`bash:*` is refused even if hand-written).
 * - Interpreters derive only the `interpreter <workspace-script>:*` shape —
 *   script pinned, args free. An interpreter invocation whose first operand
 *   is a flag (`node -e …`) or an out-of-workspace path derives nothing.
 */

/** Ask-class codes whose approvals may be persisted as project rules. All
 *  other ask classes (destructive, network, reader-path, recursive-read,
 *  write-redirection, delete, process) re-prompt every time, rule or no
 *  rule. `command_ask_vcs` (git mutations) and `command_ask_fs` (mkdir /
 *  touch / cp / mv / ln) split off from `unknown` on 2026-08-17 for honest
 *  card labels; they keep unknown's eligibility so `git commit:*` /
 *  `mkdir:*` rules still derive exactly as before. */
const RULE_ELIGIBLE_ASK_CODES: ReadonlySet<string> = new Set([
  "command_ask_unknown",
  "command_ask_interpreter",
  "command_ask_vcs",
  "command_ask_fs",
]);

export function isRuleEligibleAskCode(code: string | undefined): boolean {
  return code !== undefined && RULE_ELIGIBLE_ASK_CODES.has(code);
}

/** Script interpreters that may derive the pinned `interp <script>:*` shape.
 *  Mirrors the UNCACHEABLE_INTERPRETERS motivation (session-approval-cache):
 *  bare argv[0] is an arbitrary-code grant, but interpreter + workspace
 *  script path constrains WHAT runs to a file the record's diffs track.
 *  Exported: the run_command classifier uses the SAME set to give these an
 *  honest `command_ask_interpreter` class instead of 「未识别的命令」 — one
 *  source, so classification and rule derivation can't drift. */
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

/** Never derivable, never matchable. Shells and `-c`-style wrappers execute
 *  arbitrary bodies; env/xargs/sudo-alikes exec their arguments; npx/make
 *  fetch or dispatch code the argv doesn't name. A rule on any of these is a
 *  standing arbitrary-execution grant, so the store refuses them outright —
 *  including entries hand-written into permissions.json.
 *
 *  EXPORTED because the task-scoped approval cache needs the same set: the
 *  two drifted apart, and the cache was missing every WRAPPER here
 *  (timeout/sudo/nice/xargs/…), so approving `timeout 600 npm run build`
 *  silently pre-approved `timeout 5 node -e '<payload>'` for the rest of the
 *  task (audit 2026-08-05, S5). Neither set is a superset of the other —
 *  session-approval-cache unions them. */
export const NEVER_RULABLE: ReadonlySet<string> = new Set([
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
 *  lowercased) — rule tokens themselves are stored and compared verbatim.
 *  Shared with the approval cache's interpreter/wrapper checks. */
export function binaryBasename(a0: string): string {
  const base = a0.split(/[\\/]/).pop() ?? a0;
  return base.toLowerCase().replace(/\.exe$/, "");
}

/** Same subcommand shape the reference prefix extractor requires: lowercase
 *  alphanumeric words (`build`, `run-script`) — not flags, paths, numbers. */
const SUBCOMMAND_SHAPE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const ABSOLUTE_OR_HOME = /^([A-Za-z]:|[\\/]|~)/;

function escapesWorkspace(operand: string): boolean {
  return (
    ABSOLUTE_OR_HOME.test(operand) ||
    operand === ".." ||
    operand.includes("../") ||
    operand.includes("..\\")
  );
}

export interface ProjectCommandRule {
  /** Leading argv tokens, compared verbatim. */
  readonly argvPrefix: readonly string[];
  /** True → any further args match (`:*` display); false → exact argv. */
  readonly anyArgs: boolean;
  readonly addedAt: string;
  /**
   * The cwd the approval was granted in, workspace-relative ("" = the root),
   * matched against the cwd of a later call (audit BL15).
   *
   * A rule like `node src/index.mjs:*` pins a workspace-relative SCRIPT PATH,
   * but `matches()` never saw a cwd — and cwd is model-supplied. So the same
   * rule authorized `src/index.mjs` under any directory in the tree that
   * happened to contain that path. This is contract fidelity, not an
   * escalation: ADR 0030 already grants "run whatever that script contains,"
   * and the user approving it was looking at one particular script.
   */
  readonly cwd: string;
}

/** Display form shown on the approval card, in Settings, and in CLI markers:
 *  `node src/index.mjs:*` (prefix) or the plain joined argv (exact). */
export function ruleDisplay(rule: {
  readonly argvPrefix: readonly string[];
  readonly anyArgs: boolean;
}): string {
  const joined = rule.argvPrefix.join(" ");
  return rule.anyArgs ? `${joined}:*` : joined;
}

/**
 * The one rule an approval of `argv` may persist, or null when no rule is
 * safe to offer (the panel then hides the project button entirely). Callers
 * gate on `isRuleEligibleAskCode` first — derivation itself only shapes.
 */
export function deriveProjectCommandRule(argv: readonly string[]): {
  readonly argvPrefix: readonly string[];
  readonly anyArgs: boolean;
} | null {
  const a0 = argv[0];
  if (typeof a0 !== "string" || a0.length === 0) return null;
  if (argv.some((a) => typeof a !== "string")) return null;
  const base = binaryBasename(a0);
  if (NEVER_RULABLE.has(base)) return null;

  const a1 = argv[1];
  if (SCRIPT_INTERPRETERS.has(base)) {
    // Interpreter: ONLY the script-pinned shape. A flag operand (`-e`, `-c`,
    // `-m`, `--eval`) or an out-of-workspace script derives nothing — those
    // re-prompt every time, deliberately.
    if (
      typeof a1 !== "string" ||
      a1.length === 0 ||
      a1.startsWith("-") ||
      escapesWorkspace(a1)
    ) {
      return null;
    }
    return { argvPrefix: [a0, a1], anyArgs: true };
  }

  // Plain binary: `tool subcommand:*` when argv[1] looks like a subcommand,
  // else the exact argv (a re-run of the identical command stops prompting;
  // anything else still asks).
  if (typeof a1 === "string" && SUBCOMMAND_SHAPE.test(a1)) {
    if (base === "git" && UNDECIDABLE_GIT_SUBCOMMANDS.has(a1)) {
      return { argvPrefix: [...argv], anyArgs: false };
    }
    return { argvPrefix: [a0, a1], anyArgs: true };
  }
  return { argvPrefix: [...argv], anyArgs: false };
}

/**
 * git subcommands whose OPERAND decides whether they destroy work, in a way no
 * classifier reading the string can settle.
 *
 * `git checkout main` switches branch; `git checkout main.ts` throws away that
 * file. Same shape — git itself decides by asking whether the name resolves as
 * a ref, which this harness cannot do. The destructive tier catches every
 * spelling it can read (`--`, a bare `.`, a tree-ish plus operands), and the
 * honest residue is the single ambiguous operand.
 *
 * So these get no `:*`. A wildcard turns one approval into a standing grant
 * over every future spelling, and ADR 0045 already established where that
 * leads: the tier's coverage is "what someone thought of," and a wildcard
 * makes each miss permanent and silent instead of a question. Reproduced end
 * to end on 2026-08-25 — approving `git checkout -b feature/x` persisted
 * `git checkout:*`, which then auto-approved `git checkout main src/foo.ts`
 * with no card, discarding that file's uncommitted changes.
 *
 * The cost is one card per distinct checkout, which is the right side to err
 * on: the failure mode here is a re-prompt, and the other one is unrecoverable.
 * Everything else — `git commit:*`, `git add:*`, ADR 0030's own examples —
 * derives exactly as before.
 */
const UNDECIDABLE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "checkout",
  "switch",
  "restore",
]);

/**
 * One spelling for "the directory this rule was granted in" (audit BL15).
 * Slash-separated and relative, so a rule survives the workspace moving and
 * compares the same on both platforms; undefined/empty/"." all mean the root,
 * which is `run_command`'s own default cwd.
 */
export function normalizeRuleCwd(cwd: string | undefined): string {
  if (cwd === undefined) return "";
  const trimmed = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed === "." || trimmed === "" ? "" : trimmed;
}

interface PermissionsFile {
  readonly version: 1;
  readonly commandAllow: readonly ProjectCommandRule[];
}

function validRule(entry: unknown): entry is ProjectCommandRule {
  if (typeof entry !== "object" || entry === null) return false;
  const r = entry as ProjectCommandRule;
  if (!Array.isArray(r.argvPrefix) || r.argvPrefix.length === 0) return false;
  if (!r.argvPrefix.every((t) => typeof t === "string" && t.length > 0))
    return false;
  if (typeof r.anyArgs !== "boolean") return false;
  if (typeof r.addedAt !== "string") return false;
  // Rules written before the cwd field existed are dropped rather than
  // defaulted (audit BL15). Defaulting them to the root would silently keep
  // granting the broad match this field exists to narrow, and the cost of
  // dropping is one re-approval on a file that has never shipped.
  if (typeof r.cwd !== "string") return false;
  // Refuse shell/wrapper rules even when hand-written into the file.
  const first = r.argvPrefix[0];
  if (first === undefined || NEVER_RULABLE.has(binaryBasename(first)))
    return false;
  return true;
}

/**
 * Reads/writes `.herta/permissions.json` under the CURRENT workspace root.
 * The root is a provider, not a constant: setWorkspace can move the backend
 * workspace mid-session, and rules must follow the workspace they were
 * granted for. Loads are tolerant (missing/malformed file or entry → the
 * entry is dropped, never the process); writes are whole-file (tiny file,
 * matching the sidecar idiom).
 */
export class ProjectCommandRuleStore {
  constructor(private readonly rootProvider: () => string) {}

  private filePath(): string {
    return join(this.rootProvider(), ".herta", "permissions.json");
  }

  list(): ProjectCommandRule[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath(), "utf8");
    } catch {
      return [];
    }
    let parsed: Partial<PermissionsFile>;
    try {
      parsed = JSON.parse(raw) as Partial<PermissionsFile>;
    } catch {
      return [];
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.commandAllow)) return [];
    return parsed.commandAllow.filter(validRule);
  }

  /** True when a persisted rule covers `argv` run from `cwd`. Callers MUST
   *  gate on the live ask code being rule-eligible — the store never sees the
   *  verdict. `cwd` is the call's working directory (audit BL15); omitting it
   *  means the workspace root, which is `run_command`'s own default. */
  matches(argv: readonly string[], cwd?: string): boolean {
    const a0 = argv[0];
    if (typeof a0 !== "string" || NEVER_RULABLE.has(binaryBasename(a0))) {
      return false;
    }
    const here = normalizeRuleCwd(cwd);
    for (const rule of this.list()) {
      if (rule.cwd !== here) continue;
      const p = rule.argvPrefix;
      if (rule.anyArgs ? argv.length < p.length : argv.length !== p.length) {
        continue;
      }
      if (p.every((tok, i) => argv[i] === tok)) return true;
    }
    return false;
  }

  /** Persists a derived rule (no-op on duplicates). Only ever called from a
   *  user's explicit project-persist choice on the approval surface. */
  add(rule: {
    readonly argvPrefix: readonly string[];
    readonly anyArgs: boolean;
    readonly cwd?: string;
  }): void {
    const existing = this.list();
    const entry: ProjectCommandRule = {
      argvPrefix: [...rule.argvPrefix],
      anyArgs: rule.anyArgs,
      addedAt: new Date().toISOString(),
      cwd: normalizeRuleCwd(rule.cwd),
    };
    // Deduped on display AND cwd: the same command approved in two different
    // directories is two grants, and collapsing them would silently widen the
    // first one.
    if (
      existing.some(
        (r) => ruleDisplay(r) === ruleDisplay(rule) && r.cwd === entry.cwd,
      )
    ) {
      return;
    }
    if (!validRule(entry)) return; // fail-closed: never persist a refused shape
    this.write([...existing, entry]);
  }

  /** Removes the rule whose display form matches (Settings / CLI delete). */
  remove(display: string): boolean {
    const existing = this.list();
    const kept = existing.filter((r) => ruleDisplay(r) !== display);
    if (kept.length === existing.length) return false;
    this.write(kept);
    return true;
  }

  private write(rules: readonly ProjectCommandRule[]): void {
    const dir = join(this.rootProvider(), ".herta");
    mkdirSync(dir, { recursive: true });
    const payload: PermissionsFile = { version: 1, commandAllow: rules };
    // Atomic (audit BL7). A torn write here fails CLOSED — the loader drops
    // an unparseable file and everything re-prompts — so this is about not
    // silently losing the user's grants, not about safety.
    writeFileAtomicSync(
      join(dir, "permissions.json"),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  }
}
