import type { AgentExecutionReport, TestRunSummary } from "@herta/core";
import { describe, expect, it } from "vitest";
import { buildDoneMarker } from "./backend-record-projection.js";

// Owner 2026-11-13. A live run went red, was fixed and went green; its
// marker read `测试 1 通过，1 失败`, the supervisor took that for a failure
// still standing and vetoed Herta's true "3/3 passed", and she told the user
// a test was failing. The marker counts test RUNS in the order they ran, so
// the last one says how the testing ended.

const run = (status: TestRunSummary["status"]): TestRunSummary => ({
  command: "npm test",
  status,
  summary: status === "passed" ? "exit 0, 0.8s" : "exit 1, 0.8s",
});

const markerFor = (
  statuses: ReadonlyArray<TestRunSummary["status"]>,
  status: AgentExecutionReport["status"] = "completed",
) =>
  buildDoneMarker(
    {
      taskId: "t",
      status,
      changedFiles: [],
      evidence: [],
      tests: statuses.map(run),
      permissions: [],
      residualRisks: [],
    },
    undefined,
    undefined,
  );

describe("the done-marker's tests: the last run decides (owner 2026-11-13)", () => {
  it("red, a fix, green: passed, with the failed run before it", () => {
    const m = markerFor(["failed", "passed"]);
    expect(m.body).toBe("完成 · 测试通过（此前失败 1 次）");
    expect(m.markerSummary?.tests).toEqual({
      passed: 1,
      failed: 1,
      last: "passed",
    });
    expect(markerFor(["failed", "failed", "passed", "passed"]).body).toBe(
      "完成 · 测试通过（此前失败 2 次）",
    );
  });

  it("green then red is a failure, however many passed before", () => {
    const m = markerFor(["passed", "passed", "failed"], "partial");
    expect(m.body).toBe("部分完成 · 测试失败（3 次中 1 次）");
    expect(m.markerSummary?.tests).toEqual({
      passed: 2,
      failed: 1,
      last: "failed",
    });
    expect(markerFor(["failed"], "failed").body).toBe("失败 · 测试失败");
  });

  it("every run green reads as it did", () => {
    const m = markerFor(["passed", "passed"]);
    expect(m.body).toBe("完成 · 测试 2/2");
    expect(m.markerSummary?.tests).toEqual({
      passed: 2,
      failed: 0,
      last: "passed",
    });
  });

  it("a run that neither passed nor failed does not decide", () => {
    // Skipped after a green run: the green run is the last word.
    const m = markerFor(["failed", "passed", "skipped"]);
    expect(m.body).toBe("完成 · 测试通过（此前失败 1 次）");
    // Nothing passed or failed at all: no `last`, and the count says so.
    const none = markerFor(["not_run"]);
    expect(none.markerSummary?.tests).toEqual({ passed: 0, failed: 0 });
    expect(none.body).toBe("完成 · 测试 0/0");
  });

  it("the body no longer holds the wording the supervisor misread", () => {
    for (const order of [
      ["failed", "passed"],
      ["passed", "failed"],
      ["failed", "passed", "passed"],
    ] as const) {
      expect(markerFor(order).body).not.toMatch(/\d+ 通过，\d+ 失败/u);
    }
  });
});
