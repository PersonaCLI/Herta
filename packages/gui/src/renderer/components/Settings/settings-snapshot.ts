import { useCallback, useState } from "react";
import type {
  AttentionSettings,
  BackendContractChoice,
  BackendThinking,
  DeepSeekKeyStatus,
  HertaBridge,
  InteractionLanguageChoice,
  MiniMaxRefusalState,
  MiniMaxVoiceState,
  ModelConfig,
  RealtimeVoiceState,
  UpdateState,
  VoiceEngine,
  VoiceModelState,
} from "../../ipc/bridge-types.js";

/**
 * The last-known value of every read a Settings pane makes (owner
 * 2026-09-18: "some sections' status are loaded when clicked into that
 * section, which will cause the UX flash").
 *
 * A pane mounts when its nav item is clicked, and every pane used to start
 * from a default and correct itself when its read landed a few frames later:
 * 检查中… → 已连接 plus a delete link, the local-model row → the two MiniMax
 * key rows, — → v0.1.5. With a default that matches the stored value nothing
 * showed; with one that does not, every switch into the pane popped.
 *
 * So the pane's FIRST frame renders what was last known. `SettingsModal`
 * primes this store at app start and again on every open — long before a
 * click can reach a second section — and each pane writes its own state
 * through it, so a change made in a pane is what that pane shows when the
 * user comes back. The pane still reads on mount; that read now confirms
 * rather than reveals, and only a value that really changed in between
 * (a download finishing while another section was up) moves anything.
 *
 * Keyed by the bridge object: one store per app, and a fresh one per test.
 */
export interface SettingsSnapshot {
  "language.interaction": InteractionLanguageChoice;
  "window.closeToTray": boolean;
  "window.attention": AttentionSettings;
  "window.predictions": boolean;
  "update.version": string | null;
  "update.state": UpdateState;
  "update.auto": boolean;
  "voice.realtime": RealtimeVoiceState | null;
  "voice.model": VoiceModelState | null;
  "voice.engine": VoiceEngine;
  "voice.minimaxKey": DeepSeekKeyStatus | null;
  "voice.minimaxPlanKey": DeepSeekKeyStatus | null;
  "voice.clone": MiniMaxVoiceState | null;
  "voice.refusal": MiniMaxRefusalState | null;
  /** A MiniMax key saved while the platform could not check it (未核对).
   *  Only the save's answer says so — main keeps no such flag, so no read
   *  primes these; the pane's own write is what a remount shows (UX review
   *  2026-09-22, item 25: it read 已连接 after the pane was reopened). */
  "voice.minimaxKeyUnverified": boolean;
  "voice.minimaxPlanKeyUnverified": boolean;
  "dream.enabled": boolean;
  "deepseek.keyStatus": DeepSeekKeyStatus | null;
  "deepseek.models": ModelConfig;
  "banzhuan.thinking": BackendThinking;
  "banzhuan.contract": BackendContractChoice;
  "banzhuan.bashFound": boolean | undefined;
  "banzhuan.pdfPictureTranscripts": boolean;
}

type Key = keyof SettingsSnapshot;

interface Store {
  readonly values: Map<Key, unknown>;
  /** Bumped on every write — a prime that started before a pane's write
   *  must not put the older value back over it. */
  readonly versions: Map<Key, number>;
}

const stores = new WeakMap<object, Store>();

function storeFor(bridge: object): Store {
  let s = stores.get(bridge);
  if (s === undefined) {
    s = { values: new Map(), versions: new Map() };
    stores.set(bridge, s);
  }
  return s;
}

/** The last-known value, or `undefined` when nothing has been read yet. */
export function peekSetting<K extends Key>(
  bridge: object,
  key: K,
): SettingsSnapshot[K] | undefined {
  const s = stores.get(bridge);
  if (s === undefined || !s.values.has(key)) return undefined;
  return s.values.get(key) as SettingsSnapshot[K];
}

export function rememberSetting<K extends Key>(
  bridge: object,
  key: K,
  value: SettingsSnapshot[K],
): void {
  const s = storeFor(bridge);
  s.values.set(key, value);
  s.versions.set(key, (s.versions.get(key) ?? 0) + 1);
}

/**
 * `useState` whose first value is the last-known one and whose setter
 * writes through to the store. `fallback` is what the pane showed before
 * this store existed — the real handler's default — and still shows when
 * nothing has been read yet (the read failed, or the pane mounted before
 * the first prime landed).
 */
export function useRememberedSetting<K extends Key>(
  bridge: object,
  key: K,
  fallback: SettingsSnapshot[K],
): readonly [SettingsSnapshot[K], (next: SettingsSnapshot[K]) => void] {
  const [value, setValue] = useState<SettingsSnapshot[K]>(() => {
    const s = stores.get(bridge);
    return s?.values.has(key)
      ? (s.values.get(key) as SettingsSnapshot[K])
      : fallback;
  });
  const set = useCallback(
    (next: SettingsSnapshot[K]): void => {
      rememberSetting(bridge, key, next);
      setValue(next);
    },
    [bridge, key],
  );
  return [value, set] as const;
}

/**
 * Read everything the panes read and keep it. Every read is optional on the
 * bridge (the website demo and test fakes omit most) and every failure is
 * silent — the pane's own read on mount is what reports a load failure.
 * A key a pane wrote after this prime began keeps the pane's value.
 */
export function primeSettings(bridge: HertaBridge): void {
  const s = storeFor(bridge);
  const started = new Map(s.versions);
  const keep = <K extends Key>(key: K, value: SettingsSnapshot[K]): void => {
    if ((s.versions.get(key) ?? 0) !== (started.get(key) ?? 0)) return;
    s.values.set(key, value);
  };
  const quiet = (): void => undefined;

  void bridge
    .getInteractionLanguage?.()
    .then((v) => keep("language.interaction", v), quiet);
  void bridge
    .getCloseToTray?.()
    .then((v) => keep("window.closeToTray", v), quiet);
  void bridge.getAttention?.().then((v) => keep("window.attention", v), quiet);
  void bridge.getAppVersion?.().then((v) => keep("update.version", v), quiet);
  void bridge.getUpdateState?.().then((v) => keep("update.state", v), quiet);
  void bridge.getAutoUpdate?.().then((v) => keep("update.auto", v), quiet);
  void bridge.getRealtimeVoice?.().then((v) => {
    keep("voice.realtime", v);
    keep("voice.model", v.model);
    keep("voice.engine", v.engine);
    keep("voice.minimaxKey", v.minimax.key);
    keep("voice.minimaxPlanKey", v.minimax.planKey);
    keep("voice.clone", v.minimax.voice);
    keep("voice.refusal", v.minimax.refusal);
  }, quiet);
  void bridge
    .getDreamConfig?.()
    .then((c) => keep("dream.enabled", c.enabled), quiet);
  void bridge
    .getDeepSeekKeyStatus?.()
    .then((v) => keep("deepseek.keyStatus", v), quiet);
  void bridge.getModelConfig?.().then((v) => keep("deepseek.models", v), quiet);
  void bridge.getBackendConfig?.().then((c) => {
    keep("banzhuan.thinking", c.thinking);
    if (c.contract !== undefined) keep("banzhuan.contract", c.contract);
    keep("banzhuan.bashFound", c.bashFound);
  }, quiet);
  void bridge
    .getPdfPictureTranscripts?.()
    .then((v) => keep("banzhuan.pdfPictureTranscripts", v), quiet);
}
