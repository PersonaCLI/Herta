import {
  type AgentEvent,
  InMemoryEventBus,
  type ProviderAdapter,
  setUsageNoteSink,
  type TerminalRecord,
  type UsageNote,
} from "@herta/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorTurnDeps } from "./actor-turn-deps.js";
import { runSupervisorVerdict } from "./actor-turn-judges.js";

type Frame = Parameters<ProviderAdapter["streamChat"]>[0];

function saying(text: string): ProviderAdapter {
  return {
    async *streamChat() {
      yield { type: "text-delta", text };
      yield { type: "finish", reason: "stop" };
    },
  } as unknown as ProviderAdapter;
}

/** A stream that emits nothing and ends only when its signal aborts. */
function hanging(): ProviderAdapter {
  return {
    streamChat(_frame: Frame, signal: AbortSignal) {
      return {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<never>((_resolve, reject) => {
              const stop = (): void => reject(new Error("aborted"));
              if (signal.aborted) stop();
              else signal.addEventListener("abort", stop, { once: true });
            }),
        }),
      };
    },
  } as unknown as ProviderAdapter;
}

const RECORD: TerminalRecord = [{ kind: "user", text: "现在呢？" }];

function verdictOf(
  supervisorProvider: ProviderAdapter,
  signal: AbortSignal = new AbortController().signal,
): ReturnType<typeof runSupervisorVerdict> {
  return runSupervisorVerdict({
    deps: {
      bus: new InMemoryEventBus<AgentEvent>(),
    } as unknown as ActorTurnDeps,
    supervisorProvider,
    supervisorPrompt: "",
    supervisorFrame: {} as Frame,
    signal,
    record: RECORD,
    controller: undefined,
  });
}

describe("runSupervisorVerdict — its line in the usage log (review 2026-11-10)", () => {
  const notes: UsageNote[] = [];
  beforeEach(() => {
    notes.length = 0;
    setUsageNoteSink((n) => notes.push(n));
  });
  afterEach(() => {
    setUsageNoteSink(undefined);
    vi.useRealTimers();
  });

  it("an approval and a block each report the verdict and the call's wall time", async () => {
    expect((await verdictOf(saying("OK"))).verdict).toBe("ok");
    expect((await verdictOf(saying("重来：称呼姬子用了姐姐"))).verdict).toBe(
      "block",
    );
    expect(notes).toEqual([
      { kind: "supervisor", verdict: "ok", ms: expect.any(Number) },
      { kind: "supervisor", verdict: "block", ms: expect.any(Number) },
    ]);
  });

  it("a call that threw is an approval on screen and an error in the log", async () => {
    const failing = {
      streamChat() {
        throw new Error("provider down");
      },
    } as unknown as ProviderAdapter;
    expect((await verdictOf(failing)).verdict).toBe("ok");
    expect(notes).toEqual([
      {
        kind: "supervisor",
        verdict: "ok",
        why: "error",
        ms: expect.any(Number),
      },
    ]);
  });

  it("an answer with nothing in it says so", async () => {
    expect((await verdictOf(saying("  "))).verdict).toBe("ok");
    expect(notes).toEqual([
      {
        kind: "supervisor",
        verdict: "ok",
        why: "empty",
        ms: expect.any(Number),
      },
    ]);
  });

  it("a call that ran out its deadline reports the timeout and how long it held the speech", async () => {
    vi.useFakeTimers();
    const pending = verdictOf(hanging());
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).verdict).toBe("ok");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: "supervisor",
      verdict: "ok",
      why: "timeout",
    });
    expect((notes[0] as { ms: number }).ms).toBeGreaterThanOrEqual(60_000);
  });

  it("a turn the user interrupted reports nothing: no verdict was reached", async () => {
    const turn = new AbortController();
    const pending = verdictOf(hanging(), turn.signal);
    turn.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(notes).toEqual([]);
  });
});
