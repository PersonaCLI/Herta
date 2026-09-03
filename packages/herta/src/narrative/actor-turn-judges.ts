// Supervisor-side judgment calls of the actor turn: the shared judgment
// window (deadline, turn-interrupt link, the refcounted `supervisor.check`
// bracket), the supervisor verdict, the trigger re-pass, the missing-dispatch
// judge and the first-pass judge starter. Extracted from actor-turn.ts on
// 2026-09-03 (owner's request: the file had grown to 3,200 lines); bodies and
// comments are verbatim.

import type {
  AgentEvent,
  EventBus,
  ProviderAdapter,
  TerminalRecord,
} from "@herta/core";
import {
  ActorTurnAbortedError,
  type ActorTurnDeps,
  MAX_DISPATCHES_PER_TURN,
} from "./actor-turn-deps.js";
import { abandonController, stripStrayOpenTags } from "./actor-turn-stream.js";
import { sanitizeActorText } from "./escape.js";
import { lastNTurnsForSupervisor } from "./intent-router.js";
import { neutralizeBanzhuanTrigger, parseHertaBlock } from "./parse.js";
import type { SlowStreamController } from "./streaming-sink.js";
import {
  formatSupervisorOutDump,
  isTriggerRelatedFinding,
  judgeMissingDispatch,
  parseSupervisorVerdict,
  recheckTrigger,
} from "./supervisor.js";

/** Wall-clock deadline on the supervisor call. Fail-soft covers THROWS, not
 *  hangs: a supervisor stream that stalls (connection up, nothing emitted)
 *  leaves the verdict gate closed and the paced stream frozen in its hold
 *  forever. The supervisor runs in THINKING mode, so an output-token cap is
 *  not viable (it would truncate reasoning and garble the verdict) — a
 *  generous deadline is the hang protection instead. Reaching it fail-softs
 *  to OK, exactly like a thrown provider error. */
const SUPERVISOR_DEADLINE_MS = 60_000;

// ── Supervisor-side judgment calls ──────────────────────────────────────────
//
// Three model calls gate a candidate speech before it commits: the supervisor
// verdict, the trigger re-pass (judgeTriggerAndNeutralize), and the
// missing-dispatch judge (ADR 0036). Until 2026-08-19 each carried its own
// copy of the same discipline inline in the main loop — a wall-clock deadline
// (SUPERVISOR_DEADLINE_MS) linked to the turn signal, the ephemeral
// `supervisor.check` start/end bracket on the bus, cleanup in `finally` — so
// a fix to one (the deadline, bug 4's hint bracket) had to be made three
// times. `withJudgmentWindow` is that discipline once; the three judges sit
// on top of it with their own fail-soft rules.

/**
 * Run one judgment call under the shared discipline. The call gets its OWN
 * abort signal — the deadline (SUPERVISOR_DEADLINE_MS; fail-soft covers
 * THROWS, not hangs — a stalled stream would park the turn) and the turn's
 * interrupt both abort the CALL, never the turn. The `supervisor.check`
 * start/end bracket is the renderer's judgment-window hint (bug 4,
 * 2026-07-09: the paced reveal holds its tail while a verdict is pending, so
 * a slow judge read as a frozen cursor); `end` fires in the finally, covering
 * OK / veto / fail-soft / deadline alike. Whatever `fn` throws propagates —
 * each judge decides fail-soft vs interrupt itself, and can read
 * `judgeSignal.aborted` to tell a deadline from a provider error.
 */
async function withJudgmentWindow<T>(
  bus: EventBus<AgentEvent>,
  turnSignal: AbortSignal,
  fn: (judgeSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const judgeAbort = new AbortController();
  const deadlineTimer = setTimeout(
    () => judgeAbort.abort(),
    SUPERVISOR_DEADLINE_MS,
  );
  const onTurnAbort = (): void => judgeAbort.abort();
  if (turnSignal.aborted) judgeAbort.abort();
  else turnSignal.addEventListener("abort", onTurnAbort, { once: true });
  openJudgmentWindow(bus);
  try {
    return await fn(judgeAbort.signal);
  } finally {
    clearTimeout(deadlineTimer);
    turnSignal.removeEventListener("abort", onTurnAbort);
    closeJudgmentWindow(bus);
  }
}

/**
 * Open judgment windows per bus (2026-09-03). The first-pass judge runs
 * ALONGSIDE the supervisor now, and the renderer folds `supervisor.check`
 * as a boolean (`start` → verdict pending, `end` → clear), so two
 * overlapping brackets would clear the hold hint the moment the FASTER call
 * returned while the verdict was still out. One bracket spans the overlap:
 * `start` on the first window to open, `end` on the last to close. Keyed by
 * the bus — one per session, which runs one turn at a time on it.
 */
const openJudgmentWindows = new WeakMap<EventBus<AgentEvent>, number>();

function openJudgmentWindow(bus: EventBus<AgentEvent>): void {
  const depth = openJudgmentWindows.get(bus) ?? 0;
  openJudgmentWindows.set(bus, depth + 1);
  if (depth === 0) {
    bus.publish({ type: "supervisor.check", layer: "actor", phase: "start" });
  }
}

function closeJudgmentWindow(bus: EventBus<AgentEvent>): void {
  const depth = Math.max(0, (openJudgmentWindows.get(bus) ?? 1) - 1);
  openJudgmentWindows.set(bus, depth);
  if (depth === 0) {
    bus.publish({ type: "supervisor.check", layer: "actor", phase: "end" });
  }
}

/** A promise that never rejects — for a judge started alongside the
 *  supervisor, so its outcome can be read AFTER the verdict without an
 *  unhandled rejection in between. */
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error): Settled<T> => ({ ok: false, error }),
  );
}

export interface SupervisorVerdict {
  verdict: "ok" | "block";
  reason?: string;
  blockFindings: ReadonlyArray<{ category: string; detail: string }>;
}

/**
 * Stream the supervisor over the built frame and parse its verdict.
 * Fail-soft (a provider error OR the deadline firing): log the synthetic dump
 * body, return OK, so the candidate commits as-is. A USER INTERRUPT is not a
 * supervisor failure: fail-softing it committed the candidate as if approved
 * (the speech persisted, a @板砖 in it dispatched on a dead signal), so an
 * interrupt tears the visible slow-stream down (exactly-one-terminal-call
 * contract) and aborts record-carrying (audit 2026-07-13 T2.5 — a raw
 * rethrow reverted the driver to its pre-turn record, losing blocks a prior
 * @板砖 dispatch already put on screen and disk, D7).
 */
export async function runSupervisorVerdict(opts: {
  deps: ActorTurnDeps;
  supervisorProvider: ProviderAdapter;
  supervisorPrompt: string;
  supervisorFrame: Parameters<ProviderAdapter["streamChat"]>[0];
  signal: AbortSignal;
  record: TerminalRecord;
  /** The paced controller rendering the candidate (torn down on interrupt). */
  controller: SlowStreamController | undefined;
}): Promise<SupervisorVerdict> {
  const { deps, signal } = opts;
  return withJudgmentWindow(deps.bus, signal, async (judgeSignal) => {
    try {
      let buffered = "";
      let reasoning = "";
      for await (const ev of opts.supervisorProvider.streamChat(
        opts.supervisorFrame,
        judgeSignal,
      )) {
        if (ev.type === "text-delta") {
          buffered += ev.text;
        } else if (ev.type === "reasoning-delta") {
          // Captured for diagnostic dumping only. The verdict is decided
          // from the final text-delta line; reasoning lets operators audit
          // whether the stated rationale matches.
          reasoning += ev.text;
        } else if (ev.type === "finish") {
          break;
        }
      }
      deps.onPrompt?.(
        "supervisor-out",
        formatSupervisorOutDump({
          prompt: opts.supervisorPrompt,
          reasoning,
          rawOutput: buffered,
        }),
      );
      return parseSupervisorVerdict(buffered);
    } catch (err) {
      if (signal.aborted) {
        await abandonController(opts.controller);
        throw new ActorTurnAbortedError(opts.record);
      }
      const timedOut = judgeSignal.aborted;
      const errorMsg = err instanceof Error ? err.message : String(err);
      deps.onPrompt?.(
        "supervisor-out",
        formatSupervisorOutDump({
          prompt: opts.supervisorPrompt,
          reasoning: "",
          rawOutput: timedOut
            ? `[supervisor deadline (${SUPERVISOR_DEADLINE_MS}ms): ${errorMsg}]`
            : `[supervisor failed: ${errorMsg}]`,
        }),
      );
      return { verdict: "ok", blockFindings: [] };
    }
  });
}

/**
 * Run the focused trigger judge over a candidate that carries a
 * dispatch-effective `@板砖`, and neutralize the token (`@板砖` → quoted
 * `` `@板砖` ``, visible but inert — 2026-08-17; the stripped `板砖` form only
 * as the malformed-backtick fallback) when it says this is not a dispatch.
 * Returns the text to commit plus any reason to record.
 *
 * Shared by BOTH passes (first pass and veto re-speak). It was the re-pass's
 * alone until a live miss showed why the first pass needs it too (user
 * 2026-07-29): Herta wrote "没有 @板砖，没有场外求助" — a rhetorical negation —
 * the supervisor passed it, and the literal token woke the coprocessor for
 * 24s of nothing. §8 covers that class with near-identical examples; the
 * trouble is that §8 is one rule inside a very long prompt. Measured on the
 * shipped flash-high config (scripts/supervisor-lab.mjs, 3 samples): the full
 * supervisor blocks that sentence 2/3, this judge 3/3 — and does it in ~2.1s
 * against the supervisor's ~10.5s, because its whole prompt IS the question.
 * Both agree on the controls (a bare 板砖 mention, a real in-scope dispatch),
 * so the second look costs no false blocks.
 *
 * Gate order matters: this runs only after the supervisor has PASSED the
 * speech, so it never competes with a veto, and only when a token would
 * really fire (`wouldDispatch`) — no round-trip for a backticked `@板砖`, or
 * one already past the per-turn dispatch budget (commit neutralizes those
 * regardless).
 *
 * Fail-soft on throws, hard-fail on interrupt: an aborted turn must not
 * commit-and-dispatch. The interrupt escapes as the thrown error; the
 * caller owns the controller teardown and the record-carrying abort.
 */
export async function judgeTriggerAndNeutralize(opts: {
  deps: ActorTurnDeps;
  supervisorProvider: ProviderAdapter;
  signal: AbortSignal;
  record: TerminalRecord;
  candidate: string;
  thought: string | undefined;
}): Promise<{ text: string; reason?: string }> {
  const { deps, signal, candidate } = opts;
  let recheckPrompt = "";
  return withJudgmentWindow(deps.bus, signal, async (judgeSignal) => {
    try {
      const recheck = await recheckTrigger({
        provider: opts.supervisorProvider,
        recentRecord: lastNTurnsForSupervisor(opts.record, 8),
        ...(opts.thought !== undefined
          ? { currentTurnThought: opts.thought }
          : {}),
        candidateSpeech: candidate,
        lang: deps.lang ?? "zh",
        signal: judgeSignal,
        onPromptBuilt: (p) => {
          recheckPrompt = p;
          // Shares the re-pass's dump channel: it is the same judge, and its
          // prompt names itself in the first line, so a trace reader can
          // tell the two passes apart by content.
          deps.onPrompt?.("supervisor-retry", p);
        },
      });
      deps.onPrompt?.(
        "supervisor-retry-out",
        formatSupervisorOutDump({
          prompt: recheck.prompt,
          reasoning: recheck.reasoning,
          rawOutput: recheck.rawOutput,
        }),
      );
      if (
        recheck.verdict === "block" &&
        recheck.blockFindings.some(isTriggerRelatedFinding)
      ) {
        const triggerReasons = recheck.blockFindings
          .filter(isTriggerRelatedFinding)
          .map((f) => f.detail)
          .join("；");
        // The gate reads the SANITIZED projection (T2.5), but neutralize
        // edits the RAW text — on a zero-width-broken token the raw parse
        // sees no live trigger, neutralize no-ops, and the commit's own
        // sanitize then reassembles the very token the judge just blocked,
        // so it dispatched anyway (review 2026-07-31). When the raw
        // neutralize didn't take, neutralize the sanitized projection and
        // commit THAT — the commit path re-sanitizes idempotently.
        let neutralized = neutralizeBanzhuanTrigger(candidate);
        const projected = sanitizeActorText(
          stripStrayOpenTags(neutralized, "speech"),
          { role: "speech" },
        );
        if (parseHertaBlock(projected).hasBanzhuanTrigger) {
          neutralized = neutralizeBanzhuanTrigger(projected);
        }
        return {
          text: neutralized,
          ...(triggerReasons.length > 0 ? { reason: triggerReasons } : {}),
        };
      }
      return { text: candidate };
    } catch (err) {
      if (signal.aborted) throw err;
      const errorMsg = err instanceof Error ? err.message : String(err);
      deps.onPrompt?.(
        "supervisor-retry-out",
        formatSupervisorOutDump({
          prompt: recheckPrompt,
          reasoning: "",
          rawOutput: `[trigger re-pass failed: ${errorMsg}]`,
        }),
      );
      return { text: candidate };
    }
  });
}

/**
 * Missing-dispatch judge (ADR 0036) — the trigger gate's mirror. A speech the
 * supervisor PASSED can still PROMISE the 开拓者 present 板砖 work while
 * dispatching nothing ("先去翻你代码……一会儿一起看结果" — the persona E2E's
 * fabrication cascade began exactly there: the user came back to collect on
 * the promise, and the smoothest exit was an invented receipt). §8 step 3
 * covers the shape but sits buried in the long prompt (~1/3 on this class,
 * the same reliability gap the trigger recheck was built for). The caller
 * gates it tightly (supervisor passed, the sanitized projection MENTIONS 板砖,
 * no live trigger); a BLOCK is returned as a verdict for the caller to fold
 * into the supervisor veto so the rethink-respeak machinery resolves it — she
 * really dispatches or drops the promise; the harness never injects an `@`
 * itself. Fail-soft: an unavailable judge must not block the commit (returns
 * null). Interrupt: escapes as the thrown error, exactly like the trigger
 * judge — the caller owns the controller teardown and the record-carrying
 * abort (since 2026-09-03 the judge runs alongside the supervisor, and the
 * supervisor's own interrupt path already tears the controller down).
 */
async function runMissingDispatchJudge(opts: {
  deps: ActorTurnDeps;
  supervisorProvider: ProviderAdapter;
  signal: AbortSignal;
  record: TerminalRecord;
  candidate: string;
  thought: string | undefined;
}): Promise<SupervisorVerdict | null> {
  const { deps, signal } = opts;
  let mdPrompt = "";
  return withJudgmentWindow(deps.bus, signal, async (judgeSignal) => {
    try {
      const md = await judgeMissingDispatch({
        provider: opts.supervisorProvider,
        recentRecord: lastNTurnsForSupervisor(opts.record, 8),
        ...(opts.thought !== undefined
          ? { currentTurnThought: opts.thought }
          : {}),
        candidateSpeech: opts.candidate,
        lang: deps.lang ?? "zh",
        signal: judgeSignal,
        onPromptBuilt: (p) => {
          mdPrompt = p;
          // Shares the re-pass's dump channel (same rationale as the trigger
          // judge): the prompt names itself in its first line, so a trace
          // reader tells the judges apart by content.
          deps.onPrompt?.("supervisor-retry", p);
        },
      });
      deps.onPrompt?.(
        "supervisor-retry-out",
        formatSupervisorOutDump({
          prompt: md.prompt,
          reasoning: md.reasoning,
          rawOutput: md.rawOutput,
        }),
      );
      if (md.verdict === "block" && md.blockFindings.length > 0) {
        return {
          verdict: "block",
          ...(md.reason !== undefined ? { reason: md.reason } : {}),
          blockFindings: md.blockFindings,
        };
      }
      return null;
    } catch (err) {
      if (signal.aborted) throw err;
      const errorMsg = err instanceof Error ? err.message : String(err);
      deps.onPrompt?.(
        "supervisor-retry-out",
        formatSupervisorOutDump({
          prompt: mdPrompt,
          reasoning: "",
          rawOutput: `[missing-dispatch judge failed: ${errorMsg}]`,
        }),
      );
      return null;
    }
  });
}

type FirstPassJudge =
  | {
      kind: "trigger";
      settled: Promise<Settled<{ text: string; reason?: string }>>;
    }
  | { kind: "missing"; settled: Promise<Settled<SupervisorVerdict | null>> };

/**
 * Start the ONE judge a first-pass candidate earns, without waiting for it
 * (2026-09-03). Which judge is decided from the candidate's text alone — a
 * live `@板砖` (wouldDispatch) gets the trigger judge, a triggerless 板砖
 * mention the missing-dispatch judge (ADR 0036), ordinary conversation
 * nothing — so nothing about the choice depends on the supervisor's verdict,
 * and the judge's ~2s no longer sits on the critical path AFTER the ~10s
 * verdict. The caller reads the outcome once the verdict is in and drops it
 * on a veto (the candidate is being rewritten; the re-speak gets its own
 * pass in recoverFromVeto) — one wasted flash call per veto, in exchange for
 * a shorter wait on every dispatch. Gates unchanged from the sequential form:
 * the missing-dispatch judge reads the SANITIZED projection and ignores the
 * budget (a written `@` over budget is not a missing one).
 */
export function startFirstPassJudge(opts: {
  deps: ActorTurnDeps;
  supervisorProvider: ProviderAdapter;
  signal: AbortSignal;
  record: TerminalRecord;
  candidate: string;
  thought: string | undefined;
  dispatchCount: number;
}): FirstPassJudge | undefined {
  const { dispatchCount, ...judgeOpts } = opts;
  if (wouldDispatch(opts.candidate, dispatchCount)) {
    return {
      kind: "trigger",
      settled: settle(judgeTriggerAndNeutralize(judgeOpts)),
    };
  }
  const projected = sanitizeActorText(
    stripStrayOpenTags(opts.candidate, "speech"),
    { role: "speech" },
  );
  if (
    !parseHertaBlock(projected).hasBanzhuanTrigger &&
    projected.includes("板砖")
  ) {
    return {
      kind: "missing",
      settled: settle(runMissingDispatchJudge(judgeOpts)),
    };
  }
  return undefined;
}

/** Would this candidate's `@板砖` actually fire? Backticked tokens cannot,
 *  and one past the per-turn budget is neutralized at commit regardless —
 *  neither earns a judge round-trip. Reads the SANITIZED projection the
 *  commit path parses (audit 2026-07-13 T2.5), so the gate and the commit
 *  never disagree about which token is live. */
export function wouldDispatch(
  candidate: string,
  dispatchCount: number,
): boolean {
  return (
    dispatchCount < MAX_DISPATCHES_PER_TURN &&
    parseHertaBlock(
      sanitizeActorText(stripStrayOpenTags(candidate, "speech"), {
        role: "speech",
      }),
    ).hasBanzhuanTrigger
  );
}
