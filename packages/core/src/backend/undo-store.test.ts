import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readUndoIndex,
  UNDO_SESSION_MAX_BYTES,
  UndoStore,
  undoBlobPath,
  undoSegments,
  undoStoreDir,
} from "./undo-store.js";

const sha = (s: string | Buffer): string =>
  createHash("sha256").update(s).digest("hex");

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herta-undo-"));
  dir = undoStoreDir(join(root, "transcript"), "sess");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

const blobs = (): string[] =>
  existsSync(join(dir, "blobs")) ? readdirSync(join(dir, "blobs")).sort() : [];

describe("the undo store keeps what 板砖's editors replaced (ADR 0074 §1–§2)", () => {
  it("lives in an undo/ folder beside the session records, one folder per session", () => {
    expect(dir).toBe(join(root, "transcript", "undo", "sess"));
  });

  it("the first write of a path in a segment keeps its bytes; a later write of the same path keeps none", async () => {
    const store = await UndoStore.open(dir);
    const s = store.openSegment(12, "task-1");
    await s.undo.captureWrite({
      path: "/w/a.ts",
      before: Buffer.from("v1"),
      after: sha("v2"),
    });
    await s.undo.captureWrite({
      path: "/w/a.ts",
      before: Buffer.from("v2"),
      after: sha("v3"),
    });
    await store.close();
    expect(s.seg).toBe(1);
    expect(await readUndoIndex(dir)).toEqual([
      { kind: "segment", seg: 1, at: 12, taskId: "task-1" },
      {
        kind: "write",
        seg: 1,
        path: "/w/a.ts",
        before: sha("v1"),
        after: sha("v2"),
      },
      {
        kind: "write",
        seg: 1,
        path: "/w/a.ts",
        before: sha("v2"),
        after: sha("v3"),
      },
    ]);
    expect(blobs()).toEqual([sha("v1")]);
    expect(undoBlobPath(dir, sha("v1"))).toBe(join(dir, "blobs", sha("v1")));
  });

  it("a file being created has nothing before: no bytes are kept", async () => {
    const store = await UndoStore.open(dir);
    const s = store.openSegment(3, "task-1");
    await s.undo.captureWrite({
      path: "/w/new.ts",
      before: null,
      after: sha("x"),
    });
    await store.close();
    expect((await readUndoIndex(dir)).at(-1)).toEqual({
      kind: "write",
      seg: s.seg,
      path: "/w/new.ts",
      before: null,
      after: sha("x"),
    });
    expect(blobs()).toEqual([]);
  });

  it("each segment keeps its own first bytes, and the same bytes are kept once", async () => {
    const store = await UndoStore.open(dir);
    const a = store.openSegment(12, "task-1");
    await a.undo.captureWrite({
      path: "/w/a.ts",
      before: Buffer.from("v1"),
      after: sha("v2"),
    });
    await a.undo.captureWrite({
      path: "/w/b.ts",
      before: Buffer.from("same"),
      after: sha("b2"),
    });
    const b = store.openSegment(20, "task-2");
    await b.undo.captureWrite({
      path: "/w/a.ts",
      before: Buffer.from("v2"),
      after: sha("v3"),
    });
    await b.undo.captureWrite({
      path: "/w/c.ts",
      before: Buffer.from("same"),
      after: sha("c2"),
    });
    await store.close();
    expect([a.seg, b.seg]).toEqual([1, 2]);
    expect(blobs()).toEqual([sha("same"), sha("v1"), sha("v2")].sort());
  });

  it("segments are numbered across reopenings, so two at the same record length never mix", async () => {
    const first = await UndoStore.open(dir);
    const a = first.openSegment(12, "task-1");
    await a.undo.captureWrite({
      path: "/w/a.ts",
      before: Buffer.from("v1"),
      after: sha("v2"),
    });
    await first.close();
    const second = await UndoStore.open(dir);
    // The same record length again (a rewind, then a new turn): a new segment.
    const b = second.openSegment(12, "task-9");
    await b.undo.captureWrite({
      path: "/w/a.ts",
      before: Buffer.from("v1"),
      after: sha("v9"),
    });
    await second.close();
    expect(b.seg).toBe(2);
    const views = undoSegments(await readUndoIndex(dir));
    expect(views.map((v) => [v.seg, v.at, v.taskId, v.writes.length])).toEqual([
      [1, 12, "task-1", 1],
      [2, 12, "task-9", 1],
    ]);
  });

  it("a run notes the paths its commands changed — or that it ran commands whose changes are unknown", async () => {
    const store = await UndoStore.open(dir);
    const a = store.openSegment(12, "task-1");
    await a.noteCommands(["package-lock.json"]);
    const b = store.openSegment(20, "task-2");
    await b.noteCommands(null);
    await store.close();
    const views = undoSegments(await readUndoIndex(dir));
    expect(views.map((v) => v.commands)).toEqual([
      { paths: ["package-lock.json"], unknown: false },
      { paths: [], unknown: true },
    ]);
  });

  it("the reader folds each segment: its writes, first before and last after per path, and its marks", async () => {
    const store = await UndoStore.open(dir);
    const s = store.openSegment(12, "task-1");
    await s.undo.captureWrite({
      path: "/w/a.ts",
      before: Buffer.from("v1"),
      after: sha("v2"),
    });
    await s.undo.captureWrite({
      path: "/w/a.ts",
      before: Buffer.from("v2"),
      after: sha("v3"),
    });
    await store.mark("withdrawn", [s.seg]);
    await store.mark("undone", [s.seg]);
    await store.close();
    const [view] = undoSegments(await readUndoIndex(dir));
    expect(view).toMatchObject({
      seg: 1,
      at: 12,
      writes: [{ path: "/w/a.ts", before: sha("v1"), after: sha("v3") }],
      incomplete: false,
      pruned: false,
      withdrawn: true,
      undone: true,
      dropped: false,
    });
  });

  it("a dropped segment's bytes go, unless a live segment names them too", async () => {
    const store = await UndoStore.open(dir);
    const a = store.openSegment(12, "task-1");
    await a.undo.captureWrite({
      path: "/w/a.ts",
      before: Buffer.from("only-a"),
      after: sha("a2"),
    });
    await a.undo.captureWrite({
      path: "/w/s.ts",
      before: Buffer.from("shared"),
      after: sha("s2"),
    });
    const b = store.openSegment(20, "task-2");
    await b.undo.captureWrite({
      path: "/w/t.ts",
      before: Buffer.from("shared"),
      after: sha("t2"),
    });
    await store.mark("dropped", [a.seg]);
    await store.close();
    expect(blobs()).toEqual([sha("shared")]);
    const views = undoSegments(await readUndoIndex(dir));
    expect(views.find((v) => v.seg === a.seg)?.dropped).toBe(true);
  });

  it("fail-open: when the bytes cannot be kept, the write is still recorded and the segment is marked incomplete", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "blobs"), "not a folder");
    const store = await UndoStore.open(dir);
    const s = store.openSegment(12, "task-1");
    await expect(
      s.undo.captureWrite({
        path: "/w/a.ts",
        before: Buffer.from("v1"),
        after: sha("v2"),
      }),
    ).resolves.toBeUndefined();
    await store.close();
    const [view] = undoSegments(await readUndoIndex(dir));
    expect(view?.writes).toEqual([
      { path: "/w/a.ts", before: sha("v1"), after: sha("v2") },
    ]);
    expect(view?.incomplete).toBe(true);
  });

  it("never rejects, even when nothing at all can be written", async () => {
    mkdirSync(join(root, "transcript", "undo"), { recursive: true });
    writeFileSync(dir, "a file where the folder should be");
    const store = await UndoStore.open(dir);
    const s = store.openSegment(12, "task-1");
    await expect(
      s.undo.captureWrite({
        path: "/w/a.ts",
        before: Buffer.from("v1"),
        after: sha("v2"),
      }),
    ).resolves.toBeUndefined();
    await expect(s.noteCommands(null)).resolves.toBeUndefined();
    await expect(store.mark("undone", [s.seg])).resolves.toBeUndefined();
    await store.close();
  });

  it("the per-session bound drops the oldest segment's bytes first, keeping bytes a surviving segment shares", async () => {
    const store = await UndoStore.open(dir, { maxBytes: 10 });
    const a = store.openSegment(1, "t1");
    await a.undo.captureWrite({
      path: "/w/a.ts",
      before: Buffer.from("aaaaaa"),
      after: sha("a2"),
    });
    await a.undo.captureWrite({
      path: "/w/s.ts",
      before: Buffer.from("ss"),
      after: sha("s2"),
    });
    const b = store.openSegment(2, "t2");
    await b.undo.captureWrite({
      path: "/w/t.ts",
      before: Buffer.from("ss"),
      after: sha("t2"),
    });
    await b.undo.captureWrite({
      path: "/w/b.ts",
      before: Buffer.from("bbbbbb"),
      after: sha("b2"),
    });
    await store.close();
    // 6 + 2 + 6 = 14 > 10: segment a goes; "ss" stays, segment b needs it.
    expect(blobs()).toEqual([sha("bbbbbb"), sha("ss")].sort());
    const views = undoSegments(await readUndoIndex(dir));
    expect(views.map((v) => v.pruned)).toEqual([true, false]);
  });

  it("a segment that alone passes the bound keeps what fits and marks itself incomplete", async () => {
    const store = await UndoStore.open(dir, { maxBytes: 10 });
    const s = store.openSegment(1, "t1");
    await s.undo.captureWrite({
      path: "/w/a.ts",
      before: Buffer.from("aaaaaa"),
      after: sha("a2"),
    });
    await s.undo.captureWrite({
      path: "/w/b.ts",
      before: Buffer.from("bbbbbb"),
      after: sha("b2"),
    });
    await store.close();
    expect(blobs()).toEqual([sha("aaaaaa")]);
    const [view] = undoSegments(await readUndoIndex(dir));
    expect(view?.incomplete).toBe(true);
    // The write is on record all the same: part of the turn, not restorable.
    expect(view?.writes.map((w) => w.path)).toEqual(["/w/a.ts", "/w/b.ts"]);
  });

  it("the default bound is 64 MiB", () => {
    expect(UNDO_SESSION_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it("an absent store reads as empty; a torn last line is skipped, and the next entry starts on a fresh line", async () => {
    expect(await readUndoIndex(dir)).toEqual([]);
    const first = await UndoStore.open(dir);
    first.openSegment(12, "task-1");
    await first.close();
    appendFileSync(join(dir, "index.jsonl"), '{"kind":"wri');
    const second = await UndoStore.open(dir);
    second.openSegment(20, "task-2");
    await second.close();
    expect(await readUndoIndex(dir)).toEqual([
      { kind: "segment", seg: 1, at: 12, taskId: "task-1" },
      { kind: "segment", seg: 2, at: 20, taskId: "task-2" },
    ]);
  });
});
