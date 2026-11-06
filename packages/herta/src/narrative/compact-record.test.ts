import type {
  AgentEvent,
  SystemBlock,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import { projectBackendEvent } from "./backend-record-projection.js";
import {
  buildCompactionBody,
  compactRecordForPrompt,
  decideAttachmentFolds,
  digestSystemBlock,
  foldAttachments,
} from "./compact-record.js";
import { serializeTerminalRecord } from "./serialize.js";

describe("digestSystemBlock — 差分协处理器 entries", () => {
  it('renders Reading {"path":"X"} as \'Reading X\'', () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: 'Reading {"path":"foo.ts"}',
    };
    expect(digestSystemBlock(block)).toBe("Reading foo.ts");
  });

  it("renders Reading with extra fields as 'Reading X'", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: 'Reading {"path":"src","recursive":false,"maxEntries":30}',
    };
    expect(digestSystemBlock(block)).toBe("Reading src");
  });

  it('renders Writing {"path":"X"} as \'Writing X\'', () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: 'Writing {"path":"scripts/merge-sort.js"}',
    };
    expect(digestSystemBlock(block)).toBe("Writing scripts/merge-sort.js");
  });

  it("renders Running {\"argv\":[...]} as 'Running `joined`'", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: 'Running {"argv":["pnpm","test","--silent"]}',
    };
    expect(digestSystemBlock(block)).toBe("Running `pnpm test --silent`");
  });

  it("a THOUGHT after the done-marker does not count as the spoken verdict (audit 2026-07-24, 1.10)", () => {
    // The mood-routed path commits a （我 想）right after the dispatch's
    // done-marker; treating that as "verdict spoken" folded the marker away
    // and stripped its evidence roll-up from the very prompt that generates
    // the synthesis speech.
    const marker: TerminalRecordBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "完成 · 1 个文件",
      role: "done-marker",
      evidenceDetail: "↳ 改动文件: a.ts\n↳ 待办: 补测试",
    };
    const withThought: TerminalRecord = [
      { kind: "user", text: "改一下" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      { kind: "system", label: "差分协处理器", body: "Writing a.ts" },
      marker,
      { kind: "herta", surface: "thought", text: "（我 想）看着还行。" },
    ];
    const out = compactRecordForPrompt(withThought);
    const kept = out.find(
      (b) =>
        b.kind === "system" && (b as { role?: string }).role === "done-marker",
    );
    expect(kept).toBeDefined();
    expect((kept as { evidenceDetail?: string }).evidenceDetail).toContain(
      "改动文件: a.ts",
    );
    // …while a SPEECH after it still folds the marker away (State 2).
    const withSpeech: TerminalRecord = [
      ...withThought.slice(0, 4),
      { kind: "herta", surface: "speech", text: "改完了。" },
    ];
    expect(
      compactRecordForPrompt(withSpeech).find(
        (b) =>
          b.kind === "system" &&
          (b as { role?: string }).role === "done-marker",
      ),
    ).toBeUndefined();
  });

  it("skips Planning blocks (returns null)", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: 'Planning {"op":"add","item":{"id":"x"}}',
    };
    expect(digestSystemBlock(block)).toBeNull();
  });

  it("renders bg digests as one lifecycle line; skips todo digests (2026-07-23)", () => {
    const bg: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "↳ background bg-1: running",
      digest: { kind: "bg", id: "bg-1", state: "running" },
    };
    expect(digestSystemBlock(bg)).toBe("后台命令 bg-1 在跑");
    const todo: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "todo list (2):\n[~] a\n[ ] b",
      digest: { kind: "todo", total: 2, completed: 0 },
    };
    expect(digestSystemBlock(todo)).toBeNull();
  });

  it("renders the B1 no-op marker as 「板砖这次什么也没动。」 (ADR 0079)", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "无产出 — 这次没有触发任何文件、目录或命令操作。",
    };
    expect(digestSystemBlock(block)).toBe("板砖这次什么也没动。");
  });

  it("an attachment digest is the name and a plain aside, no path or sidecar (ADR 0079), in both languages", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "附件 book.pdf · PDF · 516 页 · 正文过长，未取正文 · 目录 124 条 · .herta/attachments/s1/book-ab12cd34.pdf.txt",
      digest: {
        kind: "attachment",
        name: "book.pdf",
        path: ".herta/attachments/s1/book-ab12cd34.pdf.txt",
        lines: 14603,
        chars: 318437,
        format: "pdf",
        pages: 516,
        unreadable: "too_large",
        pageMarker: "── 第 N 页 ──",
        outline: {
          path: ".herta/attachments/s1/book-ab12cd34.pdf.outline.txt",
          entries: 124,
        },
      },
    };
    // 板砖 reaches the file and its outline through its own task line.
    expect(digestSystemBlock(block)).toBe(
      "附件 book.pdf（文件过大，未取正文）",
    );
    expect(digestSystemBlock(block, "en")).toBe(
      "附件 book.pdf (file too large, no body taken)",
    );
  });

  it("a digest result keeps the sidecar by citation once its overview is gone (ADR 0043)", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "↳ digest .herta/attachments/s1/b.pdf.digest.txt · 27 chunks",
      digest: {
        kind: "digest",
        source: ".herta/attachments/s1/b.pdf.txt",
        path: ".herta/attachments/s1/b.pdf.digest.txt",
        chunks: 27,
        cached: false,
      },
      evidenceDetail: "↳ 摘要 …\nOVERVIEW-LINE",
    };
    // The document by name, not its store paths (ADR 0079); 板砖 finds the
    // sidecar through its own lines.
    expect(digestSystemBlock(block)).toBe(
      "通读了 b.pdf，共 27 段（摘要不在手边）",
    );
    expect(digestSystemBlock(block, "en")).toBe(
      "Read through b.pdf, 27 parts (summary not at hand)",
    );
  });

  it("digests a role:noop-marker block to 「板砖这次什么也没动。」", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "无产出 — 这次没有触发任何文件、目录或命令操作。",
      role: "noop-marker",
    };
    expect(digestSystemBlock(block)).toBe("板砖这次什么也没动。");
  });

  it("still digests a roleless 无产出 body (fallback for pre-role persisted records)", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "无产出 — 旧记录",
    };
    expect(digestSystemBlock(block)).toBe("板砖这次什么也没动。");
  });

  it("falls back to first non-empty line truncated to 60 chars for unknown 差分协处理器 bodies", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: 'SomeUnknownVerb {"data":"x"}',
    };
    expect(digestSystemBlock(block)).toBe('SomeUnknownVerb {"data":"x"}');
  });
});

describe("digestSystemBlock — 系统 entries", () => {
  it("skips patch preview blocks (covered by Writing)", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "patch preview: scripts/merge-sort.js\n\n```diff\n--- /dev/null\n+++ b/scripts/merge-sort.js\n+content\n```",
    };
    expect(digestSystemBlock(block)).toBeNull();
  });

  it("renders all-pass tests as 'Tests: N/N passed'", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "↳ tests: 8 passed, 0 failed",
    };
    expect(digestSystemBlock(block)).toBe("Tests: 8/8 passed");
  });

  it("renders mixed-result tests as 'Tests: N passed, M failed'", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "↳ tests: 6 passed, 2 failed",
    };
    expect(digestSystemBlock(block)).toBe("Tests: 6 passed, 2 failed");
  });

  it("renders tool failures as '<tool> failed (<code>)'", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "↳ write_new_file failed: file_exists: scripts/merge_sort.py already exists",
    };
    expect(digestSystemBlock(block)).toBe(
      "write_new_file failed (file_exists)",
    );
  });

  it("falls back to first non-empty line truncated to 60 chars for unknown 系统 bodies", () => {
    const longBody = `[文件内容：foo.ts]\n${"x".repeat(200)}`;
    const block: SystemBlock = {
      kind: "system",
      label: "系统",
      body: longBody,
    };
    expect(digestSystemBlock(block)).toBe("[文件内容：foo.ts]");
  });

  it("truncates a very long first line to 60 chars", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "x".repeat(200),
    };
    const out = digestSystemBlock(block);
    expect(out).not.toBeNull();
    expect((out ?? "").length).toBe(60);
  });
});

describe("buildCompactionBody — assemble summary block body", () => {
  it("wraps a single non-skipped digest in the [历史已压缩 · 板砖] header", () => {
    const blocks: SystemBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"foo.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"foo.ts"}',
      },
    ];
    expect(buildCompactionBody(blocks)).toBe(
      "板砖之前做过的事（细节不在手边）：\n- Reading foo.ts\n- Writing foo.ts",
    );
  });

  it("coalesces consecutive Reading entries into one comma-joined bullet", () => {
    const blocks: SystemBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"b.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"c.ts"}',
      },
    ];
    expect(buildCompactionBody(blocks)).toBe(
      "板砖之前做过的事（细节不在手边）：\n- Reading a.ts, b.ts, c.ts",
    );
  });

  it("coalesces consecutive Writing entries similarly", () => {
    const blocks: SystemBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"b.ts"}',
      },
    ];
    expect(buildCompactionBody(blocks)).toBe(
      "板砖之前做过的事（细节不在手边）：\n- Writing a.ts, b.ts",
    );
  });

  it("does NOT coalesce across verb changes", () => {
    const blocks: SystemBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"b.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"c.ts"}',
      },
    ];
    expect(buildCompactionBody(blocks)).toBe(
      "板砖之前做过的事（细节不在手边）：\n- Reading a.ts\n- Writing b.ts\n- Reading c.ts",
    );
  });

  it("skips Planning and patch preview entries silently", () => {
    const blocks: SystemBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      { kind: "system", label: "差分协处理器", body: 'Planning {"op":"add"}' },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: a.ts\n\n```diff\n+x\n```",
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
    ];
    expect(buildCompactionBody(blocks)).toBe(
      "板砖之前做过的事（细节不在手边）：\n- Reading a.ts\n- Writing a.ts",
    );
  });

  it("returns empty string when every input block hits a skip rule", () => {
    const blocks: SystemBlock[] = [
      { kind: "system", label: "差分协处理器", body: 'Planning {"op":"add"}' },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: x\n```diff\n+y\n```",
      },
    ];
    expect(buildCompactionBody(blocks)).toBe("");
  });

  it("returns empty string for an empty input list", () => {
    expect(buildCompactionBody([])).toBe("");
  });

  it("mixes Reading-coalesce with a tool-fail in the middle correctly", () => {
    const blocks: SystemBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"b.ts"}',
      },
      {
        kind: "system",
        label: "系统",
        body: "↳ write_new_file failed: file_exists: a.ts",
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"c.ts"}',
      },
    ];
    expect(buildCompactionBody(blocks)).toBe(
      "板砖之前做过的事（细节不在手边）：\n- Reading a.ts, b.ts\n- write_new_file failed (file_exists)\n- Reading c.ts",
    );
  });
});

describe("compactRecordForPrompt — walker", () => {
  it("returns an empty record for empty input", () => {
    expect(compactRecordForPrompt([])).toEqual([]);
  });

  it("returns input unchanged when there are no system blocks", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "hi" },
      { kind: "herta", surface: "speech", text: "yes." },
    ];
    expect(compactRecordForPrompt(record)).toEqual(record);
  });

  it("passes through a singleton system block (run too short to compact)", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "hi" },
      { kind: "system", label: "系统", body: "无产出 — some marker" },
      { kind: "herta", surface: "speech", text: "yes." },
    ];
    expect(compactRecordForPrompt(record)).toEqual(record);
  });

  it("compacts a run of ≥2 contiguous system blocks into one summary block", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "改一下" },
      { kind: "herta", surface: "speech", text: "@板砖" },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
      { kind: "herta", surface: "speech", text: "done." },
    ];
    const compacted = compactRecordForPrompt(record);
    expect(compacted).toHaveLength(4);
    expect(compacted[0]).toEqual(record[0]);
    expect(compacted[1]).toEqual(record[1]);
    expect(compacted[2]).toEqual({
      kind: "system",
      label: "系统",
      body: "板砖之前做过的事（细节不在手边）：\n- Reading a.ts\n- Writing a.ts",
    });
    expect(compacted[3]).toEqual(record[4]);
  });

  it("treats beat-interrupted runs as separate runs (each gets its own summary)", () => {
    // Spec §3: "When an in-turn beat fires between two system blocks
    // of the same invocation, the run gets split — the result is two
    // smaller summary blocks rather than one."
    const record: TerminalRecord = [
      { kind: "user", text: "x" },
      { kind: "herta", surface: "speech", text: "@板砖" },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"b.ts"}',
      },
      { kind: "herta", surface: "speech", text: "beat between" }, // beat splits run
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
      { kind: "system", label: "系统", body: "↳ tests: 8 passed, 0 failed" },
      { kind: "herta", surface: "speech", text: "done." },
    ];
    const compacted = compactRecordForPrompt(record);
    // Expected layout:
    //   [user, herta@板砖, summary1, beat, summary2, herta-done]
    expect(compacted).toHaveLength(6);
    expect(compacted[2]).toEqual({
      kind: "system",
      label: "系统",
      body: "板砖之前做过的事（细节不在手边）：\n- Reading a.ts, b.ts",
    });
    expect(compacted[3]).toEqual(record[4]); // the beat
    expect(compacted[4]).toEqual({
      kind: "system",
      label: "系统",
      body: "板砖之前做过的事（细节不在手边）：\n- Writing a.ts\n- Tests: 8/8 passed",
    });
  });

  it("preserves HertaBlock.selfCorrection verbatim across compactable surroundings", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "改一下" },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
      {
        kind: "herta",
        surface: "speech",
        text: "嗯，重写过的。",
        selfCorrection: "不该跟着叫瓦尔特杨叔",
      },
    ];
    const compacted = compactRecordForPrompt(record);
    expect(compacted).toHaveLength(3);
    expect(compacted[2]).toEqual({
      kind: "herta",
      surface: "speech",
      text: "嗯，重写过的。",
      selfCorrection: "不该跟着叫瓦尔特杨叔",
    });
  });

  it("passes through a skip-only run verbatim (no empty-header summary)", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "x" },
      { kind: "system", label: "差分协处理器", body: 'Planning {"op":"add"}' },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: a.ts\n```diff\n+x\n```",
      },
      { kind: "herta", surface: "speech", text: "done." },
    ];
    const compacted = compactRecordForPrompt(record);
    // The 2-block run is skip-only → buildCompactionBody returns "" →
    // we pass the original blocks through.
    expect(compacted).toEqual(record);
  });

  it("respects opts.minRunSize", () => {
    const record: TerminalRecord = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"b.ts"}',
      },
    ];
    // With minRunSize=3, a 2-block run passes through.
    expect(compactRecordForPrompt(record, { minRunSize: 3 })).toEqual(record);
    // With minRunSize=2 (default), a 2-block run compacts.
    expect(compactRecordForPrompt(record, { minRunSize: 2 })).toHaveLength(1);
  });

  it("does not mutate the input record", () => {
    const record: TerminalRecord = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
    ];
    const snapshot = JSON.parse(JSON.stringify(record));
    compactRecordForPrompt(record);
    expect(record).toEqual(snapshot);
  });
});

describe("compactRecordForPrompt — done-marker two-state lifecycle", () => {
  const doneMarker = (detail?: string): SystemBlock => ({
    kind: "system",
    label: "差分协处理器",
    body: "完成 · 1 file · tests 12/12",
    role: "done-marker",
    ...(detail ? { evidenceDetail: detail } : {}),
  });

  it("an excerpt is verbatim in its own turn and a CITATION afterwards (ADR 0027)", () => {
    const excerpt = (): TerminalRecordBlock => ({
      kind: "system",
      label: "差分协处理器",
      body: "↳ excerpt src/a.ts:120-121",
      digest: { kind: "excerpt", path: "src/a.ts", from: 120, to: 121 },
      evidenceDetail: "↳ 摘录 src/a.ts:120-121\n120\tconst x = 1;",
    });
    // The turn it happened in: the content must reach Herta, or she cannot
    // quote what the user asked to see.
    const live: TerminalRecord = [
      { kind: "user", text: "把那两行贴出来" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      excerpt(),
    ];
    const liveOut = compactRecordForPrompt(live);
    expect(
      liveOut.some(
        (b) =>
          b.kind === "system" &&
          (b as { evidenceDetail?: string }).evidenceDetail?.includes(
            "const x = 1;",
          ) === true,
      ),
    ).toBe(true);

    // Later turns: a long run folds it into the summary. The citation
    // survives (she still knows she was shown that span); the content does
    // not (it stops costing tokens every turn thereafter).
    const later: TerminalRecord = [
      { kind: "user", text: "把那两行贴出来" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      { kind: "system", label: "差分协处理器", body: "Reading src/a.ts" },
      excerpt(),
      { kind: "system", label: "差分协处理器", body: "Reading src/b.ts" },
      { kind: "herta", surface: "speech", text: "贴好了。" },
      { kind: "user", text: "下一件事" },
    ];
    const out = compactRecordForPrompt(later);
    const text = JSON.stringify(out);
    expect(text).not.toContain("const x = 1;");
    expect(text).toContain("看过 src/a.ts 第 120–121 行（原文不在手边）");
  });

  it("a search-hit row folds to its citation with the lines elided (2026-08-17)", () => {
    // Third member of the excerpt/attachment family: the hit list is prompt
    // -visible in its own turn and a counted citation afterwards — never a
    // bare line that invites quoting matches no longer in view.
    const hits = (): TerminalRecordBlock => ({
      kind: "system",
      label: "差分协处理器",
      body: "↳ 2 matches in 1 files",
      digest: {
        kind: "search",
        pattern: "CUDA",
        matches: 2,
        files: 1,
        truncated: false,
      },
      evidenceDetail:
        "↳ 匹配 /CUDA/:\nlog.txt:33: torch.OutOfMemoryError: CUDA out of memory\nlog.txt:40: CUDA_VISIBLE_DEVICES=0",
    });
    const live: TerminalRecord = [
      { kind: "user", text: "哪几行提到 CUDA" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      hits(),
    ];
    expect(JSON.stringify(compactRecordForPrompt(live))).toContain(
      "CUDA_VISIBLE_DEVICES=0",
    );
    const later: TerminalRecord = [
      { kind: "user", text: "哪几行提到 CUDA" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      { kind: "system", label: "差分协处理器", body: "Reading log.txt" },
      hits(),
      { kind: "system", label: "差分协处理器", body: "Reading run.sh" },
      { kind: "herta", surface: "speech", text: "两处。" },
      { kind: "user", text: "下一件事" },
    ];
    const text = JSON.stringify(compactRecordForPrompt(later));
    expect(text).not.toContain("CUDA_VISIBLE_DEVICES=0");
    expect(text).toContain("搜索 /CUDA/：1 个文件里 2 处（原文不在手边）");
  });

  it("a finding row survives compaction WHOLE — the claim is the deliverable (ADR 0039)", () => {
    const finding = (): TerminalRecordBlock => ({
      kind: "system",
      label: "差分协处理器",
      body: "↳ finding: 崩在显存超限。 — log.txt:33",
      digest: {
        kind: "finding",
        claim: "崩在显存超限。",
        cites: ["log.txt:33"],
      },
    });
    const later: TerminalRecord = [
      { kind: "user", text: "分析一下" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      { kind: "system", label: "差分协处理器", body: "Reading log.txt" },
      finding(),
      { kind: "system", label: "差分协处理器", body: "Reading run.sh" },
      { kind: "herta", surface: "speech", text: "看到了。" },
      { kind: "user", text: "下一件事" },
    ];
    const text = JSON.stringify(compactRecordForPrompt(later));
    expect(text).toContain("结论：崩在显存超限。（log.txt:33）");
  });

  it("State 1 (verdict turn): passes the done-marker through verbatim with evidenceDetail", () => {
    const record: TerminalRecord = [
      { kind: "system", label: "差分协处理器", body: "Writing a.ts" },
      { kind: "system", label: "差分协处理器", body: "↳ exit 0 · 1 lines" },
      doneMarker("↳ 输出:\nRESULT=42"),
      // no herta block after → verdict not yet spoken
    ];
    const out = compactRecordForPrompt(record);
    const marker = out.find(
      (b) =>
        b.kind === "system" && (b as { role?: string }).role === "done-marker",
    );
    expect(marker).toBeDefined();
    expect((marker as { evidenceDetail?: string }).evidenceDetail).toContain(
      "RESULT=42",
    );
    // The non-marker system blocks compacted into a summary before it.
    const summary = out.find(
      (b) =>
        b.kind === "system" &&
        (b as { body: string }).body.includes("板砖之前做过的事"),
    );
    expect(summary).toBeDefined();
  });

  it("State 2 (verdict spoken): drops the done-marker's evidenceDetail, folds body in", () => {
    const record: TerminalRecord = [
      { kind: "system", label: "差分协处理器", body: "Writing a.ts" },
      doneMarker("↳ 输出:\nRESULT=42"),
      { kind: "herta", surface: "speech", text: "板砖搞定了。" }, // verdict spoken
    ];
    const out = compactRecordForPrompt(record);
    // No surviving block carries evidenceDetail (the roll-up was dropped).
    const survivingDetail = out.find(
      (b) =>
        b.kind === "system" &&
        (b as { evidenceDetail?: string }).evidenceDetail !== undefined,
    );
    expect(survivingDetail).toBeUndefined();
    // The herta block is preserved.
    expect(out.some((b) => b.kind === "herta")).toBe(true);
  });

  it("a run with no done-marker compacts exactly as before (regression)", () => {
    const record: TerminalRecord = [
      { kind: "system", label: "差分协处理器", body: "Reading a.ts" },
      { kind: "system", label: "差分协处理器", body: "Reading b.ts" },
    ];
    const out = compactRecordForPrompt(record);
    expect(out).toHaveLength(1);
    expect((out[0] as { body: string }).body).toContain("板砖之前做过的事");
  });

  it("State 1: does not drop system blocks that follow the pass-through done-marker", () => {
    // done-marker not last in its run (no herta after → State 1). The trailing
    // system block must survive (regression guard for the i=j drop bug).
    const record: TerminalRecord = [
      { kind: "system", label: "差分协处理器", body: "Reading a.ts" },
      doneMarker("↳ 输出:\nRESULT=1"),
      { kind: "system", label: "差分协处理器", body: "Writing b.ts" },
    ];
    const out = compactRecordForPrompt(record);
    // The done-marker passes through verbatim with its detail.
    const marker = out.find(
      (b) =>
        b.kind === "system" && (b as { role?: string }).role === "done-marker",
    );
    expect(marker).toBeDefined();
    expect((marker as { evidenceDetail?: string }).evidenceDetail).toContain(
      "RESULT=1",
    );
    // The trailing "Writing b.ts" content is NOT lost (verbatim, since it's a
    // lone run of 1 < minRunSize, OR folded if you change minRunSize — assert
    // the content survives somewhere in the output).
    const survives = out.some(
      (b) =>
        b.kind === "system" && (b as { body: string }).body.includes("b.ts"),
    );
    expect(survives).toBe(true);
  });

  it("State 1: re-collapses a multi-block suffix after the pass-through done-marker", () => {
    const record: TerminalRecord = [
      doneMarker("↳ 输出:\nR=0"),
      { kind: "system", label: "差分协处理器", body: "Reading x.ts" },
      { kind: "system", label: "差分协处理器", body: "Reading y.ts" },
    ];
    const out = compactRecordForPrompt(record);
    // done-marker first (verbatim), then the two Readings collapse to a summary.
    expect(out[0]?.kind).toBe("system");
    expect((out[0] as { role?: string }).role).toBe("done-marker");
    const summary = out.find(
      (b) =>
        b.kind === "system" &&
        (b as { body: string }).body.includes("板砖之前做过的事"),
    );
    expect(summary).toBeDefined();
    // Both x.ts and y.ts survive (in the summary).
    expect((summary as { body: string }).body).toContain("x.ts");
    expect((summary as { body: string }).body).toContain("y.ts");
  });
});

describe("digestSystemBlock — structured digest field (M-projection-3)", () => {
  // Blocks written since 2026-07-04 carry `digest` data; the body-regex
  // path above survives only for pre-digest persisted records.

  it("op rows are steps: no folded line of their own — the summary says what came of them (ADR 0079)", () => {
    const base = { kind: "system" as const, label: "差分协处理器" as const };
    expect(
      digestSystemBlock({
        ...base,
        body: "Reading src/foo.ts",
        digest: { kind: "op", verb: "Reading", arg: "src/foo.ts" },
      }),
    ).toBeNull();
    expect(
      digestSystemBlock({
        ...base,
        body: "Running pnpm test",
        digest: { kind: "op", verb: "Running", arg: "pnpm test" },
      }),
    ).toBeNull();
    expect(
      digestSystemBlock({
        ...base,
        body: "Planning add step",
        digest: { kind: "op", verb: "Planning", arg: "add step" },
      }),
    ).toBeNull();
  });

  it("digest takes precedence over a body the legacy regexes would misread", () => {
    // Human-form bodies (summarizeInput, 2026-06) never matched the
    // legacy JSON patterns — with the digest present the body is not
    // parsed at all.
    const out = digestSystemBlock({
      kind: "system",
      label: "差分协处理器",
      body: "Writing scripts/merge_sort.py",
      digest: { kind: "op", verb: "Writing", arg: "scripts/merge_sort.py" },
    });
    // The legacy fallback would have kept the body's first line; the digest
    // says it is a step, which folds to nothing (ADR 0079).
    expect(out).toBeNull();
  });

  it("renders tests digests from status + summary (both labels' legacy paths never matched real bodies)", () => {
    expect(
      digestSystemBlock({
        kind: "system",
        label: "差分协处理器",
        body: "↳ tests: exit 0, 3.21s",
        digest: { kind: "tests", status: "passed", summary: "exit 0, 3.21s" },
      }),
    ).toBe("测试通过");
    expect(
      digestSystemBlock({
        kind: "system",
        label: "差分协处理器",
        body: "↳ tests: exit 1, 5.02s",
        digest: { kind: "tests", status: "failed", summary: "exit 1, 5.02s" },
      }),
    ).toBe("测试没过");
  });

  it("renders tool-fail digests and skip digests", () => {
    expect(
      digestSystemBlock({
        kind: "system",
        label: "系统",
        body: "↳ edit_file failed: stale_read: file changed",
        digest: { kind: "tool-fail", tool: "edit_file", code: "stale_read" },
      }),
    ).toBe("这一步没成（edit_file）：文件读过之后又被改了");
    expect(
      digestSystemBlock({
        kind: "system",
        label: "系统",
        body: "patch preview: x.ts\n```diff\n+1\n```",
        digest: { kind: "skip" },
      }),
    ).toBeNull();
  });

  it("text digests fall back to the first line, truncated to 60 chars", () => {
    const long = `${"x".repeat(80)}\nsecond line`;
    const out = digestSystemBlock({
      kind: "system",
      label: "差分协处理器",
      body: long,
      digest: { kind: "text", text: long },
    });
    // The cut is marked and still fits the 60-char budget.
    expect(out).toBe(`${"x".repeat(59)}…`);
    expect((out ?? "").length).toBe(60);
  });

  it("does not mark a first line that fit", () => {
    const out = digestSystemBlock({
      kind: "system",
      label: "差分协处理器",
      body: "x".repeat(60),
      digest: { kind: "text", text: "x".repeat(60) },
    });
    expect(out).toBe("x".repeat(60));
  });

  it("a run that only looked around folds to its steps, a kind's consecutive ones on one line (ADR 0079)", () => {
    const body = buildCompactionBody([
      {
        kind: "system",
        label: "差分协处理器",
        body: "Reading a.ts",
        digest: { kind: "op", verb: "Reading", arg: "a.ts" },
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: "Reading b.ts",
        digest: { kind: "op", verb: "Reading", arg: "b.ts" },
      },
    ]);
    expect(body).toContain("- 读 a.ts、b.ts");
  });

  it("a block WITHOUT digest still digests via the legacy body path (pre-digest records)", () => {
    expect(
      digestSystemBlock({
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"old.ts"}',
      }),
    ).toBe("Reading old.ts");
  });
});

describe("compaction markers — session language", () => {
  const excerpt: SystemBlock = {
    kind: "system",
    label: "差分协处理器",
    body: "↳ excerpt src/a.ts:120-140",
    digest: { kind: "excerpt", path: "src/a.ts", from: 120, to: 140 },
    evidenceDetail: "↳ 摘录 src/a.ts:120-140\n120\tconst x = 1;",
  };
  const noop: SystemBlock = {
    kind: "system",
    label: "差分协处理器",
    body: "无产出 — 这次没有触发任何文件、目录或命令操作。",
    role: "noop-marker",
  };

  it("defaults to zh so an unlabelled call is unchanged for CN sessions", () => {
    expect(digestSystemBlock(excerpt)).toBe(digestSystemBlock(excerpt, "zh"));
    expect(buildCompactionBody([excerpt, noop])).toBe(
      buildCompactionBody([excerpt, noop], "zh"),
    );
  });

  it("localizes the header, the no-output marker and the excerpt elision", () => {
    const zh = buildCompactionBody([excerpt, noop], "zh");
    const en = buildCompactionBody([excerpt, noop], "en");
    expect(zh).toBe(
      "板砖之前做过的事（细节不在手边）：\n- 看过 src/a.ts 第 120–140 行（原文不在手边）\n- 板砖这次什么也没动。",
    );
    expect(en).toBe(
      "What 板砖 did before (details not at hand):\n- Was shown src/a.ts lines 120–140 (not at hand)\n- 板砖 did nothing this time.",
    );
  });

  it("keeps the operation verbs canonical in both languages", () => {
    // Only harness prose localizes. `Reading` / `Writing` / `Running` echo
    // the record body verbatim and must read the same in every session, or
    // the summary stops matching the blocks it summarizes.
    const ops: SystemBlock[] = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"b.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Running {"argv":["npm","test"]}',
      },
    ];
    const bullets = (lang: "zh" | "en") =>
      buildCompactionBody(ops, lang).split("\n").slice(1).join("\n");
    expect(bullets("en")).toBe(bullets("zh"));
    expect(bullets("zh")).toContain("Reading a.ts");
  });

  it("threads lang from compactRecordForPrompt into the summary block", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "show me those lines" },
      { kind: "herta", surface: "speech", text: "@板砖 go." },
      { kind: "system", label: "差分协处理器", body: "Reading src/a.ts" },
      excerpt,
      { kind: "herta", surface: "speech", text: "there." },
    ];
    const en = JSON.stringify(compactRecordForPrompt(record, { lang: "en" }));
    expect(en).toContain("What 板砖 did before (details not at hand):");
    expect(en).toContain("(not at hand)");
    // The content itself is gone either way — the note describes a real loss.
    expect(en).not.toContain("const x = 1;");
  });
});

describe("stranded evidenceDetail — the run-of-one hole (self-review 2026-08-11)", () => {
  // The run-compaction only reaches a block's detail inside a run of ≥2. A
  // block that lands ALONE passed through with its detail in EVERY later
  // prompt — and the bridge produces exactly that whenever a beat fires next
  // to the block. ADR 0033 §1 closed this for attachments and asserted
  // show_excerpt "always sits inside a dispatch's run"; the beat makes that
  // false, so ADR 0027's two-state lane was silently broken for excerpts and
  // command tails.
  const excerpt: SystemBlock = {
    kind: "system",
    label: "差分协处理器",
    body: "↳ excerpt src/a.ts:120-140",
    evidenceDetail: "↳ 摘录 src/a.ts:120-140\n120\tconst LEAKED = 1;",
    digest: { kind: "excerpt", path: "src/a.ts", from: 120, to: 140 },
  };

  it("a stranded excerpt drops its detail once she has spoken; the citation stays", () => {
    const out = compactRecordForPrompt([
      { kind: "user", text: "看一下" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      excerpt, // alone: a beat on either side
      { kind: "herta", surface: "speech", text: "看到了。" },
      { kind: "user", text: "然后" },
    ]);
    const kept = out.find(
      (b) => b.kind === "system" && b.body.includes("excerpt"),
    );
    expect(kept).toBeDefined();
    expect(kept?.kind === "system" && kept.evidenceDetail).toBeUndefined();
    // The citation stays AND says the body went (R-2 probe, 2026-08-12).
    // Dropping it silently left a row that read as the whole of what the
    // block ever said, so a later turn quoted figures from a span no longer
    // in front of her with nothing in the record to contradict it.
    expect(kept?.kind === "system" && kept.body).toBe(
      `${excerpt.body} · 正文已略去`,
    );
    expect(JSON.stringify(out)).not.toContain("LEAKED");
  });

  it("State 1 is untouched — no speech since means she is still reading it", () => {
    const out = compactRecordForPrompt([
      { kind: "user", text: "看一下" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      excerpt,
      { kind: "herta", surface: "thought", text: "（我 想）扫一眼。" },
    ]);
    expect(JSON.stringify(out)).toContain("LEAKED");
  });

  it("the real bridge shape: beat before the done-marker strands its roll-up", () => {
    const out = compactRecordForPrompt([
      { kind: "user", text: "改一下" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "系统",
        body: "patch preview: a.ts\n\n```diff\n+x\n```",
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
      { kind: "herta", surface: "speech", text: "diff 干净。" }, // BeatPolicy
      {
        kind: "system",
        label: "差分协处理器",
        body: "完成 · 1 个文件",
        role: "done-marker",
        evidenceDetail: "↳ 改动文件: a.ts\n↳ 待办: STRANDED-TODO",
      },
      { kind: "herta", surface: "speech", text: "改完了。" },
      { kind: "user", text: "然后呢" },
    ]);
    expect(JSON.stringify(out)).not.toContain("STRANDED-TODO");
    // The citation survives, and so does the diff hint on the same block.
    const marker = out.find(
      (b) => b.kind === "system" && b.body.includes("完成 · 1 个文件"),
    );
    expect(marker?.kind === "system" && marker.body).toContain(
      "（改动的 diff 不在手边）",
    );
  });

  it("the State-1 pass-through done-marker still keeps its roll-up", () => {
    // The verdict turn: the marker is emitted OUTSIDE the pass-through branch
    // precisely so its evidence reaches the prompt that writes the verdict.
    const out = compactRecordForPrompt([
      { kind: "user", text: "改一下" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
      { kind: "herta", surface: "speech", text: "diff 干净。" },
      {
        kind: "system",
        label: "差分协处理器",
        body: "完成 · 1 个文件",
        role: "done-marker",
        evidenceDetail: "↳ 改动文件: a.ts\n↳ 待办: KEEP-THIS",
      },
    ]);
    expect(JSON.stringify(out)).toContain("KEEP-THIS");
  });
});

describe("done-marker diff re-read hint (E2E 2026-08-11)", () => {
  // Patch previews are prompt-skipped once their run compacts, so "which
  // lines changed?" one turn after a dispatch found nothing to quote and got
  // invented detail — which then fossilized into recap and dream. For a few
  // turns after the newest FOLDED marker, the summary says the diff is
  // re-readable; then the nudge expires.
  const dispatch = (marker: string): TerminalRecordBlock[] => [
    { kind: "system", label: "差分协处理器", body: 'Reading {"path":"a.ts"}' },
    { kind: "system", label: "差分协处理器", body: 'Writing {"path":"a.ts"}' },
    {
      kind: "system",
      label: "差分协处理器",
      body: marker,
      role: "done-marker",
      evidenceDetail: "↳ 改动文件: a.ts",
    },
  ];

  it("the verdict turn (State 1) carries the verbatim roll-up, no hint", () => {
    const out = compactRecordForPrompt([
      { kind: "user", text: "修一下" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      ...dispatch("完成 · 1 个文件"),
    ]);
    expect(JSON.stringify(out)).not.toContain("git diff");
  });

  it("a follow-up turn after the verdict sees the hint on the compacted summary", () => {
    const out = compactRecordForPrompt([
      { kind: "user", text: "修一下" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      ...dispatch("完成 · 1 个文件"),
      { kind: "herta", surface: "speech", text: "修完了。" },
      { kind: "user", text: "改了哪几行？" },
    ]);
    const summary = out.find(
      (b) => b.kind === "system" && b.body.includes("板砖之前做过的事"),
    );
    expect(summary?.kind === "system" && summary.body).toContain(
      "（改动的 diff 不在手边）",
    );
  });

  it("the hint expires after the window; the summary stays", () => {
    const out = compactRecordForPrompt([
      { kind: "user", text: "修一下" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      ...dispatch("完成 · 1 个文件"),
      { kind: "herta", surface: "speech", text: "修完了。" },
      { kind: "user", text: "改了哪几行？" },
      { kind: "herta", surface: "speech", text: "一行。" },
      { kind: "user", text: "哦" },
      { kind: "herta", surface: "speech", text: "。" },
      { kind: "user", text: "嗯" },
      { kind: "herta", surface: "speech", text: "。" },
      { kind: "user", text: "换个话题" },
    ]);
    const s = JSON.stringify(out);
    expect(s).toContain("板砖之前做过的事");
    expect(s).not.toContain("git diff");
  });

  it("only the NEWEST folded marker hints — an older dispatch stays quiet", () => {
    const out = compactRecordForPrompt([
      { kind: "user", text: "修 a" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      ...dispatch("完成 · 1 个文件"),
      { kind: "herta", surface: "speech", text: "修完了。" },
      { kind: "user", text: "再修 b" },
      { kind: "herta", surface: "speech", text: "@板砖 去。" },
      ...dispatch("完成 · 2 个文件"),
      { kind: "herta", surface: "speech", text: "也修完了。" },
      { kind: "user", text: "b 改了哪几行？" },
    ]);
    const hinted = out.filter(
      (b) => b.kind === "system" && b.body.includes("（改动的 diff 不在手边）"),
    );
    expect(hinted).toHaveLength(1);
    expect(hinted[0]?.kind === "system" && hinted[0].body).toContain(
      "2 个文件",
    );
  });

  it("localizes by session language", () => {
    const out = compactRecordForPrompt(
      [
        { kind: "user", text: "fix it" },
        { kind: "herta", surface: "speech", text: "@板砖 go." },
        ...dispatch("完成 · 1 个文件"),
        { kind: "herta", surface: "speech", text: "done." },
        { kind: "user", text: "which lines changed?" },
      ],
      { lang: "en" },
    );
    expect(JSON.stringify(out)).toContain("(the diff isn't at hand)");
  });
});

describe("decideAttachmentFolds / foldAttachments — the fold lane on its own (ADR 0033 §6g amendment, 2026-09-22)", () => {
  // The beat projection renders the record in two pieces and needs the
  // attachment decision made over the WHOLE record first (serialize.ts).
  // These pin the seam: the pre-decided folds are what compactRecordForPrompt
  // would have decided itself, and foldAttachments applies that lane alone.
  const attachment: SystemBlock = {
    kind: "system",
    label: "系统",
    body: "附件 spec.md · 120 行 · 4.8K 字 · .herta/attachments/s1/spec.md",
    evidenceDetail: "↳ 附件 spec.md\n# Spec\nCONFIDENTIAL-HEAD-LINE",
    digest: {
      kind: "attachment",
      name: "spec.md",
      path: ".herta/attachments/s1/spec.md",
      lines: 120,
      chars: 4800,
    },
  };
  const readA: SystemBlock = {
    kind: "system",
    label: "差分协处理器",
    body: 'Reading {"path":"a.ts"}',
  };
  const readB: SystemBlock = {
    kind: "system",
    label: "差分协处理器",
    body: 'Reading {"path":"b.ts"}',
  };
  const record: TerminalRecord = [
    attachment,
    { kind: "user", text: "看看这份" },
    { kind: "herta", surface: "speech", text: "看完了。" },
    { kind: "user", text: "聊点别的" },
    { kind: "herta", surface: "speech", text: "行。" },
    { kind: "user", text: "改一下 a.ts @板砖" },
    { kind: "herta", surface: "speech", text: "@板砖，处理 a.ts。" },
    readA,
    readB,
  ];

  it("messages during a run and steers are not turns: the commission's document stays (review 2026-11-05, H7)", () => {
    const talk = (text: string): TerminalRecord[number] => ({
      kind: "user",
      text,
      duringRun: true,
    });
    const said = (text: string): TerminalRecord[number] => ({
      kind: "herta",
      surface: "speech",
      text,
      duringRun: true,
    });
    const midRun: TerminalRecord = [
      attachment,
      { kind: "user", text: "照这份改 @板砖" },
      { kind: "herta", surface: "speech", text: "@板砖，照它改。" },
      readA,
      talk("顺便问一句"),
      said("嗯。"),
      talk("还有"),
      said("说。"),
      { kind: "user", text: "先别动 b.ts", steer: true },
      talk("好了吗"),
      said("快了。"),
    ];
    expect(decideAttachmentFolds(midRun).get(attachment)).toBe("verbatim");
    // Three turns after it still fold it, with talk among them or not.
    const later: TerminalRecord = [
      ...midRun,
      { kind: "user", text: "聊点别的" },
      { kind: "herta", surface: "speech", text: "行。" },
      { kind: "user", text: "再聊点别的" },
      { kind: "herta", surface: "speech", text: "行。" },
    ];
    expect(decideAttachmentFolds(later).get(attachment)).toBe("citation-hint");
  });

  it("a message during a run that names the file keeps it, as any message does", () => {
    const named: TerminalRecord = [
      attachment,
      { kind: "user", text: "一" },
      { kind: "herta", surface: "speech", text: "嗯。" },
      { kind: "user", text: "二" },
      { kind: "herta", surface: "speech", text: "嗯。" },
      { kind: "user", text: "三" },
      { kind: "herta", surface: "speech", text: "嗯。" },
      { kind: "user", text: "spec.md 第二节呢", duringRun: true },
      { kind: "herta", surface: "speech", text: "看着。", duringRun: true },
    ];
    expect(decideAttachmentFolds(named).get(attachment)).toBe("verbatim");
  });

  it("the pre-decided folds are compactRecordForPrompt's own decision", () => {
    const folds = decideAttachmentFolds(record);
    expect(folds.size).toBe(1);
    expect(folds.get(attachment)).toBe("citation-hint");
    expect(compactRecordForPrompt(record, { attachmentFolds: folds })).toEqual(
      compactRecordForPrompt(record),
    );
  });

  it("foldAttachments applies the attachment lane and nothing else", () => {
    const out = foldAttachments(record, decideAttachmentFolds(record));
    expect(out).toHaveLength(record.length);
    const folded = out[0];
    expect(folded?.kind === "system" ? folded.evidenceDetail : "?").toBe(
      undefined,
    );
    expect(folded?.kind === "system" ? folded.body : "").toContain(
      "读过，原文不在手边",
    );
    // The system run beside it is neither compacted nor touched: the same
    // block objects come back, uncompacted.
    expect(out[7]).toBe(readA);
    expect(out[8]).toBe(readB);
    expect(JSON.stringify(out)).not.toContain("[历史已压缩");
  });

  it("a block nobody decided is read fresh: its name, then its text (ADR 0079)", () => {
    const out = foldAttachments([attachment], new Map());
    const fresh = out[0];
    expect(fresh?.kind === "system" ? fresh.body : "").toBe("附件 spec.md");
    expect(fresh?.kind === "system" ? fresh.evidenceDetail : "").toBe(
      "# Spec\nCONFIDENTIAL-HEAD-LINE",
    );
  });
});

describe("an attachment as Herta reads it (ADR 0079, owner 2026-10-16)", () => {
  // The row as the ingest writes it: bookkeeping in the body, the head and
  // the outline preview in `evidence`. What she reads is the name, the
  // document's text and its outline — every picture its transcript where
  // one was made, a plain （图） where none was.
  const pdf: SystemBlock = {
    kind: "system",
    label: "系统",
    body: "附件 hw3.pdf · PDF · 2 页 · 已提取文本 · 11 行 · 423 字 · 目录 2 条 · .herta/attachments/s1/hw3-02738c2d.pdf.txt",
    evidenceDetail:
      "↳ 附件 hw3.pdf\n(the stored detail, superseded by evidence)",
    evidence: [
      {
        kind: "attachment",
        name: "hw3.pdf",
        path: ".herta/attachments/s1/hw3-02738c2d.pdf.txt",
        text: [
          "── 第 1 页 ──",
          "Question 1. Let A be the matrix below.",
          "[图 1-1 · .herta/attachments/s1/hw3-02738c2d.pdf.p1-1.png] 自动转写：A=\\begin{bmatrix}2&1\\\\1&2\\end{bmatrix}",
          "(a) Compute det(A).",
          "[图 1-2 · .herta/attachments/s1/hw3-02738c2d.pdf.p1-2.png]（未转写，可用 view_image 查看原图）",
          "[图 1-3：未能保存]",
          "(b) Find the eigenvalues of A.",
        ].join("\n"),
        clipped: true,
      },
      {
        kind: "outline",
        name: "hw3.pdf",
        path: ".herta/attachments/s1/hw3-02738c2d.pdf.outline.txt",
        items: ["Question 1 · 第 1 页", "Question 2 · 第 2 页"],
        total: 5,
      },
    ],
    digest: {
      kind: "attachment",
      name: "hw3.pdf",
      path: ".herta/attachments/s1/hw3-02738c2d.pdf.txt",
      lines: 11,
      chars: 423,
      format: "pdf",
      pages: 2,
      outline: {
        path: ".herta/attachments/s1/hw3-02738c2d.pdf.outline.txt",
        entries: 5,
      },
    },
  };
  const read = (lang: "zh" | "en"): SystemBlock => {
    const out = foldAttachments([pdf], new Map(), lang)[0];
    if (out?.kind !== "system") throw new Error("not a system block");
    return out;
  };

  it("fresh: the name, the text with each picture its transcript or （图）, and the outline", () => {
    const fresh = read("zh");
    expect(fresh.body).toBe("附件 hw3.pdf");
    expect(fresh.evidenceDetail).toBe(
      [
        "── 第 1 页 ──",
        "Question 1. Let A be the matrix below.",
        "A=\\begin{bmatrix}2&1\\\\1&2\\end{bmatrix}",
        "(a) Compute det(A).",
        "（图）",
        "（图）",
        "(b) Find the eigenvalues of A.",
        "（仅开头部分，正文更长）",
        "目录（共 5 条，这里是前 2 条）：",
        "Question 1 · 第 1 页",
        "Question 2 · 第 2 页",
      ].join("\n"),
    );
    // None of the store's bookkeeping reaches her.
    const all = `${fresh.body}\n${fresh.evidenceDetail}`;
    for (const gone of [
      ".herta/",
      "423 字",
      "11 行",
      "已提取文本",
      "自动转写",
      "view_image",
      "↳",
    ]) {
      expect(all).not.toContain(gone);
    }
  });

  it("an EN session reads the notes and the picture mark in English; 附件 stays the record's word", () => {
    const fresh = read("en");
    expect(fresh.body).toBe("附件 hw3.pdf");
    expect(fresh.evidenceDetail).toContain("(figure)");
    expect(fresh.evidenceDetail).toContain(
      "(only the opening; the document runs longer)",
    );
    expect(fresh.evidenceDetail).toContain(
      "Contents (5 entries, the first 2 shown):",
    );
  });

  it("folded, a document she saw only the opening of says so — 「读过」 alone would claim more", () => {
    const out = compactRecordForPrompt([
      pdf,
      { kind: "user", text: "看看" },
      { kind: "herta", surface: "speech", text: "看了。" },
      { kind: "user", text: "嗯" },
      { kind: "herta", surface: "speech", text: "。" },
      { kind: "user", text: "换个话题" },
    ]);
    const folded = out.find((b) => b.kind === "system");
    expect(folded?.kind === "system" ? folded.body : "").toBe(
      "附件 hw3.pdf（读过开头，原文不在手边）",
    );
    expect(digestSystemBlock(pdf, "en")).toBe(
      "附件 hw3.pdf (read the opening; the original isn't at hand)",
    );
  });

  it("a document too long to take keeps its outline preview while fresh, and says why in every state", () => {
    const book: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "附件 book.pdf · PDF · 516 页 · 文件过大，未取正文 · 目录 124 条 · .herta/attachments/s1/book.pdf.txt",
      evidence: [
        {
          kind: "outline",
          name: "book.pdf",
          path: ".herta/attachments/s1/book.pdf.outline.txt",
          items: ["第一章 · 第 1 页"],
          total: 124,
        },
      ],
      digest: {
        kind: "attachment",
        name: "book.pdf",
        path: ".herta/attachments/s1/book.pdf.txt",
        lines: 14603,
        chars: 318437,
        format: "pdf",
        pages: 516,
        unreadable: "too_large",
      },
    };
    const fresh = foldAttachments([book], new Map())[0];
    expect(fresh?.kind === "system" ? fresh.body : "").toBe(
      "附件 book.pdf（文件过大，未取正文）",
    );
    expect(fresh?.kind === "system" ? fresh.evidenceDetail : "").toBe(
      "目录（共 124 条，这里是前 1 条）：\n第一章 · 第 1 页",
    );
    const folded = foldAttachments(
      [book],
      new Map([[book, "citation" as const]]),
    )[0];
    expect(folded?.kind === "system" ? folded.body : "").toBe(
      "附件 book.pdf（文件过大，未取正文）",
    );
    expect(
      folded?.kind === "system" ? folded.evidenceDetail : "",
    ).toBeUndefined();
  });

  it("a picture's line is projected only in a PDF's text — a text file keeps its own lines", () => {
    const md: SystemBlock = {
      ...pdf,
      evidence: [
        {
          kind: "attachment",
          name: "notes.md",
          path: ".herta/attachments/s1/notes.md",
          text: "[图 1-1 · a note the user wrote this way]",
          clipped: false,
        },
      ],
      digest: {
        kind: "attachment",
        name: "notes.md",
        path: ".herta/attachments/s1/notes.md",
        lines: 1,
        chars: 40,
      },
    };
    const out = foldAttachments([md], new Map())[0];
    expect(out?.kind === "system" ? out.evidenceDetail : "").toBe(
      "[图 1-1 · a note the user wrote this way]",
    );
  });
});

describe("attachment blocks — per-block two-state fold (ADR 0033)", () => {
  // The run-compaction above never reaches these: an attachment block sits
  // ALONE between a herta block and the user's next message, and a run of one
  // passes through verbatim. Without the per-block fold, the document's head
  // would ride evidenceDetail into every subsequent prompt of the session.
  const attachment: SystemBlock = {
    kind: "system",
    label: "系统",
    body: "附件 spec.md · 120 行 · 4.8K 字 · .herta/attachments/s1/spec.md",
    evidenceDetail: "↳ 附件 spec.md\n# Spec\nCONFIDENTIAL-HEAD-LINE",
    digest: {
      kind: "attachment",
      name: "spec.md",
      path: ".herta/attachments/s1/spec.md",
      lines: 120,
      chars: 4800,
    },
  };

  const sys = (out: TerminalRecord): SystemBlock[] =>
    out.filter((b): b is SystemBlock => b.kind === "system");

  it("State 1 — no speech since: the head passes through verbatim", () => {
    const out = compactRecordForPrompt([
      { kind: "herta", surface: "speech", text: "嗯？" },
      attachment,
      { kind: "user", text: "看看这份" },
    ]);
    const kept = sys(out)[0];
    expect(kept?.evidenceDetail).toContain("CONFIDENTIAL-HEAD-LINE");
    expect(kept?.body).toBe("附件 spec.md");
  });

  it("State 1 spans the drop turn plus two follow-ups; the third folds it (§6g window)", () => {
    // The one-speech key punished the conversation that STAYED on the
    // document: the first follow-up already found the head gone, and Herta's
    // honest paths were a 板砖 re-read or answering from her own commentary —
    // the confabulation hazard the fold exists to prevent (owner 2026-08-11).
    const withinWindow = compactRecordForPrompt([
      attachment,
      { kind: "user", text: "看看这份" },
      { kind: "herta", surface: "speech", text: "看完了，一般。" },
      { kind: "user", text: "第三章呢？" },
    ]);
    // Two user turns since the block — she can still read the head while
    // answering the follow-up.
    expect(sys(withinWindow)[0]?.evidenceDetail).toContain(
      "CONFIDENTIAL-HEAD-LINE",
    );

    const exhausted = compactRecordForPrompt([
      attachment,
      { kind: "user", text: "看看这份" },
      { kind: "herta", surface: "speech", text: "看完了，一般。" },
      { kind: "user", text: "第三章呢？" },
      { kind: "herta", surface: "speech", text: "论证太松。" },
      { kind: "user", text: "换个话题吧" },
    ]);
    const folded = sys(exhausted)[0];
    expect(folded?.evidenceDetail).toBeUndefined();
    expect(folded?.body).toContain("读过，原文不在手边");
    // She still knows what it was; where it is stays 板砖's (ADR 0079).
    expect(folded?.body).toContain("spec.md");
    expect(folded?.body).not.toContain(".herta/attachments/s1/spec.md");
    expect(JSON.stringify(exhausted)).not.toContain("CONFIDENTIAL-HEAD-LINE");
  });

  it("no speech since the block keeps it verbatim even past the window (speech lower bound)", () => {
    // Same rule as the done-marker (audit 2026-07-24, 1.10): the mood-routed
    // path commits a （我 想） before the responding speech, and that thought
    // must not strip the head from the very prompt that generates the reply —
    // however many user messages have piled up unanswered.
    const out = compactRecordForPrompt([
      attachment,
      { kind: "user", text: "看看这份" },
      { kind: "herta", surface: "thought", text: "先扫一眼。" },
      { kind: "user", text: "在吗" },
      { kind: "user", text: "？" },
      { kind: "user", text: "喂" },
    ]);
    expect(sys(out)[0]?.evidenceDetail).toContain("CONFIDENTIAL-HEAD-LINE");
  });

  it("folded, every turn reads 「读过，原文不在手边」 — the hinted turns and the later ones alike (ADR 0079)", () => {
    // The re-read hint (owner 2026-08-11) read wrong in her 自传 (owner
    // 2026-10-16); "not at hand" already says the text can be fetched.
    const exchanges = (n: number): TerminalRecordBlock[] =>
      Array.from({ length: n }, (_, k) => [
        { kind: "user", text: `第 ${k} 句` } as TerminalRecordBlock,
        {
          kind: "herta",
          surface: "speech",
          text: "嗯。",
        } as TerminalRecordBlock,
      ]).flat();

    // 3 user turns past the block — just folded, hint attached.
    const fresh = compactRecordForPrompt([attachment, ...exchanges(3)]);
    const freshBody = sys(fresh)[0]?.body ?? "";
    expect(freshBody).toBe("附件 spec.md（读过，原文不在手边）");
    expect(sys(fresh)[0]?.evidenceDetail).toBeUndefined();

    // 5 user turns — last hinted prompt.
    const lastHinted = compactRecordForPrompt([attachment, ...exchanges(5)]);
    expect(sys(lastHinted)[0]?.body).toBe(freshBody);

    // 6 user turns — the hint expires; the bare citation remains.
    const expired = compactRecordForPrompt([attachment, ...exchanges(6)]);
    const expiredBody = sys(expired)[0]?.body ?? "";
    expect(expiredBody).toBe(freshBody);
  });

  it("naming the file re-opens the window, which can expire again (§6g re-inflate)", () => {
    const base: TerminalRecord = [
      attachment,
      { kind: "user", text: "看看这份" },
      { kind: "herta", surface: "speech", text: "看完了。" },
      { kind: "user", text: "聊点别的" },
      { kind: "herta", surface: "speech", text: "行。" },
      { kind: "user", text: "今天天气不错" },
      { kind: "herta", surface: "speech", text: "嗯。" },
    ];
    // Window exhausted (3 user turns past the block, speech since) — folded.
    expect(
      sys(compactRecordForPrompt(base))[0]?.evidenceDetail,
    ).toBeUndefined();

    // A later user message naming the file (case-insensitively) moves the
    // anchor there: the head is back in front of her for the return turn…
    const returned: TerminalRecord = [
      ...base,
      { kind: "user", text: "回到 SPEC.md，第二段那个论点站得住吗" },
    ];
    expect(sys(compactRecordForPrompt(returned))[0]?.evidenceDetail).toContain(
      "CONFIDENTIAL-HEAD-LINE",
    );

    // …and the re-opened window expires the same way the first one did.
    const drifted: TerminalRecord = [
      ...returned,
      { kind: "herta", surface: "speech", text: "站不住。" },
      { kind: "user", text: "好吧" },
      { kind: "herta", surface: "speech", text: "嗯。" },
      { kind: "user", text: "午饭吃什么" },
      { kind: "herta", surface: "speech", text: "随你。" },
      { kind: "user", text: "走了" },
    ];
    expect(
      sys(compactRecordForPrompt(drifted))[0]?.evidenceDetail,
    ).toBeUndefined();
  });

  it("a filename INSIDE another filename does not re-open the shorter one (self-review 2026-08-11)", () => {
    // The first cut matched by bare substring and claimed the extension made
    // collisions impossible. It does not: `report.md` is a suffix of
    // `final-report.md`, so naming the long file re-inflated the short one's
    // head too — a spurious 4000-char head plus the cache churn it drags.
    const short: SystemBlock = {
      ...attachment,
      body: "附件 report.md · 10 行 · 200 字 · .herta/attachments/s1/report.md",
      evidenceDetail: "↳ 附件 report.md\nSHORT-FILE-HEAD",
      digest: {
        kind: "attachment",
        name: "report.md",
        path: ".herta/attachments/s1/report.md",
        lines: 10,
        chars: 200,
      },
    };
    const long: SystemBlock = {
      ...attachment,
      body: "附件 final-report.md · 10 行 · 200 字 · .herta/attachments/s1/final-report.md",
      evidenceDetail: "↳ 附件 final-report.md\nLONG-FILE-HEAD",
      digest: {
        kind: "attachment",
        name: "final-report.md",
        path: ".herta/attachments/s1/final-report.md",
        lines: 10,
        chars: 200,
      },
    };
    const out = compactRecordForPrompt([
      short,
      long,
      { kind: "user", text: "都看看" },
      { kind: "herta", surface: "speech", text: "看了。" },
      { kind: "user", text: "嗯" },
      { kind: "herta", surface: "speech", text: "。" },
      { kind: "user", text: "好" },
      { kind: "herta", surface: "speech", text: "。" },
      { kind: "user", text: "final-report.md 第三条再说说" },
    ]);
    const s = JSON.stringify(out);
    expect(s).toContain("LONG-FILE-HEAD"); // the named file
    expect(s).not.toContain("SHORT-FILE-HEAD"); // NOT its substring neighbour
  });

  it("a name embedded in an unrelated word does not re-open its window", () => {
    const tiny: SystemBlock = {
      ...attachment,
      body: "附件 log.md · 10 行",
      evidenceDetail: "↳ 附件 log.md\nTINY-HEAD",
      digest: {
        kind: "attachment",
        name: "log.md",
        path: ".herta/attachments/s1/log.md",
        lines: 10,
        chars: 200,
      },
    };
    const tail: TerminalRecordBlock[] = [
      { kind: "user", text: "看看" },
      { kind: "herta", surface: "speech", text: "看了。" },
      { kind: "user", text: "嗯" },
      { kind: "herta", surface: "speech", text: "。" },
      { kind: "user", text: "好" },
      { kind: "herta", surface: "speech", text: "。" },
    ];
    // "catalog.md" contains "log.md" — flanked by a filename char, so no.
    const embedded = compactRecordForPrompt([
      tiny,
      ...tail,
      { kind: "user", text: "catalog.md 里写了什么" },
    ]);
    expect(JSON.stringify(embedded)).not.toContain("TINY-HEAD");
    // A real reference still lands, including with CJK hard against it
    // (Chinese has no spaces — a word-boundary rule would have broken this).
    const real = compactRecordForPrompt([
      tiny,
      ...tail,
      { kind: "user", text: "回到log.md，第二段说了什么" },
    ]);
    expect(JSON.stringify(real)).toContain("TINY-HEAD");
  });

  it("a CJK filename inside a longer SIBLING attachment's name does not re-open it (round-2 review)", () => {
    // The boundary class [A-Za-z0-9._-] carries Latin names only: 报告.md
    // inside 年度报告.md has flank 度 — not a "filename character" — so the
    // round-1 fix passed it. The class cannot grow CJK (回到报告.md is a
    // legitimate spaceless reference with the same local shape); what
    // disambiguates is the record's OWN attachment list — a match covered by
    // a longer sibling's occurrence belongs to the sibling.
    const short: SystemBlock = {
      ...attachment,
      body: "附件 报告.md · 10 行",
      evidenceDetail: "↳ 附件 报告.md\nCJK-SHORT-HEAD",
      digest: {
        kind: "attachment",
        name: "报告.md",
        path: ".herta/attachments/s1/报告.md",
        lines: 10,
        chars: 200,
      },
    };
    const long: SystemBlock = {
      ...attachment,
      body: "附件 年度报告.md · 10 行",
      evidenceDetail: "↳ 附件 年度报告.md\nCJK-LONG-HEAD",
      digest: {
        kind: "attachment",
        name: "年度报告.md",
        path: ".herta/attachments/s1/年度报告.md",
        lines: 10,
        chars: 200,
      },
    };
    const drift: TerminalRecordBlock[] = [
      { kind: "user", text: "都看看" },
      { kind: "herta", surface: "speech", text: "看了。" },
      { kind: "user", text: "嗯" },
      { kind: "herta", surface: "speech", text: "。" },
      { kind: "user", text: "好" },
      { kind: "herta", surface: "speech", text: "。" },
    ];
    const named = compactRecordForPrompt([
      short,
      long,
      ...drift,
      { kind: "user", text: "年度报告.md 第三条再说说" },
    ]);
    const s = JSON.stringify(named);
    expect(s).toContain("CJK-LONG-HEAD"); // the sibling that was named
    expect(s).not.toContain("CJK-SHORT-HEAD"); // not the name inside it

    // …while a spaceless CJK prose reference to the SHORT name still lands —
    // the sibling only covers matches at ITS OWN occurrences.
    const prose = compactRecordForPrompt([
      short,
      long,
      ...drift,
      { kind: "user", text: "回到报告.md，第二段怎么说" },
    ]);
    expect(JSON.stringify(prose)).toContain("CJK-SHORT-HEAD");
  });

  it("a reference re-opens only ITS file's window", () => {
    const second: SystemBlock = {
      ...attachment,
      body: "附件 notes.md · 10 行 · 200 字 · .herta/attachments/s1/notes.md",
      evidenceDetail: "↳ 附件 notes.md\nSECOND-HEAD-LINE",
      digest: {
        kind: "attachment",
        name: "notes.md",
        path: ".herta/attachments/s1/notes.md",
        lines: 10,
        chars: 200,
      },
    };
    const out = compactRecordForPrompt([
      attachment,
      second,
      { kind: "user", text: "都看看" },
      { kind: "herta", surface: "speech", text: "看了。" },
      { kind: "user", text: "嗯" },
      { kind: "herta", surface: "speech", text: "。" },
      { kind: "user", text: "好" },
      { kind: "herta", surface: "speech", text: "。" },
      { kind: "user", text: "notes.md 里第三条再说说" },
    ]);
    const s = JSON.stringify(out);
    expect(s).toContain("SECOND-HEAD-LINE");
    expect(s).not.toContain("CONFIDENTIAL-HEAD-LINE");
  });

  it("an unreadable attachment never gains an elision note", () => {
    // There was never a body to elide; claiming one was is exactly the
    // shown-vs-readable confusion the two-state split exists to prevent.
    const unreadable: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "附件 photo.bin · 非文本文件，未取正文",
      digest: {
        kind: "attachment",
        name: "photo.bin",
        path: ".herta/attachments/s1/photo.bin",
        lines: 0,
        chars: 0,
        unreadable: "binary",
      },
    };
    const out = compactRecordForPrompt([
      unreadable,
      { kind: "user", text: "这个呢" },
      { kind: "herta", surface: "speech", text: "读不了。" },
      { kind: "user", text: "哦" },
      { kind: "herta", surface: "speech", text: "。" },
      { kind: "user", text: "行吧" },
    ]);
    // Window exhausted AND spoken since — deep in State 2 territory, and the
    // body still must not claim an elided body that never existed.
    expect(sys(out)[0]?.body).toBe("附件 photo.bin（非文本文件，未取正文）");
  });

  // ── Images (ADR 0048) ────────────────────────────────────────────────────

  const image: SystemBlock = {
    kind: "system",
    label: "系统",
    body: "附件 shot.png · 图片 PNG · 1920×1080 · 一张终端截图，测试全部通过。 · .herta/attachments/s1/shot.png",
    digest: {
      kind: "attachment",
      name: "shot.png",
      path: ".herta/attachments/s1/shot.png",
      lines: 0,
      chars: 0,
      image: { format: "png", width: 1920, height: 1080 },
      caption: "一张终端截图，测试全部通过。",
    },
  };

  it("a folded image keeps its CAPTION, not an elision note", () => {
    // The load-bearing case for ADR 0048 §1. A document's head is an excerpt
    // of text still on disk, so eliding it loses nothing permanently. A
    // caption is the ONLY textual form the picture ever had — the actor
    // cannot re-read pixels — so if the fold dropped it, the moment would
    // vanish from the recap, the 废案 distillation, and every later session.
    const out = compactRecordForPrompt([
      image,
      { kind: "user", text: "看看这个" },
      { kind: "herta", surface: "speech", text: "看到了。" },
      { kind: "user", text: "哦" },
      { kind: "herta", surface: "speech", text: "。" },
      { kind: "user", text: "换个话题" },
    ]);
    const folded = sys(out)[0];
    // Never the document elision note: nothing was elided. A vision-capable
    // 板砖 is sent back to the picture through its own task line, which
    // keeps the path (ADR 0048 §5, ADR 0079).
    expect(folded?.body).toBe("附件 shot.png：一张终端截图，测试全部通过。");
  });

  it("an uncaptioned image says so and claims no reading", () => {
    const uncaptioned: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "附件 shot.png · 图片 PNG · 已存图片，未能读图 · .herta/attachments/s1/shot.png",
      digest: {
        kind: "attachment",
        name: "shot.png",
        path: ".herta/attachments/s1/shot.png",
        lines: 0,
        chars: 0,
        image: { format: "png" },
        unreadable: "no_caption",
      },
    };
    const out = compactRecordForPrompt([
      uncaptioned,
      { kind: "user", text: "这个呢" },
      { kind: "herta", surface: "speech", text: "没读上。" },
      { kind: "user", text: "哦" },
      { kind: "herta", surface: "speech", text: "。" },
      { kind: "user", text: "行吧" },
    ]);
    expect(sys(out)[0]?.body).toBe("附件 shot.png（图片已存，未能读图）");
  });

  it("the caption survives into an EN session's summary verbatim", () => {
    // The caption is written in the session language and is content, not
    // chrome — the compaction template localizes around it, never it.
    const out = compactRecordForPrompt(
      [
        image,
        { kind: "user", text: "look" },
        { kind: "herta", surface: "speech", text: "seen." },
        { kind: "user", text: "ok" },
        { kind: "herta", surface: "speech", text: "." },
        { kind: "user", text: "moving on" },
      ],
      { lang: "en" },
    );
    expect(sys(out)[0]?.body).toBe(
      "附件 shot.png: 一张终端截图，测试全部通过。",
    );
  });

  it("adjacent attachments never fold into a 板砖-headed summary", () => {
    // A multi-file attach is ≥2 contiguous system blocks — big enough for the
    // run-compaction, whose header names 板砖. Filing the user's own documents
    // under the coprocessor's name would be a false receipt, so attachments
    // break runs and each folds alone.
    const second: SystemBlock = {
      ...attachment,
      body: "附件 notes.md · 10 行 · 200 字 · .herta/attachments/s1/notes.md",
      evidenceDetail: "↳ 附件 notes.md\nSECOND-HEAD-LINE",
      digest: {
        kind: "attachment",
        name: "notes.md",
        path: ".herta/attachments/s1/notes.md",
        lines: 10,
        chars: 200,
      },
    };
    const out = compactRecordForPrompt([
      attachment,
      second,
      { kind: "user", text: "都看看" },
      { kind: "herta", surface: "speech", text: "看了。" },
      { kind: "user", text: "嗯" },
      { kind: "herta", surface: "speech", text: "。" },
      { kind: "user", text: "好" },
      { kind: "herta", surface: "speech", text: "。" },
    ]);
    const s = JSON.stringify(out);
    expect(s).not.toContain("板砖之前做过的事");
    expect(s).not.toContain("CONFIDENTIAL-HEAD-LINE");
    expect(s).not.toContain("SECOND-HEAD-LINE");
    expect(sys(out).map((b) => b.digest?.kind)).toEqual([
      "attachment",
      "attachment",
    ]);
  });

  it("an attachment beside a dispatch run neither joins it nor breaks its fold", () => {
    const out = compactRecordForPrompt([
      attachment,
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Writing {"path":"a.ts"}',
      },
      { kind: "user", text: "继续" },
      { kind: "herta", surface: "speech", text: "行。" },
      { kind: "user", text: "然后呢" },
      { kind: "herta", surface: "speech", text: "在做。" },
      { kind: "user", text: "好" },
    ]);
    const s = JSON.stringify(out);
    // The dispatch pair still compacts; the attachment folded on its own.
    expect(s).toContain("板砖之前做过的事");
    expect(s).not.toContain("CONFIDENTIAL-HEAD-LINE");
    expect(s).toContain("读过，原文不在手边");
  });

  it("localizes the elision note by session language", () => {
    const out = compactRecordForPrompt(
      [
        attachment,
        { kind: "user", text: "read it" },
        { kind: "herta", surface: "speech", text: "done." },
        { kind: "user", text: "ok" },
        { kind: "herta", surface: "speech", text: "." },
        { kind: "user", text: "next" },
      ],
      { lang: "en" },
    );
    // The aside localizes; 附件 is the record's own word and does not, and
    // 板砖 stays literal per ADR 0015 (display alias only).
    expect(sys(out)[0]?.body).toBe(
      "附件 spec.md (read it; the original isn't at hand)",
    );
  });
});

describe("the verdict turn: an excerpt the marker shows folds to the read (ADR 0079 §2)", () => {
  // The bridge's shape: the marker's tail is the run's last 差分协处理器 row
  // with a detail (`lastCommandTail`), here the excerpt — a patch preview is
  // a 系统 row and does not replace it.
  const lines =
    "30\tclass TestSieveFast(unittest.TestCase):\n31\t    LIMITS = [0, 1, 2, 3, 997]";
  const shown = `↳ 摘录 test_primes.py:30-31\n${lines}`;
  const op = (verb: "Reading" | "Writing" | "Running", arg: string) =>
    ({
      kind: "system",
      label: "差分协处理器",
      body: `${verb} ${arg}`,
      digest: { kind: "op", verb, arg },
    }) satisfies SystemBlock;
  const excerpt = (detail = shown, path = "test_primes.py"): SystemBlock => ({
    kind: "system",
    label: "差分协处理器",
    body: `↳ excerpt ${path}:30-31`,
    digest: { kind: "excerpt", path, from: 30, to: 31 },
    evidenceDetail: detail,
  });
  const patch: SystemBlock = {
    kind: "system",
    label: "系统",
    body: "patch preview: primes.py (+3 -1)\n\n```diff\n+x\n```",
    digest: { kind: "patch", files: ["primes.py"], add: 3, del: 1 },
  };
  const marker = (tail: string): SystemBlock => ({
    kind: "system",
    label: "差分协处理器",
    body: "完成 · 1 个文件 · +3 −1 · 测试 1/1",
    role: "done-marker",
    markerSummary: {
      kind: "done",
      state: "completed",
      fileCount: 1,
      lines: { add: 3, del: 1 },
      tests: { passed: 1, failed: 0 },
      riskCount: 0,
    },
    evidenceDetail: `${tail}\n↳ 改动文件: primes.py`,
  });
  const dispatch = (...rows: TerminalRecordBlock[]): TerminalRecord => [
    { kind: "user", text: "TestSieveFast 拿哪些 limit 比对？" },
    { kind: "herta", surface: "speech", text: "@板砖 去看。" },
    ...rows,
  ];
  /** The compaction summaries' bodies, in order. */
  const summaries = (out: TerminalRecord): string[] =>
    out
      .filter(
        (b): b is SystemBlock =>
          b.kind === "system" &&
          b.role === undefined &&
          b.digest === undefined &&
          b.evidenceDetail === undefined,
      )
      .map((b) => b.body);

  it("the excerpt the marker ends on reads as the read, not 「原文不在手边」 above its own lines", () => {
    const out = compactRecordForPrompt(
      dispatch(
        op("Reading", "test_primes.py:30-31"),
        excerpt(),
        patch,
        op("Writing", "primes.py"),
        marker(shown),
      ),
    );
    expect(summaries(out)).toEqual([
      "板砖之前做过的事（细节不在手边）：\n- 读 test_primes.py 第 30–31 行\n- 改动 primes.py（+3 −1）",
    ]);
    // The marker passes through with the lines.
    const dm = out.find(
      (b): b is SystemBlock => b.kind === "system" && b.role === "done-marker",
    );
    expect(dm?.evidenceDetail).toContain(lines);
    expect(JSON.stringify(out)).not.toContain("原文不在手边");
  });

  it("in an English session too", () => {
    const out = compactRecordForPrompt(
      dispatch(excerpt(), patch, marker(shown)),
      { lang: "en" },
    );
    expect(summaries(out)).toEqual([
      "What 板砖 did before (details not at hand):\n- Read test_primes.py lines 30–31\n- Changed primes.py (+3 −1)",
    ]);
  });

  it("once she has spoken her verdict, the fold says the lines are not at hand again", () => {
    const out = compactRecordForPrompt([
      ...dispatch(excerpt(), patch, marker(shown)),
      { kind: "herta", surface: "speech", text: "五个 limit。" },
    ]);
    expect(summaries(out)[0]).toContain(
      "- 看过 test_primes.py 第 30–31 行（原文不在手边）",
    );
    expect(JSON.stringify(out)).not.toContain("LIMITS");
  });

  it("an excerpt the marker does not show keeps 「原文不在手边」: other lines, the same lines before an edit, a tail that is a command's output", () => {
    const before = `↳ 摘录 test_primes.py:30-31\n30\tclass TestSieveFast(unittest.TestCase):\n31\t    LIMITS = [0, 1]`;
    const out = compactRecordForPrompt(
      dispatch(
        excerpt("↳ 摘录 bench.py:30-31\n30\tx\n31\ty", "bench.py"),
        excerpt(before),
        patch,
        excerpt(),
        marker(shown),
      ),
    );
    expect(summaries(out)).toEqual([
      [
        "板砖之前做过的事（细节不在手边）：",
        "- 看过 bench.py 第 30–31 行（原文不在手边）",
        "- 看过 test_primes.py 第 30–31 行（原文不在手边）",
        "- 改动 primes.py（+3 −1）",
        "- 读 test_primes.py 第 30–31 行",
      ].join("\n"),
    ]);

    const output: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "↳ exit 0 · 1 lines",
      digest: { kind: "text", text: "↳ exit 0 · 1 lines", exitCode: 0 },
      evidenceDetail: "↳ 输出:\nOK",
    };
    const tailIsOutput = compactRecordForPrompt(
      dispatch(
        excerpt(),
        op("Running", "pytest"),
        output,
        marker("↳ 输出:\nOK"),
      ),
    );
    expect(summaries(tailIsOutput)[0]).toContain(
      "- 看过 test_primes.py 第 30–31 行（原文不在手边）",
    );
  });

  it("only the dispatch the marker closes: a run split by a beat or a steer reads the read, an earlier dispatch's same excerpt does not", () => {
    const earlier = dispatch(excerpt(), patch, marker(shown));
    const out = compactRecordForPrompt([
      ...earlier,
      { kind: "herta", surface: "speech", text: "五个 limit。" },
      ...dispatch(
        op("Reading", "test_primes.py:30-31"),
        excerpt(),
        patch,
        // A beat splits the run, and a steer is not a new message to answer;
        // the marker after them still shows the lines.
        { kind: "herta", surface: "speech", text: "改得不错。" },
        { kind: "user", text: "顺便跑下测试", steer: true },
        op("Writing", "primes.py"),
        op("Running", "pytest"),
        marker(shown),
      ),
    ]);
    const [old, beforeBeat] = summaries(out);
    expect(old).toContain("- 看过 test_primes.py 第 30–31 行（原文不在手边）");
    expect(beforeBeat).toBe(
      "板砖之前做过的事（细节不在手边）：\n- 读 test_primes.py 第 30–31 行\n- 改动 primes.py（+3 −1）",
    );
  });
});

describe("a memory save, as the bridge writes it — no digest (ADR 0079 §2)", () => {
  // Longer than the 60 characters the legacy fold cut a row's first line to.
  const fact =
    "测试用 node --test test/，别用 npm test：package.json 的 test 脚本是坏的，在 Node 22 下一跑就退出，所以别再用它";
  const saved = (): SystemBlock => {
    const event: AgentEvent = {
      type: "tool.call.finished",
      layer: "backend",
      id: "m1",
      tool: "memory_save",
      result: {
        ok: true,
        summary: "remembered: test_command",
        data: { id: "x", kind: "test_command", text: fact, why: "开拓者说的" },
      },
    };
    const block = projectBackendEvent(event);
    if (block === null) throw new Error("the bridge wrote no row");
    return block;
  };
  const op = (verb: "Running" | "Saving memory", arg: string): SystemBlock => ({
    kind: "system",
    label: "差分协处理器",
    body: `${verb} ${arg}`,
    digest: { kind: "op", verb, arg },
  });
  const marker: SystemBlock = {
    kind: "system",
    label: "差分协处理器",
    body: "完成",
    role: "done-marker",
    markerSummary: {
      kind: "done",
      state: "completed",
      fileCount: 0,
      riskCount: 0,
    },
  };
  const dispatch: TerminalRecord = [
    { kind: "user", text: "记住：测试用 node --test test/" },
    { kind: "herta", surface: "speech", text: "@板砖 记下来。" },
  ];
  const run = [
    op("Running", "cat package.json"),
    op("Saving memory", "test_command"),
    saved(),
  ];

  it("folded, the summary says what was remembered — the whole fact, in both languages", () => {
    const later: TerminalRecord = [
      ...dispatch,
      ...run,
      marker,
      { kind: "herta", surface: "speech", text: "记下了。" },
      { kind: "user", text: "下一件事" },
    ];
    expect(buildCompactionBody(run, "zh")).toBe(
      `板砖之前做过的事（细节不在手边）：\n- 板砖记下了：${fact}`,
    );
    expect(buildCompactionBody(run, "en")).toBe(
      `What 板砖 did before (details not at hand):\n- 板砖 noted: ${fact}`,
    );
    for (const [lang, line] of [
      ["zh", `- 板砖记下了：${fact}`],
      ["en", `- 板砖 noted: ${fact}`],
    ] as const) {
      const prompt = serializeTerminalRecord(later, { lang });
      expect(prompt).toContain(line);
      expect(prompt).not.toContain("remembered");
    }
  });

  it("fresh — a beat's window, a run of one — it reads the same, in both languages", () => {
    const beat: TerminalRecord = [...dispatch, ...run];
    const alone: TerminalRecord = [
      ...dispatch,
      saved(),
      { kind: "herta", surface: "speech", text: "记下了。" },
    ];
    for (const [lang, line] of [
      ["zh", `板砖记下了：${fact}`],
      ["en", `板砖 noted: ${fact}`],
    ] as const) {
      for (const prompt of [
        serializeTerminalRecord(beat, {
          lang,
          verbatimSinceLastDispatch: true,
        }),
        serializeTerminalRecord(alone, { lang }),
      ]) {
        expect(prompt).toContain(line);
        expect(prompt).not.toContain("remembered");
      }
    }
  });
});
