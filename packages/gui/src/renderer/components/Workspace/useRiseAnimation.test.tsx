import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { morphFlightActive, resetMorphFlights } from "./morph-flight.js";
import {
  E_OUT_CUBIC,
  easeOutQuart,
  useRiseAnimation,
} from "./useRiseAnimation.js";

/**
 * The element's VISUAL position: base left/top plus the flight's transform
 * displacement. Since 2026-07-30 the flight is a FLIP inversion — the base
 * position is the destination and the travel is a transform — so reading
 * `style.top` alone would report the landing slot on every frame. These
 * helpers keep the assertions about what the user sees.
 */
function translation(el: HTMLElement): { x: number; y: number } {
  const m = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/.exec(
    el.style.transform,
  );
  if (m === null) return { x: 0, y: 0 };
  return {
    x: Number.parseFloat(m[1] ?? "0"),
    y: Number.parseFloat(m[2] ?? "0"),
  };
}
const visualTop = (el: HTMLElement): number =>
  Number.parseFloat(el.style.top || "0") + translation(el).y;
const visualLeft = (el: HTMLElement): number =>
  Number.parseFloat(el.style.left || "0") + translation(el).x;

let now = 0;
let rafCbs: FrameRequestCallback[] = [];
function pump(ms: number): void {
  now += ms;
  const cbs = rafCbs;
  rafCbs = [];
  for (const cb of cbs) cb(now);
}

let api: ReturnType<typeof useRiseAnimation> | null = null;
function Harness(): JSX.Element {
  api = useRiseAnimation();
  return <div />;
}

beforeEach(() => {
  resetMorphFlights();
});

afterEach(() => {
  api = null;
  now = 0;
  rafCbs = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // A leaked flight would hold the aura at its idle cadence for the rest of
  // the app's life, so every test above must close what it opened.
  expect(morphFlightActive()).toBe(false);
});

describe("useRiseAnimation", () => {
  it("interpolates left/top from→to and fires onSettle once at the end", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
    render(<Harness />);
    const el = document.createElement("div");
    const settled = vi.fn();
    act(() => {
      api?.start({
        el,
        from: { left: 0, top: 100 },
        to: { left: 0, top: 20 },
        durationMs: 100,
        easing: (t) => t,
        onSettle: settled,
      });
    });
    act(() => pump(0));
    expect(visualTop(el)).toBe(100);
    expect(el.classList.contains("is-moving")).toBe(true);
    act(() => pump(50));
    expect(visualTop(el)).toBe(60);
    expect(settled).not.toHaveBeenCalled();
    act(() => pump(60));
    expect(visualTop(el)).toBe(20);
    // Landed by DROPPING the transform, not by writing a final position —
    // so the base geometry is the exact destination and the hand-off to the
    // real flow element cannot be a pixel off.
    expect(el.style.transform).toBe("none");
    expect(el.style.top).toBe("20px");
    expect(el.classList.contains("is-settled")).toBe(true);
    expect(el.classList.contains("is-moving")).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("with a cssEasing, a top-anchored flight runs on the COMPOSITOR (WAAPI)", () => {
    // The reason the send morph survives a blocked main thread on a slow PC
    // (user 2026-07-30): the travel is handed to the compositor instead of
    // being stepped by rAF. jsdom has no WAAPI, so the animate() stub records
    // what would have been handed over.
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    const anim = { onfinish: null as null | (() => void), cancel: vi.fn() };
    const animate = vi.fn(() => anim);
    (HTMLElement.prototype as unknown as { animate: unknown }).animate =
      animate;
    try {
      render(<Harness />);
      const el = document.createElement("div");
      const settled = vi.fn();
      act(() => {
        api?.start({
          el,
          from: { left: 10, top: 500 },
          to: { left: 40, top: 100 },
          durationMs: 860,
          easing: (t) => t,
          cssEasing: E_OUT_CUBIC,
          onSettle: settled,
        });
      });
      // Handed over, not stepped: no rAF loop for the travel.
      expect(animate).toHaveBeenCalledTimes(1);
      expect(rafSpy).not.toHaveBeenCalled();
      const [frames, opts] = animate.mock.calls[0] as unknown as [
        Array<{ transform: string }>,
        { duration: number; easing: string; fill: string },
      ];
      // From the displaced start to zero — the destination is the base
      // position, so the animation ends at the identity transform.
      expect(frames[0]?.transform).toBe("translate3d(-30px, 400px, 0)");
      expect(frames[1]?.transform).toBe("translate3d(0px, 0px, 0)");
      expect(opts).toMatchObject({
        duration: 860,
        easing: E_OUT_CUBIC,
        fill: "forwards",
      });
      // Base geometry is the destination from the first frame.
      expect(el.style.left).toBe("40px");
      expect(el.style.top).toBe("100px");
      // The compositor's finish drives the settle.
      expect(settled).not.toHaveBeenCalled();
      act(() => anim.onfinish?.());
      expect(settled).toHaveBeenCalledTimes(1);
      expect(el.style.transform).toBe("none");
      expect(visualLeft(el)).toBe(40);
      expect(visualTop(el)).toBe(100);
    } finally {
      delete (HTMLElement.prototype as unknown as { animate?: unknown })
        .animate;
    }
  });

  it("holds a flight open for the travel only — and closes it BEFORE onSettle", () => {
    // The aura paces itself off this counter while something is flying
    // (morph-flight.ts). Two things have to hold: the window matches the
    // travel, and the close lands before onSettle — the outgoing rise's settle
    // is what starts the incoming one, so closing afterwards would decrement
    // the NEXT flight's count and leave the aura paced forever.
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
    render(<Harness />);
    const el = document.createElement("div");
    let activeAtSettle: boolean | null = null;
    expect(morphFlightActive()).toBe(false);
    act(() => {
      api?.start({
        el,
        from: { left: 0, top: 100 },
        to: { left: 0, top: 20 },
        durationMs: 100,
        easing: (t) => t,
        onSettle: () => {
          activeAtSettle = morphFlightActive();
        },
      });
    });
    expect(morphFlightActive()).toBe(true);
    act(() => pump(50));
    expect(morphFlightActive()).toBe(true);
    act(() => pump(60)); // past the end → finish()
    expect(activeAtSettle).toBe(false);
    expect(morphFlightActive()).toBe(false);
  });

  it("reduced motion opens no flight at all", () => {
    // It never flies, so there is nothing to pace against; opening one here
    // would re-cadence the wave for a morph that does not exist.
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    render(<Harness />);
    act(() => {
      api?.start({
        el: document.createElement("div"),
        from: { left: 0, top: 100 },
        to: { left: 0, top: 20 },
        durationMs: 100,
        easing: (t) => t,
      });
    });
    expect(morphFlightActive()).toBe(false);
  });

  it("restarting mid-flight leaves exactly one flight open, and unmount closes it", () => {
    // start() cancels an in-flight rise first; a naive counter would either
    // double-count the restart or double-close it.
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
    const { unmount } = render(<Harness />);
    const el = document.createElement("div");
    const opts = {
      el,
      from: { left: 0, top: 100 },
      to: { left: 0, top: 20 },
      durationMs: 100,
      easing: (t: number) => t,
    };
    act(() => api?.start(opts));
    act(() => api?.start(opts)); // restart before the first one lands
    expect(morphFlightActive()).toBe(true);
    // One close is enough: the counter is per-hook, not per-start.
    act(() => api?.cancel());
    expect(morphFlightActive()).toBe(false);
    // And an unmount mid-flight cannot leak one.
    act(() => api?.start(opts));
    expect(morphFlightActive()).toBe(true);
    unmount();
    expect(morphFlightActive()).toBe(false);
  });

  it("a mid-flight resize settles the composited flight: animation cancelled BEFORE transform cleared", () => {
    // The regression this pins (review 2026-07-30): the flight runs with
    // `fill: "forwards"`. If finish() ever wrote `transform: none` before
    // cancelling the animation, the fill would override the write and the
    // clone would freeze displaced at `from` forever after a resize — the
    // resize settle exists precisely because the landing slot just moved.
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const order: string[] = [];
    const anim = {
      onfinish: null as null | (() => void),
      cancel: () => order.push("anim.cancel"),
    };
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = () =>
      anim;
    try {
      render(<Harness />);
      const el = document.createElement("div");
      // Record the write order of `transform` relative to the cancel.
      const style = el.style;
      const realSet = style.setProperty.bind(style);
      Object.defineProperty(el, "style", {
        value: new Proxy(style, {
          set(target, prop, value) {
            if (prop === "transform" && value === "none")
              order.push("transform:none");
            return Reflect.set(target, prop, value);
          },
        }),
      });
      void realSet;
      const settled = vi.fn();
      act(() => {
        api?.start({
          el,
          from: { left: 0, top: 500 },
          to: { left: 0, top: 100 },
          durationMs: 860,
          easing: (t) => t,
          cssEasing: E_OUT_CUBIC,
          onSettle: settled,
        });
      });
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      // The settle ran (the slot moved; the real flow element takes over)…
      expect(settled).toHaveBeenCalledTimes(1);
      // …and the animation died before the landing transform was written, so
      // fill:forwards cannot resurrect the displaced position.
      expect(order).toEqual(["anim.cancel", "transform:none"]);
      expect(el.style.transform).toBe("none");
      // The listener is spent: a second resize must not re-settle.
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      expect(settled).toHaveBeenCalledTimes(1);
    } finally {
      delete (HTMLElement.prototype as unknown as { animate?: unknown })
        .animate;
    }
  });

  it("cancel() kills a composited flight without firing its settle", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const anim = { onfinish: null as null | (() => void), cancel: vi.fn() };
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = () =>
      anim;
    try {
      render(<Harness />);
      const el = document.createElement("div");
      const settled = vi.fn();
      act(() => {
        api?.start({
          el,
          from: { left: 0, top: 500 },
          to: { left: 0, top: 100 },
          durationMs: 860,
          easing: (t) => t,
          cssEasing: E_OUT_CUBIC,
          onSettle: settled,
        });
      });
      act(() => api?.cancel());
      expect(anim.cancel).toHaveBeenCalledTimes(1);
      // Detached first: a cancelled flight must not commit the turn's
      // hand-off (the settle un-hides the real bubble).
      expect(anim.onfinish).toBeNull();
      expect(settled).not.toHaveBeenCalled();
    } finally {
      delete (HTMLElement.prototype as unknown as { animate?: unknown })
        .animate;
    }
  });

  it("under reduced motion, places at target instantly and settles without rAF", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    render(<Harness />);
    const el = document.createElement("div");
    const settled = vi.fn();
    act(() => {
      api?.start({
        el,
        from: { left: 0, top: 100 },
        to: { left: 5, top: 20 },
        durationMs: 100,
        easing: (t) => t,
        onSettle: settled,
      });
    });
    expect(el.style.left).toBe("5px");
    expect(el.style.top).toBe("20px");
    expect(el.style.transform).toBe("none");
    expect(el.classList.contains("is-settled")).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(rafSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// anchor: "bottom" tests
// ---------------------------------------------------------------------------

function mockRafWithClock(): void {
  let rafNow = 0;
  // Map rAF handle → setTimeout handle so cancelAnimationFrame can clear the
  // right timer without confusing vitest's fake-timer type tracking.
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  let nextHandle = 1;
  vi.spyOn(performance, "now").mockImplementation(() => rafNow);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    const handle = nextHandle++;
    const tid = setTimeout(() => {
      handles.delete(handle);
      rafNow += 16;
      cb(rafNow);
    }, 16);
    handles.set(handle, tid);
    return handle;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
    const tid = handles.get(handle);
    if (tid !== undefined) {
      clearTimeout(tid);
      handles.delete(handle);
    }
  });
}

function makeGrowingEl(initialHeight: number): {
  el: HTMLElement;
  setHeight: (h: number) => void;
} {
  const el = document.createElement("div");
  let h = initialHeight;
  Object.defineProperty(el, "offsetHeight", { get: () => h });
  return {
    el,
    setHeight: (next: number) => {
      h = next;
    },
  };
}

describe("useRiseAnimation anchor: bottom", () => {
  it("keeps the bottom edge on the eased path while height growth extends the top", () => {
    vi.useFakeTimers();
    mockRafWithClock();
    const { result } = renderHook(() => useRiseAnimation());
    const { el, setHeight } = makeGrowingEl(40);
    // Geometry: start bottom 540 (top 500 + h 40), slot at top 100.
    result.current.start({
      el,
      from: { left: 50, top: 500 },
      to: { left: 50, top: 100 },
      durationMs: 320,
      easing: easeOutQuart,
      anchor: "bottom",
    });
    const startBottom = 540;
    let lastBottom = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 25; i++) {
      if (i === 5) setHeight(120); // the bubble grows mid-flight — BEFORE the frame sees it
      act(() => {
        vi.advanceTimersByTime(16);
      });
      const top = Math.round(visualTop(el));
      const h = el.offsetHeight;
      const bottom = top + h;
      const targetBottom = 100 + h;
      // Bottom never drops below the worse of start/target paths (+1px slack):
      // growth must extend the TOP, not the bottom.
      expect(bottom).toBeLessThanOrEqual(
        Math.max(startBottom, targetBottom) + 1,
      );
      // Descends monotonically toward the slot, never back down.
      expect(bottom).toBeLessThanOrEqual(lastBottom + 1);
      lastBottom = bottom;
    }
    // Settled: top lands exactly on the slot.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(visualTop(el)).toBe(100);
    expect(el.classList.contains("is-settled")).toBe(true);
  });

  it("growth past the rise distance extends the bubble DOWN from its slot — never up over the row above it (2026-10-07)", () => {
    // Owner 2026-10-07: a reply that started right under the 板砖 row filled
    // several lines in flight, and the bottom-held clone grew straight up over
    // that row. Above the slot is the previous row; the top stops there, and
    // the rest of the growth extends the bottom, as the real bubble's does.
    vi.useFakeTimers();
    mockRafWithClock();
    const { result } = renderHook(() => useRiseAnimation());
    const { el, setHeight } = makeGrowingEl(40);
    const fromTop = 160;
    const toTop = 100;
    const startBottom = fromTop + 40; // 200
    result.current.start({
      el,
      from: { left: 0, top: fromTop },
      to: { left: 0, top: toTop },
      durationMs: 320,
      easing: easeOutQuart,
      anchor: "bottom",
    });
    const tops: number[] = [];
    for (let i = 0; i < 30; i++) {
      if (i === 3) setHeight(300); // big chunk lands BEFORE this frame runs
      act(() => {
        vi.advanceTimersByTime(16);
      });
      const top = Math.round(visualTop(el));
      tops.push(top);
      // Never above the slot — the row above it is not the clone's to cover.
      expect(top).toBeGreaterThanOrEqual(toTop);
      // Still no composer invasion beyond where the real bubble rests.
      expect(top + el.offsetHeight).toBeLessThanOrEqual(
        Math.max(startBottom, toTop + el.offsetHeight) + 1,
      );
    }
    // Rising only: no frame moves back down, so nothing snaps at the settle.
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i]).toBeLessThanOrEqual(tops[i - 1] ?? Number.NaN);
    }
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(visualTop(el)).toBe(toTop);
  });

  it("liveTo: aims at the slot where it IS, lands there, and stays on it until cancel (2026-10-07)", () => {
    // The conversation's follow now runs under the incoming flight, so a reply
    // that starts at a full pane scrolls its slot up line by line. The clone
    // re-reads the slot every frame — through the hand-off hold too.
    vi.useFakeTimers();
    mockRafWithClock();
    const { result } = renderHook(() => useRiseAnimation());
    const { el, setHeight } = makeGrowingEl(40);
    const settled = vi.fn();
    let slot: number | null = 300;
    result.current.start({
      el,
      from: { left: 0, top: 500 },
      to: { left: 0, top: 300 },
      durationMs: 160,
      easing: easeOutQuart,
      anchor: "bottom",
      liveTo: () => (slot === null ? null : { left: 0, top: slot }),
      onSettle: settled,
    });
    act(() => {
      vi.advanceTimersByTime(48);
    });
    // A line lands and the follow lifts the slot by it.
    setHeight(66);
    slot = 274;
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(Math.round(visualTop(el))).toBeGreaterThanOrEqual(274);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(visualTop(el)).toBe(274); // landed where the slot is, not at `to`
    // The hold: another line, another lift — the parked clone follows.
    slot = 248;
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(visualTop(el)).toBe(248);
    // The slot unmounting (null) keeps the last good answer.
    slot = null;
    act(() => {
      vi.advanceTimersByTime(16);
    });
    expect(visualTop(el)).toBe(248);
    // The hand-off cancels; nothing moves the clone after it.
    act(() => result.current.cancel());
    slot = 100;
    act(() => {
      vi.advanceTimersByTime(64);
    });
    expect(visualTop(el)).toBe(248);
  });

  it("default anchor (top) behavior is unchanged", () => {
    vi.useFakeTimers();
    mockRafWithClock();
    const { result } = renderHook(() => useRiseAnimation());
    const { el } = makeGrowingEl(40);
    // No cssEasing → the rAF path, which is what this suite drives.
    result.current.start({
      el,
      from: { left: 0, top: 200 },
      to: { left: 0, top: 80 },
      durationMs: 160,
      easing: easeOutQuart,
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(visualTop(el)).toBe(80);
  });

  it("holdSettle parks the flight ON its target until the predicate clears (deferred-fix 2026-07-31)", () => {
    // The incoming rise aims at the POST-climb slot; a fast first token used
    // to end the 760ms flight mid-climb and the settle swap dropped the
    // bubble onto a slot still travelling toward the aimed position.
    vi.useFakeTimers();
    mockRafWithClock();
    const { result } = renderHook(() => useRiseAnimation());
    const { el } = makeGrowingEl(40);
    const settled = vi.fn();
    let gliding = true;
    result.current.start({
      el,
      from: { left: 0, top: 400 },
      to: { left: 0, top: 100 },
      durationMs: 160,
      easing: easeOutQuart,
      anchor: "bottom",
      holdSettle: () => gliding,
      onSettle: settled,
    });
    // Past the natural duration: the flight is parked, not settled.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(settled).not.toHaveBeenCalled();
    expect(visualTop(el)).toBe(100); // exactly on the aimed slot
    expect(el.classList.contains("is-moving")).toBe(true);
    // The climb ends (converge / cap / takeover / cancel path flips it) —
    // the very next frame settles.
    gliding = false;
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(el.style.transform).toBe("none");
    expect(el.classList.contains("is-settled")).toBe(true);
  });

  it("a container WIDTH change settles the flight early; a same-width delivery does not (deferred-fix 2026-07-31)", () => {
    // Sidebar toggle / rail gutter reflows move the slot with no window
    // resize event. Width only: the flow's height grows on every streamed
    // line, and settling on that would kill every flight mid-stream.
    vi.useFakeTimers();
    mockRafWithClock();
    const callbacks: Array<(entries: unknown) => void> = [];
    const observed: Element[] = [];
    class FakeRO {
      constructor(cb: (entries: unknown) => void) {
        callbacks.push(cb);
      }
      observe(t: Element): void {
        observed.push(t);
      }
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeRO);
    const { result } = renderHook(() => useRiseAnimation());
    const { el } = makeGrowingEl(40);
    const flow = document.createElement("div");
    const settled = vi.fn();
    result.current.start({
      el,
      from: { left: 0, top: 400 },
      to: { left: 0, top: 100 },
      durationMs: 800,
      easing: easeOutQuart,
      onSettle: settled,
      watchWidthOf: flow,
    });
    expect(observed).toContain(flow);
    const fire = (width: number): void => {
      for (const cb of callbacks) {
        act(() => cb([{ contentRect: { width } }]));
      }
    };
    // The observer's initial delivery is the baseline — never a settle.
    fire(880);
    expect(settled).not.toHaveBeenCalled();
    // A height-only reflow delivers the same width: still flying.
    fire(880);
    expect(settled).not.toHaveBeenCalled();
    // The gutter eases in mid-flight: the slot moved — settle NOW, the way
    // a window resize does, so the swap lands on fresh layout.
    fire(844);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(el.style.transform).toBe("none");
  });
});
