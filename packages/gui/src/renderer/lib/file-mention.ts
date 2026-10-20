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

/** How many matches the list shows — more than fit, so it scrolls under
 *  its faded edges (ADR 0072 amendment 2026-10-20). */
export const MENTION_LIMIT = 12;

/** One row of the list: the delegation token, or a workspace file. */
export type MentionItem =
  | { readonly kind: "brick" }
  | { readonly kind: "file"; readonly path: string; readonly dir?: true };

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
    // Folders beside the files (ADR 0072 amendment 2026-10-20): a bare `@`
    // offers the top-level ones after the files being worked on; a query
    // ranks every folder with the files.
    const folders = listedFolders(files);
    const isFolder = new Set(folders);
    const paths =
      query.length === 0
        ? openingPaths(
            [...folders.filter((d) => !d.includes("/")), ...files],
            changed,
          )
        : rankPaths([...folders, ...files], query);
    for (const path of paths) {
      items.push(
        isFolder.has(path)
          ? { kind: "file", path, dir: true }
          : { kind: "file", path },
      );
    }
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

// ── File chips (ADR 0072 amendment 2026-10-20) ─────────────────────────────
//
// A picked file is a CHIP in the composer: the text holds a short token,
// `@<name>`, and the highlight layer draws it as a chip (the type icon over
// the `@`, the name after it), so the textarea keeps every glyph's width and
// the caret stays where it is drawn. The chip stands for its path: on send
// each token becomes the path (`expandChips`), and the user block records the
// paths it mentions, so Herta's prompt can name each by its file name while
// 板砖 reads the path.

/** One chip in the composer: the token's name and the path it stands for. */
export interface FileChip {
  readonly name: string;
  readonly path: string;
  /** A folder: the icon says so, and the path is sent with a `/`. */
  readonly dir?: true;
}

/** Where a chip's token sits in the text (`end` exclusive). */
export interface ChipSpan {
  readonly start: number;
  readonly end: number;
  readonly chip: FileChip;
}

/** The name a path's chip shows: its last segment. */
export function chipName(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/** A character that would continue a file name — a token followed by one is
 *  not the token (`@a.ts` is not in `@a.tsx`). ASCII only: Chinese runs on
 *  from a token without a space, and must not swallow it. */
const NAME_CHAR = /[A-Za-z0-9_.\-/]/;

/**
 * The chips' tokens in the text, left to right. A token is `@<name>` with no
 * name character before the `@` or after the name. Two chips with the same
 * name are matched to their tokens in the order they were inserted.
 */
export function findChipSpans(
  text: string,
  chips: readonly FileChip[],
): ChipSpan[] {
  if (chips.length === 0) return [];
  const byName = new Map<string, FileChip[]>();
  for (const c of chips) {
    const list = byName.get(c.name) ?? [];
    list.push(c);
    byName.set(c.name, list);
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const used = new Map<string, number>();
  const spans: ChipSpan[] = [];
  let i = text.indexOf("@");
  while (i !== -1) {
    const before = i > 0 ? (text[i - 1] as string) : "";
    let matched: ChipSpan | null = null;
    if (before === "" || !NAME_CHAR.test(before)) {
      for (const name of names) {
        if (!text.startsWith(name, i + 1)) continue;
        const end = i + 1 + name.length;
        const after = text[end];
        if (after !== undefined && NAME_CHAR.test(after)) continue;
        const list = byName.get(name) as FileChip[];
        const k = used.get(name) ?? 0;
        if (k >= list.length) continue;
        used.set(name, k + 1);
        matched = { start: i, end, chip: list[k] as FileChip };
        break;
      }
    }
    if (matched !== null) {
      spans.push(matched);
      i = text.indexOf("@", matched.end);
    } else {
      i = text.indexOf("@", i + 1);
    }
  }
  return spans;
}

/** The chips whose tokens the text still holds — an edited-away chip goes. */
export function pruneChips(
  text: string,
  chips: readonly FileChip[],
): readonly FileChip[] {
  if (chips.length === 0) return chips;
  const kept = findChipSpans(text, chips).map((s) => s.chip);
  return kept.length === chips.length ? chips : kept;
}

/** The chip whose token the caret is strictly inside, or ends at. */
export function chipAt(
  spans: readonly ChipSpan[],
  caret: number,
): ChipSpan | null {
  for (const s of spans) if (caret > s.start && caret <= s.end) return s;
  return null;
}

/** A chip's path as the message spells it: a folder with its `/`, a path
 *  with whitespace in backticks (as a picked path always was). */
function spelledPath(chip: FileChip): string {
  const path =
    chip.dir === true ? `${chip.path.replace(/\/+$/u, "")}/` : chip.path;
  return /\s/.test(path) ? `\`${path}\`` : path;
}

/** The message to send: each token replaced by the path it stands for, and
 *  the paths it mentions (as they appear, folders with their `/`). */
export function expandChips(
  text: string,
  chips: readonly FileChip[],
): { readonly text: string; readonly mentions: readonly string[] } {
  const spans = findChipSpans(text, chips);
  if (spans.length === 0) return { text, mentions: [] };
  let out = "";
  let at = 0;
  const mentions: string[] = [];
  for (const s of spans) {
    out += text.slice(at, s.start) + spelledPath(s.chip);
    at = s.end;
    const path =
      s.chip.dir === true
        ? `${s.chip.path.replace(/\/+$/u, "")}/`
        : s.chip.path;
    if (!mentions.includes(path)) mentions.push(path);
  }
  return { text: out + text.slice(at), mentions };
}

/** A sent message back as chips (the ↑ recall): each mentioned path's
 *  occurrence becomes its token. */
export function chipify(
  text: string,
  mentions: readonly string[] | undefined,
): { readonly text: string; readonly chips: readonly FileChip[] } {
  if (mentions === undefined || mentions.length === 0)
    return { text, chips: [] };
  let out = text;
  const chips: FileChip[] = [];
  for (const raw of [...mentions].sort((a, b) => b.length - a.length)) {
    const dir = raw.endsWith("/");
    const path = raw.replace(/\/+$/u, "");
    const name = chipName(path);
    const spelled = [`\`${raw}\``, raw];
    for (const s of spelled) {
      if (!out.includes(s)) continue;
      out = out.split(s).join(`@${name}`);
      chips.push({ name, path, ...(dir ? { dir: true as const } : {}) });
      break;
    }
  }
  return { text: out, chips };
}

/** The `@<name>` token a picked path becomes, and the chip that draws it,
 *  replacing `@query` (from `start` to the caret) with one space after. */
export function insertChip(
  value: string,
  start: number,
  caret: number,
  path: string,
  dir: boolean,
): {
  readonly text: string;
  readonly caret: number;
  readonly chip: FileChip;
} {
  const chip: FileChip = {
    name: chipName(path),
    path: path.replace(/\/+$/u, ""),
    ...(dir ? { dir: true as const } : {}),
  };
  const token = `@${chip.name}`;
  const after = value.slice(caret);
  const sep = after.startsWith(" ") ? "" : " ";
  return {
    text: `${value.slice(0, start)}${token}${sep}${after}`,
    caret: start + token.length + 1,
    chip,
  };
}

/** The folders of a file listing, shallowest first then by name — what the
 *  list offers beside the files. */
export function listedFolders(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    let cut = f.lastIndexOf("/");
    while (cut > 0) {
      const d = f.slice(0, cut);
      if (dirs.has(d)) break;
      dirs.add(d);
      cut = d.lastIndexOf("/");
    }
  }
  return [...dirs].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
}
