import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DigestDocumentData,
  HertaTool,
  ProgressFn,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { resolveSafePath } from "../path-safety.js";
import { redactSecrets } from "../run-command/redactor.js";
import { chunkDocument, type DocumentChunk } from "./chunker.js";
import {
  digestDocumentInputSchema,
  digestDocumentJsonSchema,
} from "./schema.js";

/**
 * `digest_document` — a map-reduce digest of an attached document (ADR 0043).
 *
 * The large-document lab (2026-08-23) measured what "summarize this 500-page
 * PDF" costs a coprocessor that can only read: ~100 sequential round trips,
 * 13 minutes, and a structure list instead of the summary. The page markers
 * and outline (ADR 0038 §5) make NAVIGATION cheap; they do nothing for a
 * task that needs the whole document's content at once. This tool does that
 * one thing: split the stored text into ~12K-char chunks at the document's
 * own seams, summarize every chunk in parallel with a small side model,
 * reduce the chunk summaries into a short overview, and store the whole
 * digest as a sidecar (`…pdf.digest.txt`) beside the text — once per
 * document, idempotent by the content-hashed name.
 *
 * Boundaries, each a decision:
 * - **Attachments only.** The sidecar lives beside the text under
 *   `.herta/attachments/`, where the harness owns the directory; a digest of
 *   a repo file would have to land in the user's tree or a new carve-out.
 *   Other paths get a structured refusal pointing at grep.
 * - **The digest is evidence for 板砖, not Herta's voice (D6).** It is a
 *   model-generated navigation aid and SAYS so in its header; a
 *   `report_finding` cite into a `.digest.txt` is refused so conclusions
 *   stay anchored in the source lines the digest points at.
 * - **Allow-tier, bounded.** It reads a file the backend may already read,
 *   writes only its own sidecar, and spends side-model tokens on the user's
 *   key — bounded by `MAX_DIGEST_CHUNKS`, visible in the record as a
 *   `Digesting <path>` row and a result row carrying the overview.
 * - **Deterministic chunking, model-authored summaries.** The harness decides
 *   every `L<from>–L<to>` range; the model never chooses what it saw.
 *
 * The side model is injected (`DigestModel`): the tool package knows nothing
 * about providers. The wiring supplies flash with thinking off; a null model
 * (no key, tests) makes the tool report `unavailable` rather than vanish.
 */
export type DigestModel = (
  input: { readonly system: string; readonly user: string },
  signal: AbortSignal,
) => Promise<string>;

export interface DigestDocumentToolOpts {
  /** The side model, or null when none is configured. */
  readonly model: DigestModel | null;
  /** Language of the summaries and the sidecar's header (ADR 0016). Default zh. */
  readonly lang?: "zh" | "en";
  /** Shell-spelling translation (ADR 0040), like show_excerpt's. */
  readonly mapPath?: (p: string) => string;
  /** Parallel side-model calls in flight. Default DIGEST_CONCURRENCY. */
  readonly concurrency?: number;
  /** Chunk budget override (tests). */
  readonly chunkChars?: number;
}

/** The result-data shape lives in core (the bridge reads it, and herta must
 *  not depend on tools) — re-exported here for the tool's consumers. */
export type { DigestDocumentData } from "@herta/core";

/** Cap on chunks per document — 60 × 12K ≈ 720K chars of source, past the
 *  attachment char cap's neighbourhood; a bigger file is a corpus, and the
 *  answer is grep + the outline, not a 200-call digest. */
export const MAX_DIGEST_CHUNKS = 60;
export const DIGEST_CONCURRENCY = 6;
/** Per-chunk summary bound (chars) — the model is asked for 2–4 lines. */
const MAX_CHUNK_SUMMARY_CHARS = 700;
/** Overview bound (chars). */
const MAX_OVERVIEW_CHARS = 1_500;
/** What the MODEL sees of the digest in the tool message (the sidecar holds
 *  the whole thing; `sed -n` reaches the rest). */
const MAX_MODEL_TEXT_CHARS = 16_000;
const DIGEST_SUFFIX = ".digest.txt";
const ATTACHMENT_PREFIX = ".herta/attachments/";
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

const TEXT = {
  zh: {
    chunkSystem:
      "你是文档的导航摘要器。输入是一份长文档中的一段（附行号范围，可能附页码）。请用 2 到 4 行写出这一段的导航摘要：每行一句，说明这段讲了什么、出现了哪些关键名称、数字、结论或事件。用中文写，文档中的专有名词、术语、标题保留原文。只输出摘要行——不要前言、不要标题、不要引号、不要评价。",
    chunkUser: (name: string, range: string, body: string) =>
      `文档：${name}\n范围：${range}\n\n${body}`,
    reduceSystem:
      "下面是一份长文档各段的导航摘要，按原文顺序排列，每段标有行号范围（可能附页码）。请写一段不超过 6 行的总览：这份文档是什么、主要部分有哪些、各部分大致落在哪些行或页。用中文写，专有名词保留原文。只输出总览——不要前言、不要标题。",
    reduceUser: (name: string, entries: string) =>
      `文档：${name}\n\n${entries}`,
    header: (name: string, chunks: number) =>
      `# 文档摘要 · ${name} · 共 ${chunks} 段 · 模型生成的导航摘要——引用前请回读原文对应行`,
    chunkHeading: (range: string) => `## ${range}`,
    range: (c: DocumentChunk) =>
      `L${c.fromLine}–L${c.toLine}${
        c.pages !== undefined
          ? c.pages[0] === c.pages[1]
            ? `（第 ${c.pages[0]} 页）`
            : `（第 ${c.pages[0]}–${c.pages[1]} 页）`
          : ""
      }`,
    failedChunk: "（该段摘要失败——请直接读取原文）",
    noOverview: "（总览生成失败——请按下列分段摘要自行归纳）",
    cachedNote: "（已有摘要，直接返回）",
  },
  en: {
    chunkSystem:
      "You summarize one section of a long document for a reader who will navigate it. The input is the section with its line range (and page range when known). Write 2 to 4 lines: one sentence each, saying what the section covers and which key names, numbers, conclusions or events appear. Write in English; keep the document's proper nouns, terms and headings verbatim. Output only the summary lines — no preamble, no heading, no quotes, no evaluation.",
    chunkUser: (name: string, range: string, body: string) =>
      `Document: ${name}\nRange: ${range}\n\n${body}`,
    reduceSystem:
      "Below are navigation summaries of a long document's sections, in order, each with its line range (and page range when known). Write an overview of at most 6 lines: what the document is, its main parts, and roughly which lines or pages each part spans. Write in English; keep proper nouns verbatim. Output only the overview — no preamble, no heading.",
    reduceUser: (name: string, entries: string) =>
      `Document: ${name}\n\n${entries}`,
    header: (name: string, chunks: number) =>
      `# Document digest · ${name} · ${chunks} chunks · model-generated navigation summaries — re-read the cited lines before quoting`,
    chunkHeading: (range: string) => `## ${range}`,
    range: (c: DocumentChunk) =>
      `L${c.fromLine}–L${c.toLine}${
        c.pages !== undefined
          ? c.pages[0] === c.pages[1]
            ? ` (p.${c.pages[0]})`
            : ` (pp.${c.pages[0]}–${c.pages[1]})`
          : ""
      }`,
    failedChunk: "(summary failed for this chunk — read the source directly)",
    noOverview: "(overview failed — synthesize from the chunk summaries below)",
    cachedNote: "(existing digest, returned as is)",
  },
} as const;

/** Normalize a model's summary: trim, drop blank lines and list bullets the
 *  prompt forbade anyway, bound the length at a line boundary. */
function tidySummary(raw: string, max: number): string {
  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "").trim())
    .filter((l) => l.length > 0);
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > max) {
      if (out.length === 0) out.push(l.slice(0, max));
      break;
    }
    out.push(l);
    used += l.length + 1;
  }
  return out.join("\n");
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}

/** The sidecar path for a stored attachment: `book-x.pdf.txt` →
 *  `book-x.pdf.digest.txt`, `spec-x.md` → `spec-x.md.digest.txt`. */
export function digestSidecarFor(relPath: string): string {
  return `${relPath.replace(/\.txt$/, "")}${DIGEST_SUFFIX}`;
}

export function isDigestSidecar(relPath: string): boolean {
  return relPath.endsWith(DIGEST_SUFFIX);
}

export function digestDocumentTool(opts: DigestDocumentToolOpts): HertaTool {
  const mapPath = opts.mapPath ?? ((p: string) => p);
  const lang = opts.lang ?? "zh";
  const text = TEXT[lang];
  const concurrency = opts.concurrency ?? DIGEST_CONCURRENCY;
  return {
    name: "digest_document",
    readOnly: true,
    schema(): ToolSchema {
      return {
        name: "digest_document",
        description:
          "Build (or fetch) a digest of an ATTACHED document — the stored text under .herta/attachments/. " +
          "The harness splits the text into ~12K-char chunks at page/paragraph seams, summarizes every chunk " +
          "in parallel with a side model, and writes an overview plus one entry per chunk " +
          "(`L<from>–L<to>` ranges, page ranges when known) to a `.digest.txt` sidecar beside the text. " +
          "Use it when the task needs the WHOLE document's content — a summary, an index, 'what does this " +
          "cover' — instead of reading the file end to end; use the outline or grep when you only need to " +
          "locate something. One call per document; a second call returns the stored digest. The summaries " +
          "are model-generated: re-read the source lines before quoting, and cite the source, never the digest.",
        inputSchema: digestDocumentJsonSchema,
      };
    },
    summarize(input: unknown): string | undefined {
      const p = (input as { path?: unknown } | undefined)?.path;
      return typeof p === "string" ? p : undefined;
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
      progress: ProgressFn,
    ): Promise<ToolResult<DigestDocumentData>> {
      const parsed = digestDocumentInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: formatInputIssues(parsed.error),
            retryable: false,
          },
          suggestion: "usage: {path} — the attachment's stored text path",
          summary: "invalid input",
        };
      }
      const { path } = parsed.data;
      const safe = await resolveSafePath(ctx.workspaceRoot, mapPath(path), {
        allowAttachmentPaths: true,
      });
      if (!safe.ok) {
        return {
          ok: false,
          error: { code: safe.code, message: safe.message, retryable: false },
          summary: `denied: ${safe.message}`,
        };
      }
      const rel = safe.relative;
      if (!rel.startsWith(ATTACHMENT_PREFIX) || isDigestSidecar(rel)) {
        return {
          ok: false,
          error: {
            code: "not_an_attachment",
            message: `digest_document works on attached documents (${ATTACHMENT_PREFIX}…), not ${rel}`,
            retryable: false,
          },
          suggestion:
            "For a repo file, search it (git grep / rg) or view the range you need.",
          summary: `not an attachment: ${rel}`,
        };
      }
      if (opts.model === null) {
        return {
          ok: false,
          error: {
            code: "unavailable",
            message: "no side model is configured for digests",
            retryable: false,
          },
          suggestion:
            "Read the outline sidecar (if any) and grep / read ranges instead.",
          summary: "digest unavailable",
        };
      }

      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(safe.resolved);
      } catch {
        return {
          ok: false,
          error: {
            code: "not_found",
            message: `not found: ${rel}`,
            retryable: false,
          },
          summary: `not found: ${rel}`,
        };
      }
      if (!info.isFile() || info.size > MAX_SOURCE_BYTES) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: `not a digestible file: ${rel}`,
            retryable: false,
          },
          summary: `not a file: ${rel}`,
        };
      }

      const digestRel = digestSidecarFor(rel);
      const digestAbs = join(ctx.workspaceRoot, ...digestRel.split("/"));
      const name = rel.split("/").pop() ?? rel;

      // The result shape, shared by the cached and the fresh path. The
      // sidecar is VERBATIM on disk; the copies that travel (model text,
      // record overview) are redacted — the attachment head's split (ADR
      // 0033 §6f).
      const finish = (
        r: DigestDocumentData & { content: string },
      ): ToolResult<DigestDocumentData> => {
        const { content: full, ...data } = r;
        const redacted = redactSecrets(full);
        const modelText =
          redacted.length <= MAX_MODEL_TEXT_CHARS
            ? redacted
            : `${redacted.slice(0, MAX_MODEL_TEXT_CHARS)}\n…（${lang === "en" ? "digest continues in" : "余下部分见"} ${data.digestPath}）`;
        return {
          ok: true,
          data: { ...data, overview: redactSecrets(data.overview) },
          summary: `digested ${data.relPath} → ${data.digestPath} (${data.chunks} chunks${
            data.cached
              ? ", cached"
              : data.failed > 0
                ? `, ${data.failed} failed`
                : ""
          })`,
          modelText: data.cached
            ? `${text.cachedNote}\n${modelText}`
            : modelText,
        };
      };

      // Cache: the stored name is content-hashed (ADR 0033), so an existing
      // sidecar describes exactly this text.
      try {
        const existing = await readFile(digestAbs, "utf8");
        const parsedExisting = parseSidecar(existing);
        return finish({
          relPath: rel,
          digestPath: digestRel,
          chunks: parsedExisting.chunks,
          failed: 0,
          overview: parsedExisting.overview,
          cached: true,
          content: existing,
        });
      } catch {
        // No sidecar yet — build one.
      }

      let source: string;
      try {
        source = (await readFile(safe.resolved, "utf8")).replace(/^\uFEFF/, "");
      } catch (err) {
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
      if (source.trim().length === 0) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: `empty file: ${rel}`,
            retryable: false,
          },
          summary: `empty: ${rel}`,
        };
      }
      const chunks = chunkDocument(source, {
        ...(opts.chunkChars !== undefined
          ? { targetChars: opts.chunkChars }
          : {}),
      });
      if (chunks.length > MAX_DIGEST_CHUNKS) {
        return {
          ok: false,
          error: {
            code: "too_large",
            message: `${rel} would need ${chunks.length} chunks (cap ${MAX_DIGEST_CHUNKS})`,
            retryable: false,
          },
          suggestion:
            "Use the outline sidecar and grep to locate the parts the task needs, then read those ranges.",
          summary: `too large to digest: ${rel}`,
        };
      }

      // Map: one side-model call per chunk, bounded concurrency, one retry.
      const model = opts.model;
      let done = 0;
      let failed = 0;
      const summaries = await mapLimit(chunks, concurrency, async (c) => {
        const range = text.range(c);
        const user = text.chunkUser(name, range, c.text);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (ctx.signal.aborted) break;
          try {
            const raw = await model(
              { system: text.chunkSystem, user },
              ctx.signal,
            );
            const tidy = tidySummary(raw, MAX_CHUNK_SUMMARY_CHARS);
            if (tidy.length > 0) {
              done += 1;
              progress({
                id: call.id,
                message: `digest ${done}/${chunks.length}`,
              });
              return tidy;
            }
          } catch {
            // retry once, then mark failed
          }
        }
        failed += 1;
        return text.failedChunk;
      });
      if (ctx.signal.aborted) {
        const err = new Error("aborted");
        (err as Error & { name: string }).name = "AbortError";
        throw err;
      }
      if (failed * 2 > chunks.length) {
        return {
          ok: false,
          error: {
            code: "digest_failed",
            message: `${failed} of ${chunks.length} chunk summaries failed`,
            retryable: true,
          },
          suggestion:
            "The side model is unavailable right now; retry, or navigate with the outline and grep.",
          summary: "digest failed",
        };
      }

      // Reduce: the overview from the chunk entries.
      const entries = chunks
        .map((c, i) => `${text.chunkHeading(text.range(c))}\n${summaries[i]}`)
        .join("\n\n");
      let overview = "";
      try {
        overview = tidySummary(
          await model(
            {
              system: text.reduceSystem,
              user: text.reduceUser(name, entries),
            },
            ctx.signal,
          ),
          MAX_OVERVIEW_CHARS,
        );
      } catch {
        overview = "";
      }
      if (overview.length === 0) overview = text.noOverview;

      const content = `${text.header(name, chunks.length)}\n${overview}\n\n${entries}\n`;
      try {
        await writeFile(digestAbs, content, "utf8");
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "write_failed",
            message: (err as Error).message ?? "could not write the digest",
            retryable: true,
          },
          summary: "digest write failed",
        };
      }
      return finish({
        relPath: rel,
        digestPath: digestRel,
        chunks: chunks.length,
        failed,
        overview,
        cached: false,
        content,
      });
    },
  };
}

/** Read the chunk count and overview back out of an existing sidecar: the
 *  header's count, and the lines between the header and the first `## `. */
function parseSidecar(content: string): { chunks: number; overview: string } {
  const lines = content.replace(/\r/g, "").split("\n");
  const header = lines[0] ?? "";
  const m = /(\d+)\s*(?:段|chunks)/.exec(header);
  const chunks = m !== null ? Number(m[1]) : 0;
  const overview: string[] = [];
  for (const l of lines.slice(1)) {
    if (l.startsWith("## ")) break;
    if (l.trim().length > 0) overview.push(l);
  }
  return { chunks, overview: overview.join("\n") };
}
