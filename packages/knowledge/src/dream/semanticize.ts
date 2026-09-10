/**
 * Semanticization — the third exit of the memory economy (user decision
 * 2026-07-07). When forgetting archives a dream-created 废案 (capacity cap or
 * stale-floor decay), the EPISODE dies but its gist about the 开拓者 may
 * survive: the dying record(s) are distilled into a bounded, few-sentence
 * continuation of HertaBio's 第六章 (her chapter on the Trailblazer), stored
 * as a `### 记录` file that `buildStaticHertaPrefix` already loads (it sorts
 * after every 废案 — her freshest knowledge of the user sits closest to the
 * live record). In memory-psychology terms: episodic memories semanticize as
 * they fade — the evening is forgotten, the person remains.
 *
 * Ground rules (mirroring the dream pass's own stance):
 * - REWRITE, not append: the model merges old page + dying gist into a whole
 *   replacement page under a hard char budget — otherwise this becomes a
 *   second unbounded memory stream one level up.
 * - Only dream-created records feed it (the collector sits on the two
 *   forgetting call-sites, never on seed eviction and never on
 *   reconsolidation supersede-archives — those memories live on).
 * - Best-effort: any failure leaves the old page untouched and NEVER blocks
 *   the eviction that triggered it.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "@herta/core";
import { stripDisplayUnsafe } from "@herta/core/text-sanitize";
import type { DeepSeekClient } from "../llm/types.js";
import {
  buildNotesAuditPrompt,
  buildNotesRefinePrompt,
  buildSemanticizePrompt,
  type PromptLang,
} from "./distill-prompt.js";
import { LEAK_MARKERS } from "./feian-format.js";
import { DreamTransportError, jsonCall } from "./llm-json.js";
import { readTextFileResult } from "./pass-ops.js";
import { assertUnderDreamRoot } from "./promote.js";
import type { DreamConfig } from "./types.js";

/** A dying 废案's text, captured just before its file is archived. */
export interface EvictedFeianText {
  readonly file: string;
  readonly body: string;
}

/** The overlay's filename, per interaction language (ADR 0017 follow-up). The
 *  `### 记录` prefix is CN STRUCTURAL and stays in BOTH languages — it is what
 *  the actor's static-prefix loader matches (NARRATIVE_FILE_PREFIXES); only the
 *  title localizes, mirroring the `### 废案_NN：<title>` corpus. Each language's
 *  page lives in its OWN narrative dir (narrative / narrative-en), so the two
 *  never collide. Keep these stable — renaming orphans the page. */
export const TRAILBLAZER_NOTES_FILE = "### 记录：关于开拓者.txt";
export const TRAILBLAZER_NOTES_FILE_EN = "### 记录：About the Trailblazer.txt";
function notesFileFor(lang: PromptLang): string {
  return lang === "en" ? TRAILBLAZER_NOTES_FILE_EN : TRAILBLAZER_NOTES_FILE;
}

/** Fixed in-world frame; the model only ever writes the body below it. The
 *  title line (after `### 记录：`) MUST equal the filename minus `.txt`. */
const NOTES_HEADER_ZH =
  "### 记录：关于开拓者\n\n" +
  "有些夜晚的细节我已经不记得了，但关于这位开拓者，有几件事沉了下来：\n\n";
const NOTES_HEADER_EN =
  "### 记录：About the Trailblazer\n\n" +
  "Some evenings I no longer remember the details of. But about this Trailblazer, a few things have settled:\n\n";
function notesHeaderFor(lang: PromptLang): string {
  return lang === "en" ? NOTES_HEADER_EN : NOTES_HEADER_ZH;
}

/** Any dialogue fence, ANY role, opener or closer — same tag shape as
 *  feian-format's checkFences. The 2026-07-09 review found the previous
 *  literal list (（我 说）/（/我/（开拓者/（我 想）) let a stray closer
 *  （/开拓者 说） or another role's fence （阮·梅 说） straight into the
 *  static prefix; it also false-positived on innocent parentheticals like
 *  （开拓者的老毛病）. The shape match fixes both directions. */
const DIALOGUE_FENCE = /（\/?[^（）/\s]+\s+(?:说|想)）/;

/** Substrings that must never appear in the notes body: truncated fence
 *  closers, record markers, and headers would corrupt the prefix's
 *  narrative grammar. */
const FORBIDDEN = [
  "（/", // any closer, even truncated — never legitimate prose
  "### ",
  "→ 系统",
  "→ 差分协处理器",
  "```",
] as const;

const MIN_BODY_CHARS = 20;

/** Current notes body (frame stripped), or "" when the page doesn't exist.
 *  `lang` selects which page (per-language file + header); default "zh".
 *
 *  Kept as-is for read-only callers that genuinely cannot act on the
 *  difference. Anything that goes on to REWRITE the page must use
 *  `readTrailblazerNotesResult` (audit 2026-07-24, 2.1). */
export function readTrailblazerNotesBody(
  narrativeDir: string,
  lang: PromptLang = "zh",
): string {
  const read = readTrailblazerNotesResult(narrativeDir, lang);
  return read.kind === "body" ? read.text : "";
}

/** The notes page read with ABSENT and UNREADABLE kept apart.
 *
 *  `""` means two incompatible things to the fold below: "she has not written
 *  anything about the Trailblazer yet" and "I could not open the page". The
 *  rewrite is a whole-page regeneration whose prompt says, in the first case
 *  truthfully and in the second falsely, that there is nothing to preserve —
 *  and it then durably replaces the file and reports `updated`. One transient
 *  lock (AV / indexer / OneDrive on `.herta/narrative`, or EMFILE in the
 *  long-lived main process) erases everything she had settled. */
export type NotesRead =
  | { readonly kind: "body"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly code: string };

export function readTrailblazerNotesResult(
  narrativeDir: string,
  lang: PromptLang = "zh",
): NotesRead {
  const header = notesHeaderFor(lang);
  const read = readTextFileResult(narrativeDir, notesFileFor(lang));
  if (read.kind !== "text") return read;
  const full = read.text;
  const text = full.startsWith(header)
    ? full.slice(header.length).trim()
    : // Header drifted (hand edit?) — take everything after the title line.
      full.split("\n").slice(1).join("\n").trim();
  return { kind: "body", text };
}

/** Validation errors for a candidate notes body; empty array = valid.
 *  Callers must run `stripDisplayUnsafe` FIRST (both write paths do): the
 *  strip re-fuses zero-width-obfuscated markers into literals, so the
 *  substring/shape checks below actually fire on them. */
export function validateTrailblazerNotesBody(
  body: string,
  maxChars: number,
): string[] {
  const errors: string[] = [];
  if (body.trim().length < MIN_BODY_CHARS) {
    errors.push(`too short (<${MIN_BODY_CHARS} chars)`);
  }
  if (body.length > maxChars) errors.push(`too long (>${maxChars} chars)`);
  if (DIALOGUE_FENCE.test(body)) {
    errors.push("forbidden token: dialogue fence （X 说/想）");
  }
  for (const token of FORBIDDEN) {
    if (body.includes(token)) errors.push(`forbidden token: ${token.trim()}`);
  }
  // Same rule as validateFeian: this page lands verbatim in the same static
  // prefix, so the backend-report vocabulary D2/D3 forbid in her voice must
  // not enter through this door either.
  if (LEAK_MARKERS.test(body)) {
    errors.push("leaked English structural marker (Verdict:/Changed:/…)");
  }
  return errors;
}

/** Durable replace of the notes page (tmp + rename, D4-guarded). `lang`
 *  selects the per-language file + header; default "zh".
 *
 *  `dreamDir` (optional) enables the pre-overwrite backup below. Every 废案
 *  eviction is archived and recoverable; this page was the ONE artifact in
 *  the corpus with no archive copy and no half-life, replaced in place by a
 *  rename (audit 2026-07-24, 2.1). Callers that can supply the dream dir
 *  should. */
export function writeTrailblazerNotes(
  narrativeDir: string,
  body: string,
  runId: string,
  lang: PromptLang = "zh",
  dreamDir?: string,
): void {
  mkdirSync(narrativeDir, { recursive: true });
  const target = join(narrativeDir, notesFileFor(lang));
  assertUnderDreamRoot(target, narrativeDir);
  backupNotesPage(target, lang, runId, dreamDir);
  writeFileAtomicSync(target, `${notesHeaderFor(lang)}${body.trim()}\n`);
}

/**
 * Copy the CURRENT page into the dream archive before it is overwritten.
 *
 * The rewrite is a whole-page regeneration driven by an LLM against whatever
 * the fold could read of the prior page. Both readers now refuse to act on an
 * unreadable page (`readTrailblazerNotesResult`) rather than treating it as
 * blank — but this backup is the part that survives a reader nobody thought
 * about: it removes the irreversibility, which is what actually hurts. This
 * page is otherwise the ONE artifact in the corpus with no archive copy.
 *
 * Best-effort and deliberately silent: a backup failure must never stop the
 * fold. The copy goes to `dreamDir/archive` — NEVER beside the page, because
 * `narrativeDir` is the corpus the actor loads few-shots from and a stray
 * file there would be ingested.
 */
function backupNotesPage(
  target: string,
  lang: PromptLang,
  runId: string,
  dreamDir: string | undefined,
): void {
  if (dreamDir === undefined) return;
  try {
    if (!existsSync(target)) return; // nothing to preserve yet
    const archiveDir = join(dreamDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const name = notesFileFor(lang).replace(/\.txt$/, "");
    const dest = join(archiveDir, `${name}.before-${runId}.txt`);
    assertUnderDreamRoot(dest, dreamDir);
    copyFileSync(target, dest);
  } catch {
    // Best-effort: never block the fold on the backup.
  }
}

/**
 * ONE validator-feedback refine retry, mirroring the 废案 refine idiom
 * (run-dream-pass's `buildRefinePrompt` loop): a single validation failure
 * used to return "failed" outright and permanently lose the evicted dreams'
 * gist, yet the zh-calibrated LEAK_MARKERS match ordinary EN prose ("the
 * plan: …") and the shared char cap is ~3x tighter in information terms for
 * EN — so EN trips these gates at a real rate. The refine asks the model to
 * fix EXACTLY the listed errors in THIS body, then re-sanitizes and
 * re-validates. Returns the repaired body, or undefined when the retry
 * itself fails (transport error, unparseable reply, or a second validation
 * failure) — the caller returns "failed" with the old page untouched, as
 * before.
 */
async function refineNotesBody(args: {
  readonly client: DeepSeekClient;
  readonly cfg: DreamConfig;
  readonly failedBody: string;
  readonly errors: readonly string[];
  readonly lang?: PromptLang;
}): Promise<string | undefined> {
  const prompt = buildNotesRefinePrompt({
    failedBody: args.failedBody,
    errors: args.errors,
    maxChars: args.cfg.trailblazerNotesMaxChars,
    lang: args.lang,
  });
  let reply: { notes?: unknown } | undefined;
  try {
    reply = await jsonCall<{ notes?: unknown }>(
      args.client,
      prompt,
      args.cfg.model,
      args.cfg.gateEffort,
    );
  } catch (err) {
    // Same stance as the first call: a transport failure loses the gist
    // this time; anything else propagates.
    if (err instanceof DreamTransportError) return undefined;
    throw err;
  }
  if (reply === undefined || typeof reply.notes !== "string") return undefined;
  const body = stripDisplayUnsafe(reply.notes).trim();
  if (
    validateTrailblazerNotesBody(body, args.cfg.trailblazerNotesMaxChars)
      .length > 0
  ) {
    return undefined; // second failure — give up, old page untouched
  }
  return body;
}

export type SemanticizeOutcome = "updated" | "failed" | "none";

/**
 * Fold the dying 废案 — and any reactivation-STABILIZED living 废案 (ADR
 * 0023, consolidation without death) — into the 开拓者 page: one LLM call
 * rewrites the whole page (old body + both source lists → new body ≤ budget),
 * then sanitize, validate, and durably replace the file. A validation failure
 * gets ONE refine retry (see refineNotesBody) before giving up. Every failure
 * path returns "failed" with the old page untouched — the caller's eviction
 * has already happened and must never be blocked or unwound by this step
 * (and the caller flags `gistFolded` only on "updated", so a failed living
 * fold simply retries next pass).
 */
export async function semanticizeEvictions(args: {
  readonly narrativeDir: string;
  /** Enables the pre-overwrite backup of the notes page (audit 2026-07-24,
   *  2.1). Optional so existing callers/tests keep compiling. */
  readonly dreamDir?: string;
  readonly client: DeepSeekClient;
  readonly cfg: DreamConfig;
  readonly evicted: readonly EvictedFeianText[];
  /** LIVING records folded WITHOUT dying (ADR 0023): reactivation-stabilized
   *  废案 whose understanding joins the same single-page rewrite under a
   *  distinct framing. Default [] — the pre-ADR-0023 dying-only fold. */
  readonly stabilized?: readonly EvictedFeianText[];
  readonly guide: string;
  readonly runId: string;
  /** LLM-facing prompt language (EN interaction slice 3b; default "zh"). */
  readonly lang?: PromptLang;
}): Promise<SemanticizeOutcome> {
  const stabilized = args.stabilized ?? [];
  if (args.evicted.length === 0 && stabilized.length === 0) return "none";
  const read = readTrailblazerNotesResult(args.narrativeDir, args.lang);
  if (read.kind === "unreadable") {
    // A rewrite that cannot see the prior page is not a fold, it's an erase
    // (audit 2026-07-24, 2.1). The gist is lost this pass — the page isn't.
    return "failed";
  }
  const prompt = buildSemanticizePrompt({
    currentNotes: read.kind === "body" ? read.text : "",
    dying: args.evicted,
    stabilized,
    guide: args.guide,
    maxChars: args.cfg.trailblazerNotesMaxChars,
    lang: args.lang,
  });
  let reply: { notes?: unknown } | undefined;
  try {
    reply = await jsonCall<{ notes?: unknown }>(
      args.client,
      prompt,
      args.cfg.model,
      args.cfg.gateEffort,
    );
  } catch (err) {
    // Transport failure: unlike the episode loop, do NOT abort anything —
    // the forgetting already happened; the gist is simply lost this time.
    if (err instanceof DreamTransportError) return "failed";
    throw err;
  }
  if (reply === undefined || typeof reply.notes !== "string") return "failed";
  let body = stripDisplayUnsafe(reply.notes).trim();
  const errors = validateTrailblazerNotesBody(
    body,
    args.cfg.trailblazerNotesMaxChars,
  );
  if (errors.length > 0) {
    // One refine retry before the gist is lost — see refineNotesBody.
    const repaired = await refineNotesBody({
      client: args.client,
      cfg: args.cfg,
      failedBody: body,
      errors,
      lang: args.lang,
    });
    if (repaired === undefined) return "failed";
    body = repaired;
  }
  try {
    writeTrailblazerNotes(
      args.narrativeDir,
      body,
      args.runId,
      args.lang,
      args.dreamDir,
    );
  } catch {
    return "failed";
  }
  return "updated";
}

export type NotesAuditOutcome = "consistent" | "revised" | "failed" | "none";

/**
 * Contradiction audit (fossilization mitigation): let the strongest LIVING
 * dream 废案 challenge the page once per pass. consistent:true costs nothing
 * (no write at all); a revision goes through the same sanitize → validate
 * (with the same single refine retry) → durable-replace pipeline as
 * semanticization. Best-effort like everything on this file: failures leave
 * the page untouched.
 */
export async function auditTrailblazerNotes(args: {
  readonly narrativeDir: string;
  /** Enables the pre-overwrite backup of the notes page (audit 2026-07-24,
   *  2.1). Optional so existing callers/tests keep compiling. */
  readonly dreamDir?: string;
  readonly client: DeepSeekClient;
  readonly cfg: DreamConfig;
  readonly living: readonly EvictedFeianText[];
  readonly guide: string;
  readonly runId: string;
  /** LLM-facing prompt language (EN interaction slice 3b; default "zh"). */
  readonly lang?: PromptLang;
}): Promise<NotesAuditOutcome> {
  const read = readTrailblazerNotesResult(args.narrativeDir, args.lang);
  // "none" is a claim that there was nothing to audit; an unreadable page is
  // a claim we are not entitled to make about it (audit 2026-07-24, 2.1).
  if (read.kind === "unreadable") return "failed";
  const current = read.kind === "body" ? read.text : "";
  if (current.length === 0 || args.living.length === 0) return "none";
  const prompt = buildNotesAuditPrompt({
    currentNotes: current,
    living: args.living,
    guide: args.guide,
    maxChars: args.cfg.trailblazerNotesMaxChars,
    lang: args.lang,
  });
  let reply: { consistent?: unknown; notes?: unknown } | undefined;
  try {
    reply = await jsonCall<{ consistent?: unknown; notes?: unknown }>(
      args.client,
      prompt,
      args.cfg.model,
      args.cfg.gateEffort,
    );
  } catch (err) {
    if (err instanceof DreamTransportError) return "failed";
    throw err;
  }
  if (reply === undefined || typeof reply.consistent !== "boolean") {
    return "failed";
  }
  if (reply.consistent) return "consistent";
  if (typeof reply.notes !== "string") return "failed";
  let body = stripDisplayUnsafe(reply.notes).trim();
  const errors = validateTrailblazerNotesBody(
    body,
    args.cfg.trailblazerNotesMaxChars,
  );
  if (errors.length > 0) {
    // One refine retry before the revision is lost — see refineNotesBody.
    const repaired = await refineNotesBody({
      client: args.client,
      cfg: args.cfg,
      failedBody: body,
      errors,
      lang: args.lang,
    });
    if (repaired === undefined) return "failed";
    body = repaired;
  }
  try {
    writeTrailblazerNotes(
      args.narrativeDir,
      body,
      args.runId,
      args.lang,
      args.dreamDir,
    );
  } catch {
    return "failed";
  }
  return "revised";
}
