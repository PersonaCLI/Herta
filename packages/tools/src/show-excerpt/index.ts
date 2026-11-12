import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type {
  HertaTool,
  ShowExcerptData,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { resolveSafePath } from "../path-safety.js";
import { redactSecrets } from "../run-command/redactor.js";
import { decodeUtf8, looksBinary } from "../text-sniff.js";
import { showExcerptInputSchema, showExcerptJsonSchema } from "./schema.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Presentation bounds. Larger than `boundedTail`'s 15/800 (sized for a
 *  command's log tail) because this exists to be READ, but still bounded:
 *  the excerpt lands in Herta's prompt for one turn. */
export const MAX_EXCERPT_LINES = 60;
export const MAX_EXCERPT_CHARS = 4000;

/** Default lines of context each side of a `match`. */
const DEFAULT_CONTEXT = 6;

/** Cut `text` to at most `max` UTF-16 code units without splitting a
 *  surrogate pair: a cut landing mid-astral-char (emoji, CJK ext-B) would
 *  leave a lone high surrogate in the excerpt — invalid the moment it is
 *  UTF-8-encoded for a prompt or transcript (same class as the recap
 *  estimator's 2026-07 non-ASCII fix). */
function cutAtChar(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Put a VERBATIM slice of a workspace file in front of both the user and
 * Herta (2026-07-27).
 *
 * Why this exists: a successful `read_file` projects nothing but its path
 * (backend-bridge only surfaces result blocks for the run_command trio), so
 * the content lives solely in the backend's own transcript. Herta never sees
 * it and neither does the user — "show me what's in that log" was
 * unanswerable, only reachable by shelling out to `sed`/`grep` and reading
 * the 15-line command tail.
 *
 * Why the HARNESS slices instead of the model passing text: the request this
 * serves is usually some form of "原样 / verbatim", and a model retyping
 * content into a tool argument can paraphrase, trim, or translate it. Taking
 * a path plus a range (or a match) makes fidelity a property of the harness
 * rather than a promise from the model — the same reflex as D4, applied to
 * accuracy.
 *
 * `readOnly` and the ordinary path guard: this is a read, and it is exempt
 * from almost nothing. It does NOT set `allowHarnessReadPaths` — read_file has
 * that carve-out so the backend can follow the harness's own
 * `.herta/tool-results/…` pointers, but PRESENTING unredacted harness
 * internals to the user is not what this tool is for.
 *
 * It DOES set `allowAttachmentPaths` (ADR 0033) and
 * `allowEvidenceExcerptPaths` (ADR 0036, amending ADR 0027 §5's blanket
 * exclusion). The distinctions are the reason those are separate flags:
 * `.herta/attachments/` holds documents the 开拓者 handed over — user
 * content stored under a harness directory — and showing one back is
 * exactly this tool's job; `.herta/logs/` holds shell output that passed
 * `redactSecrets` at capture, and the persona E2E (2026-08-11) showed the
 * one honest answer to "念给我听那行输出" is a bounded excerpt of that
 * receipt — the backend tried three times and was denied, leaving
 * paraphrase as the only path. `tool-results/` stays excluded: it is
 * written verbatim, so quoting it would surface unredacted bytes.
 */
export interface ShowExcerptToolOpts {
  /**
   * Translate the model's path spelling before path safety (ADR 0040): under
   * the minimal contract the model copies what its shell printed
   * (`/e/repo/src/x`, `/tmp/…` on MSYS), which the native resolver would
   * read as root-relative on the current drive. Absent = identity.
   */
  mapPath?: (p: string) => string;
}

export function showExcerptTool(opts: ShowExcerptToolOpts = {}): HertaTool {
  const mapPath = opts.mapPath ?? ((p: string) => p);
  return {
    name: "show_excerpt",
    readOnly: true,
    schema(): ToolSchema {
      return {
        name: "show_excerpt",
        description:
          "Show a verbatim slice of a workspace text file to the user and to Herta. " +
          "Use this when the task asks to SEE, quote, or read out file content — " +
          "the editor's `view` alone is silent to both of them. `{path}` alone shows the " +
          "head of the file; give `fromLine`/`toLine` for a range, or `match` " +
          "(a literal substring) with optional `context` lines each side. The " +
          "excerpt is taken from disk, so it is exact; do not retype content " +
          `yourself. Bounded to ${MAX_EXCERPT_LINES} lines / ${MAX_EXCERPT_CHARS} chars.`,
        inputSchema: showExcerptJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<ShowExcerptData>> {
      const parsed = showExcerptInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: formatInputIssues(parsed.error),
            retryable: false,
          },
          suggestion:
            "usage: {path} (the head of the file), {path, fromLine, toLine?} or {path, match, context?}",
          summary: "invalid input",
        };
      }
      const { path, fromLine, toLine, match, context } = parsed.data;

      // No tool-results carve-out (see the header) — but attachments AND the
      // redacted command logs ARE presentable: a document the user handed
      // over, or a shell receipt they asked to hear verbatim, that Herta
      // could read and never quote back would answer half the request
      // (ADR 0033 / ADR 0036).
      const safe = await resolveSafePath(ctx.workspaceRoot, mapPath(path), {
        allowAttachmentPaths: true,
        allowEvidenceExcerptPaths: true,
      });
      if (!safe.ok) {
        return {
          ok: false,
          error: { code: safe.code, message: safe.message, retryable: false },
          summary: `denied: ${safe.message}`,
        };
      }

      let info: Stats;
      try {
        info = await stat(safe.resolved);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        return {
          ok: false,
          error: {
            code: code === "ENOENT" ? "not_found" : "read_failed",
            message:
              code === "ENOENT"
                ? `not found: ${safe.relative || path}`
                : ((err as Error).message ?? "stat failed"),
            retryable: false,
          },
          summary:
            code === "ENOENT"
              ? `not found: ${safe.relative || path}`
              : "read failed",
        };
      }
      if (!info.isFile()) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: `not a file: ${safe.relative || path}`,
            retryable: false,
          },
          summary: `not a file: ${safe.relative || path}`,
        };
      }
      if (info.size > MAX_FILE_BYTES) {
        return {
          ok: false,
          error: {
            code: "file_too_large",
            message: `file is ${info.size} bytes (cap ${MAX_FILE_BYTES})`,
            retryable: false,
          },
          summary: `too large: ${safe.relative}`,
        };
      }

      let buf: Buffer;
      try {
        buf = await readFile(safe.resolved);
      } catch (err: unknown) {
        return {
          ok: false,
          error: {
            code: "read_failed",
            message: (err as Error).message ?? "read failed",
            retryable: false,
          },
          summary: "read failed",
        };
      }
      if (looksBinary(buf)) {
        return {
          ok: false,
          error: {
            code: "binary_file",
            message: "NUL byte detected in first 4KB",
            retryable: false,
          },
          summary: `binary: ${safe.relative}`,
        };
      }

      // Showing a file counts as having read it: record the hash so the
      // edit-freshness ledger treats it like any other read.
      ctx.reads.record(
        safe.resolved,
        createHash("sha256").update(buf).digest("hex"),
      );

      // This excerpt goes into the record — the USER reads it. A non-UTF-8
      // source decodes to U+FFFD runs, so the excerpt must say that rather
      // than present the damage as the file's contents (2026-08-24).
      const decoded = decodeUtf8(buf);
      const lossyNote = decoded.lossy ? " (not valid UTF-8)" : "";
      let text = decoded.text;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const lines = text.split("\n");
      const totalLines = text.endsWith("\n") ? lines.length - 1 : lines.length;
      if (totalLines === 0) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: `empty file: ${safe.relative}`,
            retryable: false,
          },
          summary: `empty: ${safe.relative}`,
        };
      }

      let start: number; // 1-based inclusive
      let end: number;
      if (match !== undefined) {
        const hit = lines.findIndex((l) => l.includes(match));
        if (hit === -1) {
          return {
            ok: false,
            error: {
              code: "not_found",
              message: `no line contains ${JSON.stringify(match)} in ${safe.relative}`,
              retryable: false,
            },
            summary: `no match in ${safe.relative}`,
          };
        }
        const pad = context ?? DEFAULT_CONTEXT;
        start = Math.max(1, hit + 1 - pad);
        end = Math.min(totalLines, hit + 1 + pad);
      } else if (fromLine === undefined && toLine === undefined) {
        // A bare path (2026-09-18): the head of the file, up to the excerpt
        // bound — "show me this file" answered with as much as one excerpt
        // holds, not with a rebuke for the missing range.
        start = 1;
        end = Math.min(MAX_EXCERPT_LINES, totalLines);
      } else {
        start = Math.min(fromLine ?? 1, totalLines);
        end = Math.min(toLine ?? start + DEFAULT_CONTEXT * 2, totalLines);
      }

      let truncated = false;
      if (end - start + 1 > MAX_EXCERPT_LINES) {
        end = start + MAX_EXCERPT_LINES - 1;
        truncated = true;
      }
      // The bare-path head of a file longer than the bound is a cut too: the
      // reader must know the file goes on, even though no range was asked.
      if (
        match === undefined &&
        fromLine === undefined &&
        toLine === undefined &&
        end < totalLines
      ) {
        truncated = true;
      }

      // The char cap cuts at LINE boundaries, and `end` follows the cut.
      // Slicing the joined string (as first shipped) over-claimed: `range`
      // and the `path:start-end` summary kept naming lines the cut had
      // removed, and the compaction digest a later turn keeps (`Excerpt
      // a.ts:120-180 · 正文已略去`) inherited the over-claim — a harness-
      // sourced version of the fabricated receipt. A single line wider than
      // the whole budget (minified source) is the one case that still cuts
      // mid-line, surrogate-safely; its line is genuinely (partially) shown,
      // so it stays in the range.
      const padWidth = String(end).length;
      const numbered: string[] = [];
      let used = 0;
      for (const [i, l] of lines.slice(start - 1, end).entries()) {
        const row = `${String(start + i).padStart(padWidth, " ")}\t${l}`;
        const cost = row.length + (numbered.length > 0 ? 1 : 0); // "\n"
        if (used + cost > MAX_EXCERPT_CHARS) {
          if (numbered.length === 0)
            numbered.push(cutAtChar(row, MAX_EXCERPT_CHARS));
          truncated = true;
          break;
        }
        numbered.push(row);
        used += cost;
      }
      end = start + numbered.length - 1;
      // Redact the assembled excerpt (review #4). This tool's output reaches
      // the RECORD — evidenceDetail, the GUI's evidence pane, Herta's prompt —
      // and every other record-reaching producer already redacts: run_command
      // tails, search_text results, the attachment head. This was the one open
      // door left: 板砖 asked to 展示 a key-bearing file put the key on
      // screen and into the provider prompt verbatim. ADR 0027's fidelity
      // promise ("the harness cut it, nothing paraphrased it") is about
      // provenance, not secrets — a `[REDACTED:api_key]` marker is the
      // harness speaking, which that contract already allows. `read_file`
      // stays byte-exact: it never reaches the record, and its re-read
      // offsets must match the file (the documented BL17 boundary).
      // Redacted AFTER assembly so the multi-line PEM rule sees the block
      // whole; the matching itself ran on the original text above, so
      // `match`/range semantics are unchanged.
      const excerpt = redactSecrets(numbered.join("\n"));

      return {
        ok: true,
        data: {
          excerpt,
          range: [start, end],
          totalLines,
          truncated,
          relPath: safe.relative,
        },
        // The summary is the RECORD BODY's argument (inputSummary drives the
        // op row); the excerpt itself rides evidenceDetail via the bridge.
        summary: `${safe.relative}:${start}-${end}${lossyNote}`,
      };
    },
  };
}
