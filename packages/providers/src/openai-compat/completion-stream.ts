import type { CompletionEvent } from "@herta/core";
import { ProviderError } from "../errors.js";
import { parseUsageChunk } from "../usage.js";
import { throwIfAborted } from "./abort.js";
import type { StreamUsage } from "./stream.js";

interface CompletionDeltaChunk {
  choices?: ReadonlyArray<{
    index?: number;
    text?: unknown;
    finish_reason?: string | null;
  }>;
}

export async function* mapCompletionStream(
  events: AsyncIterable<unknown>,
  signal: AbortSignal,
  /** As `mapStream`'s: told the usage before the chunk's `finish` goes out. */
  onUsage?: (usage: StreamUsage) => void,
): AsyncGenerator<CompletionEvent, void, void> {
  let sawFinish = false;
  let sawText = false;

  for await (const ev of events) {
    throwIfAborted(signal);
    if (onUsage !== undefined) {
      const usage = parseUsageChunk(ev);
      if (usage !== null) onUsage(usage);
    }
    // A chunk carrying an `error` payload instead of `choices` was silently
    // dropped by the guard below on its way to the "assume stop" default
    // (audit 2026-07-24, 1.9) — surface it as the failure it is. `!= null`,
    // not `!== undefined`: some OpenAI-compatible gateways stamp a benign
    // `"error": null` on every chunk, which must not kill the stream.
    const errPayload = (ev as { error?: { message?: unknown } | null }).error;
    if (errPayload !== undefined && errPayload !== null) {
      throw new ProviderError({
        code: "sse",
        retryable: true,
        message: `completion stream carried an error payload: ${
          typeof errPayload.message === "string"
            ? errPayload.message
            : JSON.stringify(errPayload).slice(0, 200)
        }`,
      });
    }
    const choice = (ev as CompletionDeltaChunk).choices?.[0];
    if (choice === undefined) continue;

    if (choice.text !== undefined && choice.text !== "") {
      if (typeof choice.text !== "string") {
        throw new ProviderError({
          code: "sse",
          retryable: false,
          message: `completion stream emitted non-string text: ${typeof choice.text}`,
        });
      }
      sawText = true;
      yield { type: "text-delta", text: choice.text };
    }

    const reason = choice.finish_reason;
    if (reason === null || reason === undefined) continue;

    sawFinish = true;
    if (reason === "stop" || reason === "length") {
      yield { type: "finish", reason };
    } else {
      yield { type: "finish", reason: "error" };
    }
  }

  if (!sawFinish) {
    // "The iterator ended" is NOT "the model chose to stop" (audit
    // 2026-07-24, 1.9). Fabricating `stop` here meant a TRUNCATED generation
    // — an upstream ending the body early, a gateway emitting an error object
    // then [DONE] — was committed as a finished （我 说）block: a
    // half-generated sentence written into the durable record and shown as a
    // complete Herta turn, with no error and no retry. Including the case
    // where the @板砖 dispatch line was cut mid-token.
    //
    // With NO text emitted the stream was simply empty (an unusual but
    // benign shape the callers already handle); with text emitted and no
    // finish_reason, the generation is incomplete and must be retryable.
    if (sawText) {
      throw new ProviderError({
        code: "sse",
        retryable: true,
        message:
          "completion stream ended mid-generation (no finish_reason after text)",
      });
    }
    yield { type: "finish", reason: "stop" };
  }
}
