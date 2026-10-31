import {
  FLOW_TOPIC_GROUPS,
  MAX_FLOW_TOPICS,
} from "@herta/app-server/flow-topics";
import { useEffect, useState } from "react";
import type {
  FlowRefreshOutcome,
  FlowSettingsView,
} from "../../../shared/flow.js";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useLocale, useT } from "../../i18n/LocaleProvider.js";
import { SettingRow } from "./SettingRow.js";
import { useRememberedSetting } from "./settings-snapshot.js";
import { Toggle } from "./Toggle.js";

/** One keyword picked or put back, in the list's own order, at most
 *  twelve picked. */
export function toggleTopic(
  picked: readonly string[],
  id: string,
): readonly string[] {
  if (picked.includes(id)) return picked.filter((x) => x !== id);
  if (picked.length >= MAX_FLOW_TOPICS) return picked;
  const order = FLOW_TOPIC_GROUPS.flatMap((g) => g.topics.map((t) => t.id));
  return order.filter((x) => x === id || picked.includes(x));
}

/**
 * Settings → Flow (ADR 0084 §4, §10; amendment "topics are picked"): the
 * switch, the keywords to pick from, and "Refresh now" inside the day's
 * three. What Herta knows of the Trailblazer is always read, so it has no
 * row. Every change applies at once: main keeps the settings and the next
 * tick reads them.
 */
export function FlowSettings(): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const { bridge } = useHertaBridge();
  // The first frame shows what was last known (settings-snapshot.ts), so
  // the switch and the chips do not play off → on as the read lands.
  const [settings, setSettings] = useRememberedSetting(
    bridge,
    "flow.settings",
    null,
  );
  const [left, setLeft] = useRememberedSetting(
    bridge,
    "flow.refreshesLeft",
    null,
  );
  const [outcome, setOutcome] = useState<FlowRefreshOutcome | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    bridge.flowSettings?.().then(
      (s) => alive && setSettings(s),
      () => alive && setLoadFailed(true),
    );
    bridge.flowState?.().then(
      (s) => alive && setLeft(s.refreshesLeft),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bridge, setSettings, setLeft]);

  const save = (next: FlowSettingsView): void => {
    const before = settings;
    setSettings(next);
    setFailed(false);
    void bridge.flowSetSettings?.(next).then(
      (saved) => setSettings(saved),
      () => {
        setSettings(before);
        setFailed(true);
      },
    );
  };
  const refresh = (): void => {
    setOutcome(null);
    void bridge.flowRefresh?.().then(
      (r) => {
        setOutcome(r);
        void bridge.flowState?.().then((s) => setLeft(s.refreshesLeft));
      },
      () => setFailed(true),
    );
  };

  const on = settings?.enabled === true;
  const picked = settings?.topics ?? [];
  const full = picked.length >= MAX_FLOW_TOPICS;
  return (
    <>
      <p className="settings-intro">{t("flow.settings.intro")}</p>
      {/* The rows scroll inside the fixed-height pane, as Voice's do. */}
      <div className="settings-rows">
        <SettingRow
          title={t("flow.settings.enable")}
          description={t("flow.settings.enableDesc")}
          control={
            <Toggle
              checked={on}
              ariaLabel={t("flow.settings.enable")}
              disabled={settings === null}
              onChange={(enabled) =>
                settings !== null && save({ ...settings, enabled })
              }
            />
          }
        />
        <div className="settings-row">
          <div className="settings-row-text">
            <p className="settings-row-title">{t("flow.settings.topics")}</p>
            <p className="settings-row-desc">
              {picked.length === 0 && settings !== null
                ? t("flow.settings.topicsNone")
                : t("flow.settings.topicsDesc", { n: MAX_FLOW_TOPICS })}
            </p>
            <div className="flow-topic-groups">
              {FLOW_TOPIC_GROUPS.map((g) => (
                <fieldset key={g.id} className="flow-topic-group">
                  <legend>{g[locale]}</legend>
                  {g.topics.map((topic) => {
                    const isOn = picked.includes(topic.id);
                    return (
                      <button
                        key={topic.id}
                        type="button"
                        className={`flow-topic-chip${isOn ? " is-on" : ""}`}
                        aria-pressed={isOn}
                        disabled={settings === null || (full && !isOn)}
                        onClick={() =>
                          settings !== null &&
                          save({
                            ...settings,
                            topics: toggleTopic(picked, topic.id),
                          })
                        }
                      >
                        <svg
                          className="flow-topic-check"
                          viewBox="0 0 12 12"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                        >
                          <path d="M2.5 6.3l2.2 2.2 4.8-5" />
                        </svg>
                        {topic[locale]}
                      </button>
                    );
                  })}
                </fieldset>
              ))}
            </div>
          </div>
        </div>
        <SettingRow
          title={t("flow.settings.refresh")}
          description={
            outcome !== null
              ? t(
                  `flow.settings.refresh.${outcome}` as "flow.settings.refresh.started",
                )
              : t("flow.settings.refreshDesc", { n: left ?? 3 })
          }
          control={
            <button
              type="button"
              className="settings-btn"
              disabled={!on || left === 0}
              onClick={refresh}
            >
              {t("flow.settings.refresh")}
            </button>
          }
        />
      </div>
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
