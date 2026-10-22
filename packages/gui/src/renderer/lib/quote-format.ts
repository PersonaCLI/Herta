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
 * same shape back into a card (`parseLeadingQuotes`). Pure.
 */

import { makeT } from "../i18n/LocaleProvider.js";

export interface ComposerQuote {
  readonly id: string;
  /** Workspace-relative, forward slashes. */
  readonly path: string;
  readonly from: number;
  readonly to: number;
  /** What `from` and `to` count: lines (absent), or a PDF's pages (ADR 0078
   *  amendment 2026-10-21 — a PDF has no lines of its own). */
  readonly unit?: "page";
  /** A markdown section's heading; a PDF outline entry's title. */
  readonly title?: string;
  /** The source of those lines, bounded (`boundQuoteText`). */
  readonly text: string;
  /** The fence's language tag, when the file has one. */
  readonly fence?: string;
}

export const QUOTE_MAX_LINES = 200;
export const QUOTE_MAX_CHARS = 8_000;

/** A PDF quote's pages as the message's own language writes them
 *  (`quote.page` / `quote.pages` in the session-language catalogs). */
const pagesWord = (lang: "zh" | "en", from: number, to: number): string =>
  to > from
    ? makeT(lang)("quote.pages", { from, to })
    : makeT(lang)("quote.page", { n: from });

/** The four page spellings as patterns, read from the catalogs: each
 *  placeholder becomes a number group, the rest is literal. */
const NUM_A = "";
const NUM_B = "";
const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const PAGE_SPELLINGS: readonly string[] = (["zh", "en"] as const).flatMap(
  (lang) => [
    escapeRe(makeT(lang)("quote.page", { n: NUM_A })).replace(NUM_A, "(\\d+)"),
    escapeRe(makeT(lang)("quote.pages", { from: NUM_A, to: NUM_B }))
      .replace(NUM_A, "(\\d+)")
      .replace(NUM_B, "(\\d+)"),
  ],
);
/** Any page spelling, numbers uncaptured — for the header's label part. */
const PAGE_PART = `(?:${PAGE_SPELLINGS.map((p) => p.replaceAll("(\\d+)", "\\d+")).join("|")})`;
/** `path · <pages>`, one pattern per spelling. */
const PAGE_LABELS = PAGE_SPELLINGS.map((p) => new RegExp(`^(.+) · ${p}$`, "u"));

/** The header's word is the message's own language, so it comes from the
 *  session-language catalogs (`makeT`), never the UI locale; the parser
 *  knows both. The brackets are structure, not copy: U+3014 / U+3015. */
const OPEN = "\u3014";
const CLOSE = "\u3015";
const headerWord = (lang: "zh" | "en"): string => makeT(lang)("quote.header");
// The label is lazy up to its optional page part, so a page label's own
// " · " never reads as the title's.
const HEADER = new RegExp(
  `^${OPEN}(?:${headerWord("zh")}|${headerWord("en")}) (.+?(?: · ${PAGE_PART})?)(?: · (.+))?${CLOSE}$`,
  "u",
);
const LABEL = /^(.+):(\d+)(?:–(\d+))?$/;

/** `path:from–to`, or `path:from` for one line; a PDF's pages as
 *  `path · 第 3 页` (zh) or `path · p. 3` (en), in the message's language. */
export function quoteLabel(
  q: {
    readonly path: string;
    readonly from: number;
    readonly to: number;
    readonly unit?: "page";
  },
  lang: "zh" | "en" = "zh",
): string {
  if (q.unit === "page") return `${q.path} · ${pagesWord(lang, q.from, q.to)}`;
  return q.to > q.from ? `${q.path}:${q.from}–${q.to}` : `${q.path}:${q.from}`;
}

/** A label read back: its path and range, and what the range counts. */
function parseLabel(label: string):
  | {
      readonly path: string;
      readonly from: number;
      readonly to: number;
      readonly unit?: "page";
    }
  | undefined {
  for (const re of PAGE_LABELS) {
    const page = re.exec(label);
    if (page === null) continue;
    const from = Number(page[2]);
    return {
      path: page[1] as string,
      from,
      to: Number(page[3] ?? from),
      unit: "page",
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

/** A fence of backticks longer than any run inside the text. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g))
    longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** A title (a quoted section's heading) sits on the header line, OUTSIDE the
 *  fence that makes the source quotation (ADR 0078 amendment 2026-10-21): a
 *  heading that names `@板砖` — or `@brick`, which an EN session's alias
 *  turns into it — would dispatch 板砖 on the Trailblazer's behalf. A
 *  zero-width space after the `@` keeps the words and breaks the token. */
function inertTitle(title: string): string {
  return title.replace(/@(?=板砖|brick)/giu, "@​");
}

/** One quote as the message carries it. */
export function formatQuote(q: ComposerQuote, lang: "zh" | "en"): string {
  const title =
    q.title !== undefined && q.title.length > 0
      ? ` · ${inertTitle(q.title)}`
      : "";
  const fence = fenceFor(q.text);
  return [
    `${OPEN}${headerWord(lang)} ${quoteLabel(q, lang)}${title}${CLOSE}`,
    `${fence}${q.fence ?? ""}`,
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
  readonly path?: string;
  readonly from?: number;
  readonly to?: number;
  /** The range counts a PDF's pages. */
  readonly unit?: "page";
  readonly title?: string;
  readonly text: string;
  /** The fence's language tag, when it carried one. */
  readonly fence?: string;
}

/**
 * A header's label and title. The label takes an optional page part, so a
 * line quote whose title reads like one (`docs/x.md:1–5 · 第 2 页`, a
 * heading in a book's transcript) read as a PDF page quote of a file named
 * `docs/x.md:1–5` (release review 2026-10-22). A page label whose path is
 * itself a line label is that line quote, its title the page phrase.
 */
function splitHeader(
  label: string,
  title: string | undefined,
): { readonly label: string; readonly title?: string } {
  const at = parseLabel(label);
  if (at?.unit === "page" && LABEL.test(at.path)) {
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
    const at = parseLabel(label);
    quotes.push({
      label,
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
    if (q.path === undefined || q.from === undefined || q.to === undefined)
      return { quotes: [], rest: message };
    backSeq += 1;
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
  const labels = [
    ...quotes.map((q) => q.label),
    ...(cut !== null ? [cut[1] as string] : []),
  ];
  if (labels.length === 0) return message;
  const head = labels.map((l) => `${OPEN}${l}${CLOSE}`).join("");
  const said = cut === null ? rest.trim() : "";
  return said.length > 0 ? `${head} ${said}` : head;
}
