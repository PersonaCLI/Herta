/**
 * The Settings rows' IPC (2026-09-11, the post-0.1.5 refactor pass): every
 * `settings:*` handler the desktop's session service registers — Dream,
 * the coprocessor's effort and contract, the DeepSeek model rows and key,
 * the UI and interaction languages, close-to-tray, automatic updates, the
 * appearance, the PDF-picture switch, the real-time voice with its engine,
 * the MiniMax keys and clone, the model download. They were a 370-line
 * block inside the service's 1 200-line handler closure; the service still
 * registers them at construction (synchronously, before any bootstrap —
 * the renderer's first invokes must never find "No handler registered"),
 * and hands them the live voice state it owns through `VoiceSettingsState`
 * (getters and setters over the service's own variables, so the flags the
 * synthesizer reads at every stream's start stay the service's).
 *
 * The rows that only store a value answer one keyed pair since 2026-11-23
 * (owner, from the review of 2026-11-10): `settings:get` / `settings:set`
 * over `settingRows`, a table keyed like `SETTING_KEYS`, where each row had
 * a channel pair, a preload line, a bridge pair and a demo stub of its own.
 * The keys, the voice engine and the model download keep their channels.
 */
import type { SessionHost } from "@herta/app-server";
import { validateDeepSeekKey } from "@herta/providers";
import { findBash } from "@herta/tools";
import { app, type ipcMain } from "electron";
import { CMD } from "../preload/channels.js";
import type {
  AttentionSettings,
  InteractionLanguageChoice,
  MiniMaxRefusalState,
  RealtimeVoiceState,
  SettingReads,
} from "../renderer/ipc/bridge-types.js";
import { isSettingKey, type SettingKey } from "../shared/setting-keys.js";
import type { VoiceEngine } from "./app-global-settings.js";
import {
  composerPredictionsEnabled,
  defaultCloseToTray,
  type GlobalSettings,
  type Locale,
  osLocale,
  pdfPictureTranscriptsEnabled,
  readGlobalSettings,
  resolveInitialLocale,
  type ThemePref,
  updateGlobalSettings,
} from "./app-global-settings.js";
import {
  type AppSettings,
  dreamEnabled,
  effectiveModels,
  isBackendThinking,
  isModelChoice,
  normalizeModelChoice,
  readAppSettings,
  updateAppSettings,
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
  /** Settles once main has recovered the PATH a terminal would have (the
   *  login shell's on macOS / Linux, the registry's on Windows). The window
   *  no longer waits for it (review 2026-11-10: up to 3 s on macOS/Linux);
   *  whatever reads PATH waits here instead: the session bootstrap, before
   *  any shell or probe is started, and the bash check below. Absent in
   *  tests: nothing to wait for. */
  readonly pathReady?: Promise<unknown>;
  /** Fired after Settings → Language persists a new locale. Lets main-side
   *  surfaces that render OUTSIDE the renderer (the tray hover tooltip —
   *  drawn by the OS, so no React re-render reaches it) re-resolve their
   *  strings immediately instead of showing the old language until restart. */
  readonly onLocaleChanged?: () => void;
  /** Fired after Settings → Window persists the close-to-tray flag. The
   *  window close handler lives in main's index.ts — this hook updates its
   *  cached flag so the change applies to the very next close click. */
  readonly onCloseToTrayChanged?: (enabled: boolean) => void;
  /** Fired after Settings → Window persists an attention setting (ADR 0072
   *  §1), with both values as they now stand — the watcher reads them at
   *  every event, so the change applies to the next one. */
  readonly onAttentionChanged?: (prefs: AttentionSettings) => void;
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
  /** The speech synthesizer's standing refusal, blamed on the key that
   *  spoke (ADR 0062 §5). */
  readonly minimaxRefusal: () => MiniMaxRefusalState | null;
  /** End the speech in flight — the toggle turned off mid-reply (ADR 0042
   *  §7c): the local worker stops, the cloud requests abort; each unit
   *  answers null and types unvoiced. */
  readonly stopSpeech: () => void;
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
  /** The Dream flag the RUNNING host was built with; undefined before
   *  bootstrap. Optional for tests. */
  readonly dreamRunning?: () => boolean | undefined;
}

/** The attention settings as they stand: absent = on (ADR 0072 §1). */
export function attentionSettingsOf(s: GlobalSettings): AttentionSettings {
  return {
    notifications: s.notifications ?? true,
    keepAwake: s.keepAwake ?? true,
  };
}

/** One Settings row in main: how its value is read, and how a value the
 *  renderer sent is checked and persisted. `set` takes the value unchecked:
 *  each row validates its own, as each channel's handler did. */
interface SettingRow<K extends SettingKey> {
  readonly get: () => Promise<SettingReads[K]>;
  readonly set: (value: unknown) => Promise<void>;
}

type SettingRows = { readonly [K in SettingKey]: SettingRow<K> };

/** The table behind `settings:get` / `settings:set` (owner 2026-11-23),
 *  keyed like `SETTING_KEYS`: the mapped type makes a key without a row a
 *  build error. Exported for the tests. */
export function settingRows(deps: SettingsIpcDeps): SettingRows {
  const { hooks, voice, workspaceRoot } = deps;
  const userData = (): string => app.getPath("userData");
  return {
    // Settings → Dream. Restart-to-apply: read/write the persisted flag; the
    // running app-server is untouched (it reads config.dream at next
    // bootstrap). The answer carries what the running app has too
    // (`running`): the pane's "restart to apply" note compares against it,
    // not against the file it read on mount — a pane reopened after a change
    // showed ON with no note while the running app still had the old value
    // (dream review 2026-09-22, finding 20).
    dream: {
      get: async () => {
        const s = await readAppSettings(workspaceRoot());
        const running = deps.dreamRunning?.();
        return {
          enabled: dreamEnabled(s),
          ...(running !== undefined ? { running } : {}),
        };
      },
      set: async (value) => {
        const cfg = value as { enabled: boolean };
        await updateAppSettings(workspaceRoot(), (s) => ({
          ...s,
          dream: { ...s.dream, enabled: cfg.enabled },
        }));
      },
    },
    // Settings → Coprocessor: backend reasoning effort. It applies from
    // 板砖's next dispatch (ADR 0081).
    backend: {
      get: async () => {
        const s = await readAppSettings(workspaceRoot());
        const v = s.backend?.thinking;
        // `findBash` reads PATH: on Windows it finds bash beside the git
        // there.
        await hooks.pathReady;
        return {
          thinking: isBackendThinking(v) ? v : "high",
          // Whether 板砖 can run here at all (ADR 0086): it needs a bash,
          // and the pane says so when there is none.
          bashFound: findBash() !== null,
        };
      },
      set: async (value) => {
        const cfg = value as { thinking?: unknown } | null | undefined;
        // Validate like theme/locale: an off-enum value would fail the
        // read-side shape check downstream — refuse it instead of
        // persisting.
        const thinking = isBackendThinking(cfg?.thinking)
          ? cfg.thinking
          : undefined;
        if (thinking === undefined) return;
        const next = await updateAppSettings(
          workspaceRoot(),
          (s): AppSettings => ({
            ...s,
            backend: { ...s.backend, thinking },
          }),
        );
        deps.host()?.setModels({ thinking: effectiveModels(next).thinking });
      },
    },
    // Settings → DeepSeek → 模型: per-stage model (2026-08-17). An env
    // override, if set, still wins at the next bootstrap — it is the dev/lab
    // knob.
    model: {
      get: async () => {
        const s = await readAppSettings(workspaceRoot());
        return {
          actor: normalizeModelChoice(s.models?.actor) ?? "deepseek-v4-pro",
          // Default `deepseek-flash` (the vision-capable flash, ADR 0048
          // §5a/§5b) — must match buildConfig's, or the pane shows a model
          // the next boot will not use. A legacy name in the file reads as
          // its successor here too, so the pane shows what the boot will
          // run.
          backend: normalizeModelChoice(s.models?.backend) ?? "deepseek-flash",
        };
      },
      set: async (value) => {
        const cfg = value as
          | { actor?: unknown; backend?: unknown }
          | null
          | undefined;
        if (!isModelChoice(cfg?.actor) || !isModelChoice(cfg?.backend)) return;
        const { actor, backend } = cfg;
        const next = await updateAppSettings(
          workspaceRoot(),
          (s): AppSettings => ({
            ...s,
            models: { ...s.models, actor, backend },
          }),
        );
        // Live (ADR 0081): Herta's next turn and 板砖's next dispatch use
        // them. An env override still wins, as at a fresh start.
        const live = effectiveModels(next);
        deps.host()?.setModels({
          actorModel: live.actorModel,
          backendModel: live.backendModel,
        });
      },
    },
    // Settings → Language. App-global (per-user) preference; the renderer
    // applies it live, so this is just persistence. The read resolves a
    // stored choice, else maps the OS locale.
    locale: {
      get: async () => {
        const s = await readGlobalSettings(userData());
        return resolveInitialLocale(s, osLocale(process.platform, app));
      },
      set: async (value) => {
        // Validate like theme: an off-enum value would fail the read-side
        // shape check and silently reset EVERY preference to default.
        if (value !== "zh" && value !== "en") return;
        const locale: Locale = value;
        await updateGlobalSettings(userData(), (s) => ({ ...s, locale }));
        // AFTER the write settles: the hook re-reads the persisted settings,
        // so firing early would re-render the tray tooltip from the OLD
        // file.
        hooks.onLocaleChanged?.();
      },
    },
    // Settings → Language: interaction language (slice 4). Reads the STORED
    // choice ("follow" when absent = follow the UI locale); "follow" DELETES
    // the stored field. Applies to NEW sessions (per-session static prefix +
    // prompt cache) — session activation resolves it fresh.
    interactionLanguage: {
      get: async () => {
        const s = await readGlobalSettings(userData());
        return s.interactionLanguage ?? "follow";
      },
      set: async (value) => {
        // Validate like theme: an off-enum value would fail the read-side
        // shape check and silently reset EVERY preference to default.
        if (value !== "zh" && value !== "en" && value !== "follow") return;
        const choice: InteractionLanguageChoice = value;
        await updateGlobalSettings(userData(), (s) => {
          if (choice === "follow") {
            const { interactionLanguage: _drop, ...rest } = s;
            return rest;
          }
          return { ...s, interactionLanguage: choice };
        });
      },
    },
    // Settings → Window. Close-to-tray is app-global (per-user) and applies
    // LIVE: the hook updates main's cached close-handler flag immediately.
    closeToTray: {
      get: async () => {
        const s = await readGlobalSettings(userData());
        return s.closeToTray ?? defaultCloseToTray(process.platform);
      },
      set: async (value) => {
        const enabled = value === true;
        await updateGlobalSettings(userData(), (s) => ({
          ...s,
          closeToTray: enabled,
        }));
        hooks.onCloseToTrayChanged?.(enabled);
      },
    },
    // Settings → Window: attention (ADR 0072 §1). Both default on; a write
    // carries either or both, and anything but a boolean is ignored.
    attention: {
      get: async () =>
        attentionSettingsOf(await readGlobalSettings(userData())),
      set: async (value) => {
        const prefs = value as
          | { notifications?: unknown; keepAwake?: unknown }
          | null
          | undefined;
        const notifications =
          typeof prefs?.notifications === "boolean"
            ? prefs.notifications
            : undefined;
        const keepAwake =
          typeof prefs?.keepAwake === "boolean" ? prefs.keepAwake : undefined;
        if (notifications === undefined && keepAwake === undefined) return;
        const dir = userData();
        await updateGlobalSettings(dir, (s) => ({
          ...s,
          ...(notifications !== undefined ? { notifications } : {}),
          ...(keepAwake !== undefined ? { keepAwake } : {}),
        }));
        hooks.onAttentionChanged?.(
          attentionSettingsOf(await readGlobalSettings(dir)),
        );
      },
    },
    // Settings → Update: automatic checks/downloads. App-global and applied
    // LIVE via the hook (the update service cancels or restarts its cycle).
    autoUpdate: {
      get: async () => {
        const s = await readGlobalSettings(userData());
        return s.autoUpdate ?? true;
      },
      set: async (value) => {
        const enabled = value === true;
        await updateGlobalSettings(userData(), (s) => ({
          ...s,
          autoUpdate: enabled,
        }));
        hooks.onAutoUpdateChanged?.(enabled);
      },
    },
    // Settings → Appearance (night-mode slice 2). The renderer's theme
    // controller applies it live; main just persists (validated on read).
    // Default "system" (user 2026-07-14): a first launch follows the OS
    // appearance; light/dark stay explicit overrides.
    theme: {
      get: async () => {
        const s = await readGlobalSettings(userData());
        return s.theme ?? "system";
      },
      set: async (value) => {
        if (value !== "light" && value !== "dark" && value !== "system") {
          return;
        }
        const theme: ThemePref = value;
        await updateGlobalSettings(userData(), (s) => ({ ...s, theme }));
        hooks.onThemeChanged?.(theme);
      },
    },
    // Settings → 差分协处理器 → PDF picture transcription (2026-10-01). Per
    // user and LIVE: persisted here, mirrored to the running host, which
    // every session reads at its next attach. Anything but a boolean is
    // ignored.
    pdfPictureTranscripts: {
      get: async () =>
        pdfPictureTranscriptsEnabled(await readGlobalSettings(userData())),
      set: async (value) => {
        if (typeof value !== "boolean") return;
        await updateGlobalSettings(userData(), (s) => ({
          ...s,
          pdfPictureTranscripts: value,
        }));
        deps.host()?.setPdfPictureTranscription(value);
      },
    },
    // Settings → 窗口 → composer predictions (2026-10-10). Per user and LIVE:
    // persisted here, mirrored to the running host, which reads it at every
    // finished turn. Anything but a boolean is ignored.
    composerPredictions: {
      get: async () =>
        composerPredictionsEnabled(await readGlobalSettings(userData())),
      set: async (value) => {
        if (typeof value !== "boolean") return;
        await updateGlobalSettings(userData(), (s) => ({
          ...s,
          composerPredictions: value,
        }));
        deps.host()?.setComposerPredictions(value);
      },
    },
    // Settings → Voice: Herta's real-time synthesized voice (ADR 0042).
    // App-global and applied LIVE — the synthesizer reads the cached flag at
    // every speech stream's start. The read reports the ASSET facts
    // alongside the toggle so the row can explain a silent install rather
    // than claim the voice is on when nothing can speak.
    realtimeVoice: {
      get: async (): Promise<RealtimeVoiceState> => {
        const s = await readGlobalSettings(userData());
        const enabled = s.realtimeVoice ?? true;
        voice.realtimeEnabled = enabled;
        const st = voice.synthesizer?.status();
        return {
          enabled,
          bundle: st?.bundle ?? false,
          runtime: st?.runtime ?? false,
          failed: st?.failed ?? false,
          model: (await voice.voiceModel?.state()) ?? {
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
            refusal: voice.minimaxRefusal(),
          },
        };
      },
      set: async (value) => {
        const next = value === true;
        voice.realtimeEnabled = next;
        // Off mid-reply: the renderer fades what is on air; this ends what
        // is still being made, so the rest of the reply types unvoiced
        // instead of resuming one sentence later (ADR 0042 §7c).
        if (!next) voice.stopSpeech();
        await updateGlobalSettings(userData(), (s) => ({
          ...s,
          realtimeVoice: next,
        }));
      },
    },
  };
}

export function registerSettingsHandlers(deps: SettingsIpcDeps): void {
  const { handle, voice } = deps;
  const rows = settingRows(deps);
  // Every Settings row's value through one keyed pair (owner 2026-11-23).
  // A key that is not a setting is refused, as a channel nobody registered
  // was.
  handle(CMD.getSetting, async (_e, key: unknown) => {
    if (!isSettingKey(key)) throw new Error(`not a setting: ${String(key)}`);
    return rows[key].get();
  });
  handle(CMD.setSetting, async (_e, key: unknown, value: unknown) => {
    if (!isSettingKey(key)) throw new Error(`not a setting: ${String(key)}`);
    await rows[key].set(value);
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
