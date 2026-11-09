import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { countDiffLinesFor, type ToolContext } from "@herta/core";
import type { ShellPaths } from "../bash/shell-paths.js";
import {
  computeUnifiedDiff,
  isCrlfOnly,
  withCrlf,
} from "../edit-file/engine.js";
import { resolveSafePath, type SafePathResult } from "../path-safety.js";
import type { StrReplaceEditorInput } from "./schema.js";

/**
 * Pure pieces of `str_replace_editor` (ADR 0040), shared by the permission
 * rule (which computes the diff for the patch preview + ask) and the tool
 * (which applies it) — the same shape as edit_file's engine/rule/tool split.
 * The messages are the trained shape's own strings: the model has seen
 * exactly these and knows what to do next.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_OUTPUT_CHARS = 16_000;
export const CLIP_NOTE =
  "<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";

export interface EditorPathOk {
  ok: true;
  /** Native absolute path (realpath'd, inside the workspace). */
  resolved: string;
  /** Workspace-relative POSIX form (record / report). */
  relative: string;
  /** How the model spelled it (echoed in messages). */
  display: string;
}
export interface EditorPathErr {
  ok: false;
  code: string;
  /** Model-facing message (trained-shape wording where one exists). */
  message: string;
}
export type EditorPath = EditorPathOk | EditorPathErr;

/** Resolve the model's `path` (shell spelling or native) to a safe native
 *  path. `forRead` unlocks the read carve-outs read_file/show_excerpt have
 *  (attachments, harness evidence); writes never get them. */
export async function resolveEditorPath(
  input: string,
  ctx: ToolContext,
  paths: ShellPaths,
  workspaceShellPath: string,
  forRead: boolean,
): Promise<EditorPath> {
  const display = String(input).trim();
  if (display.length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      message: "Parameter `path` is required and must be a non-empty string.",
    };
  }
  const native = paths.toNative(display);
  if (native === null) {
    // Relative (or an MSYS-internal root like /usr): the trained message,
    // with a hint that is actually correct for this workspace.
    return {
      ok: false,
      code: "path_not_absolute",
      message: `The path ${display} is not an absolute path, it should start with \`/\`. Maybe you meant ${workspaceShellPath}/${display.replace(/^\.\//, "")}?`,
    };
  }
  const safe: SafePathResult = await resolveSafePath(
    ctx.workspaceRoot,
    native,
    forRead
      ? {
          allowAttachmentPaths: true,
          allowHarnessReadPaths: true,
          allowEvidenceExcerptPaths: true,
        }
      : { mutation: true },
  );
  if (!safe.ok) {
    return {
      ok: false,
      code: safe.code,
      message:
        safe.code === "path_outside_workspace"
          ? `The path ${display} is outside the workspace ${workspaceShellPath}; only paths under it can be viewed or edited.`
          : `The path ${display} cannot be accessed: ${safe.message}`,
    };
  }
  return {
    ok: true,
    resolved: safe.resolved,
    relative: safe.relative,
    display,
  };
}

export function clip(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS
    ? text
    : text.slice(0, MAX_OUTPUT_CHARS) + CLIP_NOTE;
}

/** `cat -n` view, optionally ranged. Errors are the trained strings. */
export function formatFileView(
  display: string,
  content: string,
  viewRange: number[] | undefined,
):
  | { ok: true; text: string; from: number; to: number }
  | { ok: false; message: string } {
  const all = content.split("\n");
  let lines = all;
  let start = 1;
  let prompt = `Here's the content of ${display} with line numbers (which has a total of ${all.length} lines)`;
  let to = all.length;
  if (viewRange !== undefined) {
    if (viewRange.length !== 2 || !viewRange.every(Number.isInteger)) {
      return {
        ok: false,
        message: "Invalid `view_range`. It should be a list of two integers.",
      };
    }
    const [s, e] = viewRange as [number, number];
    if (s < 1 || s > all.length) {
      return {
        ok: false,
        message: `Invalid \`view_range\`: [${s}, ${e}]. Its first element \`${s}\` should be within the range of lines of the file: [1, ${all.length}]`,
      };
    }
    if (e > all.length) {
      return {
        ok: false,
        message: `Invalid \`view_range\`: [${s}, ${e}]. Its second element \`${e}\` should be smaller than the number of lines in the file: \`${all.length}\``,
      };
    }
    if (e !== -1 && e < s) {
      return {
        ok: false,
        message: `Invalid \`view_range\`: [${s}, ${e}]. Its second element \`${e}\` should be larger or equal than its first \`${s}\``,
      };
    }
    start = s;
    lines = e === -1 ? all.slice(s - 1) : all.slice(s - 1, e);
    to = e === -1 ? all.length : e;
    prompt += ` with view_range=[${s}, ${e}]`;
  }
  const numbered = lines
    .map((l, i) => `${String(start + i).padStart(6, " ")}\t${l}`)
    .join("\n");
  return { ok: true, text: clip(`${prompt}:\n${numbered}\n`), from: start, to };
}

/** Two-level directory listing (hidden, node_modules, __pycache__ skipped). */
export async function listDirectory(
  resolvedDir: string,
  display: string,
): Promise<string> {
  const rows: string[] = [`d\t${display}`];
  // Characters gathered so far. Past the clip budget nothing more can be
  // SHOWN, so nothing more is walked: a flat directory of ten thousand files
  // used to be stat'ed one by one, serially, to produce rows `clip` then
  // threw away (perf audit 2026-09-20).
  let chars = rows[0]?.length ?? 0;
  const visit = async (
    dir: string,
    disp: string,
    depth: number,
  ): Promise<void> => {
    let entries: Dirent[];
    try {
      // The entry already knows its type — one readdir instead of a stat per
      // name. Same order as before: by name, code-unit ascending.
      entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      if (chars > MAX_OUTPUT_CHARS) return;
      const name = entry.name;
      if (
        name.startsWith(".") ||
        name === "node_modules" ||
        name === "__pycache__"
      )
        continue;
      const p = join(dir, name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        // A link is what it POINTS at, as `stat` always answered; a broken
        // one is skipped, as it always was.
        try {
          isDir = (await stat(p)).isDirectory();
        } catch {
          continue;
        }
      }
      const d = `${disp.replace(/\/$/, "")}/${name}`;
      const row = `${isDir ? "d" : "f"}\t${d}`;
      rows.push(row);
      chars += row.length + 1;
      if (isDir && depth < 2) await visit(p, d, depth + 1);
    }
  };
  await visit(resolvedDir, display, 1);
  return `Here're the files and directories up to 2 levels deep in ${display}, excluding hidden items, node_modules, and Python cache directories:\n${clip(`${rows.join("\n")}\n`)}\n`;
}

export type PlannedEdit =
  | { ok: true; after: string; diff: string }
  | { ok: false; code: string; message: string };

/** Compute the post-edit content for str_replace / insert against `before`
 *  — the trained error strings on failure. `relPath` labels the diff.
 *
 *  In a file whose every line ends `\r\n`, the line breaks the model wrote
 *  are read as the file's (review 2026-11-10; `inFileTerms` in edit_file's
 *  engine says why). The messages still quote `old_str` as it was written. */
export function planEdit(
  input: StrReplaceEditorInput,
  before: string,
  display: string,
  relPath: string,
): PlannedEdit {
  const crlf = isCrlfOnly(before);
  if (input.command === "str_replace") {
    const oldStr = input.old_str;
    if (typeof oldStr !== "string" || oldStr.length === 0) {
      return {
        ok: false,
        code: "invalid_input",
        message: "Parameter `old_str` is required for command: str_replace",
      };
    }
    const sought = crlf ? withCrlf(oldStr) : oldStr;
    const newStr = crlf ? withCrlf(input.new_str ?? "") : (input.new_str ?? "");
    const offsets: number[] = [];
    let off = 0;
    while (true) {
      const i = before.indexOf(sought, off);
      if (i === -1) break;
      offsets.push(i);
      off = i + sought.length;
    }
    if (offsets.length === 0) {
      return {
        ok: false,
        code: "edit_not_found",
        message: `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${display}.`,
      };
    }
    if (offsets.length > 1) {
      const lineOf = (o: number): number =>
        before.slice(0, o).split("\n").length;
      return {
        ok: false,
        code: "edit_ambiguous",
        message: `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines [${offsets.map(lineOf).join(", ")}]. Please ensure it is unique`,
      };
    }
    const at = offsets[0] as number;
    const after =
      before.slice(0, at) + newStr + before.slice(at + sought.length);
    return {
      ok: true,
      after,
      diff: computeUnifiedDiff(before, after, relPath),
    };
  }
  // insert
  const line = input.insert_line;
  if (!Number.isInteger(line)) {
    return {
      ok: false,
      code: "invalid_input",
      message: "Parameter `insert_line` is required for command: insert",
    };
  }
  if (typeof input.new_str !== "string") {
    return {
      ok: false,
      code: "invalid_input",
      message: "Parameter `new_str` is required for command: insert",
    };
  }
  // Line by line with `\n` between, whatever the file's own ending: the
  // inserted lines then take it with every other line, on the way out.
  const lines = (crlf ? before.replace(/\r\n/g, "\n") : before).split("\n");
  const added = crlf ? input.new_str.replace(/\r\n/g, "\n") : input.new_str;
  const n = line as number;
  if (n < 0 || n > lines.length) {
    return {
      ok: false,
      code: "insert_out_of_range",
      message: `Invalid \`insert_line\` parameter: ${n}. It should be within the range of lines of the file: [0, ${lines.length}]`,
    };
  }
  const joined = [
    ...lines.slice(0, n),
    ...added.split("\n"),
    ...lines.slice(n),
  ].join("\n");
  const after = crlf ? withCrlf(joined) : joined;
  return { ok: true, after, diff: computeUnifiedDiff(before, after, relPath) };
}

export function countDiffLines(diff: string, prefix: "+" | "-"): number {
  return countDiffLinesFor(diff, prefix);
}
