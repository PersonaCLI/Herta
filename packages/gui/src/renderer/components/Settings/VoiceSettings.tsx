import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type {
  DeepSeekKeyStatus,
  MiniMaxVoiceError,
  MiniMaxVoiceState,
  RealtimeVoiceState,
  SetKeyResult,
  VoiceEngine,
  VoiceModelFailure,
  VoiceModelState,
} from "../../ipc/bridge-types.js";
import { applyVoiceVolume, stopAllVoice } from "../../voice/play-voice.js";
import { useVoiceMuted } from "../../voice/useVoiceMuted.js";
import { useVoiceVolume } from "../../voice/useVoiceVolume.js";
import { setVoiceMuted, setVoiceVolume } from "../../voice/voice-prefs.js";
import { Select } from "./Select.js";
import { SettingRow } from "./SettingRow.js";
import { Toggle } from "./Toggle.js";

const mb = (bytes: number): string => String(Math.round(bytes / 1e6));

function failureKey(reason: VoiceModelFailure) {
  switch (reason) {
    case "network":
      return "voice.modelFailed.network" as const;
    case "http":
      return "voice.modelFailed.http" as const;
    case "size":
      return "voice.modelFailed.size" as const;
    case "hash":
      return "voice.modelFailed.hash" as const;
    case "archive":
      return "voice.modelFailed.archive" as const;
    case "verify":
      return "voice.modelFailed.verify" as const;
    case "disk":
      return "voice.modelFailed.disk" as const;
    case "cancelled":
      return "voice.modelFailed.cancelled" as const;
  }
}

function cloneFailureKey(reason: MiniMaxVoiceError) {
  switch (reason) {
    case "no_key":
      return "voice.cloneFailed.no_key" as const;
    case "invalid_key":
      return "voice.cloneFailed.invalid_key" as const;
    case "auth":
      return "voice.cloneFailed.auth" as const;
    case "rate":
      return "voice.cloneFailed.rate" as const;
    case "quota":
      return "voice.cloneFailed.quota" as const;
    case "sensitive":
      return "voice.cloneFailed.sensitive" as const;
    case "voice_missing":
      return "voice.cloneFailed.voice_missing" as const;
    case "invalid":
      return "voice.cloneFailed.invalid" as const;
    case "network":
      return "voice.cloneFailed.network" as const;
    case "http":
      return "voice.cloneFailed.http" as const;
    case "cancelled":
      return "voice.cloneFailed.cancelled" as const;
    case "reference":
      return "voice.cloneFailed.reference" as const;
    case "no_clone_key":
      return "voice.cloneFailed.no_clone_key" as const;
    case "other":
      return "voice.cloneFailed.other" as const;
  }
}

/** A "?" circle that explains something in place (owner 2026-09-08: the
 *  two MiniMax keys' division of labour is hard to read from two rows).
 *  The tip opens on hover and on keyboard focus through CSS alone, and a
 *  click pins it open for touch and for reading; Escape or leaving closes
 *  it. The text is in the DOM always — it is the button's description. */
function HelpTip(p: {
  readonly label: string;
  readonly text: string;
  readonly id: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <span className={`settings-help${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="settings-help-btn"
        aria-label={p.label}
        aria-expanded={open}
        aria-describedby={p.id}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        ?
      </button>
      <span role="tooltip" id={p.id} className="settings-help-tip">
        {p.text}
      </span>
    </span>
  );
}

interface KeyRowProps {
  readonly title: string;
  /** Rendered after the title — the help "?" for the row that needs it. */
  readonly help?: ReactNode;
  readonly description: ReactNode;
  readonly placeholder: string;
  readonly ariaLabel: string;
  /** Masked status, null until the first read lands. */
  readonly status: DeepSeekKeyStatus | null;
  /** The clone's last failure blamed this key: it reads 密钥无效. */
  readonly refused: boolean;
  /** Saved while the platform could not check it, and nothing has proven
   *  it since: it reads 未核对. */
  readonly unchecked: boolean;
  readonly save: ((key: string) => Promise<SetKeyResult>) | undefined;
  readonly clear:
    | (() => Promise<{ readonly status: DeepSeekKeyStatus }>)
    | undefined;
  readonly onStatus: (status: DeepSeekKeyStatus) => void;
  readonly onUnverified: (unverified: boolean) => void;
}

/** One MiniMax key: the row with its masked status, the form under it, the
 *  delete link, and the notes a save can leave. The pay-as-you-go key and
 *  the token-plan key (ADR 0062 §1.8) are two of these. */
function KeyRow(p: KeyRowProps): JSX.Element {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rejected, setRejected] = useState(false);
  const busy = saving || deleting;
  const status = p.status;

  const onSave = (): void => {
    const key = draft.trim();
    if (p.save === undefined || key.length === 0 || saving) return;
    setSaving(true);
    setFailed(false);
    setRejected(false);
    p.onUnverified(false);
    void p
      .save(key)
      .then((r) => {
        if (!r.ok) {
          setRejected(true);
          return;
        }
        p.onStatus(r.status);
        setDraft("");
        p.onUnverified(r.unverified);
      })
      .catch(() => setFailed(true))
      .finally(() => setSaving(false));
  };

  const onDelete = (): void => {
    if (p.clear === undefined || deleting) return;
    setDeleting(true);
    setFailed(false);
    void p
      .clear()
      .then((r) => {
        p.onStatus(r.status);
        p.onUnverified(false);
      })
      .catch(() => setFailed(true))
      .finally(() => setDeleting(false));
  };

  // One card row like every other setting (owner 2026-09-08: a card with a
  // form hanging under it read as two things). The field lives INSIDE the
  // row, under the description; the masked status and the delete link sit
  // in the control column; a note a save leaves stays inside the row too,
  // so the card group never breaks. The row is a `.settings-row` itself so
  // it fuses with its neighbours.
  const state =
    status === null ? (
      <span className="settings-key-state is-muted">
        {t("deepseek.checking")}
      </span>
    ) : status.set && p.refused ? (
      <span className="settings-key-state is-rejected">
        {t("voice.minimaxKeyRejected")} · …{status.hint}
      </span>
    ) : status.set && p.unchecked ? (
      <span className="settings-key-state is-muted">
        {t("voice.minimaxKeyUnchecked")} · …{status.hint}
      </span>
    ) : status.set ? (
      <span className="settings-key-state is-connected">
        <span className="settings-key-dot" aria-hidden="true" />
        {t("deepseek.connected")} · …{status.hint}
      </span>
    ) : (
      <span className="settings-key-state is-muted">{t("deepseek.noKey")}</span>
    );

  return (
    <div className="settings-row settings-row--key">
      <div className="settings-row-text">
        <p className="settings-row-title">
          {p.title}
          {p.help}
        </p>
        <p className="settings-row-desc">{p.description}</p>
        <div className="settings-key-inline">
          <input
            type="password"
            className="settings-key-input is-compact"
            placeholder={status?.set ? t("deepseek.replaceKey") : p.placeholder}
            aria-label={p.ariaLabel}
            autoComplete="off"
            spellCheck={false}
            value={draft}
            disabled={busy}
            onChange={(e) => {
              setDraft(e.target.value);
              setRejected(false);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                onSave();
              }
            }}
          />
          <button
            type="button"
            className="settings-key-save is-compact"
            disabled={draft.trim().length === 0 || busy}
            onClick={onSave}
          >
            {saving ? t("deepseek.verifying") : t("deepseek.save")}
          </button>
        </div>
        {rejected && (
          <p className="settings-note is-error is-inline">
            {t("voice.minimaxRejected")}
          </p>
        )}
        {failed && (
          <p className="settings-note is-inline">{t("common.couldntSave")}</p>
        )}
        {status?.set && !status.encrypted && (
          <p className="settings-note is-inline">{t("deepseek.unencrypted")}</p>
        )}
      </div>
      <div className="settings-row-control settings-key-control">
        {state}
        {status?.set && (
          <button
            type="button"
            className="settings-key-delete is-inline"
            disabled={busy}
            onClick={onDelete}
          >
            {deleting ? t("deepseek.deleting") : t("voice.keyDelete")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The Voice settings section — the real-time voice (ADR 0042), its engine
 * (ADR 0062: the local model with its download, ADR 0061, or the MiniMax
 * clone on the user's key), master mute, master volume.
 *
 * The clone itself is machinery the user never operates (owner,
 * 2026-09-08): main makes it when the engine is MiniMax and a key exists,
 * and remakes it when the platform drops it. This pane shows only what
 * needs a hand — the key — plus a line while the voice is being prepared
 * and a line, with a retry, when that failed.
 */
export function VoiceSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const muted = useVoiceMuted();
  const volume = useVoiceVolume();
  // The rows render on the FIRST frame whenever the bridge has the methods
  // (the settings-pane rule, owner 2026-09-07: gate on the METHOD's presence,
  // never on an async read's result); the controls stay inert until the
  // state lands, so nothing pops in a frame later.
  const supported =
    bridge.getRealtimeVoice !== undefined &&
    bridge.setRealtimeVoice !== undefined;
  const modelSupported = bridge.downloadVoiceModel !== undefined;
  const engineSupported =
    bridge.setVoiceEngine !== undefined && bridge.setMiniMaxKey !== undefined;
  const planSupported = bridge.setMiniMaxPlanKey !== undefined;
  const [rt, setRt] = useState<RealtimeVoiceState | null>(null);
  const [rtFailed, setRtFailed] = useState(false);
  const [model, setModel] = useState<VoiceModelState | null>(null);
  const [engine, setEngine] = useState<VoiceEngine>("local");
  const [engineFailed, setEngineFailed] = useState(false);
  const [mmKey, setMmKey] = useState<DeepSeekKeyStatus | null>(null);
  const [mmPlanKey, setMmPlanKey] = useState<DeepSeekKeyStatus | null>(null);
  const [clone, setClone] = useState<MiniMaxVoiceState | null>(null);
  const [keyUnverified, setKeyUnverified] = useState(false);
  const [planUnverified, setPlanUnverified] = useState(false);

  useEffect(() => {
    const read = bridge.getRealtimeVoice;
    if (read === undefined) return;
    let alive = true;
    const refresh = (): void => {
      void read().then(
        (s) => {
          if (!alive) return;
          setRt(s);
          setModel(s.model);
          setEngine(s.engine);
          setMmKey(s.minimax.key);
          setMmPlanKey(s.minimax.planKey);
          setClone(s.minimax.voice);
        },
        () => undefined,
      );
    };
    refresh();
    const unsubModel = bridge.onVoiceModel?.((m) => {
      if (!alive) return;
      setModel(m);
      // A phase change may have changed what the synthesizer can see — the
      // downloaded copy landed, or went — so re-read the facts rather than
      // infer them here (a dev workspace copy would be inferred wrong).
      if (m.phase !== "downloading") refresh();
    });
    const unsubClone = bridge.onMiniMaxVoice?.((c) => {
      if (!alive) return;
      setClone(c);
      // A clone that landed proves the key: a save the platform could not
      // check at the time is checked now.
      if (c.phase === "ready") setKeyUnverified(false);
    });
    return () => {
      alive = false;
      unsubModel?.();
      unsubClone?.();
    };
  }, [bridge]);

  // A downloaded bundle counts the moment its state says ready; the initial
  // read's `bundle` covers the dev workspace's copy, which no download owns.
  const bundle =
    model !== null && model.phase === "ready" ? true : (rt?.bundle ?? false);
  const runtime = rt?.runtime ?? false;
  const failed = rt?.failed ?? false;
  const localCanSpeak = bundle && runtime && !failed;
  // Either MiniMax key speaks: the plan key under the plan, the
  // pay-as-you-go key otherwise (§1.8).
  const anyKey = (mmKey?.set ?? false) || (mmPlanKey?.set ?? false);
  const cloneReady = clone !== null && clone.phase === "ready";
  const cloudCanSpeak = anyKey && cloneReady;
  const canSpeak = engine === "minimax" ? cloudCanSpeak : localCanSpeak;

  const onRealtimeChange = (next: boolean): void => {
    const write = bridge.setRealtimeVoice;
    if (write === undefined || rt === null) return;
    // Optimistic, with a snap-back on a failed write — same contract as the
    // Dream toggle, so the switch never claims a state that missed disk.
    setRt({ ...rt, enabled: next });
    setRtFailed(false);
    void write(next).catch(() => {
      setRt({ ...rt, enabled: !next });
      setRtFailed(true);
    });
    // Turning it OFF cuts a reply already speaking (immediate silence,
    // mirroring the mute below).
    if (!next) stopAllVoice();
  };

  const onEngineChange = (next: VoiceEngine): void => {
    const write = bridge.setVoiceEngine;
    if (write === undefined) return;
    const prev = engine;
    setEngine(next);
    setEngineFailed(false);
    void write(next).catch(() => {
      setEngine(prev);
      setEngineFailed(true);
    });
  };

  const modelRow = ((): {
    readonly description: string;
    readonly control: JSX.Element | null;
  } => {
    if (model === null) return { description: "—", control: null };
    const size = mb(model.unpackedBytes);
    switch (model.phase) {
      case "downloading":
        return {
          description: t("voice.modelDownloading", {
            received: mb(model.receivedBytes),
            total: mb(model.totalBytes),
          }),
          control: (
            <button
              type="button"
              className="settings-btn"
              onClick={() => void bridge.cancelVoiceModelDownload?.()}
            >
              {t("voice.modelCancel")}
            </button>
          ),
        };
      case "ready":
        return {
          description: t("voice.modelReady", { size }),
          control: (
            <button
              type="button"
              className="settings-btn"
              onClick={() => {
                stopAllVoice();
                void bridge.removeVoiceModel?.();
              }}
            >
              {t("voice.modelRemove")}
            </button>
          ),
        };
      case "failed":
        return {
          description:
            model.error !== undefined
              ? t(failureKey(model.error))
              : t("voice.modelFailed.disk"),
          control: (
            <button
              type="button"
              className="settings-btn settings-btn--primary"
              disabled={!runtime}
              onClick={() => void bridge.downloadVoiceModel?.()}
            >
              {t("voice.modelRetry")}
            </button>
          ),
        };
      default:
        // Absent. In dev the workspace's own copy may already be answering.
        return bundle
          ? { description: t("voice.modelDev"), control: null }
          : {
              description: t("voice.modelAbsent", { size }),
              control: (
                <button
                  type="button"
                  className="settings-btn settings-btn--primary"
                  disabled={!runtime}
                  onClick={() => void bridge.downloadVoiceModel?.()}
                >
                  {t("voice.modelDownload")}
                </button>
              ),
            };
    }
  })();

  // The key row's description keeps the literal host emphasized
  // (settings-key-host) and verbatim in every locale — the DeepSeek
  // section's shape.
  const keyDescParts = t("voice.minimaxKeyDesc").split("platform.minimaxi.com");
  // A stored key the platform then refuses (revoked, or saved unverified
  // during an outage) must not keep reading 已连接: the clone's own auth
  // failure is the honest signal. It blames the key the clone used — the
  // pay-as-you-go one when set, else the plan key that tried to adopt.
  const keyRefused =
    clone !== null &&
    clone.phase === "failed" &&
    (clone.error === "invalid_key" || clone.error === "auth");
  const blamed: "api" | "plan" | null = !keyRefused
    ? null
    : (mmKey?.set ?? false)
      ? "api"
      : "plan";
  // A key stored while the platform could not be reached is not 已连接 —
  // nobody has checked it. The clone made right after either proves it
  // (ready → connected) or says what went wrong on its own line.
  const keyUnchecked = keyUnverified && !cloneReady;

  const progress =
    model !== null && model.phase === "downloading" && model.totalBytes > 0
      ? Math.min(
          100,
          Math.round((model.receivedBytes / model.totalBytes) * 100),
        )
      : null;

  return (
    // The rows scroll inside the fixed-height pane (the Coprocessor pane's
    // idiom): with the cloud engine's two key rows the section had grown
    // past the card's floor and the card resized (owner 2026-09-08).
    <div className="settings-rows">
      {supported && (
        <>
          <SettingRow
            title={t("voice.realtime")}
            description={t("voice.realtimeDesc")}
            control={
              <Toggle
                checked={(rt?.enabled ?? false) && canSpeak}
                ariaLabel={t("voice.realtime")}
                disabled={rt === null || !canSpeak}
                onChange={onRealtimeChange}
              />
            }
          />
          {rtFailed ? (
            <p className="settings-note">{t("common.couldntSave")}</p>
          ) : engine === "local" && rt !== null && !runtime ? (
            <p className="settings-note">{t("voice.realtimeMissing")}</p>
          ) : engine === "local" && failed ? (
            <p className="settings-note">{t("voice.realtimeFailed")}</p>
          ) : null}
          {engineSupported && (
            <SettingRow
              title={t("voice.engine")}
              description={t("voice.engineDesc")}
              control={
                <Select<VoiceEngine>
                  value={engine}
                  ariaLabel={t("voice.engine")}
                  options={[
                    { value: "local", label: t("voice.engine.local") },
                    { value: "minimax", label: t("voice.engine.minimax") },
                  ]}
                  onChange={onEngineChange}
                />
              }
            />
          )}
          {engineFailed && (
            <p className="settings-note">{t("common.couldntSave")}</p>
          )}
          {modelSupported && engine === "local" && (
            <>
              <SettingRow
                title={t("voice.model")}
                description={modelRow.description}
                control={modelRow.control}
              />
              {progress !== null && (
                <div
                  className="settings-progress"
                  role="progressbar"
                  aria-label={t("voice.model")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                >
                  <span
                    className="settings-progress__fill"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}
            </>
          )}
          {engineSupported && engine === "minimax" && (
            <>
              <KeyRow
                title={t("voice.minimaxKey")}
                help={
                  <HelpTip
                    id="voice-minimax-help"
                    label={t("voice.minimaxHelpAria")}
                    text={t("voice.minimaxHelp")}
                  />
                }
                description={
                  <>
                    {keyDescParts[0]}
                    <span className="settings-key-host">
                      platform.minimaxi.com
                    </span>
                    {keyDescParts[1] ?? ""}
                  </>
                }
                placeholder="sk-api-…"
                ariaLabel={t("voice.minimaxKeyAria")}
                status={mmKey}
                refused={blamed === "api"}
                unchecked={keyUnchecked}
                save={bridge.setMiniMaxKey}
                clear={bridge.clearMiniMaxKey}
                onStatus={setMmKey}
                onUnverified={setKeyUnverified}
              />
              {planSupported && (
                <KeyRow
                  title={t("voice.minimaxPlanKey")}
                  description={t("voice.minimaxPlanKeyDesc")}
                  placeholder="sk-cp-…"
                  ariaLabel={t("voice.minimaxPlanKeyAria")}
                  status={mmPlanKey}
                  refused={blamed === "plan"}
                  unchecked={planUnverified}
                  save={bridge.setMiniMaxPlanKey}
                  clear={bridge.clearMiniMaxPlanKey}
                  onStatus={setMmPlanKey}
                  onUnverified={setPlanUnverified}
                />
              )}
              {/* The clone is main's business; only its two visible moments
                  reach the pane — being made, and having failed. */}
              {anyKey && clone?.phase === "preparing" && (
                <p className="settings-note" data-testid="voice-clone-note">
                  {t("voice.clonePreparing")}
                </p>
              )}
              {anyKey && clone?.phase === "failed" && (
                <p
                  className="settings-note is-error"
                  data-testid="voice-clone-note"
                >
                  {t(cloneFailureKey(clone.error ?? "other"))}{" "}
                  <button
                    type="button"
                    className="settings-note-action"
                    onClick={() => void bridge.prepareMiniMaxVoice?.()}
                  >
                    {t("voice.cloneRetry")}
                  </button>
                </p>
              )}
            </>
          )}
        </>
      )}
      <SettingRow
        title={t("voice.mute")}
        description={t("voice.muteDesc")}
        control={
          <Toggle
            checked={muted}
            ariaLabel={t("voice.mute")}
            onChange={(next) => {
              setVoiceMuted(next);
              // Turning mute ON cuts any clip already playing (immediate silence).
              if (next) stopAllVoice();
            }}
          />
        }
      />
      <SettingRow
        title={t("voice.volume")}
        description={t("voice.volumeDesc")}
        control={
          <span
            className={`settings-slider-wrap${muted ? " is-disabled" : ""}`}
          >
            <input
              type="range"
              className="settings-slider"
              min={0}
              max={100}
              step={5}
              value={Math.round(volume * 100)}
              /* The custom track paints its LED fill from this var — CSS
                 alone can't know a range input's value. */
              style={
                {
                  "--slider-fill": `${Math.round(volume * 100)}%`,
                } as CSSProperties
              }
              aria-label={t("voice.volume")}
              disabled={muted}
              onChange={(e) => {
                setVoiceVolume(Number(e.target.value) / 100);
                // Re-scale a clip that is ALREADY playing, so dragging the
                // slider mid-line is audible immediately.
                applyVoiceVolume();
              }}
            />
            <span className="settings-slider-value">
              {Math.round(volume * 100)}%
            </span>
          </span>
        }
      />
    </div>
  );
}
