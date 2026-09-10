/**
 * The error helpers every package used to spell for itself (2026-09-11,
 * the post-0.1.5 refactor pass): the message of an unknown thrown value,
 * the ONE abort predicate, and the ONE abort constructor.
 */

/** The message of whatever was thrown: an Error's `message`, anything else
 *  stringified. Thirty-six sites spelled this ternary inline before. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The ONE abort predicate (2026-09-03; moved here from
 * stream-model-inference.ts on 2026-09-11, re-exported there). Five sites
 * had their own — a name-only check, the providers' wider one, two inline
 * `name === "AbortError"` tests in the tools — with two definitions between
 * them. This is the wide one: `name === "AbortError"` (a DOMException, a
 * fetch abort, the harness's own constructed errors) OR `code ===
 * "ABORT_ERR"` (undici surfaces some interrupts with that code and a
 * different name). No `instanceof Error` — a DOMException from another
 * realm (jsdom) is not one, and the interrupt it carries is still an
 * interrupt. Every seam that asks "was this the user's interrupt?" must
 * answer the same way, or one layer re-badges an interrupt as a failure.
 */
export function isAbortError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
}

/**
 * A fresh AbortError: a plain Error NAMED "AbortError", which is what
 * `isAbortError` classifies by. Constructed rather than taken from
 * `signal.reason`, so a reason-less `abort()` or a custom reason can never
 * demote an interrupt to a failure downstream. Five sites built their own
 * before (the providers' retry loop, the backend's backoff sleep, spawn-git,
 * and the two permission gates).
 */
export function abortError(message = "aborted"): Error {
  const e = new Error(message);
  e.name = "AbortError";
  return e;
}
