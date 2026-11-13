import { describe, expect, it } from "vitest";
import type { DoneMarkerSummary } from "../types/terminal-record.js";
import {
  composeMarkerSummary,
  type MarkerSummaryLabels,
  type TestRollup,
  testRollup,
} from "./marker-summary.js";

// Owner 2026-11-13. A marker's test counts are of test RUNS. A run that went
// red, was fixed and went green counted one of each, and "1 passed, 1 failed"
// read as a failure still standing: in a live run the supervisor vetoed
// Herta's true "3/3 passed" on it and she told the user a test was failing.
describe("testRollup — the last test run decides how a run's testing reads", () => {
  it("red, a fix, green: the tests passed, after one failed run", () => {
    expect(testRollup({ passed: 1, failed: 1, last: "passed" })).toEqual({
      kind: "passed-after-failures",
      failed: 1,
    });
    expect(testRollup({ passed: 2, failed: 3, last: "passed" })).toEqual({
      kind: "passed-after-failures",
      failed: 3,
    });
  });

  it("green then red, or red throughout: the tests failed, so many of the runs", () => {
    expect(testRollup({ passed: 2, failed: 1, last: "failed" })).toEqual({
      kind: "failed",
      failed: 1,
      runs: 3,
    });
    expect(testRollup({ passed: 0, failed: 1, last: "failed" })).toEqual({
      kind: "failed",
      failed: 1,
      runs: 1,
    });
  });

  it("no failed run is a pass whatever `last` says, and zero runs is said as zero", () => {
    expect(testRollup({ passed: 4, failed: 0, last: "passed" })).toEqual({
      kind: "passed",
      runs: 4,
    });
    expect(testRollup({ passed: 4, failed: 0 })).toEqual({
      kind: "passed",
      runs: 4,
    });
    // Skipped, or never found: none passed and none failed.
    expect(testRollup({ passed: 0, failed: 0 })).toEqual({
      kind: "passed",
      runs: 0,
    });
  });

  it("a marker written before `last` reads by its two counts, as it did", () => {
    expect(testRollup({ passed: 1, failed: 1 })).toEqual({
      kind: "counts",
      passed: 1,
      failed: 1,
    });
  });
});

describe("composeMarkerSummary hands the caller that one reading", () => {
  const seen: TestRollup[] = [];
  const labels: MarkerSummaryLabels = {
    stateWord: "Done",
    file: (n) => `${n} files`,
    tests: (r) => {
      seen.push(r);
      return `tests:${r.kind}`;
    },
    risk: (n) => `${n} risks`,
    aborted: "aborted",
    crashed: "crashed",
    stepLimit: "step limit",
  };
  const marker = (tests: DoneMarkerSummary["tests"]): DoneMarkerSummary => ({
    kind: "done",
    state: "completed",
    fileCount: 1,
    riskCount: 0,
    ...(tests !== undefined ? { tests } : {}),
  });

  it("in the segment's place, and not at all for a run that tested nothing", () => {
    expect(
      composeMarkerSummary(
        marker({ passed: 1, failed: 1, last: "passed" }),
        labels,
      ),
    ).toBe("Done · 1 files · tests:passed-after-failures");
    expect(seen).toEqual([{ kind: "passed-after-failures", failed: 1 }]);
    expect(composeMarkerSummary(marker(undefined), labels)).toBe(
      "Done · 1 files",
    );
    expect(seen).toHaveLength(1);
  });
});
