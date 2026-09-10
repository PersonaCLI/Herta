import { errorMessage } from "@herta/core";
import { ProviderError } from "../errors.js";
import { isAbortError } from "./abort.js";

const DONE = Symbol("SSE_DONE");
type ParsedEvent = unknown | typeof DONE;

export interface ParseSSEOpts {
  /**
   * Max ms to wait for the next chunk of bytes (including the first one)
   * before treating the stream as stalled. A stalled stream throws
   * `ProviderError{code:"stall", retryable:false}` — mid-stream output may
   * already have been consumed, so the caller must not blind-retry.
   * `0` disables the watchdog. Default 90s: generous against slow thinking
   * models (SSE keep-alive comments count as bytes and reset the timer),
   * but finite — without it a provider that accepts the connection and then
   * goes silent parks `reader.read()` forever and the turn spinner never
   * resolves (hang audit 2026-07-09, H1).
   */
  readonly idleTimeoutMs?: number;
}

export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 90_000;

/** One `reader.read()` guarded by the idle watchdog. On timeout: cancel the
 *  reader (closes the connection; also settles the losing read — a cancelled
 *  read resolves `{done:true}`, so it can never become an unhandled
 *  rejection) and throw the stall error. */
async function readWithIdleDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const readP = reader.read();
  try {
    return await Promise.race([
      readP,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new ProviderError({
              code: "stall",
              retryable: false,
              message: `SSE stream stalled: no bytes for ${idleMs}ms`,
            }),
          );
        }, idleMs);
      }),
    ]);
  } catch (err) {
    // The losing read may still reject later (external abort tearing down
    // the body) — mark it handled so it can never crash as an unhandled
    // rejection, then close the stream if WE timed out.
    readP.catch(() => undefined);
    if (err instanceof ProviderError && err.code === "stall") {
      try {
        await reader.cancel();
      } catch {
        // Already errored/closed — the throw below is the real outcome.
      }
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  opts: ParseSSEOpts = {},
): AsyncGenerator<unknown, void, void> {
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_SSE_IDLE_TIMEOUT_MS;
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let sourceEnded = false;

  try {
    while (true) {
      signal.throwIfAborted();
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read =
          idleMs > 0
            ? await readWithIdleDeadline(reader, idleMs)
            : await reader.read();
      } catch (cause) {
        // A transport failure mid-body rejects reader.read() with a RAW
        // undici error (`TypeError: terminated`, ECONNRESET) — the one
        // failure mode in this pipeline that escaped untyped: it reached
        // the turn-fail surface verbatim (E2E-4 X6b, 2026-07-19). Wrap it;
        // aborts (user interrupt) and already-typed errors pass through.
        // Not retryable: partial output was already consumed downstream
        // (same contract as the mid-stream stall above).
        if (cause instanceof ProviderError || isAbortError(cause)) throw cause;
        throw new ProviderError({
          code: "network",
          retryable: false,
          message: `stream terminated mid-response: ${errorMessage(cause)}`,
          cause,
        });
      }
      const { value, done } = read;
      if (done) {
        sourceEnded = true;
        if (buffer.length > 0) {
          const event = takeEvent(buffer);
          if (event !== undefined) {
            const parsed = tryParse(event);
            if (parsed !== DONE) yield parsed;
          }
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = takeEvent(raw);
        if (event !== undefined) {
          const parsed = tryParse(event);
          if (parsed === DONE) return;
          yield parsed;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    // Cancel the body on every exit that is not the source's own EOF (audit
    // 2026-07-10 §6): the backend loop breaks its for-await at `finish`
    // without waiting for `[DONE]`, which unwinds this generator with the
    // response body still open — releaseLock alone abandoned the connection
    // (tail unread, socket held until teardown) on effectively every backend
    // request, up to 100 per turn. The [DONE] early-return and thrown-error
    // paths get the same treatment; a cancel after natural EOF would be a
    // harmless no-op, but skipping it keeps a cleanly-drained body eligible
    // for keep-alive reuse.
    if (!sourceEnded) {
      try {
        await reader.cancel();
      } catch {
        // Already closed/errored — the exit in flight is the real outcome.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

function takeEvent(raw: string): string | undefined {
  let data = "";
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      const payload = line.slice(5).replace(/^ /, "");
      data += data.length > 0 ? `\n${payload}` : payload;
    }
  }
  return data.length > 0 ? data : undefined;
}

function tryParse(payload: string): ParsedEvent {
  if (payload === "[DONE]") return DONE;
  try {
    return JSON.parse(payload);
  } catch (cause) {
    throw new ProviderError({
      code: "sse",
      retryable: false,
      message: `malformed JSON in SSE data: ${payload.slice(0, 80)}`,
      cause,
    });
  }
}
