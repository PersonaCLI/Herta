import { describe, expect, it } from "vitest";
import type { MessageKey } from "../../i18n/keys.js";
import { en } from "../../i18n/messages/en.js";
import { zh } from "../../i18n/messages/zh.js";
import type { SystemBlock } from "./group-record.js";
import {
  latestOpStep,
  stepDisplayBody,
  stepDisplayDetail,
} from "./step-display.js";

// zh-flavored fake catalog: proves localization is applied without coupling
// the test to the real message files.
const ZH: Partial<Record<MessageKey, string>> = {
  "activity.verb.reading": "读取",
  "activity.verb.writing": "写入",
  "activity.result.tests": "测试",
  "activity.result.failed": "失败",
  "activity.result.exit": "退出",
  "activity.result.lines": "行",
  "activity.step.patchPreview": "补丁预览",
  "activity.bg.label": "后台",
  "activity.bg.running": "运行中",
  "activity.bg.stopped": "已停止",
  "activity.bg.exited": "已退出",
  "activity.bg.signal": "信号中止",
  "evidence.output": "输出",
  "evidence.excerpt": "摘录",
  "evidence.files": "改动文件",
  "evidence.risks": "风险",
  "evidence.todos": "待办",
  "evidence.error": "错误",
};
const t = (key: MessageKey): string => ZH[key] ?? key;

/** en-flavored fake catalog — the case the structured lane exists for. */
const EN: Partial<Record<MessageKey, string>> = {
  "evidence.output": "output",
  "evidence.excerpt": "excerpt",
  "evidence.files": "changed files",
  "evidence.risks": "risks",
  "evidence.todos": "to do",
  "evidence.error": "error",
};
const tEn = (key: MessageKey): string => EN[key] ?? key;

const sys = (body: string, digest?: SystemBlock["digest"]): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body,
  ...(digest !== undefined ? { digest } : {}),
});

/**
 * A write was the ONE operation with no `↳` outcome row: its patch block said
 * `patch preview: <files>`, which restates the `Writing` row above it and says
 * nothing about size. Every other operation answers itself.
 *
 * Since 2026-08-25 evening a preview normally FOLDS into the write it previews
 * (`activityRows`), so this path renders only the standalone case: a DENIED
 * edit, previewed by the permission rule but never written.
 */
describe("stepDisplayBody — patch magnitude (2026-08-25)", () => {
  const body = "patch preview: a.ts (+96 -5)\n\n```diff\n+x\n-y\n```";

  it("leads with the magnitude and keeps the diff beneath it", () => {
    const out = stepDisplayBody(
      sys(body, { kind: "patch", files: ["a.ts"], add: 96, del: 5 }),
      t,
    );
    expect(out.split("\n")[0]).toBe("↳ +96 −5");
    // The fence is untouched — the existing expander still opens it.
    expect(out).toContain("```diff");
    expect(out).toContain("+x");
  });

  it("leaves the canonical line alone when there is nothing to count", () => {
    // Owner, 2026-08-25 evening: this used to read `↳ 已改动（命令，无逐行差异）`
    // — a sentence about the absence of a number, where the canonical line at
    // least names the file. A `+0 −0` is still never acceptable.
    const out = stepDisplayBody(
      sys("patch preview: a.ts\n\n```diff\n```", {
        kind: "patch",
        files: ["a.ts"],
      }),
      t,
    );
    expect(out.split("\n")[0]).toBe("patch preview: a.ts");
    expect(out).not.toContain("+0");
  });

  it("still renders a pre-2026-08-25 record's skip digest", () => {
    expect(
      stepDisplayBody(
        sys("patch preview: a.ts\n\n```diff\n+x\n```", {
          kind: "skip",
        }),
        t,
      ),
    ).toContain("补丁预览");
  });
});

describe("stepDisplayBody — bg digests (2026-07-23), legacy todo rows", () => {
  it("localizes background lifecycle rows, incl. the signal case", () => {
    expect(
      stepDisplayBody(
        sys("↳ background bg-1: running", {
          kind: "bg",
          id: "bg-1",
          state: "running",
        }),
        t,
      ),
    ).toBe("↳ 后台 bg-1: 运行中");
    expect(
      stepDisplayBody(
        sys("↳ background bg-1: exited (signal)", {
          kind: "bg",
          id: "bg-1",
          state: "exited",
          exitCode: null,
        }),
        t,
      ),
    ).toBe("↳ 后台 bg-1: 已退出 (信号中止)");
    expect(
      stepDisplayBody(
        sys("↳ background bg-1: exited (0)", {
          kind: "bg",
          id: "bg-1",
          state: "exited",
          exitCode: 0,
        }),
        t,
      ),
    ).toBe("↳ 后台 bg-1: 已退出 (0)");
  });

  it("a legacy todo row (records before ADR 0073) shows the body it was recorded with", () => {
    const body = "todo list (2):\n[~] 定位 bug\n[ ] 修复";
    expect(
      stepDisplayBody(sys(body, { kind: "todo", total: 2, completed: 0 }), t),
    ).toBe(body);
    expect(
      stepDisplayBody(
        sys("todo 1/3: 修复", {
          kind: "todo",
          total: 3,
          completed: 1,
          current: "修复",
        }),
        t,
      ),
    ).toBe("todo 1/3: 修复");
  });
});

describe("latestOpStep — a legacy todo row is never the live state (ADR 0073)", () => {
  it("skips back past it to the op", () => {
    const op = sys("Reading a.ts", {
      kind: "op",
      verb: "Reading",
      arg: "a.ts",
    });
    const progress = sys("todo 1/3: b", {
      kind: "todo",
      total: 3,
      completed: 1,
      current: "b",
    });
    expect(latestOpStep([op, progress])).toBe(op);
  });
});

describe("latestOpStep — failure rows are headline-eligible (2026-07-23)", () => {
  it("returns a trailing tool-fail row instead of hiding it behind the last op", () => {
    const steps = [
      sys("Reading a.ts", { kind: "op", verb: "Reading", arg: "a.ts" }),
      sys("↳ read_file failed: tool_crashed: boom", {
        kind: "tool-fail",
        tool: "read_file",
        code: "tool_crashed",
        message: "boom",
      }),
    ];
    expect(latestOpStep(steps)?.digest?.kind).toBe("tool-fail");
  });
});

describe("stepDisplayBody (display-only localization from digests, D7)", () => {
  it("localizes op verbs", () => {
    expect(
      stepDisplayBody(
        sys("Writing a.ts", { kind: "op", verb: "Writing", arg: "a.ts" }),
        t,
      ),
    ).toBe("写入 a.ts");
  });

  it("localizes the tests label, keeping the summary (data) verbatim", () => {
    expect(
      stepDisplayBody(
        sys("↳ tests: 3 passed", {
          kind: "tests",
          status: "passed",
          summary: "3 passed",
        }),
        t,
      ),
    ).toBe("↳ 测试: 3 passed");
  });

  it("localizes the failed label when the digest carries the message", () => {
    expect(
      stepDisplayBody(
        sys("↳ edit_file failed: stale_read: file changed", {
          kind: "tool-fail",
          tool: "edit_file",
          code: "stale_read",
          message: "file changed",
        }),
        t,
      ),
    ).toBe("↳ edit_file 失败: stale_read: file changed");
  });

  it("falls back to the canonical body for a pre-2026-07-10 tool-fail digest (no message — a digest-only render would drop it)", () => {
    expect(
      stepDisplayBody(
        sys("↳ edit_file failed: stale_read: file changed", {
          kind: "tool-fail",
          tool: "edit_file",
          code: "stale_read",
        }),
        t,
      ),
    ).toBe("↳ edit_file failed: stale_read: file changed");
  });

  it("localizes exit rows from the structured numbers", () => {
    expect(
      stepDisplayBody(
        sys("↳ exit 1 · 0 lines", {
          kind: "text",
          text: "↳ exit 1 · 0 lines",
          exitCode: 1,
          lineCount: 0,
        }),
        t,
      ),
    ).toBe("↳ 退出 1 · 0 行");
  });

  it("falls back to the body for text digests without exit numbers (signal/timeout, old records)", () => {
    expect(
      stepDisplayBody(
        sys("↳ timed out · 0 lines", {
          kind: "text",
          text: "↳ timed out · 0 lines",
        }),
        t,
      ),
    ).toBe("↳ timed out · 0 lines");
  });

  it("swaps only the patch-preview label, keeping files + diff fence verbatim", () => {
    const body = "patch preview: a.ts\n\n```diff\n+x\n```";
    expect(stepDisplayBody(sys(body, { kind: "skip" }), t)).toBe(
      "补丁预览: a.ts\n\n```diff\n+x\n```",
    );
  });

  it("renders records without a digest verbatim", () => {
    expect(stepDisplayBody(sys("Reading a.ts"), t)).toBe("Reading a.ts");
  });

  it("localizes a search-hit row from its counts (2026-08-17)", () => {
    const S: Partial<Record<MessageKey, string>> = {
      "activity.result.matches": "处匹配",
      "activity.result.files": "个文件",
      "activity.result.truncated": "已截断",
    };
    const ts = (key: MessageKey): string => S[key] ?? `MISSING:${key}`;
    expect(
      stepDisplayBody(
        sys("↳ 5 matches in 1 files", {
          kind: "search",
          pattern: "CUDA",
          matches: 5,
          files: 1,
          truncated: false,
        }),
        ts,
      ),
    ).toBe("↳ 5 处匹配 · 1 个文件");
    expect(
      stepDisplayBody(
        sys("↳ 0 matches", {
          kind: "search",
          pattern: "x",
          matches: 0,
          files: 0,
          truncated: true,
        }),
        ts,
      ),
    ).toBe("↳ 0 处匹配 (已截断)");
  });

  it("composes the search-hit detail pane from the structured section, with the omitted count", () => {
    const S: Partial<Record<MessageKey, string>> = {
      "evidence.matches": "matches",
      "evidence.matches.omitted": "({n} more not listed)",
    };
    const ts = (key: MessageKey): string => S[key] ?? `MISSING:${key}`;
    const block: SystemBlock = {
      ...sys("↳ 3 matches in 1 files", {
        kind: "search",
        pattern: "CUDA",
        matches: 3,
        files: 1,
        truncated: false,
      }),
      evidenceDetail:
        "↳ 匹配 /CUDA/:\nlog.txt:33: a\nlog.txt:40: b\n（另有 1 处未列出）",
      evidence: [
        {
          kind: "matches",
          pattern: "CUDA",
          items: ["log.txt:33: a", "log.txt:40: b"],
          omitted: 1,
        },
      ],
    };
    expect(stepDisplayDetail(block, ts)).toBe(
      "↳ matches /CUDA/:\nlog.txt:33: a\nlog.txt:40: b\n(1 more not listed)",
    );
  });
});

describe("stepDisplayBody — attachment rows, incl. PDF / Word (ADR 0038)", () => {
  // The row is composed WHOLLY from the digest (never the canonical body), so
  // a fake catalog with only the attachment keys is enough. Every key here is
  // a real MessageKey — the fallback `?? key` would otherwise mask a typo as
  // a passing test.
  const A: Partial<Record<MessageKey, string>> = {
    "activity.attachment.label": "附件",
    "activity.attachment.chars": "字",
    "activity.result.lines": "行",
    "activity.attachment.pages": "页",
    "activity.attachment.extracted": "已提取文本",
    "activity.attachment.format.pdf": "PDF",
    "activity.attachment.format.docx": "Word 文档",
    "activity.attachment.unreadable.tooLarge": "文件过大，未取正文",
    "activity.attachment.unreadable.tooManyPages": "页数过多，未提取",
    "activity.attachment.unreadable.textTooLong": "正文过长，未取正文",
    "activity.attachment.unreadable.empty": "未提取到文本",
    "activity.attachment.unreadable.scanned": "未提取到文本，可能是扫描件",
    "activity.attachment.unreadable.encrypted": "文档已加密，未取正文",
    "activity.attachment.unreadable.unsupported": "暂不支持的文档格式",
    "activity.attachment.unreadable.readError": "读取失败",
    "activity.attachment.outline": "目录 {n} 条",
    "activity.attachment.image": "图片 {f}",
    "activity.attachment.unreadable.imageTooLarge": "图片过大，未能读图",
    "activity.attachment.unreadable.noCaption": "已存图片，未能读图",
  };
  const ta = (key: MessageKey): string => A[key] ?? `MISSING:${key}`;
  const att = (digest: Record<string, unknown>): SystemBlock =>
    sys("附件 …", {
      kind: "attachment",
      name: "x",
      path: ".herta/attachments/s/x",
      lines: 0,
      chars: 0,
      ...digest,
    } as SystemBlock["digest"]);

  it("a plain text attachment reads as before — no format, no pages", () => {
    expect(
      stepDisplayBody(att({ name: "spec.md", lines: 120, chars: 4800 }), ta),
    ).toBe("附件 spec.md · 120 行 · 4,800 字");
  });

  it("a PDF names its format and page count first, then says the text was extracted", () => {
    expect(
      stepDisplayBody(
        att({
          name: "report.pdf",
          path: ".herta/attachments/s/report-ab12cd34.pdf.txt",
          format: "pdf",
          pages: 12,
          lines: 340,
          chars: 18000,
        }),
        ta,
      ),
    ).toBe("附件 report.pdf · PDF · 12 页 · 已提取文本 · 340 行 · 18,000 字");
  });

  it("a document with an outline shows the entry count after the body counts — and after the reason for an over-cap one (2026-08-23)", () => {
    const outline = {
      path: ".herta/attachments/s/book-ab12cd34.pdf.outline.txt",
      entries: 124,
    };
    expect(
      stepDisplayBody(
        att({
          name: "book.pdf",
          format: "pdf",
          pages: 216,
          lines: 5149,
          chars: 116049,
          pageMarker: "── 第 N 页 ──",
          outline,
        }),
        ta,
      ),
    ).toBe(
      "附件 book.pdf · PDF · 216 页 · 已提取文本 · 5,149 行 · 116,049 字 · 目录 124 条",
    );
    expect(
      stepDisplayBody(
        att({
          name: "book.pdf",
          format: "pdf",
          pages: 516,
          unreadable: "too_large",
          outline,
        }),
        ta,
      ),
    ).toBe("附件 book.pdf · PDF · 516 页 · 正文过长，未取正文 · 目录 124 条");
  });

  it("a Word document has no page count", () => {
    expect(
      stepDisplayBody(
        att({ name: "spec.docx", format: "docx", lines: 20, chars: 900 }),
        ta,
      ),
    ).toBe("附件 spec.docx · Word 文档 · 已提取文本 · 20 行 · 900 字");
  });

  it("`too_large` reads three ways by context — text file / page cap / long extraction", () => {
    // Text file over the excerpt cap: stored, no head.
    expect(
      stepDisplayBody(att({ name: "huge.log", unreadable: "too_large" }), ta),
    ).toBe("附件 huge.log · 文件过大，未取正文");
    // PDF over the page cap: refused whole, nothing on disk.
    expect(
      stepDisplayBody(
        att({
          name: "book.pdf",
          path: "",
          format: "pdf",
          pages: 1400,
          unreadable: "too_large",
        }),
        ta,
      ),
    ).toBe("附件 book.pdf · PDF · 1,400 页 · 页数过多，未提取");
    // Extracted text over the char cap: stored in full, no head.
    expect(
      stepDisplayBody(
        att({
          name: "long.pdf",
          path: ".herta/attachments/s/long-ab12cd34.pdf.txt",
          format: "pdf",
          pages: 80,
          unreadable: "too_large",
        }),
        ta,
      ),
    ).toBe("附件 long.pdf · PDF · 80 页 · 正文过长，未取正文");
  });

  it("an empty PDF is called a probable scan; an empty docx is just empty", () => {
    expect(
      stepDisplayBody(
        att({
          name: "scan.pdf",
          path: "",
          format: "pdf",
          pages: 3,
          unreadable: "empty",
        }),
        ta,
      ),
    ).toBe("附件 scan.pdf · PDF · 3 页 · 未提取到文本，可能是扫描件");
    expect(
      stepDisplayBody(
        att({
          name: "blank.docx",
          path: "",
          format: "docx",
          unreadable: "empty",
        }),
        ta,
      ),
    ).toBe("附件 blank.docx · Word 文档 · 未提取到文本");
  });

  it("encrypted and unsupported carry their own reasons", () => {
    expect(
      stepDisplayBody(
        att({
          name: "locked.pdf",
          path: "",
          format: "pdf",
          unreadable: "encrypted",
        }),
        ta,
      ),
    ).toBe("附件 locked.pdf · PDF · 文档已加密，未取正文");
    expect(
      stepDisplayBody(
        att({ name: "old.doc", path: "", unreadable: "unsupported" }),
        ta,
      ),
    ).toBe("附件 old.doc · 暂不支持的文档格式");
  });

  // ── Images (ADR 0048) ────────────────────────────────────────────────────

  it("an image row is format, size, then the CAPTION — never 0 行 0 字", () => {
    // The pre-ADR-0048 branch would have rendered an image's empty line/char
    // counts, stating two numbers about a file that has neither.
    expect(
      stepDisplayBody(
        att({
          name: "shot.png",
          image: { format: "png", width: 1920, height: 1080 },
          caption: "一张终端截图，测试全部通过。",
        }),
        ta,
      ),
    ).toBe(
      "附件 shot.png · 图片 PNG · 1920×1080 · 一张终端截图，测试全部通过。",
    );
  });

  it("omits dimensions the sniff could not read, rather than guessing", () => {
    expect(
      stepDisplayBody(
        att({
          name: "pic.webp",
          image: { format: "webp" },
          caption: "一只猫。",
        }),
        ta,
      ),
    ).toBe("附件 pic.webp · 图片 WEBP · 一只猫。");
  });

  it("an uncaptioned image says stored-not-read, and still shows what it is", () => {
    expect(
      stepDisplayBody(
        att({
          name: "shot.png",
          image: { format: "png", width: 800, height: 600 },
          unreadable: "no_caption",
        }),
        ta,
      ),
    ).toBe("附件 shot.png · 图片 PNG · 800×600 · 已存图片，未能读图");
  });

  it("too_large on an IMAGE reads as its own reason, not the document ones", () => {
    // Four meanings share `too_large`; the image one must not borrow a
    // document's phrasing (mirrors app-server's reasonFor).
    expect(
      stepDisplayBody(
        att({
          name: "huge.png",
          image: { format: "png", width: 9000, height: 9000 },
          unreadable: "too_large",
        }),
        ta,
      ),
    ).toBe("附件 huge.png · 图片 PNG · 9000×9000 · 图片过大，未能读图");
  });
});

describe("stepDisplayDetail — the evidence pane localizes (2026-08-01)", () => {
  /** A block whose canonical detail is the Chinese the bridge composes, with
   *  the structured mirror alongside it — exactly what projectBackendEvent
   *  now writes. */
  const excerptBlock: SystemBlock = {
    kind: "system",
    label: "差分协处理器",
    body: "↳ excerpt src/a.ts:120-121",
    evidenceDetail: "↳ 摘录 src/a.ts:120-121\nconst x = 1;",
    evidence: [
      {
        kind: "excerpt",
        path: "src/a.ts",
        from: 120,
        to: 121,
        text: "const x = 1;",
      },
    ],
  };

  it("translates the section label for an EN session", () => {
    expect(stepDisplayDetail(excerptBlock, tEn)).toBe(
      "↳ excerpt src/a.ts:120-121\nconst x = 1;",
    );
  });

  it("reproduces the canonical string verbatim for a zh session", () => {
    // The zh render must stay byte-identical to the canonical detail — this
    // change is display-only and must not move Chinese output by a character.
    expect(stepDisplayDetail(excerptBlock, t)).toBe(
      excerptBlock.evidenceDetail,
    );
  });

  it("keeps backend-authored payloads verbatim in both languages", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "↳ exit 0 · 2 lines",
      evidenceDetail: "↳ 输出:\nsrc/a.ts:9\nsrc/b.ts:3",
      evidence: [{ kind: "output", text: "src/a.ts:9\nsrc/b.ts:3" }],
    };
    expect(stepDisplayDetail(block, tEn)).toBe(
      "↳ output:\nsrc/a.ts:9\nsrc/b.ts:3",
    );
    expect(stepDisplayDetail(block, t)).toBe(block.evidenceDetail);
  });

  it("composes a multi-section done-marker roll-up in order", () => {
    const marker: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "完成 · 2 个文件",
      role: "done-marker",
      evidenceDetail:
        "↳ 输出:\nok\n↳ 改动文件: a.ts, b.ts\n↳ 风险: 未跑全量\n↳ 待办: 补测试",
      evidence: [
        { kind: "output", text: "ok" },
        { kind: "files", paths: ["a.ts", "b.ts"] },
        { kind: "risks", items: ["未跑全量"] },
        { kind: "todos", items: ["补测试"] },
      ],
    };
    expect(stepDisplayDetail(marker, tEn)).toBe(
      "↳ output:\nok\n↳ changed files: a.ts, b.ts\n↳ risks: 未跑全量\n↳ to do: 补测试",
    );
    expect(stepDisplayDetail(marker, t)).toBe(marker.evidenceDetail);
  });

  it("localizes the bridge-failure marker's error section", () => {
    expect(
      stepDisplayDetail(
        {
          kind: "system",
          label: "差分协处理器",
          body: "失败 · 运行异常中止",
          role: "done-marker",
          evidenceDetail: "↳ 错误: mkdir EACCES",
          evidence: [{ kind: "error", message: "mkdir EACCES" }],
        },
        tEn,
      ),
    ).toBe("↳ error: mkdir EACCES");
  });

  it("localizes the outline section and keeps its preview note (2026-08-23)", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "附件 book.pdf · …",
      evidenceDetail:
        "↳ 目录 124 条（前 2 条）\nChapter 1 (p.1 · L1)\n  Section 1.1 (p.2 · L4)",
      evidence: [
        {
          kind: "outline",
          name: "book.pdf",
          path: ".herta/attachments/s/book-ab12cd34.pdf.outline.txt",
          items: ["Chapter 1 (p.1 · L1)", "  Section 1.1 (p.2 · L4)"],
          total: 124,
        },
      ],
    };
    const tOutline = (key: MessageKey): string =>
      key === "evidence.outline"
        ? "outline · {n} entries"
        : key === "evidence.outline.shown"
          ? "(first {n})"
          : tEn(key);
    expect(stepDisplayDetail(block, tOutline)).toBe(
      "↳ outline · 124 entries (first 2)\nChapter 1 (p.1 · L1)\n  Section 1.1 (p.2 · L4)",
    );
    // A complete preview carries no "(first N)".
    const whole: SystemBlock = {
      ...block,
      evidence: [
        {
          kind: "outline",
          name: "book.pdf",
          path: ".herta/attachments/s/book-ab12cd34.pdf.outline.txt",
          items: ["Chapter 1 (p.1 · L1)", "  Section 1.1 (p.2 · L4)"],
          total: 2,
        },
      ],
    };
    expect(stepDisplayDetail(whole, tOutline)).toBe(
      "↳ outline · 2 entries\nChapter 1 (p.1 · L1)\n  Section 1.1 (p.2 · L4)",
    );
  });

  it("a digest row and its overview pane localize, and the pane keeps the model-generated label (ADR 0043)", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "↳ digest .herta/attachments/s/b-ab12cd34.pdf.digest.txt · 27 chunks (cached)",
      digest: {
        kind: "digest",
        source: ".herta/attachments/s/b-ab12cd34.pdf.txt",
        path: ".herta/attachments/s/b-ab12cd34.pdf.digest.txt",
        chunks: 27,
        cached: true,
      },
      evidenceDetail: "↳ 摘要 …\n总览一\n总览二",
      evidence: [
        {
          kind: "digest",
          source: ".herta/attachments/s/b-ab12cd34.pdf.txt",
          path: ".herta/attachments/s/b-ab12cd34.pdf.digest.txt",
          chunks: 27,
          text: "总览一\n总览二",
        },
      ],
    };
    const tD = (key: MessageKey): string =>
      key === "activity.result.digest"
        ? "digest"
        : key === "activity.result.chunks"
          ? "chunks"
          : key === "activity.result.cached"
            ? "cached"
            : key === "evidence.digest"
              ? "digest of {source} (model-generated, {n} chunks — per-chunk entries in {path})"
              : tEn(key);
    expect(stepDisplayBody(block, tD)).toBe(
      "↳ digest .herta/attachments/s/b-ab12cd34.pdf.digest.txt · 27 chunks (cached)",
    );
    expect(stepDisplayDetail(block, tD)).toBe(
      "↳ digest of .herta/attachments/s/b-ab12cd34.pdf.txt (model-generated, 27 chunks — per-chunk entries in .herta/attachments/s/b-ab12cd34.pdf.digest.txt)\n总览一\n总览二",
    );
    // The op row's verb localizes through VERB_KEY like every other verb.
    expect(
      stepDisplayBody(
        sys("Digesting x", { kind: "op", verb: "Digesting", arg: "x" }),
        (key: MessageKey) =>
          key === "activity.verb.digesting" ? "摘要" : tEn(key),
      ),
    ).toBe("摘要 x");
  });

  it("the crash marker's cut-off steps: the outcome words translate, the steps stay verbatim (ADR 0071 §1.2)", () => {
    const tCat =
      (cat: Record<MessageKey, string>) =>
      (key: MessageKey): string =>
        cat[key];
    // The canonical detail exactly as the seal writes it (pinned by the
    // app-server's dispatch-recovery test).
    const marker: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "中断 · 1 个文件 · 应用意外退出",
      role: "done-marker",
      evidenceDetail:
        "↳ 中断时: edit_file a.ts — 已写入; run_command npm test — 未开始\n↳ 改动文件: a.ts",
      evidence: [
        {
          kind: "cutoff",
          steps: [
            { step: "edit_file a.ts", outcome: "write_applied" },
            { step: "run_command npm test", outcome: "not_started" },
          ],
        },
        { kind: "files", paths: ["a.ts"] },
      ],
    };
    expect(stepDisplayDetail(marker, tCat(zh))).toBe(marker.evidenceDetail);
    expect(stepDisplayDetail(marker, tCat(en))).toBe(
      "↳ when the app exited: edit_file a.ts — written; run_command npm test — not started\n↳ changed files: a.ts",
    );
  });

  it("falls back to the canonical string for records without sections", () => {
    // Every session persisted before `evidence` existed. The pane must keep
    // showing what it showed before rather than going blank.
    expect(
      stepDisplayDetail(
        {
          kind: "system",
          label: "差分协处理器",
          body: "↳ exit 0 · 1 lines",
          evidenceDetail: "↳ 输出:\nlegacy",
        },
        tEn,
      ),
    ).toBe("↳ 输出:\nlegacy");
  });

  it("returns undefined when the block carries no detail at all", () => {
    expect(stepDisplayDetail(sys("Reading a.ts"), tEn)).toBeUndefined();
  });
});

describe("latestOpStep", () => {
  it("prefers the latest OP over a trailing result row", () => {
    const steps = [
      sys("Running x", { kind: "op", verb: "Running", arg: "x" }),
      sys("↳ exit 1 · 0 lines", { kind: "text", text: "↳ exit 1 · 0 lines" }),
    ];
    expect(latestOpStep(steps)?.body).toBe("Running x");
  });

  it("falls back to the last step when only results exist", () => {
    const steps = [
      sys("↳ exit 1 · 0 lines", { kind: "text", text: "↳ exit 1 · 0 lines" }),
    ];
    expect(latestOpStep(steps)?.body).toBe("↳ exit 1 · 0 lines");
  });
});

describe("web rows (ADR 0080)", () => {
  const T = (key: MessageKey): string => zh[key] ?? key;
  const TE = (key: MessageKey): string => en[key] ?? key;
  const search: SystemBlock = {
    kind: "system",
    label: "差分协处理器",
    body: "↳ web results: 2",
    digest: {
      kind: "web-search",
      query: "vitest update",
      results: [
        { title: "update | Vitest", site: "Vitest" },
        { title: "Snapshot", site: "example.com" },
      ],
    },
    evidenceDetail:
      "↳ 网页结果:\n- update | Vitest（Vitest）\n- Snapshot（example.com）",
    evidence: [
      {
        kind: "web-results",
        items: [
          {
            title: "update | Vitest",
            site: "Vitest",
            url: "https://vitest.dev/config/update",
          },
          {
            title: "Snapshot",
            site: "example.com",
            url: "https://example.com/snap",
          },
        ],
      },
    ],
  };
  const page: SystemBlock = {
    kind: "system",
    label: "差分协处理器",
    body: '↳ page nodejs.org: "File system" · 189634 chars',
    digest: {
      kind: "web-fetch",
      url: "https://nodejs.org/api/fs.html",
      host: "nodejs.org",
      title: "File system",
      path: ".herta/web/nodejs.org-0123abcd.md",
      chars: 189634,
    },
    evidence: [
      {
        kind: "web-page",
        url: "https://nodejs.org/api/fs.html",
        title: "File system",
        path: ".herta/web/nodejs.org-0123abcd.md",
        text: "# File system",
      },
    ],
  };
  const op = (
    verb: "Searching the web" | "Reading web page",
    arg: string,
  ): SystemBlock => ({
    kind: "system",
    label: "差分协处理器",
    body: `${verb} ${arg}`,
    digest: { kind: "op", verb, arg },
  });

  it("names the steps in the session's language", () => {
    expect(stepDisplayBody(op("Searching the web", "vitest update"), T)).toBe(
      "搜索网页 vitest update",
    );
    expect(
      stepDisplayBody(op("Reading web page", "https://nodejs.org/x"), TE),
    ).toBe("Reading web page https://nodejs.org/x");
  });

  it("states a search's count and a page's site, title and size", () => {
    expect(stepDisplayBody(search, T)).toBe("↳ 2 条结果");
    expect(
      stepDisplayBody(
        {
          ...search,
          digest: { ...search.digest, results: [] } as SystemBlock["digest"],
        },
        T,
      ),
    ).toBe("↳ 没有搜到结果");
    expect(stepDisplayBody(page, T)).toBe(
      `↳ 网页 nodejs.org · File system · ${(189634).toLocaleString()} 字`,
    );
  });

  it("lists each result's URL in the detail pane, where the row makes it a link", () => {
    expect(stepDisplayDetail(search, TE)).toBe(
      "↳ web results:\n- update | Vitest（Vitest）\n  https://vitest.dev/config/update\n- Snapshot（example.com）\n  https://example.com/snap",
    );
    expect(stepDisplayDetail(page, T)).toBe(
      "↳ 网页 File system\nhttps://nodejs.org/api/fs.html\n# File system",
    );
  });
});

describe("stepDisplayBody — the page steps (ADR 0083 §10)", () => {
  const tz = (key: MessageKey): string => zh[key];
  const te = (key: MessageKey): string => en[key];

  it("names each step's verb in the user's language", () => {
    const op = sys("Clicking", { kind: "op", verb: "Clicking", arg: "" });
    expect(stepDisplayBody(op, tz)).toBe("点击");
    expect(stepDisplayBody(op, te)).toBe("Clicking");
    const open = sys("Opening page localhost:5173/login", {
      kind: "op",
      verb: "Opening page",
      arg: "localhost:5173/login",
    });
    expect(stepDisplayBody(open, tz)).toBe("打开页面 localhost:5173/login");
  });

  it("localizes the chrome, keeps the page's words verbatim", () => {
    const opened = sys("↳ opened …", {
      kind: "page-open",
      route: "localhost:5173/login",
      title: "Vite + React",
      status: 500,
      errors: 2,
    });
    expect(stepDisplayBody(opened, tz)).toBe(
      "↳ localhost:5173/login · Vite + React · HTTP 500 · 2 个控制台错误",
    );
    const typed = sys("↳ typed …", {
      kind: "page-act",
      action: "type",
      route: "localhost:5173/login",
      title: "",
      navigated: false,
      target: 'textbox "Password"',
      typed: "••••••",
      password: true,
      submit: true,
      errors: 0,
    });
    expect(stepDisplayBody(typed, tz)).toBe(
      '↳ 在 textbox "Password" 输入了 "••••••"，按了回车',
    );
    expect(stepDisplayBody(typed, te)).toBe(
      '↳ Typed "••••••" into textbox "Password", then pressed Enter',
    );
    const network = sys("↳ network …", {
      kind: "page-read",
      mode: "network",
      route: "localhost:5173/login",
      title: "",
      count: 24,
      truncated: false,
      failures: 1,
    });
    expect(stepDisplayBody(network, te)).toBe("↳ 24 requests · 1 failed");
    const shot = sys("↳ screenshot …", {
      kind: "page-shot",
      route: "localhost:5173",
      path: ".herta/browser/s/shot-1.png",
      width: 375,
      height: 812,
      region: false,
    });
    expect(stepDisplayBody(shot, tz)).toBe("↳ localhost:5173 · 375×812");
  });

  it("the detail pane counts what the bound left out", () => {
    const b: SystemBlock = {
      ...sys("↳ 3 elements on localhost:5173"),
      evidence: [
        { kind: "page", mode: "tree", text: 'button "Sign in"', omitted: 4 },
      ],
    };
    expect(stepDisplayDetail(b, tz)).toBe(
      '↳ 页面元素:\nbutton "Sign in"\n（另有 4 个未列出）',
    );
  });
});

describe("stepDisplayBody — the launcher (ADR 0083 §5)", () => {
  const tz = (key: MessageKey): string => zh[key];
  const te = (key: MessageKey): string => en[key];

  it("names the server and where it answers; who started it when it was you", () => {
    expect(
      stepDisplayBody(
        sys("Starting dev server web", {
          kind: "op",
          verb: "Starting dev server",
          arg: "web",
        }),
        tz,
      ),
    ).toBe("启动开发服务器 web");
    const ready = sys("↳ dev server web: ready at localhost:5173", {
      kind: "server",
      action: "start",
      by: "banzhuan",
      name: "web",
      command: "npm run dev",
      route: "localhost:5173",
      already: false,
    });
    expect(stepDisplayBody(ready, tz)).toBe(
      "↳ 开发服务器 web · 已就绪 · localhost:5173",
    );
    const yours = sys("开拓者启动了开发服务器 web", {
      kind: "server",
      action: "start",
      by: "trailblazer",
      name: "web",
      command: "npm run dev",
      route: "localhost:5173",
      already: false,
    });
    expect(stepDisplayBody(yours, te)).toBe(
      "↳ dev server web · started by you · localhost:5173",
    );
    const reaped = sys("上次应用退出时…", {
      kind: "server",
      action: "reaped",
      names: ["web", "api"],
    });
    expect(stepDisplayBody(reaped, te)).toBe(
      "↳ Dev servers left running at the last exit were stopped: web, api",
    );
  });
});
