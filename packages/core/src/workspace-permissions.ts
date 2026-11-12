import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomicSync } from "./atomic-write.js";

/**
 * The owner's permission choices per workspace — today one: whether
 * automatic review is on (ADR 0075, which replaced workspace trust on
 * 2026-10-10).
 *
 * They are kept OUTSIDE every workspace, in one file under the harness's own
 * home folder (`<home>/.herta/review-choices.json`, `reviewChoicesFileFor`),
 * keyed by the workspace's path (ADR 0064 amendment 2026-11-12). Until then
 * each workspace carried its own, in `<workspace>/.herta/permissions.json`,
 * and the file was read as found: a folder that arrived with one in it — a
 * cloned or downloaded project — had automatic review on with no choice by
 * the owner. A folder can carry nothing now. Its old file is never read
 * again, except once, by `importLegacyChoices`, for the workspaces this
 * installation's own session records name.
 *
 * No command may write the harness's home (`harnessHomeWriteDenial` in
 * @herta/tools, beside `hertaStateWriteDenial` for a workspace's own
 * `.herta`), so the agent can neither turn its own reviewer on nor off.
 */
interface ChoicesFile {
  readonly version: 1;
  /** Workspace key (`workspaceKey`) → the owner's choice there. */
  readonly workspaces: Readonly<
    Record<string, { readonly autoReview: boolean }>
  >;
  /** The surfaces whose one-time import of the old per-workspace files has
   *  run (`importLegacyChoices`). */
  readonly imported?: readonly string[];
}

const EMPTY: ChoicesFile = { version: 1, workspaces: {} };

/**
 * A workspace's key: its real path, as the disk names it. Two spellings of
 * one folder (another case on Windows or macOS, an 8.3 name, a link) are one
 * workspace and share a choice; a folder that is gone keeps the key its last
 * spelling gives. Lower-cased on Windows, where no spelling of a path that
 * no longer resolves can be told from another.
 */
export function workspaceKey(root: string): string {
  const abs = resolve(root);
  let real = abs;
  try {
    real = realpathSync.native(abs);
  } catch {
    // Not there (deleted, an unplugged drive): its resolved spelling.
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function readChoices(file: string): ChoicesFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return EMPTY;
  }
  let parsed: Partial<ChoicesFile>;
  try {
    parsed = JSON.parse(raw) as Partial<ChoicesFile>;
  } catch {
    return EMPTY;
  }
  if (parsed === null || typeof parsed !== "object" || parsed.version !== 1)
    return EMPTY;
  const workspaces: Record<string, { autoReview: boolean }> = {};
  if (parsed.workspaces !== null && typeof parsed.workspaces === "object") {
    for (const [key, value] of Object.entries(parsed.workspaces)) {
      // Only a boolean is a choice: a hand-edited "yes" is none.
      if (
        value !== null &&
        typeof value === "object" &&
        typeof (value as { autoReview?: unknown }).autoReview === "boolean"
      ) {
        workspaces[key] = {
          autoReview: (value as { autoReview: boolean }).autoReview,
        };
      }
    }
  }
  const imported = Array.isArray(parsed.imported)
    ? parsed.imported.filter((s): s is string => typeof s === "string")
    : [];
  return {
    version: 1,
    workspaces,
    ...(imported.length > 0 ? { imported } : {}),
  };
}

function writeChoices(file: string, choices: ChoicesFile): void {
  mkdirSync(dirname(file), { recursive: true });
  // Atomic (audit BL7): a torn write would lose every workspace's choice.
  writeFileAtomicSync(file, `${JSON.stringify(choices, null, 2)}\n`);
}

/**
 * The choice an OLD per-workspace file states, or null. `trust` is workspace
 * trust (ADR 0064), replaced by automatic review on 2026-10-10: on a file
 * that never chose `autoReview`, `"workspace"` reads as on and `"ask"` as
 * off. For `importLegacyChoices` only; nothing else reads that file.
 */
export function readLegacyChoice(workspaceRoot: string): boolean | null {
  let raw: string;
  try {
    raw = readFileSync(
      join(workspaceRoot, ".herta", "permissions.json"),
      "utf8",
    );
  } catch {
    return null;
  }
  let parsed: {
    version?: unknown;
    autoReview?: unknown;
    trust?: unknown;
  } | null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || parsed.version !== 1)
    return null;
  if (typeof parsed.autoReview === "boolean") return parsed.autoReview;
  if (parsed.trust === "workspace") return true;
  if (parsed.trust === "ask") return false;
  return null;
}

/**
 * Carry the choices of the old per-workspace files over, ONCE per surface
 * (`"desktop"`, `"cli"`).
 *
 * `workspaces` must be the folders this installation's own records name —
 * the workspaces of its recorded sessions — never a folder just because it
 * is open: a file's presence proves nothing about who wrote it, and that is
 * the hole the move closed. A workspace that already has a choice here keeps
 * it. After the first call for a surface nothing is imported for it again,
 * whatever arrives later. Returns how many choices were carried over.
 */
export function importLegacyChoices(opts: {
  readonly file: string;
  readonly surface: string;
  readonly workspaces: readonly string[];
}): number {
  const current = readChoices(opts.file);
  if (current.imported?.includes(opts.surface) === true) return 0;
  const workspaces: Record<string, { autoReview: boolean }> = {
    ...current.workspaces,
  };
  let carried = 0;
  for (const root of opts.workspaces) {
    const key = workspaceKey(root);
    if (workspaces[key] !== undefined) continue;
    const choice = readLegacyChoice(root);
    if (choice === null) continue;
    workspaces[key] = { autoReview: choice };
    carried += 1;
  }
  writeChoices(opts.file, {
    version: 1,
    workspaces,
    imported: [...(current.imported ?? []), opts.surface],
  });
  return carried;
}

/** Whether a surface's one-time import has run. */
export function legacyChoicesImported(file: string, surface: string): boolean {
  return readChoices(file).imported?.includes(surface) === true;
}

/**
 * The choice for the CURRENT workspace. The root is a provider, not a
 * constant: setWorkspace can move the backend workspace mid-session, and the
 * choice follows the workspace it was made for.
 *
 * `file` is where the choices are kept (`reviewChoicesFileFor(home)` in both
 * hosts). Null keeps them in memory for the life of this object: a caller
 * with nowhere to record a choice (a test, an embedder) still gets one that
 * holds for the session, and nothing of the machine's own is touched.
 * Loads are tolerant (missing or malformed file → no choice, never a throw);
 * a write reads the file again first, so two processes do not lose each
 * other's workspaces, and is whole-file and atomic.
 */
export class WorkspacePermissions {
  private readonly memory = new Map<string, boolean>();

  constructor(
    private readonly rootProvider: () => string,
    private readonly file: string | null = null,
  ) {}

  /** The owner's automatic-review choice for this workspace, or null when
   *  they never chose — the policy then applies its default. */
  autoReview(): boolean | null {
    const key = workspaceKey(this.rootProvider());
    if (this.file === null) return this.memory.get(key) ?? null;
    return readChoices(this.file).workspaces[key]?.autoReview ?? null;
  }

  /** Persist the choice; null clears it back to the default. Only ever
   *  called from the owner's explicit choice: a card, the device card's
   *  menu, or the CLI's `/permissions auto-review`. */
  setAutoReview(on: boolean | null): void {
    const key = workspaceKey(this.rootProvider());
    if (this.file === null) {
      if (on === null) this.memory.delete(key);
      else this.memory.set(key, on);
      return;
    }
    const current = readChoices(this.file);
    const workspaces: Record<string, { autoReview: boolean }> = {
      ...current.workspaces,
    };
    if (on === null) delete workspaces[key];
    else workspaces[key] = { autoReview: on };
    writeChoices(this.file, {
      version: 1,
      workspaces,
      ...(current.imported !== undefined ? { imported: current.imported } : {}),
    });
  }
}
