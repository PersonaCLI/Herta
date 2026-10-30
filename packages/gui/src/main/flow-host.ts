import { join } from "node:path";
import {
  type FlowEvent,
  type FlowFailure,
  type FlowIssue,
  FlowService,
  type FlowSettings,
  type FlowStatus,
  normalizeFlowSettings,
  type SessionHost,
} from "@herta/app-server";
import {
  defaultWebClient,
  flowSideModel,
  flowWordFrom,
} from "@herta/app-server/wiring";
import type { ipcMain } from "electron";
import { CMD, EVT } from "../preload/channels.js";
import type {
  FlowEvent as FlowEventView,
  FlowFailure as FlowFailureView,
  FlowIssueView,
  FlowSettingsView,
  FlowStateView,
} from "../shared/flow.js";
import { flowImageUrl } from "./flow-protocol.js";

/**
 * Flow in the desktop's main process (ADR 0084): one service for the app,
 * the same issue from every session (§2), its IPC, and the mapping from the
 * store's shapes to the panel's. Nothing here reaches a session's record
 * (§12, D7) — the host is read only for whether a turn is in flight, the
 * recent workspaces and Herta's model.
 */

/** Herta's model when no host has started yet: the actor's default. */
const DEFAULT_WORD_MODEL = "deepseek-v4-pro";
/** Her notes come from the workspaces of the sessions used in this window,
 *  the most recent first (§4, question 10). */
const RECENT_DAYS = 14;
/** A bound on the listing: each entry costs a stat and a read on this
 *  thread (perf audit 2026-09-20). */
const RECENT_SESSIONS = 60;

export interface FlowHostDeps {
  /** Flow's own dir: `<userData>/flow`, beside the transcripts (§10). */
  readonly dir: string;
  readonly host: () => SessionHost | null;
  /** The DeepSeek key now; empty when none is set. */
  readonly apiKey: () => string;
  readonly baseUrl?: string;
  /** The GUI's language now: an issue is gathered in it (§7). */
  readonly lang: () => "zh" | "en";
  /** The `flow` section of the per-user settings, read and written whole. */
  readonly readSettings: () => Promise<unknown>;
  readonly writeSettings: (next: FlowSettings) => Promise<void>;
  readonly send: (channel: string, payload: unknown) => void;
  readonly openExternal: (url: string) => Promise<void>;
  /** Test seam. */
  readonly now?: () => number;
  /** Test seam: the service, built from the other deps by default. */
  readonly service?: (opts: {
    readonly settings: () => FlowSettings;
    readonly onChange: (e: FlowEvent) => void;
  }) => FlowLike;
}

/** What this module uses of the service. */
export type FlowLike = Pick<
  FlowService,
  "start" | "refresh" | "issues" | "markRead" | "state" | "dispose" | "tick"
>;

export interface FlowHost {
  /** Register Flow's channels through the session service's `handle`. */
  register(handle: typeof ipcMain.handle): void;
  /** Read the settings, then start the trigger's clock. */
  start(): Promise<void>;
  dispose(): Promise<void>;
}

export function createFlowHost(deps: FlowHostDeps): FlowHost {
  const now = deps.now ?? Date.now;
  let settings: FlowSettings = normalizeFlowSettings(undefined);
  let status: FlowStatus | null = null;
  let started = false;
  const hasKey = (): boolean => deps.apiKey().trim() !== "";
  const baseUrl = deps.baseUrl !== undefined ? { baseUrl: deps.baseUrl } : {};

  const service: FlowLike =
    deps.service?.({ settings: () => settings, onChange }) ??
    new FlowService({
      dir: deps.dir,
      settings: () => settings,
      hasKey,
      isBusy: () => deps.host()?.activeSession?.turnInFlight === true,
      webClient: () => defaultWebClient(deps.apiKey, baseUrl),
      sideModel: () => flowSideModel(deps.apiKey, baseUrl),
      word: flowWordFrom({
        apiKey: deps.apiKey,
        ...baseUrl,
        model: () => deps.host()?.models?.().actorModel ?? DEFAULT_WORD_MODEL,
      }),
      workspaceRoots: () => recentWorkspaces(deps.host(), now()),
      lang: deps.lang,
      onChange,
      now,
    });

  function onChange(e: FlowEvent): void {
    if (e.kind === "state") {
      status = e.status;
      sendState();
    } else if (e.kind === "stage") {
      const { kind: _k, ...stage } = e;
      if (status !== null) status = { ...status, running: true, stage };
      sendState();
    } else if (e.kind === "landed") {
      void service
        .issues()
        .then((list) => {
          const issue = list.find((i) => i.id === e.issueId);
          if (issue !== undefined)
            send({ kind: "issue", issue: flowIssueView(issue) });
        })
        .catch(() => undefined);
    }
  }
  function send(e: FlowEventView): void {
    deps.send(EVT.flow, e);
  }
  function sendState(): void {
    send({ kind: "state", state: view() });
  }
  function view(): FlowStateView {
    return flowStateView(status, settings, hasKey());
  }
  async function freshState(): Promise<FlowStateView> {
    status = await service.state();
    return view();
  }

  return {
    register(handle) {
      handle(CMD.flowState, () => freshState());
      handle(CMD.flowIssues, async () =>
        (await service.issues()).map(flowIssueView),
      );
      handle(CMD.flowRefresh, () => service.refresh());
      handle(CMD.flowMarkRead, async (_e, issueId: unknown) => {
        if (typeof issueId !== "string") return;
        status = await service.markRead(issueId);
      });
      // A post's source opens in the OS browser only when it is a post of a
      // kept issue: the renderer is not trusted with an "open any URL" door.
      handle(CMD.flowOpenSource, async (_e, url: unknown) => {
        if (typeof url !== "string") return false;
        const issues = await service.issues();
        if (!issues.some((i) => i.cards.some((c) => c.url === url)))
          return false;
        if (!/^https?:\/\//i.test(url)) return false;
        await deps.openExternal(url);
        return true;
      });
      handle(CMD.flowSettings, (): FlowSettingsView => settings);
      handle(CMD.flowSetSettings, async (_e, next: unknown) => {
        const wasOn = settings.enabled;
        settings = normalizeFlowSettings(next);
        await deps.writeSettings(settings);
        sendState();
        // Turned on: today's issue need not wait for the next tick (§6).
        if (!wasOn && settings.enabled && started)
          void service.tick().catch(() => undefined);
        return settings;
      });
    },
    async start() {
      settings = normalizeFlowSettings(await deps.readSettings());
      started = true;
      service.start();
    },
    async dispose() {
      started = false;
      await service.dispose();
    },
  };
}

/** The workspaces of the sessions used in the last two weeks, most recent
 *  first, each once. */
export function recentWorkspaces(
  host: SessionHost | null,
  now: number,
): readonly string[] {
  if (host === null) return [];
  const since = now - RECENT_DAYS * 24 * 60 * 60 * 1000;
  const rows = host
    .listSessions({ workspaceRoot: null, limit: RECENT_SESSIONS })
    .filter((m) => Date.parse(m.lastActivityAt) >= since)
    .sort(
      (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
    );
  return [...new Set(rows.map((m) => m.workspaceRoot))];
}

const FAILURE_VIEW: Readonly<Record<FlowFailure, FlowFailureView>> = {
  no_key: "no_key",
  no_interests: "no_interests",
  balance: "balance",
  auth: "auth",
  network: "network",
  error: "other",
};

export function flowStateView(
  status: FlowStatus | null,
  settings: FlowSettings,
  hasKey: boolean,
): FlowStateView {
  const running = status?.running === true;
  return {
    enabled: settings.enabled,
    gathering: running ? (status?.stage ?? { stage: "queries" }) : null,
    // No key is said before any attempt: the trigger never starts one.
    failed:
      settings.enabled && !hasKey
        ? "no_key"
        : status?.lastFailure != null
          ? FAILURE_VIEW[status.lastFailure.reason]
          : null,
    unreadIssueId: status?.unread ?? null,
    refreshesLeft: status?.refreshesLeft ?? 3,
  };
}

export function flowIssueView(issue: FlowIssue): FlowIssueView {
  return {
    id: issue.id,
    number: issue.number,
    localDate: issue.localDate,
    lang: issue.lang,
    posts: issue.cards.map((c, n) => ({
      id: `${issue.id}/${n}`,
      url: c.url,
      site: c.site,
      date: /^\d{4}-\d{2}-\d{2}/.test(c.date) ? c.date.slice(0, 10) : null,
      title: c.title,
      summary: c.summary,
      why: c.why,
      detail: c.detail,
      points: c.points,
      word: c.word,
      picture: c.picture !== null ? flowImageUrl(issue.id, c.picture) : null,
    })),
    evidence: {
      queries: issue.evidence.queries.map((q) => q.text),
      hits: issue.evidence.hits.map((h) => ({
        title: h.title,
        site: h.site,
        date: h.date,
        url: h.url,
        fate: h.fate,
      })),
      pages: issue.evidence.pages.filter((p) => p.ok).map((p) => p.url),
    },
  };
}

/** Flow's dir under the app's data dir (§10). */
export function flowDirFor(userDataDir: string): string {
  return join(userDataDir, "flow");
}
