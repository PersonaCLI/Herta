import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentEvent,
  BackgroundHost,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
} from "@herta/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import {
  isAttachmentSearchRoot,
  isHertaCarveOutSearchRoot,
  type SearchTextData,
  searchTextTool,
} from "./index.js";
import { detectRg } from "./rg-engine.js";

const rgBin = await detectRg();

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

function ctx(workspaceRoot: string, reads = new ReadLedger()) {
  return {
    sessionId: "s",
    signal: new AbortController().signal,
    workspaceRoot,
    reads,
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    memory: new NoopMemoryManager(),
  };
}
const noopProgress = () => {};

describe("searchTextTool", () => {
  it("throws AbortError on an aborted signal (audit M4: interrupt, not a tool result)", async () => {
    ws = await mkTmpWorkspace({ "a.ts": "const foo = 1;\n" });
    const tool = searchTextTool();
    const ac = new AbortController();
    ac.abort();
    await expect(
      tool.run(
        { id: "1", tool: "search_text", input: { pattern: "foo" } },
        { ...ctx(ws.root), signal: ac.signal },
        noopProgress,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects a catastrophic-backtracking pattern as invalid_pattern (audit 2026-07-13 T2.3)", async () => {
    ws = await mkTmpWorkspace({ "a.ts": "aaaa\n" });
    const tool = searchTextTool();
    const r = await tool.run(
      { id: "1", tool: "search_text", input: { pattern: "(a+)+$" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    const error = (r as { error: { code: string; retryable: boolean } }).error;
    expect(error.code).toBe("invalid_pattern");
    expect(error.retryable).toBe(false);
  });

  it("finds literal-style matches with regex pattern", async () => {
    ws = await mkTmpWorkspace({
      "a.ts": "const foo = 1;\nconst bar = 2;\n",
      "b.ts": "function foo() {}\n",
    });
    const tool = searchTextTool();
    const r = await tool.run(
      { id: "1", tool: "search_text", input: { pattern: "foo" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as {
      matches: { path: string; line: number; content: string }[];
      truncated: boolean;
    };
    expect(data.matches).toHaveLength(2);
    expect(data.matches.map((m) => m.path).sort()).toEqual(["a.ts", "b.ts"]);
    expect(data.truncated).toBe(false);
  });

  it("sorts matches by path then line", async () => {
    ws = await mkTmpWorkspace({
      "z.ts": "foo\nfoo\nfoo\n",
      "a.ts": "foo\nfoo\n",
    });
    const tool = searchTextTool();
    const r = await tool.run(
      { id: "1", tool: "search_text", input: { pattern: "foo" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { matches: { path: string; line: number }[] };
    expect(data.matches.map((m) => `${m.path}:${m.line}`)).toEqual([
      "a.ts:1",
      "a.ts:2",
      "z.ts:1",
      "z.ts:2",
      "z.ts:3",
    ]);
  });

  it("supports case-insensitive search", async () => {
    ws = await mkTmpWorkspace({
      "a.ts": "Foo\nFOO\nbar\n",
    });
    const tool = searchTextTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "search_text",
        input: { pattern: "foo", caseSensitive: false },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { matches: unknown[] };
    expect(data.matches).toHaveLength(2);
  });

  it("returns context lines when requested", async () => {
    ws = await mkTmpWorkspace({
      "a.ts": "line1\nline2\nMATCH\nline4\nline5\n",
    });
    const tool = searchTextTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "search_text",
        input: { pattern: "MATCH", contextLines: 1 },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as {
      matches: {
        contextBefore?: string[];
        contextAfter?: string[];
      }[];
    };
    expect(data.matches[0]?.contextBefore).toEqual(["line2"]);
    expect(data.matches[0]?.contextAfter).toEqual(["line4"]);
  });

  it("truncates at maxMatches", async () => {
    const lines = Array.from({ length: 10 }, () => "foo").join("\n");
    ws = await mkTmpWorkspace({ "a.ts": lines });
    const tool = searchTextTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "search_text",
        input: { pattern: "foo", maxMatches: 3 },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { matches: unknown[]; truncated: boolean };
    expect(data.matches).toHaveLength(3);
    expect(data.truncated).toBe(true);
  });

  it("skips files with NUL byte in first 4KB", async () => {
    const buf = new Uint8Array(100);
    buf[5] = 0;
    ws = await mkTmpWorkspace({
      "bin.dat": buf,
      "good.ts": "foo\n",
    });
    const tool = searchTextTool();
    const r = await tool.run(
      { id: "1", tool: "search_text", input: { pattern: "foo" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { matches: { path: string }[] };
    expect(data.matches.map((m) => m.path)).toEqual(["good.ts"]);
  });

  it("returns invalid_pattern for bad regex", async () => {
    ws = await mkTmpWorkspace({ "a.ts": "x" });
    const tool = searchTextTool();
    const r = await tool.run(
      { id: "1", tool: "search_text", input: { pattern: "[unclosed" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("invalid_pattern");
    expect(r.error?.retryable).toBe(false);
  });

  it("returns invalid_input for empty pattern", async () => {
    ws = await mkTmpWorkspace({ "a.ts": "x" });
    const tool = searchTextTool();
    const r = await tool.run(
      { id: "1", tool: "search_text", input: { pattern: "" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("invalid_input");
  });

  it("respects skip list", async () => {
    ws = await mkTmpWorkspace({
      "src/foo.ts": "foo\n",
      "node_modules/lib.js": "foo\n",
    });
    const tool = searchTextTool();
    const r = await tool.run(
      { id: "1", tool: "search_text", input: { pattern: "foo" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { matches: { path: string }[] };
    expect(data.matches.map((m) => m.path)).toEqual(["src/foo.ts"]);
  });

  it("returns not_found for missing path", async () => {
    ws = await mkTmpWorkspace({});
    const tool = searchTextTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "search_text",
        input: { pattern: "x", path: "nope" },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("not_found");
  });

  it("searches a single FILE when path names one (2026-08-17; was invalid_input)", async () => {
    // Same pipeline as a walked file — loader, size cap, sniff, redaction,
    // context — so the shape equals a directory search that matched only it.
    ws = await mkTmpWorkspace({
      "a.ts": "line one\nfoo here\nline three\nfoo again\n",
      "b.ts": "foo elsewhere\n",
    });
    const tool = searchTextTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "search_text",
        input: { pattern: "foo", path: "a.ts", contextLines: 1 },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as SearchTextData;
    // Only a.ts — b.ts is not searched.
    expect(data.matches.map((m) => `${m.path}:${m.line}`)).toEqual([
      "a.ts:2",
      "a.ts:4",
    ]);
    expect(data.matches[0]?.contextBefore).toEqual(["line one"]);
    expect(data.matches[0]?.contextAfter).toEqual(["line three"]);
    expect(data.truncated).toBe(false);
  });

  it("a single-file search honours maxMatches, the size cap and the binary sniff", async () => {
    ws = await mkTmpWorkspace({
      "many.txt": Array.from({ length: 10 }, () => "foo").join("\n"),
      "bin.dat": Buffer.from([
        0x66, 0x6f, 0x6f, 0x00, 0x66, 0x6f, 0x6f,
      ]).toString("latin1"),
    });
    const tool = searchTextTool();
    const capped = await tool.run(
      {
        id: "1",
        tool: "search_text",
        input: { pattern: "foo", path: "many.txt", maxMatches: 3 },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(capped.ok).toBe(true);
    expect((capped.data as SearchTextData).matches).toHaveLength(3);
    expect((capped.data as SearchTextData).truncated).toBe(true);
    // A binary file named directly is skipped, not errored — same as when
    // the walker meets it.
    const bin = await tool.run(
      {
        id: "2",
        tool: "search_text",
        input: { pattern: "foo", path: "bin.dat" },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(bin.ok).toBe(true);
    expect((bin.data as SearchTextData).matches).toHaveLength(0);
  });

  it("denies path outside workspace", async () => {
    ws = await mkTmpWorkspace({});
    const tool = searchTextTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "search_text",
        input: { pattern: "x", path: "../../etc" },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("path_outside_workspace");
  });

  it("exposes JSON Schema via schema()", async () => {
    const tool = searchTextTool();
    const schema = tool.schema();
    expect(schema.name).toBe("search_text");
    expect(schema.description.length).toBeGreaterThan(0);
    expect(schema.inputSchema).toBeDefined();
  });

  // 2026-07-10 audit, finding 1: only the search ROOT was validated — the
  // walk read `.env` / `*.pem` past the credential denylist and returned
  // their contents as matches, straight into the model-facing transcript.

  it("skips credential-denylisted files instead of matching inside them", async () => {
    ws = await mkTmpWorkspace({
      ".env": "DEEPSEEK_API_KEY=sk-supersecret123456789\n",
      "sub/server.pem": "-----BEGIN PRIVATE KEY-----\n",
      id_rsa: "API_KEY material\n",
      "src/config.ts": 'const name = "API_KEY";\n',
    });
    const tool = searchTextTool();
    const r = await tool.run(
      { id: "1", tool: "search_text", input: { pattern: "API_KEY" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as { matches: { path: string; content: string }[] };
    expect(data.matches.map((m) => m.path)).toEqual(["src/config.ts"]);
    expect(JSON.stringify(data)).not.toContain("sk-supersecret");

    const pem = await tool.run(
      { id: "2", tool: "search_text", input: { pattern: "PRIVATE" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(pem.ok).toBe(true);
    expect((pem.data as { matches: unknown[] }).matches).toHaveLength(0);
  });

  it("redacts secret values in match content and context lines", async () => {
    ws = await mkTmpWorkspace({
      "docker-compose.yml":
        "services:\n  GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
    });
    const tool = searchTextTool();
    const r = await tool.run(
      {
        id: "1",
        tool: "search_text",
        input: { pattern: "services", contextLines: 1 },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as {
      matches: { content: string; contextAfter?: string[] }[];
    };
    expect(data.matches).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain("ghp_abcdef");
    expect(data.matches[0]?.contextAfter?.[0]).toContain("[REDACTED");
  });

  it("does not follow a file symlink out of the workspace", async () => {
    ws = await mkTmpWorkspace({ "readme.md": "no secrets here\n" });
    const outside = `${ws.root}-outside`;
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "LEAKME=oops\n");
    try {
      await symlink(join(outside, "secret.txt"), join(ws.root, "notes.txt"));
    } catch {
      // Windows without admin / Developer Mode cannot create file symlinks;
      // the underlying realpath check is covered by path-safety tests.
      await rm(outside, { recursive: true, force: true });
      return;
    }
    const tool = searchTextTool();
    const r = await tool.run(
      { id: "1", tool: "search_text", input: { pattern: "LEAKME" } },
      ctx(ws.root),
      noopProgress,
    );
    await rm(outside, { recursive: true, force: true });
    expect(r.ok).toBe(true);
    expect((r.data as { matches: unknown[] }).matches).toHaveLength(0);
  });

  it("falls back to the JS scanner for JS-only regex dialect (lookbehind) — works with or without rg", async () => {
    ws = await mkTmpWorkspace({
      "a.ts": "const fooBar = 1;\nconst bar = 2;\n",
    });
    const r = await searchTextTool().run(
      // Rust regex has no lookbehind — rg exits 2 with no candidates and
      // the JS engine takes over transparently.
      { id: "1", tool: "search_text", input: { pattern: "(?<=foo)Bar" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as SearchTextData;
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]?.line).toBe(1);
  });
});

describe("searchTextTool — the JS engine and .gitignore (review 2026-11-10, second pass)", () => {
  const js = (root: string, input: Record<string, unknown>) =>
    searchTextTool({ engine: "js" }).run(
      { id: "1", tool: "search_text", input },
      ctx(root),
      noopProgress,
    );
  const paths = (r: { data?: unknown }): string[] =>
    (r.data as SearchTextData).matches.map((m) => m.path);

  it("does not search what .gitignore ignores, as ripgrep does not", async () => {
    ws = await mkTmpWorkspace({
      ".gitignore": "generated/\n*.min.js\n",
      "src/a.ts": "needle\n",
      "generated/bundle.ts": "needle\n",
      "src/app.min.js": "needle\n",
      "src/.gitignore": "!keep.min.js\n",
      "src/keep.min.js": "needle\n",
    });
    const r = await js(ws.root, { pattern: "needle" });
    expect(r.ok).toBe(true);
    expect(paths(r)).toEqual(["src/a.ts", "src/keep.min.js"]);
  });

  it("still searches an ignored directory or file that `path` names", async () => {
    ws = await mkTmpWorkspace({
      ".gitignore": "generated/\n*.min.js\n",
      "generated/bundle.ts": "needle\n",
      "src/app.min.js": "needle\n",
    });
    expect(
      paths(await js(ws.root, { pattern: "needle", path: "generated" })),
    ).toEqual(["generated/bundle.ts"]);
    expect(
      paths(await js(ws.root, { pattern: "needle", path: "src/app.min.js" })),
    ).toEqual(["src/app.min.js"]);
  });

  it("a search that ran out of time says so first, and not `found 0 matches`", async () => {
    ws = await mkTmpWorkspace({
      "a.ts": "nothing here\n",
      "b.ts": "needle\n",
    });
    // The clock jumps past the scan budget after the search has started.
    const real = Date.now();
    let calls = 0;
    const spy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (calls++ === 0 ? real : real + 60_000));
    try {
      const r = await js(ws.root, { pattern: "needle" });
      expect(r.ok).toBe(true);
      expect((r.data as SearchTextData).truncated).toBe(true);
      expect(
        r.summary.startsWith("search incomplete: stopped at the 10s"),
      ).toBe(true);
      expect(r.summary).toContain("after 0 files with 0 matches so far");
      expect(r.summary).toContain("was not searched");
      expect(r.summary).not.toMatch(/^found 0 matches/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe.skipIf(rgBin === null)(
  "searchTextTool — ripgrep engine parity",
  () => {
    it("rg and JS engines return identical results on a mixed fixture", async () => {
      ws = await mkTmpWorkspace({
        "src/a.ts": "alpha();\nbeta();\nalpha();\n",
        "src/deep/b.md": "gamma alpha\n",
        ".hidden/c.ts": "alpha hidden\n",
        "node_modules/dep/d.ts": "alpha ignored\n",
        "big.txt": "alpha\n",
      });
      const input = { pattern: "alpha", contextLines: 1 };
      const auto = await searchTextTool().run(
        { id: "1", tool: "search_text", input },
        ctx(ws.root),
        noopProgress,
      );
      const js = await searchTextTool({ engine: "js" }).run(
        { id: "2", tool: "search_text", input },
        ctx(ws.root),
        noopProgress,
      );
      expect(auto.ok).toBe(true);
      expect(js.ok).toBe(true);
      expect(auto.data).toEqual(js.data);
      const paths = (auto.data as SearchTextData).matches.map((m) => m.path);
      expect(paths).toContain(".hidden/c.ts"); // --hidden parity with the walker
      expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
    });

    it("rg path preserves redact-before-match: a pattern targeting a raw secret finds nothing", async () => {
      ws = await mkTmpWorkspace({
        "config.ts":
          "const t = 'ghp_abcdefabcdefabcdefabcdefabcdefabcdef12';\nplain line\n",
      });
      const r = await searchTextTool().run(
        // Matches the RAW token; the redacted line no longer matches, so the
        // verification stage must drop rg's candidate (no probe oracle).
        {
          id: "1",
          tool: "search_text",
          input: { pattern: "ghp_abcdefabcdef" },
        },
        ctx(ws.root),
        noopProgress,
      );
      expect(r.ok).toBe(true);
      expect((r.data as SearchTextData).matches).toHaveLength(0);
    });

    it("rg path caps at maxMatches with truncated=true", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 6; i += 1) files[`f${i}.txt`] = "needle\nneedle\n";
      ws = await mkTmpWorkspace(files);
      const r = await searchTextTool().run(
        {
          id: "1",
          tool: "search_text",
          input: { pattern: "needle", maxMatches: 5 },
        },
        ctx(ws.root),
        noopProgress,
      );
      expect(r.ok).toBe(true);
      const data = r.data as SearchTextData;
      expect(data.matches).toHaveLength(5);
      expect(data.truncated).toBe(true);
    });
  },
);

describe("searchTextTool — attachments (ADR 0033, amended 2026-08-10)", () => {
  it("searches an attachment when pointed at it", async () => {
    // The ADR justifies STORING an oversized or binary attachment on the
    // grounds that 板砖 can still search it, and the backend's citation line
    // promises exactly that. Until this carve-out, `.herta` denied the path
    // and the promise was false.
    ws = await mkTmpWorkspace({
      ".herta/attachments/s1/notes.md": "alpha\nNEEDLE-IN-ATTACHMENT\nbeta\n",
    });
    const r = await searchTextTool().run(
      {
        id: "1",
        tool: "search_text",
        input: {
          pattern: "NEEDLE-IN-ATTACHMENT",
          path: ".herta/attachments/s1",
        },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as SearchTextData;
    expect(data.matches.length).toBeGreaterThan(0);
    expect(data.matches[0]?.path).toContain("notes.md");
  });

  it("a workspace-root search still never descends into .herta", async () => {
    // The carve-out opens an EXPLICIT path, not discovery: the walker skips
    // any `.herta` directory it meets, so ordinary searches stay clean and
    // an attachment cannot leak into an unrelated result set.
    ws = await mkTmpWorkspace({
      "src/a.ts": "const x = 1;\n",
      ".herta/attachments/s1/notes.md": "SECRET-STRING-XYZ\n",
    });
    const r = await searchTextTool().run(
      { id: "1", tool: "search_text", input: { pattern: "SECRET-STRING-XYZ" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    expect((r.data as SearchTextData).matches).toHaveLength(0);
  });

  it("the carve-out does not open the rest of .herta", async () => {
    ws = await mkTmpWorkspace({ ".herta/keys/deepseek": "sk-live\n" });
    const r = await searchTextTool().run(
      {
        id: "1",
        tool: "search_text",
        input: { pattern: "sk-", path: ".herta/keys" },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(false);
  });

  it("searches a stored-without-excerpt attachment ABOVE the 1MiB scan cap", async () => {
    // Review 2026-08-10: the files this carve-out exists for are the over-2MB
    // ones the ingest stored on the promise they stay searchable — and the
    // ordinary scan cap silently skipped them, making the first carve-out fix
    // true only for files small enough to have excerpts anyway.
    const big = `${"x".repeat(3 * 1024 * 1024)}\nDEEP-NEEDLE-42\n`;
    ws = await mkTmpWorkspace({ ".herta/attachments/s1/big.log": big });
    const r = await searchTextTool().run(
      {
        id: "1",
        tool: "search_text",
        input: { pattern: "DEEP-NEEDLE-42", path: ".herta/attachments/s1" },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    expect((r.data as SearchTextData).matches.length).toBeGreaterThan(0);
  });

  it("`path` may name the attachment FILE itself (real session 2026-08-16)", async () => {
    // The bridge's citation hands 板砖 the file path and says it is
    // searchable; §6a says "point `path` AT it". 板砖 did — and got
    // `not a directory`. A single file is the natural target for "which lines
    // of this log mention X".
    ws = await mkTmpWorkspace({
      ".herta/attachments/s1/log-a1e18c1b.txt":
        "warning: amplitude\nTraceback\ntorch.OutOfMemoryError: CUDA out of memory\nCUDA_VISIBLE_DEVICES=0\n",
    });
    const r = await searchTextTool().run(
      {
        id: "1",
        tool: "search_text",
        input: {
          pattern: "CUDA|world_size",
          path: ".herta/attachments/s1/log-a1e18c1b.txt",
        },
      },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const data = r.data as SearchTextData;
    expect(data.matches.map((m) => m.line)).toEqual([3, 4]);
    expect(data.matches[0]?.path).toBe(
      ".herta/attachments/s1/log-a1e18c1b.txt",
    );
    // The receipt names WHERE — this string is what the done-marker roll-up
    // carries, and "found 5 matches in 1 files" gave Herta nothing to cite.
    expect((r as { summary: string }).summary).toBe(
      "found 2 matches in 1 files for /CUDA|world_size/ — .herta/attachments/s1/log-a1e18c1b.txt:3,4",
    );
    // The data echoes the pattern so the record row can name it.
    expect(data.pattern).toBe("CUDA|world_size");
  });

  it("the receipt's location list is bounded (3 files × 6 lines, then …)", async () => {
    const files: Record<string, string> = {};
    for (const f of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
      files[f] = Array.from({ length: 8 }, () => "needle").join("\n");
    }
    ws = await mkTmpWorkspace(files);
    const r = await searchTextTool().run(
      { id: "1", tool: "search_text", input: { pattern: "needle" } },
      ctx(ws.root),
      noopProgress,
    );
    expect(r.ok).toBe(true);
    const summary = (r as { summary: string }).summary;
    expect(summary).toContain("a.txt:1,2,3,4,5,6,…");
    expect(summary).toContain("c.txt:");
    expect(summary).not.toContain("d.txt");
    expect(summary.endsWith("; …")).toBe(true);
  });

  it("an attachment root always takes the JS engine (engine-independence)", () => {
    // rg mirrors SKIP_DIR_NAMES as `-g !.herta/**` and respects the BL6
    // gitignore, so an rg-backed attachment search returned zero candidates
    // while JS found matches. The predicate below is what forces JS.
    expect(isAttachmentSearchRoot(".herta/attachments/s1")).toBe(true);
    expect(isAttachmentSearchRoot(".herta/attachments/s1/big.log")).toBe(true);
    expect(isAttachmentSearchRoot("src")).toBe(false);
    expect(isAttachmentSearchRoot("")).toBe(false);
  });

  it("EVERY .herta carve-out root takes the JS engine, logs included", () => {
    // The size rule differs between the carve-outs but the engine rule does
    // not: rg cannot see inside `.herta` at all. When `.herta/logs` became
    // searchable (ADR 0036 residual) this predicate had to grow with it —
    // otherwise searching a receipt would have silently found nothing, the
    // same divergence the attachment carve-out hit in review.
    expect(isHertaCarveOutSearchRoot(".herta/logs")).toBe(true);
    expect(isHertaCarveOutSearchRoot(".herta/logs/run-abc.log")).toBe(true);
    expect(isHertaCarveOutSearchRoot(".herta/attachments/s1")).toBe(true);
    // Not a carve-out: still denied by the guard, and never rg-searchable.
    expect(isHertaCarveOutSearchRoot(".herta/tool-results")).toBe(false);
    expect(isHertaCarveOutSearchRoot("src")).toBe(false);
    expect(isHertaCarveOutSearchRoot("")).toBe(false);
  });
});
