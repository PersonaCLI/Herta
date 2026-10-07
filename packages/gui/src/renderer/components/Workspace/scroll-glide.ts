/**
 * A damped climb to the scroller's (live) bottom — the page-move of a send
 * that reserved room, run as an exponential approach: fastest at the start,
 * settling on a long soft tail. Replaces `scrollIntoView({behavior:"smooth"})`
 * there (user 2026-07-30: the native curve "feels linear"; Chromium caps the
 * duration of a programmatic smooth scroll, so a pane-sized move spends most
 * of its travel at constant speed).
 *
 * Two structural wins over the native scroll, beyond the feel:
 *
 * - It RETARGETS. The destination is re-derived from the live scrollHeight
 *   every frame, so content landing mid-climb (the reply's first blocks) moves
 *   the goal and the climb follows. The native scroll aims once and lands
 *   short — which is what the GLIDE_WINDOW_MS re-assert timeout existed to
 *   paper over.
 *
 * - It has a real lifecycle. `onDone` fires when the approach converges (or at
 *   the runaway cap), `cancel()` stops it cold, and a wheel/touch from the
 *   user hands the scroller back immediately via `onUserTakeover` — parity
 *   with the native scroll, which any user input interrupts.
 *
 * The per-frame work is a scrollTop write and a scrollHeight read — no layout
 * is invalidated by the write itself (scrolling is a compositor concern), and
 * the read only forces layout in frames where content actually changed.
 */

/** Damping time-constant: the remaining distance shrinks by e× every tau.
 *  ~63% of the travel happens in the first tau, ~95% by 3·tau (~400ms) —
 *  brisk out of the gate, settling softly. */
export const SCROLL_GLIDE_TAU_MS = 130;
/** Close enough to snap: sub-pixel chasing has no visible motion left. */
export const SCROLL_GLIDE_SNAP_PX = 1;
/** Runaway cap. A stream appending content every frame moves the target
 *  every frame, and an approach that must get within SNAP of a moving goal
 *  might never converge — at the cap the climb lands on the then-current
 *  bottom and hands over to the pinned follow. */
export const SCROLL_GLIDE_MAX_MS = 1500;
/** Floor under the approach speed. A pure exponential never quite arrives —
 *  its last ~30px take another ~450ms of asymptote — so once the fractional
 *  step falls below this rate, the glide moves at this rate instead. Ends
 *  the tail decisively (~30px in under 200ms) without touching the damped
 *  character of the travel, which by then is over. */
export const SCROLL_GLIDE_MIN_SPEED_PX_S = 160;

// NOTE deliberately absent: a per-frame dt clamp. The first version capped dt
// at 50ms "so a starved frame steps rather than teleports", and that clamp WAS
// the user-visible bug on exactly the machines this feature serves (user
// 2026-07-30, second report): on a struggling PC frames run 100ms+ with
// 300–400ms long-task stalls, every one of them counted as 50ms, so the glide
// fell behind the wall clock and its tail crept on for SECONDS after it looked
// landed — measured at 6× throttle: still 192px short at t=3s, last movement
// at t≈4s. The exponential form needs no clamp: `1 − exp(−dt/tau)` < 1 for any
// dt, so a huge frame (a stall, a background-tab return) is not an unstable
// teleport — it lands the glide exactly where the wall clock says it should
// be, which for a scroll-to-bottom is precisely right.

export interface ScrollGlideHandle {
  /** Stop without callbacks — for the owner tearing the glide down
   *  (session switch, a newer glide, unmount). */
  cancel(): void;
}

export function startScrollGlide(
  el: HTMLElement,
  hooks: {
    /** Converged (or capped) AT the live bottom. */
    readonly onDone: () => void;
    /** The reader took the scroller (wheel/touch, or any scroll the loop
     *  didn't write — scrollbar drag, keyboard) — the glide stops where it
     *  is and does NOT re-assert anything. */
    readonly onUserTakeover: () => void;
    /** The runaway cap, default {@link SCROLL_GLIDE_MAX_MS}. The streaming
     *  follow passes Infinity (2026-10-08): it chases a reply that grows a
     *  line at a time for as long as the reply streams, and a cap there
     *  would snap whatever lag it had left, mid-stream. It still ends —
     *  the moment the reply stops growing, it converges. */
    readonly maxMs?: number;
  },
): ScrollGlideHandle {
  const maxMs = hooks.maxMs ?? SCROLL_GLIDE_MAX_MS;
  let raf: number | null = null;
  let last = performance.now();
  const started = last;

  const detach = (): void => {
    el.removeEventListener("wheel", takeover);
    el.removeEventListener("touchstart", takeover);
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  };
  // Any user input hands the scroller back mid-climb. The native smooth
  // scroll did this for free; without it a rAF loop literally fights the
  // reader's wheel, re-approaching the bottom they are scrolling away from.
  function takeover(): void {
    detach();
    hooks.onUserTakeover();
  }
  el.addEventListener("wheel", takeover, { passive: true });
  el.addEventListener("touchstart", takeover, { passive: true });

  // Write-tracking takeover (review 2026-07-31): wheel/touch above catch the
  // inputs that announce themselves, but a scrollbar drag or PgUp/arrow-key
  // scroll fires no wheel event — the loop used to overwrite those
  // frame-by-frame for up to the cap, a visible tug-of-war on the thumb. Any
  // scrollTop this loop did not write is user input (or a clamp from content
  // shrinking under the climb — rewind — where stopping is equally right).
  let lastWritten: number | null = null;

  const step = (now: number): void => {
    raf = null;
    const dt = now - last; // UNCLAMPED — see the note above the constants
    last = now;
    if (lastWritten !== null && Math.abs(el.scrollTop - lastWritten) > 1) {
      takeover();
      return;
    }
    const target = el.scrollHeight - el.clientHeight; // live — see retargeting
    const remaining = target - el.scrollTop;
    const capped = now - started >= maxMs;
    if (Math.abs(remaining) <= SCROLL_GLIDE_SNAP_PX || capped) {
      el.scrollTop = target;
      detach();
      hooks.onDone();
      return;
    }
    // Exponential approach: a fixed FRACTION of what remains per unit time,
    // which is what reads as damping — and is frame-rate independent (the
    // exp() form composes: two 8ms steps equal one 16ms step). The floor
    // takes over once the fraction is slower than a steady crawl, so the
    // asymptote ends instead of trailing off.
    const eased =
      Math.abs(remaining) * (1 - Math.exp(-dt / SCROLL_GLIDE_TAU_MS));
    const floor = (SCROLL_GLIDE_MIN_SPEED_PX_S * dt) / 1000;
    const magnitude = Math.min(Math.abs(remaining), Math.max(eased, floor));
    el.scrollTop = el.scrollTop + Math.sign(remaining) * magnitude;
    // Read back rather than remember the computed value: the browser rounds
    // and clamps the assignment, and the next frame compares against what
    // the scroller actually holds.
    lastWritten = el.scrollTop;
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);

  return { cancel: detach };
}
