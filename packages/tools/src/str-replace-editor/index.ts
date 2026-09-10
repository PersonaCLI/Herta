import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  errorMessage,
  type HertaTool,
  type ToolCallRequest,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
  writeFileAtomic,
} from "@herta/core";
import { PersistentShell, SHELL_BG_ID } from "../bash/persistent-shell.js";
import { type ShellPaths, shellPathsFor } from "../bash/shell-paths.js";
import { computeUnifiedDiff } from "../edit-file/engine.js";
import { formatInputIssues } from "../input-issues.js";
import { decodeUtf8, reattachBom } from "../text-sniff.js";
import {
  countDiffLines,
  formatFileView,
  listDirectory,
  MAX_FILE_BYTES,
  planEdit,
  resolveEditorPath,
} from "./engine.js";
import {
  STR_REPLACE_EDITOR_DESCRIPTION,
  strReplaceEditorInputSchema,
  strReplaceEditorJsonSchema,
} from "./schema.js";

export {
  makeStrReplaceEditorRule,
  registerStrReplaceEditorRule,
} from "./rule.js";
export type { StrReplaceEditorInput } from "./schema.js";

/** Result data (harness-facing). Writes carry relPath + diff so the runtime
 *  harvests changedFiles like edit_file / write_new_file; `wrote` is what
 *  the completion heuristic keys on (a view proves nothing). */
export interface StrReplaceEditorData {
  command: "view" | "create" | "str_replace" | "insert";
  /** Workspace-relative POSIX path (writes only — a view has `path`). */
  relPath?: string;
  path?: string;
  diff?: string;
  wrote?: boolean;
  created?: boolean;
  /** view: the range shown (1-based, inclusive). */
  from?: number;
  to?: number;
}

export interface StrReplaceEditorToolOpts {
  /** The bash binary (for path spelling); null → native paths only. */
  bashPath: string | null;
  /** How the shell spells the workspace (schema example paths). A getter:
   *  a session's workspace can change between dispatches. */
  workspaceShellPath: () => string;
}

/** A path as the record header shows it: workspace-relative (POSIX
 *  separators) when the text is an absolute path — in ANY spelling the
 *  shell produces — inside the workspace; otherwise exactly as written. */
export function headerPath(
  path: string,
  workspaceRoot: string,
  paths: ShellPaths,
): string {
  const native = paths.toNative(path);
  if (native === null) return path;
  const rel = relative(resolve(workspaceRoot), native);
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return path;
  }
  return rel.split(sep).join("/");
}

function fail(
  code: string,
  message: string,
  summary?: string,
): ToolResult<StrReplaceEditorData> {
  return {
    ok: false,
    error: { code, message, retryable: false },
    summary: summary ?? `failed: ${code}`,
    modelText: message,
  };
}

/**
 * `str_replace_editor` — the minimal contract's editor (ADR 0040).
 *
 * `view` reads (and records the file in the read ledger); `create` /
 * `str_replace` / `insert` write atomically (temp + rename) after the
 * permission rule computed the same edit for the preview + ask — the tool
 * recomputes against the file as it is NOW, so a change between the ask
 * and the apply surfaces as the trained "did not appear verbatim" instead
 * of a stale write. Model-facing text is the trained shape's; the harness
 * gets structured data for the record and the report.
 */
export function strReplaceEditorTool(
  opts: StrReplaceEditorToolOpts,
): HertaTool {
  const paths: ShellPaths = shellPathsFor(opts.bashPath);
  return {
    name: "str_replace_editor",
    schema(): ToolSchema {
      return {
        name: "str_replace_editor",
        description: STR_REPLACE_EDITOR_DESCRIPTION,
        inputSchema: strReplaceEditorJsonSchema(opts.workspaceShellPath()),
      };
    },
    summarize(input: unknown, ctx: { workspaceRoot: string }) {
      // The record header: `<command> <path>` (the bridge reads Reading /
      // Writing from the leading word — the shape is load-bearing), with a
      // workspace path shown RELATIVE the way edit_file's rows do. The model
      // copies absolute shell-spelled paths from `pwd` (`/tmp/…/ws/NOTES.md`
      // under MSYS), and the loop's generic form cannot map that spelling
      // back — live GUI 2026-08-17: "写入 /tmp/claude/E--HERTA/…/scratchpa…"
      // with the file name cut off. A path OUTSIDE the workspace stays as
      // written: that is exactly what a reader must see.
      const obj =
        typeof input === "object" && input !== null
          ? (input as {
              command?: unknown;
              path?: unknown;
              view_range?: unknown;
            })
          : null;
      if (
        obj === null ||
        typeof obj.command !== "string" ||
        typeof obj.path !== "string" ||
        obj.path.length === 0
      ) {
        return undefined;
      }
      const display = headerPath(obj.path, ctx.workspaceRoot, paths);
      const range = Array.isArray(obj.view_range)
        ? obj.view_range.filter((n): n is number => typeof n === "number")
        : [];
      return obj.command === "view" && range.length === 2
        ? `${obj.command} ${display}:${range[0]}-${range[1]}`
        : `${obj.command} ${display}`;
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<StrReplaceEditorData>> {
      const parsed = strReplaceEditorInputSchema.safeParse(call.input);
      if (!parsed.success) {
        const message = formatInputIssues(parsed.error);
        return fail(
          "invalid_input",
          `Invalid parameters for str_replace_editor: ${message}. The allowed commands are: view, create, str_replace, insert.`,
        );
      }
      const input = parsed.data;
      const shell = ctx.bg.getInternal(SHELL_BG_ID);
      const wsShell =
        shell instanceof PersistentShell
          ? shell.workspaceShellPath
          : paths.toShell(ctx.workspaceRoot);
      const target = await resolveEditorPath(
        input.path,
        ctx,
        paths,
        wsShell,
        input.command === "view",
      );
      if (!target.ok) return fail(target.code, target.message);

      // ── view ──
      if (input.command === "view") {
        let info: Awaited<ReturnType<typeof stat>>;
        try {
          info = await stat(target.resolved);
        } catch {
          return fail(
            "not_found",
            `The path ${target.display} does not exist. Please provide a valid path.`,
          );
        }
        if (info.isDirectory()) {
          if (input.view_range !== undefined) {
            return fail(
              "invalid_input",
              "The `view_range` parameter is not allowed when `path` points to a directory.",
            );
          }
          const listing = await listDirectory(target.resolved, target.display);
          return {
            ok: true,
            data: {
              command: "view",
              path: target.relative === "" ? "." : target.relative,
            },
            summary: `listed ${target.relative === "" ? "." : target.relative}`,
            modelText: listing,
          };
        }
        if (!info.isFile()) {
          return fail(
            "invalid_input",
            `cannot view "${target.display}": not a regular file or directory`,
          );
        }
        if (info.size > MAX_FILE_BYTES) {
          return fail(
            "file_too_large",
            `The file ${target.display} is too large to view (${info.size} bytes); use \`sed -n\` / \`grep -n\` through bash for a slice.`,
          );
        }
        const buf = await readFile(target.resolved);
        if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) {
          return fail(
            "binary_file",
            `The file ${target.display} is binary; this tool views text files only.`,
          );
        }
        ctx.reads.record(
          target.resolved,
          createHash("sha256").update(buf).digest("hex"),
        );
        const viewDecoded = decodeUtf8(buf);
        const view = formatFileView(
          target.display,
          viewDecoded.text,
          input.view_range,
        );
        if (!view.ok) return fail("invalid_input", view.message);
        // Viewing a non-UTF-8 file is allowed; pretending the U+FFFD runs are
        // what the file says is not. The edit commands refuse it outright.
        const viewLossyNote = viewDecoded.lossy
          ? " — WARNING: not valid UTF-8; unreadable bytes shown as U+FFFD and this file cannot be edited"
          : "";
        return {
          ok: true,
          data: {
            command: "view",
            path: target.relative,
            from: view.from,
            to: view.to,
          },
          summary: `viewed ${target.relative} (${view.from}-${view.to})${viewLossyNote}`,
          modelText: view.text,
        };
      }

      // ── create ──
      if (input.command === "create") {
        if (typeof input.file_text !== "string") {
          return fail(
            "invalid_input",
            "Parameter `file_text` is required for command: create",
          );
        }
        try {
          await stat(target.resolved);
          return fail(
            "create_exists",
            `File already exists at: ${target.display}. Cannot overwrite files using command \`create\`.`,
          );
        } catch {
          // absent — good
        }
        await mkdir(dirname(target.resolved), { recursive: true });
        const written = await atomicWrite(target.resolved, input.file_text);
        if (!written.ok) return fail("write_failed", written.message);
        ctx.reads.record(
          target.resolved,
          createHash("sha256").update(input.file_text).digest("hex"),
        );
        const diff = computeUnifiedDiff("", input.file_text, target.relative);
        return {
          ok: true,
          data: {
            command: "create",
            relPath: target.relative,
            diff,
            wrote: true,
            created: true,
          },
          summary: `created ${target.relative} (${countDiffLines(diff, "+")} lines)`,
          modelText: `New file created successfully at: ${target.display}`,
        };
      }

      // ── str_replace / insert ──
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(target.resolved);
      } catch {
        return fail(
          "not_found",
          `The path ${target.display} does not exist. Please provide a valid path.`,
        );
      }
      if (info.isDirectory()) {
        return fail(
          "invalid_input",
          `The path ${target.display} is a directory and only the \`view\` command can be used on directories`,
        );
      }
      if (info.size > MAX_FILE_BYTES) {
        return fail(
          "file_too_large",
          `The file ${target.display} is too large to edit (${info.size} bytes > ${MAX_FILE_BYTES}).`,
        );
      }
      const buf = await readFile(target.resolved);
      if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) {
        return fail(
          "binary_file",
          `The file ${target.display} is binary and cannot be edited with this tool.`,
        );
      }
      // A NUL sniff does not prove the bytes are UTF-8, and every command here
      // rewrites the whole file from the decoded string — so editing a
      // GBK/Big5/Shift-JIS source would replace its unreadable bytes with
      // U+FFFD everywhere, not just where the edit landed (2026-08-24).
      const decoded = decodeUtf8(buf);
      if (decoded.lossy) {
        return fail(
          "non_utf8_file",
          `The file ${target.display} is not valid UTF-8. Editing it would rewrite the entire file and replace every byte outside UTF-8 with U+FFFD, including parts this edit does not touch. Convert it to UTF-8 first, or make this change by hand.`,
        );
      }
      if (input.command === "insert") {
        // Line numbers are only meaningful relative to a view (see rule).
        const sha = createHash("sha256").update(buf).digest("hex");
        const entry = ctx.reads.get(target.resolved);
        if (!entry) {
          return fail(
            "view_required",
            `Please \`view\` ${target.display} before using \`insert\` — insert_line refers to the line numbers of a view.`,
          );
        }
        if (entry.sha256 !== sha) {
          return fail(
            "stale_view",
            `${target.display} changed since you last viewed it; view it again and recompute insert_line.`,
          );
        }
      }
      const before = decoded.text;
      const plan = planEdit(input, before, target.display, target.relative);
      if (!plan.ok) return fail(plan.code, plan.message);
      // Put back the BOM the decoder consumed — every command here rewrites
      // the whole file, so without this a one-line replace also deleted three
      // bytes the edit never addressed. The ledger must hash what was actually
      // WRITTEN, or the next freshness check fails against our own write.
      const out = reattachBom(plan.after, decoded.bom);
      const written = await atomicWrite(target.resolved, out);
      if (!written.ok) return fail("write_failed", written.message);
      ctx.reads.record(
        target.resolved,
        createHash("sha256").update(out).digest("hex"),
      );
      return {
        ok: true,
        data: {
          command: input.command,
          relPath: target.relative,
          diff: plan.diff,
          wrote: true,
          created: false,
        },
        summary: `edited ${target.relative} (${input.command}, +${countDiffLines(plan.diff, "+")}/-${countDiffLines(plan.diff, "-")} lines)`,
        modelText: `The file ${target.display} has been edited successfully.`,
      };
    },
  };
}

/** Core's atomic replace, answered as this tool's result shape. */
async function atomicWrite(
  resolved: string,
  content: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await writeFileAtomic(resolved, content);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, message: errorMessage(err) };
  }
}
