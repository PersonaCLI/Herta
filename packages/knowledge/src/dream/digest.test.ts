import type { SystemBlock, TerminalRecordBlock } from "@herta/core";
import { projectBackendEvent } from "@herta/herta";
import { describe, expect, it } from "vitest";
import {
  buildEpisodeDigest,
  DIGEST_EVIDENCE_BUDGET,
  DIGEST_MAX_SYSTEM_ROWS,
  systemRowForDream,
} from "./digest.js";

const blocks: TerminalRecordBlock[] = [
  { kind: "user", text: "加个 --verbose" },
  { kind: "herta", surface: "thought", text: "又是 flag。" },
  { kind: "herta", surface: "speech", text: "@板砖 去加。" },
  {
    kind: "system",
    label: "差分协处理器",
    body: "完成 · 1 个文件",
    evidenceDetail: "↳ 依据: targeted test pass",
    role: "done-marker",
    markerSummary: {
      kind: "done",
      state: "completed",
      fileCount: 1,
      riskCount: 0,
    },
  },
  { kind: "herta", surface: "speech", text: "加好了，只跑了定向测试。" },
];

/** A command's result row as the bridge writes it. */
const result = (
  exitCode: number,
  output?: string,
  lineCount = 2,
): TerminalRecordBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: `↳ exit ${exitCode} · ${lineCount} lines`,
  digest: {
    kind: "text",
    text: `↳ exit ${exitCode} · ${lineCount} lines`,
    exitCode,
    lineCount,
  },
  ...(output !== undefined ? { evidenceDetail: `↳ 输出:\n${output}` } : {}),
});

const running = (cmd: string): TerminalRecordBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: `Running ${cmd}`,
  digest: { kind: "op", verb: "Running", arg: cmd },
});

describe("buildEpisodeDigest — attachments (ADR 0033)", () => {
  // The ADR claims dreams need no new rule for attachments, because the
  // citation rides `body` and the document's text rides `evidenceDetail`,
  // which no dream ever reads. That is a claim about behaviour, so it is
  // pinned here rather than asserted in prose: she should be able to dream
  // that the 开拓者 handed her a spec, and never dream its contents.
  const withAttachment: TerminalRecordBlock[] = [
    { kind: "user", text: "看看这个" },
    {
      kind: "system",
      label: "系统",
      body: "附件 spec.md · 120 行 · 4.8K 字 · .herta/attachments/s1/spec.md",
      evidenceDetail: "↳ 附件 spec.md\nCONFIDENTIAL ROADMAP Q4 REVENUE TARGET",
      digest: {
        kind: "attachment",
        name: "spec.md",
        path: ".herta/attachments/s1/spec.md",
        lines: 120,
        chars: 4800,
      },
    },
    { kind: "herta", surface: "speech", text: "看完了。" },
  ];

  it("keeps the name, never the document body or where the store keeps it (ADR 0079 §3)", () => {
    const d = buildEpisodeDigest(withAttachment);
    expect(d).toContain("附件 spec.md（读过，原文不在手边）");
    expect(d).not.toContain("CONFIDENTIAL");
    expect(d).not.toContain("REVENUE");
    expect(d).not.toContain(".herta/attachments");
    expect(d).not.toContain("120 行");
  });

  // ADR 0069 §5 (dream review 2026-09-22, finding 9): the same text came back
  // through 板砖's read lanes — the fold's own hint sends Herta to re-read the
  // document — and those rows kept their detail. Keyed on provenance now.
  const reread: TerminalRecordBlock[] = [
    { kind: "user", text: "再看看那份 spec 第三节" },
    { kind: "herta", surface: "speech", text: "@板砖 翻一下第三节。" },
    {
      kind: "system",
      label: "差分协处理器",
      body: "↳ excerpt .herta/attachments/s1/spec.md:40-60",
      digest: {
        kind: "excerpt",
        path: ".herta/attachments/s1/spec.md",
        from: 40,
        to: 60,
      },
      evidenceDetail:
        "↳ 摘录 .herta/attachments/s1/spec.md:40-60\nCONFIDENTIAL ROADMAP",
    },
    {
      kind: "system",
      label: "差分协处理器",
      body: "↳ 3 matches in 2 files",
      digest: {
        kind: "search",
        pattern: "TARGET",
        matches: 3,
        files: 2,
        truncated: false,
      },
      evidenceDetail: [
        "↳ 匹配 /TARGET/:",
        ".herta/attachments/s1/spec.md:12: Q4 REVENUE TARGET",
        "E:\\ws\\.herta\\attachments\\s1\\spec.md:13: REVENUE TARGET 2",
        "src/config.ts:4: const TARGET_FPS = 60;",
      ].join("\n"),
    },
    running("cat .herta/attachments/s1/spec.md"),
    result(0, "CONFIDENTIAL APPENDIX", 120),
    running("npm test"),
    result(1, "FAIL src/config.test.ts"),
    { kind: "herta", surface: "speech", text: "第三节说的是路线图。" },
  ];

  it("drops what 板砖 re-read from the attachment store and keeps what it read from the repo", () => {
    const d = buildEpisodeDigest(reread);
    for (const secret of ["CONFIDENTIAL", "REVENUE", "APPENDIX"]) {
      expect(d).not.toContain(secret);
    }
    // The steps stay: she remembers going back to the document, and that
    // the excerpt is no longer in front of her.
    expect(d).toContain(
      "看过 .herta/attachments/s1/spec.md 第 40–60 行（原文不在手边）",
    );
    expect(d).toContain("运行 `cat .herta/attachments/s1/spec.md`");
    // Repo evidence in the same episode is untouched.
    expect(d).toContain("src/config.ts:4: const TARGET_FPS = 60;");
    expect(d).toContain("没成，退出码 1\n输出：\nFAIL src/config.test.ts");
  });
});

describe("buildEpisodeDigest", () => {
  it("includes user + herta lines and the verified outcome evidence", () => {
    const d = buildEpisodeDigest(blocks);
    expect(d).toContain("加个 --verbose");
    expect(d).toContain("我（内心独白）：又是 flag。"); // thought → 内心独白
    expect(d).toContain("@板砖 去加");
    expect(d).toContain("做完了：改了 1 个文件。");
    expect(d).toContain("依据：targeted test pass");
  });
  it("labels the outcome spine as verified backend evidence", () => {
    expect(buildEpisodeDigest(blocks)).toContain("差分协处理器");
  });
  it("omits an outcome spine when the episode has no coding system blocks", () => {
    const chat: TerminalRecordBlock[] = [
      { kind: "user", text: "闲聊" },
      { kind: "herta", surface: "speech", text: "终端外面有噪声。" },
    ];
    const d = buildEpisodeDigest(chat);
    expect(d).not.toContain("差分协处理器");
    expect(d).toContain("终端外面有噪声");
  });
  it("surfaces a supervisor self-correction as a labeled beat before the line", () => {
    const corrected: TerminalRecordBlock[] = [
      { kind: "user", text: "瓦尔特那边怎么说" },
      {
        kind: "herta",
        surface: "speech",
        text: "瓦尔特说再等等。",
        selfCorrection: "把瓦尔特说成了杨叔，已更正",
      },
    ];
    const d = buildEpisodeDigest(corrected);
    expect(d).toContain("〔黑塔的自我更正：把瓦尔特说成了杨叔，已更正〕");
    // the marker precedes the corrected speech line
    const lines = d.split("\n");
    const markerIdx = lines.findIndex((l) => l.includes("自我更正"));
    const speechIdx = lines.findIndex((l) => l.includes("瓦尔特说再等等"));
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeLessThan(speechIdx);
  });
  it("adds no self-correction marker for a thought block or a plain speech", () => {
    const plain: TerminalRecordBlock[] = [
      { kind: "herta", surface: "speech", text: "在。" },
      { kind: "herta", surface: "thought", text: "随便他。" },
    ];
    expect(buildEpisodeDigest(plain)).not.toContain("自我更正");
  });
  it("drops live-work chrome: bg rows, todo layout, patch previews, 待办 roll-up", () => {
    const coding: TerminalRecordBlock[] = [
      { kind: "user", text: "修一下解析器" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: a.ts\n\n```diff\n+++ b/a.ts\n+x\n```",
        digest: { kind: "skip" },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "todo list (2):\n[ ] 修解析器\n[x] 读文件",
        digest: { kind: "todo", total: 2, completed: 1 },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "↳ background bg-1: running",
        digest: { kind: "bg", id: "bg-1", state: "running" },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "Writing a.ts",
        digest: { kind: "op", verb: "Writing", arg: "a.ts" },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "完成 · 1 个文件",
        role: "done-marker",
        markerSummary: {
          kind: "done",
          state: "completed",
          fileCount: 1,
          riskCount: 0,
        },
        evidenceDetail: "↳ 改动文件: a.ts\n↳ 待办: 补测试",
      },
      { kind: "herta", surface: "speech", text: "改完了。" },
    ];
    const d = buildEpisodeDigest(coding);
    expect(d).not.toContain("```diff");
    expect(d).not.toContain("todo list");
    expect(d).not.toContain("后台命令 bg-1");
    expect(d).not.toContain("待办");
    // The outcome spine survives: the step, the marker, its files roll-up.
    expect(d).toContain("写 a.ts");
    expect(d).toContain("做完了：改了 1 个文件。");
    expect(d).toContain("改了：a.ts");
  });
  it("keeps a background command's exit and its output — the verdict of a background test run — and drops its start, polls and stop (dream review 2026-09-22, finding 17)", () => {
    const bg = (
      state: "running" | "stopped" | "exited",
      extra: Pick<SystemBlock, "evidenceDetail"> = {},
    ): TerminalRecordBlock => ({
      kind: "system",
      label: "差分协处理器",
      body: `↳ background bg-1: ${state === "exited" ? "exited (1)" : state}`,
      digest: {
        kind: "bg",
        id: "bg-1",
        state,
        ...(state === "exited" ? { exitCode: 1 } : {}),
      },
      ...extra,
    });
    const run: TerminalRecordBlock[] = [
      running("npm test &"),
      bg("running"),
      bg("running", { evidenceDetail: "↳ 输出:\nRUNS 12 suites" }),
      bg("exited", { evidenceDetail: "↳ 输出:\nFAIL parser.test.ts" }),
    ];
    const d = buildEpisodeDigest(run);
    expect(d).toContain("后台命令 bg-1 结束，退出码 1");
    expect(d).toContain("FAIL parser.test.ts");
    expect(d).not.toContain("后台命令 bg-1 在跑");
    expect(d).not.toContain("RUNS 12 suites");
    // A background command that read the attachment store keeps its exit
    // row and loses the text (ADR 0069 §5).
    const fromStore = buildEpisodeDigest([
      running("cat .herta/attachments/s1/spec.md &"),
      bg("running"),
      {
        kind: "system",
        label: "差分协处理器",
        body: "Reading bg-1 output",
        digest: { kind: "op", verb: "Reading", arg: "bg-1 output" },
      },
      bg("exited", { evidenceDetail: "↳ 输出:\nCONFIDENTIAL" }),
    ]);
    expect(fromStore).toContain("后台命令 bg-1 结束，退出码 1");
    expect(fromStore).not.toContain("CONFIDENTIAL");
  });

  it("a run that ended on a web page: the marker's tail names the site, never the URL or the stored path (release review 2026-10-22)", () => {
    const url = "https://nodejs.org/api/fs.html";
    const path = ".herta/web/nodejs.org-ab12cd34.md";
    const d = buildEpisodeDigest([
      { kind: "user", text: "查一下 fs.readFile 的签名" },
      { kind: "herta", surface: "speech", text: "@板砖 去查。" },
      {
        kind: "system",
        label: "差分协处理器",
        body: "完成",
        evidenceDetail: `↳ 网页 「File system」（${url}，存于 ${path}）
readFile(path[, options], callback)`,
        evidence: [
          {
            kind: "web-page",
            url,
            title: "File system",
            path,
            text: "readFile(path[, options], callback)",
          },
        ],
        role: "done-marker",
        markerSummary: {
          kind: "done",
          state: "completed",
          fileCount: 0,
          riskCount: 0,
        },
      },
      { kind: "herta", surface: "speech", text: "签名在这。" },
    ]);
    expect(d).toContain("网页 nodejs.org「File system」");
    expect(d).not.toContain("https://");
    expect(d).not.toContain(".herta/web");
  });

  it("bounds a long run: its first and last rows, every marker, and a line saying how many were left out (ADR 0069 §7)", () => {
    const op = (i: number): TerminalRecordBlock => ({
      kind: "system",
      label: "差分协处理器",
      body: `Reading src/f${i}.ts`,
      digest: { kind: "op", verb: "Reading", arg: `src/f${i}.ts` },
    });
    const run: TerminalRecordBlock[] = [
      { kind: "user", text: "修 parser" },
      ...Array.from({ length: 50 }, (_, i) => op(i)),
      {
        kind: "system",
        label: "差分协处理器",
        body: "受阻 · 缺依赖",
        role: "done-marker",
      },
      ...Array.from({ length: 50 }, (_, i) => op(50 + i)),
      { kind: "herta", surface: "speech", text: "修好了。" },
    ];
    const d = buildEpisodeDigest(run);
    // The limit counts 板砖's rows; the marker stays on top of it.
    const kept = (d.match(/读 src\/f\d+\.ts/g) ?? []).length;
    expect(kept).toBe(DIGEST_MAX_SYSTEM_ROWS);
    expect(d).toContain("读 src/f0.ts");
    expect(d).toContain("读 src/f99.ts");
    // A marker written before its structured summary keeps its own text.
    expect(d).toContain("受阻 · 缺依赖");
    expect(d).toContain(`此处略去 ${100 - kept} 条板砖操作记录`);
    expect(d).toContain("修好了。");
  });

  it("keeps run evidence within a budget, nearest the verdict first, and always the marker's own detail (ADR 0069 §7); a row past it reads folded", () => {
    const excerpt = (i: number): TerminalRecordBlock => ({
      kind: "system",
      label: "差分协处理器",
      body: `↳ excerpt src/f${i}.ts:1-40`,
      digest: { kind: "excerpt", path: `src/f${i}.ts`, from: 1, to: 40 },
      evidenceDetail: `↳ 摘录 src/f${i}.ts:1-40\nOUT${i} ${"x".repeat(1000)}`,
    });
    const d = buildEpisodeDigest([
      ...Array.from({ length: 12 }, (_, i) => excerpt(i)),
      running("pnpm test"),
      // Past the budget, a command that came back fine leaves nothing.
      result(0, "ok"),
      {
        kind: "system",
        label: "差分协处理器",
        body: "完成 · 1 个文件",
        role: "done-marker",
        markerSummary: {
          kind: "done",
          state: "completed",
          fileCount: 1,
          riskCount: 0,
        },
        evidenceDetail: "↳ 改动文件: a.ts",
      },
    ]);
    // Every row stays; only the last rows' text fits the budget, and an
    // earlier one says its text is not at hand.
    expect(d).toContain("看过 src/f0.ts 第 1–40 行（原文不在手边）");
    expect(d).not.toContain("OUT0 ");
    expect(d).toContain("摘录 src/f11.ts 第 1–40 行：\nOUT11 ");
    const outputs = (d.match(/OUT\d+ /g) ?? []).length;
    expect(outputs).toBeGreaterThan(0);
    expect(outputs * 1000).toBeLessThanOrEqual(DIGEST_EVIDENCE_BUDGET);
    expect(d).toContain("改了：a.ts");
  });

  it("tags each row by what it is — a failed call, a run that failed, stopped or stalled — instead of calling everything verified (dream review 2026-09-22, finding 17)", () => {
    const marker = (
      body: string,
      state?: "completed" | "failed" | "interrupted" | "blocked" | "partial",
      extra: { aborted?: true } = {},
    ): TerminalRecordBlock => ({
      kind: "system",
      label: "差分协处理器",
      body,
      role: "done-marker",
      ...(state !== undefined
        ? {
            markerSummary: {
              kind: "done" as const,
              state,
              fileCount: 0,
              riskCount: 0,
              ...extra,
            },
          }
        : {}),
    });
    const d = buildEpisodeDigest([
      {
        kind: "system",
        label: "系统",
        body: "↳ edit_file failed: stale_read: file changed since read",
        digest: {
          kind: "tool-fail",
          tool: "edit_file",
          code: "stale_read",
        },
      },
      marker("中断 · 0 个文件", "interrupted"),
      marker("失败 · 运行异常中止", "failed", { aborted: true }),
      marker("部分完成 · 1 个文件", "partial"),
      // Persisted before markerSummary existed: the body's state word.
      marker("受阻 · 缺依赖"),
      marker("完成 · 1 个文件", "completed"),
      {
        kind: "system",
        label: "差分协处理器",
        body: "↳ tests: 3 failed",
        digest: { kind: "tests", status: "failed", summary: "3 failed" },
      },
    ]);
    expect(d).toContain(
      "〔系统（失败）：这一步没成（edit_file）：文件读过之后又被改了〕",
    );
    expect(d).toContain("〔差分协处理器（中断）：停下了。〕");
    expect(d).toContain("〔差分协处理器（失败）：没做成：运行中途出了异常。〕");
    expect(d).toContain("〔差分协处理器（部分完成）：做了一部分。〕");
    expect(d).toContain("〔差分协处理器（受阻）：受阻 · 缺依赖〕");
    expect(d).toContain("〔差分协处理器（已核实）：做完了。〕");
    // A failing test is a verified fact about the code, not a failed run.
    expect(d).toContain("〔差分协处理器（已核实）：测试没过（3 failed）〕");
  });

  it("reads a patch preview as its magnitude, never its diff (dream review 2026-09-22, finding 1; ADR 0079 §3)", () => {
    const current: TerminalRecordBlock[] = [
      { kind: "herta", surface: "speech", text: "改。" },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: a.ts (+2 -1)\n\n```diff\n--- a/a.ts\n+++ b/a.ts\n-x\n+y\n+z\n```",
        digest: { kind: "patch", files: ["a.ts"], add: 2, del: 1 },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "Writing a.ts ↳ +2 −1",
        digest: { kind: "op", verb: "Writing", arg: "a.ts" },
      },
    ];
    const d = buildEpisodeDigest(current);
    expect(d).not.toContain("```diff");
    expect(d).not.toContain("patch preview");
    // The write step says what was written; the preview, by how much.
    expect(d).toContain("〔系统（已核实）：改动 a.ts（+2 −1）〕");
    expect(d).toContain("写 a.ts");
    const preview = current[1];
    if (preview?.kind !== "system") throw new Error("fixture");
    expect(systemRowForDream(preview, null)).toBe("改动 a.ts（+2 −1）");
  });

  it("drops a legacy pre-digest patch preview by body prefix", () => {
    const legacy: TerminalRecordBlock[] = [
      { kind: "herta", surface: "speech", text: "看。" },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: old.ts\n\n```diff\n+y\n```",
      },
    ];
    expect(buildEpisodeDigest(legacy)).not.toContain("patch preview");
  });
});

describe("buildEpisodeDigest — 板砖's rows in the words she read them in (ADR 0079 §3)", () => {
  // The 废案 a dream writes retells the record; the digest is what it
  // retells it from. Built from the stored bodies, it handed the dream the
  // grammar Herta's prompt no longer reads — `↳ exit 0 · 2 lines`,
  // `ran … (exit 0, 3.1s) — log at …` — and the new 废案 came out in it.
  const REMEMBERED =
    "测试用 pnpm test，别用 npm test：package.json 里的 test 脚本在 Node 22 下一跑就退出，所以别再用它";
  const run: TerminalRecordBlock[] = [
    { kind: "user", text: "把 fib 改成迭代" },
    { kind: "herta", surface: "speech", text: "@板砖 改。" },
    {
      kind: "system",
      label: "差分协处理器",
      body: "Saving memory test_command",
      digest: { kind: "op", verb: "Saving memory", arg: "test_command" },
    },
    // What was saved, as the bridge writes it: its body, no digest.
    projectBackendEvent({
      type: "tool.call.finished",
      layer: "backend",
      id: "m1",
      tool: "memory_save",
      result: {
        ok: true,
        summary: "remembered: test_command",
        data: { id: "x", kind: "test_command", text: REMEMBERED, why: "x" },
      },
    }) as SystemBlock,
    running("pnpm test"),
    result(0),
    {
      kind: "system",
      label: "差分协处理器",
      body: "完成 · 1 个文件 · +9 −4 · 测试 8/8",
      role: "done-marker",
      markerSummary: {
        kind: "done",
        state: "completed",
        fileCount: 1,
        lines: { add: 9, del: 4 },
        tests: { passed: 8, failed: 0 },
        riskCount: 0,
      },
      evidenceDetail: [
        "↳ 改动文件: fibonacci.ts",
        "↳ 依据: ran `cd /c/Users/x/.herta/workspaces/abc && pnpm test` (exit 0, 3.10s) — log at .herta/logs/run.log（call_00_ab12）",
      ].join("\n"),
      evidence: [
        { kind: "files", paths: ["fibonacci.ts"] },
        {
          kind: "evidence",
          items: [
            "ran `cd /c/Users/x/.herta/workspaces/abc && pnpm test` (exit 0, 3.10s) — log at .herta/logs/run.log（call_00_ab12）",
          ],
        },
      ],
    },
    { kind: "herta", surface: "speech", text: "8/8。" },
  ];

  it("in Chinese: the done sentence, the plain labels, no bookkeeping", () => {
    const d = buildEpisodeDigest(run);
    expect(d).toContain(
      "〔差分协处理器（已核实）：做完了：改了 1 个文件（+9 −4），测试 8/8 通过。\n改了：fibonacci.ts\n依据：运行 `pnpm test`〕",
    );
    // A memory save's row has no digest; it reads as what was remembered,
    // the whole fact, as in her prompt.
    expect(d).toContain(
      `〔差分协处理器（已核实）：板砖记下了：${REMEMBERED}〕`,
    );
    for (const bookkeeping of [
      "↳",
      "exit 0",
      ".herta/logs",
      "call_00",
      "3.10s",
      "/workspaces/",
      "Saving memory",
      "test_command",
    ]) {
      expect(d).not.toContain(bookkeeping);
    }
  });

  it("in English: the same rows in English, the digest's own notation unchanged", () => {
    const d = buildEpisodeDigest(run, "en");
    expect(d).toContain(
      "〔差分协处理器（已核实）：Done: changed 1 file (+9 −4), tests 8/8 passed.\nChanged files: fibonacci.ts\nBased on: ran `pnpm test`〕",
    );
    expect(d).toContain(
      `〔差分协处理器（已核实）：板砖 noted: ${REMEMBERED}〕`,
    );
    expect(d).toContain("开拓者：把 fib 改成迭代");
    expect(d).not.toContain("↳");
    expect(d).not.toContain("remembered");
    expect(d).not.toContain(".herta/logs");
  });
});
