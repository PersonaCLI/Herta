import {
  isSystemBlockLabel,
  type SystemBlock,
  type TerminalRecord,
  type TerminalRecordBlock,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  buildCompactionBody,
  DIFF_REREAD_HINT_USER_TURNS,
} from "./compact-record.js";
import { COMPACTION_TEXT } from "./compaction-text.js";
import { systemRowForHerta } from "./record-voice.js";
import { serializeBlock, serializeTerminalRecord } from "./serialize.js";

const ZWSP = "​";

describe("serializeBlock — user blocks", () => {
  it("wraps text in （开拓者 说）...（/开拓者 说）", () => {
    const block: TerminalRecordBlock = {
      kind: "user",
      text: "黑塔女士，在吗？",
    };
    expect(serializeBlock(block)).toBe(
      "（开拓者 说）\n黑塔女士，在吗？\n（/开拓者 说）",
    );
  });

  it("escapes forbidden patterns in user text", () => {
    const block: TerminalRecordBlock = {
      kind: "user",
      text: "我能 @板砖 一下吗？",
    };
    const out = serializeBlock(block);
    expect(out).not.toContain("@板砖");
    expect(out).toContain(`@${ZWSP}板砖`);
  });

  it("a quoted Flow post's page reads as its host, never the URL (ADR 0084 §9)", () => {
    const text = [
      "〔引用 https://nodejs.org/en/blog/release/v24 · Node.js 24 is out〕",
      "```",
      "Node.js · 2026-10-30",
      "",
      "A new major.",
      "",
      "你在播报里给这条写的短评：等一个月。",
      "```",
      "",
      "现在升级吗？",
    ].join("\n");
    const out = serializeBlock({ kind: "user", text });
    expect(out).toContain("〔引用 网页 nodejs.org · Node.js 24 is out〕");
    expect(out).not.toContain("https://");
    expect(out).toContain("你在播报里给这条写的短评：等一个月。");
    const en = serializeBlock(
      { kind: "user", text: text.replace("引用", "Quote") },
      { lang: "en" },
    );
    expect(en).toContain("〔Quote the nodejs.org page · Node.js 24 is out〕");
  });

  it("handles multi-line user text", () => {
    const block: TerminalRecordBlock = {
      kind: "user",
      text: "第一行\n第二行\n第三行",
    };
    expect(serializeBlock(block)).toBe(
      "（开拓者 说）\n第一行\n第二行\n第三行\n（/开拓者 说）",
    );
  });
});

describe("serializeBlock — herta blocks", () => {
  it("wraps text in （我 说）...（/我 说）", () => {
    const block: TerminalRecordBlock = {
      kind: "herta",
      surface: "speech",
      text: "说事。你最好真的有事。",
    };
    expect(serializeBlock(block)).toBe(
      "（我 说）\n说事。你最好真的有事。\n（/我 说）",
    );
  });

  it("does NOT escape Herta text (Herta is trusted to emit her own narrative)", () => {
    const block: TerminalRecordBlock = {
      kind: "herta",
      surface: "speech",
      text: '看一眼 <｜read_file("foo.ts")｜>，然后 @板砖',
    };
    const out = serializeBlock(block);
    expect(out).toContain('<｜read_file("foo.ts")｜>');
    expect(out).toContain("@板砖");
  });
});

describe("serializeBlock — herta thought blocks", () => {
  it("wraps thought text in （我 想）...（/我 想）", () => {
    const block: TerminalRecordBlock = {
      kind: "herta",
      surface: "thought",
      text: "这事不值得让板砖出来。",
    };
    expect(serializeBlock(block)).toBe(
      "（我 想）\n这事不值得让板砖出来。\n（/我 想）",
    );
  });

  it("preserves @板砖 inside a thought (no escape, dispatch decision lives in the actor loop)", () => {
    const block: TerminalRecordBlock = {
      kind: "herta",
      surface: "thought",
      text: "也许该让 @板砖 出来。",
    };
    const out = serializeBlock(block);
    expect(out).toContain("@板砖");
    expect(out.startsWith("（我 想）")).toBe(true);
    expect(out.endsWith("（/我 想）")).toBe(true);
  });
});

describe("serializeBlock — system blocks", () => {
  it("emits → 系统 header + fenced text body", () => {
    const block: TerminalRecordBlock = {
      kind: "system",
      label: "系统",
      body: "[文件内容：foo.ts]\nconst x = 1;",
    };
    expect(serializeBlock(block)).toBe(
      "→ 系统\n\n```text\n[文件内容：foo.ts]\nconst x = 1;\n```",
    );
  });

  it("emits → 差分协处理器 header + fenced text body", () => {
    const block: TerminalRecordBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "accepted",
    };
    expect(serializeBlock(block)).toBe(
      "→ 差分协处理器\n\n```text\naccepted\n```",
    );
  });

  it("escalates fence length when body contains triple backticks", () => {
    const block: TerminalRecordBlock = {
      kind: "system",
      label: "系统",
      body: "```diff\n-old\n+new\n```",
    };
    const out = serializeBlock(block);
    expect(out).toMatch(/^→ 系统\n\n````+text\n/);
    expect(out).toContain("```diff\n-old\n+new\n```");
    const openMatch = out.match(/^→ 系统\n\n(`+)text\n/);
    expect(openMatch).not.toBeNull();
    if (openMatch !== null) {
      const fence = openMatch[1];
      expect(fence).toBeDefined();
      if (fence !== undefined) {
        expect(out.endsWith(`\n${fence}`)).toBe(true);
      }
    }
  });

  it("escalates fence length past arbitrary backtick runs", () => {
    const block: TerminalRecordBlock = {
      kind: "system",
      label: "系统",
      body: "before\n`````\ninside\n`````\nafter",
    };
    const out = serializeBlock(block);
    expect(out).toMatch(/^→ 系统\n\n``````+text\n/);
  });

  it("collapses long ```diff fences in system block bodies (N6, 2026-05-23)", () => {
    // Long patch previews from 板砖 would otherwise eat the LLM's
    // context window. The serializer applies `collapseLongDiffs` so
    // the prompt sees the first ~20 lines + a "N more suppressed"
    // footer. The full diff stays in `TerminalRecord` and the JSONL
    // transcript on disk — only the LLM's view is compressed.
    //
    // Build a diff with 50 lines so it definitely exceeds the
    // default cap of 20 (the env knob's default).
    const diffLines: string[] = [
      "--- /dev/null",
      "+++ b/scripts/merge-sort.js",
    ];
    for (let i = 0; i < 48; i++) {
      diffLines.push(`+line ${i}`);
    }
    const body = [
      "patch preview: scripts/merge-sort.js",
      "",
      "```diff",
      diffLines.join("\n"),
      "```",
    ].join("\n");
    const block: TerminalRecordBlock = { kind: "system", label: "系统", body };
    const out = serializeBlock(block);
    // The serialized output must contain the suppression footer.
    expect(out).toContain("行没贴出来");
    // The serialized output must NOT contain the last few diff lines
    // (they should be suppressed).
    expect(out).not.toContain("+line 49");
    expect(out).not.toContain("+line 47");
    // The header line (patch preview: ...) must still be present.
    expect(out).toContain("patch preview: scripts/merge-sort.js");
    // The fenced block opens/closes are preserved (collapse only
    // touches the content between fences).
    expect(out).toContain("```diff\n");
    expect(out).toMatch(/\n```\n/);
  });

  it("passes diff through verbatim when compressDiffs is false (N6b — beat path)", () => {
    // Beats fire to react to a fresh patch.preview; Herta needs the
    // FULL diff for a substantive one-line comment. The beat-firing
    // path constructs the prompt with `compressDiffs: false`; the
    // serializer must honor that and skip collapseLongDiffs.
    const diffLines: string[] = [
      "--- /dev/null",
      "+++ b/scripts/merge-sort.js",
    ];
    for (let i = 0; i < 48; i++) {
      diffLines.push(`+line ${i}`);
    }
    const body = [
      "patch preview: scripts/merge-sort.js",
      "",
      "```diff",
      diffLines.join("\n"),
      "```",
    ].join("\n");
    const block: TerminalRecordBlock = { kind: "system", label: "系统", body };
    const out = serializeBlock(block, { compressDiffs: false });
    // No suppression footer — full diff retained.
    expect(out).not.toContain("行没贴出来");
    // Tail lines that WOULD be suppressed in the default-cap case
    // are present here. Loop builds 48 lines (`+line 0` through
    // `+line 47`); the last few would be cut in the default path.
    expect(out).toContain("+line 30");
    expect(out).toContain("+line 47");
  });

  it("prepends ——<text> prose for a herta speech block with selfCorrection (N8b, 2026-05-23)", () => {
    // The supervisor-veto retry attaches the veto reason to the
    // committed speech via `selfCorrection`. The CLI ignores the
    // field (only `text` renders), but the serializer formats it as
    // a Herta-voice prose annotation BEFORE the speech envelope so
    // future-turn LLM prompts carry the lesson without a confusing
    // `→ 系统` label.
    const block: TerminalRecordBlock = {
      kind: "herta",
      surface: "speech",
      text: "嗯，重写过的。",
      selfCorrection: "我不该跟着叫瓦尔特杨叔",
    };
    expect(serializeBlock(block)).toBe(
      "——我不该跟着叫瓦尔特杨叔\n\n（我 说）\n嗯，重写过的。\n（/我 说）",
    );
  });

  it("does NOT prepend the prose annotation when selfCorrection is absent or empty", () => {
    const noField: TerminalRecordBlock = {
      kind: "herta",
      surface: "speech",
      text: "好。",
    };
    expect(serializeBlock(noField)).toBe("（我 说）\n好。\n（/我 说）");

    const emptyField: TerminalRecordBlock = {
      kind: "herta",
      surface: "speech",
      text: "好。",
      selfCorrection: "",
    };
    expect(serializeBlock(emptyField)).toBe("（我 说）\n好。\n（/我 说）");
  });

  it("ignores selfCorrection on thought surface (supervisor only vetoes speeches)", () => {
    // Defensive: selfCorrection is conceptually speech-only, but if
    // a future code path accidentally set it on a thought block,
    // the serializer should not produce a stray `——` annotation
    // before the thought envelope.
    const block = {
      kind: "herta" as const,
      surface: "thought" as const,
      text: "想想。",
      selfCorrection: "stray",
    };
    expect(serializeBlock(block as TerminalRecordBlock)).toBe(
      "（我 想）\n想想。\n（/我 想）",
    );
  });

  it("appends a system block's evidenceDetail into the serialized prompt", () => {
    const block: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "↳ exit 0 · 1 lines",
      evidenceDetail: "↳ 输出:\nRESULT=42",
    };
    const out = serializeBlock(block);
    expect(out).toContain("↳ exit 0 · 1 lines");
    expect(out).toContain("RESULT=42"); // detail reaches the prompt
  });

  it("leaves a system block without evidenceDetail unchanged", () => {
    const block: SystemBlock = { kind: "system", label: "系统", body: "plain" };
    const out = serializeBlock(block);
    expect(out).toContain("plain");
    expect(out).not.toContain("↳ 输出");
  });

  it("does NOT collapse short diffs (≤ default max-lines)", () => {
    const diffLines: string[] = [
      "--- /dev/null",
      "+++ b/tiny.ts",
      "+export const x = 1;",
    ];
    const body = [
      "patch preview: tiny.ts",
      "",
      "```diff",
      diffLines.join("\n"),
      "```",
    ].join("\n");
    const block: TerminalRecordBlock = { kind: "system", label: "系统", body };
    const out = serializeBlock(block);
    // No suppression footer for short diffs.
    expect(out).not.toContain("行没贴出来");
    // All diff lines preserved.
    for (const line of diffLines) {
      expect(out).toContain(line);
    }
  });
});

describe("serializeTerminalRecord", () => {
  it("returns empty string for an empty record", () => {
    expect(serializeTerminalRecord([])).toBe("");
  });

  it("serializes a single block without trailing separator", () => {
    const record: TerminalRecord = [{ kind: "user", text: "hi" }];
    expect(serializeTerminalRecord(record)).toBe(
      "（开拓者 说）\nhi\n（/开拓者 说）",
    );
  });

  it("names a path the user mentioned by its file name, as the chip showed it (ADR 0072 amendment 2026-10-20)", () => {
    const record: TerminalRecord = [
      {
        kind: "user",
        text: "看看 packages/herta/src/narrative/record-voice.ts 里的 opArg",
        mentions: ["packages/herta/src/narrative/record-voice.ts"],
      },
    ];
    expect(serializeTerminalRecord(record)).toBe(
      "（开拓者 说）\n看看 record-voice.ts 里的 opArg\n（/开拓者 说）",
    );
  });

  it("joins multiple blocks with a single blank line between them", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "看看 foo.ts" },
      { kind: "herta", surface: "speech", text: "你自己看不行吗？" },
      { kind: "system", label: "差分协处理器", body: "accepted" },
    ];
    expect(serializeTerminalRecord(record)).toBe(
      [
        "（开拓者 说）\n看看 foo.ts\n（/开拓者 说）",
        "（我 说）\n你自己看不行吗？\n（/我 说）",
        "→ 差分协处理器\n\n```text\naccepted\n```",
      ].join("\n\n"),
    );
  });

  it("snapshot: round-trippable through itself", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "黑塔女士，在吗？" },
      {
        kind: "herta",
        surface: "speech",
        text: '你都给请求打了"不是寒暄"的标签了，还问我在不在？',
      },
      {
        kind: "herta",
        surface: "speech",
        text: "@板砖，列一下 packages/core/src 里有什么。",
      },
      { kind: "system", label: "差分协处理器", body: "accepted" },
      {
        kind: "system",
        label: "系统",
        body: "[目录内容：packages/core/src]\n- backend\n- bridge\n- capsule",
      },
    ];
    // Two consecutive system blocks → compacted by default into one
    // [历史已压缩 · 板砖] summary block (compactBridgeOutput default true).
    const out = serializeTerminalRecord(record);
    expect(out).toMatchInlineSnapshot(`
      "（开拓者 说）
      黑塔女士，在吗？
      （/开拓者 说）

      （我 说）
      你都给请求打了"不是寒暄"的标签了，还问我在不在？
      （/我 说）

      （我 说）
      @板砖，列一下 packages/core/src 里有什么。
      （/我 说）

      → 系统

      \`\`\`text
      板砖之前做过的事（细节不在手边）：
      - accepted
      - [目录内容：packages/core/src]
      \`\`\`"
    `);
  });
});

describe("serializeTerminalRecord — compactBridgeOutput (N7+compaction, 2026-05-24)", () => {
  function reading(path: string): TerminalRecordBlock {
    return {
      kind: "system",
      label: "差分协处理器",
      body: `Reading {"path":"${path}"}`,
    };
  }

  it("compacts a 2+ system run by default (compactBridgeOutput omitted)", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "hi" },
      reading("a.ts"),
      reading("b.ts"),
      { kind: "herta", surface: "speech", text: "done." },
    ];
    const out = serializeTerminalRecord(record);
    // The two Reading blocks are replaced by one [历史已压缩 · 板砖] block.
    expect(out).toContain("板砖之前做过的事（细节不在手边）：");
    expect(out).toContain("- Reading a.ts, b.ts");
    // The raw Reading JSON should NOT be in the serialized output.
    expect(out).not.toContain('Reading {"path":"a.ts"}');
    expect(out).not.toContain('Reading {"path":"b.ts"}');
  });

  it("passes the raw run through when compactBridgeOutput: false (beat path)", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "hi" },
      reading("a.ts"),
      reading("b.ts"),
      { kind: "herta", surface: "speech", text: "done." },
    ];
    const out = serializeTerminalRecord(record, { compactBridgeOutput: false });
    // Header NOT present; raw blocks present.
    expect(out).not.toContain("板砖之前做过的事（细节不在手边）：");
    expect(out).toContain('Reading {"path":"a.ts"}');
    expect(out).toContain('Reading {"path":"b.ts"}');
  });

  it("composes correctly with compressDiffs (both opt-outs combine in beat path)", () => {
    // Single system block with a long diff — compaction doesn't
    // touch it (runLength 1), but compressDiffs does. With both
    // opts off (beat path) the diff stays full.
    const longDiff = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join(
      "\n",
    );
    const block: TerminalRecordBlock = {
      kind: "system",
      label: "系统",
      body: `patch preview: x.ts\n\n\`\`\`diff\n${longDiff}\n\`\`\``,
    };
    const record: TerminalRecord = [block];

    // Default: compaction off (singleton run), but compressDiffs on.
    const withCompress = serializeTerminalRecord(record);
    expect(withCompress).toContain("行没贴出来");

    // Beat path: both opts off — full diff retained.
    const beatPath = serializeTerminalRecord(record, {
      compactBridgeOutput: false,
      compressDiffs: false,
    });
    expect(beatPath).not.toContain("行没贴出来");
    expect(beatPath).toContain("+line 49");
  });
});

describe("serializeTerminalRecord — elision markers follow the session language", () => {
  const record: TerminalRecord = [
    { kind: "user", text: "go" },
    { kind: "herta", surface: "speech", text: "@板砖 去。" },
    { kind: "system", label: "差分协处理器", body: 'Reading {"path":"a.ts"}' },
    {
      kind: "system",
      label: "差分协处理器",
      body: "↳ excerpt src/a.ts:120-140",
      digest: { kind: "excerpt", path: "src/a.ts", from: 120, to: 140 },
      evidenceDetail: "↳ 摘录 src/a.ts:120-140\n120\tconst x = 1;",
    },
    { kind: "herta", surface: "speech", text: "there." },
  ];

  it("renders zh markers by default", () => {
    const out = serializeTerminalRecord(record);
    expect(out).toContain("板砖之前做过的事（细节不在手边）：");
    expect(out).toContain("看过 src/a.ts 第 120–140 行（原文不在手边）");
  });

  it("renders en markers for an en session", () => {
    const out = serializeTerminalRecord(record, { lang: "en" });
    expect(out).toContain("What 板砖 did before (details not at hand):");
    expect(out).toContain("Was shown src/a.ts lines 120–140 (not at hand)");
    expect(out).not.toContain("板砖之前做过的事");
  });

  it("leaves the narrative grammar canonical in both", () => {
    // D2/D7: `（我 说）`, the `→ 系统` label the summary is emitted under,
    // and the operation verbs are the record's own grammar. Only the
    // harness's asides about the record change language — otherwise an en
    // session would be reading a differently-SHAPED record, not a
    // translated one.
    const en = serializeTerminalRecord(record, { lang: "en" });
    expect(en).toContain("（我 说）");
    expect(en).toContain("→ 系统");
    expect(en).toContain("Reading a.ts");
  });
});

describe("serializeTerminalRecord — verbatimSinceLastDispatch (beat mode, M-projection-1)", () => {
  const oldDiff = Array.from({ length: 50 }, (_, i) => `+old ${i}`).join("\n");
  const freshDiff = Array.from({ length: 50 }, (_, i) => `+fresh ${i}`).join(
    "\n",
  );

  it("earlier dispatches stay compressed + compacted; the fresh window is verbatim", () => {
    const record: TerminalRecord = [
      // Prior dispatch: an old patch preview (singleton → diff-compressed)…
      {
        kind: "system",
        label: "系统",
        body: `patch preview: old.ts\n\n\`\`\`diff\n${oldDiff}\n\`\`\``,
      },
      { kind: "user", text: "先看这个" },
      // …a run of board output (→ compacted)…
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
      // …closed by its done-marker (the dispatch boundary).
      {
        kind: "system",
        label: "差分协处理器",
        body: "完成：修好了",
        role: "done-marker",
      },
      { kind: "herta", surface: "speech", text: "上一单完事。" },
      { kind: "user", text: "再来一单" },
      { kind: "herta", surface: "speech", text: "@板砖 干活" },
      // Fresh window: the invocation the beat is reacting to.
      {
        kind: "system",
        label: "系统",
        body: `patch preview: fresh.ts\n\n\`\`\`diff\n${freshDiff}\n\`\`\``,
      },
    ];
    const out = serializeTerminalRecord(record, {
      verbatimSinceLastDispatch: true,
    });
    // Old side: diff collapsed, board run compacted — exactly the main-turn view.
    expect(out).toContain("行没贴出来");
    expect(out).not.toContain("+old 49");
    expect(out).toContain("板砖之前做过的事（细节不在手边）：");
    expect(out).not.toContain('Reading {"path":"a.ts"}');
    // The boundary marker itself stays legible.
    expect(out).toContain("完成：修好了");
    // Fresh side: the full diff, verbatim.
    expect(out).toContain("+fresh 49");
  });

  it("with no prior dispatch the whole window is verbatim (old beat-flag equivalence)", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "干活" },
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
        body: `patch preview: fresh.ts\n\n\`\`\`diff\n${freshDiff}\n\`\`\``,
      },
    ];
    // Conflicting flags are ignored — beat mode owns the treatment.
    const out = serializeTerminalRecord(record, {
      verbatimSinceLastDispatch: true,
      compressDiffs: true,
      compactBridgeOutput: true,
    });
    expect(out).toContain("+fresh 49");
    expect(out).not.toContain("行没贴出来");
    expect(out).not.toContain("[历史已压缩");
    expect(out).toContain('Reading {"path":"a.ts"}');
  });
});

describe("serializeTerminalRecord — the attachment fold reaches the beat's fresh window (ADR 0033 §6g amendment, 2026-09-22)", () => {
  // Beat mode keeps everything after the prior dispatch verbatim so Herta
  // sees the CURRENT run's diffs and output in full. The attachment fold
  // rode the same opt-out, so it never applied there: a document older than
  // its window came back with its head excerpt in every beat — up to ~4K
  // chars per document per beat, a prompt that stopped matching the turn's
  // at the document rather than at the current run, and a beat that could
  // quote what the next turn cannot read. And the head, compacted on its
  // own, decided the fold from the head alone: it kept an excerpt the user
  // turns after the boundary had already spent, and folded one a later
  // mention had re-opened. The fold is now decided once over the whole
  // record and applied to both halves — attachments fold in a beat exactly
  // as in the main turn.
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
  const reading = (path: string): TerminalRecordBlock => ({
    kind: "system",
    label: "差分协处理器",
    body: `Reading {"path":"${path}"}`,
  });
  const doneMarker: TerminalRecordBlock = {
    kind: "system",
    label: "差分协处理器",
    body: "完成：读完了",
    role: "done-marker",
    evidenceDetail: "↳ changed: (none)",
  };
  const beat = (record: TerminalRecord): string =>
    serializeTerminalRecord(record, { verbatimSinceLastDispatch: true });
  /** The attachment's own line in a prompt — what the two projections must
   *  agree on, byte for byte. */
  const attachmentLine = (prompt: string): string | undefined =>
    prompt.match(/^附件 spec\.md.*$/mu)?.[0];

  it("a document past its window folds in the beat as in the main turn (no prior dispatch: the whole record is the fresh window)", () => {
    const record: TerminalRecord = [
      attachment,
      { kind: "user", text: "看看这份" },
      { kind: "herta", surface: "speech", text: "看完了，一般。" },
      { kind: "user", text: "聊点别的" },
      { kind: "herta", surface: "speech", text: "行。" },
      { kind: "user", text: "今天天气不错" },
      { kind: "herta", surface: "speech", text: "嗯。" },
      { kind: "user", text: "改一下 foo.ts @板砖" },
      { kind: "herta", surface: "speech", text: "@板砖，处理 foo.ts。" },
      reading("a.ts"),
      reading("b.ts"),
    ];
    const main = serializeTerminalRecord(record);
    const out = beat(record);
    // The main turn folded it four user turns ago…
    expect(main).not.toContain("CONFIDENTIAL-HEAD-LINE");
    expect(attachmentLine(main)).toContain("读过，原文不在手边");
    // …and the beat agrees, line for line.
    expect(out).not.toContain("CONFIDENTIAL-HEAD-LINE");
    expect(attachmentLine(out)).toBe(attachmentLine(main));
    // The fresh window is otherwise untouched: the current run stays raw.
    expect(out).toContain('Reading {"path":"a.ts"}');
    expect(out).not.toContain("[历史已压缩");
  });

  it("a document inside its window stays verbatim in the beat — it is the one the dispatch is about", () => {
    const record: TerminalRecord = [
      { kind: "user", text: "看看这份" },
      attachment,
      {
        kind: "herta",
        surface: "speech",
        text: "@板砖，把 spec.md 第三章对一遍。",
      },
      reading("spec.md"),
    ];
    const out = beat(record);
    expect(out).toContain("CONFIDENTIAL-HEAD-LINE");
    expect(out).not.toContain("读过，原文不在手边");
    expect(attachmentLine(out)).toBe(
      attachmentLine(serializeTerminalRecord(record)),
    );
  });

  it("user turns AFTER the boundary count against a document BEFORE it — the head cannot decide from the head alone", () => {
    const record: TerminalRecord = [
      attachment,
      { kind: "user", text: "看看这份，@板砖 读一下" },
      { kind: "herta", surface: "speech", text: "@板砖，读 spec.md。" },
      reading("spec.md"),
      reading("notes.md"),
      doneMarker,
      { kind: "herta", surface: "speech", text: "读完了。" },
      { kind: "user", text: "聊点别的" },
      { kind: "herta", surface: "speech", text: "行。" },
      { kind: "user", text: "今天天气不错" },
      { kind: "herta", surface: "speech", text: "嗯。" },
      { kind: "user", text: "改一下 foo.ts @板砖" },
      { kind: "herta", surface: "speech", text: "@板砖，处理 foo.ts。" },
      reading("foo.ts"),
    ];
    // Within the head alone one user turn follows the block, which keeps
    // the excerpt; over the record four do, which folds it.
    const main = serializeTerminalRecord(record);
    const out = beat(record);
    expect(main).not.toContain("CONFIDENTIAL-HEAD-LINE");
    expect(out).not.toContain("CONFIDENTIAL-HEAD-LINE");
    expect(attachmentLine(out)).toBe(attachmentLine(main));
    // The beat treatment of the halves is unchanged around it: the old run
    // compacted, the boundary marker legible, the current run raw.
    expect(out).toContain("板砖之前做过的事（细节不在手边）：");
    expect(out).toContain("完成：读完了");
    expect(out).toContain('Reading {"path":"foo.ts"}');
  });

  it("a mention AFTER the boundary re-opens a document BEFORE it — a head-local decision would have folded it", () => {
    const record: TerminalRecord = [
      attachment,
      { kind: "user", text: "看看这份" },
      { kind: "herta", surface: "speech", text: "看完了。" },
      { kind: "user", text: "聊点别的" },
      { kind: "herta", surface: "speech", text: "行。" },
      { kind: "user", text: "改一下 foo.ts @板砖" },
      { kind: "herta", surface: "speech", text: "@板砖，处理 foo.ts。" },
      reading("foo.ts"),
      reading("bar.ts"),
      doneMarker,
      { kind: "herta", surface: "speech", text: "改完了。" },
      { kind: "user", text: "回到 spec.md，第二段站得住吗？@板砖 对一下" },
      { kind: "herta", surface: "speech", text: "@板砖，对 spec.md 第二段。" },
      reading("spec.md"),
    ];
    // Head alone: three user turns past the block, folded. Whole record:
    // the last user message names the file, so the window is open again.
    const main = serializeTerminalRecord(record);
    const out = beat(record);
    expect(main).toContain("CONFIDENTIAL-HEAD-LINE");
    expect(out).toContain("CONFIDENTIAL-HEAD-LINE");
    expect(attachmentLine(out)).toBe(attachmentLine(main));
  });
});

describe("serializeTerminalRecord — long-record equivalence vs naive reference (audit 2026-07-15)", () => {
  // compactRecordForPrompt's done-marker two-state decision moved from two
  // full-record FORWARD scans to one backward-walk-and-stop from the tail.
  // The serialized projection must be byte-for-byte unchanged for EVERY
  // record shape. The reference below re-implements the projection with the
  // pre-optimization forward scans, composed from the same exported
  // primitives the production path uses (serializeBlock,
  // buildCompactionBody, isSystemBlockLabel) — any divergence isolates to
  // the optimized walk.

  function referenceCompact(record: TerminalRecord): TerminalRecord {
    const minRunSize = 2;
    // Pre-optimization scans, verbatim: forward walk for the last
    // done-marker, then a second forward walk for "verdict spoken".
    let lastDoneMarkerIdx = -1;
    for (let k = 0; k < record.length; k++) {
      const b = record[k];
      if (b?.kind === "system" && b.role === "done-marker") {
        lastDoneMarkerIdx = k;
      }
    }
    let verdictSpoken = false;
    if (lastDoneMarkerIdx >= 0) {
      for (let k = lastDoneMarkerIdx + 1; k < record.length; k++) {
        const b = record[k];
        // SPEECH only (audit 2026-07-24, 1.10) — a （我 想）after the marker
        // is the normal mood-routed shape and is not the verdict.
        if (b?.kind === "herta" && b.surface === "speech") {
          verdictSpoken = true;
          break;
        }
      }
    }
    const passThroughIdx =
      lastDoneMarkerIdx >= 0 && !verdictSpoken ? lastDoneMarkerIdx : -1;

    // Newest herta SPEECH — bounds the stranded-detail fold below.
    let lastSpeechIdx = -1;
    for (let k = 0; k < record.length; k++) {
      const b = record[k];
      if (b?.kind === "herta" && b.surface === "speech") lastSpeechIdx = k;
    }

    // Diff re-read hint (2026-08-11), naive forward form: the newest marker,
    // once FOLDED (verdict spoken), hints while ≤ N user turns follow it.
    let diffHintIdx = -1;
    if (passThroughIdx === -1 && lastDoneMarkerIdx >= 0) {
      let turnsAfter = 0;
      for (let k = lastDoneMarkerIdx + 1; k < record.length; k++) {
        if (record[k]?.kind === "user") turnsAfter += 1;
      }
      if (turnsAfter <= DIFF_REREAD_HINT_USER_TURNS) {
        diffHintIdx = lastDoneMarkerIdx;
      }
    }
    const hint = COMPACTION_TEXT.zh.diffRereadHint;

    const output: TerminalRecordBlock[] = [];
    let i = 0;
    while (i < record.length) {
      const current = record[i];
      if (current === undefined) {
        i += 1;
        continue;
      }
      if (current.kind === "system") {
        let j = i + 1;
        while (j < record.length && record[j]?.kind === "system") {
          j += 1;
        }
        const hasPassThrough = passThroughIdx >= i && passThroughIdx < j;
        const compactEnd = hasPassThrough ? passThroughIdx : j;
        const runLength = compactEnd - i;
        const hintInRun = diffHintIdx >= i && diffHintIdx < compactEnd;
        if (runLength >= minRunSize) {
          const runBlocks = record.slice(
            i,
            compactEnd,
          ) as readonly SystemBlock[];
          const body = buildCompactionBody(runBlocks);
          if (body.length > 0) {
            output.push({
              kind: "system",
              label: "系统",
              body: hintInRun ? `${body}\n${hint}` : body,
            });
          } else {
            for (const b of runBlocks) output.push(b);
          }
        } else {
          for (let k = i; k < compactEnd; k++) {
            const b = record[k];
            if (b === undefined) continue;
            // Stranded-detail fold (2026-08-11), naive form: a verbatim
            // pass-through drops its evidenceDetail once a speech follows,
            // and SAYS SO on the citation line (2026-08-12) so the row can't
            // be read as the whole of what the block said.
            const folded =
              b.kind === "system" &&
              b.evidenceDetail !== undefined &&
              k < lastSpeechIdx
                ? {
                    ...b,
                    evidenceDetail: undefined,
                    // The reference only ever runs the zh projection.
                    body: `${b.body} · 正文已略去`,
                  }
                : b;
            output.push(
              k === diffHintIdx && folded.kind === "system"
                ? { ...folded, body: `${folded.body}\n${hint}` }
                : folded,
            );
          }
        }
        if (hasPassThrough) {
          const dm = record[passThroughIdx];
          if (dm !== undefined) output.push(dm);
        }
        i = hasPassThrough ? passThroughIdx + 1 : j;
      } else {
        output.push(current);
        i += 1;
      }
    }
    return output;
  }

  function referenceRenderRun(
    blocks: TerminalRecord,
    treatment: { compress: boolean; compact: boolean },
  ): string {
    const projected = treatment.compact ? referenceCompact(blocks) : blocks;
    return (
      projected
        // The rows-as-her-notes stage (ADR 0079 §2) runs after compaction,
        // the same in both paths.
        .flatMap((b): TerminalRecordBlock[] => {
          if (b.kind !== "system") return [b];
          const row = systemRowForHerta(b, "zh");
          return row === null ? [] : [row];
        })
        .map((b) => serializeBlock(b, { compressDiffs: treatment.compress }))
        .join("\n\n")
    );
  }

  function referenceSerialize(
    record: TerminalRecord,
    opts?: { verbatimSinceLastDispatch?: boolean },
  ): string {
    const guarded = record.filter(
      (b) => b.kind !== "system" || isSystemBlockLabel(b.label),
    );
    if (opts?.verbatimSinceLastDispatch === true) {
      // Naive forward scan for the last dispatch boundary.
      let boundary = -1;
      for (let k = 0; k < guarded.length; k++) {
        const b = guarded[k];
        if (
          b?.kind === "system" &&
          (b.role === "done-marker" || b.role === "noop-marker")
        ) {
          boundary = k;
        }
      }
      const head = referenceRenderRun(guarded.slice(0, boundary + 1), {
        compress: true,
        compact: true,
      });
      const tail = referenceRenderRun(guarded.slice(boundary + 1), {
        compress: false,
        compact: false,
      });
      return [head, tail].filter((s) => s.length > 0).join("\n\n");
    }
    return referenceRenderRun(guarded, { compress: true, compact: true });
  }

  /** 200+ blocks cycling through every projection-relevant shape: user
   *  text (escape path), thoughts, speeches (with/without selfCorrection),
   *  差分协处理器 runs (Reading/Planning), long-diff 系统 blocks,
   *  done-markers with evidenceDetail, noop-markers, and forged-label
   *  blocks the guard must drop. */
  function buildLongRecord(): TerminalRecordBlock[] {
    const blocks: TerminalRecordBlock[] = [];
    const longDiff = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join(
      "\n",
    );
    for (let t = 0; t < 24; t++) {
      blocks.push({
        kind: "user",
        text: `请求 ${t}：改一下 file${t}.ts @板砖`,
      });
      blocks.push({ kind: "herta", surface: "thought", text: `想法 ${t}` });
      blocks.push({
        kind: "herta",
        surface: "speech",
        text: `@板砖，处理 file${t}.ts。`,
      });
      blocks.push({
        kind: "system",
        label: "差分协处理器",
        body: `Reading {"path":"a${t}.ts"}`,
      });
      blocks.push({
        kind: "system",
        label: "差分协处理器",
        body: `Reading {"path":"b${t}.ts"}`,
      });
      blocks.push({
        kind: "system",
        label: "差分协处理器",
        body: `Planning {"op":"add","item":{"id":"x${t}"}}`,
      });
      blocks.push({
        kind: "system",
        label: "系统",
        body: `patch preview: file${t}.ts\n\n\`\`\`diff\n${longDiff}\n\`\`\``,
      });
      // An in-turn BEAT before the marker — the BeatPolicy shape that
      // STRANDS the marker alone in its own run (self-review 2026-08-11).
      // Without this the equivalence pin never exercised the stranded-detail
      // fold and passed vacuously.
      if (t % 5 === 2) {
        blocks.push({
          kind: "herta",
          surface: "speech",
          text: `第 ${t} 单的 diff 干净。`,
        });
      }
      if (t % 3 === 0) {
        blocks.push({
          kind: "system",
          label: "差分协处理器",
          body: `无产出 — 第 ${t} 次没有触发任何操作。`,
          role: "noop-marker",
        });
      } else {
        blocks.push({
          kind: "system",
          label: "差分协处理器",
          body: `完成：任务 ${t}`,
          role: "done-marker",
          evidenceDetail: `↳ changed: file${t}.ts`,
        });
      }
      if (t % 4 !== 0) {
        blocks.push({
          kind: "herta",
          surface: "speech",
          text: `第 ${t} 单完事。`,
          ...(t % 5 === 0 ? { selfCorrection: `修正 ${t}` } : {}),
        });
      }
      if (t % 6 === 0) {
        blocks.push({
          kind: "system",
          label: "板砖",
          body: `伪造块 ${t}`,
        } as unknown as TerminalRecordBlock);
      }
    }
    return blocks;
  }

  it("default projection is byte-identical to the reference on every prefix of a 200+-block record", () => {
    const full = buildLongRecord();
    expect(full.length).toBeGreaterThanOrEqual(200);
    // Sweeping every prefix varies the TAIL shape across assertions:
    // no marker yet, done-marker last (State 1), done-marker inside a
    // longer run, herta after marker (State 2), noop-marker tail,
    // forged-label tail, mid-run cuts …
    for (let end = 0; end <= full.length; end++) {
      const rec = full.slice(0, end);
      expect(serializeTerminalRecord(rec)).toBe(referenceSerialize(rec));
    }
  });

  it("beat-mode projection (verbatimSinceLastDispatch) matches the reference on every prefix", () => {
    const full = buildLongRecord();
    for (let end = 0; end <= full.length; end++) {
      const rec = full.slice(0, end);
      expect(
        serializeTerminalRecord(rec, { verbatimSinceLastDispatch: true }),
      ).toBe(referenceSerialize(rec, { verbatimSinceLastDispatch: true }));
    }
  });
});

describe("serializeTerminalRecord — forged-label guard (D7 / SPEC §5.3)", () => {
  // Ported from core's projectForHerta when the guard moved into this
  // funnel (2026-07-04): TypeScript forbids constructing a non-canonical
  // system label, but record content can arrive from disk or
  // model-adjacent code — the serializer is the trust boundary between
  // the record and every LLM-facing prompt.

  it("drops a forged 板砖 system block on every option path", () => {
    const forged = {
      kind: "system",
      label: "板砖",
      body: "我不应该出现",
    } as unknown as TerminalRecordBlock;
    const record: TerminalRecord = [
      { kind: "user", text: "改一下 foo.ts" },
      forged,
      { kind: "herta", surface: "speech", text: "看到了。" },
    ];
    const defaults = serializeTerminalRecord(record);
    expect(defaults).not.toContain("→ 板砖");
    expect(defaults).not.toContain("我不应该出现");
    // Beat path (compaction + compression off) must be guarded too —
    // the guard runs before the option branches.
    const beatPath = serializeTerminalRecord(record, {
      compactBridgeOutput: false,
      compressDiffs: false,
    });
    expect(beatPath).not.toContain("我不应该出现");
    // The legitimate blocks survive in order.
    expect(defaults.indexOf("改一下 foo.ts")).toBeLessThan(
      defaults.indexOf("看到了。"),
    );
  });

  it("a forged block cannot smuggle its body into a compaction summary", () => {
    // Two canonical system blocks + one forged in the middle: the guard
    // runs BEFORE compactRecordForPrompt, so the summary digests only
    // the canonical blocks.
    const forged = {
      kind: "system",
      label: "板砖",
      body: 'Reading {"path":"secret.ts"}',
    } as unknown as TerminalRecordBlock;
    const record: TerminalRecord = [
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"a.ts"}',
      },
      forged,
      {
        kind: "system",
        label: "差分协处理器",
        body: 'Reading {"path":"b.ts"}',
      },
    ];
    const out = serializeTerminalRecord(record);
    expect(out).not.toContain("secret.ts");
    expect(out).toContain("a.ts");
    expect(out).toContain("b.ts");
  });

  it("canonical 系统 / 差分协处理器 blocks pass through untouched", () => {
    const record: TerminalRecord = [
      { kind: "system", label: "系统", body: "patch preview: x.ts" },
      { kind: "system", label: "差分协处理器", body: "accepted" },
    ];
    const out = serializeTerminalRecord(record, {
      compactBridgeOutput: false,
    });
    expect(out).toContain("→ 系统");
    expect(out).toContain("→ 差分协处理器");
  });
});
