import { useEffect, useRef, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useDemoDeviceCycle } from "../../hooks/useDemoDeviceCycle.js";
import type { BanzhuanDeviceState } from "../../hooks/useDeviceState.js";
import type { MessageKey } from "../../i18n/keys.js";
import { useLocale, useT } from "../../i18n/LocaleProvider.js";
import type {
  BackendContractChoice,
  BackendThinking,
} from "../../ipc/bridge-types.js";
import { BanzhuanDemoCard } from "../UtilityRail/BanzhuanDemoCard.js";
import { Select } from "./Select.js";
import { SettingRow } from "./SettingRow.js";
import { useRememberedSetting } from "./settings-snapshot.js";
import { Toggle } from "./Toggle.js";

type DemoState =
  | "idle"
  | "delegated"
  | "waitingApproval"
  | "succeeded"
  | "failed";

interface StateMeta {
  readonly stateKey: MessageKey;
  readonly legendKey: MessageKey;
  /** Legend swatch color — approximates the state's glow. Decorative. */
  readonly dot: string;
}

const STATE_META: Record<DemoState, StateMeta> = {
  idle: {
    stateKey: "device.state.idle",
    legendKey: "banzhuan.legend.idle",
    dot: "#7ba3f0",
  },
  delegated: {
    stateKey: "device.state.working",
    legendKey: "banzhuan.legend.delegated",
    dot: "#4d86ff",
  },
  waitingApproval: {
    stateKey: "device.state.awaitingApproval",
    legendKey: "banzhuan.legend.waitingApproval",
    dot: "#f0b34a",
  },
  succeeded: {
    stateKey: "device.state.done",
    legendKey: "banzhuan.legend.succeeded",
    dot: "#5fd093",
  },
  failed: {
    stateKey: "device.state.error",
    legendKey: "banzhuan.legend.failed",
    dot: "#f2655f",
  },
};

const LEGEND_ORDER: readonly DemoState[] = [
  "idle",
  "delegated",
  "waitingApproval",
  "succeeded",
  "failed",
];

/** Look up a state's display meta, falling back to idle (the cycle only emits
 *  the five demo states, but `state` is the wider device-state union). */
function metaFor(state: BanzhuanDeviceState): StateMeta {
  return STATE_META[state as DemoState] ?? STATE_META.idle;
}

/**
 * The 差分协处理器 settings section: a short explainer of the silent coding
 * backend, the backend thinking-effort Select (low/high/max,
 * restart-to-apply), then a read-only device card that auto-cycles through
 * its lifecycle (pause on hover) with a synced caption, plus a static
 * 5-state legend. The visual reuses the live rail card; only the meaning
 * text lives here. Per-workspace permission choices (automatic review) do
 * NOT live in this pane: they're managed in the device card's ⋯ menu next to
 * the workspace they bind to (owner 2026-08-04, for the command rules that
 * were removed on 2026-10-10).
 *
 * Layout rules (owner feedback 2026-08-03, "re-design — it changed the
 * panel height"): the pane must stay inside `.settings-content`'s stable
 * min-height floor so switching sections never resizes the card, and the
 * effort Select sits ABOVE the demo card — its popover menu is an in-flow
 * absolute box (no portal), so near the pane's bottom edge it clipped
 * against the card; up here it opens downward into the demo's space.
 * There is deliberately NO dynamic restart note: the row description
 * already says "下次启动生效", and an appearing note re-flowed the pane.
 *
 * NOTE on "low": per the DeepSeek doc (2026-09-10) both `deepseek-flash`
 * and `deepseek-v4-pro` honour the low tier (the 2026-07-31 doc had Pro
 * mapping a sent "low" to "high" server-side; owner decision 2026-08-03 was
 * to persist and send the choice as-is regardless). The UI deliberately
 * says nothing about server-side handling of the tiers.
 */
export function BanzhuanSettings(): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const { locale } = useLocale();
  const [paused, setPaused] = useState(false);
  const state = useDemoDeviceCycle(paused);
  const meta = metaFor(state);

  // Thinking-effort row. The bridge surface is OPTIONAL (fakes / the website
  // demo omit it); the row hides with it, mirroring LanguageSettings' handling
  // of the interaction-language pair.
  const thinkingSupported = bridge.setBackendConfig !== undefined;
  // The last-known tier on the first frame (settings-snapshot.ts); "high" —
  // the real handler's default — only when nothing has been read yet.
  const [thinking, setThinking] = useRememberedSetting(
    bridge,
    "banzhuan.thinking",
    "high",
  );
  const [failed, setFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // Once the user picks, the in-flight async load must not clobber the pick.
  const touchedRef = useRef(false);
  // Latest-wins guard: two overlapping failed writes must not snap back to a
  // stale value — only the newest write may revert.
  const writeSeqRef = useRef(0);

  // Tool-contract row (ADR 0040). Same optimistic / latest-wins discipline as
  // the thinking row, and on screen from the FIRST paint like it: the row
  // used to wait for the config read to prove the bridge carries
  // `contract`, so every switch into this pane painted two rows and then
  // three, pushing the demo card down a beat later (owner 2026-09-07). The
  // case it waited for does not exist — the preload ships with the
  // renderer, and the website demo omits `setBackendConfig` altogether,
  // which hides every row here. `bashFound` comes from main and is folded
  // into the row description — the fallback is stated where the choice is
  // made.
  // Pre-load optimistic state = the real handler's default (minimal —
  // owner flip 2026-08-17), so the pill never flashes 标准 while the
  // config is in flight. The last-known values win over both defaults
  // (settings-snapshot.ts): a user on 标准 no longer sees 极简 for a beat,
  // and the no-bash sentence is in the description on the first frame.
  const [contract, setContract] = useRememberedSetting(
    bridge,
    "banzhuan.contract",
    "minimal",
  );
  const [bashFound, setBashFound] = useRememberedSetting(
    bridge,
    "banzhuan.bashFound",
    undefined,
  );
  const [contractFailed, setContractFailed] = useState(false);
  const contractTouchedRef = useRef(false);
  const contractSeqRef = useRef(0);

  useEffect(() => {
    let alive = true;
    bridge.getBackendConfig?.().then(
      (c) => {
        if (!alive) return;
        if (!touchedRef.current) setThinking(c.thinking);
        if (c.contract !== undefined && !contractTouchedRef.current)
          setContract(c.contract);
        setBashFound(c.bashFound);
      },
      () => {
        if (alive) setLoadFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge, setThinking, setContract, setBashFound]);

  const onContract = (next: BackendContractChoice): void => {
    const prev = contract;
    contractSeqRef.current += 1;
    const seq = contractSeqRef.current;
    contractTouchedRef.current = true;
    setContract(next);
    setContractFailed(false);
    void bridge.setBackendConfig?.({ thinking, contract: next }).catch(() => {
      if (seq !== contractSeqRef.current) return;
      setContract(prev);
      setContractFailed(true);
    });
  };

  // There is no 3D device row (owner 2026-10-01, ADR 0057 §2.7 amended):
  // the rail card draws the lit device wherever the GPU allows and the flat
  // art everywhere else, with nothing to choose. The demo card below stays
  // on the flat renders on purpose — one GPU scene per app, in the rail.

  // PDF picture transcription (2026-10-01). Live (main applies it to the next
  // attach), per user, default on; the first frame shows the last-known value
  // (settings-snapshot.ts). Optimistic + latest-wins like the rows above;
  // hides when the bridge has no surface (fakes / the website demo).
  const pdfSupported = bridge.setPdfPictureTranscripts !== undefined;
  const [pdfPictures, setPdfPictures] = useRememberedSetting(
    bridge,
    "banzhuan.pdfPictureTranscripts",
    true,
  );
  const [pdfFailed, setPdfFailed] = useState(false);
  const pdfTouchedRef = useRef(false);
  const pdfSeqRef = useRef(0);
  useEffect(() => {
    let alive = true;
    bridge.getPdfPictureTranscripts?.().then(
      (v) => {
        if (alive && !pdfTouchedRef.current) setPdfPictures(v);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bridge, setPdfPictures]);
  const onPdfPictures = (next: boolean): void => {
    const prev = pdfPictures;
    pdfSeqRef.current += 1;
    const seq = pdfSeqRef.current;
    pdfTouchedRef.current = true;
    setPdfPictures(next);
    setPdfFailed(false);
    void bridge.setPdfPictureTranscripts?.(next).catch(() => {
      if (seq !== pdfSeqRef.current) return;
      setPdfPictures(prev);
      setPdfFailed(true);
    });
  };

  const onThinking = (next: BackendThinking): void => {
    // Optimistic: show the pick now, persist async. On a failed write, snap
    // back so the row never claims a state that didn't reach disk.
    const prev = thinking;
    writeSeqRef.current += 1;
    const seq = writeSeqRef.current;
    touchedRef.current = true;
    setThinking(next);
    setFailed(false);
    void bridge.setBackendConfig?.({ thinking: next }).catch(() => {
      // Both inside the latest-wins guard (audit BL14). The snap-back was
      // guarded and the error note was not, so a stale write's failure
      // painted an error over a NEWER pick that had succeeded — the row read
      // "couldn't save" while showing a value that was on disk.
      if (seq !== writeSeqRef.current) return;
      setThinking(prev);
      setFailed(true);
    });
  };

  // Split the intro around the literal @板砖 token to preserve <code> styling.
  // This is Settings CHROME — the surrounding prose is `t()` (UI locale), so the
  // trigger label follows the UI locale too, not the active session's language:
  // an all-English panel must not show a lone CJK @板砖 (and this pane can be
  // open with no active session). @Brick / @板砖 are display-only; the wire token
  // is unchanged, and @brick is accepted case-insensitively in EN sessions.
  const introParts = t("banzhuan.intro").split("@板砖");
  const trigger = locale === "en" ? "@Brick" : "@板砖";

  return (
    <>
      <p className="settings-intro">
        {introParts[0]}
        <code>{trigger}</code>
        {introParts[1] ?? ""}
      </p>

      {/* The option rows scroll inside a fixed-height pane (owner
          2026-09-06): a third row had made this section taller than the
          card's floor and the card grew on every switch into it. */}
      <div className="settings-rows">
        {thinkingSupported && (
          <SettingRow
            title={t("banzhuan.thinking")}
            description={t("banzhuan.thinkingDesc")}
            control={
              <Select<BackendThinking>
                value={thinking}
                ariaLabel={t("banzhuan.thinking")}
                options={[
                  { value: "low", label: t("banzhuan.thinking.low") },
                  { value: "high", label: t("banzhuan.thinking.high") },
                  { value: "max", label: t("banzhuan.thinking.max") },
                ]}
                onChange={onThinking}
              />
            }
          />
        )}
        {thinkingSupported && (
          <SettingRow
            title={t("banzhuan.contract")}
            description={
              bashFound === false
                ? `${t("banzhuan.contractDesc")} ${t("banzhuan.contract.noBash")}`
                : t("banzhuan.contractDesc")
            }
            control={
              <Select<BackendContractChoice>
                value={contract}
                ariaLabel={t("banzhuan.contract")}
                options={[
                  {
                    value: "standard",
                    label: t("banzhuan.contract.standard"),
                  },
                  { value: "minimal", label: t("banzhuan.contract.minimal") },
                ]}
                onChange={onContract}
              />
            }
          />
        )}
        {pdfSupported && (
          <SettingRow
            title={t("banzhuan.pdfPictures")}
            description={t("banzhuan.pdfPicturesDesc")}
            control={
              <Toggle
                checked={pdfPictures}
                ariaLabel={t("banzhuan.pdfPictures")}
                onChange={onPdfPictures}
              />
            }
          />
        )}
      </div>
      {((thinkingSupported && (failed || contractFailed)) || pdfFailed) && (
        <p className="settings-note">{t("common.couldntSave")}</p>
      )}
      {thinkingSupported &&
        !failed &&
        !contractFailed &&
        !pdfFailed &&
        loadFailed && (
          <p className="settings-note">{t("settings.loadFailed")}</p>
        )}

      <div className="settings-bz-demo">
        <BanzhuanDemoCard state={state} onHoverChange={setPaused} />
        <div className="settings-bz-caption">
          <span className="settings-bz-caption-name">{t(meta.stateKey)}</span>
          <span className="settings-bz-caption-meaning">
            {t(meta.legendKey)}
          </span>
        </div>
      </div>

      <div className="settings-bz-legend">
        {LEGEND_ORDER.map((key) => {
          const m = metaFor(key);
          return (
            <div className="settings-bz-legend-item" key={key}>
              <span
                className="settings-bz-dot"
                style={{ background: m.dot }}
                aria-hidden="true"
              />
              <span>{t(m.stateKey)}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
