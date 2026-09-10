import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AppServerConfig,
  createSessionHost,
  defaultDirsFor,
  type LogQuery,
  recordTail,
  type Session,
  type SessionHost,
  type SessionMetadata,
  type SpeechSynthesizer,
} from "@herta/app-server";
import { SessionFileError } from "@herta/core";
import { validateDeepSeekKey } from "@herta/providers";
import {
  canonicalWorkspaceRoot,
  findBash,
  isSafeRefName,
  MAX_LOG_LIMIT,
  MAX_LOG_QUERY_CHARS,
  validateWorkspaceRoot,
} from "@herta/tools";
import {
  app,
  type BrowserWindow,
  dialog,
  ipcMain,
  net,
  shell,
  type WebContents,
} from "electron";
import { CMD, EVT } from "../preload/channels.js";
import type {
  InteractionLanguageChoice,
  RealtimeVoiceState,
  SessionOpenFailure,
  SessionSnapshot,
} from "../renderer/ipc/bridge-types.js";
import { DEVICE_SCENE_DEFAULT } from "../shared/device-scene.js";
import type { VoiceEngine } from "./app-global-settings.js";
import {
  type InteractionLang,
  type Locale,
  readGlobalSettings,
  resolveInitialLocale,
  resolveInteractionLang,
  type ThemePref,
  updateGlobalSettings,
} from "./app-global-settings.js";
import {
  isBackendContract,
  isBackendThinking,
  isModelChoice,
  normalizeModelChoice,
  readAppSettings,
  writeAppSettings,
} from "./app-settings.js";
import {
  clearDeepSeekKey,
  clearMiniMaxKey,
  clearMiniMaxPlanKey,
  getDeepSeekKeyStatus,
  getMiniMaxKeyStatus,
  getMiniMaxPlanKeyStatus,
  readDeepSeekKeyPlain,
  readMiniMaxKeyPlain,
  readMiniMaxPlanKeyPlain,
  setDeepSeekKey,
  setMiniMaxKey,
  setMiniMaxPlanKey,
} from "./key-store.js";
import {
  readWorkspaceBytesBounded,
  readWorkspaceFileBounded,
  resolveInsideWorkspace,
} from "./read-workspace-file.js";
import { createFallbackFetch } from "./tts/fallback-fetch.js";
import {
  MINIMAX_CONTROL_TIMEOUT_MS,
  MiniMaxError,
  probeHost,
} from "./tts/minimax-api.js";
import {
  createMiniMaxSynthesizer,
  type MiniMaxSynthesizer,
} from "./tts/minimax-synthesizer.js";
import {
  createMiniMaxVoiceService,
  type MiniMaxVoiceService,
} from "./tts/minimax-voice.js";
import { createSwitchingSynthesizer } from "./tts/switching-synthesizer.js";
import {
  createTtsSynthesizer,
  resolveSherpaEntry,
  type TtsSynthesizer,
} from "./tts/synthesizer.js";
import {
  resolveTtsModelRoots,
  resolveVoiceCloneReference,
  TTS_BUNDLE_ID,
  TTS_EFFECT,
  voiceModelStoreRoot,
} from "./tts/tts-path.js";
import {
  TTS_ARCHIVE_BYTES,
  TTS_ARCHIVE_SHA256,
  TTS_ARCHIVE_URL,
  TTS_ARCHIVE_URL_ENV,
  TTS_BUNDLE_BYTES,
} from "./tts/tts-release.js";
import {
  createVoiceModelService,
  type VoiceModelService,
} from "./tts/voice-model.js";
import { resolveVoiceRoot } from "./voice-path.js";

type Send = (channel: string, payload: unknown) => void;

/**
 * The history tab's query as the IPC door accepts it (ADR 0059 §6):
 * integer paging, a branch-shaped `ref` (the same rule the reader
 * applies, so a refused shape never reaches a spawn), a bounded `query`.
 * Null for anything else. Exported for tests.
 */
export function sanitizeLogQuery(raw: unknown): LogQuery | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const skip = r.skip;
  const limit = r.limit;
  if (
    typeof skip !== "number" ||
    !Number.isInteger(skip) ||
    skip < 0 ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit <= 0 ||
    limit > MAX_LOG_LIMIT
  ) {
    return null;
  }
  const out: { skip: number; limit: number; ref?: string; query?: string } = {
    skip,
    limit,
  };
  if (r.ref !== undefined) {
    if (typeof r.ref !== "string" || !isSafeRefName(r.ref)) return null;
    out.ref = r.ref;
  }
  if (r.query !== undefined) {
    if (typeof r.query !== "string") return null;
    const q = r.query.trim();
    if (q.length > MAX_LOG_QUERY_CHARS) return null;
    if (q.length > 0) out.query = q;
  }
  return out;
}

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

/** `resolveWorkspaceRoot` with THIS process's packaged-ness applied — the
 *  thin electron-aware wrapper (the pure fn stays unit-testable). */
export function appWorkspaceRoot(): string {
  return resolveWorkspaceRoot(
    app.isPackaged ? app.getPath("userData") : undefined,
  );
}

/** How many sessions the sidebar listing returns (audit BL11). Newest-first,
 *  so this is a recency window, not a truncation the user notices — search
 *  still reaches every transcript on disk. */
const SIDEBAR_LIST_LIMIT = 200;

export async function buildConfig(
  cwd: string,
  home: string,
  // Plaintext key from the secure store (`key-store.readDeepSeekKeyPlain`),
  // read by the caller because the store needs Electron `app`/`safeStorage`
  // (kept out of this pure, unit-tested fn). Null when none is stored.
  secureKey: string | null = null,
  // Packaged-aware voice root override (resolveVoiceRoot), injected by the
  // caller for the same purity reason as the key: `app.isPackaged` /
  // `process.resourcesPath` need Electron. Absent → defaultDirsFor's dev
  // layout (<cwd>/data/voice) stands.
  voiceAssetsDir?: string,
  // Dev-only DeepSeek base-URL override (chaos/staging proxy). The CALLER
  // gates this on `!app.isPackaged` before passing (same credential-safety
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
  const backendThinking = settings.backend?.thinking;
  return {
    workspaceRoot: cwd,
    ...dirs,
    ...(voiceAssetsDir !== undefined ? { voiceAssetsDir } : {}),
    ...(speechSynthesizer !== undefined
      ? { speech: { synthesizer: speechSynthesizer } }
      : {}),
    dream: { enabled: settings.dream?.enabled ?? true },
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
      actorModel:
        process.env.HERTA_ACTOR_MODEL ??
        normalizeModelChoice(settings.models?.actor) ??
        "deepseek-v4-pro",
      backendModel:
        process.env.HERTA_BACKEND_MODEL ??
        normalizeModelChoice(settings.models?.backend) ??
        "deepseek-flash",
      routerModel: "deepseek-flash",
      ...(devBaseUrl !== undefined && devBaseUrl !== ""
        ? { baseUrl: devBaseUrl }
        : {}),
    },
    // Backend reasoning effort (Settings → Coprocessor, restart-to-apply like
    // dream above — this read at bootstrap IS the apply path). Default "high".
    // isBackendThinking guards a hand-edited settings.json: an off-enum value
    // falls back to the default instead of reaching the API.
    thinking: isBackendThinking(backendThinking) ? backendThinking : "high",
    // 板砖's tool contract (ADR 0040): env (dev/lab knob) > Settings →
    // 差分协处理器 → 工具契约 > MINIMAL (owner default flip 2026-08-17,
    // after the permission lab + card fixes — ~½ prompt tokens, ~⅒
    // cache-miss, same outcomes). Session.create verifies a bash exists
    // before honoring `minimal` and falls back to standard otherwise.
    backendContract:
      process.env.HERTA_BACKEND_CONTRACT === "minimal" ||
      process.env.HERTA_BACKEND_CONTRACT === "standard"
        ? process.env.HERTA_BACKEND_CONTRACT
        : isBackendContract(settings.backend?.contract)
          ? settings.backend.contract
          : "minimal",
  };
}

function snapshot(s: Session): SessionSnapshot {
  // Long-session windowing (2026-07-12): the reset snapshot carries only the
  // trailing RECORD_TAIL_BLOCKS window — a 10MB session no longer crosses IPC
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

/** Pipes a session's 8 subscriptions to `send`. Returns a stop fn. Exported for testing. */
export function startForwarders(session: Session, send: Send): () => void {
  let live = true;
  // Every started iterator, so stop() can CLOSE them. The old stop only
  // flipped `live`, which a pump checks after its NEXT event — a
  // switched-away session that never emits again left all 8 pumps (and
  // their subscription buffers + this `send` closure) parked in `it.next()`
  // forever, accumulating per session switch.
  const iterators: AsyncIterator<unknown>[] = [];
  async function pump<T>(it: AsyncIterable<T>, channel: string): Promise<void> {
    const iterator = it[Symbol.asyncIterator]();
    iterators.push(iterator);
    while (true) {
      const r = await iterator.next();
      if (r.done === true || !live) break;
      send(channel, r.value);
    }
  }
  void pump(session.subscribeRecord(), EVT.record);
  void pump(session.subscribeOverlay(), EVT.overlay);
  void pump(session.subscribeSpeech(), EVT.speech);
  void pump(session.subscribeAgentEvents(), EVT.agent);
  void pump(session.subscribeTurnLifecycle(), EVT.turn);
  void pump(session.subscribeTitle(), EVT.title);
  void pump(session.subscribeWorkspace(), EVT.workspace);
  void pump(session.subscribeVoice(), EVT.voice);
  // The repository card's stream (ADR 0058); optional on the interface.
  if (session.subscribeRepo !== undefined) {
    void pump(session.subscribeRepo(), EVT.repo);
  }
  return () => {
    live = false;
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

/** Session ids are host-minted UUIDs the renderer only echoes back, but they
 *  feed path joins (`<transcriptDir>/<id>.jsonl`, managed workspace dirs) on
 *  the other side of the IPC boundary — a compromised renderer must not turn
 *  them into a traversal (audit 2026-07-13 T1.2). Charset allowlist rather
 *  than a strict UUID shape so any legacy transcript stem keeps opening;
 *  every separator/drive/dot shape is rejected. Exported for testing. */
export function isSafeSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** IPC-boundary validation for CMD.create (audit 2026-07-13 T1.2): the
 *  renderer only ever sends `{}`, but `backendWorkspace` roots the silent
 *  板砖 backend and `workspaceRoot` roots the session — an unchecked
 *  override would bypass the D4 guard CMD.setWorkspace enforces via
 *  validateWorkspaceRoot. Returns the validated (resolved) opts, or null
 *  when a supplied override fails validation. Exported for testing. */
export function sanitizeCreateOpts(
  opts: unknown,
  home: string,
): { workspaceRoot?: string; backendWorkspace?: string } | null {
  if (opts === undefined || opts === null) return {};
  if (typeof opts !== "object") return null;
  const { workspaceRoot, backendWorkspace } = opts as {
    workspaceRoot?: unknown;
    backendWorkspace?: unknown;
  };
  const out: { workspaceRoot?: string; backendWorkspace?: string } = {};
  if (workspaceRoot !== undefined) {
    if (typeof workspaceRoot !== "string") return null;
    const r = validateWorkspaceRoot(workspaceRoot, { home });
    if (!r.ok) return null;
    out.workspaceRoot = r.resolved;
  }
  if (backendWorkspace !== undefined) {
    if (typeof backendWorkspace !== "string") return null;
    const r = validateWorkspaceRoot(backendWorkspace, { home });
    if (!r.ok) return null;
    out.backendWorkspace = r.resolved;
  }
  return out;
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

export interface SessionServiceHooks {
  /** Fired after Settings → Language persists a new locale. Lets main-side
   *  surfaces that render OUTSIDE the renderer (the tray hover tooltip —
   *  drawn by the OS, so no React re-render reaches it) re-resolve their
   *  strings immediately instead of showing the old language until restart. */
  readonly onLocaleChanged?: () => void;
  /** Fired after Settings → Window persists the close-to-tray flag. The
   *  window close handler lives in main's index.ts — this hook updates its
   *  cached flag so the change applies to the very next close click. */
  readonly onCloseToTrayChanged?: (enabled: boolean) => void;
  /** Fired after Settings → Update persists the automatic-update toggle.
   *  The update service lives in main's index.ts — this hook live-applies
   *  it (cancelling or restarting the check cycle). */
  readonly onAutoUpdateChanged?: (enabled: boolean) => void;
  /** Fired after Settings → Window persists the appearance preference
   *  (night mode). index.ts retints the NATIVE window backgroundColor —
   *  the surface that shows for a beat on cold launch and during resizes,
   *  which the renderer's CSS can't cover. */
  readonly onThemeChanged?: (theme: ThemePref) => void;
}

/** Wires the SessionHost + ipcMain handlers to a single window's webContents.
 *  Single-window assumption for Slice 4. */
export function createSessionService(
  wc: WebContents,
  win: BrowserWindow,
  hooks: SessionServiceHooks = {},
): SessionService {
  let host: SessionHost | null = null;
  let stopForwarders: (() => void) | null = null;
  let handlersRegistered = false;
  // Herta's synthesized voice (ADR 0042). Built once at bootstrap and shared
  // by every session; the enable flag is cached here so `available()` — read
  // at every speech stream's start — never touches disk, and the Settings
  // toggle applies to the very next reply.
  let synthesizer: TtsSynthesizer | null = null;
  let realtimeVoiceEnabled = true;
  // The model as a download (ADR 0061): built beside the synthesizer, it
  // owns the bundle directory under userData and tells the synthesizer to
  // re-probe when a download lands or the bundle is removed.
  let voiceModel: VoiceModelService | null = null;
  // The cloud voice (ADR 0062): which engine speaks (cached from settings,
  // read at every stream's start), the MiniMax synthesizer and the clone it
  // uses. The key itself stays in the secure store and is read per call.
  let voiceEngine: VoiceEngine = "local";
  let minimaxSynth: MiniMaxSynthesizer | null = null;
  let minimaxVoice: MiniMaxVoiceService | null = null;
  // The cloud voice's network path (ADR 0062 §1.4, amended): Chromium's
  // proxy-aware `net.fetch` first — the same stack the DeepSeek calls use —
  // and Node's `fetch` only when Chromium could not connect at all. On the
  // owner's second machine Chromium reached DeepSeek but failed the TLS
  // handshake to both MiniMax hosts; a second stack is the only lever the
  // app has there. Called after `whenReady` only (the handlers and the
  // services are wired inside `start`).
  const minimaxFetch = createFallbackFetch(
    [(url, init) => net.fetch(url, init), (url, init) => fetch(url, init)],
    (line) => console.log(line),
  );
  /** Either MiniMax key is enough to try for a voice: the pay-as-you-go
   *  one clones, the plan one can adopt (ADR 0062 §1.8). */
  const anyMiniMaxKey = (): boolean =>
    readMiniMaxKeyPlain() !== null || readMiniMaxPlanKeyPlain() !== null;
  const send: Send = (ch, payload) => {
    if (!wc.isDestroyed()) wc.send(ch, payload);
  };

  function pointAt(session: Session): void {
    stopForwarders?.();
    stopForwarders = startForwarders(session, send);
    send(EVT.reset, snapshot(session));
  }

  // Interaction language (slice 4): resolved FRESH here per activation (like
  // getTheme reads per call) — stored choice, else follow the UI locale.
  // Threaded into the host so the session builds its static prefix, openings,
  // driver, recap, and title in this language. On CREATE this is the session's
  // birth language and the host persists it into the header. On OPEN the host
  // prefers the persisted header language and uses this value only as the
  // fallback for legacy sessions written before per-session persistence — so a
  // global EN/CN toggle changes NEW sessions without retro-flipping old ones.
  async function currentInteractionLang(): Promise<InteractionLang> {
    const s = await readGlobalSettings(app.getPath("userData"));
    return resolveInteractionLang(s, resolveInitialLocale(s, app.getLocale()));
  }

  // Last-CLICK-wins activation ordering, shared by the renderer's IPC
  // handlers AND the tray menu. Activations run concurrently, and each used
  // to pointAt whatever it resolved — so clicking session A (slow disk load)
  // then session B (fast) landed the UI on A when A's open resolved LAST.
  // Only the newest activation may point the renderer; a superseded one
  // still resolves its snapshot (harmless) but never re-points.
  let activationSeq = 0;

  async function openAndPoint(
    id: string,
  ): Promise<Session | SessionOpenFailure | null> {
    const my = ++activationSeq;
    let s: Session | undefined;
    try {
      s = await host?.openSession({
        sessionId: id,
        lang: await currentInteractionLang(),
      });
    } catch (err) {
      // The host validates the session file BEFORE swapping sessions, so a
      // failed open leaves the previously-active session pointed and the app
      // fully usable. Report a structured failure instead of letting the
      // renderer's invoke reject with no user-facing surface.
      console.error(`[herta] openSession(${id}) failed:`, err);
      return {
        openError:
          err instanceof SessionFileError
            ? {
                code: err.code,
                ...(err.line !== undefined ? { line: err.line } : {}),
              }
            : { code: "unknown" },
      };
    }
    if (s !== undefined && my === activationSeq) {
      pointAt(s);
      // D2: if last session's reply was lost to a mid-stream app-close, this
      // session ends on an orphaned user message — regenerate the reply now
      // (fire-and-forget; no-op when it ends on a Herta reply). Fired AFTER
      // pointAt so the renderer is subscribed before the reply streams.
      void s.regenerateLastReplyIfOrphaned?.();
    }
    return s ?? null;
  }

  async function createAndPoint(
    opts: Parameters<SessionHost["createSession"]>[0],
  ): Promise<Session | null> {
    const my = ++activationSeq;
    const s = await host?.createSession({
      ...(opts ?? {}),
      // Main-resolved, never renderer-supplied (sanitizeCreateOpts drops any
      // renderer value): the per-user setting is the single source of truth.
      lang: await currentInteractionLang(),
    });
    if (s !== undefined && my === activationSeq) {
      pointAt(s);
      // D3: stream the opening seed in like a reply (fire-and-forget; no-op
      // when there is no opening). Fired AFTER pointAt so the renderer is
      // subscribed before the seed streams.
      void s.playOpening?.();
    }
    return s ?? null;
  }

  // Channels THIS service registered — dispose() removes exactly these
  // (audit T3.7): the old sweep removed every channel in the CMD map,
  // tearing down the update / app-version / window-control handlers that
  // index.ts owns whenever a session service was disposed.
  const ownedChannels: string[] = [];
  const handle: typeof ipcMain.handle = (channel, listener) => {
    ipcMain.handle(channel, listener);
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
      async (_e, text: string, stagedImageIds?: readonly string[]) => {
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
          const result = await active.submitText(
            text,
            stagedImageIds !== undefined && stagedImageIds.length > 0
              ? { stagedImageIds }
              : {},
          );
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
    handle(CMD.maybePlayEasterEgg, () => {
      // Fire-and-forget GUI flourish: a successful 板砖-card lift may play the
      // easter-egg clip. The session owns the 50% roll + per-session hourly
      // throttle. Optional on the interface (GUI SessionImpl only).
      host?.activeSession?.maybePlayEasterEgg?.();
    });
    // Bounded at the IPC boundary (audit BL11). Unbounded, every sidebar
    // refresh ran a full synchronous listing — statSync, a 128KB read and a
    // sidecar open PER session — on the Electron main thread, and then handed
    // the renderer one DOM row per session ever created, with no windowing.
    // One number bounds both the main-thread scan and the row count; the
    // dream trigger's own internal listSessions() calls are untouched, since
    // they genuinely need every session.
    handle(
      CMD.list,
      () => host?.listSessions({ limit: SIDEBAR_LIST_LIMIT }) ?? [],
    );
    // Transcript content search (sidebar). Bounded + best-effort in the
    // host; the renderer debounces keystrokes. Async since 2026-09-03: the
    // scan reads off the event loop chunk by chunk (a 50 MB transcript set
    // used to hold this thread ~0.5 s per keystroke), and a query that
    // extends the previous one reads only its hits.
    handle(CMD.search, (_e, query: string) =>
      typeof query === "string" ? (host?.searchSessions(query) ?? []) : [],
    );
    // Long-session windowing: page OLDER record blocks into the renderer's
    // window. `before` is the absolute index the renderer's window currently
    // starts at; the slice returns up to `count` blocks ending there, with
    // the absolute index it starts at. Session-bound like every stateful
    // command; a mismatch (switch racing the invoke) returns an empty slice
    // the store drops by its own staleness guard anyway.
    handle(
      CMD.recordSlice,
      (_e, sessionId: string, before: number, count: number) => {
        const active = host?.activeSession ?? null;
        if (
          active === null ||
          active.sessionId !== sessionId ||
          !Number.isInteger(before) ||
          !Number.isInteger(count) ||
          before <= 0 ||
          count <= 0
        ) {
          return { start: 0, blocks: [] };
        }
        const record = active.record;
        const end = Math.min(before, record.length);
        const start = Math.max(0, end - Math.min(count, 500));
        return { start, blocks: record.slice(start, end) };
      },
    );
    handle(CMD.open, async (_e, id: string) => {
      // Id shape gate BEFORE the transcript-path join in the host (audit
      // 2026-07-13 T1.2): a traversal id must never reach readSessionFile.
      if (!isSafeSessionId(id)) return null;
      const s = await openAndPoint(id);
      if (s === null) return null;
      if ("openError" in s) return s;
      return snapshot(s);
    });
    handle(CMD.create, async (_e, opts) => {
      const checked = sanitizeCreateOpts(opts, homedir());
      if (checked === null) return null;
      const s = await createAndPoint(checked);
      return s !== null ? snapshot(s) : null;
    });
    handle(CMD.deleteSession, async (_e, id: string) => {
      // Same id gate as CMD.open — deleteSession feeds rmSync path joins.
      if (!isSafeSessionId(id)) return { ok: false, wasActive: false };
      const r = await host?.deleteSession(id);
      if (r === undefined) return { ok: false, wasActive: false };
      // If we deleted the OPEN session, the host already closed it — tear down
      // its forwarders so no stale events reach the (now blank) renderer.
      if (r.wasActive) {
        stopForwarders?.();
        stopForwarders = null;
      }
      send(EVT.sessionDeleted, { sessionId: id });
      return r;
    });
    handle(CMD.resolveApproval, (_e, opts) =>
      host?.activeSession?.resolveApproval(opts),
    );
    // Project command allow rules (ADR 0030) — scoped to the ACTIVE session's
    // effective workspace. No session → empty list / no-op remove.
    handle(
      CMD.listCommandRules,
      async () => (await host?.activeSession?.listCommandRules?.()) ?? [],
    );
    handle(CMD.removeCommandRule, async (_e, display: string) => {
      if (typeof display !== "string" || display.length === 0) return false;
      return (await host?.activeSession?.removeCommandRule?.(display)) ?? false;
    });
    // Record heal after a record-channel overflow drop: the session re-emits
    // its live record as a `reset` through the record stream (FIFO with block
    // events → race-free even mid-turn). Fire-and-forget from the renderer.
    handle(CMD.resyncRecord, () => {
      host?.activeSession?.resyncRecord?.();
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
    handle(CMD.pickAttachments, async () => {
      const r = await dialog.showOpenDialog(win, {
        properties: ["openFile", "multiSelections"],
      });
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths;
    });
    handle(
      CMD.attachFiles,
      async (_e, sessionId: string, paths: readonly string[]) => {
        const s = host?.activeSession ?? null;
        if (s === null || s.sessionId !== sessionId) {
          return { ok: false as const, message: "no matching active session" };
        }
        if (s.attachFiles === undefined) {
          return { ok: false as const, message: "attachments unavailable" };
        }
        const r = await s.attachFiles(paths);
        if (r.ok) return { ok: true as const };
        // Each refusal gets its own words: "a turn is in progress" is a
        // retry-in-a-moment, "too many files" is a do-something-different.
        return {
          ok: false as const,
          message:
            r.reason === "turn_in_progress"
              ? "a turn is in progress"
              : r.reason === "too_many"
                ? "too many files at once"
                : "no files",
        };
      },
    );
    handle(
      CMD.stageImages,
      async (
        _e,
        sessionId: string,
        inputs: readonly {
          readonly path?: string;
          readonly bytes?: Uint8Array;
          readonly name?: string;
        }[],
      ) => {
        const s = host?.activeSession ?? null;
        if (s === null || s.sessionId !== sessionId) {
          return { ok: false as const, message: "no matching active session" };
        }
        if (s.stageImages === undefined) {
          return { ok: false as const, message: "attachments unavailable" };
        }
        const r = await s.stageImages(inputs);
        if (r.ok)
          return { ok: true as const, staged: r.staged, rejected: r.rejected };
        return {
          ok: false as const,
          message:
            r.reason === "turn_in_progress"
              ? "a turn is in progress"
              : r.reason === "too_many_images"
                ? "five images per message"
                : "no files",
        };
      },
    );
    handle(CMD.unstageImage, async (_e, sessionId: string, id: string) => {
      const s = host?.activeSession ?? null;
      if (s === null || s.sessionId !== sessionId) return false;
      return (await s.unstageImage?.(id)) ?? false;
    });
    // The file-viewer panel (ADR 0050): a bounded read jailed to the
    // session's EFFECTIVE backend workspace — the tree the record's file
    // names actually live in. Session-bound like every other command.
    handle(
      CMD.readWorkspaceFile,
      async (_e, sessionId: string, path: string) => {
        const s = host?.activeSession ?? null;
        if (s === null || s.sessionId !== sessionId) {
          return { ok: false as const, reason: "no_session" as const };
        }
        return readWorkspaceFileBounded(s.backendWorkspace, path);
      },
    );
    // The rich kinds' read (ADR 0054 §2): the whole file as bytes for the
    // renderers that parse it themselves — same jail, 64 MB ceiling.
    handle(
      CMD.readWorkspaceBytes,
      async (_e, sessionId: string, path: string) => {
        const s = host?.activeSession ?? null;
        if (s === null || s.sessionId !== sessionId) {
          return { ok: false as const, reason: "no_session" as const };
        }
        return readWorkspaceBytesBounded(s.backendWorkspace, path);
      },
    );
    // The viewer's commit tab (ADR 0059): one commit of the session's
    // repository, read by the session against its effective workspace.
    // The id is checked here too — a hex commit id and nothing else ever
    // reaches a git argv (the session's reader checks again).
    handle(
      CMD.readWorkspaceCommit,
      async (_e, sessionId: string, ref: string) => {
        const s = host?.activeSession ?? null;
        if (s === null || s.sessionId !== sessionId) {
          return { ok: false as const, reason: "no_session" as const };
        }
        if (typeof ref !== "string" || !/^[0-9a-f]{4,64}$/.test(ref)) {
          return { ok: false as const, reason: "not_found" as const };
        }
        const commit = (await s.describeCommit?.(ref)) ?? null;
        return commit === null
          ? { ok: false as const, reason: "not_found" as const }
          : { ok: true as const, commit };
      },
    );
    // The viewer's diff tab (ADR 0059 §5): one path's working-tree change
    // against HEAD. The SAME jail as the file reads decides the path —
    // the session's reader diffs an untracked file against /dev/null, so
    // an outside-resolving name must never reach it. A tracked file
    // deleted from the tree has no inode and still has a diff: `missing`
    // passes its in-workspace spelling through.
    handle(
      CMD.readWorkspaceDiff,
      async (_e, sessionId: string, path: string) => {
        const s = host?.activeSession ?? null;
        if (s === null || s.sessionId !== sessionId) {
          return { ok: false as const, reason: "no_session" as const };
        }
        const r = await resolveInsideWorkspace(s.backendWorkspace, path);
        if (r.kind === "outside") {
          return { ok: false as const, reason: "outside_workspace" as const };
        }
        const relative = r.kind === "ok" ? r.relative : r.relative;
        if (relative === undefined || relative.length === 0) {
          return { ok: false as const, reason: "not_found" as const };
        }
        const diff = (await s.describeWorkingDiff?.(relative)) ?? null;
        return diff === null
          ? { ok: false as const, reason: "not_found" as const }
          : { ok: true as const, diff };
      },
    );
    // The viewer's log tab (ADR 0059 §6): a page of a ref's history,
    // optionally filtered. Every field is checked at the door — paging
    // numbers are integers, the ref has a branch's shape (the reader
    // checks again and hands git `--end-of-options`), the query is a
    // bounded string — and the reader bounds the limit again.
    handle(
      CMD.readWorkspaceLog,
      async (_e, sessionId: string, raw: unknown) => {
        const s = host?.activeSession ?? null;
        if (s === null || s.sessionId !== sessionId) {
          return { ok: false as const, reason: "no_session" as const };
        }
        const opts = sanitizeLogQuery(raw);
        if (opts === null) {
          return { ok: false as const, reason: "not_found" as const };
        }
        const page = (await s.describeLog?.(opts)) ?? null;
        return page === null
          ? { ok: false as const, reason: "not_found" as const }
          : { ok: true as const, page };
      },
    );
    // The history tab's read-only branch picker (ADR 0059 §6).
    handle(CMD.readWorkspaceBranches, async (_e, sessionId: string) => {
      const s = host?.activeSession ?? null;
      if (s === null || s.sessionId !== sessionId) {
        return { ok: false as const, reason: "no_session" as const };
      }
      const branches = (await s.describeBranches?.()) ?? null;
      return branches === null
        ? { ok: false as const, reason: "not_found" as const }
        : { ok: true as const, branches };
    });
    // The viewer's 打开: hand the jailed path to the OS default app. The
    // same resolution as the read — an outside-resolving name never
    // reaches shell.openPath.
    handle(
      CMD.openWorkspaceFile,
      async (_e, sessionId: string, path: string) => {
        const s = host?.activeSession ?? null;
        if (s === null || s.sessionId !== sessionId) return false;
        const r = await resolveInsideWorkspace(s.backendWorkspace, path);
        if (r.kind !== "ok") return false;
        return (await shell.openPath(r.abs)) === "";
      },
    );
    handle(
      CMD.removeAttachment,
      async (_e, sessionId: string, path: string) => {
        const s = host?.activeSession ?? null;
        if (s === null || s.sessionId !== sessionId) {
          return { ok: false as const, message: "no matching active session" };
        }
        if (s.removeAttachment === undefined) {
          return { ok: false as const, message: "attachments unavailable" };
        }
        const r = await s.removeAttachment(path);
        if (r.ok) return { ok: true as const };
        return {
          ok: false as const,
          message:
            r.reason === "turn_in_progress"
              ? "a turn is in progress"
              : "attachment not found",
        };
      },
    );
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
    // Settings → Dream. Restart-to-apply: read/write the persisted flag; the
    // running app-server is untouched (it reads config.dream at next bootstrap).
    handle(CMD.getDreamConfig, async () => {
      const s = await readAppSettings(appWorkspaceRoot());
      return { enabled: s.dream?.enabled ?? true };
    });
    handle(CMD.setDreamConfig, async (_e, cfg: { enabled: boolean }) => {
      const ws = appWorkspaceRoot();
      const s = await readAppSettings(ws);
      await writeAppSettings(ws, {
        ...s,
        dream: { ...s.dream, enabled: cfg.enabled },
      });
    });
    // Settings → Coprocessor: backend reasoning effort. Restart-to-apply, same
    // contract as Dream above — buildConfig reads it at the next bootstrap.
    handle(CMD.getBackendConfig, async () => {
      const s = await readAppSettings(appWorkspaceRoot());
      const v = s.backend?.thinking;
      const c = s.backend?.contract;
      return {
        thinking: isBackendThinking(v) ? v : "high",
        // ADR 0040: the tool contract, plus whether the minimal one can run
        // here at all — the row says so next to the choice, where the user
        // makes it, instead of a note in the record at the next session.
        // Default MINIMAL (owner 2026-08-17) — must match buildConfig's.
        contract: isBackendContract(c) ? c : "minimal",
        bashFound: findBash() !== null,
      };
    });
    handle(
      CMD.setBackendConfig,
      async (_e, cfg: { thinking?: unknown; contract?: unknown }) => {
        // Validate like setTheme/setLocale: an off-enum value would fail the
        // read-side shape check downstream — refuse it instead of persisting.
        // Each field is optional so the two rows can write independently.
        const thinking = isBackendThinking(cfg?.thinking)
          ? cfg.thinking
          : undefined;
        const contract = isBackendContract(cfg?.contract)
          ? cfg.contract
          : undefined;
        if (thinking === undefined && contract === undefined) return;
        const ws = appWorkspaceRoot();
        const s = await readAppSettings(ws);
        await writeAppSettings(ws, {
          ...s,
          backend: {
            ...s.backend,
            ...(thinking !== undefined ? { thinking } : {}),
            ...(contract !== undefined ? { contract } : {}),
          },
        });
      },
    );
    // Settings → DeepSeek → 模型: per-stage model (2026-08-17). Same
    // restart-to-apply contract; buildConfig reads it at the next bootstrap
    // (an env override, if set, still wins there — it is the dev/lab knob).
    handle(CMD.getModelConfig, async () => {
      const s = await readAppSettings(appWorkspaceRoot());
      return {
        actor: normalizeModelChoice(s.models?.actor) ?? "deepseek-v4-pro",
        // Default `deepseek-flash` (the vision-capable flash, ADR 0048
        // §5a/§5b) — must match buildConfig's, or the pane shows a model
        // the next boot will not use. A legacy name in the file reads as
        // its successor here too, so the pane shows what the boot will run.
        backend: normalizeModelChoice(s.models?.backend) ?? "deepseek-flash",
      };
    });
    handle(
      CMD.setModelConfig,
      async (_e, cfg: { actor?: unknown; backend?: unknown }) => {
        if (!isModelChoice(cfg?.actor) || !isModelChoice(cfg?.backend)) return;
        const ws = appWorkspaceRoot();
        const s = await readAppSettings(ws);
        await writeAppSettings(ws, {
          ...s,
          models: { ...s.models, actor: cfg.actor, backend: cfg.backend },
        });
      },
    );
    // Settings → Language. App-global (per-user) preference; the renderer
    // applies it live, so this is just persistence. getLocale resolves a stored
    // choice, else maps the OS locale.
    handle(CMD.getLocale, async () => {
      const s = await readGlobalSettings(app.getPath("userData"));
      return resolveInitialLocale(s, app.getLocale());
    });
    handle(CMD.setLocale, async (_e, locale: Locale) => {
      // Validate like setTheme: an off-enum value would fail the read-side
      // shape check and silently reset EVERY preference to default.
      if (locale !== "zh" && locale !== "en") return;
      await updateGlobalSettings(app.getPath("userData"), (s) => ({
        ...s,
        locale,
      }));
      // AFTER the write settles: the hook re-reads the persisted settings,
      // so firing early would re-render the tray tooltip from the OLD file.
      hooks.onLocaleChanged?.();
    });
    // Settings → Language: interaction language (slice 4). Returns the STORED
    // choice ("follow" when absent = follow the UI locale); "follow" DELETES
    // the stored field. Applies to NEW sessions (per-session static prefix +
    // prompt cache) — session activation resolves it fresh above.
    handle(CMD.getInteractionLanguage, async () => {
      const s = await readGlobalSettings(app.getPath("userData"));
      return s.interactionLanguage ?? "follow";
    });
    handle(
      CMD.setInteractionLanguage,
      async (_e, choice: InteractionLanguageChoice) => {
        // Validate like setTheme: an off-enum value would fail the read-side
        // shape check and silently reset EVERY preference to default.
        if (choice !== "zh" && choice !== "en" && choice !== "follow") return;
        await updateGlobalSettings(app.getPath("userData"), (s) => {
          if (choice === "follow") {
            const { interactionLanguage: _drop, ...rest } = s;
            return rest;
          }
          return { ...s, interactionLanguage: choice };
        });
      },
    );
    // Settings → Window. Close-to-tray is app-global (per-user) and applies
    // LIVE: the hook updates main's cached close-handler flag immediately.
    handle(CMD.getCloseToTray, async () => {
      const s = await readGlobalSettings(app.getPath("userData"));
      return s.closeToTray ?? true;
    });
    handle(CMD.setCloseToTray, async (_e, enabled: boolean) => {
      await updateGlobalSettings(app.getPath("userData"), (s) => ({
        ...s,
        closeToTray: enabled === true,
      }));
      hooks.onCloseToTrayChanged?.(enabled === true);
    });
    // Settings → Update: automatic checks/downloads. App-global and applied
    // LIVE via the hook (the update service cancels or restarts its cycle).
    handle(CMD.getAutoUpdate, async () => {
      const s = await readGlobalSettings(app.getPath("userData"));
      return s.autoUpdate ?? true;
    });
    handle(CMD.setAutoUpdate, async (_e, enabled: boolean) => {
      await updateGlobalSettings(app.getPath("userData"), (s) => ({
        ...s,
        autoUpdate: enabled === true,
      }));
      hooks.onAutoUpdateChanged?.(enabled === true);
    });
    // Settings → Appearance (night-mode slice 2). The renderer's theme
    // controller applies it live; main just persists (validated on read).
    // Default "system" (user 2026-07-14): a first launch follows the OS
    // appearance; light/dark stay explicit overrides.
    handle(CMD.getTheme, async () => {
      const s = await readGlobalSettings(app.getPath("userData"));
      return s.theme ?? "system";
    });
    handle(CMD.setTheme, async (_e, theme: ThemePref) => {
      if (theme !== "light" && theme !== "dark" && theme !== "system") return;
      await updateGlobalSettings(app.getPath("userData"), (s) => ({
        ...s,
        theme,
      }));
      hooks.onThemeChanged?.(theme);
    });
    // Settings → 差分协处理器 → 3D device card (ADR 0057). The renderer
    // applies it live; main only persists. Absent = the shipped default.
    handle(CMD.getDeviceScene, async () => {
      const s = await readGlobalSettings(app.getPath("userData"));
      return s.deviceScene ?? DEVICE_SCENE_DEFAULT;
    });
    handle(CMD.setDeviceScene, async (_e, enabled: boolean) => {
      await updateGlobalSettings(app.getPath("userData"), (s) => ({
        ...s,
        deviceScene: enabled === true,
      }));
    });
    // Settings → Voice: Herta's real-time synthesized voice (ADR 0042).
    // App-global and applied LIVE — the synthesizer reads the cached flag at
    // every speech stream's start. The read reports the ASSET facts alongside
    // the toggle so the row can explain a silent install rather than claim
    // the voice is on when nothing can speak.
    handle(CMD.getRealtimeVoice, async (): Promise<RealtimeVoiceState> => {
      const s = await readGlobalSettings(app.getPath("userData"));
      const enabled = s.realtimeVoice ?? true;
      realtimeVoiceEnabled = enabled;
      const st = synthesizer?.status();
      return {
        enabled,
        bundle: st?.bundle ?? false,
        runtime: st?.runtime ?? false,
        failed: st?.failed ?? false,
        model: voiceModel?.state() ?? {
          phase: "absent",
          receivedBytes: 0,
          totalBytes: TTS_ARCHIVE_BYTES,
          unpackedBytes: TTS_BUNDLE_BYTES,
        },
        engine: voiceEngine,
        minimax: {
          key: getMiniMaxKeyStatus(),
          planKey: getMiniMaxPlanKeyStatus(),
          voice: minimaxVoice?.state() ?? { phase: "absent" },
        },
      };
    });
    // Settings → Voice → the engine and the cloud voice (ADR 0062).
    handle(CMD.setVoiceEngine, async (_e, engine: VoiceEngine) => {
      const next: VoiceEngine = engine === "minimax" ? "minimax" : "local";
      voiceEngine = next;
      await updateGlobalSettings(app.getPath("userData"), (s) => ({
        ...s,
        voiceEngine: next,
      }));
      // The clone is machinery, not a step (owner 2026-09-08): choosing
      // the cloud with a key in the store makes (or adopts) it now, unasked.
      if (next === "minimax" && anyMiniMaxKey()) {
        void minimaxVoice?.prepare();
      }
    });
    handle(CMD.getMiniMaxKeyStatus, async () => getMiniMaxKeyStatus());
    // A key is checked against the platform before it is stored — a key
    // neither host accepts is refused, like a DeepSeek key that fails its
    // auth check. A network failure stores it unverified — and a platform
    // that never answers is one (the deadline; the save must not spin for
    // the rest of the session).
    const checkKey = async (
      key: string,
    ): Promise<{ trimmed: string; unverified: boolean } | null> => {
      const trimmed = typeof key === "string" ? key.trim() : "";
      if (trimmed.length === 0) return null;
      try {
        await probeHost(
          minimaxFetch,
          trimmed,
          undefined,
          undefined,
          MINIMAX_CONTROL_TIMEOUT_MS,
        );
        return { trimmed, unverified: false };
      } catch (err) {
        if (err instanceof MiniMaxError && err.reason === "invalid_key") {
          return null;
        }
        return { trimmed, unverified: true };
      }
    };
    handle(CMD.setMiniMaxKey, async (_e, key: string) => {
      const checked = await checkKey(key);
      if (checked === null) {
        return { ok: false as const, reason: "rejected" as const };
      }
      // The same key saved again keeps the clone (a fresh one would be a
      // fresh first-use fee, ADR 0062 §1.8); a different key may be another
      // account — forget the clone the old one owned, and make or adopt one
      // now if the cloud engine is chosen.
      const unchanged = readMiniMaxKeyPlain() === checked.trimmed;
      const { encrypted } = setMiniMaxKey(checked.trimmed);
      const svc = minimaxVoice;
      if (svc !== null) {
        if (unchanged) {
          if (voiceEngine === "minimax" && svc.voice() === null) {
            void svc.prepare();
          }
        } else {
          void svc.reset().then(() => {
            if (voiceEngine === "minimax") return svc.prepare();
            return undefined;
          });
        }
      }
      return {
        ok: true as const,
        encrypted,
        unverified: checked.unverified,
        status: getMiniMaxKeyStatus(),
      };
    });
    handle(CMD.clearMiniMaxKey, async () => {
      clearMiniMaxKey();
      return { ok: true as const, status: getMiniMaxKeyStatus() };
    });
    // The token-plan key (ADR 0062 §1.8): speaks under the plan, cannot
    // clone. Saving it does not touch the clone; with the cloud chosen and
    // no clone yet it starts a prepare, which may adopt one the account
    // already paid for.
    handle(CMD.getMiniMaxPlanKeyStatus, async () => getMiniMaxPlanKeyStatus());
    handle(CMD.setMiniMaxPlanKey, async (_e, key: string) => {
      const checked = await checkKey(key);
      if (checked === null) {
        return { ok: false as const, reason: "rejected" as const };
      }
      const { encrypted } = setMiniMaxPlanKey(checked.trimmed);
      const svc = minimaxVoice;
      if (svc !== null && voiceEngine === "minimax" && svc.voice() === null) {
        void svc.prepare();
      }
      return {
        ok: true as const,
        encrypted,
        unverified: checked.unverified,
        status: getMiniMaxPlanKeyStatus(),
      };
    });
    handle(CMD.clearMiniMaxPlanKey, async () => {
      clearMiniMaxPlanKey();
      return { ok: true as const, status: getMiniMaxPlanKeyStatus() };
    });
    handle(CMD.prepareMiniMaxVoice, async () => {
      if (minimaxVoice === null) throw new Error("cloud voice not up");
      return minimaxVoice.prepare();
    });
    handle(CMD.resetMiniMaxVoice, async () => {
      if (minimaxVoice === null) throw new Error("cloud voice not up");
      return minimaxVoice.reset();
    });
    handle(CMD.setRealtimeVoice, async (_e, enabled: boolean) => {
      const next = enabled === true;
      realtimeVoiceEnabled = next;
      await updateGlobalSettings(app.getPath("userData"), (s) => ({
        ...s,
        realtimeVoice: next,
      }));
    });
    // Settings → Voice → the model row (ADR 0061). Download resolves with
    // the state the download ENDED in; progress rides EVT.voiceModel.
    handle(CMD.downloadVoiceModel, async () => {
      if (voiceModel === null) throw new Error("voice model service not up");
      return voiceModel.download();
    });
    handle(CMD.cancelVoiceModelDownload, async () => {
      voiceModel?.cancel();
    });
    handle(CMD.removeVoiceModel, async () => {
      if (voiceModel === null) throw new Error("voice model service not up");
      return voiceModel.remove();
    });
    // Settings → DeepSeek key. The secure store is the single source of truth;
    // `host.setDeepSeekKey` mirrors it to the running session's live key so the
    // NEXT turn uses it with no restart. Only the masked status crosses back to
    // the renderer (the raw key stays in main).
    handle(CMD.getDeepSeekKeyStatus, () => getDeepSeekKeyStatus());
    handle(CMD.setDeepSeekKey, async (_e, key: string) => {
      const trimmed = key.trim();
      // Validate before persisting (a cheap token-free auth check). A rejected
      // key is never stored, so "Connected" stays truthful and no doomed turn
      // ever runs. A check we couldn't complete (offline) saves anyway, flagged
      // `unverified`, rather than blocking the user.
      const verdict = await validateDeepSeekKey(trimmed);
      if (verdict === "rejected") {
        return { ok: false as const, reason: "rejected" as const };
      }
      const { encrypted } = setDeepSeekKey(trimmed);
      host?.setDeepSeekKey(trimmed);
      return {
        ok: true as const,
        encrypted,
        status: getDeepSeekKeyStatus(),
        unverified: verdict === "unreachable",
      };
    });
    handle(CMD.clearDeepSeekKey, () => {
      clearDeepSeekKey();
      host?.setDeepSeekKey("");
      return { ok: true as const, status: getDeepSeekKeyStatus() };
    });
  }
  registerHandlers();

  async function start(): Promise<void> {
    // Re-entrant: did-finish-load can fire again on renderer reload. If we're
    // already bootstrapped, just re-sync the renderer with the active session
    // (re-point forwarders + re-send reset).
    if (host !== null) {
      const active = host.activeSession;
      // Re-sync the reloaded renderer: re-point at the open session if any, else
      // restore the connect screen (the user reloaded while still disconnected).
      if (active !== null) pointAt(active);
      else send(EVT.reset, { noSession: true });
      return;
    }
    // Wrap the WHOLE bootstrap: a missing key (buildConfig) OR a failed
    // createSessionHost/openSession must surface as the error panel via
    // session:reset, not a silent unhandled rejection that leaves the
    // renderer stuck on an empty workbench.
    try {
      const workspaceRoot = appWorkspaceRoot();
      // Herta's synthesized voice (ADR 0042). Constructed here — before the
      // host, so every session it creates carries it — but the utility
      // process starts LAZILY on the first sentence, so an install that
      // never speaks never pays the model load. The enable flag is seeded
      // from the persisted setting; the Settings handler keeps it current.
      realtimeVoiceEnabled =
        (await readGlobalSettings(app.getPath("userData"))).realtimeVoice ??
        true;
      const userDataPath = app.getPath("userData");
      synthesizer = createTtsSynthesizer({
        // The downloaded copy first, the dev workspace's second (ADR 0061);
        // a packaged app has only the first.
        modelRoots: resolveTtsModelRoots({
          userDataPath,
          isPackaged: app.isPackaged,
          workspaceRoot,
        }),
        // electron.vite.config.ts emits the worker beside the main bundle;
        // it is a plain .cjs on purpose — a native addon cannot be bundled.
        workerPath: join(__dirname, "tts-worker.cjs"),
        sherpaPath: resolveSherpaEntry({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          startDir: __dirname,
        }),
        enabled: () => realtimeVoiceEnabled,
      });
      {
        // The model download (ADR 0061). The archive's location is pinned
        // with its hash; a dev run may point it at a local server for the
        // lab — NEVER a packaged build (the T1.3 rule the update feed and
        // the DeepSeek base URL already follow).
        const override = app.isPackaged
          ? undefined
          : process.env[TTS_ARCHIVE_URL_ENV];
        const synth = synthesizer;
        voiceModel = createVoiceModelService({
          root: voiceModelStoreRoot(userDataPath),
          bundleId: TTS_BUNDLE_ID,
          archive: {
            url:
              override !== undefined && override !== ""
                ? override
                : TTS_ARCHIVE_URL,
            sha256: TTS_ARCHIVE_SHA256,
            bytes: TTS_ARCHIVE_BYTES,
            unpackedBytes: TTS_BUNDLE_BYTES,
          },
          // Electron's client: proxy-aware, and the session's certificate
          // policy applies. The signal aborts the transfer on cancel.
          fetch: (url, init) => net.fetch(url, { signal: init.signal }),
          onChange: (state) => send(EVT.voiceModel, state),
          // The worker holds the bundle's files open; stop it before the
          // files go (it forks afresh on the next request if a bundle is
          // still there).
          beforeRemove: () => synth.stopWorker(),
          afterChange: () => {
            synth.refreshBundle();
          },
        });
      }
      // The cloud voice (ADR 0062) beside the local one, both behind one
      // switching synthesizer the app-server sees. The engine and the clone
      // record come from settings; the key from the secure store, per call.
      const startupSettings = await readGlobalSettings(userDataPath);
      voiceEngine = startupSettings.voiceEngine ?? "local";
      const referencePath = resolveVoiceCloneReference({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        workspaceRoot,
      });
      const fetchLike = minimaxFetch;
      minimaxVoice = createMiniMaxVoiceService({
        fetch: fetchLike,
        key: readMiniMaxKeyPlain,
        planKey: readMiniMaxPlanKeyPlain,
        readReference: async () => {
          try {
            return new Uint8Array(await readFile(referencePath));
          } catch {
            return null;
          }
        },
        initial: startupSettings.minimaxVoice ?? null,
        save: async (record) => {
          await updateGlobalSettings(userDataPath, (s) => ({
            ...s,
            minimaxVoice: record ?? undefined,
          }));
        },
        onChange: (state) => send(EVT.voiceMinimax, state),
      });
      const voiceService = minimaxVoice;
      // An install that chose the cloud and has a key but no clone yet (a
      // reset, a settings file from before the clone existed): make it at
      // start, unasked — the user never operates the clone.
      if (
        voiceEngine === "minimax" &&
        anyMiniMaxKey() &&
        voiceService.voice() === null
      ) {
        void voiceService.prepare();
      }
      minimaxSynth = createMiniMaxSynthesizer({
        fetch: fetchLike,
        // Speech goes through the plan when there is one (§1.8), else it is
        // billed to the pay-as-you-go key.
        key: () => readMiniMaxPlanKeyPlain() ?? readMiniMaxKeyPlain(),
        voice: () => voiceService.voice(),
        enabled: () => realtimeVoiceEnabled && voiceEngine === "minimax",
        applyEffect: loadCommChannelEffect(),
        onVoiceMissing: (id) => voiceService.markMissing(id),
        onUsed: () => voiceService.stampUsed(),
      });
      const speech = createSwitchingSynthesizer({
        engine: () => voiceEngine,
        local: synthesizer,
        minimax: minimaxSynth,
      });
      const config = await buildConfig(
        workspaceRoot,
        homedir(),
        readDeepSeekKeyPlain(),
        // Packaged builds read the bundled clips; dev reads the workspace.
        resolveVoiceRoot({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          workspaceRoot,
        }),
        // Dev-only chaos/staging feed: NEVER honored in a packaged build
        // (T1.3 pattern — an env-settable base URL in production would
        // redirect the API key to an arbitrary host).
        app.isPackaged ? undefined : process.env.HERTA_DEEPSEEK_BASE_URL,
        speech,
      );
      host = createSessionHost(config);
      // Launch lands on the connect screen (接入黑塔空间站) rather than
      // auto-resuming the latest session: the user explicitly opens one from the
      // sidebar or starts a new one from the connect button (user 2026-06-20).
      // The host IS created so listSessions() still populates the sidebar — we
      // just don't open a session yet, so the renderer shows the disconnected
      // (no-session) state. `pickLatest` is retained (exported, tested) for a
      // future "resume last" affordance.
      console.log("[herta] launch: connect screen (no auto-resume)");
      send(EVT.reset, { noSession: true });
    } catch (err) {
      console.error("[herta] session bootstrap failed:", err);
      host = null;
      send(EVT.reset, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function dispose(): Promise<void> {
    stopForwarders?.();
    stopForwarders = null;
    if (handlersRegistered) {
      // Exactly the channels registered above — never the whole CMD map,
      // which also names the update / app-version / window-control channels
      // index.ts owns (audit T3.7: disposing a session service used to tear
      // those down with it).
      for (const c of ownedChannels) ipcMain.removeHandler(c);
      ownedChannels.length = 0;
      handlersRegistered = false;
    }
    await host?.closeActiveSession();
    host?.dispose();
    host = null;
    // The voice worker is a CHILD PROCESS: left running it would outlive the
    // window and hold ~200 MB of loaded model. Disposed after the sessions,
    // so a turn still unwinding can finish its last synthesis request
    // (which resolves null once the worker is gone — the reveal types it).
    // A download in flight dies with the window (its partial file is
    // discarded by the downloader itself); the service is rebuilt with the
    // synthesizer on the next start.
    voiceModel?.cancel();
    voiceModel = null;
    minimaxSynth?.dispose();
    minimaxSynth = null;
    minimaxVoice = null;
    synthesizer?.dispose();
    synthesizer = null;
  }

  /**
   * The station-terminal treatment for the cloud voice, from the vendored
   * `.cjs` emitted beside the main bundle (the worker requires the same file
   * the same way). Absent — a dev tree before a build — the cloud voice
   * plays dry rather than not at all.
   */
  function loadCommChannelEffect():
    | ((samples: Float32Array, sampleRate: number) => Float32Array)
    | undefined {
    try {
      const mod = createRequire(__filename)(
        join(__dirname, "comm-channel-effect.cjs"),
      ) as {
        applyCommChannel: (
          samples: Float32Array,
          sampleRate: number,
          options: { preset: string },
        ) => Float32Array;
      };
      return (samples, sampleRate) =>
        mod.applyCommChannel(samples, sampleRate, { preset: TTS_EFFECT });
    } catch (err) {
      console.warn(
        `[herta-minimax] comm-channel effect unavailable, playing dry: ${String(err)}`,
      );
      return undefined;
    }
  }

  return {
    start,
    dispose,
    listSessions: () => host?.listSessions() ?? [],
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
