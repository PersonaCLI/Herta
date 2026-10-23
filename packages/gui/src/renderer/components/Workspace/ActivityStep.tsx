import {
  Fragment,
  memo,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { TFn } from "../../i18n/LocaleProvider.js";
import { Tooltip } from "../Tooltip/Tooltip.js";
import {
  AttachProgressBar,
  AttachProgressFinish,
  AttachProgressLabel,
} from "./AttachProgressLine.js";
import type { AttachProgressFrame } from "./attach-progress.js";
import { CollapsibleBody } from "./CollapsibleBody.js";
import { useUnpinConversation } from "./ConversationPin.js";
import { DiffBody } from "./DiffBody.js";
import { DiffStat, type DiffStatValue } from "./DiffStat.js";
import { segmentByTargets, splitBodyAtPath } from "./file-name-target.js";
import { StepIcon, type StepIconKey, stepIcon } from "./step-icon.js";

export interface ActivityStepProps {
  readonly body: string;
  /**
   * A picture the step left (ADR 0083 §11; owner's pick A): a screenshot
   * 板砖 took, as a small thumbnail at the row's end that opens the
   * lightbox. The pixels come through the attachment scheme.
   */
  readonly thumb?: {
    readonly src: string;
    readonly onOpen: () => void;
    /** Localized, session-language like the row. */
    readonly ariaLabel: string;
  };
  /** SESSION-scoped translator, forwarded to CollapsibleBody's diff toggle —
   *  the whole activity line follows the session lang (ADR 0019), and `body`
   *  arrives already localized with this same `t`. */
  readonly t: TFn;
  /** Icon key derived from the CANONICAL body (stable English verbs from
   *  workflowLabel). Pass it when `body` is a LOCALIZED display string —
   *  stepIcon can't parse a translated verb. Omitted → derived from `body`
   *  (pre-localization callers and tests). */
  readonly icon?: StepIconKey;
  /** The currently-running step shimmers (Pillar B). */
  readonly active: boolean;
  /** Failure row (tool-fail digest): distinct color + ✗ icon (2026-07-23). */
  readonly failed?: boolean;
  /**
   * The block's `evidenceDetail` — the fuller evidence Herta's prompt reads
   * (command-output tail, 改动文件 / 风险 / 待办 roll-ups). Rendered as a
   * collapsed-by-default expander (2026-07-23): the screen stays terse (the
   * original evidenceDetail design intent) while the evidence becomes
   * inspectable on demand (PHILOSOPHY §9) — before this the user could see
   * NONE of what Herta reads from these fields.
   */
  readonly detail?: string;
  /**
   * Take-back handler for an attachment row (ADR 0033, owner 2026-08-10).
   * Present only on a live, not-yet-removed attachment while the session is
   * idle — the removal rides the same out-of-turn record write as the attach,
   * so the parent withholds it mid-turn rather than letting a click earn a
   * refusal.
   */
  readonly onRemove?: () => void;
  /** Label + aria for the take-back control. Required when `onRemove` is set;
   *  passed rather than translated here so the row keeps following the SESSION
   *  lang (ADR 0019) like every other string in it. */
  readonly removeLabel?: string;
  /**
   * A standalone patch row's magnitude (2026-08-25) — rendered as an animated
   * element in place of the body's first line, because the digits count up.
   *
   * Only reached when the preview has no write to fold into (a DENIED edit:
   * the permission rule previews the patch, the tool never runs, so no
   * `Writing` row follows it). The normal case is `patch` below.
   */
  readonly stat?: DiffStatValue;
  /**
   * The patch this operation wrote, folded into the row (2026-08-25 evening).
   *
   * `patch.preview` is published by the permission RULE, which runs BEFORE
   * the tool — so the diff was projected AHEAD of its own `Writing` row and
   * the history read backwards: a wall of diff, then the action that caused
   * it. Folded here, the row states the action and its magnitude, and the
   * evidence opens underneath it on a click.
   */
  readonly patch?: {
    readonly stat: DiffStatValue;
    /** Diff content without the ```diff fence. */
    readonly diff: string;
  };
  /**
   * The row's block `at` stamp, for DiffStat's recency gate (2026-08-25):
   * the count-up plays only on a live append, never when a session switch or
   * reload mounts history. Absent on pre-timestamp records — those render
   * their magnitude settled.
   */
  readonly at?: string;
  /**
   * Makes the file NAME inside the body a click target that opens the
   * viewer panel (ADR 0050 §1) — the name only, never the row, and only
   * when the caller (ActivityBlock) has both a path-shaped digest arg and
   * an available viewer. The name is found by substring in the localized
   * body; a miss degrades to plain text.
   */
  readonly file?: {
    readonly path: string;
    /** The display NAME to locate in the body when it differs from `path` —
     *  an attachment row shows the file's name while its `path` is the
     *  stored copy under `.herta/attachments/` (ADR 0050 amendment,
     *  owner 2026-08-31). Absent → the path is the display text. */
    readonly name?: string;
    readonly onOpen: () => void;
    /** Localized aria label ("查看文件 x"), session-language like the row. */
    readonly ariaLabel: string;
  };
  /**
   * MULTIPLE click targets inside the body (ADR 0050 v1.5) — a finding
   * row's cites (`claim — src/x.ts:12-30, src/y.ts:5`), each opening the
   * viewer at its lines. First occurrence of each, in order; a target the
   * body no longer carries degrades to plain text. Ignored when `file`
   * (the single-target form) is set.
   */
  readonly links?: readonly FileLinkTarget[];
  /** Click targets inside the DETAIL pane (the done-marker's
   *  `↳ 改动文件:` list). Same contract as `links`. */
  readonly detailLinks?: readonly FileLinkTarget[];
  /** A PLACEHOLDER row of an attach in flight (2026-10-01): which file of
   *  the batch it stands for, and how its count reads (session language). */
  readonly progress?: {
    readonly index: number;
    readonly label: (frame: AttachProgressFrame | undefined) => string;
  };
  /** The real row that just took a placeholder's place: its hairline fades
   *  and folds away instead of vanishing. */
  readonly progressFinishing?: boolean;
}

export interface FileLinkTarget {
  /** The exact substring to make clickable. */
  readonly text: string;
  readonly onOpen: () => void;
  readonly ariaLabel: string;
}

/** The body (or detail) with each link target wrapped as a click span —
 *  the same `.file-open-name` affordance as the single-target form.
 *  Exported for the activity line's headline (the done marker's commit
 *  sha, ADR 0059). */
export function textWithLinks(
  text: string,
  links: readonly FileLinkTarget[],
): JSX.Element | string {
  const segments = segmentByTargets(
    text,
    links.map((l) => l.text),
  );
  if (!segments.some((s) => s.kind === "target")) return text;
  return (
    <>
      {segments.map((s, i) => {
        if (s.kind === "text")
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable split of one string
          return <span key={i}>{s.text}</span>;
        const link = links[s.index];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable split of one string
          <Fragment key={i}>
            {/* biome-ignore lint/a11y/useSemanticElements: rendered inside a <pre>; a span keeps the text flow intact. */}
            <span
              role="button"
              tabIndex={0}
              className="file-open-name"
              aria-label={link?.ariaLabel}
              onClick={(e) => {
                e.stopPropagation();
                link?.onOpen();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  link?.onOpen();
                }
              }}
            >
              {s.text}
            </span>
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * The body with its file name as the click target — a span, not a link:
 * ink text, dotted underline, glass pill on hover (owner 2026-08-31: "not
 * the blue link style"). Inside a patch row this sits WITHIN the fold
 * button, so activation stops propagation instead of also toggling the
 * fold; role/tabIndex keep it a first-class keyboard stop either way.
 */
function bodyWithFileName(
  body: string,
  file: NonNullable<ActivityStepProps["file"]>,
): JSX.Element | string {
  const split = splitBodyAtPath(body, file.name ?? file.path);
  if (split === null) return body;
  const activate = (e: { stopPropagation: () => void }): void => {
    e.stopPropagation();
    file.onOpen();
  };
  return (
    <>
      {split.before}
      {/* biome-ignore lint/a11y/useSemanticElements: a real <button> cannot nest inside the patch row's fold <button>; the span keeps valid DOM in both branches. */}
      <span
        role="button"
        tabIndex={0}
        className="file-open-name"
        aria-label={file.ariaLabel}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate(e);
          }
        }}
      >
        {split.name}
      </span>
      {split.after}
    </>
  );
}

/**
 * Measured max-height reveal, same as the activity history panel: a px
 * target is the only way to transition to `auto`, and the scroller's
 * overflow-anchor:none keeps the growth pointing downward. Shared by the
 * folded patch and the evidence-detail pane (2026-08-26 — the detail used
 * to pop with no animation while the diff beside it eased); both render a
 * `.activity-step__fold` wrapper, which carries the transition.
 */
function useMeasuredFold(open: boolean): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.maxHeight = open ? `${el.scrollHeight}px` : "0px";
  }, [open]);
  return ref;
}

/** One row in an activity block: a verb icon + the (collapsible) body. */
/**
 * memo (2026-09-03): the parent derives every row's props once per `blocks`
 * identity, so a historical row's props are reference-stable across the
 * live group's 1 Hz tick and the turn-boundary re-renders — only the row
 * whose `active` shimmer flips reconciles.
 */
export const ActivityStep = memo(function ActivityStep(
  props: ActivityStepProps,
): JSX.Element {
  const icon = props.icon ?? stepIcon(props.body);
  const continuation = icon === "result" || icon === "fail";
  // The projected body carries a literal "↳ " prefix for the CLI (which has no
  // icons). In the GUI the continuation is shown by the result arrow icon, so
  // strip the literal arrow to avoid a doubled "↳ ↳".
  const body = continuation ? props.body.replace(/^\s*↳\s*/, "") : props.body;
  const [detailOpen, setDetailOpen] = useState(false);
  const unpin = useUnpinConversation();
  const hasDetail = props.detail !== undefined && props.detail.length > 0;
  // Mount the detail on FIRST open and keep it mounted, so collapsing
  // animates out instead of vanishing — the same lifecycle as the patch
  // fold below (an unopened pane costs nothing).
  const [detailMounted, setDetailMounted] = useState(false);
  const detailFoldRef = useMeasuredFold(detailOpen);
  const patch = props.patch;
  const [patchOpen, setPatchOpen] = useState(false);
  // Mount the diff on FIRST open and keep it mounted, so collapsing animates
  // out instead of vanishing. A closed row costs nothing until it is opened —
  // a long dispatch can carry dozens of patches, each thousands of lines.
  const [patchMounted, setPatchMounted] = useState(false);
  const foldRef = useMeasuredFold(patchOpen);
  return (
    <div
      className={`activity-step${props.active ? " is-active" : ""}${
        continuation ? " is-continuation" : ""
      }${props.failed === true ? " is-failure" : ""}`}
    >
      <span className="activity-step__icon">
        <StepIcon kind={icon} />
      </span>
      <div className="activity-step__text">
        {/* The body and the ✕ share one row so the control tracks the
            FILENAME, not the text column (owner 2026-08-10: expanding the
            detail pane widened the column and carried the ✕ rightward with
            it). The toggle and the detail sit below, full width. */}
        {patch !== undefined ? (
          // The action states itself and its magnitude; the evidence opens
          // underneath on a click. The whole headline is the control (the
          // reference tools put the target on the file row, not on a separate
          // "expand" link), so the accessible name is the row's own text.
          <button
            type="button"
            className={`activity-step__fold-head${patchOpen ? " is-open" : ""}`}
            aria-expanded={patchOpen}
            onClick={() => {
              // Opening grows the record BELOW this row with no scroll event —
              // unpin so the follow machinery can't later yank the viewport
              // past the diff (see ConversationPin.tsx).
              if (!patchOpen) {
                unpin();
                setPatchMounted(true);
              }
              setPatchOpen((v) => !v);
            }}
          >
            <span className="activity-step__body">
              {props.file !== undefined
                ? bodyWithFileName(body, props.file)
                : body}
            </span>
            <DiffStat
              value={patch.stat}
              {...(props.at !== undefined ? { at: props.at } : {})}
            />
            <svg
              className="activity-step__fold-chevron"
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3.5 2l3 3-3 3" />
            </svg>
          </button>
        ) : (
          <div className="activity-step__headline">
            <CollapsibleBody
              body={body}
              preClassName="activity-step__body"
              t={props.t}
              {...(props.stat !== undefined
                ? {}
                : props.file !== undefined
                  ? { bodyNode: bodyWithFileName(body, props.file) }
                  : props.links !== undefined && props.links.length > 0
                    ? { bodyNode: textWithLinks(body, props.links) }
                    : {})}
              {...(props.stat !== undefined
                ? {
                    headline: (
                      <DiffStat
                        value={props.stat}
                        {...(props.at !== undefined ? { at: props.at } : {})}
                      />
                    ),
                  }
                : {})}
            />
            {props.thumb !== undefined && (
              <button
                type="button"
                className="activity-step__thumb"
                aria-label={props.thumb.ariaLabel}
                onClick={props.thumb.onOpen}
              >
                <img src={props.thumb.src} alt="" draggable={false} />
              </button>
            )}
            {props.progress !== undefined && (
              <AttachProgressLabel
                index={props.progress.index}
                label={props.progress.label}
              />
            )}
            {props.onRemove !== undefined && (
              // The app's styled pill, not the native `title` (owner
              // 2026-08-10 — the same OS-beige-box mismatch the paperclip had),
              // and PORTALED. This row sits inside the activity history panel
              // inside the conversation scroller; an in-flow pill was cut there
              // twice, by two different causes (the panel's reveal clip, then
              // whatever paints past its bottom edge once the detail pane is
              // closed). Rendering to <body> at fixed coords ends the class —
              // nothing can clip an element it does not contain — and the
              // placement auto-flips when the viewport bottom is close.
              <Tooltip
                label={props.removeLabel ?? ""}
                placement="bottom"
                align="center"
                portal
              >
                <button
                  type="button"
                  className="activity-step__remove"
                  aria-label={props.removeLabel}
                  onClick={props.onRemove}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M3 3l6 6M9 3l-6 6" />
                  </svg>
                </button>
              </Tooltip>
            )}
          </div>
        )}
        {props.progress !== undefined && (
          <AttachProgressBar index={props.progress.index} />
        )}
        {props.progress === undefined && props.progressFinishing === true && (
          <AttachProgressFinish />
        )}
        {patch !== undefined && (
          <div
            ref={foldRef}
            className={`activity-step__fold${patchOpen ? " is-open" : ""}`}
          >
            {patchMounted && <DiffBody text={patch.diff} />}
          </div>
        )}
        {hasDetail && (
          <button
            type="button"
            className="activity-step__detail-toggle"
            aria-expanded={detailOpen}
            onClick={() => {
              // Same disclosure contract as the activity history's chevron
              // (ConversationPin.tsx), which this toggle never joined when it
              // was added: opening grows the flow BELOW the toggle, the
              // scroller's ResizeObserver watches the scroller's own box and
              // so never fires, and the focus-scroll that follows the click
              // reaches the scroll handler as a plain "reader left the
              // bottom" — lighting the jump chip nobody asked for and
              // disarming the next send's travel (owner 2026-08-10).
              if (!detailOpen) {
                unpin();
                setDetailMounted(true);
              }
              setDetailOpen((v) => !v);
            }}
          >
            {props.t(
              detailOpen ? "activity.detail.hide" : "activity.detail.show",
            )}
          </button>
        )}
        {hasDetail && (
          // The same animated fold as the patch above — the detail pane used
          // to mount/unmount bare, popping open next to a diff that eased.
          <div
            ref={detailFoldRef}
            className={`activity-step__fold${detailOpen ? " is-open" : ""}`}
          >
            {detailMounted && (
              <pre className="activity-step__detail">
                {props.detailLinks !== undefined && props.detailLinks.length > 0
                  ? textWithLinks(props.detail ?? "", props.detailLinks)
                  : props.detail}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
