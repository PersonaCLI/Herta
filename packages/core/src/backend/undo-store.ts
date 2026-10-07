import { createHash } from "node:crypto";
import { type FileHandle, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import type { ToolCallUndo } from "../types/tool.js";

/**
 * The undo store (ADR 0074 §1–§2): what 板砖's editors replaced, kept so the
 * user can take the latest turn's edits back.
 *
 * One folder per session beside the session records: an `index.jsonl` and
 * `blobs/<sha256>`, content-addressed so the same bytes are kept once.
 *
 * Writes belong to a SEGMENT — one dispatch, or one 继续 continuation —
 * numbered in the order segments began, and carrying the record length it
 * began at (`at`). Which turn a segment belongs to is read from the record
 * when the user undoes; the number keeps two segments apart that began at
 * the same length (a rewind, then a new turn). Within a segment only the
 * FIRST write of a path keeps its bytes: a later write's "before" is the
 * segment's own earlier "after", and undoing returns each path from its last
 * after to its first before.
 *
 * Marks follow a segment's life: `withdrawn` when ⟲ takes its turn out of
 * the record, `undone` once its edits are taken back, `dropped` once they
 * can no longer be (its bytes go), `pruned` when the bound took its bytes.
 *
 * Everything here is best effort. A capture that fails records the write
 * all the same and marks the segment incomplete; the store never fails 板砖's
 * write (the ADR 0071 journal is the fail-closed record, not this).
 */

/** Bytes of kept pre-images per session; past it the oldest segments go. */
export const UNDO_SESSION_MAX_BYTES = 64 * 1024 * 1024;

const INDEX = "index.jsonl";

/** Where a session keeps its undo store: `undo/<sessionId>/` beside the
 *  session records, so the session listing never takes it for a session. */
export function undoStoreDir(transcriptDir: string, sessionId: string): string {
  return join(transcriptDir, "undo", sessionId);
}

export function undoBlobPath(dir: string, sha: string): string {
  return join(dir, "blobs", sha);
}

export type UndoMark = "withdrawn" | "undone" | "dropped";

export type UndoIndexEntry =
  /** A dispatch or a continuation began, at record length `at`. */
  | {
      readonly kind: "segment";
      readonly seg: number;
      readonly at: number;
      readonly taskId: string;
    }
  /** A file is about to be replaced: its sha256 before (null when it is
   *  being created) and after. The first entry per path per segment names
   *  the kept bytes. */
  | {
      readonly kind: "write";
      readonly seg: number;
      readonly path: string;
      readonly before: string | null;
      readonly after: string;
    }
  /** At the run's end: the paths its commands changed, or null when it ran
   *  commands and what they changed is not known (no repository). */
  | {
      readonly kind: "commands";
      readonly seg: number;
      readonly paths: readonly string[] | null;
    }
  /** Some bytes of this segment could not be kept. */
  | {
      readonly kind: "incomplete";
      readonly seg: number;
      readonly reason: string;
    }
  /** The bound dropped this segment's bytes. */
  | { readonly kind: "pruned"; readonly seg: number }
  | { readonly kind: UndoMark; readonly seg: number };

const MARKS: ReadonlySet<string> = new Set([
  "pruned",
  "withdrawn",
  "undone",
  "dropped",
]);

const isEntry = (e: unknown): e is UndoIndexEntry => {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  if (typeof o.seg !== "number") return false;
  switch (o.kind) {
    case "segment":
      return typeof o.at === "number" && typeof o.taskId === "string";
    case "write":
      return (
        typeof o.path === "string" &&
        (o.before === null || typeof o.before === "string") &&
        typeof o.after === "string"
      );
    case "commands":
      return (
        o.paths === null ||
        (Array.isArray(o.paths) && o.paths.every((p) => typeof p === "string"))
      );
    case "incomplete":
      return typeof o.reason === "string";
    default:
      return typeof o.kind === "string" && MARKS.has(o.kind);
  }
};

const parse = (text: string): UndoIndexEntry[] => {
  const out: UndoIndexEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const e: unknown = JSON.parse(line);
      if (isEntry(e)) out.push(e);
    } catch {
      // A torn line (the app died mid-append): skipped.
    }
  }
  return out;
};

/** Read a session's undo index back; empty when there is none. */
export async function readUndoIndex(dir: string): Promise<UndoIndexEntry[]> {
  try {
    return parse(await readFile(join(dir, INDEX), "utf8"));
  } catch {
    return [];
  }
}

/** One segment, folded from the index. */
export interface UndoSegmentView {
  readonly seg: number;
  readonly at: number;
  readonly taskId: string;
  /** Per path, in first-write order: the FIRST before (null: the segment
   *  created it) and the LAST after. */
  readonly writes: readonly {
    readonly path: string;
    readonly before: string | null;
    readonly after: string;
  }[];
  /** What the run's commands changed (`unknown`: it ran commands, and what
   *  they changed could not be read). Empty when it ran none it could see. */
  readonly commands: {
    readonly paths: readonly string[];
    readonly unknown: boolean;
  };
  readonly incomplete: boolean;
  readonly pruned: boolean;
  readonly withdrawn: boolean;
  readonly undone: boolean;
  readonly dropped: boolean;
}

/** Fold the index into its segments, in the order they began. */
export function undoSegments(
  entries: readonly UndoIndexEntry[],
): UndoSegmentView[] {
  interface Acc {
    seg: number;
    at: number;
    taskId: string;
    writes: Map<string, { path: string; before: string | null; after: string }>;
    commandPaths: Set<string>;
    commandsUnknown: boolean;
    incomplete: boolean;
    pruned: boolean;
    withdrawn: boolean;
    undone: boolean;
    dropped: boolean;
  }
  const acc = new Map<number, Acc>();
  const get = (seg: number): Acc => {
    let a = acc.get(seg);
    if (a === undefined) {
      a = {
        seg,
        at: -1,
        taskId: "",
        writes: new Map(),
        commandPaths: new Set(),
        commandsUnknown: false,
        incomplete: false,
        pruned: false,
        withdrawn: false,
        undone: false,
        dropped: false,
      };
      acc.set(seg, a);
    }
    return a;
  };
  for (const e of entries) {
    const a = get(e.seg);
    switch (e.kind) {
      case "segment":
        a.at = e.at;
        a.taskId = e.taskId;
        break;
      case "write": {
        const prior = a.writes.get(e.path);
        a.writes.set(e.path, {
          path: e.path,
          before: prior === undefined ? e.before : prior.before,
          after: e.after,
        });
        break;
      }
      case "commands":
        if (e.paths === null) a.commandsUnknown = true;
        else for (const p of e.paths) a.commandPaths.add(p);
        break;
      case "incomplete":
        a.incomplete = true;
        break;
      default:
        a[e.kind] = true;
    }
  }
  return [...acc.values()]
    .filter((a) => a.at >= 0)
    .map((a) => ({
      seg: a.seg,
      at: a.at,
      taskId: a.taskId,
      writes: [...a.writes.values()],
      commands: { paths: [...a.commandPaths], unknown: a.commandsUnknown },
      incomplete: a.incomplete,
      pruned: a.pruned,
      withdrawn: a.withdrawn,
      undone: a.undone,
      dropped: a.dropped,
    }));
}

/** What a run holds while it writes. */
export interface UndoSegment {
  readonly seg: number;
  /** The view its tools capture through (`ToolContext.undo`). */
  readonly undo: ToolCallUndo;
  /** At the run's end: the paths its commands changed, or null when it ran
   *  commands and what they changed is not known. Never rejects. */
  noteCommands(paths: readonly string[] | null): Promise<void>;
}

const sha256 = (b: Buffer): string =>
  createHash("sha256").update(b).digest("hex");

const reason = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

interface Live {
  /** Paths written in this segment: only the first write keeps bytes. */
  readonly paths: Set<string>;
  /** The kept blobs this segment's first writes name. */
  readonly blobs: Set<string>;
  /** Its bytes are no longer needed (pruned or dropped). */
  gone: boolean;
}

export class UndoStore {
  private handle: FileHandle | null = null;
  private tail: Promise<void> = Promise.resolve();
  /** The index does not end in a newline (a torn append): the next line
   *  starts on a fresh one. */
  private needsNewline = false;
  private nextSeg = 1;
  /** Every kept blob a live segment names, and its size. */
  private readonly blobSize = new Map<string, number>();
  private readonly segments = new Map<number, Live>();
  /** Segments in the order they began: the oldest is pruned first. */
  private readonly order: number[] = [];

  private constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
  ) {}

  /** Never rejects: a store that cannot be read starts empty. */
  static async open(
    dir: string,
    opts: { readonly maxBytes?: number } = {},
  ): Promise<UndoStore> {
    const store = new UndoStore(dir, opts.maxBytes ?? UNDO_SESSION_MAX_BYTES);
    await store.load().catch(() => undefined);
    return store;
  }

  /** A dispatch or a continuation begins at record length `at`. Its number
   *  is assigned at once; the entry is queued. */
  openSegment(at: number, taskId: string): UndoSegment {
    const seg = this.nextSeg++;
    this.live(seg);
    void this.enqueue(() => this.append({ kind: "segment", seg, at, taskId }));
    return {
      seg,
      undo: { captureWrite: (w) => this.capture(seg, w) },
      noteCommands: (paths) =>
        this.enqueue(() => this.append({ kind: "commands", seg, paths }), seg),
    };
  }

  /** Mark segments `withdrawn`, `undone` or `dropped`. A dropped segment's
   *  bytes go, unless a live segment names them too. Never rejects. */
  mark(kind: UndoMark, segs: readonly number[]): Promise<void> {
    return this.enqueue(async () => {
      for (const seg of segs) await this.append({ kind, seg });
      if (kind !== "dropped") return;
      for (const seg of segs) {
        const live = this.segments.get(seg);
        if (live === undefined) continue;
        live.gone = true;
        live.blobs.clear();
      }
      await this.collect();
    });
  }

  /** Wait for everything queued, then release the index. */
  async close(): Promise<void> {
    await this.tail;
    const handle = this.handle;
    this.handle = null;
    await handle?.close().catch(() => undefined);
  }

  private capture(
    seg: number,
    w: { path: string; before: Buffer | null; after: string },
  ): Promise<void> {
    return this.enqueue(async () => {
      const live = this.live(seg);
      const first = !live.paths.has(w.path);
      live.paths.add(w.path);
      const before = w.before === null ? null : sha256(w.before);
      let lost: string | null = null;
      if (first && w.before !== null && before !== null) {
        try {
          await this.keep(seg, live, before, w.before);
        } catch (err) {
          lost = reason(err);
        }
      }
      await this.append({
        kind: "write",
        seg,
        path: w.path,
        before,
        after: w.after,
      });
      if (lost !== null) {
        await this.append({ kind: "incomplete", seg, reason: lost });
      }
    }, seg);
  }

  /** Keep `bytes` as blob `sha`, making room under the bound first. */
  private async keep(
    seg: number,
    live: Live,
    sha: string,
    bytes: Buffer,
  ): Promise<void> {
    if (this.blobSize.has(sha)) {
      live.blobs.add(sha);
      return;
    }
    if (!(await this.makeRoom(seg, bytes.length))) {
      throw new Error(
        `past the session's ${this.maxBytes}-byte bound for kept edits`,
      );
    }
    await mkdir(join(this.dir, "blobs"), { recursive: true });
    await writeFileAtomic(undoBlobPath(this.dir, sha), bytes, { fsync: true });
    this.blobSize.set(sha, bytes.length);
    live.blobs.add(sha);
  }

  /** Drop the oldest segments' bytes (never `current`'s) until `size` more
   *  fits; false when it cannot. */
  private async makeRoom(current: number, size: number): Promise<boolean> {
    if (this.total() + size <= this.maxBytes) return true;
    for (const seg of this.order) {
      if (seg === current) continue;
      const live = this.segments.get(seg);
      if (live === undefined || live.gone) continue;
      await this.append({ kind: "pruned", seg });
      live.gone = true;
      live.blobs.clear();
      await this.collect();
      if (this.total() + size <= this.maxBytes) return true;
    }
    return false;
  }

  private total(): number {
    let total = 0;
    for (const n of this.blobSize.values()) total += n;
    return total;
  }

  /** Delete every kept blob no live segment names. */
  private async collect(): Promise<void> {
    for (const sha of [...this.blobSize.keys()]) {
      if (this.named(sha)) continue;
      await rm(undoBlobPath(this.dir, sha), { force: true }).catch(
        () => undefined,
      );
      this.blobSize.delete(sha);
    }
  }

  private named(sha: string): boolean {
    for (const live of this.segments.values()) {
      if (!live.gone && live.blobs.has(sha)) return true;
    }
    return false;
  }

  private live(seg: number): Live {
    let live = this.segments.get(seg);
    if (live === undefined) {
      live = { paths: new Set(), blobs: new Set(), gone: false };
      this.segments.set(seg, live);
      this.order.push(seg);
    }
    return live;
  }

  private async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(join(this.dir, INDEX), "utf8");
    } catch {
      return;
    }
    this.needsNewline = text.length > 0 && !text.endsWith("\n");
    for (const e of parse(text)) {
      this.nextSeg = Math.max(this.nextSeg, e.seg + 1);
      const live = this.live(e.seg);
      if (e.kind === "write") {
        if (!live.paths.has(e.path) && e.before !== null && !live.gone) {
          live.blobs.add(e.before);
        }
        live.paths.add(e.path);
      } else if (e.kind === "pruned" || e.kind === "dropped") {
        live.gone = true;
        live.blobs.clear();
      }
    }
    for (const live of this.segments.values()) {
      for (const sha of live.blobs) {
        if (this.blobSize.has(sha)) continue;
        const size = await readFile(undoBlobPath(this.dir, sha)).then(
          (b) => b.length,
          () => null,
        );
        if (size === null) live.blobs.delete(sha);
        else this.blobSize.set(sha, size);
      }
    }
  }

  private async append(entry: UndoIndexEntry): Promise<void> {
    if (this.handle === null) {
      await mkdir(this.dir, { recursive: true });
      this.handle = await open(join(this.dir, INDEX), "a");
    }
    const lead = this.needsNewline ? "\n" : "";
    await this.handle.appendFile(`${lead}${JSON.stringify(entry)}\n`, "utf8");
    this.needsNewline = false;
    await this.handle.sync();
  }

  /** Run `work` after everything queued before it. Never rejects: a failure
   *  is noted against segment `seg` when there is one, and swallowed. */
  private enqueue(work: () => Promise<void>, seg?: number): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        await work();
      } catch (err) {
        if (seg === undefined) return;
        await this.append({
          kind: "incomplete",
          seg,
          reason: reason(err),
        }).catch(() => undefined);
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result;
    return result;
  }
}
