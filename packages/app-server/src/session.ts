/**
 * SessionImpl — real Session composing the v0.2 runtime.
 *
 * Wires the same components that packages/cli/src/app/main.ts assembles,
 * but without TTY sinks (no NarrativeRenderer, no Input, no CliAskResolver).
 * Turns are driven through a V2ActorDriver, giving the desktop session the
 * same mood-routing + supervisor wiring as the CLI. An all-empty meta-think
 * corpus and empty supervisor reference degrade to single-phase actor mode.
 *
 * v0.3 Slice 2 Task 5 — uses SessionEventProjector for all subscription channels.
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ApprovalOverlayState,
  defaultWorkspaceFor,
  isAbortError,
  type LastTurnEnd,
  type ProjectCommandRuleStore,
  type ProviderAdapter,
  ruleDisplay,
  type SessionTopic,
  type SystemBlock,
  type TerminalRecord,
  type TerminalRecordBlock,
  type V2RecordPersister,
} from "@herta/core";
import {
  type MetaThinkCorpus,
  type OpeningChoice,
  type PromptLang,
  type StaticHertaPrefix,
  V2ActorDriver,
} from "@herta/herta";
import { type ApiKey, deepseekVisionCaptioner } from "@herta/providers";
import { type ImageCaptioner, migrateAttachments } from "./attachments.js";
import { BusActorStreamingSink } from "./bus-streaming-sink.js";
import { OverlayAskResolver } from "./overlay-ask-resolver.js";
import { recordTail } from "./record-window.js";
import { SessionAttachments } from "./session-attachments.js";
import { SessionEventProjector } from "./session-event-projector.js";
import {
  createTitleProvider,
  loadSessionTitleState,
  SessionTitler,
} from "./session-titler.js";
import { loadSessionVoice, type SessionVoice } from "./session-voice.js";
import {
  createActorStack,
  createBackendProvider,
  createBackendStack,
  defaultDigestModel,
  digestModelFrom,
} from "./session-wiring.js";
import type { StagedImage } from "./staged-images.js";
import type {
  ApprovalResult,
  AppServerConfig,
  AttachResult,
  OverlayEvent,
  RecordEvent,
  RemoveAttachmentResult,
  ResolveApprovalOpts,
  RewindResult,
  Session,
  SessionAgentEvent,
  SpeechControlEvent,
  StageImagesResult,
  TitleEvent,
  TurnLifecycleEvent,
  VoiceCueEvent,
  WorkspaceEvent,
  WorkspaceSetResult,
} from "./types.js";

/**
 * True when a withdrawn span includes a backend (板砖) done-marker that reports
 * changed files — used to warn that those filesystem edits are NOT reverted by a
 * record-only rewind. The done-marker's `body` carries an "N files" segment and
 * its `evidenceDetail` an "改动文件" list only when `changedFiles > 0`
 * (see `buildDoneMarker` in `@herta/herta`'s backend-bridge).
 */
export function spanEditedFiles(blocks: TerminalRecord): boolean {
  return blocks.some(
    (b) =>
      b.kind === "system" &&
      b.label === "差分协处理器" &&
      (b.evidenceDetail?.includes("改动文件") === true ||
        /\b\d+ files?\b/.test(b.body)),
  );
}

// The title machinery — tuning constants, the recent-window input, the
// provider, the sidecar load and the titler itself — lives in
// session-titler.ts (2026-09-03). `buildRecentTitleInput` is re-exported
// for its tests.
export { buildRecentTitleInput } from "./session-titler.js";

/**
 * The `turn.failed` error payload. Carries the provider's HTTP status when
 * the failure has one (ProviderError.status — the official DeepSeek error
 * codes: 401 bad key, 402 insufficient balance, 429 rate limit, 500/503
 * server; 2026-07-12), so the renderer can say what actually went wrong
 * instead of the generic connection-lost line. Duck-typed: any Error
 * carrying a numeric `status` qualifies, so provider wrappers keep working.
 */
export function turnErrorPayload(err: unknown): {
  code: string;
  message: string;
  status?: number;
  providerCode?: string;
} {
  if (err instanceof Error) {
    const status = (err as { status?: unknown }).status;
    // `code` stays `err.name` — the renderer keys "AbortError" off it to tell
    // a user interrupt from a failure. The provider's OWN code rides
    // alongside so a certificate/proxy failure (audit S3), which has no HTTP
    // status, can still get its own message instead of "connection lost".
    const providerCode = (err as { code?: unknown }).code;
    return {
      code: err.name,
      message: err.message,
      ...(typeof status === "number" ? { status } : {}),
      ...(typeof providerCode === "string" ? { providerCode } : {}),
    };
  }
  return { code: "unknown", message: String(err) };
}

// ── Test-only seam ──────────────────────────────────────────────────────────

/**
 * Test-only override seam. NOT exported from the package barrel.
 * Production code always omits this; tests pass stubs via `SessionImpl.create`
 * directly (bypassing `createSessionHost`).
 */
export interface SessionInternalDeps {
  /** Inject stub providers instead of constructing real DeepSeek providers. */
  readonly providerOverrides?: {
    readonly actor?: import("@herta/core").CompletionProviderAdapter;
    readonly backend?: import("@herta/core").ProviderAdapter;
    readonly router?: ProviderAdapter;
    readonly supervisor?: ProviderAdapter;
    readonly title?: ProviderAdapter;
    /** The digest tool's side model (ADR 0043). With `providerOverrides`
     *  present and this absent, the tool mounts `unavailable`. */
    readonly digest?: ProviderAdapter;
  };
  /** Skip the async buildStaticHertaPrefix disk scan. */
  readonly staticPrefixOverride?: StaticHertaPrefix;
  /** Replace the compiled meta-think corpus (M-prompts-1: always fully
   *  populated in production). An all-empty corpus disables mood routing
   *  (single-phase actor mode) — stub-session tests rely on that. */
  readonly metaThinkOverride?: MetaThinkCorpus;
  /** Replace the config-derived supervisor toggle. Empty string disables
   *  the supervisor (stub tests); production defaults ON via
   *  `config.supervisor?.enabled`. */
  readonly supervisorReferenceOverride?: string;
  /** Inject a deterministic opening instead of the real `pickOpening`
   *  (which now draws from the COMPILED corpus and thus always finds
   *  candidates — M-prompts-1). `null` means "no opening" explicitly;
   *  stub-session tests need it because an unpicked corpus no longer
   *  exists. New-session-only — ignored when the caller passes a
   *  non-empty `initialRecord` (resumed sessions already carry block 0). */
  readonly openingOverride?: OpeningChoice | null;
  /** D3: override the opening-stream lead beat (ms held before the seed starts
   *  streaming, so the in-flight hint shows). Defaults to `OPENING_LEAD_MS`;
   *  tests pass 0 to skip the wall-clock wait. */
  readonly openingLeadMs?: number;
  /** Inject the opening clip's duration (ms) instead of reading the clip from
   *  disk (clip-matched cadence tests). Skips `readOpusDurationMs`. */
  readonly openingDurationMs?: number | null;
  /** Random source for picking a particle clip variant. Defaults to
   *  `Math.random`; tests inject a deterministic source. */
  readonly particleRandom?: () => number;
  /** Random source for the veto-reaction roll (case selection + clip pick).
   *  Defaults to `Math.random`; tests inject a deterministic source. */
  readonly vetoRandom?: () => number;
  /** Random source for the easter-egg 50% roll + clip pick. Defaults to
   *  `Math.random`; tests inject a deterministic source. */
  readonly easterEggRandom?: () => number;
  /** Clock (ms) for the easter-egg per-session hourly throttle. Defaults to
   *  `Date.now`; tests inject a controllable clock. */
  readonly easterEggNow?: () => number;
}

/**
 * ADR 0044: the record note a NEW session carries when the configured
 * `minimal` contract fell back to `standard` because no bash exists on this
 * machine. Names the remedy — before this, the only surfaces were a
 * console.warn no GUI user sees and a Settings sentence that named the
 * problem but not the fix. Static harness text (the appendSystemNote caller
 * owns sanitizing; there is no user input here).
 */
function contractFallbackNote(lang: PromptLang): string {
  return lang === "en"
    ? 'no bash found — the "minimal" tool contract is unavailable, running "standard" this session. Install Git for Windows (or set HERTA_BASH) and restart.'
    : "未检测到 bash：工具契约「极简」不可用，本次按「标准」运行。安装 Git for Windows（或设置 HERTA_BASH）后重启生效。";
}

// ── SessionImpl ─────────────────────────────────────────────────────────────

export class SessionImpl implements Session {
  readonly sessionId: string;
  readonly workspaceRoot: string;

  // The EFFECTIVE backend (板砖) workspace lives in a single mutable holder
  // shared with the runtimeFactory closure (created in `create`) so a future
  // setWorkspace can mutate the value the factory reads on its next dispatch.
  // Distinct from workspaceRoot (the immutable record-store anchor).
  private readonly wsHolder: { current: string };
  private wsIsDefault: boolean;

  // The block persister — owned by the driver for turn blocks, but held here
  // too so setWorkspace/resetWorkspace can append a structured workspace_set
  // line that survives resume.
  private readonly persister: V2RecordPersister;

  private _record: TerminalRecord;
  private _overlay: ApprovalOverlayState | null = null;

  // Generalized event projector — fan-out to all subscribers with bounded
  // queues and dropped-event sentinels (Task 5). Bus subscription is wired
  // via constructor opts so agent events pass through automatically.
  private readonly projector: SessionEventProjector;

  // Overlay resolver — installed in create() and held here so
  // resolveApproval() can call resolveExternal().
  private readonly overlayResolver: OverlayAskResolver;

  // Project command allow rules (ADR 0030) — held for the Settings
  // management surface (list/remove); the resolver consults it directly.
  private readonly commandRules: ProjectCommandRuleStore;

  // The narrative-completion actor driver — owns the growing TerminalRecord,
  // mood routing, the supervisor, and (via its persister) block persistence.
  // submitText delegates to driver.runTurn and broadcasts the driver's new
  // blocks; the driver appends them to disk itself, so submitText must NOT
  // re-persist (no double-append).
  private readonly driver: V2ActorDriver;

  // The actor streaming sink — held so rewindLastTurn can reset its
  // canonical-diff cursor (emittedCount) to the truncated record length, so the
  // next turn's flushBlocks emits from the new tail rather than the stale count.
  private readonly sink: BusActorStreamingSink;

  /** How this session's last turn ended per the loaded file, or undefined
   *  when it recorded no ending (a true mid-stream crash). Never cleared
   *  in-process — every turn overwrites it on ITS ending, and the mid-turn
   *  window is covered by the `currentTurn` gate in
   *  regenerateLastReplyIfOrphaned. Gates resume-recovery (audit
   *  2026-07-24, 1.6). */
  private lastTurnEnd: LastTurnEnd | undefined;

  /** The session's voice cues — opening clip and cadence, particle, veto
   *  reaction, easter egg — with their catalogs and repeat-avoidance state
   *  (session-voice.ts). */
  private readonly voice: SessionVoice;

  // D3 (streaming opening): a NEW session's opening seed, deferred from the
  // in-memory record so playOpening can stream it in like a reply. null for
  // resumed sessions and new sessions with no opening. Cleared (one-shot) once
  // playOpening commits it.
  private pendingOpening: TerminalRecordBlock | null;

  // ADR 0044: deferred contract-fallback record note (minimal asked for, no
  // bash found) — null when the contract ran as configured or the session is
  // resumed. Flushed one-shot by flushContractNote (see its doc for why it is
  // deferred rather than appended at create).
  private pendingContractNote: string | null;

  // D3: the opening-stream lead beat (ms held before the seed streams, so the
  // in-flight hint shows). undefined → the driver's OPENING_LEAD_MS default;
  // tests pass 0 to skip the wall-clock wait.
  private readonly openingLeadMs: number | undefined;

  // Live DeepSeek key getter (the host's mutable holder). submitText reads it to
  // detect the no-key case; the providers were built with the same getter.
  private readonly deepSeekKey: () => string;

  // Per-turn abort tracking. Set at the start of submitText; cleared in
  // finally. interrupt() aborts this controller; close() calls interrupt()
  // before tearing down the projector.
  private currentTurn: {
    readonly turnId: string;
    readonly abortController: AbortController;
    /** Resolves when the turn has fully unwound (its finally ran); never
     *  rejects. close() awaits this so teardown — and deleteSession's rmSync
     *  right after it — can never race a still-unwinding turn's appends
     *  (audit 2026-07-10, finding 14). */
    readonly settled: Promise<void>;
  } | null = null;

  /** The session title and its topic history — generation after a user
   *  turn, the rewind fence, the sidecar (session-titler.ts). */
  private readonly titler: SessionTitler;
  // Interaction language (slice 4) — held for per-turn language-parameterized
  // calls (the session-title prompt; the driver got its own copy at
  // construction). PUBLIC (implements Session.lang): the GUI surfaces it so the
  // renderer can localize the 板砖→Brick display to the conversation's language.
  public readonly lang: PromptLang;

  private readonly transcriptDir: string;
  /** The session's documents and pictures — ingest, take-back, the composer's
   *  staged images, the rewind GC (session-attachments.ts). */
  private readonly attachments: SessionAttachments;

  private constructor(opts: {
    sessionId: string;
    workspaceRoot: string;
    wsHolder: { current: string };
    isDefaultWorkspace: boolean;
    persister: V2RecordPersister;
    driver: V2ActorDriver;
    sink: BusActorStreamingSink;
    projector: SessionEventProjector;
    overlayResolver: OverlayAskResolver;
    commandRules: ProjectCommandRuleStore;
    transcriptDir: string;
    titler: SessionTitler;
    pendingOpening: TerminalRecordBlock | null;
    voice: SessionVoice;
    openingLeadMs: number | undefined;
    deepSeekKey: () => string;
    lang: PromptLang;
    lastTurnEnd?: LastTurnEnd;
    pendingContractNote: string | null;
    captionImage: ImageCaptioner | null;
  }) {
    this.lastTurnEnd = opts.lastTurnEnd;
    this.sessionId = opts.sessionId;
    this.workspaceRoot = opts.workspaceRoot;
    this.wsHolder = opts.wsHolder;
    this.wsIsDefault = opts.isDefaultWorkspace;
    this.persister = opts.persister;
    this.driver = opts.driver;
    this.sink = opts.sink;
    // Initial snapshot reflects the driver's record (empty for now; Task 5
    // seeds an opening block before the session is handed to the caller).
    this._record = opts.driver.getRecord();
    this.projector = opts.projector;
    this.overlayResolver = opts.overlayResolver;
    this.commandRules = opts.commandRules;
    this.transcriptDir = opts.transcriptDir;
    this.titler = opts.titler;
    this.pendingOpening = opts.pendingOpening;
    this.voice = opts.voice;
    this.openingLeadMs = opts.openingLeadMs;
    this.deepSeekKey = opts.deepSeekKey;
    this.lang = opts.lang;
    this.pendingContractNote = opts.pendingContractNote;
    this.attachments = new SessionAttachments({
      sessionId: opts.sessionId,
      lang: opts.lang,
      wsHolder: this.wsHolder,
      captionImage: opts.captionImage,
      turnInFlight: () => this.currentTurn !== null,
      driver: this.driver,
      onAppended: () => {
        this._record = this.driver.getRecord();
      },
      onReplaced: () => {
        this._record = this.driver.getRecord();
        // The sink streams by a monotonic cursor and mirrors block
        // REFERENCES, so a mutation behind the cursor is invisible to it —
        // re-seed with the new record (same move rewind makes after
        // truncating), then push the corrected record to the renderer.
        this.sink.seedEmittedCount(this._record.length, this._record);
        this.resyncRecord();
      },
    });
  }

  /**
   * ADR 0044: flush the deferred contract-fallback note (minimal asked for,
   * no bash on this machine) as an out-of-turn `→ 系统` record note — the
   * shared record per D7, so the user learns the remedy where they live and
   * Herta can answer "why is 板砖 on the standard contract" from the record.
   *
   * Deferred rather than appended at create because the record's block order
   * must match the persisted order: a NEW session's opening seed is persisted
   * at create but only committed to the in-memory record when playOpening
   * streams it, so a create-time note would land BEFORE the opening in memory
   * and AFTER it on disk. One-shot; between turns only (appendSystemNote's
   * contract). Called from playOpening (GUI — the note lands right after the
   * opening) and from submitText (a front-end that never plays openings, e.g.
   * the CLI — the note lands before the first user block).
   */
  private flushContractNote(): void {
    const note = this.pendingContractNote;
    if (note === null || this.currentTurn !== null) return;
    this.pendingContractNote = null;
    this.driver.appendSystemNote("系统", note);
    this._record = this.driver.getRecord();
  }

  /**
   * The one turn skeleton (2026-09-03). Three entry points run a turn — a
   * user submit, the resume regenerate (D2) and the opening stream (D3) —
   * and each carried its own copy of the same dozen lines: mint a turn id
   * and an abort controller, take the single-turn slot, emit `started`, run,
   * refresh the record snapshot, emit `finished` or `failed`, release the
   * slot in `finally` (resolving `settled` for close()'s wait) only if this
   * turn still owns it. The copies had drifted in what they did on failure;
   * here the skeleton is one function and each path supplies only what
   * differs: `onFinished` runs after the record refresh and before
   * `finished` (the submit path records the turn's ending there); `onFailed`
   * runs before `failed` (reconciliation, the turn-end marker); `rethrow`
   * says whether the caller sees the error — a user submit does, the two
   * fire-and-forget paths swallow (see each). Callers gate on `currentTurn`
   * BEFORE calling: what a busy session means differs per path (throw,
   * no-op, no-op). Everything `body` does — including work before the
   * driver call, such as taking the staged pictures — runs under the
   * try, so a throw anywhere in it releases the slot instead of wedging
   * the session.
   */
  private async runAsTurn(
    body: (signal: AbortSignal) => Promise<unknown>,
    hooks: {
      readonly onFinished?: () => void;
      readonly onFailed?: (err: unknown) => void;
      readonly rethrow: boolean;
    },
  ): Promise<string> {
    const turnId = randomUUID();
    const abortController = new AbortController();
    let settleTurn: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settleTurn = resolve;
    });
    this.currentTurn = { turnId, abortController, settled };
    this.projector.emitTurnLifecycle({ kind: "started", turnId });
    try {
      await body(abortController.signal);
      this._record = this.driver.getRecord();
      hooks.onFinished?.();
      this.projector.emitTurnLifecycle({ kind: "finished", turnId });
    } catch (err) {
      hooks.onFailed?.(err);
      this.projector.emitTurnLifecycle({
        kind: "failed",
        turnId,
        error: turnErrorPayload(err),
      });
      if (hooks.rethrow) throw err;
    } finally {
      settleTurn();
      // Clear the per-turn state only if this turn still owns it. (A second
      // entry replacing `currentTurn` mid-turn is what the callers' gates
      // forbid; the check keeps a wrong release impossible regardless.)
      if (this.currentTurn?.turnId === turnId) this.currentTurn = null;
    }
    return turnId;
  }

  /** GUI easter egg (SPEC 2026-06-23): called per successful 板砖-card lift
   *  via IPC. The voice module owns the roll and the hourly throttle. */
  maybePlayEasterEgg(): void {
    this.voice.maybePlayEasterEgg();
  }

  // ── Session interface ──────────────────────────────────────────────────────

  get backendWorkspace(): string {
    return this.wsHolder.current;
  }

  get backendWorkspaceIsDefault(): boolean {
    return this.wsIsDefault;
  }

  get record(): TerminalRecord {
    return this._record;
  }

  get overlay(): ApprovalOverlayState | null {
    return this._overlay;
  }

  get title(): string | null {
    return this.titler.title;
  }

  get topics(): readonly SessionTopic[] {
    return this.titler.topics;
  }

  get turnInFlight(): boolean {
    return this.currentTurn !== null;
  }

  /** Stage pictures in the composer (ADR 0048 §4) — see SessionAttachments. */
  stageImages(
    inputs: readonly {
      readonly path?: string;
      readonly bytes?: Uint8Array;
      readonly name?: string;
    }[],
  ): Promise<StageImagesResult> {
    return this.attachments.stageImages(inputs);
  }

  /** Drop a staged image and delete its stored copy. */
  unstageImage(id: string): Promise<boolean> {
    return this.attachments.unstageImage(id);
  }

  /** What is currently waiting in the composer — for a renderer that
   *  reconnects (reload, session switch) and needs to redraw the strip. */
  get stagedImageList(): readonly StagedImage[] {
    return this.attachments.stagedImageList;
  }

  async submitText(
    text: string,
    opts: { readonly stagedImageIds?: readonly string[] } = {},
  ): Promise<{ readonly turnId: string } | { readonly needsKey: true }> {
    // No DeepSeek key yet (first run, or it was cleared): don't run the turn —
    // signal the renderer to prompt for one. The opening (no LLM call) already
    // streamed fine; once a key is set, the kept message is re-sent.
    if (this.deepSeekKey().trim() === "") {
      return { needsKey: true };
    }
    // Single-turn invariant: only one turn — user submit, opening stream (D3),
    // or resume regenerate (D2) — runs at a time. The renderer locks the
    // composer during a turn, but enforce it here too: D2/D3 added main-process
    // turn entry points fired on open/create that the renderer lock does NOT
    // gate, so a duplicate IPC / renderer-reload race could otherwise run two
    // turns concurrently on the single-threaded driver and corrupt the shared
    // record + persist cursor.
    if (this.currentTurn !== null) {
      throw new Error("a turn is already in progress");
    }
    // ADR 0044: a front-end that never calls playOpening (the CLI) still gets
    // the contract-fallback note — between turns, before this turn's user
    // block. One-shot no-op everywhere else.
    this.flushContractNote();
    const turnId = await this.runAsTurn(
      async (signal) => {
        // Take the staged pictures BEFORE the driver runs (ADR 0048 §4):
        // their blocks go in right after the user block, so Herta reads the
        // message and what came with it as one thing. `commit` awaits the
        // captions started at stage time — usually long since resolved under
        // the user's typing. Inside the turn, so a failing commit releases
        // the slot like any other failure instead of leaving it taken.
        let userAttachments: readonly SystemBlock[] = [];
        if (
          opts.stagedImageIds !== undefined &&
          opts.stagedImageIds.length > 0
        ) {
          userAttachments = await this.attachments.commitStaged(
            opts.stagedImageIds,
          );
        }
        // The actor sink (BusActorStreamingSink) streams every appended block
        // to record subscribers in canonical order DURING the turn via
        // flushBlocks (called at each append site in the actor turn + @板砖
        // bridge). So submitText no longer emits records post-turn — it only
        // drives turn lifecycle and refreshes the synchronous .record
        // snapshot. The driver persists each new block to JSONL inside
        // runTurn; nothing to re-persist here. See
        // docs/superpowers/specs/2026-06-01-gui-record-stream-ordering-design.md.
        await this.driver.runTurn(text, signal, true, userAttachments);
      },
      {
        onFinished: () => this.recordTurnEnd("completed"),
        onFailed: (err) => {
          this.reconcileRecordAfterFailure();
          // Durably record HOW this turn ended, so reopening can tell a
          // deliberate stop from a crash (audit 2026-07-24, 1.6). An
          // interrupt and a provider failure both leave a trailing user
          // block; only a crash leaves no ending at all.
          this.recordTurnEnd(isAbortError(err) ? "interrupted" : "failed");
        },
        rethrow: true,
      },
    );
    // Refresh the session title as the conversation evolves (initial title,
    // re-entry, or periodic on a long session). Fire-and-forget — the user
    // already sees Herta's reply; the title fills/updates after.
    this.titler.afterUserTurn();
    return { turnId };
  }

  /**
   * D2 (resume recovery): regenerate the reply for an orphaned trailing user
   * block (a reply lost to a mid-stream app-close). Runs as a normal turn so
   * the composer locks via turn status, the reply streams, and it persists —
   * but does NOT append a new user block (the orphaned one stays in place, and
   * the GUI sink's seeded cursor keeps it from being re-streamed/re-persisted).
   * No-op when the session does not end on a user block.
   *
   * Fire-and-forget (the open handler calls it `void`): a failure emits a
   * `failed` lifecycle and is swallowed rather than rethrown — the orphan stays
   * on disk and regenerates again on the next resume.
   */
  /**
   * Persist how a turn ended and remember it in-process. Best-effort: a
   * failure here must never fail an otherwise-good turn — the cost of a
   * missing marker is one spurious regenerate on the next open, which is the
   * pre-fix behaviour, not a regression.
   */
  private recordTurnEnd(outcome: "completed" | "interrupted" | "failed"): void {
    const entry = {
      outcome,
      atBlockCount: this.driver.getRecord().length,
    } as const;
    this.lastTurnEnd = entry;
    try {
      this.persister.appendTurnEnd?.(outcome, new Date().toISOString());
    } catch {
      // Disk trouble: the in-memory value still guards this process.
    }
  }

  async regenerateLastReplyIfOrphaned(): Promise<void> {
    const last = this.driver.getRecord().at(-1);
    if (last === undefined || last.kind !== "user") return;
    // A trailing user block is NOT proof of a crash (audit 2026-07-24, 1.6).
    // An interrupted turn — and a provider-failed one — leaves a byte-identical
    // file: the user block is flushed at the actor loop's head and persisted
    // before the abort throws. Reading the shape alone meant that opening a
    // session silently RE-RAN a turn the user had deliberately killed: an
    // unrequested API call, and, when the text carried `@板砖`, a coding
    // dispatch that mutates the repo. Regenerate ONLY when the turn left no
    // recorded ending at all — a true mid-stream app-close.
    if (this.lastTurnEnd !== undefined) return;
    // Single-turn invariant (see submitText): a re-entrant CMD.open must not
    // start a second regenerate while one is in flight.
    if (this.currentTurn !== null) return;
    await this.runAsTurn((signal) => this.driver.regenerateLastReply(signal), {
      // The SAME reconciliation submitText does, not the old unconditional
      // reseed (audit 2026-08-05, S9). regenerateLastReply POPS the orphan
      // user block and `runTurn` re-appends it only in the actor's LOCAL
      // record; on a non-abort provider throw the driver adopts the
      // partial record only for ActorTurnAbortedError, so `this.record`
      // sits at N-1 while disk and the screen hold N. Seeding the cursor
      // to N-1 left that split standing, which cost two things:
      //   - the orphan message the user is looking at was permanently
      //     absent from Herta's context (a D7 divergence), and
      //   - `rewindLastUserTurn` derives its index from the DRIVER record
      //     and truncates positionally, so the next rewind silently
      //     deleted an EXTRA user message — one not reported in
      //     `withdrawn` and not returned as `userText`, i.e. unrecoverable.
      // Reachable via a crash-left orphan plus a non-retryable HTTP
      // failure (a 402, say).
      //
      // Deliberately NOT calling recordTurnEnd here: leaving `lastTurnEnd`
      // undefined is what makes the orphan retry on the next open, which
      // is the documented intent of this recovery path.
      onFailed: () => this.reconcileRecordAfterFailure(),
      // Not rethrown — background recovery must not crash the open handler;
      // the orphan persists and retries on the next resume.
      rethrow: false,
    });
  }

  /**
   * D3 (streaming opening): stream a NEW session's deferred opening seed in via
   * the actor sink so it arrives like a reply (read-along pace) rather than
   * appearing instantly. Runs as a turn (lifecycle started/finished) so the
   * composer locks while it streams — no user turn can race the seed commit. The
   * seed is already on disk (persisted at create); this streams + commits it to
   * the in-memory record and settles the render surface. No-op (one-shot) when
   * there is no deferred seed: resumed sessions, or new sessions with no opening.
   *
   * Fire-and-forget (the create handler calls it `void`): a failure emits a
   * `failed` lifecycle and is swallowed — the seed stays on disk and shows as
   * instant history on the next resume.
   */
  async playOpening(): Promise<void> {
    const block = this.pendingOpening;
    if (block === null) {
      // No seed to stream (resumed session, or a new one without an opening)
      // — but a deferred contract note still wants the record (ADR 0044).
      this.flushContractNote();
      return;
    }
    // Single-turn invariant (see submitText): don't stream the opening over an
    // in-flight turn. In practice currentTurn is null here (playOpening fires on
    // create before any turn), so this is a defensive backstop.
    if (this.currentTurn !== null) return;
    this.pendingOpening = null; // one-shot
    // Interrupt-as-SKIP (audit 2026-07-10; supersedes the deliberate
    // non-interruptibility): the composer shows a STOP button during the
    // opening, and interrupt() reported ok while doing nothing — a dead
    // affordance. The turn's abort signal threads into driver.playOpening,
    // where a stop click cuts the lead beat and flushes the remaining seed
    // text in ONE delta (fast-forward, never truncate — the seed still
    // commits verbatim and stays durable).
    //
    // The voice cue fires via onStreamStart — AFTER the lead beat, the
    // instant the text begins streaming — so the opening's voice and its
    // text reveal land together. No clipId → no cue (opening without a voice
    // file); a skip BEFORE stream start also suppresses the cue.
    await this.runAsTurn(
      (signal) =>
        this.driver.playOpening(
          block,
          this.openingLeadMs,
          () => this.voice.onOpeningStreamStart(),
          this.voice.openingBaseMs,
          signal,
        ),
      // Not rethrown — fire-and-forget; the seed is durable on disk and shows
      // as instant history on the next resume.
      { rethrow: false },
    );
    // After the opening settles (success, skip, or failure — the seed is
    // durable either way): the contract-fallback note follows it into the
    // record, so the user reads the opening first and the notice second.
    this.flushContractNote();
  }

  async interrupt(opts?: {
    readonly turnId?: string;
  }): Promise<{ readonly ok: boolean }> {
    if (this.currentTurn === null) return { ok: false };
    if (opts?.turnId !== undefined && opts.turnId !== this.currentTurn.turnId) {
      return { ok: false };
    }
    this.currentTurn.abortController.abort(
      new DOMException("Interrupted by session.interrupt()", "AbortError"),
    );
    return { ok: true };
  }

  /**
   * Rewind the latest 开拓者 turn (record-only, idle-only). Withdraws the last
   * user block and everything after it from the in-memory record + the persisted
   * JSONL (via the driver), resets the sink's canonical-diff cursor so the next
   * turn streams from the new tail, clears a now-stale title if the session
   * emptied, broadcasts a `reset` RecordEvent so subscribers adopt the shorter
   * record, and returns the withdrawn user text (+ whether the span edited files,
   * which are NOT reverted). See the 2026-06-21-rewind-last-turn spec.
   */
  async rewindLastTurn(): Promise<RewindResult> {
    // D-Idle-only: never rewind across an in-flight turn (mirrors submitText's
    // single-turn invariant). The button is also hidden client-side while busy,
    // but enforce it here so an IPC race can't truncate mid-stream.
    if (this.currentTurn !== null) {
      return { ok: false, reason: "turn_in_progress" };
    }
    const result = this.driver.rewindLastUserTurn();
    if (result === null) {
      return { ok: false, reason: "no_user_turn" };
    }
    this._record = this.driver.getRecord();
    // Reset the sink's canonical-diff cursor to the new (shorter) length: the
    // record just shrank, so the next turn's flushBlocks must emit from there,
    // not from the pre-rewind count (which would skip the next turn's blocks).
    // Passing the truncated record re-seeds the sink's resync mirror too.
    this.sink.seedEmittedCount(this._record.length, this._record);
    // Title generation fires at turn end and runs while the session is idle
    // — exactly when this method is allowed — so an in-flight generation may
    // be titling the window this rewind is about to withdraw. The titler
    // fences it out, clears a title whose exchange is gone, and prunes the
    // topic anchors beyond the truncation (see SessionTitler.onRewind); the
    // guard on currentTurn above cannot catch any of that.
    this.titler.onRewind(
      this._record.length,
      this._record.some((b) => b.kind === "user"),
    );
    // Broadcast the truncated record so every subscriber replaces its mirror
    // — windowed like every full-record payload (long sessions, 2026-07-12) —
    // and the pruned topic history with it. The topics ride along because this
    // is the only event that shrinks the record, and the renderer cannot work
    // the pruning out for itself: a topic anchored in surviving history but
    // BORN in the withdrawn turn looks alive from there (user 2026-07-30).
    const tail = recordTail(this._record);
    this.projector.emitRecord({
      kind: "reset",
      record: tail.record,
      start: tail.start,
      topics: this.titler.topics,
    });
    // Stored-attachment GC last: the record is already truncated and
    // broadcast, and a failed unlink must not fail the rewind (best-effort,
    // like the ✕). See the method for the D-Record-only amendment. The
    // withdrawn PICTURES come back as staged entries instead of being
    // deleted (owner 2026-08-27) — they ride the restored draft.
    const images = await this.attachments.cleanUpWithdrawn(
      result.withdrawn,
      this._record,
    );
    return {
      ok: true,
      userText: result.userText,
      editedFiles: spanEditedFiles(result.withdrawn),
      ...(images.length > 0 ? { images } : {}),
    };
  }

  /**
   * Renderer-requested record heal after a record-channel overflow drop
   * (defense in depth — chat-scale streams never fill the 1000-deep queue).
   * Delegates to the sink, which re-emits its live mirror as a `reset`
   * through the record stream: same channel as block events, so FIFO
   * ordering makes the heal race-free even mid-turn (an out-of-band
   * snapshot could duplicate still-queued blocks, and `_record` is stale
   * mid-turn). Synchronous and side-effect-free beyond the one event.
   */
  resyncRecord(): void {
    this.sink.resyncRecord();
  }

  /**
   * Re-align the THREE copies of the record after a failed turn: the DRIVER's
   * in-memory record, the SINK's flushed mirror (what streamed + what is on
   * disk), and `this._record` (what the snapshot serves).
   *
   * On a PLAIN provider throw the driver keeps its pre-turn record — only
   * aborts adopt the partial one — while the sink's cursor sits at the failed
   * turn's high-water mark. Left split, the next turn's user block lands BELOW
   * the cursor: never streamed, never persisted, visually vanishing when
   * `finished` clears the optimistic echo, while disk keeps the failed turn's
   * text in its place (audit 2026-07-10, finding 10).
   *
   * Worse, `rewindLastTurn` derives its index from the DRIVER's record but
   * truncates the DISK file, so a stale split aims it a whole turn too early —
   * clicking rewind on a failed message withdrew the PREVIOUS exchange and
   * destroyed the failed message with it (audit 2026-07-24, H1).
   *
   * Adopt UP, not down: the flushed record is what the user sees and what disk
   * holds, so it is the authority. Adopting it also restores D7 — otherwise
   * Herta's next prompt could not see the message the user is still looking
   * at. (Resetting the renderer DOWN would hide a message disk keeps, so it
   * would reappear on the next open.)
   *
   * EXTRACTED 2026-08-06 (audit S9): this reconciliation lived inline in
   * `submitText` while `regenerateLastReplyIfOrphaned` still did the original
   * unconditional `seedEmittedCount`. Both run a full turn through the same
   * driver/sink pair and both can fail the same ways, so the divergence was
   * only ever an oversight — see the call site there for what it cost.
   */
  private reconcileRecordAfterFailure(): void {
    const driverRecord = this.driver.getRecord();
    const flushed = this.sink.flushedRecord();
    if (flushed !== null && flushed.length > driverRecord.length) {
      // Cursor and mirror already sit at `flushed.length`, so the invariant
      // holds without a reseed and the next turn's block appends cleanly.
      this.driver.loadRecord(flushed);
      this._record = flushed;
    } else if (flushed !== null && flushed.length < driverRecord.length) {
      // The DRIVER is ahead — the mirror image of the case above, and the one
      // the length-comparison `else` used to swallow (audit 2026-07-24, 1.7).
      // Reachable when an interrupt lands BEFORE the turn's first flush: the
      // router/recap phase runs ~1s at the head of every turn,
      // `classifyIntent` swallows the abort, and the loop head then throws a
      // record-carrying abort BEFORE `flushBlocks` — so the driver adopts a
      // record longer than anything ever streamed. Seeding the cursor to that
      // length declared blocks emitted that never were: the user's message was
      // never written to JSONL, no later flush could persist it, and the
      // renderer dropped its optimistic echo on `failed` with no notice
      // (interrupts set turnFailed:false). The typed message vanished from the
      // screen AND from disk while living on in memory.
      //
      // Flush the missing tail instead: it streams and persists the blocks for
      // real, which is what the cursor was about to claim had happened.
      this.sink.flushBlocks(driverRecord);
      this._record = driverRecord;
    } else {
      // Equal lengths, or the mirror is untrustworthy (`flushedRecord()`
      // refuses to answer when its invariant is broken — a correct
      // conservatism we must not read as "nothing was flushed"). Keep the
      // original cursor reseed (audit 2026-07-10, finding 10) so the next
      // turn's user block cannot land below a stale high-water mark.
      this.sink.seedEmittedCount(driverRecord.length, driverRecord);
      this._record = driverRecord;
    }
  }

  /** Display forms of the project command allow rules (ADR 0030) for the
   *  CURRENT effective workspace — the Settings management list. */
  async listCommandRules(): Promise<readonly string[]> {
    return this.commandRules.list().map(ruleDisplay);
  }

  /** Removes one rule by its display form. False when nothing matched. */
  async removeCommandRule(display: string): Promise<boolean> {
    return this.commandRules.remove(display);
  }

  async resolveApproval(opts: ResolveApprovalOpts): Promise<ApprovalResult> {
    return this.overlayResolver.resolveExternal({
      requestId: opts.requestId,
      decision: opts.decision,
      persistence: opts.persistence,
    });
  }

  /**
   * Set the effective backend (板砖) workspace. Mutates the shared wsHolder
   * (so the runtimeFactory picks it up on its next dispatch), persists a
   * `workspace_set` line, and broadcasts a WorkspaceEvent. TRUSTS its caller —
   * validation happens at the GUI/CLI boundary in later tasks.
   *
   * Idle-only (audit 2026-07-10, finding 13): `driver.appendSystemNote`'s
   * contract is "only called between turns" — mid-turn it drops the note and
   * can rewind the sink cursor (duplicate JSONL lines + duplicate bubbles).
   * Mirrors rewindLastTurn's guard; the DeviceCard menu is clickable mid-turn,
   * so enforce it here rather than trusting the renderer.
   */
  async setWorkspace(workspace: string): Promise<WorkspaceSetResult> {
    if (this.currentTurn !== null) {
      return { ok: false, reason: "turn_in_progress" };
    }
    // Attachments follow the session, not the folder (owner 2026-08-10). The
    // record cites workspace-RELATIVE paths, so leaving the files behind would
    // silently break every document already handed over — and would make
    // removeAttachment unlink from a root the file was never in.
    const fromRoot = this.wsHolder.current;
    await migrateAttachments({
      fromRoot,
      toRoot: workspace,
      sessionId: this.sessionId,
    });
    // Guard re-check on the far side of the await (review 2026-08-10): the
    // migration can be a multi-megabyte copy, and a turn starting during it
    // would make the appendSystemNote below a MID-turn write and hand the
    // in-flight dispatch a half-switched holder. Refuse — and move the files
    // BACK first, because a refusal that leaves them under the new root while
    // the holder stays old would break every citation in the record.
    if (this.currentTurn !== null) {
      await migrateAttachments({
        fromRoot: workspace,
        toRoot: fromRoot,
        sessionId: this.sessionId,
      });
      return { ok: false, reason: "turn_in_progress" };
    }
    this.wsHolder.current = workspace;
    this.wsIsDefault = false;
    this.persister.appendWorkspaceSet(workspace, new Date().toISOString());
    this.projector.emitWorkspace({
      kind: "workspace",
      workspace,
      isDefault: false,
    });
    // Out-of-turn → 系统 note so the workspace change is visible, persisted,
    // and resumable in the canonical TerminalRecord.
    this.driver.appendSystemNote("系统", `workspace → ${workspace}`);
    this._record = this.driver.getRecord();
    return { ok: true };
  }

  /** Ingest documents the 开拓者 handed over (ADR 0033) — see
   *  SessionAttachments.attachFiles. */
  attachFiles(paths: readonly string[]): Promise<AttachResult> {
    return this.attachments.attachFiles(paths);
  }

  /** Take back an attached document (ADR 0033, owner 2026-08-10) — see
   *  SessionAttachments.removeAttachment. */
  removeAttachment(path: string): Promise<RemoveAttachmentResult> {
    return this.attachments.removeAttachment(path);
  }

  /**
   * Restore the managed-sandbox default backend workspace
   * (`~/.herta/workspaces/<sessionId>`). Persists it as a `workspace_set`
   * line and broadcasts a WorkspaceEvent flagged `isDefault: true`.
   * Idle-only, same guard and rationale as setWorkspace (finding 13).
   */
  async resetWorkspace(): Promise<WorkspaceSetResult> {
    if (this.currentTurn !== null) {
      return { ok: false, reason: "turn_in_progress" };
    }
    const def = defaultWorkspaceFor(homedir(), this.sessionId);
    // Same reason as setWorkspace: the documents belong to the conversation.
    const resetFrom = this.wsHolder.current;
    await migrateAttachments({
      fromRoot: resetFrom,
      toRoot: def,
      sessionId: this.sessionId,
    });
    // Same far-side re-check as setWorkspace (review 2026-08-10) — and the
    // same move-back on refusal, so the citations keep resolving.
    if (this.currentTurn !== null) {
      await migrateAttachments({
        fromRoot: def,
        toRoot: resetFrom,
        sessionId: this.sessionId,
      });
      return { ok: false, reason: "turn_in_progress" };
    }
    this.wsHolder.current = def;
    this.wsIsDefault = true;
    this.persister.appendWorkspaceSet(def, new Date().toISOString());
    this.projector.emitWorkspace({
      kind: "workspace",
      workspace: def,
      isDefault: true,
    });
    // Out-of-turn → 系统 note (mirrors setWorkspace) so the reset is visible,
    // persisted, and resumable in the canonical TerminalRecord.
    this.driver.appendSystemNote("系统", `workspace → ${def}`);
    this._record = this.driver.getRecord();
    return { ok: true };
  }

  subscribeRecord(): AsyncIterable<RecordEvent> {
    return this.projector.subscribeRecord();
  }

  subscribeOverlay(): AsyncIterable<OverlayEvent> {
    return this.projector.subscribeOverlay();
  }

  subscribeAgentEvents(): AsyncIterable<SessionAgentEvent> {
    return this.projector.subscribeAgentEvents();
  }

  subscribeTurnLifecycle(): AsyncIterable<TurnLifecycleEvent> {
    return this.projector.subscribeTurnLifecycle();
  }

  subscribeSpeech(): AsyncIterable<SpeechControlEvent> {
    return this.projector.subscribeSpeech();
  }

  subscribeTitle(): AsyncIterable<TitleEvent> {
    return this.projector.subscribeTitle();
  }

  subscribeWorkspace(): AsyncIterable<WorkspaceEvent> {
    return this.projector.subscribeWorkspace();
  }

  subscribeVoice(): AsyncIterable<VoiceCueEvent> {
    return this.projector.subscribeVoice();
  }

  /**
   * Test seam: resolves once the in-flight title generation settles (no-op
   * when none ran). Production never awaits this — title generation is
   * fire-and-forget so it cannot delay a turn.
   */
  async whenTitleSettled(): Promise<void> {
    await this.titler.whenSettled();
  }

  async close(): Promise<void> {
    // Capture BEFORE interrupt: the turn's finally clears currentTurn.
    const inFlight = this.currentTurn?.settled ?? null;
    // Cancel any in-flight turn first. interrupt() is a no-op when
    // currentTurn is null, so this is always safe to call.
    await this.interrupt();
    // Abort any in-flight title generation so a slow flash call can't outlive
    // the session.
    this.titler.dispose();

    // Await the interrupted turn's REAL settlement (audit 2026-07-10,
    // finding 14): one setImmediate was not enough — a still-unwinding turn
    // (the bridge's done-marker append, the driver's persist) could land
    // appends after teardown, and deleteSession's rmSync then raced them:
    // a post-delete append recreated `<id>.jsonl` with no header, an
    // unlistable zombie that half-undid the delete. Bounded so a
    // pathologically hung turn can never wedge app quit (the before-quit
    // session-flush hold awaits close()).
    if (inFlight !== null) {
      let timer: NodeJS.Timeout | undefined;
      const cap = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000);
      });
      try {
        await Promise.race([inFlight, cap]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    // Pictures still sitting in the composer never became part of anything:
    // no record block ever mentioned them, so their stored copies are pure
    // orphans (ADR 0048 §4). Best-effort — a copy that survives is a stray
    // file, never a broken session.
    await this.attachments.clearStaged();

    // Give the turn loop one event-loop tick to observe the AbortSignal and
    // emit turn.failed before we close the projector (which would close all
    // subscriber queues, potentially losing the failed event).
    await new Promise<void>((resolve) => setImmediate(resolve));

    this.projector.close();
    // V2RecordPersister has no explicit close — it appends synchronously.
  }

  // ── Async factory ─────────────────────────────────────────────────────────

  /**
   * Asynchronously construct a `SessionImpl`. Performs disk reads (static
   * prefix, meta-think corpus, supervisor reference) and returns a fully
   * wired session.
   *
   * The `deps` seam is test-only — production code passes `undefined`.
   * Tests construct `SessionImpl.create(...)` directly (bypassing
   * `createSessionHost`) to inject stub providers.
   */
  static async create(opts: {
    sessionId: string;
    workspaceRoot: string;
    /** The EFFECTIVE backend (板砖) workspace — the cwd the coding backend
     *  uses. Distinct from workspaceRoot (the record-store anchor). */
    effectiveWorkspace: string;
    /** Whether `effectiveWorkspace` is the managed-sandbox default (true)
     *  vs. an explicit caller override (false). */
    isDefaultWorkspace: boolean;
    config: AppServerConfig;
    persister: V2RecordPersister;
    initialRecord?: TerminalRecord;
    /** How the loaded session's last turn ended, when the file recorded it.
     *  Absent = the turn left no ending, i.e. a true mid-stream crash — the
     *  only case resume-recovery may regenerate (audit 2026-07-24, 1.6). */
    lastTurnEnd?: LastTurnEnd;
    deps?: SessionInternalDeps;
    /** Live DeepSeek key getter (from the host's mutable holder) so a key set
     *  in Settings / onboarding takes effect on the next turn. Falls back to the
     *  static config key when omitted (tests). */
    deepSeekKey?: () => string;
    /** Interaction language (slice 4): threaded into every language-
     *  parameterized constructor below (static prefix, seeds, opening,
     *  meta-think, hints, recap, title) and into the V2ActorDriver. The
     *  caller resolves it per session activation. Default "zh" —
     *  byte-identical to pre-slice-4 behavior. */
    lang?: PromptLang;
  }): Promise<SessionImpl> {
    const { sessionId, workspaceRoot, config, persister } = opts;
    const lang: PromptLang = opts.lang ?? "zh";
    const initialRecord = opts.initialRecord ?? [];
    const deps = opts.deps ?? {};

    // The effective backend workspace lives in ONE mutable holder shared
    // between the runtimeFactory closure (read fresh per dispatch) and the
    // SessionImpl instance, so a future setWorkspace mutates both at once.
    const wsHolder = { current: opts.effectiveWorkspace };

    // Live key: prefer the host-provided getter (updated when the user sets the
    // key in Settings / onboarding) so a new key takes effect on the next turn
    // without a restart; fall back to the static config key (tests).
    const deepSeekKey: () => string =
      opts.deepSeekKey ?? (() => config.providers.deepseekApiKey);
    const apiKey: ApiKey = deepSeekKey;
    // Dev-only chaos/staging lever (see types.ts providers.baseUrl) — spread
    // into every turn-path provider construction so a chaos proxy sees the
    // actor, backend, and router/supervisor/title traffic alike.
    const baseUrl =
      config.providers.baseUrl !== undefined
        ? { baseUrl: config.providers.baseUrl }
        : {};
    // The one way both hosts build it (session-wiring.ts): Settings →
    // Coprocessor supplies the model and the thinking level (default
    // "high"), the wiring supplies everything the CLI would spell the same.
    const backendProvider =
      deps.providerOverrides?.backend ??
      createBackendProvider({
        apiKey,
        model: config.providers.backendModel,
        ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
        ...baseUrl,
      });

    // 1. Backend stack (shared wiring — see session-wiring.ts). The
    //    OverlayAskResolver surfaces pending permission requests through the
    //    session's overlay snapshot and emits OverlayEvents via the projector.
    //    Its callbacks close over a mutable `sessionHolder` filled in after
    //    SessionImpl construction — safe because present() is only ever
    //    called during a live turn, which can only happen after create()
    //    returns the SessionImpl to the caller.
    const sessionHolder: { session: SessionImpl | null } = { session: null };
    let overlayResolver: OverlayAskResolver | undefined;
    const backend = createBackendStack({
      wsHolder,
      workspaceRoot,
      lang,
      // The contract the setting asks for (ADR 0040). `minimal` needs a bash
      // on this machine; without one the session runs `standard`. The
      // Settings row shows the detection result (the GUI's getBackendContract
      // reports `bashFound`), and since ADR 0044 a NEW session also carries
      // one `→ 系统` record note naming the remedy (see contractFallbackNote).
      wantMinimal: config.backendContract === "minimal",
      backendProvider,
      // ADR 0048 §5: the stack mounts `view_image` only when this model can
      // actually see (isVisionModel, one rule for both hosts).
      backendModel: config.providers.backendModel,
      // The digest tool's side model (ADR 0043): flash, thinking off. A test
      // override takes the place of the real provider; without one the tool
      // mounts as `unavailable` rather than reaching the network under test.
      digestModel:
        deps.providerOverrides?.digest !== undefined
          ? digestModelFrom(deps.providerOverrides.digest)
          : deps.providerOverrides === undefined
            ? defaultDigestModel(apiKey, baseUrl)
            : null,
      makeAsk: ({ cache, rules }) => {
        overlayResolver = new OverlayAskResolver({
          cache,
          rules,
          setPendingOverlay(overlay) {
            // biome-ignore lint/style/noNonNullAssertion: set before any turn runs
            sessionHolder.session!._overlay = overlay;
            // biome-ignore lint/style/noNonNullAssertion: set before any turn runs
            sessionHolder.session!.projector.emitOverlay({
              kind: "pending",
              overlay,
            });
          },
          clearOverlay(requestId) {
            // biome-ignore lint/style/noNonNullAssertion: set before any turn runs
            sessionHolder.session!._overlay = null;
            // biome-ignore lint/style/noNonNullAssertion: set before any turn runs
            sessionHolder.session!.projector.emitOverlay({
              kind: "resolved",
              requestId,
            });
          },
        });
        return overlayResolver;
      },
    });
    if (overlayResolver === undefined) {
      throw new Error("createBackendStack did not build the ask resolver");
    }
    const contractFellBack =
      config.backendContract === "minimal" && backend.bashPath === null;
    if (contractFellBack) {
      console.warn(
        "[herta] backendContract=minimal requested but no bash found (install Git for Windows or set HERTA_BASH); running the standard contract",
      );
    }
    const { bus, commandRules, runtimeFactory } = backend;

    // 1a. Event projector — subscribes to the bus so agent events fan-out
    //     to all SessionAgentEvent consumers automatically.
    //     Bus → wire-stream classification: the agent stream is a raw
    //     passthrough for all events. Record-stream projection is NOT done
    //     here — committed record blocks reach subscribers via
    //     BusActorStreamingSink.flushBlocks in canonical order (2026-06-01;
    //     see docs/superpowers/specs/2026-06-01-gui-record-stream-ordering-design.md).
    //     TurnLifecycleEvents are emitted directly by Session.submitText, NOT
    //     mapped from bus turn.* events — that path would double-emit (backend
    //     loop publishes turn.* on the bus and submitText also emits lifecycle).
    const projector = new SessionEventProjector({ bus, queueCapacity: 1000 });

    // 2. Actor stack (shared wiring): providers, static prefix (+ reopen
    //    own-dream filter), opening seed, meta-think/hints/supervisor toggle,
    //    recap runtime, prompt dump. The test seams in `deps` thread through
    //    as overrides.
    const actor = await createActorStack({
      workspaceRoot,
      sessionId,
      lang,
      initialRecord,
      apiKey,
      ...(config.providers.baseUrl !== undefined
        ? { baseUrl: config.providers.baseUrl }
        : {}),
      // Supervisor toggle is config-driven (default ON).
      supervisorEnabled: config.supervisor?.enabled ?? true,
      dream: config.dream,
      promptDumpDir: config.transcriptDir,
      overrides: {
        ...(deps.providerOverrides?.actor !== undefined
          ? { actorProvider: deps.providerOverrides.actor }
          : {}),
        ...(deps.providerOverrides?.router !== undefined
          ? { routerProvider: deps.providerOverrides.router }
          : {}),
        ...(deps.providerOverrides?.supervisor !== undefined
          ? { supervisorProvider: deps.providerOverrides.supervisor }
          : {}),
        ...(deps.staticPrefixOverride !== undefined
          ? { staticPrefix: deps.staticPrefixOverride }
          : {}),
        ...(deps.metaThinkOverride !== undefined
          ? { metaThink: deps.metaThinkOverride }
          : {}),
        ...(deps.supervisorReferenceOverride !== undefined
          ? { supervisorReference: deps.supervisorReferenceOverride }
          : {}),
        ...(deps.openingOverride !== undefined
          ? { opening: deps.openingOverride }
          : {}),
      },
    });

    // The title model (see createTitleProvider) and the title/topics the
    // session opens with, judged against the record actually loaded.
    const titleProvider =
      deps.providerOverrides?.title ?? createTitleProvider(apiKey, baseUrl);
    const existing = loadSessionTitleState(
      config.transcriptDir,
      sessionId,
      opts.initialRecord ?? [],
    );

    const sink = new BusActorStreamingSink(
      bus,
      (ev) => projector.emitSpeech(ev),
      (ev) => projector.emitRecord(ev),
      // random + now keep their wall-clock defaults; `lang` selects the reveal
      // cadence (EN reveals speech by word, zh by code point).
      undefined,
      undefined,
      lang,
    );

    // 3. Voice (session-voice.ts): the opening's clip and clip-matched
    //    cadence, the particle cue, the veto reaction and the easter egg,
    //    with their catalogs read once. The clip root is config-driven since
    //    2026-07-06 so a PACKAGED app can point it at its bundled resources
    //    copy; the fallback is the dev layout under the workspace.
    const { opening, seedBlock } = actor;
    const voice = await loadSessionVoice({
      voiceAssetsDir:
        config.voiceAssetsDir ?? join(workspaceRoot, "data", "voice"),
      lang,
      opening,
      emit: (cue) => projector.emitVoice(cue),
      ...(deps.openingDurationMs !== undefined
        ? { openingDurationMs: deps.openingDurationMs }
        : {}),
      ...(deps.particleRandom !== undefined
        ? { particleRandom: deps.particleRandom }
        : {}),
      ...(deps.vetoRandom !== undefined ? { vetoRandom: deps.vetoRandom } : {}),
      ...(deps.easterEggRandom !== undefined
        ? { easterEggRandom: deps.easterEggRandom }
        : {}),
      ...(deps.easterEggNow !== undefined
        ? { easterEggNow: deps.easterEggNow }
        : {}),
    });

    // 4. V2ActorDriver — owns the growing TerminalRecord, mood routing,
    //     the supervisor, and (via the persister) block persistence. An
    //     all-empty corpus + empty supervisor reference degrade to
    //     single-phase actor mode. The per-turn AbortSignal is threaded by
    //     submitText into driver.runTurn so interrupt() can cancel.
    const driver = new V2ActorDriver({
      provider: actor.actorProvider,
      model: config.providers.actorModel,
      staticPrefix: actor.staticPrefix,
      bus,
      runtimeFactory,
      persister,
      sink,
      onPrompt: actor.onPrompt,
      // Particle voice at the FIRST speech of each turn (not retries, beats
      // or regenerate) and the veto reaction — both the voice module's.
      onPrimarySpeechStart: (text: string) => voice.onPrimarySpeechStart(text),
      onSupervisorVeto: () => voice.onSupervisorVeto(),
      routerProvider: actor.routerProvider,
      metaThinkCorpus: actor.metaThinkCorpus,
      hints: actor.actorHints,
      supervisorProvider: actor.supervisorProvider,
      supervisorReference: actor.supervisorReference,
      recap: actor.recap,
      lang,
    });

    // Resume path: load the prior record into the driver. loadRecord does
    // NOT replay through the persister — the blocks are already on disk in
    // the (forResume) source file. New blocks the next turn writes append
    // to that same file.
    //
    // New-session path: when an opening was picked, inject its seed line as
    // TerminalRecord block 0 (loaded into the driver) AND persist it to the
    // new session's JSONL so it survives across resumes. The preamble is
    // already folded into effectiveStaticPrefix above; it does NOT enter
    // TerminalRecord (per Slice 8 §3 decision B). Mirrors the CLI's main.ts.
    if (initialRecord.length > 0) {
      driver.loadRecord(initialRecord); // resume — already on disk
    } else if (seedBlock !== null) {
      // D3 (streaming opening): persist the seed at create so a mid-stream close
      // never loses it (on resume it loads as block 0 = instant history), but
      // DEFER it from the in-memory record so the onReset snapshot is empty and
      // the renderer streams it in via playOpening (like a reply) instead of
      // showing it instantly. SessionImpl.playOpening — fired by the create
      // handler after the renderer subscribes — streams + commits it.
      persister.appendBlock(seedBlock);
    }

    // Seed the sink's canonical-diff cursor past any blocks already present
    // at session start (loaded record on resume, opening seed on a new
    // session) — those reached the GUI via the onReset snapshot, not the
    // stream. The first turn's flushBlocks then emits only its new blocks.
    // The record itself seeds the sink's resync mirror (record-drop heal).
    const seedRecord = driver.getRecord();
    sink.seedEmittedCount(seedRecord.length, seedRecord);

    const session = new SessionImpl({
      sessionId,
      workspaceRoot,
      wsHolder,
      isDefaultWorkspace: opts.isDefaultWorkspace,
      ...(opts.lastTurnEnd !== undefined
        ? { lastTurnEnd: opts.lastTurnEnd }
        : {}),
      persister,
      driver,
      sink,
      projector,
      overlayResolver,
      commandRules,
      transcriptDir: config.transcriptDir,
      titler: new SessionTitler({
        sessionId,
        transcriptDir: config.transcriptDir,
        lang,
        provider: titleProvider,
        getRecord: () => driver.getRecord(),
        emit: (event) => projector.emitTitle(event),
        initialTitle: existing.title,
        initialTopics: existing.topics,
      }),
      // D3: the deferred opening seed (new sessions with an opening). null for
      // resumed sessions (seedBlock is only set when initialRecord is empty) and
      // new sessions without an opening — playOpening then no-ops.
      pendingOpening: seedBlock,
      voice,
      // D3: opening-stream lead beat; undefined → the driver's OPENING_LEAD_MS.
      openingLeadMs: deps.openingLeadMs,
      deepSeekKey,
      lang,
      // ADR 0044: NEW sessions only — a resumed record already carried the
      // note when it was new (and the machine state may have changed since).
      pendingContractNote:
        contractFellBack && initialRecord.length === 0
          ? contractFallbackNote(lang)
          : null,
      // The captioning instrument (ADR 0048 §3). Same shape as the digest
      // model above: absent under provider overrides, so a test never reaches
      // the network — images are then stored and marked `no_caption`, which
      // is a real production state too (no key, instrument down).
      captionImage:
        deps.providerOverrides === undefined
          ? deepseekVisionCaptioner({ apiKey, ...baseUrl })
          : null,
    });
    sessionHolder.session = session;
    return session;
  }
}
