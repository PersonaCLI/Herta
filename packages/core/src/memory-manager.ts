export type MemoryKind =
  | "build_command"
  | "test_command"
  | "style_preference"
  | "repo_fact"
  | "known_flaky_test"
  | "recurring_mistake"
  | "herta_lesson";

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "build_command",
  "test_command",
  "style_preference",
  "repo_fact",
  "known_flaky_test",
  "recurring_mistake",
  "herta_lesson",
] as const;

export interface MemoryItem {
  id: string;
  scope: "repo" | "user";
  kind: MemoryKind;
  text: string;
  /** Why it holds — what the user said or what happened (ADR 0077). Items
   *  saved before have none. */
  why?: string;
  sourceSession: string;
  createdAt: string;
  /** When it was last saved: a save of the same fact re-confirms it, and
   *  recall shows the age from here (ADR 0077). */
  lastSeen: string;
  confidence: number;
}

export interface MemoryQuery {
  scope?: "repo" | "user";
  kind?: MemoryKind;
}

/** What a correction came to (ADR 0077 amendment 2026-11-09). */
export type MemoryReplaceOutcome =
  | { readonly ok: true; readonly replaced: MemoryItem }
  | { readonly ok: false; readonly reason: "not_found" | "ambiguous" };

/**
 * How many characters of a fact's id recall shows (ADR 0077 amendment
 * 2026-11-09): enough to tell 200 random ids apart, few enough to copy.
 */
export const MEMORY_HANDLE_LENGTH = 8;
const ID_SHAPE = /^[0-9a-z][0-9a-z-]*$/i;

/**
 * The handle recall shows for a fact, or null for an id `memory_save` would
 * not have written: a repository may ship any project.jsonl (ADR 0060
 * §2.6), and a line of the frame takes only the shapes the tool writes.
 */
export function memoryHandle(id: unknown): string | null {
  if (typeof id !== "string") return null;
  if (id.length < MEMORY_HANDLE_LENGTH || id.length > 64) return null;
  if (!ID_SHAPE.test(id)) return null;
  return id.slice(0, MEMORY_HANDLE_LENGTH).toLowerCase();
}

/**
 * A fact's id as a correction names it, ready to match the start of a
 * stored id: the handle recall shows or the whole id, with an `id:` or `#`
 * lead-in and the case forgiven. Null when it is shorter than a handle.
 */
export function normalizeMemoryHandle(handle: string): string | null {
  const h = handle
    .trim()
    .replace(/^(?:id\s*[:：]\s*|#)/i, "")
    .toLowerCase();
  return h.length >= MEMORY_HANDLE_LENGTH ? h : null;
}

export interface MemoryManager {
  recall(query: MemoryQuery): Promise<MemoryItem[]>;
  save(item: MemoryItem): Promise<void>;
  /**
   * Save `item` in place of the stored fact whose id starts with `handle`:
   * a correction (ADR 0077 amendment 2026-11-09). The old fact goes, and the
   * new one is saved the way `save` saves it. Nothing is written when no
   * fact, or more than one, has that id.
   */
  replace(handle: string, item: MemoryItem): Promise<MemoryReplaceOutcome>;
  /**
   * Synchronous read of the current in-memory snapshot. Returns the empty
   * array if the manager hasn't loaded yet (e.g., before the first recall()
   * or save() has populated the cache). Implementations must NOT perform
   * disk I/O here — this is the path called by the capsule pipeline on
   * every turn.
   */
  currentItems(): readonly MemoryItem[];
}

export class NoopMemoryManager implements MemoryManager {
  async recall(_query: MemoryQuery): Promise<MemoryItem[]> {
    return [];
  }
  async save(_item: MemoryItem): Promise<void> {
    // no-op
  }
  async replace(
    _handle: string,
    _item: MemoryItem,
  ): Promise<MemoryReplaceOutcome> {
    return { ok: false, reason: "not_found" };
  }
  currentItems(): readonly MemoryItem[] {
    return [];
  }
}
