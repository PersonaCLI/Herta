import type {
  ApprovalOverlayState,
  OverlayEvent,
  RecordEvent,
  RepoContextSnapshot,
  RepoEvent,
  ResumeEvent,
  SessionAgentEvent,
  SessionDeletedEvent,
  SessionTopic,
  TerminalRecord,
  TitleEvent,
  TurnLifecycleEvent,
  UndoEvent,
  UndoTarget,
  UndoTurnEditsResult,
  WorkspaceEvent,
} from "@herta/app-server";
import { EMPTY_LIVE } from "../../shared/live-tool-feed.js";
import type {
  HertaBridge,
  LiveToolSnapshot,
  NavBlockedEvent,
  SessionError,
  SessionNoSession,
  SessionSnapshot,
  SpeechControlEvent,
  StagedImageInfo,
} from "../ipc/bridge-types.js";
import { journeyMark, journeyMarkAfterPaint } from "../lib/journey.js";

export type SessionStatus = "idle" | "thinking" | "speaking";

export interface SessionSnapshotView {
  readonly sessionId: string | null;
  /** The active session's interaction language (its birth language). Drives the
   *  板砖→Brick user-facing alias for THIS conversation, independent of the UI
   *  locale. "zh" when no session is active or the snapshot predates the field. */
  readonly lang: "zh" | "en";
  /** The loaded WINDOW of the session's record (long sessions, 2026-07-12):
   *  the trailing blocks, extendable backward via `loadOlderBlocks`. Live
   *  block events append to it as before. */
  readonly record: TerminalRecord;
  /** Absolute index `record[0]` has in the full record — the count of OLDER
   *  blocks not loaded (0 = everything is loaded). Row keys and the record-
   *  reset merge align by `recordStart + i`. */
  readonly recordStart: number;
  /** Where the conversation should land once the named session is loaded, or
   *  null. Set by a search-result click (see `requestJump`); consumed and
   *  cleared by Conversation once `sessionId` matches. Carries the target
   *  session BECAUSE the request is made before the open: without it,
   *  Conversation would consume the request against the session still on
   *  screen and jump in the wrong transcript. */
  readonly pendingJump: { sessionId: string; blockIndex: number } | null;
  readonly streamingText: string | null;
  /** The Trailblazer's likely next message, offered in the composer after a
   *  finished turn (composer predictions, owner 2026-10-10): Tab fills it
   *  in, typing replaces it. Null when there is none; cleared when a turn
   *  starts or the session changes. Never part of the record. */
  readonly prediction: string | null;
  readonly overlay: ApprovalOverlayState | null;
  readonly status: SessionStatus;
  readonly error: string | null;
  /** Optimistic echo of the message the user just sent, shown
   *  immediately (below the record, above the thinking/streaming row)
   *  until the turn's own user RecordEvent lands. */
  readonly pendingUser: string | null;
  /** Pictures riding the optimistic echo (ADR 0048 §4) — the staged images
   *  taken from the composer strip at send, so the echo (and the flying
   *  clone) already shows them instead of popping them in when the record
   *  lands. Never non-null while `pendingUser` is null: the emit guard
   *  clears it with its carrier, whichever of the many clearing sites
   *  fired. */
  readonly pendingUserImages: readonly StagedImageInfo[] | null;
  /** True while the supervisor-veto retract morph is in flight:
   *  streamingText holds the vetoed candidate (the morph's shrink source)
   *  and retryText buffers the retry's deltas. Cleared when the finalized
   *  herta block lands (onRecord) or by the turn finished/failed safety
   *  nets — never by animation completion. */
  readonly retracting: boolean;
  /** The retry's accumulated deltas while `retracting`; null otherwise.
   *  The component's useRetractMorph shrinks the vetoed text to the common
   *  prefix with this and types the rest forward from there. */
  readonly retryText: string | null;
  /** Server-computed divergence index (code points) for the retract morph's
   *  backward erase: it halts here instead of wiping to empty. Null except
   *  between a `retractFloor` and the clearing record/turn event. */
  readonly retractKeepLen: number | null;
  /** Renderer wall-clock (Date.now) when the current turn started; null when
   *  idle. Used to time a live backend activity run (no record timing exists). */
  readonly turnStartedAt: number | null;
  /** True while the @板砖 backend turn is running (between its turn.started and
   *  turn.finished), for the 处理中… placeholder. */
  readonly backendActive: boolean;
  /** Backend tool calls currently in flight (raw tool.call.started minus
   *  finished). >1 during a parallel read-only batch (ADR 0025 slice 5) —
   *  drives the multi-row shimmer in ActivityBlock. Reset with the backend
   *  turn lifecycle. */
  readonly backendInFlight: number;
  /** The live views of 板砖's run (ADR 0073) — its recent calls, numbered as
   *  the record will number their op rows, and the focused call's stream
   *  (the file it is writing, a command's output) — as main last sent them.
   *  Kept past the backend's end (the record trails it), cleared by the next
   *  run and by a reset. Screen-only: never in the record. */
  readonly live: LiveToolSnapshot;
  /** Renderer wall-clock (Date.now) when the @板砖 backend turn started (its
   *  backend-layer turn.started). Anchors the backend activity timer to the
   *  actual 板砖 start, NOT turnStartedAt — which begins when Herta's turn
   *  starts and so includes her speech-streaming time. Null until a backend run
   *  starts; cleared on turn start / end / reset. */
  readonly backendStartedAt: number | null;
  /** True after the @板砖 backend turn FAILED (turn.failed{layer:"backend"}),
   *  until the next turn starts / reset. Drives the device card's error state.
   *  An INTERRUPT is not an error and does not set it (audit 2026-07-24, M2). */
  readonly backendError: boolean;
  /** Incremented once per CLEANLY FINISHED @板砖 run; 0 at session start.
   *
   *  The device card's green success flash used to be inferred from the
   *  `backendActive` true→false edge plus "no error" — which silently became
   *  wrong the moment an interrupt stopped counting as an error (M2): the
   *  interrupt produced exactly that edge, so stopping a run flashed 完成 /
   *  Done. An explicit success signal cannot be confused with any other
   *  outcome, and it retires the edge-baseline ref whose staleness across a
   *  session switch was its own bug. */
  readonly backendSucceededSeq: number;
  /** True while the long-session recap summarizer is running (between the
   *  recap.compaction `start` and `end` bus events). Ephemeral — drives a
   *  transient in-world status row; never persisted to the record. */
  readonly recapCompacting: boolean;
  /** True while the supervisor model is judging a candidate speech (between
   *  the supervisor.check `start` and `end` bus events). Ephemeral — drives
   *  the debounced 伽马风暴 hint row that explains a long reveal-hold; never
   *  persisted to the record. */
  readonly supervisorChecking: boolean;
  /** Generated session title, or null when none exists yet. */
  readonly title: string | null;
  /** True when the latest title arrived via a live `session:title` event (so
   *  the header should type it in); false for a disk-loaded title (reset),
   *  which renders instantly. */
  readonly titleAnimate: boolean;
  /** Topic history (the topic rail's jump targets): seeded from the reset
   *  snapshot, appended by title events carrying a `topic`, pruned when a
   *  record reset truncates below an anchor (rewind). */
  readonly topics: readonly SessionTopic[];
  /** The FIRST user message sent since this session was activated (reset).
   *  Frozen after the first message — the sidebar shows it for the active
   *  session so intermediate messages don't flicker the preview. Null until
   *  the first message of this activation lands. */
  readonly activationFirstUser: string | null;
  /** The EFFECTIVE backend (板砖) workspace — the cwd the coding backend
   *  uses. Seeded from the reset snapshot and live-updated by `workspace`
   *  events (set / reset-to-default). Null until a session is activated. */
  readonly backendWorkspace: string | null;
  /** True when `backendWorkspace` is still the managed-sandbox default. */
  readonly backendWorkspaceIsDefault: boolean;
  /** The workspace's repository as last probed (ADR 0058) — the rail's
   *  repository card. Null when the workspace is not a repository, no
   *  probe has answered yet, or the bridge has no repo surface. Seeded from
   *  the reset snapshot, live-updated by `repo` events; a workspace change
   *  keeps the last answer until the new workspace's arrives. */
  readonly repo: RepoContextSnapshot | null;
  /** One-shot: text to load into the composer (set by a rewind — the withdrawn
   *  user message returns here for editing). The Composer adopts it then calls
   *  `clearComposerDraft`. Null when there's nothing to restore. */
  readonly composerDraft: string | null;
  /** Pictures to RE-STAGE when the composer adopts the draft — set by a
   *  failed submit or a cancelled no-key card, whose staged copies still
   *  exist main-side (only `commit` consumes them; the key check runs
   *  before it). NOT set by a rewind: a rewound turn's stored copies are
   *  GC'd, so there is nothing left to restage. Rides `composerDraft`'s
   *  lifecycle via the emit guard. */
  readonly composerDraftImages: readonly StagedImageInfo[] | null;
  /** One-shot: pictures main still holds staged for this session, carried
   *  by a reset (a window that reloaded with pictures in its strip, UX
   *  review 2026-09-22, item 7). The composer adopts them into its strip,
   *  then calls `clearRestagedImages`. Null when there is nothing to adopt. */
  readonly restagedImages: readonly StagedImageInfo[] | null;
  /** A message sent while 板砖 works (ADR 0063), waiting above the composer:
   *  sent as the next turn the moment this one ends, unless the user
   *  interjects it into the running work (`steerText`) or takes it back.
   *  A composer-side draft with a delivery trigger — never in the record,
   *  and gone with the activation like any other draft. */
  readonly held: string | null;
  /** A 继续 is on offer (ADR 0071 §1.4): 板砖's last run was interrupted —
   *  the app exited under it, or the user pressed Stop — and main can
   *  continue it. Main's answer, from the reset snapshot and `onResume`. */
  readonly resumable: boolean;
  /** The latest turn's edits can be taken back (ADR 0074 §4) — its card's
   *  撤销 chip. Main's answer, from the reset snapshot and `onUndo`. */
  readonly undoable: boolean;
  /** The rewind notice's 撤销改动 (ADR 0074 §4): `offer` while the withdrawn
   *  turn's edits can still be taken back, `busy` while they are. Rides the
   *  notice: a new notice, or the notice's clearing, takes it away. */
  readonly rewindUndo: "offer" | "busy" | null;
  /** One-shot transient notice shown by the composer — e.g. the rewind warning
   *  that 板砖's file edits were NOT reverted. Cleared on the next keystroke. */
  readonly composerNotice: string | null;
  /** Non-null while the no-key onboarding card is open — holds the message the
   *  user just tried to send with no DeepSeek key set. Saving a key re-submits
   *  this text; cancelling restores it to the composer. Null = card closed. */
  readonly needsKeyText: string | null;
  /** Pictures held WITH the no-key message: the key check refuses before
   *  `commit` consumes the staged copies, so the re-send can still carry
   *  them and a cancel can put them back in the strip. Rides
   *  `needsKeyText`'s lifecycle via the emit guard. */
  readonly needsKeyImages: readonly StagedImageInfo[] | null;
  /** True once the main process has resolved the initial state (opened a
   *  session, or signalled no-session). Gates the disconnected UI so it
   *  never flashes during the async launch bootstrap. */
  readonly bootstrapped: boolean;
  /** One-shot: the last turn FAILED for a non-interrupt reason (provider /
   *  network error) with nothing committed to explain it — previously the
   *  half-typed sentence just vanished (slice 4). Drives a small inline
   *  notice in the conversation. Cleared when the next turn starts or the
   *  session resets. A user interrupt (AbortError) never sets it. */
  readonly turnFailed: boolean;
  /** The failed turn's HTTP status when the provider reported one (the
   *  official DeepSeek error codes — 401/402/429/500/503), else null. The
   *  TurnFailedRow maps it to a specific message. Lifecycle mirrors
   *  `turnFailed`. */
  readonly turnFailedStatus: number | null;
  /** The provider's own error code for a failure that carried no HTTP status.
   *  Only "network-tls" is acted on: a certificate or proxy problem, where
   *  "connection lost — please resend" would send the user around a loop that
   *  cannot succeed (audit S3). Lifecycle mirrors `turnFailed`. */
  readonly turnFailedProviderCode: string | null;
  /** Main refused a tray-initiated navigation mid-turn (2026-07-13).
   *  `target` is the session the tray tried to open (null = new-chat);
   *  `seq` increments per refusal so a repeat of the same target re-fires.
   *  The matching SessionItem / TopBar arms its two-step confirm on it. */
  readonly navBlock: {
    readonly target: string | null;
    readonly seq: number;
  } | null;
}

const INITIAL: SessionSnapshotView = {
  sessionId: null,
  lang: "zh",
  record: [],
  recordStart: 0,
  pendingJump: null,
  streamingText: null,
  prediction: null,
  overlay: null,
  status: "idle",
  error: null,
  pendingUser: null,
  pendingUserImages: null,
  retracting: false,
  retryText: null,
  retractKeepLen: null,
  turnStartedAt: null,
  backendActive: false,
  backendInFlight: 0,
  live: EMPTY_LIVE,
  backendStartedAt: null,
  backendError: false,
  backendSucceededSeq: 0,
  recapCompacting: false,
  supervisorChecking: false,
  title: null,
  titleAnimate: false,
  topics: [],
  activationFirstUser: null,
  backendWorkspace: null,
  backendWorkspaceIsDefault: false,
  repo: null,
  composerDraft: null,
  composerDraftImages: null,
  restagedImages: null,
  held: null,
  resumable: false,
  undoable: false,
  rewindUndo: null,
  composerNotice: null,
  needsKeyText: null,
  needsKeyImages: null,
  bootstrapped: false,
  turnFailed: false,
  turnFailedStatus: null,
  turnFailedProviderCode: null,
  navBlock: null,
};

/**
 * NAMED TRANSIENT GROUPS (audit 2026-07-24, Class C).
 *
 * Every reset path here spreads the snapshot and nulls a hand-picked subset
 * of the same transient fields — and each one historically cleared four to
 * six siblings correctly while missing one (the failure notice surviving a
 * rewind, L2). Naming the groups makes the omission visible at the call site:
 * the question becomes "which groups does this boundary end?" instead of
 * "did I remember every field?".
 *
 * Deliberately NOT one blanket TRANSIENT_CLEARED constant: the boundaries
 * differ in kind. A record `reset` also serves a mid-turn drop-heal (must
 * keep the live turn's progress), and `turn.finished` keeps `backendError`
 * (the device card reports the failed dispatch until the next turn). A
 * blanket clear would silently break both, so groups stay small and each
 * call site states its deliberate keeps.
 */

/** View state owned by the STREAMING bubble (including the supervisor-veto
 *  retract morph and the optimistic echo). Ends whenever the stream's content
 *  is replaced or the turn stops producing it. */
const STREAM_VIEW_CLEARED = {
  streamingText: null,
  retracting: false,
  retryText: null,
  retractKeepLen: null,
  pendingUser: null,
} as const;

/** The one-shot inline failure notice. Belongs to the turn it describes —
 *  cleared when the next turn starts, when the session resets, and when the
 *  record it annotates is replaced. */
const TURN_FAILURE_CLEARED = {
  turnFailed: false,
  turnFailedStatus: null,
  turnFailedProviderCode: null,
} as const;

/**
 * Renderer-side mirror of the active session, fed by IPC events from
 * main. Implements the useSyncExternalStore contract: getSnapshot
 * returns a referentially-stable object that only changes identity
 * when state changes. Slice 4 is chat-only — no device-state
 * derivation (Slice 5).
 */
export class SessionStore {
  private snapshot: SessionSnapshotView = INITIAL;
  private readonly listeners = new Set<() => void>();
  private unsubs: Array<() => void> = [];
  /** The connected bridge, held so onRecord's `dropped` branch can request a
   *  record heal (fire-and-forget IPC). Null while disconnected. Internal —
   *  the store stays a pure event-folder: the heal arrives back as an
   *  ordinary `reset` RecordEvent on the record channel. */
  private bridge: HertaBridge | null = null;
  /** Whether a finalized herta block landed since the current turn started.
   *  Drives the phantom-bubble cleanup (slice 4): a turn that finishes
   *  WITHOUT committing one (clean-to-empty) must clear the streaming
   *  bubble itself — no block will ever come to clear it. Internal —
   *  never part of the snapshot. */
  private hertaLandedThisTurn = false;

  // The constructor is intentionally PURE — it does NOT subscribe to the
  // bridge. Subscribing is a side effect; doing it in the constructor breaks
  // under React StrictMode, where the provider creates the store during
  // render but tears it down in an effect cleanup. StrictMode's dev
  // double-invoke would dispose a constructor-subscribed store and never
  // recreate it, leaving a dead store with no IPC listeners. Subscription
  // lifecycle therefore lives in connect()/disconnect(), driven by the
  // provider's useEffect (cleanup → setup re-subscribes cleanly).

  /** Subscribe to the bridge's IPC event streams. Returns a disconnect
   *  function. Idempotent and re-callable after disconnect. */
  connect(bridge: HertaBridge): () => void {
    this.disconnect();
    this.bridge = bridge;
    this.unsubs = [
      bridge.onReset((e) => this.onReset(e)),
      bridge.onRecord((e) => this.onRecord(e)),
      bridge.onAgent((e) => this.onAgent(e)),
      bridge.onTurn((e) => this.onTurn(e)),
      bridge.onOverlay((e) => this.onOverlay(e)),
      bridge.onSpeech((e) => this.onSpeech(e)),
      bridge.onTitle((e) => this.onTitle(e)),
      bridge.onSessionDeleted((e) => this.onSessionDeleted(e)),
      bridge.onWorkspace((e) => this.onWorkspace(e)),
      // Optional: only the Electron preload emits it (tray refusals).
      ...(bridge.onNavBlocked !== undefined
        ? [bridge.onNavBlocked((e) => this.onNavBlocked(e))]
        : []),
      // Optional: the repository card's stream (ADR 0058).
      ...(bridge.onRepo !== undefined
        ? [bridge.onRepo((e) => this.onRepo(e))]
        : []),
      // Optional: the 继续 offer (ADR 0071 §1.4).
      ...(bridge.onResume !== undefined
        ? [bridge.onResume((e) => this.onResume(e))]
        : []),
      // Optional: the 撤销 chip (ADR 0074 §4).
      ...(bridge.onUndo !== undefined
        ? [bridge.onUndo((e) => this.onUndo(e))]
        : []),
      // Optional: the live views of the call in flight (ADR 0073).
      ...(bridge.onLive !== undefined
        ? [bridge.onLive((e) => this.onLive(e))]
        : []),
    ];
    // Subscribed: now ask for the state. Main's own push at did-finish-load
    // can land before this line after a reload, and was then lost — the
    // window came back with no session over a running one (UX review
    // 2026-09-22, item 7).
    void bridge.requestSessionSync?.().catch(() => undefined);
    return () => this.disconnect();
  }

  private navBlockSeq = 0;

  /** Main's newest live views (ADR 0073). Only while a run is live: once
   *  the backend has ended, the views it left are what the trace card shows
   *  until the record catches up, and a late snapshot (main's own clearing
   *  one included) must not replace them. */
  private onLive(e: LiveToolSnapshot): void {
    if (!this.snapshot.backendActive) return;
    if (e.views.length === 0 && this.snapshot.live.views.length === 0) return;
    this.emit({ ...this.snapshot, live: e });
  }

  /** Main's answer on the 继续 offer changed. A dropped-events sentinel
   *  says nothing about it; the next reset re-syncs. */
  private onResume(e: ResumeEvent): void {
    if (e.kind !== "offer" || e.resumable === this.snapshot.resumable) return;
    this.emit({ ...this.snapshot, resumable: e.resumable });
  }

  /** Main's answer on the 撤销 chip changed (ADR 0074 §4). */
  private onUndo(e: UndoEvent): void {
    if (e.kind !== "offer" || e.undoable === this.snapshot.undoable) return;
    this.emit({ ...this.snapshot, undoable: e.undoable });
  }

  /**
   * Take a turn's edits back (ADR 0074 §4), bound to the session it was
   * asked in. Null when there is no bridge or session to ask, or the
   * session changed while main answered — the answer then belongs to a
   * record no longer on screen. Never rejects: a failed invoke answers as
   * nothing to undo.
   */
  async undoTurnEdits(target: UndoTarget): Promise<UndoTurnEditsResult | null> {
    const bridge = this.bridge;
    const sessionId = this.snapshot.sessionId;
    if (bridge?.undoLastTurnEdits === undefined || sessionId === null) {
      return null;
    }
    let r: UndoTurnEditsResult;
    try {
      r = await bridge.undoLastTurnEdits(sessionId, target);
    } catch {
      r = { ok: false, reason: "nothing_to_undo" };
    }
    return this.snapshot.sessionId === sessionId ? r : null;
  }

  /** The rewind notice's 撤销改动 is running (or offered again). */
  setRewindUndo(state: "offer" | "busy" | null): void {
    if (this.snapshot.rewindUndo === state) return;
    this.emit({ ...this.snapshot, rewindUndo: state });
  }

  /**
   * 继续 pressed: the strip goes at once (the turn's own lifecycle takes over
   * the composer), and main continues the run. With no key, the no-key card
   * opens as for a send; with nothing to continue, the strip just stays gone.
   */
  async continueInterrupted(): Promise<void> {
    const bridge = this.bridge;
    if (bridge?.continueInterrupted === undefined || !this.snapshot.resumable) {
      return;
    }
    this.emit({ ...this.snapshot, resumable: false });
    let r: Awaited<ReturnType<NonNullable<HertaBridge["continueInterrupted"]>>>;
    try {
      r = await bridge.continueInterrupted();
    } catch {
      return;
    }
    if ("needsKey" in r) this.emit({ ...this.snapshot, resumable: true });
  }

  private onNavBlocked(e: NavBlockedEvent): void {
    this.navBlockSeq += 1;
    this.emit({
      ...this.snapshot,
      navBlock: { target: e.target, seq: this.navBlockSeq },
    });
  }

  private disconnect(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.bridge = null;
  }

  readonly subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  readonly getSnapshot = (): SessionSnapshotView => this.snapshot;

  /** Optimistically echo the message the user just sent, before the turn's
   *  user RecordEvent arrives. Cleared when that block lands (onRecord) or
   *  when the turn ends / a reset replaces the session. `images` are the
   *  staged pictures riding this message (ADR 0048 §4), so the echo and its
   *  flying clone show them from the first frame. */
  markPendingUser(text: string, images?: readonly StagedImageInfo[]): void {
    this.emit({
      ...this.snapshot,
      pendingUser: text,
      pendingUserImages:
        images !== undefined && images.length > 0 ? images : null,
    });
  }

  /** Withdraw a rejected submit's optimistic echo (audit 2026-07-10): when
   *  `submitText` rejects BEFORE any turn lifecycle event (single-turn
   *  invariant), no safety net will clear the echo. Matching text only — a
   *  stale rejection must never clear a NEWER submit's echo — and the text
   *  goes back to the composer draft so nothing typed is lost. */
  withdrawPendingUser(text: string, images?: readonly StagedImageInfo[]): void {
    if (this.snapshot.pendingUser !== text) return;
    this.emit({
      ...this.snapshot,
      pendingUser: null,
      composerDraft: text,
      // The pictures go back too: their staged copies still exist main-side
      // (the submit never reached `commit`), so the ids restage cleanly.
      composerDraftImages:
        images !== undefined && images.length > 0 ? images : null,
    });
  }

  /** Stage the withdrawn user text (+ optional warning) for the composer to
   *  adopt after a rewind. The Composer reads `composerDraft` and clears it.
   *  `text` may be null to show a notice ALONE — a rewind that failed has no
   *  withdrawn text to restore but still owes the user an explanation
   *  (audit 2026-07-24, M3). */
  requestComposerDraft(
    text: string | null,
    notice: string | null,
    images?: readonly StagedImageInfo[],
    /** The rewound turn's edits can still be taken back: the notice offers
     *  撤销改动 (ADR 0074 §4). */
    undoOffer = false,
  ): void {
    this.emit({
      ...this.snapshot,
      composerDraft: text,
      composerDraftImages:
        images !== undefined && images.length > 0 ? images : null,
      composerNotice: notice,
      rewindUndo: undoOffer && notice !== null ? "offer" : null,
    });
  }

  /** The composer consumed the staged draft — null it so it isn't re-applied.
   *  (The emit guard drops `composerDraftImages` with it.) */
  clearComposerDraft(): void {
    if (this.snapshot.composerDraft === null) return;
    this.emit({ ...this.snapshot, composerDraft: null });
  }

  /** The composer adopted the reset's staged pictures (`restagedImages`). */
  clearRestagedImages(): void {
    if (this.snapshot.restagedImages === null) return;
    this.emit({ ...this.snapshot, restagedImages: null });
  }

  /** Hold a message sent while 板砖 works (ADR 0063). ONE held message at a
   *  time (owner 2026-09-14): a second send while one waits joins it as a
   *  new paragraph rather than replacing it — nothing typed is lost, and
   *  the strip's edit takes the whole back into the composer. */
  holdMessage(text: string): void {
    const prev = this.snapshot.held;
    this.emit({
      ...this.snapshot,
      held: prev === null ? text : `${prev}\n\n${text}`,
    });
  }

  /** Drop the held message (discarded, edited back, steered, or sent). */
  clearHeld(): void {
    if (this.snapshot.held === null) return;
    this.emit({ ...this.snapshot, held: null });
  }

  /** Where the NEXT outgoing clone lifts off from (ADR 0063: a held message
   *  flies from its card, not from the input). A side channel, not snapshot
   *  state: it is read exactly once, on the edge that mounts the clone, and
   *  a send that never takes it must not leave it for a later one. */
  private launch: { readonly left: number; readonly top: number } | null = null;
  armLaunch(
    launch: { readonly left: number; readonly top: number } | null,
  ): void {
    this.launch = launch;
  }
  /** The armed lift-off point, consumed. */
  takeLaunch(): { readonly left: number; readonly top: number } | null {
    const l = this.launch;
    this.launch = null;
    return l;
  }

  /** Show a transient composer notice with no draft to restore — an attach
   *  refusal (ADR 0033). Distinct from `requestComposerDraft`, whose contract
   *  is "here is text to put back AND why": passing a null draft through that
   *  path would read as a rewind that lost the message. */
  setComposerNotice(notice: string): void {
    this.emit({ ...this.snapshot, composerNotice: notice, rewindUndo: null });
  }

  /** Dismiss the transient composer notice (e.g. on the next keystroke). */
  clearComposerNotice(): void {
    if (this.snapshot.composerNotice === null) return;
    this.emit({ ...this.snapshot, composerNotice: null, rewindUndo: null });
  }

  /** Open the no-key onboarding card, holding the message that couldn't send
   *  (no DeepSeek key). Also clears the optimistic echo it had shown. The
   *  pictures move from the echo to the hold: the key check refused BEFORE
   *  `commit` consumed their staged copies, so the re-send still carries
   *  them and a cancel can restage them. */
  requestKeyPrompt(text: string, images?: readonly StagedImageInfo[]): void {
    this.emit({
      ...this.snapshot,
      pendingUser: null,
      needsKeyText: text,
      needsKeyImages: images !== undefined && images.length > 0 ? images : null,
    });
  }

  /** Close the no-key onboarding card. */
  clearKeyPrompt(): void {
    if (this.snapshot.needsKeyText === null) return;
    this.emit({ ...this.snapshot, needsKeyText: null });
  }

  /**
   * Ask the conversation to jump to an absolute record index once the session
   * is open (2026-07-27, search-result navigation).
   *
   * A store field rather than an IPC option: the target comes from a search
   * hit the RENDERER already holds, and `Conversation` owns the only code
   * that can perform the jump (it pages older blocks in, then scrolls the
   * anchor row). Main has nothing to contribute, so nothing crosses the wire.
   *
   * Cleared by the consumer via `clearPendingJump` — and by `reset`, so a
   * request that never got consumed (the session failed to open, the user
   * clicked elsewhere first) cannot fire against a later session.
   */
  requestJump(sessionId: string, blockIndex: number): void {
    this.emit({ ...this.snapshot, pendingJump: { sessionId, blockIndex } });
  }

  clearPendingJump(): void {
    if (this.snapshot.pendingJump === null) return;
    this.emit({ ...this.snapshot, pendingJump: null });
  }

  /** The user renamed a session (ADR 0072 §3). The open one's header takes
   *  the name at once, without the reveal a generated title gets; main
   *  sends no title event for a rename. `topics`, when main answered them,
   *  are the rail's entries with the current topic renamed. Any other
   *  session is not shown here. */
  applyUserTitle(
    sessionId: string,
    title: string | null,
    topics?: readonly SessionTopic[],
  ): void {
    if (this.snapshot.sessionId !== sessionId) return;
    this.emit({
      ...this.snapshot,
      title,
      titleAnimate: false,
      ...(topics !== undefined ? { topics } : {}),
    });
  }

  /** Single-flight guard for loadOlderBlocks. */
  private loadingOlder = false;

  /**
   * Extend the record window BACKWARD by up to `count` blocks (the "load
   * earlier" affordance for long sessions, 2026-07-12). Pages
   * `[recordStart - count, recordStart)` from main and prepends it. Guards:
   * single-flight; no-op when everything is loaded or the bridge lacks
   * recordSlice (fakes); a response is dropped when the session switched or
   * the window start moved (a rewind/heal reset re-anchored it) while the
   * invoke was in flight — the absolute indices would no longer line up.
   */
  async loadOlderBlocks(count = 200): Promise<void> {
    const { sessionId, recordStart } = this.snapshot;
    if (
      this.loadingOlder ||
      sessionId === null ||
      recordStart <= 0 ||
      this.bridge?.recordSlice === undefined
    ) {
      return;
    }
    this.loadingOlder = true;
    try {
      const r = await this.bridge.recordSlice(sessionId, recordStart, count);
      if (
        this.snapshot.sessionId !== sessionId ||
        this.snapshot.recordStart !== recordStart ||
        r.blocks.length === 0 ||
        r.start + r.blocks.length !== recordStart
      ) {
        return; // stale or empty — drop
      }
      this.emit({
        ...this.snapshot,
        record: [...r.blocks, ...this.snapshot.record],
        recordStart: r.start,
      });
    } catch {
      // best-effort — the affordance simply stays available
    } finally {
      this.loadingOlder = false;
    }
  }

  /** Live-window trim (audit T3.5): drop the OLDEST blocks from the windowed
   *  record, advancing `recordStart`, once live appends have grown it well
   *  past the reset-tail bound. Caller-gated — the Conversation trims only
   *  while the reader is pinned at the bottom and no morph is measuring row
   *  slots. Nothing is lost: main keeps the full record, and "load earlier"
   *  pages the dropped rows back on demand. */
  trimRecordWindow(maxLen: number): void {
    const excess = this.snapshot.record.length - maxLen;
    if (excess <= 0) return;
    this.emit({
      ...this.snapshot,
      record: this.snapshot.record.slice(excess),
      recordStart: this.snapshot.recordStart + excess,
    });
  }

  /** Full teardown: disconnect IPC + drop all React listeners. */
  dispose(): void {
    this.disconnect();
    this.listeners.clear();
  }

  private emit(next: SessionSnapshotView): void {
    // Shape guard at the commit boundary (the speech-commit-guard pattern):
    // pictures ride a carrier — the echo, the draft, the no-key hold — and
    // MUST clear with it. The carriers are cleared from many sites (turn
    // finished/failed, the record's user block, resets, the safety nets);
    // normalizing here means none of those sites can strand a picture list,
    // now or after the next refactor.
    if (next.pendingUser === null && next.pendingUserImages !== null) {
      next = { ...next, pendingUserImages: null };
    }
    if (next.composerDraft === null && next.composerDraftImages !== null) {
      next = { ...next, composerDraftImages: null };
    }
    if (next.needsKeyText === null && next.needsKeyImages !== null) {
      next = { ...next, needsKeyImages: null };
    }
    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  private onReset(e: SessionSnapshot | SessionError | SessionNoSession): void {
    if ("noSession" in e) {
      this.emit({ ...INITIAL, bootstrapped: true });
      return;
    }
    if ("error" in e) {
      this.emit({ ...INITIAL, error: e.error });
      return;
    }
    this.emit({
      sessionId: e.sessionId,
      // Pin the conversation's language for the 板砖→Brick alias (absent on
      // legacy snapshots → zh).
      lang: e.lang ?? "zh",
      record: e.record,
      recordStart: e.recordStart ?? 0,
      // PRESERVED across the reset, deliberately (2026-07-27). A search click
      // requests the jump BEFORE calling openSession, so that the conversation
      // entrance — which fires on this very reset and otherwise re-pins and
      // scrolls to the latest turn — can see the intent and stand down.
      // Clearing here instead made the two race, and the entrance usually won.
      // The window is tiny: Conversation consumes and clears it on the next
      // commit. A FAILED open clears it explicitly at the call site.
      //
      // But only when the reset ACTIVATED the session the jump was for (audit
      // BL12). The request already carries its target session — carrying it
      // forward unconditionally meant a reset that activated a DIFFERENT
      // session (a tray click, a rewind, a delete landing on a neighbour
      // between the request and the open) handed a block index from one
      // transcript to another, and the reader landed somewhere arbitrary.
      pendingJump:
        this.snapshot.pendingJump?.sessionId === e.sessionId
          ? this.snapshot.pendingJump
          : null,
      streamingText: null,
      prediction: null,
      overlay: e.overlay,
      // A reset that lands mid-turn — a window reloaded while Herta or 板砖
      // worked — comes back busy (UX review 2026-09-22, item 7): Stop, the
      // hold window, the live timers. Idle was the only state a reset knew,
      // and a running turn showed no Stop until it ended. The timers start
      // at the reset: when the turn really began, this window never saw.
      status: e.turn !== undefined ? "thinking" : "idle",
      error: null,
      pendingUser: null,
      pendingUserImages: null,
      retracting: false,
      retryText: null,
      retractKeepLen: null,
      turnStartedAt: e.turn !== undefined ? Date.now() : null,
      backendActive: e.turn?.backendActive ?? false,
      backendInFlight: 0,
      live: EMPTY_LIVE,
      backendStartedAt: e.turn?.backendActive === true ? Date.now() : null,
      backendError: false,
      backendSucceededSeq: 0,
      recapCompacting: false,
      supervisorChecking: false,
      // Disk-loaded title renders instantly (no typewriter on reopen).
      title: e.title ?? null,
      titleAnimate: false,
      topics: e.topics ?? [],
      // New activation: forget the prior activation's first message.
      activationFirstUser: null,
      // Seed the effective backend workspace from the snapshot; live
      // `workspace` events update it thereafter.
      backendWorkspace: e.backendWorkspace ?? null,
      backendWorkspaceIsDefault: e.backendWorkspaceIsDefault ?? false,
      repo: e.repo ?? null,
      // A fresh activation starts the composer empty (no stale rewind draft,
      // no message held for a turn that belonged to another session).
      composerDraft: null,
      composerDraftImages: null,
      restagedImages:
        e.stagedImages !== undefined && e.stagedImages.length > 0
          ? e.stagedImages
          : null,
      held: null,
      // The 继续 offer as main has it for this session (ADR 0071 §1.4).
      resumable: e.resumable === true,
      // The 撤销 chip as main has it for this session (ADR 0074 §4).
      undoable: e.undoable === true,
      rewindUndo: null,
      composerNotice: null,
      needsKeyText: null,
      needsKeyImages: null,
      bootstrapped: true,
      turnFailed: false,
      turnFailedStatus: null,
      turnFailedProviderCode: null,
      // A reset means navigation actually happened — the refusal is moot.
      navBlock: null,
    });
    this.hertaLandedThisTurn = false;
    // The open-session journey ends when this record is on screen.
    journeyMarkAfterPaint("open-session:painted");
  }

  private onWorkspace(e: WorkspaceEvent): void {
    if (e.kind !== "workspace") return; // ignore the dropped overflow sentinel
    this.emit({
      ...this.snapshot,
      backendWorkspace: e.workspace,
      backendWorkspaceIsDefault: e.isDefault,
    });
  }

  private onRepo(e: RepoEvent): void {
    if (e.kind !== "repo") return; // ignore the dropped overflow sentinel
    // A late answer for a workspace the session has since left describes
    // the wrong folder; the new workspace's own probe is on its way.
    if (
      this.snapshot.backendWorkspace !== null &&
      e.workspace !== this.snapshot.backendWorkspace
    ) {
      return;
    }
    this.emit({ ...this.snapshot, repo: e.repo });
  }

  private onSessionDeleted(e: SessionDeletedEvent): void {
    // Only the OPEN session blanks the panel; deleting any other session
    // leaves this view untouched (the sidebar list drops its card separately).
    if (e.sessionId === this.snapshot.sessionId)
      this.emit({ ...INITIAL, bootstrapped: true });
  }

  private onTitle(e: TitleEvent): void {
    if (e.kind !== "title") return;
    // A title event carrying a topic marks a boundary — append it (dedupe
    // defensively: an IPC replay of the same event must not double it).
    const last = this.snapshot.topics[this.snapshot.topics.length - 1];
    const topics =
      e.topic !== undefined &&
      (last === undefined ||
        last.anchorIndex !== e.topic.anchorIndex ||
        last.title !== e.topic.title)
        ? [...this.snapshot.topics, e.topic]
        : this.snapshot.topics;
    // Live generation → animate the header reveal.
    this.emit({ ...this.snapshot, title: e.title, titleAnimate: true, topics });
  }

  private onRecord(e: RecordEvent): void {
    if (e.kind === "dropped") {
      // Overflow hole: a block event was lost, so this mirror is permanently
      // missing a block (screen would diverge from the canonical record, D7).
      // Ask main to re-emit the full record as a `reset` THROUGH the record
      // channel — FIFO with block events makes the heal race-free; it folds
      // below like any reset. Fire-and-forget; a missing bridge method (older
      // fakes) or a rejected invoke degrades to the old ignore behavior.
      // (Chat-scale streams never fill the bounded queue; defense in depth.)
      void this.bridge?.resyncRecord?.().catch(() => undefined);
      return;
    }
    if (e.kind === "reset") {
      // Full-record replacement: adopt the record and clear the turn's
      // transient view state. Session identity + title stay put. Two sources:
      // a rewind (shorter record; the withdrawn user text is restored to the
      // composer by the rewind action, not here) or a drop-heal resync
      // (re-emitted full record after an overflow drop; see the `dropped`
      // branch below).
      //
      // Timestamp preservation: the server's IN-MEMORY blocks carry `at` only on
      // ones it stamped at creation (the opening seed) — live turn blocks were
      // stamped on the streamed COPY, not the canonical block, so the reset record
      // can arrive missing the `at` the GUI already holds. Rewind is a pure
      // truncation (the survivors are a prefix), so carry over the existing
      // per-index `at` wherever a reset block lacks one — otherwise the surviving
      // bubbles lose their hover timestamps. (Heal resets come from the sink's
      // mirror of STAMPED copies, so every block already carries `at` and this
      // merge no-ops — index misalignment across the hole can't misstamp.)
      // Windowing (2026-07-12): both sides are windows now, so alignment is
      // by ABSOLUTE index — incoming block i sits at `start + i`; the prior
      // window holds it at `start + i - prevStart` (when loaded).
      const start = e.start ?? 0;
      const prev = this.snapshot.record;
      const prevStart = this.snapshot.recordStart;
      const record = e.record.map((b, i) => {
        if (b.at !== undefined) return b;
        const at = prev[start + i - prevStart]?.at;
        return at !== undefined ? { ...b, at } : b;
      });
      // A reset that changed the topic history (rewind) CARRIES the new one —
      // adopt it. This used to re-derive the pruning here by testing anchor
      // liveness against the new end, which is not the rule: a topic can be
      // anchored at a message from hours ago (the title window's start) and
      // still belong to the turn just withdrawn, so it passed the test and its
      // rail tick outlived it (user 2026-07-30). The server owns the rule, and
      // now the wire carries the answer rather than the inputs to a second
      // implementation of it. No `topics` means this reset cannot have changed
      // them (a drop-heal resync).
      const topics = e.topics ?? this.snapshot.topics;
      // `activationFirstUser` is frozen at this activation's first user block
      // and is what the SIDEBAR shows for the active card. A rewind can
      // withdraw the very message it froze — and this branch, which already
      // prunes topics and the failure notice for "the truncation invalidated
      // it", used to leave it standing: rewinding a just-sent message left the
      // card previewing the withdrawn text (user 2026-08-03; the sidebar
      // store's own refresh could not help, since the active card prefers this
      // value over `lastUserText`). Only a SHRINKING reset re-decides — a
      // drop-heal resync re-emits the same or a longer record and must not
      // disturb a live turn's frozen preview. Gone from the record → null, and
      // the card falls back to the disk-backed `lastUserText`.
      const shrank = start + record.length < prevStart + prev.length;
      const frozen = this.snapshot.activationFirstUser;
      const activationFirstUser =
        shrank &&
        frozen !== null &&
        !record.some((b) => b.kind === "user" && b.text === frozen)
          ? null
          : frozen;
      this.emit({
        ...this.snapshot,
        record,
        recordStart: start,
        activationFirstUser,
        ...STREAM_VIEW_CLEARED,
        // The failure notice belongs to the turn it describes: a rewind that
        // withdraws that turn must take the notice with it, or it sits under
        // a now-shorter conversation reading as though the REWIND failed
        // (audit 2026-07-24, L2). This branch already prunes topics for the
        // same "the truncation invalidated it" reason.
        //
        // Deliberately NOT a blanket turn-transient clear: this branch also
        // serves a mid-turn drop-heal resync, where clearing turnStartedAt /
        // backendActive / overlay would break a LIVE turn.
        ...TURN_FAILURE_CLEARED,
        topics,
      });
      return;
    }
    const block = e.block;
    if (block.kind === "herta") this.hertaLandedThisTurn = true;
    const record = [...this.snapshot.record, block];
    // A finalized herta block supersedes the transient streaming bubble.
    const streamingText =
      block.kind === "herta" ? null : this.snapshot.streamingText;
    // It also terminates any in-flight retract morph — the block IS the
    // retry's full text; the morph's transient state is done.
    const retracting =
      block.kind === "herta" ? false : this.snapshot.retracting;
    const retryText = block.kind === "herta" ? null : this.snapshot.retryText;
    const retractKeepLen =
      block.kind === "herta" ? null : this.snapshot.retractKeepLen;
    // The turn's real user block replaces the optimistic echo.
    const pendingUser =
      block.kind === "user" ? null : this.snapshot.pendingUser;
    // Capture the FIRST user message of this activation (frozen after). These
    // are streamed blocks (the activation's initial record arrives via reset,
    // not onRecord), so the first one here is this activation's first message.
    const activationFirstUser =
      block.kind === "user" && this.snapshot.activationFirstUser === null
        ? block.text
        : this.snapshot.activationFirstUser;
    this.emit({
      ...this.snapshot,
      record,
      streamingText,
      retracting,
      retryText,
      retractKeepLen,
      pendingUser,
      activationFirstUser,
    });
  }

  private onAgent(e: SessionAgentEvent): void {
    if (e.kind === "dropped") return;
    const ev = e.event;
    if (ev.type === "turn.started" && ev.layer === "backend") {
      this.emit({
        ...this.snapshot,
        backendActive: true,
        backendInFlight: 0,
        live: EMPTY_LIVE,
        backendStartedAt: Date.now(),
        backendError: false,
      });
      return;
    }
    if (ev.type === "turn.finished" && ev.layer === "backend") {
      // backendStartedAt is intentionally left set (carried via spread): the
      // ActivityBlock already froze its elapsed against its captured start; the
      // actor turn-finished clears it. A second @板砖 dispatch re-stamps it.
      // The live views are KEPT: the record trails the backend by the length of
      // Herta's beats (lab 2026-09-30), and the trace card needs the last
      // views until the done-marker lands. The next run clears them.
      this.emit({
        ...this.snapshot,
        backendActive: false,
        backendInFlight: 0,
        backendError: false,
      });
      return;
    }
    // The run's VERDICT (audit 2026-07-24, 1.1). `turn.finished` only means
    // the backend loop ended without throwing — a user-denied (blocked) or
    // all-failed (partial) run ends exactly the same way and emits no
    // turn.failed, so counting it as success flashed the card green 完成
    // while the activity line beside it said 受阻. The report is the one
    // value that states what happened.
    if (ev.type === "agent.report" && ev.layer === "backend") {
      if (ev.report.status === "completed") {
        this.emit({
          ...this.snapshot,
          backendSucceededSeq: this.snapshot.backendSucceededSeq + 1,
        });
      }
      return;
    }
    if (ev.type === "turn.failed" && ev.layer === "backend") {
      // backendStartedAt is intentionally left set (carried via spread) — same
      // rationale as turn.finished above; the actor turn-failed clears it.
      //
      // An INTERRUPT is not an error (audit 2026-07-24, M2). Stopping a run
      // deliberately used to turn the always-visible 差分协处理器 card red and
      // leave it red until the next message — while the conversation stayed
      // (correctly) silent, so the two surfaces contradicted each other about
      // the same event. The actor's own failure branch already encodes this
      // policy ("the user did it deliberately", turnFailed below); the device
      // path just never got the exclusion.
      // Neither is the step limit: the run stopped where it stood and can be
      // continued (2026-09-29).
      this.emit({
        ...this.snapshot,
        backendActive: false,
        backendInFlight: 0,
        backendError:
          ev.error.kind !== "interrupted" && ev.error.kind !== "step_limit",
      });
      return;
    }
    // In-flight tool tracking (ADR 0025 slice 5 chrome): a parallel batch
    // emits several started events before any finished — the count drives
    // the multi-row shimmer. Bounded below at 0 (defensive: a finished
    // without its started can arrive after a mid-turn reconnect).
    if (ev.type === "tool.call.started" && ev.layer === "backend") {
      this.emit({
        ...this.snapshot,
        backendInFlight: this.snapshot.backendInFlight + 1,
      });
      return;
    }
    if (ev.type === "tool.call.finished" && ev.layer === "backend") {
      this.emit({
        ...this.snapshot,
        backendInFlight: Math.max(0, this.snapshot.backendInFlight - 1),
      });
      return;
    }
    // Long-session recap compaction: a transient, ephemeral hint that the
    // recap summarizer is running. `start` raises the in-world status row,
    // `end` clears it. Never enters the durable record (per the event's
    // ephemeral contract).
    if (ev.type === "recap.compaction") {
      this.emit({ ...this.snapshot, recapCompacting: ev.phase === "start" });
      return;
    }
    // Supervisor judgment window (bug 4, 2026-07-09): same ephemeral
    // contract as recap.compaction. `start` marks the verdict as pending
    // (the paced reveal is holding its tail); `end` clears it on OK / veto /
    // fail-soft alike. The Conversation debounces the visible hint so quick
    // verdicts never flash it.
    if (ev.type === "supervisor.check") {
      this.emit({
        ...this.snapshot,
        supervisorChecking: ev.phase === "start",
      });
      return;
    }
    // Only the actor layer feeds Herta's streaming speech bubble. Backend
    // (@板砖) deltas are the silent coding agent's tokens — per D6/D7 the
    // backend never speaks to the user (its work projects as 差分协处理器
    // record blocks), so they must not leak into the speech stream.
    if (ev.type === "assistant.delta" && ev.layer === "actor") {
      // Turn-active guard (audit T3.7 latent): deltas ride the agent channel
      // while turn lifecycle rides its own — a tail delta pumped AFTER the
      // cross-channel turn.finished would resurrect a phantom streaming
      // bubble (and its caret) over the already-finalized block, with
      // nothing left to clear it. Outside a turn there is nothing a delta
      // can legitimately add: the finalized record block is the truth.
      if (this.snapshot.status === "idle") return;
      if (this.snapshot.retracting) {
        // Deltas during a retract are the RETRY's tokens. Buffer them in
        // retryText; the vetoed streamingText stays put — it's the morph's
        // shrink source (useRetractMorph deletes it back to the common
        // prefix with retryText and types the rest forward).
        this.emit({
          ...this.snapshot,
          retryText: (this.snapshot.retryText ?? "") + ev.text,
          status: "speaking",
        });
        return;
      }
      // The reply's first glyph at the renderer's door: the send journey's
      // split between everything upstream and the renderer's own share.
      if (this.snapshot.streamingText === null) journeyMark("send:first-delta");
      this.emit({
        ...this.snapshot,
        streamingText: (this.snapshot.streamingText ?? "") + ev.text,
        status: "speaking",
      });
    }
    // Other agent events ignored in Slice 4 (device states → Slice 5).
  }

  private onSpeech(e: SpeechControlEvent): void {
    if (e.kind === "dropped") {
      // Overflow hole on the speech channel: a `retract` may have been lost.
      // Continuing as-is risks the WORST intermediate state — retry deltas
      // appending to the vetoed candidate, fusing rejected + corrected text
      // into one garbled bubble. Blank the live view instead; the finalized
      // block re-renders the truth at commit. (Chat-scale streams never
      // overflow the queue; this is defense in depth.)
      this.emit({
        ...this.snapshot,
        streamingText: null,
        retracting: false,
        retryText: null,
        retractKeepLen: null,
      });
      return;
    }
    if (e.kind === "retract") {
      // Re-entrant retract while a morph is mid-erase: unreachable in the
      // current actor (the veto retry commits unconditionally), and the morph
      // is keyed on the `retracting` BOOLEAN — it would neither re-seed its
      // shrink source nor restart its timers, while this handler would
      // discard the buffered retry. Ignore the event instead: the in-flight
      // morph continues coherently and the block commit settles the truth.
      if (this.snapshot.retracting) return;
      // Keep streamingText (the vetoed candidate — the morph's shrink source)
      // and start buffering retry deltas fresh. Clear any stale floor from a
      // prior retract. useRetractMorph owns the animation; record/turn events
      // clear the state (onRecord herta block, onTurn finished/failed).
      // Cross-iteration retracts (a turn CAN veto more than once — post-@板砖
      // commentary is supervised too) arrive here with retracting FALSE: the
      // prior retry's block commit cleared the state before the next
      // candidate streamed, so each cycle seeds cleanly.
      this.emit({
        ...this.snapshot,
        retracting: true,
        retryText: null,
        retractKeepLen: null,
      });
      return;
    }
    if (e.kind === "retractFloor") {
      // The server-computed divergence (Bug 2). Only meaningful while
      // retracting; ignore a floor that lands outside a morph (the cursor-0
      // veto where no retract event fired).
      if (this.snapshot.retracting) {
        this.emit({ ...this.snapshot, retractKeepLen: e.keepLen });
      }
      return;
    }
  }

  private onTurn(e: TurnLifecycleEvent): void {
    if (e.kind === "started") {
      this.hertaLandedThisTurn = false;
      // Keep pendingUser — the optimistic echo stays until the real user
      // block lands. Clear the (stale) streaming text AND any stale retract
      // state — if a finished/failed event was dropped or reordered, a stuck
      // retracting flag would silently route the new turn's deltas into retryText.
      this.emit({
        ...this.snapshot,
        status: "thinking",
        streamingText: null,
        // The suggestion was for the line just sent.
        prediction: null,
        retracting: false,
        retryText: null,
        retractKeepLen: null,
        turnStartedAt: Date.now(),
        backendStartedAt: null,
        backendError: false,
        supervisorChecking: false,
        // Same dropped-end-event reasoning as supervisorChecking above: a
        // lost `recap.compaction end` otherwise strands the flag, and the
        // RecapCompactRow shows where the galaxy should for the rest of the
        // turn (review 2026-07-31 — the one sibling this list missed).
        recapCompacting: false,
        // NOTE: pendingUser is deliberately KEPT — it is the optimistic echo
        // of the message that started this turn, and it clears when the
        // turn's own user block lands. (So STREAM_VIEW_CLEARED, which drops
        // it, is not applicable here.)
        ...TURN_FAILURE_CLEARED,
      });
    } else if (e.kind === "finished") {
      // Safety net: on success the user block already cleared pendingUser;
      // this drops any dangling echo. Do NOT clear streamingText here on the
      // normal path — the finalized record block clears it atomically
      // (onRecord); clearing on finished could race the record event across
      // IPC channels and flicker the normal end-of-stream transition. TWO
      // exceptions clear it here because no block will ever come:
      //   - an unresolved retract (an empty veto-retry commits nothing), and
      //   - a turn that finished WITHOUT committing a herta block at all
      //     (clean-to-empty, slice 4) — the phantom bubble + caret would
      //     otherwise sit there forever. If the record event merely lost
      //     the cross-channel race, its arrival re-renders the block anyway.
      const retractCleanup =
        this.snapshot.retracting ||
        (!this.hertaLandedThisTurn && this.snapshot.streamingText !== null)
          ? {
              streamingText: null,
              retracting: false,
              retryText: null,
              retractKeepLen: null,
            }
          : {};
      this.emit({
        ...this.snapshot,
        status: "idle",
        pendingUser: null,
        turnStartedAt: null,
        backendStartedAt: null,
        backendActive: false,
        // Safety net: if the recap.compaction / supervisor.check `end` event
        // was dropped, the turn ending clears the transient hints so they
        // can't linger.
        recapCompacting: false,
        supervisorChecking: false,
        // Safety net: a permission gate exists only WITHIN a turn (the backend
        // awaits its resolution), so a turn ending with the overlay still up
        // means the `resolved` event was dropped/never sent. A stranded overlay
        // is the worst stuck state in the GUI: it suppresses the composer,
        // blocks session switching and new-session — only an app restart
        // escaped. A late stale `resolved` after this is a harmless no-op.
        overlay: null,
        ...retractCleanup,
      });
    } else if (e.kind === "predicted") {
      // Offered only to an idle composer with no card up; anything that
      // started since owns the composer now.
      if (this.snapshot.status === "idle" && this.snapshot.overlay === null) {
        this.emit({ ...this.snapshot, prediction: e.text });
      }
    } else if (e.kind === "failed") {
      // Safety net: on failure (no blocks emitted) drop the dangling echo and
      // also clear any retract state (no finalized record block will come to
      // clear it). `overlay: null` per the same stranded-gate rationale as
      // "finished" — a turn that died mid-gate must not lock the app.
      //
      // turnFailed (slice 4): a genuine failure used to silently evaporate
      // the half-typed sentence — surface a small inline notice instead. A
      // user interrupt reports code "AbortError" (the actor's abort error
      // name) and stays silent: the user did it deliberately.
      this.emit({
        ...this.snapshot,
        status: "idle",
        pendingUser: null,
        streamingText: null,
        retracting: false,
        retryText: null,
        retractKeepLen: null,
        turnStartedAt: null,
        backendStartedAt: null,
        backendActive: false,
        recapCompacting: false,
        supervisorChecking: false,
        overlay: null,
        turnFailed: e.error.code !== "AbortError",
        // The provider's HTTP status (official DeepSeek codes) when the
        // failure carried one — the notice row maps it to a specific
        // message (402 balance, 401 key, …) instead of "connection lost".
        turnFailedStatus:
          e.error.code !== "AbortError" ? (e.error.status ?? null) : null,
        // And the provider's own code for the failures that have no HTTP
        // status at all — a certificate or proxy problem reaches the row this
        // way (audit S3).
        turnFailedProviderCode:
          e.error.code !== "AbortError" ? (e.error.providerCode ?? null) : null,
      });
    }
  }

  private onOverlay(e: OverlayEvent): void {
    if (e.kind === "pending") {
      this.emit({ ...this.snapshot, overlay: e.overlay });
    } else if (e.kind === "resolved") {
      this.emit({ ...this.snapshot, overlay: null });
    }
  }
}
