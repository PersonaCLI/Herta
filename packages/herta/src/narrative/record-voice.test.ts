import type { AgentEvent, SystemBlock } from "@herta/core";
import { describe, expect, it } from "vitest";
import { projectBackendEvent } from "./backend-record-projection.js";
import {
  detailForHerta,
  elisionNote,
  foldedRunLine,
  foldedStepLines,
  nameMentionedPaths,
  receiptForHerta,
  shownExcerptLine,
  systemRowForHerta,
} from "./record-voice.js";

/** 板砖's rows as Herta reads them (ADR 0079 §2, owner 2026-10-16). */

const row = (over: Partial<SystemBlock>): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: "",
  ...over,
});
const read = (b: SystemBlock, lang: "zh" | "en" = "zh") => {
  const out = systemRowForHerta(b, lang);
  return out === null
    ? null
    : `${out.body}${out.evidenceDetail !== undefined ? `\n${out.evidenceDetail}` : ""}`;
};
/** A memory save's row as the bridge writes it: its body, no digest. */
const remembered = (text: string): SystemBlock => {
  const event: AgentEvent = {
    type: "tool.call.finished",
    layer: "backend",
    id: "m1",
    tool: "memory_save",
    result: {
      ok: true,
      summary: "remembered: test_command",
      data: { id: "x", kind: "test_command", text, why: "开拓者说的" },
    },
  };
  const block = projectBackendEvent(event);
  if (block === null) throw new Error("the bridge wrote no row");
  return block;
};

describe("the done-marker reads as a sentence", () => {
  const marker = (state: string, extra: object = {}): SystemBlock =>
    row({
      body: "完成 · 2 个文件 · +196 −0 · 测试 6/6",
      role: "done-marker",
      markerSummary: {
        kind: "done",
        state,
        fileCount: 2,
        lines: { add: 196, del: 0 },
        tests: { passed: 6, failed: 0 },
        riskCount: 0,
        ...extra,
      } as never,
    });

  it("states what changed and what the tests said", () => {
    expect(read(marker("completed"))).toBe(
      "做完了：改了 2 个文件（+196 −0），测试 6/6 通过。",
    );
    expect(read(marker("completed"), "en")).toBe(
      "Done: changed 2 files (+196 −0), tests 6/6 passed.",
    );
  });

  it("the user's own Stop is never a failure (audit 2026-07-24, 1.4)", () => {
    expect(read(marker("interrupted"))).toMatch(/^停下了：/u);
    expect(read(marker("interrupted"))).not.toContain("没做成");
  });

  it("failed tests, risks, a commit and the step limit are each said", () => {
    const out = read(
      marker("partial", {
        tests: { passed: 4, failed: 1 },
        riskCount: 2,
        git: { commit: "abc1234" },
        stepLimit: true,
      }),
    );
    expect(out).toBe(
      "做了一部分：改了 2 个文件（+196 −0），测试 4 过、1 没过，提交 abc1234，留了 2 个风险，步数到了上限。",
    );
  });

  it("a run that ended on a web page or a search: the tail names the site, never the URL or the stored path (release review 2026-10-22)", () => {
    const url = "https://nodejs.org/api/fs.html?x=1";
    const path = ".herta/web/nodejs.org-ab12cd34.md";
    const page = {
      ...marker("completed"),
      evidenceDetail: `↳ 网页 「File system」（${url}，存于 ${path}）\nThe fs module enables interacting with the file system.`,
      evidence: [
        {
          kind: "web-page" as const,
          url,
          title: "File system",
          path,
          text: "The fs module enables interacting with the file system.",
        },
      ],
    };
    for (const lang of ["zh", "en"] as const) {
      const out = read(page, lang) ?? "";
      expect(out).not.toContain("https://");
      expect(out).not.toContain(".herta");
      expect(out).not.toContain("存于");
      expect(out).toContain("The fs module enables");
    }
    expect(read(page)).toContain("网页 nodejs.org「File system」，开头：");
    expect(read(page, "en")).toContain(
      'Page nodejs.org, "File system" — the opening:',
    );
    const results = {
      ...marker("completed"),
      evidenceDetail: "↳ 网页结果:\n- File system（nodejs.org）",
      evidence: [
        {
          kind: "web-results" as const,
          items: [{ title: "File system", site: "nodejs.org", url }],
        },
      ],
    };
    expect(read(results)).toContain(
      "找到 1 条结果：\n- File system（nodejs.org）",
    );
    expect(read(results, "en")).toContain(
      "Found 1 result:\n- File system (nodejs.org)",
    );
    expect(read(results, "en")).not.toContain("https://");
  });

  it("its detail loses the arrows, the log path, the sandbox and the call ids; a command's own `; ` survives", () => {
    const out = read({
      ...marker("completed"),
      evidenceDetail: [
        "↳ 摘录 test_primes.py:30-31",
        "30\tclass TestSieveFast(unittest.TestCase):",
        "31\t    pass",
        "↳ 改动文件: a.py, b.py",
        "↳ 结论: 快了 24 倍（bench.py:12）",
        "↳ 依据: ran `cd /c/Users/x/.herta/workspaces/abc && for L in 1 2; do echo $L; done` (exit 0, 0.26s) — log at .herta/logs/x.log（call_00_ab12）",
      ].join("\n"),
      evidence: [
        { kind: "files", paths: ["a.py", "b.py"] },
        { kind: "findings", items: ["快了 24 倍（bench.py:12）"] },
        {
          kind: "evidence",
          items: [
            "ran `cd /c/Users/x/.herta/workspaces/abc && for L in 1 2; do echo $L; done` (exit 0, 0.26s) — log at .herta/logs/x.log（call_00_ab12）",
          ],
        },
      ],
    });
    expect(out).toBe(
      [
        "做完了：改了 2 个文件（+196 −0），测试 6/6 通过。",
        "摘录 test_primes.py 第 30–31 行：",
        "30\tclass TestSieveFast(unittest.TestCase):",
        "31\t    pass",
        "改了：a.py、b.py",
        "结论：快了 24 倍（bench.py:12）",
        "依据：运行 `for L in 1 2; do echo $L; done`",
      ].join("\n"),
    );
  });

  it("in English its labels are plain words, never the report D3 names (ADR 0079 §3)", () => {
    const out = read(
      {
        ...marker("completed"),
        evidenceDetail: [
          "↳ 改动文件: a.py, b.py",
          "↳ 风险: ranks has no debug entry",
          "↳ 依据: ran `pytest` (exit 0, 1.00s) — log at .herta/logs/x.log",
        ].join("\n"),
      },
      "en",
    );
    expect(out).toBe(
      [
        "Done: changed 2 files (+196 −0), tests 6/6 passed.",
        "Changed files: a.py, b.py",
        "Risks left: ranks has no debug entry",
        "Based on: ran `pytest`",
      ].join("\n"),
    );
    // The 废案 gate's LEAK_MARKERS (knowledge/dream/feian-format.ts).
    expect(out).not.toMatch(
      /\b(Verdict|Changed|Evidence|Summary|Risks?|Plan)\s*[:：]/i,
    );
  });

  it("a hint line the compaction added stays under the sentence", () => {
    const hinted = {
      ...marker("completed"),
      body: "完成 · 2 个文件\n（改动的 diff 不在手边）",
    };
    expect(read(hinted)).toBe(
      "做完了：改了 2 个文件（+196 −0），测试 6/6 通过。\n（改动的 diff 不在手边）",
    );
  });

  it("with its detail dropped by the compaction, it says the details are not at hand", () => {
    const elided = {
      ...marker("completed"),
      body: `完成 · 2 个文件${elisionNote("zh")}`,
    };
    expect(read(elided)).toBe(
      "做完了：改了 2 个文件（+196 −0），测试 6/6 通过。（细节不在手边）",
    );
  });
});

describe("板砖's other rows", () => {
  it("a step names what it did; a memory save's kind and a planning step drop out", () => {
    expect(
      read(
        row({
          body: "Running pnpm test",
          digest: { kind: "op", verb: "Running", arg: "pnpm test" },
        }),
      ),
    ).toBe("运行 `pnpm test`");
    expect(
      read(
        row({
          body: "Reading a.ts:1-9",
          digest: { kind: "op", verb: "Reading", arg: "a.ts:1-9" },
        }),
      ),
    ).toBe("读 a.ts 第 1–9 行");
    expect(
      read(
        row({
          body: "Saving memory test_command",
          digest: { kind: "op", verb: "Saving memory", arg: "test_command" },
        }),
      ),
    ).toBeNull();
    expect(
      read(
        row({
          body: "Planning x",
          digest: { kind: "op", verb: "Planning", arg: "x" },
        }),
      ),
    ).toBeNull();
  });

  it("a command's result: its output, its exit code only when it failed, nothing when it printed nothing and passed", () => {
    const result = (exitCode: number, output?: string) =>
      row({
        body: `↳ exit ${exitCode} · 1 lines`,
        digest: {
          kind: "text",
          text: `↳ exit ${exitCode} · 1 lines`,
          exitCode,
          lineCount: 1,
        },
        ...(output !== undefined
          ? {
              evidenceDetail: `↳ 输出:\n${output}\n…(truncated, full log: .herta/logs/a.log)`,
            }
          : {}),
      });
    expect(read(result(0, "ok"))).toBe("输出：\nok\n……（后面还有，没贴全）");
    expect(read(result(2, "boom"))).toBe(
      "没成，退出码 2\n输出：\nboom\n……（后面还有，没贴全）",
    );
    expect(read(result(0))).toBeNull();
    // A line of its own opens with a capital in English.
    expect(read(result(2, "boom"), "en")).toBe(
      "Failed, exit code 2\nOutput:\nboom\n…(more, not shown)",
    );
  });

  it("a test run, a change, a finding, a remembered fact, a failure, a background command", () => {
    expect(
      read(
        row({
          body: "↳ tests: exit 0, 0.24s",
          digest: { kind: "tests", status: "passed", summary: "exit 0, 0.24s" },
        }),
      ),
    ).toBe("测试通过");
    expect(
      read(
        row({
          body: "↳ tests: 3 passed, 1 failed",
          digest: {
            kind: "tests",
            status: "failed",
            summary: "3 passed, 1 failed",
          },
        }),
      ),
    ).toBe("测试没过（3 passed, 1 failed）");
    expect(
      read(
        row({
          label: "系统",
          body: "patch preview: a.ts (+3 -1)\n\n```diff\n+x\n```",
          digest: { kind: "patch", files: ["a.ts"], add: 3, del: 1 },
        }),
      ),
    ).toBe("改动 a.ts（+3 −1）\n\n```diff\n+x\n```");
    expect(
      read(
        row({
          body: "↳ finding: 崩在显存超限。 — log.txt:33",
          digest: {
            kind: "finding",
            claim: "崩在显存超限。",
            cites: ["log.txt:33"],
          },
        }),
      ),
    ).toBe("结论：崩在显存超限。（log.txt:33）");
    expect(read(remembered("测试用 pnpm test"))).toBe(
      "板砖记下了：测试用 pnpm test",
    );
    expect(
      read(
        row({
          label: "系统",
          body: "↳ bash failed: path_denied: .herta is denied",
          digest: {
            kind: "tool-fail",
            tool: "bash",
            code: "path_denied",
            message: ".herta is denied",
          },
          evidenceDetail: "↳ 提示: read the file by its full path",
        }),
      ),
    ).toBe(
      "这一步没成（bash）：.herta is denied\n提示：read the file by its full path",
    );
    expect(
      read(
        row({
          body: "↳ background bg-1: exited (0)",
          digest: { kind: "bg", id: "bg-1", state: "exited", exitCode: 0 },
        }),
      ),
    ).toBe("后台命令 bg-1 结束，退出码 0");
  });

  it("an excerpt reads its lines under a plain header; a no-op says 板砖 did nothing", () => {
    expect(
      read(
        row({
          body: "↳ excerpt a.ts:5-6",
          digest: { kind: "excerpt", path: "a.ts", from: 5, to: 6 },
          evidenceDetail: "↳ 摘录 a.ts:5-6\n5\tx\n6\ty",
        }),
      ),
    ).toBe("摘录 a.ts 第 5–6 行：\n5\tx\n6\ty");
    expect(
      read(
        row({
          body: "无产出 — 这次没有触发任何文件、目录或命令操作。",
          role: "noop-marker",
        }),
      ),
    ).toBe("板砖这次什么也没动。");
  });

  it("an attachment is the fold's, and a row with no digest keeps its own text", () => {
    const attachment = row({
      label: "系统",
      body: "附件 a.pdf",
      digest: {
        kind: "attachment",
        name: "a.pdf",
        path: "p",
        lines: 1,
        chars: 1,
      },
    });
    expect(systemRowForHerta(attachment, "zh")).toBe(attachment);
    const legacy = row({ body: 'Reading {"path":"old.ts"}' });
    expect(systemRowForHerta(legacy, "zh")).toBe(legacy);
  });
});

describe("a memory save, as the bridge writes it — no digest (ADR 0079 §2)", () => {
  // Longer than the 60 characters the legacy fold cut a row's first line to.
  const fact =
    "测试用 node --test test/，别用 npm test：package.json 的 test 脚本是坏的，在 Node 22 下一跑就退出，所以别再用它";
  const saved = remembered(fact);

  it("the bridge writes its body and no digest", () => {
    expect(saved.digest).toBeUndefined();
    expect(saved.body).toBe(`↳ remembered: ${fact}`);
    expect(fact.length).toBeGreaterThan(60);
  });

  it("fresh, it reads as what was remembered, in the session's language", () => {
    expect(read(saved)).toBe(`板砖记下了：${fact}`);
    expect(read(saved, "en")).toBe(`板砖 noted: ${fact}`);
  });

  it("folded, it is the whole fact, never the arrow, the English label or a cut", () => {
    expect(foldedRunLine(saved, "zh")).toBe(`板砖记下了：${fact}`);
    expect(foldedRunLine(saved, "en")).toBe(`板砖 noted: ${fact}`);
  });

  it("a row it does not know, digest-less, still keeps its own text", () => {
    const note = row({ body: "↳ rememberedness: x" });
    expect(systemRowForHerta(note, "zh")).toBe(note);
    expect(foldedRunLine(note, "zh")).toBeNull();
  });
});

describe("folded lines: what was done, never how", () => {
  it("a failed command names the command its result row answers", () => {
    const fail = row({
      body: "↳ exit 128 · 2 lines",
      digest: {
        kind: "text",
        text: "↳ exit 128 · 2 lines",
        exitCode: 128,
        lineCount: 2,
      },
    });
    expect(foldedRunLine(fail, "zh", "git status")).toBe(
      "运行 `git status`（退出码 128）",
    );
    expect(foldedRunLine(fail, "zh")).toBe("没成，退出码 128");
    // In English the line opens with a capital; the same receipt after
    // `Based on: ` keeps its lower case.
    expect(foldedRunLine(fail, "en", "git status")).toBe(
      "Ran `git status` (exit code 128)",
    );
    expect(foldedRunLine(fail, "en")).toBe("Failed, exit code 128");
    expect(receiptForHerta("ran `git status` (exit 128, 0.10s)", "en")).toBe(
      "ran `git status` (exit code 128)",
    );
  });

  it("a failure folds to its cause in plain words, not the tool's message", () => {
    const fail = row({
      label: "系统",
      body: "↳ bash failed: path_denied: …",
      digest: {
        kind: "tool-fail",
        tool: "bash",
        code: "path_denied",
        message: "read-only command targets .herta",
      },
    });
    expect(foldedRunLine(fail, "zh")).toBe(
      "这一步没成（bash）：碰到了受保护的路径",
    );
  });

  it("an excerpt and a search say they are not at hand", () => {
    expect(
      foldedRunLine(
        row({
          body: "",
          digest: { kind: "excerpt", path: "a.ts", from: 1, to: 2 },
        }),
        "zh",
      ),
    ).toBe("看过 a.ts 第 1–2 行（原文不在手边）");
    expect(
      foldedRunLine(
        row({
          body: "",
          digest: {
            kind: "search",
            pattern: "x",
            matches: 3,
            files: 2,
            truncated: false,
          },
        }),
        "en",
      ),
    ).toBe("Searched /x/: 3 matches in 2 files (not at hand)");
  });

  it("an excerpt the marker in front of her shows folds to the read", () => {
    const excerpt = (from: number, to: number) =>
      row({ body: "", digest: { kind: "excerpt", path: "a.ts", from, to } });
    expect(shownExcerptLine(excerpt(1, 2), "zh")).toBe("读 a.ts 第 1–2 行");
    expect(shownExcerptLine(excerpt(5, 5), "zh")).toBe("读 a.ts 第 5 行");
    expect(shownExcerptLine(excerpt(1, 2), "en")).toBe("Read a.ts lines 1–2");
    expect(shownExcerptLine(excerpt(5, 5), "en")).toBe("Read a.ts line 5");
    expect(
      shownExcerptLine(
        row({ body: "", digest: { kind: "op", verb: "Reading", arg: "a.ts" } }),
        "zh",
      ),
    ).toBeNull();
  });

  it("a run with no outcome folds to its steps, a kind's consecutive ones on one line", () => {
    const op = (verb: "Reading" | "Running", arg: string) =>
      row({ body: "", digest: { kind: "op", verb, arg } });
    expect(
      foldedStepLines(
        [
          op("Reading", "a.ts"),
          op("Reading", "b.ts"),
          op("Running", "ls"),
          op("Running", "pwd"),
        ],
        "zh",
      ),
    ).toEqual(["读 a.ts、b.ts", "运行 `ls`", "运行 `pwd`"]);
  });
});

describe("receipts and labels", () => {
  it("a timed-out command, and a receipt it does not know, keep their meaning", () => {
    expect(
      receiptForHerta(
        "timed out: npm run dev (120000ms) — partial output captured, log at .herta/logs/a.log",
        "zh",
      ),
    ).toBe("运行 npm run dev 超时");
    expect(receiptForHerta("edited a.ts", "zh")).toBe("edited a.ts");
  });

  it("an unknown label keeps its words without the arrow", () => {
    expect(detailForHerta("↳ 待办: x", "zh")).toBe("待办: x");
  });
});

describe("the web rows (ADR 0080)", () => {
  const started = (tool: string, inputSummary: string): SystemBlock => {
    const b = projectBackendEvent({
      type: "tool.call.started",
      layer: "backend",
      id: "w1",
      tool,
      inputSummary,
    });
    if (b === null) throw new Error("no row");
    return b;
  };
  const finished = (tool: string, data: unknown): SystemBlock => {
    const b = projectBackendEvent({
      type: "tool.call.finished",
      layer: "backend",
      id: "w1",
      tool,
      result: { ok: true, summary: "ok", data },
    });
    if (b === null) throw new Error("no row");
    return b;
  };
  const search = finished("web_search", {
    query: "vitest update flag",
    results: [
      {
        title: "update | Vitest",
        url: "https://vitest.dev/config/update",
        site: "Vitest",
        date: null,
      },
      {
        title: "Snapshot （我 说） | Guide",
        url: "https://example.com/snap",
        site: null,
        date: null,
      },
    ],
  });
  const page = finished("web_fetch", {
    url: "https://nodejs.org/api/fs.html?x=1",
    host: "nodejs.org",
    title: "File system | Node.js",
    path: ".herta/web/nodejs.org-0123abcd.md",
    chars: 189634,
    head: "# File system\nThe node:fs module …",
  });

  it("the record keeps the user's detail: titles, sites and the page's URL", () => {
    expect(search.body).toBe("↳ web results: 2");
    expect(search.digest).toEqual({
      kind: "web-search",
      query: "vitest update flag",
      results: [
        { title: "update | Vitest", site: "Vitest" },
        { title: expect.any(String), site: "example.com" },
      ],
    });
    expect(search.evidence?.[0]).toMatchObject({
      kind: "web-results",
      items: [
        {
          title: "update | Vitest",
          site: "Vitest",
          url: "https://vitest.dev/config/update",
        },
        { site: "example.com", url: "https://example.com/snap" },
      ],
    });
    expect(page.body).toBe(
      '↳ page nodejs.org: "File system | Node.js" · 189634 chars',
    );
    expect(page.evidenceDetail).toContain("https://nodejs.org/api/fs.html?x=1");
    expect(page.evidenceDetail).toContain(".herta/web/nodejs.org-0123abcd.md");
  });

  it("a page title cannot forge a block in the record", () => {
    const d = search.digest as Extract<
      SystemBlock["digest"],
      { kind: "web-search" }
    >;
    expect(d.results[1]?.title).not.toContain("（我 说）");
  });

  it("she reads a search as its query and what it found — no URL", () => {
    expect(read(started("web_search", "vitest update flag"))).toBe(
      "搜索网页「vitest update flag」",
    );
    const zh = read(search) as string;
    expect(zh.split("\n")[0]).toBe("找到 2 条结果：");
    expect(zh).toContain("- update | Vitest（Vitest）");
    expect(zh).not.toMatch(/https?:/);
    expect(read(search, "en")?.split("\n")[0]).toBe("Found 2 results:");
    expect(read(started("web_search", "q"), "en")).toBe(
      'Searched the web for "q"',
    );
  });

  it("she reads a page as its host, its title and its opening — no URL, no stored path", () => {
    expect(
      read(started("web_fetch", "https://nodejs.org/api/fs.html?x=1")),
    ).toBe("读网页 nodejs.org");
    const zh = read(page) as string;
    expect(zh).toBe(
      "网页 nodejs.org「File system | Node.js」，开头：\n# File system\nThe node:fs module …",
    );
    expect(read(page, "en")?.split("\n")[0]).toBe(
      'Page nodejs.org, "File system | Node.js" — the opening:',
    );
  });

  it("folded: what was looked up and read, not at hand", () => {
    expect(foldedRunLine(search, "zh")).toBe(
      "搜索过网页「vitest update flag」，2 条结果",
    );
    expect(foldedRunLine(page, "zh")).toBe(
      "读过网页 nodejs.org「File system | Node.js」（原文不在手边）",
    );
    expect(foldedRunLine(search, "en")).toBe(
      'Searched the web for "vitest update flag": 2 results',
    );
    expect(foldedRunLine(page, "en")).toBe(
      'Read web page nodejs.org, "File system | Node.js" (not at hand)',
    );
    expect(
      foldedRunLine(started("web_fetch", "https://x.org/"), "zh"),
    ).toBeNull();
  });

  it("a run that only fetched and failed folds to its steps, as hosts", () => {
    expect(
      foldedStepLines(
        [
          started("web_fetch", "https://a.org/x"),
          started("web_fetch", "https://b.org/y"),
        ],
        "zh",
      ),
    ).toEqual(["读网页 a.org、b.org"]);
  });

  it("a stored page 板砖 reads, quotes or cites reads as the site's page — a command keeps its words", () => {
    expect(
      read(started("read_file", ".herta/web/vitest.dev-11d34302.md:8-24")),
    ).toBe("读 网页 vitest.dev 第 8–24 行");
    expect(
      read(
        started("read_file", ".herta/web/vitest.dev-11d34302.md:8-24"),
        "en",
      ),
    ).toBe("Read the vitest.dev page lines 8–24");
    const finding = row({
      body: "↳ finding: x",
      digest: {
        kind: "finding",
        claim: "4.x 加了 new/all/none",
        cites: [".herta/web/v3.vitest.dev-9cec2dcd.md:657-664"],
      },
    });
    expect(read(finding)).toBe(
      "结论：4.x 加了 new/all/none（网页 v3.vitest.dev:657-664）",
    );
    expect(foldedRunLine(finding, "zh")).not.toContain(".herta");
    expect(
      read(started("bash", "grep -n x .herta/web/vitest.dev-7d9779fc.md")),
    ).toBe("运行 `grep -n x .herta/web/vitest.dev-7d9779fc.md`");
  });

  it("a refused URL folds to its cause in plain words", () => {
    const fail = projectBackendEvent({
      type: "tool.call.finished",
      layer: "backend",
      id: "w2",
      tool: "web_fetch",
      result: {
        ok: false,
        summary: "URL refused",
        error: {
          code: "url_refused",
          message: "the host is local",
          retryable: false,
        },
      },
    }) as SystemBlock;
    expect(foldedRunLine(fail, "zh")).toBe(
      "这一步没成（web_fetch）：这个网址没放出去",
    );
  });
});

describe("a mentioned path, as Herta reads it (ADR 0072 amendment 2026-10-20)", () => {
  it("names each mentioned path by its file or folder name", () => {
    expect(
      nameMentionedPaths(
        "看看 packages/herta/src/narrative/record-voice.ts 里的 opArg，再翻 packages/gui 目录",
        ["packages/herta/src/narrative/record-voice.ts", "packages/gui"],
      ),
    ).toBe("看看 record-voice.ts 里的 opArg，再翻 gui 目录");
  });

  it("keeps a backticked path's ticks, and leaves a path nobody mentioned as written", () => {
    expect(
      nameMentionedPaths("读 `docs/design notes.md` 和 src/a.ts", [
        "docs/design notes.md",
      ]),
    ).toBe("读 `design notes.md` 和 src/a.ts");
  });

  it("never cuts into a longer path that only starts with a mentioned one", () => {
    expect(nameMentionedPaths("src/a.ts 和 src/a.ts.map", ["src/a.ts"])).toBe(
      "a.ts 和 src/a.ts.map",
    );
  });

  it("a top-level file and no mentions are left as they are", () => {
    expect(nameMentionedPaths("README.md", ["README.md"])).toBe("README.md");
    expect(nameMentionedPaths("src/a.ts", undefined)).toBe("src/a.ts");
  });
});
