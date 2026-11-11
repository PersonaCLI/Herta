import { type FlowStateFile, localDateOf } from "./flow-store.js";
import type { FlowFailure, FlowSettings } from "./flow-types.js";

/**
 * When an issue is gathered (ADR 0084 §6), on `DreamTrigger`'s pattern: the
 * host ticks it on a coarse timer, and every gate is harness code (D4).
 * One fixed daily cadence for this feature — not a scheduler anyone
 * defines.
 */

/** No issue before this local hour (§6, question 5). */
export const FLOW_START_HOUR = 8;
/** Between a failed attempt and the next automatic one (§6). */
export const FLOW_RETRY_MS = 60 * 60 * 1000;
/** Automatic attempts per local day (§6). */
export const FLOW_ATTEMPTS_PER_DAY = 3;
/** Manual refreshes per local day (§5). */
export const FLOW_REFRESHES_PER_DAY = 3;

export type FlowRunKind = "auto" | "refresh";

export type FlowRunOutcome =
  | { readonly ok: true; readonly issueId: string; readonly cards: number }
  | { readonly ok: false; readonly reason: FlowFailure | "aborted" };

/** The store as the trigger reads it. */
export interface FlowTriggerStore {
  hasIssueFor(localDate: string): Promise<boolean>;
  readState(): Promise<FlowStateFile>;
  updateState(
    change: (s: FlowStateFile) => FlowStateFile,
  ): Promise<FlowStateFile>;
  /** Resolves to false when the change could not be written. */
  commitState(change: (s: FlowStateFile) => FlowStateFile): Promise<boolean>;
}

export interface FlowTriggerOptions {
  readonly now: () => number;
  /** Read fresh each tick: Settings may change it at any time. */
  readonly settings: () => FlowSettings;
  readonly hasKey: () => boolean;
  /** A turn is in flight in the open session: never compete with it. */
  readonly isBusy: () => boolean;
  readonly store: FlowTriggerStore;
  /** Gathers one issue for `localDate`. Detached from the caller: the
   *  trigger never makes a tick or a refresh wait for it. */
  readonly runIssue: (
    kind: FlowRunKind,
    localDate: string,
  ) => Promise<FlowRunOutcome>;
  /** After a run: its outcome is in state.json and the guard is released,
   *  so what the host reads now is what the panel should show. `idle()`
   *  waits for it. */
  readonly onSettled?: (
    outcome: FlowRunOutcome,
    kind: FlowRunKind,
  ) => void | Promise<void>;
}

/** What a tick did: `started`, or the gate that stopped it. */
export type FlowTickResult =
  | "started"
  | "off"
  | "no_key"
  | "running"
  | "early"
  | "busy"
  | "done_today"
  | "backoff"
  | "attempts"
  | "unsaved";

/** `unsaved`: the attempt could not be recorded, so nothing was started —
 *  an unrecorded run is one no daily cap can count. */
export type FlowRefreshResult =
  | "started"
  | "off"
  | "no_key"
  | "running"
  | "limit"
  | "unsaved";

/** The day's counts, reset when the local date moved on. */
function onDay(s: FlowStateFile, day: string): FlowStateFile {
  return s.day === day ? s : { ...s, day, attempts: 0, refreshes: 0 };
}

export function refreshesLeft(s: FlowStateFile, today: string): number {
  return Math.max(0, FLOW_REFRESHES_PER_DAY - onDay(s, today).refreshes);
}

export class FlowTrigger {
  /** Set from a tick's first gate to its run's end, so two ticks (or a
   *  tick and a refresh) can never both pass the async gates. */
  private claimed = false;
  private inFlight: Promise<void> | null = null;
  /** The day's counts and last failure as this process recorded them: a
   *  floor under state.json's, should a later write of it fail. */
  private floor: {
    day: string;
    attempts: number;
    refreshes: number;
    failedAt: number | null;
  } = { day: "", attempts: 0, refreshes: 0, failedAt: null };

  constructor(private readonly opts: FlowTriggerOptions) {}

  get running(): boolean {
    return this.claimed;
  }

  /** Resolves when the run in flight, if any, has finished. */
  async idle(): Promise<void> {
    await this.inFlight;
  }

  /**
   * The automatic path. Gates cheapest first: the settings and the clock in
   * memory, then state.json, then the issues dir. An attempt is recorded
   * before the run starts, so a run that never ends cannot loop.
   */
  async tick(): Promise<FlowTickResult> {
    const { opts } = this;
    if (!opts.settings().enabled) return "off";
    if (!opts.hasKey()) return "no_key";
    if (this.claimed) return "running";
    const t = opts.now();
    if (new Date(t).getHours() < FLOW_START_HOUR) return "early";
    // Not an attempt: the turn's end must not wait out a backoff.
    if (opts.isBusy()) return "busy";
    this.claimed = true;
    let started = false;
    try {
      const today = localDateOf(t);
      const s = onDay(await opts.store.readState(), today);
      const floor = this.floorOn(today);
      const failedAt = Math.max(
        s.lastFailure?.at ?? Number.NEGATIVE_INFINITY,
        floor.failedAt ?? Number.NEGATIVE_INFINITY,
      );
      // Within the hour either side. A failure stamped further ahead than
      // that was stamped by a clock since set back: `t - failedAt` stayed
      // negative and the backoff never ended (review 2026-11-10, second
      // pass). The day's three attempts still bound what follows.
      if (Math.abs(t - failedAt) < FLOW_RETRY_MS) return "backoff";
      const attempts = Math.max(s.attempts, floor.attempts);
      if (attempts >= FLOW_ATTEMPTS_PER_DAY) return "attempts";
      // A missed day stays missed: only today's date is ever gathered.
      if (await opts.store.hasIssueFor(today)) return "done_today";
      const saved = await opts.store.commitState((cur) => {
        const d = onDay(cur, today);
        return { ...d, attempts: d.attempts + 1, lastAttemptAt: t };
      });
      if (!saved) return "unsaved";
      floor.attempts = attempts + 1;
      this.start("auto", today);
      started = true;
      return "started";
    } finally {
      if (!started) this.claimed = false;
    }
  }

  /**
   * The Trailblazer's "refresh now" (§5–6): at once, whatever the hour, the
   * busy flag or the backoff — they asked — but inside the day's three, and
   * never beside a run in flight. Each makes a new issue for today.
   */
  async refresh(): Promise<FlowRefreshResult> {
    const { opts } = this;
    if (!opts.settings().enabled) return "off";
    if (!opts.hasKey()) return "no_key";
    if (this.claimed) return "running";
    this.claimed = true;
    let started = false;
    try {
      const t = opts.now();
      const today = localDateOf(t);
      const s = onDay(await opts.store.readState(), today);
      const floor = this.floorOn(today);
      const refreshes = Math.max(s.refreshes, floor.refreshes);
      if (refreshes >= FLOW_REFRESHES_PER_DAY) return "limit";
      const saved = await opts.store.commitState((cur) => {
        const d = onDay(cur, today);
        return { ...d, refreshes: d.refreshes + 1, lastAttemptAt: t };
      });
      if (!saved) return "unsaved";
      floor.refreshes = refreshes + 1;
      this.start("refresh", today);
      started = true;
      return "started";
    } finally {
      if (!started) this.claimed = false;
    }
  }

  /** The floor for `day`: its counts start over with the date, its last
   *  failure does not (a backoff runs past midnight, as state.json's). */
  private floorOn(day: string): typeof this.floor {
    if (this.floor.day !== day) {
      this.floor = { ...this.floor, day, attempts: 0, refreshes: 0 };
    }
    return this.floor;
  }

  private start(kind: FlowRunKind, today: string): void {
    const run = async (): Promise<void> => {
      let outcome: FlowRunOutcome;
      try {
        outcome = await this.opts.runIssue(kind, today);
      } catch {
        outcome = { ok: false, reason: "error" };
      }
      // An aborted run (the app quitting) is not a failure: no backoff.
      const failure: FlowFailure | null | undefined = outcome.ok
        ? null
        : outcome.reason === "aborted"
          ? undefined
          : outcome.reason;
      try {
        if (failure !== undefined) {
          const at = this.opts.now();
          this.floor.failedAt = failure === null ? null : at;
          await this.opts.store.updateState((s) => ({
            ...s,
            lastFailure: failure === null ? null : { at, reason: failure },
          }));
        }
      } finally {
        this.claimed = false;
      }
      try {
        await this.opts.onSettled?.(outcome, kind);
      } catch {
        // a listener's error is not the run's
      }
    };
    this.inFlight = run().catch(() => undefined);
  }
}
