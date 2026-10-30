import { redactSecrets } from "@herta/tools";

/**
 * The text rules every model-written or web-sourced field of an issue
 * passes (ADR 0084 §5 step 4): plain text, `@板砖` / `@brick` inert, the
 * redactor, a length cap. Pure functions, shared by the pipeline and the
 * store's seen index.
 */

/** A zero-width space after the `@` keeps the words and breaks the token:
 *  a post quoted into the composer (§9) must not dispatch 板砖. The same
 *  one-line rule as the renderer's `inertMentions` (gui
 *  `renderer/lib/file-mention.ts`); copied, since app-server cannot import
 *  the renderer. */
export function inertMentions(text: string): string {
  return text.replace(/@(?=板砖|brick)/giu, "@​");
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
};

/**
 * Markdown and HTML out, words kept. Entities are decoded first so an
 * escaped tag is stripped as well. Every pattern is linear: the input is a
 * model's reply or a web summary, never trusted to be small or well formed.
 * `lines` keeps paragraph breaks (the write-up); otherwise the result is
 * one line.
 */
export function plainText(raw: string, lines = false): string {
  let t = raw.replace(/\r\n?/g, "\n");
  t = t.replace(
    /&(amp|lt|gt|quot|apos|nbsp|#39|#x27);/gi,
    (m, name: string) => ENTITIES[name.toLowerCase()] ?? m,
  );
  // A tag never spans another `<`, so a stray one cannot make every later
  // start scan to the end.
  t = t.replace(/<[^<>]*>/g, " ");
  // Images and links keep their text, never their target. The same bound:
  // a bracket's text holds no other bracket.
  t = t.replace(/!\[([^[\]\n]*)\]\([^()\n]*\)/g, "$1");
  t = t.replace(/\[([^[\]\n]*)\]\([^()\n]*\)/g, "$1");
  t = t.replace(/\[([^[\]\n]*)\]\[[^[\]\n]*\]/g, "$1");
  t = t.replace(/`+([^`\n]*)`+/g, "$1");
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  t = t.replace(/__([^_\n]+)__/g, "$1");
  t = t.replace(/~~([^~\n]+)~~/g, "$1");
  t = t.replace(/(^|[^\w*])\*([^*\s][^*\n]*)\*(?!\w)/g, "$1$2");
  t = t.replace(/(^|[^\w])_([^_\s][^_\n]*)_(?!\w)/g, "$1$2");
  // Line-start markers: headings, quotes, bullets (numbered ones only in a
  // write-up — a one-line title may well start "2. ").
  t = t.replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+•][ \t]+)/gm, "");
  if (lines) t = t.replace(/^[ \t]*\d{1,2}[.)][ \t]+/gm, "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
  t = t.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
  if (!lines) return t.replace(/\s+/g, " ").trim();
  return t
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** At most `max` characters (code points), an ellipsis marking a cut. */
export function cut(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

/** One field of a card, through every rule of §5 step 4. The cap comes
 *  last: the redactor's marker may lengthen a line. */
export function cleanField(raw: string, max: number, lines = false): string {
  return cut(redactSecrets(inertMentions(plainText(raw, lines))), max);
}

/**
 * The write-up as an article (ADR 0084, amendment round 3): a small part of
 * Markdown kept so the opened post reads as sections — `###` headings,
 * paragraphs, `-` and numbered lists, **bold**, and GFM tables — and
 * everything else out, as `plainText` takes it out: HTML, images, link
 * targets, code, quotes, rules. The owner found the one block of plain text
 * "hard to read". Then the same rules as a field, and a cap that ends at a
 * block, so a cut never leaves half a table.
 */
export function cleanArticle(raw: string, max: number): string {
  let t = raw.replace(/\r\n?/g, "\n");
  t = t.replace(
    /&(amp|lt|gt|quot|apos|nbsp|#39|#x27);/gi,
    (m, name: string) => ENTITIES[name.toLowerCase()] ?? m,
  );
  t = t.replace(/<[^<>]*>/g, " ");
  t = t.replace(/!\[([^[\]\n]*)\]\([^()\n]*\)/g, "");
  t = t.replace(/\[([^[\]\n]*)\]\([^()\n]*\)/g, "$1");
  t = t.replace(/\[([^[\]\n]*)\]\[[^[\]\n]*\]/g, "$1");
  t = t.replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, "");
  t = t.replace(/`+([^`\n]*)`+/g, "$1");
  t = t.replace(/__([^_\n]+)__/g, "**$1**");
  t = t.replace(/~~([^~\n]+)~~/g, "$1");
  // Every heading is a section's, one level; quotes and rules go.
  t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, "### ");
  t = t.replace(/^[ \t]*>[ \t]?/gm, "");
  t = t.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "");
  t = t.replace(/^[ \t]*[*+•][ \t]+/gm, "- ");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
  t = t.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
  t = t
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const text = redactSecrets(inertMentions(t));
  if (Array.from(text).length <= max) return text;
  let kept = "";
  for (const b of text.split("\n\n")) {
    const next = kept === "" ? b : `${kept}\n\n${b}`;
    if (Array.from(next).length <= max) {
      kept = next;
      continue;
    }
    // A table goes whole or not at all; prose is cut to what is left.
    const room = max - Array.from(kept).length - 2;
    if (!b.startsWith("|") && room >= 80)
      kept = kept === "" ? cut(b, max) : `${kept}\n\n${cut(b, room)}`;
    break;
  }
  return kept !== "" ? kept : cut(text, max);
}

/**
 * A why-line that names the app (ADR 0084 §7). Herta read 「你的 HERTA 跑在
 * Electron 43 上」 as being about herself, so the card call is told to say
 * "your project"; this is the backstop when it does not. A possessive
 * ("your HERTA", 「你的 HERTA」) is the project and becomes "your project" /
 * 「你的项目」. Any other mention may be the game's Herta, and a wrong chip
 * is worse than none: the line is dropped.
 */
export function unnameApp(why: string, lang: "zh" | "en"): string {
  if (!APP_NAME.test(why)) return why;
  const project = lang === "zh" ? "你的项目" : "your project";
  const t = why.replace(OWNED_APP_NAME, project);
  return APP_NAME.test(t) ? "" : t;
}

const APP_NAME = /(?<![a-z0-9])herta(?![a-z0-9])|黑塔/iu;
const OWNED_APP_NAME =
  /(?:\byour\s+|你的\s*)(?:the\s+)?(?<![a-z0-9])herta(?![a-z0-9])(?:\s*(?:project|app|项目))?|你的\s*大?黑塔(?:\s*项目)?/giu;

/** A title as the seen index compares it: case, width and punctuation
 *  folded away, so a re-published headline still matches. */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** A URL as the seen index and the de-duplication compare it: no fragment,
 *  no `utm_*` tags, no trailing slash. A string that is not a URL compares
 *  as itself. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) u.searchParams.delete(key);
    }
    return u.href.replace(/\/(?=$|\?)/, "");
  } catch {
    return raw.trim();
  }
}

/** The URL's host without `www.`; the URL itself when it has none. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

/**
 * The site's name as the post's header shows it. The spike (ADR 0084,
 * 2026-10-30) found DeepSeek sometimes returns the site hex-encoded
 * (`766974656a73` is "vitejs"): an even-length all-hex name is decoded
 * when it is printable UTF-8, and otherwise the URL's host stands in, as
 * it does for a missing name.
 */
export function siteName(site: string | null, url: string): string {
  const s = site?.trim() ?? "";
  if (s === "") return hostOf(url);
  if (/^(?:[0-9a-f]{2})+$/i.test(s)) return decodeHexUtf8(s) ?? hostOf(url);
  return s;
}

function decodeHexUtf8(hex: string): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(Buffer.from(hex, "hex"))
      .trim();
    if (text === "" || /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u.test(text)) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

/** A model's JSON reply: the whole text, else the span from the first
 *  bracket to the last one of its kind (a fenced block, a sentence before
 *  it). Undefined when neither parses. */
export function parseJsonReply(text: string): unknown {
  const t = text
    .trim()
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    // fall through to the bracketed span
  }
  const start = t.search(/[[{]/);
  if (start < 0) return undefined;
  const end = t.lastIndexOf(t[start] === "{" ? "}" : "]");
  if (end <= start) return undefined;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
