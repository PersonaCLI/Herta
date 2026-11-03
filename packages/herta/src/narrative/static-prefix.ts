/**
 * Builder for the Static Herta Prefix — the stable, cache-friendly head
 * of the v0.2 actor's prompt. Per SPEC §4.1, the prefix is:
 *
 *   HertaBio + selected 废案 few-shots + selected 记录 files + EnvSet
 *
 * The body of each top-level section is concatenated with blank-line
 * separators; no outer English markers are emitted (the few-shot files
 * already self-identify via their internal `### 废案_NN：xxx` /
 * `### 记录：xxx` headers, and HertaBio / EnvSet are short enough that
 * adjacent prose suffices).
 *
 * Two tiers (M-prompts-1, 2026-07-05):
 *
 * - HertaBio and EnvSet are IDENTITY — compiled into the bundle via
 *   `PROMPT_ASSETS` (D1: identity lives in the harness, not in
 *   user-editable workspace files; it also must not vanish when the
 *   session workspace isn't this repo). They are no longer read from
 *   `.herta/narrative/` at runtime.
 * - The 废案/记录 few-shots are LIVING MEMORY — still loaded from the
 *   workspace's `.herta/narrative/` because the Dream system writes new
 *   废案 there and cap-eviction archives them. Files whose name starts
 *   with `### 废案` or `### 记录` load in ascending NN order (00, 01, …)
 *   via the lexical `.sort()` below (zero-padded numbers). A fresh
 *   workspace is materialized with the canonical seeds first — see
 *   `materializeSeedFeian`.
 *
 * The prefix is treated as immutable during a turn; runtime facts live in
 * `TerminalRecord`, not by rewriting this prefix.
 *
 * Order rationale: HertaBio establishes voice, the few-shots demonstrate
 * it in action, then EnvSet anchors the current environment right before
 * the turn's running record — putting EnvSet last keeps the most
 * operationally-relevant context closest to the open `（我 说）` tag.
 *
 * The prefix deliberately contains NO session metadata (sessionId, ISO
 * timestamps, workspace path). Such bookkeeping belongs in the JSONL
 * session header (`V2RecordPersister.forNewSession`) and in the
 * `/resume` picker — it does not belong inside Herta's in-voice prompt
 * context. See Slice 8 design doc §3 decision E.
 */
import { narrativeDirName } from "@herta/core";
import type { StaticHertaPrefix } from "./actor-prompt.js";
import { checkFewShot } from "./few-shot-guard.js";
import { promptAssetsFor } from "./prompt-assets.js";
import type { PromptLang } from "./prompt-lang.js";

export interface StaticPrefixDeps {
  readonly workspaceRoot: string;
  /** Interaction language of the compiled identity assets (bio/env).
   *  Default "zh" — byte-identical to pre-slice-4 output. The 废案/记录
   *  few-shots are living workspace memory and load as-is regardless. */
  readonly lang?: PromptLang;
  /** 板砖 has a page this session (ADR 0083): the desktop's envSet, which
   *  says so. false — a host that mounts no browser, the CLI — takes
   *  `envSetCli`, which says it has none there (R5). Decided once per
   *  session, so the cached prefix stays one. Default true. */
  readonly browser?: boolean;
  readonly readFile: (relPath: string) => Promise<string>;
  readonly readNarrativeDir: () => Promise<readonly string[]>;
  /** Few-shot filenames to withhold from THIS open's prefix — the reopen
   *  own-dream filter: 废案 distilled from the opening session's episodes are
   *  excluded while their source content is still verbatim in the record
   *  (they'd read as memories of the conversation sitting right below them).
   *  Per-prompt only; the files themselves are untouched. */
  readonly excludeFewShotFiles?: ReadonlySet<string>;
  /** Called when a disk-loaded few-shot is rejected by `checkFewShot`
   *  (audit BL3). Diagnostic only — the build proceeds without that file. */
  readonly onFewShotDropped?: (name: string, reason: string) => void;
}

// Match the discard-draft / record few-shot files by their leading
// header token, WITHOUT the trailing colon. This covers both the legacy
// unnumbered `### 废案：xxx` form and the numbered `### 废案_NN：xxx` form
// (the `_NN` sits between 废案 and the colon).
const NARRATIVE_FILE_PREFIXES = ["### 废案", "### 记录"] as const;

/**
 * Build the static Herta prefix as a structured value. The `opening`
 * field is left undefined — the caller picks an opening separately and
 * assigns it to the returned prefix before threading it through to the
 * driver.
 */
export async function buildStaticHertaPrefix(
  deps: StaticPrefixDeps,
): Promise<StaticHertaPrefix> {
  const lang = deps.lang ?? "zh";
  const assets = promptAssetsFor(lang);
  const env = deps.browser === false ? assets.envSetCli : assets.envSet;

  // Living memory from THIS language's narrative dir (`narrative` for zh,
  // `narrative-en` for en; the caller's readNarrativeDir/readFile point at the
  // same lang-specific dir). The two corpora are isolated on disk, so an EN
  // session reads only English 废案 — the earlier "EN reads the bundle" branch
  // existed solely to avoid a SINGLE shared dir mixing languages, a hazard the
  // parallel dirs remove. The Dream system writes 废案/记录 here; cap-eviction
  // archives them.
  const narrativeRel = `.herta/${narrativeDirName(lang)}`;
  const allFiles = await deps.readNarrativeDir();
  const excluded = deps.excludeFewShotFiles;
  const fewShotFiles = allFiles
    .filter((name) =>
      NARRATIVE_FILE_PREFIXES.some((prefix) => name.startsWith(prefix)),
    )
    .filter((name) => excluded === undefined || !excluded.has(name))
    .slice()
    .sort();
  // Read the few-shots in PARALLEL (arch audit 2026-07-15) — the previous
  // loop awaited each file before starting the next. Ordering still comes
  // from the sorted filename list (`allSettled` preserves input order, not
  // completion order), and error semantics are unchanged: ENOENT degrades
  // to the per-file placeholder inside `safeRead`, while the first
  // non-ENOENT failure IN FILENAME ORDER rejects the build exactly as the
  // sequential loop did (allSettled also consumes the other rejections, so
  // no unhandled-rejection noise).
  const settled = await Promise.allSettled(
    fewShotFiles.map((name) =>
      safeRead(deps, narrativeRel, name, `[${name} 读取失败]`),
    ),
  );
  const fewShots: string[] = [];
  for (const [i, s] of settled.entries()) {
    if (s.status === "rejected") throw s.reason;
    // Gate every disk-loaded body (audit BL3). These files live in the user's
    // workspace, land verbatim at the head of every completion, and are
    // reported to the supervisor as 【有出处】 — so a body that can close the
    // block it sits in forges record. Dropped, not repaired: a few-shot that
    // fails this is not a few-shot, and silently truncating one would leave
    // a half-example teaching the wrong shape.
    const check = checkFewShot(fewShotFiles[i] as string, s.value);
    if (!check.ok) {
      deps.onFewShotDropped?.(fewShotFiles[i] as string, check.reason ?? "");
      continue;
    }
    fewShots.push(check.body);
  }
  // EN safety net: a brand-new EN workspace whose narrative-en dir has not been
  // seeded yet (materialize is best-effort) falls back to the compiled EN seeds
  // so the prefix is never few-shot-empty. zh keeps its exact prior behavior
  // (an empty dir yields empty few-shots), so this changes nothing for zh.
  if (fewShots.length === 0 && lang === "en") {
    const seeds = Object.keys(assets.feianSeeds)
      .sort()
      .map((name) => assets.feianSeeds[name] as string);
    return { bio: assets.hertaBio, env, fewShots: seeds };
  }
  return { bio: assets.hertaBio, env, fewShots };
}

async function safeRead(
  deps: StaticPrefixDeps,
  narrativeRel: string,
  relPath: string,
  fallback: string,
): Promise<string> {
  try {
    return await deps.readFile(`${narrativeRel}/${relPath}`);
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === "ENOENT") return fallback;
    throw cause;
  }
}
