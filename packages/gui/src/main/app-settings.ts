import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "@herta/core";

/**
 * User app settings, persisted to `<workspaceRoot>/.herta/settings.json`
 * (workspace-scoped, gitignored). Extensible — future sections add keys. Read
 * at app-server bootstrap (`buildConfig`); changes apply on the next launch.
 */
/** Backend (差分协处理器) reasoning effort tiers, as accepted by the DeepSeek
 *  API since its 2026-07-31 update. NOTE: deepseek-v4-pro maps a sent "low"
 *  to "high" server-side until its announced early-August-2026 update — we
 *  store and send the user's choice as-is so it starts meaning "low" the day
 *  DeepSeek ships that, with no change here. */
export type BackendThinking = "low" | "high" | "max";

const BACKEND_THINKING_VALUES: readonly string[] = ["low", "high", "max"];

/** Narrow an untrusted (hand-editable settings.json) value to a valid tier. */
export function isBackendThinking(v: unknown): v is BackendThinking {
  return typeof v === "string" && BACKEND_THINKING_VALUES.includes(v);
}

/** The DeepSeek models the app can drive each stage with (2026-08-17, owner:
 *  API prices rose; the actor is the biggest per-turn lever). Exactly the two
 *  names the completion endpoint accepts (DeepSeek doc, 2026-09-10):
 *  `deepseek-flash` (V4.1 Flash — reads images, 1M context, the three
 *  thinking tiers) and `deepseek-v4-pro`. NOTE: DeepSeek retires V4 Pro on
 *  2026-09-14 — from then a `deepseek-v4-pro` request is served by V4.1
 *  Flash at the Flash price; the name stays accepted.
 *
 *  The 2026-08 names are off the API's own list: `deepseek-v4-flash` and
 *  `deepseek-v4-flash-vision-exp` are still ACCEPTED but served by V4.1
 *  Flash. `normalizeModelChoice` folds a persisted legacy name into
 *  `deepseek-flash`, so a settings.json written before the rename keeps
 *  meaning "flash" (guarding it off-enum would have switched such a user to
 *  the Pro default, at Pro prices, without a word). Since the flash reads
 *  images, the separate vision model — and with it the difference between
 *  what the actor and 板砖 may run — is gone (ADR 0048 §5b). */
export type ModelChoice = "deepseek-v4-pro" | "deepseek-flash";

const MODEL_CHOICE_VALUES: readonly string[] = [
  "deepseek-v4-pro",
  "deepseek-flash",
];

export function isModelChoice(v: unknown): v is ModelChoice {
  return typeof v === "string" && MODEL_CHOICE_VALUES.includes(v);
}

/** The pre-2026-09 names a settings.json may still carry, and what each
 *  means today (both are served by V4.1 Flash). */
const LEGACY_MODEL_NAMES: Readonly<Record<string, ModelChoice>> = {
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
};

/** A persisted model name as the app should read it: a current name as-is,
 *  a legacy name folded into its successor, anything else `undefined` (the
 *  caller falls back to its default). Read-side only — the file is rewritten
 *  with current names the next time the user picks a model. */
export function normalizeModelChoice(v: unknown): ModelChoice | undefined {
  if (isModelChoice(v)) return v;
  if (typeof v === "string") return LEGACY_MODEL_NAMES[v];
  return undefined;
}

/** Which model-facing tool contract 板砖 runs (ADR 0040, 2026-08-17).
 *  `standard` = the 15-tool set + the long execution contract; `minimal` = the
 *  DeepSeek-trained shape (persistent `bash` + `str_replace_editor` + the
 *  two record channels) with the short 板砖 prompt — same reliability in the
 *  lab, ~½ the prompt tokens, ~⅒ the cache-miss tokens. Needs a bash on this
 *  machine (Git for Windows ships one); without one the app falls back to
 *  `standard` and says so at session start. */
export type BackendContractChoice = "standard" | "minimal";

const BACKEND_CONTRACT_VALUES: readonly string[] = ["standard", "minimal"];

export function isBackendContract(v: unknown): v is BackendContractChoice {
  return typeof v === "string" && BACKEND_CONTRACT_VALUES.includes(v);
}

export interface AppSettings {
  readonly dream?: { readonly enabled?: boolean };
  readonly backend?: {
    readonly thinking?: BackendThinking;
    /** Settings → 差分协处理器 → 工具契约. Absent = standard. Restart-to-apply. */
    readonly contract?: BackendContractChoice;
  };
  /** Per-stage model choice (Settings → DeepSeek → 模型). `actor` drives the
   *  narrative actor (speech / thought / beats, completion mode); `backend`
   *  drives 板砖 (chat + tools). Absent = the built-in default (Pro for
   *  both). Read at bootstrap; restart-to-apply like the rows above. */
  readonly models?: {
    readonly actor?: ModelChoice;
    /** Same two names as the actor since 2026-09 (the flash reads images;
     *  ADR 0048 §5b). Readers go through `normalizeModelChoice` — the file
     *  may still say `deepseek-v4-flash-vision-exp`. */
    readonly backend?: ModelChoice;
  };
}

function settingsPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".herta", "settings.json");
}

/**
 * Read the settings file. Best-effort: a missing / unreadable / corrupt /
 * non-object file resolves to `{}` so every setting falls back to its default.
 */
export async function readAppSettings(
  workspaceRoot: string,
): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(workspaceRoot), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    // A malformed nested section (e.g. a hand-edited `"dream": 5`) → fall back
    // to defaults rather than hand back a shape that violates AppSettings.
    const { dream, backend, models } = parsed as {
      dream?: unknown;
      backend?: unknown;
      models?: unknown;
    };
    if (dream !== undefined && (typeof dream !== "object" || dream === null)) {
      return {};
    }
    if (
      backend !== undefined &&
      (typeof backend !== "object" || backend === null)
    ) {
      return {};
    }
    if (
      models !== undefined &&
      (typeof models !== "object" || models === null)
    ) {
      return {};
    }
    return parsed as AppSettings;
  } catch {
    return {};
  }
}

/** Write the settings file, creating `.herta/` if needed. Temp + rename so a
 *  crash mid-write can't tear the file into "all defaults" (audit 2026-07-13
 *  T3.9, same fix as app-global-settings). */
export async function writeAppSettings(
  workspaceRoot: string,
  settings: AppSettings,
): Promise<void> {
  const path = settingsPath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });
  // Atomic, unique temp (audit BL7). A FIXED `.tmp` path with no
  // serialization meant two concurrent writes — two Settings panes, or a
  // fast toggle — interleaved on the same file: writer A's rename could
  // publish writer B's half-written bytes. That race is what made the
  // Settings error-note bug (BL14) reachable at all.
  await writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
}
