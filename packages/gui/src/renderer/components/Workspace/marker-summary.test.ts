import { describe, expect, it } from "vitest";
import type { MessageKey } from "../../i18n/keys.js";
import { interpolate, type TFn } from "../../i18n/LocaleProvider.js";
import { en } from "../../i18n/messages/en.js";
import { zh } from "../../i18n/messages/zh.js";
import type { ActivitySummary, DoneMarkerSummary } from "./group-record.js";
import { composeMarkerSummary } from "./marker-summary.js";

const tFor =
  (cat: Record<MessageKey, string>): TFn =>
  (key, params) =>
    interpolate(cat[key] ?? key, params);
const ten = tFor(en);
const tzh = tFor(zh);

const done = (m: Omit<DoneMarkerSummary, "kind">): ActivitySummary => ({
  kind: "structured",
  marker: { kind: "done", ...m },
});

describe("composeMarkerSummary", () => {
  it("done · files only", () => {
    const s = done({ state: "completed", fileCount: 2, riskCount: 0 });
    expect(composeMarkerSummary(s, ten)).toBe("Done · 2 files");
    expect(composeMarkerSummary(s, tzh)).toBe("完成 · 2 个文件");
  });

  it("singular file uses the singular catalog form", () => {
    const s = done({ state: "completed", fileCount: 1, riskCount: 0 });
    expect(composeMarkerSummary(s, ten)).toBe("Done · 1 file");
    expect(composeMarkerSummary(s, tzh)).toBe("完成 · 1 个文件");
  });

  it("done · files · all-pass tests", () => {
    const s = done({
      state: "completed",
      fileCount: 1,
      tests: { passed: 1, failed: 0 },
      riskCount: 0,
    });
    expect(composeMarkerSummary(s, ten)).toBe("Done · 1 file · tests 1/1");
    expect(composeMarkerSummary(s, tzh)).toBe("完成 · 1 个文件 · 测试 1/1");
  });

  it("failed · files · failing tests · risks", () => {
    const s = done({
      state: "failed",
      fileCount: 1,
      tests: { passed: 1, failed: 2 },
      riskCount: 3,
    });
    expect(composeMarkerSummary(s, ten)).toBe(
      "Failed · 1 file · tests 1 passed, 2 failed · 3 risks",
    );
    expect(composeMarkerSummary(s, tzh)).toBe(
      "失败 · 1 个文件 · 测试 1 通过，2 失败 · 3 风险",
    );
  });

  // Owner 2026-11-13: the last test run decides. A live run that went red,
  // was fixed and went green read "tests 1 passed, 1 failed" on its row.
  it("red, a fix, green: the tests passed, with the failed runs before", () => {
    const one = done({
      state: "completed",
      fileCount: 1,
      tests: { passed: 1, failed: 1, last: "passed" },
      riskCount: 0,
    });
    expect(composeMarkerSummary(one, ten)).toBe(
      "Done · 1 file · tests passed (1 failed run before)",
    );
    expect(composeMarkerSummary(one, tzh)).toBe(
      "完成 · 1 个文件 · 测试通过（此前失败 1 次）",
    );
    const two = done({
      state: "completed",
      fileCount: 1,
      tests: { passed: 1, failed: 2, last: "passed" },
      riskCount: 0,
    });
    expect(composeMarkerSummary(two, ten)).toBe(
      "Done · 1 file · tests passed (2 failed runs before)",
    );
    expect(composeMarkerSummary(two, tzh)).toBe(
      "完成 · 1 个文件 · 测试通过（此前失败 2 次）",
    );
  });

  it("a run whose last test run failed says so, and how many of its runs did", () => {
    const mixed = done({
      state: "partial",
      fileCount: 1,
      tests: { passed: 2, failed: 1, last: "failed" },
      riskCount: 0,
    });
    expect(composeMarkerSummary(mixed, ten)).toBe(
      "Partial · 1 file · tests failed (1 of 3 runs)",
    );
    expect(composeMarkerSummary(mixed, tzh)).toBe(
      "部分完成 · 1 个文件 · 测试失败（3 次中 1 次）",
    );
    const only = done({
      state: "failed",
      fileCount: 0,
      tests: { passed: 0, failed: 1, last: "failed" },
      riskCount: 0,
    });
    expect(composeMarkerSummary(only, ten)).toBe("Failed · tests failed");
    expect(composeMarkerSummary(only, tzh)).toBe("失败 · 测试失败");
  });

  it("state-only roll-up with a single risk (no files, no tests)", () => {
    const s = done({ state: "blocked", fileCount: 0, riskCount: 1 });
    expect(composeMarkerSummary(s, ten)).toBe("Blocked · 1 risk");
    expect(composeMarkerSummary(s, tzh)).toBe("受阻 · 1 风险");
  });

  it("partial state word", () => {
    const s = done({ state: "partial", fileCount: 0, riskCount: 0 });
    expect(composeMarkerSummary(s, ten)).toBe("Partial");
    expect(composeMarkerSummary(s, tzh)).toBe("部分完成");
  });

  it("aborted run composes the abnormal-termination word, not a synthetic risk", () => {
    // The bridge-failure marker (canonical body 失败 · 运行异常中止) carries
    // aborted: true + riskCount 0 since audit 2026-07-16; both locales show
    // the abort, matching the canonical CN body.
    const s = done({
      state: "failed",
      fileCount: 0,
      riskCount: 0,
      aborted: true,
    });
    expect(composeMarkerSummary(s, ten)).toBe("Failed · run aborted");
    expect(composeMarkerSummary(s, tzh)).toBe("失败 · 运行异常中止");
  });

  it("a run the app exited during composes the app-exit word (ADR 0071 §1.2)", () => {
    // The seal's marker: its zh twin is the canonical body exactly.
    const s = done({
      state: "interrupted",
      fileCount: 1,
      riskCount: 0,
      crashed: true,
    });
    expect(composeMarkerSummary(s, ten)).toBe(
      "Stopped · 1 file · the app exited unexpectedly",
    );
    expect(composeMarkerSummary(s, tzh)).toBe("中断 · 1 个文件 · 应用意外退出");
  });

  it("a run stopped at the step limit composes the step-limit word (2026-09-29)", () => {
    const s = done({
      state: "interrupted",
      fileCount: 0,
      riskCount: 1,
      stepLimit: true,
    });
    expect(composeMarkerSummary(s, ten)).toBe(
      "Stopped · 1 risk · step limit reached",
    );
    expect(composeMarkerSummary(s, tzh)).toBe("中断 · 1 风险 · 步数已达上限");
  });

  it("noop localizes to the no-output word", () => {
    const s: ActivitySummary = { kind: "noop" };
    expect(composeMarkerSummary(s, ten)).toBe("No output");
    expect(composeMarkerSummary(s, tzh)).toBe("无产出");
  });

  it("raw summary passes the canonical body through unchanged", () => {
    const s: ActivitySummary = { kind: "raw", text: "完成 · 2 files" };
    expect(composeMarkerSummary(s, ten)).toBe("完成 · 2 files");
    expect(composeMarkerSummary(s, tzh)).toBe("完成 · 2 files");
  });
});
