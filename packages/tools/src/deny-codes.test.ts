import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CALL_ERROR_DENY_CODES, REFUSAL_DENY_CODES } from "@herta/core";
import { describe, expect, it } from "vitest";

/**
 * Every code a permission rule can deny with is decided — a call error or a
 * refusal (ADR 0047 amendment 2026-09-29, `permission-deny-codes.ts` in
 * @herta/core). The status gate exempts call errors; anything else caps the
 * run. A code decided in neither set still caps, conservatively — so a new
 * malformed-call code would silently undersell completed runs again (the
 * todo lab's `path_not_absolute`). This test makes a new code a decision.
 *
 * The rules' own sources are read: the codes are string literals spread over
 * the rules, the engines they plan with, the path-safety resolver and the
 * command classifiers' block tier. Ask codes (`…_ask`) are not denials.
 */
const SOURCES = [
  "src/str-replace-editor/rule.ts",
  "src/str-replace-editor/engine.ts",
  "src/edit-file/engine.ts",
  "src/run-command/rule.ts",
  "src/bash/rule.ts",
  "src/path-safety.ts",
];
/** Rules that share a file with their tool, whose error codes are not
 *  rule-denials: only the rule's own lines are read (review 2026-10-30, T2:
 *  neither was scanned, and `browser_off_loopback` was decided nowhere). */
const RULE_SLICES = [
  { rel: "src/browser/index.ts", from: "export function registerBrowserRules" },
  {
    rel: "src/launcher/tool.ts",
    from: "const rule: PermissionRule",
    to: "const tool: HertaTool",
  },
];
/** The command classifiers: only their block tier denies. */
const CLASSIFIERS = [
  "src/run-command/classifier.ts",
  "src/bash/shell-classifier.ts",
];

function read(rel: string): string {
  for (const base of [".", "packages/tools"]) {
    const p = resolve(process.cwd(), base, rel);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`${rel} not found from cwd`);
}

/** A rule's own lines, between two markers of its file. */
function slice(rel: string, from: string, to?: string): string {
  const text = read(rel);
  const start = text.indexOf(from);
  if (start === -1) throw new Error(`${from} not found in ${rel}`);
  const end = to === undefined ? text.length : text.indexOf(to, start);
  if (end === -1) throw new Error(`${to} not found in ${rel}`);
  return text.slice(start, end);
}

function denyCodes(): Set<string> {
  const codes = new Set<string>();
  for (const text0 of [
    ...SOURCES.map(read),
    ...RULE_SLICES.map((s) => slice(s.rel, s.from, s.to)),
  ]) {
    const text = text0.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    // `code: "x"`, a `deny("x", …)` helper, and a union `code: "a" | "b"`.
    for (const m of text.matchAll(
      /(?:code:\s*|deny\(\s*)"([a-z_]+)"((?:\s*\|\s*"[a-z_]+")*)/g,
    )) {
      codes.add(m[1] as string);
      for (const u of (m[2] ?? "").matchAll(/"([a-z_]+)"/g))
        codes.add(u[1] as string);
    }
  }
  for (const rel of CLASSIFIERS) {
    for (const m of read(rel).matchAll(
      /kind:\s*"block",\s*code:\s*"([a-z_]+)"/g,
    ))
      codes.add(m[1] as string);
  }
  for (const c of [...codes]) if (c.endsWith("_ask")) codes.delete(c);
  return codes;
}

describe("every rule-deny code is decided (ADR 0047 amendment 2026-09-29)", () => {
  it("finds the codes it should — the scan is not vacuous", () => {
    const codes = denyCodes();
    for (const known of [
      "invalid_input",
      "path_not_absolute",
      "edit_not_found",
      "hunk_ambiguous",
      "view_required",
      "path_outside_workspace",
      "path_denied",
      "command_blocked",
      "browser_off_loopback",
    ]) {
      expect(codes.has(known), known).toBe(true);
    }
  });

  it("each is a call error or a refusal, and never both", () => {
    const undecided = [...denyCodes()].filter(
      (c) => !CALL_ERROR_DENY_CODES.has(c) && !REFUSAL_DENY_CODES.has(c),
    );
    expect(undecided).toEqual([]);
    for (const c of CALL_ERROR_DENY_CODES)
      expect(REFUSAL_DENY_CODES.has(c), c).toBe(false);
  });
});
