/**
 * Which renderer a file gets (ADR 0054 §1). Pure: the EXTENSION decides
 * the kind — it is what the tab shows and what the OS would use — and
 * unknown extensions stay `text`, exactly the ADR 0050 behaviour. Content
 * sniffing stays where it was (the main-process NUL check on the TEXT
 * read); nothing here looks at bytes.
 */
export type ViewerKind =
  | "markdown"
  | "code"
  | "text"
  | "image"
  | "pdf"
  | "docx"
  | "xlsx"
  | "csv"
  | "pptx"
  /** A commit, not a file (ADR 0059): chosen by the TARGET's kind, never
   *  by a path — `viewerKindFor` never answers it. */
  | "commit"
  /** A path's working-tree diff against HEAD (ADR 0059 §5) — the
   *  target's kind again. */
  | "diff"
  /** The repository's history (ADR 0059 §6). */
  | "log"
  /** The browser page (ADR 0083 §2): not a file at all. */
  | "page";

export interface ViewerKindInfo {
  readonly kind: ViewerKind;
  /** highlight.js language id for `code` (and Markdown fences by alias);
   *  undefined for every other kind. */
  readonly language?: string;
}

/** Kinds that need the file's BYTES (the `readWorkspaceBytes` read); the
 *  rest ride the ADR 0050 text read. `csv` is text — its grid parses the
 *  decoded string. */
export function needsBytes(kind: ViewerKind): boolean {
  return (
    kind === "image" ||
    kind === "pdf" ||
    kind === "docx" ||
    kind === "xlsx" ||
    kind === "pptx"
  );
}

/** Extension → highlight.js language. Curated to the languages the
 *  highlighter registers (viewer/highlight.ts) — an id here that is not
 *  registered would fall back to plain text at render time, so the two
 *  lists are pinned to each other by a test. */
const CODE_LANGUAGES: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  py: "python",
  pyi: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  php: "php",
  lua: "lua",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  psm1: "powershell",
  sql: "sql",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  makefile: "makefile",
  mk: "makefile",
  graphql: "graphql",
  gql: "graphql",
  r: "r",
  dart: "dart",
  scala: "scala",
  pl: "perl",
  ex: "elixir",
  exs: "elixir",
};

/** Every language id the extension map can name. The highlighter's
 *  registration test asserts it registers exactly these. */
export const CODE_LANGUAGE_IDS: readonly string[] = [
  ...new Set(Object.values(CODE_LANGUAGES)),
].sort();

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  // SVG is a picture here, drawn through <img> (scripts inert), never
  // inlined as markup.
  "svg",
]);

/** Bare file names that are code without an extension. */
const CODE_BASENAMES: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

function tail(path: string): string {
  const parts = path.split(/[\\/]/);
  return (parts[parts.length - 1] ?? path).toLowerCase();
}

/** The kind for a path (or a display label — the attachment rows carry
 *  the real name apart from the stored path, and either spelling works). */
export function viewerKindFor(path: string): ViewerKindInfo {
  const name = tail(path);
  const basenameLang = CODE_BASENAMES[name];
  if (basenameLang !== undefined)
    return { kind: "code", language: basenameLang };
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return { kind: "text" };
  const ext = name.slice(dot + 1);
  if (ext === "md" || ext === "markdown") return { kind: "markdown" };
  if (ext === "pdf") return { kind: "pdf" };
  if (ext === "docx") return { kind: "docx" };
  if (ext === "xlsx" || ext === "xlsm") return { kind: "xlsx" };
  if (ext === "pptx") return { kind: "pptx" };
  if (ext === "csv" || ext === "tsv") return { kind: "csv" };
  // SVG is listed as code above (xml) for the source view, but as a FILE it
  // is a picture first; the image check runs before the code map.
  if (IMAGE_EXTENSIONS.has(ext)) return { kind: "image" };
  const lang = CODE_LANGUAGES[ext];
  if (lang !== undefined) return { kind: "code", language: lang };
  return { kind: "text" };
}
