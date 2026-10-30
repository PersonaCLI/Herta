import type { WebClient } from "@herta/core";
import { type DigestModel, fetchPreviewImage } from "@herta/tools";
import { gatherFlowInterests } from "./flow-interests.js";
import { type FlowWord, runFlowIssue } from "./flow-pipeline.js";
import { FlowStore, localDateOf, seenOf } from "./flow-store.js";
import {
  type FlowRefreshResult,
  type FlowRunKind,
  type FlowRunOutcome,
  type FlowTickResult,
  FlowTrigger,
  refreshesLeft,
} from "./flow-trigger.js";
import type {
  FlowEvent,
  FlowIssue,
  FlowLang,
  FlowSettings,
  FlowStageInfo,
  FlowStatus,
} from "./flow-types.js";

/**
 * Flow for its host (ADR 0084): the store, the trigger and the pipeline
 * tied together, app-wide — the same Flow from every session (§2). The
 * desktop's main process owns one; the CLI none (§1).
 *
 * The host hands in what only it knows — the settings, the key, whether a
 * turn is in flight, the recent workspaces, the GUI's language, Herta's
 * word — and hears back through `onChange`. Nothing here reaches a
 * session's record (§7, D7).
 */

/** The trigger's coarse tick (§6). */
export const FLOW_TICK_MS = 10 * 60 * 1000;
/** The first tick after launch (§6). */
export const FLOW_FIRST_TICK_MS = 60 * 1000;

export interface FlowServiceOptions {
  /** Flow's own dir under the app's data dir, beside the session
   *  transcripts and never in a workspace (§10). */
  readonly dir: string;
  /** Read fresh at every tick and run: Settings may change it any time. */
  readonly settings: () => FlowSettings;
  readonly hasKey: () => boolean;
  /** A turn is in flight in the open session (§6). */
  readonly isBusy: () => boolean;
  /** The web seam and the flash side model (ADR 0080, ADR 0043), each read
   *  once per run: a run spends one key throughout, and a key changed in
   *  Settings reaches the next run. */
  readonly webClient: () => WebClient;
  readonly sideModel: () => DigestModel;
  /** Herta's word on one post (§7): `hertaWordOn` in @herta/herta. */
  readonly word: FlowWord;
  /** The workspaces of the sessions used in the last 14 days, most recent
   *  first (§4, question 10). */
  readonly workspaceRoots: () => readonly string[] | Promise<readonly string[]>;
  /** The GUI's language now: an issue is gathered in it and keeps it (§7). */
  readonly lang: () => FlowLang;
  readonly onChange: (event: FlowEvent) => void;
  /** A source page's preview picture (§8); defaults to `fetchPreviewImage`,
   *  the guarded fetch. Null when there is none to show. */
  readonly picture?: (
    pageUrl: string,
    signal: AbortSignal,
  ) => Promise<{ readonly bytes: Uint8Array; readonly type: string } | null>;
  /** Test seam. */
  readonly now?: () => number;
}

export class FlowService {
  private readonly store: FlowStore;
  private readonly trigger: FlowTrigger;
  private readonly now: () => number;
  private stage: FlowStageInfo | null = null;
  /** The run in flight, to abort it on dispose. */
  private abort: AbortController | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private everyTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly opts: FlowServiceOptions) {
    this.store = new FlowStore(opts.dir);
    this.now = opts.now ?? Date.now;
    this.trigger = new FlowTrigger({
      now: this.now,
      settings: opts.settings,
      hasKey: opts.hasKey,
      isBusy: opts.isBusy,
      store: this.store,
      runIssue: (kind, localDate) => this.runIssue(kind, localDate),
      onSettled: (outcome) => this.settled(outcome),
    });
  }

  /** Tick once a minute after launch, then every ten minutes (§6). The
   *  timers never hold the process open. */
  start(): void {
    if (this.disposed || this.everyTimer !== null) return;
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      void this.tick().catch(() => undefined);
    }, FLOW_FIRST_TICK_MS);
    this.everyTimer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, FLOW_TICK_MS);
    this.firstTimer.unref?.();
    this.everyTimer.unref?.();
  }

  /**
   * Delete what has turned seven days old — whether or not Flow is on, so
   * nothing outlives its week (§10) — then let the trigger decide whether
   * today's issue starts. Never waits for the run.
   */
  async tick(): Promise<FlowTickResult> {
    if (this.disposed) return "off";
    try {
      if ((await this.store.prune(this.now())).length > 0) {
        await this.emitState();
      }
    } catch {
      // a file that will not go now goes at a later tick
    }
    return this.trigger.tick();
  }

  /** "Refresh now" (§5–6): a new issue for today, at most three a day. */
  async refresh(): Promise<FlowRefreshResult> {
    if (this.disposed) return "off";
    return this.trigger.refresh();
  }

  /** The issues of the last seven local days, newest first. */
  issues(): Promise<FlowIssue[]> {
    return this.store.issues(this.now());
  }

  /** The panel opened the issue. With an id, only that issue is cleared: one
   *  that landed since the panel drew stays unread. */
  async markRead(issueId?: string): Promise<FlowStatus> {
    await this.store.updateState((s) =>
      s.unread === null || (issueId !== undefined && s.unread !== issueId)
        ? s
        : { ...s, unread: null },
    );
    const status = await this.state();
    this.emit({ kind: "state", status });
    return status;
  }

  async state(): Promise<FlowStatus> {
    const s = await this.store.readState();
    return {
      running: this.abort !== null,
      stage: this.stage,
      unread: s.unread,
      lastAttemptAt: s.lastAttemptAt,
      lastFailure: s.lastFailure,
      refreshesLeft: refreshesLeft(s, localDateOf(this.now())),
    };
  }

  /** Resolves when the run in flight, if any, has settled. */
  idle(): Promise<void> {
    return this.trigger.idle();
  }

  /** Stop the timers and the run in flight; an aborted run is not a
   *  failure and leaves no backoff. Nothing is emitted after this. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.firstTimer !== null) clearTimeout(this.firstTimer);
    if (this.everyTimer !== null) clearInterval(this.everyTimer);
    this.firstTimer = null;
    this.everyTimer = null;
    this.abort?.abort();
    await this.trigger.idle();
  }

  private async runIssue(
    _kind: FlowRunKind,
    localDate: string,
  ): Promise<FlowRunOutcome> {
    const ac = new AbortController();
    this.abort = ac;
    this.stage = null;
    let issueId: string | null = null;
    try {
      await this.emitState();
      const lang = this.opts.lang();
      const [roots, recent] = await Promise.all([
        this.opts.workspaceRoots(),
        this.store.issues(this.now()),
      ]);
      const interests = await gatherFlowInterests({
        settings: this.opts.settings(),
        workspaceRoots: roots,
        lang,
      });
      const id = await this.store.nextIssueId(localDate);
      issueId = id;
      const result = await runFlowIssue(
        {
          web: this.opts.webClient(),
          model: this.opts.sideModel(),
          interests,
          seen: seenOf(recent),
          recentTitles: recent.flatMap((i) => i.cards.map((c) => c.title)),
          now: this.now,
          lang,
          word: this.opts.word,
          onStage: (info) => {
            this.stage = info;
            this.emit({ kind: "stage", ...info });
          },
          savePage: (url, page) =>
            this.store.savePage(id, url, page, new Date(this.now())),
        },
        ac.signal,
      );
      if (!result.ok) {
        await this.store.removeIssueFiles(id).catch(() => undefined);
        return { ok: false, reason: result.reason };
      }
      // The pictures (§8), all at once: each is bounded by its own deadline,
      // and a card without one keeps its halftone cover.
      const cards = await Promise.all(
        result.cards.map(async (card, n) => {
          const got = await this.picture(card.url, ac.signal).catch(() => null);
          if (got === null) return card;
          const picture = await this.store.saveImage(
            id,
            n,
            got.bytes,
            got.type,
          );
          return picture === null ? card : { ...card, picture };
        }),
      );
      const number = (await this.store.readState()).nextNumber;
      const issue: FlowIssue = {
        id,
        localDate,
        number,
        lang,
        createdAt: new Date(this.now()).toISOString(),
        cards,
        evidence: result.evidence,
      };
      await this.store.writeIssue(issue);
      // An issue with no posts is still an episode: the broadcast went out
      // and found nothing new. It just has nothing to mark unread.
      await this.store.updateState((s) => ({
        ...s,
        nextNumber: Math.max(s.nextNumber, number + 1),
        unread: issue.cards.length > 0 ? issue.id : s.unread,
      }));
      return { ok: true, issueId: id, cards: issue.cards.length };
    } catch {
      if (issueId !== null) {
        await this.store.removeIssueFiles(issueId).catch(() => undefined);
      }
      return { ok: false, reason: ac.signal.aborted ? "aborted" : "error" };
    } finally {
      if (this.abort === ac) this.abort = null;
      this.stage = null;
    }
  }

  private async picture(
    pageUrl: string,
    signal: AbortSignal,
  ): Promise<{ readonly bytes: Uint8Array; readonly type: string } | null> {
    if (this.opts.picture !== undefined)
      return this.opts.picture(pageUrl, signal);
    const got = await fetchPreviewImage(pageUrl, signal);
    return got.ok ? { bytes: got.bytes, type: got.type } : null;
  }

  private async settled(outcome: FlowRunOutcome): Promise<void> {
    if (outcome.ok) {
      this.emit({
        kind: "landed",
        issueId: outcome.issueId,
        cards: outcome.cards,
      });
    } else if (outcome.reason !== "aborted") {
      this.emit({ kind: "failed", reason: outcome.reason });
    }
    await this.emitState();
  }

  private async emitState(): Promise<void> {
    if (this.disposed) return;
    try {
      this.emit({ kind: "state", status: await this.state() });
    } catch {
      // the next change emits again
    }
  }

  private emit(event: FlowEvent): void {
    if (this.disposed) return;
    try {
      this.opts.onChange(event);
    } catch {
      // the host's listener is not Flow's to fail
    }
  }
}
