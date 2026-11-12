import type { Finding } from "../findings-ledger.js";

/**
 * The working state the harness keeps for 板砖 once old iterations have been
 * dropped from its transcript (2026-09-29 long-run study, proposal 2).
 *
 * The budget trim drops whole old groups and leaves a count. Three things
 * then vanish that the model cannot cheaply work out again: the files it
 * has changed, the conclusions it has recorded (so at the ledger's cap it
 * cannot consolidate), and what the user said while it worked (a steer sits
 * in a droppable group). (A fourth, the standard set's managed background
 * commands, left with that set: ADR 0086.) This block states them from the
 * harness's own records — deterministic, never model-written — in the state
 * trailer after the transcript, so the cached prefix is untouched. Claude Code rebuilds the same kind of state after a
 * compaction; Codex rebuilds its context from live state. Herta never
 * summarizes, so this is the whole of it.
 */

export interface WorkingStateInput {
  /** Files the editors changed this run (workspace-relative). */
  readonly changedFiles: ReadonlyArray<{
    readonly path: string;
    readonly kind: "created" | "modified" | "deleted";
    /** `+N -M` when the diff was measured. */
    readonly diffSummary?: string;
  }>;
  /** Conclusions recorded with report_finding. */
  readonly findings: readonly Finding[];
  /** What the user said while this run worked, oldest first. */
  readonly steers: readonly string[];
}

const MAX_FILES = 30;
const MAX_STEERS = 5;
const MAX_STEER_CHARS = 400;

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The working-state section. Always says something: the trim marker
 *  promises a working state at the end once iterations were dropped. */
export function renderWorkingState(
  input: WorkingStateInput,
  lang: "zh" | "en",
  maxFindings: number,
): string {
  const en = lang === "en";
  const out: string[] = [
    en ? "## Working state" : "## 当前工作状态",
    en
      ? "(Kept by the system from its own records — what this run has done so far, beyond the iterations still shown above.)"
      : "（由系统根据自己的记录维护：这次运行到目前为止的实际状态，不限于上方还保留的记录。）",
  ];

  const files = input.changedFiles.slice(0, MAX_FILES);
  if (files.length > 0) {
    out.push(en ? "Files changed:" : "改过的文件：");
    for (const f of files) {
      const kind = en
        ? f.kind
        : f.kind === "created"
          ? "新建"
          : f.kind === "deleted"
            ? "删除"
            : "修改";
      const size =
        f.diffSummary !== undefined && /^\+\d+ -\d+$/.test(f.diffSummary)
          ? `, ${f.diffSummary}`
          : "";
      out.push(`- ${f.path} (${kind}${size})`);
    }
    const more = input.changedFiles.length - files.length;
    if (more > 0) out.push(en ? `- …and ${more} more` : `- ……另 ${more} 个`);
  } else {
    out.push(en ? "Files changed: none yet." : "改过的文件：暂无。");
  }

  if (input.findings.length > 0) {
    out.push(
      en
        ? `Conclusions recorded (${input.findings.length}/${maxFindings}):`
        : `已记录的结论（${input.findings.length}/${maxFindings}）：`,
    );
    input.findings.forEach((f, i) => {
      const cites = f.cites.length > 0 ? ` (${f.cites.join(", ")})` : "";
      out.push(`${i + 1}. ${f.claim}${cites}`);
    });
  }

  const steers = input.steers.slice(-MAX_STEERS);
  if (steers.length > 0) {
    const skipped = input.steers.length - steers.length;
    out.push(
      en
        ? "What the user said while you worked (oldest first):"
        : "开拓者在你工作时补充的话（按先后）：",
    );
    if (skipped > 0) {
      out.push(
        en
          ? `- (${skipped} earlier not shown)`
          : `-（更早的 ${skipped} 条未列出）`,
      );
    }
    for (const s of steers) out.push(`- 「${clip(s, MAX_STEER_CHARS)}」`);
  }

  return out.join("\n");
}

/** How many of the last iterations carry the step notice. */
export const STEP_NOTICE_WINDOW = 10;

/**
 * The step notice (proposal 3): from `STEP_NOTICE_WINDOW` iterations before
 * the cap, the model is told how many are left and what to do with them —
 * rather than the cap ending the run without a word. `iteration` is the
 * 1-based number of the call being built. "" outside the window.
 */
export function renderStepNotice(
  iteration: number,
  maxIterations: number,
  lang: "zh" | "en",
): string {
  const left = maxIterations - iteration;
  if (left >= STEP_NOTICE_WINDOW) return "";
  if (lang === "en") {
    return left > 0
      ? `(Step notice: this run is limited to ${maxIterations} steps. This is step ${iteration}; ${left} remain after it. Wrap up the current step and record conclusions with report_finding. When the steps run out the run stops where it is, and the user can continue it.)`
      : `(Step notice: this is the last of ${maxIterations} steps. Record conclusions with report_finding now; the run stops after this step, and the user can continue it.)`;
  }
  return left > 0
    ? `（步数提醒：这次运行最多 ${maxIterations} 步，这是第 ${iteration} 步，之后还剩 ${left} 步。请收尾当前这一步，并用 report_finding 记下结论。步数用完后运行会停在原处，开拓者可以接着继续。）`
    : `（步数提醒：这是 ${maxIterations} 步里的最后一步。现在就用 report_finding 记下结论；这一步之后运行会停下，开拓者可以接着继续。）`;
}
