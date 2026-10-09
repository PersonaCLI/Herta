import type { AutoReviewNotice } from "@herta/app-server";
import type { UndoFileResult } from "@herta/core";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import type { MessageKey } from "../../i18n/keys.js";
import { makeT } from "../../i18n/LocaleProvider.js";
import { hoverTipProps } from "../common/hover-tip.js";
import {
  useFileViewerOpen,
  type ViewerAnchor,
} from "../FileViewer/file-viewer-context.js";
import {
  ActivityStep,
  type ActivityStepProps,
  type FileLinkTarget,
  textWithLinks,
} from "./ActivityStep.js";
import type { AttachProgressFrame } from "./attach-progress.js";
import { useUnpinConversation } from "./ConversationPin.js";
import { DiffStat, type DiffStatValue } from "./DiffStat.js";
import { type DiffSummary, summarizeDiff } from "./diff-summary.js";
import { opTarget, parseCite } from "./file-name-target.js";
import {
  activityChipLabel,
  activityHasTerminalMarker,
  activityRows,
  activitySteps,
  activitySummary,
  type SystemBlock,
} from "./group-record.js";
import { composeMarkerSummary } from "./marker-summary.js";
import { isAttachHandoff, pendingAttachIndex } from "./pending-attach.js";
import { SwapText } from "./SwapText.js";
import {
  latestOpStep,
  middleTruncateName,
  stepDisplayBody,
  stepDisplayDetail,
} from "./step-display.js";
import { type StepIconKey, stepIcon } from "./step-icon.js";

/** One history row's props, derived once per `blocks` identity. */
interface RowView {
  readonly body: string;
  readonly icon: StepIconKey;
  readonly failed: boolean;
  readonly isOp: boolean;
  readonly detail: string | undefined;
  readonly patch: { stat: DiffStatValue; diff: string } | undefined;
  readonly at: string | undefined;
  readonly stat: DiffStatValue | undefined;
  readonly remove: (() => void) | undefined;
  readonly removeLabel: string | undefined;
  readonly file: ActivityStepProps["file"];
  readonly links: ActivityStepProps["links"];
  /** A placeholder of the attach in flight (2026-10-01). */
  readonly progress: ActivityStepProps["progress"];
  /** A real row that just replaced a placeholder. */
  readonly progressFinishing: boolean;
}

export interface ActivityBlockProps {
  readonly blocks: readonly SystemBlock[];
  /** True while this is the last group and the turn is still running. */
  readonly active: boolean;
  /** Renderer turn start (Date.now); used to time a live run. */
  readonly turnStartedAt: number | null;
  /** Actual 板砖 backend start (Date.now at backend-layer turn.started);
   *  preferred over turnStartedAt as the timer anchor. */
  readonly backendStartedAt: number | null;
  /** Active session interaction language: the whole activity line (chip,
   *  markers, step verbs, duration) follows the SESSION, not the UI locale
   *  (GUI record-label parity, ADR 0018 / ADR 0015 §4). */
  readonly lang: "zh" | "en";
  /** Number of backend tool calls currently in flight (from the raw agent
   *  stream). >1 during a parallel read-only batch (ADR 0025 slice 5) —
   *  the last N op rows shimmer together instead of only the last-started
   *  one. Optional: omitted/1 keeps the classic single-row shimmer. */
  readonly inFlightCount?: number;
  /**
   * Factory for an attachment row's take-back handler, or undefined when
   * removal is unavailable (no session, or a turn in flight). A FACTORY keyed
   * on the stored path rather than a handler taking one, so the row itself
   * never has to hold or forward record state.
   *
   * A prop, not a hook call here: this component is `memo`'d over a stable
   * `blocks` identity, and reaching for the bridge inside it would make every
   * historical group re-render on unrelated store churn.
   */
  readonly onRemoveAttachment?: (path: string) => () => void;
  /**
   * The 撤销 chip (ADR 0074 §4) — only on the latest turn's last finished
   * 板砖 card, and only the user's: nothing of it is in the record. `offer`
   * takes the turn's edits back on a click; `busy` while that runs; `done`
   * once the turn holds its undo line.
   */
  readonly undo?:
    | { readonly state: "offer" | "busy"; readonly onUndo: () => void }
    | { readonly state: "done" };
  /**
   * ADR 0075: what the automatic reviewer settled in this run, shown under
   * the header so the owner sees each one without opening the history —
   * user-only, never the record's (D7).
   */
  readonly autoReviews?: readonly AutoReviewNotice[];
}

const AUTO_REVIEW_KEY = {
  allow: "activity.autoReview.allowed",
  deny: "activity.autoReview.denied",
  paused: "activity.autoReview.paused",
} as const satisfies Record<AutoReviewNotice["decision"], MessageKey>;

/** An undo line's per-file results (ADR 0074 §3), in the session language. */
const UNDO_RESULT_KEY = {
  restored: "activity.undo.result.restored",
  deleted: "activity.undo.result.deleted",
  unchanged: "activity.undo.result.unchanged",
  changed_since: "activity.undo.result.changed_since",
  not_kept: "activity.undo.result.not_kept",
  outside_workspace: "activity.undo.result.outside_workspace",
  failed: "activity.undo.result.failed",
} as const satisfies Record<UndoFileResult, MessageKey>;

type UndoDigest = Extract<
  NonNullable<SystemBlock["digest"]>,
  { readonly kind: "undo" }
>;

/** The undo line's header: what came back, and how much was left alone —
 *  a skipped file and a command's edit alike are still changed. */
function undoSummary(d: UndoDigest, t: ReturnType<typeof makeT>): string {
  const count = (pred: (r: UndoFileResult) => boolean): number =>
    d.files.filter((f) => pred(f.result)).length;
  const restored = count((r) => r === "restored");
  const deleted = count((r) => r === "deleted");
  const left =
    count((r) => r !== "restored" && r !== "deleted" && r !== "unchanged") +
    d.commands.length;
  return [
    t("activity.undo.summary"),
    ...(restored > 0
      ? [t("activity.undo.count.restored", { n: restored })]
      : []),
    ...(deleted > 0 ? [t("activity.undo.count.deleted", { n: deleted })] : []),
    ...(left > 0 ? [t("activity.undo.count.left", { n: left })] : []),
  ].join(" · ");
}

/** The row views of a history nobody has opened yet — one shared empty array,
 *  so the memo below hands every such group the same identity. */
const NO_ROWS: readonly RowView[] = [];

/**
 * The magnitude recorded on a patch block, or the honest absence of one.
 *
 * The digest is the source of truth. The fallback to counting the fenced diff
 * is for records written before the `patch` digest existed (their preview is a
 * `skip` with no counts) — and it is the SAME computation the projector runs
 * at write time, not an inference, so those rows get a real number instead of
 * silence. No diff at all → `unmeasured`, which renders nothing.
 */
function patchStat(block: SystemBlock, summary?: DiffSummary): DiffStatValue {
  const d = block.digest;
  if (d?.kind === "patch" && d.add !== undefined && d.del !== undefined) {
    return { add: d.add, del: d.del };
  }
  const s = summary ?? summarizeDiff(block.body);
  if (s.hasDiff && s.diffLineCount > 0) {
    return { add: s.addCount, del: s.delCount };
  }
  return "unmeasured";
}

/** What a write's row folds in: its magnitude, and the diff it wrote. */
function foldedPatch(block: SystemBlock): {
  stat: DiffStatValue;
  diff: string;
} {
  const summary = summarizeDiff(block.body);
  return { stat: patchStat(block, summary), diff: summary.diffText };
}

function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${`${s}`.padStart(2, "0")}`;
}

/**
 * Backend activity rendered as a single live status line: pulsing LED +
 * label + the latest step swapping in place + elapsed time. Default-
 * collapsed even while running — clicking toggles the quiet hairline
 * history; the done state shows the summary + duration + chevron
 * (spec 2026-06-12 §6). Owns its own timing so a live run shows a duration
 * even though the record carries none (historical groups show no duration).
 *
 * memo: `blocks` identity is stable per record snapshot (groupRecord is
 * memoized on the record), so historical groups bail out of Conversation's
 * per-delta re-renders; the live group still updates via its own 1 Hz tick
 * and its changing props.
 */
export const ActivityBlock = memo(function ActivityBlock(
  props: ActivityBlockProps,
): JSX.Element {
  const { blocks, active, turnStartedAt, backendStartedAt, lang } = props;
  const inFlightCount = props.inFlightCount ?? 1;
  const onRemoveAttachment = props.onRemoveAttachment;
  const t = useMemo(() => makeT(lang), [lang]);
  // A placeholder row's count (2026-10-01), in the session's language like
  // every string in the row. One function per language, so the rows' views
  // stay identity-stable across frames.
  const progressLabel = useCallback(
    (f: AttachProgressFrame | undefined): string => {
      if (f === undefined || f.stage === "done") return "";
      if (f.stage === "waiting")
        return t("activity.attachment.progress.waiting");
      if (f.stage === "transcripts") {
        return t("activity.attachment.progress.pictures", {
          done: f.done,
          total: f.total,
        });
      }
      return f.total > 0
        ? t("activity.attachment.progress.page", {
            // The page being read, not the pages finished.
            done: Math.min(f.done + 1, f.total),
            total: f.total,
          })
        : t("activity.attachment.progress.reading");
    },
    [t],
  );
  // Everything derived from the blocks, once per `blocks` identity
  // (2026-09-03): the live group re-renders at 1 Hz for its duration and on
  // every in-flight tool call, and every group re-renders at a turn
  // boundary — none of which changes what the blocks say. Before this the
  // header labels, the step/row projections and the marker detail were
  // re-derived on each of those renders.
  const derived = useMemo(() => {
    const chip = activityChipLabel(blocks);
    const summary = activitySummary(blocks);
    const done = activityHasTerminalMarker(blocks);
    // Localized header summary composed from the structured marker (or the
    // canonical body verbatim for pre-structured records). D7: the record
    // body is untouched; this is display-only.
    // An undo line (ADR 0074 §4) is its own group: a header saying what came
    // back, and a row per file.
    const undoDigest: UndoDigest | null =
      blocks.length === 1 && blocks[0]?.digest?.kind === "undo"
        ? blocks[0].digest
        : null;
    const headline =
      undoDigest !== null
        ? undoSummary(undoDigest, t)
        : done && summary !== null
          ? composeMarkerSummary(summary, t)
          : null;
    // The commit the run landed (ADR 0049 §4) — the headline's `提交 sha`
    // segment becomes the commit tab's opener (ADR 0059).
    const commitSha =
      summary?.kind === "structured"
        ? (summary.marker.git?.commit ?? null)
        : null;
    const steps = activitySteps(blocks);
    // Rendered rows, not raw blocks: a patch preview folds into the write it
    // previews (the permission rule emits it BEFORE the tool runs, so the
    // record holds diff-then-action and the history read backwards). The
    // live-line lookup below stays on `steps` — a patch block is not an op,
    // so folding cannot change what it finds.
    const rows = activityRows(blocks);
    // The terminal marker's evidenceDetail (改动文件 / 风险 / 待办 / output
    // roll-up — what Herta's prompt reads) surfaces as one expandable row at
    // the end of the history (2026-07-23).
    const markerBlock = blocks.find(
      (b) => b.role === "done-marker" || b.role === "noop-marker",
    );
    const markerDetail =
      markerBlock === undefined ? undefined : stepDisplayDetail(markerBlock, t);
    // Live line shows the latest OPERATION, localized (bugs 3+4, 2026-07-10):
    // a result row ("↳ exit 1 · 0 lines") as the "current activity" reads
    // wrong while the backend works, and the projected verbs are canonical
    // English regardless of locale. Result rows still appear in the history.
    const latestOp = latestOpStep(steps);
    const latestStep =
      latestOp !== undefined ? stepDisplayBody(latestOp, t) : "";
    return {
      chip,
      summary,
      done,
      headline,
      commitSha,
      rows,
      markerBlock,
      markerDetail,
      latestStep,
      undoDigest,
    };
  }, [blocks, t]);
  const {
    chip,
    summary,
    done,
    headline,
    commitSha,
    rows,
    markerBlock,
    markerDetail,
    undoDigest,
  } = derived;
  const latestStep = derived.latestStep;
  // Expandable only when there are operational rows to reveal. A group that
  // is just a terminal marker (e.g. 完成 · 1 file) has nothing behind the
  // chevron — so it gets no chevron and the line isn't a toggle (bug 1) —
  // unless the marker carries evidence detail worth expanding.
  const expandable = rows.length > 0 || markerDetail !== undefined;

  const reduced = useReducedMotion();
  const unpin = useUnpinConversation();
  // Stable opener (or null when no viewer is available — the demo, bare
  // tests): its identity never changes, so reading it here cannot
  // invalidate the load-bearing record-identity memo (ADR 0050 §1).
  const openFile = useFileViewerOpen();
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  // An all-attachment group is a USER act filed under the system chip (ADR
  // 0033): "which files did I just hand over" is the whole point of the row,
  // so it defaults OPEN — a collapsed `系统 ›` with the filenames behind a
  // click answered nothing (owner 2026-08-10). Backend activity keeps the
  // default-collapsed contract below: the line IS the rendering (F4). Mixed
  // groups (an attachment swept into a dispatch run by an edge-case record
  // tail) count as activity, not as an attach act.
  const isAttachmentGroup =
    blocks.length > 0 && blocks.every((b) => b.digest?.kind === "attachment");
  // Default-collapsed even while running — the line IS the rendering (F4).
  const expanded = expandable
    ? (userToggled ?? (isAttachmentGroup || undoDigest !== null))
    : false;
  // The history's rows mount on the FIRST expand and stay mounted — the same
  // lifecycle as a row's own diff and detail panes (ActivityStep), one level
  // up (ADR 0068 §11, 2026-09-22). A session carries every dispatch it ever
  // ran, and the line IS the rendering; yet an unexpanded history still paid,
  // at mount, for every row's DOM and for the fold of every write's diff (a
  // split and re-join of the whole patch, in rowViews below) — work no reader
  // had asked for, repeated for every historical group on every session
  // switch. The panel element itself stays mounted whenever expandable, so
  // the measured reveal below always has something to size; only its
  // contents wait. Seeded from the mount-time `expanded` so a default-open
  // attachment group draws its filenames at once, and latched by the click
  // that opens — in the same batch as the toggle, so the layout effect
  // measures the rows it is about to reveal.
  const [historyMounted, setHistoryMounted] = useState(expanded);
  const rowsMounted = historyMounted || expanded;
  // Entrance for a LIVE attach (owner 2026-08-10: the row popped in with no
  // motion). Same adopted feel as the session-switch entrance (350ms / 12px /
  // easeOutQuint — one motion vocabulary, not two). Recency-gated off the
  // block's own `at` stamp, decided ONCE at mount: a live append is seconds
  // old, a session switch or reload mounts blocks that are not — so history
  // never replays the entrance. Deliberately no store flag ("animate the next
  // group") — cross-component transient state is the exact class the
  // 2026-07-24 audit catalogued.
  const [entering, setEntering] = useState(() => {
    if (!isAttachmentGroup || reduced) return false;
    const at = blocks[blocks.length - 1]?.at;
    if (at === undefined) return false;
    const age = Date.now() - Date.parse(at);
    // `5000 > age`, not `age < 5000`: the no-hardcoded-english guard scans
    // .tsx lines for `>text<` JSX-text shapes, and the `<` here after the
    // `>=` reads as a text node ">= 0 && age<" to its regex.
    return Number.isFinite(age) && age >= 0 && 5000 > age;
  });

  const startRef = useRef<number | null>(null);
  const [frozenMs, setFrozenMs] = useState<number | null>(null);
  const [, forceTick] = useState(0);
  const lastBlockAt = blocks[blocks.length - 1]?.at;

  useEffect(() => {
    if (active) {
      if (startRef.current === null)
        startRef.current = backendStartedAt ?? turnStartedAt ?? Date.now();
      const id = window.setInterval(() => forceTick((t) => t + 1), 1000);
      return () => window.clearInterval(id);
    }
    if (startRef.current !== null && frozenMs === null) {
      setFrozenMs(Date.now() - startRef.current);
      return undefined;
    }
    // Born-done part: a beat split the run so the 完成 part was never active and
    // carries no live timing. Freeze the whole-run total from backendStartedAt —
    // captured here while it is still set (the backend turn.finished keeps it;
    // only the later actor turn-finished clears it). End at the 完成 block's own
    // timestamp so the frozen value is stable across re-renders. On a reloaded
    // session backendStartedAt is null, so historical groups stay duration-less.
    if (
      !active &&
      done &&
      frozenMs === null &&
      startRef.current === null &&
      backendStartedAt !== null
    ) {
      const parsed =
        lastBlockAt !== undefined ? Date.parse(lastBlockAt) : Number.NaN;
      const end = Number.isNaN(parsed) ? Date.now() : parsed;
      // The anchor must actually BELONG to this group (audit 2026-07-24,
      // 1.14). Nothing tied them together except the absence of the group's
      // own timing, and `backendStartedAt` is passed to EVERY group — so
      // clicking 加载更早 during a live run mounted historical rows fresh
      // (both refs null) against the running dispatch's anchor, making a past
      // multi-minute run render 用时 0s: `end - backendStartedAt` went
      // negative and the clamp below hid it. A group whose last block predates
      // the anchor cannot be part of that run.
      if (end >= backendStartedAt) setFrozenMs(end - backendStartedAt);
    }
    return undefined;
  }, [active, backendStartedAt, turnStartedAt, frozenMs, done, lastBlockAt]);

  const anchor = backendStartedAt ?? turnStartedAt;
  const elapsedMs =
    frozenMs ??
    (startRef.current !== null
      ? Date.now() - startRef.current
      : active && anchor !== null
        ? Date.now() - anchor
        : null);
  // An undo line's rows (ADR 0074 §4): one per file, saying what happened to
  // it, then what commands changed — never restored. A file still on disk
  // opens in the viewer; a deleted or out-of-workspace one has nothing to open.
  const undoRows =
    undoDigest === null ? null : (
      <>
        {undoDigest.files.map((f) => (
          <ActivityStep
            key={`undo:${f.path}`}
            body={`${f.path} · ${t(UNDO_RESULT_KEY[f.result])}`}
            t={t}
            icon={
              f.result === "restored" || f.result === "deleted"
                ? "write"
                : "dot"
            }
            active={false}
            {...(openFile !== null &&
            f.result !== "deleted" &&
            f.result !== "outside_workspace"
              ? {
                  file: {
                    path: f.path,
                    onOpen: () => openFile(f.path, {}),
                    ariaLabel: `${t("activity.file.openAria")} ${f.path}`,
                  },
                }
              : {})}
          />
        ))}
        {undoDigest.commands.map((path) => (
          <ActivityStep
            key={`undo-cmd:${path}`}
            body={`${path} · ${t("activity.undo.commands")}`}
            t={t}
            icon="run"
            active={false}
          />
        ))}
        {undoDigest.commandsUnknown && undoDigest.commands.length === 0 && (
          <ActivityStep
            body={t("activity.undo.commandsUnknown")}
            t={t}
            icon="run"
            active={false}
          />
        )}
      </>
    );
  const durationText = elapsedMs === null ? null : formatDuration(elapsedMs);
  // One duration per 板砖 run, not per split part. When a beat bubble lands
  // between backend blocks it splits the run into separate activity groups;
  // only the FINAL part (the one carrying the 完成/terminal marker) shows the
  // total — anchored to backendStartedAt, so it's the whole run, not just the
  // last segment. The active part shows a live timer; the frozen intermediate
  // parts (not terminal) show nothing.
  const durationLabel =
    durationText === null
      ? null
      : active
        ? durationText
        : done
          ? `${t("workspace.took")} ${durationText}`
          : null;
  // The history rows' props, once per `blocks` identity (2026-09-03) — the
  // localized bodies and details, the folded diff (a split + re-join of the
  // whole patch), the click targets and their closures. `ActivityStep` is
  // memo'd, so a row whose view object is unchanged does not reconcile at
  // all; only the shimmer flag is computed per render. `openFile` and the
  // take-back factory are identity-stable by their own contracts.
  const rowViews = useMemo(
    (): readonly RowView[] =>
      // Not before the rows are wanted: the fold of each write's diff is
      // the costly part of a row's view, and a history nobody has opened
      // has no rows to give it to.
      !rowsMounted
        ? NO_ROWS
        : rows.map((row) => {
            const b = row.block;
            const failed = b.digest?.kind === "tool-fail";
            // The file NAME as a click target (ADR 0050 §1): op rows whose
            // digest arg is the path — reads, writes, and the folded-patch edit
            // rows all carry one. Attachment rows too (owner 2026-08-31): the
            // NAME in the body opens the STORED copy under .herta/attachments/
            // — text attachments only (pictures already have the thumbnail +
            // lightbox), and only while the store still holds the file.
            const fileTarget: {
              readonly path: string;
              readonly name?: string;
              readonly label?: string;
              readonly anchor?: ViewerAnchor;
            } | null =
              openFile === null
                ? null
                : b.digest?.kind === "op" &&
                    (b.digest.verb === "Reading" ||
                      b.digest.verb === "Writing") &&
                    b.digest.arg.length > 0
                  ? // An excerpt read's arg carries its range
                    // ("viewer-demo.txt:2-8") — parse it like a cite so the
                    // click opens the REAL file anchored at those lines instead
                    // of asking the jail for a path with a colon in it (found
                    // live, 2026-08-31). `name` stays the verbatim arg — it is
                    // what the row displays.
                    opTarget(b.digest.arg)
                  : b.digest?.kind === "attachment" &&
                      b.digest.image === undefined &&
                      b.digest.unreadable !== "removed" &&
                      // The ORIGINAL document when the ingest kept one (ADR 0038
                      // amendment): the viewer draws the PDF / Word /
                      // spreadsheet / deck itself (ADR 0054), even when no text
                      // came out of it. Otherwise the stored text: `too_large`
                      // means STORED but no head excerpt taken — the viewer's
                      // own bounded read is exactly the remedy, so it stays
                      // clickable; genuinely dead states (read_error / denied /
                      // …) stay plain.
                      (b.digest.source !== undefined ||
                        (b.digest.path.length > 0 &&
                          (b.digest.unreadable === undefined ||
                            b.digest.unreadable === "too_large")))
                    ? {
                        path: b.digest.source ?? b.digest.path,
                        // The row DISPLAYS the middle-truncated name (long names
                        // wrapped the row, owner 2026-08-10) — split on what is
                        // actually on screen or a long name silently loses its
                        // click affordance. The panel breadcrumb gets the WHOLE
                        // name.
                        name: middleTruncateName(b.digest.name),
                        label: b.digest.name,
                      }
                    : null;
            const file: ActivityStepProps["file"] =
              fileTarget !== null && openFile !== null
                ? {
                    path: fileTarget.path,
                    ...(fileTarget.name !== undefined
                      ? { name: fileTarget.name }
                      : {}),
                    onOpen: () =>
                      openFile(fileTarget.path, {
                        ...(fileTarget.label !== undefined
                          ? { label: fileTarget.label }
                          : {}),
                        ...(fileTarget.anchor !== undefined
                          ? { anchor: fileTarget.anchor }
                          : {}),
                      }),
                    ariaLabel: `${t("activity.file.openAria")} ${fileTarget.name ?? fileTarget.path}`,
                  }
                : undefined;
            // A finding's cites open the viewer AT the cited lines (ADR 0050
            // v1.5) — each cite in the row becomes its own target; unparseable
            // ones stay plain text.
            const links: ActivityStepProps["links"] =
              openFile !== null &&
              b.digest?.kind === "finding" &&
              b.digest.cites.length > 0
                ? b.digest.cites.flatMap((cite): FileLinkTarget[] => {
                    const parsed = parseCite(cite);
                    if (parsed === null) return [];
                    return [
                      {
                        text: cite,
                        onOpen: () =>
                          openFile(parsed.path, {
                            ...(parsed.anchor !== undefined
                              ? { anchor: parsed.anchor }
                              : {}),
                          }),
                        ariaLabel: `${t("activity.file.openAria")} ${cite}`,
                      },
                    ];
                  })
                : undefined;
            // Take-back, offered only where it can actually work: a stored
            // attachment (a path to delete), not already removed. Mid-turn the
            // control hides by CSS (`.conversation-flow.is-busy`) and the handler
            // itself re-checks the live status — the factory no longer changes
            // identity with the turn, so the rows stay memo-stable across it.
            const remove =
              onRemoveAttachment !== undefined &&
              b.digest?.kind === "attachment" &&
              (b.digest.path.length > 0 || b.digest.source !== undefined) &&
              b.digest.unreadable !== "removed"
                ? // Addressed by the text path when there is one, else by the
                  // original's (a source-only document — the session's removal
                  // accepts either).
                  onRemoveAttachment(
                    b.digest.path.length > 0
                      ? b.digest.path
                      : (b.digest.source as string),
                  )
                : undefined;
            // A placeholder of the attach in flight (2026-10-01) says only
            // which file it is — its counts ride the hairline; the record
            // block that replaces it states the rest.
            const pendingIndex = pendingAttachIndex(b);
            const pendingName =
              pendingIndex !== undefined && b.digest?.kind === "attachment"
                ? b.digest.name
                : undefined;
            return {
              body:
                pendingName !== undefined
                  ? `${t("activity.attachment.label")} ${middleTruncateName(pendingName)}`
                  : stepDisplayBody(b, t),
              progress:
                pendingIndex !== undefined
                  ? { index: pendingIndex, label: progressLabel }
                  : undefined,
              progressFinishing: isAttachHandoff(b),
              // Icon parses the CANONICAL body — the display body may be a
              // localized verb stepIcon can't recognize. Failure and
              // attachment rows key off the structured digest instead.
              icon: failed
                ? "fail"
                : b.digest?.kind === "attachment"
                  ? "attach"
                  : stepIcon(b.body),
              failed,
              isOp: b.digest?.kind === "op",
              detail: stepDisplayDetail(b, t),
              // The write states its own magnitude, and the diff it wrote folds
              // in underneath (2026-08-25 evening).
              patch:
                row.patch !== undefined ? foldedPatch(row.patch) : undefined,
              // The row's own stamp gates the magnitude's count-up: live appends
              // animate, a reloaded session's history does not.
              at: b.at,
              // A patch with no write to fold into (a DENIED edit) still answers
              // with its magnitude, in place of the body's first line — the
              // element, because the digits count up.
              stat:
                row.patch === undefined && b.digest?.kind === "patch"
                  ? patchStat(b)
                  : undefined,
              remove,
              removeLabel:
                remove !== undefined
                  ? t("activity.attachment.remove")
                  : undefined,
              file,
              links,
            };
          }),
    [rows, t, openFile, onRemoveAttachment, rowsMounted, progressLabel],
  );

  // Animated reveal of the history (bug 2). The panel is always mounted (when
  // expandable) and grows/shrinks via a measured max-height transition, so the
  // blocks below are pushed DOWN smoothly instead of jumping. The conversation
  // scroller sets `overflow-anchor: none` so the growth always points downward
  // — without it the browser's scroll anchoring intermittently compensates
  // scrollTop and shoves the blocks ABOVE upward instead (bug 2c).
  const historyRef = useRef<HTMLDivElement>(null);
  const prevExpandedRef = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const el = historyRef.current;
    if (el === null) return;
    const prev = prevExpandedRef.current;
    prevExpandedRef.current = expanded;
    // The panel stays `overflow: hidden` throughout (the CSS default here) so
    // the max-height reveal clips cleanly. An earlier pass lifted the clip
    // while open, to stop it cutting a row's hover tooltip; that is gone —
    // the tooltip is portaled to <body> now (see Tooltip `portal`), which
    // fixes the clipping for every ancestor rather than this one, and lets
    // the reveal keep the simple always-clipped behaviour it was written for.
    // First commit for this element: set the resting state, no animation.
    if (prev === null) {
      el.style.maxHeight = expanded ? "none" : "0px";
      return;
    }
    // Steps changed but the open/closed state held — never animate on step
    // churn; keep an open panel free-growing and a closed one collapsed.
    if (prev === expanded) {
      if (expanded) el.style.maxHeight = "none";
      return;
    }
    if (reduced) {
      el.style.maxHeight = expanded ? "none" : "0px";
      return;
    }
    if (expanded) {
      // 0 → measured content height; onTransitionEnd then releases the ceiling
      // to `none` so a later inner-diff expand isn't clipped.
      el.style.maxHeight = `${el.scrollHeight}px`;
    } else {
      // `none` → pinned px → reflow → 0, giving the collapse a start value.
      el.style.maxHeight = `${el.scrollHeight}px`;
      void el.offsetHeight;
      el.style.maxHeight = "0px";
    }
    // `steps.length` is intentionally NOT a dep: once open, onTransitionEnd
    // releases maxHeight to `none`, so later-appended steps grow freely
    // without re-running this effect.
  }, [expanded, reduced]);

  return (
    <div
      className={`activity-line-group${active ? " is-active" : ""}${
        entering ? " is-attach-enter" : ""
      }`}
      // Drop the class once it has played. `animation-fill-mode: both` keeps
      // a FINISHED animation applied, and an element with a filling
      // opacity/transform animation stays a stacking context — which would
      // trap a row's tooltip z-index inside this group forever. The entrance
      // is a one-shot; nothing should outlive it. Gated on the animation
      // NAME: React's onAnimationEnd fires for BUBBLED descendant animations
      // too, and a future child animation ending first would otherwise clear
      // the entrance mid-flight.
      onAnimationEnd={
        entering
          ? (e) => {
              if (e.animationName === "conv-switch-in") setEntering(false);
            }
          : undefined
      }
      data-testid="activity-block"
    >
      {/* The toggle shrinks to its CONTENT; the row around it holds the
          right-anchored duration (owner 2026-07-27: `.activity-line` was
          `width: 100%`, so the wide empty gap between the summary and the
          right edge was part of the button — clicking dead space expanded
          the row, and the cursor turned into a pointer over a region with
          no affordance in it at all). The clickable area is now exactly
          what it looks like: the LED, the label, the summary, the chevron. */}
      <div className="activity-line-row">
        <button
          type="button"
          className={`activity-line${expandable ? "" : " is-static"}`}
          aria-expanded={expandable ? expanded : undefined}
          onClick={
            expandable
              ? () => {
                  // Opening the history grows the record below the line with
                  // no scroll event — unpin so the follow machinery can't
                  // later yank the viewport past it (see ConversationPin.tsx).
                  // The first open also mounts the rows (see historyMounted).
                  if (!expanded) {
                    unpin();
                    setHistoryMounted(true);
                  }
                  setUserToggled(!expanded);
                }
              : undefined
          }
        >
          <span
            className={`activity-line__led${active ? " is-pulsing" : ""}`}
            aria-hidden="true"
          />
          <span className="activity-line__label">
            {t(
              chip === "差分协处理器"
                ? "record.chip.coprocessor"
                : "record.chip.system",
            )}
          </span>
          {active ? (
            <SwapText text={latestStep} reduced={reduced} shimmer />
          ) : (
            headline !== null && (
              <span className="activity-line__summary">
                {/* The sha the run committed opens the commit beside the
                    record (ADR 0059) — the same name affordance as a file,
                    inside the toggle button, so activation stops there. */}
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
                {/* The dispatch's total, as an element so the digits count up
                    like the per-write rows they sum. Present only when every
                    changed file had a real diff — see DoneMarkerSummary.lines. */}
                {summary?.kind === "structured" &&
                  summary.marker.lines !== undefined && (
                    <>
                      {" · "}
                      <DiffStat
                        value={summary.marker.lines}
                        rollup
                        {...(summary.at !== undefined
                          ? { at: summary.at }
                          : {})}
                      />
                    </>
                  )}
              </span>
            )
          )}
          {/* Chevron INLINE after the summary text (user 2026-07-07: it
            floated detached at the far edge); only the duration stays
            right-anchored (its margin-left:auto in CSS). */}
          {!active && expandable && (
            <svg
              className="activity-line__chevron"
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              aria-hidden="true"
            >
              <path d={expanded ? "M2 6.5l3-3 3 3" : "M3.5 2l3 3-3 3"} />
            </svg>
          )}
        </button>
        {/* Outside the button: the duration is a fact about the run, not part
          of the toggle's label, and it is what pinned the button to the full
          row width. */}
        {/* 撤销 (ADR 0074 §4): outside the toggle like the duration — a
          button cannot sit in a button, and taking edits back is not
          opening the history. */}
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
        {durationLabel !== null && (
          <span className="activity-line__duration">{durationLabel}</span>
        )}
      </div>
      {props.autoReviews !== undefined && props.autoReviews.length > 0 && (
        <ul className="activity-reviews">
          {props.autoReviews.map((n) => (
            <li
              key={`${n.requestId}:${n.decision}`}
              className={`activity-review is-${n.decision}`}
            >
              <span className="activity-review__label">
                {t(AUTO_REVIEW_KEY[n.decision])}
              </span>
              {n.command !== null && (
                <code
                  className="activity-review__command"
                  {...hoverTipProps(n.command)}
                >
                  {n.command}
                </code>
              )}
              {n.reason !== "" && (
                <span
                  className="activity-review__reason"
                  {...hoverTipProps(n.reason)}
                >
                  {n.reason}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {expandable && (
        <div
          ref={historyRef}
          className={`activity-line__history${expanded ? " is-open" : ""}`}
          onTransitionEnd={(e) => {
            if (e.propertyName !== "max-height") return;
            const el = historyRef.current;
            if (el !== null && expanded) el.style.maxHeight = "none";
          }}
        >
          <div className="activity-line__history-inner">
            {rowsMounted && undoDigest !== null && undoRows}
            {rowsMounted &&
              undoDigest === null &&
              rowViews.map((rv, i) => {
                // A parallel batch (ADR 0025 slice 5) has several ops in
                // flight at once — shimmer the last `inFlightCount` op rows
                // together; the classic single-row shimmer otherwise.
                const shimmer =
                  active &&
                  (i === rowViews.length - 1 ||
                    (inFlightCount > 1 &&
                      rv.isOp &&
                      i >= rowViews.length - inFlightCount));
                return (
                  <ActivityStep
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are append-only and stable-order; bodies can duplicate (repeated "↳ exit 0 · N lines" rows), so body keys would collide and shimmer/reconcile the wrong row.
                    key={i}
                    body={rv.body}
                    t={t}
                    icon={rv.icon}
                    active={shimmer}
                    failed={rv.failed}
                    detail={rv.detail}
                    patch={rv.patch}
                    at={rv.at}
                    stat={rv.stat}
                    onRemove={rv.remove}
                    removeLabel={rv.removeLabel}
                    file={rv.file}
                    links={rv.links}
                    {...(rv.progress !== undefined
                      ? { progress: rv.progress }
                      : {})}
                    {...(rv.progressFinishing
                      ? { progressFinishing: true }
                      : {})}
                  />
                );
              })}
            {rowsMounted && markerDetail !== undefined && (
              <ActivityStep
                body={t("activity.result.detail")}
                t={t}
                icon="result"
                active={false}
                detail={markerDetail}
                // The marker's ↳ 改动文件 list as viewer targets (ADR 0050
                // v1.5) — from the STRUCTURED evidence sections, never by
                // parsing the detail string; the paths appear verbatim in
                // it, so the wrap lands on what is shown.
                {...(openFile !== null
                  ? {
                      detailLinks: (markerBlock?.evidence ?? [])
                        .filter((s) => s.kind === "files")
                        .flatMap((s) =>
                          s.paths.map(
                            (p): FileLinkTarget => ({
                              text: p,
                              onOpen: () => openFile(p, {}),
                              ariaLabel: `${t("activity.file.openAria")} ${p}`,
                            }),
                          ),
                        ),
                    }
                  : {})}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
});
