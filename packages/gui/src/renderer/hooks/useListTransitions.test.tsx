import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useListTransitions } from "./useListTransitions.js";

afterEach(() => {
  vi.useRealTimers();
});

const key = (s: string): string => s;
const OPTS = { leaveMs: 200, enterMs: 300, reduced: false };

describe("useListTransitions (ADR 0058 §5.7)", () => {
  it("the first render is steady; a new row enters, then settles", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) =>
        useListTransitions(items, key, OPTS),
      { initialProps: { items: ["a", "b"] } },
    );
    expect(result.current.map((r) => r.phase)).toEqual(["steady", "steady"]);
    rerender({ items: ["a", "b", "c"] });
    expect(result.current.map((r) => [r.key, r.phase])).toEqual([
      ["a", "steady"],
      ["b", "steady"],
      ["c", "enter"],
    ]);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current[2]?.phase).toBe("steady");
  });

  it("a removed row leaves in place for leaveMs, then drops; coming back cancels the exit", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) =>
        useListTransitions(items, key, OPTS),
      { initialProps: { items: ["a", "b", "c"] } },
    );
    rerender({ items: ["a", "c"] });
    expect(result.current.map((r) => [r.key, r.phase])).toEqual([
      ["a", "steady"],
      ["b", "leave"],
      ["c", "steady"],
    ]);
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(result.current).toHaveLength(3);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.map((r) => r.key)).toEqual(["a", "c"]);

    // Remove again, then restore before the exit ends: no drop.
    rerender({ items: ["a"] });
    expect(result.current[1]?.phase).toBe("leave");
    rerender({ items: ["a", "c"] });
    expect(result.current.map((r) => [r.key, r.phase])).toEqual([
      ["a", "steady"],
      ["c", "enter"],
    ]);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.map((r) => r.key)).toEqual(["a", "c"]);
  });

  it("a row that leaves inside its entrance gets its exit; one that returns inside its exit gets its entrance (2026-09-10)", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) =>
        useListTransitions(items, key, OPTS),
      { initialProps: { items: ["a"] } },
    );
    // Enters, then leaves 100 ms in: the exit is armed and drops the row
    // after leaveMs — the stale entrance timer settles nothing.
    rerender({ items: ["a", "b"] });
    expect(result.current[1]?.phase).toBe("enter");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ items: ["a"] });
    expect(result.current.map((r) => [r.key, r.phase])).toEqual([
      ["a", "steady"],
      ["b", "leave"],
    ]);
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(result.current.map((r) => r.key)).toEqual(["a", "b"]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.map((r) => r.key)).toEqual(["a"]);
    // Leaves, then returns 100 ms in: enters, and settles after enterMs —
    // the stale exit timer drops nothing.
    rerender({ items: ["a", "c"] });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    rerender({ items: ["a"] });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ items: ["a", "c"] });
    expect(result.current.map((r) => [r.key, r.phase])).toEqual([
      ["a", "steady"],
      ["c", "enter"],
    ]);
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current[1]?.phase).toBe("enter");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.map((r) => [r.key, r.phase])).toEqual([
      ["a", "steady"],
      ["c", "steady"],
    ]);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.map((r) => r.key)).toEqual(["a", "c"]);
  });

  it("reduced motion: rows appear and vanish in place, no phases", () => {
    const { result, rerender } = renderHook(
      ({ items }: { items: readonly string[] }) =>
        useListTransitions(items, key, { ...OPTS, reduced: true }),
      { initialProps: { items: ["a"] } },
    );
    rerender({ items: ["b"] });
    expect(result.current.map((r) => [r.key, r.phase])).toEqual([
      ["b", "steady"],
    ]);
  });
});
