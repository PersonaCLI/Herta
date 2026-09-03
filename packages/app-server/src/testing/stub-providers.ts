/**
 * Test-only provider stubs for @herta/app-server session tests.
 *
 * Not exported from the package barrel — internal seam only.
 */
import type {
  CompletionEvent,
  CompletionProviderAdapter,
  CompletionRequest,
  ProviderAdapter,
  ProviderEvent,
} from "@herta/core";

/**
 * The thought the completion stubs answer every `（我 想）` prompt with.
 * Every actor turn thinks before it speaks (the single-phase path went on
 * 2026-09-03), so a turn commits `{ kind: "herta", surface: "thought", text:
 * STUB_THOUGHT }` right before each scripted speech. Exported so record-shape
 * assertions can name the block instead of counting around it.
 */
export const STUB_THOUGHT = "想想看。";

/** True for the actor's thought-phase prompt (it ends with the forced open
 *  tag and the newline the serializer appends to a complete tag). */
export function isThoughtPrompt(request: CompletionRequest): boolean {
  return request.prompt.endsWith("（我 想）\n");
}

/** The canned thought stream: STUB_THOUGHT closed by its stop sequence. */
export async function* stubThoughtStream(): AsyncGenerator<CompletionEvent> {
  yield { type: "text-delta", text: `${STUB_THOUGHT}（/我 想）` };
  yield { type: "finish", reason: "stop" };
}

export interface StubCompletionOptions {
  /**
   * When true, thought prompts consume scripts like any other call — for a
   * test that wants to script the thought phase (an empty thought, a thought
   * that rolls into `（我 说）`, …). Defaults to false: thought prompts are
   * answered with `stubThoughtStream` WITHOUT consuming a script, so a
   * script list reads as the turn's speeches.
   */
  readonly scriptThoughts?: boolean;
}

export interface CompletionScript {
  /** Deltas to yield in order, as `{ type: "text-delta" }` events. */
  readonly deltas: readonly string[];
  /** The stop reason. Defaults to "stop". */
  readonly stopReason?: "stop" | "length" | "error";
}

/**
 * A scripted CompletionProviderAdapter that yields predefined delta
 * sequences in order. Throws with a descriptive message when more calls
 * are made than scripts were provided. Thought prompts are auto-answered
 * unless `scriptThoughts` is set (see StubCompletionOptions).
 */
export function stubCompletionProvider(
  scripts: readonly CompletionScript[],
  opts: StubCompletionOptions = {},
): CompletionProviderAdapter {
  let i = 0;
  return {
    streamCompletion(
      request: CompletionRequest,
      _signal: AbortSignal,
    ): AsyncIterable<CompletionEvent> {
      if (opts.scriptThoughts !== true && isThoughtPrompt(request)) {
        return stubThoughtStream();
      }
      const script = scripts[i];
      i += 1;
      if (script === undefined) {
        throw new Error(
          `stubCompletionProvider: no script for call #${i}; provided ${scripts.length}`,
        );
      }
      const deltas = script.deltas;
      const stopReason = script.stopReason ?? "stop";
      return (async function* () {
        for (const delta of deltas) {
          yield { type: "text-delta", text: delta } satisfies CompletionEvent;
        }
        yield { type: "finish", reason: stopReason } satisfies CompletionEvent;
      })();
    },
  };
}

export interface SlowCompletionScript {
  /** Deltas to yield in order, each separated by `delayMs` milliseconds. */
  readonly deltas: readonly string[];
  /** Delay between each delta emission. Defaults to 20 ms. */
  readonly delayMs?: number;
  /** The stop reason. Defaults to "stop". */
  readonly stopReason?: "stop" | "length" | "error";
}

/**
 * A slow CompletionProviderAdapter that yields predefined delta sequences with
 * async delays between each delta. Checks `signal.aborted` before each delta
 * and throws an `AbortError` if the signal has been aborted. This allows tests
 * to interrupt a turn mid-stream.
 *
 * Serves the same script on every call, so a slow turn stays in-flight until
 * interrupted. Thought prompts are answered instantly with the canned thought
 * unless `scriptThoughts` is set — the paced speech phase is what keeps the
 * turn open.
 */
export function slowStubCompletionProvider(
  script: SlowCompletionScript,
  opts: StubCompletionOptions = {},
): CompletionProviderAdapter {
  const delayMs = script.delayMs ?? 20;
  const deltas = script.deltas;
  const stopReason = script.stopReason ?? "stop";
  return {
    streamCompletion(
      request: CompletionRequest,
      signal: AbortSignal,
    ): AsyncIterable<CompletionEvent> {
      if (opts.scriptThoughts !== true && isThoughtPrompt(request)) {
        return stubThoughtStream();
      }
      return (async function* () {
        for (const delta of deltas) {
          // Abort-aware delay.
          await new Promise<void>((resolve, reject) => {
            if (signal.aborted) {
              const e = new DOMException("Aborted", "AbortError");
              reject(e);
              return;
            }
            const timer = setTimeout(resolve, delayMs);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                const e = new DOMException("Aborted", "AbortError");
                reject(e);
              },
              { once: true },
            );
          });
          yield { type: "text-delta", text: delta } satisfies CompletionEvent;
        }
        yield { type: "finish", reason: stopReason } satisfies CompletionEvent;
      })();
    },
  };
}

export interface ChatScript {
  readonly events: readonly ProviderEvent[];
}

/**
 * A scripted ProviderAdapter that yields predefined events in order.
 * Throws on unexpected calls to surface unscripted usage in tests.
 */
export function stubChatProvider(
  scripts: readonly ChatScript[],
): ProviderAdapter {
  let i = 0;
  return {
    streamChat(
      _frame: Parameters<ProviderAdapter["streamChat"]>[0],
      _signal: AbortSignal,
    ): AsyncIterable<ProviderEvent> {
      const script = scripts[i];
      i += 1;
      if (script === undefined) {
        throw new Error(
          `stubChatProvider: no script for call #${i}; provided ${scripts.length}`,
        );
      }
      const events = script.events;
      return (async function* () {
        for (const ev of events) {
          yield ev;
        }
      })();
    },
  };
}
