import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  defaultWorkspaceFor,
  deleteSessionFiles,
  dispatchJournalDir,
  dispatchJournalPath,
  dreamDirFor,
  ensureHertaGitignore,
  readSessionFile,
  readSessionFileAsync,
  listSessionHeaders as readSessionHeaders,
  listSessions as readSessionListings,
  readSessionTitle,
  readSessionTopics,
  resolveEffectiveWorkspace,
  type TerminalRecord,
  type TerminalRecordBlock,
  V2RecordPersister,
  workspacesBaseDir,
  writeSessionTitle,
} from "@herta/core";
import {
  type DreamSessionInput,
  hasEnoughMaterial,
  isModifiedSince,
  lastFullPassAtMs,
  RealDeepSeekClient,
  readManifest,
  resolveDreamConfig,
  runDreamPass,
} from "@herta/knowledge";
import { reportProviderUsage } from "@herta/providers";
import {
  reapOrphanedDispatches,
  sealOpenDispatch,
} from "./dispatch-recovery.js";
import { DreamTrigger } from "./dream-trigger.js";
import { SessionImpl } from "./session.js";
import {
  DEFAULT_HIT_LIMIT,
  narrowSearchCandidates,
  type SearchMemo,
  type SessionSearchHit,
  searchSessionTranscripts,
} from "./session-search.js";
import { cleanUserTitle } from "./session-titler.js";
import { renameCurrentTopic } from "./session-topics.js";
import { cachedRecapBoundary } from "./session-wiring.js";
import type {
  AppServerConfig,
  CreateSessionOpts,
  ListSessionsOpts,
  OpenSessionOpts,
  RenameSessionResult,
  Session,
  SessionExportSource,
  SessionHost,
  SessionMetadata,
} from "./types.js";
import { installUsageLog } from "./usage-log.js";

export function createSessionHost(config: AppServerConfig): SessionHost {
  validateConfig(config);
  // Self-ignore `.herta` before the first transcript lands (audit BL6). A
  // no-op for a PACKAGED app, whose workspace is userData and not a repo —
  // it matters for a dev GUI and for any build pointed at a real project.
  ensureHertaGitignore(config.workspaceRoot);
  // The usage log is per process, like the provider sink it installs; a
  // host rebuilt with the same path just installs it again.
  if (config.usageLogPath !== undefined) installUsageLog(config.usageLogPath);
  return new SessionHostImpl(config);
}

class SessionHostImpl implements SessionHost {
  private _active: Session | null = null;
  private readonly dreamTrigger: DreamTrigger;
  private dreamIntervalHandle: ReturnType<typeof setInterval> | null = null;
  /** Mutable live DeepSeek key. Seeded from config; updated by setDeepSeekKey
   *  (no-key onboarding / Settings). Each session reads it through a getter, so
   *  a change takes effect on the NEXT turn with no restart. */
  private readonly keyHolder: { current: string };
  /** The user's PDF-picture transcription switch (2026-10-01), live the same
   *  way as the key: each session reads it at every attach. On until a host
   *  says otherwise — the CLI never does. */
  private readonly pdfTranscriptsHolder = { current: true };
  /** Composer predictions (2026-10-10): on unless the user turned them off. */
  private readonly predictionsHolder = { current: true };
  /** Serializes create/open/delete/closeActive (audit 2026-07-10, finding
   *  11): each op awaits a long disk load and then assigns `_active`
   *  unconditionally, so two concurrent activations could leave `_active`
   *  pointing at the LOSER — every later IPC (submitText, resolveApproval,
   *  rewind, interrupt) then routed to a session the user wasn't looking at,
   *  its text silently persisting into the wrong JSONL, while the winner
   *  leaked un-closed. The GUI's activationSeq gates only renderer pointing,
   *  not this assignment. A promise-chain mutex makes each lifecycle op
   *  observe the previous one's final state. */
  private readonly serializeLifecycle = makeLifecycleSerializer();
  /** The previous content search's outcome, so a query that extends it
   *  scans only its hits (see narrowSearchCandidates). */
  private searchMemo: SearchMemo | null = null;

  constructor(private readonly config: AppServerConfig) {
    this.keyHolder = { current: config.providers.deepseekApiKey };
    const dreamCfg = resolveDreamConfig(config.dream);

    this.dreamTrigger = new DreamTrigger({
      idleMs: dreamCfg.idleMs,
      cooldownMs: dreamCfg.cooldownMs,
      minRetryMs: dreamCfg.minRetryMs,
      enabled: dreamCfg.enabled,
      now: () => Date.now(),
      lastFullPassAt: () => this.lastDreamPassAtMs(),
      hasEnoughMaterial: () => this.hasEnoughDreamMaterial(),
      runPass: () => this.runDreamPassDetached(),
      isBusy: () => this._active?.turnInFlight === true,
    });

    if (dreamCfg.enabled) {
      // Coarse 5-minute polling interval — still far below idleMs (30 min
      // default), so an idle user is noticed promptly, while keeping idle-state
      // wakeups (and the small manifest read the cadence gate does) low. This
      // interval is only the idle-detection BACKSTOP: the post-turn tick
      // (wrapSession) covers the responsive path, and the gates are
      // level-triggered, so a coarser poll can never miss a window — it just
      // re-evaluates less often. Cheap to lower again if faster idle pickup is
      // ever wanted.
      this.dreamIntervalHandle = setInterval(() => {
        // Fire-and-forget: tick() is async but must never block input.
        void this.dreamTrigger.tick();
      }, 300_000);
      // Node's default keeps processes alive for timers; unref so this
      // timer never prevents a clean exit when nothing else is running.
      if (
        typeof this.dreamIntervalHandle === "object" &&
        this.dreamIntervalHandle !== null &&
        "unref" in this.dreamIntervalHandle
      ) {
        (this.dreamIntervalHandle as NodeJS.Timeout).unref();
      }
    }
  }

  /**
   * Ms-epoch anchor for the Dream cadence, read fresh from the persisted
   * manifests so the cadence floor survives process restarts. A single
   * trigger drives passes for every language PRESENT in this workspace's
   * sessions, and run-dream-pass deliberately withholds `lastRunAt` on a
   * transport abort so the aborted language retries — so the anchor is the
   * MINIMUM across the present languages' completed passes. (The previous
   * MAX let the OTHER language's completed pass in the same run advance the
   * cadence anyway, locking the aborted language's unconsumed episodes
   * behind a fresh cooldown AND a material gate that no longer counted its
   * sessions; MAX also guarded against anchoring on zh alone, which MIN
   * preserves — an EN-only workspace anchors on its own manifest.) The
   * accompanying re-pass of the already-completed language is cheap
   * (per-manifest episode dedup), and a single-language workspace behaves
   * exactly as before. A PRESENT language that has NEVER completed a pass
   * yields null immediately — the workspace is fire-eligible like a fresh
   * install (a brand-new EN corpus must not wait out zh's cooldown). Null
   * when no timestamp was collected.
   */
  private lastDreamPassAtMs(): number | null {
    // Languages present in this workspace's sessions (header lang; absent →
    // "zh"). An empty listing (fresh workspace) is treated as {zh} so the
    // single-language behavior is unchanged.
    const present = new Set<"zh" | "en">();
    try {
      for (const meta of this.listSessions()) present.add(meta.lang ?? "zh");
    } catch {
      // Unreadable listing — fall through to the {zh} default below.
    }
    if (present.size === 0) present.add("zh");

    let oldest: number | null = null;
    for (const lang of present) {
      let at: number | null;
      try {
        at = lastFullPassAtMs(
          readManifest(dreamDirFor(this.config.workspaceRoot, lang)),
        );
      } catch {
        // Unreadable manifest for this language — skip it, as before.
        continue;
      }
      // A present language with no completed pass keeps the whole
      // workspace fire-eligible (readManifest maps an absent manifest to
      // the empty ledger, so a brand-new corpus lands here too).
      if (at === null) return null;
      if (oldest === null || at < oldest) oldest = at;
    }
    return oldest;
  }

  /**
   * Material gate: enough sessions are new since the last completed pass, or one
   * is long enough on its own (by 黑塔 turn count). Only invoked after the
   * trigger's idle + cooldown checks pass (≈ at most weekly), so reading the
   * touched transcripts is affordable. Conservative on any error — when material
   * cannot be assessed, do not fire.
   */
  private hasEnoughDreamMaterial(): boolean {
    try {
      // No key, no pass (`runDreamPassDetached` returns at once): checked
      // FIRST, before the listing and the transcript reads below — they ran
      // on the main thread for a pass that could not happen (dream review
      // 2026-09-22, finding 11).
      if (this.keyHolder.current.trim() === "") return false;
      const dreamCfg = resolveDreamConfig(this.config.dream);
      const since = this.lastDreamPassAtMs() ?? 0;
      const newRecords: TerminalRecord[] = [];
      for (const meta of this.listSessions()) {
        if (!isModifiedSince(meta.lastActivityAt, since)) continue;
        try {
          const sessionFile = join(
            this.config.transcriptDir,
            `${meta.sessionId}.jsonl`,
          );
          newRecords.push(readSessionFile(sessionFile).record);
        } catch {
          // Unreadable transcript — skip it for the material count.
        }
      }
      // Turns counted SINCE the anchor: a long session touched by one block
      // used to re-qualify on its whole history every cooldown.
      return hasEnoughMaterial(newRecords, dreamCfg, since);
    } catch {
      return false;
    }
  }

  /**
   * Detached Dream pass: builds the DeepSeek client, reads all sessions for
   * this workspace, and runs runDreamPass. Fire-and-forget — never awaited
   * in any turn path. Gracefully no-ops when the API key is absent.
   */
  private async runDreamPassDetached(): Promise<void> {
    try {
      // Dream uses the SAME live key as chat (the live holder, seeded from the
      // secure store), not any external env/file source. No key → skip silently.
      const key = this.keyHolder.current.trim();
      if (key === "") {
        // No key configured — skip silently. D4: no throw.
        return;
      }
      const dreamCfg = resolveDreamConfig(this.config.dream);
      // The pass steps aside between episodes once the user is back — any
      // action since it started, or a turn in flight (finding 12). It used
      // to run to completion beside the live turn on the same key.
      const activityAtStart = this.dreamTrigger.activityCount;
      const shouldYield = (): boolean =>
        this._active?.turnInFlight === true ||
        this.dreamTrigger.activityCount !== activityAtStart;
      const client = new RealDeepSeekClient({
        apiKey: key,
        model: dreamCfg.model,
        // Into usage.jsonl with every other call, marked as the dream's
        // (dream review 2026-09-22, finding 4): the one consumer of the key
        // that runs while the user is away was the one the log never saw.
        onUsage: (u) =>
          reportProviderUsage({ endpoint: "chat", source: "dream", ...u }),
      });

      // Enumerate sessions, GROUPED by the interaction language each was
      // created under (persisted in the header; absent → "zh", since every
      // pre-persistence session and dream is Chinese). Each language grows its
      // OWN 废案 corpus from ONLY its own sessions — the "separate per-language
      // pools" design — so we run one pass per language present.
      // Records load LAZILY (audit BL10): the pass awaits several LLM calls
      // per episode, so materializing every transcript here held the user's
      // whole history in main-process memory for the duration — minutes, on
      // the Electron main thread, growing without bound. The header read
      // below is still eager, because the pass has to be grouped by language
      // before it starts; it is a bounded prefix read, not the whole file.
      const byLang = new Map<"zh" | "en", DreamSessionInput[]>();
      for (const meta of this.listSessions()) {
        try {
          const sessionFile = join(
            this.config.transcriptDir,
            `${meta.sessionId}.jsonl`,
          );
          const lang = meta.lang ?? "zh";
          const arr = byLang.get(lang) ?? [];
          arr.push({
            sessionId: meta.sessionId,
            // Swallowed HERE, not by the outer catch: the read now happens
            // inside runDreamPass, and one corrupt transcript must skip that
            // session, not abort the pass for every other one — which is what
            // this loop's try/catch used to guarantee.
            record: () => {
              try {
                return readSessionFile(sessionFile).record;
              } catch {
                return [];
              }
            },
            // The session open in the window dreams only behind its recap
            // boundary (ADR 0069 §2): what the prompt has already lost to
            // compression. Its live tail — what a rewind or a take-back can
            // still change, what the prompt still shows verbatim — waits.
            dreamableEnd: (record) => {
              const open = this._active;
              return open !== null && open.sessionId === meta.sessionId
                ? cachedRecapBoundary(
                    open.workspaceRoot,
                    meta.sessionId,
                    record,
                  )
                : undefined;
            },
          });
          byLang.set(lang, arr);
        } catch {
          // Unreadable transcript — skip it.
        }
      }

      // One pass per language (each targets its own narrative/dream dirs via
      // runDreamPass's `lang`). Sequential so they never contend for the shared
      // client; a fresh runId per pass.
      for (const [lang, sessions] of byLang) {
        const result = await runDreamPass({
          workspaceRoot: this.config.workspaceRoot,
          sessions,
          client,
          runId: randomUUID(),
          config: this.config.dream,
          now: () => new Date(),
          lang,
          // The automatic pass's spend ceiling (finding 3); the rest waits.
          maxEpisodes: dreamCfg.autoPassMaxEpisodes,
          shouldYield,
        });
        // The corpus may have moved: the open session's next turn re-derives
        // its prefix once (ADR 0069 §1b) — new dreams from any session
        // enter, archived ones leave. Marked after any pass that held the
        // lock, even an aborted one (the stale floor archives before the
        // episodes): a rebuild that finds nothing new yields the same bytes,
        // so the prompt cache does not notice.
        if (result.lockBusy !== true) this._active?.markPrefixStale?.();
        // The user is back: the other language's pass waits too.
        if (result.yielded === true) break;
      }
    } catch {
      // Swallow all errors — this is a background pass and must never
      // surface to the user or interrupt any turn. D4.
    }
  }

  get activeSession(): Session | null {
    return this._active;
  }

  /** Something the user did in the window that is not a turn — a rewind, an
   *  attachment, a search, a file opened in the viewer. It resets the dream
   *  trigger's idle clock, and a pass already running steps aside at its
   *  next episode (dream review 2026-09-22, finding 12). */
  noteUserActivity(): void {
    this.dreamTrigger.noteActivity();
  }

  /** Update the live DeepSeek key. The active session (and any later one) reads
   *  it through `() => keyHolder.current`, so the NEXT turn uses the new value —
   *  no restart. Pass "" to clear (the next submit then re-prompts via
   *  `needsKey`). Persistence is the caller's job (key-store). */
  setDeepSeekKey(key: string): void {
    this.keyHolder.current = key;
  }

  /** Update the PDF-picture transcription switch (Settings, 2026-10-01). The
   *  next attach — in this session or any later one — reads the new value.
   *  Persistence is the caller's job. */
  setPdfPictureTranscription(enabled: boolean): void {
    this.pdfTranscriptsHolder.current = enabled;
  }

  /** Update the composer-prediction switch (Settings, 2026-10-10). The next
   *  finished turn — in this session or any later one — reads the new
   *  value. Persistence is the caller's job. */
  setComposerPredictions(enabled: boolean): void {
    this.predictionsHolder.current = enabled;
  }

  async reapOrphanedProcesses(): Promise<void> {
    try {
      const reaped = await reapOrphanedDispatches(
        dispatchJournalDir(this.config.transcriptDir),
      );
      if (reaped.fates.length > 0) {
        console.log(
          `[herta] processes left by interrupted runs: ${reaped.fates
            .map((f) => `${f.pid} ${f.fate}`)
            .join(", ")}`,
        );
      }
    } catch (err) {
      console.error("[herta] reaping interrupted runs failed:", err);
    }
  }

  createSession(opts: CreateSessionOpts): Promise<Session> {
    return this.serializeLifecycle(() => this.createSessionInner(opts));
  }

  private async createSessionInner(opts: CreateSessionOpts): Promise<Session> {
    // Opening/creating a session is user activity — reset the dream idle
    // clock (audit finding 21: only submitText did, so a pass could fire
    // right as the user navigated in).
    this.dreamTrigger.noteActivity();
    const sessionId = randomUUID();
    const workspaceRoot = opts.workspaceRoot ?? this.config.workspaceRoot;
    // The effective backend (板砖) workspace: an explicit caller override, or
    // the managed sandbox `~/.herta/workspaces/<sessionId>/` for a new GUI
    // session. Stamped into the JSONL header so resume can recover it.
    const backendWorkspace =
      opts.backendWorkspace ?? defaultWorkspaceFor(homedir(), sessionId);
    // The new transcript is written BEFORE the active session closes — the
    // same contract openSessionInner keeps by validating first. A transcript
    // directory that cannot be written (a full disk, a permission) throws
    // here with the open session intact; closing first left the host with
    // nothing open while the window still showed the closed session (UX
    // review 2026-09-22, item 6).
    const persister = V2RecordPersister.forNewSession({
      sessionId,
      workspaceRoot,
      backendWorkspace,
      startedAt: new Date(),
      transcriptDir: this.config.transcriptDir,
      // Record the birth language so a reopen pins to it and the dream pass
      // can scope this session by language.
      ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
    });
    await this.closeActiveInner();
    const session = await SessionImpl.create({
      sessionId,
      workspaceRoot,
      effectiveWorkspace: backendWorkspace,
      isDefaultWorkspace: opts.backendWorkspace === undefined,
      config: this.config,
      deepSeekKey: () => this.keyHolder.current,
      transcribePdfPictures: () => this.pdfTranscriptsHolder.current,
      composerPredictions: () => this.predictionsHolder.current,
      persister,
      ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
    });
    this._active = this.wrapSession(session);
    return this._active;
  }

  openSession(opts: OpenSessionOpts): Promise<Session> {
    return this.serializeLifecycle(() => this.openSessionInner(opts));
  }

  private async openSessionInner(opts: OpenSessionOpts): Promise<Session> {
    this.dreamTrigger.noteActivity();
    const sessionFile = join(
      this.config.transcriptDir,
      `${opts.sessionId}.jsonl`,
    );
    // Read/validate BEFORE closing the active session: a corrupt or missing
    // file throws here with the currently-open session fully intact. Closing
    // first left the host with no active session on a failed open — the app
    // looked alive but every submit dead-ended until another session opened.
    let loaded = readSessionFile(sessionFile);
    const reopeningActive = this._active?.sessionId === opts.sessionId;
    await this.closeActiveInner();
    // Closing can flush an interrupted turn's blocks into this same file, so
    // a self-reopen re-reads to resume from the final on-disk record.
    if (reopeningActive) loaded = readSessionFile(sessionFile);
    const { meta, latestWorkspaceSet } = loaded;
    let { record, lastTurnEnd } = loaded;
    const persister = V2RecordPersister.forResume({ sessionFile });
    // A 板砖 run the app exited during is sealed first, before anything
    // else reads the record: its open steps decided and closed, a 中断
    // marker and `turn_end interrupted` written (ADR 0071 §1.2). The
    // marker ends the dispatch for every reader, and the turn_end keeps the
    // regenerate path off a turn that did not lose a reply.
    try {
      const sealed = await sealOpenDispatch({
        journalPath: dispatchJournalPath(
          this.config.transcriptDir,
          opts.sessionId,
        ),
        record,
        persister,
      });
      if (sealed !== null) {
        record = sealed.record;
        lastTurnEnd = sealed.lastTurnEnd;
      }
    } catch (err) {
      console.error("[herta] sealing an interrupted run failed:", err);
    }
    // Recover the effective backend workspace in precedence order (latest
    // workspace_set → header backendWorkspace → legacy workspaceRoot). It is
    // "default" only when it equals the managed sandbox for this session.
    const effectiveWorkspace = resolveEffectiveWorkspace(
      meta,
      latestWorkspaceSet,
    );
    const isDefaultWorkspace =
      effectiveWorkspace === defaultWorkspaceFor(homedir(), meta.sessionId);
    // Pin the reopened session to the language it was CREATED under (persisted
    // in the header). Only when the header predates per-session persistence
    // (meta.lang absent) do we fall back to the caller's current preference.
    // This stops a global EN/CN toggle from retro-flipping old sessions.
    const lang = meta.lang ?? opts.lang;
    const session = await SessionImpl.create({
      sessionId: opts.sessionId,
      workspaceRoot: meta.workspaceRoot,
      effectiveWorkspace,
      isDefaultWorkspace,
      config: this.config,
      deepSeekKey: () => this.keyHolder.current,
      transcribePdfPictures: () => this.pdfTranscriptsHolder.current,
      composerPredictions: () => this.predictionsHolder.current,
      persister,
      initialRecord: record,
      // How the last turn ENDED, when the file recorded it. Its absence is
      // what marks a true mid-stream crash — the only case resume-recovery
      // may regenerate (audit 2026-07-24, 1.6).
      ...(lastTurnEnd !== undefined ? { lastTurnEnd } : {}),
      ...(lang !== undefined ? { lang } : {}),
    });
    this._active = this.wrapSession(session);
    return this._active;
  }

  private wrapSession(session: Session): Session {
    return wrapSessionForDreamActivity(session, this.dreamTrigger);
  }

  async searchSessions(query: string): Promise<SessionSearchHit[]> {
    // Content search re-opens each transcript itself and uses only the session
    // id + newest-first order, so it takes the header-only listing — no
    // tail-window or title-sidecar reads per debounced keystroke. Same
    // current-workspace scoping as listSessions().
    const headers = readSessionHeaders({
      transcriptDir: this.config.transcriptDir,
      currentWorkspaceRoot: this.config.workspaceRoot,
      limit: Number.POSITIVE_INFINITY,
    });
    const sessions = headers.map((h) => ({
      sessionId: h.sessionId,
      workspaceRoot: h.workspaceRoot,
      startedAt: h.startedAt,
      lastActivityAt: h.mtime.toISOString(),
      ...(h.lang !== undefined ? { lang: h.lang } : {}),
    }));
    // A query that extends the previous one scans only the previous hits
    // (2026-09-03); the open session is always read — it grows as the user
    // types. The scan itself reads off the event loop chunk by chunk.
    const candidates = narrowSearchCandidates(
      this.searchMemo,
      query,
      sessions,
      {
        ...(this._active !== null
          ? { alwaysInclude: this._active.sessionId }
          : {}),
      },
    );
    const hits = await searchSessionTranscripts({
      transcriptDir: this.config.transcriptDir,
      sessions: candidates,
      query,
    });
    const trimmed = query.trim();
    this.searchMemo =
      trimmed === ""
        ? null
        : {
            query: trimmed,
            hitSessionIds: hits.map((h) => h.sessionId),
            // Under the cap → every candidate was read, and (by the
            // containment the narrowing relies on) the hits are complete
            // over the FULL listing, not just the narrowed candidates.
            exhaustive: hits.length < DEFAULT_HIT_LIMIT,
            candidateCount: sessions.length,
            at: Date.now(),
          };
    return hits;
  }

  listSessions(opts?: ListSessionsOpts): SessionMetadata[] {
    const workspaceRoot =
      opts?.workspaceRoot === null
        ? undefined
        : (opts?.workspaceRoot ?? this.config.workspaceRoot);
    const allWorkspaces = opts?.workspaceRoot === null;
    const summaries = readSessionListings({
      transcriptDir: this.config.transcriptDir,
      currentWorkspaceRoot: workspaceRoot ?? this.config.workspaceRoot,
      allWorkspaces,
      limit: opts?.limit ?? Number.POSITIVE_INFINITY,
    });
    // SessionListEntry has: sessionId, sessionFile, startedAt, workspaceRoot,
    // preview, mtime (Date), title? (from the sidecar). There is no
    // lastActivityAt field — we derive it from mtime (the transcript file's
    // last-write time).
    return summaries.map((s) => ({
      sessionId: s.sessionId,
      workspaceRoot: s.workspaceRoot,
      startedAt: s.startedAt,
      lastActivityAt: s.mtime.toISOString(),
      ...(s.title !== undefined ? { title: s.title } : {}),
      ...(s.lastUserText !== undefined ? { lastUserText: s.lastUserText } : {}),
      ...(s.lang !== undefined ? { lang: s.lang } : {}),
    }));
  }

  deleteSession(
    sessionId: string,
  ): Promise<{ ok: boolean; wasActive: boolean }> {
    return this.serializeLifecycle(() => this.deleteSessionInner(sessionId));
  }

  private async deleteSessionInner(
    sessionId: string,
  ): Promise<{ ok: boolean; wasActive: boolean; removed?: boolean }> {
    const wasActive =
      this._active !== null && this._active.sessionId === sessionId;
    // Close FIRST so the persister releases its handle on `<id>.jsonl`
    // (Windows locks open files — the remove would EBUSY otherwise). close()
    // awaits the in-flight turn's settlement (finding 14), so the remove
    // below cannot race a still-unwinding turn's appends. The remove is
    // awaited (async since 2026-09-03 — a managed workspace with a
    // node_modules is a seconds-long tree delete that used to block the
    // main thread), and this whole method runs inside the lifecycle
    // serializer, so nothing reopens the session until it is gone.
    if (wasActive) await this.closeActiveInner();
    try {
      await deleteSessionFiles(
        this.config.transcriptDir,
        sessionId,
        workspacesBaseDir(homedir()),
        // Also the recap sidecar under `.herta/compaction` (audit BL8) — it
        // lives outside transcriptDir, so it used to survive every delete.
        this.config.workspaceRoot,
      );
    } catch (err) {
      // The transcript goes first; what can fail after it is the managed
      // workspace — a document in it open in Word holds the folder past the
      // retry deadline. The session is then gone with its folder behind.
      // A throw here used to reach the window as a rejected delete: no
      // `deleted` event, the closed session still on screen, a composer
      // whose sends went nowhere (UX review 2026-09-22, item 6). Report
      // which it is instead; the caller drops the card only when the
      // session is really gone.
      console.warn(`[herta] deleting session ${sessionId} failed:`, err);
      const transcript = join(this.config.transcriptDir, `${sessionId}.jsonl`);
      const removed = await access(transcript).then(
        () => false,
        () => true,
      );
      return { ok: false, wasActive, removed };
    }
    return { ok: true, wasActive, removed: true };
  }

  /**
   * Name a session by hand (ADR 0072 §3): the current topic takes the name.
   * Serialized with the lifecycle ops: a session opening concurrently reads
   * the sidecar as it loads, and a rename written in between would be
   * overwritten by its titler's next write. The open session is renamed
   * through its titler (which fences out a generation in flight) and answers
   * its topics; any other gets its sidecar rewritten, the last topic renamed
   * (with none, its reopen synthesizes the first from the name).
   */
  renameSession(
    sessionId: string,
    title: string,
  ): Promise<RenameSessionResult> {
    return this.serializeLifecycle(async () => {
      const clean = cleanUserTitle(title);
      if (clean === null) return { ok: false } as const;
      try {
        const active = this._active;
        if (active !== null && active.sessionId === sessionId) {
          if (active.renameTitle === undefined) return { ok: false } as const;
          // No message yet means no topic to name: the name would show on
          // the sidebar's card and be dropped by the next open, which keeps
          // no title without a user turn (review 2026-09-30).
          if (!active.record.some((b) => b.kind === "user")) {
            return { ok: false } as const;
          }
          const topics = active.renameTitle(clean);
          return { ok: true, title: clean, topics } as const;
        }
        // Never a sidecar for a session that does not exist.
        await access(join(this.config.transcriptDir, `${sessionId}.jsonl`));
        writeSessionTitle(this.config.transcriptDir, sessionId, clean, [
          ...renameCurrentTopic(
            readSessionTopics(this.config.transcriptDir, sessionId),
            clean,
            [],
          ),
        ]);
        return { ok: true, title: clean } as const;
      } catch (err) {
        console.warn(`[herta] renaming session ${sessionId} failed:`, err);
        return { ok: false } as const;
      }
    });
  }

  async readSessionForExport(
    sessionId: string,
  ): Promise<SessionExportSource | null> {
    try {
      const active = this._active;
      if (active !== null && active.sessionId === sessionId) {
        return {
          sessionId,
          title: active.title,
          lang: active.lang,
          record: exportRecord(active.record),
        };
      }
      const { meta, record } = await readSessionFileAsync(
        join(this.config.transcriptDir, `${sessionId}.jsonl`),
      );
      const title = readSessionTitle(this.config.transcriptDir, sessionId);
      return {
        sessionId,
        // What the window shows: a title whose every user turn was rewound
        // away is not the session's (loadSessionTitleState).
        title:
          title !== undefined && record.some((b) => b.kind === "user")
            ? title
            : null,
        lang: meta.lang ?? "zh",
        record: exportRecord(record),
      };
    } catch (err) {
      console.warn(`[herta] reading session ${sessionId} for export:`, err);
      return null;
    }
  }

  closeActiveSession(): Promise<void> {
    return this.serializeLifecycle(() => this.closeActiveInner());
  }

  /** Unserialized close — for use INSIDE an already-serialized lifecycle op
   *  (calling the public wrapper there would deadlock on the mutex). */
  private async closeActiveInner(): Promise<void> {
    if (this._active === null) return;
    const active = this._active;
    this._active = null;
    await active.close();
  }

  dispose(): void {
    if (this.dreamIntervalHandle !== null) {
      clearInterval(this.dreamIntervalHandle);
      this.dreamIntervalHandle = null;
    }
  }
}

/**
 * Promise-chain mutex for the host's lifecycle ops. Each enqueued op runs
 * only after every previously-enqueued op has SETTLED (success or failure);
 * an op's rejection propagates to its own caller but never poisons the
 * chain. Exported for testing (the host's instance is private).
 */
export function makeLifecycleSerializer(): <T>(
  op: () => Promise<T>,
) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(op: () => Promise<T>): Promise<T> => {
    const run = tail.then(op, op);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * The record as an export reads it (ADR 0072 §3): what the window shows.
 * Herta's thoughts are never shown, and a system block's evidence sections
 * are the prompt's and the expander's — an export prints one line per
 * block, and a command's output tail or an attachment's head excerpt can
 * run to megabytes on the way over IPC. Exported for testing.
 */
export function exportRecord(record: TerminalRecord): TerminalRecord {
  const out: TerminalRecordBlock[] = [];
  for (const block of record) {
    if (block.kind === "herta" && block.surface === "thought") continue;
    if (block.kind === "system") {
      const { evidenceDetail: _detail, evidence: _evidence, ...rest } = block;
      out.push(rest);
      continue;
    }
    out.push(block);
  }
  return out;
}

/** The dream trigger's activity surface (structural — tests pass a fake). */
export interface DreamActivitySink {
  noteActivity(): void;
  tick(): Promise<void> | void;
}

/** Session entry points that RUN or STREAM a turn. Each counts as user
 *  activity for the dream idle clock (audit 2026-07-10, finding 21):
 *  pre-fix only submitText reset it, so a dream pass could fire during a
 *  live opening stream or an orphan-reply regeneration — both real LLM
 *  turns. Session open/create reset the clock host-side. */
const ACTIVITY_METHODS: ReadonlySet<string> = new Set([
  "submitText",
  "continueInterrupted",
  "regenerateLastReplyIfOrphaned",
  "playOpening",
]);

/**
 * Wrap a session so every turn-running entry point notes activity on the
 * dream trigger. The trigger never runs inside the turn — noteActivity()
 * is synchronous BEFORE the turn and again when it ENDS, and tick() fires
 * after in a detached microtask, never awaited in the turn path.
 *
 * Both ends (dream review 2026-09-22, finding 2): the clock used to restart
 * from the user's request only, so a 板砖 run longer than the idle window
 * ended into a clock that had already run out, and the post-turn tick fired
 * a pass the moment the reply landed — while the user was reading it. The
 * host's busy gate keeps a pass out of the turn itself.
 * Exported for testing (the host's trigger is private).
 */
export function wrapSessionForDreamActivity(
  session: Session,
  trigger: DreamActivitySink,
): Session {
  return new Proxy(session, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (
        typeof prop === "string" &&
        ACTIVITY_METHODS.has(prop) &&
        typeof value === "function"
      ) {
        return async (...args: unknown[]) => {
          trigger.noteActivity();
          try {
            return await (value as (...a: unknown[]) => Promise<unknown>).apply(
              target,
              args,
            );
          } finally {
            trigger.noteActivity();
            void Promise.resolve().then(() => trigger.tick());
          }
        };
      }
      return value;
    },
  });
}

function validateConfig(config: AppServerConfig): void {
  if (!isAbsolute(config.workspaceRoot)) {
    throw new Error(
      `AppServerConfig.workspaceRoot must be absolute (got: ${config.workspaceRoot})`,
    );
  }
  // An EMPTY key is allowed at construction: the GUI boots with no key, plays
  // the canned opening (no LLM), and defers no-key onboarding to the first
  // submit (which returns `needsKey` instead of running a turn). See the
  // 2026-06-24-deepseek-key design.
}
