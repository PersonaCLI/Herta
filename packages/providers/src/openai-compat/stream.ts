import type { ProviderEvent, ToolCallRequest } from "@herta/core";
import { errorMessage } from "@herta/core";
import { ProviderError } from "../errors.js";

interface OpenAIDeltaChunk {
  choices?: ReadonlyArray<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ReadonlyArray<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

interface ToolBufEntry {
  id?: string;
  name?: string;
  argsBuf: string;
}

export async function* mapStream(
  events: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent, void, void> {
  const toolBuf = new Map<number, ToolBufEntry>();
  let sawFinish = false;
  let sawText = false;

  for await (const ev of events) {
    signal.throwIfAborted();
    // Mid-stream error payload (audit BL4) — the completion-mode twin got this
    // guard in the 2026-07-24 pass and this one did not, so a gateway that
    // emitted an error object and then [DONE] fell through the `choices`
    // check below and out to the fabricated "stop" at the end. `!= null`
    // rather than `!== undefined`: some OpenAI-compatible gateways stamp a
    // benign `"error": null` on every chunk.
    const errPayload = (ev as { error?: { message?: unknown } | null }).error;
    if (errPayload !== undefined && errPayload !== null) {
      throw new ProviderError({
        code: "sse",
        retryable: true,
        message: `chat stream carried an error payload: ${
          typeof errPayload.message === "string"
            ? errPayload.message
            : JSON.stringify(errPayload).slice(0, 200)
        }`,
      });
    }
    const choice = (ev as OpenAIDeltaChunk).choices?.[0];
    if (choice === undefined) continue;
    const delta = choice.delta ?? {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      sawText = true;
      yield { type: "text-delta", text: delta.content };
    }

    if (
      typeof delta.reasoning_content === "string" &&
      delta.reasoning_content.length > 0
    ) {
      yield { type: "reasoning-delta", text: delta.reasoning_content };
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const entry = toolBuf.get(tc.index) ?? { argsBuf: "" };
        if (typeof tc.id === "string" && tc.id.length > 0) entry.id = tc.id;
        if (
          typeof tc.function?.name === "string" &&
          tc.function.name.length > 0
        ) {
          entry.name = tc.function.name;
        }
        if (typeof tc.function?.arguments === "string") {
          entry.argsBuf += tc.function.arguments;
        }
        toolBuf.set(tc.index, entry);
      }
    }

    const reason = choice.finish_reason;
    if (reason === null || reason === undefined) continue;

    sawFinish = true;
    if (reason === "stop" || reason === "length") {
      yield { type: "finish", reason };
      continue;
    }
    if (reason === "tool_calls") {
      const ordered = [...toolBuf.entries()].sort((a, b) => a[0] - b[0]);
      for (const [, entry] of ordered) {
        if (entry.id === undefined || entry.name === undefined) {
          throw new ProviderError({
            code: "sse",
            retryable: true,
            message: "tool_calls missing id or name in stream",
          });
        }
        const call = parseCall({
          id: entry.id,
          name: entry.name,
          argsBuf: entry.argsBuf,
        });
        yield { type: "tool-call-request", call };
      }
      toolBuf.clear();
      yield { type: "finish", reason: "tool_calls" };
      continue;
    }
    yield { type: "finish", reason: "error" };
  }

  if (!sawFinish) {
    if (toolBuf.size > 0) {
      throw new ProviderError({
        code: "sse",
        retryable: true,
        message:
          "stream ended before finish_reason; partial tool calls discarded",
      });
    }
    // "The iterator ended" is NOT "the model chose to stop" (audit BL4). This
    // fabricated `stop` overwrote the "error" default in
    // stream-model-inference, which made backend-turn-loop's truncation guard
    // — the one whose comment says it exists to catch exactly this —
    // unreachable in the real provider path. A backend turn cut off
    // mid-generation was reported to Herta as 完成, and she narrated a
    // finished commission.
    //
    // With no text and no tool calls the stream was simply empty, a shape the
    // callers already handle. With text emitted and no finish_reason the
    // generation is incomplete, and it is retryable — nothing was committed.
    if (sawText) {
      throw new ProviderError({
        code: "sse",
        retryable: true,
        message:
          "chat stream ended mid-generation (no finish_reason after text)",
      });
    }
    yield { type: "finish", reason: "stop" };
  }
}

function parseCall(entry: {
  id: string;
  name: string;
  argsBuf: string;
}): ToolCallRequest {
  let input: unknown;
  try {
    input = entry.argsBuf.length > 0 ? JSON.parse(entry.argsBuf) : {};
  } catch (cause) {
    // Do NOT throw. This used to raise ProviderError{code:"tool-args",
    // retryable:false}, which backend-error-policy maps to terminal — one
    // mis-escaped argument ended the brief and threw away every tool call
    // already run in it (measured: a real brief died 256s and five calls in).
    // The model can fix its own escaping when told, so the failure travels
    // as data and the turn loop hands it back as a tool result. See the
    // `malformedArgs` doc on ToolCallRequest.
    return {
      id: entry.id,
      tool: entry.name,
      input: {},
      malformedArgs: {
        raw: entry.argsBuf,
        parseError: errorMessage(cause),
      },
    };
  }
  return { id: entry.id, tool: entry.name, input };
}
