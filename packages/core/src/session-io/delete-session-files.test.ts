import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { undoStoreDir } from "../backend/undo-store.js";
import {
  deleteSessionFiles,
  recapCachePath,
  rmTreeWithRetry,
} from "./delete-session-files.js";

describe("rmTreeWithRetry — the managed workspace while a child still holds it (2026-09-18)", () => {
  const busy = (code: string) => Object.assign(new Error(code), { code });

  it("retries a busy directory until the remove succeeds", async () => {
    // Windows: the repository probe's `git` or the backend's shell can still
    // have the workspace as its cwd for a moment after close(); the first
    // rmdir answers EBUSY and rm's own maxRetries never engage.
    let calls = 0;
    const rmImpl = (async () => {
      calls += 1;
      if (calls < 3) throw busy("EBUSY");
    }) as unknown as typeof import("node:fs/promises").rm;
    await rmTreeWithRetry("X:/never/used", { rmImpl, pauseMs: 1 });
    expect(calls).toBe(3);
  });

  it("gives up at the deadline with the last error, never silently", async () => {
    const rmImpl = (async () => {
      throw busy("EBUSY");
    }) as unknown as typeof import("node:fs/promises").rm;
    await expect(
      rmTreeWithRetry("X:/never/used", { rmImpl, deadlineMs: 20, pauseMs: 5 }),
    ).rejects.toMatchObject({ code: "EBUSY" });
  });

  it("propagates a non-transient error at once", async () => {
    let calls = 0;
    const rmImpl = (async () => {
      calls += 1;
      throw busy("EACCES");
    }) as unknown as typeof import("node:fs/promises").rm;
    await expect(
      rmTreeWithRetry("X:/never/used", { rmImpl, pauseMs: 1 }),
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(calls).toBe(1);
  });
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "herta-del-"));
}

describe("deleteSessionFiles", () => {
  it("removes the transcript and title sidecar for the id", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.jsonl"), "{}");
    writeFileSync(join(dir, "a.title.json"), "{}");
    await deleteSessionFiles(dir, "a");
    expect(existsSync(join(dir, "a.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "a.title.json"))).toBe(false);
  });

  it("removes the session's undo store, and only its own (ADR 0074 §2)", async () => {
    const dir = tmp();
    const mine = undoStoreDir(dir, "a");
    const theirs = undoStoreDir(dir, "b");
    for (const d of [mine, theirs]) {
      mkdirSync(join(d, "blobs"), { recursive: true });
      writeFileSync(join(d, "index.jsonl"), "{}\n");
      writeFileSync(join(d, "blobs", "0".repeat(64)), "old bytes");
    }
    await deleteSessionFiles(dir, "a");
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(join(theirs, "index.jsonl"))).toBe(true);
  });

  it("a traversal id cannot reach a folder outside the undo dir", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "undo"), { recursive: true });
    const victim = join(dir, "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "keep.txt"), "x");
    await deleteSessionFiles(dir, "../victim");
    expect(existsSync(join(victim, "keep.txt"))).toBe(true);
  });

  it("is idempotent when files are already missing", async () => {
    const dir = tmp();
    await expect(deleteSessionFiles(dir, "ghost")).resolves.toBeUndefined();
  });

  it("removes the recap sidecar too, given a workspace root (audit BL8)", async () => {
    // It lives under `.herta/compaction`, OUTSIDE transcriptDir, so before
    // this it survived every delete — a growing pile of orphans describing
    // conversations that no longer exist.
    const ws = tmp();
    const dir = join(ws, ".herta", "transcript", "v2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.jsonl"), "{}");
    const sidecar = recapCachePath(ws, "a");
    mkdirSync(join(ws, ".herta", "compaction"), { recursive: true });
    writeFileSync(sidecar, "{}");

    await deleteSessionFiles(dir, "a", undefined, ws);
    expect(existsSync(sidecar)).toBe(false);
  });

  it("leaves the sidecar alone when no workspace root is given", async () => {
    // Callers that do not know the root keep the old behaviour rather than
    // guessing a path and deleting something else.
    const ws = tmp();
    const dir = join(ws, ".herta", "transcript", "v2");
    mkdirSync(dir, { recursive: true });
    const sidecar = recapCachePath(ws, "a");
    mkdirSync(join(ws, ".herta", "compaction"), { recursive: true });
    writeFileSync(sidecar, "{}");

    await deleteSessionFiles(dir, "a");
    expect(existsSync(sidecar)).toBe(true);
  });

  it("a traversal id cannot reach a sidecar outside the compaction dir", async () => {
    const ws = tmp();
    const outside = join(ws, "precious.json");
    writeFileSync(outside, "{}");
    await deleteSessionFiles(join(ws, "t"), "../../precious", undefined, ws);
    expect(existsSync(outside)).toBe(true);
  });

  it("leaves other sessions' files intact", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.jsonl"), "{}");
    writeFileSync(join(dir, "b.jsonl"), "{}");
    writeFileSync(join(dir, "b.title.json"), "{}");
    await deleteSessionFiles(dir, "a");
    expect(readdirSync(dir).sort()).toEqual(["b.jsonl", "b.title.json"]);
  });

  it("deletes the managed workspace dir for the id when a base dir is given — a tree, off the event loop", async () => {
    const transcriptDir = tmp();
    const workspacesDir = tmp();
    const wsPath = join(workspacesDir, "abc");
    // A small tree: the delete is recursive, and the whole point of the
    // async form is that a `node_modules`-sized one does not block the UI.
    mkdirSync(join(wsPath, "node_modules", "pkg", "lib"), { recursive: true });
    writeFileSync(join(wsPath, "scratch.ts"), "x");
    writeFileSync(join(wsPath, "node_modules", "pkg", "lib", "index.js"), "x");
    writeFileSync(join(transcriptDir, "abc.jsonl"), "{}");
    // The returned promise is the completion: nothing is gone before it
    // settles, everything is gone after.
    const done = deleteSessionFiles(transcriptDir, "abc", workspacesDir);
    await done;
    expect(existsSync(join(transcriptDir, "abc.jsonl"))).toBe(false);
    expect(existsSync(wsPath)).toBe(false);
  });

  it("is a no-op for the workspace dir when no base dir is given", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "abc.jsonl"), "{}");
    await expect(deleteSessionFiles(dir, "abc")).resolves.toBeUndefined();
  });

  it("never escapes the transcript dir (guard rejects a traversal id)", async () => {
    const outer = tmp();
    const transcriptDir = join(outer, "transcripts");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(outer, "victim.jsonl"), "{}");
    writeFileSync(join(outer, "victim.title.json"), "{}");
    await deleteSessionFiles(transcriptDir, "../victim");
    expect(existsSync(join(outer, "victim.jsonl"))).toBe(true);
    expect(existsSync(join(outer, "victim.title.json"))).toBe(true);
  });

  it("never follows an absolute-path id out of the transcript dir", async () => {
    const transcriptDir = tmp();
    const elsewhere = tmp();
    const victim = join(elsewhere, "victim");
    writeFileSync(`${victim}.jsonl`, "{}");
    await deleteSessionFiles(transcriptDir, victim);
    expect(existsSync(`${victim}.jsonl`)).toBe(true);
  });

  it("never escapes the workspaces base dir (guard rejects a traversal id)", async () => {
    const transcriptDir = tmp();
    const workspacesDir = tmp();
    writeFileSync(join(workspacesDir, "keep.txt"), "x");
    await deleteSessionFiles(transcriptDir, "..", workspacesDir);
    // The parent of the base must be untouched, and the base itself must survive.
    expect(existsSync(join(workspacesDir, "keep.txt"))).toBe(true);
    expect(existsSync(workspacesDir)).toBe(true);
  });
});
