import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The stylesheet's own bytes, read off disk (see record-left.test.ts for why
 *  not `import.meta.url` or `?raw`). */
const CSS = ((): string => {
  const rel = "src/renderer/styles/reference-ux.css";
  for (const base of [".", "packages/gui"]) {
    const p = resolve(process.cwd(), base, rel);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error("reference-ux.css not found from cwd");
})();

function ruleBody(selector: string): string {
  const re = new RegExp(
    `^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "m",
  );
  const body = re.exec(CSS)?.[1];
  if (body === undefined) throw new Error(`no rule for ${selector}`);
  // Comments may mention the very properties being checked.
  return body.replace(/\/\*[\s\S]*?\*\//g, "");
}
const px = (value: string | undefined): number =>
  Number.parseFloat(value ?? "NaN");

/**
 * A card-menu row nested inside a PADDED section reaches the menu's edges by
 * bleeding through that padding — and the bleed has to be in the WIDTH too.
 *
 * The bug (owner 2026-09-21): 改为逐项确认 sits in `.card-menu-trust`
 * (padding 12px a side) and is a `.card-menu-item` — `width: 100%`. Its
 * `margin: 2px -12px 0` moved the box 12px left; the fixed width did not
 * grow, so the hover band started at the menu's left edge and stopped 24px
 * short of its right one. Measured in the real app: 254px against the 278px
 * of the rows above it; 278px after.
 *
 * jsdom applies no stylesheet, so the geometry cannot be asserted here. What
 * can be — and is exactly what was missing — is that the three numbers still
 * agree: the section's side padding, the negative side margin, and the width
 * that makes up for both.
 */
describe("the switch row's toggle hover band runs edge to edge", () => {
  it("bleeds the section's side padding in its margin AND its width", () => {
    // The trust row's rules, kept by the automatic-review row that replaced
    // it (ADR 0075 amendment 2026-10-10).
    const section = ruleBody(".card-menu-review");
    const toggle = ruleBody(".card-menu-review-toggle");
    // `padding: <top> <sides> <bottom>`
    const sidePad = px(/padding:\s*\S+\s+(\S+?)px/.exec(section)?.[1]);
    // `margin: <top> -<sides> <bottom>`
    const sideMargin = px(/margin:\s*\S+\s+(-\S+?)px/.exec(toggle)?.[1]);
    const extraWidth = px(
      /width:\s*calc\(\s*100%\s*\+\s*(\S+?)px\s*\)/.exec(toggle)?.[1],
    );
    expect(sidePad).toBeGreaterThan(0);
    expect(sideMargin).toBe(-sidePad);
    expect(extraWidth).toBe(2 * sidePad);
  });

  it("anti-vacuous: the row it is measured against really is width: 100%", () => {
    // The premise of the bleed — if `.card-menu-item` ever stops fixing its
    // width, the calc above is what to revisit, not this test to delete.
    expect(ruleBody(".card-menu-item")).toMatch(/width:\s*100%/);
  });
});
