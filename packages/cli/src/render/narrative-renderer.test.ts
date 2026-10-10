import type { TerminalRecord, TerminalRecordBlock } from "@herta/core";
import { collapseLongDiffs, startupDelayMs } from "@herta/herta";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockWritable } from "../testing/mock-streams.js";
import {
  NarrativeRenderer,
  SLOW_STREAM_BASE_DELAY_MS,
} from "./narrative-renderer.js";
import { makeStyle } from "./style.js";

const TICK = SLOW_STREAM_BASE_DELAY_MS;

const plainStyle = makeStyle({ enabled: false });

function mk(): { out: MockWritable; r: NarrativeRenderer } {
  const out = new MockWritable();
  const r = new NarrativeRenderer(out, plainStyle);
  return { out, r };
}

describe("NarrativeRenderer — empty record", () => {
  it("does not write anything for an empty record", () => {
    const { out, r } = mk();
    r.update([]);
    expect(out.full()).toBe("");
  });
});

describe("NarrativeRenderer — user blocks", () => {
  it("skips user blocks (no echo)", () => {
    const { out, r } = mk();
    const record: TerminalRecord = [{ kind: "user", text: "黑塔女士，在吗？" }];
    r.update(record);
    expect(out.full()).toBe("");
  });
});

describe("NarrativeRenderer — herta blocks", () => {
  it("renders herta block text followed by a newline", () => {
    const { out, r } = mk();
    const record: TerminalRecord = [
      { kind: "herta", surface: "speech", text: "说事。你最好真的有事。" },
    ];
    r.update(record);
    expect(out.full()).toBe("说事。你最好真的有事。\n");
  });

  it("does not add an extra newline if text already ends with one", () => {
    const { out, r } = mk();
    const record: TerminalRecord = [
      { kind: "herta", surface: "speech", text: "好。\n" },
    ];
    r.update(record);
    expect(out.full()).toBe("好。\n");
  });
});

describe("NarrativeRenderer — display hygiene (slice 6)", () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const RLO = String.fromCharCode(0x202e);

  it("strips ANSI/OSC sequences from streamed herta tokens (raw-TTY injection)", () => {
    const { out, r } = mk();
    r.beginHertaStream("speech");
    r.streamHertaToken(`${ESC}]0;pwned${BEL}你好${ESC}[2J`);
    r.endHertaStream();
    expect(out.full()).not.toContain(ESC);
    expect(out.full()).toContain("]0;pwned你好[2J");
  });

  it("strips control/bidi chars from rendered herta blocks (disk-loaded legacy)", () => {
    const { out, r } = mk();
    r.update([
      { kind: "herta", surface: "speech", text: `${RLO}倒着念${ESC}[31m` },
    ]);
    expect(out.full()).toBe("倒着念[31m\n");
  });

  it("strips escapes from system block bodies (hostile build output)", () => {
    const { out, r } = mk();
    r.update([
      {
        kind: "system",
        label: "系统",
        body: `line1${ESC}[1;31m\nline2`,
      },
    ]);
    expect(out.full()).not.toContain(ESC);
    expect(out.full()).toContain("  line1[1;31m\n  line2\n");
  });
});

describe("NarrativeRenderer — system blocks", () => {
  it("renders → 系统 header and indented body", () => {
    const { out, r } = mk();
    const record: TerminalRecord = [
      {
        kind: "system",
        label: "系统",
        body: "[文件内容：foo.ts]\nexport const x = 1;",
      },
    ];
    r.update(record);
    expect(out.full()).toBe(
      "→ 系统\n  [文件内容：foo.ts]\n  export const x = 1;\n",
    );
  });

  it("renders → 差分协处理器 header and indented body", () => {
    const { out, r } = mk();
    const record: TerminalRecord = [
      { kind: "system", label: "差分协处理器", body: "accepted" },
    ];
    r.update(record);
    expect(out.full()).toBe("→ 差分协处理器\n  accepted\n");
  });

  it("indents each body line independently", () => {
    const { out, r } = mk();
    const record: TerminalRecord = [
      {
        kind: "system",
        label: "系统",
        body: "line 1\nline 2\nline 3",
      },
    ];
    r.update(record);
    expect(out.full()).toBe("→ 系统\n  line 1\n  line 2\n  line 3\n");
  });

  it("does not emit a blank indented line when body ends with \\n", () => {
    const { out, r } = mk();
    r.update([{ kind: "system", label: "系统", body: "line 1\n" }]);
    expect(out.full()).toBe("→ 系统\n  line 1\n");
  });

  it("renders a single blank indented line for an empty body", () => {
    // Empty body still gets the header. The empty body produces zero indented
    // lines after the trailing-empty drop — header-only output is the
    // expected behavior.
    const { out, r } = mk();
    r.update([{ kind: "system", label: "差分协处理器", body: "" }]);
    expect(out.full()).toBe("→ 差分协处理器\n");
  });

  it("never writes a system block's evidenceDetail to stdout (Herta-only overlay)", () => {
    // D7: `evidenceDetail` is the Herta-prompt-only tail of a system block
    // (e.g. the done-marker roll-up / command-output tail). The CLI render is
    // terse: `renderSystem` reads `block.body` ONLY. evidenceDetail must NEVER
    // reach the user's stdout — it's an overlay Herta sees in her prompt, not
    // the shared terminal record. This guards against a future change that
    // accidentally surfaces the evidence tail on screen.
    const { out, r } = mk();
    const record: TerminalRecord = [
      {
        kind: "system",
        label: "差分协处理器",
        body: "↳ exit 0 · 1 lines",
        evidenceDetail: "↳ 输出:\nSECRET_TAIL_42",
        role: "done-marker",
      },
    ];
    r.update(record);
    const rendered = out.full();
    expect(rendered).toContain("exit 0"); // body IS rendered
    expect(rendered).not.toContain("SECRET_TAIL_42"); // evidenceDetail is NOT
  });
});

describe("NarrativeRenderer — EN system-block localization", () => {
  const mkEn = (): { out: MockWritable; r: NarrativeRenderer } => {
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle, { lang: "en" });
    return { out, r };
  };

  it("localizes the 系统 label to → System", () => {
    const { out, r } = mkEn();
    r.update([{ kind: "system", label: "系统", body: "Reading foo.ts" }]);
    expect(out.full()).toBe("→ System\n  Reading foo.ts\n");
  });

  it("localizes the 差分协处理器 label to → Coprocessor", () => {
    const { out, r } = mkEn();
    r.update([
      { kind: "system", label: "差分协处理器", body: "Reading foo.ts" },
    ]);
    expect(out.full()).toBe("→ Coprocessor\n  Reading foo.ts\n");
  });

  it("recomposes a done-marker roll-up in English from markerSummary", () => {
    const { out, r } = mkEn();
    r.update([
      {
        kind: "system",
        label: "差分协处理器",
        body: "完成 · 2 files · tests 89/89 · 1 风险",
        role: "done-marker",
        markerSummary: {
          kind: "done",
          state: "completed",
          fileCount: 2,
          tests: { passed: 89, failed: 0 },
          riskCount: 1,
        },
      },
    ]);
    const full = out.full();
    expect(full).toBe(
      "→ Coprocessor\n  Done · 2 files · tests 89/89 · 1 risk\n",
    );
    expect(full).not.toContain("完成");
    expect(full).not.toContain("风险");
  });

  it("recomposes a failed done-marker (tests-failed variant)", () => {
    const { out, r } = mkEn();
    r.update([
      {
        kind: "system",
        label: "差分协处理器",
        body: "失败 · tests 3 passed, 2 failed · 1 风险",
        role: "done-marker",
        markerSummary: {
          kind: "done",
          state: "failed",
          fileCount: 0,
          tests: { passed: 3, failed: 2 },
          riskCount: 1,
        },
      },
    ]);
    expect(out.full()).toBe(
      "→ Coprocessor\n  Failed · tests 3 passed, 2 failed · 1 risk\n",
    );
  });

  it("localizes the noop-marker body", () => {
    const { out, r } = mkEn();
    r.update([
      {
        kind: "system",
        label: "差分协处理器",
        body: "无产出 — 这次没有触发任何文件、目录或命令操作。",
        role: "noop-marker",
      },
    ]);
    const full = out.full();
    expect(full).toContain("→ Coprocessor");
    expect(full).toContain("No output");
    expect(full).not.toContain("无产出");
  });

  it("passes an already-English activity body through (only the label localizes)", () => {
    const { out, r } = mkEn();
    r.update([
      {
        kind: "system",
        label: "差分协处理器",
        body: "↳ tests: 12/12 passed",
        digest: { kind: "tests", status: "passed", summary: "12/12 passed" },
      },
    ]);
    expect(out.full()).toBe("→ Coprocessor\n  ↳ tests: 12/12 passed\n");
  });

  it("zh is unchanged: the same done-marker renders the CN body verbatim", () => {
    const { out, r } = mk(); // zh (default)
    r.update([
      {
        kind: "system",
        label: "差分协处理器",
        body: "完成 · 2 files · tests 89/89 · 1 风险",
        role: "done-marker",
        markerSummary: {
          kind: "done",
          state: "completed",
          fileCount: 2,
          tests: { passed: 89, failed: 0 },
          riskCount: 1,
        },
      },
    ]);
    expect(out.full()).toBe(
      "→ 差分协处理器\n  完成 · 2 files · tests 89/89 · 1 风险\n",
    );
  });

  it("recomposes the bridge-failure marker as 'Failed · run aborted' — no synthetic risk", () => {
    const { out, r } = mkEn();
    r.update([
      {
        kind: "system",
        label: "差分协处理器",
        body: "失败 · 运行异常中止",
        role: "done-marker",
        markerSummary: {
          kind: "done",
          state: "failed",
          fileCount: 0,
          riskCount: 0,
          aborted: true,
        },
      },
    ]);
    const full = out.full();
    expect(full).toBe("→ Coprocessor\n  Failed · run aborted\n");
    expect(full).not.toContain("risk");
  });

  it("recomposes the seal's marker with the app-exit word (ADR 0071 §1.2)", () => {
    const { out, r } = mkEn();
    r.update([
      {
        kind: "system",
        label: "差分协处理器",
        body: "中断 · 1 个文件 · 应用意外退出",
        role: "done-marker",
        markerSummary: {
          kind: "done",
          state: "interrupted",
          fileCount: 1,
          riskCount: 0,
          crashed: true,
        },
      },
    ]);
    expect(out.full()).toBe(
      "→ Coprocessor\n  Stopped · 1 file · the app exited unexpectedly\n",
    );
  });

  it("recomposes a step-limit marker with its word (2026-09-29)", () => {
    const { out, r } = mkEn();
    r.update([
      {
        kind: "system",
        label: "差分协处理器",
        body: "中断 · 步数已达上限",
        role: "done-marker",
        markerSummary: {
          kind: "done",
          state: "interrupted",
          fileCount: 0,
          riskCount: 0,
          stepLimit: true,
        },
      },
    ]);
    expect(out.full()).toBe("→ Coprocessor\n  Stopped · step limit reached\n");
  });

  it("an unknown system label falls back to the stored label — never → undefined", () => {
    // Corrupt / hand-edited / future-version JSONL can carry a label outside
    // the union; the display must not render `→ undefined`.
    const { out, r } = mkEn();
    r.update([
      {
        kind: "system",
        label: "神秘标签" as unknown as "系统",
        body: "whatever",
      },
    ]);
    expect(out.full()).toBe("→ 神秘标签\n  whatever\n");
  });
});

describe("collapseLongDiffs — pure helper", () => {
  it("passes bodies without a diff fence through unchanged", () => {
    const body = "[文件内容：foo.ts]\nexport const x = 1;\nexport const y = 2;";
    expect(collapseLongDiffs(body, 20)).toBe(body);
  });

  it("passes short diffs (≤ maxLines) through unchanged", () => {
    const body = [
      "patch preview: foo.ts",
      "",
      "```diff",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "```",
    ].join("\n");
    expect(collapseLongDiffs(body, 20)).toBe(body);
  });

  it("truncates long diffs to maxLines content lines + a footer", () => {
    const diffLines: string[] = [];
    for (let i = 0; i < 50; i++) diffLines.push(`+line${i}`);
    const body = ["```diff", ...diffLines, "```"].join("\n");
    const out = collapseLongDiffs(body, 10);
    const outLines = out.split("\n");
    // Fence open + (maxLines-1) kept + 1 footer + fence close
    expect(outLines[0]).toBe("```diff");
    expect(outLines[outLines.length - 1]).toBe("```");
    const innerLines = outLines.slice(1, -1);
    expect(innerLines).toHaveLength(10); // 9 kept + 1 footer
    expect(innerLines[0]).toBe("+line0");
    expect(innerLines[8]).toBe("+line8");
    // Footer reports how many were suppressed.
    expect(innerLines[9]).toMatch(
      /^… \(41 more lines suppressed — full diff in evidence\)$/,
    );
  });

  it("preserves prose around the fenced diff verbatim", () => {
    const diffLines: string[] = [];
    for (let i = 0; i < 30; i++) diffLines.push(`+line${i}`);
    const body = [
      "patch preview: scripts/merge-sort.ts",
      "",
      "```diff",
      ...diffLines,
      "```",
      "",
      "appendix prose stays",
    ].join("\n");
    const out = collapseLongDiffs(body, 10);
    expect(out).toContain("patch preview: scripts/merge-sort.ts");
    expect(out).toContain("appendix prose stays");
    expect(out).toContain("21 more lines suppressed");
  });

  it("returns body unchanged when maxLines is Infinity (operator opt-out)", () => {
    const diffLines: string[] = [];
    for (let i = 0; i < 50; i++) diffLines.push(`+line${i}`);
    const body = ["```diff", ...diffLines, "```"].join("\n");
    expect(collapseLongDiffs(body, Number.POSITIVE_INFINITY)).toBe(body);
  });

  it("handles a malformed (unclosed) diff fence by treating the tail as content", () => {
    // No closing ``` — degrade gracefully rather than crashing.
    const diffLines: string[] = [];
    for (let i = 0; i < 30; i++) diffLines.push(`+line${i}`);
    const body = ["```diff", ...diffLines].join("\n");
    const out = collapseLongDiffs(body, 10);
    expect(out.split("\n")[0]).toBe("```diff");
    expect(out).toContain("21 more lines suppressed");
  });

  it("does not touch fences with a different language tag (only ```diff)", () => {
    const longCode: string[] = [];
    for (let i = 0; i < 30; i++) longCode.push(`console.log(${i});`);
    const body = ["```ts", ...longCode, "```"].join("\n");
    // ```ts is not the diff fence — pass through unchanged.
    expect(collapseLongDiffs(body, 10)).toBe(body);
  });

  it("processes multiple diff fences in the same body independently", () => {
    const a: string[] = [];
    for (let i = 0; i < 40; i++) a.push(`+a${i}`);
    const b: string[] = [];
    for (let i = 0; i < 30; i++) b.push(`+b${i}`);
    const body = [
      "first diff:",
      "```diff",
      ...a,
      "```",
      "",
      "second diff:",
      "```diff",
      ...b,
      "```",
    ].join("\n");
    const out = collapseLongDiffs(body, 10);
    expect(out).toContain("31 more lines suppressed");
    expect(out).toContain("21 more lines suppressed");
  });
});

describe("NarrativeRenderer — system block diff collapse (live render)", () => {
  it("renders the truncated diff and a suppression footer in dim", () => {
    const diffLines: string[] = [];
    for (let i = 0; i < 40; i++) diffLines.push(`+line${i}`);
    const body = [
      "patch preview: scripts/merge-sort.ts",
      "",
      "```diff",
      ...diffLines,
      "```",
    ].join("\n");
    const { out, r } = mk();
    r.update([{ kind: "system", label: "系统", body }]);
    const text = out.full();
    expect(text).toContain("→ 系统");
    expect(text).toContain("patch preview: scripts/merge-sort.ts");
    expect(text).toContain("```diff");
    expect(text).toContain("+line0");
    // With the default cap (20), one fewer than 20 diff lines are
    // shown plus one footer line. So +line19 is NOT shown (line index
    // 19 = the 20th line, which slot is taken by the footer).
    expect(text).not.toContain("+line40"); // doesn't exist
    // Session language picks the footer's prose; `mk()` is a zh session.
    expect(text).toContain("行已略去");
  });

  it("writes the suppression footer in the session language", () => {
    const diffLines: string[] = [];
    for (let i = 0; i < 40; i++) diffLines.push(`+line${i}`);
    const body = ["```diff", ...diffLines, "```"].join("\n");
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle, { lang: "en" });
    r.update([{ kind: "system", label: "系统", body }]);
    const text = out.full();
    expect(text).toContain("more lines suppressed");
    expect(text).not.toContain("行已略去");
  });

  it("respects HERTA_DIFF_PREVIEW_MAX_LINES=unlimited (no collapse)", () => {
    const prev = process.env.HERTA_DIFF_PREVIEW_MAX_LINES;
    process.env.HERTA_DIFF_PREVIEW_MAX_LINES = "unlimited";
    try {
      const diffLines: string[] = [];
      for (let i = 0; i < 40; i++) diffLines.push(`+line${i}`);
      const body = ["```diff", ...diffLines, "```"].join("\n");
      const { out, r } = mk();
      r.update([{ kind: "system", label: "系统", body }]);
      const text = out.full();
      // All 40 lines present, no suppression footer.
      expect(text).toContain("+line0");
      expect(text).toContain("+line39");
      expect(text).not.toContain("行已略去");
    } finally {
      if (prev === undefined) {
        delete process.env.HERTA_DIFF_PREVIEW_MAX_LINES;
      } else {
        process.env.HERTA_DIFF_PREVIEW_MAX_LINES = prev;
      }
    }
  });

  it("respects HERTA_DIFF_PREVIEW_MAX_LINES=5 (custom cap)", () => {
    const prev = process.env.HERTA_DIFF_PREVIEW_MAX_LINES;
    process.env.HERTA_DIFF_PREVIEW_MAX_LINES = "5";
    try {
      const diffLines: string[] = [];
      for (let i = 0; i < 40; i++) diffLines.push(`+line${i}`);
      const body = ["```diff", ...diffLines, "```"].join("\n");
      const { out, r } = mk();
      r.update([{ kind: "system", label: "系统", body }]);
      const text = out.full();
      expect(text).toContain("+line0");
      expect(text).toContain("+line3"); // 4 lines kept (cap - 1 footer slot)
      expect(text).not.toContain("+line4");
      expect(text).toContain("另有 36 行已略去");
    } finally {
      if (prev === undefined) {
        delete process.env.HERTA_DIFF_PREVIEW_MAX_LINES;
      } else {
        process.env.HERTA_DIFF_PREVIEW_MAX_LINES = prev;
      }
    }
  });
});

describe("NarrativeRenderer — speech-then-tool-result flow (regression)", () => {
  // The user-reported bug: after a Herta speech that triggered an
  // inline tool call (e.g. `list_files("scripts/")`), the resulting
  // `→ 系统` block was appended to the record but NEVER rendered in
  // the CLI. The conversation then continued with a follow-up speech
  // appearing directly after the first one, no system block between
  // them. The actor's flow is:
  //   1. Streaming speech via begin/tokens/end (cursor +1)
  //   2. Append speech block to record (record length matches cursor)
  //   3. Tool fires, append → 系统 block to record (cursor lags by 1)
  //   4. Loop continues, flushBlocks(record) should render the system block
  //
  // This test reproduces that flow in isolation against a real
  // NarrativeRenderer instance and asserts the system block lands in
  // the output between the speech and any follow-up content.

  it("renders the system block when it lands AFTER a streamed speech (cursor accounting)", () => {
    const { out, r } = mk();
    // Simulate the user input (always added to record before streaming).
    const stepRecord1: TerminalRecord = [
      { kind: "user", text: "scripts 里有什么？" },
    ];
    r.flushBlocks(stepRecord1); // cursor: 0 → 1 (user is no-op render)

    // Stream the speech that contains the tool call. Cursor advances
    // by 1 on endHertaStream regardless of streamingSurface.
    r.beginHertaStream("speech");
    r.streamHertaToken('不错，这次路径给对了。\n\nlist_files("scripts/")');
    r.endHertaStream();

    // Now commit the speech block to the record AND append the
    // system block from the tool result — this matches the actor's
    // C3 speech-commit + toolPromise.await flow.
    const stepRecord2: TerminalRecord = [
      { kind: "user", text: "scripts 里有什么？" },
      {
        kind: "herta",
        surface: "speech",
        text: '不错，这次路径给对了。\n\nlist_files("scripts/")',
      },
      {
        kind: "system",
        label: "系统",
        body: "[目录内容：scripts/]\n- scripts/merge-sort.ts",
      },
    ];

    // Next iter's flushBlocks. Cursor=2 (speech consumed), record.length=3.
    // The system block at index 2 MUST be rendered here.
    r.flushBlocks(stepRecord2);

    const output = out.full();
    // Speech content present.
    expect(output).toContain('list_files("scripts/")');
    // System block present.
    expect(output).toContain("→ 系统");
    expect(output).toContain("[目录内容：scripts/]");
    expect(output).toContain("scripts/merge-sort.ts");
    // Critical ordering: system block appears AFTER the speech.
    expect(output.indexOf("→ 系统")).toBeGreaterThan(
      output.indexOf('list_files("scripts/")'),
    );
  });

  it("renders the system block when slow-stream's fastForward drove the speech (production path)", async () => {
    // Reproduces the EXACT production path:
    //   1. user input added to record, flushBlocks at iter start
    //   2. supervisor block kicks off slowStreamSpeech (non-TTY here
    //      defers, but fastForward emits via begin/token/end)
    //   3. fastForward awaited → cursor advances past the speech
    //   4. speech committed to record
    //   5. tool result appended to record
    //   6. continue → iter N+1 flushBlocks → should render system
    //
    // The previous test passed; this one stresses the same flow but
    // with the slow-stream controller in between. If a cursor double-
    // advance happens anywhere on this path, this test catches it.
    const { out, r } = mk();
    const stepRecord1: TerminalRecord = [
      { kind: "user", text: "scripts 里有什么？" },
    ];
    r.flushBlocks(stepRecord1);

    // Slow-stream + fastForward — this is what the supervisor block
    // calls on OK verdict. Non-TTY mode (MockWritable defaults to
    // isTTY=false) means the controller defers; fastForward emits.
    const speechText = '不错，这次路径给对了。\n\nlist_files("scripts/")';
    const ctrl = r.slowStreamSpeech(speechText);
    await ctrl.fastForward();

    const stepRecord2: TerminalRecord = [
      { kind: "user", text: "scripts 里有什么？" },
      { kind: "herta", surface: "speech", text: speechText },
      {
        kind: "system",
        label: "系统",
        body: "[目录内容：scripts/]\n- scripts/merge-sort.ts",
      },
    ];
    r.flushBlocks(stepRecord2);

    const output = out.full();
    expect(output).toContain('list_files("scripts/")');
    expect(output).toContain("→ 系统");
    expect(output).toContain("[目录内容：scripts/]");
    expect(output).toContain("scripts/merge-sort.ts");
    expect(output.indexOf("→ 系统")).toBeGreaterThan(
      output.indexOf('list_files("scripts/")'),
    );
  });

  it("renders system block in TTY mode after fastForward drains slow-stream (the user's environment)", async () => {
    // The user's CLI is running on a real terminal (TTY=true), so
    // slow-stream takes the TTY path: setTimeout-scheduled char-by-
    // char emission, fastForward drains at min cadence. This test
    // forces isTTY=true so we exercise that exact path under fake
    // timers.
    vi.useFakeTimers();
    try {
      const out = new MockWritable();
      // Inject isTTY=true explicitly via the constructor option.
      const r = new NarrativeRenderer(out, plainStyle, { isTTY: true });

      const stepRecord1: TerminalRecord = [
        { kind: "user", text: "scripts 里有什么？" },
      ];
      r.flushBlocks(stepRecord1);

      const speechText = '看看。list_files("scripts/")';
      const ctrl = r.slowStreamSpeech(speechText);
      // Concurrently fastForward AND advance timers so the slow-
      // stream's setTimeout chain runs to completion.
      const ffPromise = ctrl.fastForward();
      await vi.advanceTimersByTimeAsync(10_000);
      await ffPromise;

      const stepRecord2: TerminalRecord = [
        ...stepRecord1,
        { kind: "herta", surface: "speech", text: speechText },
        {
          kind: "system",
          label: "系统",
          body: "[目录内容：scripts/]\n- scripts/merge-sort.ts",
        },
      ];
      r.flushBlocks(stepRecord2);

      const output = out.full();
      expect(output).toContain('list_files("scripts/")');
      expect(output).toContain("→ 系统");
      expect(output).toContain("scripts/merge-sort.ts");
      expect(output.indexOf("→ 系统")).toBeGreaterThan(
        output.indexOf('list_files("scripts/")'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders system block through a full think-speak-tool-think-speak cycle", async () => {
    // Simulates: iter 1 thought, iter 1 speech-with-tool, system
    // block appended, iter 2 thought, iter 2 speech. Each thought
    // begin/end pair advances cursor; the system block must NOT be
    // lost in the cursor accounting across multiple thought streams.
    const { out, r } = mk();
    const baseRecord: TerminalRecord = [
      { kind: "user", text: "scripts 里有什么？" },
    ];
    r.flushBlocks(baseRecord);

    // iter 1 thought (begin/end pair advances cursor by 1)
    r.beginHertaStream("thought");
    r.endHertaStream();

    const afterThought1: TerminalRecord = [
      ...baseRecord,
      { kind: "herta", surface: "thought", text: "他要找..." },
    ];
    r.flushBlocks(afterThought1);

    // iter 1 speech via slow-stream (the supervised + tool path)
    const speech1 = '看看。list_files("scripts/")';
    const ctrl1 = r.slowStreamSpeech(speech1);
    await ctrl1.fastForward();

    const afterSpeech1: TerminalRecord = [
      ...afterThought1,
      { kind: "herta", surface: "speech", text: speech1 },
      {
        kind: "system",
        label: "系统",
        body: "[目录内容：scripts/]\n- scripts/merge-sort.ts",
      },
    ];
    r.flushBlocks(afterSpeech1);

    // iter 2 thought
    r.beginHertaStream("thought");
    r.endHertaStream();

    const afterThought2: TerminalRecord = [
      ...afterSpeech1,
      { kind: "herta", surface: "thought", text: "他只列了..." },
    ];
    r.flushBlocks(afterThought2);

    // iter 2 speech
    const speech2 = "唔，只有 merge-sort.ts。";
    const ctrl2 = r.slowStreamSpeech(speech2);
    await ctrl2.fastForward();

    const finalRecord: TerminalRecord = [
      ...afterThought2,
      { kind: "herta", surface: "speech", text: speech2 },
    ];
    r.flushBlocks(finalRecord);

    const output = out.full();
    // Both speeches rendered.
    expect(output).toContain('list_files("scripts/")');
    expect(output).toContain("唔，只有 merge-sort.ts。");
    // System block rendered.
    expect(output).toContain("→ 系统");
    expect(output).toContain("scripts/merge-sort.ts");
    // Critical ordering: speech1 → system → speech2.
    const idxSpeech1 = output.indexOf('list_files("scripts/")');
    const idxSystem = output.indexOf("→ 系统");
    const idxSpeech2 = output.indexOf("唔，只有");
    expect(idxSpeech1).toBeGreaterThanOrEqual(0);
    expect(idxSystem).toBeGreaterThan(idxSpeech1);
    expect(idxSpeech2).toBeGreaterThan(idxSystem);
  });
});

describe("NarrativeRenderer — differential update", () => {
  it("does not re-render blocks already shown", () => {
    const { out, r } = mk();
    r.update([{ kind: "herta", surface: "speech", text: "first" }]);
    expect(out.full()).toBe("first\n");
    r.update([
      { kind: "herta", surface: "speech", text: "first" },
      { kind: "herta", surface: "speech", text: "second" },
    ]);
    expect(out.full()).toBe("first\nsecond\n");
  });

  it("renders multiple newly-appended blocks in order", () => {
    const { out, r } = mk();
    r.update([
      { kind: "user", text: "看 foo.ts" },
      { kind: "herta", surface: "speech", text: "好。" },
      {
        kind: "system",
        label: "系统",
        body: "[文件内容：foo.ts]\nexport const x = 1;",
      },
      { kind: "herta", surface: "speech", text: "看完了。" },
    ]);
    expect(out.full()).toBe(
      [
        "好。\n",
        "→ 系统\n",
        "  [文件内容：foo.ts]\n",
        "  export const x = 1;\n",
        "看完了。\n",
      ].join(""),
    );
  });

  it("no-ops when called with an empty record after prior update", () => {
    const { out, r } = mk();
    r.update([{ kind: "herta", surface: "speech", text: "first" }]);
    r.update([]);
    expect(out.full()).toBe("first\n");
  });
});

describe("NarrativeRenderer — streaming", () => {
  it("streamHertaToken writes bright text and does not advance cursor", () => {
    const { out, r } = mk();
    r.streamHertaToken("你好");
    expect(out.full()).toBe("你好");
    // No cursor advance yet — endHertaStream is what advances.
    // Verify by appending a record with the streamed block + a fresh herta;
    // the streamed block should be skipped, the fresh one rendered.
  });

  it("endHertaStream writes trailing newline and advances cursor", () => {
    const { out, r } = mk();
    r.streamHertaToken("你好");
    r.endHertaStream();
    expect(out.full()).toBe("你好\n");
    // Cursor should now be at 1. Verify by updating with a single herta
    // block — it must be SKIPPED (already streamed).
    r.update([{ kind: "herta", surface: "speech", text: "你好" }]);
    expect(out.full()).toBe("你好\n"); // unchanged
  });

  it("endHertaStream does not write a second newline if streamHertaToken ended with one", () => {
    const { out, r } = mk();
    r.streamHertaToken("你好\n");
    r.endHertaStream();
    // Expected behaviour: endHertaStream always writes "\n" — duplicate
    // newlines are acceptable; the actor's text rarely ends in newline
    // before the stop tag. Test for the actual rendered output.
    expect(out.full()).toBe("你好\n\n");
    // Comment: this matches the existing renderHerta behavior, which writes
    // `\n` if text doesn't end with one. The streaming path is simpler —
    // always write `\n` after the last token.
  });

  it("multiple streamHertaToken calls concatenate", () => {
    const { out, r } = mk();
    r.streamHertaToken("你");
    r.streamHertaToken("好");
    r.streamHertaToken("。");
    r.endHertaStream();
    expect(out.full()).toBe("你好。\n");
  });

  it("streamHertaToken with empty string is a no-op", () => {
    const { out, r } = mk();
    r.streamHertaToken("");
    expect(out.full()).toBe("");
  });

  it("endHertaStream is a no-op when not streaming (no prior streamHertaToken)", () => {
    const { out, r } = mk();
    r.endHertaStream();
    // No newline emitted because nothing was streamed. But cursor still
    // advances (the position is claimed).
    expect(out.full()).toBe("");
  });

  it("flushBlocks renders new blocks since last call", () => {
    const { out, r } = mk();
    // Simulate a turn where the user block is appended then flushed.
    r.flushBlocks([{ kind: "user", text: "看 foo.ts" }]);
    expect(out.full()).toBe(""); // user blocks skipped
    // Then a system block lands.
    r.flushBlocks([
      { kind: "user", text: "看 foo.ts" },
      { kind: "system", label: "系统", body: "ok" },
    ]);
    expect(out.full()).toBe("→ 系统\n  ok\n");
  });

  it("cancelStream resets streaming state and writes newline if mid-stream", () => {
    const { out, r } = mk();
    r.streamHertaToken("partial");
    r.cancelStream();
    expect(out.full()).toBe("partial\n");
    // Cursor was NOT advanced by cancelStream — the herta block was never
    // appended to the record. Verify by updating with an empty record; no-op.
    r.update([]);
    expect(out.full()).toBe("partial\n");
  });

  it("cancelStream is a no-op when not streaming", () => {
    const { out, r } = mk();
    r.cancelStream();
    expect(out.full()).toBe("");
  });

  it("stream + flushBlocks + stream pattern (one full turn)", () => {
    const { out, r } = mk();
    // Turn flow: flush (user block, skipped) → stream herta-1 → end →
    // flush (system block) → stream herta-2 → end → final update (no-op).
    r.flushBlocks([{ kind: "user", text: "U" }]);
    r.streamHertaToken("first");
    r.endHertaStream();
    r.flushBlocks([
      { kind: "user", text: "U" },
      { kind: "herta", surface: "speech", text: "first" },
      { kind: "system", label: "系统", body: "sys" },
    ]);
    r.streamHertaToken("second");
    r.endHertaStream();
    r.update([
      { kind: "user", text: "U" },
      { kind: "herta", surface: "speech", text: "first" },
      { kind: "system", label: "系统", body: "sys" },
      { kind: "herta", surface: "speech", text: "second" },
    ]);
    expect(out.full()).toBe(
      [
        "first\n", // streamed herta-1
        "→ 系统\n", // flushed system block
        "  sys\n",
        "second\n", // streamed herta-2
        // Final update is a no-op (cursor already at record.length).
      ].join(""),
    );
  });

  it("update after endHertaStream skips the streamed herta block", () => {
    const { out, r } = mk();
    r.streamHertaToken("streamed");
    r.endHertaStream();
    // Now append the streamed block + a fresh system block.
    r.update([
      { kind: "herta", surface: "speech", text: "streamed" },
      { kind: "system", label: "系统", body: "after" },
    ]);
    expect(out.full()).toBe(
      [
        "streamed\n", // from the stream
        "→ 系统\n", // from the update (rendered normally)
        "  after\n",
      ].join(""),
    );
  });
});

describe("NarrativeRenderer — thought surface (Slice 10)", () => {
  it("beginHertaStream('thought') writes the dim (思考中…) indicator at the cursor (no trailing newline)", () => {
    const { out, r } = mk();
    r.beginHertaStream("thought");
    const written = out.full();
    expect(written).toContain("(思考中…)");
    // No trailing newline — the cursor stays on the indicator's line so
    // endHertaStream's `\r\x1b[K` actually wipes the indicator in place.
    // (Earlier design wrote `(思考中…)\n` which moved the cursor to a
    // fresh line, and `\r\x1b[K` cleared only the empty line below,
    // leaving the indicator visible. Post-merge hotfix.)
    expect(written.endsWith("\n")).toBe(false);
  });

  it("streamHertaToken is a no-op while in thought surface", () => {
    const { out, r } = mk();
    r.beginHertaStream("thought");
    const beforeLen = out.chunks.length;
    r.streamHertaToken("内心独白文本");
    // No new chunks should have been written after the indicator.
    const afterOutput = out.chunks.slice(beforeLen).join("");
    expect(afterOutput).toBe("");
  });

  it("endHertaStream clears the indicator line via \\r\\x1b[K", () => {
    const { out, r } = mk();
    r.beginHertaStream("thought");
    const beforeLen = out.chunks.length;
    r.endHertaStream();
    const written = out.chunks.slice(beforeLen).join("");
    expect(written).toContain("\r\x1b[K");
  });

  it("beginHertaStream('speech') after endHertaStream of a thought does not re-emit the indicator", () => {
    const { out, r } = mk();
    r.beginHertaStream("thought");
    r.endHertaStream();
    const beforeLen = out.chunks.length;
    r.beginHertaStream("speech");
    r.streamHertaToken("好。");
    r.endHertaStream();
    const written = out.chunks.slice(beforeLen).join("");
    expect(written).toContain("好。");
    expect(written).not.toContain("(思考中…)");
  });

  it("beginHertaStream('speech') while a thought is still active clears the residual indicator", () => {
    const { out, r } = mk();
    r.beginHertaStream("thought");
    const beforeLen = out.chunks.length;
    r.beginHertaStream("speech");
    const written = out.chunks.slice(beforeLen).join("");
    expect(written).toContain("\r\x1b[K");
  });

  it("cancelStream mid-thought clears the indicator", () => {
    const { out, r } = mk();
    r.beginHertaStream("thought");
    const beforeLen = out.chunks.length;
    r.cancelStream();
    const written = out.chunks.slice(beforeLen).join("");
    expect(written).toContain("\r\x1b[K");
  });

  it("flushBlocks skips herta blocks with surface 'thought'", () => {
    const { out, r } = mk();
    const record: TerminalRecord = [
      { kind: "user", text: "在吗" },
      { kind: "herta", surface: "thought", text: "这个不值得回应" },
      { kind: "herta", surface: "speech", text: "在。" },
    ];
    r.flushBlocks(record);
    const written = out.full();
    expect(written).not.toContain("这个不值得回应");
    expect(written).toContain("在。");
  });

  it("flushBlocks advances internal cursor over thought blocks (does not re-evaluate on next flush)", () => {
    const { out, r } = mk();
    const record1: TerminalRecord = [
      { kind: "herta", surface: "thought", text: "x" },
    ];
    r.flushBlocks(record1);
    const beforeLen = out.chunks.length;
    const record2: TerminalRecord = [
      ...record1,
      { kind: "herta", surface: "speech", text: "y" },
    ];
    r.flushBlocks(record2);
    const written = out.chunks.slice(beforeLen).join("");
    expect(written).toContain("y");
    expect(written).not.toContain("x");
  });
});

describe("NarrativeRenderer — compaction hint (recap.compaction transient UI)", () => {
  it("beginCompactionHint writes the indicator text without a trailing newline", () => {
    const { out, r } = mk();
    r.beginCompactionHint();
    const written = out.full();
    expect(written).toContain("正在压缩对话记忆");
    // No trailing newline — cursor stays on the indicator's line so
    // endCompactionHint's `\r\x1b[K` erases it in place.
    expect(written.endsWith("\n")).toBe(false);
  });

  it("endCompactionHint writes \\r\\x1b[K to erase the indicator in place", () => {
    const { out, r } = mk();
    r.beginCompactionHint();
    const beforeLen = out.chunks.length;
    r.endCompactionHint();
    const written = out.chunks.slice(beforeLen).join("");
    expect(written).toContain("\r\x1b[K");
  });

  it("begin then end leaves no visible text (indicator is erased)", () => {
    const { out, r } = mk();
    r.beginCompactionHint();
    r.endCompactionHint();
    const written = out.full();
    // The raw bytes contain the indicator then the clear sequence, but the
    // net visible result is blank — the clear sequence overwrites the indicator.
    expect(written).toContain("\r\x1b[K");
  });

  it("subsequent herta speech renders normally after compaction hint clears", () => {
    const { out, r } = mk();
    r.beginCompactionHint();
    r.endCompactionHint();
    r.streamHertaToken("压缩完了。");
    r.endHertaStream();
    const written = out.full();
    expect(written).toContain("压缩完了。");
  });

  it("does not advance the block cursor (compaction hint is not a record block)", () => {
    const { out, r } = mk();
    r.update([{ kind: "herta", surface: "speech", text: "before" }]);
    r.beginCompactionHint();
    r.endCompactionHint();
    // Cursor should still be at 1; updating with the same record is a no-op.
    const beforeLen = out.chunks.length;
    r.update([{ kind: "herta", surface: "speech", text: "before" }]);
    // No new output should have been written by the second update (cursor already at 1).
    const afterAdditional = out.chunks.slice(beforeLen).join("");
    expect(afterAdditional).toBe("");
  });
});

describe("NarrativeRenderer.slowStreamSpeech — forward emission (TTY)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mkTty(): { out: MockWritable; r: NarrativeRenderer } {
    const out = new MockWritable();
    // Deterministic random returns 0.5 → jitter offset = 0 → base delay = TICK ms.
    const r = new NarrativeRenderer(out, plainStyle, {
      isTTY: true,
      random: () => 0.5,
    });
    return { out, r };
  }

  it("emits characters one at a time at base delay (no jitter, no punctuation)", async () => {
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("abc");
    // First character is scheduled after the initial TICK ms delay.
    expect(out.full()).toBe("");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("a");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("ab");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("abc");
    // One more tick: emitNext detects emittedCount >= chars.length,
    // calls endHertaStream (writes \n) and resolves done.
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("abc\n");
    await ctrl.done;
  });

  it("adds a 200 ms pause after punctuation", async () => {
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("a。b");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("a");
    // After 'a', the next scheduled delay is TICK ms.
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("a。");
    // After '。', the next delay is TICK + 200 ms.
    await vi.advanceTimersByTimeAsync(TICK + 200 - 1);
    expect(out.full()).toBe("a。"); // not yet
    await vi.advanceTimersByTimeAsync(1);
    expect(out.full()).toBe("a。b");
    await vi.advanceTimersByTimeAsync(TICK);
    await ctrl.done;
  });

  it("adds a 400 ms pause after a newline", async () => {
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("a\nb");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("a");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("a\n");
    // After '\n', the next delay is TICK + 400 ms.
    await vi.advanceTimersByTimeAsync(TICK + 400 - 1);
    expect(out.full()).toBe("a\n"); // still
    await vi.advanceTimersByTimeAsync(1);
    expect(out.full()).toBe("a\nb");
    await vi.advanceTimersByTimeAsync(TICK);
    await ctrl.done;
  });

  it("calls beginHertaStream exactly once (deferred to first emit)", async () => {
    const styled = makeStyle({ enabled: true });
    const out2 = new MockWritable();
    const r2 = new NarrativeRenderer(out2, styled, {
      isTTY: true,
      random: () => 0.5,
    });
    const ctrl = r2.slowStreamSpeech("a");
    expect(out2.full()).toBe(""); // no begin yet
    await vi.advanceTimersByTimeAsync(TICK);
    // After first char, the begin happened. Styled output wraps the
    // chunk in bright ANSI. The exact escape is implementation-detail;
    // assert that the char appears and the output is non-empty.
    expect(out2.full()).toContain("a");
    await vi.advanceTimersByTimeAsync(TICK);
    await ctrl.done;
  });

  it("resolves done() once the full text has been emitted", async () => {
    const { r } = mkTty();
    const ctrl = r.slowStreamSpeech("hi");
    // 2 chars × TICK ms, then one more tick for emitNext to
    // detect emittedCount >= chars.length and resolve done.
    await vi.advanceTimersByTimeAsync(TICK * 2 + TICK);
    await expect(ctrl.done).resolves.toBeUndefined();
  });

  it("emits empty text without scheduling any timer", async () => {
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("");
    // The first timer is scheduled with `computeFirstDelay`. With 0
    // chars, the emit loop immediately resolves `done` and exits
    // without calling beginHertaStream.
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("");
    await ctrl.done;
  });

  it("fastForward drains the remaining text at base cadence (verdict inaudible as speed change)", async () => {
    // 2026-06-11 revision: fastForward no longer uses a 8ms drain cadence.
    // Instead it re-arms at SLOW_STREAM_BASE_DELAY_MS and subsequent delays
    // are humanized. With random=0.5 (zero jitter), plain chars take TICK each.
    // The verdict must not be perceptible as a speed change.
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("a。bcd"); // 5 chars, one punctuation
    // Emit "a" then "。" at normal cadence.
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("a");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("a。");
    // At this point the pending timer is TICK+200 (punctuation pause after 。).
    // fastForward cancels that and re-arms at TICK (base cadence).
    const ff = ctrl.fastForward();
    // After TICK ms, "b" appears (fastForward re-armed at TICK, not 300ms).
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("a。b");
    // "c" and "d" at base cadence (plain chars, TICK each).
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("a。bc");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("a。bcd");
    // One more tick: completion emitNext writes \n.
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("a。bcd\n");
    await ff;
    await ctrl.done;
  });

  it("ramp-and-hold: streams front chars freely then holds at the hold index (V2, 2026-06-11)", async () => {
    // Replaces the V1 fixed-4x-multiplier test. With the shared
    // pacing policy (pacingDecision), a 4-char text has:
    //   holdIndex = min(floor(4 * 0.92), 3) = 3
    //   RAMP_START = 0.55  (progress 0–0.55 = 1x, above = ramp)
    //   cursors 0,1,2 → progress 0, 0.25, 0.5 → all < RAMP_START → 1x (TICK ms)
    //   cursor 3 → holdIndex → HOLD (both pre-emit and post-emit gates)
    //
    // So chars 'a','b','c' emit at TICK ms each; 'd' is held indefinitely
    // until the terminal call (fastForward / cancelAndBackspace).
    const { out, r } = mkTty();
    let resolvePending: () => void = () => {};
    const verdictPending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    const STARTUP = startupDelayMs({ total: 4, baseMs: TICK });
    const ctrl = r.slowStreamSpeech("abcd", { verdictPending });
    // Adaptive startup buffer: a supervised short line holds the first char up
    // front (under the in-flight hint) — nothing emits until it elapses.
    await vi.advanceTimersByTimeAsync(STARTUP);
    expect(out.full()).toBe("");
    // Then the first 3 chars emit at base cadence (TICK ms each).
    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(out.full()).toBe("abc");
    // Stream is now held at 'd'. No amount of time advances it.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(out.full()).toBe("abc");
    // fastForward drains the held tail.
    resolvePending();
    const ff = ctrl.fastForward();
    await vi.advanceTimersByTimeAsync(2_000);
    await ff;
    await ctrl.done;
    expect(out.full()).toContain("abcd");
  });

  it("holds the slow-stream short of completion while the verdict is pending", async () => {
    // 10-char CJK text; holdIndex = min(floor(10 * 0.92), 9) = min(9, 9) = 9.
    // The stream must hold before emitting the 10th char (index 9, "九"),
    // regardless of how much time passes.
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("零一二三四五六七八九", {
      verdictPending: new Promise<void>(() => {}),
    });
    ctrl.done.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(120_000);
    // 10 chars → holdIndex 9: the last char must NOT have been written.
    expect(out.full()).toContain("零一二三四五六七八");
    expect(out.full()).not.toContain("九");
  });

  it("fastForward drains a held stream at the drain cadence and resolves done", async () => {
    const { out, r } = mkTty();
    let resolveVerdict!: () => void;
    const ctrl = r.slowStreamSpeech("零一二三四五六七八九", {
      verdictPending: new Promise<void>((r) => {
        resolveVerdict = r;
      }),
    });
    await vi.advanceTimersByTimeAsync(120_000); // reach the hold
    resolveVerdict();
    const ff = ctrl.fastForward();
    await vi.advanceTimersByTimeAsync(2_000);
    await ff;
    await ctrl.done;
    expect(out.full()).toContain("零一二三四五六七八九");
  });

  it("does NOT throttle when verdictPending is omitted (default-open gate)", async () => {
    // Backwards-compat: callers that don't pass `verdictPending`
    // see the pre-V1 cadence — every char at base ~TICK ms.
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("abcd");
    await vi.advanceTimersByTimeAsync(TICK * 4);
    expect(out.full()).toBe("abcd");
    await vi.advanceTimersByTimeAsync(TICK); // completion tick
    expect(out.full()).toBe("abcd\n");
    await ctrl.done;
  });

  it("does NOT throttle in the pre-ramp region even when verdictPending is unresolved", async () => {
    // With the ramp+hold policy, chars before RAMP_START (0.55)
    // emit at 1x regardless of verdictPending. For 4-char text:
    //   cursors 0,1,2 → progress 0, 0.25, 0.5 → all < 0.55 → 1x
    //   cursor 3 → holdIndex=3 → HOLD
    // So 'abc' emits freely at TICK ms each; 'd' is held indefinitely.
    const { out, r } = mkTty();
    const verdictPending = new Promise<void>(() => {
      // never resolves — simulates a still-pending supervisor
    });
    const STARTUP = startupDelayMs({ total: 4, baseMs: TICK });
    const ctrl = r.slowStreamSpeech("abcd", { verdictPending });
    // Adaptive startup buffer first — nothing emits until it elapses.
    await vi.advanceTimersByTimeAsync(STARTUP);
    expect(out.full()).toBe("");
    // Then pre-ramp chars (indices 0, 1, 2) emit at base cadence.
    await vi.advanceTimersByTimeAsync(TICK * 2);
    expect(out.full()).toBe("ab");
    await vi.advanceTimersByTimeAsync(TICK);
    expect(out.full()).toBe("abc");
    // 'd' (index 3) is held. No amount of time advances it.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(out.full()).toBe("abc");
    // Force completion via fastForward. Even though verdictPending
    // never resolved, fastForward overrides.
    const ff = ctrl.fastForward();
    // The held tail ("d") drains at base cadence (TICK ms per char) — no speed burst.
    await vi.advanceTimersByTimeAsync(TICK * 2); // ample for the held char + completion
    await ff;
    expect(out.full()).toContain("abcd");
  });

  it("fastForward is a no-op after natural completion", async () => {
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("ab");
    // 2 chars × TICK ms emit, + TICK ms for completion detection.
    await vi.advanceTimersByTimeAsync(TICK * 3);
    await ctrl.done;
    expect(out.full()).toBe("ab\n");
    await expect(ctrl.fastForward()).resolves.toBeUndefined();
    expect(out.full()).toBe("ab\n"); // no double-end, no extra output
  });

  it("regression: full speech rendered EXACTLY ONCE after fastForward + flushBlocks (2026-05-23)", async () => {
    // User-reported: speech text rendered TWICE consecutively in the
    // CLI when the supervisor approved a non-tool speech. Root cause:
    //
    // The slow-stream's "completion" emitNext (which calls
    // endHertaStream + resolveDone) was scheduled on a SEPARATE
    // setTimeout tick AFTER the last char's emitNext. Sequence:
    //   t=0   slowStreamSpeech() starts setTimeout chain
    //   t=N   last-char emitNext: writes char, count = chars.length,
    //         scheduleNext(delay) → completion timer pending
    //   t=N'  supervisor returns OK (likely t=N' >= t=N, completion
    //         timer still pending in event queue)
    //         actor calls fastForward()
    //         PRE-FIX: fastForward checks `count >= chars.length`
    //         → TRUE → returns synchronously without awaiting done
    //         actor proceeds to speech-commit + final flushBlocks
    //         renderer's `rendered` cursor still BEHIND the record
    //         (endHertaStream not yet called)
    //         flushBlocks → renderHerta(text) re-emits → DUPLICATE
    //   t=>N  completion timer fires (way too late)
    //
    // Fix: fastForward now `await done` ALWAYS, even when
    // `emittedCount >= chars.length`. This forces it to wait for
    // the pending completion timer to fire, so endHertaStream + the
    // cursor advance happen BEFORE fastForward returns.
    //
    // This test reproduces the exact scenario: emit all chars at
    // natural cadence (last char fired, completion timer pending),
    // then `await fastForward()` (must wait for pending completion),
    // then flushBlocks the new record. Text must appear EXACTLY ONCE.
    const { out, r } = mkTty();
    const text = "abc";
    const ctrl = r.slowStreamSpeech(text);
    // Drain 3 chars × TICK ms — at this point all chars are written
    // to stdout but the completion timer hasn't fired yet.
    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(out.full()).toBe("abc");

    // fastForward must await the pending completion timer. With the
    // fix, vi.advanceTimersByTimeAsync was needed to let the
    // completion tick fire; we drive it concurrently here.
    const ffPromise = ctrl.fastForward();
    await vi.advanceTimersByTimeAsync(TICK);
    await ffPromise;

    // Cursor is now advanced (endHertaStream wrote "\n").
    expect(out.full()).toBe("abc\n");

    // Mimic the actor's downstream sync path: flushBlocks the new
    // record containing the herta-speech block.
    r.flushBlocks([{ kind: "herta", surface: "speech", text }]);

    // Critical: text must appear EXACTLY ONCE. Pre-fix this would
    // be "abc" (slow-stream chars, no endHertaStream's "\n") +
    // "abc\n" (renderHerta's re-emission). Post-fix: just "abc\n"
    // because fastForward properly waited for endHertaStream to
    // advance the cursor.
    const occurrences = out.full().split("abc").length - 1;
    expect(occurrences).toBe(1);
    expect(out.full()).toBe("abc\n");
  });
});

describe("NarrativeRenderer.slowStreamSpeech — non-TTY deferred path", () => {
  // Pre-2026-05-22 the non-TTY branch emitted synchronously on
  // construction, breaking verdict gating (the rejected speech showed
  // up AND the retry was appended after it). The new contract: defer
  // emission until fastForward, never emit on cancelAndBackspace.

  it("buffers text and emits nothing on construction (deferred)", async () => {
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle); // isTTY defaults to false
    r.slowStreamSpeech("hello");
    // No emission until fastForward / cancelAndBackspace is called.
    expect(out.full()).toBe("");
  });

  it("fastForward() emits the buffered text and resolves done (OK path)", async () => {
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle);
    const ctrl = r.slowStreamSpeech("hello");
    expect(out.full()).toBe("");
    await ctrl.fastForward();
    // Speech now visible (with the trailing newline from endHertaStream).
    expect(out.full()).toBe("hello\n");
    await expect(ctrl.done).resolves.toBeUndefined();
  });

  it("cancelAndBackspace() emits nothing and rejects done (veto path — bug-2 regression)", async () => {
    // This is the exact bug-2 fix: in non-TTY, cancelAndBackspace
    // used to be a silent no-op but the text was ALREADY on screen
    // (emitted synchronously on construction). The retry then
    // appended below it. Now: no emission AT ALL when cancelled.
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle);
    const ctrl = r.slowStreamSpeech("rejected speech");
    expect(out.full()).toBe("");
    await ctrl.cancelAndBackspace();
    // STILL nothing visible — the rejected speech never reached stdout.
    expect(out.full()).toBe("");
    // The done promise rejects, mirroring the TTY contract.
    await expect(ctrl.done).rejects.toThrow(/cancelled/);
  });

  it("fastForward is idempotent (second call is a no-op)", async () => {
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle);
    const ctrl = r.slowStreamSpeech("hello");
    await ctrl.fastForward();
    await ctrl.fastForward(); // second call: no extra emission
    expect(out.full()).toBe("hello\n");
  });

  it("cancelAndBackspace after fastForward is a no-op (already resolved)", async () => {
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle);
    const ctrl = r.slowStreamSpeech("hello");
    await ctrl.fastForward();
    // After fastForward the text is visible and done has resolved.
    // A late cancelAndBackspace must not retract or reject.
    await ctrl.cancelAndBackspace();
    expect(out.full()).toBe("hello\n");
    // The original resolve takes precedence — done stays resolved.
    await expect(ctrl.done).resolves.toBeUndefined();
  });

  it("emits nothing for empty text on fastForward (no spurious begin/end)", async () => {
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle);
    const ctrl = r.slowStreamSpeech("");
    await ctrl.fastForward();
    expect(out.full()).toBe("");
    await ctrl.done;
  });
});

describe("NarrativeRenderer.slowStreamSpeech — cancelAndBackspace (TTY)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mkTty(termCols = 80): { out: MockWritable; r: NarrativeRenderer } {
    const out = new MockWritable();
    // Simulate `process.stdout.columns` on a non-TTY MockWritable.
    Object.defineProperty(out, "columns", {
      value: termCols,
      writable: false,
    });
    const r = new NarrativeRenderer(out, plainStyle, {
      isTTY: true,
      random: () => 0.5,
    });
    return { out, r };
  }

  it("emits `\\b \\b` once per ASCII column when retracting mid-stream", async () => {
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("abc");
    await vi.advanceTimersByTimeAsync(TICK); // emit "a"
    await vi.advanceTimersByTimeAsync(TICK); // emit "b"
    expect(out.full()).toBe("ab");
    // Now cancel. Retract "b" then "a", 25 ms each.
    const cancelPromise = ctrl.cancelAndBackspace();
    await vi.advanceTimersByTimeAsync(25); // retract "b"
    expect(out.full()).toBe("ab\b \b");
    // Retract "a" (25 ms). 2026-05-23 V2: no trailing `\n` written
    // — cursor stays at col 0 of row 0 (the blanked text row) so
    // the retry overwrites it directly.
    await vi.advanceTimersByTimeAsync(25);
    expect(out.full()).toBe("ab\b \b\b \b");
    await cancelPromise;
    expect(out.full()).toBe("ab\b \b\b \b");
    // The original `done` promise should have rejected.
    await expect(ctrl.done).rejects.toThrow(/cancelled/);
  });

  it("emits two `\\b \\b` pairs per CJK character", async () => {
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("好");
    await vi.advanceTimersByTimeAsync(TICK); // emit "好"
    expect(out.full()).toBe("好");
    const cancelPromise = ctrl.cancelAndBackspace();
    // CJK char takes 2 columns → 2 `\b \b` pairs. No trailing `\n`.
    await vi.advanceTimersByTimeAsync(25);
    expect(out.full()).toBe("好\b \b\b \b");
    await cancelPromise;
    expect(out.full()).toBe("好\b \b\b \b");
  });

  it("repositions to the previous row's END when retracting across a newline (per-char erase continues)", async () => {
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("a\nb");
    await vi.advanceTimersByTimeAsync(TICK); // emit "a"
    await vi.advanceTimersByTimeAsync(TICK + 400); // emit "\n" (+400 pause)
    await vi.advanceTimersByTimeAsync(TICK); // emit "b"
    expect(out.full()).toBe("a\nb");
    const cancelPromise = ctrl.cancelAndBackspace();
    await vi.advanceTimersByTimeAsync(25); // retract "b"
    expect(out.full()).toBe("a\nb\b \b");
    // Crossing the newline backwards: cursor-up + right to the previous
    // row's end (width 1). The old `\x1b[2K` wiped the whole upper row at
    // once and left the per-char loop no-op'ing at col 0.
    await vi.advanceTimersByTimeAsync(25);
    expect(out.full()).toBe("a\nb\b \b\x1b[1A\x1b[1C");
    // Retract "a" CHAR-BY-CHAR. No trailing `\n` (V2): cursor stays at
    // col 0 of the first text row for the retry to overwrite.
    await vi.advanceTimersByTimeAsync(25);
    expect(out.full()).toBe("a\nb\b \b\x1b[1A\x1b[1C\b \b");
    await cancelPromise;
    expect(out.full()).toBe("a\nb\b \b\x1b[1A\x1b[1C\b \b");
  });

  it("repositions to the previous row's END when retracting across an auto-wrap (termCols boundary)", async () => {
    // Terminal is 3 columns wide. "abcd" → row1="abc", row2="d".
    const { out, r } = mkTty(3);
    const ctrl = r.slowStreamSpeech("abcd");
    await vi.advanceTimersByTimeAsync(TICK * 4);
    expect(out.full()).toBe("abcd");
    const cancelPromise = ctrl.cancelAndBackspace();
    // Retract "d" first.
    await vi.advanceTimersByTimeAsync(25);
    expect(out.full()).toBe("abcd\b \b");
    // Then cursor-up + right to row1's end (width 3), so its chars erase
    // one-by-one instead of the row wiping at once.
    await vi.advanceTimersByTimeAsync(25);
    expect(out.full()).toBe("abcd\b \b\x1b[1A\x1b[3C");
    // Retract "c", "b", "a". V2: no trailing `\n` — cursor stays at
    // col 0 of row 1 for the retry.
    await vi.advanceTimersByTimeAsync(75);
    expect(out.full()).toBe("abcd\b \b\x1b[1A\x1b[3C\b \b\b \b\b \b");
    await cancelPromise;
  });

  it("repositions the cursor when cancel fires AFTER natural emission completion (2026-05-23 regression)", async () => {
    // Bug: if the slow-stream emits all chars before the supervisor
    // verdict arrives, `emitNext` calls `endHertaStream` which
    // writes `\n` and advances the cursor to the row BELOW the
    // last text row. A subsequent `cancelAndBackspace` then walks
    // its retract loop from THAT cursor position — every `\b \b`
    // lands on an empty line and visually erases nothing, leaving
    // the rejected speech on screen above the retry.
    //
    // Fix: when cancelAndBackspace runs after a natural completion,
    // emit `\x1b[1A` (cursor up 1 row) + `\x1b[<n>C` (cursor right
    // to end of last text row) BEFORE the retract loop, and undo
    // the rendered++ bookkeeping. The final endHertaStream then
    // re-issues `\n` + rendered++ for net-same state as the
    // mid-stream cancel path.
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("abc");
    // Advance enough time to emit all 3 chars (3 × TICK ms) PLUS the
    // completion-emit which calls endHertaStream and resolves done.
    await vi.advanceTimersByTimeAsync(TICK * 4);
    // After natural completion: chars + trailing `\n`.
    expect(out.full()).toBe("abc\n");
    await expect(ctrl.done).resolves.toBeUndefined();

    const cancelPromise = ctrl.cancelAndBackspace();
    // First synchronous output: cursor-up + cursor-right-by-3
    // (lastRowWidth = 3 ASCII chars on row 0). This is what
    // moves the cursor back to the end of "abc" before retract.
    expect(out.full()).toBe("abc\n\x1b[1A\x1b[3C");
    // Then retract each char (25ms each). V2 (2026-05-23): no
    // trailing `\n` — cursor stays at col 0 of the (now-blanked)
    // text row so the retry overwrites it directly. Verifies the
    // "blank line above retry" regression stays fixed.
    await vi.advanceTimersByTimeAsync(75);
    expect(out.full()).toBe("abc\n\x1b[1A\x1b[3C\b \b\b \b\b \b");
    await cancelPromise;
  });

  it("repositions correctly on natural-completion cancel with CJK chars (column-width math)", async () => {
    // CJK chars are 2 columns each. For text "好好" (2 chars,
    // 4 columns total), the cursor-right offset must be 4, not 2.
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("好好");
    await vi.advanceTimersByTimeAsync(TICK * 3);
    expect(out.full()).toBe("好好\n");
    const cancelPromise = ctrl.cancelAndBackspace();
    expect(out.full()).toBe("好好\n\x1b[1A\x1b[4C");
    await vi.advanceTimersByTimeAsync(50);
    // V2: no trailing `\n`.
    expect(out.full()).toBe("好好\n\x1b[1A\x1b[4C\b \b\b \b\b \b\b \b");
    await cancelPromise;
  });

  it("retry stream starts at col 0 of the blanked text row — NO blank line above retry (V2 regression)", async () => {
    // User report: when supervisor vetoed Herta's speech, the
    // CLI retracted the rejected text BUT then wrote a trailing
    // `\n` that pushed the cursor down, so the retry rendered on
    // the line BELOW the blanked text — leaving a visible blank
    // line above the retry. This test pins the fix end-to-end:
    // cancelAndBackspace leaves the cursor at col 0 of the first
    // text row (no trailing `\n`), and the retry's begin/token/
    // end sequence then overwrites the blanked chars directly.
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("rejected");
    // Emit all 8 chars + the completion-emit (calls endHertaStream).
    await vi.advanceTimersByTimeAsync(TICK * 9);
    expect(out.full()).toBe("rejected\n");

    // Verdict comes back veto. Actor calls cancelAndBackspace.
    const cancelPromise = ctrl.cancelAndBackspace();
    // Cursor-up + cursor-right + 8 retract pairs.
    await vi.advanceTimersByTimeAsync(25 * 8);
    await cancelPromise;
    // After retract: cursor at col 0 of the (now-blanked) text row.
    // No trailing `\n` — that's the V2 fix.
    expect(out.full()).toBe(
      "rejected\n\x1b[1A\x1b[8C\b \b\b \b\b \b\b \b\b \b\b \b\b \b\b \b",
    );

    // Now the actor invokes the retry's runPhaseTwo which streams
    // via the sink's begin/token/end protocol. Simulate that.
    r.beginHertaStream("speech");
    r.streamHertaToken("retry");
    r.endHertaStream();
    // The raw lane reveals at the paced cadence on a TTY (2026-10-10).
    await vi.advanceTimersByTimeAsync(TICK * 10);

    // The retry's `r.beginHertaStream` writes nothing visible for
    // speech surface (just sets internal state). The reveal writes
    // "retry" at col 0 of the blanked text row, then "\n" to move the
    // cursor to the next line. So the total output appends "retry\n"
    // with NO extra blank line between the retract sequence and the
    // retry chars.
    expect(out.full()).toBe(
      "rejected\n\x1b[1A\x1b[8C\b \b\b \b\b \b\b \b\b \b\b \b\b \b\b \bretry\n",
    );
  });

  it("is idempotent — calling cancelAndBackspace again after completion is a no-op", async () => {
    const { out, r } = mkTty();
    const ctrl = r.slowStreamSpeech("a");
    await vi.advanceTimersByTimeAsync(TICK);
    const c1 = ctrl.cancelAndBackspace();
    await vi.advanceTimersByTimeAsync(25);
    await c1;
    const fullAfterFirst = out.full();
    await expect(ctrl.cancelAndBackspace()).resolves.toBeUndefined();
    expect(out.full()).toBe(fullAfterFirst);
  });

  it("non-TTY cancelAndBackspace discards the buffered speech (bug-2 fix)", async () => {
    // Updated 2026-05-22: pre-fix, non-TTY emitted on construction
    // and cancelAndBackspace was a silent no-op — the rejected
    // speech remained on screen. Post-fix, non-TTY defers emission
    // and cancelAndBackspace discards the buffer. The rejected
    // speech never reaches stdout, identical observable outcome to
    // TTY's retract.
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle); // non-TTY default
    const ctrl = r.slowStreamSpeech("hello");
    // Deferred: no emission yet.
    expect(out.full()).toBe("");
    // Veto path: cancel; the done promise rejects with the
    // cancellation error matching the TTY contract. We catch here
    // because the test isn't asserting the rejection details (the
    // dedicated non-TTY-veto test in the new describe block does).
    ctrl.cancelAndBackspace().catch(() => {});
    await ctrl.done.catch(() => {});
    // Still nothing visible — verdict-gating preserved.
    expect(out.full()).toBe("");
  });
});

describe("NarrativeRenderer — EN word-pacing + Brick alias (lang 'en')", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function mkEn(isTTY: boolean): { out: MockWritable; r: NarrativeRenderer } {
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle, {
      isTTY,
      random: () => 0.5, // zero jitter
      lang: "en",
    });
    return { out, r };
  }

  it("reveals whole WORDS, not letters, in an EN slow-stream", async () => {
    const { out, r } = mkEn(true);
    const ctrl = r.slowStreamSpeech("fix the parser now");
    // First unit fires after the ~100ms first-delay: the whole word "fix ",
    // NOT a lone "f" — the letter-by-letter symptom this fixes.
    await vi.advanceTimersByTimeAsync(100);
    expect(out.full()).toBe("fix ");
    // Drain the rest (unsupervised → completes on its own).
    await vi.advanceTimersByTimeAsync(20_000);
    await ctrl.done;
    expect(out.full()).toBe("fix the parser now\n");
  });

  it("renders @板砖 as @Brick in an EN slow-stream (display-only)", async () => {
    const { out, r } = mkEn(true);
    const ctrl = r.slowStreamSpeech("ask @板砖 to fix it");
    await vi.advanceTimersByTimeAsync(20_000);
    await ctrl.done;
    expect(out.full()).toBe("ask @Brick to fix it\n");
    expect(out.full()).not.toContain("板砖");
  });

  it("aliases committed @板砖 / bare 板砖 to Brick for EN (renderHerta / opening)", () => {
    const { out, r } = mkEn(false);
    r.update([
      {
        kind: "herta",
        surface: "speech",
        text: "hand it to @板砖. 板砖 idle.",
      },
    ]);
    expect(out.full()).toBe("hand it to @Brick. Brick idle.\n");
  });

  it("keeps @板砖 literal for a zh committed block (byte-identical)", () => {
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle); // default lang zh
    r.update([{ kind: "herta", surface: "speech", text: "交给 @板砖。" }]);
    expect(out.full()).toBe("交给 @板砖。\n");
  });

  it("veto retract erases the ALIASED column count (@Brick = 6 cols, not @板砖's 5)", async () => {
    const { out, r } = mkEn(true);
    const ctrl = r.slowStreamSpeech("@板砖");
    ctrl.done.catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000); // reveal "@Brick\n"
    expect(out.full()).toBe("@Brick\n");
    const cancel = ctrl.cancelAndBackspace();
    await vi.advanceTimersByTimeAsync(20_000); // drive the retract sleeps
    await cancel;
    // 6 narrow columns of "@Brick" → 6 backspace-space-backspace sequences.
    // (Were emittedChars keyed on the raw @板砖 it would erase 1+2+2=5, leaving
    // one column of residue.)
    const erases = out.full().split("\b \b").length - 1;
    expect(erases).toBe(6);
  });

  it("aliases a 板砖 split across two raw streamHertaToken chunks (EN beats lane)", () => {
    const { out, r } = mkEn(false);
    r.beginHertaStream("speech");
    r.streamHertaToken("hand it to @板"); // ends in 板 → held
    r.streamHertaToken("砖 now"); // 砖 completes the token → Brick
    r.endHertaStream();
    expect(out.full()).toBe("hand it to @Brick now\n");
  });

  it("flushes a genuine standalone 板 on endHertaStream (styled, before the newline)", () => {
    const { out, r } = mkEn(false);
    r.beginHertaStream("speech");
    r.streamHertaToken("a 板"); // ends in 板 → held; "a " written
    r.endHertaStream(); // flush the real 板
    expect(out.full()).toBe("a 板\n");
  });

  // Code-aware display alias (audit 2026-07-16): parity with the GUI, whose
  // tokenizer exempts code nodes and whose bubble exempts fence segments.
  it("keeps a fenced @板砖 verbatim in an EN committed block; prose still aliases", () => {
    const { out, r } = mkEn(false);
    r.update([
      {
        kind: "herta",
        surface: "speech",
        text: "ask @板砖 first:\n```\nsend @板砖 the file\n```\nthen @板砖 again",
      },
    ]);
    expect(out.full()).toBe(
      "ask @Brick first:\n```\nsend @板砖 the file\n```\nthen @Brick again\n",
    );
  });

  it("keeps a backticked `@板砖` quotation verbatim in an EN committed block", () => {
    const { out, r } = mkEn(false);
    r.update([
      {
        kind: "herta",
        surface: "speech",
        text: "the token is `@板砖`, but say @板砖 to use it",
      },
    ]);
    expect(out.full()).toBe("the token is `@板砖`, but say @Brick to use it\n");
  });

  it("slow-stream keeps a fenced 板砖 verbatim (aliased ONCE before the split)", async () => {
    const { out, r } = mkEn(true);
    const ctrl = r.slowStreamSpeech("ping @板砖\n```\n板砖 --help\n```");
    await vi.advanceTimersByTimeAsync(60_000);
    await ctrl.done;
    expect(out.full()).toBe("ping @Brick\n```\n板砖 --help\n```\n");
  });

  it("zh committed block with a fence is byte-identical (display alias is a no-op)", () => {
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle); // default lang zh
    r.update([
      {
        kind: "herta",
        surface: "speech",
        text: "交给 @板砖：\n```\n板砖 --help\n```",
      },
    ]);
    expect(out.full()).toBe("交给 @板砖：\n```\n板砖 --help\n```\n");
  });
});

describe("NarrativeRenderer — legacy todo blocks (ADR 0073)", () => {
  it("print as the body the record holds, like any other row — no plan strip, no re-anchor after a beat", () => {
    const { out, r } = mk();
    const layout: TerminalRecordBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "todo list (2):\n[~] 定位 bug\n[ ] 修复",
      digest: { kind: "todo", total: 2, completed: 0 },
    };
    const progress: TerminalRecordBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "todo 1/2: 修复",
      digest: { kind: "todo", total: 2, completed: 1, current: "修复" },
    };
    r.update([
      layout,
      { kind: "herta", surface: "speech", text: "继续。" },
      progress,
    ]);
    expect(out.full()).toBe(
      [
        "→ 差分协处理器",
        "  todo list (2):",
        "  [~] 定位 bug",
        "  [ ] 修复",
        "继续。",
        "→ 差分协处理器",
        "  todo 1/2: 修复",
        "",
      ].join("\n"),
    );
  });
});

describe("NarrativeRenderer — EN transient chrome (audit 2026-07-16)", () => {
  const mkEnPlain = (): { out: MockWritable; r: NarrativeRenderer } => {
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle, { lang: "en" });
    return { out, r };
  };

  it("EN thought indicator is (thinking…), same no-newline contract", () => {
    const { out, r } = mkEnPlain();
    r.beginHertaStream("thought");
    const written = out.full();
    expect(written).toContain("(thinking…)");
    expect(written).not.toContain("思考中");
    expect(written.endsWith("\n")).toBe(false);
  });

  it("EN compaction hint reuses the GUI's recapping wording", () => {
    const { out, r } = mkEnPlain();
    r.beginCompactionHint();
    expect(out.full()).toContain("⋯ Tidying conversation history…");
    expect(out.full()).not.toContain("压缩对话记忆");
    r.endCompactionHint();
    expect(out.full()).toContain("\r\x1b[K");
  });

  it("zh indicators are byte-identical", () => {
    const { out, r } = mk(); // default lang zh
    r.beginHertaStream("thought");
    expect(out.full()).toContain("(思考中…)");
    r.endHertaStream();
    r.beginCompactionHint();
    expect(out.full()).toContain("⋯ 正在压缩对话记忆…");
  });
});

describe("NarrativeRenderer — a beat is paced like the reply on a TTY (owner 2026-10-10)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  function mkTty(): { out: MockWritable; r: NarrativeRenderer } {
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle, {
      isTTY: true,
      random: () => 0.5,
    });
    return { out, r };
  }
  const BEAT = "先让测试兜住。";
  const ROW: TerminalRecordBlock = {
    kind: "system",
    label: "差分协处理器",
    body: "Running node --test",
  };
  // The bridge's order: begin at the first safe token, the chunk, end, then
  // the beat block committed and flushed, the backend's next row behind it.
  function fireBeat(
    r: NarrativeRenderer,
    text: string,
    record: TerminalRecord,
  ) {
    r.beginHertaStream("speech");
    r.streamHertaToken(text);
    r.endHertaStream();
    r.flushBlocks(record);
  }
  const recordWith = (...beats: string[]): TerminalRecord => [
    ...beats.flatMap((b): TerminalRecordBlock[] => [
      { kind: "herta", surface: "speech", text: b },
      ROW,
    ]),
  ];

  it("reveals one glyph at a time, and the row behind it prints after its newline", async () => {
    const { out, r } = mkTty();
    fireBeat(r, BEAT, recordWith(BEAT).slice(0, 2));
    expect(out.full()).toBe("");
    await vi.advanceTimersByTimeAsync(TICK * 2);
    expect(out.full().length).toBeGreaterThan(0);
    expect(out.full()).not.toContain("→");
    await vi.advanceTimersByTimeAsync(TICK * 30);
    await r.settled();
    expect(out.full()).toBe(`${BEAT}\n→ 差分协处理器\n  Running node --test\n`);
  });

  it("the next stream lands it first: its tail, its newline, its row", async () => {
    const { out, r } = mkTty();
    fireBeat(r, BEAT, recordWith(BEAT).slice(0, 2));
    await vi.advanceTimersByTimeAsync(TICK);
    r.beginHertaStream("thought");
    expect(out.full()).toBe(
      `${BEAT}\n→ 差分协处理器\n  Running node --test\n(思考中…)`,
    );
  });

  it("settled() waits for the reveal; an error mid-beat lands what was handed over", async () => {
    const { r } = mkTty();
    fireBeat(r, BEAT, recordWith(BEAT).slice(0, 2));
    let done = false;
    void r.settled().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(TICK * 2);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(TICK * 30);
    expect(done).toBe(true);

    const second = mkTty();
    second.r.beginHertaStream("speech");
    second.r.streamHertaToken("半句");
    second.r.cancelStream();
    expect(second.out.full()).toBe("半句\n");
  });

  it("non-TTY output keeps the raw writes", () => {
    const out = new MockWritable();
    const r = new NarrativeRenderer(out, plainStyle);
    r.beginHertaStream("speech");
    r.streamHertaToken(BEAT);
    r.endHertaStream();
    expect(out.full()).toBe(`${BEAT}\n`);
  });
});
