/**
 * @-file mentions in the composer (ADR 0072 §2): which `@query` the caret
 * sits in, whether `@板砖` completion still owns it, and which workspace
 * paths match. Pure, so the matching unit-tests without a DOM.
 */

/** The `@query` the caret sits in: the `@` must start the text or follow
 *  whitespace, and the query runs from it to the caret with no whitespace
 *  and no second `@`. Null when the caret is not in one. */
export function findMentionQuery(
  value: string,
  caret: number | null,
): { readonly start: number; readonly query: string } | null {
  if (caret === null || caret < 1 || caret > value.length) return null;
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i] as string;
    if (ch === "@") break;
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  if (i < 0) return null;
  if (i > 0 && !/\s/.test(value[i - 1] ?? "")) return null;
  return { start: i, query: value.slice(i + 1, caret) };
}

/** Whether the query can still become the `@板砖` delegation token — the
 *  list then offers it first, and the inline ghost previews it. */
export function brickAhead(query: string, lang: "zh" | "en"): boolean {
  if (query.length === 0) return true;
  if ("板砖".startsWith(query)) return true;
  return lang === "en" && "brick".startsWith(query.toLowerCase());
}

/** The query already IS the token, typed out or completed: nothing is left
 *  to offer — no file is meant by `@板砖`. */
export function brickComplete(query: string, lang: "zh" | "en"): boolean {
  return query === "板砖" || (lang === "en" && query.toLowerCase() === "brick");
}

/** How many matches the list shows. */
export const MENTION_LIMIT = 8;

/** One row of the list: the delegation token, or a workspace file. */
export type MentionItem =
  | { readonly kind: "brick" }
  | { readonly kind: "file"; readonly path: string };

/**
 * What the list offers for the `@query` (owner 2026-10-08: the list
 * appeared only once a query was typed past what could be `@板砖`, so a
 * bare `@` showed the ghost alone and nobody learned the files were
 * there). `@板砖` first while the query can still become it — its place is
 * kept, now as the first row, highlighted — then the files: for a bare
 * `@`, the ones being worked on (`changed`, workspace-relative) and then
 * the listing's own order, shallowest first; for a query, the ranked
 * matches. `files` null: not listed (yet, or no surface) — the token alone.
 */
export function mentionItems(
  query: string,
  lang: "zh" | "en",
  files: readonly string[] | null,
  changed: readonly string[] = [],
): MentionItem[] {
  if (brickComplete(query, lang)) return [];
  const items: MentionItem[] = [];
  if (brickAhead(query, lang)) items.push({ kind: "brick" });
  if (files !== null) {
    const paths =
      query.length === 0
        ? openingPaths(files, changed)
        : rankPaths(files, query);
    for (const path of paths) items.push({ kind: "file", path });
  }
  return items;
}

/** A bare `@`'s files: `first` (in its order, only those listed — a deleted
 *  file is not offered), then the rest of `paths` in theirs. */
export function openingPaths(
  paths: readonly string[],
  first: readonly string[],
  limit = MENTION_LIMIT,
): string[] {
  const listed = new Set(paths);
  const out = new Set<string>();
  for (const p of first) {
    if (out.size >= limit) break;
    if (listed.has(p)) out.add(p);
  }
  for (const p of paths) {
    if (out.size >= limit) break;
    out.add(p);
  }
  return [...out];
}

/**
 * The workspace paths that match `query`, best first. Case-insensitive; a
 * `\` in the query reads as `/`. The file name starting with the query ranks
 * first, then the file name containing it, then the path containing it, then
 * the query's characters in order in the FILE NAME — or, for a query that
 * names a folder (it holds a `/`), in the whole path. In order across the
 * whole path for any query was noise: `errors.ts` in `packages/core/src`
 * matched "parser" (live check 2026-09-29). Shorter paths win a tie, then
 * the alphabet.
 */
export function rankPaths(
  paths: readonly string[],
  query: string,
  limit = MENTION_LIMIT,
): string[] {
  const q = query.toLowerCase().replace(/\\/g, "/");
  if (q.length === 0) return [];
  const namesFolder = q.includes("/");
  const scored: Array<{ path: string; rank: number }> = [];
  for (const path of paths) {
    const p = path.toLowerCase();
    const base = p.slice(p.lastIndexOf("/") + 1);
    let rank: number;
    if (base.startsWith(q)) rank = 0;
    else if (base.includes(q)) rank = 1;
    else if (p.includes(q)) rank = 2;
    else if (inOrder(namesFolder ? p : base, q)) rank = 3;
    else continue;
    scored.push({ path, rank });
  }
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path),
  );
  return scored.slice(0, limit).map((s) => s.path);
}

function inOrder(text: string, q: string): boolean {
  let j = 0;
  for (let i = 0; i < text.length && j < q.length; i += 1) {
    if (text[i] === q[j]) j += 1;
  }
  return j === q.length;
}

/** The text with `@query` completed to `@<token>` — exactly what the
 *  ghost's Tab inserts, no space after it (a zh message runs on from
 *  `@板砖` without one). */
export function insertBrick(
  value: string,
  start: number,
  caret: number,
  token: string,
): { readonly text: string; readonly caret: number } {
  const at = start + 1;
  return {
    text: `${value.slice(0, at)}${token}${value.slice(caret)}`,
    caret: at + token.length,
  };
}

/** The text with `@query` (from `start` to the caret) replaced by the path
 *  and one space, and where the caret goes. A path with whitespace in it
 *  goes in backticks, so where it ends is not left to the reader (review
 *  2026-09-30: `docs/design notes.md` read as `docs/design`); the preview
 *  surfaces strip inline ticks as they do for any code span. */
export function insertMention(
  value: string,
  start: number,
  caret: number,
  path: string,
): { readonly text: string; readonly caret: number } {
  const spelled = /\s/.test(path) ? `\`${path}\`` : path;
  const after = value.slice(caret);
  const sep = after.startsWith(" ") ? "" : " ";
  const text = `${value.slice(0, start)}${spelled}${sep}${after}`;
  return { text, caret: start + spelled.length + 1 };
}
