import { memo, useEffect, useMemo, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useApprovalPending } from "../../hooks/useApprovalPending.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { makeT } from "../../i18n/LocaleProvider.js";
import { runShortcut } from "../../lib/shortcut-registry.js";
import { hoverTipProps } from "../common/hover-tip.js";
import {
  runTabPath,
  useFileViewerOpen,
} from "../FileViewer/file-viewer-context.js";
import { textWithLinks } from "./ActivityStep.js";
import { DiffStat } from "./DiffStat.js";
import type { SystemBlock } from "./group-record.js";
import { composeMarkerSummary } from "./marker-summary.js";
import { formatDuration, liveState, runFacts, runTookMs } from "./run-facts.js";
import { SwapText } from "./SwapText.js";

const STATE_KEY = {
  working: "run.state.working",
  verifying: "run.state.verifying",
  waiting: "run.state.waiting",
} as const;

export interface RunRowProps {
  /** Every system block of the run, across the beats that split it. */
  readonly blocks: readonly SystemBlock[];
  /** The run's first block's absolute record index: its tab's name. */
  readonly absIndex: number;
  /** Her dispatching bubble's stamp (see the run item). */
  readonly dispatchedAt?: string | undefined;
  /** The current turn's run, still working. */
  readonly active: boolean;
  /** The backend's start (Date.now), when this run is the live turn's: the
   *  live time counts from it. */
  readonly backendStartedAt: number | null;
  /** The session's language: the row is the record's, as the activity line
   *  was (ADR 0019). */
  readonly lang: "zh" | "en";
  /** 撤销 (ADR 0074 §4), on the latest turn's last finished run. */
  readonly undo?:
    | { readonly state: "offer" | "busy"; readonly onUndo: () => void }
    | { readonly state: "done" };
}

/**
 * One of 板砖's runs in the chat (ADR 0085 §9 and its amendments of
 * 2026-11-04): one row under the bubble that dispatched it, in the device's
 * own words while it works — 「差分协处理器 · 验证中 · 4 步」 — and the
 * marker's line once it ended. The run's rows are not unfolded here: the
 * rail's card shows them live, and **完整记录 ›** opens all of them in a
 * viewer tab, for this run and for every earlier one — the card leaves a
 * beat after the run, the row stays. Once the run has ended and changed
 * files, **撤销** sits beside it. With the rail hidden, the live row also
 * carries 停止运行 (the CSS shows it there only).
 *
 * memo: `blocks` keeps its identity while the run is unchanged
 * (`shareRunIdentity`), so earlier runs skip the chat's re-renders; the live
 * one ticks once a second for its time.
 */
export const RunRow = memo(function RunRow(props: RunRowProps): JSX.Element {
  const { blocks, active, lang } = props;
  const t = useMemo(() => makeT(lang), [lang]);
  const reduced = useReducedMotion();
  const waiting = useApprovalPending();
  const openFile = useFileViewerOpen();
  const { bridge, sessionStore } = useHertaBridge();
  const canSteer = bridge.steerText !== undefined;
  const facts = useMemo(
    () => runFacts(blocks, props.dispatchedAt),
    [blocks, props.dispatchedAt],
  );
  const { summary } = facts;
  const headline = useMemo(
    () => (summary === null ? null : composeMarkerSummary(summary, t)),
    [summary, t],
  );
  // The commit the run landed (ADR 0049 §4) opens beside the record (ADR
  // 0059), as the activity line's did.
  const commitSha =
    summary?.kind === "structured"
      ? (summary.marker.git?.commit ?? null)
      : null;

  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  const anchor =
    props.backendStartedAt ??
    (facts.startedAt !== undefined ? Date.parse(facts.startedAt) : Number.NaN);
  const durationMs = active
    ? Number.isFinite(anchor)
      ? Date.now() - anchor
      : null
    : runTookMs(facts);

  const state = liveState(facts.phase, waiting);
  const stepsText =
    facts.steps === 1
      ? t("trace.card.stepOne")
      : t("trace.card.steps", { n: String(facts.steps) });
  const first = blocks[0];

  return (
    <div
      className={`activity-line-group run-row${active ? " is-active" : ""}`}
      data-testid="run-row"
    >
      <div className="activity-line-row">
        <span className="activity-line is-static">
          <span
            className={`activity-line__led${active ? " is-pulsing" : ""}`}
            aria-hidden="true"
          />
          <span className="activity-line__label">
            {t("record.chip.coprocessor")}
          </span>
          {active ? (
            <span className="activity-line__summary run-row__live">
              <span aria-hidden="true">·</span>
              <SwapText text={t(STATE_KEY[state])} reduced={reduced} shimmer />
              {state !== "waiting" && facts.steps > 0 && (
                <span>· {stepsText}</span>
              )}
            </span>
          ) : headline !== null ? (
            <span className="activity-line__summary">
              {commitSha !== null && openFile !== null
                ? textWithLinks(headline, [
                    {
                      text: commitSha,
                      onOpen: () =>
                        openFile(commitSha, {
                          kind: "commit",
                          label: commitSha,
                        }),
                      ariaLabel: `${t("activity.commit.openAria")} ${commitSha}`,
                    },
                  ])
                : headline}
              {summary?.kind === "structured" &&
                summary.marker.lines !== undefined && (
                  <>
                    {" · "}
                    <DiffStat
                      value={summary.marker.lines}
                      rollup
                      {...(summary.at !== undefined ? { at: summary.at } : {})}
                    />
                  </>
                )}
            </span>
          ) : (
            // No marker in the record: a run cut short before the bridge
            // could write one. What it did is still counted.
            facts.steps > 0 && (
              <span className="activity-line__summary">· {stepsText}</span>
            )
          )}
        </span>
        {openFile !== null && first !== undefined && (
          <button
            type="button"
            className="run-row__record"
            aria-label={t("run.record.openAria")}
            onClick={() =>
              openFile(runTabPath(props.absIndex, first.at), {
                kind: "run",
                label: t("run.tab"),
              })
            }
          >
            {t("run.record")}
            <span aria-hidden="true"> ›</span>
          </button>
        )}
        {props.undo !== undefined &&
          !active &&
          (props.undo.state === "done" ? (
            <span className="activity-undo is-done">
              {t("activity.undo.chipDone")}
            </span>
          ) : (
            <button
              type="button"
              className="activity-undo"
              // The app's tip, not the OS's (owner 2026-10-08).
              {...hoverTipProps(t("activity.undo.chipTitle"))}
              disabled={props.undo.state === "busy"}
              onClick={props.undo.onUndo}
            >
              {t("activity.undo.chip")}
            </button>
          ))}
        {active && canSteer && (
          // 插话 with the rail hidden (ADR 0085 §9): the composer's tag.
          <button
            type="button"
            className="run-row__steer"
            onClick={() => {
              sessionStore.setComposerSteer(true);
              runShortcut("focusComposer");
            }}
          >
            {t("run.steer")}
          </button>
        )}
        {active && (
          // The composer's own Stop, through its command: it cuts the voice
          // and drops a held message, as the button does.
          <button
            type="button"
            className="run-row__stop"
            onClick={() => runShortcut("stopRun")}
          >
            {t("run.stop")}
          </button>
        )}
        {durationMs !== null && (
          <span className="activity-line__duration">
            {active
              ? formatDuration(durationMs)
              : `${t("workspace.took")} ${formatDuration(durationMs)}`}
          </span>
        )}
      </div>
    </div>
  );
});
