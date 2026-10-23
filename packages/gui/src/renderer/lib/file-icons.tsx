/**
 * A file's type at a glance (ADR 0072 amendment 2026-10-20): the composer's
 * @ list and its chips, and a sent message's chips, draw the same small
 * glyph per kind of file. Inline SVG in currentColor; the colour per kind is
 * the stylesheet's (`.file-icon--<kind>`), so both themes read it.
 */

export type FileKind =
  | "folder"
  | "ts"
  | "js"
  | "md"
  | "json"
  | "config"
  | "git"
  | "image"
  | "pdf"
  | "web"
  | "py"
  | "lock"
  | "text";

const BY_EXT: Readonly<Record<string, FileKind>> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  md: "md",
  mdx: "md",
  markdown: "md",
  json: "json",
  jsonl: "json",
  jsonc: "json",
  yaml: "config",
  yml: "config",
  toml: "config",
  ini: "config",
  cfg: "config",
  conf: "config",
  env: "config",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  ico: "image",
  pdf: "pdf",
  html: "web",
  htm: "web",
  css: "web",
  scss: "web",
  vue: "web",
  py: "py",
  lock: "lock",
};

/** The kind of a workspace path. */
export function fileKind(path: string, dir = false): FileKind {
  if (dir) return "folder";
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name.startsWith(".git")) return "git";
  if (name.endsWith("-lock.yaml") || name.endsWith(".lock")) return "lock";
  if (name.startsWith(".") && !name.slice(1).includes(".")) return "config";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return BY_EXT[ext] ?? "text";
}

const PAGE = "M4 1.75h5.25L12.5 5v9.25H4z";
const FOLD = "M9.25 1.75V5h3.25";

/** The glyph for one kind, 16×16. */
function glyph(kind: FileKind): JSX.Element {
  switch (kind) {
    case "folder":
      return <path d="M1.75 4.25h4.5l1.5 1.5h6.5v7.5H1.75z" />;
    case "ts":
    case "js":
    case "py":
      return (
        <>
          <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
          <text
            x="8"
            y="10.6"
            textAnchor="middle"
            fontSize="6.2"
            fontWeight="700"
            stroke="none"
            fill="currentColor"
            fontFamily="ui-sans-serif, system-ui, sans-serif"
          >
            {kind === "ts" ? "TS" : kind === "js" ? "JS" : "PY"}
          </text>
        </>
      );
    case "md":
      return (
        <>
          <path d={PAGE} />
          <path d={FOLD} />
          <path d="M6 8.25h4.5M6 10.75h3" />
        </>
      );
    case "json":
      return (
        <path d="M6 2.75c-1.5 0-2 .6-2 1.8v1.6c0 .9-.4 1.4-1.25 1.85.85.45 1.25.95 1.25 1.85v1.6c0 1.2.5 1.8 2 1.8M10 2.75c1.5 0 2 .6 2 1.8v1.6c0 .9.4 1.4 1.25 1.85-.85.45-1.25.95-1.25 1.85v1.6c0 1.2-.5 1.8-2 1.8" />
      );
    case "config":
      return (
        <>
          <path d="M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h10.5" />
          <circle cx="5.5" cy="4.5" r="1.1" />
          <circle cx="10.5" cy="8" r="1.1" />
          <circle cx="7" cy="11.5" r="1.1" />
        </>
      );
    case "git":
      return (
        <>
          <path d="M8 1.75 14.25 8 8 14.25 1.75 8z" />
          <path d="M6.2 5.4 8.2 7.4M8.2 7.4v3.3M8.2 7.4l1.9 1.1" />
        </>
      );
    case "image":
      return (
        <>
          <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
          <circle cx="5.6" cy="6.1" r="1.15" />
          <path d="m2.5 12 3.7-3.4 2.4 2.1 2-1.7 3 2.6" />
        </>
      );
    case "pdf":
      return (
        <>
          <path d={PAGE} />
          <path d={FOLD} />
          <path d="M5.75 11.75c1.6-1.1 2.6-3.4 2.6-4.9 0-1-.9-1-.9 0 0 1.6 2.3 3.9 4.3 4.4" />
        </>
      );
    case "web":
      return (
        <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9.1 3.5 6.9 12.5" />
      );
    case "lock":
      return (
        <>
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d="M5.25 7V5.25a2.75 2.75 0 0 1 5.5 0V7" />
        </>
      );
    default:
      return (
        <>
          <path d={PAGE} />
          <path d={FOLD} />
        </>
      );
  }
}

export function FileTypeIcon(props: {
  readonly path: string;
  readonly dir?: boolean;
  readonly className?: string;
}): JSX.Element {
  const kind = fileKind(props.path, props.dir === true);
  return (
    <svg
      className={`file-icon file-icon--${kind}${props.className !== undefined ? ` ${props.className}` : ""}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyph(kind)}
    </svg>
  );
}

/** A picked page element's mark (ADR 0083 §4, the owner's pick A): a
 *  crosshair, in the chip's own ink. */
export function PickIcon(props: { readonly className?: string }): JSX.Element {
  return (
    <svg
      className={`pick-icon${props.className !== undefined ? ` ${props.className}` : ""}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="4.2" />
      <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" />
    </svg>
  );
}
