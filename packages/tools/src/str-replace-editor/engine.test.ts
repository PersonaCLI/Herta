import { describe, expect, it } from "vitest";
import { planEdit } from "./engine.js";
import type { StrReplaceEditorInput } from "./schema.js";

const plan = (
  input: Partial<StrReplaceEditorInput> & { command: "str_replace" | "insert" },
  before: string,
) =>
  planEdit(
    { path: "f.js", ...input } as StrReplaceEditorInput,
    before,
    "f.js",
    "f.js",
  );

/** The lines of `text` that end in a `\n` with no `\r` before it. */
const bareLf = (text: string): string[] =>
  text
    .split("\n")
    .filter((l, i, all) => i < all.length - 1 && !l.endsWith("\r"));

describe("planEdit — a file whose lines end \\r\\n (review 2026-11-10)", () => {
  const file = ["function a() {", "  return 1;", "}", ""].join("\r\n");

  it("an old_str of two lines, written with \\n, is found", () => {
    const r = plan(
      {
        command: "str_replace",
        old_str: "function a() {\n  return 1;",
        new_str: "function a() {\n  return 2;",
      },
      file,
    );
    expect(r).toMatchObject({
      ok: true,
      after: "function a() {\r\n  return 2;\r\n}\r\n",
    });
  });

  it("a new_str of two lines leaves no bare \\n", () => {
    const r = plan(
      {
        command: "str_replace",
        old_str: "  return 1;",
        new_str: "  const x = 1;\n  return x;",
      },
      file,
    );
    if (!r.ok) throw new Error(r.message);
    expect(bareLf(r.after)).toEqual([]);
    expect(r.after).toBe(
      "function a() {\r\n  const x = 1;\r\n  return x;\r\n}\r\n",
    );
  });

  it("an insert takes the file's ending, in the middle and after a last line that has none", () => {
    const mid = plan(
      { command: "insert", insert_line: 1, new_str: "  // one\n  // two" },
      file,
    );
    if (!mid.ok) throw new Error(mid.message);
    expect(mid.after).toBe(
      "function a() {\r\n  // one\r\n  // two\r\n  return 1;\r\n}\r\n",
    );
    const end = plan(
      { command: "insert", insert_line: 2, new_str: "c\r\nd" },
      "a\r\nb",
    );
    if (!end.ok) throw new Error(end.message);
    expect(end.after).toBe("a\r\nb\r\nc\r\nd");
  });

  it("an old_str written with \\r\\n works as it did, and the messages quote old_str as written", () => {
    expect(
      plan(
        {
          command: "str_replace",
          old_str: "  return 1;\r\n}",
          new_str: "  return 3;\r\n}",
        },
        file,
      ),
    ).toMatchObject({
      ok: true,
      after: "function a() {\r\n  return 3;\r\n}\r\n",
    });
    const missing = plan(
      { command: "str_replace", old_str: "x\ny", new_str: "" },
      file,
    );
    expect(missing).toMatchObject({ ok: false, code: "edit_not_found" });
    if (!missing.ok) expect(missing.message).toContain("`x\ny`");
    const twice = plan(
      { command: "str_replace", old_str: "a\nb", new_str: "" },
      "a\r\nb\r\na\r\nb\r\n",
    );
    expect(twice).toMatchObject({ ok: false, code: "edit_ambiguous" });
    if (!twice.ok) expect(twice.message).toContain("in lines [1, 3]");
  });

  it("a file with both endings, and a \\n file, are edited exactly as written", () => {
    const mixed = "a\r\nb\nc\n";
    expect(
      plan({ command: "str_replace", old_str: "a\nb", new_str: "x" }, mixed),
    ).toMatchObject({ ok: false, code: "edit_not_found" });
    expect(
      plan({ command: "insert", insert_line: 1, new_str: "x" }, mixed),
    ).toMatchObject({ ok: true, after: "a\r\nx\nb\nc\n" });
    expect(
      plan({ command: "insert", insert_line: 1, new_str: "x" }, "a\nb\n"),
    ).toMatchObject({ ok: true, after: "a\nx\nb\n" });
  });
});
