// One history row of 板砖's work, derived from its record block: the
// localized body and detail, the folded diff, the click targets. Moved out
// of ActivityBlock on 2026-11-04 so the 完整记录 tab (ADR 0085 §9) draws its
// rows exactly as the activity block draws its own.

import { memo } from "react";
import { attachmentImageUrl } from "../../../shared/attachment-image.js";
import type { MessageKey } from "../../i18n/keys.js";
import type { TFn } from "../../i18n/LocaleProvider.js";
import type {
  OpenFileOpts,
  ViewerAnchor,
} from "../FileViewer/file-viewer-context.js";
import {
  ActivityStep,
  type ActivityStepProps,
  type FileLinkTarget,
} from "./ActivityStep.js";
import type { AttachProgressFrame } from "./attach-progress.js";
import type { DiffStatValue } from "./DiffStat.js";
import { type DiffSummary, summarizeDiff } from "./diff-summary.js";
import { opTarget, parseCite } from "./file-name-target.js";
import type { ActivityRow, SystemBlock } from "./group-record.js";
import type { LightboxImage } from "./ImageLightbox.js";
import { isAttachHandoff, pendingAttachIndex } from "./pending-attach.js";
import {
  middleTruncateName,
  stepDisplayBody,
  stepDisplayDetail,
} from "./step-display.js";
import { type StepIconKey, stepIcon } from "./step-icon.js";

/** A screenshot row's thumbnail (ADR 0083 §11; owner's pick A). */
function shotThumb(
  d: {
    readonly path: string;
    readonly route: string;
    readonly width: number;
    readonly height: number;
  },
  t: (key: MessageKey) => string,
  openLightbox: (img: LightboxImage) => void,
): NonNullable<ActivityStepProps["thumb"]> {
  return {
    src: attachmentImageUrl(d.path),
    onOpen: () =>
      openLightbox({
        path: d.path,
        name: d.route,
        width: d.width,
        height: d.height,
      }),
    ariaLabel: `${t("activity.page.openShot")} ${d.route}`,
  };
}

/** One history row's props, derived once per `blocks` identity. */
export interface RowView {
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
  /** A web row's URLs in its detail pane, each opening in the OS browser
   *  (ADR 0080 §5); a clipped command output's full log, opening in the
   *  viewer (ADR 0085 §9). */
  readonly detailLinks: ActivityStepProps["detailLinks"];
  /** A placeholder of the attach in flight (2026-10-01). */
  readonly progress: ActivityStepProps["progress"];
  /** A real row that just replaced a placeholder. */
  readonly progressFinishing: boolean;
  readonly thumb: ActivityStepProps["thumb"];
}

/** What a row's targets open, and how its strings read. */
export interface RowViewContext {
  /** Session-language translator: the rows follow the session (ADR 0019). */
  readonly t: TFn;
  /** The viewer's stable opener, or null when there is no viewer. */
  readonly openFile: ((path: string, opts?: OpenFileOpts) => void) | null;
  readonly openLightbox: (img: LightboxImage) => void;
  readonly onRemoveAttachment?: ((path: string) => () => void) | undefined;
  readonly onOpenWebPage?: ((url: string) => void) | undefined;
  readonly progressLabel: (f: AttachProgressFrame | undefined) => string;
}

/**
 * The magnitude recorded on a patch block, or the honest absence of one.
 *
 * The digest is the source of truth. The fallback to counting the fenced diff
 * is for records written before the `patch` digest existed (their preview is a
 * `skip` with no counts) — and it is the SAME computation the projector runs
 * at write time, not an inference, so those rows get a real number instead of
 * silence. No diff at all → `unmeasured`, which renders nothing.
 */
export function patchStat(
  block: SystemBlock,
  summary?: DiffSummary,
): DiffStatValue {
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

/** The full log a clipped command output names (`…(truncated, full log:
 *  <path>)`, `bounded-tail.ts`): harness-written, workspace-relative. */
export function fullLogPath(output: string): string | null {
  const m = /full log: ([^)\n]+)\)/.exec(output);
  return m?.[1] ?? null;
}

/** One row's view: the localized strings, the folded diff, the targets. */
export function rowView(row: ActivityRow, ctx: RowViewContext): RowView {
  const { t, openFile, onRemoveAttachment, onOpenWebPage } = ctx;
  const b = row.block;
  const failed = b.digest?.kind === "tool-fail";
  // The file NAME as a click target (ADR 0050 §1): op rows whose digest arg
  // is the path — reads, writes, and the folded-patch edit rows all carry
  // one. Attachment rows too (owner 2026-08-31): the NAME in the body opens
  // the STORED copy under .herta/attachments/ — text attachments only
  // (pictures already have the thumbnail + lightbox), and only while the
  // store still holds the file.
  const fileTarget: {
    readonly path: string;
    readonly name?: string;
    readonly label?: string;
    readonly anchor?: ViewerAnchor;
  } | null =
    openFile === null
      ? null
      : b.digest?.kind === "op" &&
          (b.digest.verb === "Reading" || b.digest.verb === "Writing") &&
          b.digest.arg.length > 0
        ? // An excerpt read's arg carries its range ("viewer-demo.txt:2-8")
          // — parse it like a cite so the click opens the REAL file anchored
          // at those lines instead of asking the jail for a path with a
          // colon in it (found live, 2026-08-31). `name` stays the verbatim
          // arg — it is what the row displays.
          opTarget(b.digest.arg)
        : // A fetched page (ADR 0080 §5): its host opens the stored copy —
          // the reader view; the URL in the detail pane goes to the OS
          // browser.
          b.digest?.kind === "web-fetch" && b.digest.path.length > 0
          ? {
              path: b.digest.path,
              name: b.digest.host,
              label: b.digest.title !== "" ? b.digest.title : b.digest.host,
            }
          : b.digest?.kind === "attachment" &&
              b.digest.image === undefined &&
              b.digest.unreadable !== "removed" &&
              // The ORIGINAL document when the ingest kept one (ADR 0038
              // amendment): the viewer draws the PDF / Word / spreadsheet /
              // deck itself (ADR 0054), even when no text came out of it.
              // Otherwise the stored text: `too_large` means STORED but no
              // head excerpt taken — the viewer's own bounded read is
              // exactly the remedy, so it stays clickable; genuinely dead
              // states (read_error / denied / …) stay plain.
              (b.digest.source !== undefined ||
                (b.digest.path.length > 0 &&
                  (b.digest.unreadable === undefined ||
                    b.digest.unreadable === "too_large")))
            ? {
                path: b.digest.source ?? b.digest.path,
                // The row DISPLAYS the middle-truncated name (long names
                // wrapped the row, owner 2026-08-10) — split on what is
                // actually on screen or a long name silently loses its click
                // affordance. The panel breadcrumb gets the WHOLE name.
                name: middleTruncateName(b.digest.name),
                label: b.digest.name,
              }
            : null;
  const file: ActivityStepProps["file"] =
    fileTarget !== null && openFile !== null
      ? {
          path: fileTarget.path,
          ...(fileTarget.name !== undefined ? { name: fileTarget.name } : {}),
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
  // A finding's cites open the viewer AT the cited lines (ADR 0050 v1.5) —
  // each cite in the row becomes its own target; unparseable ones stay plain
  // text.
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
  // A web row's URLs (ADR 0080 §5), from the STRUCTURED sections — they
  // appear verbatim in the detail pane, so the wrap lands on what is shown.
  // A clipped command output names its full log (ADR 0085 §9): the path
  // opens in the viewer.
  const detailLinks: FileLinkTarget[] = (b.evidence ?? []).flatMap(
    (s): FileLinkTarget[] => {
      if (s.kind === "output") {
        const log = openFile !== null ? fullLogPath(s.text) : null;
        return log === null || openFile === null
          ? []
          : [
              {
                text: log,
                onOpen: () => openFile(log, {}),
                ariaLabel: `${t("activity.file.openAria")} ${log}`,
              },
            ];
      }
      if (onOpenWebPage === undefined) return [];
      const urls =
        s.kind === "web-page"
          ? [s.url]
          : s.kind === "web-results"
            ? s.items.map((i) => i.url)
            : [];
      return urls.map((url) => ({
        text: url,
        onOpen: () => onOpenWebPage(url),
        ariaLabel: `${t("activity.web.openAria")} ${url}`,
      }));
    },
  );
  // Take-back, offered only where it can actually work: a stored attachment
  // (a path to delete), not already removed. Mid-turn the control hides by
  // CSS (`.conversation-flow.is-busy`) and the handler itself re-checks the
  // live status — the factory no longer changes identity with the turn, so
  // the rows stay memo-stable across it.
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
  // A placeholder of the attach in flight (2026-10-01) says only which file
  // it is — its counts ride the hairline; the record block that replaces it
  // states the rest.
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
        ? { index: pendingIndex, label: ctx.progressLabel }
        : undefined,
    progressFinishing: isAttachHandoff(b),
    // A screenshot 板砖 took (ADR 0083 §11): its picture at the row's end,
    // the lightbox on a click.
    thumb:
      b.digest?.kind === "page-shot" && b.digest.path.length > 0
        ? shotThumb(b.digest, t, ctx.openLightbox)
        : undefined,
    // Icon parses the CANONICAL body — the display body may be a localized
    // verb stepIcon can't recognize. Failure and attachment rows key off the
    // structured digest instead.
    icon: failed
      ? "fail"
      : b.digest?.kind === "attachment"
        ? "attach"
        : stepIcon(b.body),
    failed,
    isOp: b.digest?.kind === "op",
    detail: stepDisplayDetail(b, t),
    // The write states its own magnitude, and the diff it wrote folds in
    // underneath (2026-08-25 evening).
    patch: row.patch !== undefined ? foldedPatch(row.patch) : undefined,
    // The row's own stamp gates the magnitude's count-up: live appends
    // animate, a reloaded session's history does not.
    at: b.at,
    // A patch with no write to fold into (a DENIED edit) still answers with
    // its magnitude, in place of the body's first line — the element,
    // because the digits count up.
    stat:
      row.patch === undefined && b.digest?.kind === "patch"
        ? patchStat(b)
        : undefined,
    remove,
    removeLabel:
      remove !== undefined ? t("activity.attachment.remove") : undefined,
    file,
    links,
    detailLinks: detailLinks.length > 0 ? detailLinks : undefined,
  };
}

/** A row view drawn as its step. `active`: the row shimmers (the step in
 *  flight). */
export const RowViewStep = memo(function RowViewStep(props: {
  readonly view: RowView;
  readonly t: TFn;
  readonly active: boolean;
}): JSX.Element {
  const { view: rv, t } = props;
  return (
    <ActivityStep
      body={rv.body}
      t={t}
      icon={rv.icon}
      active={props.active}
      failed={rv.failed}
      detail={rv.detail}
      patch={rv.patch}
      at={rv.at}
      stat={rv.stat}
      onRemove={rv.remove}
      removeLabel={rv.removeLabel}
      file={rv.file}
      links={rv.links}
      {...(rv.detailLinks !== undefined ? { detailLinks: rv.detailLinks } : {})}
      {...(rv.progress !== undefined ? { progress: rv.progress } : {})}
      {...(rv.progressFinishing ? { progressFinishing: true } : {})}
      {...(rv.thumb !== undefined ? { thumb: rv.thumb } : {})}
    />
  );
});
