import type { UndoFileResult } from "@herta/core";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import type { MessageKey } from "../../i18n/keys.js";
import { makeT } from "../../i18n/LocaleProvider.js";
import { useFileViewerOpen } from "../FileViewer/file-viewer-context.js";
import { ActivityStep } from "./ActivityStep.js";
import {
  type RowView,
  type RowViewContext,
  RowViewStep,
  rowView,
} from "./activity-row-view.js";
import type { AttachProgressFrame } from "./attach-progress.js";
import { useUnpinConversation } from "./ConversationPin.js";
import {
  activityChipLabel,
  activityRows,
  type SystemBlock,
} from "./group-record.js";
import { useLightbox } from "./ImageLightbox.js";

export interface ActivityBlockProps {
  readonly blocks: readonly SystemBlock[];
  /** Active session interaction language: the whole line (chip, rows)
   *  follows the SESSION, not the UI locale (GUI record-label parity, ADR
   *  0018 / ADR 0015 §4). */
  readonly lang: "zh" | "en";
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
   * Open a web page the session's record names in the OS browser (ADR 0080
   * §5): a web row's URLs become links in its detail pane. A prop for the
   * same reason as `onRemoveAttachment`; absent (the demo, bare tests), the
   * URLs stay plain text.
   */
  readonly onOpenWebPage?: (url: string) => void;
}

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
 * A group of system rows that stands on its own line: the files the
 * Trailblazer handed over (ADR 0033), an undo line (ADR 0074 §4), a dev
 * server the Trailblazer started or stopped (ADR 0083). 板砖's runs have
 * their own row since ADR 0085 (`RunRow`), and their rows open in the run's
 * 完整记录 tab.
 *
 * The line is the chip and, for an undo, what came back; a click toggles the
 * quiet hairline history beneath it.
 *
 * memo: `blocks` identity is stable per record snapshot (groupRecord is
 * memoized on the record), so these groups bail out of Conversation's
 * per-delta re-renders.
 */
export const ActivityBlock = memo(function ActivityBlock(
  props: ActivityBlockProps,
): JSX.Element {
  const { blocks, lang } = props;
  const onRemoveAttachment = props.onRemoveAttachment;
  const onOpenWebPage = props.onOpenWebPage;
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
  // (2026-09-03): every group re-renders at a turn boundary, which changes
  // nothing the blocks say.
  const derived = useMemo(() => {
    const chip = activityChipLabel(blocks);
    // An undo line (ADR 0074 §4) is its own group: a header saying what came
    // back, and a row per file.
    const undoDigest: UndoDigest | null =
      blocks.length === 1 && blocks[0]?.digest?.kind === "undo"
        ? blocks[0].digest
        : null;
    const headline = undoDigest !== null ? undoSummary(undoDigest, t) : null;
    // Rendered rows, not raw blocks: a patch preview folds into the write it
    // previews (the permission rule emits it BEFORE the tool runs, so the
    // record holds diff-then-action and the history read backwards).
    const rows = activityRows(blocks);
    return { chip, headline, rows, undoDigest };
  }, [blocks, t]);
  const { chip, headline, rows, undoDigest } = derived;
  const expandable = rows.length > 0;

  const reduced = useReducedMotion();
  const unpin = useUnpinConversation();
  // Stable opener (or null when no viewer is available — the demo, bare
  // tests): its identity never changes, so reading it here cannot
  // invalidate the load-bearing record-identity memo (ADR 0050 §1).
  const openFile = useFileViewerOpen();
  const openLightbox = useLightbox();
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  // An all-attachment group is a USER act filed under the system chip (ADR
  // 0033): "which files did I just hand over" is the whole point of the row,
  // so it defaults OPEN — a collapsed `系统 ›` with the filenames behind a
  // click answered nothing (owner 2026-08-10). So does an undo line: what
  // came back is its point. Anything else waits for a click.
  const isAttachmentGroup =
    blocks.length > 0 && blocks.every((b) => b.digest?.kind === "attachment");
  const expanded = expandable
    ? (userToggled ?? (isAttachmentGroup || undoDigest !== null))
    : false;
  // The history's rows mount on the FIRST expand and stay mounted — the same
  // lifecycle as a row's own diff and detail panes (ActivityStep), one level
  // up (ADR 0068 §11, 2026-09-22). An unexpanded history still paid, at
  // mount, for every row's DOM and for the fold of every write's diff — work
  // no reader had asked for, repeated on every session switch. The panel
  // element itself stays mounted whenever expandable, so the measured reveal
  // below always has something to size; only its contents wait. Seeded from
  // the mount-time `expanded` so a default-open attachment group draws its
  // filenames at once, and latched by the click that opens — in the same
  // batch as the toggle, so the layout effect measures the rows it is about
  // to reveal.
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
  // The history rows' props, once per `blocks` identity (2026-09-03) — the
  // localized bodies and details, the folded diff, the click targets and
  // their closures. `RowViewStep` is memo'd, so a row whose view object is
  // unchanged does not reconcile at all. `openFile` and the take-back
  // factory are identity-stable by their own contracts.
  const rowViews = useMemo((): readonly RowView[] => {
    // Not before the rows are wanted: the fold of each write's diff is the
    // costly part of a row's view, and a history nobody has opened has no
    // rows to give it to.
    if (!rowsMounted) return NO_ROWS;
    const ctx: RowViewContext = {
      t,
      openFile,
      openLightbox,
      onRemoveAttachment,
      onOpenWebPage,
      progressLabel,
    };
    return rows.map((row) => rowView(row, ctx));
  }, [
    rows,
    t,
    openFile,
    onRemoveAttachment,
    onOpenWebPage,
    rowsMounted,
    progressLabel,
    openLightbox,
  ]);

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
    // Rows changed but the open/closed state held — never animate on row
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
  }, [expanded, reduced]);

  return (
    <div
      className={`activity-line-group${entering ? " is-attach-enter" : ""}`}
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
      {/* The toggle shrinks to its CONTENT (owner 2026-07-27): the clickable
          area is exactly what it looks like — the LED, the label, the
          summary, the chevron — never the dead space beside it. */}
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
          <span className="activity-line__led" aria-hidden="true" />
          <span className="activity-line__label">
            {t(
              chip === "差分协处理器"
                ? "record.chip.coprocessor"
                : "record.chip.system",
            )}
          </span>
          {headline !== null && (
            <span className="activity-line__summary">{headline}</span>
          )}
          {/* Chevron INLINE after the summary text (user 2026-07-07: it
            floated detached at the far edge). */}
          {expandable && (
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
      </div>
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
              rowViews.map((rv, i) => (
                <RowViewStep
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are append-only and stable-order; bodies can duplicate, so body keys would collide and reconcile the wrong row.
                  key={i}
                  view={rv}
                  t={t}
                  active={false}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  );
});
