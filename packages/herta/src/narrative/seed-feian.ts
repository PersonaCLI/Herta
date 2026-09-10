import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dreamDirFor, errorMessage, narrativeDirFor } from "@herta/core";
import { promptAssetsFor } from "./prompt-assets.js";
import type { PromptLang } from "./prompt-lang.js";

/**
 * Materialize the canonical seed 废案 into a workspace's live narrative
 * dir (M-prompts-1, 2026-07-05).
 *
 * Two-tier prompt storage: identity/instruction prompts ship compiled
 * (`PROMPT_ASSETS`), but the 废案 corpus is LIVING MEMORY — the Dream
 * system writes new 废案 into `<workspace>/.herta/narrative/` and
 * cap-eviction archives them — so the live set must stay file-based.
 * This bootstrap gives a FRESH workspace its starting memory: the
 * compiled seed files are written verbatim, once.
 *
 * Materialization is PER FILE, guarded against resurrection (2026-07-19,
 * seed-07 rollout): a seed is written only when it is absent from the
 * live narrative dir AND absent from the dream archive. A bare per-file
 * existence check would RESURRECT seeds the cap-eviction legitimately
 * archived (seed-examples-first, M-feian-1); the old any-废案-present
 * guard avoided that but also meant a NEWLY-SHIPPED seed could never
 * reach an existing workspace — the archive check keeps both properties:
 * evicted seeds stay evicted, new seeds arrive everywhere.
 *
 * Best-effort per file (a failed write logs and continues); the static
 * prefix tolerates a partial corpus.
 *
 * `lang` (slice 4) selects WHICH bundle's seeds materialize AND the
 * per-language narrative dir they land in (`narrative` for zh,
 * `narrative-en` for en) — the two corpora are isolated on disk, so seeding
 * one never touches the other (EN-dream slice). Default "zh", byte-identical.
 * An existing workspace keeps whatever is on disk — the any-废案-present guard
 * fires before the bundle is even consulted, so a language change never
 * re-seeds or mixes corpora mid-lifecycle.
 */
export async function materializeSeedFeian(
  workspaceRoot: string,
  lang: PromptLang = "zh",
  /** Test seam: a substitute seed bundle (seeds + superseded registry).
   *  Production callers omit it — the compiled bundle is the truth. */
  assetsOverride?: {
    readonly feianSeeds: Readonly<Record<string, string>>;
    readonly supersededFeianSha1: readonly string[];
    readonly retiredFeian?: Readonly<Record<string, readonly string[]>>;
  },
): Promise<void> {
  // Per-language dir: EN seeds land in `.herta/narrative-en`, wholly separate
  // from the zh corpus in `.herta/narrative` (which only zh reads/writes). The
  // earlier "EN never materializes" guard existed only because a SINGLE shared
  // dir would have mixed languages — parallel dirs remove that hazard.
  const dir = narrativeDirFor(workspaceRoot, lang);
  const listDir = async (d: string): Promise<string[]> => {
    try {
      return await readdir(d);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT") throw err;
      return [];
    }
  };
  const live = new Set(await listDir(dir));
  // Evicted-seed graveyard: cap-eviction and forgetting move 废案 files
  // into the dream archive. A seed present there was legitimately retired
  // from THIS workspace's memory lifecycle — never resurrect it.
  const archived = new Set(
    await listDir(join(dreamDirFor(workspaceRoot, lang), "archive")),
  );

  const assets = assetsOverride ?? promptAssetsFor(lang);
  const seeds = assets.feianSeeds;
  const missing = Object.entries(seeds).filter(
    ([filename]) => !live.has(filename) && !archived.has(filename),
  );

  // Seed-revision upgrade path (ADR 0052): a live file matching a bundle
  // seed's FILENAME but not its current body is either the user's own edit
  // (untouchable, D7) or a stale copy of a prior bundle version. The two
  // are distinguished by content hash: every retired seed body's sha1 is
  // registered in the bundle, so a stale copy is recognized EXACTLY and
  // overwritten with the revision, while anything else — a user edit, a
  // dream 废案 that happens to share nothing but confusion — never matches
  // and is never touched.
  const superseded = new Set(assets.supersededFeianSha1);
  const stale: Array<[string, string]> = [];
  if (superseded.size > 0) {
    for (const [filename, body] of Object.entries(seeds)) {
      if (!live.has(filename)) continue;
      try {
        const onDisk = await readFile(join(dir, filename), "utf-8");
        const normalized = onDisk.replace(/\r\n/g, "\n");
        if (normalized === body) continue; // current — nothing to do
        const sha1 = createHash("sha1")
          .update(normalized, "utf8")
          .digest("hex");
        if (superseded.has(sha1)) stale.push([filename, body]);
      } catch {
        // unreadable live file — leave it alone; the prefix builder's own
        // error handling owns that case.
      }
    }
  }

  // Retired seeds (ADR 0053): a file that no longer ships because its
  // content was folded into another seed. Materialization only ever writes,
  // so without this an existing workspace would carry the retired file
  // NEXT TO its successor and Herta would read the same lesson twice.
  // Archived, never deleted — the same destination cap-eviction uses — and
  // only when the content still hashes to a body this bundle shipped, so a
  // user-edited copy is left alone (D7).
  const retiredMap = assets.retiredFeian ?? {};
  const retired: string[] = [];
  for (const [filename, hashes] of Object.entries(retiredMap)) {
    if (!live.has(filename)) continue;
    try {
      const onDisk = (await readFile(join(dir, filename), "utf-8")).replace(
        /\r\n/g,
        "\n",
      );
      const sha1 = createHash("sha1").update(onDisk, "utf8").digest("hex");
      if (hashes.includes(sha1)) retired.push(filename);
    } catch {
      // unreadable — leave it alone.
    }
  }

  if (missing.length === 0 && stale.length === 0 && retired.length === 0) {
    return;
  }

  await mkdir(dir, { recursive: true });
  if (retired.length > 0) {
    const archiveDir = join(dreamDirFor(workspaceRoot, lang), "archive");
    await mkdir(archiveDir, { recursive: true });
    for (const filename of retired) {
      try {
        await rename(join(dir, filename), join(archiveDir, filename));
      } catch (err) {
        console.warn(
          `materializeSeedFeian: failed to archive retired ${filename}: ${errorMessage(
            err,
          )}`,
        );
      }
    }
  }
  for (const [filename, body] of [...missing, ...stale]) {
    try {
      await writeFile(join(dir, filename), body, "utf-8");
    } catch (err) {
      console.warn(
        `materializeSeedFeian: failed to write ${filename}: ${errorMessage(
          err,
        )}`,
      );
    }
  }
}
