import type { HertaToAgentBrief } from "../bridge/types.js";
import type { EventBus } from "../event-bus.js";
import type { FindingsLedger } from "../findings-ledger.js";
import type { MemoryManager } from "../memory-manager.js";
import type { PermissionEngine } from "../permission-engine.js";
import type { ReadLedger } from "../read-ledger.js";
import { renderTodoState, type TodoStore } from "../todo-store.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { TranscriptStore } from "../transcript-store.js";
import type { AgentError } from "../types/errors.js";
import type { AgentEvent, TurnSummary } from "../types/events.js";
import type { ProviderAdapter } from "../types/provider.js";
import type {
  ToolCallRequest,
  ToolContext,
  ToolResult,
} from "../types/tool.js";
import type {
  BackendContextBuilder,
  RepoContextSnapshot,
} from "./backend-context-builder.js";
import {
  BackendRetryState,
  classifyBackendInferenceError,
  MAX_TURN_ITERATIONS,
} from "./backend-error-policy.js";
import type { BackgroundHost } from "./background-host.js";
import {
  type BackendPromptBudget,
  DEFAULT_BACKEND_PROMPT_BUDGET,
  estimateFrameBaseTokens,
  fitMessagesToBudget,
} from "./context-budget.js";
import {
  isAbortError,
  type ModelInferenceResult,
  streamModelInference,
} from "./stream-model-inference.js";
import { persistOversizedResult } from "./tool-result-persistence.js";

export interface BackendTurnDeps {
  sessionId: string;
  provider: ProviderAdapter;
  tools: ToolRegistry;
  permissions: PermissionEngine;
  backendBuilder: BackendContextBuilder;
  transcript: TranscriptStore;
  todos: TodoStore;
  bg: BackgroundHost;
  bus: EventBus<AgentEvent>;
  clock: () => Date;
  workspaceRoot: string;
  reads: ReadLedger;
  memory: MemoryManager;
  /** Per-brief conclusions (ADR 0039). Optional so existing callers and
   *  tests keep working; the runtime always supplies one. */
  findings?: FindingsLedger;
  /**
   * Working-set prompt budget (ADR 0025 slice 2). Defaults to
   * DEFAULT_BACKEND_PROMPT_BUDGET; labs/tests override to force the trim
   * ladder deterministically.
   */
  budget?: BackendPromptBudget;
  /**
   * Optional abort-aware sleep used between provider-call retries. Defaults to a
   * real setTimeout that rejects with an AbortError if the signal fires mid-wait
   * (so an interrupt during backoff surfaces as `interrupted`, not a hung turn).
   * Tests inject an instant resolver to skip wall-clock backoff.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function backoffAbortError(): Error {
  const e = new Error("aborted during backoff");
  e.name = "AbortError";
  return e;
}

function defaultBackoffSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(backoffAbortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(backoffAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface BackendTurnHandle {
  signal: AbortSignal;
  /**
   * User-only message history threaded from the actor's transcript. The
   * backend reads this as task context in place of any "brief" framing.
   * Filtered: only role === "user" entries are passed through.
   */
  userMessages: ReadonlyArray<{ text: string }>;
  /** Elided older user messages (ADR 0025 slice 2); defaults to 0. */
  omittedUserMessages?: number;
  /**
   * Optional scoped repo instructions selected by the actor for this dispatch.
   * Threaded into `BackendPromptFrame.scopedRepoInstructions`. Defaults to `""`.
   */
  scopedRepoInstructions?: string;
  /**
   * Optional scoped project memory text selected by the actor for this dispatch.
   * Threaded into `BackendPromptFrame.scopedMemory`. Defaults to `""`.
   */
  scopedMemory?: string;
  /** Pre-rendered recent dialogue since the last dispatch (referent resolution). */
  recentDialogue?: string;
  /** Pre-rendered prior-dispatch working history. */
  workingHistory?: string;
  /** The session's interaction language (ADR 0016). Selects the backend prompt
   *  language in the context builder; absent → "zh". */
  lang?: "zh" | "en";
  /** The repo snapshot taken at brief start (ADR 0049 §2). Threaded into the
   *  frame's repo-snapshot section; absent → section omitted. */
  repoContext?: RepoContextSnapshot;
}

/** What the permission gate answers for one call. */
type GateOutcome =
  | { readonly kind: "run" }
  | { readonly kind: "result"; readonly result: ToolResult };

const PERMISSION_DENIED_SUGGESTION =
  "Choose a read-only inspection path or ask the user.";

/** The model-facing hint for a rule-deny, by code. `invalid_input` surfaces
 *  through the same deny path as real permission denials (rules validate
 *  before tiering) — say so, or the model reads a malformed call as "tool
 *  forbidden" and abandons a perfectly usable tool (user 2026-07-31). */
function denySuggestion(code: string): string | undefined {
  if (code === "permission_denied") return PERMISSION_DENIED_SUGGESTION;
  if (code === "invalid_input")
    return "input validation failed, not a permission denial — fix the input shape and call the tool again";
  return undefined;
}

export async function* runBackendTurnLoop(
  deps: BackendTurnDeps,
  brief: HertaToAgentBrief,
  handle: BackendTurnHandle,
): AsyncGenerator<AgentEvent> {
  const startedAt = deps.clock().getTime();
  let toolCallCount = 0;
  /** Malformed-argument calls contained so far this turn (see the cap). */
  let malformedArgsCount = 0;

  // Distributive Omit so each variant of the union has its `layer` removed
  // independently. Plain `Omit<AgentEvent, "layer">` collapses the union and
  // strips all variant-specific fields under `excess property` checks.
  type WithoutLayer<E> = E extends unknown ? Omit<E, "layer"> : never;
  function* emit(event: WithoutLayer<AgentEvent>): Generator<AgentEvent> {
    const tagged = { ...event, layer: "backend" as const } as AgentEvent;
    deps.bus.publish(tagged);
    yield tagged;
  }

  /**
   * The permission gate for ONE tool call, shared by the serial path and
   * the parallel batch (2026-09-03). Emits the permission events and
   * answers either "run it" or the failed ToolResult that stands in for the
   * run. It was two near-identical ~75-line blocks that had already
   * drifted: the `invalid_input` suggestion (user 2026-07-31 — a model
   * reads a malformed call as "tool forbidden" and abandons a usable tool)
   * landed only in the parallel branch, which holds read-only tools only,
   * and no read-only tool has a permission rule — so the one path that can
   * produce a rule-deny never carried the hint. One gate, one drift.
   *
   * An abort while the resolver is pending propagates (the caller's
   * exactly-one-terminal-event contract); any other resolver failure is a
   * result, not a throw.
   */
  async function* gatePermission(
    call: ToolCallRequest,
    ctx: ToolContext,
  ): AsyncGenerator<AgentEvent, GateOutcome> {
    const decision = await deps.permissions.check(call, ctx);
    if (decision.kind === "deny") {
      const code = decision.code ?? "permission_denied";
      // Deterministic rule-deny: no user prompt fired, but the refusal must
      // still reach the report. Pre-fix nothing emitted a permission event
      // here — `deniedPermissions` stayed 0 and a run whose only mutation
      // was auto-blocked could report `completed` (audit 2026-07-10,
      // finding 6). `decision: "blocked"` is the PermissionEventSummary case
      // documented for exactly this; the event carries the tool since no
      // permission.requested precedes it. Code + refused-risk ride along
      // (2026-08-26) so the status gate can tell a withheld read from a
      // refused mutation.
      yield* emit({
        type: "permission.resolved",
        id: call.id,
        decision: "blocked",
        tool: call.tool,
        code,
        ...(decision.risk !== undefined ? { risk: decision.risk } : {}),
      });
      const suggestion = denySuggestion(code);
      return {
        kind: "result",
        result: {
          ok: false,
          error: { code, message: decision.reason, retryable: false },
          ...(suggestion !== undefined ? { suggestion } : {}),
          summary: code === "permission_denied" ? "denied" : `failed: ${code}`,
          ...(decision.modelText !== undefined
            ? { modelText: decision.modelText }
            : {}),
        },
      };
    }
    if (decision.kind === "ask") {
      yield* emit({
        type: "permission.requested",
        request: decision.request,
      });
      let resolved: "allow" | "deny";
      try {
        resolved = await decision.decision;
      } catch (err) {
        if (isAbortError(err)) throw err;
        return {
          kind: "result",
          result: {
            ok: false,
            error: {
              code: "permission_failed",
              message: err instanceof Error ? err.message : String(err),
              retryable: false,
            },
            summary: "permission resolver failed",
          },
        };
      }
      yield* emit({
        type: "permission.resolved",
        id: decision.request.id,
        decision: resolved,
      });
      if (resolved === "deny") {
        return {
          kind: "result",
          result: {
            ok: false,
            error: {
              code: "permission_denied",
              message: `User denied ${call.tool}`,
              retryable: false,
            },
            suggestion: PERMISSION_DENIED_SUGGESTION,
            summary: "denied",
          },
        };
      }
    }
    return { kind: "run" };
  }

  // turn.started carries the most recent user request as the "userText"
  // observation for downstream subscribers (renderer, narrator). When the
  // user history is empty (defensive — the actor only dispatches on a
  // user turn), fall back to an empty string.
  const lastUserText =
    handle.userMessages.length > 0
      ? (handle.userMessages[handle.userMessages.length - 1]?.text ?? "")
      : "";
  yield* emit({ type: "turn.started", userText: lastUserText });
  // Note: user history is system-level context. We do NOT append it to transcript.

  const sleep = deps.sleep ?? defaultBackoffSleep;
  try {
    // L2 (audit 2026-07-09): everything in the frame EXCEPT `messages` is
    // invariant across the turn's iterations — the execution contract, the
    // dialogue/history sections, the scoped strings, and the tool schemas.
    // Build the base once; each iteration only refreshes the transcript
    // (copied — `transcript.all()` returns the LIVE internal array, and the
    // frame must not grow as the transcript appends mid-inference).
    // Pre-fix `build()` re-serialized the system text and re-mapped every
    // tool schema on each of up to MAX_TURN_ITERATIONS (100) iterations.
    const baseFrame = deps.backendBuilder.build({
      brief,
      userMessages: handle.userMessages,
      omittedUserMessages: handle.omittedUserMessages ?? 0,
      scopedRepoInstructions: handle.scopedRepoInstructions ?? "",
      scopedMemory: handle.scopedMemory ?? "",
      messages: [],
      recentDialogue: handle.recentDialogue,
      workingHistory: handle.workingHistory,
      lang: handle.lang,
      ...(handle.repoContext !== undefined
        ? { repoContext: handle.repoContext }
        : {}),
    });

    let iterations = 0;
    while (true) {
      if (iterations >= MAX_TURN_ITERATIONS) {
        const error: AgentError = {
          kind: "internal",
          message: `backend turn exceeded ${MAX_TURN_ITERATIONS} iterations`,
        };
        yield* emit({ type: "turn.failed", error });
        return;
      }
      iterations += 1;

      // Per-iteration todo reminder (ADR 0025 §2): recomputed each call so
      // the model always sees the list it last wrote; appended by the
      // translate layer AFTER the transcript, so the cache-stable prefix
      // is untouched. Empty list → no section.
      const todoState = renderTodoState(deps.todos.all(), handle.lang ?? "zh");

      // Working-set budget (ADR 0025 slice 2): deterministic two-phase trim
      // of the frame COPY (clear old tool payloads, then drop oldest
      // groups). The durable transcript is untouched — every iteration
      // re-derives the projection. Pre-flight, so a bloated frame is fixed
      // BEFORE a provider call is burned on it.
      const budget = deps.budget ?? DEFAULT_BACKEND_PROMPT_BUDGET;
      const fit = fitMessagesToBudget({
        messages: deps.transcript.all(),
        baseTokens: estimateFrameBaseTokens(baseFrame, todoState),
        budget,
        lang: handle.lang ?? "zh",
      });
      if (fit.overBudget) {
        // Even the minimal tail (marker + last group) exceeds the budget —
        // the base frame itself must be near/over it. Surface honestly
        // instead of letting the provider 400 opaquely.
        const error: AgentError = {
          kind: "internal",
          message: `backend prompt exceeds the ${budget.budgetTokens}-token working-set budget even after trimming (estimated ${fit.estimatedTokens})`,
        };
        yield* emit({ type: "turn.failed", error });
        return;
      }
      const frame = {
        ...baseFrame,
        messages: fit.messages,
        ...(todoState.length > 0 ? { todoState } : {}),
      };

      // Bounded retry around the provider call: classify each failure to a named
      // reason and retry transient ones (one free retry per reason + a hard cap)
      // instead of killing the whole turn on a transient drop. Terminal reasons
      // (4xx / content-filter / missing-key / unknown) surface immediately.
      let inference: ModelInferenceResult | undefined;
      const retry = new BackendRetryState();
      while (inference === undefined) {
        try {
          inference = await streamModelInference({
            provider: deps.provider,
            frame,
            signal: handle.signal,
            bus: deps.bus,
            layer: "backend",
          });
        } catch (err) {
          if (isAbortError(err)) throw err;
          const decision = retry.decide(classifyBackendInferenceError(err));
          if (decision.kind === "surface") {
            const error: AgentError = {
              kind: "provider_failed",
              message: `${err instanceof Error ? err.message : String(err)} (${decision.detail})`,
              cause: err,
            };
            yield* emit({ type: "turn.failed", error });
            return;
          }
          await sleep(decision.backoffMs, handle.signal);
        }
      }

      // Yield deltas through the generator surface (bus already received them).
      for (const delta of inference.deltas) {
        yield delta;
      }

      // A stream that died without a `finish` event or was truncated at the
      // token limit is NOT a clean turn end — `finishReason` was previously
      // computed and ignored, so half-done work sailed through to a
      // `completed` report. Both cases surface as turn.failed with distinct,
      // honest messages (the report then reads 失败, never 完成).
      if (inference.finishReason === "error") {
        const error: AgentError = {
          kind: "provider_failed",
          message: "model stream ended without a finish event",
        };
        yield* emit({ type: "turn.failed", error });
        return;
      }
      if (inference.finishReason === "length") {
        const error: AgentError = {
          kind: "provider_failed",
          message: "model output truncated at the token limit",
        };
        yield* emit({ type: "turn.failed", error });
        return;
      }

      const accText = inference.text;
      const accReasoning = inference.reasoning;
      const accToolCalls = inference.toolCalls;

      const finalMsg = deps.transcript.appendAssistant(
        accText,
        accToolCalls,
        deps.clock(),
        accReasoning,
      );
      yield* emit({ type: "assistant.final", message: finalMsg });

      if (accToolCalls.length === 0) break;

      // Tool branch. Consecutive READ-ONLY calls execute as one concurrent
      // batch (ADR 0025 slice 5 — HertaTool.readOnly is the safety marker);
      // everything else runs as a serial group of one, byte-identical to
      // the pre-slice behavior.
      const toolCtx: ToolContext = {
        sessionId: deps.sessionId,
        signal: handle.signal,
        workspaceRoot: deps.workspaceRoot,
        reads: deps.reads,
        todos: deps.todos,
        bg: deps.bg,
        bus: deps.bus,
        memory: deps.memory,
        ...(deps.findings !== undefined ? { findings: deps.findings } : {}),
      };
      const progressFor =
        (callId: string) =>
        (progress: { id: string; message: string }): void => {
          deps.bus.publish({
            type: "tool.call.progress",
            layer: "backend",
            id: callId,
            message: progress.message,
          });
        };
      // Malformed-argument containment. A call whose `arguments` were not
      // valid JSON has no input to check or run, so it never reaches the
      // permission engine or the tool — it is answered directly with a
      // model-visible result, exactly as an uncaught tool crash is. Handled
      // BEFORE partitioning so a read-only tool with broken args cannot be
      // scheduled into a concurrent batch.
      //
      // Every id still gets a result: the assistant message above already
      // recorded the call, and a tool_call_id with no matching tool message
      // makes the NEXT provider request 400.
      const parseableCalls: ToolCallRequest[] = [];
      for (const call of accToolCalls) {
        if (call.malformedArgs === undefined) {
          parseableCalls.push(call);
          continue;
        }
        toolCallCount += 1;
        malformedArgsCount += 1;
        const result = malformedArgsResult(call.tool, call.malformedArgs);
        yield* emit({
          type: "tool.call.started",
          id: call.id,
          tool: call.tool,
          inputSummary: "(unparseable arguments)",
        });
        yield* emit({
          type: "tool.call.finished",
          id: call.id,
          tool: call.tool,
          result,
        });
        deps.transcript.appendTool(call.id, result, deps.clock());
      }
      if (malformedArgsCount >= MAX_MALFORMED_TOOL_ARGS) {
        // Terminal, but only after the model was told and given a chance —
        // the pre-fix behavior was this failure on the FIRST occurrence.
        const error: AgentError = {
          kind: "provider_failed",
          message: `model produced malformed tool arguments ${malformedArgsCount} times in one turn`,
        };
        yield* emit({ type: "turn.failed", error });
        return;
      }
      // Every call this iteration was malformed: nothing to execute, but the
      // results are in the transcript, so loop back and let the model retry.
      if (parseableCalls.length === 0) continue;

      const groups = partitionToolCalls(
        parseableCalls,
        (name) => deps.tools.get(name)?.readOnly === true,
      );
      for (const group of groups) {
        if (group.parallel) {
          // Three phases keep the machine contract deterministic:
          //   1. permissions SEQUENTIALLY — a rule on a read-only tool is
          //      allow-only today, but ask/deny are handled faithfully,
          //      and two approval prompts can never be live at once;
          //   2. execution CONCURRENTLY — the point of the batch;
          //   3. finished-events + transcript appends in CALL ORDER, so
          //      the record and the transcript stay replay-stable.
          if (handle.signal.aborted) {
            const error: AgentError = {
              kind: "interrupted",
              message: "turn aborted between tool calls",
            };
            yield* emit({ type: "turn.failed", error });
            return;
          }
          const outcomes = new Map<string, ToolResult>();
          const allowed: ToolCallRequest[] = [];
          for (const call of group.calls) {
            toolCallCount += 1;
            const gate = yield* gatePermission(call, toolCtx);
            if (gate.kind === "result") outcomes.set(call.id, gate.result);
            else allowed.push(call);
          }

          for (const call of allowed) {
            yield* emit({
              type: "tool.call.started",
              id: call.id,
              tool: call.tool,
              inputSummary: headerFor(deps, call),
            });
          }
          // An AbortError from any concurrent tool rejects the whole
          // Promise.all → the outer catch classifies it `interrupted`;
          // sibling tools observe the same signal and stop themselves.
          const settled = await Promise.all(
            allowed.map(async (call) => {
              try {
                return await deps.tools.run(
                  call,
                  toolCtx,
                  progressFor(call.id),
                );
              } catch (err) {
                if (isAbortError(err)) throw err;
                return crashedResult(call.tool, err);
              }
            }),
          );
          allowed.forEach((call, i) => {
            const r = settled[i];
            if (r !== undefined) outcomes.set(call.id, r);
          });

          for (const call of group.calls) {
            const result = outcomes.get(call.id);
            if (result === undefined) continue; // defensive; unreachable
            yield* emit({
              type: "tool.call.finished",
              id: call.id,
              tool: call.tool,
              result,
            });
            const { transcriptResult } = persistOversizedResult({
              result,
              workspaceRoot: deps.workspaceRoot,
              taskId: brief.taskId,
              callId: call.id,
            });
            deps.transcript.appendTool(call.id, transcriptResult, deps.clock());
          }
          continue;
        }

        const call = group.calls[0];
        if (call === undefined) continue;
        // An interrupt between queued calls must stop the batch: only
        // run_command observed the signal internally, so an abort landing
        // while call A applied still ran call B's permission check and
        // write — the abort only bit at the NEXT provider call.
        if (handle.signal.aborted) {
          const error: AgentError = {
            kind: "interrupted",
            message: "turn aborted between tool calls",
          };
          yield* emit({ type: "turn.failed", error });
          return;
        }
        toolCallCount += 1;
        const gate = yield* gatePermission(call, toolCtx);
        if (gate.kind === "result") {
          // A refusal (rule or user) or a failed resolver stands in for the
          // run: the same finished event + transcript append a real run gets.
          yield* emit({
            type: "tool.call.finished",
            id: call.id,
            tool: call.tool,
            result: gate.result,
          });
          deps.transcript.appendTool(call.id, gate.result, deps.clock());
          continue;
        }

        yield* emit({
          type: "tool.call.started",
          id: call.id,
          tool: call.tool,
          inputSummary: headerFor(deps, call),
        });

        let result: ToolResult;
        try {
          result = await deps.tools.run(call, toolCtx, progressFor(call.id));
        } catch (err) {
          // An abort mid-tool (run_command's runner, the fs walkers — audit
          // M4) is an interrupt, not a tool failure: rethrow to the outer
          // catch, which classifies it `interrupted`.
          if (isAbortError(err)) throw err;
          // ADR 0025 slice 5: containment. A tool defect becomes a
          // model-visible failure result instead of killing the brief —
          // pre-fix one uncaught throw (an EPERM stat, a driver bug) threw
          // away every prior step's work as turn.failed. The reference's
          // most-repeated robustness lesson: every failure must come back
          // as a result the model can route around.
          result = crashedResult(call.tool, err);
        }
        yield* emit({
          type: "tool.call.finished",
          id: call.id,
          tool: call.tool,
          result,
        });
        // The EVENT above carries the full result (report absorber,
        // renderer, evidence surfaces). What re-enters the model's prompt
        // is bounded: an oversized payload persists to
        // .herta/tool-results/ and the transcript keeps preview + path
        // (ADR 0025 slice 2).
        const { transcriptResult } = persistOversizedResult({
          result,
          workspaceRoot: deps.workspaceRoot,
          taskId: brief.taskId,
          callId: call.id,
        });
        deps.transcript.appendTool(call.id, transcriptResult, deps.clock());

        // Test-result beat producer (2026-07-23, owner-approved): the
        // verification.finished trigger and its beat hint existed since N2
        // but nothing ever emitted the event — 板砖 finishing a test run was
        // always silent. Emitted AFTER the tool.call.finished above, so the
        // "↳ tests:" record block lands before the beat that reacts to it.
        //
        // Both command tools, keyed on the DATA rather than the tool name
        // (2026-08-24, codex study): this read `call.tool === "run_command"`,
        // so when the minimal contract became the default on 2026-08-17 the
        // beat silently stopped firing — `bash` computes `testRun` exactly the
        // same way, and a test run went invisible to Herta on every default
        // session for a week. A tool-name gate on a per-contract tool is the
        // bug; the shape of the result is the honest condition.
        const testRun = (
          result.data as { testRun?: { status?: unknown } } | undefined
        )?.testRun;
        if (
          (call.tool === "run_command" || call.tool === "bash") &&
          result.ok &&
          testRun !== undefined
        ) {
          // `passed` rides along (2026-09-03) so the beat classifier can
          // leave a green run to Herta's synthesis and react only to a red
          // one — the detector's status is "passed" or "failed".
          yield* emit({
            type: "verification.finished",
            result: { passed: testRun.status === "passed" },
          });
        }
      }
    }

    const summary: TurnSummary = {
      durationMs: deps.clock().getTime() - startedAt,
      toolCallCount,
      messageCount: deps.transcript.all().length,
      endedAt: deps.clock().toISOString(),
    };
    yield* emit({ type: "turn.finished", summary });
  } catch (err) {
    if (isAbortError(err)) {
      const error: AgentError = {
        kind: "interrupted",
        message: err instanceof Error ? err.message : "interrupted",
        cause: err,
      };
      yield* emit({ type: "turn.failed", error });
      return;
    }
    const error: AgentError = {
      kind: "internal",
      message: err instanceof Error ? err.message : String(err),
      cause: err,
    };
    yield* emit({ type: "turn.failed", error });
  }
}

/** One group of the model's tool calls (ADR 0025 slice 5): `parallel`
 *  batches hold ≥2 consecutive read-only calls and execute concurrently;
 *  serial groups hold exactly one call and follow the classic path. */
export interface ToolCallBatch {
  readonly parallel: boolean;
  readonly calls: readonly ToolCallRequest[];
}

/**
 * Partition one iteration's tool calls into batches, preserving order:
 * maximal runs of ≥2 consecutive parallel-safe calls become one parallel
 * batch; every other call is its own serial group (a lone safe call
 * gains nothing from the batch machinery, so it stays on the serial
 * path). Pure; exported for tests.
 */
export function partitionToolCalls(
  calls: readonly ToolCallRequest[],
  isParallelSafe: (toolName: string) => boolean,
): ToolCallBatch[] {
  const batches: ToolCallBatch[] = [];
  let run: ToolCallRequest[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) {
      batches.push({ parallel: false, calls: run });
    } else {
      batches.push({ parallel: true, calls: run });
    }
    run = [];
  };
  for (const call of calls) {
    if (isParallelSafe(call.tool)) {
      run.push(call);
    } else {
      flush();
      batches.push({ parallel: false, calls: [call] });
    }
  }
  flush();
  return batches;
}

/**
 * How many malformed-argument calls one turn tolerates before it gives up.
 *
 * Containment must not become a spin: the model is told exactly what broke,
 * so a model that can recover does it on the next iteration, and one that
 * cannot would otherwise burn the full MAX_TURN_ITERATIONS re-emitting the
 * same broken escape. Three is "one slip, one bad correction, stop".
 */
const MAX_MALFORMED_TOOL_ARGS = 3;

/**
 * Containment result for a tool call whose arguments were not valid JSON.
 *
 * Mirrors `crashedResult`: the model sees what it did wrong and keeps the
 * turn. The suggestion names the actual mechanism because the failure is
 * almost always regex backslashes — a model told only "invalid JSON" tends to
 * re-send the same string.
 */
function malformedArgsResult(
  toolName: string,
  malformed: { raw: string; parseError: string },
): ToolResult {
  return {
    ok: false,
    error: {
      code: "malformed_tool_args",
      message: `arguments for ${toolName} were not valid JSON (${malformed.parseError}); received: ${malformed.raw.slice(0, 200)}`,
      retryable: false,
    },
    suggestion:
      "The tool did NOT run — nothing changed. Your arguments were not valid JSON, " +
      "so they could not be read. This is usually a regex: a backslash inside a " +
      'JSON string must be doubled, so `.\\{0,40\\}` has to be written "\\\\{0,40\\\\}", ' +
      "and \\d \\w \\s \\+ \\( are invalid JSON escapes for the same reason. " +
      "Re-issue the call with the backslashes escaped, or use a pattern that needs none.",
    summary: `failed: malformed arguments for ${toolName}`,
  };
}

/** Containment result for an uncaught tool throw (ADR 0025 slice 5). */
function crashedResult(toolName: string, err: unknown): ToolResult {
  return {
    ok: false,
    error: {
      code: "tool_crashed",
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    },
    suggestion:
      "The tool itself crashed on this input — do not repeat the identical call; try a different approach or report the failure honestly.",
    summary: `crashed: ${toolName}`,
  };
}

const SUMMARY_CAP = 80;

/**
 * Build the human-facing ARGUMENT portion of a backend working-state line
 * (the verb — Reading / Writing / Running / … — is applied downstream by
 * `workflowLabel` in backend-bridge.ts). Tool-aware so the `→ 差分协处理器`
 * block reads e.g. "Writing scripts/merge_sort.py" instead of dumping the
 * raw, truncated tool-call JSON (which for write_new_file/edit_file includes
 * the entire file content / hunks). Falls back to JSON truncation for unknown
 * tools or unexpected input shapes so nothing ever throws and every tool
 * renders *something*.
 */
/**
 * The record header for a call: the tool's own `summarize` hook when it has
 * one (bash knows its shell's spelling of the workspace — the loop cannot
 * derive `/tmp/…` from a native %TEMP% path), else the generic
 * `summarizeInput`. Same single-line cap either way; a hook that throws or
 * returns nothing is simply not consulted for that call.
 */
function headerFor(deps: BackendTurnDeps, call: ToolCallRequest): string {
  const tool = deps.tools.get(call.tool);
  if (tool?.summarize !== undefined) {
    try {
      const own = tool.summarize(call.input, {
        workspaceRoot: deps.workspaceRoot,
      });
      if (typeof own === "string" && own.length > 0) return capHeader(own);
    } catch {
      // fall through to the generic form
    }
  }
  return summarizeInput(call.tool, call.input, {
    workspaceRoot: deps.workspaceRoot,
  });
}

// Single-line invariant (slice 6): the summary becomes the one-line
// working-state header (`Writing <arg>` in the GUI activity row and the
// → 差分协处理器 body line). A newline smuggled through an argv/path/
// pattern would break that header into extra lines — normalize to spaces
// before the length cap. Marker/control sanitization happens at the
// projection choke point (backend-bridge's sanitizeSystemBlock).
function capHeader(s: string): string {
  const oneLine = s.replace(/\s*[\r\n]+\s*/g, " ");
  return oneLine.length > SUMMARY_CAP
    ? `${oneLine.slice(0, SUMMARY_CAP - 1)}…`
    : oneLine;
}

/**
 * The header form of a shell command (ADR 0040): leading `cd`/`pushd`
 * segments that go to the WORKSPACE ROOT dropped (the model prefixes nearly
 * every call with `cd <workspace> &&` — pure noise; a cd into a subdirectory
 * is information and stays), every spelling of the workspace root (native,
 * forward-slash, MSYS `/e/…`, plus any `extraSpellings` the caller knows —
 * bash passes its shell's own spelling, e.g. `/tmp/…` for a %TEMP% checkout)
 * collapsed to `./`, first line only with an ellipsis when there is more.
 * Exported for tests and for the bash tool's `summarize` hook.
 */
export function summarizeShellCommand(
  command: string,
  workspaceRoot?: string,
  extraSpellings: readonly string[] = [],
): string {
  let text = command.trim();
  const spellings: string[] = [];
  if (workspaceRoot !== undefined && workspaceRoot.length > 0) {
    const native = workspaceRoot.replace(/[\\/]+$/, "");
    const forward = native.replace(/\\/g, "/");
    const msys = forward.replace(
      /^([A-Za-z]):/,
      (_, d: string) => `/${d.toLowerCase()}`,
    );
    for (const s of new Set([
      native,
      forward,
      msys,
      ...extraSpellings.map((e) => e.replace(/[\\/]+$/, "")),
    ])) {
      if (s.length > 1) spellings.push(s);
    }
  }
  // Longest first so `/tmp/a/b` wins over a hypothetical `/tmp/a` alias.
  spellings.sort((a, b) => b.length - a.length);
  const lead = /^(?:cd|pushd)\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/;
  const isRoot = (target: string): boolean => {
    const t = target.replace(/^["']|["']$/g, "").replace(/[\\/]+$/, "");
    if (t === "." || t === "") return true;
    return spellings.some((s) => s.toLowerCase() === t.toLowerCase());
  };
  for (;;) {
    const m = lead.exec(text);
    if (m === null || !isRoot(m[1] as string)) break;
    text = text.slice(m[0].length);
  }
  if (text.length === 0) text = command.trim(); // it WAS just a cd
  if (spellings.length > 0) {
    for (const s of spellings) {
      const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Followed by a separator (a path inside the root) or a boundary (the
      // root itself); case-insensitive on the drive-letter platforms.
      text = text.replace(
        new RegExp(`${escaped}(?=[\\\\/]|\\s|$|["'])`, "gi"),
        ".",
      );
    }
    text = text.replace(/\.[\\/]/g, "./").replace(/\.\/\.\//g, "./");
  }
  const first = text.split(/\r?\n/)[0] ?? "";
  return text.includes("\n") ? `${first} …` : first;
}

export function summarizeInput(
  tool: string,
  input: unknown,
  opts?: { workspaceRoot?: string },
): string {
  const cap = capHeader;

  const obj =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  if (obj !== null) {
    switch (tool) {
      case "read_file":
      case "edit_file":
      case "write_new_file": {
        const path = str(obj.path);
        if (path !== null) return cap(path);
        break; // malformed → fall through to JSON fallback
      }
      case "list_files": {
        const path = str(obj.path);
        return cap(path ?? ".");
      }
      case "show_excerpt": {
        // Was the JSON fallback until 2026-08-17 — the record read
        // `Reading {"path":".herta/attachments/…` (real session). Cite it
        // the way its own result row does: `path:from-to`, or `path ~"match"`
        // for the match+context form.
        const path = str(obj.path);
        if (path === null) break;
        const from = typeof obj.fromLine === "number" ? obj.fromLine : null;
        const to = typeof obj.toLine === "number" ? obj.toLine : null;
        if (from !== null) {
          return cap(
            to !== null ? `${path}:${from}-${to}` : `${path}:${from}-`,
          );
        }
        const match = str(obj.match);
        return cap(match !== null ? `${path} ~"${match}"` : path);
      }
      case "search_text": {
        // `"pattern" in path` when a path was given (2026-08-17): the verb
        // became Searching, and where it looked is half of what a reader
        // wants — a search into one attached file reads differently from a
        // whole-workspace one.
        const pattern = str(obj.pattern);
        if (pattern === null) break;
        const path = str(obj.path);
        return cap(
          path !== null && path !== "."
            ? `"${pattern}" in ${path}`
            : `"${pattern}"`,
        );
      }
      case "glob": {
        const pattern = str(obj.pattern);
        if (pattern !== null) return cap(`"${pattern}"`);
        break;
      }
      case "memory_save": {
        // The entry `kind` (build_command / repo_fact / …) is a short,
        // identifying category. Never surface the full `text` body inline.
        const kind = str(obj.kind);
        return kind !== null ? cap(kind) : "";
      }
      case "run_command": {
        if (Array.isArray(obj.argv)) {
          const argv = obj.argv.filter(
            (a): a is string => typeof a === "string",
          );
          if (argv.length > 0) return cap(argv.join(" "));
        }
        break;
      }
      case "bash": {
        // Minimal contract (ADR 0040): the command line itself, first line
        // only — a heredoc body or a multi-line script is not a header.
        // The model habitually writes `cd <workspace> && <real command>`
        // (lab + live GUI 2026-08-17): every activity row read
        // "Running cd /tmp/…/ws && …" and the real command was cut off. Strip
        // that prefix and relativize the workspace's spellings so the row
        // says what is being run.
        const command = str(obj.command);
        if (command !== null) {
          return cap(summarizeShellCommand(command, opts?.workspaceRoot));
        }
        break;
      }
      case "str_replace_editor": {
        // `<command> <path>` (+ the range for a ranged view) — the bridge
        // picks Reading/Writing from the leading word, so the shape is
        // load-bearing (workflowLabel in backend-bridge.ts).
        const command = str(obj.command);
        const path = str(obj.path);
        if (command === null || path === null) break;
        const range = Array.isArray(obj.view_range)
          ? obj.view_range.filter((n): n is number => typeof n === "number")
          : [];
        return cap(
          command === "view" && range.length === 2
            ? `${command} ${path}:${range[0]}-${range[1]}`
            : `${command} ${path}`,
        );
      }
      case "command_output": {
        // "Reading bg-1 output" (2026-08-17): both background follow-ups used
        // to render as `Running bg-1`, which reads as a second launch.
        const id = str(obj.backgroundId);
        return id !== null ? cap(`${id} output`) : "";
      }
      case "command_stop": {
        const id = str(obj.backgroundId);
        return id !== null ? cap(id) : "";
      }
      case "git_status":
      case "git_diff":
        return ""; // verb alone is enough
      case "todo_write": {
        // Compact progress ratio: "Planning 2/5" in the activity row.
        if (Array.isArray(obj.todos)) {
          const total = obj.todos.length;
          const done = obj.todos.filter(
            (t) =>
              typeof t === "object" &&
              t !== null &&
              (t as { status?: unknown }).status === "completed",
          ).length;
          return total > 0 ? `${done}/${total}` : "";
        }
        return "";
      }
      default:
        break; // unknown tool → JSON fallback below
    }
  }

  // Fallback: original JSON-truncation behavior. Reached for unknown tools,
  // non-object inputs, and known tools whose expected field is missing/
  // malformed. Wrapped in try/catch so it never throws.
  try {
    const json = JSON.stringify(input);
    if (json === undefined) return "";
    return cap(json);
  } catch {
    return "";
  }
}
