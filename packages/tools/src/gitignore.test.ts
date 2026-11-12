import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { IgnoreStack, parseGitignore } from "./gitignore.js";
import { mkTmpWorkspace } from "./testing/tmp-workspace.js";
import { walkDir } from "./walker.js";

/** `.gitignore` for the walk that has no ripgrep (review 2026-11-10, second
 *  pass): the patterns as gitignore(5) gives them, checked against git. */

const root = (text: string): IgnoreStack => IgnoreStack.EMPTY.with("", text);

describe("IgnoreStack — one file's patterns", () => {
  it("a pattern without a slash matches a name at any depth", () => {
    const s = root("*.log\nvendor\n");
    expect(s.ignores("a.log", false)).toBe(true);
    expect(s.ignores("p/q/a.log", false)).toBe(true);
    expect(s.ignores("a.logs", false)).toBe(false);
    expect(s.ignores("vendor", true)).toBe(true);
    expect(s.ignores("p/vendor", true)).toBe(true);
  });

  it("a slash at the start or in the middle ties it to the file's directory", () => {
    const s = root("/root-only.txt\ndocs/*.md\nx/y\n");
    expect(s.ignores("root-only.txt", false)).toBe(true);
    expect(s.ignores("sub/root-only.txt", false)).toBe(false);
    expect(s.ignores("docs/a.md", false)).toBe(true);
    // `*` stays inside one name.
    expect(s.ignores("docs/deep/b.md", false)).toBe(false);
    expect(s.ignores("x/y", false)).toBe(true);
    expect(s.ignores("p/x/y", false)).toBe(false);
  });

  it("a trailing slash matches directories only", () => {
    const s = root("cache/\n");
    expect(s.ignores("cache", true)).toBe(true);
    expect(s.ignores("p/cache", true)).toBe(true);
    expect(s.ignores("cache", false)).toBe(false);
  });

  it("the last pattern that matches decides, so `!` re-includes", () => {
    const s = root("*.log\n!keep.log\n");
    expect(s.ignores("a.log", false)).toBe(true);
    expect(s.ignores("keep.log", false)).toBe(false);
    expect(root("!keep.log\n*.log\n").ignores("keep.log", false)).toBe(true);
  });

  it("`**` crosses directories: before, after and between", () => {
    const s = root("**/temp\nfoo/**\na/**/z.txt\n");
    expect(s.ignores("temp", true)).toBe(true);
    expect(s.ignores("p/q/temp", true)).toBe(true);
    expect(s.ignores("foo/1", false)).toBe(true);
    expect(s.ignores("foo/bar/2", false)).toBe(true);
    expect(s.ignores("foo", true)).toBe(false);
    expect(s.ignores("p/foo/3", false)).toBe(false);
    expect(s.ignores("a/z.txt", false)).toBe(true);
    expect(s.ignores("a/b/c/z.txt", false)).toBe(true);
    expect(s.ignores("b/z.txt", false)).toBe(false);
  });

  it("reads `?`, classes, escapes, comments and trailing spaces", () => {
    const s = root(
      "# a comment\n?.dat\n[ab].txt\n*.[oa]\n\\#literal\n\\!bang\ntrail.txt   \n\n",
    );
    expect(s.ignores("1.dat", false)).toBe(true);
    expect(s.ignores("12.dat", false)).toBe(false);
    expect(s.ignores("a.txt", false)).toBe(true);
    expect(s.ignores("c.txt", false)).toBe(false);
    expect(s.ignores("m.o", false)).toBe(true);
    expect(s.ignores("m.c", false)).toBe(false);
    expect(s.ignores("#literal", false)).toBe(true);
    expect(s.ignores("!bang", false)).toBe(true);
    expect(s.ignores("trail.txt", false)).toBe(true);
    expect(s.ignores("a comment", false)).toBe(false);
  });

  it("reads a file with CRLF line breaks, and a regex's own characters as text", () => {
    const s = root("*.bak\r\na+b(1).txt\r\n");
    expect(s.ignores("x.bak", false)).toBe(true);
    expect(s.ignores("a+b(1).txt", false)).toBe(true);
    expect(s.ignores("aab1.txt", false)).toBe(false);
  });

  it("a file of no patterns adds nothing", () => {
    expect(IgnoreStack.EMPTY.with("sub", "# only a comment\n\n")).toBe(
      IgnoreStack.EMPTY,
    );
    expect(parseGitignore("/\n!\n")).toEqual([]);
  });
});

describe("IgnoreStack — a deeper file", () => {
  it("applies below its own directory only, and after the shallower one", () => {
    const s = root("*.log\n*.cfg\n").with(
      "sub",
      "!again.log\n/only-here.txt\n",
    );
    expect(s.ignores("sub/again.log", false)).toBe(false);
    expect(s.ignores("again.log", false)).toBe(true);
    expect(s.ignores("sub/other.log", false)).toBe(true);
    expect(s.ignores("sub/only-here.txt", false)).toBe(true);
    expect(s.ignores("sub/p/only-here.txt", false)).toBe(false);
    expect(s.ignores("only-here.txt", false)).toBe(false);
    // A directory whose name only starts the same is not below it.
    expect(s.ignores("subway/again.log", false)).toBe(true);
  });
});

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasGit())("the walk agrees with git itself", () => {
  const IGNORES: Record<string, string> = {
    ".gitignore": [
      "# a comment",
      "*.log",
      "!keep.log",
      "/root-only.txt",
      "docs/*.md",
      "**/temp",
      "cache/",
      "a/**/z.txt",
      "foo/**",
      "[ab].txt",
      "?.dat",
      "\\#literal",
      "*.[oa]",
      "x/y",
      "trail.txt   ",
      "vendor",
      "!vendor/keep.txt",
      "mid**dle.txt",
      "deep/**/leaf/",
      "/anch*",
      "sub/ignored-by-root.txt",
      "generated-*/",
      "!generated-keep/",
      "*.tmp",
    ].join("\n"),
    "sub/.gitignore": [
      "!again.log",
      "/only-here.txt",
      "inner/",
      "*.cfg",
      "!wanted.cfg",
      "nested/**/skip.me",
    ].join("\n"),
    "sub/deeper/.gitignore": ["*.cfg", "!local.tmp", "/x"].join("\n"),
    "crlf/.gitignore": "*.bak\r\nkeepme\r\n",
  };
  const FILES = [
    "a.log",
    "keep.log",
    "root-only.txt",
    "sub/root-only.txt",
    "docs/a.md",
    "docs/deep/b.md",
    "docs/c.txt",
    "temp/x.txt",
    "p/q/temp/y.txt",
    "p/temp",
    "cache/c1",
    "p/cache/c2",
    "a/z.txt",
    "a/b/z.txt",
    "a/b/c/z.txt",
    "b/z.txt",
    "foo/1",
    "foo/bar/2",
    "p/foo/3",
    "a.txt",
    "b.txt",
    "c.txt",
    "ab.txt",
    "1.dat",
    "12.dat",
    "#literal",
    "m.o",
    "m.a",
    "m.c",
    "x/y",
    "p/x/y",
    "x/yy",
    "trail.txt",
    "vendor/keep.txt",
    "vendor/drop.txt",
    "p/vendor/v",
    "middle.txt",
    "mid-x-dle.txt",
    "mid/dle.txt",
    "deep/leaf/f",
    "deep/a/leaf/f",
    "deep/a/b/leaf/f",
    "deep/leaf.txt",
    "anchor.txt",
    "p/anchor.txt",
    "sub/ignored-by-root.txt",
    "p/sub/ignored-by-root.txt",
    "generated-1/g",
    "generated-keep/g",
    "sub/again.log",
    "sub/other.log",
    "sub/only-here.txt",
    "sub/p/only-here.txt",
    "sub/inner/i",
    "sub/p/inner/i",
    "sub/a.cfg",
    "sub/wanted.cfg",
    "sub/nested/skip.me",
    "sub/nested/a/b/skip.me",
    "sub/nested/keep.me",
    "sub/deeper/wanted.cfg",
    "sub/deeper/z.cfg",
    "sub/deeper/local.tmp",
    "sub/deeper/other.tmp",
    "sub/deeper/x",
    "sub/deeper/p/x",
    "plain.ts",
    "p/plain.ts",
    "crlf/a.bak",
    "crlf/keepme",
    "crlf/kept.txt",
    "t.tmp",
    "sub/t.tmp",
  ];

  it("on a tree of four .gitignore files, from the root and from below it", async () => {
    const ws = await mkTmpWorkspace({
      ...IGNORES,
      ...Object.fromEntries(FILES.map((f) => [f, "x\n"])),
    });
    try {
      execFileSync("git", ["init", "-q"], { cwd: ws.root });
      const kept = execFileSync(
        "git",
        [
          "-c",
          "core.excludesFile=",
          "-c",
          "core.quotePath=false",
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ],
        { cwd: ws.root, encoding: "utf8" },
      )
        .split("\0")
        .filter((p) => p !== "")
        .sort();
      // The fixture is not vacuous: git ignores most of it.
      expect(kept.length).toBeGreaterThan(20);
      expect(kept.length).toBeLessThan(FILES.length);

      const walked = async (start: string): Promise<string[]> => {
        const out: string[] = [];
        for await (const e of walkDir(ws.root, start, {
          recursive: true,
          gitignore: true,
        })) {
          if (e.type === "file") out.push(e.path);
        }
        return out.sort();
      };
      expect(await walked(ws.root)).toEqual(kept);
      for (const start of ["sub", "sub/deeper", "p", "docs", "crlf"]) {
        expect(await walked(`${ws.root}/${start}`)).toEqual(
          kept.filter((p) => p.startsWith(`${start}/`)),
        );
      }
    } finally {
      await ws.cleanup();
    }
  });
});
