import { CLOSE_SETTLE_CAP_MS } from "@herta/app-server";

/**
 * The two quit decisions `main/index.ts` makes, as pure functions (platform
 * review 2026-09-23 — both were wrong on macOS, and index.ts is not
 * unit-testable glue), and how long a quit holds.
 */

/**
 * How long `before-quit` holds exit for the session's flush (ADR 0071
 * §1.7). It ends as soon as every flush settles; this is only its ceiling,
 * and it must outlast `close()`'s own wait for an interrupted turn to unwind
 * plus the persist after it — it was 3 s against that 5 s, so a slow unwind
 * lost the turn's ending on a plain quit.
 */
export const QUIT_HOLD_MS = CLOSE_SETTLE_CAP_MS + 1_500;

/**
 * Whether the app ends when its last window has closed.
 *
 * Everywhere but macOS: yes. On macOS an app conventionally stays in the Dock
 * with no window — UNLESS a quit is what closed that window. The tray's Exit
 * item quits by closing the window first (its orderly-teardown route) and
 * relied on this event to finish the job; on darwin it never did, so Exit
 * left the app running in the Dock with `quitRequested` stuck on, which then
 * broke close-to-tray and crash recovery for the rest of the run.
 */
export function quitsWhenAllWindowsClosed(
  platform: NodeJS.Platform,
  quitRequested: boolean,
): boolean {
  return platform !== "darwin" || quitRequested;
}

/**
 * What a quit waits for: the dispose a closed window already started AND the
 * live session's. The first cut disposed the live session only when nothing
 * was pending — but on macOS a window closed with close-to-tray off leaves
 * its (long settled) dispose behind, the Dock reopens a window with a NEW
 * session, and Cmd+Q then waited on the stale promise while the live
 * session's transcript was cut off mid-turn. Disposing twice is harmless
 * (`dispose` is idempotent); skipping the live one is not.
 */
export function quitDisposals(
  pending: Promise<void> | null,
  live: Promise<void> | null,
): Promise<void> | null {
  if (pending === null) return live;
  if (live === null) return pending;
  return Promise.all([pending, live]).then(() => undefined);
}

/**
 * `before-quit`'s hold, as a small state machine: idle → holding → released.
 *
 * The hold returned early on a second quit WITHOUT preventing it, so while the
 * first quit waited for the flush, any other quit went straight through and
 * the app exited mid-flush (Mac findings 2026-10-24, item 6). On macOS that is
 * an ordinary hand: Cmd+Q, the Dock's Quit and logout leave the window on
 * screen looking idle, so a second Cmd+Q — or a held one, whose key
 * equivalent repeats — cut the transcript; restart-and-update quits twice
 * there by itself. Now every quit while holding is swallowed, and only the
 * hold's own quit, once the flush settles or `holdMs` runs out, goes through.
 */
export class QuitHold {
  private state: "idle" | "holding" | "released" = "idle";

  /**
   * One `before-quit`. `start` begins the flushes and returns what to wait
   * for, or null when there is nothing; `quit` quits again when the hold
   * ends. True when this quit must be prevented.
   */
  onBeforeQuit(
    start: () => Promise<unknown> | null,
    quit: () => void,
    holdMs: number,
  ): boolean {
    if (this.state === "released") return false;
    if (this.state === "holding") return true;
    const flush = start();
    if (flush === null) return false;
    this.state = "holding";
    const timeout = new Promise<void>((resolve) => {
      setTimeout(resolve, holdMs);
    });
    void Promise.race([
      flush.then(
        () => undefined,
        () => undefined,
      ),
      timeout,
    ]).finally(() => {
      this.state = "released";
      quit();
    });
    return true;
  }
}
