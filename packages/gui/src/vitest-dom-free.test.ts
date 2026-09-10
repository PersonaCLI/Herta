import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOM_FREE_TESTS } from "../vitest.dom-free.js";

/**
 * Guards the two-project split (2026-08-27).
 *
 * Splitting the GUI suite by environment buys ~2/3 of its wall clock, and
 * introduces exactly one new failure mode worth fearing: a path that matches
 * NEITHER project. A test that silently never runs is worse than a slow one —
 * it reports green forever. These assertions make both halves of that
 * impossible to get wrong quietly.
 *
 * This file itself lives at `src/` (not `src/renderer/` or `src/main/`) so the
 * jsdom project's include patterns do not match it; the `gui-node` project
 * names it explicitly.
 */

const GUI_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** The same shapes the classification was made with. A file that starts
 *  touching any of these needs a real DOM and must leave the fast lane.
 *
 *  This reads the TEST file only, and that is a known half-measure: a test
 *  can mention no DOM while the module it exercises calls `window.setInterval`
 *  (now-tick, caught this way on the first run). Membership is therefore
 *  proven by RUNNING — a wrongly-listed file throws "window is not defined"
 *  immediately and loudly. This check catches the cheaper half early. */
const DOM_API =
  /\brender\(|\bdocument\.|\bwindow\.|@testing-library|\bscreen\.|jsdom|HTMLElement|getComputedStyle|localStorage|requestAnimationFrame|IntersectionObserver|ResizeObserver|createElement/;

describe("dom-free test list", () => {
  it("every listed path exists — a typo would silently skip the file", () => {
    // The dangerous case: `gui-node` includes a path that matches nothing and
    // the jsdom project excludes it anyway, so the tests vanish from BOTH
    // projects while the suite still reports green.
    const missing = DOM_FREE_TESTS.filter(
      (p) => !existsSync(join(GUI_ROOT, p)),
    );
    expect(missing).toEqual([]);
  });

  it("no listed file uses a DOM API", () => {
    // The other direction: someone adds a DOM assertion to a file already in
    // the fast lane. That fails loudly at runtime rather than silently, but
    // this says WHY, and points at the list rather than the test.
    const offenders = DOM_FREE_TESTS.filter((p) =>
      DOM_API.test(readFileSync(join(GUI_ROOT, p), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("runs in the node environment, without a DOM", () => {
    // Proves the project wiring actually took effect. If this file ever ran
    // under jsdom, the split silently stopped applying and the suite quietly
    // got slow again — the regression nobody notices.
    expect(typeof globalThis.document).toBe("undefined");
  });

  it("has no duplicate entries", () => {
    expect(new Set(DOM_FREE_TESTS).size).toBe(DOM_FREE_TESTS.length);
  });

  it("every test file under src/ is reached by one project or the other", () => {
    // The third hazard (2026-09-10): a test in a tree NEITHER include
    // pattern names. `src/shared/links.test.ts` — the external-link
    // allowlist — sat there for a day, green by absence. The jsdom
    // project's trees are listed here to match packages/gui/vitest.config.ts;
    // a new tree needs an entry in both places, and this says so.
    const JSDOM_TREES = ["src/renderer/", "src/main/", "src/shared/"];
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(p);
        } else if (/\.test\.tsx?$/.test(entry.name)) {
          found.push(relative(GUI_ROOT, p).split(sep).join("/"));
        }
      }
    };
    walk(join(GUI_ROOT, "src"));
    const listed = new Set<string>(DOM_FREE_TESTS);
    const orphans = found.filter(
      (p) =>
        p !== "src/vitest-dom-free.test.ts" &&
        !listed.has(p) &&
        !JSDOM_TREES.some((tree) => p.startsWith(tree)),
    );
    expect(orphans).toEqual([]);
    expect(found.length).toBeGreaterThan(DOM_FREE_TESTS.length);
  });
});
