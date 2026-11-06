import type { TerminalRecord, TerminalRecordBlock } from "@herta/core";
import { describe, expect, it } from "vitest";
import {
  compactThreshold,
  DEFAULT_COMPACTION_CONFIG,
  decideRecap,
  estimatePromptTokens,
  selectBoundary,
  tailWithinTokenBudget,
} from "./session-recap.js";

describe("estimatePromptTokens", () => {
  it("counts CJK ~1 token/char, ASCII ~1 token/4 chars, empty=0", () => {
    expect(estimatePromptTokens("黑塔")).toBe(2);
    expect(estimatePromptTokens("abcd")).toBe(1);
    expect(estimatePromptTokens("")).toBe(0);
    expect(estimatePromptTokens("黑abcd塔")).toBe(3);
  });

  it("counts full-width punctuation and forms as CJK (~1 token/char)", () => {
    // ，(U+FF0C) ！(U+FF01) （）(U+FF08/09) previously fell into the ÷4 run.
    expect(estimatePromptTokens("，！（）")).toBe(4);
    expect(estimatePromptTokens("（我 说）")).toBe(5); // 4 full-width + " 说"→说 CJK + space
    // Mixed prose: 4 Han at the measured 0.65 (ceil 2.6 = 3, ADR 0068 §9)
    // + full-width comma + full-width period at 1 each.
    expect(estimatePromptTokens("你好，世界。")).toBe(5);
  });
});

describe("tailWithinTokenBudget", () => {
  const b = (text: string): TerminalRecordBlock => ({ kind: "user", text });

  it("keeps everything when under budget", () => {
    const blocks = [b("一二三"), b("四五六")];
    const r = tailWithinTokenBudget(blocks, 100);
    expect(r.blocks).toHaveLength(2);
    expect(r.droppedBlocks).toBe(0);
  });

  it("keeps the newest tail and reports the dropped head when over budget", () => {
    // 10 Han = 7 estimated tokens a block (0.65 each): one fits 10, two do not.
    const blocks = [b("旧".repeat(10)), b("中".repeat(10)), b("新".repeat(10))];
    const r = tailWithinTokenBudget(blocks, 10);
    expect(r.droppedBlocks).toBe(2);
    expect(r.blocks).toHaveLength(1);
    expect((r.blocks[0] as { text: string }).text).toContain("新");
  });

  it("always keeps at least the last block, even when it alone exceeds the budget", () => {
    const blocks = [b("旧"), b("巨".repeat(100))];
    const r = tailWithinTokenBudget(blocks, 5);
    expect(r.blocks).toHaveLength(1);
    expect(r.droppedBlocks).toBe(1);
  });

  it("empty input → empty output, nothing dropped", () => {
    const r = tailWithinTokenBudget([], 10);
    expect(r.blocks).toHaveLength(0);
    expect(r.droppedBlocks).toBe(0);
  });
});

describe("compactThreshold", () => {
  it("is contextWindow * (1 - bufferFraction)", () => {
    expect(
      compactThreshold({
        ...DEFAULT_COMPACTION_CONFIG,
        contextWindowTokens: 1000,
        bufferFraction: 0.2,
      }),
    ).toBe(800);
  });
});

function u(text: string): TerminalRecordBlock {
  return { kind: "user", text };
}
function s(text: string): TerminalRecordBlock {
  return { kind: "herta", surface: "speech", text };
}
function sys(body: string): TerminalRecordBlock {
  return { kind: "system", label: "差分协处理器", body };
}

const cfg = {
  ...DEFAULT_COMPACTION_CONFIG,
  recentWindowTokens: 10,
  minRecentTurns: 1,
  maxRecentWindowTokens: 30,
};

describe("selectBoundary", () => {
  it("returns 0 when the whole record fits (no compaction needed)", () => {
    const rec: TerminalRecord = [u("一"), s("二")];
    expect(selectBoundary(rec, cfg)).toBe(0);
  });

  it("snaps the boundary to a 开拓者 turn and keeps the recent tail", () => {
    const rec: TerminalRecordBlock[] = [];
    for (let k = 0; k < 5; k++) {
      rec.push(u(`问题${"啊".repeat(6)}`));
      rec.push(s(`回答${"哦".repeat(6)}`));
    }
    const b = selectBoundary(rec, cfg);
    expect(rec[b]?.kind).toBe("user");
    expect(b).toBeGreaterThan(0);
  });

  it("never lands on a steer: a cut there splits the run it fell in (review 2026-11-05, H5)", () => {
    const rec: TerminalRecordBlock[] = [];
    for (let k = 0; k < 6; k++) {
      rec.push(u(`问题${"啊".repeat(6)}`));
      rec.push(s(`回答${"哦".repeat(6)}`));
      rec.push({ kind: "user", text: `先别动${"呀".repeat(6)}`, steer: true });
      rec.push(s(`收到${"哦".repeat(6)}`));
    }
    const b = selectBoundary(rec, cfg);
    expect(b).toBeGreaterThan(0);
    expect(rec[b]).toMatchObject({ kind: "user" });
    expect(rec[b]).not.toHaveProperty("steer");
  });

  it("honors minRecentTurns even when one turn is huge", () => {
    const big = "啊".repeat(100);
    const rec: TerminalRecord = [u("a"), s("b"), u("c"), s(big)];
    const tight = {
      ...cfg,
      recentWindowTokens: 1,
      minRecentTurns: 2,
      maxRecentWindowTokens: 1000,
    };
    const b = selectBoundary(rec, tight);
    expect(b).toBe(0);
  });

  it("never splits a turn's group: a @板砖+board run stays with its user block", () => {
    const rec: TerminalRecord = [
      u(`旧${"事".repeat(20)}`),
      s("旧答"),
      u("@板砖 跑测试"),
      sys("Running test"),
      sys("tests: 5/5"),
      u("新问题"),
      s("新答"),
    ];
    const b = selectBoundary(rec, {
      ...cfg,
      recentWindowTokens: 5,
      minRecentTurns: 1,
      maxRecentWindowTokens: 1000,
    });
    expect(rec[b]?.kind).toBe("user");
  });
});

describe("decideRecap", () => {
  const base = {
    boundaryIndex: 10,
    recapText: "旧回忆",
    lang: "zh",
    advancesSinceRederive: 0,
  } as const;
  it("reuses when the boundary is unchanged", () => {
    expect(decideRecap(base, 10, false, cfg)).toEqual({ kind: "reuse" });
  });
  it("rolls when the boundary advanced", () => {
    expect(decideRecap(base, 18, false, cfg)).toEqual({
      kind: "roll",
      agedFrom: 10,
      agedTo: 18,
    });
  });
  it("re-derives from raw on force", () => {
    expect(decideRecap(base, 18, true, cfg)).toEqual({
      kind: "rederive",
      upTo: 18,
    });
  });
  it("forced overrides an unchanged boundary (rederive, not reuse)", () => {
    expect(decideRecap(base, 10, true, cfg)).toEqual({
      kind: "rederive",
      upTo: 10,
    });
  });
  it("re-derives from raw when the advance counter hits the cap", () => {
    const hot = { ...base, advancesSinceRederive: cfg.rederiveEveryNAdvances };
    expect(decideRecap(hot, 18, false, cfg)).toEqual({
      kind: "rederive",
      upTo: 18,
    });
  });
  it("first engage (no prior cache) re-derives from raw", () => {
    expect(decideRecap(null, 18, false, cfg)).toEqual({
      kind: "rederive",
      upTo: 18,
    });
  });
});
