import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { staleBuilds, staleBuildWarning } from "./warn-stale-dist.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A fake checkout: files by path, each with the second it was last written. */
function checkout(files: Record<string, number>): string {
  const root = mkdtempSync(join(tmpdir(), "herta-stale-"));
  roots.push(root);
  for (const [rel, second] of Object.entries(files)) {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "");
    utimesSync(abs, second, second);
  }
  return root;
}

const BUILT = 1_800_000_000;

describe("staleBuilds (review 2026-11-10)", () => {
  it("names a package whose source was written after its last build", () => {
    const root = checkout({
      "packages/tools/tsconfig.tsbuildinfo": BUILT,
      "packages/tools/dist/index.js": BUILT,
      "packages/tools/src/index.ts": BUILT - 500,
      "packages/tools/src/bash/rule.ts": BUILT + 600,
      "packages/core/tsconfig.tsbuildinfo": BUILT,
      "packages/core/dist/index.js": BUILT,
      "packages/core/src/index.ts": BUILT - 10,
    });
    const stale = staleBuilds(root, ["tools", "core"]);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ pkg: "tools", file: "src/bash/rule.ts" });
    expect(stale[0]?.behindMs).toBe(600_000);
    expect(staleBuildWarning(stale)).toContain(
      "packages/tools  (src/bash/rule.ts is 10 min newer than its build)",
    );
  });

  it("a test, a fixture and a declaration are not what another package imports", () => {
    const root = checkout({
      "packages/tools/tsconfig.tsbuildinfo": BUILT,
      "packages/tools/dist/index.js": BUILT,
      "packages/tools/src/index.ts": BUILT - 500,
      "packages/tools/src/index.test.ts": BUILT + 600,
      "packages/tools/src/__fixtures__/sample.ts": BUILT + 600,
      "packages/tools/src/types.d.ts": BUILT + 600,
      "packages/tools/src/notes.md": BUILT + 600,
    });
    expect(staleBuilds(root, ["tools"])).toEqual([]);
  });

  it("a save in the same moment as the build is not a stale build", () => {
    const root = checkout({
      "packages/tools/tsconfig.tsbuildinfo": BUILT,
      "packages/tools/dist/index.js": BUILT,
      "packages/tools/src/index.ts": BUILT + 1,
    });
    expect(staleBuilds(root, ["tools"])).toEqual([]);
  });

  it("a package never built is left to fail by itself", () => {
    const root = checkout({
      "packages/tools/src/index.ts": BUILT + 600,
      "packages/core/tsconfig.tsbuildinfo": BUILT,
      "packages/core/src/index.ts": BUILT + 600,
    });
    expect(staleBuilds(root, ["tools", "core", "absent"])).toEqual([]);
  });

  it("says nothing when every build is current", () => {
    expect(staleBuildWarning([])).toBeNull();
  });
});
