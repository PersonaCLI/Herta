import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AppServerConfig,
  type AutoReviewState,
  type ContinueInterruptedResult,
  createSessionHost,
  defaultDirsFor,
  recordTail,
  type Session,
  type SessionHost,
  type SessionMetadata,
  type SpeechSynthesizer,
  type SteerTextResult,
  type TalkTextResult,
  type UndoTarget,
  type UndoTurnEditsResult,
} from "@herta/app-server";
import {
  type BrowserHost,
  errorMessage,
  type PickedElement,
  type ServerHost,
} from "@herta/core";
import { canonicalWorkspaceRoot, validateWorkspaceRoot } from "@herta/tools";
import {
  app,
  type BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type WebContents,
} from "electron";
import { CMD, EVT } from "../preload/channels.js";
import type { SessionSnapshot } from "../renderer/ipc/bridge-types.js";
import { slimAgentEventForRenderer } from "../shared/agent-event-wire.js";
import { createLiveToolFeed } from "../shared/live-tool-feed.js";
import {
  composerPredictionsEnabled,
  type InteractionLang,
  type Locale,
  osLocale,
  pdfPictureTranscriptsEnabled,
  readGlobalSettings,
  resolveInitialLocale,
  resolveInteractionLang,
  updateGlobalSettings,
} from "./app-global-settings.js";
import {
  dreamEnabled,
  effectiveModels,
  readAppSettings,
} from "./app-settings.js";
import { registerAttachmentHandlers } from "./attachment-ipc.js";
import {
  type AttentionPrefs,
  DEFAULT_ATTENTION_PREFS,
  watchAttention,
} from "./attention.js";
import { createElectronAttentionHost } from "./attention-electron.js";
import { bootstrapOnce } from "./bootstrap-once.js";
import { createFlowHost, flowDirFor } from "./flow-host.js";
import { installMode } from "./install-mode.js";
import { readDeepSeekKeyPlain } from "./key-store.js";
import { shrinkPictureWithNativeImage } from "./picture-shrink.js";
import { createSessionActivation } from "./session-activation.js";
import {
  isSafeSessionId,
  recordPage,
  recordWindowFor,
  registerSessionListHandlers,
  sanitizeCreateOpts,
} from "./session-list-ipc.js";
import {
  attentionSettingsOf,
  registerSettingsHandlers,
  type SettingsHooks,
} from "./settings-ipc.js";
import { TRAY_SESSION_ROWS } from "./tray-menu.js";
import { resolveVoiceRoot } from "./voice-path.js";
import { createVoiceStack } from "./voice-stack.js";
import {
  registerWorkspaceReadHandlers,
  sanitizeLogQuery,
} from "./workspace-read-ipc.js";

// Tested through this module (session-service.test.ts); each lives with
// the handlers it guards.
export {
  isSafeSessionId,
  recordPage,
  recordWindowFor,
  sanitizeCreateOpts,
  sanitizeLogQuery,
};

type Send = (channel: string, payload: unknown) => void;

/** Walk up from `start` to the nearest ancestor containing a `.git`
 *  marker (file or dir) — the canonical project-root indicator. Returns
 *  undefined if the filesystem root is reached without finding one. */
export function findProjectRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root
    dir = parent;
  }
}

/** Window commands that are the user doing something outside a turn (dream
 *  review 2026-09-22, finding 12). Each resets the dream trigger's idle
 *  clock, and a pass already running steps aside at its next episode: a
 *  user rewinding, attaching, searching or reading a file in the viewer is
 *  back, however long ago they last sent a message. Turns are counted by
 *  the host itself; reads the window makes on its own (the list refresh,
 *  a resync, the repo watcher, settings panes loading their values) are
 *  not the user and stay out. */
const USER_ACTION_CHANNELS: ReadonlySet<string> = new Set([
  CMD.interrupt,
  CMD.steerText,
  CMD.talkText,
  CMD.rewindLastTurn,
  CMD.undoLastTurnEdits,
  CMD.search,
  CMD.recordSlice,
  CMD.recordWindow,
  CMD.deleteSession,
  CMD.renameSession,
  CMD.saveSessionExport,
  CMD.resolveApproval,
  CMD.setAutoReview,
  CMD.pickWorkspace,
  CMD.setWorkspace,
  CMD.resetWorkspace,
  CMD.pickAttachments,
  CMD.attachFiles,
  CMD.removeAttachment,
  CMD.serversStart,
  CMD.serversStop,
  CMD.stageImages,
  CMD.unstageImage,
  CMD.readWorkspaceFile,
  CMD.readWorkspaceBytes,
  CMD.readWorkspaceCommit,
  CMD.readWorkspaceDiff,
  CMD.readWorkspaceLog,
  CMD.readWorkspaceBranches,
  CMD.openWorkspaceFile,
]);

export function countsAsUserActivity(channel: string): boolean {
  // Every settings WRITE is a choice the user just made; the reads are the
  // panes loading and are not.
  return (
    USER_ACTION_CHANNELS.has(channel) || channel.startsWith("settings:set")
  );
}

/** The workspace the session serves. Resolution order:
 *   1. HERTA_WORKSPACE_ROOT (explicit override),
 *   2. `packagedUserDataDir` when provided — an INSTALLED app anchors its
 *      workspace at the per-user data dir (its cwd is the install dir,
 *      typically unwritable Program Files; transcripts/memory/dream all
 *      live under `<workspaceRoot>/.herta`, so cwd would break first run),
 *   3. the auto-detected project root (nearest ancestor with .git),
 *   4. the process cwd.
 *  Auto-detection means `pnpm dev:gui` (cwd = packages/gui) resolves to
 *  the repo root with no env vars, so the API key + canon files load
 *  automatically. A proper picker is deferred. */
export function resolveWorkspaceRoot(packagedUserDataDir?: string): string {
  const override = process.env.HERTA_WORKSPACE_ROOT;
  // Canonical in every branch (audit S8) — this path bypasses
  // validateWorkspaceRoot entirely, and a root reached through a symlink or a
  // junction makes resolveSafePath reject every file inside it. On macOS that
  // is any project under /tmp or /var, and cwd is not always a path the user
  // chose.
  if (override !== undefined && override.length > 0) {
    return canonicalWorkspaceRoot(override);
  }
  if (packagedUserDataDir !== undefined) {
    return canonicalWorkspaceRoot(packagedUserDataDir);
  }
  return canonicalWorkspaceRoot(
    findProjectRoot(process.cwd()) ?? process.cwd(),
  );
}

/** `resolveWorkspaceRoot` with THIS process's install mode applied — the
 *  thin electron-aware wrapper (the pure fn stays unit-testable). */
export function appWorkspaceRoot(): string {
  return resolveWorkspaceRoot(
    installMode().installed ? app.getPath("userData") : undefined,
  );
}

export async function buildConfig(
  cwd: string,
  home: string,
  // Plaintext key from the secure store (`key-store.readDeepSeekKeyPlain`),
  // read by the caller because the store needs Electron `app`/`safeStorage`
  // (kept out of this pure, unit-tested fn). Null when none is stored.
  secureKey: string | null = null,
  // Packaged-aware voice root override (resolveVoiceRoot), injected by the
  // caller for the same purity reason as the key: the install mode needs
  // Electron (install-mode.ts). Absent → defaultDirsFor's dev layout
  // (<cwd>/data/voice) stands.
  voiceAssetsDir?: string,
  // Dev-only DeepSeek base-URL override (chaos/staging proxy). The CALLER
  // gates this on an installed app before passing (same credential-safety
  // reasoning as HERTA_UPDATE_URL, audit T1.3: a packaged build honoring an
  // env-set base URL would send the API key to an arbitrary host).
  devBaseUrl?: string,
  // Herta's speech synthesizer (ADR 0042), injected for the same purity
  // reason as the key and the voice root: it forks an Electron
  // utilityProcess. Absent → sessions run the paced text reveal, exactly as
  // before.
  speechSynthesizer?: SpeechSynthesizer,
): Promise<AppServerConfig> {
  // The GUI reads the DeepSeek key from the encrypted secure store ONLY — no
  // env var, no legacy `deepseek-api-key.txt`. So "No key set" is honest: when
  // the store is empty there is no key, and the first submit defers to the
  // no-key onboarding (`needsKey`). An empty key is tolerated at boot (the app
  // plays the canned opening with no LLM). The CLI keeps its own env/file
  // resolution; only the GUI is secure-store-only.
  const deepseekApiKey = secureKey?.trim() ?? "";
  const dirs = defaultDirsFor({ workspaceRoot: cwd, homedir: home });
  // Dream: read the persisted enable flag (Settings → Dream). Restart-to-apply —
  // this is the whole apply path; the trigger reads config.dream at bootstrap.
  const settings = await readAppSettings(cwd);
  // The models and 板砖's effort, resolved the one way the live apply
  // resolves them too (ADR 0081; `effectiveModels`).
  const live = effectiveModels(settings);
  return {
    workspaceRoot: cwd,
    ...dirs,
    ...(voiceAssetsDir !== undefined ? { voiceAssetsDir } : {}),
    ...(speechSynthesizer !== undefined
      ? { speech: { synthesizer: speechSynthesizer } }
      : {}),
    dream: { enabled: dreamEnabled(settings) },
    providers: {
      deepseekApiKey,
      // Model names MUST match the working CLI (packages/cli/src/app/main.ts).
      // The DeepSeek COMPLETION endpoint (used by the narrative actor) accepts
      // ONLY `deepseek-flash` or `deepseek-v4-pro` (doc + live probe
      // 2026-09-10) — an off-list name returns a 400 "supported API model
      // names are…" and the turn fails silently (no record blocks). The
      // backend (chat mode) takes the same two; `deepseek-flash` reads
      // images (ADR 0048 §5b).
      //
      // Precedence (2026-08-17): env (a dev/lab override, mirrors the CLI's
      // knobs) > Settings → DeepSeek → 模型 (the user's choice, persisted in
      // settings.json, restart-to-apply) > the built-in default. A legacy
      // name in the file (`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`)
      // folds into `deepseek-flash`; an off-enum value falls to the default.
      //
      // Defaults: actor Pro (owner 2026-08-17 — the V4 flash was voice-flat
      // and fabricated on first pass, per the actor lab; DeepSeek retires V4
      // Pro on 2026-09-14, after which the name is served by V4.1 Flash, and
      // the actor lab has not been rerun on V4.1). Backend `deepseek-flash`:
      // the vision flash has been the default since 2026-08-28 (owner, ADR
      // 0048 §5a) so 板砖 can re-look at a picture without the user opting
      // in, and V4.1 Flash is that model under its current name.
      actorModel: live.actorModel,
      backendModel: live.backendModel,
      routerModel: "deepseek-flash",
      ...(devBaseUrl !== undefined && devBaseUrl !== ""
        ? { baseUrl: devBaseUrl }
        : {}),
    },
    // Backend reasoning effort (Settings → Coprocessor). Default "high"; an
    // off-enum value in a hand-edited settings.json falls back to it. Live
    // since ADR 0081: a change also reaches the running host (settings-ipc).
    thinking: live.thinking,
  };
}

/** The `session:reset` payload for a session. Exported for testing. */
export function snapshot(s: Session): SessionSnapshot {
  // Long-session windowing (2026-07-12): the reset snapshot carries only the
  // trailing window (`recordTail`) — a 10MB session no longer crosses IPC
  // in one message or mounts thousands of renderer rows. `recordStart` is the
  // absolute index the window begins at; older blocks page in on demand via
  // CMD.recordSlice below.
  const tail = recordTail(s.record);
  return {
    sessionId: s.sessionId,
    workspaceRoot: s.workspaceRoot,
    record: tail.record,
    recordStart: tail.start,
    overlay: s.overlay,
    title: s.title,
    backendWorkspace: s.backendWorkspace,
    backendWorkspaceIsDefault: s.backendWorkspaceIsDefault,
    topics: s.topics,
    lang: s.lang,
    // Whatever the repository probe has answered by now (ADR 0058); the
    // `session:repo` stream carries the rest.
    repo: s.repo ?? null,
    // A window that reloads mid-turn comes back busy, with the hold window
    // and the staged strip as they are (UX review 2026-09-22, item 7): the
    // snapshot used to carry no turn state, so a running turn showed no
    // Stop and no bubble, and staged pictures vanished while main still
    // counted them.
    ...(s.turnInFlight
      ? { turn: { backendActive: s.backendActive ?? false } }
      : {}),
    ...(s.stagedImageList !== undefined && s.stagedImageList.length > 0
      ? { stagedImages: s.stagedImageList }
      : {}),
    // The 继续 offer (ADR 0071 §1.4): a reloaded window's strip comes back.
    ...(s.resumable === true ? { resumable: true } : {}),
    // The 撤销 chip (ADR 0074 §4): a reloaded window's card keeps it.
    ...(s.undoable === true ? { undoable: true } : {}),
  };
}

/** Validate a user-supplied backend-workspace root and apply it to the
 *  matching active session (D4: validation is deterministic harness code,
 *  never persona). Exported for testing. */
export async function handleSetWorkspace(
  host: {
    activeSession: {
      sessionId: string;
      setWorkspace(
        p: string,
      ): Promise<{ ok: true } | { ok: false; reason: "turn_in_progress" }>;
    } | null;
  },
  sessionId: string,
  path: string,
  home: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const check = validateWorkspaceRoot(path, { home });
  if (!check.ok) return { ok: false, message: check.message };
  const s = host.activeSession;
  if (s === null || s.sessionId !== sessionId) {
    return { ok: false, message: "no matching active session" };
  }
  const r = await s.setWorkspace(check.resolved);
  // Idle-only refusal (audit finding 13): the session drops workspace
  // changes mid-turn rather than corrupting the record cursor.
  if (!r.ok) return { ok: false, message: "a turn is in progress" };
  return { ok: true };
}

/**
 * Take a turn's edits back (ADR 0074 §4) — a destructive call, bound to the
 * session the user clicked in like the rewind (a session switch can land
 * between the click and the invoke), and to a target the session knows.
 * Anything else answers that there is nothing to undo. Exported for testing.
 */
export async function handleUndoLastTurnEdits(
  host: {
    activeSession: {
      sessionId: string;
      undoLastTurnEdits?(target: UndoTarget): Promise<UndoTurnEditsResult>;
    } | null;
  },
  sessionId: unknown,
  target: unknown,
): Promise<UndoTurnEditsResult> {
  const nothing = { ok: false as const, reason: "nothing_to_undo" as const };
  const s = host.activeSession;
  if (
    s === null ||
    typeof sessionId !== "string" ||
    s.sessionId !== sessionId
  ) {
    return nothing;
  }
  if (target !== "latest" && target !== "withdrawn") return nothing;
  return (await s.undoLastTurnEdits?.(target)) ?? nothing;
}

/** Pipes a session's 8 subscriptions to `send`. Returns a stop fn. Exported for testing. */
export function startForwarders(session: Session, send: Send): () => void {
  let live = true;
  // Every started iterator, so stop() can CLOSE them. The old stop only
  // flipped `live`, which a pump checks after its NEXT event — a
  // switched-away session that never emits again left all 8 pumps (and
  // their subscription buffers + this `send` closure) parked in `it.next()`
  // forever, accumulating per session switch.
  const iterators: AsyncIterator<unknown>[] = [];
  async function pump<T>(
    it: AsyncIterable<T>,
    channel: string,
    // What crosses for one event; `null` = nothing does.
    wire?: (value: T) => T | null,
  ): Promise<void> {
    const iterator = it[Symbol.asyncIterator]();
    iterators.push(iterator);
    while (true) {
      const r = await iterator.next();
      if (r.done === true || !live) break;
      const value = wire === undefined ? r.value : wire(r.value);
      if (value !== null) send(channel, value);
    }
  }
  void pump(session.subscribeRecord(), EVT.record);
  void pump(session.subscribeOverlay(), EVT.overlay);
  void pump(session.subscribeSpeech(), EVT.speech);
  // The raw stream is a trace; the renderer wants its signals only — and,
  // folded from it, the live views of the call in flight (ADR 0073): a
  // bounded tail per call, ten times a second at most.
  const liveFeed = createLiveToolFeed((snapshot) => send(EVT.live, snapshot), {
    // Pointed at mid-run (a reload, a resync): the calls before now were
    // never seen, so none is numbered until the next run.
    midRun: session.backendActive === true,
  });
  void pump(session.subscribeAgentEvents(), EVT.agent, (e) => {
    liveFeed.push(e);
    return slimAgentEventForRenderer(e);
  });
  void pump(session.subscribeTurnLifecycle(), EVT.turn);
  void pump(session.subscribeTitle(), EVT.title);
  void pump(session.subscribeWorkspace(), EVT.workspace);
  void pump(session.subscribeVoice(), EVT.voice);
  // The repository card's stream (ADR 0058); optional on the interface.
  if (session.subscribeRepo !== undefined) {
    void pump(session.subscribeRepo(), EVT.repo);
  }
  // The 继续 offer (ADR 0071 §1.4); optional on the interface.
  if (session.subscribeResume !== undefined) {
    void pump(session.subscribeResume(), EVT.resume);
  }
  // The 撤销 chip (ADR 0074 §4); optional on the interface.
  if (session.subscribeUndo !== undefined) {
    void pump(session.subscribeUndo(), EVT.undo);
  }
  return () => {
    live = false;
    liveFeed.close();
    for (const it of iterators) {
      // Resolves the parked next() with {done:true}; best-effort (a generator
      // mid-yield settles on its own).
      void it.return?.().catch(() => undefined);
    }
  };
}

/** Pick the most-recently-active session from a `listSessions()` result.
 *  `SessionHost.listSessions()` is already sorted newest-first (by transcript
 *  mtime; see `@herta/core` `list-sessions`), so the head is the latest — but
 *  we re-select by `lastActivityAt` defensively so this stays correct even if
 *  an upstream caller re-orders the array. Callers must pass a non-empty list. */
export function pickLatest(
  sessions: readonly SessionMetadata[],
): SessionMetadata {
  return sessions.reduce((latest, s) =>
    Date.parse(s.lastActivityAt) > Date.parse(latest.lastActivityAt)
      ? s
      : latest,
  );
}

export interface SessionService {
  start(): Promise<void>;
  dispose(): Promise<void>;
  /** Tray-facing: newest-first metadata (empty before bootstrap). */
  listSessions(): readonly SessionMetadata[];
  /** Tray-facing: activate an existing session. Rides the same
   *  last-click-wins activation sequence as renderer sidebar clicks, so a
   *  tray open racing a sidebar open cannot land the UI on the loser. */
  openSessionFromMain(sessionId: string): Promise<void>;
  /** Tray-facing: create + activate a fresh session ("New Chat"). */
  createSessionFromMain(): Promise<void>;
  /** The active session's effective backend workspace — where attachments
   *  live (ADR 0048). Null before bootstrap. Read fresh per call: the user
   *  can change the workspace mid-session. */
  backendWorkspace(): string | null;
}

/** The main-side hooks the Settings rows fire (see settings-ipc.ts). */
export type SessionServiceHooks = SettingsHooks & {
  /** The window's browser pages (ADR 0083): each session gets its page's
   *  driver for 板砖's steps, and a deleted session's page closes. */
  readonly browser?: {
    driverFor(sessionId: string): BrowserHost;
    closeSession(sessionId: string): void;
  };
  /** The window's dev servers (ADR 0083 §5): each session's launcher, for
   *  dev_server; a deleted session's servers stop. */
  readonly servers?: {
    forSession(sessionId: string): ServerHost;
    closeSession(sessionId: string): void;
    attachJournal(
      journal: ReturnType<NonNullable<SessionHost["serverJournal"]>> | null,
    ): void;
  };
};

/** Wires the SessionHost + ipcMain handlers to a single window's webContents.
 *  Single-window assumption for Slice 4. */
export function createSessionService(
  wc: WebContents,
  win: BrowserWindow,
  hooks: SessionServiceHooks = {},
): SessionService {
  let host: SessionHost | null = null;
  /** The Dream flag the running host was built with (the Settings pane's
   *  restart note compares against it); undefined before bootstrap. */
  let dreamRunning: boolean | undefined;
  let handlersRegistered = false;
  const send: Send = (ch, payload) => {
    if (!wc.isDestroyed()) wc.send(ch, payload);
  };
  // Herta's synthesized voice (voice-stack.ts): the local synthesizer, its
  // model download and the cloud voice. Built once and shared by every
  // session; `bootstrap` starts it.
  const voice = createVoiceStack(send);

  // When the user is away from the window (ADR 0072 §1): notifications and
  // keep-awake for the active session. Both settings and the UI language are
  // cached here (seeded at bootstrap, kept by the Settings hooks) because the
  // watcher reads them at every event.
  let attentionPrefs: AttentionPrefs = DEFAULT_ATTENTION_PREFS;
  let uiLocale: Locale = "en";
  const refreshUiLocale = async (): Promise<void> => {
    const s = await readGlobalSettings(app.getPath("userData"));
    uiLocale = resolveInitialLocale(s, osLocale(process.platform, app));
  };
  const attentionHost = createElectronAttentionHost({
    win,
    prefs: () => attentionPrefs,
    locale: () => uiLocale,
  });

  // Flow (ADR 0084): one issue a day for the app, the same from every
  // session. It reads the host only for whether a turn is in flight, the
  // recent workspaces and Herta's model; its settings are per user.
  const flowUserData = app.getPath("userData");
  const flow = createFlowHost({
    dir: flowDirFor(flowUserData),
    host: () => host,
    apiKey: () => readDeepSeekKeyPlain() ?? "",
    // The same dev-only override the sessions get, never in a packaged build.
    ...(!installMode().installed &&
    process.env.HERTA_DEEPSEEK_BASE_URL !== undefined &&
    process.env.HERTA_DEEPSEEK_BASE_URL !== ""
      ? { baseUrl: process.env.HERTA_DEEPSEEK_BASE_URL }
      : {}),
    lang: () => uiLocale,
    readSettings: async () => (await readGlobalSettings(flowUserData)).flow,
    writeSettings: (next) =>
      updateGlobalSettings(flowUserData, (cur) => ({ ...cur, flow: next })),
    send,
    openExternal: (url) => shell.openExternal(url),
  });

  // Interaction language (slice 4): resolved FRESH here per activation (like
  // the theme setting reads per call) — stored choice, else follow the UI locale.
  // Threaded into the host so the session builds its static prefix, openings,
  // driver, recap, and title in this language. On CREATE this is the session's
  // birth language and the host persists it into the header. On OPEN the host
  // prefers the persisted header language and uses this value only as the
  // fallback for legacy sessions written before per-session persistence — so a
  // global EN/CN toggle changes NEW sessions without retro-flipping old ones.
  async function currentInteractionLang(): Promise<InteractionLang> {
    const s = await readGlobalSettings(app.getPath("userData"));
    return resolveInteractionLang(
      s,
      resolveInitialLocale(s, osLocale(process.platform, app)),
    );
  }

  // Which session the window shows, and the open / create / delete calls
  // that change it — last click wins, and after each settles the window
  // follows the host (session-activation.ts).
  const activation = createSessionActivation({
    host: () => host,
    send,
    // The window's forwarders, and beside them the attention watcher — which
    // therefore always concerns the session the window shows, and stops
    // (releasing any keep-awake hold) when the window points elsewhere.
    startForwarders: (session, sendTo) => {
      const stopForwarders = startForwarders(session, sendTo);
      const stopAttention = watchAttention(session, attentionHost);
      return () => {
        stopForwarders();
        stopAttention();
      };
    },
    snapshot,
    lang: currentInteractionLang,
  });
  const { openAndPoint, createAndPoint } = activation;

  // Channels THIS service registered — dispose() removes exactly these
  // (audit T3.7): the old sweep removed every channel in the CMD map,
  // tearing down the update / app-version / window-control handlers that
  // index.ts owns whenever a session service was disposed.
  const ownedChannels: string[] = [];
  const handle: typeof ipcMain.handle = (channel, listener) => {
    ipcMain.handle(
      channel,
      countsAsUserActivity(channel)
        ? (event, ...args) => {
            host?.noteUserActivity?.();
            return listener(event, ...args);
          }
        : listener,
    );
    ownedChannels.push(channel);
  };

  // Register the ipcMain handlers SYNCHRONOUSLY at construction, BEFORE any
  // async bootstrap. They read the mutable `host` closure, so they safely
  // no-op (returning [] / undefined) until start() sets it, then work once
  // the session exists. Registering inside the async start() (after
  // `await createSession`) raced the renderer's first session:list /
  // session:submitText invokes — and if bootstrap threw, the handlers were
  // never registered at all ("No handler registered").
  function registerHandlers(): void {
    if (handlersRegistered) return;
    handlersRegistered = true;
    handle(
      CMD.submitText,
      async (
        _e,
        text: string,
        stagedImageIds?: readonly string[],
        rawMentions?: unknown,
        rawPicks?: unknown,
      ) => {
        // The `@` mentions (ADR 0072 amendment 2026-10-20): strings only —
        // the session keeps the ones the text still holds.
        const mentions = Array.isArray(rawMentions)
          ? rawMentions.filter((m): m is string => typeof m === "string")
          : [];
        const picks = pickedElements(rawPicks);
        // Length only — chat content must not land in terminal/log capture
        // (audit 2026-07-13 T1.5; mirrors the repo's memory discipline). The
        // staged COUNT is safe for the same reason a file count is.
        console.log(
          `[herta] submitText invoked (${text.length} chars${
            stagedImageIds !== undefined && stagedImageIds.length > 0
              ? `, ${stagedImageIds.length} image(s)`
              : ""
          })`,
        );
        const active = host?.activeSession ?? null;
        if (active === null) {
          console.warn("[herta] submitText ignored — no active session yet");
          return undefined;
        }
        try {
          const before = active.record.length;
          const result = await active.submitText(text, {
            ...(stagedImageIds !== undefined && stagedImageIds.length > 0
              ? { stagedImageIds }
              : {}),
            ...(mentions.length > 0 ? { mentions } : {}),
            ...(picks.length > 0 ? { picks } : {}),
          });
          if ("needsKey" in result) {
            console.log("[herta] submitText deferred — no DeepSeek key set");
          } else {
            console.log(
              `[herta] submitText turn done: ${result.turnId} (record ${before} → ${active.record.length} blocks)`,
            );
          }
          return result;
        } catch (err) {
          // Surface turn failures in the MAIN-process terminal. Without this
          // the rejection only reaches the renderer's voided invoke (DevTools
          // console), so the user watching the terminal sees nothing.
          console.error("[herta] submitText turn failed:", err);
          throw err;
        }
      },
    );
    handle(CMD.interrupt, (_e, turnId?: string) =>
      host?.activeSession?.interrupt({ turnId }),
    );
    // A message while 板砖 works (ADR 0063). Without a session, or on a
    // session that cannot steer, the honest answer is `queued`: the renderer
    // keeps the text and sends it as the next turn.
    handle(
      CMD.steerText,
      async (_e, text: string, rawPicks?: unknown): Promise<SteerTextResult> =>
        (await host?.activeSession?.steerText?.(
          text,
          pickedElements(rawPicks),
        )) ?? { queued: true },
    );
    // A message to Herta while 板砖 works (ADR 0085 step 3). The same
    // honest `queued` without a session that can take it.
    handle(
      CMD.talkText,
      async (
        _e,
        text: string,
        rawMentions?: unknown,
        rawPicks?: unknown,
      ): Promise<TalkTextResult> => {
        const mentions = Array.isArray(rawMentions)
          ? rawMentions.filter((m): m is string => typeof m === "string")
          : [];
        const picks = pickedElements(rawPicks);
        return (
          (await host?.activeSession?.talkText?.(text, {
            ...(mentions.length > 0 ? { mentions } : {}),
            ...(picks.length > 0 ? { picks } : {}),
          })) ?? { queued: true }
        );
      },
    );
    // 继续 (ADR 0071 §1.4). No session, or one that cannot continue: there
    // is nothing to continue, and the renderer drops its strip.
    handle(
      CMD.continueInterrupted,
      async (): Promise<ContinueInterruptedResult> =>
        (await host?.activeSession?.continueInterrupted?.()) ?? {
          unavailable: true,
        },
    );
    handle(CMD.rewindLastTurn, async (_e, sessionId?: string) => {
      const active = host?.activeSession ?? null;
      // Destructive call, session-bound (same pattern as setWorkspace): the
      // renderer plays a 220ms withdraw animation before invoking, so a
      // session switch can land in the gap — an unbound rewind then truncated
      // the NEWLY-active session's latest turn. Reject the mismatch; the
      // renderer un-fades its rows on the failure.
      if (sessionId === undefined || active?.sessionId !== sessionId) {
        return { ok: false as const, reason: "no_user_turn" as const };
      }
      // rewindLastTurn is optional on the Session interface (only the GUI
      // SessionImpl implements it); a missing impl reports nothing to rewind.
      return (
        (await active?.rewindLastTurn?.()) ?? {
          ok: false as const,
          reason: "no_user_turn" as const,
        }
      );
    });
    handle(CMD.undoLastTurnEdits, (_e, sessionId?: unknown, target?: unknown) =>
      handleUndoLastTurnEdits(
        { activeSession: host?.activeSession ?? null },
        sessionId,
        target,
      ),
    );
    // The new-tab page's launcher (ADR 0083 §4–§5), for the session the
    // window shows.
    const activeFor = (sessionId: unknown) => {
      const active = host?.activeSession ?? null;
      return active !== null && active.sessionId === sessionId ? active : null;
    };
    handle(
      CMD.serversList,
      async (_e, sessionId?: unknown) =>
        (await activeFor(sessionId)?.listServers?.()) ?? {
          ok: false as const,
          reason: "no_launcher" as const,
        },
    );
    handle(
      CMD.serversStart,
      async (_e, sessionId?: unknown, name?: unknown, confirmed?: unknown) =>
        typeof name === "string"
          ? ((await activeFor(sessionId)?.startServer?.(
              name,
              typeof confirmed === "string" ? { confirmed } : {},
            )) ?? { ok: false as const, reason: "no_launcher" as const })
          : { ok: false as const, reason: "no_entry" as const },
    );
    handle(CMD.serversStop, async (_e, sessionId?: unknown, name?: unknown) =>
      typeof name === "string"
        ? ((await activeFor(sessionId)?.stopServer?.(name)) ?? { ok: false })
        : { ok: false },
    );
    handle(CMD.maybePlayEasterEgg, () => {
      // Fire-and-forget GUI flourish: a successful 板砖-card lift may play the
      // easter-egg clip. The session owns the 50% roll + per-session hourly
      // throttle. Optional on the interface (GUI SessionImpl only).
      host?.activeSession?.maybePlayEasterEgg?.();
    });
    // The sidebar's session commands and the record's paging
    // (session-list-ipc.ts).
    registerSessionListHandlers({
      handle,
      host: () => host,
      activation,
      snapshot,
      // The window's page and dev servers for that session (ADR 0083).
      onDeleted: (id) => {
        hooks.browser?.closeSession(id);
        hooks.servers?.closeSession(id);
      },
      win,
    });
    handle(CMD.resolveApproval, (_e, opts) =>
      host?.activeSession?.resolveApproval(opts),
    );
    // Automatic review (ADR 0075, which replaced workspace trust) — the
    // ACTIVE session's effective workspace. No session → a real project,
    // off (the honest default).
    const noReview: AutoReviewState = {
      on: false,
      explicit: null,
      isDefaultWorkspace: false,
    };
    handle(
      CMD.getAutoReview,
      async () => (await host?.activeSession?.getAutoReview?.()) ?? noReview,
    );
    // Only a literal boolean from the window is a choice; null clears it.
    handle(CMD.setAutoReview, async (_e, on: unknown) => {
      const v = typeof on === "boolean" ? on : null;
      return (await host?.activeSession?.setAutoReview?.(v)) ?? noReview;
    });
    // Record heal after a record-channel overflow drop: the session re-emits
    // its live record as a `reset` through the record stream (FIFO with block
    // events → race-free even mid-turn). Fire-and-forget from the renderer.
    handle(CMD.resyncRecord, () => {
      host?.activeSession?.resyncRecord?.();
    });
    // The renderer's store asks for its state once it has subscribed
    // (session-activation.ts `resync`).
    handle(CMD.requestSync, () => {
      activation.resync();
    });
    // The repository card asks for a fresh probe on window focus (ADR
    // 0058); the answer arrives as a `session:repo` event.
    handle(CMD.refreshRepo, async () => {
      await host?.activeSession?.refreshRepo?.();
    });
    handle(CMD.pickWorkspace, async () => {
      const r = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
      });
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
    });
    handle(CMD.setWorkspace, async (_e, sessionId: string, path: string) =>
      handleSetWorkspace(
        { activeSession: host?.activeSession ?? null },
        sessionId,
        path,
        homedir(),
      ),
    );
    // What the composer attaches: documents and staged pictures
    // (attachment-ipc.ts).
    registerAttachmentHandlers({ handle, host: () => host, send, win });
    // The viewer's reads of the workspace and its doors to the OS
    // (workspace-read-ipc.ts).
    registerWorkspaceReadHandlers({ handle, host: () => host });
    handle(CMD.resetWorkspace, async (_e, sessionId: string) => {
      const s = host?.activeSession ?? null;
      if (s === null || s.sessionId !== sessionId) {
        return { ok: false as const, message: "no matching active session" };
      }
      const r = await s.resetWorkspace();
      if (!r.ok) {
        return { ok: false as const, message: "a turn is in progress" };
      }
      return { ok: true as const };
    });
    // Settings → every row (settings-ipc.ts). Registered HERE, inside the
    // synchronous registration, for the same reason as every handler above;
    // the voice rows read and write this service's own flags through the
    // getters and setters below.
    registerSettingsHandlers({
      handle,
      hooks: {
        ...hooks,
        onAttentionChanged: (prefs) => {
          attentionPrefs = prefs;
          hooks.onAttentionChanged?.(prefs);
        },
        onLocaleChanged: () => {
          void refreshUiLocale();
          hooks.onLocaleChanged?.();
        },
      },
      host: () => host,
      workspaceRoot: appWorkspaceRoot,
      dreamRunning: () => dreamRunning,
      voice: voice.settings,
    });
    flow.register(handle);
  }
  registerHandlers();

  // Re-entrant: did-finish-load can fire again on renderer reload. If we're
  // already bootstrapped, just re-sync the renderer with the active session
  // (re-point forwarders + re-send reset). One bootstrap at a time: a reload
  // while the first still waits for PATH re-syncs after it (bootstrap-once).
  const start = bootstrapOnce({
    booted: () => host !== null,
    bootstrap,
    resync: () => {
      const active = host?.activeSession ?? null;
      // Re-sync the reloaded renderer: re-point at the open session if any, else
      // restore the connect screen (the user reloaded while still disconnected).
      if (active !== null) activation.pointAt(active);
      else activation.pointNowhere();
    },
  });

  /** The first start's work: the host, its settings, the connect screen.
   *  Never rejects: a failure is the error panel. */
  async function bootstrap(): Promise<void> {
    // Wrap the WHOLE bootstrap: a missing key (buildConfig) OR a failed
    // createSessionHost/openSession must surface as the error panel via
    // session:reset, not a silent unhandled rejection that leaves the
    // renderer stuck on an empty workbench.
    try {
      // Every child this service starts — the backend's shell, the
      // repository probe, a dev server — inherits PATH at spawn, and none
      // exists before this bootstrap. So it waits here for main's PATH
      // recovery, which the window no longer waits for (review 2026-11-10).
      await hooks.pathReady;
      const workspaceRoot = appWorkspaceRoot();
      // Herta's synthesized voice (voice-stack.ts). Started here — before the
      // host, so every session it creates carries it. The enable flag is
      // seeded from the persisted setting; the Settings handler keeps it
      // current.
      voice.settings.realtimeEnabled =
        (await readGlobalSettings(app.getPath("userData"))).realtimeVoice ??
        true;
      const userDataPath = app.getPath("userData");
      voice.startLocal({ userDataPath, workspaceRoot });
      // The cloud voice takes its engine and clone record from the stored
      // settings; the same read seeds what the attention watcher and Flow
      // read at every event.
      const startupSettings = await readGlobalSettings(userDataPath);
      attentionPrefs = attentionSettingsOf(startupSettings);
      uiLocale = resolveInitialLocale(
        startupSettings,
        osLocale(process.platform, app),
      );
      const speech = voice.startCloud({
        userDataPath,
        workspaceRoot,
        settings: startupSettings,
      });
      const config = await buildConfig(
        workspaceRoot,
        homedir(),
        readDeepSeekKeyPlain(),
        // Packaged builds read the bundled clips; dev reads the workspace.
        resolveVoiceRoot({
          isPackaged: installMode().installed,
          resourcesPath: installMode().resourcesPath,
          workspaceRoot,
        }),
        // Dev-only chaos/staging feed: NEVER honored in a packaged build
        // (T1.3 pattern — an env-settable base URL in production would
        // redirect the API key to an arbitrary host).
        installMode().installed
          ? undefined
          : process.env.HERTA_DEEPSEEK_BASE_URL,
        speech,
      );
      dreamRunning = config.dream?.enabled === true;
      host = createSessionHost({
        ...config,
        // Per-install, beside the settings: each model call's token counts
        // as the API states them, cache hits included — numbers only. The
        // path needs Electron's `app`, so it is set here, not in the pure
        // `buildConfig`.
        usageLogPath: join(userDataPath, "usage.jsonl"),
        // A large view_image picture goes smaller (ADR 0048 amendment
        // 2026-11-20): Electron decodes it, so it is set here too.
        shrinkPicture: shrinkPictureWithNativeImage,
      });
      // The PDF-picture switch (2026-10-01) before any session can attach;
      // Settings mirrors later changes to the host live.
      host.setPdfPictureTranscription(
        pdfPictureTranscriptsEnabled(startupSettings),
      );
      // And the composer-prediction switch (2026-10-10), before any turn.
      host.setComposerPredictions(composerPredictionsEnabled(startupSettings));
      // The window's browser pages (ADR 0083), for 板砖's page steps.
      const browser = hooks.browser;
      host.setBrowserProvider?.(
        browser !== undefined ? (sid) => browser.driverFor(sid) : null,
      );
      // And its dev servers (ADR 0083 §5), journaled for the next launch.
      const servers = hooks.servers;
      servers?.attachJournal(host.serverJournal?.() ?? null);
      host.setServerProvider?.(
        servers !== undefined ? (sid) => servers.forSession(sid) : null,
      );
      // Launch lands on the connect screen (接入黑塔空间站) rather than
      // auto-resuming the latest session: the user explicitly opens one from the
      // sidebar or starts a new one from the connect button (user 2026-06-20).
      // The host IS created so listSessions() still populates the sidebar — we
      // just don't open a session yet, so the renderer shows the disconnected
      // (no-session) state. `pickLatest` is retained (exported, tested) for a
      // future "resume last" affordance.
      console.log("[herta] launch: connect screen (no auto-resume)");
      send(EVT.reset, { noSession: true });
      // Commands a 板砖 run left running when the app last exited are ended
      // now, each only if it is still that process (ADR 0071 §1.6). The index
      // it reads is empty unless a run was cut off, so this costs a file read;
      // the process query it may spawn runs off this thread.
      void host.reapOrphanedProcesses();
      // Flow's clock (ADR 0084 §6): its first tick a minute from now.
      void flow.start().catch(() => undefined);
    } catch (err) {
      console.error("[herta] session bootstrap failed:", err);
      host = null;
      send(EVT.reset, {
        error: errorMessage(err),
      });
    }
  }

  async function dispose(): Promise<void> {
    activation.release();
    if (handlersRegistered) {
      // Exactly the channels registered above — never the whole CMD map,
      // which also names the update / app-version / window-control channels
      // index.ts owns (audit T3.7: disposing a session service used to tear
      // those down with it).
      for (const c of ownedChannels) ipcMain.removeHandler(c);
      ownedChannels.length = 0;
      handlersRegistered = false;
    }
    // Flow's run in flight stops first: it reads the host.
    await flow.dispose().catch(() => undefined);
    await host?.closeActiveSession();
    host?.dispose();
    host = null;
    // The voice worker is a CHILD PROCESS (voice-stack.ts). Disposed after
    // the sessions, so a turn still unwinding can finish its last synthesis
    // request (which resolves null once the worker is gone — the reveal
    // types it).
    voice.dispose();
  }

  return {
    start,
    dispose,
    // Bounded like the sidebar's listing above (audit BL11): the tray shows
    // at most TRAY_SESSION_ROWS sessions, and an unbounded listing ran a stat,
    // a 128KB read and a sidecar open PER session ever created, on this
    // thread, on every right-click (perf audit 2026-09-20). Twice the rows:
    // the host orders by transcript mtime and the menu re-sorts by
    // lastActivityAt, so a little slack keeps the two orders from disagreeing
    // about who is fifteenth.
    listSessions: () =>
      host?.listSessions({ limit: TRAY_SESSION_ROWS * 2 }) ?? [],
    // Tray-initiated navigation carries the SAME guards the renderer's
    // sidebar/top bar enforce (audit 2026-07-10): pre-guard-less, a tray
    // click on the already-open session tore down a running turn (re-open →
    // close → interrupt → double-fired orphan regeneration), and a tray
    // switch/new-chat over a pending approval silently auto-denied the gate
    // via the close-path abort.
    openSessionFromMain: async (id: string): Promise<void> => {
      const block = mainNavigationBlock(host?.activeSession ?? null, id);
      if (block === "turn-in-flight") {
        // Refuse the switch (it would interrupt the running reply) but front
        // the window AND arm the renderer's two-step confirm on the target
        // session (user 2026-07-13: a silent refusal read as a dead tray) —
        // the amber badge explains why nothing switched, and a follow-up
        // click in the sidebar confirms for real.
        win.show();
        win.focus();
        win.webContents.send(EVT.navBlocked, { target: id });
        return;
      }
      if (block !== null) return;
      await openAndPoint(id);
    },
    createSessionFromMain: async (): Promise<void> => {
      const block = mainNavigationBlock(host?.activeSession ?? null);
      if (block === "turn-in-flight") {
        win.show();
        win.focus();
        win.webContents.send(EVT.navBlocked, { target: null });
        return;
      }
      if (block !== null) return;
      await createAndPoint({});
    },
    backendWorkspace: (): string | null =>
      host?.activeSession?.backendWorkspace ?? null,
  };
}

/**
 * Guard for MAIN-initiated navigation (the tray menu): mirrors the renderer's
 * guards — `SessionItem.open` refuses `isActive || gatePending` and arms a
 * two-step confirm mid-turn, the top-bar new-chat disables on `gatePending`
 * and arms mid-turn — which the tray path bypassed entirely (audit
 * 2026-07-10; turn-in-flight added 2026-07-12). Returns the block reason, or
 * null when navigation may proceed. Exported for testing.
 */
export function mainNavigationBlock(
  active: {
    sessionId: string;
    overlay: unknown;
    turnInFlight?: boolean;
  } | null,
  targetId?: string,
): "gate-pending" | "already-active" | "turn-in-flight" | null {
  if (active === null) return null;
  // A pending approval gate suppresses ALL navigation: switching or creating
  // closes the active session, whose abort resolves the un-answered request
  // as a silent "deny".
  if (active.overlay !== null && active.overlay !== undefined) {
    return "gate-pending";
  }
  // Re-opening the active session is never useful and actively harmful
  // mid-turn (teardown + re-point + orphan regeneration).
  if (targetId !== undefined && targetId === active.sessionId) {
    return "already-active";
  }
  // Navigating away mid-turn closes the active session, which INTERRUPTS
  // Herta's reply (and any running 板砖 task). The sidebar/top-bar get a
  // two-step confirm; a tray menu can't, so it refuses — the caller fronts
  // the window instead, where the user sees the running turn and decides.
  if (active.turnInFlight === true) {
    return "turn-in-flight";
  }
  return null;
}

/** Elements picked on the page, as the renderer sent them (ADR 0083 §4):
 *  objects with a string line, element and route, nothing else kept. The
 *  session keeps the ones its text still holds. */
function pickedElements(raw: unknown): PickedElement[] {
  if (!Array.isArray(raw)) return [];
  const out: PickedElement[] = [];
  for (const p of raw.slice(0, 20)) {
    if (typeof p !== "object" || p === null) continue;
    const { line, element, route } = p as Record<string, unknown>;
    if (
      typeof line === "string" &&
      typeof element === "string" &&
      typeof route === "string" &&
      line.length > 0
    )
      out.push({ line, element, route });
  }
  return out;
}
