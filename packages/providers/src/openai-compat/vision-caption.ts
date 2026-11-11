import { ProviderError } from "../errors.js";
import { observedRequest, parseUsageChunk } from "../usage.js";
import type { HttpOpts } from "./http.js";
import { postChatCompletions } from "./http.js";

/**
 * One-shot image captioning over the chat endpoint (ADR 0048 §3).
 *
 * Deliberately NOT part of `ProviderAdapter`. The adapter's `PromptFrame`
 * carries string-content messages, and images ride OpenAI-style content parts
 * — widening the whole transcript union for one sidecar would touch every
 * translate/stream path for a caller that streams nothing, holds no history
 * and asks one question. This is a narrow function over the same retrying
 * POST: body in, one line of text out.
 *
 * Non-streaming on purpose: nothing consumes a caption incrementally, and a
 * single JSON response has no SSE watchdog to reason about.
 */

export interface VisionCaptionRequest {
  /** Harness-owned system prompt — the caller owns the wording, the way the
   *  digest tool's caller owns its prompts (`digestModelFrom`). */
  readonly system: string;
  readonly user: string;
  /** `data:image/png;base64,…`. The API also accepts remote URLs; the harness
   *  never sends one — an attachment is bytes we already hold, and fetching a
   *  URL on the model's behalf is a different (SSRF-shaped) decision. */
  readonly imageDataUri: string;
}

export type VisionCaptioner = (
  req: VisionCaptionRequest,
  signal: AbortSignal,
) => Promise<string>;

/** See `VisionCaptionerOpts.maxTokens` — measured, not guessed. */
export const DEFAULT_CAPTION_MAX_TOKENS = 4096;

export interface VisionCaptionerOpts extends HttpOpts {
  /**
   * Completion budget. The default is load-bearing and was MEASURED, not
   * guessed: the vision model reasons before answering, and the chain's
   * length varies wildly for the same image and prompt — 109 to 1212 tokens
   * across ten live calls on one 1024×1024 PNG (2026-08-27). At 1024, two of
   * five Chinese runs hit `finish_reason: "length"`: one returned empty, one
   * returned a caption cut mid-sentence. The default therefore sits far above
   * the observed ceiling. It costs nothing when unused — a cap truncates
   * generation, it does not provoke it.
   */
  maxTokens?: number;
  temperature?: number;
}

interface CaptionResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown };
    readonly finish_reason?: unknown;
  }[];
}

export function visionCaptioner(opts: VisionCaptionerOpts): VisionCaptioner {
  return (req, signal) =>
    observedRequest(
      { endpoint: "chat", model: opts.model, site: "vision" },
      (stated) => caption(opts, req, signal, stated),
      signal,
    );
}

async function caption(
  opts: VisionCaptionerOpts,
  req: VisionCaptionRequest,
  signal: AbortSignal,
  stated: Parameters<Parameters<typeof observedRequest>[1]>[0],
): Promise<string> {
  {
    const res = await postChatCompletions(
      opts,
      {
        model: opts.model,
        messages: [
          { role: "system", content: req.system },
          {
            role: "user",
            content: [
              { type: "text", text: req.user },
              { type: "image_url", image_url: { url: req.imageDataUri } },
            ],
          },
        ],
        max_tokens: opts.maxTokens ?? DEFAULT_CAPTION_MAX_TOKENS,
        ...(opts.temperature !== undefined
          ? { temperature: opts.temperature }
          : {}),
      },
      signal,
    );

    let json: CaptionResponse;
    try {
      json = (await res.json()) as CaptionResponse;
    } catch (cause) {
      throw new ProviderError({
        code: "sse",
        retryable: false,
        message: "caption response was not JSON",
        cause,
      });
    }

    // The one non-streamed call: its usage sits on the body (`usage.ts`).
    // A caption that fails after this (empty, truncated) was still paid for,
    // and its usage is the line it leaves.
    const usage = parseUsageChunk(json);
    if (usage !== null) stated(usage);

    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    // An empty caption is a FAILURE, never a caption. The caller degrades to
    // "stored, not read" — which is honest — whereas an empty string would
    // reach the record as a block claiming to describe an image while saying
    // nothing about it.
    if (typeof content !== "string" || content.trim() === "") {
      throw new ProviderError({
        code: "sse",
        retryable: false,
        message:
          choice?.finish_reason === "length"
            ? "caption was empty (budget consumed by reasoning)"
            : "caption was empty",
      });
    }
    // A TRUNCATED caption is the same class as an empty one, and easier to
    // miss: at a tight budget the model returned a sentence cut mid-word
    // (live, 2026-08-27), which reads as a complete description and would sit
    // in the record permanently. An incomplete reading is not a reading.
    if (choice?.finish_reason === "length") {
      throw new ProviderError({
        code: "sse",
        retryable: false,
        message: "caption was truncated (hit the token budget)",
      });
    }
    return content.trim();
  }
}
