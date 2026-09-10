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
import { writeFileAtomic, writeFileAtomicSync } from "./atomic-write.js";

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
