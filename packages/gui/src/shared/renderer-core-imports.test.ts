import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The renderer loads no value from `@herta/core`'s main entry (2026-10-29).
 *
 * That entry reaches `node:fs` and the rest of Node, which the renderer
 * does not have: vite stubs them, and the first access throws while the
 * module graph loads, so React never mounts and the window stays blank. A
 * type import is erased and costs nothing; a value comes from a subpath
 * written for the renderer (`@herta/core/browser-host`, `/page-element`,
 * …). `shared/` is held to the same rule, because the renderer imports it
 * too. The address bar's fix imported `typedPageUrl` from
 * `shared/browser-page.ts`, whose `isLoopbackHost` came from the main
 * entry: every unit test passed, and the dev app opened blank.
 */

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("renderer and shared code import no value from @herta/core's main entry", () => {
  it("every import or re-export of `@herta/core` there is a type", () => {
    const offenders: string[] = [];
    for (const file of [
      ...sources(join(SRC, "renderer")),
      ...sources(join(SRC, "shared")),
    ]) {
      const text = readFileSync(file, "utf8");
      const re = /\b(import|export)\s+([^;]*?)\s+from\s+["']@herta\/core["']/g;
      for (const m of text.matchAll(re)) {
        if (!/^type\b/.test(m[2] ?? "")) {
          offenders.push(
            `${relative(SRC, file)}: ${m[0].replace(/\s+/g, " ")}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
