import {
  composeMarkerSummary,
  type DoneMarkerSummary,
  type SystemBlock,
  type SystemBlockLabel,
} from "@herta/core";
import type { PromptLang } from "@herta/herta";

/**
 * Display-only English labels for the two record system labels. The stored
 * record keeps the CN machine tokens (系统 / 差分协处理器 — the D2 contract Herta
 * reads and parsers/dedup key on); this maps them for an EN reader's TTY only.
 * Mirrors the GUI's `record.chip.system` / `record.chip.coprocessor` i18n.
 */
const EN_SYSTEM_LABEL: Record<SystemBlockLabel, string> = {
  系统: "System",
  差分协处理器: "Coprocessor",
};

/** English no-output body — the display twin of buildNoopMarker's CN body,
 *  carrying the same one-line explanation. */
const EN_NOOP_BODY =
  "No output — nothing triggered a file, directory, or command operation this time.";

const EN_STATE_WORD: Record<DoneMarkerSummary["state"], string> = {
  completed: "Done",
  blocked: "Blocked",
  failed: "Failed",
  // A user's Stop is not a failure (audit 2026-07-24, 1.4).
  interrupted: "Stopped",
  partial: "Partial",
};

/**
 * Recompose a done-marker roll-up in English from its structured summary —
 * "Done · 2 files · tests 89/89 · 1 risk". Segment order, inclusion rules,
 * and the `·` separator live in core's `composeMarkerSummary` (the single
 * source the GUI's t()-driven twin also delegates to); this supplies only
 * the EN wording. The CN body stays canonical in the record; this is the EN
 * display twin.
 */
function composeMarkerSummaryEN(m: DoneMarkerSummary): string {
  return composeMarkerSummary(m, {
    stateWord: EN_STATE_WORD[m.state],
    file: (n) => (n === 1 ? "1 file" : `${n} files`),
    // The last test run decides how it reads (owner 2026-11-13); `counts`
    // is the older wording, for a marker whose order is not known.
    tests: (r) => {
      switch (r.kind) {
        case "passed":
          return `tests ${r.runs}/${r.runs}`;
        case "passed-after-failures":
          return `tests passed (${r.failed} failed run${r.failed === 1 ? "" : "s"} before)`;
        case "failed":
          return r.runs === 1
            ? "tests failed"
            : `tests failed (${r.failed} of ${r.runs} runs)`;
        case "counts":
          return `tests ${r.passed} passed, ${r.failed} failed`;
      }
    },
    risk: (n) => (n === 1 ? "1 risk" : `${n} risks`),
    // Digits, matching the canonical body. The GUI omits this segment because
    // it renders the same numbers as an animated element instead.
    lines: (add, del) => `+${add} −${del}`,
    // Git outcome identity (ADR 0049 §4) — the EN twins of 提交/推送.
    commit: (sha) => `committed ${sha}`,
    pushed: (ref) => `pushed ${ref}`,
    aborted: "run aborted",
    crashed: "the app exited unexpectedly",
    stepLimit: "step limit reached",
  });
}

/**
 * Localize a record system block's LABEL + BODY for TTY display (EN only; zh
 * returns the block's own label + body, byte-identical). Display-only (D2/D7):
 * the machine labels 系统 / 差分协处理器 and the canonical CN done-marker body
 * stay in the stored record — for Herta's prompt, the persisted transcript,
 * parsers and dedup — and only this rendering swaps in the English twin.
 *
 * Only the done / noop markers are recomposed: the activity / test / exit /
 * tool-fail / patch bodies are already English (their digest verbs and `↳ …`
 * prefixes are authored in English by projectBackendEvent), and evidenceDetail
 * (改动文件 / 风险 / 错误 / 输出) is a prompt-only field the CLI never renders.
 * Mirrors the GUI's ActivityBlock, which composes from the same structured
 * fields rather than the CN body.
 */
export function localizeSystemBlock(
  block: SystemBlock,
  lang: PromptLang,
): { label: string; body: string } {
  if (lang !== "en") return { label: block.label, body: block.body };
  // A corrupt / hand-edited / future-version JSONL block can carry a label
  // outside the union despite the type — fall back to the stored label
  // verbatim rather than rendering `→ undefined`.
  const label = EN_SYSTEM_LABEL[block.label] ?? block.label;
  if (block.role === "done-marker" && block.markerSummary !== undefined) {
    return { label, body: composeMarkerSummaryEN(block.markerSummary) };
  }
  if (block.role === "noop-marker") {
    return { label, body: EN_NOOP_BODY };
  }
  return { label, body: block.body };
}
