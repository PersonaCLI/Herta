// Compile packages/herta/prompts/** (zh) AND packages/herta/prompts-en/**
// (en) into the checked-in TypeScript asset module
// packages/herta/src/narrative/prompt-assets.generated.ts.
//
//   node scripts/generate-prompt-assets.mjs
//
// M-prompts-1 (2026-07-05): Tier-1 identity/instruction prompts ship COMPILED
// into the bundle (D1: identity lives in the harness, not in user-editable
// workspace files) while remaining authorable as plain .txt under
// packages/herta/prompts/. Rerun this script after editing any source file
// and commit both. Codegen (not Vite `?raw` imports) because @herta/herta is
// consumed by BOTH the tsc-built CLI and the electron-vite GUI.
//
// Slice 4 (2026-07-14, EN interaction): prompts-en/ compiles into a second
// constant `PROMPT_ASSETS_EN` of the SAME shape. The two trees must stay
// key-parallel — every record group (hints, meta_think surfaces, openings,
// feianSeeds) is checked for key-set equality and the codegen FAILS LOUDLY
// on any divergence, so an added/renamed .txt in one tree cannot silently
// ship a bundle where one language is missing an asset.
//
// The live 废案 corpus stays file-based in <workspace>/.herta/narrative/
// (Tier 2 — mutable memory the Dream system owns); the seeds compiled here
// are the canonical copies materialized into fresh workspaces.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(
  root,
  "packages",
  "herta",
  "src",
  "narrative",
  "prompt-assets.generated.ts",
);

const stem = (f) => f.replace(/\.txt$/, "");

/** Compile one prompt tree (`packages/herta/<dirName>/**`) into an assets
 *  object. */
function compileTree(dirName) {
  const promptsDir = join(root, "packages", "herta", dirName);

  /** Read one file as UTF-8, normalized to LF so the generated module is
   *  byte-stable across Windows/Unix checkouts (git autocrlf). */
  function read(...parts) {
    return readFileSync(join(promptsDir, ...parts), "utf8").replace(
      /\r\n/g,
      "\n",
    );
  }

  /** All .txt files of a subdirectory as a sorted { key: content } record.
   *  `keyOf` maps a filename to its record key. */
  function dirRecord(sub, keyOf = (f) => f) {
    const out = {};
    const files = readdirSync(join(promptsDir, sub))
      .filter((f) => f.endsWith(".txt"))
      .sort();
    for (const f of files) out[keyOf(f)] = read(sub, f);
    return out;
  }

  return {
    hertaBio: read("HertaBio.txt"),
    envSet: read("EnvSet.txt"),
    hertaGuide: read("HertaGuide.txt"),
    hints: dirRecord("hints", stem),
    metaThink: {
      preThink: dirRecord(join("meta_think", "pre_think"), stem),
      preSpeak: dirRecord(join("meta_think", "pre_speak"), stem),
    },
    // Keyed by FULL filename: the picker's time-band extraction and the
    // opening→voice-clip pairing both key on the filename.
    openings: dirRecord("openings"),
    // Keyed by FULL filename: materialization writes these files verbatim
    // into a fresh workspace's .herta/narrative/.
    feianSeeds: dirRecord("feian-seeds"),
    // Flow (ADR 0084 §7): the frame her word on a post is completed in, and
    // the judge that reads it.
    flow: dirRecord("flow", stem),
  };
}

const assets = compileTree("prompts");
const assetsEn = compileTree("prompts-en");

// Superseded seed-body hashes (ADR 0052): the registry lives once, beside
// the zh tree; each language's list rides its own bundle so materialize can
// upgrade stale seed files in existing workspaces.
const superseded = JSON.parse(
  readFileSync(
    join(root, "packages", "herta", "prompts", "feian-seeds-superseded.json"),
    "utf8",
  ),
);
assets.supersededFeianSha1 = superseded.zh ?? [];
assetsEn.supersededFeianSha1 = superseded.en ?? [];

// Retired seed files (ADR 0053): consolidated away, no successor file.
// materialize archives a live copy that still matches a shipped body.
const retired = JSON.parse(
  readFileSync(
    join(root, "packages", "herta", "prompts", "feian-seeds-retired.json"),
    "utf8",
  ),
);
assets.retiredFeian = retired.zh ?? {};
assetsEn.retiredFeian = retired.en ?? {};

/** Key-set parity gate: the zh and en trees must expose IDENTICAL keys in
 *  every record group. Any divergence aborts codegen with a loud error. */
function checkKeyParity(label, zhRecord, enRecord) {
  const zhKeys = Object.keys(zhRecord).sort();
  const enKeys = Object.keys(enRecord).sort();
  const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
  const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
  if (missingInEn.length === 0 && missingInZh.length === 0) return;
  const lines = [`prompt-assets codegen FAILED: key-set mismatch in ${label}`];
  if (missingInEn.length > 0) {
    lines.push(`  present in prompts/ but missing in prompts-en/:`);
    for (const k of missingInEn) lines.push(`    - ${k}`);
  }
  if (missingInZh.length > 0) {
    lines.push(`  present in prompts-en/ but missing in prompts/:`);
    for (const k of missingInZh) lines.push(`    - ${k}`);
  }
  throw new Error(lines.join("\n"));
}

checkKeyParity("hints", assets.hints, assetsEn.hints);
checkKeyParity(
  "metaThink.preThink",
  assets.metaThink.preThink,
  assetsEn.metaThink.preThink,
);
checkKeyParity(
  "metaThink.preSpeak",
  assets.metaThink.preSpeak,
  assetsEn.metaThink.preSpeak,
);
checkKeyParity("openings", assets.openings, assetsEn.openings);
checkKeyParity("feianSeeds", assets.feianSeeds, assetsEn.feianSeeds);
checkKeyParity("flow", assets.flow, assetsEn.flow);

const body = `// GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: packages/herta/prompts/** (zh) and
// packages/herta/prompts-en/** (en) — edit there, then run
//   node scripts/generate-prompt-assets.mjs
// and commit both. See scripts/generate-prompt-assets.mjs for why these
// ship compiled (M-prompts-1 / D1). The two trees are key-parallel — the
// codegen fails loudly if their key sets diverge (slice 4).

export interface PromptAssets {
  readonly hertaBio: string;
  readonly envSet: string;
  readonly hertaGuide: string;
  /** Actor format hints, keyed by hint name (filename stem). */
  readonly hints: Readonly<Record<string, string>>;
  readonly metaThink: {
    /** Mood-state pre-think preambles, keyed by state name. */
    readonly preThink: Readonly<Record<string, string>>;
    /** Mood-state pre-speak preambles, keyed by state name. */
    readonly preSpeak: Readonly<Record<string, string>>;
  };
  /** Opening scenes, keyed by full filename (band + voice-clip pairing). */
  readonly openings: Readonly<Record<string, string>>;
  /** Canonical seed 废案, keyed by full filename (materialized verbatim
   *  into a fresh workspace's live corpus). */
  readonly feianSeeds: Readonly<Record<string, string>>;
  /** sha1 (LF-normalized) of RETIRED seed bodies — a live workspace file
   *  matching one is a stale prior seed version and gets overwritten by
   *  materialization (the seed-revision upgrade path, ADR 0052). */
  readonly supersededFeianSha1: readonly string[];
  /** Seed files that no longer ship, keyed by filename → the sha1s of the
   *  bodies that ever shipped under that name. A live copy matching one is
   *  archived rather than left to duplicate its successor (ADR 0053). */
  readonly retiredFeian: Readonly<Record<string, readonly string[]>>;
  /** Flow (ADR 0084 §7), keyed by filename stem: word — the frame her
   *  word on a post is completed in, its worked examples included;
   *  judge — the system message of the judge that reads it. */
  readonly flow: Readonly<Record<string, string>>;
}

export const PROMPT_ASSETS: PromptAssets = ${JSON.stringify(assets, null, 2)};

/** EN interaction bundle (slice 4). Same shape and key sets as
 *  \`PROMPT_ASSETS\`; select via \`promptAssetsFor(lang)\`. MoodState keys
 *  and 废案/opening filenames stay CN in both bundles (machine contract). */
export const PROMPT_ASSETS_EN: PromptAssets = ${JSON.stringify(assetsEn, null, 2)};
`;

writeFileSync(outFile, body, "utf8");
const counts = [
  `hints=${Object.keys(assets.hints).length}`,
  `preThink=${Object.keys(assets.metaThink.preThink).length}`,
  `preSpeak=${Object.keys(assets.metaThink.preSpeak).length}`,
  `openings=${Object.keys(assets.openings).length}`,
  `feianSeeds=${Object.keys(assets.feianSeeds).length}`,
].join(" ");
console.log(`prompt-assets.generated.ts written (zh+en, ${counts})`);
