import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreUndo, undoSpan } from "./undo-restore.js";
import {
  readUndoIndex,
  UndoStore,
  undoBlobPath,
  undoSegments,
  undoStoreDir,
} from "./undo-store.js";

const sha = (s: string | Buffer): string =>
  createHash("sha256").update(s).digest("hex");

let root: string;
let ws: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herta-undo-restore-"));
  ws = join(root, "ws");
  mkdirSync(ws, { recursive: true });
  dir = undoStoreDir(join(root, "transcript"), "sess");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/** Play an editor's writes through the store AND onto disk, as a run would:
 *  each step replaces the file's content (null: create it). */
async function run(
  steps: Array<{ file: string; to: string }>,
  store?: UndoStore,
): Promise<UndoStore> {
  const s = store ?? (await UndoStore.open(dir));
  const seg = s.openSegment(12, "task-1");
  for (const step of steps) {
    const path = join(ws, step.file);
    const before = existsSync(path) ? readFileSync(path) : null;
    await seg.undo.captureWrite({ path, before, after: sha(step.to) });
    writeFileSync(path, step.to);
  }
  return s;
}

const views = async () => undoSegments(await readUndoIndex(dir));

describe("taking a turn's edits back (ADR 0074 §3)", () => {
  it("a file as the turn left it gets its first bytes back — exactly, BOM and all", async () => {
    const original = Buffer.from("﻿alpha\n", "utf8");
    writeFileSync(join(ws, "a.ts"), original);
    const store = await run([
      { file: "a.ts", to: "beta\n" },
      { file: "a.ts", to: "gamma\n" },
    ]);
    await store.close();
    const outcome = await restoreUndo(dir, await views(), ws);
    expect(outcome.files).toEqual([
      { path: join(ws, "a.ts"), result: "restored" },
    ]);
    expect(readFileSync(join(ws, "a.ts")).equals(original)).toBe(true);
  });

  it("a file the turn created is deleted", async () => {
    await (await run([{ file: "new.ts", to: "fresh\n" }])).close();
    const outcome = await restoreUndo(dir, await views(), ws);
    expect(outcome.files).toEqual([
      { path: join(ws, "new.ts"), result: "deleted" },
    ]);
    expect(existsSync(join(ws, "new.ts"))).toBe(false);
  });

  it("a file already as it was is left alone — including a created file already gone", async () => {
    writeFileSync(join(ws, "a.ts"), "alpha\n");
    await (
      await run([
        { file: "a.ts", to: "beta\n" },
        { file: "new.ts", to: "fresh\n" },
      ])
    ).close();
    writeFileSync(join(ws, "a.ts"), "alpha\n");
    unlinkSync(join(ws, "new.ts"));
    const outcome = await restoreUndo(dir, await views(), ws);
    expect(outcome.files.map((f) => f.result)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    expect(existsSync(join(ws, "new.ts"))).toBe(false);
  });

  it("a file changed since 板砖 wrote it is never overwritten", async () => {
    writeFileSync(join(ws, "a.ts"), "alpha\n");
    await (await run([{ file: "a.ts", to: "beta\n" }])).close();
    writeFileSync(join(ws, "a.ts"), "the user's own edit\n");
    const outcome = await restoreUndo(dir, await views(), ws);
    expect(outcome.files).toEqual([
      { path: join(ws, "a.ts"), result: "changed_since" },
    ]);
    expect(readFileSync(join(ws, "a.ts"), "utf8")).toBe(
      "the user's own edit\n",
    );
  });

  it("bytes that were not kept are said so, and the file is left alone", async () => {
    writeFileSync(join(ws, "a.ts"), "alpha\n");
    await (await run([{ file: "a.ts", to: "beta\n" }])).close();
    unlinkSync(undoBlobPath(dir, sha("alpha\n")));
    const outcome = await restoreUndo(dir, await views(), ws);
    expect(outcome.files).toEqual([
      { path: join(ws, "a.ts"), result: "not_kept" },
    ]);
    expect(readFileSync(join(ws, "a.ts"), "utf8")).toBe("beta\n");
  });

  it("a path outside the workspace is refused, never written", async () => {
    const outside = join(root, "elsewhere.ts");
    writeFileSync(outside, "alpha\n");
    const store = await UndoStore.open(dir);
    const seg = store.openSegment(12, "task-1");
    await seg.undo.captureWrite({
      path: outside,
      before: Buffer.from("alpha\n"),
      after: sha("beta\n"),
    });
    writeFileSync(outside, "beta\n");
    await store.close();
    const outcome = await restoreUndo(dir, await views(), ws);
    expect(outcome.files).toEqual([
      { path: outside, result: "outside_workspace" },
    ]);
    expect(readFileSync(outside, "utf8")).toBe("beta\n");
  });

  it("several segments undo as one span: back to the earliest segment's first bytes", async () => {
    writeFileSync(join(ws, "a.ts"), "v1\n");
    const store = await run([{ file: "a.ts", to: "v2\n" }]);
    const second = store.openSegment(20, "task-2");
    await second.undo.captureWrite({
      path: join(ws, "a.ts"),
      before: readFileSync(join(ws, "a.ts")),
      after: sha("v3\n"),
    });
    writeFileSync(join(ws, "a.ts"), "v3\n");
    await store.close();
    const all = await views();
    expect(undoSpan(all).writes).toEqual([
      { path: join(ws, "a.ts"), before: sha("v1\n"), after: sha("v3\n") },
    ]);
    const outcome = await restoreUndo(dir, all, ws);
    expect(outcome.files.map((f) => f.result)).toEqual(["restored"]);
    expect(readFileSync(join(ws, "a.ts"), "utf8")).toBe("v1\n");
  });

  it("carries what commands changed and whether every byte was kept", async () => {
    writeFileSync(join(ws, "a.ts"), "alpha\n");
    const store = await UndoStore.open(dir);
    const seg = store.openSegment(12, "task-1");
    await seg.undo.captureWrite({
      path: join(ws, "a.ts"),
      before: Buffer.from("alpha\n"),
      after: sha("beta\n"),
    });
    await seg.noteCommands(["package-lock.json"]);
    const other = store.openSegment(14, "task-2");
    await other.noteCommands(null);
    await store.close();
    const outcome = await restoreUndo(dir, await views(), ws);
    expect(outcome.commands).toEqual({
      paths: ["package-lock.json"],
      unknown: true,
    });
    expect(outcome.incomplete).toBe(false);
  });
});
