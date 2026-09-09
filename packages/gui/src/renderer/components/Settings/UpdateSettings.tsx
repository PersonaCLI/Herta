import { useEffect, useState } from "react";
import { NETDISK_URL } from "../../../shared/links.js";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type { UpdateState } from "../../ipc/bridge-types.js";
import { SettingRow } from "./SettingRow.js";
import { Toggle } from "./Toggle.js";

/**
 * Settings → Update (2026-07-10): current version + update state + the two
 * actions (manual check; restart-and-install once ready). The bridge surface
 * is OPTIONAL — the website demo and test fakes omit it, and this pane then
 * shows only the version line (or nothing at all when even that is absent).
 *
 * The state itself streams from main (check on launch + every 4h, background
 * differential download, install-on-quit). Deterministic chrome: the harness
 * owns the update decision; nothing here is persona.
 */
export function UpdateSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const [version, setVersion] = useState<string | null>(null);
  const [state, setState] = useState<UpdateState>({ phase: "idle" });
  // Automatic checks/downloads (2026-07-12): persisted app-global, applied
  // live by main. Default true; the row hides when the bridge lacks the
  // setting (fakes / the website demo).
  const [autoUpdate, setAutoUpdate] = useState(true);
  const supported = bridge.checkForUpdate !== undefined;
  const autoSupported = bridge.setAutoUpdate !== undefined;

  useEffect(() => {
    let alive = true;
    void bridge.getAppVersion?.().then((v) => {
      if (alive) setVersion(v);
    });
    // Invoke-time snapshot first (a `ready` reached before this pane mounted
    // must show), then the live stream.
    void bridge.getUpdateState?.().then((s) => {
      if (alive) setState(s);
    });
    void bridge.getAutoUpdate?.().then((on) => {
      if (alive) setAutoUpdate(on);
    });
    const unsub = bridge.onUpdate?.((s) => setState(s));
    return () => {
      alive = false;
      unsub?.();
    };
  }, [bridge]);

  const statusText = ((): string => {
    switch (state.phase) {
      case "checking":
        return t("update.checking");
      case "available":
        return `${t("update.available")} v${state.version ?? "?"}`;
      case "downloading":
        return `${t("update.downloading")} ${state.progress ?? 0}%`;
      case "ready":
        return `${t("update.ready")} v${state.version ?? "?"}`;
      case "error":
        // The feed could not be reached (offline, a blocked region — GitHub
        // is the feed): say that, and where else the build is, instead of
        // the raw error (owner 2026-09-09).
        if (state.network === true) return t("update.unreachable");
        return `${t("update.error")}${
          state.message !== undefined ? `: ${state.message}` : ""
        }`;
      case "up-to-date":
        return t("update.upToDate");
      default:
        // `idle` = no news, NOT "you are current" (audit 2026-07-24, 1.13):
        // never checked, auto-update off, unsupported build, or an automatic
        // check that failed silently by design. Claiming "已是最新" from that
        // told an offline user they were on the newest build.
        return t("update.notChecked");
    }
  })();

  return (
    <>
      <p className="settings-intro">{t("update.intro")}</p>
      <p className="settings-intro">
        <strong>{t("update.betaLead")}</strong>
        {t("update.betaNotice")}
      </p>
      <SettingRow
        title={t("update.currentVersion")}
        description={version !== null ? `v${version}` : "—"}
        control={
          supported ? (
            state.phase === "ready" ? (
              <button
                type="button"
                className="settings-btn settings-btn--primary"
                onClick={() => void bridge.restartAndInstall?.()}
              >
                {t("update.restartNow")}
              </button>
            ) : (
              <button
                type="button"
                className="settings-btn"
                disabled={
                  state.phase === "checking" || state.phase === "downloading"
                }
                onClick={() => void bridge.checkForUpdate?.()}
              >
                {t("update.checkNow")}
              </button>
            )
          ) : (
            <span className="settings-note">{t("update.unsupported")}</span>
          )
        }
      />
      {supported && autoSupported && (
        <SettingRow
          title={t("update.auto")}
          description={t("update.autoDesc")}
          control={
            <Toggle
              checked={autoUpdate}
              ariaLabel={t("update.auto")}
              onChange={(next) => {
                setAutoUpdate(next);
                void bridge.setAutoUpdate?.(next);
              }}
            />
          }
        />
      )}
      {supported && (
        <p className="settings-note" data-testid="update-status">
          {statusText}
          {state.phase === "error" &&
            state.network === true &&
            bridge.openExternal !== undefined && (
              <>
                {" "}
                <button
                  type="button"
                  className="settings-note-action"
                  onClick={() => void bridge.openExternal?.(NETDISK_URL)}
                >
                  {t("update.netdisk")}
                </button>
              </>
            )}
        </p>
      )}
      {/* Attribution (audit S12). The app carries the character's name, her
          likeness and her voice, and said nowhere inside itself that this is
          an unofficial fan project. It sits beside the version row because
          that is where someone looks to find out what this thing is. */}
      <p className="settings-note settings-fan-notice" data-testid="fan-notice">
        {t("app.fanNotice")}
      </p>
    </>
  );
}
