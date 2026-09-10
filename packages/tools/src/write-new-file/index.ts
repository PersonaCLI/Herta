import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
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
import { writeNewFileInputSchema, writeNewFileJsonSchema } from "./schema.js";

export type { WriteNewFileRuleDeps } from "./rule.js";
export { makeWriteNewFileRule, registerWriteNewFileRule } from "./rule.js";
export type { WriteNewFileInput } from "./schema.js";

const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

export interface WriteNewFileData {
  relPath: string;
  bytesWritten: number;
  sha256: string;
}

export function writeNewFileTool(): HertaTool {
  return {
    name: "write_new_file",
    schema(): ToolSchema {
      return {
        name: "write_new_file",
        description:
          "Create a new UTF-8 text file with the given content. Refuses to overwrite existing files (use edit_file for that). Auto-creates missing parent directories within the workspace.",
        inputSchema: writeNewFileJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<WriteNewFileData>> {
      const parsed = writeNewFileInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return errResult(
          "invalid_input",
          formatInputIssues(parsed.error),
          "usage: {path, content}",
          "invalid input",
        );
      }
      const { path, content } = parsed.data;

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

      const byteLength = Buffer.byteLength(content, "utf-8");
      if (byteLength > MAX_CONTENT_BYTES) {
        return errResult(
          "file_too_large",
          `${byteLength} bytes > cap ${MAX_CONTENT_BYTES}`,
          "split into smaller files",
          `too large: ${safe.relative}`,
        );
      }

      let info: Stats | null = null;
      try {
        info = await stat(safe.resolved);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code !== "ENOENT") {
          return errResult(
            "read_failed",
            (err as Error).message ?? "stat failed",
            undefined,
            "stat failed",
          );
        }
      }
      if (info !== null) {
        return errResult(
          "file_exists",
          `${safe.relative} already exists${info.isDirectory() ? " (directory)" : ""}`,
          "use edit_file to modify existing files",
          `exists: ${safe.relative}`,
        );
      }

      const parentDir = dirname(safe.resolved);
      try {
        await mkdir(parentDir, { recursive: true });
      } catch (err: unknown) {
        return errResult(
          "write_failed",
          (err as Error).message ?? "mkdir failed",
          undefined,
          "mkdir failed",
        );
      }

      const contentBuf = Buffer.from(content, "utf-8");
      // Atomic replace (core's helper: unique temp beside the target, rename
      // over it, the temp removed on failure). A busy file is retryable.
      try {
        await writeFileAtomic(safe.resolved, contentBuf);
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
      const sha256 = createHash("sha256").update(newBuf).digest("hex");
      ctx.reads.record(safe.resolved, sha256);

      const data: WriteNewFileData = {
        relPath: safe.relative,
        bytesWritten: contentBuf.byteLength,
        sha256,
      };
      return {
        ok: true,
        data,
        summary: `wrote ${safe.relative} (${contentBuf.byteLength} bytes)`,
      };
    },
  };
}
