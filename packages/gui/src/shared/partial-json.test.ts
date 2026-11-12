import { describe, expect, it } from "vitest";
import { JsonStringScanner, scanJsonStrings } from "./partial-json.js";

describe("scanJsonStrings", () => {
  it("reads every string value with its key, and not the keys themselves", () => {
    expect(
      scanJsonStrings('{"command":"create","path":"a.ts","file_text":"x"}'),
    ).toEqual([
      { key: "command", value: "create", complete: true },
      { key: "path", value: "a.ts", complete: true },
      { key: "file_text", value: "x", complete: true },
    ]);
  });

  it("is tolerant of a text cut off anywhere — the normal case while arguments stream", () => {
    expect(scanJsonStrings('{"path":"src/a')).toEqual([
      { key: "path", value: "src/a", complete: false },
    ]);
    expect(scanJsonStrings('{"path":"a.ts","file_te')).toEqual([
      { key: "path", value: "a.ts", complete: true },
    ]);
    expect(scanJsonStrings("")).toEqual([]);
    expect(scanJsonStrings("{")).toEqual([]);
  });

  it("decodes escapes, and leaves out one cut off at the end rather than guess", () => {
    expect(
      scanJsonStrings('{"t":"a\\nb\\t\\"q\\" \\\\ \\u4e2d"}')[0]?.value,
    ).toBe('a\nb\t"q" \\ 中');
    expect(scanJsonStrings('{"t":"line\\')[0]).toEqual({
      key: "t",
      value: "line",
      complete: false,
    });
    expect(scanJsonStrings('{"t":"x\\u4e')[0]?.value).toBe("x");
  });

  it("an array's elements carry the array's key; nested objects their own", () => {
    expect(
      scanJsonStrings(
        '{"path":"a.ts","hunks":[{"search":"old","replace":"new"},{"search":"o2","replace":"n',
      ),
    ).toEqual([
      { key: "path", value: "a.ts", complete: true },
      { key: "search", value: "old", complete: true },
      { key: "replace", value: "new", complete: true },
      { key: "search", value: "o2", complete: true },
      { key: "replace", value: "n", complete: false },
    ]);
    expect(
      scanJsonStrings('{"argv":["npm","test"],"cwd":"."}').map((f) => f.key),
    ).toEqual(["argv", "argv", "cwd"]);
  });

  it("a brace or quote inside a string value is text, not structure", () => {
    expect(
      scanJsonStrings('{"file_text":"if (a) { b(\\"}\\"); }","path":"x.ts"}'),
    ).toEqual([
      { key: "file_text", value: 'if (a) { b("}"); }', complete: true },
      { key: "path", value: "x.ts", complete: true },
    ]);
  });
});

describe("JsonStringScanner — the same fields, read as the text arrives (review 2026-11-10, second pass)", () => {
  const TEXTS = [
    JSON.stringify({ path: "src/a.ts", content: 'line 1\nline "2"\n\tend\\' }),
    JSON.stringify({
      command: "cat > f <<'EOF'\n{ \"a\": [1, 2] }\nEOF",
      timeout: 5,
      background: false,
    }),
    JSON.stringify({
      path: "x",
      hunks: [
        { search: "a{b}", replace: "c[d]" },
        { search: "é 中文 😀", replace: "" },
      ],
    }),
    JSON.stringify({
      argv: ["node", "--test", "a b"],
      env: { K: "v" },
      n: null,
    }),
    // Escapes the serializer does not write, as a model may. `String.raw`:
    // the backslashes are the text's own.
    String.raw`{"a":"\u4e2d\u6587 \/ \b\f","b":"tab\there","c":["\u00e9"]}`,
    // Malformed: a bad escape ends the scan, in both.
    String.raw`{"a":"ok","b":"bad \uZZZZ rest","c":"never"}`,
    String.raw`{"a":"x\u12`,
    String.raw`{"a":"cut \u12G4 short","b":"never"}`,
    '"top" ["loose", {"k": "v"}] "end',
    "",
  ];

  const fed = (text: string, sizes: readonly number[]): JsonStringScanner => {
    const scanner = new JsonStringScanner();
    let at = 0;
    for (let k = 0; at < text.length; k++) {
      const size = sizes[k % sizes.length] as number;
      scanner.push(text.slice(at, at + size));
      at += size;
    }
    return scanner;
  };

  it("agrees with a whole scan at every prefix, whatever the pieces", () => {
    for (const text of TEXTS) {
      for (let end = 0; end <= text.length; end++) {
        const prefix = text.slice(0, end);
        const whole = scanJsonStrings(prefix);
        for (const sizes of [
          [1],
          [2],
          [3, 1],
          [7, 2, 5],
          [prefix.length || 1],
        ]) {
          expect(
            fed(prefix, sizes).fields,
            `${JSON.stringify(prefix)} by ${sizes}`,
          ).toEqual(whole);
        }
      }
    }
  });

  it("keeps the fields it has: a value grows in place, and nothing is read twice", () => {
    const scanner = new JsonStringScanner();
    scanner.push('{"path":"a.ts","content":"one');
    const content = scanner.fields[1];
    expect(content).toEqual({ key: "content", value: "one", complete: false });
    // An escaped line break, as the arguments carry it.
    scanner.push(String.raw`\ntwo`);
    scanner.push('"}');
    // The same object, now whole.
    expect(scanner.fields[1]).toBe(content);
    expect(content).toEqual({
      key: "content",
      value: "one\ntwo",
      complete: true,
    });
  });
});
