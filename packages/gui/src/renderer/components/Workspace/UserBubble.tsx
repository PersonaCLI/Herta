import { memo, type Ref, useMemo } from "react";
import { attachmentImageUrl } from "../../../shared/attachment-image.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { renderBanzhuanText } from "../../lib/banzhuan-text.js";
import { renderMentionText } from "../../lib/mention-text.js";
import { parseLeadingQuotes } from "../../lib/quote-format.js";
import { useFileViewerOpen } from "../FileViewer/file-viewer-context.js";
import { Tooltip } from "../Tooltip/Tooltip.js";
import { BubbleTime } from "./BubbleTime.js";
import type { SystemBlock } from "./group-record.js";
import { useLightbox } from "./ImageLightbox.js";

/**
 * Rewind / undo glyph — Heroicons arrow-uturn-down (from
 * `reference_UX_design/icons/RewindIcon_outline.svg`). Rendered inline so CSS
 * owns size + stroke-width + hover color (see `.message-rewind-svg`).
 */
function RewindIcon(): JSX.Element {
  return (
    <svg
      className="message-rewind-svg"
      data-icon="rewind"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m15 15-6 6m0 0-6-6m6 6V9a6 6 0 0 1 12 0v3" />
    </svg>
  );
}

export interface UserBubbleProps {
  readonly text: string;
  /** ISO send time (the block's stamped `at`); the adaptive label is derived
   *  in the BubbleTime leaf, off the shared coarse clock. Omitted for
   *  pre-timestamp blocks → the line is hidden rather than showing a
   *  fabricated time. */
  readonly at?: string;
  /** When true, the bubble is kept in layout (holds its slot) but invisible —
   *  used while the send morph's flying clone rises to this slot. */
  readonly hidden?: boolean;
  /** Ref to the inner .message-bubble, so the morph can measure the slot. */
  readonly bubbleRef?: Ref<HTMLDivElement>;
  /** When set, a rewind control shows in the hover action row — only the LATEST
   *  user turn, only when idle. Clicking withdraws this turn (and everything
   *  below it) and restores its text to the composer. */
  readonly onRewind?: () => void;
  /** ABSOLUTE record index, stamped as `data-abs-index` on the row so the
   *  topic rail's jump can find its anchor block in the DOM. */
  readonly absIndex?: number;
  /** Conversation language for the 板砖→Brick display alias (default "zh"). */
  readonly lang?: "zh" | "en";
  /** Pictures sent WITH this message (ADR 0048 §4), shown above the bubble —
   *  where the 开拓者 put them. For a record row their blocks live after the
   *  user block (inside the turn's span, so a rewind takes both); only the
   *  presentation differs, which is what D7 is for. For the optimistic echo
   *  they come from the just-taken composer strip — a VIEW type rather than
   *  SystemBlock so both sources feed the same rendering. */
  readonly images?: readonly UserImageView[];
  /** Paths the message mentions with the composer's `@` (ADR 0072 amendment
   *  2026-10-20): drawn as the chips the composer showed. */
  readonly mentions?: readonly string[];
}

/** Everything the bubble needs to draw one attached picture. `caption` is
 *  the instrument's reading — the alt text a screen reader gets, since the
 *  filename says nothing about what is in the frame. `width`/`height` are
 *  the sniffed pixel dimensions, stamped as attributes. Under the fixed
 *  56px cover-crop thumb (owner 2026-08-27) the CSS owns the box, so they
 *  no longer drive layout — they stay because they are true, cost nothing,
 *  and any return to natural sizing needs them for pre-load slot height
 *  (the morph flight measures that slot). */
export interface UserImageView {
  readonly path: string;
  readonly name: string;
  readonly caption?: string;
  readonly width?: number;
  readonly height?: number;
}

function imageView(block: SystemBlock): UserImageView | null {
  const d = block.digest;
  if (d?.kind !== "attachment" || d.image === undefined) return null;
  if (d.path.length === 0 || d.unreadable === "removed") return null;
  return {
    path: d.path,
    name: d.name,
    ...(d.caption !== undefined ? { caption: d.caption } : {}),
    ...(d.image.width !== undefined ? { width: d.image.width } : {}),
    ...(d.image.height !== undefined ? { height: d.image.height } : {}),
  };
}

/** The record-row source: lifted attachment blocks → views (drops the
 *  non-image / removed ones). */
export function imageViewsFromBlocks(
  blocks: readonly SystemBlock[],
): readonly UserImageView[] {
  return blocks.map(imageView).filter((v): v is UserImageView => v !== null);
}

/** memo: bails historical bubbles out of Conversation's per-delta re-renders
 *  (props are primitives + the stable rewind callback / bubbleRef). */
export const UserBubble = memo(function UserBubble(
  props: UserBubbleProps,
): JSX.Element {
  const t = useT();
  // Stable opener — a context read cannot invalidate this memo.
  const openLightbox = useLightbox();
  const lang = props.lang ?? "zh";
  const hasActions = props.onRewind !== undefined || props.at !== undefined;
  const images = props.images ?? [];
  // Quotes from the viewer's page lead the message (ADR 0078 §7): a card
  // each — the label opens the file at those lines — then what was said.
  const { quotes, rest } = useMemo(
    () => parseLeadingQuotes(props.text),
    [props.text],
  );
  const openFile = useFileViewerOpen();
  return (
    <div
      className="message-row user-row"
      data-abs-index={props.absIndex}
      style={props.hidden ? { visibility: "hidden" } : undefined}
    >
      {images.length > 0 && (
        <div className="message-images">
          {images.map((img) => (
            // Click-to-enlarge (ADR 0048 §4a): the 56px thumb is an index
            // card, the lightbox is the picture. A BUTTON, so the keyboard
            // reaches it too.
            <button
              key={img.path}
              type="button"
              className="message-images__open"
              aria-label={`${t("lightbox.open")} ${img.name}`}
              onClick={() => openLightbox(img)}
            >
              <img
                className="message-images__thumb"
                src={attachmentImageUrl(img.path)}
                // The caption is what the picture IS; the filename is what it
                // was called. A screen reader wants the former.
                alt={img.caption ?? img.name}
                title={img.name}
                // True pixel dimensions (see UserImageView on why they stay
                // under the fixed-size thumb CSS).
                {...(img.width !== undefined ? { width: img.width } : {})}
                {...(img.height !== undefined ? { height: img.height } : {})}
                draggable={false}
              />
            </button>
          ))}
        </div>
      )}
      <div ref={props.bubbleRef} className="message-bubble user-bubble">
        {quotes.map((q, i) => {
          const preview = q.text.split("\n").slice(0, 3).join("\n");
          const target = q.path;
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: quotes are positional in an immutable message
              key={i}
              className="message-quote"
            >
              {openFile !== null && target !== undefined ? (
                <button
                  type="button"
                  className="message-quote__label"
                  onClick={() =>
                    openFile(target, {
                      ...(q.from !== undefined
                        ? { anchor: { from: q.from, to: q.to ?? q.from } }
                        : {}),
                    })
                  }
                >
                  {q.label}
                  {q.title !== undefined ? ` · ${q.title}` : ""}
                </button>
              ) : (
                <span className="message-quote__label">
                  {q.label}
                  {q.title !== undefined ? ` · ${q.title}` : ""}
                </span>
              )}
              <pre className="message-quote__text">{preview}</pre>
            </div>
          );
        })}
        {(quotes.length === 0 || rest.trim().length > 0) && (
          <div className="message-text">
            {renderMentionText(
              quotes.length > 0 ? rest : props.text,
              props.mentions,
              (segment) => renderBanzhuanText(segment, "bubble", lang),
              openFile !== null ? (path) => openFile(path, {}) : undefined,
            )}
          </div>
        )}
      </div>
      {/* Hover-revealed action row BELOW the bubble (a sibling, not a child) —
          Codex/Claude-style: [rewind] … timestamp, shown only on bubble hover. */}
      {hasActions && (
        <div className="message-actions">
          {props.onRewind !== undefined && (
            <Tooltip label={t("workspace.rewind")} placement="bottom">
              <button
                type="button"
                className="message-rewind"
                aria-label={t("workspace.rewind")}
                onClick={props.onRewind}
              >
                <RewindIcon />
              </button>
            </Tooltip>
          )}
          {props.at !== undefined && <BubbleTime at={props.at} />}
        </div>
      )}
    </div>
  );
});
