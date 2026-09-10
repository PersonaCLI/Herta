import { describe, expect, it } from "vitest";
import { abortError, errorMessage, isAbortError } from "./errors.js";

describe("errors", () => {
  it("errorMessage: an Error's message, anything else stringified", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage({ code: "ENOENT" })).toBe("[object Object]");
  });

  it("abortError: a plain Error named AbortError that the predicate accepts", () => {
    const e = abortError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("AbortError");
    expect(e.message).toBe("aborted");
    expect(abortError("during backoff").message).toBe("during backoff");
    expect(isAbortError(e)).toBe(true);
  });

  it("isAbortError: by name or undici's code, never by instanceof", () => {
    expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError({ code: "ABORT_ERR" })).toBe(true);
    expect(isAbortError(new Error("normal"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});
