import { errorMessage, isAbortError } from "../errors.js";
import type { EventBus } from "../event-bus.js";
import type { AgentError } from "../types/errors.js";
import type { AgentEvent } from "../types/events.js";
import type {
  ProviderAdapter,
  ProviderPromptFrame,
} from "../types/provider.js";
import type { ToolCallRequest } from "../types/tool.js";

export interface ModelInferenceResult {
  /** Accumulated text deltas in stream order. */
  text: string;
  /** Accumulated reasoning deltas (for providers that emit them). */
  reasoning: string;
  /** Tool calls the model emitted this inference. Empty if finishReason="stop". */
  toolCalls: ToolCallRequest[];
  /** Why the inference ended. */
  finishReason: "stop" | "tool_calls" | "length" | "error";
  /** All assistant.delta events emitted during this inference, in order.
   * Generator-style callers can re-yield these to expose them through
   * their AsyncGenerator surface. The bus has already received them. */
  deltas: AgentEvent[];
}

export interface ModelInferenceOpts {
  provider: ProviderAdapter;
  frame: ProviderPromptFrame;
  signal: AbortSignal;
  bus: EventBus<AgentEvent>;
  /**
   * Identifies which layer's loop is running. Backend's nested run-coding-task
   * delegation uses "backend"; the top-level Herta actor uses "actor".
   * Populates the `layer` field on emitted `assistant.delta` events.
   */
  layer: "actor" | "backend";
}

/**
 * Streams a single provider inference round. Accumulates text + reasoning +
 * tool-call requests, emitting `assistant.delta` events as text arrives.
 * Returns when the provider emits a `finish` event.
 *
 * Throws `AbortError` if the signal aborts. Other provider failures resolve
 * normally with `finishReason: "error"`; the caller decides how to react
 * (the existing backend turn loop emits a `turn.failed` event in that case).
 */
export async function streamModelInference(
  opts: ModelInferenceOpts,
): Promise<ModelInferenceResult> {
  let text = "";
  let reasoning = "";
  const toolCalls: ToolCallRequest[] = [];
  const deltas: AgentEvent[] = [];
  let finishReason: ModelInferenceResult["finishReason"] = "error";

  for await (const pevent of opts.provider.streamChat(
    opts.frame,
    opts.signal,
  )) {
    if (pevent.type === "text-delta") {
      const event: AgentEvent = {
        type: "assistant.delta",
        layer: opts.layer,
        text: pevent.text,
      };
      opts.bus.publish(event);
      deltas.push(event);
      text += pevent.text;
    } else if (pevent.type === "reasoning-delta") {
      reasoning += pevent.text;
    } else if (pevent.type === "tool-call-request") {
      toolCalls.push(pevent.call);
    } else if (pevent.type === "finish") {
      finishReason = pevent.reason;
      break;
    }
  }

  return { text, reasoning, toolCalls, finishReason, deltas };
}

// The ONE abort predicate lives in ../errors.ts since 2026-09-11 (with the
// abort constructor and `errorMessage`); re-exported here for the callers
// that import it by this path.
export { isAbortError };

export function toProviderError(err: unknown): AgentError {
  return {
    kind: "provider_failed",
    message: errorMessage(err),
    cause: err,
  };
}
