import type {
  ApprovalOverlayState,
  ApprovalResult,
  AttachProgress,
  AutoReviewState,
  BranchList,
  CommitDescription,
  ContinueInterruptedResult,
  CreateSessionOpts,
  LogPage,
  LogQuery,
  OverlayEvent,
  RecordEvent,
  RenameSessionResult,
  RepoContextSnapshot,
  RepoEvent,
  ResolveApprovalOpts,
  ResumeEvent,
  RewindResult,
  SessionAgentEvent,
  SessionDeletedEvent,
  SessionExportSource,
  SessionMetadata,
  SessionSearchHit,
  SessionTopic,
  SteerTextResult,
  SubmitTextResult,
  TerminalRecord,
  TitleEvent,
  TurnLifecycleEvent,
  UndoEvent,
  UndoTarget,
  UndoTurnEditsResult,
  VoiceCueEvent,
  WorkingDiff,
  WorkspaceEvent,
} from "@herta/app-server";
import type { LiveToolSnapshot } from "../../shared/live-tool-feed.js";

/** One file's progress in an attach in flight, from main (2026-10-01). */
export interface AttachProgressEvent extends AttachProgress {
  readonly sessionId: string;
}

export type {
  LiveToolSnapshot,
  LiveToolView,
} from "../../shared/live-tool-feed.js";

/** A point-in-time snapshot of a session, returned by open/create and
 *  carried by the reset event. Mirrors the app-server Session's
 *  record + overlay snapshots plus identity. */
export interface SessionSnapshot {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly record: TerminalRecord;
  /** Long-session windowing (2026-07-12): `record` is the trailing
   *  RECORD_TAIL_BLOCKS window of the full record and this is the absolute
   *  index it starts at (= how many OLDER blocks exist, pageable via
   *  `recordSlice`). Optional on the wire — absent means 0 (the window is
   *  the whole record; older fixtures/fakes stay valid). */
  readonly recordStart?: number;
  readonly overlay: ApprovalOverlayState | null;
  /** Generated session title, or null when none exists yet. Optional on the
   *  wire (older fixtures omit it); the store normalizes a missing value to
   *  null. The main process always populates it. */
  readonly title?: string | null;
  /** The EFFECTIVE backend (板砖) workspace — the cwd the coding backend
   *  uses. Distinct from `workspaceRoot` (the immutable record-store anchor). */
  readonly backendWorkspace: string;
  /** True when `backendWorkspace` is still the managed-sandbox default. */
  readonly backendWorkspaceIsDefault: boolean;
  /** The session's topic history (the topic rail's jump targets). Optional
   *  on the wire — older fixtures omit it; absent means none. */
  readonly topics?: readonly SessionTopic[];
  /** The session's interaction language. Drives the user-facing 板砖→Brick
   *  alias (display + composer input) for the conversation, independent of the
   *  UI locale. Optional on the wire — older fixtures omit it; absent → "zh". */
  readonly lang?: "zh" | "en";
  /** The workspace's repository as probed so far (ADR 0058); null when it
   *  is not a repository or the first probe has not finished. Optional on
   *  the wire — older fixtures and fakes omit it. */
  readonly repo?: RepoContextSnapshot | null;
  /** Present while a turn is in flight: a window that reloads mid-turn
   *  learns it is busy — Stop, the hold window — instead of coming back idle
   *  over a running turn (UX review 2026-09-22, item 7). Absent = idle. */
  readonly turn?: { readonly backendActive: boolean };
  /** A 继续 is on offer (ADR 0071 §1.4): a reloaded window's strip comes
   *  back. Optional on the wire; absent = no offer. */
  readonly resumable?: boolean;
  /** The latest turn's edits can be taken back (ADR 0074 §4): a reloaded
   *  window's card keeps its 撤销 chip. Optional on the wire; absent = no. */
  readonly undoable?: boolean;
  /** Pictures staged in the composer and not yet sent (ADR 0048 §4): a
   *  reloaded window's strip comes back instead of vanishing while main
   *  still counts them. Optional on the wire; absent = none. */
  readonly stagedImages?: readonly StagedImageInfo[];
}

/** Carried by session:reset when bootstrap fails (e.g. no API key). */
export interface SessionError {
  readonly error: string;
}

/** Carried by session:reset when the app launches with no prior session history. */
export interface SessionNoSession {
  readonly noSession: true;
}

/** Returned by openSession when the clicked session's archive could not be
 *  loaded (e.g. a corrupt line in the JSONL). The previously-active session
 *  stays open and pointed — the failure needs a notice, not a teardown. */
export interface SessionOpenFailure {
  readonly openError: {
    /** `SessionFileErrorCode` (`corrupt-line`, `bad-header`, …) or "unknown". */
    readonly code: string;
    /** 1-based line number, present for corrupt-line failures. */
    readonly line?: number;
  };
}

/**
 * Carried by session:speech. The renderer receives `retract` (begin the
 * prefix-preserving morph) and `retractFloor` (the server-computed divergence
 * index where the backward erase should halt). `dropped` mirrors the
 * app-server overflow sentinel: the preload relays events verbatim, so it CAN
 * arrive, and the store must blank the live view on it (a lost `retract`
 * otherwise fuses vetoed + corrected text into one garbled bubble — see
 * SessionStore.onSpeech). Practically unreachable at chat scale (~2
 * events/turn against a deep bounded queue); defense in depth.
 */
export type SpeechControlEvent =
  | { readonly kind: "retract" }
  | { readonly kind: "retractFloor"; readonly keepLen: number }
  | { readonly kind: "dropped"; readonly count: number };

/** The user-facing Dream config (Settings → Dream). v1 = one enable flag. */
export interface DreamConfig {
  readonly enabled: boolean;
  /** On a read: what the RUNNING app was built with (the flag applies at the
   *  next start). Absent before bootstrap, from fakes, and on a write. */
  readonly running?: boolean;
}

/** Backend (差分协处理器) reasoning-effort tiers. DeepSeek's 2026-07-31 update
 *  gave flash all three; v4-pro maps a sent "low" to "high" server-side until
 *  its announced early-August-2026 update, so "low" is safe to persist now. */
export type BackendThinking = "low" | "high" | "max";

/** 板砖's model-facing tool contract (ADR 0040, 2026-08-17). */
export type BackendContractChoice = "standard" | "minimal";

/** The user-facing backend config (Settings → Coprocessor): the reasoning
 *  tier, and (ADR 0040) the tool contract. `contract` is optional so an older
 *  bridge that only knows the tier (the website demo) still type-checks; the
 *  row hides when it is absent. `bashFound` is read-side information from
 *  main — whether the minimal contract can actually run on this machine. */
export interface BackendConfig {
  readonly thinking: BackendThinking;
  readonly contract?: BackendContractChoice;
  readonly bashFound?: boolean;
}

/** The two DeepSeek models a stage can run on (2026-08-17; names per the
 *  2026-09 API: `deepseek-flash` is V4.1 Flash, which reads images, and
 *  `deepseek-v4-pro` retires on 2026-09-14). Exactly the names the
 *  completion endpoint accepts. */
export type ModelChoice = "deepseek-v4-pro" | "deepseek-flash";

/** Settings → DeepSeek → 模型: which model drives the actor (Herta's speech /
 *  thought / beats) and which drives 板砖. Both stages pick from the same two
 *  names since the flash reads images (ADR 0048 §5b) — the separate vision
 *  model is gone. Restart-to-apply. */
export interface ModelConfig {
  readonly actor: ModelChoice;
  readonly backend: ModelChoice;
}

/**
 * Herta's real-time-voice state (ADR 0042) for the Settings row. `enabled`
 * is the user's toggle; the rest is why it may still be silent — reported
 * rather than inferred, because "the toggle is on and she does not speak"
 * with no explanation is the worst version of this feature.
 */
export interface RealtimeVoiceState {
  readonly enabled: boolean;
  /** The model bundle is installed and complete. */
  readonly bundle: boolean;
  /** The native synthesis runtime was found. */
  readonly runtime: boolean;
  /** The worker failed repeatedly; voice is off until the app restarts. */
  readonly failed: boolean;
  /** The downloadable model's state (ADR 0061). `bundle` above may be true
   *  while this says `absent` in DEV (the workspace's own copy); a packaged
   *  app has no bundle but the downloaded one. */
  readonly model: VoiceModelState;
  /** Which engine speaks (ADR 0062): the local model, or the MiniMax clone
   *  on the user's own key. */
  readonly engine: VoiceEngine;
  /** The cloud engine's facts: the masked key status and the clone. */
  readonly minimax: MiniMaxState;
}

export type VoiceEngine = "local" | "minimax";

export type MiniMaxVoicePhase = "absent" | "preparing" | "ready" | "failed";

/** Why the clone could not be made — a key the row localizes (mirrors
 *  `MiniMaxVoiceError` in main). */
export type MiniMaxVoiceError =
  | "no_key"
  | "invalid_key"
  | "auth"
  | "rate"
  | "quota"
  | "sensitive"
  | "voice_missing"
  | "invalid"
  | "network"
  | "http"
  | "cancelled"
  | "other"
  | "reference"
  | "no_clone_key";

/** The MiniMax clone this install owns (ADR 0062). `preparing` covers the
 *  platform probe, the reference upload and the clone call. */
export interface MiniMaxVoiceState {
  readonly phase: MiniMaxVoicePhase;
  readonly error?: MiniMaxVoiceError;
  readonly voiceId?: string;
  readonly host?: string;
  readonly clonedAt?: string;
}

/** A refusal the platform answered a SPEECH unit with (ADR 0062 §5): the
 *  key was rejected or the account is out of balance, so the replies type
 *  unvoiced until the user acts. `key` is the one that spoke — the plan key
 *  when set, else the API key (mirrors `MiniMaxRefusal` in main). */
export interface MiniMaxRefusalState {
  readonly reason: "auth" | "invalid_key" | "quota";
  readonly key: "api" | "plan";
}

export interface MiniMaxState {
  /** The pay-as-you-go key: clones, and speaks when no plan key is set. */
  readonly key: DeepSeekKeyStatus;
  /** The token-plan key (ADR 0062 §1.8): speaks under the plan; cannot
   *  clone, but can adopt a clone the account already paid for. */
  readonly planKey: DeepSeekKeyStatus;
  readonly voice: MiniMaxVoiceState;
  /** The standing refusal for the key that speaks, or null. */
  readonly refusal: MiniMaxRefusalState | null;
}

/** What storing a MiniMax key answers: `rejected` when neither platform
 *  accepts it, `unverified` when the check could not run and the key was
 *  stored anyway. */
export type SetKeyResult =
  | {
      readonly ok: true;
      readonly encrypted: boolean;
      readonly unverified: boolean;
      readonly status: DeepSeekKeyStatus;
    }
  | { readonly ok: false; readonly reason: "rejected" };

export type VoiceModelPhase = "absent" | "downloading" | "ready" | "failed";

/** Why a model download did not end in a bundle — a key the row
 *  localizes (mirrors `VoiceModelFailure` in main's voice-model.ts). */
export type VoiceModelFailure =
  | "network"
  | "http"
  | "size"
  | "hash"
  | "archive"
  | "verify"
  | "disk"
  | "cancelled";

/**
 * The voice model as a download (ADR 0061): not in the installer, fetched
 * on the user's say-so from Settings → Voice, verified against the hash the
 * app carries. `totalBytes` is the archive; `unpackedBytes` what it becomes
 * on disk (the number the row quotes).
 */
export interface VoiceModelState {
  readonly phase: VoiceModelPhase;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly unpackedBytes: number;
  readonly error?: VoiceModelFailure;
}

/** The UI chrome language (Settings → Language). */
export type Locale = "zh" | "en";

/** The interaction-language CHOICE (Settings → Language, slice 4): an
 *  explicit language, or "follow" = follow the UI locale (the stored field
 *  is absent). Distinct from the RESOLVED "zh" | "en" the server threads
 *  into new sessions. */
export type InteractionLanguageChoice = "zh" | "en" | "follow";

/** The composer's @-mention list (ADR 0072 §2): workspace-relative paths
 *  with `/`, and whether a cap cut the list short. */
export interface WorkspaceFileList {
  readonly files: readonly string[];
  readonly truncated: boolean;
}

/** Settings → Window's attention rows (ADR 0072 §1). */
export interface AttentionSettings {
  /** OS notifications while the window is not attended. */
  readonly notifications: boolean;
  /** Keep the machine awake while 板砖 runs. */
  readonly keepAwake: boolean;
}

/**
 * Renderer-facing auto-update state (2026-07-10), streamed over
 * `update:state` and snapshotted via getUpdateState. `version` is the
 * REMOTE version once known; `progress` is 0-100 while downloading.
 * Automatic check failures stay `idle` (a private feed / offline user must
 * not be nagged); only a MANUAL Settings check surfaces `error`.
 */
export interface UpdateState {
  readonly phase: /** Nothing to report — NEVER CHECKED, auto-update off, unsupported build,
   *  or an automatic check that failed silently. Deliberately distinct from
   *  `up-to-date` (audit 2026-07-24, 1.13): the renderer used to print
   *  "已是最新 / Up to date" for this, an affirmative claim about the
   *  installed version made from a state that only ever meant "no news".
   *  A user offline or behind a blocked feed for weeks was told they were
   *  current. */
    | "idle"
    /** A check COMPLETED and the feed reported no newer version. */
    | "up-to-date"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "error";
  readonly version?: string;
  readonly progress?: number;
  readonly message?: string;
  /** On `error`: the feed could not be REACHED at all (offline, a blocked
   *  region), as opposed to an answer it gave — the pane points at the
   *  network, the VPN and the netdisk instead of printing the error. Set on
   *  the automatic path too (2026-09-09). */
  readonly network?: boolean;
  /** This install cannot update itself: a Linux build run outside an
   *  AppImage (a distro package under /opt, an extracted AppImage), where
   *  electron-updater answers every check with nothing at all. The pane says
   *  "updates unavailable here" instead of offering a check that silently
   *  never reports (platform review 2026-09-23). */
  readonly unsupported?: boolean;
}

/** Masked DeepSeek key status for the renderer (Settings → DeepSeek). The raw
 *  key never crosses IPC — only whether one is set, its last-4 `hint`, and
 *  whether it is stored encrypted. The GUI reads the key from the secure store
 *  only, so `set` is the whole truth (no env / legacy-file sources). */
export interface DeepSeekKeyStatus {
  readonly set: boolean;
  readonly hint: string | null;
  readonly encrypted: boolean;
}

/** One picture waiting in the composer (ADR 0048 §4). `path` is
 *  workspace-relative — the renderer turns it into a `herta-attachment://`
 *  URL to draw, and never learns an absolute filesystem path. */
export interface StagedImageInfo {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Reply from `readWorkspaceFile` (ADR 0050 §2): the viewer panel's one
 * bounded, workspace-jailed read. `truncated` means `content` is a prefix
 * of a file whose whole size is `size` — the panel says so and offers 打开.
 */
export type ReadWorkspaceFileReply =
  | {
      readonly ok: true;
      readonly content: string;
      readonly truncated: boolean;
      readonly size: number;
      /** Workspace-relative, forward slashes — the breadcrumb's text. */
      readonly relative: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "not_found"
        | "not_a_file"
        | "outside_workspace"
        | "binary"
        | "unreadable"
        | "no_session";
    };

/**
 * Reply from `readWorkspaceBytes` (ADR 0054 §2): the rich kinds' read —
 * the whole file as bytes through the same jail, refused over the 64 MB
 * ceiling. No truncation: a cut ZIP or PDF is garbage, not a preview.
 */
export type ReadWorkspaceBytesReply =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly size: number;
      readonly relative: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "not_found"
        | "not_a_file"
        | "outside_workspace"
        | "too_large"
        | "unreadable"
        | "no_session";
    };

/**
 * Reply from `readWorkspaceCommit` (ADR 0059): one commit of the session's
 * repository for the viewer's commit tab. `not_found` covers what git
 * cannot show — an unknown or ambiguous id, no repository; `timeout` is a
 * read the clock ended (ADR 0058 §7.7): unknown, worth a retry.
 */
export type ReadWorkspaceCommitReply =
  | { readonly ok: true; readonly commit: CommitDescription }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "timeout" | "no_session";
    };

/**
 * Reply from `readWorkspaceDiff` (ADR 0059 §5): one workspace path's
 * working-tree change against HEAD for the viewer's diff tab. Jailed like
 * the file reads — `outside_workspace` for a path that resolves outside.
 */
export type ReadWorkspaceDiffReply =
  | { readonly ok: true; readonly diff: WorkingDiff }
  | {
      readonly ok: false;
      readonly reason:
        | "not_found"
        | "timeout"
        | "outside_workspace"
        | "no_session";
    };

/** Reply from `readWorkspaceLog` (ADR 0059 §6): one page of history. */
export type ReadWorkspaceLogReply =
  | { readonly ok: true; readonly page: LogPage }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "timeout" | "no_session";
    };

/** Reply from `readWorkspaceBranches` (ADR 0059 §6): the branch list for
 *  the history tab's read-only picker. */
export type ReadWorkspaceBranchesReply =
  | { readonly ok: true; readonly branches: BranchList }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "timeout" | "no_session";
    };

/** Reply from `stageImages`. Per-file refusals ride `rejected` so one bad
 *  item never discards its siblings; only whole-action failures use `ok:
 *  false` with a message, like every other command here. */
export type StageImagesReply =
  | {
      readonly ok: true;
      readonly staged: readonly StagedImageInfo[];
      readonly rejected: readonly {
        readonly name: string;
        readonly reason: string;
      }[];
    }
  | { readonly ok: false; readonly message?: string };

/**
 * The typed surface the preload exposes to the renderer as
 * `window.herta`. Commands round-trip through ipcRenderer.invoke;
 * `on*` register ipcRenderer.on listeners and return an unsubscribe.
 */
export interface HertaBridge {
  /** The OS platform (process.platform in the preload). The renderer gates
   *  the custom window controls on it — macOS keeps its native traffic
   *  lights, so the buttons render only elsewhere. */
  readonly platform: string;
  /** `stagedImageIds` sends the pictures waiting in the composer with this
   *  message (ADR 0048 §4); their record blocks land right after the user
   *  block, inside the turn's span. */
  submitText(
    text: string,
    stagedImageIds?: readonly string[],
  ): Promise<SubmitTextResult>;
  interrupt(turnId?: string): Promise<{ readonly ok: boolean }>;
  /** A message while 板砖 works (ADR 0063): `accepted` means the text is in
   *  the record and reaches the coprocessor at its next step; `queued` means
   *  there was no step to reach and the composer keeps holding the text for
   *  the next turn. OPTIONAL — fakes and the website demo omit it, and the
   *  held strip then offers no steer. */
  steerText?(text: string): Promise<SteerTextResult>;
  /** 继续 (ADR 0071 §1.4): continue the interrupted 板砖 run. Resolves when
   *  the turn has ended, like `submitText`; never rejects. OPTIONAL with
   *  `onResume` — fakes and the website demo omit them, and no strip shows. */
  continueInterrupted?(): Promise<ContinueInterruptedResult>;
  /** Whether a 继续 is on offer changed. */
  onResume?(cb: (e: ResumeEvent) => void): () => void;
  /** Withdraw the latest 开拓者 turn (record-only, idle-only). Resolves with the
   *  withdrawn user text to restore into the composer, or a failure reason.
   *  `sessionId` binds the destructive call to the session the user clicked in:
   *  main rejects a mismatch with the active session (the click's 220ms
   *  withdraw animation races a session switch — an unbound rewind then
   *  truncated the WRONG session's latest turn). */
  rewindLastTurn(sessionId: string): Promise<RewindResult>;
  /** Take a turn's edits back (ADR 0074): `latest` from its card's 撤销,
   *  `withdrawn` from the rewind notice's 撤销改动. Bound to `sessionId` like
   *  the rewind. OPTIONAL with `onUndo` — fakes and the website demo omit
   *  them, and no chip shows. */
  undoLastTurnEdits?(
    sessionId: string,
    target: UndoTarget,
  ): Promise<UndoTurnEditsResult>;
  /** Whether the latest turn can be undone changed. */
  onUndo?(cb: (e: UndoEvent) => void): () => void;
  /** Fire-and-forget: a successful 板砖-card lift may play the easter-egg voice.
   *  The active session owns the 50% roll + per-session hourly throttle. */
  maybePlayEasterEgg(): Promise<void>;
  listSessions(): Promise<readonly SessionMetadata[]>;
  /** Content search over persisted transcripts (dialogue only — user + Herta
   *  speech). Returns bounded hits with a preview snippet for the sidebar
   *  card. OPTIONAL so existing bridge fakes keep compiling — the sidebar
   *  degrades to title-only filtering without it. */
  searchSessions?(query: string): Promise<readonly SessionSearchHit[]>;
  /** Long-session windowing: fetch up to `count` record blocks ENDING at
   *  absolute index `before` (exclusive) for the active session — the store's
   *  "load earlier" paging. Resolves `{ start, blocks }` where `start` is the
   *  absolute index of `blocks[0]`; an empty slice means nothing older / a
   *  session mismatch. OPTIONAL so bridge fakes keep compiling — the load-
   *  earlier affordance hides without it. */
  recordSlice?(
    sessionId: string,
    before: number,
    count: number,
  ): Promise<{ readonly start: number; readonly blocks: TerminalRecord }>;
  /** Both resolve `null` when main has no session host (bootstrap failed) or
   *  the open/create could not produce a session — the previous non-null
   *  claim hid the failure path from callers. openSession additionally
   *  resolves a `SessionOpenFailure` when the session file itself failed to
   *  load (corrupt archive); the active session survives that. */
  openSession(
    sessionId: string,
  ): Promise<SessionSnapshot | SessionOpenFailure | null>;
  createSession(opts: CreateSessionOpts): Promise<SessionSnapshot | null>;
  deleteSession(
    sessionId: string,
  ): Promise<{ readonly ok: boolean; readonly wasActive: boolean }>;
  /** Name a session by hand, open or not (ADR 0072 §3). Resolves the title
   *  as kept (cleaned: one line, capped), or `ok: false`. OPTIONAL — the
   *  sidebar's menu offers no rename without it. */
  renameSession?(
    sessionId: string,
    title: string,
  ): Promise<RenameSessionResult>;
  /** What an export is built from (ADR 0072 §3): the record as the window
   *  shows it, the title and the session's language. Null when the session
   *  cannot be read. OPTIONAL with `saveSessionExport`. */
  readSessionForExport?(sessionId: string): Promise<SessionExportSource | null>;
  /** Show the save dialog and write the export. `saved: false` when the
   *  user cancelled or the write failed (`failed` says which). */
  saveSessionExport?(
    fileName: string,
    markdown: string,
  ): Promise<{ readonly saved: boolean; readonly failed?: boolean }>;
  resolveApproval(opts: ResolveApprovalOpts): Promise<ApprovalResult>;
  /** Automatic review (ADR 0075, which replaced workspace trust) for the
   *  ACTIVE session's workspace. OPTIONAL like the rule pair; the device
   *  card's menu hides the row without it. */
  getAutoReview?(): Promise<AutoReviewState>;
  /** Record the owner's choice for this workspace (null → back to the
   *  default); resolves with the state after the change. */
  setAutoReview?(on: boolean | null): Promise<AutoReviewState>;
  /** Fire-and-forget record heal: ask main to re-emit the active session's
   *  full record as a `reset` through the record stream. Called by the store
   *  when a record-channel `dropped` overflow sentinel arrives (a block was
   *  lost; the mirror has a permanent hole otherwise). OPTIONAL so existing
   *  bridge fakes keep compiling — the store no-ops without it. */
  resyncRecord?(): Promise<void>;
  /** Ask main to send the current `session:reset` again — what the store
   *  calls once it has subscribed. Main pushes the reset on the page's
   *  did-finish-load, which after a RELOAD can run before this page's
   *  store subscribes: the push was lost and the window showed no session
   *  at all over a running one (UX review 2026-09-22, item 7). Main answers
   *  nothing before its host exists; the bootstrap's own reset follows.
   *  OPTIONAL like `resyncRecord`. */
  requestSessionSync?(): Promise<void>;
  /** Auto-update surface (2026-07-10). All OPTIONAL so bridge fakes and the
   *  website demo keep compiling — the UI hides without them. Check is
   *  manual (Settings); state also streams via onUpdate. */
  checkForUpdate?(): Promise<void>;
  /** Quit + install a `ready` update (rides the before-quit flush hold). */
  restartAndInstall?(): Promise<void>;
  /** The current update state (invoke-time snapshot for late subscribers). */
  getUpdateState?(): Promise<UpdateState>;
  /** The app's own version, for the Settings pane. */
  getAppVersion?(): Promise<string>;
  onUpdate?(cb: (e: UpdateState) => void): () => void;
  pickWorkspace(): Promise<string | null>;
  setWorkspace(
    sessionId: string,
    workspacePath: string,
  ): Promise<{ readonly ok: boolean; readonly message?: string }>;
  /** Mirrors `setWorkspace`'s result shape: main already returns a `message`
   *  on refusal ("a turn is in progress" / "no matching active session"), and
   *  the renderer needs it to surface the refusal instead of no-opping
   *  silently (audit 2026-07-24, M6). */
  resetWorkspace(
    sessionId: string,
  ): Promise<{ readonly ok: boolean; readonly message?: string }>;
  /** Open the OS file picker for documents (ADR 0033). Null when cancelled. */
  pickAttachments(): Promise<readonly string[] | null>;
  /** Ingest documents into the session. Same refusal shape as setWorkspace —
   *  the renderer must surface it rather than no-op silently. */
  attachFiles(
    sessionId: string,
    paths: readonly string[],
  ): Promise<{ readonly ok: boolean; readonly message?: string }>;
  /** Take back an attached document: deletes the stored file and marks its
   *  record block removed. Same refusal shape as attachFiles. */
  removeAttachment(
    sessionId: string,
    path: string,
  ): Promise<{ readonly ok: boolean; readonly message?: string }>;
  /**
   * Stage pictures in the composer (ADR 0048 §4): stored and captioning now,
   * appended to the record only when the message is sent — so the × before
   * sending truly un-happens it, and the caption cost hides under typing.
   *
   * Takes a path (picker, drop) OR raw bytes (paste — a clipboard screenshot
   * has no path at all). Non-images come back in `rejected` with reason
   * `not_image`; the caller routes those to `attachFiles`, which is still the
   * document path.
   */
  stageImages(
    sessionId: string,
    inputs: readonly {
      readonly path?: string;
      readonly bytes?: Uint8Array;
      readonly name?: string;
    }[],
  ): Promise<StageImagesReply>;
  /** Drop a staged picture and delete its stored copy. */
  unstageImage(sessionId: string, id: string): Promise<boolean>;
  /** The file-viewer panel's read (ADR 0050): bounded, jailed to the
   *  session's effective workspace. OPTIONAL so existing bridge fakes keep
   *  compiling — the file names simply aren't clickable without it. */
  readWorkspaceFile?(
    sessionId: string,
    path: string,
  ): Promise<ReadWorkspaceFileReply>;
  /** The composer's @-mention list (ADR 0072 §2): the files of the session's
   *  effective workspace, bounded; null when the session is not the active
   *  one. OPTIONAL — without it `@` completes only `@板砖`. */
  listWorkspaceFiles?(sessionId: string): Promise<WorkspaceFileList | null>;
  /** The rich kinds' read (ADR 0054 §2): bytes for pictures, PDFs and
   *  Office files, same jail, 64 MB ceiling. Optional like its sibling. */
  readWorkspaceBytes?(
    sessionId: string,
    path: string,
  ): Promise<ReadWorkspaceBytesReply>;
  /** The viewer's commit tab (ADR 0059): one commit of the session's
   *  repository — message, author, files with counts, the patch. `ref` is a
   *  hex commit id. Optional like its siblings; the sha stays plain text
   *  without it. */
  readWorkspaceCommit?(
    sessionId: string,
    ref: string,
  ): Promise<ReadWorkspaceCommitReply>;
  /** The viewer's diff tab (ADR 0059 §5): one path's working-tree change
   *  against HEAD, same jail as the file reads. Optional like its siblings;
   *  a dirty row then opens the file instead. */
  readWorkspaceDiff?(
    sessionId: string,
    path: string,
  ): Promise<ReadWorkspaceDiffReply>;
  /** The viewer's log tab (ADR 0059 §6): a page of a ref's history (HEAD
   *  by default), newest first, unpushed commits marked, optionally
   *  filtered by message. Optional like its siblings; the card's list then
   *  has no "all commits" opener. */
  readWorkspaceLog?(
    sessionId: string,
    opts: LogQuery,
  ): Promise<ReadWorkspaceLogReply>;
  /** The history tab's read-only branch picker (ADR 0059 §6). Optional;
   *  without it the tab shows HEAD's history alone. */
  readWorkspaceBranches?(
    sessionId: string,
  ): Promise<ReadWorkspaceBranchesReply>;
  /** The viewer's 打开 button: open the jailed path with the OS default
   *  application (shell.openPath). False when refused/missing. */
  openWorkspaceFile?(sessionId: string, path: string): Promise<boolean>;
  /** The real filesystem path of a dropped `File`. Electron 43 removed
   *  `File.path`, so only the preload can answer this — the renderer never
   *  holds a File beyond the drop handler. */
  pathForFile(file: File): string;
  /** Read the persisted Dream config (Settings → Dream). */
  getDreamConfig(): Promise<DreamConfig>;
  /** Persist the Dream config. Restart-to-apply (the running app-server reads
   *  it at the next bootstrap). */
  setDreamConfig(cfg: DreamConfig): Promise<void>;
  /** Read the persisted backend reasoning effort (Settings → Coprocessor).
   *  OPTIONAL — fakes and the website demo omit it; the settings row hides
   *  with it (same contract as the interaction-language pair). */
  getBackendConfig?(): Promise<BackendConfig>;
  /** Persist the backend reasoning effort. Restart-to-apply (buildConfig
   *  reads it at the next bootstrap). Optional alongside getBackendConfig. */
  setBackendConfig?(cfg: BackendConfig): Promise<void>;
  /** Read the persisted per-stage model choice (Settings → DeepSeek → 模型,
   *  2026-08-17). OPTIONAL like the backend-config pair; the rows hide with
   *  it. */
  getModelConfig?(): Promise<ModelConfig>;
  /** Persist the per-stage model choice. Restart-to-apply. */
  setModelConfig?(cfg: ModelConfig): Promise<void>;
  /** Read the resolved UI language (stored choice, else OS-derived). */
  getLocale(): Promise<Locale>;
  /** Persist the UI language. Live — the renderer re-renders immediately; this
   *  only writes the per-user preference for the next launch. */
  setLocale(locale: Locale): Promise<void>;
  /** Read the STORED interaction-language choice (Settings → Language,
   *  slice 4): "zh" / "en" when explicitly set, else "follow" (follow the UI
   *  locale). OPTIONAL — fakes and the website demo omit it and the row
   *  hides with it. */
  getInteractionLanguage?(): Promise<InteractionLanguageChoice>;
  /** Persist the interaction-language choice; "follow" DELETES the stored
   *  field. Applies to NEW sessions only (per-session static prefix +
   *  prompt cache) — running sessions keep their language. */
  setInteractionLanguage?(choice: InteractionLanguageChoice): Promise<void>;
  /** Read whether the close button hides the app to the system tray
   *  (Settings → Window). Default true. */
  getCloseToTray(): Promise<boolean>;
  /** Persist + LIVE-apply the close-to-tray behavior (main updates its
   *  window close handler immediately — no restart). */
  setCloseToTray(enabled: boolean): Promise<void>;
  /** Read the attention settings (Settings → Window, ADR 0072 §1): OS
   *  notifications while the window is not attended, and keeping the
   *  machine awake while 板砖 runs. Both default on. OPTIONAL — fakes and
   *  the website demo omit it, and the rows hide with it. */
  getAttention?(): Promise<AttentionSettings>;
  /** Persist + LIVE-apply either or both attention settings. */
  setAttention?(prefs: Partial<AttentionSettings>): Promise<void>;
  /** Read whether AUTOMATIC update checks/downloads are enabled (Settings →
   *  Update; default true). OPTIONAL — fakes and the website demo omit it,
   *  and the toggle then hides with the rest of the update surface. */
  getAutoUpdate?(): Promise<boolean>;
  /** Persist + LIVE-apply the automatic-update toggle: off cancels the
   *  check cycle; a MANUAL check still downloads and installs on quit. */
  setAutoUpdate?(enabled: boolean): Promise<void>;
  /** Read the UI appearance preference (Settings → Window; default "light").
   *  OPTIONAL — fakes and the website demo omit it and stay light. */
  getTheme?(): Promise<ThemePref>;
  /** Persist the appearance preference; the renderer's theme controller
   *  applies it live (no restart). */
  setTheme?(theme: ThemePref): Promise<void>;
  /** Whether this host draws the 3D device card (ADR 0057) — the desktop
   *  answers true; the GPU probe decides the rest. No setting since
   *  2026-10-01 (§2.7 amended). OPTIONAL — fakes and the website demo omit
   *  it, and the card then stays on its flat renders. */
  getDeviceScene?(): Promise<boolean>;
  /** Read whether an attached PDF's pictures are transcribed (2026-10-01;
   *  Settings → 差分协处理器). Default on. OPTIONAL — fakes and the website
   *  demo omit it, and the row hides. */
  getPdfPictureTranscripts?(): Promise<boolean>;
  /** Persist the switch; main applies it to the next attach, no restart. */
  setPdfPictureTranscripts?(enabled: boolean): Promise<void>;
  /** Read whether the composer offers a predicted next message (2026-10-10;
   *  Settings → 窗口). Default on. OPTIONAL — fakes and the website demo
   *  omit it, and the row hides. */
  getComposerPredictions?(): Promise<boolean>;
  /** Persist the switch; main applies it from the next finished turn. */
  setComposerPredictions?(enabled: boolean): Promise<void>;
  /** Read Herta's real-time-voice state (ADR 0042): whether the user has it
   *  ON, and whether it can run here at all — `available` folds in the model
   *  bundle, the native runtime, and a worker that has failed for good, so
   *  the Settings row can say WHY it is silent instead of lying. OPTIONAL —
   *  fakes and the website demo omit the pair and the row hides with it. */
  getRealtimeVoice?(): Promise<RealtimeVoiceState>;
  /** Persist the real-time-voice toggle. LIVE: the synthesizer reads it at
   *  every speech stream's start, so it applies to the next reply. */
  setRealtimeVoice?(enabled: boolean): Promise<void>;
  /** Start downloading the voice model (ADR 0061); resolves with the state
   *  the download ENDED in (ready, failed, or absent after a cancel).
   *  Progress streams through `onVoiceModel`. OPTIONAL — the website demo
   *  and fakes omit the set, and the model row hides with it. */
  downloadVoiceModel?(): Promise<VoiceModelState>;
  /** Abort a running download; the partial file is discarded. */
  cancelVoiceModelDownload?(): Promise<void>;
  /** Delete the downloaded model (stops the voice worker first). */
  removeVoiceModel?(): Promise<VoiceModelState>;
  /** The model's live state — every phase change and throttled progress. */
  onVoiceModel?(cb: (e: VoiceModelState) => void): () => void;
  /** Choose which engine speaks (ADR 0062). LIVE: read at the next stream's
   *  start; an utterance already speaking keeps its engine. */
  setVoiceEngine?(engine: VoiceEngine): Promise<void>;
  /** The MiniMax key, stored like the DeepSeek one: masked status only. */
  getMiniMaxKeyStatus?(): Promise<DeepSeekKeyStatus>;
  /** Check the key against the platform and store it; `rejected` when
   *  neither platform accepts it, `unverified` when the check could not
   *  run and the key was stored anyway. */
  setMiniMaxKey?(key: string): Promise<SetKeyResult>;
  clearMiniMaxKey?(): Promise<{
    readonly ok: true;
    readonly status: DeepSeekKeyStatus;
  }>;
  /** Open an https link in the OS browser — ONLY an allowlisted host
   *  (`shared/links.ts`): the netdisk mirror, GitHub, the key platforms.
   *  Anything else is refused by main. OPTIONAL — fakes and the website
   *  demo omit it, and the links then do not render. */
  openExternal?(url: string): Promise<void>;
  /** The token-plan key (ADR 0062 §1.8), stored and checked like the
   *  pay-as-you-go one. Optional alongside it. */
  getMiniMaxPlanKeyStatus?(): Promise<DeepSeekKeyStatus>;
  setMiniMaxPlanKey?(key: string): Promise<SetKeyResult>;
  clearMiniMaxPlanKey?(): Promise<{
    readonly ok: true;
    readonly status: DeepSeekKeyStatus;
  }>;
  /** Make the clone from the shipped reference; resolves with the state it
   *  ended in. Progress rides `onMiniMaxVoice`. */
  prepareMiniMaxVoice?(): Promise<MiniMaxVoiceState>;
  onMiniMaxVoice?(cb: (e: MiniMaxVoiceState) => void): () => void;
  /** A speech refusal recorded (the reason and the key) or cleared (null)
   *  mid-reply (ADR 0062 §5); the row re-reads the voice state on it. */
  onMiniMaxSpeech?(cb: (e: MiniMaxRefusalState | null) => void): () => void;
  /** Read the masked DeepSeek key status (Settings → DeepSeek). */
  getDeepSeekKeyStatus(): Promise<DeepSeekKeyStatus>;
  /** Validate a DeepSeek key (a cheap token-free auth check), and on success
   *  store it (secure store) + apply it live to the running session — the next
   *  turn uses it, no restart. A rejected key is NOT stored. `unverified` is
   *  true when the key was stored without confirmation (the check couldn't reach
   *  DeepSeek — offline). */
  setDeepSeekKey(key: string): Promise<
    | {
        readonly ok: true;
        readonly encrypted: boolean;
        readonly status: DeepSeekKeyStatus;
        readonly unverified: boolean;
      }
    | { readonly ok: false; readonly reason: "rejected" }
  >;
  /** Delete the stored DeepSeek key (live — the next send re-prompts). */
  clearDeepSeekKey(): Promise<{
    readonly ok: true;
    readonly status: DeepSeekKeyStatus;
  }>;
  /** Custom caption buttons (the native titleBarOverlay was dropped — its
   *  Chromium-drawn buttons showed unremovable, doubled hover tooltips on
   *  Windows; user 2026-07-06). `windowClose` goes through win.close(), so
   *  the close-to-tray setting applies exactly like the old native button. */
  windowMinimize(): void;
  windowToggleMaximize(): void;
  windowClose(): void;
  /** Current maximize state, for the max/restore glyph on renderer reload. */
  windowIsMaximized(): Promise<boolean>;
  /** Fires on the window's maximize/unmaximize — drives the glyph swap. */
  onWindowMaximized(cb: (maximized: boolean) => void): () => void;
  /** Current full-screen state, and its changes (2026-09-23): macOS hides
   *  the traffic lights in full screen, so the top bar stops reserving room
   *  for them. OPTIONAL — fakes and the website demo omit the pair. */
  windowIsFullScreen?(): Promise<boolean>;
  onWindowFullScreen?(cb: (fullScreen: boolean) => void): () => void;
  /** The application menu's Settings… item (Cmd+, on macOS). OPTIONAL. */
  onOpenSettings?(cb: () => void): () => void;
  onWorkspace(cb: (e: WorkspaceEvent) => void): () => void;
  /** The workspace's repository state (ADR 0058) — the rail's repository
   *  card. OPTIONAL: fakes and the website demo omit the pair, and the card
   *  then never mounts. */
  onRepo?(cb: (e: RepoEvent) => void): () => void;
  /** The live views of 板砖's call in flight (ADR 0073) — the file it is
   *  writing, the command's output — folded and throttled in main. OPTIONAL:
   *  fakes and the website demo omit it, and the trace card then shows the
   *  record's rows alone. */
  onLive?(cb: (e: LiveToolSnapshot) => void): () => void;
  /** How far an attach in flight has got, per file (2026-10-01) — the
   *  pending row's hairline. OPTIONAL: fakes and the website demo omit it,
   *  and a pending row then shows its files without counts. */
  onAttachProgress?(cb: (e: AttachProgressEvent) => void): () => void;
  /** Ask the active session to probe its repository again; the answer
   *  arrives through `onRepo`. The card asks on window focus. */
  refreshRepo?(): Promise<void>;
  onRecord(cb: (e: RecordEvent) => void): () => void;
  onOverlay(cb: (e: OverlayEvent) => void): () => void;
  onSpeech(cb: (e: SpeechControlEvent) => void): () => void;
  onAgent(cb: (e: SessionAgentEvent) => void): () => void;
  onTurn(cb: (e: TurnLifecycleEvent) => void): () => void;
  onReset(
    cb: (e: SessionSnapshot | SessionError | SessionNoSession) => void,
  ): () => void;
  onTitle(cb: (e: TitleEvent) => void): () => void;
  onSessionDeleted(cb: (e: SessionDeletedEvent) => void): () => void;
  /** Voice-clip autoplay cues (opening voice; more categories later). */
  onVoice(cb: (e: VoiceCueEvent) => void): () => void;
  /** Main refused a tray-initiated navigation because a turn is in flight
   *  (2026-07-13): the window fronts and the renderer ARMS the matching
   *  two-step confirm — the target session's amber badge, or the top-bar
   *  new-session icon for `target: null` — so the refusal explains itself.
   *  Optional: only the Electron preload emits it (demo/mock bridges have
   *  no tray). */
  onNavBlocked?(cb: (e: NavBlockedEvent) => void): () => void;
}

/** A main-side navigation refusal (tray menu, mid-turn). `target` is the
 *  session the tray tried to open, or null for a new-chat attempt. */
export interface NavBlockedEvent {
  readonly target: string | null;
}

/** UI appearance preference (night-mode slice 2). "system" follows the OS
 *  via prefers-color-scheme, resolved live by the theme controller. */
export type ThemePref = "light" | "dark" | "system";

// The `window.herta` global augmentation lives in the renderer-only
// ambient declaration `../herta-window.d.ts`. This file stays free of
// any DOM (`Window`) dependency so the Electron main + preload projects
// (which have no DOM lib) can import these IPC contract types directly.
