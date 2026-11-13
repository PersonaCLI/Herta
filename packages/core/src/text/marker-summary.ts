import type { DoneMarkerSummary } from "../types/terminal-record.js";

/**
 * How a run's test runs read as ONE statement (owner 2026-11-13). The counts
 * in a marker are of test RUNS, in the order they ran, and the last run
 * decides: a run that went red, was fixed and went green ENDED green. Read by
 * the two counts alone it said "1 passed, 1 failed", which is how a failure
 * still standing reads.
 */
export type TestRollup =
  /** No run failed: `runs` passed. Zero when none passed either (skipped,
   *  or the tests were never found). */
  | { readonly kind: "passed"; readonly runs: number }
  /** The last run passed; `failed` runs before it did not. */
  | { readonly kind: "passed-after-failures"; readonly failed: number }
  /** The last run failed: `failed` of the `runs` did. */
  | { readonly kind: "failed"; readonly failed: number; readonly runs: number }
  /** Runs failed and their order is not known (a record written before
   *  `tests.last`): the two counts, as such a marker always read. */
  | {
      readonly kind: "counts";
      readonly passed: number;
      readonly failed: number;
    };

/** The one reading of a marker's test counts that every wording follows:
 *  the record's own body, Herta's view of it, the desktop and the CLI. */
export function testRollup(
  tests: NonNullable<DoneMarkerSummary["tests"]>,
): TestRollup {
  const { passed, failed, last } = tests;
  if (failed === 0) return { kind: "passed", runs: passed };
  if (last === "passed") return { kind: "passed-after-failures", failed };
  if (last === "failed") {
    return { kind: "failed", failed, runs: passed + failed };
  }
  return { kind: "counts", passed, failed };
}

/**
 * Localized label fragments for {@link composeMarkerSummary}. The caller
 * (CLI system-localize, GUI marker-summary) owns the WORDING — its locale
 * catalog, singular/plural forms, all-pass vs failed test phrasing — while
 * the composer here owns which segments appear and in what order.
 */
export interface MarkerSummaryLabels {
  /** The localized state word for the marker's state (Done / 完成 / …). */
  readonly stateWord: string;
  /** File-count segment, called only when the run touched ≥1 file. */
  readonly file: (n: number) => string;
  /** Test segment, called only when the run executed ≥1 test, with the one
   *  reading of its runs (`testRollup`): the caller words each kind. */
  readonly tests: (rollup: TestRollup) => string;
  /** Risk-count segment, called only when the backend flagged ≥1 risk. */
  readonly risk: (n: number) => string;
  /** Added/removed lines, called only when every changed file had a real
   *  per-file diff (see `DoneMarkerSummary.lines`). Omit the label to leave
   *  the segment out entirely — older callers stay unchanged. */
  readonly lines?: (add: number, del: number) => string;
  /** Commit-identity segment (ADR 0049 §4), called only when the run's last
   *  successful commit was detected. Optional — omit to leave it out. */
  readonly commit?: (sha: string) => string;
  /** Push-destination segment (ADR 0049 §4), called only when the run's last
   *  successful push was detected. Optional — omit to leave it out. */
  readonly pushed?: (ref: string) => string;
  /** Abnormal-termination word (run aborted / 运行异常中止) — appended only
   *  on the bridge-failure marker (`aborted: true`). */
  readonly aborted: string;
  /** The app-exit word (app exited unexpectedly / 应用意外退出) — appended
   *  only on the marker a session's next open wrote for a run the app
   *  exited during (`crashed: true`, ADR 0071 §1.2). */
  readonly crashed: string;
  /** The step-limit word (step limit reached / 步数已达上限) — appended only
   *  on the marker of a run that stopped at the step limit (`stepLimit`). */
  readonly stepLimit: string;
}

/**
 * Compose a done-marker roll-up ("Done · 2 files · tests 89/89 · 1 risk")
 * from its structured summary. The segment ORDER, the inclusion rules
 * (state always; files/tests/risks only when present; the abort word only on
 * an aborted run), and the ` · ` separator live HERE — the single source the
 * CLI's EN recomposition (system-localize.ts) and the GUI's t()-driven
 * `composeMarkerSummary` (marker-summary.ts) both delegate to, mirroring the
 * canonical CN `body` the bridge authors (buildDoneMarker). Display-only:
 * the canonical body stays the shared-record text (D7); this recomposition
 * is for localizing renderers reading `markerSummary`.
 */
export function composeMarkerSummary(
  m: DoneMarkerSummary,
  labels: MarkerSummaryLabels,
): string {
  const parts: string[] = [labels.stateWord];
  if (m.fileCount > 0) parts.push(labels.file(m.fileCount));
  // Directly after the file count, which it qualifies.
  if (m.lines !== undefined && labels.lines !== undefined) {
    parts.push(labels.lines(m.lines.add, m.lines.del));
  }
  if (m.tests !== undefined) {
    parts.push(labels.tests(testRollup(m.tests)));
  }
  // Git outcome identity (ADR 0049 §4): the commit/push the run landed,
  // after the work segments they conclude and before the risk tally.
  if (m.git?.commit !== undefined && labels.commit !== undefined) {
    parts.push(labels.commit(m.git.commit));
  }
  if (m.git?.pushedRef !== undefined && labels.pushed !== undefined) {
    parts.push(labels.pushed(m.git.pushedRef));
  }
  if (m.riskCount > 0) parts.push(labels.risk(m.riskCount));
  // Abnormal termination (bridge-failure marker): the twin of the canonical
  // 运行异常中止 segment — composed, never fabricated as a risk count.
  if (m.aborted === true) parts.push(labels.aborted);
  if (m.crashed === true) parts.push(labels.crashed);
  if (m.stepLimit === true) parts.push(labels.stepLimit);
  return parts.join(" · ");
}
