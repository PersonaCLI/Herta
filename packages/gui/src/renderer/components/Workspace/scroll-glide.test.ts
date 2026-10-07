import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SCROLL_GLIDE_MAX_MS,
  SCROLL_GLIDE_SNAP_PX,
  type ScrollGlideHandle,
  startScrollGlide,
} from "./scroll-glide.js";

let now = 0;
let nextRaf = 1;
let rafCbs = new Map<number, FrameRequestCallback>();
function pump(ms: number): void {
  now += ms;
  const cbs = [...rafCbs.values()];
  rafCbs = new Map();
  for (const cb of cbs) cb(now);
}

/** A scroller the glide can drive in jsdom: writable scrollTop, mutable
 *  scrollHeight, fixed viewport. A real div, so the wheel/touch listeners
 *  attach for real. */
function makeScroller(scrollHeight: number, clientHeight = 800) {
  const el = document.createElement("div");
  let top = 0;
  let height = scrollHeight;
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = v;
    },
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    get: () => clientHeight,
    configurable: true,
  });
  Object.defineProperty(el, "scrollHeight", {
    get: () => height,
    configurable: true,
  });
  return {
    el,
    grow: (px: number) => {
      height += px;
    },
    top: () => top,
    bottom: () => height - clientHeight,
  };
}

function start(el: HTMLElement): {
  handle: ScrollGlideHandle;
  done: ReturnType<typeof vi.fn>;
  takeover: ReturnType<typeof vi.fn>;
} {
  const done = vi.fn();
  const takeover = vi.fn();
  const handle = startScrollGlide(el, {
    onDone: done,
    onUserTakeover: takeover,
  });
  return { handle, done, takeover };
}

afterEach(() => {
  now = 0;
  nextRaf = 1;
  rafCbs = new Map();
  vi.restoreAllMocks();
});

function mockClock(): void {
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    const id = nextRaf++;
    rafCbs.set(id, cb);
    return id;
  });
  // A REAL cancel — a no-op stub here let cancelled glides keep stepping and
  // failed the cancel/takeover tests for the wrong reason (first draft).
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    rafCbs.delete(id);
  });
}

/** Pump frames until the glide reports done (bounded), returning the step
 *  sizes. Convergence to within SNAP of a ~2200px travel takes
 *  tau·ln(2200) ≈ 1s of clock — more frames than a first guess suggests. */
function pumpUntilDone(
  done: ReturnType<typeof vi.fn>,
  top: () => number,
  frameMs = 16,
): number[] {
  const steps: number[] = [];
  let prev = top();
  for (let i = 0; i < 200 && done.mock.calls.length === 0; i++) {
    pump(frameMs);
    steps.push(top() - prev);
    prev = top();
  }
  return steps;
}

describe("startScrollGlide", () => {
  it("approaches the bottom monotonically with SHRINKING steps — damped, not linear", () => {
    // The user-facing point (2026-07-30): the native smooth scroll spends a
    // pane-sized move at roughly constant speed. This must decelerate.
    mockClock();
    const s = makeScroller(3000);
    const { done } = start(s.el);
    const steps = pumpUntilDone(done, () => s.top());
    expect(done).toHaveBeenCalledTimes(1);
    expect(s.top()).toBe(s.bottom());
    // Every step forward, none backward…
    for (const d of steps) expect(d).toBeGreaterThanOrEqual(0);
    // …and each visible step no larger than the one before (damping). The
    // final ≤SNAP_PX snap onto the exact bottom and the trailing zero-steps
    // are excluded: the snap is bookkeeping, not motion the eye can rank.
    const moving = steps.filter((d) => d > SCROLL_GLIDE_SNAP_PX);
    for (let i = 1; i < moving.length; i++) {
      expect(moving[i]).toBeLessThanOrEqual((moving[i - 1] ?? 0) + 0.001);
    }
    // And it is decisively front-loaded: the first quarter of the frames
    // covers most of the distance.
    const q = Math.ceil(moving.length / 4);
    const firstQuarter = moving.slice(0, q).reduce((a, b) => a + b, 0);
    expect(firstQuarter).toBeGreaterThan(s.bottom() * 0.6);
  });

  it("RETARGETS: content landing mid-climb moves the goal, and the glide lands on the new bottom", () => {
    // The native scroll aims once and lands short — the failure the
    // GLIDE_WINDOW_MS re-assert existed to paper over.
    mockClock();
    const s = makeScroller(3000);
    const { done } = start(s.el);
    pump(16);
    pump(16);
    s.grow(400);
    pumpUntilDone(done, () => s.top());
    expect(done).toHaveBeenCalledTimes(1);
    expect(s.top()).toBe(s.bottom()); // the GROWN bottom
  });

  it("caps a chase it can never win and lands on the then-current bottom", () => {
    // A stream appending every frame outruns the approach; at the cap the
    // glide concedes, snaps to wherever the bottom is, and hands over.
    mockClock();
    const s = makeScroller(3000);
    const { done } = start(s.el);
    const frames = Math.ceil(SCROLL_GLIDE_MAX_MS / 16) + 2;
    for (let i = 0; i < frames && done.mock.calls.length === 0; i++) {
      s.grow(40); // faster than the tail of the approach
      pump(16);
    }
    expect(done).toHaveBeenCalledTimes(1);
    expect(Math.abs(s.top() - s.bottom())).toBeLessThanOrEqual(
      SCROLL_GLIDE_SNAP_PX,
    );
  });

  it("maxMs Infinity never concedes mid-chase — it ends when the growth does (the streaming follow, 2026-10-08)", () => {
    // A cap there would snap whatever lag was left, mid-reply: the step
    // the follow's glide exists to remove.
    mockClock();
    const s = makeScroller(3000);
    s.el.scrollTop = s.bottom();
    const done = vi.fn();
    startScrollGlide(s.el, {
      onDone: done,
      onUserTakeover: vi.fn(),
      maxMs: Number.POSITIVE_INFINITY,
    });
    const steps: number[] = [];
    // A line every ~150ms for three caps' worth of clock.
    const frames = Math.ceil((3 * SCROLL_GLIDE_MAX_MS) / 16);
    for (let i = 0; i < frames; i++) {
      if (i % 9 === 0) s.grow(26);
      const before = s.top();
      pump(16);
      steps.push(s.top() - before);
    }
    expect(done).not.toHaveBeenCalled();
    // Never a line-sized jump: the largest step is a fraction of a line.
    expect(Math.max(...steps)).toBeLessThan(13);
    // Growth stops — the glide lands on the bottom and ends.
    pumpUntilDone(done, s.top);
    expect(done).toHaveBeenCalledTimes(1);
    expect(s.top()).toBe(s.bottom());
  });

  it("a wheel hands the scroller back: stops where it is, no onDone, no re-assert", () => {
    mockClock();
    const s = makeScroller(3000);
    const { done, takeover } = start(s.el);
    pump(16);
    const mid = s.top();
    expect(mid).toBeGreaterThan(0);
    s.el.dispatchEvent(new Event("wheel"));
    expect(takeover).toHaveBeenCalledTimes(1);
    pump(16);
    pump(16);
    expect(s.top()).toBe(mid); // not another pixel
    expect(done).not.toHaveBeenCalled();
  });

  it("a scrollbar drag hands the scroller back too — any scroll the loop didn't write (review 2026-07-31)", () => {
    // A drag on the 10px scrollbar (or PgUp/arrow keys) fires no wheel
    // event; pre-fix the loop overwrote the reader's position frame by
    // frame for up to the cap — a visible tug-of-war on the thumb.
    mockClock();
    const s = makeScroller(3000);
    const { done, takeover } = start(s.el);
    pump(16);
    expect(s.top()).toBeGreaterThan(0);
    // The reader drags the thumb back up between frames.
    s.el.scrollTop = 40;
    pump(16);
    expect(takeover).toHaveBeenCalledTimes(1);
    pump(16);
    expect(s.top()).toBe(40); // not fought — left exactly where they put it
    expect(done).not.toHaveBeenCalled();
  });

  it("cancel() stops it cold with no callbacks", () => {
    mockClock();
    const s = makeScroller(3000);
    const { handle, done, takeover } = start(s.el);
    pump(16);
    const mid = s.top();
    handle.cancel();
    pump(16);
    expect(s.top()).toBe(mid);
    expect(done).not.toHaveBeenCalled();
    expect(takeover).not.toHaveBeenCalled();
  });

  it("frame-rate independent: 120Hz and 30Hz land within a pixel of each other over the same wall clock", () => {
    // The exp() form composes across frame sizes — the property that keeps
    // the FEEL identical on a 165Hz panel and a struggling low-config PC.
    mockClock();
    const a = makeScroller(3000);
    start(a.el);
    for (let i = 0; i < 60; i++) pump(8); // 480ms at 120Hz
    const at120 = a.top();
    now = 0;
    rafCbs = new Map();
    const b = makeScroller(3000);
    start(b.el);
    for (let i = 0; i < 15; i++) pump(32); // 480ms at ~30Hz
    expect(Math.abs(b.top() - at120)).toBeLessThanOrEqual(1);
  });

  it("a long-task stall costs no wall-clock: the next frame lands where smooth frames would have", () => {
    // The user's second report (2026-07-30): on a struggling machine the tail
    // crept for SECONDS after the climb looked landed. Cause: the first
    // version clamped dt at 50ms, so a 400ms stall advanced the glide as if
    // only 50ms had passed — the glide fell behind the wall clock, frame
    // after frame. Unclamped, a stall frame steps by the TRUE elapsed time.
    mockClock();
    const smooth = makeScroller(3000);
    start(smooth.el);
    for (let i = 0; i < 30; i++) pump(16); // 480ms, healthy
    const healthy = smooth.top();
    now = 0;
    rafCbs = new Map();
    const janky = makeScroller(3000);
    start(janky.el);
    for (let i = 0; i < 5; i++) pump(16); // 80ms healthy…
    pump(400); // …one long-task stall…
    // …and the wall clock now reads 480ms, same as the smooth run.
    expect(Math.abs(janky.top() - healthy)).toBeLessThanOrEqual(1);
  });

  it("the speed floor ends the tail instead of letting it trail off", () => {
    // A pure exponential's last ~30px take another ~450ms of asymptote —
    // half of the "still moving" feeling even on a healthy machine. Below
    // the floor rate the glide moves at the floor, so the tail is bounded.
    mockClock();
    const s = makeScroller(3000);
    const { done } = start(s.el);
    // Run to within ~40px of the bottom.
    while (s.bottom() - s.top() > 40 && done.mock.calls.length === 0) pump(16);
    const tailStart = now;
    pumpUntilDone(done, () => s.top());
    expect(done).toHaveBeenCalledTimes(1);
    // 40px at ≥160px/s → ≤250ms, plus a frame of slack. The unfloored
    // asymptote took ~480ms from here (130·ln(40)).
    expect(now - tailStart).toBeLessThanOrEqual(300);
  });
});
