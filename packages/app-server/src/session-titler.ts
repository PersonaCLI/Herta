import type {
  ProviderAdapter,
  SessionTopic,
  TerminalRecord,
} from "@herta/core";
import {
  readSessionTitle,
  readSessionTopics,
  writeSessionTitle,
} from "@herta/core";
import { generateSessionTitle, type PromptLang } from "@herta/herta";
import { type ApiKey, deepseekProvider } from "@herta/providers";
import {
  appendTopic,
  pruneTopics,
  synthesizeInitialTopic,
  topicAnchorText,
} from "./session-topics.js";
import type { TitleEvent } from "./types.js";

/**
 * The session title and its topic history (extracted from session.ts,
 * 2026-09-03 — eight fields and three methods that only ever talked to each
 * other, plus the rewind fence and the close-time abort).
 *
 * A title is generated from the recent window after a user turn: on a new
 * session (retried a few turns while untitled), on a re-opened titled
 * session's first new turn, and periodically on a long session. A CHANGED
 * title marks a topic boundary — the rail's jump targets (session-topics.ts).
 * Both persist in the title sidecar beside the transcript. Every generation
 * is fire-and-forget and best-effort: a model error, an empty answer or a
 * disk failure leaves the title unchanged, never throws, and says so in the
 * log (owner 2026-09-03).
 */

// ── Dynamic title tuning ─────────────────────────────────────────────────────

/** Re-title a long session every this many user turns since the last title. */
const RETITLE_EVERY_N_TURNS = 6;
/** How many trailing user→Herta exchanges feed a (re)title. At the first turn
 *  this IS the first exchange, so the initial title is unchanged. */
const TITLE_WINDOW_EXCHANGES = 2;
/** Cap on consecutive per-turn attempts to produce an initial title (while the
 *  session is still untitled). Bounds the retry on a failing/empty-output title
 *  model to a few turns; the periodic trigger still retries later. */
const MAX_INITIAL_TITLE_ATTEMPTS = 3;

/**
 * Build the title-model input from the RECENT window — the last
 * `windowExchanges` user messages plus the Herta speech from the first of those
 * onward. Returns null when there is no user turn (nothing to title).
 * `startIndex` is the record index of the window's first user block — a title
 * change anchors its TOPIC entry there (session-topics.ts): the new title
 * describes the conversation from that message on. Exported for unit testing.
 */
export function buildRecentTitleInput(
  record: TerminalRecord,
  windowExchanges: number,
): { userText: string; hertaText: string; startIndex: number } | null {
  const userIdxs: number[] = [];
  record.forEach((b, i) => {
    if (b.kind === "user") userIdxs.push(i);
  });
  if (userIdxs.length === 0) return null;
  // Take the last min(N, windowExchanges) user blocks from the tail.
  const take = Math.min(userIdxs.length, windowExchanges);
  const start = userIdxs[userIdxs.length - take] ?? 0;
  const slice = record.slice(start);
  const userText = slice
    .filter((b) => b.kind === "user")
    .map((b) => (b.kind === "user" ? b.text : ""))
    .join("\n")
    .trim();
  const hertaText = slice
    .filter((b) => b.kind === "herta" && b.surface === "speech")
    .map((b) => (b.kind === "herta" ? b.text : ""))
    .join("\n")
    .trim();
  return userText === "" ? null : { userText, hertaText, startIndex: start };
}

/**
 * The title model — a fast flash chat call at thinking "low" (owner decision
 * 2026-08-03; omitting `thinking` meant the server's DEFAULT effort, which is
 * "high" — titles were silently paying full reasoning). NOTE:
 * deepseek-v4-flash is a reasoning model; it streams a reasoning chain BEFORE
 * the answer, so maxTokens must cover the reasoning PLUS the (short) title —
 * a tight cap silently starves the answer and yields an empty title. 1024
 * stays: generous for low effort, and the model stops naturally after the
 * title.
 */
export function createTitleProvider(
  apiKey: ApiKey,
  baseUrl: { baseUrl?: string } = {},
): ProviderAdapter {
  return deepseekProvider({
    apiKey,
    model: "deepseek-v4-flash",
    thinking: "low",
    maxTokens: 1024,
    temperature: 0.3,
    ...baseUrl,
  });
}

/**
 * The title and topics a session opens with, read from the sidecar and
 * judged against the record actually loaded.
 *
 * The sidecar can outlive the record it described (review 2026-07-31):
 * rewind-to-empty deliberately skips the sidecar rewrite ("the next title
 * write starts it fresh" — which never comes if the app closes first), and a
 * crash can land between the JSONL truncation and the sidecar write. Without
 * this, resume resurrected the withdrawn title and dead rail ticks — and the
 * next real title write re-persisted them for good.
 *
 * Topic history (2026-07-12) persists alongside the title. Sessions titled
 * BEFORE the history existed get their first entry synthesized from the
 * existing title, anchored at the record's first user block (in-memory; it
 * persists with the next real title write). The synthesis runs AFTER the
 * prune on purpose: a title whose every topic was pruned re-anchors at the
 * record's first surviving user block, same as a pre-history sidecar.
 */
export function loadSessionTitleState(
  transcriptDir: string,
  sessionId: string,
  loadedRecord: TerminalRecord,
): { title: string | null; topics: readonly SessionTopic[] } {
  let title = readSessionTitle(transcriptDir, sessionId) ?? null;
  let topics: readonly SessionTopic[] = readSessionTopics(
    transcriptDir,
    sessionId,
  );
  if (!loadedRecord.some((b) => b.kind === "user")) {
    // No surviving user turn: whatever the sidecar describes is gone.
    title = null;
    topics = [];
  } else {
    topics = pruneTopics(topics, loadedRecord.length);
  }
  const synthesized = synthesizeInitialTopic(title, topics, loadedRecord);
  if (synthesized !== null) topics = [synthesized];
  return { title, topics };
}

export interface SessionTitlerDeps {
  readonly sessionId: string;
  readonly transcriptDir: string;
  /** Interaction language of the title prompt and the generated title. */
  readonly lang: PromptLang;
  readonly provider: ProviderAdapter;
  /** The driver's CURRENT record — read at generation time, and again when
   *  the answer lands, because the record moves while the model thinks. */
  readonly getRecord: () => TerminalRecord;
  /** Where a landed title goes (the session's projector). */
  readonly emit: (event: TitleEvent) => void;
  readonly initialTitle: string | null;
  readonly initialTopics: readonly SessionTopic[];
}

export class SessionTitler {
  private _title: string | null;
  /** Topic history (title changes anchored at their window's first user
   *  block) — the rail's jump targets. Loaded from the sidecar; appended by
   *  a landed title; pruned by rewind. */
  private _topics: readonly SessionTopic[];
  /** A reopened session that already has a title re-titles on its first new
   *  turn (so continuing an old session refreshes the now-stale title). */
  private reEntryRetitlePending: boolean;
  private turnsSinceTitle = 0;
  private genInFlight = false;
  /** Bumped by every rewind. An in-flight title generation captures the
   *  epoch at start and drops its result on a mismatch: the window it
   *  titled was (partly) withdrawn while the model was thinking, and a late
   *  landing re-set a title for erased content and appended a ghost topic
   *  whose post-rewind `bornAtLength` even pruneTopics couldn't kill
   *  (review 2026-07-31). */
  private epoch = 0;
  /** Consecutive attempts since the last SUCCESS — bounds the initial-title
   *  retry (while untitled) on a failing title model. */
  private attempts = 0;
  private readonly abort = new AbortController();
  /** Test seam (whenSettled). */
  private pending: Promise<void> | null = null;

  constructor(private readonly deps: SessionTitlerDeps) {
    this._title = deps.initialTitle;
    this._topics = deps.initialTopics;
    this.reEntryRetitlePending = deps.initialTitle !== null;
  }

  get title(): string | null {
    return this._title;
  }

  get topics(): readonly SessionTopic[] {
    return this._topics;
  }

  /**
   * Decide whether the user turn that just finished should (re)generate the
   * title, and if so kick it off (fire-and-forget). Triggers: no title yet
   * (new session or a prior failed attempt), a re-opened titled session's
   * first new turn, or every RETITLE_EVERY_N_TURNS turns on a long session.
   * Single-flight: while a generation runs, later turns keep counting and
   * retry next turn.
   */
  afterUserTurn(): void {
    this.turnsSinceTitle += 1;
    const shouldRetitle =
      (this._title === null && this.attempts < MAX_INITIAL_TITLE_ATTEMPTS) ||
      this.reEntryRetitlePending ||
      this.turnsSinceTitle >= RETITLE_EVERY_N_TURNS;
    if (!shouldRetitle || this.genInFlight) return;
    this.reEntryRetitlePending = false;
    this.turnsSinceTitle = 0;
    this.pending = this.generateAndEmit();
  }

  /**
   * The record was truncated to `recordLength` blocks. Fences out an
   * in-flight generation (see `epoch`); clears the title when no user turn
   * survives (the generated title described a now-withdrawn exchange — the
   * next turn regenerates from scratch, while a surviving prior turn keeps
   * its title); prunes topic anchors beyond the truncation and persists the
   * pruned history so a resume doesn't resurrect dead jump targets (skipped
   * when the title itself was cleared — the next title write starts the
   * sidecar fresh).
   */
  onRewind(recordLength: number, hasUserTurn: boolean): void {
    this.epoch += 1;
    if (!hasUserTurn) {
      this._title = null;
      this.reEntryRetitlePending = false;
      this.turnsSinceTitle = 0;
      this.attempts = 0;
    }
    const pruned = pruneTopics(this._topics, recordLength);
    if (pruned !== this._topics) {
      this._topics = pruned;
      if (this._title !== null) {
        writeSessionTitle(
          this.deps.transcriptDir,
          this.deps.sessionId,
          this._title,
          this._topics,
        );
      }
    }
  }

  /**
   * Test seam: resolves once the in-flight title generation settles (no-op
   * when none ran). Production never awaits this — title generation is
   * fire-and-forget so it cannot delay a turn.
   */
  async whenSettled(): Promise<void> {
    if (this.pending !== null) await this.pending;
  }

  /** Abort any in-flight generation so a slow flash call can't outlive the
   *  session. */
  dispose(): void {
    this.abort.abort();
  }

  /**
   * Generate a title from the recent window (last TITLE_WINDOW_EXCHANGES
   * exchanges — at the first turn that IS the first exchange), persist it,
   * and emit a title event. Best-effort: any failure (model error, empty
   * output, disk error) leaves the title unchanged and never throws — but
   * says so in the log (owner 2026-09-03: a sidebar stuck on 未命名 had
   * nothing in the log to explain it). Single-flight via `genInFlight`.
   */
  private async generateAndEmit(): Promise<void> {
    this.genInFlight = true;
    this.attempts += 1;
    const epoch = this.epoch;
    const { sessionId } = this.deps;
    try {
      const input = buildRecentTitleInput(
        this.deps.getRecord(),
        TITLE_WINDOW_EXCHANGES,
      );
      if (input === null) {
        console.warn(
          `[herta] title: nothing to title yet (no user text in the window) — session ${sessionId}`,
        );
        return;
      }
      const title = await generateSessionTitle(
        this.deps.provider,
        {
          ...input,
          lang: this.deps.lang,
          // Incumbent-title contract (owner 2026-08-11): a re-title that sees
          // the current title can say "still on topic" by copying it exactly,
          // which appendTopic's exact-match dedup then swallows — no churn,
          // no ghost topic tick on a same-topic re-entry. Absent on the
          // initial title (nothing to keep).
          ...(this._title !== null ? { currentTitle: this._title } : {}),
        },
        this.abort.signal,
      );
      if (title === null) {
        // The generator swallows the provider error, so this line is the
        // only trace a failing title model leaves.
        console.warn(
          `[herta] title: the title model returned nothing (attempt ${this.attempts}/${MAX_INITIAL_TITLE_ATTEMPTS} while untitled) — session ${sessionId}`,
        );
        return;
      }
      // A rewind landed while the model was thinking: `input` describes a
      // window that no longer exists, and every index below is stale. Drop
      // the whole result — no title, no topic, no persist, no emit.
      if (epoch !== this.epoch) return;
      // Topic history (2026-07-12): a CHANGED title marks a topic boundary,
      // anchored at the title window's first user block (the message the new
      // title describes the conversation from). A re-derived same title
      // appends nothing — the conversation stayed on topic.
      const recordNow = this.deps.getRecord();
      const anchorBlock = recordNow[input.startIndex];
      const appended = appendTopic(this._topics, {
        title,
        anchorIndex: input.startIndex,
        anchorText: topicAnchorText(
          anchorBlock?.kind === "user" ? anchorBlock.text : input.userText,
        ),
        at: new Date().toISOString(),
        // How much conversation this topic needed to exist. A rewind below it
        // withdrew the turn that produced this title, so the topic goes with
        // it — which the anchor cannot express, since the anchor is the title
        // WINDOW's start and may predate this turn by hours (pruneTopics).
        bornAtLength: recordNow.length,
      });
      if (appended !== null) this._topics = appended;
      writeSessionTitle(
        this.deps.transcriptDir,
        sessionId,
        title,
        this._topics,
      );
      this._title = title;
      this.attempts = 0; // success → refresh the initial-title budget
      const newTopic =
        appended !== null ? this._topics[this._topics.length - 1] : undefined;
      this.deps.emit({
        kind: "title",
        sessionId,
        title,
        ...(newTopic !== undefined ? { topic: newTopic } : {}),
      });
    } catch (err) {
      // best-effort: a title failure never affects the session — but it is
      // logged, so a stuck 未命名 can be diagnosed from the log.
      console.warn(
        `[herta] title: generation failed — session ${sessionId}:`,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.genInFlight = false;
    }
  }
}
