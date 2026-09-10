/**
 * The Settings rows' IPC (2026-09-11, the post-0.1.5 refactor pass): every
 * `settings:*` handler the desktop's session service registers — Dream,
 * the coprocessor's effort and contract, the DeepSeek model rows and key,
 * the UI and interaction languages, close-to-tray, automatic updates, the
 * appearance, the 3D device card, the real-time voice with its engine,
 * the MiniMax keys and clone, the model download. They were a 370-line
 * block inside the service's 1 200-line handler closure; the service still
 * registers them at construction (synchronously, before any bootstrap —
 * the renderer's first invokes must never find "No handler registered"),
 * and hands them the live voice state it owns through `VoiceSettingsState`
 * (getters and setters over the service's own variables, so the flags the
 * synthesizer reads at every stream's start stay the service's).
 */
import type { SessionHost } from "@herta/app-server";
import { validateDeepSeekKey } from "@herta/providers";
import { findBash } from "@herta/tools";
import { app, type ipcMain } from "electron";
import { CMD } from "../preload/channels.js";
import type {
  InteractionLanguageChoice,
  RealtimeVoiceState,
} from "../renderer/ipc/bridge-types.js";
import { DEVICE_SCENE_DEFAULT } from "../shared/device-scene.js";
import type { VoiceEngine } from "./app-global-settings.js";
import {
  type Locale,
  readGlobalSettings,
  resolveInitialLocale,
  type ThemePref,
  updateGlobalSettings,
} from "./app-global-settings.js";
import {
  isBackendContract,
  isBackendThinking,
  isModelChoice,
  normalizeModelChoice,
  readAppSettings,
  writeAppSettings,
} from "./app-settings.js";
import {
  clearDeepSeekKey,
  clearMiniMaxKey,
  clearMiniMaxPlanKey,
  getDeepSeekKeyStatus,
  getMiniMaxKeyStatus,
  getMiniMaxPlanKeyStatus,
  readMiniMaxKeyPlain,
  setDeepSeekKey,
  setMiniMaxKey,
  setMiniMaxPlanKey,
} from "./key-store.js";
import {
  MINIMAX_CONTROL_TIMEOUT_MS,
  MiniMaxError,
  probeHost,
} from "./tts/minimax-api.js";
import type { MiniMaxVoiceService } from "./tts/minimax-voice.js";
import type { TtsSynthesizer } from "./tts/synthesizer.js";
import { TTS_ARCHIVE_BYTES, TTS_BUNDLE_BYTES } from "./tts/tts-release.js";
import type { VoiceModelService } from "./tts/voice-model.js";

export interface SettingsHooks {
  /** Fired after Settings → Language persists a new locale. Lets main-side
   *  surfaces that render OUTSIDE the renderer (the tray hover tooltip —
   *  drawn by the OS, so no React re-render reaches it) re-resolve their
   *  strings immediately instead of showing the old language until restart. */
  readonly onLocaleChanged?: () => void;
  /** Fired after Settings → Window persists the close-to-tray flag. The
   *  window close handler lives in main's index.ts — this hook updates its
   *  cached flag so the change applies to the very next close click. */
  readonly onCloseToTrayChanged?: (enabled: boolean) => void;
  /** Fired after Settings → Update persists the automatic-update toggle.
   *  The update service lives in main's index.ts — this hook live-applies
   *  it (cancelling or restarting the check cycle). */
  readonly onAutoUpdateChanged?: (enabled: boolean) => void;
  /** Fired after Settings → Window persists the appearance preference
   *  (night mode). index.ts retints the NATIVE window backgroundColor —
   *  the surface that shows for a beat on cold launch and during resizes,
   *  which the renderer's CSS can't cover. */
  readonly onThemeChanged?: (theme: ThemePref) => void;
}

/** The live voice state the session service owns and the Voice rows read
 *  and write (ADR 0042 / 0061 / 0062). `engine` and `realtimeEnabled` are
 *  the flags the synthesizer reads at every speech stream's start — set here,
 *  applied to the very next reply. */
export interface VoiceSettingsState {
  readonly synthesizer: TtsSynthesizer | null;
  readonly voiceModel: VoiceModelService | null;
  readonly minimaxVoice: MiniMaxVoiceService | null;
  engine: VoiceEngine;
  realtimeEnabled: boolean;
  /** The cloud voice's network path (Chromium's fetch, then Node's). */
  readonly minimaxFetch: Parameters<typeof probeHost>[0];
  /** Either MiniMax key is enough to try for a voice (ADR 0062 §1.8). */
  readonly anyMiniMaxKey: () => boolean;
}

export interface SettingsIpcDeps {
  /** The service's owned-channel registrar (dispose removes exactly these). */
  readonly handle: typeof ipcMain.handle;
  readonly hooks: SettingsHooks;
  /** The session host, null before bootstrap — read per call. */
  readonly host: () => SessionHost | null;
  /** The workspace whose `.herta/settings.json` the per-workspace rows
   *  read and write (the service's `appWorkspaceRoot`). */
  readonly workspaceRoot: () => string;
  readonly voice: VoiceSettingsState;
}

export function registerSettingsHandlers(deps: SettingsIpcDeps): void {
  const { handle, hooks, voice, workspaceRoot } = deps;
  // Settings → Dream. Restart-to-apply: read/write the persisted flag; the
  // running app-server is untouched (it reads config.dream at next bootstrap).
  handle(CMD.getDreamConfig, async () => {
    const s = await readAppSettings(workspaceRoot());
    return { enabled: s.dream?.enabled ?? true };
  });
  handle(CMD.setDreamConfig, async (_e, cfg: { enabled: boolean }) => {
    const ws = workspaceRoot();
    const s = await readAppSettings(ws);
    await writeAppSettings(ws, {
      ...s,
      dream: { ...s.dream, enabled: cfg.enabled },
    });
  });
  // Settings → Coprocessor: backend reasoning effort. Restart-to-apply, same
  // contract as Dream above — buildConfig reads it at the next bootstrap.
  handle(CMD.getBackendConfig, async () => {
    const s = await readAppSettings(workspaceRoot());
    const v = s.backend?.thinking;
    const c = s.backend?.contract;
    return {
      thinking: isBackendThinking(v) ? v : "high",
      // ADR 0040: the tool contract, plus whether the minimal one can run
      // here at all — the row says so next to the choice, where the user
      // makes it, instead of a note in the record at the next session.
      // Default MINIMAL (owner 2026-08-17) — must match buildConfig's.
      contract: isBackendContract(c) ? c : "minimal",
      bashFound: findBash() !== null,
    };
  });
  handle(
    CMD.setBackendConfig,
    async (_e, cfg: { thinking?: unknown; contract?: unknown }) => {
      // Validate like setTheme/setLocale: an off-enum value would fail the
      // read-side shape check downstream — refuse it instead of persisting.
      // Each field is optional so the two rows can write independently.
      const thinking = isBackendThinking(cfg?.thinking)
        ? cfg.thinking
        : undefined;
      const contract = isBackendContract(cfg?.contract)
        ? cfg.contract
        : undefined;
      if (thinking === undefined && contract === undefined) return;
      const ws = workspaceRoot();
      const s = await readAppSettings(ws);
      await writeAppSettings(ws, {
        ...s,
        backend: {
          ...s.backend,
          ...(thinking !== undefined ? { thinking } : {}),
          ...(contract !== undefined ? { contract } : {}),
        },
      });
    },
  );
  // Settings → DeepSeek → 模型: per-stage model (2026-08-17). Same
  // restart-to-apply contract; buildConfig reads it at the next bootstrap
  // (an env override, if set, still wins there — it is the dev/lab knob).
  handle(CMD.getModelConfig, async () => {
    const s = await readAppSettings(workspaceRoot());
    return {
      actor: normalizeModelChoice(s.models?.actor) ?? "deepseek-v4-pro",
      // Default `deepseek-flash` (the vision-capable flash, ADR 0048
      // §5a/§5b) — must match buildConfig's, or the pane shows a model
      // the next boot will not use. A legacy name in the file reads as
      // its successor here too, so the pane shows what the boot will run.
      backend: normalizeModelChoice(s.models?.backend) ?? "deepseek-flash",
    };
  });
  handle(
    CMD.setModelConfig,
    async (_e, cfg: { actor?: unknown; backend?: unknown }) => {
      if (!isModelChoice(cfg?.actor) || !isModelChoice(cfg?.backend)) return;
      const ws = workspaceRoot();
      const s = await readAppSettings(ws);
      await writeAppSettings(ws, {
        ...s,
        models: { ...s.models, actor: cfg.actor, backend: cfg.backend },
      });
    },
  );
  // Settings → Language. App-global (per-user) preference; the renderer
  // applies it live, so this is just persistence. getLocale resolves a stored
  // choice, else maps the OS locale.
  handle(CMD.getLocale, async () => {
    const s = await readGlobalSettings(app.getPath("userData"));
    return resolveInitialLocale(s, app.getLocale());
  });
  handle(CMD.setLocale, async (_e, locale: Locale) => {
    // Validate like setTheme: an off-enum value would fail the read-side
    // shape check and silently reset EVERY preference to default.
    if (locale !== "zh" && locale !== "en") return;
    await updateGlobalSettings(app.getPath("userData"), (s) => ({
      ...s,
      locale,
    }));
    // AFTER the write settles: the hook re-reads the persisted settings,
    // so firing early would re-render the tray tooltip from the OLD file.
    hooks.onLocaleChanged?.();
  });
  // Settings → Language: interaction language (slice 4). Returns the STORED
  // choice ("follow" when absent = follow the UI locale); "follow" DELETES
  // the stored field. Applies to NEW sessions (per-session static prefix +
  // prompt cache) — session activation resolves it fresh above.
  handle(CMD.getInteractionLanguage, async () => {
    const s = await readGlobalSettings(app.getPath("userData"));
    return s.interactionLanguage ?? "follow";
  });
  handle(
    CMD.setInteractionLanguage,
    async (_e, choice: InteractionLanguageChoice) => {
      // Validate like setTheme: an off-enum value would fail the read-side
      // shape check and silently reset EVERY preference to default.
      if (choice !== "zh" && choice !== "en" && choice !== "follow") return;
      await updateGlobalSettings(app.getPath("userData"), (s) => {
        if (choice === "follow") {
          const { interactionLanguage: _drop, ...rest } = s;
          return rest;
        }
        return { ...s, interactionLanguage: choice };
      });
    },
  );
  // Settings → Window. Close-to-tray is app-global (per-user) and applies
  // LIVE: the hook updates main's cached close-handler flag immediately.
  handle(CMD.getCloseToTray, async () => {
    const s = await readGlobalSettings(app.getPath("userData"));
    return s.closeToTray ?? true;
  });
  handle(CMD.setCloseToTray, async (_e, enabled: boolean) => {
    await updateGlobalSettings(app.getPath("userData"), (s) => ({
      ...s,
      closeToTray: enabled === true,
    }));
    hooks.onCloseToTrayChanged?.(enabled === true);
  });
  // Settings → Update: automatic checks/downloads. App-global and applied
  // LIVE via the hook (the update service cancels or restarts its cycle).
  handle(CMD.getAutoUpdate, async () => {
    const s = await readGlobalSettings(app.getPath("userData"));
    return s.autoUpdate ?? true;
  });
  handle(CMD.setAutoUpdate, async (_e, enabled: boolean) => {
    await updateGlobalSettings(app.getPath("userData"), (s) => ({
      ...s,
      autoUpdate: enabled === true,
    }));
    hooks.onAutoUpdateChanged?.(enabled === true);
  });
  // Settings → Appearance (night-mode slice 2). The renderer's theme
  // controller applies it live; main just persists (validated on read).
  // Default "system" (user 2026-07-14): a first launch follows the OS
  // appearance; light/dark stay explicit overrides.
  handle(CMD.getTheme, async () => {
    const s = await readGlobalSettings(app.getPath("userData"));
    return s.theme ?? "system";
  });
  handle(CMD.setTheme, async (_e, theme: ThemePref) => {
    if (theme !== "light" && theme !== "dark" && theme !== "system") return;
    await updateGlobalSettings(app.getPath("userData"), (s) => ({
      ...s,
      theme,
    }));
    hooks.onThemeChanged?.(theme);
  });
  // Settings → 差分协处理器 → 3D device card (ADR 0057). The renderer
  // applies it live; main only persists. Absent = the shipped default.
  handle(CMD.getDeviceScene, async () => {
    const s = await readGlobalSettings(app.getPath("userData"));
    return s.deviceScene ?? DEVICE_SCENE_DEFAULT;
  });
  handle(CMD.setDeviceScene, async (_e, enabled: boolean) => {
    await updateGlobalSettings(app.getPath("userData"), (s) => ({
      ...s,
      deviceScene: enabled === true,
    }));
  });
  // Settings → Voice: Herta's real-time synthesized voice (ADR 0042).
  // App-global and applied LIVE — the synthesizer reads the cached flag at
  // every speech stream's start. The read reports the ASSET facts alongside
  // the toggle so the row can explain a silent install rather than claim
  // the voice is on when nothing can speak.
  handle(CMD.getRealtimeVoice, async (): Promise<RealtimeVoiceState> => {
    const s = await readGlobalSettings(app.getPath("userData"));
    const enabled = s.realtimeVoice ?? true;
    voice.realtimeEnabled = enabled;
    const st = voice.synthesizer?.status();
    return {
      enabled,
      bundle: st?.bundle ?? false,
      runtime: st?.runtime ?? false,
      failed: st?.failed ?? false,
      model: voice.voiceModel?.state() ?? {
        phase: "absent",
        receivedBytes: 0,
        totalBytes: TTS_ARCHIVE_BYTES,
        unpackedBytes: TTS_BUNDLE_BYTES,
      },
      engine: voice.engine,
      minimax: {
        key: getMiniMaxKeyStatus(),
        planKey: getMiniMaxPlanKeyStatus(),
        voice: voice.minimaxVoice?.state() ?? { phase: "absent" },
      },
    };
  });
  // Settings → Voice → the engine and the cloud voice (ADR 0062).
  handle(CMD.setVoiceEngine, async (_e, engine: VoiceEngine) => {
    const next: VoiceEngine = engine === "minimax" ? "minimax" : "local";
    voice.engine = next;
    await updateGlobalSettings(app.getPath("userData"), (s) => ({
      ...s,
      voiceEngine: next,
    }));
    // The clone is machinery, not a step (owner 2026-09-08): choosing
    // the cloud with a key in the store makes (or adopts) it now, unasked.
    if (next === "minimax" && voice.anyMiniMaxKey()) {
      void voice.minimaxVoice?.prepare();
    }
  });
  handle(CMD.getMiniMaxKeyStatus, async () => getMiniMaxKeyStatus());
  // A key is checked against the platform before it is stored — a key
  // neither host accepts is refused, like a DeepSeek key that fails its
  // auth check. A network failure stores it unverified — and a platform
  // that never answers is one (the deadline; the save must not spin for
  // the rest of the session).
  const checkKey = async (
    key: string,
  ): Promise<{ trimmed: string; unverified: boolean } | null> => {
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (trimmed.length === 0) return null;
    try {
      await probeHost(
        voice.minimaxFetch,
        trimmed,
        undefined,
        undefined,
        MINIMAX_CONTROL_TIMEOUT_MS,
      );
      return { trimmed, unverified: false };
    } catch (err) {
      if (err instanceof MiniMaxError && err.reason === "invalid_key") {
        return null;
      }
      return { trimmed, unverified: true };
    }
  };
  handle(CMD.setMiniMaxKey, async (_e, key: string) => {
    const checked = await checkKey(key);
    if (checked === null) {
      return { ok: false as const, reason: "rejected" as const };
    }
    // The same key saved again keeps the clone (a fresh one would be a
    // fresh first-use fee, ADR 0062 §1.8); a different key may be another
    // account — forget the clone the old one owned, and make or adopt one
    // now if the cloud engine is chosen.
    const unchanged = readMiniMaxKeyPlain() === checked.trimmed;
    const { encrypted } = setMiniMaxKey(checked.trimmed);
    const svc = voice.minimaxVoice;
    if (svc !== null) {
      if (unchanged) {
        if (voice.engine === "minimax" && svc.voice() === null) {
          void svc.prepare();
        }
      } else {
        void svc.reset().then(() => {
          if (voice.engine === "minimax") return svc.prepare();
          return undefined;
        });
      }
    }
    return {
      ok: true as const,
      encrypted,
      unverified: checked.unverified,
      status: getMiniMaxKeyStatus(),
    };
  });
  handle(CMD.clearMiniMaxKey, async () => {
    clearMiniMaxKey();
    return { ok: true as const, status: getMiniMaxKeyStatus() };
  });
  // The token-plan key (ADR 0062 §1.8): speaks under the plan, cannot
  // clone. Saving it does not touch the clone; with the cloud chosen and
  // no clone yet it starts a prepare, which may adopt one the account
  // already paid for.
  handle(CMD.getMiniMaxPlanKeyStatus, async () => getMiniMaxPlanKeyStatus());
  handle(CMD.setMiniMaxPlanKey, async (_e, key: string) => {
    const checked = await checkKey(key);
    if (checked === null) {
      return { ok: false as const, reason: "rejected" as const };
    }
    const { encrypted } = setMiniMaxPlanKey(checked.trimmed);
    const svc = voice.minimaxVoice;
    if (svc !== null && voice.engine === "minimax" && svc.voice() === null) {
      void svc.prepare();
    }
    return {
      ok: true as const,
      encrypted,
      unverified: checked.unverified,
      status: getMiniMaxPlanKeyStatus(),
    };
  });
  handle(CMD.clearMiniMaxPlanKey, async () => {
    clearMiniMaxPlanKey();
    return { ok: true as const, status: getMiniMaxPlanKeyStatus() };
  });
  handle(CMD.prepareMiniMaxVoice, async () => {
    if (voice.minimaxVoice === null) throw new Error("cloud voice not up");
    return voice.minimaxVoice.prepare();
  });
  handle(CMD.resetMiniMaxVoice, async () => {
    if (voice.minimaxVoice === null) throw new Error("cloud voice not up");
    return voice.minimaxVoice.reset();
  });
  handle(CMD.setRealtimeVoice, async (_e, enabled: boolean) => {
    const next = enabled === true;
    voice.realtimeEnabled = next;
    await updateGlobalSettings(app.getPath("userData"), (s) => ({
      ...s,
      realtimeVoice: next,
    }));
  });
  // Settings → Voice → the model row (ADR 0061). Download resolves with
  // the state the download ENDED in; progress rides EVT.voiceModel.
  handle(CMD.downloadVoiceModel, async () => {
    if (voice.voiceModel === null)
      throw new Error("voice model service not up");
    return voice.voiceModel.download();
  });
  handle(CMD.cancelVoiceModelDownload, async () => {
    voice.voiceModel?.cancel();
  });
  handle(CMD.removeVoiceModel, async () => {
    if (voice.voiceModel === null)
      throw new Error("voice model service not up");
    return voice.voiceModel.remove();
  });
  // Settings → DeepSeek key. The secure store is the single source of truth;
  // `host.setDeepSeekKey` mirrors it to the running session's live key so the
  // NEXT turn uses it with no restart. Only the masked status crosses back to
  // the renderer (the raw key stays in main).
  handle(CMD.getDeepSeekKeyStatus, () => getDeepSeekKeyStatus());
  handle(CMD.setDeepSeekKey, async (_e, key: string) => {
    const trimmed = key.trim();
    // Validate before persisting (a cheap token-free auth check). A rejected
    // key is never stored, so "Connected" stays truthful and no doomed turn
    // ever runs. A check we couldn't complete (offline) saves anyway, flagged
    // `unverified`, rather than blocking the user.
    const verdict = await validateDeepSeekKey(trimmed);
    if (verdict === "rejected") {
      return { ok: false as const, reason: "rejected" as const };
    }
    const { encrypted } = setDeepSeekKey(trimmed);
    deps.host()?.setDeepSeekKey(trimmed);
    return {
      ok: true as const,
      encrypted,
      status: getDeepSeekKeyStatus(),
      unverified: verdict === "unreachable",
    };
  });
  handle(CMD.clearDeepSeekKey, () => {
    clearDeepSeekKey();
    deps.host()?.setDeepSeekKey("");
    return { ok: true as const, status: getDeepSeekKeyStatus() };
  });
}
