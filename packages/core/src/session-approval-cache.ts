import type { EventBus } from "./event-bus.js";
import type { RiskLevel } from "./permission-engine.js";
import {
  binaryBasename,
  pinnedScript,
  RUNS_ITS_ARGUMENTS,
  SCRIPT_INTERPRETERS,
} from "./program-identity.js";
import type { AgentEvent, PermissionRequest } from "./types/events.js";

/**
 * Tools whose workspace_write approval can be remembered — each keyed by a
 * per-call SCOPE discriminator:
 *   - edit_file / write_new_file → the constant "task" scope: one remember
 *     covers ALL file writes (both tools) for the REMAINDER OF THE CURRENT
 *     板砖 TASK (ADR 0026, owner decision 2026-07-24 — the T3.4 per-path key
 *     re-prompted for every new file of a multi-file commission).
 *   - run_command → argv[0] (the binary) — a remembered `npm test` must not
 *     cover `python attacker.py`, so commands keep the discriminator.
 *
 * The cache's LIFETIME is what bounds the file-write grant: it is cleared
 * when the backend brief ends (`wireTaskScopedApprovalCache` below), so no
 * remember outlives the task the user was watching when they granted it.
 * Within that task, every auto-approved write still projects its patch
 * preview into the record (D7) — the evidence trail is unaffected.
 */
const SCOPED_CACHEABLE_TOOLS: ReadonlySet<string> = new Set([
  "edit_file",
  "write_new_file",
  "run_command",
  // Minimal contract (ADR 0040): the editor's writes share the file-write
  // identity; `bash` is scoped by the program its RULE derived (or not at all).
  "str_replace_editor",
  "bash",
]);

/** edit_file, write_new_file and str_replace_editor share one cache identity:
 *  approving "writes for this task" must cover creating a file AND the
 *  follow-up edits to it (pre-unification the two tools re-prompted separately
 *  on the same path); the minimal contract's editor is the same act. */
function normalizeTool(tool: string): string {
  return tool === "edit_file" ||
    tool === "write_new_file" ||
    tool === "str_replace_editor"
    ? "file_write"
    : tool;
}

/**
 * In-memory, TASK-scoped cache of "yes-and-remember" approvals for the
 * permission prompt (session-scoped until ADR 0026). Destructive and network
 * risks are intentionally excluded (they re-prompt every call), and every
 * cacheable entry REQUIRES a per-call scope — fail-closed, so a scopeless
 * entry can never match every path.
 * See docs/superpowers/specs/2026-05-10-permission-session-cache-design.md
 * and docs/adr/0026-task-scoped-write-approvals.md.
 */
export class SessionApprovalCache {
  private readonly approved = new Set<string>();

  private static keyOf(tool: string, risk: RiskLevel, scope?: string): string {
    const t = normalizeTool(tool);
    return scope === undefined ? `${t}:${risk}` : `${t}:${scope}:${risk}`;
  }

  isCacheable(tool: string, risk: RiskLevel, scope?: string): boolean {
    // A cacheable tool with NO scope is treated as non-cacheable — never fall
    // back to the path-free `tool:risk` key, which would re-open the
    // auto-approve-every-path escalation (audit T3.4).
    return (
      SCOPED_CACHEABLE_TOOLS.has(tool) &&
      scope !== undefined &&
      risk === "workspace_write"
    );
  }

  has(tool: string, risk: RiskLevel, scope?: string): boolean {
    return this.approved.has(SessionApprovalCache.keyOf(tool, risk, scope));
  }

  /**
   * Records an approval. Silently no-ops when the (tool, risk, scope) tuple
   * is not cacheable — including a cacheable tool that arrived with no scope
   * (defense-in-depth: a scopeless approval is never remembered).
   */
  add(tool: string, risk: RiskLevel, scope?: string): void {
    if (!this.isCacheable(tool, risk, scope)) return;
    this.approved.add(SessionApprovalCache.keyOf(tool, risk, scope));
  }

  clear(): void {
    this.approved.clear();
  }

  size(): number {
    return this.approved.size;
  }

  list(): readonly string[] {
    return [...this.approved].sort();
  }
}

/**
 * Task-scope lifetime (ADR 0026): clear the approval cache when the backend
 * brief ends — turn.finished OR turn.failed on the BACKEND layer — so a
 * "yes-and-remember" never outlives the 板砖 task it was granted for. The
 * next dispatch starts with a clean slate and re-asks. Wired once where the
 * cache is created (CLI main + app-server SessionImpl); returns the bus
 * unsubscribe.
 */
export function wireTaskScopedApprovalCache(
  bus: EventBus<AgentEvent>,
  cache: SessionApprovalCache,
): () => void {
  return bus.onAny((event) => {
    if (
      (event.type === "turn.finished" || event.type === "turn.failed") &&
      event.layer === "backend"
    ) {
      cache.clear();
    }
  });
}

/**
 * Commands whose argv[0] is a WEAK cache scope: remembering `python build.py`
 * under scope `python` would auto-approve `python -c '<arbitrary code>'` — the
 * classifier does not inspect interpreter `-c`/`-e` bodies, so an
 * argv[0]-scoped remember is an arbitrary-code-execution grant (audit T3.4
 * review). These are excluded from caching entirely (scope → undefined → not
 * cacheable → every invocation re-prompts). Compared by argv[0] BASENAME
 * (dir + `.exe` stripped, lowercased).
 *
 * UNIONED with the shared program sets (audit 2026-08-05, S5) rather than
 * hand-listed. This set and `RUNS_ITS_ARGUMENTS` (then ADR 0030's
 * `NEVER_RULABLE`) were maintained separately under identical reasoning
 * and drifted: the WRAPPERS — `timeout`, `time`, `sudo`, `doas`,
 * `pkexec`, `nice`, `nohup`, `xargs`, `stdbuf` — were there but not here, so approving a benign `timeout 600 npm run
 * build` silently covered `timeout 5 node -e '<payload>'` with no overlay for
 * the remainder of the task. Neither set is a superset of the other, so the
 * union is taken and the drift cannot recur.
 *
 * Deliberately NOT scoped as `argv[0]+argv[1]` for wrappers: `timeout 600 X`
 * and `timeout 5 X` differ at argv[1], which both fails to constrain the real
 * command and re-prompts noisily. */
const UNCACHEABLE_INTERPRETERS: ReadonlySet<string> = new Set([
  ...RUNS_ITS_ARGUMENTS,
  ...SCRIPT_INTERPRETERS,
  // Extras this set carried that the shared sets do not need: shells and
  // runtimes that are never a stable identity for what they execute.
  "zsh",
  "nodejs",
]);

/**
 * The per-call cache SCOPE for a permission request, computed identically by
 * every AskResolver so the cache key is consistent (audit T3.4). Returns
 * `undefined` when no scope is derivable OR the scope is too weak to be safe —
 * which makes the request non-cacheable (fail-closed), never a broad match.
 *
 * - run_command → argv[0] (binary discriminator; a benign `npm test` remember
 *   must not cover `python attacker.py`), EXCEPT generic interpreters/shells
 *   whose argv[0] doesn't constrain the executed code — those are never cached.
 * - edit_file / write_new_file → the constant "task" scope (ADR 0026): the
 *   remember covers every file write until the brief ends and the cache is
 *   cleared. Still gated on the rule-RESOLVED path being present — a rule
 *   that produced no canonical target stays non-cacheable (fail-closed).
 */
export function permissionCacheScope(
  request: PermissionRequest,
): string | undefined {
  const tool = request.call.tool;
  if (tool === "run_command") {
    const input = request.call.input;
    if (typeof input !== "object" || input === null) return undefined;
    const argv = (input as { argv?: unknown }).argv;
    if (!Array.isArray(argv) || argv.length === 0) return undefined;
    const first = argv[0];
    if (typeof first !== "string" || first.length === 0) return undefined;
    if (UNCACHEABLE_INTERPRETERS.has(binaryBasename(first))) {
      return pinnedInterpreterScope(argv);
    }
    return first;
  }
  if (
    tool === "edit_file" ||
    tool === "write_new_file" ||
    tool === "str_replace_editor"
  ) {
    const first = request.files?.[0];
    return typeof first === "string" && first.length > 0 ? "task" : undefined;
  }
  if (tool === "bash") {
    // The bash RULE derives the effective argv (ADR 0040): the single
    // program a command line really runs, after the model's
    // `cd <workspace> &&` prefix, or nothing when the line runs several
    // programs / an interpreter body / a redirect outside the workspace.
    // From there, EXACTLY run_command's rule: argv[0], minus the
    // interpreter/shell/wrapper set — the same code path so they cannot drift.
    // A chained line whose every (non-reader, non-builtin) program is the
    // SAME identity scopes by that identity too — `git add && git commit`
    // is a "git" line — because the cache is per program, not per rule.
    const first =
      request.argv?.[0] ??
      (request.programs !== undefined && request.programs.length === 1
        ? request.programs[0]
        : undefined);
    if (typeof first !== "string" || first.length === 0) return undefined;
    if (UNCACHEABLE_INTERPRETERS.has(binaryBasename(first))) {
      // Only the single-program argv can pin a script; a chained line's
      // `programs` cannot.
      return request.argv !== undefined
        ? pinnedInterpreterScope(request.argv)
        : undefined;
    }
    return first;
  }
  return undefined;
}

/**
 * The one interpreter shape the task cache MAY scope: the pinned
 * `<interp> <workspace-script>` — `node scripts/stats.mjs` (`pinnedScript`):
 * the script path constrains what runs to a file the record's diffs track,
 * where bare `node` would cover `node -e '<anything>'`. Permission lab 2026-08-17: the
 * model re-ran `node scripts/stats.mjs` three times in one brief and the
 * user was asked three times, with nothing between the asks that changed
 * what would run. Flag operands, out-of-workspace scripts, shells and
 * wrappers still yield no scope (undefined → not cacheable).
 */
function pinnedInterpreterScope(argv: readonly unknown[]): string | undefined {
  return pinnedScript(argv)?.join(" ");
}

/** For rules that derive their own scope: is this program identity a safe
 *  cache discriminator? (Shells, wrappers and script interpreters are not —
 *  see UNCACHEABLE_INTERPRETERS.) */
export function isCacheableProgram(a0: string): boolean {
  return !UNCACHEABLE_INTERPRETERS.has(binaryBasename(a0));
}
