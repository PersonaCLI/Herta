/**
 * The abort predicate and constructor every provider seam uses — the retry
 * loop, the SSE reader and the deadline helpers — so an interrupt in flight
 * is never re-badged as a network failure, an SSE error, or an HTTP status.
 * Since 2026-09-03 the predicate IS `@herta/core`'s `isAbortError` (name
 * "AbortError" or code "ABORT_ERR"), and since 2026-09-11 the constructor is
 * core's too; this file kept copies of its own until they were folded.
 */
import { abortError } from "@herta/core";

export { abortError, isAbortError } from "@herta/core";

/**
 * `signal.throwIfAborted()` that always throws an AbortError. The native one
 * throws the signal's reason, which is whatever the caller aborted with: a
 * deadline's plain Error, a TimeoutError. Thrown as it was, a call its own
 * signal had cut was not an abort to `isAbortError`, and which error came
 * out depended on whether the abort landed during a read or between two
 * (review 2026-11-10, second pass).
 */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}
