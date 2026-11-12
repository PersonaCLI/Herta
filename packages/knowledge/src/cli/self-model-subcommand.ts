import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { estimateCostUsd, formatCostUsd } from "../llm/cost-estimator.js";
import { RealDeepSeekClient } from "../llm/deepseek-client.js";
import type { DeepSeekClient } from "../llm/types.js";
import { defaultDbPath } from "../paths.js";
import { HERTA_PERSON_PRIME } from "../schema.js";
import {
  type CorpusManifest,
  corpusManifestSchema,
  type HertaFacts,
  type HertaSelfModelV1,
  hertaFactsSchema,
  hertaSelfModelV1Schema,
  runCleanPass,
  runExpandCorpusPass,
  runExtractPass,
  runJudgePass,
  runProgrammaticChecks,
  runSynthesizePass,
} from "../self-model/index.js";
import { SqliteKnowledgeStore } from "../store/sqlite-knowledge-store.js";

export interface SelfModelCliIo {
  cwd: string;
  log: (line: string) => void;
  err: (line: string) => void;
}

export interface SelfModelCliDeps {
  /** Test-only: build a DeepSeek client from a key + model. */
  makeDeepSeekClient?: (apiKey: string, model: string) => DeepSeekClient;
}

export const SELF_MODEL_USAGE = `usage: herta knowledge self-model <subcommand> [options]

Subcommands:
  clean             Pass 0  — clean HTML files into plain text
  expand-corpus     Pass 0.5 — grep canon for Herta mentions, write manifest
  extract           Pass 1  — DS V4 Pro fact extraction (per accepted file)
  synthesize        Pass 2  — DS V4 Pro synthesis (single call)
  validate          Pass 3a + 3b — programmatic checks + LLM-judge
  build             Run Passes 0 → 3b in sequence (recommended)
  judge             Pass 3b only — re-run LLM-judge against existing self-model
  ship              Pass 4  — gate on Pass 3a, then insert self-model into DB

Common options:
  --dry-run         Print cost preview, exit without making API calls
  --confirm         (alias for default behavior; the command runs unless --dry-run)
  --data-root <p>   Canon corpus root (default: ./data)
  --model <name>    DeepSeek model (default: deepseek-v4-pro)
  --concurrency <n> Pass 1 parallel calls (default: 4)

Run 'herta knowledge self-model <sub> --help' for per-sub options.`;

interface SelfModelPaths {
  dataRoot: string;
  cleanedDir: string;
  cacheDir: string;
  manifestPath: string;
  factsPath: string;
  selfModelPath: string;
  judgeReportPath: string;
  dbPath: string;
}

function defaultPaths(cwd: string): SelfModelPaths {
  return {
    dataRoot: resolve(cwd, "data"),
    cleanedDir: resolve(cwd, ".herta/canon/cleaned"),
    cacheDir: resolve(cwd, ".herta/cache/self-model"),
    manifestPath: resolve(cwd, ".herta/canon/corpus-manifest.json"),
    factsPath: resolve(cwd, ".herta/self-model/herta_facts.json"),
    selfModelPath: resolve(cwd, ".herta/self-model/herta_self_model_v1.json"),
    judgeReportPath: resolve(cwd, ".herta/self-model/judge_report.json"),
    dbPath: defaultDbPath(cwd),
  };
}

interface CommonFlags {
  dryRun: boolean;
  model: string;
  paths: SelfModelPaths;
  help: boolean;
  concurrency: number;
}

function parseCommonFlags(
  args: ReadonlyArray<string>,
  cwd: string,
): CommonFlags {
  const paths = defaultPaths(cwd);
  let dryRun = false;
  let model = "deepseek-v4-pro";
  let help = false;
  let concurrency = 4;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--confirm") {
      /* default behavior; flag accepted as a no-op for symmetry */
    } else if (a === "--help" || a === "-h") help = true;
    else if (a === "--data-root" && args[i + 1] !== undefined) {
      paths.dataRoot = resolve(cwd, args[++i] as string);
    } else if (a === "--model" && args[i + 1] !== undefined) {
      model = args[++i] as string;
    } else if (a === "--concurrency" && args[i + 1] !== undefined) {
      const next = args[++i] as string;
      const n = Number.parseInt(next, 10);
      if (Number.isFinite(n) && n >= 1) concurrency = n;
    }
  }
  return { dryRun, model, paths, help, concurrency };
}

export async function runSelfModelSubcommand(
  args: ReadonlyArray<string>,
  io: SelfModelCliIo,
  deps: SelfModelCliDeps = {},
): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h") {
    io.log(SELF_MODEL_USAGE);
    return sub === undefined ? 1 : 0;
  }
  const rest = args.slice(1);
  switch (sub) {
    case "clean":
      return runCleanCommand(rest, io);
    case "expand-corpus":
      return runExpandCorpusCommand(rest, io);
    case "extract":
      return runExtractCommand(rest, io, deps);
    case "synthesize":
      return runSynthesizeCommand(rest, io, deps);
    case "validate":
      return runValidateCommand(rest, io, deps);
    case "build":
      return runBuildCommand(rest, io, deps);
    case "judge":
      return runJudgeCommand(rest, io, deps);
    case "ship":
      return runShipCommand(rest, io);
    default:
      io.err(`unknown self-model subcommand: ${sub}`);
      io.err(SELF_MODEL_USAGE);
      return 1;
  }
}

// ─── Pass 0: clean ───────────────────────────────────────────────────

async function runCleanCommand(
  args: ReadonlyArray<string>,
  io: SelfModelCliIo,
): Promise<number> {
  const flags = parseCommonFlags(args, io.cwd);
  if (flags.help) {
    io.log("usage: herta knowledge self-model clean [--data-root <p>]");
    return 0;
  }
  const manifest = readManifestOrEmpty(flags.paths.manifestPath);
  const sources = manifest.candidates
    .filter((c) => c.accepted)
    .map((c) => resolve(io.cwd, c.path));
  if (sources.length === 0) {
    io.err(
      "no accepted candidates in manifest — run `expand-corpus` first and edit accepted flags.",
    );
    return 1;
  }
  io.log(`cleaning ${sources.length} files...`);
  const result = await runCleanPass({
    sources,
    outDir: flags.paths.cleanedDir,
    cacheDir: flags.paths.cacheDir,
  });
  let fresh = 0;
  let cached = 0;
  let fallback = 0;
  for (const c of result.cleaned) {
    if (c.cacheHit) cached += 1;
    else fresh += 1;
    if (c.usedFallback) fallback += 1;
  }
  io.log(
    `done — ${fresh} fresh, ${cached} from cache, ${fallback} via br-fallback`,
  );
  return 0;
}

// ─── Pass 0.5: expand-corpus ─────────────────────────────────────────

async function runExpandCorpusCommand(
  args: ReadonlyArray<string>,
  io: SelfModelCliIo,
): Promise<number> {
  const flags = parseCommonFlags(args, io.cwd);
  if (flags.help) {
    io.log("usage: herta knowledge self-model expand-corpus [--data-root <p>]");
    return 0;
  }
  io.log(`scanning corpus at ${flags.paths.dataRoot}...`);
  const manifest = await runExpandCorpusPass({
    corpusRoot: flags.paths.dataRoot,
    manifestPath: flags.paths.manifestPath,
  });
  const accepted = manifest.candidates.filter((c) => c.accepted).length;
  io.log(
    `wrote ${manifest.candidates.length} candidates → ${flags.paths.manifestPath} (${accepted} accepted)`,
  );
  if (accepted === 0) {
    io.log(
      "next step: edit the manifest and flip 'accepted: true' on files you want to extract.",
    );
  }
  return 0;
}

// ─── Pass 1: extract ─────────────────────────────────────────────────

async function runExtractCommand(
  args: ReadonlyArray<string>,
  io: SelfModelCliIo,
  deps: SelfModelCliDeps,
): Promise<number> {
  const flags = parseCommonFlags(args, io.cwd);
  if (flags.help) {
    io.log(
      "usage: herta knowledge self-model extract [--dry-run] [--model <m>]",
    );
    return 0;
  }
  const manifest = readManifestOrEmpty(flags.paths.manifestPath);
  const accepted = manifest.candidates.filter((c) => c.accepted);
  if (accepted.length === 0) {
    io.err(
      "no accepted candidates in manifest — run `expand-corpus` first and edit accepted flags.",
    );
    return 1;
  }

  const cost = estimateCostUsd({
    model: flags.model,
    calls: accepted.length,
    inputTokensPerCall: 10_000,
    outputTokensPerCall: 2_000,
  });
  io.err(
    `[cost preview] Pass 1 extract: ${accepted.length} calls × ~10K in × ~2K out = ${formatCostUsd(cost)}`,
  );
  if (flags.dryRun) return 0;

  const voiceProfile = loadVoiceProfile(flags.paths.dbPath, io);
  if (voiceProfile === null) return 1;

  const client = makeClient(deps, flags.model, io);
  if (client === null) return 1;

  io.log(
    `Pass 1: extracting from ${accepted.length} files (concurrency=${flags.concurrency})...`,
  );
  const result = await runExtractPass({
    manifest,
    cleanedDir: flags.paths.cleanedDir,
    outPath: flags.paths.factsPath,
    cacheDir: flags.paths.cacheDir,
    antiPatterns: voiceProfile.antiPatterns,
    client,
    model: flags.model,
    concurrency: flags.concurrency,
    onProgress: (e) => {
      const pos = `[${e.index + 1}/${e.total}]`;
      if (e.kind === "cache_hit") io.log(`  ${pos} CACHE  ${e.source}`);
      else if (e.kind === "completed")
        io.log(
          `  ${pos} ${(e.durationMs / 1000).toFixed(1)}s  ${e.source} (${e.factCount} facts)`,
        );
      else if (e.kind === "failed")
        io.err(`  ${pos} FAIL   ${e.source} — ${e.reason}`);
    },
  });
  io.log(
    `done — ${result.facts.files.length} files extracted, ${result.cacheHits} cache hits, ${result.facts.failures.length} failures`,
  );
  for (const f of result.facts.failures) {
    io.err(`  failure: ${f.source} — ${f.reason}`);
  }
  io.log(`wrote ${flags.paths.factsPath}`);
  return result.facts.failures.length > 0 ? 0 : 0; // partial failures don't fail the command
}

// ─── Pass 2: synthesize ──────────────────────────────────────────────

async function runSynthesizeCommand(
  args: ReadonlyArray<string>,
  io: SelfModelCliIo,
  deps: SelfModelCliDeps,
): Promise<number> {
  const flags = parseCommonFlags(args, io.cwd);
  if (flags.help) {
    io.log(
      "usage: herta knowledge self-model synthesize [--dry-run] [--model <m>]",
    );
    return 0;
  }
  const facts = readFactsOrNull(flags.paths.factsPath, io);
  if (facts === null) return 1;

  const cost = estimateCostUsd({
    model: flags.model,
    calls: 1,
    inputTokensPerCall: 100_000,
    outputTokensPerCall: 5_000,
  });
  io.err(
    `[cost preview] Pass 2 synthesize: 1 call × ~100K in × ~5K out = ${formatCostUsd(cost)}`,
  );
  if (flags.dryRun) return 0;

  const voiceProfile = loadVoiceProfile(flags.paths.dbPath, io);
  if (voiceProfile === null) return 1;

  const client = makeClient(deps, flags.model, io);
  if (client === null) return 1;

  io.log("Pass 2: synthesizing self-model...");
  const result = await runSynthesizePass({
    facts,
    voiceRegister: voiceProfile.defaultRegister,
    antiPatterns: voiceProfile.antiPatterns,
    outPath: flags.paths.selfModelPath,
    client,
    model: flags.model,
  });
  io.log(
    `done — ${result.callsMade} call(s), ${result.warnings.length} warnings`,
  );
  for (const w of result.warnings) {
    io.err(`  warning: ${w.kind} in ${w.slot}`);
  }
  io.log(`wrote ${flags.paths.selfModelPath}`);
  return 0;
}

// ─── Pass 3a + 3b: validate ──────────────────────────────────────────

async function runValidateCommand(
  args: ReadonlyArray<string>,
  io: SelfModelCliIo,
  deps: SelfModelCliDeps,
): Promise<number> {
  const flags = parseCommonFlags(args, io.cwd);
  if (flags.help) {
    io.log(
      "usage: herta knowledge self-model validate [--dry-run] [--model <m>]",
    );
    return 0;
  }
  const selfModel = readSelfModelOrNull(flags.paths.selfModelPath, io);
  if (selfModel === null) return 1;

  // Pass 3a — programmatic, no API.
  io.log("Pass 3a: programmatic checks...");
  const checks = runProgrammaticChecks({
    selfModel,
    corpusRoot: flags.paths.dataRoot,
  });
  if (checks.passed) {
    io.log("  PASSED");
  } else {
    io.err(`  FAILED — ${checks.failures.length} hard failures:`);
    for (const f of checks.failures) {
      io.err(`    [${f.kind}] in ${f.slot}: ${describeFailure(f)}`);
    }
    return 1;
  }

  // Pass 3b — LLM-judge.
  const cost = estimateCostUsd({
    model: flags.model,
    calls: 1,
    inputTokensPerCall: 10_000,
    outputTokensPerCall: 2_000,
  });
  io.err(
    `[cost preview] Pass 3b judge: 1 call × ~10K in × ~2K out = ${formatCostUsd(cost)}`,
  );
  if (flags.dryRun) return 0;

  const voiceProfile = loadVoiceProfile(flags.paths.dbPath, io);
  if (voiceProfile === null) return 1;

  const client = makeClient(deps, flags.model, io);
  if (client === null) return 1;

  io.log("Pass 3b: LLM-judge...");
  const result = await runJudgePass({
    selfModel,
    voiceRegister: voiceProfile.defaultRegister,
    antiPatterns: voiceProfile.antiPatterns,
    outPath: flags.paths.judgeReportPath,
    client,
    model: flags.model,
  });
  io.log(
    `  done — minScore=${result.minScore}, avgScore=${result.avgScore?.toFixed(2)}`,
  );
  io.log(`wrote ${flags.paths.judgeReportPath}`);
  return 0;
}

// ─── Pass 3b alone: judge ────────────────────────────────────────────

async function runJudgeCommand(
  args: ReadonlyArray<string>,
  io: SelfModelCliIo,
  deps: SelfModelCliDeps,
): Promise<number> {
  const flags = parseCommonFlags(args, io.cwd);
  if (flags.help) {
    io.log("usage: herta knowledge self-model judge [--dry-run] [--model <m>]");
    return 0;
  }
  const selfModel = readSelfModelOrNull(flags.paths.selfModelPath, io);
  if (selfModel === null) return 1;

  const cost = estimateCostUsd({
    model: flags.model,
    calls: 1,
    inputTokensPerCall: 10_000,
    outputTokensPerCall: 2_000,
  });
  io.err(
    `[cost preview] judge: 1 call × ~10K in × ~2K out = ${formatCostUsd(cost)}`,
  );
  if (flags.dryRun) return 0;

  const voiceProfile = loadVoiceProfile(flags.paths.dbPath, io);
  if (voiceProfile === null) return 1;

  const client = makeClient(deps, flags.model, io);
  if (client === null) return 1;

  io.log("running LLM-judge...");
  const result = await runJudgePass({
    selfModel,
    voiceRegister: voiceProfile.defaultRegister,
    antiPatterns: voiceProfile.antiPatterns,
    outPath: flags.paths.judgeReportPath,
    client,
    model: flags.model,
  });
  io.log(
    `done — minScore=${result.minScore}, avgScore=${result.avgScore?.toFixed(2)}`,
  );
  io.log(`wrote ${flags.paths.judgeReportPath}`);
  return 0;
}

// ─── build (orchestrates 0 → 3b) ─────────────────────────────────────

async function runBuildCommand(
  args: ReadonlyArray<string>,
  io: SelfModelCliIo,
  deps: SelfModelCliDeps,
): Promise<number> {
  const flags = parseCommonFlags(args, io.cwd);
  if (flags.help) {
    io.log("usage: herta knowledge self-model build [--dry-run] [--model <m>]");
    return 0;
  }

  // Pre-flight: ensure manifest exists.
  if (!existsSync(flags.paths.manifestPath)) {
    io.err("no manifest — run `expand-corpus` first.");
    return 1;
  }
  const manifest = readManifestOrEmpty(flags.paths.manifestPath);
  const accepted = manifest.candidates.filter((c) => c.accepted);
  if (accepted.length === 0) {
    io.err(
      "no accepted candidates in manifest — edit it and flip 'accepted: true' on files you want.",
    );
    return 1;
  }

  // Cost preview for the whole build.
  const extractCost = estimateCostUsd({
    model: flags.model,
    calls: accepted.length,
    inputTokensPerCall: 10_000,
    outputTokensPerCall: 2_000,
  });
  const synthesizeCost = estimateCostUsd({
    model: flags.model,
    calls: 1,
    inputTokensPerCall: 100_000,
    outputTokensPerCall: 5_000,
  });
  const judgeCost = estimateCostUsd({
    model: flags.model,
    calls: 1,
    inputTokensPerCall: 10_000,
    outputTokensPerCall: 2_000,
  });
  const total = extractCost + synthesizeCost + judgeCost;
  io.err(
    `[cost preview] build: extract ${formatCostUsd(extractCost)} + synthesize ${formatCostUsd(synthesizeCost)} + judge ${formatCostUsd(judgeCost)} = ${formatCostUsd(total)}`,
  );
  if (flags.dryRun) return 0;

  // 0
  io.log("=== Pass 0: clean ===");
  const cleanCode = await runCleanCommand(args, io);
  if (cleanCode !== 0) return cleanCode;

  // 1
  io.log("\n=== Pass 1: extract ===");
  const extractCode = await runExtractCommand(args, io, deps);
  if (extractCode !== 0) return extractCode;

  // 2
  io.log("\n=== Pass 2: synthesize ===");
  const synthesizeCode = await runSynthesizeCommand(args, io, deps);
  if (synthesizeCode !== 0) return synthesizeCode;

  // 3a + 3b
  io.log("\n=== Pass 3: validate ===");
  const validateCode = await runValidateCommand(args, io, deps);
  if (validateCode !== 0) return validateCode;

  io.log(
    "\n=== build complete ===\n" +
      `  facts:        ${flags.paths.factsPath}\n` +
      `  self-model:   ${flags.paths.selfModelPath}\n` +
      `  judge report: ${flags.paths.judgeReportPath}`,
  );
  io.log(
    "next step: review the self-model JSON, then `herta knowledge self-model ship` (Phase 6, not yet implemented).",
  );
  return 0;
}

// ─── Pass 4: ship ────────────────────────────────────────────────────

/**
 * Pass 4. Gate on Pass 3a programmatic checks (hard fail), then insert the
 * synthesized self-model into the knowledge DB's `self_models` table.
 * Pass 3b's judge report is included if present but never gates ingest.
 *
 * Skip-on-unchanged: if `--force` is not set and the latest row for this
 * entity already has the same `source_facts_hash`, the command logs the
 * no-op and exits 0 without writing.
 */
async function runShipCommand(
  args: ReadonlyArray<string>,
  io: SelfModelCliIo,
): Promise<number> {
  const flags = parseCommonFlags(args, io.cwd);
  if (flags.help) {
    io.log(
      "usage: herta knowledge self-model ship [--dry-run] [--force] [--no-judge-report] [--entity <id>]",
    );
    return 0;
  }
  let force = false;
  let includeJudgeReport = true;
  let entityId: string = HERTA_PERSON_PRIME;
  let dbPathOverride: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--force") force = true;
    else if (a === "--no-judge-report") includeJudgeReport = false;
    else if (a === "--entity" && args[i + 1] !== undefined)
      entityId = args[++i] as string;
    else if (a === "--db" && args[i + 1] !== undefined)
      dbPathOverride = resolve(io.cwd, args[++i] as string);
  }
  const dbPath = dbPathOverride ?? flags.paths.dbPath;

  const selfModel = readSelfModelOrNull(flags.paths.selfModelPath, io);
  if (selfModel === null) return 1;

  // Pass 3a gate (hard).
  io.log("Pass 3a: programmatic checks (gating ship)...");
  const checks = runProgrammaticChecks({
    selfModel,
    corpusRoot: flags.paths.dataRoot,
  });
  if (!checks.passed) {
    io.err(`  FAILED — ${checks.failures.length} hard failures:`);
    for (const f of checks.failures) {
      io.err(`    [${f.kind}] in ${f.slot}: ${describeFailure(f)}`);
    }
    io.err("ship aborted. fix the self-model and re-run.");
    return 1;
  }
  io.log("  PASSED");

  // Optional judge report — read if present, never gating.
  let judgeReportJson: string | null = null;
  if (includeJudgeReport && existsSync(flags.paths.judgeReportPath)) {
    judgeReportJson = readFileSync(flags.paths.judgeReportPath, "utf8").trim();
  }

  // Source facts hash — used for skip-on-unchanged.
  const sourceFactsHash = existsSync(flags.paths.factsPath)
    ? `sha256:${createHash("sha256")
        .update(readFileSync(flags.paths.factsPath))
        .digest("hex")}`
    : null;

  // Open DB.
  if (!existsSync(dbPath)) {
    io.err(
      `knowledge DB missing: ${dbPath} — run \`herta knowledge ingest\` first.`,
    );
    return 1;
  }
  const store = SqliteKnowledgeStore.openOrCreate({ dbPath });
  try {
    // Skip-on-unchanged.
    const latest = store.getLatestSelfModel(entityId);
    if (
      !force &&
      latest !== undefined &&
      sourceFactsHash !== null &&
      latest.sourceFactsHash === sourceFactsHash
    ) {
      io.log(
        `no change since ${latest.shippedAt} (row ${latest.id}, same source_facts_hash). use --force to ship anyway.`,
      );
      return 0;
    }

    if (flags.dryRun) {
      io.log(
        `[dry-run] would ship self-model for ${entityId}` +
          (sourceFactsHash !== null ? ` (facts ${sourceFactsHash})` : "") +
          (judgeReportJson !== null ? " with judge report" : ""),
      );
      return 0;
    }

    const id = store.insertSelfModel({
      entityId,
      schemaVersion: selfModel.version,
      payloadJson: JSON.stringify(selfModel),
      judgeReportJson,
      sourceFactsHash,
      shippedAt: new Date().toISOString(),
    });
    const history = store.listSelfModelHistory(entityId);
    io.log(
      `shipped row ${id} for ${entityId} (history: ${history.length} ship${history.length === 1 ? "" : "s"})`,
    );
    return 0;
  } finally {
    store.close();
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

function readManifestOrEmpty(path: string): CorpusManifest {
  if (!existsSync(path)) {
    return { version: 1, candidates: [] };
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return corpusManifestSchema.parse(raw);
}

function readFactsOrNull(path: string, io: SelfModelCliIo): HertaFacts | null {
  if (!existsSync(path)) {
    io.err(`facts file missing: ${path} — run \`extract\` first.`);
    return null;
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return hertaFactsSchema.parse(raw);
}

function readSelfModelOrNull(
  path: string,
  io: SelfModelCliIo,
): HertaSelfModelV1 | null {
  if (!existsSync(path)) {
    io.err(`self-model file missing: ${path} — run \`synthesize\` first.`);
    return null;
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return hertaSelfModelV1Schema.parse(raw);
}

function loadVoiceProfile(dbPath: string, io: SelfModelCliIo) {
  if (!existsSync(dbPath)) {
    io.err(
      `knowledge DB missing: ${dbPath} — run \`herta knowledge ingest\` first.`,
    );
    return null;
  }
  const store = SqliteKnowledgeStore.openOrCreate({
    dbPath,
    readonly: true,
  });
  // Closed on both ways out: the handle was left open for the life of the
  // command (review 2026-11-10, second pass).
  try {
    const profile = store.getVoiceProfile(HERTA_PERSON_PRIME);
    if (profile === undefined) {
      io.err(
        "no voice profile in DB — the voice_profiles row is required (the generation pipeline was retired 2026-07-14; use a DB that already carries the row).",
      );
      return null;
    }
    return profile;
  } finally {
    store.close();
  }
}

function makeClient(
  deps: SelfModelCliDeps,
  model: string,
  io: SelfModelCliIo,
): DeepSeekClient | null {
  if (deps.makeDeepSeekClient !== undefined) {
    return deps.makeDeepSeekClient(process.env.DEEPSEEK_API_KEY ?? "", model);
  }
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    // Try the common deepseek-api-key.txt fallback.
    const keyFile = resolve(io.cwd, "deepseek-api-key.txt");
    if (existsSync(keyFile)) {
      const fileKey = readFileSync(keyFile, "utf8").trim();
      if (fileKey.length > 0) {
        return new RealDeepSeekClient({ apiKey: fileKey, model });
      }
    }
    io.err(
      "DeepSeek API key not found. Set DEEPSEEK_API_KEY or place key in ./deepseek-api-key.txt.",
    );
    return null;
  }
  return new RealDeepSeekClient({ apiKey, model });
}

function describeFailure(
  f: ReturnType<typeof runProgrammaticChecks>["failures"][number],
): string {
  switch (f.kind) {
    case "banned_phrase":
      return `phrase "${f.phrase}"`;
    case "third_person_voice":
      return `sample "${f.sample}"`;
    case "ni_hao_opener":
      return `opens with "${f.sample}"`;
    case "evidence_unresolved":
      return `cited file "${f.filename}" not found in corpus`;
  }
}
