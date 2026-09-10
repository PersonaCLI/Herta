import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
  countDiffLinesFor,
  errorMessage,
  type HertaTool,
  type ToolCallRequest,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
  writeFileAtomic,
} from "@herta/core";
import { errResult } from "../errors.js";
import { formatInputIssues } from "../input-issues.js";
import { resolveSafePath } from "../path-safety.js";
import { decodeUtf8, reattachBom } from "../text-sniff.js";
import {
  applyHunks,
  computeUnifiedDiff,
  parsePatch,
  validateHunks,
} from "./engine.js";
import { editFileInputSchema, editFileJsonSchema } from "./schema.js";

export type { EditFileRuleDeps } from "./rule.js";
export { makeEditFileRule, registerEditFileRule } from "./rule.js";
export type { EditFileInput } from "./schema.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SNIFF_BYTES = 4096;

export interface EditFileData {
  relPath: string;
  hunkCount: number;
  bytesWritten: number;
  oldSha256: string;
  newSha256: string;
  diff: string;
}

export function editFileTool(): HertaTool {
  return {
    name: "edit_file",
    schema(): ToolSchema {
      return {
        name: "edit_file",
        description:
          "Apply anchor-based search/replace hunks to an existing UTF-8 text file. Each hunk's `search` must match exactly once. Requires a prior read_file on the same path; the file's bytes must be byte-identical to that read.",
        inputSchema: editFileJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<EditFileData>> {
      const parsed = editFileInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return errResult(
          "invalid_input",
          formatInputIssues(parsed.error),
          "usage: {path, hunks: [{search, replace}, …]}",
          "invalid input",
        );
      }
      const { path, hunks } = parsed.data;

      const safe = await resolveSafePath(ctx.workspaceRoot, path, {
        mutation: true,
      });
      if (!safe.ok) {
        return errResult(
          safe.code,
          safe.message,
          undefined,
          `denied: ${safe.message}`,
        );
      }

      let info: Stats;
      try {
        info = await stat(safe.resolved);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === "ENOENT") {
          return errResult(
            "not_found",
            `not found: ${safe.relative}`,
            "use write_new_file for new files",
            `not found: ${safe.relative}`,
          );
        }
        return errResult(
          "read_failed",
          (err as Error).message ?? "stat failed",
          undefined,
          "stat failed",
        );
      }
      if (!info.isFile()) {
        return errResult(
          "invalid_input",
          `not a file: ${safe.relative}`,
          undefined,
          `not a file: ${safe.relative}`,
        );
      }
      if (info.size > MAX_FILE_BYTES) {
        return errResult(
          "file_too_large",
          `${info.size} bytes > cap ${MAX_FILE_BYTES}`,
          "split file or refactor first",
          `too large: ${safe.relative}`,
        );
      }

      let buf: Buffer;
      try {
        buf = await readFile(safe.resolved);
      } catch (err: unknown) {
        return errResult(
          "read_failed",
          (err as Error).message ?? "read failed",
          undefined,
          "read failed",
        );
      }
      const sniff = buf.subarray(0, Math.min(SNIFF_BYTES, buf.length));
      if (sniff.includes(0)) {
        return errResult(
          "binary_file",
          "NUL byte detected in first 4KB",
          "edit_file is utf-8 only",
          `binary: ${safe.relative}`,
        );
      }
      // The NUL sniff above passes a GBK / Big5 / Shift-JIS source file, and
      // this tool rewrites the WHOLE file from the decoded string — so an edit
      // to one ASCII line would re-encode every unreadable byte as U+FFFD,
      // destroying regions the patch never touched. Refuse instead: the bytes
      // we cannot read faithfully are the bytes we must not write.
      const decoded = decodeUtf8(buf);
      if (decoded.lossy) {
        return errResult(
          "non_utf8_file",
          `${safe.relative} is not valid UTF-8; editing it would rewrite the whole file and replace every byte outside UTF-8 with U+FFFD`,
          "convert the file to UTF-8 first, or make this change by hand",
          `not utf-8: ${safe.relative}`,
        );
      }

      const oldSha256 = createHash("sha256").update(buf).digest("hex");
      const entry = ctx.reads.get(safe.resolved);
      if (!entry) {
        return errResult(
          "read_required",
          `call read_file on ${safe.relative} before patching`,
          "call read_file on the path before patching",
          `read required: ${safe.relative}`,
        );
      }
      if (entry.sha256 !== oldSha256) {
        return errResult(
          "stale_read",
          `${safe.relative} changed since last read; re-read and rebuild hunks`,
          "re-read the file and rebuild your hunks",
          `stale: ${safe.relative}`,
        );
      }

      const parsedHunks = parsePatch(hunks);
      if (!parsedHunks.ok) {
        return errResult(
          parsedHunks.code,
          parsedHunks.message,
          "each hunk needs non-empty search and replace",
          parsedHunks.message,
        );
      }
      const before = decoded.text;
      const validated = validateHunks(before, parsedHunks.hunks);
      if (!validated.ok) {
        return errResult(
          validated.code,
          validated.message,
          suggestionFor(validated.code),
          validated.message,
        );
      }

      const after = applyHunks(before, parsedHunks.hunks);
      // Put back the BOM the decoder consumed. Without this an edit to one
      // ASCII line silently deleted three bytes the patch never addressed.
      const afterBuf = Buffer.from(reattachBom(after, decoded.bom), "utf-8");
      const diff = computeUnifiedDiff(before, after, safe.relative);

      // Atomic replace (core's helper: unique temp beside the target, rename
      // over it, the temp removed on failure). A busy file is retryable.
      try {
        await writeFileAtomic(safe.resolved, afterBuf);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        return errResult(
          "write_failed",
          errorMessage(err),
          undefined,
          "write failed",
          code === "EBUSY" || code === "EAGAIN",
        );
      }

      const newBuf = await readFile(safe.resolved);
      const newSha256 = createHash("sha256").update(newBuf).digest("hex");
      ctx.reads.record(safe.resolved, newSha256);

      const data: EditFileData = {
        relPath: safe.relative,
        hunkCount: parsedHunks.hunks.length,
        bytesWritten: afterBuf.byteLength,
        oldSha256,
        newSha256,
        diff,
      };
      const addCount = countLines(diff, "+");
      const delCount = countLines(diff, "-");
      return {
        ok: true,
        data,
        summary: `patched ${safe.relative} (${data.hunkCount} hunks, +${addCount}/-${delCount} lines)`,
      };
    },
  };
}

function suggestionFor(code: string): string {
  if (code === "hunk_not_found")
    return "the search text isn't in the current file — re-read and adjust";
  if (code === "hunk_ambiguous")
    return "include more surrounding context to make the match unique";
  if (code === "hunk_overlap")
    return "split into separate calls or revise hunks";
  return "fix tool input";
}

function countLines(diff: string, prefix: "+" | "-"): number {
  return countDiffLinesFor(diff, prefix);
}
