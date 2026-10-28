import { readFile, stat } from "node:fs/promises";
import type {
  HertaTool,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { MAX_FINDINGS } from "@herta/core";
import { isDigestSidecar } from "../digest-document/index.js";
import { formatInputIssues } from "../input-issues.js";
import { resolveSafePath } from "../path-safety.js";
import {
  CITE_PATTERN,
  MAX_FINDING_CLAIM_CHARS,
  reportFindingInputSchema,
  reportFindingJsonSchema,
} from "./schema.js";

export type { ReportFindingInput } from "./schema.js";
export { MAX_FINDING_CITES, MAX_FINDING_CLAIM_CHARS } from "./schema.js";

export interface ReportFindingData {
  /** 1-based position in this brief's findings. */
  index: number;
  claim: string;
  /** Normalized citations, exactly as validated. */
  cites: readonly string[];
}

/** Files above this are not line-counted for citation checks (the read is
 *  the cost); the path must still exist. Equals the attachment storage
 *  ceiling — nothing a brief can cite is bigger. */
const LINE_CHECK_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Record one CONCLUSION of the brief, with citations (ADR 0039).
 *
 * WHY. The report the backend returns has always been by-products — files
 * touched, tests, risks, receipts — and the model's final prose has no
 * channel at all (D6). For an analysis brief that meant the deliverable
 * evaporated: 板砖 read the log, said `部分完成`, and Herta re-did the
 * analysis from her own prompt. This tool is the channel: one call per
 * conclusion, and the harness projects it into the record and lists it in
 * the done marker under `↳ 结论`.
 *
 * WHY CITATIONS ARE VERIFIED. A conclusion nobody can check is not evidence;
 * a fabricated `path:line` must fail HERE, at the tool, not later in Herta's
 * mouth. Every cite is resolved through the same path guard as a read (the
 * attachment / log carve-outs included), must exist, and a line range must
 * lie inside the file. That makes a recorded finding quote-grade by
 * construction — the same stance ADR 0036 took for evidence in the record.
 */
export interface ReportFindingToolOpts {
  /** Translate a cite's path spelling before path safety (ADR 0040; see
   *  show_excerpt's ShowExcerptToolOpts). Absent = identity. */
  mapPath?: (p: string) => string;
  /** The session's interaction language (ADR 0016 amendment, 2026-09-03):
   *  names the language `claim` is written in — it is shown to the user
   *  verbatim, in the conversation. Absent = "zh". */
  lang?: "zh" | "en";
}

/** The language sentence of the description. */
export function findingClaimLanguageLine(lang: "zh" | "en"): string {
  return lang === "en"
    ? "Write `claim` in English: the finding is shown to the user inside an English conversation."
    : "Write `claim` in Chinese (中文): the finding is shown to the user inside a Chinese conversation.";
}

export function reportFindingTool(opts: ReportFindingToolOpts = {}): HertaTool {
  const mapPath = opts.mapPath ?? ((p: string) => p);
  const lang = opts.lang ?? "zh";
  return {
    name: "report_finding",
    // NOT readOnly: it appends to the per-brief ledger — harness state —
    // and serial execution keeps finding indices in the order the model
    // recorded them.
    schema(): ToolSchema {
      return {
        name: "report_finding",
        description:
          'Record ONE conclusion of your analysis so it reaches the record and the final report — your final message text is NOT shown to anyone. `claim`: one sentence stating what you found. `cites`: 1–6 FILE locations that support it, each `path`, `path:line` or `path:from-to` (workspace-relative; attachments and .herta/logs allowed); every cite is checked to exist. Example: {claim: "remove() splices by id, not index", cites: ["src/store.mjs:20-22", "README.md"]}. A commit hash, command, or prose is NOT a cite — name those inside the claim and cite the files they concern. Call once per conclusion; consolidate rather than exceed the per-brief cap. Use for explore/analysis briefs; not needed when the deliverable is a file change. ' +
          findingClaimLanguageLine(lang),
        inputSchema: reportFindingJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<ReportFindingData>> {
      const parsed = reportFindingInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: formatInputIssues(parsed.error),
            retryable: false,
          },
          suggestion:
            overLongClaim(call.input) ??
            'usage: {claim: "<one sentence>", cites: ["path:line", "path:from-to", …]}',
          summary: "invalid input",
        };
      }
      const claim = parsed.data.claim.replace(/\s*[\r\n]+\s*/g, " ").trim();

      // Validate every citation before recording anything: a finding is
      // accepted whole or not at all.
      const cites: string[] = [];
      for (const raw of parsed.data.cites) {
        const m = CITE_PATTERN.exec(raw.trim());
        if (m === null || m[1] === undefined) {
          return badCite(raw, "expected `path`, `path:line` or `path:from-to`");
        }
        const path = m[1];
        const from = m[2] !== undefined ? Number(m[2]) : undefined;
        const to = m[3] !== undefined ? Number(m[3]) : undefined;
        if (from !== undefined && from < 1) {
          return badCite(raw, "line numbers start at 1");
        }
        if (from !== undefined && to !== undefined && to < from) {
          return badCite(raw, "`to` must be >= `from`");
        }
        const safe = await resolveSafePath(ctx.workspaceRoot, mapPath(path), {
          allowAttachmentPaths: true,
          allowHarnessReadPaths: true,
          allowEvidenceExcerptPaths: true,
          allowEvidenceDiscoveryPaths: true,
        });
        if (!safe.ok) return badCite(raw, safe.message);
        // A digest sidecar (ADR 0043) is model-generated: a conclusion cited
        // to it would rest on a summary, not on the document. The digest's
        // own entries name the source ranges — cite those.
        if (isDigestSidecar(safe.relative)) {
          return badCite(
            raw,
            "a .digest.txt is a model-generated summary — cite the source lines its L<from>–L<to> entries point at, not the digest",
          );
        }
        let info: Awaited<ReturnType<typeof stat>>;
        try {
          info = await stat(safe.resolved);
        } catch {
          return badCite(raw, "no such file or directory");
        }
        if (from !== undefined) {
          if (!info.isFile()) return badCite(raw, "line numbers need a file");
          if (info.size <= LINE_CHECK_MAX_BYTES) {
            let text: string;
            try {
              text = await readFile(safe.resolved, "utf8");
            } catch {
              return badCite(raw, "could not read the file to check the lines");
            }
            const total = text.length === 0 ? 0 : text.split("\n").length;
            const last = to ?? from;
            if (last > total) {
              return badCite(
                raw,
                `line ${last} is beyond the end of the file (${total} lines)`,
              );
            }
          }
        }
        cites.push(
          from === undefined
            ? safe.relative || path
            : `${safe.relative || path}:${from}${to !== undefined ? `-${to}` : ""}`,
        );
      }

      const index = ctx.findings?.add({ claim, cites }) ?? null;
      if (ctx.findings !== undefined && index === null) {
        return {
          ok: false,
          error: {
            code: "findings_cap",
            message: `this brief already holds ${MAX_FINDINGS} findings`,
            retryable: false,
          },
          suggestion:
            "Consolidate: the cap is the number of conclusions a reader can use, not a scratch buffer.",
          summary: "findings cap reached",
        };
      }
      const n = index ?? 0;
      return {
        ok: true,
        data: { index: n, claim, cites },
        summary: `finding${n > 0 ? ` #${n}` : ""}: ${claim} — ${cites.join(", ")}`,
      };
    },
  };
}

/**
 * The move that fixes an over-long claim. The generic usage line only said
 * "one sentence", and the browser lab's refused finding (ADR 0083 step 7)
 * held two conclusions and their evidence in one: say how long it is, and
 * that each conclusion is a finding of its own.
 */
function overLongClaim(input: unknown): string | null {
  const claim = (input as { claim?: unknown } | null)?.claim;
  if (typeof claim !== "string" || claim.length <= MAX_FINDING_CLAIM_CHARS) {
    return null;
  }
  return `The claim is ${claim.length} characters; the limit is ${MAX_FINDING_CLAIM_CHARS}. If it holds more than one conclusion, record each as a finding of its own; otherwise keep the conclusion and its deciding fact, and let the cites carry the detail.`;
}

function badCite(raw: string, why: string): ToolResult<ReportFindingData> {
  return {
    ok: false,
    error: {
      code: "invalid_cite",
      message: `cite "${raw}": ${why}`,
      retryable: false,
    },
    suggestion:
      "Cite only locations you actually read: `path:line` or `path:from-to` from a read_file / show_excerpt / search_text result. Fix the cite; do not drop the citation.",
    summary: "invalid cite",
  };
}
