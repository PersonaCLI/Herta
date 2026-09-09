import { app } from "electron";
import type { AppUpdater, UpdateInfo } from "electron-updater";
// The state shape lives with the IPC contract (bridge-types is deliberately
// DOM-free so main/preload can import it).
import type { UpdateState } from "../renderer/ipc/bridge-types.js";

export type { UpdateState };

/** Interval between automatic checks. Launch also checks once (delayed so
 *  the boot path never competes with the update check). */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const LAUNCH_CHECK_DELAY_MS = 15_000;

export interface UpdateServiceDeps {
  /** electron-updater's autoUpdater (injected for tests). */
  readonly updater: AppUpdater;
  /** Push a state snapshot to the renderer. */
  readonly send: (state: UpdateState) => void;
  /** app.isPackaged — dev runs have no app-update.yml and must not check. */
  readonly isPackaged: boolean;
  /** Optional generic-provider override (HERTA_UPDATE_URL): points the feed
   *  at any static HTTP server. This is the end-to-end dry-run lever while
   *  the GitHub repo is private — serve latest.yml + installer + blockmap
   *  from localhost and the full download→verify→install loop runs. */
  readonly feedUrlOverride?: string;
  /** Whether the AUTOMATIC cycle (launch check + interval) starts enabled
   *  (Settings → Update, persisted; default true). Manual checks are
   *  unaffected. Live-toggled via setAutoEnabled. */
  readonly autoEnabled?: boolean;
}

export interface UpdateService {
  /** Wire updater events + start the launch/interval checks. */
  start(): void;
  /** Manual check (Settings button). Errors surface (unlike auto checks). */
  checkNow(): Promise<void>;
  /** Quit and install a `ready` update. No-op unless ready. */
  restartAndInstall(): void;
  /** The renderer's initial snapshot (invoke-time state). */
  current(): UpdateState;
  /** Live-toggle the AUTOMATIC cycle (Settings → Update): off cancels the
   *  pending launch check and the interval; on restarts the interval and
   *  runs one check. Manual checks work either way. No-op before start()
   *  (start() applies the initial setting) and in unsupported envs. */
  setAutoEnabled(enabled: boolean): void;
  dispose(): void;
}

/**
 * Auto-update service (2026-07-10). Policy: check on launch + every 4h,
 * download in the background when found (differential via the blockmap),
 * install on quit by default — `restartAndInstall` is the opt-in "now"
 * path. AUTOMATIC check failures are silent (the feed is a private repo
 * until launch, and an offline user must not be nagged); only a manual
 * Settings check reports `error`. Never installs mid-session on its own:
 * autoInstallOnAppQuit rides the existing before-quit flush hold.
 */
/** Whether an updater error means the feed could not be reached at all —
 *  Chromium's `net::ERR_*`, Node's socket errors, a TLS handshake that did
 *  not complete — as opposed to an answer it did not like (404, a bad
 *  signature). The feed is GitHub; from some networks it is simply not
 *  there. Exported for tests. */
export function isUnreachable(message: string): boolean {
  return /net::ERR_|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|timed? ?out|fetch failed|handshake|certificate|getaddrinfo|ERR_NETWORK/i.test(
    message,
  );
}

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const { updater, send } = deps;
  let state: UpdateState = { phase: "idle" };
  let manualCheck = false;
  let launchTimer: NodeJS.Timeout | null = null;
  let interval: NodeJS.Timeout | null = null;
  let autoEnabled = deps.autoEnabled ?? true;
  let started = false;

  const clearAutoTimers = (): void => {
    if (launchTimer !== null) {
      clearTimeout(launchTimer);
      launchTimer = null;
    }
    if (interval !== null) {
      clearInterval(interval);
      interval = null;
    }
  };

  /** Phases that END an update flow. `manualCheck` stays latched until one
   *  of these lands (audit 2026-07-10, finding 8): it used to reset in
   *  check()'s finally — i.e. when checkForUpdates() resolved, which is
   *  merely "metadata fetched" — so an error DURING the autoDownload that
   *  the check kicked off took the silent branch, and a user who watched
   *  "available v0.2.0 → downloading 30%" was told 已是最新. `checking`,
   *  `available`, and `downloading` are all mid-flow. */
  const TERMINAL_PHASES: ReadonlySet<UpdateState["phase"]> = new Set([
    "idle",
    "up-to-date",
    "ready",
    "error",
  ]);

  const set = (next: UpdateState): void => {
    state = next;
    // Clear AFTER the branch that consulted manualCheck built `next` —
    // set() is always the last step of an event handler.
    if (TERMINAL_PHASES.has(next.phase)) manualCheck = false;
    send(state);
  };

  const wire = (): void => {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    if (deps.feedUrlOverride !== undefined) {
      updater.setFeedURL({ provider: "generic", url: deps.feedUrlOverride });
    }
    updater.on("checking-for-update", () => set({ phase: "checking" }));
    updater.on("update-available", (info: UpdateInfo) =>
      set({ phase: "available", version: info.version }),
    );
    // An ANSWER, not silence: the feed said there is nothing newer. Distinct
    // from the `idle` the silent-failure paths use (audit 2026-07-24, 1.13).
    updater.on("update-not-available", () => set({ phase: "up-to-date" }));
    updater.on("download-progress", (p: { percent: number }) =>
      set({
        phase: "downloading",
        version: state.version,
        progress: Math.round(p.percent),
      }),
    );
    updater.on("update-downloaded", (info: UpdateInfo) =>
      set({ phase: "ready", version: info.version }),
    );
    updater.on("error", (err: Error) => report(err));
  };

  /**
   * One failure, one report. A feed that cannot be REACHED (offline, a
   * blocked region — GitHub is the feed; owner 2026-09-09: "正在检查…" then
   * "尚未检查更新" was all a user behind a wall ever saw) is said so on the
   * automatic path too, with `network` set so the pane can point at the
   * VPN and the netdisk: nothing to nag about, and the pane is the only
   * place it shows. Any other automatic failure (a private feed's 404)
   * stays silent as before; a manual check reports whatever it hit.
   */
  const report = (err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    if (isUnreachable(message)) {
      set({ phase: "error", message, network: true });
    } else if (manualCheck) {
      set({ phase: "error", message });
    } else {
      set({ phase: "idle" });
    }
  };

  const check = async (): Promise<void> => {
    try {
      await updater.checkForUpdates();
      // No reset here (finding 8): checkForUpdates() resolving only means
      // the metadata arrived — the download the check started is still in
      // flight, and its outcome must keep the manual/auto distinction.
      // set() clears the latch at the next terminal phase.
    } catch (err) {
      // checkForUpdates rejects AND emits "error" for the same failure. The
      // event lands first and, being terminal, clears the manual latch — so
      // this catch used to take the silent branch and overwrite a reported
      // error with idle (owner 2026-09-09). The event's report stands.
      if (state.phase === "error") return;
      report(err);
    }
  };

  return {
    start(): void {
      // Dev runs have no app-update.yml — checking throws noise. The dry-run
      // override re-enables checks in dev against a localhost feed.
      if (!deps.isPackaged && deps.feedUrlOverride === undefined) return;
      wire();
      started = true;
      // Events are wired regardless (manual checks need them); the AUTOMATIC
      // cycle honors the persisted Settings → Update toggle.
      if (!autoEnabled) return;
      launchTimer = setTimeout(() => {
        launchTimer = null;
        void check();
      }, LAUNCH_CHECK_DELAY_MS);
      interval = setInterval(() => void check(), CHECK_INTERVAL_MS);
    },
    setAutoEnabled(enabled: boolean): void {
      autoEnabled = enabled;
      if (!started) return; // start() applies the initial value
      clearAutoTimers();
      if (enabled) {
        // Re-enabling checks once right away (the user just asked for
        // automatic updates back), then resumes the interval cadence.
        void check();
        interval = setInterval(() => void check(), CHECK_INTERVAL_MS);
      }
    },
    async checkNow(): Promise<void> {
      if (!deps.isPackaged && deps.feedUrlOverride === undefined) {
        set({ phase: "error", message: "dev build (no update feed)" });
        return;
      }
      manualCheck = true;
      await check();
    },
    restartAndInstall(): void {
      if (state.phase !== "ready") return;
      // quitAndInstall quits DIRECTLY — the window has not closed yet at
      // before-quit time, so the flush hold's pendingDispose (assigned only
      // by the window's closed handler) was still null and the hold never
      // engaged: this comment used to claim the flush ran, and it did not
      // (audit 2026-07-10, finding 7). before-quit now starts the session
      // dispose eagerly for exactly this shape (main/index.ts), so the
      // mid-turn transcript lands before the installer takes over.
      updater.quitAndInstall();
    },
    current: () => state,
    dispose(): void {
      clearAutoTimers();
      updater.removeAllListeners();
    },
  };
}

/** The app's own version, for the Settings pane ("当前版本 vX.Y.Z"). */
export function appVersion(): string {
  return app.getVersion();
}
