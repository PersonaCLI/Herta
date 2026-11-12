import { describe, expect, it } from "vitest";
import {
  renderStepNotice,
  renderWorkingState,
  STEP_NOTICE_WINDOW,
} from "./working-state.js";

const empty = { changedFiles: [], findings: [], steers: [] };

describe("the working state the harness keeps (2026-09-29, proposal 2)", () => {
  it("says so even when nothing has happened yet — the trim marker promises it", () => {
    const zh = renderWorkingState(empty, "zh", 12);
    expect(zh).toContain("## 当前工作状态");
    expect(zh).toContain("改过的文件：暂无。");
    expect(renderWorkingState(empty, "en", 12)).toContain(
      "Files changed: none yet.",
    );
  });

  it("lists files with their size when measured, findings against the cap, and steers", () => {
    const text = renderWorkingState(
      {
        changedFiles: [
          { path: "a.ts", kind: "modified", diffSummary: "+3 -1" },
          {
            path: "b.ts",
            kind: "created",
            diffSummary: "changed via a command",
          },
        ],
        findings: [
          { claim: "x is stale", cites: ["a.ts:3"] },
          { claim: "y is fine", cites: [] },
        ],
        steers: ["use the old API"],
      },
      "en",
      12,
    );
    expect(text).toContain("- a.ts (modified, +3 -1)");
    // An unmeasured summary is not shown as a size.
    expect(text).toContain("- b.ts (created)");
    // No background list: bash has no managed background (ADR 0086).
    expect(text).not.toContain("command_output");
    expect(text).not.toContain("bg-");
    expect(text).toContain("Conclusions recorded (2/12):");
    expect(text).toContain("1. x is stale (a.ts:3)");
    expect(text).toContain("2. y is fine");
    expect(text).toContain("- 「use the old API」");
  });

  it("is bounded: 30 files, the last 5 steers, long steers clipped", () => {
    const text = renderWorkingState(
      {
        ...empty,
        changedFiles: Array.from({ length: 34 }, (_, i) => ({
          path: `f${i}.ts`,
          kind: "modified" as const,
        })),
        steers: ["one", "two", "three", "four", "five", "six", "x".repeat(900)],
      },
      "zh",
      12,
    );
    expect(text).toContain("- f29.ts");
    expect(text).not.toContain("- f30.ts");
    expect(text).toContain("- ……另 4 个");
    expect(text).not.toContain("「one」");
    expect(text).toContain("-（更早的 2 条未列出）");
    expect(text).toContain("「three」");
    expect(text).toContain("…」");
    expect(text.length).toBeLessThan(3_000);
  });
});

describe("the step notice (2026-09-29, proposal 3)", () => {
  it("is silent until the last steps, then counts down to the last one", () => {
    expect(renderStepNotice(100 - STEP_NOTICE_WINDOW, 100, "zh")).toBe("");
    expect(renderStepNotice(91, 100, "zh")).toContain("还剩 9 步");
    expect(renderStepNotice(99, 100, "en")).toContain("1 remain after it");
    expect(renderStepNotice(100, 100, "en")).toContain(
      "this is the last of 100 steps",
    );
    // The todo list is gone (ADR 0073): the notice no longer asks for it.
    expect(renderStepNotice(95, 100, "zh")).not.toContain("任务清单");
    expect(renderStepNotice(100, 100, "en")).not.toContain("todo");
  });
});
