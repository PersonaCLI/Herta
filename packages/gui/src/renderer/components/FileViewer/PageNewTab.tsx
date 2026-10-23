import type { ServerEntryView, ServerListing } from "@herta/app-server";
import { useCallback, useEffect, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import type { MessageKey } from "../../i18n/keys.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { REASON_KEY } from "../Approval/risk-label.js";
import { useFileViewerOpen } from "./file-viewer-context.js";

/** What the page offers to write when there is no launch file. */
const LAUNCH_EXAMPLE =
  '{ "version": 1, "servers": [ { "name": "web", "command": "npm", "args": ["run", "dev"], "port": 5173 } ] }';

const STATE_KEY: Record<ServerEntryView["state"], MessageKey> = {
  idle: "page.servers.state.idle",
  starting: "page.servers.state.starting",
  ready: "page.servers.state.ready",
  exited: "page.servers.state.exited",
  stopped: "page.servers.state.stopped",
};

/** `localhost:5173` — where a server answers, as the row says it. */
function routeOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * The page tab with no page open (ADR 0083 §4; the owner's pick B): the
 * workspace's launcher entries, a card each, with Run and Stop. A Run is
 * classified in the session as run_command would classify the command; an
 * ask-class one shows its command and why it asks, here in the card, on
 * its first start in the session (question 8). Without a launch file, how
 * to make one.
 */
export function PageNewTab({
  sessionId,
}: {
  readonly sessionId: string;
}): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const openFile = useFileViewerOpen();
  const [listing, setListing] = useState<ServerListing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<{
    readonly name: string;
    readonly command: string;
    readonly code?: string;
  } | null>(null);
  const [failure, setFailure] = useState<{
    readonly name: string;
    readonly text: string;
  } | null>(null);

  const refresh = useCallback(() => {
    void bridge.serversList?.(sessionId).then(setListing, () => undefined);
  }, [bridge, sessionId]);
  useEffect(() => {
    setListing(null);
    setAsk(null);
    setFailure(null);
    refresh();
    return bridge.onServersChanged?.((sid) => {
      if (sid === sessionId) refresh();
    });
  }, [bridge, sessionId, refresh]);

  const run = async (name: string, confirmed: boolean): Promise<void> => {
    if (bridge.serversStart === undefined) return;
    setBusy(name);
    setAsk(null);
    setFailure(null);
    try {
      const r = await bridge.serversStart(sessionId, name, confirmed);
      if (r.ok) return;
      if (r.reason === "confirm") {
        setAsk({
          name,
          command: r.command,
          ...(r.code !== undefined ? { code: r.code } : {}),
        });
      } else {
        setFailure({
          name,
          text:
            r.reason === "refused"
              ? `${t("page.servers.refused")}${r.message}`
              : r.reason === "failed"
                ? `${t("page.servers.failed")}${r.message}`
                : t("page.servers.gone"),
        });
      }
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const stop = async (name: string): Promise<void> => {
    setBusy(name);
    try {
      await bridge.serversStop?.(sessionId, name);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  if (listing === null || (!listing.ok && listing.reason === "no_launcher")) {
    return <p className="page-view__empty">{t("page.empty")}</p>;
  }
  if (!listing.ok) {
    return (
      <div className="page-servers">
        <p className="page-servers__hint">{t("page.empty")}</p>
        <div className="page-servers__nofile">
          <p>
            {listing.reason === "no_launch_file"
              ? t("page.servers.noFile")
              : `${t("page.servers.badFile")}${listing.message ?? ""}`}
          </p>
          <code className="page-servers__example">{LAUNCH_EXAMPLE}</code>
        </div>
      </div>
    );
  }
  return (
    <div className="page-servers">
      <p className="page-servers__hint">{t("page.empty")}</p>
      {listing.entries.map((e) => {
        const running = e.state === "starting" || e.state === "ready";
        const pending = busy === e.name;
        return (
          <div key={e.name} className="page-server" data-state={e.state}>
            <div className="page-server__head">
              <span
                className={`page-server__dot is-${pending && !running ? "starting" : e.state}`}
                aria-hidden="true"
              />
              <span className="page-server__name">{e.name}</span>
              <button
                type="button"
                className="page-server__btn"
                disabled={pending}
                onClick={() =>
                  void (running ? stop(e.name) : run(e.name, false))
                }
              >
                {running ? (
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    aria-hidden="true"
                  >
                    <rect
                      x="2"
                      y="2"
                      width="6"
                      height="6"
                      rx="1"
                      fill="currentColor"
                    />
                  </svg>
                ) : (
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    aria-hidden="true"
                  >
                    <path d="M3 1.8v6.4L8.2 5z" fill="currentColor" />
                  </svg>
                )}
                {t(running ? "page.servers.stop" : "page.servers.start")}
              </button>
            </div>
            <div className="page-server__cmd">{e.command}</div>
            <div className="page-server__meta">
              {t(STATE_KEY[pending && !running ? "starting" : e.state])}
              {e.state === "exited" && e.exitCode != null
                ? ` (${e.exitCode})`
                : ""}
              {` · ${routeOf(e.url)}`}
              {e.logPath !== undefined && openFile !== null && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="page-server__log"
                    onClick={() =>
                      openFile(e.logPath as string, {
                        label: `${e.name} · ${t("page.servers.log")}`,
                      })
                    }
                  >
                    {t("page.servers.log")}
                  </button>
                </>
              )}
            </div>
            {ask !== null && ask.name === e.name && (
              <fieldset className="page-server__ask">
                <p>
                  {ask.code !== undefined && REASON_KEY[ask.code] !== undefined
                    ? t("page.servers.confirmWhy").replace(
                        "{why}",
                        t(REASON_KEY[ask.code] as MessageKey),
                      )
                    : t("page.servers.confirm")}
                </p>
                <code className="page-server__cmd">{ask.command}</code>
                <div className="page-server__ask-actions">
                  <button
                    type="button"
                    className="page-server__btn"
                    onClick={() => setAsk(null)}
                  >
                    {t("page.servers.cancel")}
                  </button>
                  <button
                    type="button"
                    className="page-server__btn is-primary"
                    onClick={() => void run(e.name, true)}
                  >
                    {t("page.servers.confirmRun")}
                  </button>
                </div>
              </fieldset>
            )}
            {failure !== null && failure.name === e.name && (
              <p className="page-server__failure">{failure.text}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
