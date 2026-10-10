import { useEffect, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type { AttentionSettings, ThemePref } from "../../ipc/bridge-types.js";
import { applyThemePref, themePref } from "../../lib/theme.js";
import { Select } from "./Select.js";
import { SettingRow } from "./SettingRow.js";
import { useRememberedSetting } from "./settings-snapshot.js";
import { Toggle } from "./Toggle.js";

/**
 * Settings → Window: appearance (night-mode slice 2) + the close-to-tray
 * toggle (user request 2026-07-06 — the always-on tray behavior becomes a
 * choice) + the attention rows (ADR 0072 §1: notifications while the window
 * is not attended, keep the machine awake while 板砖 runs). LIVE apply on both: the theme stamps <html data-theme> before
 * the persist settles; main updates its close handler the moment the write
 * lands. Mirrors DreamSettings' optimistic-flip/snap-back shape.
 */
export function WindowSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  // The last-known value on the first frame (settings-snapshot.ts); the
  // platform's default only when nothing has been read yet — ON, except on
  // Linux, where main defaults it OFF (app-global-settings.ts,
  // defaultCloseToTray: stock GNOME shows no tray icon).
  const [enabled, setEnabled] = useRememberedSetting(
    bridge,
    "window.closeToTray",
    bridge.platform !== "linux",
  );
  // A Mac has a menu bar, not a system tray, and stays in the Dock when its
  // window closes — "quit on close" is not what happens there (2026-09-23).
  const isMac = bridge.platform === "darwin";
  const [failed, setFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // Seed from the controller (already booted by App) — no async flash.
  const [theme, setTheme] = useState<ThemePref>(() => themePref());
  // Attention (ADR 0072 §1): the rows exist when the bridge can read them
  // (the website demo's cannot); both default on, like main's reading.
  const hasAttention = bridge.getAttention !== undefined;
  const [attention, setAttention] = useRememberedSetting(
    bridge,
    "window.attention",
    { notifications: true, keepAwake: true },
  );
  // Composer predictions (2026-10-10): on unless turned off, like main's
  // reading; the row exists when the bridge can read it.
  const hasPredictions = bridge.getComposerPredictions !== undefined;
  const [predictions, setPredictions] = useRememberedSetting(
    bridge,
    "window.predictions",
    true,
  );

  useEffect(() => {
    if (bridge.getComposerPredictions === undefined) return;
    let alive = true;
    bridge.getComposerPredictions().then(
      (v) => {
        if (alive) setPredictions(v);
      },
      () => {
        if (alive) setLoadFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge, setPredictions]);

  const onPredictions = (next: boolean): void => {
    // Optimistic, like the rows above: flip now, snap back on a failed write.
    setPredictions(next);
    setFailed(false);
    void bridge.setComposerPredictions?.(next).catch(() => {
      setPredictions(!next);
      setFailed(true);
    });
  };

  useEffect(() => {
    if (bridge.getAttention === undefined) return;
    let alive = true;
    bridge.getAttention().then(
      (v) => {
        if (alive) setAttention(v);
      },
      () => {
        if (alive) setLoadFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge, setAttention]);

  const onAttention = (change: Partial<AttentionSettings>): void => {
    // Optimistic, like close-to-tray: flip now, snap back on a failed write.
    const before = attention;
    setAttention({ ...attention, ...change });
    setFailed(false);
    void bridge.setAttention?.(change).catch(() => {
      setAttention(before);
      setFailed(true);
    });
  };

  const onTheme = (next: ThemePref): void => {
    // Apply LIVE first (the whole point), then persist. A failed write
    // keeps the live theme but flags the save error — snapping the theme
    // back would flash the UI over a disk hiccup.
    setTheme(next);
    applyThemePref(next);
    setFailed(false);
    void bridge.setTheme?.(next).catch(() => setFailed(true));
  };

  useEffect(() => {
    let alive = true;
    bridge.getCloseToTray().then(
      (v) => {
        if (alive) setEnabled(v);
      },
      () => {
        if (alive) setLoadFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge, setEnabled]);

  const onChange = (next: boolean): void => {
    // Optimistic: flip now, persist async. On a failed write, snap back so
    // the toggle never claims a state that didn't reach disk.
    setEnabled(next);
    setFailed(false);
    void bridge.setCloseToTray(next).catch(() => {
      setEnabled(!next);
      setFailed(true);
    });
  };

  return (
    <>
      <p className="settings-intro">{t("window.intro")}</p>
      <SettingRow
        title={t("window.theme")}
        description={t("window.themeDesc")}
        control={
          <Select
            value={theme}
            ariaLabel={t("window.theme")}
            options={[
              { value: "light", label: t("theme.light") },
              { value: "dark", label: t("theme.dark") },
              { value: "system", label: t("theme.system") },
            ]}
            onChange={onTheme}
          />
        }
      />
      <SettingRow
        title={t(isMac ? "window.closeToTrayMac" : "window.closeToTray")}
        description={t(
          isMac ? "window.closeToTrayDescMac" : "window.closeToTrayDesc",
        )}
        control={
          <Toggle
            checked={enabled}
            ariaLabel={t(
              isMac ? "window.closeToTrayMac" : "window.closeToTray",
            )}
            onChange={onChange}
          />
        }
      />
      {hasAttention && (
        <>
          <SettingRow
            title={t("window.notifications")}
            description={t("window.notificationsDesc")}
            control={
              <Toggle
                checked={attention.notifications}
                ariaLabel={t("window.notifications")}
                onChange={(next) => onAttention({ notifications: next })}
              />
            }
          />
          <SettingRow
            title={t("window.keepAwake")}
            description={t("window.keepAwakeDesc")}
            control={
              <Toggle
                checked={attention.keepAwake}
                ariaLabel={t("window.keepAwake")}
                onChange={(next) => onAttention({ keepAwake: next })}
              />
            }
          />
        </>
      )}
      {hasPredictions && (
        <SettingRow
          title={t("window.predictions")}
          description={t("window.predictionsDesc")}
          control={
            <Toggle
              checked={predictions}
              ariaLabel={t("window.predictions")}
              onChange={onPredictions}
            />
          }
        />
      )}
      {failed ? (
        <p className="settings-note">{t("common.couldntSave")}</p>
      ) : (
        loadFailed && (
          <p className="settings-note">{t("settings.loadFailed")}</p>
        )
      )}
    </>
  );
}
