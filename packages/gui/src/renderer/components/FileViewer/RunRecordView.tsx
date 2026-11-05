import { useLayoutEffect, useMemo, useRef } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { makeT, type TFn } from "../../i18n/LocaleProvider.js";
import { SpeakerAvatar } from "../common/SpeakerAvatar.js";
import {
  type FileLinkTarget,
  textWithLinks,
} from "../Workspace/ActivityStep.js";
import {
  type RowView,
  type RowViewContext,
  RowViewStep,
  rowView,
} from "../Workspace/activity-row-view.js";
import { DiffStat } from "../Workspace/DiffStat.js";
import {
  type ActivityRow,
  groupRecord,
  groupRuns,
  lastTurnIndex,
  liftUserImages,
  openRun,
  type RenderItem,
  type SystemBlock,
  steerOf,
  undoTarget,
} from "../Workspace/group-record.js";
import { LightboxProvider, useLightbox } from "../Workspace/ImageLightbox.js";
import { composeMarkerSummary } from "../Workspace/marker-summary.js";
import {
  formatDuration,
  liveState,
  type RunSection,
  runFacts,
  runSections,
  runTookMs,
} from "../Workspace/run-facts.js";
import { stepDisplayDetail } from "../Workspace/step-display.js";
import { useUndoTurn } from "../Workspace/useUndoTurn.js";
import { parseRunTabPath, useFileViewerOpen } from "./file-viewer-context.js";

const PHASE_KEY = {
  explore: "trace.phase.explore",
  modify: "trace.phase.modify",
  verify: "trace.phase.verify",
} as const;

type RunItem = Extract<RenderItem, { readonly kind: "run" }>;

/** No attach is in flight inside a run: a placeholder never reaches here. */
const NO_PROGRESS = (): string => "";

/**
 * A run's 完整记录, in a viewer tab (ADR 0085 §9, amendment 2026-11-04
 * later): every row of 板砖's run, none summarised, under the card's phases
 * — a read links its file, a command opens to its output's tail (and its
 * full log, when the tail was cut), a write opens to its diff, a steer
 * carries its speaker's avatar, a finding stands where it was made — and at
 * the end the marker's facts, which her verdict reads. Live while the run
 * works: it reads the session's record as it lands.
 *
 * No approvals: D7 keeps them out of the record, and this draws the
 * record's rows. 等待批准 is a state of the card and the row only.
 *
 * In the session's language, as the rows are in the chat (ADR 0019).
 */
/** Where each 完整记录 tab was left, by tab path (owner 2026-11-05): a file
 *  opened from a row takes the panel and this view unmounts, and coming back
 *  to the tab must land on the row the reader left. */
const leftAt = new Map<string, number>();

export function RunRecordView(props: { readonly path: string }): JSX.Element {
  return (
    // The tab sits beside the workspace, not inside its lightbox: a
    // screenshot row opens its own.
    <LightboxProvider>
      <RunRecord path={props.path} />
    </LightboxProvider>
  );
}

function RunRecord(props: { readonly path: string }): JSX.Element {
  const record = useSessionSelector((s) => s.record);
  const recordStart = useSessionSelector((s) => s.recordStart);
  const lang = useSessionSelector((s) => s.lang);
  const status = useSessionSelector((s) => s.status);
  const backendActive = useSessionSelector((s) => s.backendActive);
  const backendStartedAt = useSessionSelector((s) => s.backendStartedAt);
  const undoable = useSessionSelector((s) => s.undoable);
  const { bridge, sessionStore } = useHertaBridge();
  const sessionId = useSessionSelector((s) => s.sessionId);
  const t = useMemo(() => makeT(lang), [lang]);
  const openFile = useFileViewerOpen();
  const openLightbox = useLightbox();
  const { handleUndo, undoBusy } = useUndoTurn(sessionStore);

  const items = useMemo(
    () => groupRuns(liftUserImages(groupRecord(record))),
    [record],
  );
  const lastTurn = useMemo(() => lastTurnIndex(record), [record]);
  // The run whose first block the tab was opened on — found by that block,
  // so a window that later loaded earlier rows (moving the run's start)
  // still answers for it.
  const ref = useMemo(() => parseRunTabPath(props.path), [props.path]);
  const target = ref === null ? undefined : record[ref.index - recordStart];
  const found = useMemo((): { item: RunItem; idx: number } | null => {
    if (ref === null || target === undefined || target.kind !== "system")
      return null;
    if ((target.at ?? "") !== ref.at) return null;
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (item?.kind === "run" && item.blocks.includes(target))
        return { item, idx };
    }
    return null;
  }, [items, target, ref]);

  const onOpenWebPage = useMemo(() => {
    const open = bridge.openWebPage;
    if (sessionId === null || open === undefined) return undefined;
    return (url: string): void => {
      void open(sessionId, url);
    };
  }, [bridge, sessionId]);
  const ctx = useMemo(
    (): RowViewContext => ({
      t,
      openFile,
      openLightbox,
      onOpenWebPage,
      progressLabel: NO_PROGRESS,
    }),
    [t, openFile, openLightbox, onOpenWebPage],
  );
  // A row's view is kept while its blocks are the same objects: a live run
  // re-reads the record at every commit, and only its new rows are new.
  const views = useRef<{
    ctx: RowViewContext;
    cache: WeakMap<SystemBlock, RowView>;
  } | null>(null);
  if (views.current === null || views.current.ctx !== ctx) {
    views.current = { ctx, cache: new WeakMap() };
  }
  const cache = views.current.cache;
  const viewOf = (row: ActivityRow): RowView => {
    const hit = cache.get(row.block);
    if (
      hit !== undefined &&
      (row.patch === undefined) === (hit.patch === undefined)
    )
      return hit;
    const v = rowView(row, ctx);
    cache.set(row.block, v);
    return v;
  };

  const run = found?.item ?? null;
  const scroller = useRef<HTMLDivElement>(null);
  const shown = run !== null;
  useLayoutEffect(() => {
    const at = leftAt.get(props.path);
    if (shown && at !== undefined && scroller.current !== null) {
      scroller.current.scrollTop = at;
    }
  }, [props.path, shown]);
  const facts = useMemo(
    () => (run === null ? null : runFacts(run.blocks, run.dispatchedAt)),
    [run],
  );
  const sections = useMemo(
    () => (run === null ? [] : runSections(run.entries)),
    [run],
  );

  if (run === null || facts === null || found === null) {
    return (
      <div className="file-viewer__body">
        <p className="file-viewer__notice">{t("run.tab.gone")}</p>
      </div>
    );
  }

  const live =
    found.idx === openRun(items, lastTurn) &&
    status !== "idle" &&
    (backendActive || backendStartedAt !== null);
  const undo = undoTarget(items, lastTurn);
  const isUndoRun = undo.card === found.idx;
  const markerBlock = run.blocks.find(
    (b) => b.role === "done-marker" || b.role === "noop-marker",
  );
  const lastRow = lastRowOf(sections);

  return (
    <div className="file-viewer__body">
      <div
        ref={scroller}
        className="file-viewer__scroll run-record"
        data-testid="run-record"
        onScroll={(e) => leftAt.set(props.path, e.currentTarget.scrollTop)}
      >
        <RunHead
          facts={facts}
          live={live}
          t={t}
          undo={
            !isUndoRun || live
              ? null
              : undo.undone
                ? "done"
                : undoable && status === "idle"
                  ? undoBusy
                    ? "busy"
                    : "offer"
                  : null
          }
          onUndo={() => void handleUndo()}
        />
        {sections.length === 0 ? (
          <p className="file-viewer__notice">{t("run.tab.empty")}</p>
        ) : (
          <ol className="run-record__sections">
            {sections.map((section) =>
              section.kind === "steer" ? (
                <li key={section.key} className="run-record__steer">
                  <SpeakerAvatar
                    speaker={steerOf(section.block).speaker}
                    t={t}
                  />
                  <span className="run-record__steer-text">
                    {steerOf(section.block).text}
                  </span>
                </li>
              ) : (
                <li
                  key={section.key}
                  className={`run-record__phase is-${section.phase}`}
                >
                  <h3 className="run-record__phase-name">
                    {t(PHASE_KEY[section.phase])}
                  </h3>
                  <div className="run-record__rows">
                    {section.rows.map((row, i) => (
                      <RowViewStep
                        // Rows only append within a stretch; their bodies can
                        // repeat ("↳ exit 0 · 3 lines"), so the place is the key.
                        // biome-ignore lint/suspicious/noArrayIndexKey: see above
                        key={`${section.key}:${i}`}
                        view={viewOf(row)}
                        t={t}
                        active={live && row === lastRow}
                      />
                    ))}
                  </div>
                </li>
              ),
            )}
          </ol>
        )}
        {markerBlock !== undefined && (
          <MarkerFacts block={markerBlock} t={t} openFile={openFile} />
        )}
      </div>
    </div>
  );
}

function lastRowOf(sections: readonly RunSection[]): ActivityRow | undefined {
  for (let i = sections.length - 1; i >= 0; i--) {
    const s = sections[i];
    if (s?.kind === "phase") return s.rows[s.rows.length - 1];
  }
  return undefined;
}

const STATE_KEY = {
  working: "run.state.working",
  verifying: "run.state.verifying",
} as const;

/** The tab's head: the state, the counts, the time, and 撤销本轮改动 once
 *  the run has ended (ADR 0074's rules decide when). */
function RunHead(props: {
  readonly facts: NonNullable<ReturnType<typeof runFacts>>;
  readonly live: boolean;
  readonly t: TFn;
  readonly undo: "offer" | "busy" | "done" | null;
  readonly onUndo: () => void;
}): JSX.Element {
  const { facts, live, t } = props;
  const { summary } = facts;
  // No approval state here: the tab draws the record (D7).
  const state = liveState(facts.phase, false);
  const headline =
    summary === null
      ? live
        ? t(STATE_KEY[state === "verifying" ? "verifying" : "working"])
        : null
      : composeMarkerSummary(summary, t);
  // The live time ticks on the run's row; the head says it once it ended.
  const took = live ? null : runTookMs(facts);
  const counts = [
    facts.steps === 1
      ? t("trace.card.stepOne")
      : t("trace.card.steps", { n: String(facts.steps) }),
    ...(facts.files > 0
      ? [
          facts.files === 1
            ? t("trace.card.fileOne")
            : t("trace.card.files", { n: String(facts.files) }),
        ]
      : []),
    ...(took !== null
      ? [`${t("workspace.took")} ${formatDuration(took)}`]
      : []),
  ];
  return (
    <header className="run-record__head">
      <div className="run-record__state">
        <span
          className={`run-record__led${live ? " is-live" : ""}`}
          aria-hidden="true"
        />
        <span className="run-record__label">
          {t("record.chip.coprocessor")}
        </span>
        {headline !== null && (
          <span className="run-record__summary">
            {headline}
            {summary?.kind === "structured" &&
              summary.marker.lines !== undefined && (
                <>
                  {" · "}
                  <DiffStat value={summary.marker.lines} rollup />
                </>
              )}
          </span>
        )}
      </div>
      <div className="run-record__meta">
        <span className="run-record__counts">{counts.join(" · ")}</span>
        {props.undo === "done" ? (
          <span className="activity-undo is-done">
            {t("activity.undo.chipDone")}
          </span>
        ) : props.undo !== null ? (
          <button
            type="button"
            className="activity-undo"
            disabled={props.undo === "busy"}
            onClick={props.onUndo}
          >
            {t("run.undoAll")}
          </button>
        ) : null}
      </div>
    </header>
  );
}

/** The marker's facts — changed files, risks, open items — at the end: what
 *  her verdict reads. A changed file opens in the viewer. */
function MarkerFacts(props: {
  readonly block: SystemBlock;
  readonly t: TFn;
  readonly openFile: ReturnType<typeof useFileViewerOpen>;
}): JSX.Element | null {
  const { block, t, openFile } = props;
  const detail = stepDisplayDetail(block, t);
  if (detail === undefined) return null;
  const links: FileLinkTarget[] =
    openFile === null
      ? []
      : (block.evidence ?? [])
          .filter((s) => s.kind === "files")
          .flatMap((s) =>
            s.paths.map(
              (p): FileLinkTarget => ({
                text: p,
                onOpen: () => openFile(p, {}),
                ariaLabel: `${t("activity.file.openAria")} ${p}`,
              }),
            ),
          );
  return (
    <section className="run-record__facts">
      <h3 className="run-record__phase-name">{t("activity.result.detail")}</h3>
      <pre className="run-record__facts-body">
        {links.length > 0 ? textWithLinks(detail, links) : detail}
      </pre>
    </section>
  );
}
