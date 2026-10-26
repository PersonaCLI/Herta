import { CLOSE_SETTLE_CAP_MS } from "@herta/app-server";
import { describe, expect, it, vi } from "vitest";
import {
  QUIT_HOLD_MS,
  QuitHold,
  quitDisposals,
  quitsWhenAllWindowsClosed,
} from "./quit-policy.js";

describe("QUIT_HOLD_MS (ADR 0071 §1.7)", () => {
  it("outlasts close()'s wait for an interrupted turn to unwind", () => {
    // 3 s against 5 s let a slow unwind lose the turn's ending on a quit.
    expect(QUIT_HOLD_MS).toBeGreaterThan(CLOSE_SETTLE_CAP_MS);
  });
});

describe("quitsWhenAllWindowsClosed", () => {
  it("quits on Windows and Linux whenever the last window closes", () => {
    expect(quitsWhenAllWindowsClosed("win32", false)).toBe(true);
    expect(quitsWhenAllWindowsClosed("linux", false)).toBe(true);
  });

  it("keeps a macOS app in the Dock after an ordinary close…", () => {
    expect(quitsWhenAllWindowsClosed("darwin", false)).toBe(false);
  });

  it("…but quits when a quit is what closed the window — the tray's Exit (2026-09-23)", () => {
    expect(quitsWhenAllWindowsClosed("darwin", true)).toBe(true);
  });
});

describe("quitDisposals", () => {
  const settled = (log: string[], name: string): Promise<void> =>
    new Promise((resolve) =>
      setTimeout(() => {
        log.push(name);
        resolve();
      }, 5),
    );

  it("waits for the live session even when a closed window's dispose is still around (2026-09-23)", async () => {
    // macOS: close (close-to-tray off) → the Dock reopens a window with a new
    // session → Cmd+Q. The stale dispose alone would let the quit through
    // before the live transcript lands.
    const log: string[] = [];
    const stale = Promise.resolve();
    const both = quitDisposals(stale, settled(log, "live"));
    await both;
    expect(log).toEqual(["live"]);
  });

  it("is whichever one exists, or null when there is nothing to wait for", async () => {
    const p = Promise.resolve();
    expect(quitDisposals(p, null)).toBe(p);
    expect(quitDisposals(null, p)).toBe(p);
    expect(quitDisposals(null, null)).toBeNull();
  });
});

describe("QuitHold (Mac findings 2026-10-24, item 6)", () => {
  const deferred = () => {
    let resolve = () => {};
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it("a second quit while the flush is held waits with it; only the hold's own quit goes through", async () => {
    const hold = new QuitHold();
    const flush = deferred();
    const quits: string[] = [];
    const quit = () => quits.push("quit");
    let starts = 0;
    const start = () => {
      starts += 1;
      return flush.promise;
    };
    expect(hold.onBeforeQuit(start, quit, 60_000)).toBe(true);
    // Cmd+Q again, a held key repeating, Squirrel's second quit: all held.
    expect(hold.onBeforeQuit(start, quit, 60_000)).toBe(true);
    expect(hold.onBeforeQuit(start, quit, 60_000)).toBe(true);
    expect(starts).toBe(1);
    expect(quits).toEqual([]);
    flush.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(quits).toEqual(["quit"]);
    // The hold's own quit is let through.
    expect(hold.onBeforeQuit(start, quit, 60_000)).toBe(false);
    expect(starts).toBe(1);
  });

  it("a hung flush is let go at the ceiling, and a failed one does not wedge", async () => {
    vi.useFakeTimers();
    try {
      const hold = new QuitHold();
      const quits: number[] = [];
      expect(
        hold.onBeforeQuit(
          () => new Promise(() => {}),
          () => quits.push(1),
          QUIT_HOLD_MS,
        ),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(QUIT_HOLD_MS - 1);
      expect(quits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(quits).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
    const failing = new QuitHold();
    const quits: number[] = [];
    failing.onBeforeQuit(
      () => Promise.reject(new Error("disk full")),
      () => quits.push(1),
      60_000,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(quits).toEqual([1]);
  });

  it("nothing to flush: the quit goes straight through", () => {
    const hold = new QuitHold();
    expect(
      hold.onBeforeQuit(
        () => null,
        () => {},
        60_000,
      ),
    ).toBe(false);
  });
});
