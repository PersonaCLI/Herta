/**
 * The Settings rows' keys (owner 2026-11-23, from the review of 2026-11-10):
 * one keyed get/set pair carries them all, `settings:get` / `settings:set`,
 * where each had a channel pair of its own (a new setting touched about 11
 * files). The values each key reads and writes are `SettingReads` /
 * `SettingWrites` in `renderer/ipc/bridge-types.ts`; main's handlers are a
 * table keyed the same way (`main/settings-ipc.ts`).
 *
 * The API keys, the workspace, automatic review and the voice engine keep
 * their own channels: a key is stored encrypted and answers with a status,
 * not its value, and the others act as much as they store.
 */
export const SETTING_KEYS = [
  "dream",
  "backend",
  "model",
  "locale",
  "interactionLanguage",
  "closeToTray",
  "attention",
  "autoUpdate",
  "theme",
  "pdfPictureTranscripts",
  "composerPredictions",
  "realtimeVoice",
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

/** Whether `value` names a setting; main refuses any other key. */
export function isSettingKey(value: unknown): value is SettingKey {
  return (
    typeof value === "string" &&
    (SETTING_KEYS as readonly string[]).includes(value)
  );
}
