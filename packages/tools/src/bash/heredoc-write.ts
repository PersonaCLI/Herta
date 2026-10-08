import { readFile, stat } from "node:fs/promises";
import { computeUnifiedDiff } from "../edit-file/engine.js";
import {
  countDiffLines,
  MAX_FILE_BYTES,
} from "../str-replace-editor/engine.js";
import {
  resolveWorkspacePath,
  type ShellClassifyOpts,
  tokenize,
} from "./shell-classifier.js";

/**
 * The minimal contract's file-write idiom, previewed like a file write.
 *
 * The 板砖 model on the `bash` contract writes files the way its training
 * taught it: `mkdir -p src && cat > src/server.mjs <<'EOF' … EOF`. To the
 * classifier that is a redirect (an ask, correctly) — but to the user the
 * approval card then showed the WHOLE file inline as "the command", cut off
 * at the bottom of the card, under the label 未识别的命令 (owner 2026-08-17).
 * The standard contract shows the same act as `新建文件 src/server.mjs` with
 * a collapsible diff, and the record gets a patch preview. This module gives
 * the heredoc idiom that reading: for each `<<WORD` heredoc whose body goes
 * to a workspace file through `> path` / `>> path` (or `tee [-a] path`), it
 * builds the diff the write would produce (create / overwrite / append), so
 * the rule can attach it to the ask and publish it to the record, and the
 * card can fold the body out of the command box.
 *
 * Fidelity, deliberately conservative: the body is shown as the shell would
 * write it only when that is KNOWABLE from the text — a quoted terminator
 * (`<<'EOF'` / `<<"EOF"` / `<<\EOF`) makes the body literal; an unquoted one
 * expands `$var`, `$(…)`, backticks and backslashes, so it is previewed only
 * when the body contains none of those. `<<-` strips leading tabs (as bash
 * does). Anything else (a heredoc fed to a program, a variable target, a
 * target outside the workspace, a binary or oversized existing file) yields
 * no preview — the card then shows the verbatim command as before.
 */
export interface HeredocWrite {
  /** Workspace-relative POSIX path of the target. */
  readonly relative: string;
  /** Native absolute path. */
  readonly native: string;
  /** `>` / `tee` overwrite (or create) vs `>>` / `tee -a` append. */
  readonly mode: "overwrite" | "append";
  /** The body as the shell will write it (with its trailing newline). */
  readonly body: string;
  /** Line span of the heredoc BODY inside the command (0-based, inclusive
   *  start, exclusive end) — the lines between the `<<WORD` line and the
   *  terminator line. For folding the command box. */
  readonly bodyLines: { readonly start: number; readonly end: number };
}

const HEREDOC_OPEN =
  /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/;

/** A segment with its heredoc operators (`<<'EOF'`) blanked, so the
 *  tokenizer reads its redirects and words alone. */
export function withoutHeredocOpeners(segment: string): string {
  return segment.replace(new RegExp(HEREDOC_OPEN.source, "g"), " ");
}

/** Every heredoc of the command is closed and lands as written — a quoted
 *  terminator, or a body with nothing for the shell to expand — so no
 *  body runs a command (`<<EOF` … `$(rm x)` … would). */
export function heredocBodiesInert(
  command: string,
  opts: ShellClassifyOpts,
): boolean {
  const scanned = scanHeredocs(command, opts);
  return scanned.complete !== false && scanned.every((h) => h.literal);
}

/** Text the shell would expand in an UNQUOTED heredoc body. */
const EXPANDS = /[$`\\]/;

/**
 * Find the heredoc file writes in a command. Pure — no fs. Returns them in
 * order; a heredoc that is not a knowable file write is skipped.
 */
export function findHeredocWrites(
  command: string,
  opts: ShellClassifyOpts,
): HeredocWrite[] {
  return scanHeredocs(command, opts).flatMap((h) =>
    h.target !== null && h.literal
      ? [
          {
            relative: h.target.relative,
            native: h.target.native,
            mode: h.target.mode,
            body: h.body,
            bodyLines: h.bodyLines,
          },
        ]
      : [],
  );
}

/** One heredoc of a command, as the scan read it. */
interface ScannedHeredoc {
  /** The file its segment writes, or null when that is not knowable. */
  readonly target: {
    readonly native: string;
    readonly relative: string;
    readonly mode: "overwrite" | "append";
  } | null;
  /** The body is what lands: a quoted terminator, or nothing to expand. */
  readonly literal: boolean;
  readonly body: string;
  readonly bodyLines: { readonly start: number; readonly end: number };
}

/** Every heredoc of a command, in order, up to an unterminated one (which
 *  `complete` says). Pure. */
function scanHeredocs(
  command: string,
  opts: ShellClassifyOpts,
): ScannedHeredoc[] & { complete?: false } {
  const lines = command.split("\n");
  const out: ScannedHeredoc[] & { complete?: false } = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const m = HEREDOC_OPEN.exec(line);
    if (m === null) continue;
    const stripTabs = m[1] === "-";
    const quoted =
      m[2] !== undefined || m[3] !== undefined || m[4] !== undefined;
    const terminator = (m[2] ?? m[3] ?? m[4] ?? m[5]) as string;
    // Collect the body up to the terminator line.
    let j = i + 1;
    const bodyLines: string[] = [];
    let closed = false;
    for (; j < lines.length; j += 1) {
      const raw = lines[j] as string;
      const probe = stripTabs ? raw.replace(/^\t+/, "") : raw;
      if (probe === terminator) {
        closed = true;
        break;
      }
      bodyLines.push(probe);
    }
    if (!closed) {
      // Unterminated: nothing after it is a command line.
      out.complete = false;
      break;
    }
    out.push({
      target: writeTargetOf(line, m.index, opts),
      literal: quoted || !EXPANDS.test(bodyLines.join("\n")),
      body: bodyLines.length === 0 ? "" : `${bodyLines.join("\n")}\n`,
      bodyLines: { start: i + 1, end: j },
    });
    i = j; // resume after the terminator
  }
  return out;
}

/**
 * Where the heredoc's line sends its stdout: the LAST segment of the line
 * (the heredoc feeds the command it is attached to; `a && cat > f <<EOF`
 * → the `cat > f` segment). A `> path` / `>> path` redirect on a bare
 * `cat`, or `tee [-a] path` as its program, names a file; anything else
 * (a heredoc consumed by `python3 -`, `bash`, `psql`, or one whose target
 * carries a variable) is not a knowable file write. The program counts
 * (2026-10-08): `python3 - > out.txt <<'PY'` sends the script's OUTPUT to
 * the file, and was previewed as writing the script there.
 */
function writeTargetOf(
  line: string,
  heredocAt: number,
  opts: ShellClassifyOpts,
): { native: string; relative: string; mode: "overwrite" | "append" } | null {
  // The segment containing the heredoc operator: split on && || ; | outside
  // quotes — the classifier's splitter would strip the heredoc word too, so a
  // small local scan is used here (segments are simple on a heredoc line).
  const seg = segmentAround(line, heredocAt);
  const cleaned = seg.replace(HEREDOC_OPEN, " ").trim();
  const { words, redirects } = tokenize(cleaned);
  const outs = redirects.filter((r) => r.kind === "out");
  const prog = words[0]?.split(/[\\/]/).pop();
  if (outs.length === 1) {
    // `cat` alone (or `cat -`): what it reads is the heredoc.
    if (prog !== "cat" || words.slice(1).some((w) => w !== "-")) return null;
    const r = outs[0] as { target: string };
    const rawOp = appendOperator(seg, r.target);
    const resolved = resolveWorkspacePath(r.target, opts);
    if (resolved === null) return null;
    return { ...resolved, mode: rawOp === ">>" ? "append" : "overwrite" };
  }
  if (outs.length > 1) return null;
  // tee [-a] path
  if (prog === "tee") {
    const args = words.slice(1);
    const append = args.some((a) => a === "-a" || a === "--append");
    const files = args.filter((a) => !a.startsWith("-"));
    if (files.length !== 1) return null;
    const resolved = resolveWorkspacePath(files[0] as string, opts);
    if (resolved === null) return null;
    return { ...resolved, mode: append ? "append" : "overwrite" };
  }
  return null;
}

/** The `>`/`>>` operator that precedes `target` in the raw segment text. */
function appendOperator(seg: string, target: string): ">" | ">>" {
  const idx = seg.indexOf(target);
  const before = idx === -1 ? "" : seg.slice(0, idx);
  return /\d?>>\s*$/.test(before) ? ">>" : ">";
}

/** The `&&`/`||`/`;`/`|`-delimited segment of `line` containing `at`,
 *  quote-aware (single and double). */
function segmentAround(line: string, at: number): string {
  let start = 0;
  let quote: "'" | '"' | null = null;
  const bounds: number[] = [];
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quote !== null) {
      if (ch === quote && line[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (
      (ch === "&" && line[i + 1] === "&") ||
      (ch === "|" && line[i + 1] === "|")
    ) {
      bounds.push(i, i + 2);
      i += 1;
      continue;
    }
    if (ch === ";" || (ch === "|" && line[i + 1] !== "|")) {
      bounds.push(i, i + 1);
    }
  }
  let end = line.length;
  for (let k = 0; k < bounds.length; k += 2) {
    const b0 = bounds[k] as number;
    const b1 = bounds[k + 1] as number;
    if (b1 <= at) start = b1;
    else if (b0 >= at) {
      end = b0;
      break;
    }
  }
  return line.slice(start, end);
}

export interface HeredocPreview {
  readonly files: string[];
  /** Concatenated unified diffs, one per write (empty when none apply). */
  readonly diff: string;
  /** Per-write summary for the ask reason. */
  readonly summary: string;
  /** Body line spans to fold in the command box. */
  readonly folds: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
  }>;
  readonly added: number;
  readonly removed: number;
}

/**
 * Build the diff preview for the heredoc writes of a command against the
 * files as they are on disk NOW. Async (reads the current contents); never
 * throws — an unreadable/binary/oversized target simply yields no preview
 * for that write. Returns null when nothing is previewable.
 */
export async function previewHeredocWrites(
  command: string,
  opts: ShellClassifyOpts,
): Promise<HeredocPreview | null> {
  const writes = findHeredocWrites(command, opts);
  if (writes.length === 0) return null;
  const files: string[] = [];
  const diffs: string[] = [];
  const parts: string[] = [];
  const folds: Array<{ start: number; end: number }> = [];
  let added = 0;
  let removed = 0;
  for (const w of writes) {
    let before = "";
    let exists = false;
    try {
      const info = await stat(w.native);
      if (info.isDirectory() || info.size > MAX_FILE_BYTES) continue;
      const buf = await readFile(w.native);
      if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) continue;
      before = buf.toString("utf-8");
      exists = true;
    } catch {
      // absent → create
    }
    const after = w.mode === "append" ? before + w.body : w.body;
    const diff = computeUnifiedDiff(before, after, w.relative);
    const plus = countDiffLines(diff, "+");
    const minus = countDiffLines(diff, "-");
    added += plus;
    removed += minus;
    files.push(w.relative);
    diffs.push(diff);
    folds.push(w.bodyLines);
    parts.push(
      !exists
        ? `creates ${w.relative} (${plus} lines)`
        : w.mode === "append"
          ? `appends to ${w.relative} (+${plus} lines)`
          : `overwrites ${w.relative} (+${plus}/-${minus} lines)`,
    );
  }
  if (files.length === 0) return null;
  return {
    files,
    diff: diffs.filter((d) => d.length > 0).join("\n"),
    summary: parts.join("; "),
    folds,
    added,
    removed,
  };
}
