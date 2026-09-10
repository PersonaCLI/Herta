import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  dreamDirFor,
  errorMessage,
  listSessions,
  narrativeDirFor,
  readSessionFile,
} from "@herta/core";
import {
  archiveLiveRecord,
  runDreamPass as defaultRunDreamPass,
  liveDreamRecords,
  parseFeianHeader,
  type RunDreamPassOptions,
  type RunDreamPassResult,
  readManifest,
  resolveDreamConfig,
  segmentSession,
  selectEpisodes,
  writeManifest,
} from "../dream/index.js";
import {
  defaultTextMapDir,
  loadTextMap,
  searchAlignedTerms,
  TEXTMAP_CN_FILENAME,
  TEXTMAP_EN_FILENAME,
} from "../glossary/textmap-glossary.js";
import {
  getPersonaComponent,
  PERSONA_COMPONENTS,
  type PersonaComponentSpec,
  PersonaStore,
} from "../index.js";
import { ingestCorpus } from "../ingest/ingest-corpus.js";
import { estimateCostUsd, formatCostUsd } from "../llm/cost-estimator.js";
import { RealDeepSeekClient } from "../llm/deepseek-client.js";
import { resolveDeepSeekApiKey } from "../llm/key-resolver.js";
import type { DeepSeekClient } from "../llm/types.js";
import { defaultDataDir, defaultDbPath } from "../paths.js";
import { type CanonEntityId, HERTA_PERSON_PRIME } from "../schema.js";
import { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";
import {
  runAlignPass as defaultRunAlignPass,
  type RunAlignPassOptions,
  type RunAlignPassResult,
} from "../voice/run-align-pass.js";
import {
  runRestratifyLlmPass as defaultRunRestratifyLlmPass,
  type RunRestratifyLlmPassOptions,
  type RunRestratifyLlmPassResult,
} from "../voice/run-restratify-llm-pass.js";
import {
  runStratifyPass as defaultRunStratifyPass,
  type RunStratifyPassOptions,
  type RunStratifyPassResult,
} from "../voice/run-stratify-pass.js";
import { runSelfModelSubcommand } from "./self-model-subcommand.js";

export interface CliIo {
  cwd: string;
  log: (line: string) => void;
  err: (line: string) => void;
}

/**
 * Optional dependency overrides. Tests inject fakes for the orchestrators
 * (so we never make real DeepSeek calls) and for the DeepSeek client factory.
 */
export interface CliDeps {
  runAlignPass?: (
    opts: RunAlignPassOptions,
  ) => RunAlignPassResult | Promise<RunAlignPassResult>;
  runStratifyPass?: (
    opts: RunStratifyPassOptions,
  ) => RunStratifyPassResult | Promise<RunStratifyPassResult>;
  runRestratifyLlmPass?: (
    opts: RunRestratifyLlmPassOptions,
  ) => Promise<RunRestratifyLlmPassResult>;
  runDreamPass?: (opts: RunDreamPassOptions) => Promise<RunDreamPassResult>;
  /** Build a DeepSeek client given a resolved API key. */
  makeDeepSeekClient?: (apiKey: string, model: string) => DeepSeekClient;
}

const USAGE = `usage: herta knowledge <subcommand>

Subcommands:
  ingest                Build .herta/knowledge/herta-canon.sqlite from a data corpus.
  persona-seed          Seed The Herta's persona components from canon.
  voice-align           Align stratified chunks to official localized lines (chunk_translations).
  voice-stratify        R0: classify Herta-spoken chunks by addressee class.
  voice-restratify-llm  Pass 1: whole-doc LLM re-stratification (two-pass consensus).
  self-model            Spec B1 pipeline (clean / expand-corpus / extract / synthesize / validate / build / judge)
  extract-scenes        Dump Herta's in-game conversations (per document) as JSONL.
  glossary              Look up official CN↔EN term pairs in the aligned TextMaps.
  dream                 Distill session episodes into live 废案 voice few-shots.
  dream list            List live dream-created records (title + voice score).
  dream archive <id>    Archive a live dream-created record by id.

Run 'herta knowledge <subcommand> --help' for per-subcommand options.`;

const INGEST_USAGE = `usage: herta knowledge ingest [options]

Options:
  --data-root <path>            Path to corpus root (default: ./data)
  --db <path>                   Output SQLite DB path (default: .herta/knowledge/herta-canon.sqlite)
  --review-out <path>           Review JSONL directory (default: .herta/knowledge/review)
  --force                       Rebuild DB from scratch
  --deepseek <mode>             off | auto | required (default: auto)
  --deepseek-model <name>       Default: deepseek-chat
  --deepseek-key-file <path>    Override key location
  --max-llm-chunks <n>          Cap on chunks sent to DeepSeek (default: 100)
  --deepseek-concurrency <n>    Parallel API calls (default: 2)
  --no-claims                   Skip the deterministic claim extraction pass
  --llm-claims <mode>           off | auto | required (default: off in MVP)
  --max-llm-claim-chunks <n>    Cap on chunks sent to DS for claim extraction (default: 50)
  --no-wiki                     Skip the wiki pages pass`;

const VOICE_STRATIFY_USAGE = `usage: herta knowledge voice-stratify [options]

Options:
  --speaker <entityId>          Speaker entity to stratify (default: ${HERTA_PERSON_PRIME})
  --db <path>                   SQLite DB path (default: .herta/knowledge/herta-canon.sqlite)`;

const VOICE_RESTRATIFY_LLM_USAGE = `usage: herta knowledge voice-restratify-llm [options]

Options:
  --speaker <entityId>          Speaker entity. Default: ${HERTA_PERSON_PRIME}
  --db <path>                   SQLite DB path (default: .herta/knowledge/herta-canon.sqlite)
  --deepseek <mode>             off | auto | required (default: auto)
  --deepseek-model <name>       Default: deepseek-v4-pro
  --deepseek-key-file <path>    Override key location
  --dry-run                     Skip API calls + DB writes; print estimate
  --sample-docs <N>             Process first N docs only
  --budget-cap-usd <N>          Refuse to start if estimated cost exceeds N
  --abort-on-disagreement-rate <pct>   Abort when heuristic-vs-LLM rate exceeds (default: 20)`;

const DREAM_USAGE = `usage: herta knowledge dream [options]

Distill recent session episodes into live 废案 few-shot examples via
DeepSeek V4-Pro (chat, reasoning_effort max). Sessions are grouped by the
interaction language in their header (absent → zh) and one pass runs per
language: zh survivors promote into .herta/narrative/, en into
.herta/narrative-en/ (archives under the matching .herta/dream*/archive/).

Options:
  --workspace <path>          Workspace root to read sessions from (default: cwd)
  --all-workspaces            Include sessions from all workspaces
  --limit <N>                 Load at most N sessions (default: unbounded)
  --reconsider                Re-evaluate previously-skipped episodes
  --budget-cap-usd <N>        Abort if estimated cost exceeds N USD
  --dry-run                   Print estimate only; make no API calls
  --deepseek-model <name>     Default: deepseek-v4-pro
  --deepseek-key-file <path>  Override key location

Subcommands:
  dream list [--lang zh|en]         List live dream-created records (title + voice score)
  dream archive <id> [--lang zh|en] Archive a live dream-created record by id`;

const EXTRACT_SCENES_USAGE = `usage: herta knowledge extract-scenes [options]

Dump Herta's in-game conversations from the canon DB as JSONL — one
scene per line, each scene is a full document's chunk stream with
speaker labels and an isTarget flag on Herta's lines. Use for offline
curation of "interaction memory" sources.

Options:
  --speaker <entityId>          Target speaker (default: ${HERTA_PERSON_PRIME})
  --output <path>               JSONL output path (default: .herta/scenes/<speaker>.jsonl)
  --db <path>                   SQLite DB path
  --min-target-turns <N>        Drop scenes with fewer than N target lines (default: 1)
  --min-turns <N>               Drop scenes with fewer than N total turns (default: 2)
  --limit <N>                   Extract at most N scenes (default: unbounded)`;

const PERSONA_SEED_USAGE = `usage: herta knowledge persona-seed [options]

Options:
  --component <id|all>          Component to seed (or 'all'). Default: all
  --persona-dir <path>          Output directory (default: .herta/persona/)
  --db <path>                   SQLite DB path
  --deepseek <mode>             off | auto | required
  --deepseek-model <name>       Default: deepseek-v4-pro
  --deepseek-key-file <path>    Override key location
  --dry-run                     Skip API calls + writes; print estimate`;

export async function runKnowledgeCli(
  args: ReadonlyArray<string>,
  io: CliIo,
  deps: CliDeps = {},
): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h") {
    io.log(USAGE);
    return sub === undefined ? 1 : 0;
  }
  if (sub === "ingest") return runIngest(args.slice(1), io);
  if (sub === "persona-seed") return runPersonaSeed(args.slice(1), io, deps);
  if (sub === "voice-align") return runVoiceAlign(args.slice(1), io, deps);
  if (sub === "voice-stratify")
    return runVoiceStratify(args.slice(1), io, deps);
  if (sub === "voice-restratify-llm")
    return runVoiceRestratifyLlm(args.slice(1), io, deps);
  if (sub === "self-model") return runSelfModelSubcommand(args.slice(1), io);
  if (sub === "extract-scenes") return runExtractScenes(args.slice(1), io);
  if (sub === "glossary") return runGlossary(args.slice(1), io);
  if (sub === "dream") return runDreamSubcommand(args.slice(1), io, deps);
  io.err(`unknown subcommand: ${sub}`);
  io.err(USAGE);
  return 1;
}

async function runIngest(
  args: ReadonlyArray<string>,
  io: CliIo,
): Promise<number> {
  let dataRoot = defaultDataDir(io.cwd);
  let dbPath: string | undefined;
  let reviewDir: string | undefined;
  let force = false;
  let deepseek: "off" | "auto" | "required" = "auto";
  let deepseekModel = "deepseek-chat";
  let deepseekKeyFile: string | undefined;
  let maxLlmChunks = 100;
  let deepseekConcurrency = 2;
  let extractClaims = true;
  let buildWiki = true;
  let llmClaimsMode: "off" | "auto" | "required" = "off";
  let maxLlmClaimChunks = 50;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      io.log(INGEST_USAGE);
      return 0;
    }
    if (a === "--force") {
      force = true;
      continue;
    }
    if (a === "--no-claims") {
      extractClaims = false;
      continue;
    }
    if (a === "--no-wiki") {
      buildWiki = false;
      continue;
    }
    const next = args[i + 1];
    if (a === "--data-root" && next !== undefined) {
      dataRoot = resolve(io.cwd, next);
      i += 1;
      continue;
    }
    if (a === "--db" && next !== undefined) {
      dbPath = resolve(io.cwd, next);
      i += 1;
      continue;
    }
    if (a === "--review-out" && next !== undefined) {
      reviewDir = resolve(io.cwd, next);
      i += 1;
      continue;
    }
    if (a === "--deepseek" && next !== undefined) {
      if (next !== "off" && next !== "auto" && next !== "required") {
        io.err(`--deepseek expects off|auto|required; got: ${next}`);
        return 2;
      }
      deepseek = next;
      i += 1;
      continue;
    }
    if (a === "--deepseek-model" && next !== undefined) {
      deepseekModel = next;
      i += 1;
      continue;
    }
    if (a === "--deepseek-key-file" && next !== undefined) {
      deepseekKeyFile = resolve(io.cwd, next);
      i += 1;
      continue;
    }
    if (a === "--max-llm-chunks" && next !== undefined) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 0) {
        io.err(`--max-llm-chunks expects a non-negative integer; got: ${next}`);
        return 2;
      }
      maxLlmChunks = n;
      i += 1;
      continue;
    }
    if (a === "--deepseek-concurrency" && next !== undefined) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 1) {
        io.err(
          `--deepseek-concurrency expects a positive integer; got: ${next}`,
        );
        return 2;
      }
      deepseekConcurrency = n;
      i += 1;
      continue;
    }
    if (a === "--llm-claims" && next !== undefined) {
      if (next !== "off" && next !== "auto" && next !== "required") {
        io.err(`--llm-claims expects off|auto|required; got: ${next}`);
        return 2;
      }
      llmClaimsMode = next;
      i += 1;
      continue;
    }
    if (a === "--max-llm-claim-chunks" && next !== undefined) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 0) {
        io.err(
          `--max-llm-claim-chunks expects a non-negative integer; got: ${next}`,
        );
        return 2;
      }
      maxLlmClaimChunks = n;
      i += 1;
      continue;
    }
    io.err(`unknown option: ${a}`);
    io.err(INGEST_USAGE);
    return 2;
  }

  let llmConfig:
    | {
        client: import("../llm/types.js").DeepSeekClient;
        model: string;
        maxChunks: number;
        concurrency: number;
      }
    | undefined;
  if (deepseek !== "off") {
    const resolved = await resolveDeepSeekApiKey({
      workspaceRoot: io.cwd,
      keyFile: deepseekKeyFile,
    });
    if ("missing" in resolved) {
      if (deepseek === "required") {
        io.err(
          "DeepSeek API key required but not found. Set HERTA_DEEPSEEK_API_KEY, place a key at .herta/secrets/deepseek-api-key, or pass --deepseek-key-file.",
        );
        return 3;
      }
      io.log(
        "DeepSeek API key missing; --deepseek auto continuing in deterministic-only mode.",
      );
    } else {
      llmConfig = {
        client: new RealDeepSeekClient({
          apiKey: resolved.key,
          model: deepseekModel,
        }),
        model: deepseekModel,
        maxChunks: maxLlmChunks,
        concurrency: deepseekConcurrency,
      };
    }
  }

  let llmClaimsConfig:
    | {
        client: import("../llm/types.js").DeepSeekClient;
        model: string;
        maxChunks: number;
        concurrency: number;
      }
    | undefined;
  if (llmClaimsMode !== "off") {
    if (llmConfig === undefined) {
      if (llmClaimsMode === "required") {
        io.err(
          "--llm-claims required but no DeepSeek API key resolved. Set HERTA_DEEPSEEK_API_KEY, place a key at .herta/secrets/deepseek-api-key, or pass --deepseek-key-file.",
        );
        return 3;
      }
      io.log("--llm-claims auto: no DeepSeek key, skipping claim extraction.");
    } else {
      llmClaimsConfig = {
        client: llmConfig.client,
        model: llmConfig.model,
        maxChunks: maxLlmClaimChunks,
        concurrency: llmConfig.concurrency,
      };
    }
  }

  try {
    const result = await ingestCorpus({
      dataRoot,
      workspaceRoot: io.cwd,
      dbPath,
      reviewDir,
      force,
      llm: llmConfig,
      extractClaims,
      buildWiki,
      llmClaims: llmClaimsConfig,
    });
    const llmLine =
      result.llmClaims === undefined
        ? "skipped"
        : `${result.llmClaims.proposed} proposed / ${result.llmClaims.accepted} accepted / ${result.llmClaims.merged} merged / ${result.llmClaims.needsReview} needs_review / ${result.llmClaims.rejected} rejected`;
    io.log(
      `ingest: ${result.fileCount} files, ${result.chunkCount} chunks, ` +
        `${result.ambiguousMentions} ambiguous mentions, claims: ${result.claimsCount}, ` +
        `llm_claims: ${llmLine}, wiki: ${result.wikiPagesCount}`,
    );
    return 0;
  } catch (err) {
    io.err(`ingest failed: ${(err as Error).message}`);
    return 4;
  }
}

// ---------------------------------------------------------------------------
// voice-stratify
// ---------------------------------------------------------------------------

async function runVoiceStratify(
  args: ReadonlyArray<string>,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  let speakerEntityId = HERTA_PERSON_PRIME as string;
  let dbPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      io.log(VOICE_STRATIFY_USAGE);
      return 0;
    }
    const next = args[i + 1];
    if (a === "--speaker" && next !== undefined) {
      speakerEntityId = next;
      i += 1;
      continue;
    }
    if (a === "--db" && next !== undefined) {
      dbPath = resolve(io.cwd, next);
      i += 1;
      continue;
    }
    io.err(`unknown option: ${a}`);
    io.err(VOICE_STRATIFY_USAGE);
    return 2;
  }

  const resolvedDbPath = dbPath ?? defaultDbPath(io.cwd);
  const runner = deps.runStratifyPass ?? defaultRunStratifyPass;
  const store = SqliteKnowledgeStore.openOrCreate({ dbPath: resolvedDbPath });
  try {
    const result = await runner({ store, speakerEntityId });
    io.log(
      `voice-stratify: classified ${result.chunksClassified} chunks ` +
        `(player=${result.byClass.player}, ` +
        `other_named=${result.byClass.other_named}, ` +
        `self_narration=${result.byClass.self_narration}, ` +
        `unknown=${result.byClass.unknown})`,
    );
    return 0;
  } catch (err) {
    io.err(`voice-stratify failed: ${(err as Error).message}`);
    return 4;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// voice-align
// ---------------------------------------------------------------------------

const VOICE_ALIGN_USAGE = `usage: herta knowledge voice-align [options]

Resolve every stratified chunk of the speaker to its OFFICIAL localized
line via the aligned TextMaps and write chunk_translations rows
(EN interaction slice 2). Deterministic and offline; idempotent — re-run
after a corpus or TextMap refresh.

Options:
  --lang <tag>          Target language tag (default: en); the target file
                        is TextMap<TAG-uppercased>.json, e.g. en → TextMapEN.json
  --textmap-dir <path>  Directory holding the TextMaps (default: ./data/textmap)
  --db <path>           Knowledge DB (default: .herta/knowledge/herta-canon.sqlite)
  --speaker <entityId>  Speaker whose chunks get aligned (default: Herta)`;

async function runVoiceAlign(
  args: ReadonlyArray<string>,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  let speakerEntityId = HERTA_PERSON_PRIME as string;
  let dbPath: string | undefined;
  let textmapDir = defaultTextMapDir(io.cwd);
  let lang = "en";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      io.log(VOICE_ALIGN_USAGE);
      return 0;
    }
    const next = args[i + 1];
    if (a === "--speaker" && next !== undefined) {
      speakerEntityId = next;
      i += 1;
      continue;
    }
    if (a === "--db" && next !== undefined) {
      dbPath = resolve(io.cwd, next);
      i += 1;
      continue;
    }
    if (a === "--textmap-dir" && next !== undefined) {
      textmapDir = resolve(io.cwd, next);
      i += 1;
      continue;
    }
    if (a === "--lang" && next !== undefined) {
      lang = next;
      i += 1;
      continue;
    }
    io.err(`unknown option: ${a}`);
    io.err(VOICE_ALIGN_USAGE);
    return 2;
  }

  let cnMap: Record<string, string>;
  let targetMap: Record<string, string>;
  const targetFile = `TextMap${lang.toUpperCase()}.json`;
  try {
    cnMap = loadTextMap(join(textmapDir, TEXTMAP_CN_FILENAME));
    targetMap = loadTextMap(join(textmapDir, targetFile));
  } catch (e) {
    io.err(`failed to load TextMaps from ${textmapDir}: ${errorMessage(e)}`);
    io.err(
      `expected ${TEXTMAP_CN_FILENAME} + ${targetFile} — see textmap-glossary.ts for the upstream source`,
    );
    return 2;
  }

  const resolvedDbPath = dbPath ?? defaultDbPath(io.cwd);
  const runner = deps.runAlignPass ?? defaultRunAlignPass;
  const store = SqliteKnowledgeStore.openOrCreate({ dbPath: resolvedDbPath });
  try {
    const result = await runner({
      store,
      cnMap,
      targetMap,
      lang,
      speakerEntityId,
    });
    const pct =
      result.chunksSeen === 0
        ? "0.0"
        : ((result.aligned / result.chunksSeen) * 100).toFixed(1);
    io.log(
      `voice-align: ${result.aligned}/${result.chunksSeen} chunks aligned to ${lang} (${pct}%) ` +
        `(exact=${result.byMatchKind.exact}, normalized=${result.byMatchKind.normalized}, ` +
        `unmatched=${result.unmatched.length}, no_target_line=${result.noTargetLine.length})`,
    );
    return 0;
  } catch (err) {
    io.err(`voice-align failed: ${(err as Error).message}`);
    return 4;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// voice-restratify-llm
// ---------------------------------------------------------------------------

async function runVoiceRestratifyLlm(
  args: ReadonlyArray<string>,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.log(VOICE_RESTRATIFY_LLM_USAGE);
    return 0;
  }

  let speaker: string = HERTA_PERSON_PRIME;
  let dbPath: string | undefined;
  let deepseekMode: "off" | "auto" | "required" = "auto";
  let deepseekModel = "deepseek-v4-pro";
  let deepseekKeyFile: string | undefined;
  let dryRun = false;
  let sampleDocs: number | undefined;
  let budgetCapUsd: number | undefined;
  let abortRate = 0.2;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === "--speaker" && next !== undefined) {
      speaker = next;
      i += 1;
      continue;
    }
    if (a === "--db" && next !== undefined) {
      dbPath = resolve(io.cwd, next);
      i += 1;
      continue;
    }
    if (a === "--deepseek" && next !== undefined) {
      if (next !== "off" && next !== "auto" && next !== "required") {
        io.err(`--deepseek expects off|auto|required; got: ${next}`);
        return 2;
      }
      deepseekMode = next;
      i += 1;
      continue;
    }
    if (a === "--deepseek-model" && next !== undefined) {
      deepseekModel = next;
      i += 1;
      continue;
    }
    if (a === "--deepseek-key-file" && next !== undefined) {
      deepseekKeyFile = resolve(io.cwd, next);
      i += 1;
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--sample-docs" && next !== undefined) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n <= 0) {
        io.err(`--sample-docs expects a positive integer; got: ${next}`);
        return 2;
      }
      sampleDocs = n;
      i += 1;
      continue;
    }
    if (a === "--budget-cap-usd" && next !== undefined) {
      const v = Number.parseFloat(next);
      if (!Number.isFinite(v) || v < 0) {
        io.err(`--budget-cap-usd expects a non-negative number; got: ${next}`);
        return 2;
      }
      budgetCapUsd = v;
      i += 1;
      continue;
    }
    if (a === "--abort-on-disagreement-rate" && next !== undefined) {
      const pct = Number.parseInt(next, 10);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        io.err(`--abort-on-disagreement-rate expects 0..100; got: ${next}`);
        return 2;
      }
      abortRate = pct / 100;
      i += 1;
      continue;
    }
    io.err(`voice-restratify-llm: unknown option: ${a}`);
    return 2;
  }

  const resolvedDbPath = dbPath ?? defaultDbPath(io.cwd);
  const store = SqliteKnowledgeStore.openOrCreate({ dbPath: resolvedDbPath });

  try {
    // Estimate cost before resolving the client — needed for budget guard.
    const docs = store.listDocsContainingSpeakerChunks(speaker);
    const slice = sampleDocs !== undefined ? docs.slice(0, sampleDocs) : docs;
    const estCalls = slice.length * 2;
    const estCost = estimateCostUsd({
      model: deepseekModel,
      calls: estCalls,
      inputTokensPerCall: 30_000,
      outputTokensPerCall: 5_000,
    });
    io.log(
      `voice-restratify-llm: ${slice.length} docs, ~${estCalls} calls, est ${formatCostUsd(estCost)}${dryRun ? " [dry-run estimate]" : ""}.`,
    );

    if (budgetCapUsd !== undefined && estCost > budgetCapUsd) {
      io.err(
        `voice-restratify-llm: estimated ${formatCostUsd(estCost)} exceeds budget cap ${formatCostUsd(budgetCapUsd)}; aborting.`,
      );
      return 2;
    }

    // Resolve client. When --dry-run, skip key resolution entirely.
    let client: DeepSeekClient;
    if (dryRun) {
      client = {
        chatJson: async () => {
          throw new Error("dry-run: no API calls expected");
        },
      };
    } else if (deepseekMode === "off") {
      io.log(
        "voice-restratify-llm: --deepseek off; skipping (this pass requires the LLM).",
      );
      return 0;
    } else {
      const resolved = await resolveDeepSeekClient({
        io,
        deepseek: deepseekMode,
        deepseekModel,
        deepseekKeyFile,
        contextLabel: "voice-restratify-llm",
        deps,
      });
      if (resolved === undefined) return 3;
      client = resolved;
    }

    const runner = deps.runRestratifyLlmPass ?? defaultRunRestratifyLlmPass;
    const result = await runner({
      store,
      client,
      speakerEntityId: speaker as CanonEntityId,
      abortOnDisagreementRate: abortRate,
      sampleDocs,
      dryRun,
    });

    io.log(
      `voice-restratify-llm: docs=${result.docsProcessed} consensus=${result.chunksWithConsensus} disagreement=${result.chunksWithDisagreement} disagreement-vs-heuristic=${result.disagreementWithHeuristic} (rate=${(result.disagreementRate * 100).toFixed(1)}%)${result.aborted ? " [ABORTED]" : ""}${dryRun ? " [DRY-RUN]" : ""}.`,
    );
    return result.aborted ? 3 : 0;
  } catch (err) {
    io.err(`voice-restratify-llm failed: ${(err as Error).message}`);
    return 4;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// persona-seed
// ---------------------------------------------------------------------------

function sampleCanonContextForPersona(store: SqliteKnowledgeStore): string {
  // Access the underlying better-sqlite3 db via a type cast, since the
  // public SqliteKnowledgeStore API doesn't expose a generic query surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
  const rows = db
    .prepare(
      `SELECT c.text, s.addressee_class, s.addressee_entity_id, s.mood, s.register_mode
         FROM chunks c
         JOIN voice_evidence_strata s ON s.chunk_id = c.id
        WHERE c.speaker_entity_id = 'herta.person.prime'
          AND s.source IN ('consensus', 'disagreement')
        ORDER BY c.id`,
    )
    .all() as Array<{
    text: string;
    addressee_class: string;
    addressee_entity_id: string | null;
    mood: string | null;
    register_mode: string | null;
  }>;
  const byClass: Record<string, typeof rows> = {
    player: [],
    other_named: [],
    unknown: [],
  };
  for (const r of rows) {
    const k = byClass[r.addressee_class] ?? byClass.unknown;
    if (k) k.push(r);
  }
  function take<T>(arr: T[], n: number): T[] {
    if (arr.length <= n) return arr;
    const step = arr.length / n;
    const out: T[] = [];
    for (let i = 0; i < n; i++) {
      const item = arr[Math.floor(i * step)];
      if (item !== undefined) out.push(item);
    }
    return out;
  }
  const sample = [
    ...take(byClass.player ?? [], 80),
    ...take(byClass.other_named ?? [], 30),
    ...take(byClass.unknown ?? [], 20),
  ];
  const wiki = db
    .prepare(
      `SELECT content_json FROM wiki_pages WHERE entity_id = 'herta.person.prime' LIMIT 1`,
    )
    .all() as Array<{ content_json: string }>;
  const lines = sample.map(
    (r) =>
      `[${r.addressee_class}${r.addressee_entity_id ? `:${r.addressee_entity_id}` : ""}${r.mood ? ` mood=${r.mood}` : ""}] ${r.text}`,
  );
  const firstWiki = wiki[0];
  if (firstWiki !== undefined) {
    lines.push("---wiki---");
    lines.push(firstWiki.content_json);
  }
  return lines.join("\n");
}

async function runPersonaSeed(
  args: ReadonlyArray<string>,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.log(PERSONA_SEED_USAGE);
    return 0;
  }

  let component = "all";
  let personaDir: string | undefined;
  let dbPath: string | undefined;
  let deepseekMode: "off" | "auto" | "required" = "auto";
  let deepseekModel = "deepseek-v4-pro";
  let deepseekKeyFile: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === "--component" && next !== undefined) {
      component = next;
      i++;
      continue;
    }
    if (a === "--persona-dir" && next !== undefined) {
      personaDir = resolve(io.cwd, next);
      i++;
      continue;
    }
    if (a === "--db" && next !== undefined) {
      dbPath = resolve(io.cwd, next);
      i++;
      continue;
    }
    if (a === "--deepseek" && next !== undefined) {
      if (next !== "off" && next !== "auto" && next !== "required") {
        io.err(`--deepseek expects off|auto|required; got: ${next}`);
        return 2;
      }
      deepseekMode = next;
      i++;
      continue;
    }
    if (a === "--deepseek-model" && next !== undefined) {
      deepseekModel = next;
      i++;
      continue;
    }
    if (a === "--deepseek-key-file" && next !== undefined) {
      deepseekKeyFile = resolve(io.cwd, next);
      i++;
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    io.err(`persona-seed: unknown option: ${a}`);
    return 2;
  }

  // Resolve the component(s) to seed.
  // PersonaStore + components moved into @herta/knowledge in Slice 7a;
  // these are now real imports at the top of this file (see import block).
  let targets: ReadonlyArray<PersonaComponentSpec>;
  if (component === "all") {
    targets = PERSONA_COMPONENTS;
  } else {
    const spec = getPersonaComponent(component);
    if (!spec) {
      io.err(`persona-seed: unknown component "${component}"`);
      return 2;
    }
    targets = [spec];
  }

  const resolvedDbPath = dbPath ?? defaultDbPath(io.cwd);
  const store = SqliteKnowledgeStore.openOrCreate({
    dbPath: resolvedDbPath,
    readonly: true,
  });
  let exit = 0;
  try {
    const canon = sampleCanonContextForPersona(store);
    io.log(
      `persona-seed: ${targets.length} components, canon context ${canon.length} chars${dryRun ? " [dry-run]" : ""}.`,
    );
    if (dryRun) return 0;

    if (deepseekMode === "off") {
      io.err("persona-seed: --deepseek off; this pass requires the LLM.");
      return 2;
    }

    const client = await resolveDeepSeekClient({
      io,
      deepseek: deepseekMode,
      deepseekModel,
      deepseekKeyFile,
      contextLabel: "persona-seed",
      deps,
    });
    if (client === undefined) return 3;

    const root =
      personaDir ?? resolve(io.cwd ?? process.cwd(), ".herta", "persona");
    const personaStore = new PersonaStore({ root });
    for (const spec of targets) {
      const systemPrompt = spec.seedPrompt(canon);
      let resp: import("../llm/types.js").DeepSeekChatResponse;
      try {
        resp = await client.chatJson({
          systemPrompt,
          userPayload: "{}",
          model: deepseekModel,
        });
      } catch (err) {
        io.err(
          `persona-seed: ${spec.id} API call failed: ${(err as Error).message}`,
        );
        exit = 4;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(resp.rawJsonText);
      } catch (err) {
        io.err(
          `persona-seed: ${spec.id} response not JSON: ${(err as Error).message}`,
        );
        exit = 4;
        continue;
      }
      const v = spec.validate(parsed);
      if (!v.ok) {
        io.err(
          `persona-seed: ${spec.id} validation failed: ${(v.errors ?? []).join("; ")}`,
        );
        exit = 4;
        continue;
      }
      personaStore.save(spec.id, v.value);
      io.log(`persona-seed: ${spec.id} written to ${root}/${spec.id}.json`);
    }
  } finally {
    store.close();
  }
  return exit;
}

// ---------------------------------------------------------------------------
// extract-scenes
// ---------------------------------------------------------------------------

const GLOSSARY_USAGE = `usage: herta knowledge glossary <query> [options]

Look up official CN↔EN localization pairs in the aligned TextMaps
(EN interaction-language slice 1). Shortest matches print first — for a
term query that is usually the canonical name entry, with dialogue
usages after it. Cite the printed hash as evidence in canonical-terms.

Options:
  --textmap-dir <path>  Directory holding TextMapCHS.json + TextMapEN.json
                        (default: ./data/textmap — gitignored corpus, see
                        the module header of textmap-glossary.ts for the
                        upstream source)
  --limit <n>           Maximum hits (default: 10)
  --exact               Full-string match instead of substring
  --en                  Match the query against the EN side (case-insensitive)`;

async function runGlossary(
  args: ReadonlyArray<string>,
  io: CliIo,
): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.log(GLOSSARY_USAGE);
    return args.length === 0 ? 2 : 0;
  }
  let query: string | undefined;
  let textmapDir = defaultTextMapDir(io.cwd);
  let limit = 10;
  let exact = false;
  let side: "cn" | "en" = "cn";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === "--textmap-dir" && next !== undefined) {
      textmapDir = resolve(io.cwd, next);
      i += 1;
      continue;
    }
    if (a === "--limit" && next !== undefined) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 1) {
        io.err(`--limit expects a positive integer; got: ${next}`);
        return 2;
      }
      limit = n;
      i += 1;
      continue;
    }
    if (a === "--exact") {
      exact = true;
      continue;
    }
    if (a === "--en") {
      side = "en";
      continue;
    }
    if (a?.startsWith("--")) {
      io.err(`unknown option: ${a}`);
      return 2;
    }
    if (query !== undefined) {
      io.err(`expected one query; got a second: ${a}`);
      return 2;
    }
    query = a;
  }
  if (query === undefined) {
    io.err("missing query");
    io.log(GLOSSARY_USAGE);
    return 2;
  }
  let cnMap: Record<string, string>;
  let enMap: Record<string, string>;
  try {
    cnMap = loadTextMap(join(textmapDir, TEXTMAP_CN_FILENAME));
    enMap = loadTextMap(join(textmapDir, TEXTMAP_EN_FILENAME));
  } catch (e) {
    io.err(`failed to load TextMaps from ${textmapDir}: ${errorMessage(e)}`);
    io.err(
      "expected TextMapCHS.json + TextMapEN.json — see textmap-glossary.ts for the upstream source",
    );
    return 2;
  }
  const hits = searchAlignedTerms(cnMap, enMap, query, { limit, exact, side });
  if (hits.length === 0) {
    io.log(`no matches for: ${query}`);
    return 0;
  }
  for (const hit of hits) {
    io.log(`[${hit.hash}]`);
    io.log(`  CN: ${hit.cn}`);
    io.log(`  EN: ${hit.en ?? "<missing in EN map>"}`);
  }
  io.log(`${hits.length} match(es)`);
  return 0;
}

async function runExtractScenes(
  args: ReadonlyArray<string>,
  io: CliIo,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.log(EXTRACT_SCENES_USAGE);
    return 0;
  }

  let speaker: string = HERTA_PERSON_PRIME;
  let dbPath: string | undefined;
  let outputPath: string | undefined;
  let minTargetTurns = 1;
  let minTurns = 2;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === "--speaker" && next !== undefined) {
      speaker = next;
      i += 1;
      continue;
    }
    if (a === "--output" && next !== undefined) {
      outputPath = resolve(io.cwd, next);
      i += 1;
      continue;
    }
    if (a === "--db" && next !== undefined) {
      dbPath = resolve(io.cwd, next);
      i += 1;
      continue;
    }
    if (a === "--min-target-turns" && next !== undefined) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 0) {
        io.err(
          `--min-target-turns expects a non-negative integer; got: ${next}`,
        );
        return 2;
      }
      minTargetTurns = n;
      i += 1;
      continue;
    }
    if (a === "--min-turns" && next !== undefined) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 0) {
        io.err(`--min-turns expects a non-negative integer; got: ${next}`);
        return 2;
      }
      minTurns = n;
      i += 1;
      continue;
    }
    if (a === "--limit" && next !== undefined) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n <= 0) {
        io.err(`--limit expects a positive integer; got: ${next}`);
        return 2;
      }
      limit = n;
      i += 1;
      continue;
    }
    io.err(`extract-scenes: unknown option: ${a}`);
    return 2;
  }

  const resolvedDbPath = dbPath ?? defaultDbPath(io.cwd);
  const speakerSlug = speaker.replace(/[^a-z0-9.-]+/gi, "_");
  const resolvedOutputPath =
    outputPath ?? resolve(io.cwd, ".herta", "scenes", `${speakerSlug}.jsonl`);

  const store = SqliteKnowledgeStore.openOrCreate({
    dbPath: resolvedDbPath,
    readonly: true,
  });
  try {
    const sceneOpts: import("../retrieval/extract-scenes.js").ExtractScenesOpts =
      {
        targetEntityId: speaker,
        minTargetTurns,
        minTurns,
      };
    if (limit !== undefined) sceneOpts.limit = limit;
    const { extractHertaScenes } = await import(
      "../retrieval/extract-scenes.js"
    );
    const scenes = extractHertaScenes(store, sceneOpts);

    mkdirSync(resolve(resolvedOutputPath, ".."), { recursive: true });
    const body = scenes.map((s) => JSON.stringify(s)).join("\n");
    writeFileSync(
      resolvedOutputPath,
      body.length > 0 ? `${body}\n` : "",
      "utf8",
    );
    const totalTurns = scenes.reduce((n, s) => n + s.turns.length, 0);
    const targetTurns = scenes.reduce((n, s) => n + s.targetTurnCount, 0);
    io.log(
      `extract-scenes: wrote ${scenes.length} scenes (${targetTurns} ${speaker} turns, ${totalTurns} total turns) → ${resolvedOutputPath}`,
    );
    return 0;
  } catch (err) {
    io.err(`extract-scenes failed: ${(err as Error).message}`);
    return 4;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// dream / dream list / dream archive
// ---------------------------------------------------------------------------

const CALLS_PER_EPISODE =
  1 /*worthiness*/ +
  1 /*generate*/ +
  2 /*refine max*/ +
  1 /*similarity*/ +
  1 /*critique*/;

/**
 * Pre-flight cost estimate for a dream run.
 *
 * Pure function; tested in herta-knowledge.dream.test.ts.
 */
export function planDreamRun(input: {
  episodeCount: number;
  budgetCapUsd?: number;
  model?: string;
}): { estimatedCalls: number; estimatedUsd: number; withinBudget: boolean } {
  const model = input.model ?? "deepseek-v4-pro";
  const estimatedCalls = input.episodeCount * CALLS_PER_EPISODE;
  // Rough per-call token budget including thinking output.
  const estimatedUsd = estimateCostUsd({
    model,
    calls: estimatedCalls,
    inputTokensPerCall: 4000,
    outputTokensPerCall: 3000,
  });
  return {
    estimatedCalls,
    estimatedUsd,
    withinBudget:
      input.budgetCapUsd === undefined || estimatedUsd <= input.budgetCapUsd,
  };
}

async function runDreamSubcommand(
  args: ReadonlyArray<string>,
  io: CliIo,
  deps: CliDeps,
): Promise<number> {
  // dispatch to `dream list` / `dream archive <id>`
  // Resolve workspace early so list/archive read the correct manifest.
  // We need to scan the remaining args for --workspace before dispatching.
  let earlyWorkspace: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace" && args[i + 1] !== undefined) {
      earlyWorkspace = resolve(io.cwd, args[i + 1] as string);
      break;
    }
  }
  const resolvedWorkspaceRoot = earlyWorkspace ?? io.cwd;
  if (args[0] === "list")
    return runDreamList(args.slice(1), io, resolvedWorkspaceRoot);
  if (args[0] === "archive")
    return runDreamArchive(args.slice(1), io, resolvedWorkspaceRoot);
  if (args[0] === "--help" || args[0] === "-h") {
    io.log(DREAM_USAGE);
    return 0;
  }

  // --- main `dream` run ---
  let workspace: string | undefined;
  let allWorkspaces = false;
  let limit: number | undefined;
  let reconsider = false;
  let budgetCapUsd: number | undefined;
  let dryRun = false;
  let deepseekModel = "deepseek-v4-pro";
  let deepseekKeyFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === "--help" || a === "-h") {
      io.log(DREAM_USAGE);
      return 0;
    }
    if (a === "--all-workspaces") {
      allWorkspaces = true;
      continue;
    }
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a === "--reconsider") {
      reconsider = true;
      continue;
    }
    if (a === "--workspace" && next !== undefined) {
      workspace = resolve(io.cwd, next);
      i += 1;
      continue;
    }
    if (a === "--limit" && next !== undefined) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n <= 0) {
        io.err(`--limit expects a positive integer; got: ${next}`);
        return 2;
      }
      limit = n;
      i += 1;
      continue;
    }
    if (a === "--budget-cap-usd" && next !== undefined) {
      const v = Number.parseFloat(next);
      if (!Number.isFinite(v) || v < 0) {
        io.err(`--budget-cap-usd expects a non-negative number; got: ${next}`);
        return 2;
      }
      budgetCapUsd = v;
      i += 1;
      continue;
    }
    if (a === "--deepseek-model" && next !== undefined) {
      deepseekModel = next;
      i += 1;
      continue;
    }
    if (a === "--deepseek-key-file" && next !== undefined) {
      deepseekKeyFile = resolve(io.cwd, next);
      i += 1;
      continue;
    }
    io.err(`dream: unknown option: ${a}`);
    io.err(DREAM_USAGE);
    return 2;
  }

  const workspaceRoot = workspace ?? io.cwd;
  const transcriptDir = join(workspaceRoot, ".herta", "transcript", "v2");

  // Enumerate sessions.
  const sessionEntries = listSessions({
    transcriptDir,
    currentWorkspaceRoot: workspaceRoot,
    allWorkspaces,
    limit: Number.POSITIVE_INFINITY,
  });

  // Load session records (errors in individual files are tolerated), keeping
  // the interaction language each session was CREATED under (header meta.lang;
  // absent → "zh" — every pre-persistence session is Chinese). The pass below
  // runs once per language, mirroring the app-server dream trigger: each
  // language grows its OWN 废案 corpus from ONLY its own sessions. A lang-less
  // pass over a mixed workspace distilled EN episodes with the zh bundle into
  // the zh corpus AND left the EN manifest without dedup entries, so the
  // trigger's later EN pass re-dreamed the same episodes (ADR 0014).
  const sessions: {
    sessionId: string;
    record: import("@herta/core").TerminalRecord;
    lang: "zh" | "en";
  }[] = [];
  for (const entry of sessionEntries) {
    try {
      const { record, meta } = readSessionFile(entry.sessionFile);
      sessions.push({
        sessionId: entry.sessionId,
        record,
        lang: meta.lang ?? "zh",
      });
    } catch {
      // skip malformed sessions
    }
  }

  // Count candidate episodes (not sessions) for an accurate budget estimate.
  // segmentSession + selectEpisodes are deterministic (no LLM), so this is cheap.
  const dreamCfg = resolveDreamConfig(undefined);
  const loadedSessions =
    limit !== undefined ? sessions.slice(0, limit) : sessions;
  let candidateEpisodeCount = 0;
  for (const s of loadedSessions) {
    // Clock threaded so the estimate counts trailing-silence-settled tails
    // (ADR 0024) exactly like the real pass does.
    const episodes = segmentSession(
      s.sessionId,
      s.record,
      dreamCfg,
      Date.now(),
    );
    candidateEpisodeCount += selectEpisodes(episodes, dreamCfg).length;
  }

  const plan = planDreamRun({
    episodeCount: candidateEpisodeCount,
    budgetCapUsd,
    model: deepseekModel,
  });

  io.log(
    `dream: ${sessions.length} sessions, ${candidateEpisodeCount} candidate episodes, ~${plan.estimatedCalls} estimated calls, est ${formatCostUsd(plan.estimatedUsd)}${dryRun ? " [dry-run]" : ""}`,
  );

  if (!plan.withinBudget) {
    io.err(
      `dream: estimated ${formatCostUsd(plan.estimatedUsd)} exceeds budget cap ${formatCostUsd(budgetCapUsd ?? 0)}; aborting.`,
    );
    return 2;
  }

  if (dryRun) {
    io.log("dream: dry-run; no API calls made.");
    return 0;
  }

  // Resolve the DeepSeek client.
  const client = await resolveDeepSeekClient({
    io,
    deepseek: "auto",
    deepseekModel,
    deepseekKeyFile,
    contextLabel: "dream",
    deps,
  });
  if (client === undefined) return 3;

  const runId = `${Date.now()}`;

  // One pass per language present, zh first for a stable order (matches the
  // app-server trigger's per-language passes; sequential so the two passes
  // never contend for the shared client). Each pass targets its own
  // narrative/dream dirs via runDreamPass's `lang`.
  const dreamRunner = deps.runDreamPass ?? defaultRunDreamPass;
  let anyAborted = false;
  for (const lang of ["zh", "en"] as const) {
    const group = loadedSessions
      .filter((s) => s.lang === lang)
      .map(({ sessionId, record }) => ({ sessionId, record }));
    if (group.length === 0) continue;
    let result: RunDreamPassResult;
    try {
      result = await dreamRunner({
        workspaceRoot,
        sessions: group,
        client,
        runId: `${runId}-${lang}`,
        reconsider,
        lang,
      });
    } catch (err) {
      io.err(`dream[${lang}]: pass failed: ${(err as Error).message}`);
      return 4;
    }

    if (result.lockBusy === true) {
      io.log(`Dream[${lang}]: another pass holds the lock — skipped`);
      continue;
    }

    io.log(
      `Dream[${lang}]: promoted ${result.promoted} · reinforced ${result.reinforced} · ` +
        `reconsolidated ${result.reconsolidated} · skipped ${result.skipped} · archived ${result.archived}` +
        ` · echo ${result.echoReinforced}`,
    );
    if (result.aborted !== undefined) {
      io.err(
        `dream[${lang}]: pass aborted early (${result.aborted}); unconsumed episodes retry next pass`,
      );
      anyAborted = true;
    }
  }
  return anyAborted ? 4 : 0;
}

/** Parse a trailing `--lang zh|en` (default zh — the pre-split corpus).
 *  Returns undefined (after printing) on an invalid value. */
function parseDreamLang(
  args: ReadonlyArray<string>,
  io: CliIo,
): "zh" | "en" | undefined {
  const i = args.indexOf("--lang");
  if (i === -1) return "zh";
  const v = args[i + 1];
  if (v !== "zh" && v !== "en") {
    io.err(`--lang expects zh or en; got: ${v ?? "(missing)"}`);
    return undefined;
  }
  return v;
}

async function runDreamList(
  args: ReadonlyArray<string>,
  io: CliIo,
  workspaceRoot: string,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.log("usage: herta knowledge dream list [--lang zh|en]");
    return 0;
  }
  const lang = parseDreamLang(args, io);
  if (lang === undefined) return 2;
  const dreamDir = dreamDirFor(workspaceRoot, lang);
  const manifest = readManifest(dreamDir);
  const live = liveDreamRecords(manifest);
  if (live.length === 0) {
    io.log("dream list: no live dream-created records.");
    return 0;
  }
  for (const r of live) {
    const header = parseFeianHeader(r.file.replace(/\.txt$/, ""));
    const title = header?.title ?? r.file;
    io.log(
      `[${r.id}] ${title}  voice=${r.critiqueScores.voice.toFixed(2)}  ${r.generatedAt.slice(0, 10)}`,
    );
  }
  return 0;
}

async function runDreamArchive(
  args: ReadonlyArray<string>,
  io: CliIo,
  workspaceRoot: string,
): Promise<number> {
  const id = args[0];
  if (id === undefined || id === "--help" || id === "-h") {
    io.log("usage: herta knowledge dream archive <id> [--lang zh|en]");
    return id === undefined ? 1 : 0;
  }
  const lang = parseDreamLang(args, io);
  if (lang === undefined) return 2;
  const dreamDir = dreamDirFor(workspaceRoot, lang);
  const narrativeDir = narrativeDirFor(workspaceRoot, lang);
  const manifest = readManifest(dreamDir);
  const rec = manifest.created.find((r) => r.id === id);
  if (rec === undefined) {
    io.err(`dream archive: no record with id "${id}"`);
    return 2;
  }
  if (rec.state === "archived") {
    io.err(`dream archive: record "${id}" is already archived`);
    return 2;
  }
  try {
    archiveLiveRecord({
      narrativeDir,
      dreamDir,
      file: rec.file,
      reason: "manual archive via CLI",
    });
  } catch (err) {
    io.err(`dream archive: failed to move file: ${(err as Error).message}`);
    return 4;
  }
  // Flip state in manifest (the manifest uses readonly so rebuild the array).
  manifest.created = manifest.created.map((r) =>
    r.id === id ? { ...r, state: "archived" as const } : r,
  ) as typeof manifest.created;
  writeManifest(dreamDir, manifest);
  io.log(`dream archive: archived record "${id}" (${rec.file})`);
  return 0;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

interface ResolveClientArgs {
  io: CliIo;
  deepseek: "auto" | "required";
  deepseekModel: string;
  deepseekKeyFile?: string;
  contextLabel: string;
  deps: CliDeps;
}

/**
 * Resolve a DeepSeek client honoring the auto/required/off flag pattern.
 *
 * Returns:
 *  - the {@link DeepSeekClient} on success;
 *  - `undefined` when the key was required but missing — the caller exits 3.
 *
 * `--deepseek auto` with a missing key is treated as a hard failure here
 * (returns undefined → caller exits 3) because R1/R2 cannot produce useful
 * output without the LLM. Use `--deepseek off` to short-circuit the command
 * entirely.
 */
async function resolveDeepSeekClient(
  args: ResolveClientArgs,
): Promise<DeepSeekClient | undefined> {
  const resolved = await resolveDeepSeekApiKey({
    workspaceRoot: args.io.cwd,
    keyFile: args.deepseekKeyFile,
  });
  if ("missing" in resolved) {
    args.io.err(
      `${args.contextLabel}: DeepSeek API key required but not found. ` +
        "Set HERTA_DEEPSEEK_API_KEY, place a key at .herta/secrets/deepseek-api-key, " +
        "or pass --deepseek-key-file. (Use --deepseek off to skip the LLM pass entirely.)",
    );
    return undefined;
  }
  const factory =
    args.deps.makeDeepSeekClient ??
    ((apiKey: string, model: string) =>
      new RealDeepSeekClient({ apiKey, model }));
  return factory(resolved.key, args.deepseekModel);
}
