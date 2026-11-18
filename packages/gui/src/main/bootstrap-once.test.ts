import { describe, expect, it } from "vitest";
import { bootstrapOnce } from "./bootstrap-once.js";

/** A bootstrap that waits for `land`, as the real one waits for PATH. */
function gated(): {
  start: () => Promise<void>;
  land: () => void;
  boots: () => number;
  resyncs: () => number;
  fail: (yes: boolean) => void;
} {
  let booted = false;
  let failing = false;
  let boots = 0;
  let resyncs = 0;
  let land = (): void => {};
  const start = bootstrapOnce({
    booted: () => booted,
    bootstrap: async () => {
      boots += 1;
      await new Promise<void>((resolve) => {
        land = resolve;
      });
      if (!failing) booted = true;
    },
    resync: () => {
      resyncs += 1;
    },
  });
  return {
    start,
    land: () => land(),
    boots: () => boots,
    resyncs: () => resyncs,
    fail: (yes) => {
      failing = yes;
    },
  };
}

describe("bootstrapOnce — one bootstrap at a time (review 2026-11-10)", () => {
  it("a second load while the first bootstrap waits builds nothing, and re-syncs after it", async () => {
    const g = gated();
    const first = g.start();
    const second = g.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(g.boots()).toBe(1);
    expect(g.resyncs()).toBe(0);
    g.land();
    await Promise.all([first, second]);
    expect(g.boots()).toBe(1);
    expect(g.resyncs()).toBe(1);
  });

  it("a load after the bootstrap only re-syncs", async () => {
    const g = gated();
    const first = g.start();
    await new Promise((r) => setTimeout(r, 0));
    g.land();
    await first;
    await g.start();
    expect(g.boots()).toBe(1);
    expect(g.resyncs()).toBe(1);
  });

  it("a bootstrap that ended without a host is tried again by the next load", async () => {
    const g = gated();
    g.fail(true);
    const first = g.start();
    await new Promise((r) => setTimeout(r, 0));
    g.land();
    await first;
    g.fail(false);
    const again = g.start();
    await new Promise((r) => setTimeout(r, 0));
    g.land();
    await again;
    expect(g.boots()).toBe(2);
    expect(g.resyncs()).toBe(0);
  });
});
