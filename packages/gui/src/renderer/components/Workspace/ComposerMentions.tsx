/**
 * The composer's @-mention list (ADR 0072 §2): `@板砖` first, then the
 * workspace's files. The caret stays in the textarea, whose keys move the
 * highlight. Split out of Composer.tsx (review 2026-11-10, moved
 * 2026-11-27); the composer decides when the list shows and what a pick
 * does.
 */
import { type Dispatch, Fragment, type SetStateAction } from "react";
import type { useT } from "../../i18n/LocaleProvider.js";
import { FileTypeIcon } from "../../lib/file-icons.js";
import type { MentionItem } from "../../lib/file-mention.js";

// Fade the list's edges only where there is more to scroll to.
const fadeEdges = (el: HTMLElement | null): void => {
  if (el === null) return;
  el.dataset.above = el.scrollTop > 1 ? "1" : "0";
  el.dataset.below =
    el.scrollTop + el.clientHeight < el.scrollHeight - 1 ? "1" : "0";
};

export function ComposerMentions(props: {
  readonly mentionMatches: readonly MentionItem[];
  readonly mentionActive: MentionItem | undefined;
  readonly pickMention: (item: MentionItem) => void;
  readonly setMentionIndex: Dispatch<SetStateAction<number>>;
  readonly lang: "zh" | "en";
  readonly t: ReturnType<typeof useT>;
}): JSX.Element {
  const {
    mentionMatches,
    mentionActive,
    pickMention,
    setMentionIndex,
    lang,
    t,
  } = props;
  return (
    <div
      id="composer-mentions"
      className="composer-mentions"
      role="listbox"
      aria-label={t("composer.mentions.aria")}
    >
      <div
        className="composer-mentions__scroll"
        ref={fadeEdges}
        onScroll={(e) => fadeEdges(e.currentTarget)}
      >
        {mentionMatches.map((item, i) => {
          const active = item === mentionActive;
          const firstFile =
            item.kind === "file" && mentionMatches[i - 1]?.kind !== "file";
          const option = (children: JSX.Element): JSX.Element => (
            <button
              key={item.kind === "brick" ? "@brick" : item.path}
              id={`composer-mention-${i}`}
              type="button"
              role="option"
              // The caret stays in the textarea; the keys it takes move
              // the highlight, so an option is never tabbed to.
              tabIndex={-1}
              aria-selected={active}
              className={`composer-mentions__item${item.kind === "brick" ? " is-brick" : ""}${active ? " is-active" : ""}`}
              // mousedown, not click: the textarea keeps the caret.
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(item);
              }}
              onMouseEnter={() => setMentionIndex(i)}
            >
              {children}
            </button>
          );
          if (item.kind === "brick") {
            return option(
              <>
                <span className="composer-mentions__name">
                  {lang === "en" ? "@brick" : "@板砖"}
                </span>
                <span className="composer-mentions__desc">
                  {t("composer.mentions.brick")}
                </span>
              </>,
            );
          }
          const cut = item.path.lastIndexOf("/");
          const name = item.path.slice(cut + 1);
          const dir = cut >= 0 ? item.path.slice(0, cut) : "";
          const folder = item.dir === true;
          return (
            <Fragment key={item.path}>
              {firstFile && (
                // What the rows below are — the list says so itself.
                <div className="composer-mentions__section" aria-hidden="true">
                  {t("composer.mentions.files")}
                </div>
              )}
              {option(
                <>
                  <FileTypeIcon
                    path={item.path}
                    dir={folder}
                    className="composer-mentions__icon"
                  />
                  <span className="composer-mentions__name">{name}</span>
                  {dir.length > 0 && (
                    <span className="composer-mentions__dir">{dir}</span>
                  )}
                </>,
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
