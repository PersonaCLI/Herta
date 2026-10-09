import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSessionHeaders, listSessions } from "./list-sessions.js";
import { writeSessionTitle } from "./session-title-sidecar.js";

const HEADER = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    _kind: "session_meta",
    version: 1,
    sessionId: "abc",
    startedAt: "2026-05-15T12:00:00.000Z",
    workspaceRoot: "/p",
    ...overrides,
  });

describe("listSessions", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "v2-enum-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeSession(
    sessionId: string,
    overrides: Record<string, unknown>,
    blocks: string[],
    mtime?: Date,
  ): string {
    const lines = [HEADER({ sessionId, ...overrides }), ...blocks, ""];
    const path = join(tmp, `${sessionId}.jsonl`);
    writeFileSync(path, lines.join("\n"), "utf8");
    if (mtime !== undefined) utimesSync(path, mtime, mtime);
    return path;
  }

  it("returns empty array when transcriptDir is missing", () => {
    const result = listSessions({
      transcriptDir: join(tmp, "does-not-exist"),
      currentWorkspaceRoot: "/p",
    });
    expect(result).toEqual([]);
  });

  it("returns empty array when transcriptDir has no .jsonl files", () => {
    writeFileSync(join(tmp, "not-a-session.txt"), "ignore me", "utf8");
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result).toEqual([]);
  });

  it("filters to current workspace by default", () => {
    writeSession("s1", { workspaceRoot: "/p" }, [
      '{"kind":"user","text":"keep me"}',
    ]);
    writeSession("s2", { workspaceRoot: "/other" }, [
      '{"kind":"user","text":"skip me"}',
    ]);
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.sessionId).toBe("s1");
  });

  it("includes all workspaces when allWorkspaces: true", () => {
    writeSession("s1", { workspaceRoot: "/p" }, [
      '{"kind":"user","text":"first"}',
    ]);
    writeSession("s2", { workspaceRoot: "/other" }, [
      '{"kind":"user","text":"second"}',
    ]);
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
      allWorkspaces: true,
    });
    expect(result).toHaveLength(2);
  });

  it("surfaces a valid header lang and drops legacy/invalid ones", () => {
    writeSession("s-en", { lang: "en" }, ['{"kind":"user","text":"hi"}']);
    writeSession("s-zh", { lang: "zh" }, ['{"kind":"user","text":"你好"}']);
    writeSession("s-legacy", {}, ['{"kind":"user","text":"hi"}']);
    writeSession("s-bad", { lang: "fr" }, ['{"kind":"user","text":"hi"}']);
    const byId = new Map(
      listSessions({ transcriptDir: tmp, currentWorkspaceRoot: "/p" }).map(
        (r) => [r.sessionId, r],
      ),
    );
    expect(byId.get("s-en")?.lang).toBe("en");
    expect(byId.get("s-zh")?.lang).toBe("zh");
    // Legacy (pre-persistence, all Chinese) and stray values → undefined,
    // which the sidebar treats as zh (no alias).
    expect(byId.get("s-legacy")?.lang).toBeUndefined();
    expect(byId.get("s-bad")?.lang).toBeUndefined();
  });

  it("sorts by mtime descending (newest first)", () => {
    writeSession(
      "old",
      { workspaceRoot: "/p" },
      ['{"kind":"user","text":"o"}'],
      new Date("2026-05-10T00:00:00Z"),
    );
    writeSession(
      "new",
      { workspaceRoot: "/p" },
      ['{"kind":"user","text":"n"}'],
      new Date("2026-05-14T00:00:00Z"),
    );
    writeSession(
      "mid",
      { workspaceRoot: "/p" },
      ['{"kind":"user","text":"m"}'],
      new Date("2026-05-12T00:00:00Z"),
    );
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result.map((r) => r.sessionId)).toEqual(["new", "mid", "old"]);
  });

  it("extracts the first user block as preview", () => {
    writeSession("s1", { workspaceRoot: "/p" }, [
      '{"kind":"herta","text":"先 Herta 说话"}',
      '{"kind":"user","text":"看看 foo.ts 这里写错了"}',
      '{"kind":"herta","text":"好"}',
    ]);
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result[0]?.preview).toBe("看看 foo.ts 这里写错了");
  });

  it("truncates preview to ~60 chars with ellipsis", () => {
    const longText = "a".repeat(120);
    writeSession("s1", { workspaceRoot: "/p" }, [
      `{"kind":"user","text":"${longText}"}`,
    ]);
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result[0]?.preview.length).toBeLessThanOrEqual(63); // 60 + "..."
    expect(result[0]?.preview.endsWith("...")).toBe(true);
  });

  it("returns '(no user message)' preview when file has no user block in first 5 lines", () => {
    writeSession("s1", { workspaceRoot: "/p" }, [
      '{"kind":"herta","text":"only herta"}',
      '{"kind":"system","label":"系统","body":"sys"}',
    ]);
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result[0]?.preview).toBe("(no user message)");
  });

  it("limits results to `limit` (default 10)", () => {
    for (let i = 0; i < 15; i++) {
      writeSession(`s${i}`, { workspaceRoot: "/p" }, [
        `{"kind":"user","text":"msg ${i}"}`,
      ]);
    }
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result).toHaveLength(10);
  });

  it("respects an explicit `limit`", () => {
    for (let i = 0; i < 15; i++) {
      writeSession(`s${i}`, { workspaceRoot: "/p" }, [
        `{"kind":"user","text":"msg ${i}"}`,
      ]);
    }
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
      limit: 3,
    });
    expect(result).toHaveLength(3);
  });

  it("skips malformed session files without throwing", () => {
    writeFileSync(join(tmp, "bad.jsonl"), "not json\n", "utf8");
    writeSession("good", { workspaceRoot: "/p" }, [
      '{"kind":"user","text":"hi"}',
    ]);
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result.map((r) => r.sessionId)).toEqual(["good"]);
  });

  it("each entry carries sessionId, sessionFile, startedAt, workspaceRoot, preview, mtime", () => {
    writeSession(
      "s1",
      { workspaceRoot: "/p", startedAt: "2026-05-15T12:00:00.000Z" },
      ['{"kind":"user","text":"hi"}'],
    );
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result[0]).toMatchObject({
      sessionId: "s1",
      sessionFile: join(tmp, "s1.jsonl"),
      startedAt: "2026-05-15T12:00:00.000Z",
      workspaceRoot: "/p",
      preview: "hi",
    });
    expect(result[0]?.mtime).toBeInstanceOf(Date);
  });

  it("surfaces the title sidecar when present", () => {
    writeSession("s1", { workspaceRoot: "/p" }, [
      '{"kind":"user","text":"hi"}',
    ]);
    writeSessionTitle(tmp, "s1", "排查失踪引用");
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result[0]?.title).toBe("排查失踪引用");
  });

  it("leaves title undefined when no sidecar exists", () => {
    writeSession("s1", { workspaceRoot: "/p" }, [
      '{"kind":"user","text":"hi"}',
    ]);
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result[0]?.title).toBeUndefined();
  });

  it("captures the LAST user message as lastUserText (not the first)", () => {
    writeSession("s1", { workspaceRoot: "/p" }, [
      '{"kind":"herta","surface":"speech","text":"opening"}',
      '{"kind":"user","text":"first thing"}',
      '{"kind":"herta","surface":"speech","text":"reply 1"}',
      '{"kind":"user","text":"last thing"}',
      '{"kind":"herta","surface":"speech","text":"reply 2"}',
    ]);
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result[0]?.preview).toBe("first thing"); // first user (unchanged)
    expect(result[0]?.lastUserText).toBe("last thing"); // last user
  });

  it("leaves lastUserText undefined when there is no user message", () => {
    writeSession("s1", { workspaceRoot: "/p" }, [
      '{"kind":"herta","surface":"speech","text":"only herta"}',
    ]);
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result[0]?.lastUserText).toBeUndefined();
  });
});

describe("listSessions — bounded head/tail reads (2026-07-12)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "v2-enum-big-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A filler system block padding the file past the head window. */
  const filler = JSON.stringify({
    kind: "system",
    label: "差分协处理器",
    body: "x".repeat(1000),
  });

  it("a multi-MB-ish file still yields header, preview, and the tail's last user message", () => {
    const lines = [
      HEADER({ sessionId: "big" }),
      '{"kind":"user","text":"the first message"}',
      ...Array.from({ length: 200 }, () => filler), // ~200KB of middle
      '{"kind":"user","text":"the last message"}',
      filler, // trailing non-user noise within the tail window
      "",
    ];
    writeFileSync(join(tmp, "big.jsonl"), lines.join("\n"), "utf8");
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.sessionId).toBe("big");
    expect(result[0]?.preview).toBe("the first message");
    expect(result[0]?.lastUserText).toBe("the last message");
  });

  it("a last user message buried >64KB before EOF is found by stepping back (owner 2026-10-09)", () => {
    // Was the "accepted degradation": one request, then a run whose command
    // text and diffs left >64KB after it, and the sidebar card showed no
    // line at all.
    const lines = [
      HEADER({ sessionId: "buried" }),
      '{"kind":"user","text":"first message"}',
      ...Array.from({ length: 80 }, () => filler),
      '{"kind":"user","text":"deep message"}',
      ...Array.from({ length: 300 }, () => filler), // ~300KB AFTER it
      "",
    ];
    writeFileSync(join(tmp, "buried.jsonl"), lines.join("\n"), "utf8");
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.preview).toBe("first message");
    expect(result[0]?.lastUserText).toBe("deep message");
  });

  it("past the step-back budget, the head's last user message stands in — never a blank card", () => {
    const lines = [
      HEADER({ sessionId: "deeper" }),
      '{"kind":"user","text":"opening request"}',
      ...Array.from({ length: 1200 }, () => filler), // ~1.2MB, past 1MB
      "",
    ];
    writeFileSync(join(tmp, "deeper.jsonl"), lines.join("\n"), "utf8");
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result[0]?.lastUserText).toBe("opening request");
  });

  it("a multi-byte message cut by a step's edge comes back whole", () => {
    const message = "帮我写个五子棋试试，".repeat(40);
    const userLine = JSON.stringify({ kind: "user", text: message });
    // Pad after the message so the 64KB step edge falls inside it.
    const tailPad = "x".repeat(64 * 1024 - 300);
    const lines = [
      HEADER({ sessionId: "cut" }),
      ...Array.from({ length: 80 }, () => filler),
      userLine,
      JSON.stringify({ kind: "system", label: "差分协处理器", body: tailPad }),
      "",
    ];
    writeFileSync(join(tmp, "cut.jsonl"), lines.join("\n"), "utf8");
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result[0]?.lastUserText).toBe(`${message.slice(0, 140)}…`);
  });

  it("a small file behaves exactly as before (single head read)", () => {
    const lines = [
      HEADER({ sessionId: "small" }),
      '{"kind":"user","text":"only message"}',
      "",
    ];
    writeFileSync(join(tmp, "small.jsonl"), lines.join("\n"), "utf8");
    const result = listSessions({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result[0]?.preview).toBe("only message");
    expect(result[0]?.lastUserText).toBe("only message");
  });
});

describe("listSessionHeaders — header-only listing for search", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "v2-hdr-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeSession(
    sessionId: string,
    overrides: Record<string, unknown>,
    blocks: string[],
    mtime?: Date,
  ): void {
    const lines = [HEADER({ sessionId, ...overrides }), ...blocks, ""];
    const path = join(tmp, `${sessionId}.jsonl`);
    writeFileSync(path, lines.join("\n"), "utf8");
    if (mtime !== undefined) utimesSync(path, mtime, mtime);
  }

  it("returns empty array when transcriptDir is missing", () => {
    expect(
      listSessionHeaders({
        transcriptDir: join(tmp, "nope"),
        currentWorkspaceRoot: "/p",
      }),
    ).toEqual([]);
  });

  it("filters to current workspace by default and carries only header fields", () => {
    writeSession("s1", { workspaceRoot: "/p", lang: "en" }, [
      '{"kind":"user","text":"keep"}',
    ]);
    writeSession("s2", { workspaceRoot: "/other" }, [
      '{"kind":"user","text":"skip"}',
    ]);
    const result = listSessionHeaders({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sessionId: "s1",
      workspaceRoot: "/p",
      startedAt: "2026-05-15T12:00:00.000Z",
      lang: "en",
    });
    expect(result[0]?.mtime).toBeInstanceOf(Date);
  });

  it("includes all workspaces when allWorkspaces: true", () => {
    writeSession("s1", { workspaceRoot: "/p" }, ['{"kind":"user","text":"a"}']);
    writeSession("s2", { workspaceRoot: "/o" }, ['{"kind":"user","text":"b"}']);
    expect(
      listSessionHeaders({
        transcriptDir: tmp,
        currentWorkspaceRoot: "/p",
        allWorkspaces: true,
      }),
    ).toHaveLength(2);
  });

  it("sorts by mtime descending and respects limit", () => {
    writeSession(
      "old",
      {},
      ['{"kind":"user","text":"o"}'],
      new Date("2026-05-10T00:00:00Z"),
    );
    writeSession(
      "new",
      {},
      ['{"kind":"user","text":"n"}'],
      new Date("2026-05-14T00:00:00Z"),
    );
    writeSession(
      "mid",
      {},
      ['{"kind":"user","text":"m"}'],
      new Date("2026-05-12T00:00:00Z"),
    );
    const result = listSessionHeaders({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
      limit: 2,
    });
    expect(result.map((r) => r.sessionId)).toEqual(["new", "mid"]);
  });

  it("skips malformed session files without throwing", () => {
    writeFileSync(join(tmp, "bad.jsonl"), "not json\n", "utf8");
    writeSession("good", {}, ['{"kind":"user","text":"hi"}']);
    expect(
      listSessionHeaders({
        transcriptDir: tmp,
        currentWorkspaceRoot: "/p",
      }).map((r) => r.sessionId),
    ).toEqual(["good"]);
  });

  it("resolves the header of a large file without reading its tail", () => {
    const filler = JSON.stringify({
      kind: "system",
      label: "差分协处理器",
      body: "x".repeat(1000),
    });
    const lines = [
      HEADER({ sessionId: "big", workspaceRoot: "/p" }),
      '{"kind":"user","text":"first"}',
      ...Array.from({ length: 200 }, () => filler),
      "",
    ];
    writeFileSync(join(tmp, "big.jsonl"), lines.join("\n"), "utf8");
    const result = listSessionHeaders({
      transcriptDir: tmp,
      currentWorkspaceRoot: "/p",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.sessionId).toBe("big");
  });
});
