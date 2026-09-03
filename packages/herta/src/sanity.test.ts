import { describe, expect, it } from "vitest";

describe("@herta/herta sanity", () => {
  // 30 s tier (2026-09-03, same class as the 2026-08-31 renderer scanner
  // guards): the one thing this test does is load the whole of @herta/core
  // through vitest's transform, and under full-suite contention — the two
  // 1000-case fuzz files run in the same window — that cold import alone
  // blew the 5 s default twice in one day. The check is not slow; the
  // machine is busy.
  it("can import @herta/core types", async () => {
    const core = await import("@herta/core");
    expect(typeof core.CodingAgentRuntime).toBe("function");
  }, 30_000);
});
