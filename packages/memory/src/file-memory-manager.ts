import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type MemoryItem,
  type MemoryManager,
  type MemoryQuery,
  type MemoryReplaceOutcome,
  normalizeMemoryHandle,
  renameWithRetry,
} from "@herta/core";

const ITEM_CAP = 200;
const MEMORY_DIR_NAME = ".herta/memory";
const PROJECT_FILE_NAME = "project.jsonl";

export interface FsShim {
  readFile: (p: string) => Promise<Buffer>;
  writeFile: (p: string, data: string) => Promise<void>;
  mkdir: (p: string, opts?: { recursive?: boolean }) => Promise<void>;
  rename: (oldP: string, newP: string) => Promise<void>;
}

export interface FileMemoryManagerDeps {
  workspaceRoot: string;
  fs?: FsShim;
}

const defaultFs: FsShim = {
  readFile,
  writeFile,
  mkdir: async (p, opts) => {
    await mkdir(p, opts);
  },
  rename,
};

function isMissingFsError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function dedupeKey(item: { kind: string; text: string }): string {
  return `${item.kind}\x00${item.text}`;
}

/**
 * Saves queue per FILE, process-wide (release review 2026-10-13). Each
 * manager used to queue only its own: two managers on one workspace in one
 * process both read the file, and the second write dropped the first's
 * fact — and with a counter of their own, both named their tmp file
 * `<pid>-1` and the loser's rename threw ENOENT. A different process still
 * narrows to the write window (see `saveInner`).
 */
const saveTails = new Map<string, Promise<void>>();
let tmpCounter = 0;

function fileKey(p: string): string {
  const abs = resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/** When a fact was last saved — `lastSeen`, or `createdAt` for an item
 *  written without one. */
function confirmedAt(item: MemoryItem): string {
  return item.lastSeen ?? item.createdAt;
}

/** The store with `item` saved into it: a re-confirmation when the same
 *  fact is there, otherwise an append, the least recently confirmed fact
 *  giving way at the cap. */
function withSaved(existing: MemoryItem[], item: MemoryItem): MemoryItem[] {
  const incomingKey = dedupeKey(item);
  const same = existing.findIndex((it) => dedupeKey(it) === incomingKey);
  if (same >= 0) {
    // The same fact saved again RE-CONFIRMS it (ADR 0077): recall shows
    // its age from the last confirmation, and a newer reason replaces the
    // old one. Its place and its id stay.
    const prior = existing[same] as MemoryItem;
    const confirmed: MemoryItem = {
      ...prior,
      lastSeen: item.lastSeen,
      ...(item.why !== undefined ? { why: item.why } : {}),
    };
    return existing.map((it, i) => (i === same ? confirmed : it));
  }
  if (existing.length >= ITEM_CAP) {
    // The least recently confirmed fact gives way.
    const sorted = [...existing].sort((a, b) =>
      confirmedAt(a).localeCompare(confirmedAt(b)),
    );
    sorted.shift();
    return [...sorted, item];
  }
  return [...existing, item];
}

export class FileMemoryManager implements MemoryManager {
  private readonly fs: FsShim;
  private readonly dir: string;
  private readonly path: string;
  private cache: MemoryItem[] | undefined;

  constructor(deps: FileMemoryManagerDeps) {
    this.fs = deps.fs ?? defaultFs;
    this.dir = join(deps.workspaceRoot, MEMORY_DIR_NAME);
    this.path = join(this.dir, PROJECT_FILE_NAME);
  }

  /**
   * Reads the ON-DISK truth on every call, for the same reason `save` does
   * (finding 19): GUI + CLI on one workspace is supported, and the store's
   * one production reader — the backend runtime at brief start (ADR 0060)
   * — would otherwise serve a boot-time snapshot for the life of the
   * process, blind to every fact the other process saved. The file is at
   * most 200 lines; one read per dispatch is nothing. The cache still
   * refreshes here so `currentItems()` keeps its no-I/O contract.
   */
  async recall(query: MemoryQuery): Promise<MemoryItem[]> {
    const items = await this.readAll();
    this.cache = items;
    return items.filter((it) => {
      if (query.scope !== undefined && it.scope !== query.scope) return false;
      if (query.kind !== undefined && it.kind !== query.kind) return false;
      return true;
    });
  }

  save(item: MemoryItem): Promise<void> {
    return this.queued(() => this.saveInner(item));
  }

  /**
   * A correction (ADR 0077 amendment 2026-11-09): the fact `handle` names
   * goes and `item` is saved in its place, in the same queue as `save` and
   * against the same on-disk truth.
   */
  replace(handle: string, item: MemoryItem): Promise<MemoryReplaceOutcome> {
    return this.queued(() => this.replaceInner(handle, item));
  }

  private queued<T>(work: () => Promise<T>): Promise<T> {
    // Serialize the process's writes to this file behind a promise chain
    // (audit 2026-07-10, finding 19; per file since 2026-10-13); a failed
    // write never poisons the chain, and its rejection reaches its own
    // caller. The entry goes once the chain is idle.
    const key = fileKey(this.path);
    const tail = saveTails.get(key) ?? Promise.resolve();
    const run = tail.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    saveTails.set(key, settled);
    void settled.then(() => {
      if (saveTails.get(key) === settled) saveTails.delete(key);
    });
    return run;
  }

  private async saveInner(item: MemoryItem): Promise<void> {
    // Merge against the ON-DISK truth, not the boot-time cache (audit
    // 2026-07-10, finding 19): GUI + CLI on one workspace is a supported
    // combination, and each process rewrote the whole file from its own
    // stale cache — every save erased the other process's items
    // (last-writer-wins). `writeMerged` reads again just before it writes.
    await this.writeMerged((existing) => ({
      next: withSaved(existing, item),
      outcome: undefined,
    }));
  }

  private async replaceInner(
    handle: string,
    item: MemoryItem,
  ): Promise<MemoryReplaceOutcome> {
    const h = normalizeMemoryHandle(handle);
    return this.writeMerged<MemoryReplaceOutcome>((existing) => {
      const named =
        h === null
          ? []
          : existing.filter(
              (it) =>
                typeof it.id === "string" && it.id.toLowerCase().startsWith(h),
            );
      if (named.length !== 1) {
        return {
          next: null,
          outcome: {
            ok: false,
            reason: named.length === 0 ? "not_found" : "ambiguous",
          },
        };
      }
      const replaced = named[0] as MemoryItem;
      return {
        next: withSaved(
          existing.filter((it) => it !== replaced),
          item,
        ),
        outcome: { ok: true, replaced },
      };
    });
  }

  /**
   * Write what `plan` makes of the store as it is on disk (owner
   * 2026-11-16: merge on write, no lock file). The queue serializes this
   * process; the CLI and the desktop on one workspace are two. After the
   * new file is written beside the store, the store is read once more: when
   * another process wrote it in the meantime, the plan runs again on what is
   * there now, so its fact is kept. A write between that last read and the
   * rename can still be lost — the window is one read and one rename long,
   * where it used to be the whole save. `next: null` writes nothing.
   */
  private async writeMerged<T>(
    plan: (existing: MemoryItem[]) => {
      readonly next: MemoryItem[] | null;
      readonly outcome: T;
    },
  ): Promise<T> {
    // Unique tmp per save AND per process: with the shared `.tmp` name, two
    // overlapping writers renamed each other's tmp away and the loser threw
    // ENOENT (finding 19's second half). One name for the whole save: a
    // second attempt writes over the first's.
    let tmp: string | undefined;
    let raw = await this.readRaw();
    for (let attempt = 1; ; attempt++) {
      const existing = parseItems(raw);
      const { next, outcome } = plan(existing);
      if (next === null) {
        this.cache = existing;
        return outcome;
      }
      if (tmp === undefined) {
        await this.fs.mkdir(this.dir, { recursive: true });
        tmpCounter += 1;
        tmp = `${this.path}.${process.pid}-${tmpCounter}.tmp`;
      }
      await this.fs.writeFile(
        tmp,
        `${next.map((it) => JSON.stringify(it)).join("\n")}\n`,
      );
      const now = await this.readRaw();
      if (now === raw || attempt >= MERGE_ATTEMPTS) {
        // Tried again where Windows holds the target for a moment (an
        // antivirus, OneDrive): one refusal lost the fact 板砖 had just been
        // told to keep.
        await renameWithRetry(tmp, this.path, { rename: this.fs.rename });
        this.cache = next;
        return outcome;
      }
      raw = now;
    }
  }

  currentItems(): readonly MemoryItem[] {
    return this.cache ?? [];
  }

  private async readAll(): Promise<MemoryItem[]> {
    return parseItems(await this.readRaw());
  }

  /** The store's text, or null when there is no store yet. */
  private async readRaw(): Promise<string | null> {
    try {
      return (await this.fs.readFile(this.path)).toString("utf8");
    } catch (err) {
      if (isMissingFsError(err)) return null;
      throw err;
    }
  }
}

/** How many times one save merges again when the store changed under it.
 *  The last attempt writes even so: a store another process rewrites three
 *  times inside one save is not something to wait out. */
const MERGE_ATTEMPTS = 3;

function parseItems(text: string | null): MemoryItem[] {
  if (text === null) return [];
  const items: MemoryItem[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    try {
      items.push(JSON.parse(line) as MemoryItem);
    } catch {
      // silently drop corrupted line
    }
  }
  return items;
}
