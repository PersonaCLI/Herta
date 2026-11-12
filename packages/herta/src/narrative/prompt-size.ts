/**
 * A prompt the model's window cannot hold is not sent (review 2026-11-10,
 * second pass).
 *
 * The recap keeps the newest turn whole whatever its size, and nothing
 * sized a turn's prompt against the window before it left: a message
 * pasted in at more than the window went to the provider with the whole
 * conversation and came back as that provider's error, which the notice
 * could only word as a lost connection. The turn's measuring hook sizes
 * every prompt already (`runActorCompletionTurn`); it now refuses the one
 * that cannot fit, with an error the notice has words for.
 *
 * The size is the harness's estimate, calibrated against the API for both
 * languages (ADR 0068 §9), so the line is the window itself: a prompt that
 * estimates over it is not one worth a request to find out.
 */

/** The actor model's context window, in tokens. The actor is DeepSeek's
 *  completion model and no other (D8). The recap's `contextWindowTokens` is
 *  the same number by default, but it is the knob for when to compact and a
 *  host may lower it; this is what the model can read. */
export const ACTOR_WINDOW_TOKENS = 1_000_000;

export class PromptTooLargeError extends Error {
  /** What the turn-failure notice keys its wording on (`providerCode`). */
  readonly code = "prompt-too-large";

  constructor(
    readonly estimatedTokens: number,
    readonly windowTokens: number,
  ) {
    super(
      `the message is too large for the model: about ${estimatedTokens} tokens with the conversation, against a window of ${windowTokens}. Rewind it, then send it in parts or attach it as a file.`,
    );
    this.name = "PromptTooLargeError";
  }
}

/** Throws when `estimatedTokens` is more than the window holds. */
export function assertPromptFits(
  estimatedTokens: number,
  windowTokens: number,
): void {
  if (estimatedTokens > windowTokens) {
    throw new PromptTooLargeError(estimatedTokens, windowTokens);
  }
}
