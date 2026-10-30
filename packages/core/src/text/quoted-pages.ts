/**
 * The web pages a user's message quotes at its front (ADR 0084 §9). A Flow
 * post rides the message as a header and a fence, as a file's lines do (ADR
 * 0078 §5), its label the page's URL:
 *
 *   〔引用 https://nodejs.org/en/blog/release/v24 · Node.js 24 is out〕
 *   ```
 *   Node.js · 2026-10-30
 *   …
 *   ```
 *
 * ONE reading, in core, because three readers must agree on it: 板砖 reads
 * the URL as written; Herta reads the page as its host (`@herta/herta`'s
 * serializer, ADR 0080 §5: never a URL); and the desktop's main opens the
 * URL only when the session's own record names it (`recordedWebUrls`).
 * Only the leading quotes count, as the bubble reads them: a header that is
 * not over a closed fence, or that follows the message's words, is text.
 * The brackets are structure: U+3014 / U+3015. Pure.
 */

/** Any quote's header: its word (引用 / Quote), then its label and title. */
const HEAD = /^〔\S+ (.+)〕$/u;
/** A post quote's label: the page's URL, one token, then its title. */
const PAGE = /^(https?:\/\/\S+?)(?= · |$)/u;
const OPEN = /^(`{3,})[^`]*$/u;

/** Each leading quote's header line, and its page's URL when it has one. */
function leadingHeads(
  lines: readonly string[],
): { readonly line: number; readonly url: string | undefined }[] {
  const heads: { line: number; url: string | undefined }[] = [];
  let i = 0;
  for (;;) {
    const head = HEAD.exec(lines[i] ?? "");
    const open = OPEN.exec(lines[i + 1] ?? "");
    if (head === null || open === null) break;
    const fence = open[1] as string;
    const close = lines.findIndex((l, k) => k > i + 1 && l === fence);
    if (close === -1) break;
    heads.push({ line: i, url: PAGE.exec(head[1] as string)?.[1] });
    i = close + 1;
    while (i < lines.length && (lines[i] ?? "").trim().length === 0) i += 1;
  }
  return heads;
}

/** The URLs of the pages a message quotes at its front, in order. */
export function quotedPageUrls(text: string): string[] {
  return leadingHeads(text.split("\n")).flatMap((h) =>
    h.url !== undefined ? [h.url] : [],
  );
}

/** The message with each quoted page's URL, in its header, as `name` reads
 *  it. The source under the header is left as it is. */
export function nameQuotedPages(
  text: string,
  name: (url: string) => string,
): string {
  const lines = text.split("\n");
  const heads = leadingHeads(lines).filter((h) => h.url !== undefined);
  if (heads.length === 0) return text;
  for (const { line, url } of heads) {
    const at = lines[line] as string;
    const start = at.indexOf(" ") + 1;
    lines[line] =
      `${at.slice(0, start)}${name(url as string)}${at.slice(start + (url as string).length)}`;
  }
  return lines.join("\n");
}
