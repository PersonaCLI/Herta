/**
 * The abort predicate and constructor every provider seam uses — the retry
 * loop, the SSE reader and the deadline helpers — so an interrupt in flight
 * is never re-badged as a network failure, an SSE error, or an HTTP status.
 * Since 2026-09-03 the predicate IS `@herta/core`'s `isAbortError` (name
 * "AbortError" or code "ABORT_ERR"), and since 2026-09-11 the constructor is
 * core's too; this file kept copies of its own until they were folded.
 */
export { abortError, isAbortError } from "@herta/core";
