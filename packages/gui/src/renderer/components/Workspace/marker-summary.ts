import { composeMarkerSummary as composeDoneMarker } from "@herta/core/marker-summary";
import type { MessageKey } from "../../i18n/keys.js";
import type { TFn } from "../../i18n/LocaleProvider.js";
import type { ActivitySummary, DoneMarkerSummary } from "./group-record.js";

const STATE_KEY: Record<DoneMarkerSummary["state"], MessageKey> = {
  completed: "record.marker.completed",
  blocked: "record.marker.blocked",
  failed: "record.marker.failed",
  interrupted: "record.marker.interrupted",
  partial: "record.marker.partial",
};

/**
 * Compose the localized activity-header summary from an `ActivitySummary`.
 * Mirrors the canonical body's shape (`state · N file(s) · tests P/F · N
 * risks`) but every segment goes through `t()`. Segment order, inclusion
 * rules, and the `·` separator live in core's `composeMarkerSummary` (the
 * single source the CLI's EN recomposition also delegates to); this supplies
 * only the catalog wording. A `raw` summary (pre-structured record) is passed
 * through verbatim — it is already canonical mixed-locale text and there is
 * nothing structured left to translate.
 */
export function composeMarkerSummary(
  summary: ActivitySummary,
  t: TFn,
  opts?: {
    /** Put the run's `+N −M` into the text, after the file count — for a
     *  reader with no DiffStat element beside it (the Markdown export, ADR
     *  0072 §3). */
    readonly withLines?: boolean;
  },
): string {
  if (summary.kind === "raw") return summary.text;
  if (summary.kind === "noop") return t("record.marker.noop");

  const m = summary.marker;
  return composeDoneMarker(m, {
    ...(opts?.withLines === true
      ? { lines: (add: number, del: number) => `+${add} −${del}` }
      : {}),
    stateWord: t(STATE_KEY[m.state]),
    file: (n) =>
      n === 1
        ? t("record.marker.file", { n: 1 })
        : t("record.marker.files", { n }),
    // The last test run decides how it reads (owner 2026-11-13): after red,
    // a fix and green this said "tests 1 passed, 1 failed". `counts` is that
    // older wording, for a marker whose order is not known.
    tests: (r) => {
      switch (r.kind) {
        case "passed":
          return t("record.marker.tests", { passed: r.runs, total: r.runs });
        case "passed-after-failures":
          return r.failed === 1
            ? t("record.marker.testsPassedAfterRun", { failed: 1 })
            : t("record.marker.testsPassedAfterRuns", { failed: r.failed });
        case "failed":
          return r.runs === 1
            ? t("record.marker.testsFailedLast")
            : t("record.marker.testsFailedOf", {
                failed: r.failed,
                total: r.runs,
              });
        case "counts":
          return t("record.marker.testsFailed", {
            passed: r.passed,
            failed: r.failed,
          });
      }
    },
    risk: (n) =>
      n === 1
        ? t("record.marker.risk", { n: 1 })
        : t("record.marker.risks", { n }),
    // `lines` is left out unless asked for (above). The GUI renders the roll-up's
    // `+187 −42` as an ELEMENT beside this string (the digits count up), so
    // composing it into the text too would print it twice. The canonical body
    // and the CLI both include it — see CN_MARKER_LABELS and system-localize.
    // Git outcome identity (ADR 0049 §4): the commit/push the run landed.
    commit: (sha) => t("record.marker.commit", { sha }),
    pushed: (ref) => t("record.marker.pushed", { ref }),
    // Abnormal termination (bridge-failure marker): composes the canonical
    // body's 运行异常中止 segment instead of a fabricated risk count.
    aborted: t("record.marker.aborted"),
    // A run the app exited during, sealed when its session opened (ADR 0071
    // §1.2).
    crashed: t("record.marker.crashed"),
    // A run that stopped at the step limit (2026-09-29).
    stepLimit: t("record.marker.stepLimit"),
  });
}
