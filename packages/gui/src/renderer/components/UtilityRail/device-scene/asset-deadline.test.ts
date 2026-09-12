import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDeadline } from "./asset-deadline.js";

describe("withDeadline (ADR 0057 §2.12)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes an answer through and leaves no timer behind", async () => {
    let expired = 0;
    const result = withDeadline(Promise.resolve("atlas"), {
      ms: 1000,
      reason: "no answer",
      onExpire: () => {
        expired += 1;
      },
    });
    await expect(result).resolves.toBe("atlas");
    expect(expired).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the reason and stops the work when nothing ever answers", async () => {
    let stopped = 0;
    // The transcoder's shape: a promise that never settles.
    const never = new Promise<string>(() => undefined);
    const result = withDeadline(never, {
      ms: 15_000,
      reason: "the KTX2 transcoder produced no answer",
      onExpire: () => {
        stopped += 1;
      },
    });
    const rejection = expect(result).rejects.toThrow(
      "the KTX2 transcoder produced no answer",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(stopped).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards the work's own rejection before the bound", async () => {
    let stopped = 0;
    const result = withDeadline(Promise.reject(new Error("no wasm")), {
      ms: 15_000,
      reason: "no answer",
      onExpire: () => {
        stopped += 1;
      },
    });
    await expect(result).rejects.toThrow("no wasm");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopped).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not expire a slow-but-answering load after the fact", async () => {
    let stopped = 0;
    let answer: (value: string) => void = () => undefined;
    const slow = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const result = withDeadline(slow, {
      ms: 15_000,
      reason: "no answer",
      onExpire: () => {
        stopped += 1;
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    answer("atlas");
    await expect(result).resolves.toBe("atlas");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopped).toBe(0);
  });
});
