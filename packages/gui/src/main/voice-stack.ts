/**
 * Herta's synthesized voice in the desktop's main process: the local
 * synthesizer and its model download (ADR 0042, ADR 0061), the cloud voice
 * beside them (ADR 0062), and the one switching synthesizer the sessions
 * speak through. It was six variables of the session service's closure, their
 * construction in its bootstrap and their disposal (review 2026-11-10, moved
 * 2026-11-25); the service still decides WHEN each half starts, because the
 * two halves sit either side of its own read of the startup settings.
 *
 * Built once per window and shared by every session. The flags the
 * synthesizers read at every speech stream's start are cached here, so
 * `available()` never touches disk and a Settings toggle applies to the very
 * next reply; Settings reads and writes them through `settings`.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { SpeechSynthesizer } from "@herta/app-server";
import { net } from "electron";
import { EVT } from "../preload/channels.js";
import type { MiniMaxRefusalState } from "../renderer/ipc/bridge-types.js";
import {
  type GlobalSettings,
  updateGlobalSettings,
  type VoiceEngine,
} from "./app-global-settings.js";
import { installMode } from "./install-mode.js";
import { readMiniMaxKeyPlain, readMiniMaxPlanKeyPlain } from "./key-store.js";
import type { VoiceSettingsState } from "./settings-ipc.js";
import { createFallbackFetch } from "./tts/fallback-fetch.js";
import {
  createMiniMaxSynthesizer,
  type MiniMaxSynthesizer,
} from "./tts/minimax-synthesizer.js";
import {
  createMiniMaxVoiceService,
  type MiniMaxVoiceService,
} from "./tts/minimax-voice.js";
import { createSwitchingSynthesizer } from "./tts/switching-synthesizer.js";
import {
  createTtsSynthesizer,
  resolveSherpaEntry,
  type TtsSynthesizer,
} from "./tts/synthesizer.js";
import {
  resolveTtsModelRoots,
  resolveVoiceCloneReference,
  TTS_BUNDLE_ID,
  TTS_EFFECT,
  voiceModelStoreRoot,
} from "./tts/tts-path.js";
import {
  TTS_ARCHIVE_BYTES,
  TTS_ARCHIVE_SHA256,
  TTS_ARCHIVE_URL,
  TTS_ARCHIVE_URL_ENV,
  TTS_BUNDLE_BYTES,
} from "./tts/tts-release.js";
import {
  createVoiceModelService,
  type VoiceModelService,
} from "./tts/voice-model.js";

/** Where the voice files live for this start. */
export interface VoiceStackPaths {
  readonly userDataPath: string;
  readonly workspaceRoot: string;
}

export interface VoiceStack {
  /** The live state Settings' Voice rows read and write (settings-ipc.ts). */
  readonly settings: VoiceSettingsState;
  /** The local synthesizer and its model download. The utility process
   *  starts LAZILY on the first sentence, so an install that never speaks
   *  never pays the model load. Set `settings.realtimeEnabled` from the
   *  stored setting first. */
  startLocal(paths: VoiceStackPaths): void;
  /** The cloud voice beside the local one, from the stored engine and clone
   *  record. Call after `startLocal`; answers the one synthesizer the
   *  app-server sees, which switches between the two. */
  startCloud(
    paths: VoiceStackPaths & { readonly settings: GlobalSettings },
  ): SpeechSynthesizer;
  /** Ends the worker process and a download in flight. The stack is started
   *  again on the next bootstrap. */
  dispose(): void;
}

export function createVoiceStack(
  send: (channel: string, payload: unknown) => void,
): VoiceStack {
  // Herta's synthesized voice (ADR 0042). Built once at bootstrap and shared
  // by every session; the enable flag is cached here so `available()` — read
  // at every speech stream's start — never touches disk, and the Settings
  // toggle applies to the very next reply.
  let synthesizer: TtsSynthesizer | null = null;
  let realtimeVoiceEnabled = true;
  // The model as a download (ADR 0061): built beside the synthesizer, it
  // owns the bundle directory under userData and tells the synthesizer to
  // re-probe when a download lands or the bundle is removed.
  let voiceModel: VoiceModelService | null = null;
  // The cloud voice (ADR 0062): which engine speaks (cached from settings,
  // read at every stream's start), the MiniMax synthesizer and the clone it
  // uses. The key itself stays in the secure store and is read per call.
  let voiceEngine: VoiceEngine = "local";
  let minimaxSynth: MiniMaxSynthesizer | null = null;
  let minimaxVoice: MiniMaxVoiceService | null = null;
  // The cloud voice's network path (ADR 0062 §1.4, amended): Chromium's
  // proxy-aware `net.fetch` first — the same stack the DeepSeek calls use —
  // and Node's `fetch` only when Chromium could not connect at all. On the
  // owner's second machine Chromium reached DeepSeek but failed the TLS
  // handshake to both MiniMax hosts; a second stack is the only lever the
  // app has there. Called after `whenReady` only (the handlers and the
  // services are wired inside `start`).
  const minimaxFetch = createFallbackFetch(
    [(url, init) => net.fetch(url, init), (url, init) => fetch(url, init)],
    (line) => console.log(line),
  );
  /** Either MiniMax key is enough to try for a voice: the pay-as-you-go
   *  one clones, the plan one can adopt (ADR 0062 §1.8). */
  const anyMiniMaxKey = (): boolean =>
    readMiniMaxKeyPlain() !== null || readMiniMaxPlanKeyPlain() !== null;
  // The synthesizer's refusal, blamed on the key that spoke: the plan key
  // when set (speech prefers it), else the API key. The synthesizer forgets
  // a refusal when its key changes, so the key in use now is the one it was
  // answered for.
  const minimaxRefusal = (): MiniMaxRefusalState | null => {
    const reason = minimaxSynth?.status().refusal ?? null;
    if (reason === null) return null;
    return {
      reason,
      key: readMiniMaxPlanKeyPlain() !== null ? "plan" : "api",
    };
  };

  const settings: VoiceSettingsState = {
    get synthesizer() {
      return synthesizer;
    },
    get voiceModel() {
      return voiceModel;
    },
    get minimaxVoice() {
      return minimaxVoice;
    },
    get engine() {
      return voiceEngine;
    },
    set engine(next) {
      voiceEngine = next;
    },
    get realtimeEnabled() {
      return realtimeVoiceEnabled;
    },
    set realtimeEnabled(next) {
      realtimeVoiceEnabled = next;
    },
    minimaxFetch,
    anyMiniMaxKey,
    minimaxRefusal,
    stopSpeech: () => {
      synthesizer?.stopWorker();
      minimaxSynth?.cancelAll();
    },
  };

  function startLocal({ userDataPath, workspaceRoot }: VoiceStackPaths): void {
    synthesizer = createTtsSynthesizer({
      // The downloaded copy first, the dev workspace's second (ADR 0061);
      // a packaged app has only the first.
      modelRoots: resolveTtsModelRoots({
        userDataPath,
        isPackaged: installMode().installed,
        workspaceRoot,
      }),
      // electron.vite.config.ts emits the worker beside the main bundle;
      // it is a plain .cjs on purpose — a native addon cannot be bundled.
      workerPath: join(__dirname, "tts-worker.cjs"),
      sherpaPath: resolveSherpaEntry({
        isPackaged: installMode().installed,
        resourcesPath: installMode().resourcesPath,
        startDir: __dirname,
      }),
      enabled: () => realtimeVoiceEnabled,
      // Not on this thread at launch: the probe stats every file the
      // bundle's manifest lists (~50 ms, ADR 0068 §14).
      probeInBackground: true,
    });
    // The model download (ADR 0061). The archive's location is pinned
    // with its hash; a dev run may point it at a local server for the
    // lab — NEVER a packaged build (the T1.3 rule the update feed and
    // the DeepSeek base URL already follow).
    const override = installMode().installed
      ? undefined
      : process.env[TTS_ARCHIVE_URL_ENV];
    const synth = synthesizer;
    voiceModel = createVoiceModelService({
      root: voiceModelStoreRoot(userDataPath),
      bundleId: TTS_BUNDLE_ID,
      archive: {
        url:
          override !== undefined && override !== ""
            ? override
            : TTS_ARCHIVE_URL,
        sha256: TTS_ARCHIVE_SHA256,
        bytes: TTS_ARCHIVE_BYTES,
        unpackedBytes: TTS_BUNDLE_BYTES,
      },
      // Electron's client: proxy-aware, and the session's certificate
      // policy applies. The signal aborts the transfer on cancel.
      fetch: (url, init) => net.fetch(url, { signal: init.signal }),
      onChange: (state) => send(EVT.voiceModel, state),
      // The worker holds the bundle's files open; stop it before the
      // files go (it forks afresh on the next request if a bundle is
      // still there).
      beforeRemove: () => synth.stopWorker(),
      afterChange: () => {
        synth.refreshBundle();
      },
    });
  }

  // The cloud voice (ADR 0062) beside the local one, both behind one
  // switching synthesizer the app-server sees. The engine and the clone
  // record come from settings; the key from the secure store, per call.
  function startCloud({
    userDataPath,
    workspaceRoot,
    settings: startupSettings,
  }: VoiceStackPaths & {
    readonly settings: GlobalSettings;
  }): SpeechSynthesizer {
    if (synthesizer === null) {
      throw new Error("voice stack: startCloud before startLocal");
    }
    voiceEngine = startupSettings.voiceEngine ?? "local";
    const referencePath = resolveVoiceCloneReference({
      isPackaged: installMode().installed,
      resourcesPath: installMode().resourcesPath,
      workspaceRoot,
    });
    const fetchLike = minimaxFetch;
    minimaxVoice = createMiniMaxVoiceService({
      fetch: fetchLike,
      key: readMiniMaxKeyPlain,
      planKey: readMiniMaxPlanKeyPlain,
      readReference: async () => {
        try {
          return new Uint8Array(await readFile(referencePath));
        } catch {
          return null;
        }
      },
      initial: startupSettings.minimaxVoice ?? null,
      save: async (record) => {
        await updateGlobalSettings(userDataPath, (s) => ({
          ...s,
          minimaxVoice: record ?? undefined,
        }));
      },
      onChange: (state) => send(EVT.voiceMinimax, state),
    });
    const voiceService = minimaxVoice;
    // An install that chose the cloud and has a key but no clone yet (a
    // reset, a settings file from before the clone existed): make it at
    // start, unasked — the user never operates the clone.
    if (
      voiceEngine === "minimax" &&
      anyMiniMaxKey() &&
      voiceService.voice() === null
    ) {
      void voiceService.prepare();
    }
    minimaxSynth = createMiniMaxSynthesizer({
      fetch: fetchLike,
      // Speech goes through the plan when there is one (§1.8), else it is
      // billed to the pay-as-you-go key.
      key: () => readMiniMaxPlanKeyPlain() ?? readMiniMaxKeyPlain(),
      voice: () => voiceService.voice(),
      enabled: () => realtimeVoiceEnabled && voiceEngine === "minimax",
      applyEffect: loadCommChannelEffect(),
      onVoiceMissing: (id) => voiceService.markMissing(id),
      onUsed: () => voiceService.stampUsed(),
      onRefusal: () => send(EVT.voiceMinimaxSpeech, minimaxRefusal()),
    });
    return createSwitchingSynthesizer({
      engine: () => voiceEngine,
      local: synthesizer,
      minimax: minimaxSynth,
    });
  }

  function dispose(): void {
    // The voice worker is a CHILD PROCESS: left running it would outlive the
    // window and hold ~200 MB of loaded model. A download in flight dies
    // with the window (its partial file is discarded by the downloader
    // itself); the services are rebuilt with the synthesizer on the next
    // start.
    voiceModel?.cancel();
    voiceModel = null;
    minimaxSynth?.dispose();
    minimaxSynth = null;
    minimaxVoice = null;
    synthesizer?.dispose();
    synthesizer = null;
  }

  return { settings, startLocal, startCloud, dispose };
}

/**
 * The station-terminal treatment for the cloud voice, from the vendored
 * `.cjs` emitted beside the main bundle (the worker requires the same file
 * the same way). Absent — a dev tree before a build — the cloud voice
 * plays dry rather than not at all.
 */
function loadCommChannelEffect():
  | ((samples: Float32Array, sampleRate: number) => Float32Array)
  | undefined {
  try {
    const mod = createRequire(__filename)(
      join(__dirname, "comm-channel-effect.cjs"),
    ) as {
      applyCommChannel: (
        samples: Float32Array,
        sampleRate: number,
        options: { preset: string },
      ) => Float32Array;
    };
    return (samples, sampleRate) =>
      mod.applyCommChannel(samples, sampleRate, { preset: TTS_EFFECT });
  } catch (err) {
    console.warn(
      `[herta-minimax] comm-channel effect unavailable, playing dry: ${String(err)}`,
    );
    return undefined;
  }
}
