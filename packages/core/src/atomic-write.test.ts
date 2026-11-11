import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  renameWithRetry,
  writeFileAtomic,
  writeFileAtomicSync,
} from "./atomic-write.js";

const dirs: string[] = [];
function mk(): string {
  const d = mkdtempSync(join(tmpdir(), "herta-atomic-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("writeFileAtomic (sync and async)", () => {
  it("writes the content, replaces an existing file, and leaves no temp behind", async () => {
    const d = mk();
    const target = join(d, "a.json");
    writeFileAtomicSync(target, "one\n");
    expect(readFileSync(target, "utf8")).toBe("one\n");
    await writeFileAtomic(target, Buffer.from("two\n"), { fsync: true });
    expect(readFileSync(target, "utf8")).toBe("two\n");
    expect(readdirSync(d)).toEqual(["a.json"]);
  });

  it("a failed rename leaves the previous file intact, removes the temp, and rethrows the ORIGINAL error", async () => {
    const d = mk();
    const target = join(d, "keep");
    writeFileSync(target, "previous", "utf8");
    // Renaming a file over a non-empty directory fails on every platform.
    const blocker = join(d, "dir");
    mkdirSync(blocker);
    writeFileSync(join(blocker, "child"), "x", "utf8");
    let caught: unknown;
    try {
      writeFileAtomicSync(blocker, "new");
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBeTruthy();
    await expect(writeFileAtomic(blocker, "new")).rejects.toMatchObject({
      code: expect.any(String),
    });
    expect(readFileSync(target, "utf8")).toBe("previous");
    // Only the target file and the blocking directory remain — no `.tmp`.
    expect(readdirSync(d).sort()).toEqual(["dir", "keep"]);
  });

  it("a missing directory fails at the write, with node's own code, and nothing is created", async () => {
    const d = mk();
    const target = join(d, "missing", "file.txt");
    expect(() => writeFileAtomicSync(target, "x")).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
    await expect(writeFileAtomic(target, "x")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(existsSync(join(d, "missing"))).toBe(false);
  });

  it("two writers in one process never share a temp name", () => {
    const d = mk();
    const target = join(d, "same.txt");
    // Interleave: the second write must not clobber the first's temp even
    // when both are in flight in the same millisecond.
    writeFileAtomicSync(target, "first");
    writeFileAtomicSync(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
    expect(readdirSync(d)).toEqual(["same.txt"]);
  });
});

describe("renameWithRetry (review 2026-11-10)", () => {
  const refusal = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: operation not permitted`), { code });

  it("on Windows a rename another process held for a moment goes through on a later try", async () => {
    let calls = 0;
    await renameWithRetry("a.tmp", "a", {
      platform: "win32",
      delaysMs: [1, 1, 1],
      rename: async () => {
        calls += 1;
        if (calls < 3) throw refusal(calls === 1 ? "EPERM" : "EBUSY");
      },
    });
    expect(calls).toBe(3);
  });

  it("gives up after its tries and throws the last refusal", async () => {
    let calls = 0;
    await expect(
      renameWithRetry("a.tmp", "a", {
        platform: "win32",
        delaysMs: [1, 1],
        rename: async () => {
          calls += 1;
          throw refusal("EACCES");
        },
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
    // One more try than waits.
    expect(calls).toBe(3);
  });

  it("an error that is not a held file is thrown at once", async () => {
    let calls = 0;
    await expect(
      renameWithRetry("a.tmp", "a", {
        platform: "win32",
        delaysMs: [1, 1],
        rename: async () => {
          calls += 1;
          throw refusal("ENOENT");
        },
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  it("off Windows the same codes mean what they say: no second try", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      let calls = 0;
      await expect(
        renameWithRetry("a.tmp", "a", {
          platform,
          rename: async () => {
            calls += 1;
            throw refusal("EPERM");
          },
        }),
      ).rejects.toMatchObject({ code: "EPERM" });
      expect(calls, platform).toBe(1);
    }
  });
});
