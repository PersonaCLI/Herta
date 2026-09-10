import type {
  ApprovalResult,
  CreateSessionOpts,
  OverlayEvent,
  RecordEvent,
  RepoEvent,
  ResolveApprovalOpts,
  RewindResult,
  SessionAgentEvent,
  SessionDeletedEvent,
  SessionMetadata,
  SessionSearchHit,
  SubmitTextResult,
  TerminalRecord,
  TitleEvent,
  TurnLifecycleEvent,
  VoiceCueEvent,
  WorkspaceEvent,
} from "@herta/app-server";
import type {
  BackendConfig,
  DeepSeekKeyStatus,
  DreamConfig,
  HertaBridge,
  InteractionLanguageChoice,
  MiniMaxVoiceState,
  ModelConfig,
  NavBlockedEvent,
  RealtimeVoiceState,
  SessionError,
  SessionNoSession,
  SessionOpenFailure,
  SessionSnapshot,
  SpeechControlEvent,
  StagedImageInfo,
  StageImagesReply,
  ThemePref,
  UpdateState,
  VoiceEngine,
  VoiceModelState,
} from "./bridge-types.js";

export interface MockHertaBridgeOpts {
  readonly submitTextResult?: SubmitTextResult;
  readonly interruptResult?: { readonly ok: boolean };
  readonly rewindLastTurnResult?: RewindResult;
  readonly listSessionsResult?: readonly SessionMetadata[];
  /** Seed for searchSessions (transcript content search). Default []. */
  readonly searchSessionsResult?: readonly SessionSearchHit[];
  /** Seed for recordSlice (load-earlier paging). Default empty slice. */
  readonly recordSliceResult?: {
    readonly start: number;
    readonly blocks: TerminalRecord;
  };
  readonly openSessionResult?: SessionSnapshot | SessionOpenFailure;
  readonly createSessionResult?: SessionSnapshot;
  readonly resolveApprovalResult?: ApprovalResult;
  /** Seed for listCommandRules (Settings → Coprocessor, ADR 0030). The list
   *  is mutated by removeCommandRule so tests observe the round-trip.
   *  Default []. */
  readonly commandRules?: readonly string[];
  readonly pickWorkspaceResult?: string | null;
  readonly setWorkspaceResult?: { ok: boolean; message?: string };
  /** Seed for the attachment picker (ADR 0033). Null = cancelled. */
  readonly pickAttachmentsResult?: readonly string[] | null;
  /** Lets a test drive the refusal paths (turn in progress, too many). */
  readonly attachFilesResult?: { ok: boolean; message?: string };
  readonly removeAttachmentResult?: { ok: boolean; message?: string };
  /** Seed for stageImages (ADR 0048 §4). Default: every input stages, with a
   *  synthetic id/path — enough for the composer strip to render. */
  readonly stageImagesResult?: StageImagesReply;
  readonly unstageImageResult?: boolean;
  readonly getDreamConfigResult?: DreamConfig;
  /** Seed for getBackendConfig (Settings → Coprocessor). Default
   *  `{ thinking: "high", contract: "minimal" }` (the real handler's
   *  defaults). */
  readonly getBackendConfigResult?: BackendConfig;
  /** When true, setBackendConfig rejects (simulates a failed settings
   *  write) — mirrors failSetInteractionLanguage, so the snap-back +
   *  error-note paths are testable. */
  readonly failSetBackendConfig?: boolean;
  /** Seed for getModelConfig (Settings → DeepSeek → 模型). Default
   *  actor Pro / backend the VISION flash (the real handler's defaults). */
  readonly getModelConfigResult?: ModelConfig;
  /** When true, setModelConfig rejects — same seam as failSetBackendConfig. */
  readonly failSetModelConfig?: boolean;
  /** Seed the masked DeepSeek key status. Mutated by setDeepSeekKey /
   *  clearDeepSeekKey so tests observe the live status round-trip. */
  readonly deepSeekKeyStatus?: DeepSeekKeyStatus;
  /** When true, setDeepSeekKey rejects every key (simulates a wrong key that
   *  fails the validation check) — returns `{ ok: false, reason: "rejected" }`
   *  and leaves the status unchanged. */
  readonly rejectDeepSeekKey?: boolean;
  /** Seed for getCloseToTray (Settings → Window). Default true. */
  readonly closeToTrayResult?: boolean;
  /** When true, setCloseToTray rejects (simulates a failed settings write). */
  readonly failSetCloseToTray?: boolean;
  /** Seed for getTheme (Settings → Window appearance). Default "light". */
  readonly themeResult?: ThemePref;
  /** Seed for getDeviceScene (Settings → 差分协处理器 → 3D device, ADR
   *  0057). UNDEFINED (the default) omits the surface entirely — the row
   *  hides and the rail card stays flat, like the website demo's bridge. */
  readonly deviceSceneResult?: boolean;
  /** When true, setDeviceScene rejects (simulates a failed settings write). */
  readonly failSetDeviceScene?: boolean;
  /** Seed for getInteractionLanguage (Settings → Language, slice 4).
   *  Default "follow" (no stored choice). Mutated by setInteractionLanguage
   *  so tests observe the round-trip. */
  readonly interactionLanguageResult?: InteractionLanguageChoice;
  /** When true, setInteractionLanguage rejects (simulates a failed settings
   *  write) — mirrors failSetCloseToTray, so the snap-back + error-note paths
   *  are testable. */
  readonly failSetInteractionLanguage?: boolean;
  /** Platform reported by the bridge (window controls hide on darwin).
   *  Defaults to "win32". */
  readonly platform?: string;
  /** Seed for windowIsMaximized. Default false. */
  readonly windowIsMaximizedResult?: boolean;
  /** Seed for getUpdateState (Settings → Update). Default idle. */
  readonly updateState?: UpdateState;
  /** Seed for getAppVersion. Default "0.1.0". */
  readonly appVersion?: string;
  /** Seed for getRealtimeVoice (Settings → Voice, ADR 0042). Default: on,
   *  with the assets present. Mutated by setRealtimeVoice so tests observe
   *  the round-trip. */
  readonly realtimeVoiceResult?: Omit<
    RealtimeVoiceState,
    "model" | "engine" | "minimax"
  > & {
    readonly model?: VoiceModelState;
    readonly engine?: VoiceEngine;
    readonly minimax?: {
      readonly key?: DeepSeekKeyStatus;
      readonly planKey?: DeepSeekKeyStatus;
      readonly voice?: MiniMaxVoiceState;
    };
  };
  /** When true, setMiniMaxKey rejects every key (neither platform accepts
   *  it) — `{ ok: false, reason: "rejected" }`, status unchanged. */
  readonly rejectMiniMaxKey?: boolean;
  /** When true, MiniMax cannot be reached: a key is stored `unverified`
   *  and every clone attempt fails with `network`. */
  readonly offlineMiniMax?: boolean;
  /** When true, setRealtimeVoice rejects — same seam as
   *  failSetInteractionLanguage, so the snap-back + error-note path is
   *  testable. */
  readonly failSetRealtimeVoice?: boolean;
}

export interface MockHertaBridge {
  readonly bridge: HertaBridge;
  readonly calls: {
    submitText: string[];
    /** The staged-image ids sent WITH each submitText, positionally paired
     *  with `submitText` (ADR 0048 §4). */
    submitTextStaged: Array<readonly string[] | undefined>;
    interrupt: Array<string | undefined>;
    rewindLastTurn: number;
    maybePlayEasterEgg: number;
    openSession: string[];
    createSession: CreateSessionOpts[];
    deleteSession: string[];
    resolveApproval: ResolveApprovalOpts[];
    listCommandRules: number;
    removeCommandRule: string[];
    resyncRecord: number;
    checkForUpdate: number;
    restartAndInstall: number;
    openExternal: string[];
    listSessions: number;
    searchSessions: string[];
    recordSlice: Array<[string, number, number]>;
    pickWorkspace: number;
    setWorkspace: Array<[string, string]>;
    resetWorkspace: string[];
    refreshRepo: number;
    pickAttachments: number;
    attachFiles: Array<[string, readonly string[]]>;
    removeAttachment: Array<[string, string]>;
    stageImages: Array<
      [
        string,
        readonly {
          readonly path?: string;
          readonly bytes?: Uint8Array;
          readonly name?: string;
        }[],
      ]
    >;
    unstageImage: Array<[string, string]>;
    pathForFile: number;
    getDreamConfig: number;
    setDreamConfig: DreamConfig[];
    getBackendConfig: number;
    setBackendConfig: BackendConfig[];
    getModelConfig: number;
    setModelConfig: ModelConfig[];
    getDeepSeekKeyStatus: number;
    setDeepSeekKey: string[];
    clearDeepSeekKey: number;
    getCloseToTray: number;
    setCloseToTray: boolean[];
    setTheme: ThemePref[];
    setDeviceScene: boolean[];
    getInteractionLanguage: number;
    setInteractionLanguage: InteractionLanguageChoice[];
    getRealtimeVoice: number;
    setRealtimeVoice: boolean[];
    downloadVoiceModel: number;
    cancelVoiceModelDownload: number;
    removeVoiceModel: number;
    setVoiceEngine: VoiceEngine[];
    setMiniMaxKey: string[];
    clearMiniMaxKey: number;
    setMiniMaxPlanKey: string[];
    clearMiniMaxPlanKey: number;
    prepareMiniMaxVoice: number;
    resetMiniMaxVoice: number;
    windowMinimize: number;
    windowToggleMaximize: number;
    windowClose: number;
  };
  emitWindowMaximized(maximized: boolean): void;
  emitRecord(e: RecordEvent): void;
  emitOverlay(e: OverlayEvent): void;
  emitSpeech(e: SpeechControlEvent): void;
  emitAgent(e: SessionAgentEvent): void;
  emitTurn(e: TurnLifecycleEvent): void;
  emitReset(e: SessionSnapshot | SessionError | SessionNoSession): void;
  emitTitle(e: TitleEvent): void;
  emitSessionDeleted(e: SessionDeletedEvent): void;
  emitWorkspace(e: WorkspaceEvent): void;
  emitVoice(e: VoiceCueEvent): void;
  emitUpdate(e: UpdateState): void;
  /** The voice model's stream (ADR 0061) — a progress tick, a phase change. */
  emitVoiceModel(e: VoiceModelState): void;
  /** The cloud clone's stream (ADR 0062). */
  emitMiniMaxVoice(e: MiniMaxVoiceState): void;
  emitNavBlocked(e: NavBlockedEvent): void;
  /** The repository card's stream (ADR 0058). */
  emitRepo(e: RepoEvent): void;
}

const DEFAULT_SNAPSHOT: SessionSnapshot = {
  sessionId: "mock-session",
  workspaceRoot: "/mock",
  record: [],
  overlay: null,
  title: null,
  backendWorkspace: "/mock",
  backendWorkspaceIsDefault: true,
};

export function createMockHertaBridge(
  opts: MockHertaBridgeOpts = {},
): MockHertaBridge {
  const recordCbs = new Set<(e: RecordEvent) => void>();
  const overlayCbs = new Set<(e: OverlayEvent) => void>();
  const speechCbs = new Set<(e: SpeechControlEvent) => void>();
  const agentCbs = new Set<(e: SessionAgentEvent) => void>();
  const turnCbs = new Set<(e: TurnLifecycleEvent) => void>();
  const resetCbs = new Set<
    (e: SessionSnapshot | SessionError | SessionNoSession) => void
  >();
  const titleCbs = new Set<(e: TitleEvent) => void>();
  const deletedCbs = new Set<(e: SessionDeletedEvent) => void>();
  const workspaceCbs = new Set<(e: WorkspaceEvent) => void>();
  const repoCbs = new Set<(e: RepoEvent) => void>();
  const voiceCbs = new Set<(e: VoiceCueEvent) => void>();
  const updateCbs = new Set<(e: UpdateState) => void>();
  const navBlockedCbs = new Set<(e: NavBlockedEvent) => void>();

  const calls: MockHertaBridge["calls"] = {
    submitText: [],
    submitTextStaged: [],
    interrupt: [],
    rewindLastTurn: 0,
    maybePlayEasterEgg: 0,
    openSession: [],
    createSession: [],
    deleteSession: [],
    resolveApproval: [],
    listCommandRules: 0,
    removeCommandRule: [],
    resyncRecord: 0,
    checkForUpdate: 0,
    restartAndInstall: 0,
    openExternal: [],
    listSessions: 0,
    searchSessions: [],
    recordSlice: [],
    pickWorkspace: 0,
    getDreamConfig: 0,
    setDreamConfig: [],
    getBackendConfig: 0,
    setBackendConfig: [],
    getModelConfig: 0,
    setModelConfig: [],
    getDeepSeekKeyStatus: 0,
    setDeepSeekKey: [],
    clearDeepSeekKey: 0,
    getCloseToTray: 0,
    setCloseToTray: [],
    setTheme: [],
    setDeviceScene: [],
    getInteractionLanguage: 0,
    setInteractionLanguage: [],
    getRealtimeVoice: 0,
    setRealtimeVoice: [],
    downloadVoiceModel: 0,
    cancelVoiceModelDownload: 0,
    removeVoiceModel: 0,
    setVoiceEngine: [],
    setMiniMaxKey: [],
    clearMiniMaxKey: 0,
    setMiniMaxPlanKey: [],
    clearMiniMaxPlanKey: 0,
    prepareMiniMaxVoice: 0,
    resetMiniMaxVoice: 0,
    windowMinimize: 0,
    windowToggleMaximize: 0,
    windowClose: 0,
    setWorkspace: [],
    resetWorkspace: [],
    refreshRepo: 0,
    pickAttachments: 0,
    attachFiles: [],
    removeAttachment: [],
    stageImages: [],
    unstageImage: [],
    pathForFile: 0,
  };

  // Live masked status, seeded then mutated by set/clear so tests can observe
  // the round-trip the real main process performs.
  let keyStatus: DeepSeekKeyStatus = opts.deepSeekKeyStatus ?? {
    set: false,
    hint: null,
    encrypted: false,
  };

  // Live interaction-language choice, seeded then mutated by
  // setInteractionLanguage so tests observe the round-trip ("follow" =
  // no stored choice, the real handler's default).
  let interactionLanguage: InteractionLanguageChoice =
    opts.interactionLanguageResult ?? "follow";

  // Live project command rules (ADR 0030), seeded then mutated by
  // removeCommandRule so tests observe the round-trip.
  const commandRules: string[] = [...(opts.commandRules ?? [])];

  // Live real-time-voice state (ADR 0042), seeded then mutated by
  // setRealtimeVoice. The default is the healthy install: on, assets present.
  const seededVoice = opts.realtimeVoiceResult ?? {
    enabled: true,
    bundle: true,
    runtime: true,
    failed: false,
  };
  // The downloadable model (ADR 0061): ready by default (the healthy
  // install); seeded per test, mutated by download/cancel/remove, pushed to
  // onVoiceModel subscribers like main does.
  let voiceModel: VoiceModelState = seededVoice.model ?? {
    phase: seededVoice.bundle ? "ready" : "absent",
    receivedBytes: 0,
    totalBytes: 60_000_000,
    unpackedBytes: 116_000_000,
  };
  // The cloud engine (ADR 0062): the masked MiniMax key and the clone,
  // seeded per test, mutated by the key/engine/prepare/reset calls, pushed
  // to onMiniMaxVoice subscribers like main does.
  let minimaxKey: DeepSeekKeyStatus = seededVoice.minimax?.key ?? {
    set: false,
    hint: null,
    encrypted: false,
  };
  let minimaxPlanKey: DeepSeekKeyStatus = seededVoice.minimax?.planKey ?? {
    set: false,
    hint: null,
    encrypted: false,
  };
  let minimaxVoice: MiniMaxVoiceState = seededVoice.minimax?.voice ?? {
    phase: "absent",
  };
  let voiceEngine: VoiceEngine = seededVoice.engine ?? "local";
  const minimaxCbs = new Set<(e: MiniMaxVoiceState) => void>();
  const pushMiniMax = (next: MiniMaxVoiceState): void => {
    minimaxVoice = next;
    for (const cb of minimaxCbs) cb(next);
  };
  /** The clone as main makes it: preparing, then ready — or failed without
   *  a key, or with only the plan key on an account that has no clone to
   *  adopt (the mock's account is empty). */
  const mockPrepare = (): void => {
    if (!minimaxKey.set && !minimaxPlanKey.set) {
      pushMiniMax({ phase: "failed", error: "no_key" });
      return;
    }
    pushMiniMax({ phase: "preparing" });
    if (opts.offlineMiniMax === true) {
      pushMiniMax({ phase: "failed", error: "network" });
      return;
    }
    if (!minimaxKey.set) {
      pushMiniMax({ phase: "failed", error: "no_clone_key" });
      return;
    }
    pushMiniMax({
      phase: "ready",
      voiceId: "herta_mock000001",
      host: "https://api.minimaxi.com",
      clonedAt: "2026-09-08T10:00:00.000Z",
    });
  };
  const minimaxView = (): RealtimeVoiceState["minimax"] => ({
    key: minimaxKey,
    planKey: minimaxPlanKey,
    voice: minimaxVoice,
  });
  const voiceView = (): RealtimeVoiceState => ({
    ...seededVoice,
    bundle: realtimeVoice.bundle,
    enabled: realtimeVoice.enabled,
    model: voiceModel,
    engine: voiceEngine,
    minimax: minimaxView(),
  });
  let realtimeVoice: RealtimeVoiceState = {
    ...seededVoice,
    model: voiceModel,
    engine: voiceEngine,
    minimax: minimaxView(),
  };
  const voiceModelCbs = new Set<(e: VoiceModelState) => void>();
  const pushVoiceModel = (next: VoiceModelState): void => {
    voiceModel = next;
    realtimeVoice = {
      ...realtimeVoice,
      bundle: next.phase === "ready",
      model: next,
    };
    for (const cb of voiceModelCbs) cb(next);
  };

  function sub<T>(set: Set<(e: T) => void>, cb: (e: T) => void): () => void {
    set.add(cb);
    return () => set.delete(cb);
  }

  const windowMaximizedCbs = new Set<(maximized: boolean) => void>();

  const bridge: HertaBridge = {
    platform: opts.platform ?? "win32",
    windowMinimize: () => {
      calls.windowMinimize += 1;
    },
    windowToggleMaximize: () => {
      calls.windowToggleMaximize += 1;
    },
    windowClose: () => {
      calls.windowClose += 1;
    },
    windowIsMaximized: async () => opts.windowIsMaximizedResult ?? false,
    onWindowMaximized: (cb) => {
      windowMaximizedCbs.add(cb);
      return () => windowMaximizedCbs.delete(cb);
    },
    submitText: async (text, stagedImageIds) => {
      calls.submitText.push(text);
      calls.submitTextStaged.push(stagedImageIds);
      return opts.submitTextResult ?? { turnId: "mock-turn" };
    },
    interrupt: async (turnId) => {
      calls.interrupt.push(turnId);
      return opts.interruptResult ?? { ok: true };
    },
    rewindLastTurn: async (_sessionId) => {
      calls.rewindLastTurn += 1;
      return opts.rewindLastTurnResult ?? { ok: false, reason: "no_user_turn" };
    },
    maybePlayEasterEgg: async () => {
      calls.maybePlayEasterEgg += 1;
    },
    listSessions: async () => {
      calls.listSessions += 1;
      return opts.listSessionsResult ?? [];
    },
    searchSessions: async (query) => {
      calls.searchSessions.push(query);
      return opts.searchSessionsResult ?? [];
    },
    recordSlice: async (sessionId, before, count) => {
      calls.recordSlice.push([sessionId, before, count]);
      return opts.recordSliceResult ?? { start: 0, blocks: [] };
    },
    openSession: async (id) => {
      calls.openSession.push(id);
      return opts.openSessionResult ?? { ...DEFAULT_SNAPSHOT, sessionId: id };
    },
    createSession: async (o) => {
      calls.createSession.push(o);
      return opts.createSessionResult ?? DEFAULT_SNAPSHOT;
    },
    deleteSession: async (id) => {
      calls.deleteSession.push(id);
      return { ok: true, wasActive: false };
    },
    resolveApproval: async (o) => {
      calls.resolveApproval.push(o);
      return opts.resolveApprovalResult ?? { ok: true };
    },
    listCommandRules: async () => {
      calls.listCommandRules += 1;
      return commandRules;
    },
    removeCommandRule: async (display) => {
      calls.removeCommandRule.push(display);
      const i = commandRules.indexOf(display);
      if (i === -1) return false;
      commandRules.splice(i, 1);
      return true;
    },
    resyncRecord: async () => {
      calls.resyncRecord += 1;
    },
    checkForUpdate: async () => {
      calls.checkForUpdate += 1;
    },
    restartAndInstall: async () => {
      calls.restartAndInstall += 1;
    },
    openExternal: async (url) => {
      calls.openExternal.push(url);
    },
    getUpdateState: async () => opts.updateState ?? { phase: "idle" },
    getAppVersion: async () => opts.appVersion ?? "0.1.0",
    onUpdate: (cb) => sub(updateCbs, cb),
    pickWorkspace: async () => {
      calls.pickWorkspace += 1;
      return opts.pickWorkspaceResult ?? null;
    },
    setWorkspace: async (sid, path) => {
      calls.setWorkspace.push([sid, path]);
      return opts.setWorkspaceResult ?? { ok: true };
    },
    resetWorkspace: async (sid) => {
      calls.resetWorkspace.push(sid);
      return { ok: true };
    },
    pickAttachments: async () => {
      calls.pickAttachments += 1;
      return opts.pickAttachmentsResult ?? null;
    },
    attachFiles: async (sid, paths) => {
      calls.attachFiles.push([sid, paths]);
      return opts.attachFilesResult ?? { ok: true };
    },
    removeAttachment: async (sid, path) => {
      calls.removeAttachment.push([sid, path]);
      return opts.removeAttachmentResult ?? { ok: true };
    },
    stageImages: async (sid, inputs) => {
      calls.stageImages.push([sid, inputs]);
      if (opts.stageImagesResult !== undefined) return opts.stageImagesResult;
      // The per-message picture cap, whole-batch like the real handler. The
      // real one also counts what is ALREADY staged; this mock is stateless
      // across calls, so a cross-call accumulation test seeds
      // `stageImagesResult` instead.
      if (inputs.length > 5) {
        return { ok: false, message: "five images per message" };
      }
      // Default: split by EXTENSION. The real main process decides by magic
      // bytes — a mock cannot, and must not pretend to — but it does have to
      // route documents to `not_image` the way the real one does, or every
      // document test here would silently stage instead of ingesting.
      const staged: StagedImageInfo[] = [];
      const rejected: { name: string; reason: string }[] = [];
      inputs.forEach((input, i) => {
        const name =
          input.name ??
          (input.path ?? "").split(/[\\/]/).at(-1) ??
          `image-${i}.png`;
        if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) {
          rejected.push({ name, reason: "not_image" });
          return;
        }
        staged.push({
          // Positional ids so a test can predict them.
          id: `staged-${staged.length}`,
          name,
          path: `.herta/attachments/${sid}/${name}`,
          width: 800,
          height: 600,
        });
      });
      return { ok: true, staged, rejected };
    },
    unstageImage: async (sid, id) => {
      calls.unstageImage.push([sid, id]);
      return opts.unstageImageResult ?? true;
    },
    // jsdom Files have no real path; the mock returns the name so a drop test
    // can assert what got forwarded without pretending to know a temp path.
    pathForFile: (file) => {
      calls.pathForFile += 1;
      return file.name;
    },
    getDreamConfig: async () => {
      calls.getDreamConfig += 1;
      return opts.getDreamConfigResult ?? { enabled: true };
    },
    setDreamConfig: async (cfg) => {
      calls.setDreamConfig.push(cfg);
    },
    getBackendConfig: async () => {
      calls.getBackendConfig += 1;
      return (
        opts.getBackendConfigResult ?? {
          thinking: "high",
          // Mirrors the real handler's defaults (owner flip 2026-08-17).
          contract: "minimal",
          bashFound: true,
        }
      );
    },
    setBackendConfig: async (cfg) => {
      calls.setBackendConfig.push(cfg);
      if (opts.failSetBackendConfig) {
        throw new Error("settings write failed");
      }
    },
    getModelConfig: async () => {
      calls.getModelConfig += 1;
      return (
        opts.getModelConfigResult ?? {
          actor: "deepseek-v4-pro",
          // Mirrors the real handler's default: the flash, which reads
          // images since the 2026-09 rename (ADR 0048 §5a/§5b).
          backend: "deepseek-flash",
        }
      );
    },
    setModelConfig: async (cfg) => {
      calls.setModelConfig.push(cfg);
      if (opts.failSetModelConfig) {
        throw new Error("settings write failed");
      }
    },
    getDeepSeekKeyStatus: async () => {
      calls.getDeepSeekKeyStatus += 1;
      return keyStatus;
    },
    setDeepSeekKey: async (key) => {
      calls.setDeepSeekKey.push(key);
      if (opts.rejectDeepSeekKey) {
        return { ok: false, reason: "rejected" };
      }
      const trimmed = key.trim();
      keyStatus =
        trimmed.length === 0
          ? { set: false, hint: null, encrypted: false }
          : {
              set: true,
              hint: trimmed.length >= 4 ? trimmed.slice(-4) : null,
              encrypted: true,
            };
      return {
        ok: true,
        encrypted: keyStatus.encrypted,
        status: keyStatus,
        unverified: false,
      };
    },
    clearDeepSeekKey: async () => {
      calls.clearDeepSeekKey += 1;
      keyStatus = { set: false, hint: null, encrypted: false };
      return { ok: true, status: keyStatus };
    },
    getLocale: async () => "en" as const,
    setLocale: async () => {},
    getCloseToTray: async () => {
      calls.getCloseToTray += 1;
      return opts.closeToTrayResult ?? true;
    },
    setCloseToTray: async (enabled) => {
      calls.setCloseToTray.push(enabled);
      if (opts.failSetCloseToTray === true) {
        throw new Error("write failed");
      }
    },
    getTheme: async () => opts.themeResult ?? "light",
    setTheme: async (theme) => {
      calls.setTheme.push(theme);
    },
    ...(opts.deviceSceneResult !== undefined
      ? {
          getDeviceScene: async () => opts.deviceSceneResult === true,
          setDeviceScene: async (enabled: boolean) => {
            calls.setDeviceScene.push(enabled);
            if (opts.failSetDeviceScene === true) {
              throw new Error("write failed");
            }
          },
        }
      : {}),
    getInteractionLanguage: async () => {
      calls.getInteractionLanguage += 1;
      return interactionLanguage;
    },
    setInteractionLanguage: async (choice) => {
      calls.setInteractionLanguage.push(choice);
      if (opts.failSetInteractionLanguage === true) {
        throw new Error("write failed");
      }
      interactionLanguage = choice;
    },
    getRealtimeVoice: async () => {
      calls.getRealtimeVoice += 1;
      return voiceView();
    },
    setRealtimeVoice: async (enabled) => {
      calls.setRealtimeVoice.push(enabled);
      if (opts.failSetRealtimeVoice === true) throw new Error("write failed");
      realtimeVoice = { ...realtimeVoice, enabled };
    },
    downloadVoiceModel: async () => {
      calls.downloadVoiceModel += 1;
      pushVoiceModel({ ...voiceModel, phase: "downloading", receivedBytes: 0 });
      pushVoiceModel({
        ...voiceModel,
        phase: "ready",
        receivedBytes: voiceModel.totalBytes,
      });
      return voiceModel;
    },
    cancelVoiceModelDownload: async () => {
      calls.cancelVoiceModelDownload += 1;
      pushVoiceModel({ ...voiceModel, phase: "absent", receivedBytes: 0 });
    },
    removeVoiceModel: async () => {
      calls.removeVoiceModel += 1;
      pushVoiceModel({ ...voiceModel, phase: "absent", receivedBytes: 0 });
      return voiceModel;
    },
    onVoiceModel: (cb) => sub(voiceModelCbs, cb),
    setVoiceEngine: async (engine) => {
      calls.setVoiceEngine.push(engine);
      voiceEngine = engine;
      // Main makes the clone unasked when the cloud is chosen with a key.
      if (
        engine === "minimax" &&
        (minimaxKey.set || minimaxPlanKey.set) &&
        minimaxVoice.phase !== "ready"
      ) {
        mockPrepare();
      }
    },
    getMiniMaxKeyStatus: async () => minimaxKey,
    setMiniMaxKey: async (key) => {
      calls.setMiniMaxKey.push(key);
      if (opts.rejectMiniMaxKey === true) {
        return { ok: false, reason: "rejected" };
      }
      const trimmed = key.trim();
      minimaxKey = {
        set: true,
        hint: trimmed.slice(-4),
        encrypted: true,
      };
      // Main forgets the old clone and, with the cloud chosen, makes a new
      // one right away.
      pushMiniMax({ phase: "absent" });
      if (voiceEngine === "minimax") mockPrepare();
      return {
        ok: true,
        encrypted: true,
        unverified: opts.offlineMiniMax === true,
        status: minimaxKey,
      };
    },
    clearMiniMaxKey: async () => {
      calls.clearMiniMaxKey += 1;
      minimaxKey = { set: false, hint: null, encrypted: false };
      return { ok: true, status: minimaxKey };
    },
    getMiniMaxPlanKeyStatus: async () => minimaxPlanKey,
    setMiniMaxPlanKey: async (key) => {
      calls.setMiniMaxPlanKey.push(key);
      if (opts.rejectMiniMaxKey === true) {
        return { ok: false, reason: "rejected" };
      }
      minimaxPlanKey = {
        set: true,
        hint: key.trim().slice(-4),
        encrypted: true,
      };
      // The plan key never touches an existing clone; with none, main
      // tries for one (adoption on a real account).
      if (voiceEngine === "minimax" && minimaxVoice.phase !== "ready") {
        mockPrepare();
      }
      return {
        ok: true,
        encrypted: true,
        unverified: opts.offlineMiniMax === true,
        status: minimaxPlanKey,
      };
    },
    clearMiniMaxPlanKey: async () => {
      calls.clearMiniMaxPlanKey += 1;
      minimaxPlanKey = { set: false, hint: null, encrypted: false };
      return { ok: true, status: minimaxPlanKey };
    },
    prepareMiniMaxVoice: async () => {
      calls.prepareMiniMaxVoice += 1;
      mockPrepare();
      return minimaxVoice;
    },
    resetMiniMaxVoice: async () => {
      calls.resetMiniMaxVoice += 1;
      pushMiniMax({ phase: "absent" });
      return minimaxVoice;
    },
    onMiniMaxVoice: (cb) => sub(minimaxCbs, cb),
    onWorkspace: (cb) => sub(workspaceCbs, cb),
    onRepo: (cb) => sub(repoCbs, cb),
    refreshRepo: async () => {
      calls.refreshRepo += 1;
    },
    onRecord: (cb) => sub(recordCbs, cb),
    onOverlay: (cb) => sub(overlayCbs, cb),
    onSpeech: (cb) => sub(speechCbs, cb),
    onAgent: (cb) => sub(agentCbs, cb),
    onTurn: (cb) => sub(turnCbs, cb),
    onReset: (cb) => sub(resetCbs, cb),
    onTitle: (cb) => sub(titleCbs, cb),
    onSessionDeleted: (cb) => sub(deletedCbs, cb),
    onNavBlocked: (cb) => sub(navBlockedCbs, cb),
    onVoice: (cb) => sub(voiceCbs, cb),
  };

  return {
    bridge,
    calls,
    emitRecord: (e) => {
      for (const cb of recordCbs) cb(e);
    },
    emitOverlay: (e) => {
      for (const cb of overlayCbs) cb(e);
    },
    emitSpeech: (e) => {
      for (const cb of speechCbs) cb(e);
    },
    emitAgent: (e) => {
      for (const cb of agentCbs) cb(e);
    },
    emitTurn: (e) => {
      for (const cb of turnCbs) cb(e);
    },
    emitReset: (e) => {
      for (const cb of resetCbs) cb(e);
    },
    emitTitle: (e) => {
      for (const cb of titleCbs) cb(e);
    },
    emitSessionDeleted: (e) => {
      for (const cb of deletedCbs) cb(e);
    },
    emitWorkspace: (e) => {
      for (const cb of workspaceCbs) cb(e);
    },
    emitRepo: (e) => {
      for (const cb of repoCbs) cb(e);
    },
    emitVoice: (e) => {
      for (const cb of voiceCbs) cb(e);
    },
    emitUpdate: (e) => {
      for (const cb of updateCbs) cb(e);
    },
    emitVoiceModel: (e) => pushVoiceModel(e),
    emitMiniMaxVoice: (e) => pushMiniMax(e),
    emitNavBlocked: (e) => {
      for (const cb of navBlockedCbs) cb(e);
    },
    emitWindowMaximized: (maximized) => {
      for (const cb of windowMaximizedCbs) cb(maximized);
    },
  };
}
