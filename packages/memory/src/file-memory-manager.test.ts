import { join } from "node:path";
import type { MemoryItem } from "@herta/core";
import { describe, expect, it } from "vitest";
import { FileMemoryManager, type FsShim } from "./file-memory-manager.js";

interface InMemoryFs {
  files: Map<string, string>;
  dirs: Set<string>;
}

function makeShim(initial?: InMemoryFs): { shim: FsShim; state: InMemoryFs } {
  const state: InMemoryFs = initial ?? {
    files: new Map(),
    dirs: new Set(),
  };
  const shim: FsShim = {
    async readFile(p) {
      const f = state.files.get(p);
      if (f === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return Buffer.from(f, "utf8");
    },
    async writeFile(p, data) {
      state.files.set(p, data);
    },
    async mkdir(p, _opts) {
      state.dirs.add(p);
    },
    async rename(oldP, newP) {
      const data = state.files.get(oldP);
      if (data === undefined) {
        const err = new Error(`ENOENT: ${oldP}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      state.files.set(newP, data);
      state.files.delete(oldP);
    },
  };
  return { shim, state };
}

const ROOT = "/ws";
const FILE_PATH = join(ROOT, ".herta", "memory", "project.jsonl");

function mkItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: "id-1",
    scope: "repo",
    kind: "build_command",
    text: "pnpm build",
    sourceSession: "s1",
    createdAt: "2026-05-04T00:00:00.000Z",
    lastSeen: "2026-05-04T00:00:00.000Z",
    confidence: 1,
    ...overrides,
  };
}

describe("FileMemoryManager", () => {
  it("recall returns [] when memory file is missing", async () => {
    const { shim } = makeShim();
    const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    expect(await m.recall({})).toEqual([]);
  });

  it("recall parses items from existing JSONL file", async () => {
    const { shim, state } = makeShim();
    const item = mkItem();
    state.files.set(FILE_PATH, `${JSON.stringify(item)}\n`);
    const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    const items = await m.recall({});
    expect(items).toEqual([item]);
  });

  it("save creates the dir and writes the file", async () => {
    const { shim, state } = makeShim();
    const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    await m.save(mkItem());
    expect(state.dirs.has(join(ROOT, ".herta", "memory"))).toBe(true);
    expect(state.files.has(FILE_PATH)).toBe(true);
  });

  it("save + recall round-trip", async () => {
    const { shim } = makeShim();
    const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    const item = mkItem();
    await m.save(item);
    const items = await m.recall({});
    expect(items).toEqual([item]);
  });

  it("save is idempotent on dedupe key (same kind+text)", async () => {
    const { shim } = makeShim();
    const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    await m.save(mkItem({ id: "id-1" }));
    await m.save(mkItem({ id: "id-2", createdAt: "2026-05-05T00:00:00.000Z" }));
    const items = await m.recall({});
    expect(items.length).toBe(1);
    expect(items[0]?.id).toBe("id-1");
  });

  it("save evicts oldest by createdAt when at cap (200 items)", async () => {
    const { shim, state } = makeShim();
    const initial = Array.from({ length: 200 }, (_, i) =>
      mkItem({
        id: `id-${i}`,
        text: `item-${i}`,
        createdAt: `2026-05-04T00:${String(i).padStart(2, "0")}:00.000Z`,
      }),
    );
    state.files.set(
      FILE_PATH,
      `${initial.map((it) => JSON.stringify(it)).join("\n")}\n`,
    );
    const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    await m.save(
      mkItem({
        id: "id-new",
        text: "item-new",
        createdAt: "2026-05-04T03:00:00.000Z",
      }),
    );
    const items = await m.recall({});
    expect(items.length).toBe(200);
    expect(items.find((i) => i.id === "id-0")).toBeUndefined();
    expect(items.find((i) => i.id === "id-new")).toBeDefined();
  });

  it("save writes atomically (unique .tmp then rename — audit finding 19)", async () => {
    const renamePairs: Array<[string, string]> = [];
    const { shim, state } = makeShim();
    const origRename = shim.rename;
    shim.rename = async (oldP, newP) => {
      renamePairs.push([oldP, newP]);
      await origRename(oldP, newP);
    };
    const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    await m.save(mkItem());
    expect(renamePairs).toHaveLength(1);
    const [tmp, dest] = renamePairs[0] as [string, string];
    expect(dest).toBe(FILE_PATH);
    // Tmp names are unique per save + per process — the old shared
    // `project.jsonl.tmp` let two overlapping writers consume each other's
    // tmp (the loser's rename threw ENOENT).
    expect(tmp.startsWith(`${FILE_PATH}.`)).toBe(true);
    expect(tmp.endsWith(".tmp")).toBe(true);
    for (const p of state.files.keys()) {
      expect(p.endsWith(".tmp")).toBe(false);
    }
  });

  it("save merges with on-disk items written by ANOTHER process (audit finding 19)", async () => {
    const { shim, state } = makeShim();
    const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    // This process boots and populates its cache from an empty file.
    await m.recall({});
    // Another process (CLI alongside the GUI) writes its own item.
    const foreign = mkItem({ id: "foreign", text: "from the other process" });
    state.files.set(FILE_PATH, `${JSON.stringify(foreign)}\n`);
    // Pre-fix this save rewrote the file from the stale boot-time cache,
    // erasing the other process's item.
    await m.save(mkItem({ id: "mine", text: "from this process" }));
    const onDisk = (state.files.get(FILE_PATH) ?? "")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => (JSON.parse(l) as MemoryItem).id)
      .sort();
    expect(onDisk).toEqual(["foreign", "mine"]);
  });

  it("recall reads the on-disk truth — a fact ANOTHER process saved after boot is served (ADR 0060)", async () => {
    const { shim, state } = makeShim();
    const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    // This process boots and reads an empty store.
    expect(await m.recall({})).toEqual([]);
    // The CLI beside the GUI saves a fact.
    const foreign = mkItem({ id: "foreign", text: "from the other process" });
    state.files.set(FILE_PATH, `${JSON.stringify(foreign)}\n`);
    // Pre-fix recall served the boot-time cache for the life of the process,
    // so the backend's recall at brief start never saw it.
    expect(await m.recall({})).toEqual([foreign]);
    expect(m.currentItems()).toEqual([foreign]);
  });

  it("concurrent saves both land (no shared-tmp ENOENT)", async () => {
    const { shim, state } = makeShim();
    const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    await Promise.all([
      m.save(mkItem({ id: "a", text: "alpha" })),
      m.save(mkItem({ id: "b", text: "beta" })),
    ]);
    const onDisk = (state.files.get(FILE_PATH) ?? "")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => (JSON.parse(l) as MemoryItem).id)
      .sort();
    expect(onDisk).toEqual(["a", "b"]);
  });

  it("two managers on one workspace in one process keep each other's saves (release review 2026-10-13)", async () => {
    // Each manager queued only its own saves: both read the file, and the
    // second write dropped the first's fact — or, both naming their tmp
    // `<pid>-1`, the loser's rename threw ENOENT.
    const { shim, state } = makeShim();
    const a = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    const b = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    await Promise.all([
      a.save(mkItem({ id: "a1", text: "alpha" })),
      b.save(mkItem({ id: "b1", text: "beta" })),
      a.save(mkItem({ id: "a2", text: "gamma" })),
      b.save(mkItem({ id: "b2", text: "delta" })),
    ]);
    const onDisk = (state.files.get(FILE_PATH) ?? "")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => (JSON.parse(l) as MemoryItem).id)
      .sort();
    expect(onDisk).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("currentItems returns [] before any recall or save", () => {
    const { shim } = makeShim();
    const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    expect(m.currentItems()).toEqual([]);
  });

  it("currentItems reflects the cache after recall populates it", async () => {
    const { shim, state } = makeShim();
    const itemA = mkItem({ id: "a", text: "first" });
    const itemB = mkItem({ id: "b", text: "second" });
    state.files.set(
      FILE_PATH,
      `${JSON.stringify(itemA)}\n${JSON.stringify(itemB)}\n`,
    );
    const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    await m.recall({});
    const items = m.currentItems();
    expect(items.length).toBe(2);
    expect(items.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });

  it("currentItems includes a newly-saved item without a re-read", async () => {
    const { shim, state } = makeShim();
    const itemA = mkItem({ id: "a", text: "first" });
    state.files.set(FILE_PATH, `${JSON.stringify(itemA)}\n`);
    const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    await m.recall({});
    await m.save(mkItem({ id: "b", text: "second" }));
    const items = m.currentItems();
    expect(items.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });

  it("currentItems returns [] if the JSONL file does not exist", async () => {
    const { shim } = makeShim();
    const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
    await m.recall({}); // triggers ensureCache; file missing → empty
    expect(m.currentItems()).toEqual([]);
  });

  describe("replace — a correction (ADR 0077 amendment 2026-11-09)", () => {
    const WRONG = "3f9c2a71-0b4e-4d1a-9c55-1e2f3a4b5c6d";
    const OTHER = "8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

    function seeded() {
      const { shim, state } = makeShim();
      const wrong = mkItem({
        id: WRONG,
        kind: "test_command",
        text: "the tests run with node --test test/",
      });
      const other = mkItem({
        id: OTHER,
        kind: "style_preference",
        text: "tabs",
      });
      state.files.set(
        FILE_PATH,
        `${JSON.stringify(wrong)}\n${JSON.stringify(other)}\n`,
      );
      const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
      return { m, state, wrong, other };
    }

    it("the named fact goes and the correction takes its place; the rest stay", async () => {
      const { m, wrong, other } = seeded();
      const fixed = mkItem({
        id: "new-1",
        kind: "test_command",
        text: "the tests run with bare node --test",
        lastSeen: "2026-11-09T00:00:00.000Z",
      });
      const outcome = await m.replace("3f9c2a71", fixed);
      expect(outcome).toEqual({ ok: true, replaced: wrong });
      expect(await m.recall({})).toEqual([other, fixed]);
    });

    it("names a fact by the handle recall shows, the whole id, or with an id: lead-in", async () => {
      for (const name of ["3f9c2a71", WRONG, "id:3F9C2A71", "#3f9c2a71"]) {
        const { m } = seeded();
        const outcome = await m.replace(name, mkItem({ id: "n", text: "x" }));
        expect(outcome.ok, name).toBe(true);
      }
    });

    it("writes nothing when no fact has the id, or when the name is shorter than a handle", async () => {
      for (const name of ["deadbeef", "3f9c2a7", ""]) {
        const { m, state } = seeded();
        const before = state.files.get(FILE_PATH);
        const outcome = await m.replace(name, mkItem({ id: "n", text: "x" }));
        expect(outcome, name).toEqual({ ok: false, reason: "not_found" });
        expect(state.files.get(FILE_PATH)).toBe(before);
      }
    });

    it("writes nothing when more than one fact has an id that starts so", async () => {
      const { shim, state } = makeShim();
      state.files.set(
        FILE_PATH,
        [
          mkItem({ id: "aaaaaaaa-1111", text: "one" }),
          mkItem({ id: "aaaaaaaa-2222", text: "two" }),
        ]
          .map((it) => JSON.stringify(it))
          .join("\n"),
      );
      const before = state.files.get(FILE_PATH);
      const m = new FileMemoryManager({ workspaceRoot: ROOT, fs: shim });
      const outcome = await m.replace(
        "aaaaaaaa",
        mkItem({ id: "n", text: "x" }),
      );
      expect(outcome).toEqual({ ok: false, reason: "ambiguous" });
      expect(state.files.get(FILE_PATH)).toBe(before);
    });

    it("a correction that says what another saved fact says re-confirms that one", async () => {
      const { m, other } = seeded();
      const outcome = await m.replace(
        "3f9c2a71",
        mkItem({
          id: "n",
          kind: "style_preference",
          text: "tabs",
          lastSeen: "2026-11-09T00:00:00.000Z",
        }),
      );
      expect(outcome.ok).toBe(true);
      const items = await m.recall({});
      expect(items).toHaveLength(1);
      expect(items[0]?.id).toBe(other.id);
      expect(items[0]?.lastSeen).toBe("2026-11-09T00:00:00.000Z");
    });

    it("waits in the same queue as save, so neither drops the other", async () => {
      const { m } = seeded();
      await Promise.all([
        m.save(mkItem({ id: "s", kind: "repo_fact", text: "saved alongside" })),
        m.replace("3f9c2a71", mkItem({ id: "n", text: "corrected" })),
      ]);
      const texts = (await m.recall({})).map((it) => it.text).sort();
      expect(texts).toEqual(["corrected", "saved alongside", "tabs"]);
    });
  });
});
