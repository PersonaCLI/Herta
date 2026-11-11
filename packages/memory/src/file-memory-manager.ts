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
    await this.fs.mkdir(this.dir, { recursive: true });
    // Merge against the ON-DISK truth, not the boot-time cache (audit
    // 2026-07-10, finding 19): GUI + CLI on one workspace is a supported
    // combination, and each process rewrote the whole file from its own
    // stale cache — every save erased the other process's items
    // (last-writer-wins). Re-reading narrows the race to the write window
    // below; a cross-process file lock is deliberately out of scope.
    const existing = await this.readAll();
    await this.writeAll(withSaved(existing, item));
  }

  private async replaceInner(
    handle: string,
    item: MemoryItem,
  ): Promise<MemoryReplaceOutcome> {
    const existing = await this.readAll();
    const h = normalizeMemoryHandle(handle);
    const named =
      h === null
        ? []
        : existing.filter(
            (it) =>
              typeof it.id === "string" && it.id.toLowerCase().startsWith(h),
          );
    if (named.length !== 1) {
      this.cache = existing;
      return {
        ok: false,
        reason: named.length === 0 ? "not_found" : "ambiguous",
      };
    }
    const replaced = named[0] as MemoryItem;
    await this.fs.mkdir(this.dir, { recursive: true });
    await this.writeAll(
      withSaved(
        existing.filter((it) => it !== replaced),
        item,
      ),
    );
    return { ok: true, replaced };
  }

  private async writeAll(next: MemoryItem[]): Promise<void> {
    this.cache = next;
    const serialized = `${next.map((it) => JSON.stringify(it)).join("\n")}\n`;
    // Unique tmp per save AND per process: with the shared `.tmp` name, two
    // overlapping writers renamed each other's tmp away and the loser threw
    // ENOENT (finding 19's second half).
    tmpCounter += 1;
    const tmp = `${this.path}.${process.pid}-${tmpCounter}.tmp`;
    await this.fs.writeFile(tmp, serialized);
    // Tried again where Windows holds the target for a moment (an antivirus,
    // OneDrive): one refusal lost the fact 板砖 had just been told to keep.
    await renameWithRetry(tmp, this.path, { rename: this.fs.rename });
  }

  currentItems(): readonly MemoryItem[] {
    return this.cache ?? [];
  }

  private async readAll(): Promise<MemoryItem[]> {
    let buf: Buffer;
    try {
      buf = await this.fs.readFile(this.path);
    } catch (err) {
      if (isMissingFsError(err)) return [];
      throw err;
    }
    const text = buf.toString("utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    const items: MemoryItem[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as MemoryItem;
        items.push(parsed);
      } catch {
        // silently drop corrupted line
      }
    }
    return items;
  }
}
