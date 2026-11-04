import type { TerminalRecord } from "@herta/app-server";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import { ActivityBlock } from "./ActivityBlock.js";
import { ATTACH_PROGRESS_DEFAULTS } from "./attach-progress.js";
import type { SystemBlock } from "./group-record.js";
import {
  endPendingAttach,
  isAttachHandoff,
  peekPendingAttachForTest,
  pendingAttachIndex,
  reportAttachProgress,
  resetPendingAttachForTest,
  startPendingAttach,
  usePendingAttachRecord,
} from "./pending-attach.js";

afterEach(() => {
  resetPendingAttachForTest();
  vi.useRealTimers();
});

const herta = { kind: "herta", text: "题目发来。" } as TerminalRecord[number];
const realAttach = (name: string): SystemBlock => ({
  kind: "system",
  label: "系统",
  body: `附件 ${name}`,
  digest: {
    kind: "attachment",
    name,
    path: `.herta/attachments/s1/${name}.txt`,
    lines: 120,
    chars: 3400,
    format: "pdf",
    pages: 5,
  },
});

function showPending(names: readonly string[], baseAbs = 1): number {
  const id = startPendingAttach({ sessionId: "s1", names, baseAbs });
  act(() => {
    vi.advanceTimersByTime(ATTACH_PROGRESS_DEFAULTS.showAfterMs);
  });
  return id;
}

describe("the attach in flight as placeholder rows (2026-10-01)", () => {
  it("placeholders join the record once the read outlasts showAfterMs — at its end, for that session only", () => {
    vi.useFakeTimers();
    const record: TerminalRecord = [herta];
    startPendingAttach({ sessionId: "s1", names: ["a.pdf"], baseAbs: 1 });
    const { result, rerender } = renderHook(
      ({ sid }: { sid: string }) => usePendingAttachRecord(sid, record, 0),
      { initialProps: { sid: "s1" } },
    );
    // A quick read never shows a row.
    expect(result.current).toBe(record);
    act(() => {
      vi.advanceTimersByTime(ATTACH_PROGRESS_DEFAULTS.showAfterMs);
    });
    expect(result.current).toHaveLength(2);
    const placeholder = result.current[1] as SystemBlock;
    expect(placeholder.digest).toMatchObject({
      kind: "attachment",
      name: "a.pdf",
    });
    expect(pendingAttachIndex(placeholder)).toBe(0);
    // Another session never sees it.
    rerender({ sid: "s2" });
    expect(result.current).toBe(record);
  });

  it("the real blocks take the placeholders' place, are marked for the hairline's fade, and the attach ends", () => {
    vi.useFakeTimers();
    const id = showPending(["a.pdf"]);
    const { result, rerender } = renderHook(
      ({ rec }: { rec: TerminalRecord }) =>
        usePendingAttachRecord("s1", rec, 0),
      { initialProps: { rec: [herta] as TerminalRecord } },
    );
    expect(result.current).toHaveLength(2);
    const real = realAttach("a.pdf");
    const grown: TerminalRecord = [herta, real];
    rerender({ rec: grown });
    // The record as it is — no placeholder beside the real block.
    expect(result.current).toBe(grown);
    expect(isAttachHandoff(real)).toBe(true);
    act(() => {
      endPendingAttach(id, true);
    });
    expect(peekPendingAttachForTest()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // The fade is a moment, not a state: a later render draws no line.
    expect(isAttachHandoff(real)).toBe(false);
  });

  it("an answered attach waits for its blocks (they come on another channel), then hands off", () => {
    vi.useFakeTimers();
    const id = showPending(["a.pdf"]);
    act(() => {
      endPendingAttach(id, true);
    });
    expect(peekPendingAttachForTest()).not.toBeNull();
    const { result, rerender } = renderHook(
      ({ rec }: { rec: TerminalRecord }) =>
        usePendingAttachRecord("s1", rec, 0),
      { initialProps: { rec: [herta] as TerminalRecord } },
    );
    expect(result.current).toHaveLength(2);
    rerender({ rec: [herta, realAttach("a.pdf")] });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(peekPendingAttachForTest()).toBeNull();
  });

  it("a refusal takes the placeholders down at once; an attach that answered before its row showed just ends", () => {
    vi.useFakeTimers();
    const refused = showPending(["a.pdf"]);
    act(() => {
      endPendingAttach(refused, false);
    });
    expect(peekPendingAttachForTest()).toBeNull();

    const quick = startPendingAttach({
      sessionId: "s1",
      names: ["notes.md"],
      baseAbs: 1,
    });
    act(() => {
      endPendingAttach(quick, true);
    });
    expect(peekPendingAttachForTest()).toBeNull();
  });

  it("a placeholder row shows the file, its count and a hairline that follow main's reports; the real row fades the line", async () => {
    vi.useFakeTimers();
    showPending(["handout.pdf", "notes.md"]);
    const { result } = renderHook(() =>
      usePendingAttachRecord("s1", [herta], 0),
    );
    const placeholders = result.current.slice(1) as SystemBlock[];
    const view = renderWithLocale(
      <ActivityBlock blocks={placeholders} lang="en" />,
    );
    const rows = (): HTMLElement[] => [
      ...view.container.querySelectorAll<HTMLElement>(".activity-step"),
    ];
    expect(rows()).toHaveLength(2);
    expect(rows()[0]?.textContent).toContain("attachment handout.pdf");
    expect(
      view.container.querySelectorAll(".activity-step__progress"),
    ).toHaveLength(2);

    act(() => {
      reportAttachProgress({
        sessionId: "s1",
        index: 0,
        stage: "pages",
        done: 2,
        total: 5,
      });
      reportAttachProgress({
        sessionId: "s1",
        index: 1,
        stage: "pages",
        done: 0,
        total: 0,
      });
      vi.advanceTimersByTime(50);
    });
    const labels = (): string[] =>
      [
        ...view.container.querySelectorAll(".activity-step__progress-label"),
      ].map((e) => e.textContent ?? "");
    expect(labels()).toEqual(["page 3 of 5", "reading"]);
    const fill = view.container.querySelector<HTMLElement>(
      ".activity-step__progress-fill",
    );
    expect(Number.parseFloat(fill?.style.width ?? "0")).toBeGreaterThan(0);

    act(() => {
      reportAttachProgress({
        sessionId: "s1",
        index: 0,
        stage: "transcripts",
        done: 4,
        total: 18,
      });
      vi.advanceTimersByTime(50);
    });
    expect(labels()[0]).toBe("transcribing pictures 4 of 18");

    // The real blocks arrive: same group, rows in their final text, the
    // first row's line fading (it was a placeholder), no live count left.
    const real = [realAttach("handout.pdf"), realAttach("notes.md")];
    const grown = renderHook(() =>
      usePendingAttachRecord("s1", [herta, ...real], 0),
    );
    expect(grown.result.current).toHaveLength(3);
    view.rerender(<ActivityBlock blocks={real} lang="en" />);
    expect(labels()).toEqual([]);
    expect(
      view.container.querySelectorAll(".activity-step__progress.is-finishing"),
    ).toHaveLength(2);
    expect(rows()[0]?.textContent).toContain("5 pages");
  });
});
