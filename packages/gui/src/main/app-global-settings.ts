import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "@herta/core";
import { MINIMAX_HOSTS } from "./tts/minimax-api.js";

export type Locale = "zh" | "en";
export type ThemePref = "light" | "dark" | "system";
/** Which engine speaks Herta's replies (ADR 0062): the local Kokoro model
 *  (ADR 0042/0061, the default) or a MiniMax cloud clone on the user's own
 *  key. */
export type VoiceEngine = "local" | "minimax";

/** The cloned MiniMax voice this install owns (ADR 0062). `host` is the
 *  platform the key authenticated on (international or China); `lastUsedAt`
 *  lets the app re-clone before MiniMax's 7-day idle deletion bites. */
export interface MiniMaxVoiceRecord {
  readonly voiceId: string;
  readonly host: string;
  readonly clonedAt: string;
  readonly lastUsedAt?: string;
}
/** Interaction language — the language Herta is PROMPTED in (slice 4).
 *  Distinct from `Locale` (the UI chrome language); any combination works. */
export type InteractionLang = "zh" | "en";

/**
 * App-global (per-user) settings, persisted to `<userData>/settings.json`.
 * Distinct from the workspace-scoped `app-settings.ts`: language is a per-user
 * preference, not a per-project one. Pure (the userData dir is injected) so it
 * unit-tests without Electron — the caller passes `app.getPath("userData")`.
 */
export interface GlobalSettings {
  readonly locale?: Locale;
  /** Close button hides the app to the system tray instead of quitting.
   *  Default TRUE (the pre-setting behavior, user 2026-07-04); the Settings →
   *  Window toggle writes it and main applies it live to the close handler. */
  readonly closeToTray?: boolean;
  /** Automatic update checks + background downloads. Default TRUE. When
   *  false, the launch/interval cycle is off — a MANUAL Settings check still
   *  runs the full download→install-on-quit flow (user-initiated = consent).
   *  Live-applied via the session service's onAutoUpdateChanged hook. */
  readonly autoUpdate?: boolean;
  /** UI appearance (night-mode slice 2, 2026-07-13). Default "system"
   *  (user 2026-07-14; originally "light" while dark matured): a first
   *  launch follows the OS appearance, and the renderer's theme controller
   *  resolves "system" via prefers-color-scheme live. */
  readonly theme?: ThemePref;
  /** The window's last geometry (2026-07-13: a user who works maximized /
   *  fullscreen gets that back on the next launch). width/height/x/y are
   *  the NORMAL (restored) bounds; maximized/fullScreen replay on top.
   *  Captured on move/resize/state changes (debounced) and on close;
   *  restored through window-state.ts, which floors the size at the app
   *  minimum and drops a position no longer on any display. */
  readonly windowState?: WindowStateSnapshot;
  /** Interaction language (slice 4): the language Herta is prompted in for
   *  NEW sessions (static prefix, openings, router/supervisor/recap/title).
   *  ABSENT = follow the UI locale (`resolveInteractionLang`); an explicit
   *  "zh"/"en" persists. EN sessions have no opening voice in v1. */
  readonly interactionLanguage?: InteractionLang;
  /** The 3D device card (ADR 0057). ABSENT = the shipped default
   *  (`DEVICE_SCENE_DEFAULT`); the Settings → 差分协处理器 toggle writes an
   *  explicit boolean. Live-applied in the renderer; no restart. */
  readonly deviceScene?: boolean;
  /**
   * Herta's synthesized real-time voice (ADR 0042): she SPEAKS her replies,
   * and the text types in step with the audio. Default TRUE, and LIVE — the
   * synthesizer's `available()` is read at every speech stream's start, so a
   * toggle applies to the next reply with no restart.
   *
   * Default-on is safe because it is gated on assets: an install without the
   * model bundle reports unavailable and behaves exactly as before. It is
   * also the one switch that stops the synthesis WORK — the master mute
   * below it silences playback but the sentences are still synthesized.
   */
  readonly realtimeVoice?: boolean;
  /** Which engine speaks (ADR 0062). ABSENT = local. Live: the switching
   *  synthesizer reads it at every speech stream's start. */
  readonly voiceEngine?: VoiceEngine;
  /** The MiniMax clone this install made, or absent when none / forgotten. */
  readonly minimaxVoice?: MiniMaxVoiceRecord;
}

export interface WindowStateSnapshot {
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}

function settingsPath(userDataDir: string): string {
  return join(userDataDir, "settings.json");
}

/** Best-effort read: missing/unreadable/corrupt/invalid-shape -> `{}`. */
export async function readGlobalSettings(
  userDataDir: string,
): Promise<GlobalSettings> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(settingsPath(userDataDir), "utf-8"),
    );
    if (typeof parsed !== "object" || parsed === null) return {};
    const {
      locale,
      closeToTray,
      autoUpdate,
      theme,
      windowState,
      interactionLanguage,
      deviceScene,
      realtimeVoice,
      voiceEngine,
      minimaxVoice,
    } = parsed as {
      locale?: unknown;
      closeToTray?: unknown;
      autoUpdate?: unknown;
      theme?: unknown;
      windowState?: unknown;
      interactionLanguage?: unknown;
      deviceScene?: unknown;
      realtimeVoice?: unknown;
      voiceEngine?: unknown;
      minimaxVoice?: unknown;
    };
    if (deviceScene !== undefined && typeof deviceScene !== "boolean") {
      return {};
    }
    if (
      voiceEngine !== undefined &&
      voiceEngine !== "local" &&
      voiceEngine !== "minimax"
    ) {
      return {};
    }
    if (minimaxVoice !== undefined && !isValidMiniMaxVoice(minimaxVoice)) {
      return {};
    }
    if (locale !== undefined && locale !== "zh" && locale !== "en") return {};
    if (
      interactionLanguage !== undefined &&
      interactionLanguage !== "zh" &&
      interactionLanguage !== "en"
    ) {
      return {};
    }
    if (closeToTray !== undefined && typeof closeToTray !== "boolean") {
      return {};
    }
    if (autoUpdate !== undefined && typeof autoUpdate !== "boolean") {
      return {};
    }
    if (realtimeVoice !== undefined && typeof realtimeVoice !== "boolean") {
      return {};
    }
    if (
      theme !== undefined &&
      theme !== "light" &&
      theme !== "dark" &&
      theme !== "system"
    ) {
      return {};
    }
    if (windowState !== undefined && !isValidWindowState(windowState)) {
      return {};
    }
    return parsed as GlobalSettings;
  } catch {
    return {};
  }
}

function isValidMiniMaxVoice(v: unknown): v is MiniMaxVoiceRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.voiceId === "string" &&
    r.voiceId.length > 0 &&
    // The host is one of the two platforms the app talks to, not any
    // https URL a hand-edited file might carry (review 2026-09-10).
    typeof r.host === "string" &&
    MINIMAX_HOSTS.includes(r.host) &&
    typeof r.clonedAt === "string" &&
    (r.lastUsedAt === undefined || typeof r.lastUsedAt === "string")
  );
}

function isValidWindowState(v: unknown): v is WindowStateSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const ws = v as Record<string, unknown>;
  const num = (n: unknown): boolean =>
    typeof n === "number" && Number.isFinite(n);
  return (
    num(ws.width) &&
    num(ws.height) &&
    (ws.x === undefined || num(ws.x)) &&
    (ws.y === undefined || num(ws.y)) &&
    typeof ws.maximized === "boolean" &&
    typeof ws.fullScreen === "boolean"
  );
}

/** Write the settings file, creating the dir if needed. Temp + rename: a
 *  crash mid-write must not tear the file — readGlobalSettings treats a
 *  corrupt file as "all defaults", so a torn write silently reset every
 *  preference (audit 2026-07-13 T1.4/T3.9). Prefer `updateGlobalSettings`
 *  for read-modify-write cycles; this raw write is not serialized. */
export async function writeGlobalSettings(
  userDataDir: string,
  settings: GlobalSettings,
): Promise<void> {
  const path = settingsPath(userDataDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** All settings.json read-modify-write cycles chain through this promise.
 *  Five producers RMW the file concurrently (the debounced window-state
 *  persist plus the locale/closeToTray/autoUpdate/theme Settings hooks);
 *  unserialized, whichever write landed last clobbered the other's field —
 *  toggling the theme during a window-drag flush lost one or the other
 *  (audit 2026-07-13 T1.4). */
let updateChain: Promise<void> = Promise.resolve();

/** Serialized read-modify-write: reads the CURRENT settings after every
 *  earlier queued update has written, applies `mutate`, writes atomically.
 *  Errors propagate to this caller but never wedge the chain. */
export function updateGlobalSettings(
  userDataDir: string,
  mutate: (current: GlobalSettings) => GlobalSettings,
): Promise<void> {
  const run = updateChain.then(async () => {
    const current = await readGlobalSettings(userDataDir);
    await writeGlobalSettings(userDataDir, mutate(current));
  });
  updateChain = run.catch(() => undefined);
  return run;
}

/** Resolve the boot locale: a stored choice wins; else map the OS locale
 *  (`app.getLocale()`), zh* -> zh, everything else -> en. */
export function resolveInitialLocale(
  settings: GlobalSettings,
  osLocale: string,
): Locale {
  return settings.locale ?? (osLocale.startsWith("zh") ? "zh" : "en");
}

/** Resolve the effective interaction language (slice 4): an explicit stored
 *  choice wins; absent means "follow the UI locale" (zh → zh, else en).
 *  Read fresh per SESSION CREATION — a change applies to NEW sessions only
 *  (the static prefix + prompt cache are per-session). */
export function resolveInteractionLang(
  settings: GlobalSettings,
  locale: Locale,
): InteractionLang {
  return settings.interactionLanguage ?? (locale === "zh" ? "zh" : "en");
}
