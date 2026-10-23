import { pageElementWords } from "@herta/core/page-element";
import { Fragment, type ReactNode } from "react";
import { hoverTipProps } from "../components/common/hover-tip.js";
import { FileTypeIcon, PickIcon } from "./file-icons.js";
import { chipName } from "./file-mention.js";

/** An element picked on the page, as the user block records it (ADR 0083
 *  §4). */
export interface MessagePick {
  readonly line: string;
  readonly element: string;
  readonly route: string;
}

/** A character that would continue a path — a path followed by one is not
 *  the mentioned path but a longer one. ASCII only, as in the composer:
 *  Chinese runs on from a path without a space. */
const PATH_CHAR = /[A-Za-z0-9_./-]/;

/** Where each mentioned path sits in the text, left to right, longest path
 *  first at a tie. A backticked path takes its ticks with it. */
function mentionSpans(
  text: string,
  mentions: readonly string[],
): Array<{ start: number; end: number; path: string }> {
  const sorted = [...mentions].sort((a, b) => b.length - a.length);
  const spans: Array<{ start: number; end: number; path: string }> = [];
  const taken = (s: number, e: number): boolean =>
    spans.some((x) => s < x.end && e > x.start);
  for (const path of sorted) {
    for (const spelled of [`\`${path}\``, path]) {
      let i = text.indexOf(spelled);
      while (i !== -1) {
        const end = i + spelled.length;
        const before = i > 0 ? (text[i - 1] as string) : "";
        const after = text[end];
        const bounded =
          spelled.startsWith("`") ||
          ((before === "" || !PATH_CHAR.test(before)) &&
            (after === undefined || !PATH_CHAR.test(after)));
        if (bounded && !taken(i, end)) spans.push({ start: i, end, path });
        i = text.indexOf(spelled, end);
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** Where each picked element's line sits in the text, left to right. */
function pickSpansOf(
  text: string,
  picks: readonly MessagePick[],
): Array<{ start: number; end: number; pick: MessagePick }> {
  const spans: Array<{ start: number; end: number; pick: MessagePick }> = [];
  for (const pick of [...picks].sort((a, b) => b.line.length - a.line.length)) {
    if (pick.line === "") continue;
    for (let i = text.indexOf(pick.line); i !== -1; ) {
      const end = i + pick.line.length;
      if (!spans.some((x) => i < x.end && end > x.start))
        spans.push({ start: i, end, pick });
      i = text.indexOf(pick.line, end);
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * A sent message with its mentioned paths drawn as file chips (ADR 0072
 * amendment 2026-10-20) — the chip the composer showed: the type icon and
 * the name, the full path on hover, and a click opening the file in the
 * viewer when one is at hand. The rest of the text goes through `render`
 * (the `@板砖` highlight).
 */
export function renderMentionText(
  text: string,
  mentions: readonly string[] | undefined,
  render: (segment: string) => ReactNode,
  onOpen?: (path: string) => void,
  /** Elements picked on the page (ADR 0083 §4): each line is drawn as the
   *  chip the composer showed — the crosshair and the element in the
   *  session's words, the page's host and path on hover. */
  picks?: { readonly list: readonly MessagePick[]; readonly lang: "zh" | "en" },
): ReactNode {
  const pickSpans = picks !== undefined ? pickSpansOf(text, picks.list) : [];
  const spans = [
    ...pickSpans,
    ...(mentions !== undefined && mentions.length > 0
      ? mentionSpans(text, mentions).filter(
          (m) => !pickSpans.some((p) => m.start < p.end && m.end > p.start),
        )
      : []),
  ].sort((a, b) => a.start - b.start);
  if (spans.length === 0) return render(text);
  const out: ReactNode[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.start > at)
      out.push(
        <Fragment key={`t${at}`}>{render(text.slice(at, s.start))}</Fragment>,
      );
    if ("pick" in s) {
      out.push(
        <span
          key={`c${s.start}`}
          className="message-chip message-chip--pick"
          {...hoverTipProps(s.pick.route)}
        >
          <PickIcon className="message-chip__icon" />
          <span className="message-chip__name">
            {pageElementWords(s.pick.element, picks?.lang ?? "zh")}
          </span>
        </span>,
      );
      at = s.end;
      continue;
    }
    const dir = s.path.endsWith("/");
    const path = s.path.replace(/\/+$/u, "");
    const body = (
      <>
        <FileTypeIcon path={path} dir={dir} className="message-chip__icon" />
        <span className="message-chip__name">{chipName(path)}</span>
      </>
    );
    out.push(
      onOpen !== undefined ? (
        <button
          key={`c${s.start}`}
          type="button"
          className="message-chip"
          onClick={() => onOpen(path)}
          {...hoverTipProps(s.path)}
        >
          {body}
        </button>
      ) : (
        <span
          key={`c${s.start}`}
          className="message-chip"
          {...hoverTipProps(s.path)}
        >
          {body}
        </span>
      ),
    );
    at = s.end;
  }
  if (at < text.length)
    out.push(<Fragment key={`t${at}`}>{render(text.slice(at))}</Fragment>);
  return out;
}
