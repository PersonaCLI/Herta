import { useEffect, useRef, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useActiveSession } from "../../hooks/useActiveSession.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type {
  DeepSeekKeyStatus,
  ModelChoice,
  ModelConfig,
} from "../../ipc/bridge-types.js";
import { Select } from "./Select.js";
import { SettingRow } from "./SettingRow.js";

/**
 * The DeepSeek API-key section. Reads the masked status on mount (the raw key
 * never leaves the main process); lets the user set/replace and delete the key.
 * Live-apply — a change takes effect on the NEXT turn with no restart, so there
 * is no restart note. Save and Delete are disabled while a turn is in flight
 * (changing the key mid-turn would 401 a running request). See the
 * 2026-06-24-deepseek-key design.
 */
export function DeepSeekSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const { status: sessionStatus } = useActiveSession();
  const busy = sessionStatus !== "idle";

  const [status, setStatus] = useState<DeepSeekKeyStatus | null>(null);
  // A rejected status fetch previously left `status` null forever — the pane
  // showed "Checking…" indefinitely with no retry affordance.
  const [statusFailed, setStatusFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [unverified, setUnverified] = useState(false);
  // Any in-flight key op (or a running turn) locks both controls.
  const locked = busy || saving || deleting;

  // Per-stage model rows (2026-08-17). Optional bridge surface, same
  // contract and same optimistic / latest-wins / snap-back shape as the
  // Coprocessor thinking row (BanzhuanSettings). Restart-to-apply: buildConfig
  // reads the choice at the next bootstrap.
  const modelsSupported = bridge.setModelConfig !== undefined;
  // Pre-load optimistic state = the real handler's defaults (actor Pro,
  // owner 2026-08-17; backend the flash — the vision-capable one since the
  // 2026-09 rename, ADR 0048 §5a/§5b), so the pills never flash a wrong
  // selection while getModelConfig is in flight. Keep in lockstep with
  // session-service's getModelConfig and buildConfig — three statements of
  // one default.
  const [models, setModels] = useState<ModelConfig>({
    actor: "deepseek-v4-pro",
    backend: "deepseek-flash",
  });
  const [modelsFailed, setModelsFailed] = useState(false);
  const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
  const modelsTouchedRef = useRef(false);
  const modelsWriteSeqRef = useRef(0);

  useEffect(() => {
    let alive = true;
    bridge.getModelConfig?.().then(
      (c) => {
        if (alive && !modelsTouchedRef.current) setModels(c);
      },
      () => {
        if (alive) setModelsLoadFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  // Both stages pick from the same two names (the flash reads images since
  // the 2026-09 API), so one handler serves both rows.
  const onModel = (stage: keyof ModelConfig, next: ModelChoice): void => {
    const prev = models;
    const nextCfg: ModelConfig = { ...models, [stage]: next };
    modelsWriteSeqRef.current += 1;
    const seq = modelsWriteSeqRef.current;
    modelsTouchedRef.current = true;
    setModels(nextCfg);
    setModelsFailed(false);
    void bridge.setModelConfig?.(nextCfg).catch(() => {
      if (seq !== modelsWriteSeqRef.current) return;
      setModels(prev);
      setModelsFailed(true);
    });
  };

  useEffect(() => {
    let alive = true;
    bridge.getDeepSeekKeyStatus().then(
      (s) => {
        if (alive) setStatus(s);
      },
      () => {
        if (alive) setStatusFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge]);

  const onSave = (): void => {
    const key = draft.trim();
    if (key.length === 0 || locked) return;
    setSaving(true);
    setFailed(false);
    setRejected(false);
    setUnverified(false);
    void bridge
      .setDeepSeekKey(key)
      .then((r) => {
        if (!r.ok) {
          // DeepSeek rejected the key — don't claim Connected; keep the input
          // so the user can fix it.
          setRejected(true);
          return;
        }
        setStatus(r.status);
        setDraft("");
        setUnverified(r.unverified);
      })
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  };

  const onDelete = (): void => {
    if (locked) return;
    setDeleting(true);
    setFailed(false);
    void bridge
      .clearDeepSeekKey()
      .then((r) => setStatus(r.status))
      .catch(() => setFailed(true))
      .finally(() => setDeleting(false));
  };

  // Split the intro around the literal host so it keeps its emphasized style
  // (settings-key-host) and stays verbatim in every locale.
  const introParts = t("deepseek.intro").split("platform.deepseek.com");

  return (
    <>
      <p className="settings-intro">
        {introParts[0]}
        <span className="settings-key-host">platform.deepseek.com</span>
        {introParts[1] ?? ""}
      </p>

      <div className="settings-key-status">
        {status === null ? (
          <span className="settings-key-state is-muted">
            {statusFailed ? t("deepseek.statusFailed") : t("deepseek.checking")}
          </span>
        ) : status.set ? (
          <span className="settings-key-state is-connected">
            <span className="settings-key-dot" aria-hidden="true" />
            {t("deepseek.connected")} · …{status.hint}
          </span>
        ) : (
          <span className="settings-key-state is-muted">
            {t("deepseek.noKey")}
          </span>
        )}
      </div>

      <div className="settings-key-form">
        <input
          type="password"
          className="settings-key-input"
          placeholder={status?.set ? t("deepseek.replaceKey") : "sk-…"}
          aria-label={t("deepseek.keyAria")}
          autoComplete="off"
          spellCheck={false}
          value={draft}
          disabled={locked}
          onChange={(e) => {
            setDraft(e.target.value);
            setRejected(false);
            setUnverified(false);
          }}
          onKeyDown={(e) => {
            // IME safety: Enter confirming a composition candidate must not
            // trigger the save (keys are ASCII, but the guard costs nothing).
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              onSave();
            }
          }}
        />
        <button
          type="button"
          className="settings-key-save"
          disabled={draft.trim().length === 0 || locked}
          onClick={onSave}
        >
          {saving ? t("deepseek.verifying") : t("deepseek.save")}
        </button>
      </div>

      {status?.set && (
        <button
          type="button"
          className="settings-key-delete"
          disabled={locked}
          onClick={onDelete}
        >
          {deleting ? t("deepseek.deleting") : t("deepseek.deleteKey")}
        </button>
      )}

      {rejected && (
        <p className="settings-note is-error">{t("deepseek.rejected")}</p>
      )}
      {failed && <p className="settings-note">{t("common.couldntSave")}</p>}
      {busy && <p className="settings-note">{t("deepseek.busy")}</p>}
      {unverified && (
        <p className="settings-note">{t("deepseek.unverified")}</p>
      )}
      {status?.set && !status.encrypted && (
        <p className="settings-note">{t("deepseek.unencrypted")}</p>
      )}

      {modelsSupported && (
        <>
          <p className="settings-intro settings-models-intro">
            {t("deepseek.models.intro")}
          </p>
          <SettingRow
            title={t("deepseek.model.actor")}
            description={t("deepseek.model.actorDesc")}
            control={
              <Select<ModelChoice>
                value={models.actor}
                ariaLabel={t("deepseek.model.actor")}
                options={[
                  { value: "deepseek-v4-pro", label: t("deepseek.model.pro") },
                  { value: "deepseek-flash", label: t("deepseek.model.flash") },
                ]}
                onChange={(v) => onModel("actor", v)}
              />
            }
          />
          <SettingRow
            title={t("deepseek.model.backend")}
            description={t("deepseek.model.backendDesc")}
            control={
              // The same two names as the actor's row: since the 2026-09 API
              // the flash itself reads images (ADR 0048 §5b), so the
              // 板砖-only "Flash 视觉版" row of 2026-08 is gone.
              <Select<ModelChoice>
                value={models.backend}
                ariaLabel={t("deepseek.model.backend")}
                options={[
                  { value: "deepseek-v4-pro", label: t("deepseek.model.pro") },
                  { value: "deepseek-flash", label: t("deepseek.model.flash") },
                ]}
                onChange={(v) => onModel("backend", v)}
              />
            }
          />
          {modelsFailed && (
            <p className="settings-note">{t("common.couldntSave")}</p>
          )}
          {!modelsFailed && modelsLoadFailed && (
            <p className="settings-note">{t("settings.loadFailed")}</p>
          )}
        </>
      )}
    </>
  );
}
