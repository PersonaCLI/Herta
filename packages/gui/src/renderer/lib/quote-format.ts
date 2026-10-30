/**
 * A quote the Trailblazer picked from the viewer's page (ADR 0078 §4–§7):
 * a file's lines, carried to Herta as the Trailblazer's own words.
 *
 * In the message it is a header line and a fence, at the front:
 *
 *   〔引用 src/calc.js:9–14〕
 *   ```js
 *   export function div(a, b) {
 *   …
 *   ```
 *
 * Herta has no tools, so the source itself rides the record (D7); 板砖
 * reads it the same way when the message calls him. The bubble reads the
 * same shape back into a card (`parseLeadingQuotes`). A Flow post (ADR
 * 0084 §9) is a quote too, its label the page's URL, which Herta reads as
 * its host (`nameQuotedPages` in `@herta/core`). Pure.
 */

import { makeT } from "../i18n/LocaleProvider.js";
import { inertMentions } from "./file-mention.js";

/** What a quote's range counts when not lines: a PDF's pages (ADR 0078
 *  amendment 2026-10-21), a Word document's paragraphs (2026-10-29). Neither
 *  has lines of its own. */
export type QuoteUnit = "page" | "para";

/** A file's lines, pages or paragraphs, picked from the viewer's page. */
export interface FileQuote {
  readonly kind?: undefined;
  readonly id: string;
  /** Workspace-relative, forward slashes. */
  readonly path: string;
  readonly from: number;
  readonly to: number;
  /** What `from` and `to` count: lines (absent), pages or paragraphs. */
  readonly unit?: QuoteUnit;
  /** A markdown section's heading; a PDF outline entry's title; the Word
   *  heading the quote falls under. */
  readonly title?: string;
  /** The source of those lines, bounded (`boundQuoteText`). */
  readonly text: string;
  /** The fence's language tag, when the file has one. */
  readonly fence?: string;
}

/** A Flow post brought to Herta (ADR 0084 §9). */
export interface PostQuote {
  readonly kind: "post";
  readonly id: string;
  /** The source page, http(s): the header's label, for 板砖. */
  readonly url: string;
  readonly title: string;
  /** The site and date, the write-up and her word (`postQuote`). */
  readonly text: string;
  // A file quote's fields, never set: readable on either kind.
  readonly path?: undefined;
  readonly from?: undefined;
  readonly to?: undefined;
  readonly unit?: undefined;
  readonly fence?: undefined;
}

export type ComposerQuote = FileQuote | PostQuote;

export const QUOTE_MAX_LINES = 200;
export const QUOTE_MAX_CHARS = 8_000;

/** The catalog keys of a unit's one and its range. */
const UNIT_KEYS = {
  page: ["quote.page", "quote.pages"],
  para: ["quote.para", "quote.paras"],
} as const satisfies Record<QuoteUnit, readonly [string, string]>;

/** A quote's pages or paragraphs as the message's own language writes them
 *  (`quote.page` / `quote.pages`, `quote.para` / `quote.paras` in the
 *  session-language catalogs). */
const unitWord = (
  unit: QuoteUnit,
  lang: "zh" | "en",
  from: number,
  to: number,
): string => {
  const [one, range] = UNIT_KEYS[unit];
  return to > from
    ? makeT(lang)(range, { from, to })
    : makeT(lang)(one, { n: from });
};

/** Every unit spelling as a pattern, read from the catalogs: each
 *  placeholder becomes a number group, the rest is literal. */
const NUM_A = "";
const NUM_B = "";
const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const UNIT_SPELLINGS: readonly { unit: QuoteUnit; re: string }[] = (
  ["page", "para"] as const
).flatMap((unit) =>
  (["zh", "en"] as const).flatMap((lang) => {
    const [one, range] = UNIT_KEYS[unit];
    return [
      {
        unit,
        re: escapeRe(makeT(lang)(one, { n: NUM_A })).replace(NUM_A, "(\\d+)"),
      },
      {
        unit,
        re: escapeRe(makeT(lang)(range, { from: NUM_A, to: NUM_B }))
          .replace(NUM_A, "(\\d+)")
          .replace(NUM_B, "(\\d+)"),
      },
    ];
  }),
);
/** Any unit spelling, numbers uncaptured — for the header's label part. */
const UNIT_PART = `(?:${UNIT_SPELLINGS.map((u) => u.re.replaceAll("(\\d+)", "\\d+")).join("|")})`;
/** `path · <pages or paragraphs>`, one pattern per spelling. */
const UNIT_LABELS = UNIT_SPELLINGS.map((u) => ({
  unit: u.unit,
  re: new RegExp(`^(.+) · ${u.re}$`, "u"),
}));

/** The header's word is the message's own language, so it comes from the
 *  session-language catalogs (`makeT`), never the UI locale; the parser
 *  knows both. The brackets are structure, not copy: U+3014 / U+3015. */
const OPEN = "\u3014";
const CLOSE = "\u3015";
const headerWord = (lang: "zh" | "en"): string => makeT(lang)("quote.header");
// The label is lazy up to its optional page part, so a page label's own
// " · " never reads as the title's.
const HEADER = new RegExp(
  `^${OPEN}(?:${headerWord("zh")}|${headerWord("en")}) (.+?(?: · ${UNIT_PART})?)(?: · (.+))?${CLOSE}$`,
  "u",
);
const LABEL = /^(.+):(\d+)(?:–(\d+))?$/;
/** A post quote's label: its page's URL, one token. */
const URL_LABEL = /^https?:\/\/\S+$/u;

/** A page's host, as the chip, the bubble and Herta name it. */
export function quoteHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** `path:from–to`, or `path:from` for one line; a PDF's pages as
 *  `path · 第 3 页` (zh) or `path · p. 3` (en), a Word document's paragraphs
 *  as `path · 第 12–15 段` or `path · ¶ 12–15`, in the message's language. */
export function quoteLabel(
  q: {
    readonly path: string;
    readonly from: number;
    readonly to: number;
    readonly unit?: QuoteUnit;
  },
  lang: "zh" | "en" = "zh",
): string {
  if (q.unit !== undefined)
    return `${q.path} · ${unitWord(q.unit, lang, q.from, q.to)}`;
  return q.to > q.from ? `${q.path}:${q.from}–${q.to}` : `${q.path}:${q.from}`;
}

/** A label read back: its path and range, and what the range counts. */
function parseLabel(label: string):
  | {
      readonly path: string;
      readonly from: number;
      readonly to: number;
      readonly unit?: QuoteUnit;
    }
  | undefined {
  for (const { unit, re } of UNIT_LABELS) {
    const m = re.exec(label);
    if (m === null) continue;
    const from = Number(m[2]);
    return {
      path: m[1] as string,
      from,
      to: Number(m[3] ?? from),
      unit,
    };
  }
  const line = LABEL.exec(label);
  if (line === null) return undefined;
  return {
    path: line[1] as string,
    from: Number(line[2]),
    to: Number(line[3] ?? line[2]),
  };
}

/** A quote's source held to the bounds, with a note of what was left out. */
export function boundQuoteText(text: string, lang: "zh" | "en"): string {
  const lines = text.split("\n");
  let kept = lines.slice(0, QUOTE_MAX_LINES);
  let body = kept.join("\n");
  if (body.length > QUOTE_MAX_CHARS) {
    body = body.slice(0, QUOTE_MAX_CHARS);
    // Never half a character: a cut between a surrogate pair (an emoji, a
    // CJK Extension B ideograph) left a lone surrogate in the record and the
    // request (release review 2026-10-22).
    const last = body.charCodeAt(body.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) body = body.slice(0, -1);
    kept = body.split("\n");
  }
  const left = lines.length - kept.length;
  if (left <= 0 && body.length === text.length) return text;
  const note = makeT(lang)("quote.truncated", { n: Math.max(left, 1) });
  return `${body}\n${note}`;
}

/** A Flow post as a quote: its URL with any `@brick` broken as `%40` (the
 *  header sits outside the fence, where an EN session's alias reads it),
 *  its title on one line, and its text bounded. The text opens on the issue
 *  it came from and ends on her word as "yours": written as 「黑塔：…」, she
 *  read her own word as a line put in her mouth (live run 2026-10-30).
 *  Undefined for a URL that is not http(s). */
export function postQuote(
  post: {
    readonly id: string;
    readonly url: string;
    readonly site: string;
    readonly date: string | null;
    readonly title: string;
    readonly detail: string;
    readonly word: string | null;
  },
  lang: "zh" | "en",
  issue?: number,
): PostQuote | undefined {
  let url: string;
  try {
    const parsed = new URL(post.url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return undefined;
    url = parsed.href.replace(/@(?=brick)/giu, "%40");
  } catch {
    return undefined;
  }
  const head = [
    ...(issue !== undefined
      ? [makeT(lang)("quote.broadcast", { n: issue })]
      : []),
    post.site,
    ...(post.date !== null ? [post.date] : []),
  ].join(" · ");
  const parts = [head, post.detail];
  if (post.word !== null)
    parts.push(makeT(lang)("quote.word", { word: post.word }));
  return {
    kind: "post",
    id: `post-${post.id}`,
    url,
    title: post.title.replace(/\s+/gu, " ").trim(),
    text: boundQuoteText(parts.join("\n\n"), lang),
  };
}

/** The composer chip's label: a file's range, or a post's site. */
export function chipLabel(q: ComposerQuote, lang: "zh" | "en"): string {
  return q.kind === "post" ? quoteHost(q.url) : quoteLabel(q, lang);
}

/** A fence of backticks longer than any run inside the text. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g))
    longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** One quote as the message carries it. A title (a quoted section's
 *  heading) sits on the header line, OUTSIDE the fence that makes the source
 *  quotation (ADR 0078 amendment 2026-10-21), so its `@板砖` is made inert. */
export function formatQuote(q: ComposerQuote, lang: "zh" | "en"): string {
  const title =
    q.title !== undefined && q.title.length > 0
      ? ` · ${inertMentions(q.title)}`
      : "";
  const fence = fenceFor(q.text);
  const label = q.kind === "post" ? q.url : quoteLabel(q, lang);
  const tag = q.kind === "post" ? "" : (q.fence ?? "");
  return [
    `${OPEN}${headerWord(lang)} ${label}${title}${CLOSE}`,
    `${fence}${tag}`,
    q.text,
    fence,
  ].join("\n");
}

/** The message to send: the quotes first, then what was typed. */
export function composeQuotedMessage(
  quotes: readonly ComposerQuote[],
  typed: string,
  lang: "zh" | "en",
): string {
  if (quotes.length === 0) return typed;
  const head = quotes.map((q) => formatQuote(q, lang)).join("\n\n");
  const rest = typed.trim();
  return rest.length > 0 ? `${head}\n\n${rest}` : head;
}

export interface ParsedQuote {
  readonly label: string;
  /** A Flow post's page (ADR 0084 §9): the label is this URL. */
  readonly url?: string;
  readonly path?: string;
  readonly from?: number;
  readonly to?: number;
  /** The range counts a PDF's pages or a Word document's paragraphs. */
  readonly unit?: QuoteUnit;
  readonly title?: string;
  readonly text: string;
  /** The fence's language tag, when it carried one. */
  readonly fence?: string;
}

/**
 * A header's label and title. The label takes an optional page part, so a
 * line quote whose title reads like one (`docs/x.md:1–5 · 第 2 页`, a
 * heading in a book's transcript) read as a PDF page quote of a file named
 * `docs/x.md:1–5` (release review 2026-10-22). A page or paragraph label
 * whose path is itself a line label is that line quote, its title the
 * phrase.
 */
function splitHeader(
  label: string,
  title: string | undefined,
): { readonly label: string; readonly title?: string } {
  const at = parseLabel(label);
  if (
    at?.unit !== undefined &&
    (LABEL.test(at.path) || URL_LABEL.test(at.path))
  ) {
    const phrase = label.slice(at.path.length + " · ".length);
    return {
      label: at.path,
      title: title !== undefined ? `${phrase} · ${title}` : phrase,
    };
  }
  return title !== undefined ? { label, title } : { label };
}

/**
 * The quotes at the front of a message, and the rest of it. A header that
 * is not followed by a well-formed fence is ordinary text.
 */
export function parseLeadingQuotes(message: string): {
  readonly quotes: readonly ParsedQuote[];
  readonly rest: string;
} {
  const lines = message.split("\n");
  const quotes: ParsedQuote[] = [];
  let i = 0;
  for (;;) {
    const head = HEADER.exec(lines[i] ?? "");
    const open = /^(`{3,})([^`]*)$/.exec(lines[i + 1] ?? "");
    if (head === null || open === null) break;
    const fence = open[1] as string;
    const tag = (open[2] ?? "").trim();
    const close = lines.findIndex((l, k) => k > i + 1 && l === fence);
    if (close === -1) break;
    const { label, title } = splitHeader(head[1] as string, head[2]);
    // A URL is a page, never a file's line (`https://a.dev:8080`).
    const page = URL_LABEL.test(label);
    const at = page ? undefined : parseLabel(label);
    quotes.push({
      label,
      ...(page ? { url: label } : {}),
      ...(at ?? {}),
      ...(title !== undefined ? { title } : {}),
      text: lines.slice(i + 2, close).join("\n"),
      ...(tag.length > 0 ? { fence: tag } : {}),
    });
    i = close + 1;
    while ((lines[i] ?? "").trim().length === 0 && i < lines.length) i += 1;
  }
  if (quotes.length === 0) return { quotes, rest: message };
  return { quotes, rest: lines.slice(i).join("\n") };
}

/** A message's leading quotes as written, and the rest of it. */
function splitLeadingQuotes(message: string): {
  readonly head: string;
  readonly rest: string;
} {
  const { quotes, rest } = parseLeadingQuotes(message);
  if (quotes.length === 0) return { head: "", rest: message };
  return {
    head: message.slice(0, message.length - rest.length).trimEnd(),
    rest,
  };
}

/**
 * A second message held while the first waits (ADR 0063 holds one): the
 * quotes of both in front, then the words of both, in order. Joined as
 * they came, the second's quotes sat mid-message, where nothing reads a
 * quote — the held card showed its fence, and Edit, Stop or a failure put
 * the fence into the field as text (release review 2026-10-22).
 */
export function joinHeld(prev: string, next: string): string {
  const b = splitLeadingQuotes(next);
  if (b.head === "") return `${prev}\n\n${next}`;
  const a = splitLeadingQuotes(prev);
  const heads = [a.head, b.head].filter((h) => h.length > 0).join("\n\n");
  const words = [a.rest, b.rest]
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .join("\n\n");
  return words.length > 0 ? `${heads}\n\n${words}` : heads;
}

let backSeq = 0;

/**
 * A message coming back into the composer — the held card's Edit, a hold
 * returned after Stop or a failure, ↑ recall, a rewind — with its leading
 * quotes as chips again, not as header-and-fence text in the field (ADR 0078
 * amendment 2026-10-21). Only when every quote names its source: a header
 * the parser cannot place stays text, the whole message with it.
 */
export function quotesBack(message: string): {
  readonly quotes: readonly ComposerQuote[];
  readonly rest: string;
} {
  const parsed = parseLeadingQuotes(message);
  if (parsed.quotes.length === 0) return { quotes: [], rest: message };
  const quotes: ComposerQuote[] = [];
  for (const q of parsed.quotes) {
    backSeq += 1;
    if (q.url !== undefined) {
      quotes.push({
        kind: "post",
        id: `qb${Date.now().toString(36)}-${backSeq}`,
        url: q.url,
        title: q.title ?? "",
        text: q.text,
      });
      continue;
    }
    if (q.path === undefined || q.from === undefined || q.to === undefined)
      return { quotes: [], rest: message };
    quotes.push({
      id: `qb${Date.now().toString(36)}-${backSeq}`,
      path: q.path,
      from: q.from,
      to: q.to,
      ...(q.unit !== undefined ? { unit: q.unit } : {}),
      ...(q.title !== undefined ? { title: q.title } : {}),
      text: q.text,
      ...(q.fence !== undefined ? { fence: q.fence } : {}),
    });
  }
  return { quotes, rest: parsed.rest };
}

/** A one-line stand-in for a quoted message (the sidebar card's preview):
 *  each quote's label in brackets, then what was said — never the fence.
 *  The stored preview is cut at a fixed length, often inside a fence: a
 *  header whose fence never closes still names its quote, and the cut
 *  source stays out. */
export function quotedMessagePreview(message: string): string {
  const { quotes, rest } = parseLeadingQuotes(message);
  const cut = HEADER.exec(rest.split("\n", 1)[0] ?? "");
  // A post's label is its URL; the preview names its site.
  const named = (label: string): string =>
    URL_LABEL.test(label) ? quoteHost(label) : label;
  const labels = [
    ...quotes.map((q) => named(q.label)),
    ...(cut !== null ? [named(cut[1] as string)] : []),
  ];
  if (labels.length === 0) return message;
  const head = labels.map((l) => `${OPEN}${l}${CLOSE}`).join("");
  const said = cut === null ? rest.trim() : "";
  return said.length > 0 ? `${head} ${said}` : head;
}
