import type {
  AgentEvent,
  ApprovalOverlayState,
  RepoContextSnapshot,
  SessionTopic,
  TerminalRecord,
  TerminalRecordBlock,
  UndoFileResult,
  WorkspaceTrust,
} from "@herta/core";
import type {
  BranchList,
  CommitDescription,
  GitReadTimeout,
  LogPage,
  LogQuery,
  WorkingDiff,
} from "@herta/tools";
import type { SessionSearchHit } from "./session-search.js";

// ───── Configuration ─────

/**
 * Resolved configuration for `createSessionHost`. All values are
 * caller-resolved — the app-server never reads `process.env` or disk
 * for configuration. CLI's main.ts (when/if it migrates) and Electron
 * main (Slice 3+) each build this themselves before construction.
 *
 * See design doc §8.
 */
export interface AppServerConfig {
  /** Absolute. Workspace this app-server serves. */
  readonly workspaceRoot: string;
  /** Absolute. Where `<sessionId>.jsonl` files live. Typically
   *  `<workspaceRoot>/.herta/transcript/v2`. */
  readonly transcriptDir: string;
  /** Absolute. When set, every model call's token usage — as the API states
   *  it, prompt-cache hits included; numbers only — is appended to this
   *  JSONL file (`usage-log.ts`). Unset: nothing is recorded. */
  readonly usageLogPath?: string;
  /** Absolute. Project-scoped memory dir. Typically
   *  `<workspaceRoot>/.herta/memory`. */
  readonly projectMemoryDir: string;
  /** Absolute. User-scoped memory dir. Typically `~/.herta/memory`. */
  readonly userMemoryDir: string;
  /** Absolute. 废案 narrative corpus root. Typically
   *  `<workspaceRoot>/.herta/narrative`. */
  readonly narrativeDir: string;
  /** Absolute. Voice-clip root (openings/, particle/, veto/, easter_egg/).
   *  Dev default `<workspaceRoot>/data/voice`; a PACKAGED app points this at
   *  its bundled resources copy (the clips ship with the app — user decision
   *  2026-07-06; the canon corpus and knowledge DB deliberately do NOT).
   *  Optional: absent falls back to the dev default, so manually-built test
   *  configs keep working. All voice reads are best-effort — a missing dir
   *  just means voice features never fire. */
  readonly voiceAssetsDir?: string;
  readonly providers: {
    readonly deepseekApiKey: string;
    /** DeepSeek completion model used by the actor. */
    readonly actorModel: string;
    /** DeepSeek chat model used by the coding backend. */
    readonly backendModel: string;
    /** DeepSeek chat model (with thinking) used by the mood router. */
    readonly routerModel: string;
    /** Optional API base override for the TURN-path providers (actor,
     *  backend, router/supervisor/recap, title) — a dev-only chaos/staging
     *  lever (E2E-4 failure injection: point at a local proxy that drops
     *  streams or stalls endpoints). The GUI populates it from
     *  HERTA_DEEPSEEK_BASE_URL ONLY in unpackaged runs (same credential-
     *  safety gating as HERTA_UPDATE_URL, audit T1.3: honoring it in a
     *  packaged build would let any env-setting process redirect the API
     *  key to an arbitrary host). The dream pass's own client is NOT
     *  covered — dream failure paths are dream-lab territory. */
    readonly baseUrl?: string;
  };
  /** Backend reasoning effort. Per the official DeepSeek doc (2026-09-10)
   *  both `deepseek-flash` and `deepseek-v4-pro` accept "low" | "high" |
   *  "max"; thinking is on by default at "high". "off" sends the thinking
   *  block disabled. Settings → Coprocessor persists this (GUI,
   *  restart-to-apply); default "high". */
  readonly thinking?: "low" | "high" | "max" | "off";
  /**
   * 板砖's model-facing tool contract (ADR 0040). `standard` (default) = the
   * 15-tool set + BACKEND_EXECUTION_CONTRACT; `minimal` = persistent `bash`
   * + `str_replace_editor` (+ report_finding / show_excerpt) with the short
   * 板砖 prompt. `minimal` requires a bash on the machine (`findBash()`);
   * when none is found the session falls back to `standard` and projects a
   * `→ 系统` line saying so. Settings → 差分协处理器 persists this
   * (GUI, restart-to-apply).
   */
  readonly backendContract?: "standard" | "minimal";
  /** Supervisor quality gate. Default ENABLED — since M-prompts-1
   *  (2026-07-05) this config flag replaces the old
   *  `.herta/narrative/supervisor_reference.txt` existence-toggle. */
  readonly supervisor?: {
    readonly enabled?: boolean;
  };
  readonly dream?: {
    readonly enabled?: boolean;
    readonly idleMs?: number;
    readonly cooldownMs?: number;
    readonly minRetryMs?: number;
    readonly minNewSessions?: number;
    readonly minSessionHertaTurns?: number;
  };
  /**
   * Herta's synthesized voice (ADR 0042). The host owns the synthesizer —
   * in the desktop app a utility process running the Kokoro model — and
   * every session's streaming sink asks it, at each speech stream's start,
   * whether it is `available()`; when it is, the reveal is VOICED: sentence
   * units are synthesized as they arrive and the text types in lockstep
   * with the audio. Absent (the CLI, tests) → the paced text reveal, byte-
   * identical to before.
   */
  readonly speech?: {
    readonly synthesizer: SpeechSynthesizer;
  };
}

// ───── Speech synthesis (ADR 0042) ─────

/** One unit of Herta's prose to synthesize — the speakable form of a
 *  sentence-sized span (see voice/speakable-text.ts). `seq` orders units
 *  within an utterance; the synthesizer may cancel by `utteranceId`. */
export interface SynthesisRequest {
  readonly utteranceId: string;
  readonly seq: number;
  readonly text: string;
  readonly lang: "zh" | "en";
  /** `low`: synthesize when nothing else is queued — the veto reaction's
   *  filler (ADR 0042 §7b), armed as early as the reply's first unit is in
   *  flight and never allowed ahead of the reply's own sentences. Absent
   *  = the reply's units, in order. */
  readonly priority?: "low";
}

/** Mono PCM for one unit. Int16 so it crosses IPC compactly (24 kHz mono ≈
 *  48 KB/s); the renderer converts for Web Audio. */
export interface SynthesizedAudio {
  readonly samples: Int16Array;
  readonly sampleRate: number;
  readonly durationMs: number;
}

/**
 * The host-side speech synthesizer the sink drives. Surface-agnostic: the
 * app-server never loads a model — it only asks for audio and reports what
 * to play. Contract:
 *   - `available()` is read at every stream start (a live toggle, the model's
 *     presence, the worker's health all fold in); a stream that started
 *     voiced stays voiced even if this flips mid-way.
 *   - `synthesize` resolves the audio, or `null` when the request was
 *     cancelled or failed — the reveal then types that unit unvoiced at the
 *     read-along cadence rather than stalling (voice is never load-bearing
 *     for the record).
 *   - `cancel(utteranceId)` drops queued work for an utterance (a veto, an
 *     interrupt); in-flight native synthesis may finish and be discarded.
 */
export interface SpeechSynthesizer {
  available(): boolean;
  /** True when a request made now would pay no cold start: the local model
   *  is loaded, or the engine has none to load (a cloud voice). The voiced
   *  reveal reads it at a stream's first request — a warm engine's first
   *  unit is held to the same liveness cap as any later one (ADR 0042 §7d).
   *  Absent reads as cold: the head keeps its own, longer rules. */
  warm?(): boolean;
  synthesize(req: SynthesisRequest): Promise<SynthesizedAudio | null>;
  cancel(utteranceId: string): void;
}

// ───── Session lifecycle opts/result ─────

export interface CreateSessionOpts {
  /** Optional override of the host's configured workspaceRoot.
   *  Use when the host serves multiple workspaces. */
  readonly workspaceRoot?: string;
  /** Optional override of the effective backend (板砖) workspace. When
   *  omitted, a new GUI session defaults to the managed sandbox
   *  `~/.herta/workspaces/<sessionId>/`. */
  readonly backendWorkspace?: string;
  /** Interaction language (slice 4): the language Herta is prompted in —
   *  static prefix, opening, router/supervisor, recap, session title. The
   *  caller resolves it at session creation (per-user setting, else UI
   *  locale). Default "zh" — byte-identical to pre-slice-4 behavior.
   *  An "en" session's opening carries NO voice clip (no EN wavs in v1). */
  readonly lang?: "zh" | "en";
}

export interface OpenSessionOpts {
  readonly sessionId: string;
  /** Interaction language for the reopened session's runtime prompts. The host
   *  PREFERS the language persisted in the session header; this value is the
   *  fallback used only for legacy sessions whose header predates per-session
   *  persistence. Callers pass the current preference. Default "zh". */
  readonly lang?: "zh" | "en";
}

export interface ListSessionsOpts {
  readonly limit?: number;
  /** When set, filter to this workspace. Defaults to the host's
   *  configured workspaceRoot. Pass `null` to list across workspaces. */
  readonly workspaceRoot?: string | null;
}

export interface SessionMetadata {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly startedAt: string; // ISO timestamp
  readonly lastActivityAt: string; // ISO timestamp
  /** Generated session title, if one has been produced for this session. */
  readonly title?: string;
  /** The last user message in the transcript (where the user left off). */
  readonly lastUserText?: string;
  /** Interaction language this session was created under. Absent for legacy
   *  (pre-persistence) headers, all Chinese — consumers treat absent as "zh".
   *  Lets each sidebar card localize its own preview (板砖→Brick) independent
   *  of the currently active session's language. */
  readonly lang?: "zh" | "en";
}

// ───── Approval ─────

export interface ResolveApprovalOpts {
  readonly requestId: string;
  readonly decision: "allow" | "deny";
  /** "session" → task-scoped remember (ADR 0026, cleared when the brief
   *  ends). "always" → persist the derived PROJECT command rule (ADR 0030,
   *  `.herta/permissions.json`); no-ops when the pending request derives no
   *  rule — the GUI only offers it when `projectRule` is present. "trust"
   *  → turn workspace trust on for this workspace (ADR 0064); no-ops unless
   *  the pending request's class is one the tier covers — the GUI only
   *  offers it when `trustable` is present. */
  readonly persistence?: "once" | "session" | "always" | "trust";
}

/** Workspace trust as the session sees it (ADR 0064): the owner's explicit
 *  choice, the default for this workspace kind, and what applies now. */
export interface WorkspaceTrustState {
  /** What applies: "workspace" auto-allows the covered classes. */
  readonly effective: WorkspaceTrust;
  /** The owner's recorded choice for this workspace, or null when the
   *  default applies. */
  readonly explicit: WorkspaceTrust | null;
  /** The backend workspace is the session's managed sandbox — trusted by
   *  default; nothing of the user's lives there. */
  readonly isDefaultWorkspace: boolean;
  /** ADR 0075: the owner opted this workspace into the automatic review of
   *  approval requests. */
  readonly autoReview?: boolean;
  /** A reviewer is mounted (a provider key, not a test stub) — the menu
   *  offers the switch only then. */
  readonly autoReviewAvailable?: boolean;
}

/**
 * One automatic review the owner sees (ADR 0075) — user-only, like the
 * card it stands in for (D7): it never enters the record, and Herta is not
 * told. `paused` marks the brake engaging: every later request asks until
 * the next user message.
 */
export interface AutoReviewNotice {
  readonly requestId: string;
  readonly tool: string;
  /** The command as the card would have shown it. */
  readonly command: string | null;
  readonly decision: "allow" | "deny" | "paused";
  /** The reviewer's one sentence, in formal Chinese. */
  readonly reason: string;
  readonly at: string;
}

export type ApprovalResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "stale_request" | "no_pending_overlay";
    };

// ───── Rewind ─────

export type RewindResult =
  | {
      readonly ok: true;
      /** The withdrawn user turn's text, to restore into the composer. */
      readonly userText: string;
      /** True when the withdrawn span included backend (板砖) file edits — the
       *  GUI warns that those filesystem changes are NOT reverted (record-only
       *  rewind, per the 2026-06-21-rewind-last-turn spec). */
      readonly editedFiles: boolean;
      /** The withdrawn message's pictures, RESTAGED into the composer strip
       *  (owner 2026-08-27) — the renderer puts them back beside the restored
       *  draft. Absent when the turn carried none (or the strip was full and
       *  the GC took them). */
      readonly images?: readonly StagedImageInfo[];
      /** The withdrawn turn's edits can still be taken back (ADR 0074 §4):
       *  the notice offers 撤销改动 — `undoLastTurnEdits("withdrawn")` — until
       *  the next send. */
      readonly undoable: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: "turn_in_progress" | "no_user_turn";
    };

/**
 * Which turn's edits `undoLastTurnEdits` takes back (ADR 0074 §4):
 * `latest` — the record's latest turn, from its card; `withdrawn` — the
 * turn(s) ⟲ took out since the last send, from the rewind notice.
 */
export type UndoTarget = "latest" | "withdrawn";

/** What `undoLastTurnEdits` answers. Per file (workspace-relative, `/`):
 *  what happened to it. `commands`: paths commands changed — never
 *  restored; `commandsUnknown`: commands ran and what they changed could
 *  not be read; `incomplete`: some bytes were never kept. */
export type UndoTurnEditsResult =
  | {
      readonly ok: true;
      readonly files: readonly {
        readonly path: string;
        readonly result: UndoFileResult;
      }[];
      readonly commands: readonly string[];
      readonly commandsUnknown: boolean;
      readonly incomplete: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: "turn_in_progress" | "nothing_to_undo";
    };

/** Whether the record's latest turn has edits that can be taken back
 *  changed (ADR 0074 §4). The 撤销 chip's state — the user's alone: it never
 *  enters the record. */
export type UndoEvent = { readonly kind: "offer"; readonly undoable: boolean };

/** Result of setWorkspace/resetWorkspace. Idle-only ops (audit 2026-07-10,
 *  finding 13): a mid-turn call is refused rather than dropping the → 系统
 *  note and rewinding the sink cursor. */
export type WorkspaceSetResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "turn_in_progress" };

/** One ingested document (ADR 0033). `unreadable` mirrors the block's digest:
 *  the file was stored but no excerpt was taken, and the record says why. */
export interface AttachedFile {
  readonly name: string;
  readonly path: string;
  readonly unreadable?: string;
}

/**
 * How far one file of an attach has got (2026-10-01): what the pending row's
 * progress line shows while main reads. `index` is the file's place in the
 * batch. Per file, in order: `pages` (the text and the picture search, page
 * by page; `total` 0 = not paged, a Word file), `transcripts` (a PDF's
 * pictures, counted as each call finishes), then `done`. Display only —
 * nothing decides anything on it.
 */
export interface AttachProgress {
  readonly index: number;
  readonly stage: "pages" | "transcripts" | "done";
  readonly done: number;
  readonly total: number;
}

/** Result of `attachFiles`. Idle-only for the same reason as setWorkspace —
 *  it rides the same out-of-turn append. `too_many` guards the per-action cap
 *  rather than silently ingesting a prefix. */
export type AttachResult =
  | { readonly ok: true; readonly files: readonly AttachedFile[] }
  | {
      readonly ok: false;
      readonly reason: "turn_in_progress" | "too_many" | "no_files";
    };

/** One picture waiting in the composer (ADR 0048 §4). Stored and captioning;
 *  nothing about it is in the record until the message it rides is sent. */
export interface StagedImageInfo {
  readonly id: string;
  readonly name: string;
  /** Workspace-relative stored path — what the thumbnail protocol serves. */
  readonly path: string;
  readonly width?: number;
  readonly height?: number;
}

/** Result of `stageImages`. A picture refused at the door (`denied`,
 *  `too_large`, `read_error`) or that is not an image at all (`not_image` —
 *  documents ingest immediately instead, ADR 0048 §4) comes back in
 *  `rejected` while its siblings still stage; only whole-action failures use
 *  the `ok: false` shape. `too_many_images` is the per-MESSAGE picture cap
 *  (`MAX_STAGED_IMAGES`, counting what is already staged) — whole-batch,
 *  like the attachFiles cap, so the refusal can say the rule instead of
 *  silently staging a prefix. */
export type StageImagesResult =
  | {
      readonly ok: true;
      readonly staged: readonly StagedImageInfo[];
      readonly rejected: readonly {
        readonly name: string;
        readonly reason: string;
      }[];
    }
  | {
      readonly ok: false;
      readonly reason: "turn_in_progress" | "too_many_images" | "no_files";
    };

/** Result of `removeAttachment`. `removed` counts the blocks marked, which is
 *  >1 when the same document was attached more than once. `in_use`: a stored
 *  copy could not be deleted (on Windows, a file open in another program) —
 *  nothing is marked, and a retry once it is closed finishes the job. */
export type RemoveAttachmentResult =
  | { readonly ok: true; readonly removed: number }
  | {
      readonly ok: false;
      readonly reason: "turn_in_progress" | "not_found" | "in_use";
    };

// ───── Wire events (one type per AsyncIterable subscription) ─────

export type RecordEvent =
  | {
      readonly kind: "block";
      readonly blockId: string;
      readonly block: TerminalRecordBlock;
    }
  | {
      /** Full-record replacement — the subscriber drops its mirror and adopts
       *  `record` wholesale. Emitted by `rewindLastTurn` after the latest turn is
       *  withdrawn; the only event that SHRINKS the record. Long-session
       *  windowing (2026-07-12): `record` is the trailing RECORD_TAIL_BLOCKS
       *  window and `start` is the absolute index it begins at (older blocks
       *  page in via `session:recordSlice`). Absent `start` means 0 — the
       *  window is the whole record. */
      readonly kind: "reset";
      readonly record: TerminalRecord;
      readonly start?: number;
      /**
       * The session's topic history AFTER the truncation, when this reset
       * changed it (rewind). The server prunes and persists it, so it is the
       * authority — the renderer adopts this list rather than re-deriving one
       * (user 2026-07-30: the renderer's own inference could only test anchor
       * liveness, which a rewound topic can pass; see `pruneTopics`).
       * Absent on resets that cannot change topics — a drop-heal resync, whose
       * record is the same length.
       */
      readonly topics?: readonly SessionTopic[];
    }
  | { readonly kind: "dropped"; readonly count: number };

export type OverlayEvent =
  | {
      readonly kind: "pending";
      readonly overlay: ApprovalOverlayState;
    }
  | { readonly kind: "resolved"; readonly requestId: string }
  /** ADR 0075: a request the automatic reviewer settled, no card shown. */
  | { readonly kind: "reviewed"; readonly notice: AutoReviewNotice }
  | { readonly kind: "dropped"; readonly count: number };

export type SessionAgentEvent =
  | { readonly kind: "agent"; readonly event: AgentEvent }
  | { readonly kind: "dropped"; readonly count: number };

export type SpeechControlEvent =
  | { readonly kind: "retract" }
  | { readonly kind: "retractFloor"; readonly keepLen: number }
  | { readonly kind: "dropped"; readonly count: number };

export type TurnLifecycleEvent =
  | { readonly kind: "started"; readonly turnId: string }
  | { readonly kind: "finished"; readonly turnId: string }
  | {
      readonly kind: "failed";
      readonly turnId: string;
      /** `status` is the provider's HTTP status when the failure carried
       *  one (the official DeepSeek error codes — 401 bad key, 402 no
       *  balance, 429 rate limit, 500/503 server; 2026-07-12). The renderer
       *  maps it to a specific user-facing message instead of the generic
       *  connection-lost line.
       *
       *  `code` is the Error's NAME ("AbortError" marks a user interrupt);
       *  `providerCode` is ProviderError's own code, which carries the cases
       *  that have no HTTP status — notably "network-tls", a certificate or
       *  proxy failure that no amount of resending will fix (audit S3). */
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly status?: number;
        readonly providerCode?: string;
      };
    };

export type TitleEvent =
  | {
      readonly kind: "title";
      readonly sessionId: string;
      readonly title: string;
      /** Set when this (re)title marked a TOPIC boundary — the title
       *  changed, so a new entry joined the session's topic history (the
       *  rail's jump targets). Absent when the retitle re-derived the same
       *  title. See session-topics.ts. */
      readonly topic?: SessionTopic;
    }
  | { readonly kind: "dropped"; readonly count: number };

export type WorkspaceEvent =
  | {
      readonly kind: "workspace";
      readonly workspace: string;
      readonly isDefault: boolean;
    }
  | { readonly kind: "dropped"; readonly count: number };

/** The workspace's repository state for the rail's repository card (ADR
 *  0058): the same snapshot the backend frame carries (ADR 0049 §2),
 *  probed again on open, on a workspace change, at every turn's end and
 *  on request. `repo` is null when the workspace is not a repository or
 *  git cannot answer; `workspace` names the folder it describes, so a late
 *  answer for a folder the session has since left can be told apart. */
export type RepoEvent =
  | {
      readonly kind: "repo";
      readonly workspace: string;
      readonly repo: RepoContextSnapshot | null;
    }
  | { readonly kind: "dropped"; readonly count: number };

/** A cue to autoplay a voice clip in the renderer. `category` + `clipId` map to
 *  `<voiceRoot>/<category>/<clipId>.opus` (served via the `herta-voice` protocol).
 *  e.g. { category: "openings", clipId: "004-late-night-audit" }. Extensible to
 *  veto / particle / easter-egg categories. Audio playback is renderer-only; the
 *  server only says what to play and when. */
export type VoiceCueEvent =
  | { readonly kind: "cue"; readonly category: string; readonly clipId: string }
  | {
      /** One synthesized unit of Herta's speech (ADR 0042): play it now,
       *  gapless after the previous `seq` of the same utterance. The sink
       *  emits it the instant that unit's text begins to reveal, so audio
       *  and text start together. */
      readonly kind: "tts";
      readonly utteranceId: string;
      readonly seq: number;
      readonly samples: Int16Array;
      readonly sampleRate: number;
      readonly durationMs: number;
    }
  | {
      /** Stop playback of an utterance (a veto cut it mid-sentence, an
       *  interrupt, the reveal ceiling). No `utteranceId` → stop everything. */
      readonly kind: "ttsStop";
      readonly utteranceId?: string;
    }
  | { readonly kind: "dropped"; readonly count: number };

/** Emitted after a session's files are deleted, so the renderer stores can
 *  drop the card (always) and blank the main panel (if it was the open one). */
export type SessionDeletedEvent = { readonly sessionId: string };

/** What an export is built from (ADR 0072 §3). `record` is what the window
 *  shows: Herta's thoughts are left out, and so are the system blocks'
 *  evidence sections (`evidenceDetail`, `evidence`), which the export does
 *  not print and which can run to megabytes. */
export interface SessionExportSource {
  readonly sessionId: string;
  readonly title: string | null;
  readonly lang: "zh" | "en";
  readonly record: TerminalRecord;
}

/** What a rename answers (ADR 0072 §3): the title as kept, and — for the
 *  open session — its topics as they now stand, the rail's last entry
 *  renamed with it. */
export type RenameSessionResult =
  | {
      readonly ok: true;
      readonly title: string;
      readonly topics?: readonly SessionTopic[];
    }
  | { readonly ok: false };

// ───── SessionHost / Session interfaces ─────

export interface SessionHost {
  createSession(opts: CreateSessionOpts): Promise<Session>;
  openSession(opts: OpenSessionOpts): Promise<Session>;
  listSessions(opts?: ListSessionsOpts): SessionMetadata[];
  /** Content search over this workspace's persisted transcripts — the
   *  DIALOGUE only (user + Herta speech blocks), case-insensitive substring,
   *  first match per session, bounded hits with a preview snippet.
   *  Best-effort: unreadable transcripts are skipped. Async since 2026-09-03:
   *  the scan reads off the event loop chunk by chunk, and a query that
   *  extends the previous one reads only its hits. See session-search.ts. */
  searchSessions(query: string): Promise<SessionSearchHit[]>;
  /** Remove a session's persisted files. If it is the active session it is
   *  closed first (releasing the transcript file handle) and `activeSession`
   *  becomes null. `wasActive` reports whether the deleted session was open.
   *  A remove that fails part-way resolves `ok: false` rather than throwing,
   *  with `removed` saying whether the session itself is gone (its transcript
   *  is removed first; a managed workspace held open by another program can
   *  fail after it) — the caller drops the card only when it is. */
  deleteSession(
    sessionId: string,
  ): Promise<{ ok: boolean; wasActive: boolean; removed?: boolean }>;
  /** Name a session by hand, open or not (ADR 0072 §3). The title is
   *  cleaned (one line, capped); an empty one, an unknown session or a
   *  failed write answers `ok: false`. Optional: a host without the GUI's
   *  sidebar omits it. */
  renameSession?(
    sessionId: string,
    title: string,
  ): Promise<RenameSessionResult>;
  /** A session's record, title and language for an export (ADR 0072 §3):
   *  the open one's from memory, any other's read off the event loop. Null
   *  when it cannot be read. Optional like `renameSession`. */
  readSessionForExport?(sessionId: string): Promise<SessionExportSource | null>;
  closeActiveSession(): Promise<void>;
  /** Release host-level resources (clears the idle trigger interval, if any).
   *  Call on app shutdown. Idempotent. */
  dispose(): void;
  /** Update the live DeepSeek key (no-key onboarding / Settings). The active
   *  session reads it through a getter, so the NEXT turn uses the new value with
   *  no restart. Pass "" to clear. Persistence is the caller's job (key-store). */
  setDeepSeekKey(key: string): void;
  /** Update the PDF-picture transcription switch (Settings, 2026-10-01): the
   *  NEXT attach, in any session, reads it — no restart. On until set.
   *  Persistence is the caller's job. */
  setPdfPictureTranscription(enabled: boolean): void;
  /** The user did something in the window that is not a turn (a rewind, an
   *  attachment, a search, a file opened in the viewer): it counts as
   *  activity for the dream trigger, and a running pass steps aside at its
   *  next episode. Optional: a host without a dream trigger omits it. */
  noteUserActivity?(): void;
  /** End the processes 板砖 runs left running when the app exited (ADR 0071
   *  §1.6): only a process still running as the one the run started (same
   *  pid, same start time), and each outcome goes into its run's journal.
   *  Call once after launch, off the startup path. Never rejects. */
  reapOrphanedProcesses(): Promise<void>;
  readonly activeSession: Session | null;
}

/** Result of a submit: a started turn, or a signal that no DeepSeek key is set
 *  yet (the renderer prompts for one and re-sends the kept text). */
export type SubmitTextResult =
  | { readonly turnId: string }
  | { readonly needsKey: true };

/** What `steerText` answers (ADR 0063). `accepted`: the backend is running,
 *  the text is in the record and 板砖 reads it at its next step. `queued`:
 *  there is no backend step to reach — the turn is Herta's own speech, or
 *  none is running — so the caller keeps the text for the next turn. Never
 *  an error: a steer that missed its window is a queued message. */
export type SteerTextResult =
  | { readonly accepted: string }
  | { readonly queued: true };

/** Whether a 继续 is on offer changed (ADR 0071 §1.4). */
export type ResumeEvent =
  | { readonly kind: "offer"; readonly resumable: boolean }
  | { readonly kind: "dropped"; readonly count: number };

/** What `continueInterrupted` answers. `turnId`: the continued run's turn,
 *  now finished. `needsKey`: no DeepSeek key yet. `unavailable`: nothing to
 *  continue (the offer had lapsed, or a turn was running). Never an error. */
export type ContinueInterruptedResult =
  | { readonly turnId: string }
  | { readonly needsKey: true }
  | { readonly unavailable: true };

export interface Session {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  /** The EFFECTIVE backend (板砖) workspace — the cwd the coding backend uses.
   *  Distinct from `workspaceRoot` (the immutable record-store anchor). */
  readonly backendWorkspace: string;
  readonly backendWorkspaceIsDefault: boolean;
  /** The interaction language this session runs in (its birth language, pinned
   *  on reopen). Surfaced so the renderer can localize the user-facing
   *  presentation of 板砖 (the 板砖→Brick alias) to the conversation's language,
   *  independent of the UI locale. The wire/record/prompt token stays 板砖. */
  readonly lang: "zh" | "en";
  /** Synchronous snapshot of the current canonical TerminalRecord.
   *  Read once on subscribe; consume `subscribeRecord()` to stay
   *  current. */
  readonly record: TerminalRecord;
  /** Synchronous snapshot of the current pending overlay, or null when idle. */
  readonly overlay: ApprovalOverlayState | null;
  /** Current session title (generated after the first turn, or the user's
   *  own), or null. */
  readonly title: string | null;
  /** The user renamed the session (ADR 0072 §3): the current topic takes the
   *  name — the title and the rail's last entry — and the retitle rules go
   *  on as before. `title` is already cleaned (`cleanUserTitle`). Returns
   *  the topics as they now stand. Throws when the title sidecar cannot be
   *  written. Optional: only the GUI SessionImpl implements it. */
  renameTitle?(title: string): readonly SessionTopic[];
  /** The session's topic history (title changes anchored at the user block
   *  that started each topic) — the topic rail's jump targets. Empty until
   *  a title exists. */
  readonly topics: readonly SessionTopic[];
  /** True while a turn is running (submitText / opening / regenerate).
   *  Main-initiated navigation (the tray) consults it: switching away
   *  closes this session, which INTERRUPTS the turn — the tray can't show
   *  a two-step confirm, so it refuses and fronts the window instead. */
  readonly turnInFlight: boolean;
  /** 板砖's run is in progress inside the current turn — the hold window
   *  (ADR 0063). A window that reloads mid-turn re-learns it from the reset
   *  snapshot. Optional: hosts without the GUI's session omit it. */
  readonly backendActive?: boolean;
  /** A 继续 is on offer (ADR 0071 §1.4) — what a reloaded window's strip is
   *  rebuilt from. Optional like the above. */
  readonly resumable?: boolean;
  /** Pictures staged in the composer and not yet sent (ADR 0048 §4) — what
   *  a reloaded window's strip is rebuilt from. Optional like the above. */
  readonly stagedImageList?: readonly StagedImageInfo[];
  /** The dream corpus changed on disk: the next turn re-derives the static
   *  prefix once (ADR 0069 §1b). Optional like the above. */
  markPrefixStale?(): void;

  /** `stagedImageIds` sends pictures with the message (ADR 0048 §4): their
   *  blocks land right after the user block, inside this turn's span. */
  submitText(
    text: string,
    opts?: { readonly stagedImageIds?: readonly string[] },
  ): Promise<SubmitTextResult>;
  /**
   * D2 (resume recovery): if this session ends on an ORPHANED user message — a
   * reply lost to a mid-stream app-close — regenerate the reply as a normal
   * turn (lifecycle events fire, the composer locks via turn status, the reply
   * streams + persists), without re-appending the user block. No-op when the
   * session ends on a Herta reply. Fired once by the open handler right after
   * the renderer subscribes. Optional: only the GUI SessionImpl implements it.
   */
  regenerateLastReplyIfOrphaned?(): Promise<void>;
  /**
   * D3 (streaming opening): stream a NEW session's opening seed in like a reply
   * (read-along pace) instead of showing it instantly. Runs as a turn (the
   * composer locks while it streams). No-op when there is no deferred seed
   * (resumed sessions, or new sessions with no opening). Fired once by the
   * create handler after the renderer subscribes. Optional: only the GUI
   * SessionImpl implements it.
   */
  playOpening?(): Promise<void>;
  interrupt(opts?: {
    readonly turnId?: string;
  }): Promise<{ readonly ok: boolean }>;
  /**
   * A message while 板砖 works (ADR 0063). While the backend loop runs, the
   * text enters the shared record at once as a user block (Herta sees it,
   * D7) and reaches 板砖 at its next sampling boundary as the newest user
   * message; the turn continues. Outside a backend run the answer is
   * `queued` and nothing is recorded — the caller holds the text and
   * submits it as the next turn. OPTIONAL: fakes and the website demo omit
   * it; the composer then offers no steer.
   */
  steerText?(text: string): Promise<SteerTextResult>;
  /**
   * 继续 (ADR 0071 §1.4): continue the interrupted 板砖 run. OPTIONAL like
   * `steerText`: fakes and the website demo omit it, and no offer is shown.
   */
  continueInterrupted?(): Promise<ContinueInterruptedResult>;
  /** The offer's changes (see `resumable`). Optional with the above. */
  subscribeResume?(): AsyncIterable<ResumeEvent>;
  /**
   * Rewind the latest 开拓者 (user) turn: withdraw it and everything below it
   * (Herta reply, 板砖 system blocks, beats, markers) from every record store,
   * returning the withdrawn user text to restore into the composer. Idle-only —
   * rejects with `reason: "turn_in_progress"` while a turn is in flight, and
   * `reason: "no_user_turn"` when there is nothing to rewind. RECORD-ONLY:
   * filesystem side-effects of a withdrawn @板砖 turn are NOT reverted (the
   * result flags `editedFiles` so the GUI can warn). Optional: only the GUI
   * SessionImpl implements it. See the 2026-06-21-rewind-last-turn spec.
   */
  rewindLastTurn?(): Promise<RewindResult>;
  /**
   * Take a turn's edits back (ADR 0074): what 板砖's editors wrote returns to
   * what it was; a file changed since is left alone and named; command
   * effects are never reverted. `latest` also appends a `→ 系统` line saying
   * so — the turn stays in the record, and Herta must not believe edits that
   * are gone. Idle-only. Optional: only the GUI SessionImpl implements it.
   */
  undoLastTurnEdits?(target: UndoTarget): Promise<UndoTurnEditsResult>;
  /** Whether the record's latest turn can be undone (see `UndoEvent`). */
  readonly undoable?: boolean;
  /** Its changes. Optional with the above. */
  subscribeUndo?(): AsyncIterable<UndoEvent>;
  /** GUI easter egg: a successful 板砖-card lift may play a voice clip. Rolls a
   *  50% chance, throttled to ≤1 play per session per hour, then emits a
   *  `voice` cue. No-op without easter-egg clips. Optional: only the GUI
   *  SessionImpl implements it. See the 2026-06-23-easter-egg-voice spec. */
  maybePlayEasterEgg?(): void;
  /** Renderer-requested record heal after a record-channel overflow drop:
   *  re-emits the sink's live record mirror as a `reset` RecordEvent through
   *  the record stream (FIFO with block events → race-free even mid-turn).
   *  Defense in depth — chat-scale streams never fill the bounded queue.
   *  Optional: only the GUI SessionImpl implements it. */
  resyncRecord?(): void;
  resolveApproval(opts: ResolveApprovalOpts): Promise<ApprovalResult>;
  /** Project command allow rules (ADR 0030) for the CURRENT effective
   *  workspace, as display strings (`node src/index.mjs:*`) — the Settings
   *  management list. Optional: only the GUI SessionImpl implements them. */
  listCommandRules?(): Promise<readonly string[]>;
  /** Removes one rule by its display form. False when nothing matched. */
  removeCommandRule?(display: string): Promise<boolean>;
  /** Workspace trust (ADR 0064) for the CURRENT effective workspace.
   *  Optional: only the GUI SessionImpl implements the pair. */
  getWorkspaceTrust?(): Promise<WorkspaceTrustState>;
  /** Record the owner's choice for this workspace; null clears it back to
   *  the default. Resolves with the state after the change. */
  setWorkspaceTrust?(
    value: WorkspaceTrust | null,
  ): Promise<WorkspaceTrustState>;
  /** ADR 0075: opt the CURRENT workspace in or out of the automatic review
   *  of approval requests. Resolves with the state after the change. */
  setAutoReview?(on: boolean): Promise<WorkspaceTrustState>;
  /** Set the effective backend (板砖) workspace. Trusts its caller —
   *  validation happens at the GUI/CLI boundary. Persisted + broadcast.
   *  Idle-only (audit 2026-07-10, finding 13): refused with
   *  `turn_in_progress` while a turn is in flight — the underlying
   *  appendSystemNote is only safe between turns. */
  setWorkspace(workspace: string): Promise<WorkspaceSetResult>;
  /** Restore the managed-sandbox default backend workspace. Persisted +
   *  broadcast (with `isDefault: true`). Idle-only, like setWorkspace. */
  resetWorkspace(): Promise<WorkspaceSetResult>;
  /** Ingest documents the user handed over (ADR 0033): copy each into the
   *  session's attachment directory and append one → 系统 block per file.
   *  Idle-only, like setWorkspace — it rides the same out-of-turn append.
   *  Optional: only the GUI SessionImpl implements it. */
  attachFiles?(
    paths: readonly string[],
    /** How far each file has got, while it is read (2026-10-01). */
    onProgress?: (progress: AttachProgress) => void,
  ): Promise<AttachResult>;
  /** Take back an attached document: delete the stored file and mark every
   *  block citing it removed. Idle-only, like attachFiles. */
  removeAttachment?(path: string): Promise<RemoveAttachmentResult>;
  /** Stage pictures in the composer (ADR 0048 §4): store + start captioning
   *  now, append to the record only when the message is sent. Accepts a path
   *  (picker, drop) or raw bytes (paste — a clipboard screenshot has no path
   *  at all). Idle-only, like attachFiles. */
  stageImages?(
    inputs: readonly {
      readonly path?: string;
      readonly bytes?: Uint8Array;
      readonly name?: string;
    }[],
  ): Promise<StageImagesResult>;
  /** Drop a staged picture and delete its stored copy. Nothing about it ever
   *  reached the record, so — unlike removeAttachment — nothing is marked. */
  unstageImage?(id: string): Promise<boolean>;

  subscribeRecord(): AsyncIterable<RecordEvent>;
  subscribeOverlay(): AsyncIterable<OverlayEvent>;
  subscribeAgentEvents(): AsyncIterable<SessionAgentEvent>;
  subscribeTurnLifecycle(): AsyncIterable<TurnLifecycleEvent>;
  subscribeSpeech(): AsyncIterable<SpeechControlEvent>;
  subscribeTitle(): AsyncIterable<TitleEvent>;
  subscribeWorkspace(): AsyncIterable<WorkspaceEvent>;
  /** Voice-clip autoplay cues (opening voice now; veto / particle / easter-egg
   *  later). Renderer-only playback — the server only emits what to play. */
  subscribeVoice(): AsyncIterable<VoiceCueEvent>;
  /** The workspace's repository as last probed (ADR 0058): null when it is
   *  not a repository, git cannot answer, or no probe has finished yet.
   *  Optional: only the GUI SessionImpl carries the repository card's
   *  surface. */
  readonly repo?: RepoContextSnapshot | null;
  /** Probe the repository again now and emit the answer as a `repo` event
   *  (the renderer asks on window focus, so a commit made in a terminal
   *  shows when the user looks back). Coalesced: a request during a probe
   *  runs exactly one more after it. */
  refreshRepo?(): Promise<void>;
  subscribeRepo?(): AsyncIterable<RepoEvent>;
  /** One commit of the workspace's repository — message, author, the files
   *  with their counts, the patch — for the viewer's commit tab (ADR 0059).
   *  `ref` is a hex commit id (abbreviated is fine); null when git cannot
   *  show it. Optional: the GUI SessionImpl only. */
  describeCommit?(
    ref: string,
  ): Promise<CommitDescription | null | GitReadTimeout>;
  /** One workspace-relative path's working-tree change against HEAD —
   *  staged and unstaged together, an untracked file as a whole addition —
   *  for the viewer's diff tab (ADR 0059 §5). The caller has jailed the
   *  path to the workspace. Null when git cannot answer. Optional: the GUI
   *  SessionImpl only. */
  describeWorkingDiff?(
    path: string,
  ): Promise<WorkingDiff | null | GitReadTimeout>;
  /** A page of the repository's history for the viewer's log tab (ADR
   *  0059 §6): a ref's log (HEAD by default), newest first, each commit
   *  marked when not yet on that ref's upstream, optionally filtered by
   *  message. Null when git cannot answer. Optional: the GUI SessionImpl
   *  only. */
  describeLog?(opts: LogQuery): Promise<LogPage | null | GitReadTimeout>;
  /** The repository's branches for the history tab's read-only picker
   *  (ADR 0059 §6). Optional like its siblings. */
  describeBranches?(): Promise<BranchList | null | GitReadTimeout>;

  close(): Promise<void>;
}
