/**
 * The 板砖 bridge (D6/D7): drains the backend's events off the shared bus
 * as `runBrief` produces them, projects each into the TerminalRecord
 * (`backend-record-projection.ts`), fires in-turn beats between them, and
 * closes the run with a done-marker. The user-message replay it hands the
 * backend is `backend-user-history.ts`. Since 2026-09-11 this file is the
 * bridge alone — the projection and the replay were pure functions sharing
 * its 1 800 lines.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentError,
  AgentEvent,
  AgentExecutionReport,
  CodingAgentRuntime,
  EventBus,
  EvidenceSection,
  RunCommandData,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import { errorMessage } from "@herta/core";
import {
  buildBridgeFailureMarker,
  buildDoneMarker,
  buildNoopMarker,
  buildTodoLayoutBlock,
  buildTodoProgressBlock,
  projectBackendEvent,
  sanitizeSystemBlock,
  todoProgressSignature,
} from "./backend-record-projection.js";
import {
  extractRecentDialogue,
  extractWorkingHistory,
  findLastDispatchBoundary,
} from "./backend-record-slices.js";
import { extractUserMessages } from "./backend-user-history.js";
import type { BeatPolicy, TriggerSpec } from "./beat-policy.js";
import { detectGitOutcome } from "./git-outcome.js";
import type { PromptLang } from "./prompt-lang.js";
import type { ActorStreamingSink } from "./streaming-sink.js";

export type BeatFirer = (
  record: TerminalRecord,
  trigger: TriggerSpec,
  signal: AbortSignal,
) => Promise<TerminalRecordBlock | null>;

export interface BanzhuanBridgeDeps {
  /** Shared event bus the backend's `CodingAgentRuntime` publishes onto. */
  readonly bus: EventBus<AgentEvent>;
  /** Factory that constructs a fresh `CodingAgentRuntime` per invocation
   *  (the actor doesn't share runtime state across calls per ADR 0007). */
  readonly runtimeFactory: () => CodingAgentRuntime;
  /** The session's interaction language (ADR 0016). Passed through to the
   *  backend so an EN session drives the backend prompt in English; absent
   *  → the backend defaults to Chinese (byte-identical to before). */
  readonly lang?: PromptLang;
  readonly signal?: AbortSignal;
  /** Optional beat policy. If both `beatPolicy` and `fireBeat` are
   *  provided, the bridge fires in-turn beats between projected events. */
  readonly beatPolicy?: BeatPolicy;
  readonly fireBeat?: BeatFirer;
  /**
   * Optional streaming sink (Slice 9). When provided, the bridge calls
   * `sink.flushBlocks(current)` after each projected system block and
   * after each fired beat block. This lets the renderer surface system
   * blocks and beats in time-order during the post-hoc event walk,
   * rather than the caller flushing them all at end-of-turn.
   */
  readonly sink?: ActorStreamingSink;
}

/**
 * Invoke the coding-agent backend in response to Herta's `@板砖` trigger.
 *
 * Concurrency model (post-hotfix-2): event projection and beat firing
 * run on a CONCURRENT drain task that processes events as they arrive
 * on the bus, NOT after `runBrief` completes. This gives real-time UX:
 * each `→ 差分协处理器 ...` system block surfaces the moment its event
 * fires, and beats interleave with their triggering events instead of
 * bunching at the end.
 *
 * The drain task and `runBrief` run in the same single-threaded JS
 * event loop. `runBrief` does I/O (LLM calls, file reads) — between
 * its awaits, control yields to the event loop and the drain task
 * picks up any queued events. The drain task awaits `fireBeat` (an
 * async streamCompletion call) — while it does, `runBrief` may
 * continue queueing more events. Because both operate on a shared
 * `current: TerminalRecord` via `let`-reassignment (not array mutation),
 * the final value reflects all appends in chronological order.
 *
 * Filters the input record to user-only messages for the backend's
 * `userMessages` parameter (matches the existing `run_coding_task`
 * contract; SPEC §7.2 full TerminalRecord pass-through is deferred).
 *
 * SPEC v0.2 §5.6, §7.
 */
export async function invokeBanzhuanBridge(
  record: TerminalRecord,
  /** Reserved — for future extension (e.g. surfacing prior backend reports
   *  as task context). Pass `[]` for the MVP path. */
  _priorReports: readonly unknown[],
  deps: BanzhuanBridgeDeps,
): Promise<TerminalRecord> {
  // Defense-in-depth double-run guard (audit L1, 2026-07-09): nothing
  // STRUCTURAL prevents two bridge runs sharing one bus — the runtime's
  // `briefInFlight` is per-instance while `runtimeFactory()` mints a fresh
  // instance per dispatch, so the only real protections are the session
  // single-turn invariant and the one-bridge-per-turn cap. Both live in
  // CALLERS; a future entry point that bypasses them (the D2/D3 session
  // paths were retrofitted with exactly that guard for this reason) would
  // interleave two drains' projections and cross-fire their beats. Latch
  // per bus and fail loud — an interleaved record is a corruption, not a
  // degradation, so this must never be converged like an ordinary failure.
  if (BUS_IN_FLIGHT.has(deps.bus)) {
    throw new Error(
      "invokeBanzhuanBridge: a backend run is already draining this bus " +
        "(single-turn invariant violated — refusing to interleave two runs)",
    );
  }
  BUS_IN_FLIGHT.add(deps.bus);
  try {
    return await invokeBanzhuanBridgeInner(record, deps);
  } finally {
    BUS_IN_FLIGHT.delete(deps.bus);
  }
}

/** Buses with a bridge run currently draining them. WeakSet: a bus that
 *  outlives its session is not pinned by the guard. */
const BUS_IN_FLIGHT = new WeakSet<EventBus<AgentEvent>>();

async function invokeBanzhuanBridgeInner(
  record: TerminalRecord,
  deps: BanzhuanBridgeDeps,
): Promise<TerminalRecord> {
  const eventQueue: AgentEvent[] = [];
  let processedIdx = 0;
  let runBriefDone = false;
  let current: TerminalRecord = record;
  // Tracks whether the drain projected ANY backend work block (a `→ 系统` /
  // `→ 差分协处理器` block). Used to pick the terminal block: a true no-op
  // delegation (no projected work) gets the 无产出 marker; real work gets the
  // 完成/受阻/失败/部分完成 done-marker. Beats don't count — a no-op backend
  // fires none (beats trigger on patch.preview / verification.finished / tool
  // failures, none of which occur in a no-op), but using a dedicated flag
  // makes the no-op test unambiguous regardless.
  let projectedAny = false;
  // Remember the most-recent run_command output so the done-marker roll-up
  // can include it (the report's evidence[] only has short summaries). Both
  // lanes are captured together — the canonical string and its structured
  // mirror must describe the same command, or the localized detail pane would
  // quote a different run than Herta's prompt does.
  let lastCommandTail: string | undefined;
  let lastCommandEvidence: readonly EvidenceSection[] | undefined;
  // Git outcome identity (ADR 0049 §4): the LAST successful commit/push seen
  // this dispatch, harvested from finished command results as they project.
  let gitCommit: string | undefined;
  let gitPushedRef: string | undefined;
  // First-todo-layout latch + progress-row dedup + background-row state (all
  // reset per backend turn.started): see the PROCESS-phase comments at their
  // use sites.
  let todoLayoutProjected = false;
  let lastTodoSignature: string | null = null;
  const bgLastState = new Map<string, string>();

  const unsubscribe = deps.bus.onAny((event: AgentEvent) => {
    eventQueue.push(event);
  });

  const signal = deps.signal ?? new AbortController().signal;
  const policy = deps.beatPolicy;
  const fire = deps.fireBeat;
  const beatsEnabled = policy !== undefined && fire !== undefined;

  /**
   * Drains queued events: projects each to a SystemBlock (live flush),
   * fires beats per the BeatPolicy. Runs concurrently with `runBrief`;
   * exits once `runBriefDone === true`, the queue is empty, and no beats
   * are still held for firing.
   *
   * Beat deferral across the permission prompt (spec §"Fix 1"):
   *
   *   For a mutating tool the backend emits, in order, `patch.preview` →
   *   `permission.requested` → (BLOCKS on the resolver's `[y/a/N]`) →
   *   `permission.resolved` → `tool.call.started` ("Writing"). A
   *   `patch.preview` fires a beat, and `fire` is a multi-second streaming
   *   `provider.streamCompletion` call that writes Herta tokens straight to
   *   stdout. If that beat streamed inline it would race the resolver's
   *   prompt + keystroke read, scrambling the user's typed answer.
   *
   *   So beats are deferred: a trigger seen during PROCESS is collected into
   *   `staged` (classification + dedup only — `policy.shouldStage`), promoted
   *   to `ready` at cycle end, and only PRIOR-cycle `ready` beats fire — at
   *   the TOP of a later cycle (before that cycle's new events project),
   *   gated on no permission prompt being pending AND on the beat throttle
   *   (`policy.readyToFire()`, measured against the last actual fire). The
   *   gate checks both the already-processed `permissionPending` flag AND any
   *   `permission.requested` still sitting unprocessed in the queue: because
   *   `patch.preview` is published one tick before `permission.requested`, a
   *   flag-only guard would lose the race (the trailing request not yet
   *   processed when the held beat is considered). With the queue peek, a
   *   queued-but-unprocessed request still holds the beat; it fires only once
   *   `permission.resolved` has cleared the flag and no further request is
   *   pending — i.e. after the resulting "Writing" block.
   *
   * Yield primitive: between cycles the drain awaits `setTimeout(0)` (timers
   * phase), NOT `setImmediate` (check phase). In production this choice is not
   * a correctness dependency: `patch.preview` and `permission.requested` arrive
   * in the same synchronous burst (the edit-file/write-new-file rule publishes
   * the preview inside the awaited permission evaluate, then the turn loop
   * synchronously emits the request before its real `await decision.decision`),
   * so no macrotask yield can interleave between them and the queue-peek gate is
   * race-proof regardless of yield primitive. The `setTimeout(0)` choice matters
   * for the TEST harness, whose publishes are `await tick()`-separated (one
   * setTimeout apart): `setImmediate` consistently preempts a due `setTimeout(0)`
   * on a warm loop, so a `setImmediate` yield would lap the backend and re-enter
   * to fire a held beat before the trailing `permission.requested` was published.
   * Yielding on the timers phase keeps the drain in step with those publishes so
   * the queue peek can observe the pending request. This polling is cheap
   * (cooperative, not busy-loop) and runs at most once per loop turn when idle.
   */
  let permissionPending = false;
  let ready: TriggerSpec[] = [];
  let staged: TriggerSpec[] = [];
  // Tool calls the permission rules REFUSED outright (`permission.resolved`
  // with decision "blocked" — no prompt, `id` is the call id). Their
  // `tool.call.finished` failure is a harness refusal, not 板砖 crashing,
  // and must not earn the failure beat (owner 2026-09-03: an `ls -la`
  // touching `.herta` drew "炸得还挺有板砖风范" for a read the guard withheld).
  const blockedCallIds = new Set<string>();
  // Set on the runBrief-threw path BEFORE the final drain settle: the run is
  // dead, so events still queued must project (screen truth) but must not
  // stage or fire beats — a beat streaming over a failed run's teardown is
  // exactly the "held beat over whatever renders next" hazard, just inside
  // the bridge instead of after it.
  let beatsSuppressed = false;

  // A permission prompt is "pending" if we've processed a `permission.requested`
  // without its `permission.resolved` yet, OR a `permission.requested` is still
  // queued ahead of us (published a tick after its `patch.preview`, not yet
  // processed). Either way, no beat should stream while the resolver waits.
  // The queue scan is bounded and cheap: it starts at `processedIdx` (not 0),
  // the queue holds at most one turn's events, and in the common held-beat state
  // the queue is already fully drained so the scan iterates over nothing.
  const permissionPromptPending = (): boolean => {
    if (permissionPending) return true;
    for (let i = processedIdx; i < eventQueue.length; i += 1) {
      const e = eventQueue[i];
      if (e?.layer === "backend" && e.type === "permission.requested") {
        return true;
      }
    }
    return false;
  };

  const drainTask = (async (): Promise<void> => {
    while (
      !runBriefDone ||
      processedIdx < eventQueue.length ||
      ready.length > 0
    ) {
      // PHASE 1 — FIRE prior-cycle `ready` beats, before this cycle's new
      // events project, so each beat lands immediately after its own
      // triggering system block and before the next one. FIRE is intentionally
      // placed before PROCESS (not the other way round); flipping them would
      // break beat/block interleave ordering — a held beat would land before
      // its triggering system block, scrambling the [system, herta, system,
      // herta] sequence. Gated on no permission prompt pending (flag OR
      // queued-but-unprocessed request). While `fire` awaits its
      // streamCompletion more events may queue; they are picked up by PHASE 2
      // below and the next cycle.
      if (beatsEnabled && !beatsSuppressed) {
        // `readyToFire()` gates each fire attempt (M3, 2026-07-04): the
        // throttle window is measured against the previous ACTUAL fire,
        // here at the fire site — not at event arrival in PROCESS. A
        // trigger inside the window stays in `ready` and this cycle's
        // fire loop exits; PHASE 4 keeps the drain cycling while beats
        // are held, so it fires once the window opens (or is dropped by
        // the termination guard if the run ends first).
        while (
          ready.length > 0 &&
          !permissionPromptPending() &&
          policy.readyToFire()
        ) {
          const trigger = ready.shift();
          if (trigger === undefined) break;
          let beat: Awaited<ReturnType<typeof fire>> = null;
          try {
            beat = await fire(current, trigger, signal);
          } catch {
            // A failed beat (provider error, interrupt mid-beat) is DROPPED,
            // never fatal. Pre-fix this rejection escaped through drainTask —
            // whose first handler attaches only after runBrief settles — and
            // killed the process as an unhandled rejection, or (when runBrief
            // won the race) threw away a SUCCESSFUL backend run's turn.
            beat = null;
            if (signal.aborted) {
              // The turn is dead — no further beats can meaningfully fire.
              ready = [];
              break;
            }
          }
          if (beat !== null) {
            current = [...current, beat];
            deps.sink?.flushBlocks(current);
            policy.markFired(trigger.signature, policy.now());
          }
        }
      }

      // PHASE 2 — PROCESS: project blocks inline, track permission state,
      // and stage (do not fire) any beat triggers.
      while (processedIdx < eventQueue.length) {
        const event = eventQueue[processedIdx];
        processedIdx += 1;
        if (event === undefined) continue;

        if (event.type === "turn.started" && event.layer === "backend") {
          if (beatsEnabled) {
            policy.reset();
            ready = [];
            staged = [];
            blockedCallIds.clear();
          }
          todoLayoutProjected = false;
          lastTodoSignature = null;
          bgLastState.clear();
        }

        if (event.layer === "backend") {
          if (event.type === "permission.requested") permissionPending = true;
          else if (event.type === "permission.resolved") {
            permissionPending = false;
            if (event.decision === "blocked") blockedCallIds.add(event.id);
          }
        }

        // Todo projection (ADR 0025 §2 rendering + 2026-07-23 progress rows):
        // the FIRST todo_write of the dispatch projects as ONE full layout
        // block so user and Herta share the plan; every LATER update projects
        // as a compact "todo k/n: <current>" progress row so the record (and
        // the GUI's live activity line) show which step 板砖 is on. A rewrite
        // that moves neither the counts nor the in-flight item is
        // suppressed — projecting every near-identical list would spam the
        // record (see todoProgressSignature for what that costs). The
        // unfinished tail still rides the done-marker (↳ 待办).
        if (
          event.type === "plan.updated" &&
          event.layer === "backend" &&
          event.todos.length > 0
        ) {
          const signature = todoProgressSignature(event.todos);
          if (!todoLayoutProjected) {
            todoLayoutProjected = true;
            lastTodoSignature = signature;
            const todoBlock = sanitizeSystemBlock(
              buildTodoLayoutBlock(event.todos),
            );
            projectedAny = true;
            current = [...current, todoBlock];
            deps.sink?.flushBlocks(current);
          } else if (signature !== lastTodoSignature) {
            lastTodoSignature = signature;
            const progressBlock = sanitizeSystemBlock(
              buildTodoProgressBlock(event.todos),
            );
            projectedAny = true;
            current = [...current, progressBlock];
            deps.sink?.flushBlocks(current);
          }
        }

        // Git outcome identity (ADR 0049 §4): harvest commit/push from every
        // finished command result — same tool set as the result-row
        // projection below, data-shape-checked, exit 0 required inside the
        // detector. Last commit / last push win (bounded on purpose).
        if (
          event.type === "tool.call.finished" &&
          event.layer === "backend" &&
          event.result.ok &&
          (event.tool === "run_command" ||
            event.tool === "bash" ||
            event.tool === "command_output" ||
            event.tool === "command_stop")
        ) {
          const d = event.result.data as Partial<RunCommandData> | undefined;
          if (
            d !== undefined &&
            Array.isArray(d.argv) &&
            typeof d.stdout === "string" &&
            typeof d.stderr === "string"
          ) {
            const g = detectGitOutcome({
              argv: d.argv,
              exitCode: d.exitCode ?? null,
              stdout: d.stdout,
              stderr: d.stderr,
            });
            if (g.commit !== undefined) gitCommit = g.commit;
            if (g.pushedRef !== undefined) gitPushedRef = g.pushedRef;
          }
        }

        let projected = projectBackendEvent(event);
        // Consecutive-state suppression for background rows: command_output
        // polls with no new output would otherwise stack identical
        // "background bg-1: running" lines. Rows carrying evidenceDetail
        // (fresh output for Herta's prompt) always project; state CHANGES
        // (running→exited/stopped) always project.
        if (projected !== null && projected.digest?.kind === "bg") {
          const d = projected.digest;
          if (
            d.state === "running" &&
            bgLastState.get(d.id) === "running" &&
            projected.evidenceDetail === undefined
          ) {
            projected = null;
          } else {
            bgLastState.set(d.id, d.state);
          }
        }
        if (projected !== null) {
          projectedAny = true;
          current = [...current, projected];
          if (
            projected.label === "差分协处理器" &&
            projected.evidenceDetail !== undefined
          ) {
            lastCommandTail = projected.evidenceDetail;
            lastCommandEvidence = projected.evidence;
          }
          deps.sink?.flushBlocks(current);
        }

        if (beatsEnabled && !beatsSuppressed) {
          const refused =
            event.type === "tool.call.finished" &&
            event.layer === "backend" &&
            blockedCallIds.has(event.id);
          const trigger = refused ? null : policy.shouldStage(event);
          if (
            trigger !== null &&
            !staged.some((t) => t.signature === trigger.signature) &&
            !ready.some((t) => t.signature === trigger.signature)
          ) {
            staged.push(trigger);
          }
        }
      }

      // PHASE 3 — PROMOTE staged → ready (eligible to fire next cycle).
      if (staged.length > 0) {
        ready.push(...staged);
        staged = [];
      }

      // Termination guard: once the backend has exited and the queue is fully
      // drained, no further events will arrive to clear a pending-permission
      // gate. If beats are still held behind it (the turn was aborted or the
      // resolver rejected mid-prompt, so permission.resolved never came),
      // they can never fire — and looping would spin forever on setTimeout(0)
      // (and `await drainTask` is skipped when runBrief throws, orphaning this
      // loop). Drop the stuck beats and exit. Note: on the NORMAL deferral
      // path permissionPending is already false by the time the queue drains
      // (permission.resolved was processed), so this never discards a beat
      // that is legitimately waiting to fire after approval.
      //
      // The same drop applies to THROTTLE-held beats (M3): with the run
      // finished, waiting out the window would delay the whole turn — the
      // done-marker and Herta's synthesis speech — by up to minInterBurstMs
      // for the sake of a flavor line whose content her synthesis is about
      // to cover anyway. Beats are in-turn reactions; once the run is over
      // their moment has passed. Dropping (not waiting) also guarantees
      // termination under pinned test clocks, where the window would never
      // elapse.
      if (
        runBriefDone &&
        processedIdx >= eventQueue.length &&
        ready.length > 0 &&
        (permissionPending || (beatsEnabled && !policy.readyToFire()))
      ) {
        ready = [];
        break;
      }

      // PHASE 4 — YIELD if there's more to do (more backend events coming,
      // queued events to process, or held beats waiting to fire). See the
      // doc comment above on why this is `setTimeout(0)`, not `setImmediate`.
      if (!runBriefDone || ready.length > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    }
  })();

  // Defensive: mark the drain handled so an unexpected drain rejection while
  // runBrief is still pending can never crash the process as an unhandled
  // rejection. The real outcome still surfaces at `await drainTask` below.
  drainTask.catch(() => undefined);

  let report: AgentExecutionReport | undefined;
  try {
    const extracted = extractUserMessages(record, deps.lang);
    const boundary = findLastDispatchBoundary(record);
    const recentDialogue = extractRecentDialogue(record, boundary);
    const workingHistory = extractWorkingHistory(record, boundary);
    const runtime = deps.runtimeFactory();
    const taskId = `task-${randomUUID()}`;
    report = await runtime.runBrief(
      { taskId },
      {
        signal,
        userMessages: extracted.messages,
        omittedUserMessages: extracted.omitted,
        recentDialogue,
        workingHistory,
        lang: deps.lang,
      },
    );
  } catch (err) {
    // runBrief threw — an INFRA failure (workspace mkdir, the double-brief
    // guard, an internal bug), NOT an ordinary tool/provider failure: those
    // are converted to `turn.failed` inside the turn loop and runBrief
    // returns a `failed` report. Pre-fix this path rethrew without returning
    // `current`, so every block the drain had already rendered via the sink
    // existed on screen but in neither the caller's record nor disk (D7
    // divergence), and the GUI activity group froze with no terminal state.
    //
    // Converge instead of diverging: suppress beats, settle the drain (so
    // remaining queued events still project — screen truth — and the loop
    // can never fire a held beat over whatever renders next), append the
    // same failure marker shape an ordinary failed run gets, and RETURN the
    // record. Herta's next iteration reacts to the 失败 marker exactly like
    // any other failed dispatch; a turn.failed bus event gives the GUI its
    // device-card failed state (parity with in-loop failures, which emit it
    // from the turn loop itself).
    beatsSuppressed = true;
    ready = [];
    staged = [];
    runBriefDone = true;
    await drainTask.catch(() => undefined);
    // Unsubscribe BEFORE publishing turn.failed so the settled queue never
    // receives it (idempotent — the finally below re-runs it harmlessly).
    unsubscribe();
    const error: AgentError =
      typeof (err as AgentError)?.kind === "string" &&
      typeof (err as AgentError)?.message === "string"
        ? (err as AgentError)
        : {
            kind: "internal",
            message: errorMessage(err),
          };
    deps.bus.publish({ type: "turn.failed", layer: "backend", error });
    const marker = sanitizeSystemBlock(buildBridgeFailureMarker(err));
    current = [...current, marker];
    deps.sink?.flushBlocks(current);
    return current;
  } finally {
    runBriefDone = true;
    unsubscribe();
  }

  // Wait for the drain to finish processing any final queued events.
  await drainTask;

  // Append a terminal block so the next iteration's prompt has a concrete
  // signal to react to (the bridge previously discarded the report). When the
  // backend produced work blocks, emit the 完成/受阻/失败/部分完成 done-marker.
  // When it produced nothing (a true no-op delegation), emit the 无产出 marker
  // instead — a single trailing block that preserves the 2026-05-23
  // duplicate-speech fix (compact-record.ts keys on body.startsWith("无产出")).
  // If `runBrief` threw, the catch above already appended the failure marker
  // and returned; `report` is always defined here — the guard is defensive.
  if (report !== undefined) {
    // Publish the VERDICT as an explicit event (audit 2026-07-24, 1.1). The
    // `agent.report` variant was declared but never emitted, so every
    // consumer had to re-derive "did it go well" from lifecycle events —
    // and `turn.finished` only means the loop ended without throwing, which
    // is equally true of a user-denied (blocked) or all-failed (partial)
    // run. That is how denying a write still flashed the device card green.
    deps.bus.publish({ type: "agent.report", layer: "backend", report });
    // sanitizeSystemBlock: the done-marker roll-up interpolates report
    // strings (changed-file paths, residual risks) — backend-derived text,
    // same trust class as projected bodies.
    // The terminal block is chosen by the REPORT'S VERDICT, not by whether
    // anything happened to project (audit 2026-07-24, 1.5). `projectedAny` is
    // a side-effect of the projection rules, and several endings leave it
    // false for reasons that are emphatically NOT "nothing was asked": a
    // user interrupt during the first inference; a run whose only action was
    // a permission-denied non-preview command (permission events deliberately
    // project null); a provider failure before the first tool call. Those all
    // rendered 无产出 — "板砖 didn't do anything" — right after the user
    // pressed Stop or denied the command. Worse, it was self-erasing:
    // compaction digests it to （板砖无产出）and workingHistory drops
    // noop-markers entirely, so the next dispatch carried no trace.
    //
    // 无产出 now requires the run to have ended NORMALLY and produced
    // nothing. "Normally" is the complement of the three endings that carry
    // their own explanation — interrupted / blocked / failed. (A genuine
    // no-op reports `partial`, not `completed`: with no tool evidence there
    // is nothing to claim success from — which is exactly why the status
    // must be tested for the ABSENCE of a stated ending rather than for
    // success.)
    const endedNormally =
      report.status === "completed" || report.status === "partial";
    const trulyNoop =
      endedNormally &&
      !projectedAny &&
      report.changedFiles.length === 0 &&
      report.tests.length === 0;
    const marker = sanitizeSystemBlock(
      trulyNoop
        ? buildNoopMarker()
        : buildDoneMarker(report, lastCommandTail, lastCommandEvidence, {
            ...(gitCommit !== undefined ? { commit: gitCommit } : {}),
            ...(gitPushedRef !== undefined ? { pushedRef: gitPushedRef } : {}),
          }),
    );
    current = [...current, marker];
    deps.sink?.flushBlocks(current);
  }

  return current;
}
