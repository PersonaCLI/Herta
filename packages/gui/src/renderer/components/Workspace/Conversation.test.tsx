import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App.js";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { mockRecord } from "../../mocks/record.js";
import { Composer } from "./Composer.js";
import {
  Conversation,
  GALAXY_APPEAR_DELAY_MS,
  IN_FLIGHT_EXIT_MS,
  IN_FLIGHT_MIN_VISIBLE_MS,
  SUPERVISOR_HINT_DELAY_MS,
  UNPINNED_TRIM_AT,
  UNPINNED_TRIM_KEEP_TAIL,
} from "./Conversation.js";
import { SCROLL_GLIDE_MAX_MS } from "./scroll-glide.js";
import { HEADROOM_GAP_PX } from "./turn-headroom.js";
import { RETRACT_HOLD_MS, shrinkDelayMs } from "./useRetractMorph.js";
import { useWorkspaceRefs, WorkspaceRefsProvider } from "./WorkspaceRefs.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Type into the rendered Composer and submit — the real send path (the
 *  optimistic echo + bridge.submitText), which is what arms the in-flight
 *  row. Call inside act(). */
function sendViaComposer(text: string): void {
  const input = screen.getByPlaceholderText(
    "Message Herta…",
  ) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
}

/** Ms from the retract rising edge to just past the `n`-th erase deletion:
 *  the hold beat + the cumulative ramped per-char delays (mirrors the morph). */
function eraseMs(n: number): number {
  let ms = RETRACT_HOLD_MS;
  for (let k = 0; k < n; k += 1) ms += shrinkDelayMs(k);
  return ms + 5;
}

describe("Conversation", () => {
  it("renders the today-1 mock record + galaxy-travel row (thinking status)", () => {
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    // Populate the store with the mock record and put the session into
    // "thinking" status (turn started but no delta yet).
    act(() => {
      mock.emitReset({
        sessionId: "today-1",
        workspaceRoot: "/repo",
        record: mockRecord,
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    expect(
      screen.getByText(/Can you analyze the latest discovery/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/quantum fluctuations consistent with/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/What are the potential implications/),
    ).toBeInTheDocument();
    // The galaxy appears after a short grace (so a recap could preempt it).
    act(() => {
      vi.advanceTimersByTime(GALAXY_APPEAR_DELAY_MS);
    });
    expect(
      screen.getByText("Message is crossing the galaxy…"),
    ).toBeInTheDocument();
  });

  it("hides the galaxy-travel row once the backend (板砖) goes active", () => {
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "fix the parser @板砖" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" }); // status → thinking
    });
    act(() => {
      vi.advanceTimersByTime(GALAXY_APPEAR_DELAY_MS);
    });
    // Before any backend work, the galaxy is the normal "waiting for Herta" row.
    expect(
      screen.getByText("Message is crossing the galaxy…"),
    ).toBeInTheDocument();
    act(() => {
      // Backend turn.started → backendActive = true (status is still "thinking",
      // no actor delta yet — the real delegation flow, see the pending-activity
      // test below). The galaxy used to linger here until Herta's verdict.
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "turn.started",
          layer: "backend",
          userText: "",
        } as never,
      });
    });
    // It does NOT vanish on the spot: a dispatch that lands this fast used to
    // flash the row for a fraction of a second, which reads as a glitch rather
    // than as a message (user 2026-07-30). It holds its minimum first…
    expect(
      screen.getByText("Message is crossing the galaxy…"),
    ).toBeInTheDocument();
    // …and while it holds, the 处理中… placeholder defers — mounting under the
    // held galaxy shoved it down, then let it slide back up when the hold
    // expired (user 2026-07-31). The two swap in place instead.
    expect(screen.queryByTestId("pending-activity")).not.toBeInTheDocument();
    // …and then leaves through its exit fade (user 2026-07-31: the swap to
    // 处理中 was a hard same-commit switch): after the minimum the row is
    // still mounted, fading, and 处理中 still defers so the two never stack…
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_MIN_VISIBLE_MS);
    });
    const fading = screen.getByText("Message is crossing the galaxy…");
    expect(fading.closest(".status-row")?.className).toContain("is-exiting");
    expect(screen.queryByTestId("pending-activity")).not.toBeInTheDocument();
    // …and only once the fade completes do they hand off in place — without
    // waiting for Herta's verdict, the thing this test was written for.
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_EXIT_MS);
    });
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("pending-activity")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("the backend starting keeps the SAME galaxy row mounted — no unmount/remount, no replayed entrance (2026-08-17)", () => {
    // Live CDP mutation timeline of a user-typed @板砖 turn: `galaxy UNMOUNT
    // + 处理中 MOUNT` at 1149 ms, then `处理中 UNMOUNT + galaxy MOUNT →
    // is-shown` at 1167 ms — the hold flag flipped in an EFFECT one commit
    // after the hide render, and in that commit the row was down. The row
    // fading in from zero a second time (with 处理中 blinking underneath) was
    // the owner's "flashed twice before the 板砖 row". act() flushes that
    // intermediate commit, so the pin is DOM identity: the element the user
    // was looking at must be the element still there afterwards.
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "@板砖 fix the parser" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    act(() => {
      vi.advanceTimersByTime(GALAXY_APPEAR_DELAY_MS);
    });
    const before = screen
      .getByText("Message is crossing the galaxy…")
      .closest(".status-row");
    expect(before).not.toBeNull();
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "turn.started",
          layer: "backend",
          userText: "",
        } as never,
      });
    });
    const after = screen
      .getByText("Message is crossing the galaxy…")
      .closest(".status-row");
    expect(after).toBe(before);
    expect(after?.className).not.toContain("is-exiting");
    // The same node then leaves through its fade, in place.
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_MIN_VISIBLE_MS);
    });
    const fading = screen
      .getByText("Message is crossing the galaxy…")
      .closest(".status-row");
    expect(fading).toBe(before);
    expect(fading?.className).toContain("is-exiting");
    vi.useRealTimers();
  });

  it("a fast dispatch turn: galaxy → (stream waits) → speech commits → 处理中 — one continuous row, no re-show", () => {
    // Fast @板砖 dispatch (user 2026-07-31): Herta's short dispatch speech,
    // its commit and the bridge start all land inside IN_FLIGHT_MIN_VISIBLE_MS.
    // The row used to go down for the stream and then FLASH BACK above the
    // freshly mounted 处理中… (a zombie hold). Now the stream waits out the
    // row; the row's single hold covers speech → commit → bridge; and 处理中
    // takes over only once the row has left. Nothing re-shows.
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "fix the parser @板砖" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    act(() => {
      vi.advanceTimersByTime(GALAXY_APPEAR_DELAY_MS);
    });
    const row = screen
      .getByText("Message is crossing the galaxy…")
      .closest(".status-row");
    // Herta's dispatch line starts streaming well inside the minimum — the
    // row stays (its hold), the bubble waits…
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "板砖，上。",
        } as never,
      });
    });
    expect(
      screen
        .getByText("Message is crossing the galaxy…")
        .closest(".status-row"),
    ).toBe(row);
    expect(screen.queryByTestId("streaming-bubble")).not.toBeInTheDocument();
    // …the speech commits (the stream clears — the wait-is-on predicate is
    // true again for a moment): still the same row, still up…
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b1",
        block: { kind: "herta", surface: "speech", text: "板砖，上。" },
      });
    });
    expect(
      screen
        .getByText("Message is crossing the galaxy…")
        .closest(".status-row"),
    ).toBe(row);
    // …the bridge starts: 处理中 defers behind the row…
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "turn.started",
          layer: "backend",
          userText: "",
        } as never,
      });
    });
    expect(
      screen
        .getByText("Message is crossing the galaxy…")
        .closest(".status-row"),
    ).toBe(row);
    expect(screen.queryByTestId("pending-activity")).not.toBeInTheDocument();
    // …the minimum runs out → the fade → 处理中 alone. Never a re-show.
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_MIN_VISIBLE_MS);
    });
    expect(row?.className).toContain("is-exiting");
    expect(screen.queryByTestId("pending-activity")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_EXIT_MS);
    });
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("pending-activity")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_MIN_VISIBLE_MS);
    });
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("a turn FAILURE inside the minimum: the row keeps its time, fades, THEN the notice — never stacked", () => {
    // The 2026-07-31 review's complaint was the two on screen together (the
    // held galaxy directly above "the reply was lost", then yanked up). The
    // owner's 2026-08-17 rule keeps the row's minimum for failures too — the
    // message went out, the reply was lost — so the notice now defers behind
    // the row exactly like 处理中 does. Same invariant, opposite mechanism.
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "hi" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    act(() => {
      vi.advanceTimersByTime(GALAXY_APPEAR_DELAY_MS);
    });
    expect(
      screen.getByText("Message is crossing the galaxy…"),
    ).toBeInTheDocument();
    // The provider dies well inside the minimum: the row stays, the notice
    // waits.
    act(() => {
      mock.emitTurn({
        kind: "failed",
        turnId: "t1",
        error: { code: "actor_failed", message: "boom" },
      });
    });
    expect(screen.queryByTestId("turn-failed-row")).not.toBeInTheDocument();
    expect(
      screen.getByText("Message is crossing the galaxy…"),
    ).toBeInTheDocument();
    // Minimum → fade (still no notice) → the notice, alone.
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_MIN_VISIBLE_MS);
    });
    expect(
      screen.getByText("Message is crossing the galaxy…").closest(".status-row")
        ?.className,
    ).toContain("is-exiting");
    expect(screen.queryByTestId("turn-failed-row")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_EXIT_MS);
    });
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("turn-failed-row")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("a SEND shows the row at the morph's settle regardless of how fast the other side answers (owner 2026-08-17)", () => {
    // Every send travels: the row appears the moment the outgoing bubble
    // lands, even when the backend is already active by then (a fast direct
    // @板砖 turn), and 处理中 waits for it. Before, a wait shorter than the
    // 400 ms appearance grace showed nothing — same turn, some sends showed
    // the row and some did not.
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
          <Composer />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    // The user sends (the optimistic echo is the send edge; jsdom flies no
    // clone, so the "settle" is immediate) and the turn starts…
    act(() => {
      sendViaComposer("@板砖 fix the parser");
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    // …and the backend is active BEFORE any grace could elapse.
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "turn.started",
          layer: "backend",
          userText: "",
        } as never,
      });
    });
    // The row is up anyway; 处理中 defers.
    expect(
      screen.getByText("Message is crossing the galaxy…"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("pending-activity")).not.toBeInTheDocument();
    // It keeps its minimum, fades, and hands off in place.
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_MIN_VISIBLE_MS);
    });
    expect(
      screen.getByText("Message is crossing the galaxy…").closest(".status-row")
        ?.className,
    ).toContain("is-exiting");
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_EXIT_MS);
    });
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("pending-activity")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("a send that never became a turn (no DeepSeek key) shows no row", async () => {
    // The key prompt takes the message: nothing was sent, nothing travels.
    vi.useFakeTimers();
    const mock = createMockHertaBridge({
      submitTextResult: { needsKey: true },
    });
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
          <Composer />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    // submitText resolves { needsKey } → the store hands the text to the
    // prompt (echo withdrawn); no turn ever starts.
    await act(async () => {
      sendViaComposer("hi");
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(GALAXY_APPEAR_DELAY_MS + IN_FLIGHT_MIN_VISIBLE_MS);
    });
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    // And the arm does not leak into a LATER non-send turn's row: the next
    // (opening-style) turn still waits out the appearance grace.
    act(() => {
      mock.emitTurn({ kind: "started", turnId: "t2" });
    });
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(GALAXY_APPEAR_DELAY_MS);
    });
    expect(
      screen.getByText("Message is crossing the galaxy…"),
    ).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("a send whose turn fails while the bubble is still flying: row for its minimum, THEN the notice", () => {
    // A 401/402 comes back in a few hundred ms — before the morph would have
    // settled. The message went out; the row travels; then "the reply was
    // lost". The notice never mounts under a still-flying bubble or a
    // still-showing row.
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
          <Composer />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    act(() => {
      sendViaComposer("hi");
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    act(() => {
      mock.emitTurn({
        kind: "failed",
        turnId: "t1",
        error: { code: "provider_error", message: "402", status: 402 } as never,
      });
    });
    expect(
      screen.getByText("Message is crossing the galaxy…"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("turn-failed-row")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_MIN_VISIBLE_MS);
    });
    expect(screen.queryByTestId("turn-failed-row")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_EXIT_MS);
    });
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("turn-failed-row")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("a session switch ends the hold — the galaxy does not ride into the next session", () => {
    // Class A (2026-07-24 audit): Conversation stays mounted across a
    // switch and inFlightSettled is false on both sides of the reset, so a
    // hold armed by a fast turn-end rendered "crossing the galaxy" at the
    // bottom of a session with nothing in flight, through its entrance
    // cascade, for up to the hold remainder (review 2026-07-31).
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "hi" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    act(() => {
      vi.advanceTimersByTime(GALAXY_APPEAR_DELAY_MS);
    });
    expect(
      screen.getByText("Message is crossing the galaxy…"),
    ).toBeInTheDocument();
    // A fast finish arms the hold (quiet hide) — the row is deliberately
    // still up…
    act(() => {
      mock.emitTurn({ kind: "finished", turnId: "t1" });
    });
    expect(
      screen.getByText("Message is crossing the galaxy…"),
    ).toBeInTheDocument();
    // …but a switch inside the remainder takes it down with the session.
    act(() => {
      mock.emitReset({
        sessionId: "other",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "elsewhere" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    // The armed hold timer still fires in the background — it must not fade
    // a ghost row into the NEW session (the exit phase made a stale fire
    // non-benign; beginExit is guarded by the shown clock, 2026-07-31).
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_MIN_VISIBLE_MS + IN_FLIGHT_EXIT_MS);
    });
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("a stream mid-exit-fade waits for the fade — the bubble mounts in the render the row leaves (never both)", () => {
    // Owner 2026-08-17 ("mimicking sending a message to the space station"):
    // the reply enters AFTER the row's fade instead of cutting it. The
    // 2026-07-10 morph-slot invariant is kept the other way round — the
    // streaming bubble is simply not mounted while the row is on screen, so
    // its rise measures a slot the row has already left.
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "fix the parser @板砖" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    act(() => {
      vi.advanceTimersByTime(GALAXY_APPEAR_DELAY_MS);
    });
    // Quiet hide (backend starts) → hold runs out → the row enters its fade.
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "turn.started",
          layer: "backend",
          userText: "",
        } as never,
      });
    });
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_MIN_VISIBLE_MS);
    });
    expect(
      screen.getByText("Message is crossing the galaxy…").closest(".status-row")
        ?.className,
    ).toContain("is-exiting");
    // A beat's first delta lands mid-fade: the row keeps fading, the bubble
    // waits.
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "嗯",
        } as never,
      });
    });
    expect(
      screen.getByText("Message is crossing the galaxy…").closest(".status-row")
        ?.className,
    ).toContain("is-exiting");
    expect(screen.queryByTestId("streaming-bubble")).not.toBeInTheDocument();
    // The fade ends → the row unmounts and the bubble mounts, same render.
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_EXIT_MS);
    });
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("streaming-bubble")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("a stream inside the minimum waits out the hold, then the fade — the row is never cut short", () => {
    // The row's minimum used to stop at a stream (a fast first token cut it
    // to a sub-second flash — the "quick flash" report class). Now Herta's
    // reply enters after the row has had its time; while it waits, the
    // stream is buffered (status/device state already say "speaking"; only
    // the bubble and its rise wait).
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "hi" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    act(() => {
      vi.advanceTimersByTime(GALAXY_APPEAR_DELAY_MS);
    });
    expect(
      screen.getByText("Message is crossing the galaxy…"),
    ).toBeInTheDocument();
    const row = screen
      .getByText("Message is crossing the galaxy…")
      .closest(".status-row");
    // Herta starts speaking well inside the minimum — the SAME row stays,
    // not fading yet, and the bubble is not mounted.
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "嗯",
        } as never,
      });
    });
    const still = screen
      .getByText("Message is crossing the galaxy…")
      .closest(".status-row");
    expect(still).toBe(row);
    expect(still?.className).not.toContain("is-exiting");
    expect(screen.queryByTestId("streaming-bubble")).not.toBeInTheDocument();
    // Minimum reached → the fade; the bubble still waits…
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_MIN_VISIBLE_MS);
    });
    expect(still?.className).toContain("is-exiting");
    expect(screen.queryByTestId("streaming-bubble")).not.toBeInTheDocument();
    // …and enters as the row leaves.
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_EXIT_MS);
    });
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    // (Mounted; the paced reveal fills it frame by frame — no frames run
    // under fake timers, so the text itself is not asserted here.)
    expect(screen.getByTestId("streaming-bubble")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("leads with the recap-compaction row, then swaps to the galaxy on phase:end", () => {
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "hi" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" }); // status → thinking
    });
    // The shared in-flight indicator is still within its appearance grace —
    // neither row shows yet (it appears only after the send-morph settles).
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Tidying conversation history…"),
    ).not.toBeInTheDocument();
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "recap.compaction",
          layer: "actor",
          phase: "start",
        } as never,
      });
      vi.advanceTimersByTime(GALAXY_APPEAR_DELAY_MS);
    });
    // Once the grace elapses the recap row leads — the galaxy never showed.
    expect(
      screen.getByText("Tidying conversation history…"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "recap.compaction",
          layer: "actor",
          phase: "end",
        } as never,
      });
    });
    // phase:end → the indicator is already settled, so the galaxy takes over
    // immediately (no second grace).
    expect(
      screen.queryByText("Tidying conversation history…"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Message is crossing the galaxy…"),
    ).toBeInTheDocument();
  });

  it("shows the galaxy row during the post-板砖 synthesis wait (stale 'speaking' status — bug 3)", () => {
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
      // Herta speaks the delegation → status becomes (and STAYS) "speaking".
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "看看。",
        } as never,
      });
      // The finalized speech block clears the streaming bubble.
      mock.emitRecord({
        kind: "block",
        blockId: "b1",
        block: { kind: "herta", surface: "speech", text: "看看。" },
      });
      // Backend runs and finishes — now Herta's synthesis completion
      // generates, often the LONGEST silent wait of a delegation turn.
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "turn.started",
          layer: "backend",
          userText: "",
        } as never,
      });
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "turn.finished",
          layer: "backend",
          summary: {
            durationMs: 1,
            toolCallCount: 1,
            messageCount: 1,
            endedAt: "",
          },
        } as never,
      });
    });
    // Pre-fix nothing showed here (the gate required status === "thinking",
    // but the pre-dispatch speech left it "speaking"): a locked composer and
    // silence. Now the shared in-flight indicator returns after its grace.
    act(() => {
      vi.advanceTimersByTime(GALAXY_APPEAR_DELAY_MS);
    });
    expect(
      screen.getByText("Message is crossing the galaxy…"),
    ).toBeInTheDocument();
    // The turn ending hides it — after the minimum-visible hold plus the
    // exit fade, both quiet-hide mechanics like the backend starting
    // (2026-07-30 / 2026-07-31). Two advances: the fade timer is armed by an
    // effect that only flushes when the first act closes.
    act(() => {
      mock.emitTurn({ kind: "finished", turnId: "t1" });
    });
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_MIN_VISIBLE_MS);
    });
    act(() => {
      vi.advanceTimersByTime(IN_FLIGHT_EXIT_MS);
    });
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows the gamma-storm row only when the supervisor judgment outlasts its grace (bug 4)", () => {
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
      // The candidate is streaming (reveal holding its tail)…
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "不要",
        } as never,
      });
      // …and the supervisor starts judging.
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "supervisor.check",
          layer: "actor",
          phase: "start",
        } as never,
      });
    });
    // A quick verdict never flashes the storm (the reveal hasn't stalled
    // past the grace yet — early reveal frames may stamp growth, so probe
    // well inside the window).
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(
      screen.queryByText("Message caught in a gamma storm…"),
    ).not.toBeInTheDocument();
    // The judgment outlasts the stall grace with the reveal fully drained →
    // the hint appears (slack past the boundary: the stall clock counts from
    // the LAST growth frame, not the judgment start).
    act(() => {
      vi.advanceTimersByTime(SUPERVISOR_HINT_DELAY_MS + 1000);
    });
    expect(
      screen.getByText("Message caught in a gamma storm…"),
    ).toBeInTheDocument();
    // The galaxy row never fights it (a live stream suppresses it anyway).
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
    // Verdict lands → the hint clears immediately.
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "supervisor.check",
          layer: "actor",
          phase: "end",
        } as never,
      });
    });
    expect(
      screen.queryByText("Message caught in a gamma storm…"),
    ).not.toBeInTheDocument();
  });

  it("renders nothing but no galaxy-travel for an idle non-today session", () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    // Empty record, idle status (no turn started)
    act(() => {
      mock.emitReset({
        sessionId: "yesterday-1",
        workspaceRoot: "/repo",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(
      screen.queryByText("Message is crossing the galaxy…"),
    ).not.toBeInTheDocument();
  });

  it("swaps to the new session's content on a session switch (entrance effect runs without breaking)", () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s1",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "第一会话的消息" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(screen.getByText("第一会话的消息")).toBeInTheDocument();
    // Switch to a different session: the stagger-entrance layout effect fires
    // (jsdom has no layout, so it measures zero rects and applies no styles) and
    // must not break the swap to the new content.
    act(() => {
      mock.emitReset({
        sessionId: "s2",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "第二会话的消息" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(screen.queryByText("第一会话的消息")).not.toBeInTheDocument();
    expect(screen.getByText("第二会话的消息")).toBeInTheDocument();
  });

  it("renders a streaming bubble from assistant.delta, replaced by the finalized block", () => {
    // The streaming reveal is paced by requestAnimationFrame; run frames
    // synchronously so the full text is revealed within act().
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "hi" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
    });
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "Certain",
        } as never,
      });
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "ly.",
        } as never,
      });
    });
    expect(screen.getByTestId("streaming-bubble").textContent).toContain(
      "Certainly.",
    );
    // Composing caret: present while streaming, so a verdict-gated pacing
    // hold reads as "still composing" instead of the app being stuck.
    expect(
      screen.getByTestId("streaming-bubble").querySelector(".streaming-caret"),
    ).not.toBeNull();
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "h1",
        block: { kind: "herta", surface: "speech", text: "Certainly." },
      });
    });
    expect(screen.queryByTestId("streaming-bubble")).not.toBeInTheDocument();
    // The finalized block carries no caret.
    expect(document.querySelector(".streaming-caret")).toBeNull();
    expect(screen.getByText("Certainly.")).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("shrinks the vetoed bubble only to the retry's common prefix, then continues", () => {
    vi.useFakeTimers();
    // rAF must be ASYNC (setTimeout-backed) so fake timers drive the
    // useRevealedText reveal in lockstep with the morph's intervals — a
    // synchronous cb(0) mock would recurse the reveal loop inside emit.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (cb) => setTimeout(() => cb(0), 16) as unknown as number,
    );
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t-retract" });
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "共享前缀不变XYZ",
        } as never,
      });
    });
    act(() => {
      vi.advanceTimersByTime(500); // reveal the candidate fully
    });
    expect(screen.getByTestId("streaming-bubble").textContent).toBe(
      "共享前缀不变XYZ",
    );
    act(() => {
      mock.emitSpeech({ kind: "retract" });
    });
    // The retry's tokens arrive while the shrink is running, sharing the
    // 6-char prefix 共享前缀不变.
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "共享前缀不变ABC",
        } as never,
      });
    });
    act(() => {
      // Hold beat, then the ramped erase deletes only X,Y,Z (3 chars). The
      // eraseMs margin stays under the fill's first tick (handoff+16ms).
      vi.advanceTimersByTime(eraseMs(3));
    });
    expect(screen.getByTestId("streaming-bubble").textContent).toBe(
      "共享前缀不变",
    );
    act(() => {
      vi.advanceTimersByTime(300); // fill types ABC from the divergence
    });
    expect(screen.getByTestId("streaming-bubble").textContent).toBe(
      "共享前缀不变ABC",
    );
    // The finalized block swap is unchanged.
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "h1",
        block: { kind: "herta", surface: "speech", text: "共享前缀不变ABC" },
      });
    });
    expect(screen.queryByTestId("streaming-bubble")).not.toBeInTheDocument();
    expect(screen.getByText("共享前缀不变ABC")).toBeInTheDocument();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("holds a short beat, then erases the vetoed candidate and refills with the replayed retry", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (cb) => setTimeout(() => cb(0), 16) as unknown as number,
    );
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t-retract" });
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "候选答复",
        } as never,
      });
    });
    act(() => {
      vi.advanceTimersByTime(300); // reveal the candidate
    });
    act(() => {
      mock.emitSpeech({ kind: "retract" });
    });
    // During the short hold beat the candidate stays put (no wipe).
    act(() => {
      vi.advanceTimersByTime(RETRACT_HOLD_MS - 5);
    });
    expect(screen.getByTestId("streaming-bubble").textContent).toBe("候选答复");
    // After the beat the erase runs even with NO retry delta yet (the
    // paced-retry-replay is still generating), but DECELERATING with depth
    // (2026-07-27) so it does not reach empty before the divergence is known —
    // it has visibly moved and still has a tail left.
    act(() => {
      vi.advanceTimersByTime(shrinkDelayMs(0) + shrinkDelayMs(1) + 10);
    });
    const midErase = screen.getByTestId("streaming-bubble").textContent ?? "";
    expect(midErase.length).toBeGreaterThan(0);
    expect(midErase.length).toBeLessThan("候选答复".length);
    expect("候选答复".startsWith(midErase)).toBe(true);
    // The replay finally begins; it shares nothing → the erase returns to full
    // speed, runs out, and the fill types the replacement into the SAME bubble.
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "修订后的答复",
        } as never,
      });
    });
    act(() => {
      vi.advanceTimersByTime(shrinkDelayMs(2) + shrinkDelayMs(3) + 400);
    });
    expect(screen.getByTestId("streaming-bubble").textContent).toBe(
      "修订后的答复",
    );
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * A scroll pane with real (writable) geometry, so the follow can be asserted
   * by WHERE THE VIEW ENDS UP rather than by which API was called.
   *
   * These tests used to spy on `scrollIntoView`. That pinned the mechanism, and
   * the mechanism was the bug (2026-07-30): aligning `endRef` leaves the
   * scroller's bottom padding — the approval reserve — unscrolled, so "the
   * bottom" it reached was short of the real one. The follow writes
   * `scrollHeight - clientHeight` now, and an outcome assertion is both truer
   * and survives the next change of means.
   */
  function fakePane(
    container: HTMLElement,
    opts: { scrollHeight: number; clientHeight: number; scrollTop?: number },
  ): {
    pane: HTMLElement;
    top: () => number;
    bottom: number;
    scrollTo: (px: number) => void;
    /** Pane geometry reads since the last reset — each one is a forced
     *  layout in a real browser, which is what the unpinned reveal path
     *  must not pay (perf 2026-08-25). */
    reads: { scrollHeight: number; clientHeight: number };
    resetReads: () => void;
  } {
    const pane = container.querySelector(".conversation") as HTMLElement;
    let scrollTop = opts.scrollTop ?? 0;
    const reads = { scrollHeight: 0, clientHeight: 0 };
    Object.defineProperty(pane, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
      configurable: true,
    });
    Object.defineProperty(pane, "clientHeight", {
      get: () => {
        reads.clientHeight += 1;
        return opts.clientHeight;
      },
      configurable: true,
    });
    Object.defineProperty(pane, "scrollHeight", {
      get: () => {
        reads.scrollHeight += 1;
        return opts.scrollHeight;
      },
      configurable: true,
    });
    return {
      pane,
      top: () => scrollTop,
      bottom: opts.scrollHeight - opts.clientHeight,
      scrollTo: (px: number) => {
        scrollTop = px;
        fireEvent.scroll(pane);
      },
      reads,
      resetReads: () => {
        reads.scrollHeight = 0;
        reads.clientHeight = 0;
      },
    };
  }

  it("scrolls to the bottom when new content arrives", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const geo = fakePane(container, { scrollHeight: 1000, clientHeight: 100 });
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b1",
        block: { kind: "user", text: "hi" },
      });
    });
    expect(geo.top()).toBe(geo.bottom);
  });

  it("does NOT yank the pane while the user is scrolled up (unpinned)", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "hi" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const geo = fakePane(container, { scrollHeight: 1000, clientHeight: 100 });
    // The user scrolls up: far from the bottom → unpinned.
    act(() => {
      geo.scrollTo(0);
    });
    // New content arrives — the pane must NOT snap back to the bottom.
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b2",
        block: { kind: "herta", surface: "speech", text: "answer" },
      });
    });
    expect(geo.top()).toBe(0);
    // Scrolling back to the bottom re-pins: the next content follows again.
    act(() => {
      geo.scrollTo(geo.bottom);
    });
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b3",
        block: { kind: "user", text: "more" },
      });
    });
    expect(geo.top()).toBe(geo.bottom);
  });

  it("an unpinned follow trigger reads no pane geometry (perf 2026-08-25)", () => {
    // The follow (scrollToEndIfPinned) runs on every reveal growth frame and
    // on every appended block. For an unpinned reader with no reservation
    // armed it moves nothing — yet it used to read scrollHeight+clientHeight
    // for a preBottom the unpinned branch never used: one forced layout per
    // reveal frame, paid for reading history under a streaming reply. The
    // bottom read now travels with the scroll it serves.
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "hi" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const geo = fakePane(container, { scrollHeight: 1000, clientHeight: 100 });
    act(() => {
      geo.scrollTo(0); // unpin (the scroll handler's pin test reads geometry)
    });
    geo.resetReads();
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b2",
        block: { kind: "herta", surface: "speech", text: "answer" },
      });
    });
    expect(geo.reads.scrollHeight).toBe(0);
    expect(geo.reads.clientHeight).toBe(0);
    expect(geo.top()).toBe(0);
    // Anti-vacuous control: the SAME counters do count the pinned follow —
    // the read is skipped with the scroll, not gone.
    act(() => {
      geo.scrollTo(geo.bottom); // re-pin
    });
    geo.resetReads();
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b3",
        block: { kind: "user", text: "more" },
      });
    });
    expect(geo.reads.scrollHeight).toBeGreaterThan(0);
    expect(geo.top()).toBe(geo.bottom);
  });

  it("sending while scrolled up leaves the pane put and lights the chip", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
          <Composer />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "hi" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const geo = fakePane(container, { scrollHeight: 1000, clientHeight: 100 });
    act(() => {
      geo.scrollTo(0); // unpin
    });
    // Sending used to yank the pane to the bottom regardless of the pin. It no
    // longer does (user 2026-08-03): reading history is not interrupted by your
    // own send — the message lands below and the jump chip offers the ride back.
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "question" } });
    const form = container.querySelector("form.composer") as HTMLFormElement;
    act(() => {
      fireEvent.submit(form);
    });
    expect(geo.top()).toBe(0);
    expect(screen.getByText("Back to bottom")).toBeInTheDocument();
  });

  it("scrolls to reveal the 处理中 placeholder when the backend starts", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const geo = fakePane(container, { scrollHeight: 1000, clientHeight: 100 });
    // Backend turn.started flips backendActive → true (mounting the 处理中
    // placeholder) without changing record/status, so the scroll effect must
    // list backendActive as a trigger or the placeholder stays below the fold.
    act(() => {
      mock.emitAgent({
        kind: "agent",
        event: { type: "turn.started", layer: "backend", userText: "" },
      });
    });
    expect(screen.getByTestId("pending-activity")).toBeInTheDocument();
    expect(geo.top()).toBe(geo.bottom);
  });

  it("scrolls to reveal the gamma-storm hold row when it appears (pinned)", () => {
    vi.useFakeTimers();
    // rAF must be async (setTimeout-backed) so fake timers drive the reveal
    // deterministically — the hold row is stall-gated on the reveal's LAST
    // growth frame, so the reveal must fully drain before the window counts.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(
      (cb) => setTimeout(() => cb(0), 16) as unknown as number,
    );
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
      // A short candidate is streaming and the supervisor starts judging.
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "不要",
        } as never,
      });
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "supervisor.check",
          layer: "actor",
          phase: "start",
        } as never,
      });
    });
    // Drain the reveal fully FIRST, so the movement below can only come from
    // the hold row's own scroll trigger (onGrow fires on growth frames and
    // would mask a missing trigger otherwise).
    act(() => {
      vi.advanceTimersByTime(600);
    });
    // Park the view away from the bottom, so the follow has somewhere to go.
    const geo = fakePane(container, {
      scrollHeight: 1000,
      clientHeight: 100,
      scrollTop: 500,
    });
    // The judgment outlasts the stall grace → the hold row mounts — and
    // must scroll itself into view (user bug 2026-07-11: it used to appear
    // below the composer on a full pane).
    act(() => {
      vi.advanceTimersByTime(SUPERVISOR_HINT_DELAY_MS + 1000);
    });
    expect(
      screen.getByText("Message caught in a gamma storm…"),
    ).toBeInTheDocument();
    expect(geo.top()).toBe(geo.bottom);
    vi.useRealTimers();
  });

  it("rewind is bound to the clicked session: a switch during the withdraw animation aborts it", async () => {
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "session-A",
        workspaceRoot: "/r",
        record: [
          { kind: "user", text: "question A" },
          { kind: "herta", surface: "speech", text: "answer A" },
        ],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const rewindBtn = container.querySelector(
      ".message-rewind",
    ) as HTMLButtonElement;
    expect(rewindBtn).not.toBeNull();
    fireEvent.click(rewindBtn); // starts the 220ms withdraw animation
    // The user clicks session B in the sidebar during the animation.
    act(() => {
      mock.emitReset({
        sessionId: "session-B",
        workspaceRoot: "/r",
        record: [
          { kind: "user", text: "question B" },
          { kind: "herta", surface: "speech", text: "answer B" },
        ],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(240);
      await Promise.resolve();
    });
    // The rewind must NOT fire against session B's record.
    expect(mock.calls.rewindLastTurn).toBe(0);
    vi.useRealTimers();
  });

  it("rewind proceeds when the session is unchanged after the animation", async () => {
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "session-A",
        workspaceRoot: "/r",
        record: [
          { kind: "user", text: "question A" },
          { kind: "herta", surface: "speech", text: "answer A" },
        ],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const rewindBtn = container.querySelector(
      ".message-rewind",
    ) as HTMLButtonElement;
    fireEvent.click(rewindBtn);
    await act(async () => {
      vi.advanceTimersByTime(240);
      await Promise.resolve();
    });
    expect(mock.calls.rewindLastTurn).toBe(1);
    vi.useRealTimers();
  });

  it("⟲ sits on the commission, never on a steer inside its run (ADR 0063 §1.10)", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "session-A",
        workspaceRoot: "/r",
        record: [
          { kind: "user", text: "fix the parser" },
          { kind: "herta", surface: "speech", text: "on it" },
          { kind: "user", text: "also rename the test", steer: true },
          { kind: "herta", surface: "speech", text: "noted" },
        ],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const rewinds = container.querySelectorAll(".message-rewind");
    expect(rewinds).toHaveLength(1);
    const row = rewinds[0]?.closest(".message-row");
    expect(row?.textContent).toContain("fix the parser");
    expect(row?.textContent).not.toContain("also rename the test");
  });

  it("rewind restores the draft in the EN display form (@板砖 → @Brick round-trip)", async () => {
    vi.useFakeTimers();
    // The record stores the wire token; the EN user typed/saw @Brick — the
    // restored draft must read as they sent it (the composer's input alias
    // maps it back to @板砖 on re-send, ADR 0015 §3). Bare 板砖 stays.
    const mock = createMockHertaBridge({
      rewindLastTurnResult: {
        ok: true,
        userText: "hand @板砖 the bug; 板砖 is idle",
        editedFiles: false,
        undoable: false,
      },
    });
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
          <Composer />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "session-en",
        workspaceRoot: "/r",
        record: [
          { kind: "user", text: "hand @板砖 the bug; 板砖 is idle" },
          { kind: "herta", surface: "speech", text: "answer" },
        ],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
        lang: "en",
      });
    });
    const rewindBtn = container.querySelector(
      ".message-rewind",
    ) as HTMLButtonElement;
    fireEvent.click(rewindBtn);
    await act(async () => {
      vi.advanceTimersByTime(240);
      await Promise.resolve();
    });
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    expect(input.value).toBe("hand @Brick the bug; 板砖 is idle");
    vi.useRealTimers();
  });

  it("rewind returns the message's PICTURES to the composer strip with the text (owner 2026-08-27)", async () => {
    vi.useFakeTimers();
    // Main restaged the withdrawn images (their copies are on disk, captions
    // paid for) and the result carries them; the draft-adoption effect puts
    // them back in the strip beside the restored text.
    const img = {
      id: "restaged-1",
      name: "shot.png",
      path: ".herta/attachments/s/shot-abc-def.png",
      width: 640,
      height: 480,
    };
    const mock = createMockHertaBridge({
      rewindLastTurnResult: {
        ok: true,
        userText: "看看这张图",
        editedFiles: false,
        images: [img],
        undoable: false,
      },
    });
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
          <Composer />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [
          { kind: "user", text: "看看这张图" },
          { kind: "herta", surface: "speech", text: "answer" },
        ],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    fireEvent.click(
      container.querySelector(".message-rewind") as HTMLButtonElement,
    );
    await act(async () => {
      vi.advanceTimersByTime(240);
      await Promise.resolve();
    });
    // Text AND picture back in the composer.
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    expect(input.value).toBe("看看这张图");
    const thumbs = container.querySelectorAll(".composer-staged__thumb");
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0]?.getAttribute("title")).toBe("shot.png");
    vi.useRealTimers();
  });

  it("does not render a herta block's selfCorrection (veto reason is prompt-only)", () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [
          {
            kind: "herta",
            surface: "speech",
            text: "嗯，重写了。",
            selfCorrection: "不该跟着叫瓦尔特杨叔",
          },
        ],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(screen.getByText("嗯，重写了。")).toBeInTheDocument();
    expect(screen.queryByText("不该跟着叫瓦尔特杨叔")).not.toBeInTheDocument();
  });

  it("optimistically shows the user's message on send, before the turn responds", () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
          <Composer />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "你好呀 黑塔" } });
    act(() => {
      fireEvent.submit(input.closest("form") as HTMLFormElement);
    });
    // The message renders immediately from the optimistic echo — no turn
    // lifecycle / record events have been emitted yet.
    expect(screen.getByText("你好呀 黑塔")).toBeInTheDocument();
    expect(mock.calls.submitText).toContain("你好呀 黑塔");
  });

  it("renders a backend run as one activity block", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitRecord({
        kind: "block",
        blockId: "1",
        block: { kind: "user", text: "go" },
      });
      mock.emitRecord({
        kind: "block",
        blockId: "2",
        block: {
          kind: "system",
          label: "差分协处理器",
          body: "Reading scripts",
        },
      });
      mock.emitRecord({
        kind: "block",
        blockId: "3",
        block: {
          kind: "system",
          label: "差分协处理器",
          body: "完成 · 1 file",
          role: "done-marker",
        },
      });
    });
    expect(
      container.querySelectorAll('[data-testid="activity-block"]'),
    ).toHaveLength(1);
  });

  it("shows pending-activity placeholder when backendActive and no activity block yet; replaced when a system block lands", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitRecord({
        kind: "block",
        blockId: "u1",
        block: { kind: "herta", surface: "speech", text: "ok" },
      });
      // actor turn starts (sets status = "thinking")
      mock.emitTurn({ kind: "started", turnId: "t1" });
      // backend turn starts — no system block yet
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "turn.started",
          layer: "backend",
          userText: "",
        } as never,
      });
    });
    expect(screen.getByTestId("pending-activity")).toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-testid="activity-block"]'),
    ).toHaveLength(0);

    // First backend system block lands → activity block appears, pending placeholder should be gone
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "s1",
        block: {
          kind: "system",
          label: "差分协处理器",
          body: "Reading scripts",
        },
      });
    });
    expect(
      container.querySelectorAll('[data-testid="activity-block"]'),
    ).toHaveLength(1);
    expect(screen.queryByTestId("pending-activity")).not.toBeInTheDocument();
  });

  it("under reduced motion, a sent message shows as a flow bubble (no clone)", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hi there" } });
    act(() => {
      fireEvent.submit(input.closest("form") as HTMLFormElement);
    });
    expect(screen.getByText("hi there")).toBeInTheDocument();
    expect(document.querySelector(".morph-clone")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("mounts a flying clone on send when motion is enabled", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1); // freeze the rise
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "flying" } });
    act(() => {
      fireEvent.submit(input.closest("form") as HTMLFormElement);
    });
    expect(document.querySelector(".morph-clone")).toBeInTheDocument();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("the flying clone carries the 板砖→Brick alias in an EN session (matches the settled bubble)", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1); // freeze the rise
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() => {
      mock.emitReset({
        sessionId: "s-en",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
        lang: "en",
      });
    });
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    // The user types the EN input form; submit dispatches the wire token
    // (@板砖) — which is what the pendingUser echo and the clone receive.
    fireEvent.change(input, { target: { value: "hand @Brick this" } });
    act(() => {
      fireEvent.submit(input.closest("form") as HTMLFormElement);
    });
    const cloneText = document.querySelector(".morph-clone .message-text");
    expect(cloneText).not.toBeNull();
    expect(cloneText?.textContent).toBe("hand @Brick this");
    expect(cloneText?.textContent).not.toContain("板砖");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("the flight goes on when the real user block lands mid-flight — the landed row hides until the clone parks, and a stuck flight is landed by its guard (owner 2026-09-30)", () => {
    // A typed @板砖 heads its turn with no router call, so its user block
    // lands within milliseconds of the send. The echo gave way, the clone
    // was torn down with it, and the bubble jumped into place unflown.
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1); // freeze rises
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const mock = createMockHertaBridge();
      render(<App bridge={mock.bridge} />);
      act(() => {
        mock.emitReset({
          sessionId: "s",
          workspaceRoot: "/r",
          record: [],
          overlay: null,
          backendWorkspace: "/r",
          backendWorkspaceIsDefault: true,
        });
      });
      const input = screen.getByPlaceholderText(
        "Message Herta…",
      ) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "@板砖 查一下" } });
      act(() => {
        fireEvent.submit(input.closest("form") as HTMLFormElement);
      });
      expect(document.querySelector(".morph-clone")).toBeInTheDocument(); // in the air
      act(() => {
        mock.emitRecord({
          kind: "block",
          blockId: "u1",
          block: { kind: "user", text: "@板砖 查一下" },
        });
      });
      // Still flying, onto the real row — which is laid out but not shown.
      expect(document.querySelector(".morph-clone")).toBeInTheDocument();
      const landed = document.querySelector<HTMLElement>(
        '.user-row[data-abs-index="0"]',
      );
      expect(landed).not.toBeNull();
      expect(landed?.style.visibility).toBe("hidden");
      // The rise is frozen here and never reports a landing: the guard lands
      // it, so the row can never stay hidden behind a stuck clone.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(document.querySelector(".morph-clone")).not.toBeInTheDocument();
      expect(landed?.style.visibility).toBe("");
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("a record replaced wholesale mid-flight (a switch) still ends the flight at once, and hides none of its rows", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1); // freeze rises
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const input = screen.getByPlaceholderText(
      "Message Herta…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "stuck?" } });
    act(() => {
      fireEvent.submit(input.closest("form") as HTMLFormElement);
    });
    expect(document.querySelector(".morph-clone")).toBeInTheDocument();
    // A reset replaces the record wholesale (here: another session's, ending
    // on a user block) — not the turn's user block landing.
    act(() => {
      mock.emitReset({
        sessionId: "other",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "stuck?" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(document.querySelector(".morph-clone")).not.toBeInTheDocument();
    expect(
      document.querySelector<HTMLElement>('.user-row[data-abs-index="0"]')
        ?.style.visibility,
    ).toBe("");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mounts an incoming clone when streaming starts (motion enabled)", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1); // freeze the rise
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "你好",
        } as never,
      });
    });
    expect(
      document.querySelector(".morph-clone.herta-bubble"),
    ).toBeInTheDocument();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("under reduced motion, streaming shows the flow bubble directly (no clone)", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: "你好",
        } as never,
      });
    });
    expect(screen.getByTestId("streaming-bubble")).toBeInTheDocument();
    expect(document.querySelector(".morph-clone")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

describe("Conversation live-turn threading", () => {
  it("live-turn timestamps reach only the live turn's groups — born-done parts keep their duration, history stays quiet", () => {
    // perf review 2026-07-31: turnStartedAt/backendStartedAt used to be
    // handed to EVERY group, defeating ActivityBlock's memo for the whole
    // mounted history at each turn boundary — and letting a historical done
    // group (blocks without timestamps of their own) freeze a bogus duration
    // from the LIVE run's anchor. The gate: groups after the last user block
    // — which includes the born-done parts a beat split minted, whose
    // whole-run freeze still needs backendStartedAt while it is set.
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [
          { kind: "user", text: "先前的事" },
          { kind: "system", label: "差分协处理器", body: "旧活" },
          {
            kind: "system",
            label: "差分协处理器",
            body: "完成 · 1 file",
            role: "done-marker",
          },
          { kind: "herta", surface: "speech", text: "那是上次。" },
          { kind: "user", text: "fix the parser @板砖" },
          { kind: "system", label: "差分协处理器", body: "Reading parser.ts" },
          {
            kind: "system",
            label: "差分协处理器",
            body: "完成 · 1 file",
            role: "done-marker",
          },
          { kind: "herta", surface: "speech", text: "先说一句。" },
          { kind: "system", label: "差分协处理器", body: "Running tests" },
        ],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
      mock.emitAgent({
        kind: "agent",
        event: {
          type: "turn.started",
          layer: "backend",
          userText: "",
        } as never,
      });
    });
    const groups = container.querySelectorAll('[data-testid="activity-block"]');
    expect(groups).toHaveLength(3);
    // Historical (before the last user block): its blocks carry no timing,
    // and the live run's anchor must not reach it.
    expect(groups[0]?.querySelector(".activity-line__duration")).toBeNull();
    // Born-done part of the live run: frozen whole-run duration.
    expect(groups[1]?.querySelector(".activity-line__duration")).not.toBeNull();
    // The active continuation: live duration.
    expect(groups[2]?.querySelector(".activity-line__duration")).not.toBeNull();
  });
});

/** The morph overlay, exactly as Workspace mounts it. Without it in the tree
 *  `overlayRef` is null, no clone flies, and a send takes the no-flight path —
 *  which is a real branch (reduced motion) but NOT the one users see. */
function MorphOverlay(): JSX.Element {
  const { overlayRef } = useWorkspaceRefs();
  return <div ref={overlayRef} className="morph-overlay" />;
}

describe("Conversation turn headroom", () => {
  /** jsdom has no layout — every measured height here is 0, so these pin the
   *  ARM/DISARM contract (whose turn owns the reservation) rather than the
   *  size. The arithmetic is covered in turn-headroom.test.ts. */
  function setup(opts: { readonly overlay?: boolean } = {}): {
    container: HTMLElement;
    spacer: HTMLElement;
    mock: ReturnType<typeof createMockHertaBridge>;
    send: () => void;
  } {
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => undefined;
    }
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        {opts.overlay === true && <MorphOverlay />}
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
          <Composer />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "hi" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    return {
      container,
      spacer: container.querySelector(".turn-headroom") as HTMLElement,
      mock,
      send: () => {
        fireEvent.change(screen.getByRole("textbox"), {
          target: { value: "question" },
        });
        fireEvent.submit(
          container.querySelector("form.composer") as HTMLFormElement,
        );
      },
    };
  }

  it("reserves nothing until you send", () => {
    const { spacer } = setup();
    expect(spacer).toBeInTheDocument();
    expect(spacer.dataset.armed).toBe("false");
    expect(spacer.style.height).not.toBe("");
  });

  it("arms on send", () => {
    const { container, spacer, send } = setup();
    const geo = fakeGeometry(container, 3000); // a full pane
    send();
    geo.restore();
    expect(spacer.dataset.armed).toBe("true");
  });

  it("disarms on a session switch — the room belongs to the turn you sent", () => {
    const { container, spacer, mock, send } = setup();
    const geo = fakeGeometry(container, 3000);
    send();
    geo.restore();
    expect(spacer.dataset.armed).toBe("true");
    // Arriving somewhere else must land at the REAL bottom: reserved space
    // under a turn you did not send reads as a rendering fault.
    act(() => {
      mock.emitReset({
        sessionId: "other",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "elsewhere" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(spacer.dataset.armed).toBe("false");
  });

  it("a rewind releases the reservation — the withdrawn turn's room leaves with it (review 2026-07-31)", () => {
    const { container, spacer, mock, send } = setup();
    const geo = fakeGeometry(container, 3000);
    send();
    expect(spacer.dataset.armed).toBe("true");
    // The rewind arrives as a same-session record reset that shrinks the
    // TAIL. Pre-fix the extent survived it (only session switch and blanking
    // released it), so the withdrawn rows' height came back as spacer and
    // the pinned follow parked the view on blank pane.
    act(() => {
      mock.emitRecord({ kind: "reset", record: [], start: 0 });
    });
    geo.restore();
    expect(spacer.dataset.armed).toBe("false");
    expect(spacer.style.height).toBe("0px");
  });

  it("a live-window trim slides the extent down — the blank keeps its size instead of growing by the trimmed rows (review 2026-07-31)", () => {
    const { container, spacer, mock, send } = setup();
    // AT the trim threshold (not past it — a longer reset would trip the
    // trim before the reservation exists), so the next append crosses it.
    act(() => {
      mock.emitRecord({
        kind: "reset",
        record: Array.from({ length: 260 }, (_, i) => ({
          kind: "user" as const,
          text: `m${i}`,
        })),
        start: 0,
      });
    });
    const geo = fakeGeometry(container, 3000);
    send();
    expect(spacer.dataset.armed).toBe("true");
    const before = spacer.style.height;
    // The flow's measured height follows the live DOM: the moment the trim's
    // commit removes the 62 oldest rows, the content reads 1060px shorter —
    // in the SAME commit, the way real layout shrinks.
    geo.setContent(() =>
      container.querySelectorAll(".user-row").length > 230 ? 3060 : 2000,
    );
    // The 262nd block trips the trim. recordStart rises, the tail stays, and
    // the extent must slide DOWN with the content: pre-fix it held its
    // content-coordinate total, so headroomFor handed the missing 1060px to
    // the spacer as fresh blank and the pinned view (streaming reply
    // included) shoved off the top.
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b-trim",
        block: { kind: "user", text: "the one that trips the trim" },
      });
    });
    geo.restore();
    // Still armed — a trim is not a rewind — and the blank is unchanged.
    expect(spacer.dataset.armed).toBe("true");
    expect(spacer.style.height).toBe(before);
  });

  it("the spacer keeps absorbing streamed growth THROUGH a morph flight (deferred-fix 2026-07-31)", () => {
    // The sync used to stand down whenever a clone was in the air — but
    // while a reservation holds, the sync is exactly what keeps the
    // measured slots still (growth eats spacer, scrollHeight stays the
    // extent). Standing it down let growth inflate the bottom the climb
    // chases (snap-back at hand-off) and over-count the incoming rise's
    // owedScroll by the same pixels.
    vi.useFakeTimers();
    const flight = stubFlight();
    try {
      const { container, spacer, mock, send } = setup({ overlay: true });
      const geo = fakeGeometry(container, 3000);
      send();
      const before = Number.parseInt(spacer.style.height, 10);
      expect(before).toBeGreaterThan(0);
      // The reply's first block lands while the clone is still flying, and
      // the flow grows by 200px under it…
      geo.setContent(3000 + BUBBLE + 200);
      act(() => {
        mock.emitRecord({
          kind: "block",
          blockId: "b1",
          block: { kind: "herta", surface: "speech", text: "在看了。" },
        });
      });
      // …and the spacer absorbed it in the same follow.
      expect(Number.parseInt(spacer.style.height, 10)).toBe(before - 200);
      expect(flight).toBeTruthy();
      geo.restore();
    } finally {
      delete (HTMLElement.prototype as unknown as { animate?: unknown })
        .animate;
      vi.useRealTimers();
    }
  });

  it("a viewport resize mid-hold re-derives the extent — the anchored gap survives a maximize (deferred-fix 2026-07-31)", () => {
    // The extent baked in the send-time viewport, so a maximize left the
    // anchored message viewport-delta below its gap, and a
    // restore-from-maximized could leave a spacer taller than the pane.
    // extent += Δviewport restores the contract, and maxScroll
    // (extent − viewport) is invariant under it, so the pinned view holds.
    const roCallbacks: Array<() => void> = [];
    class FakeRO {
      cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
        roCallbacks.push(cb);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeRO);
    try {
      const { container, spacer, send } = setup();
      const geo = fakeGeometry(container, 3000);
      // The observer's baseline was taken at mount, before the fake geometry
      // existed — deliver once so it rebases to the 800px pane (a real
      // observer fires on that size change too). Nothing is armed yet, so
      // the delta path is a no-op.
      act(() => {
        for (const cb of roCallbacks) cb();
      });
      send();
      expect(spacer.dataset.armed).toBe("true");
      const before = Number.parseInt(spacer.style.height, 10);
      // Maximize: +400 viewport → the reserved region fills the NEW
      // viewport below the anchor.
      geo.setViewport(VIEW + 400);
      act(() => {
        for (const cb of roCallbacks) cb();
      });
      expect(Number.parseInt(spacer.style.height, 10)).toBe(before + 400);
      // Restore: symmetric — back to exactly where it started.
      geo.setViewport(VIEW);
      act(() => {
        for (const cb of roCallbacks) cb();
      });
      expect(Number.parseInt(spacer.style.height, 10)).toBe(before);
      geo.restore();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /** jsdom lays nothing out, so state the geometry outright — and make the
   *  spacer behave like a real element (its `offsetHeight` reads back the
   *  height the component wrote, and the scroller's `scrollHeight` follows),
   *  so a sequence of sends composes the way it does in a browser. */
  const VIEW = 800;
  const BUBBLE = 60;
  function fakeGeometry(
    container: HTMLElement,
    anchorTop: number,
  ): {
    /** Grow the flow, as an answer landing would. A function form makes the
     *  height follow the live DOM (resolved at each measure), the way real
     *  layout shrinks in the same commit that removes rows. */
    setContent: (px: number | (() => number)) => void;
    /** Move the newest user row, as the next send would. */
    setAnchor: (px: number) => void;
    extent: () => number;
    scrollTo: (px: number) => void;
    maxScroll: () => number;
    /** The scroller's bottom padding — what the approval panel publishes as
     *  `--approval-reserve`. Changing it resizes the scroller WITHOUT moving
     *  any content, exactly as the real panel does. */
    setPad: (px: number) => void;
    /** Resize the scrollport, as a window maximize/restore would. Fire the
     *  component's ResizeObserver yourself — jsdom has none. */
    setViewport: (px: number) => void;
    /** Read scrollTop the way the component left it. */
    scrollTop: () => number;
    restore: () => void;
  } {
    const pane = container.querySelector(".conversation") as HTMLElement;
    const spacer = container.querySelector(".turn-headroom") as HTMLElement;
    let content: number | (() => number) = anchorTop + BUBBLE;
    const contentPx = (): number =>
      typeof content === "function" ? content() : content;
    let anchor = anchorTop;
    const spacerPx = (): number =>
      Number.parseInt(spacer.style.height, 10) || 0;
    let scrollTop = 0;
    let pad = 0;
    let view = VIEW;
    Object.defineProperty(pane, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
      configurable: true,
    });
    Object.defineProperty(pane, "clientHeight", {
      get: () => view,
      configurable: true,
    });
    Object.defineProperty(pane, "scrollHeight", {
      // Never below clientHeight — the clamp that made a fresh session read
      // as a full pane in the live run. `pad` is the approval reserve: it adds
      // to the scrollable height but NOT to clientHeight (padding lives inside
      // the border box, so the scrollport keeps its size).
      get: () => Math.max(view, contentPx() + spacerPx() + pad),
      configurable: true,
    });
    Object.defineProperty(spacer, "offsetHeight", {
      get: spacerPx,
      configurable: true,
    });
    const rects = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        // Content coordinates minus the scroll, the way a real rect reads.
        // The spacer's top edge IS the bottom of the real content.
        const at = this.classList.contains("user-row")
          ? anchor
          : this.classList.contains("turn-headroom")
            ? contentPx()
            : 0;
        const top = this.classList.contains("conversation")
          ? 0
          : at - scrollTop;
        return { top, bottom: top, left: 0, right: 0, width: 0, height: 0 };
      } as () => DOMRect);
    return {
      setContent: (px) => {
        content = px;
      },
      setAnchor: (px) => {
        anchor = px;
      },
      extent: () => contentPx() + spacerPx(),
      /** Scroll as the reader would, and fire the event the app listens to. */
      scrollTo: (px: number) => {
        scrollTop = px;
        fireEvent.scroll(pane);
      },
      maxScroll: () => Math.max(view, contentPx() + spacerPx() + pad) - view,
      // The panel opening/closing: resize the scroller, then let the browser
      // CLAMP a now-out-of-range scrollTop and fire the scroll event that
      // clamp produces — the sequence the real drift came out of.
      setPad: (px: number) => {
        pad = px;
        const max = Math.max(view, contentPx() + spacerPx() + pad) - view;
        if (scrollTop > max) {
          scrollTop = max;
          fireEvent.scroll(pane);
        }
      },
      setViewport: (px: number) => {
        view = px;
      },
      scrollTop: () => scrollTop,
      restore: () => rects.mockRestore(),
    };
  }

  it("on a full pane, reserves exactly enough to put the sent message at the top", () => {
    const { container, spacer, send } = setup();
    const ANCHOR_TOP = 3000; // a long history — the pane is well past full
    const geo = fakeGeometry(container, ANCHOR_TOP);
    send();
    geo.restore();
    // Scrolled fully down WITH that reservation, the anchor sits exactly
    // HEADROOM_GAP_PX below the top of the viewport — which is the whole
    // contract, stated in the units the browser actually works in.
    const reserved = Number.parseInt(spacer.style.height, 10);
    const maxScrollAfter = ANCHOR_TOP + BUBBLE + reserved - VIEW;
    expect(ANCHOR_TOP - maxScrollAfter).toBe(HEADROOM_GAP_PX);
  });

  /** Stub WAAPI so the flight's travel is handed over rather than stepped, and
   *  hand back the recorded animation — calling `onfinish` IS the landing. */
  function stubFlight(): { finish: () => void } {
    const anim = {
      onfinish: null as null | (() => void),
      cancel: () => undefined,
    };
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = () =>
      anim;
    return {
      finish: () => {
        anim.onfinish?.();
      },
    };
  }

  /** Pump the damped climb to convergence: fake timers drive its rAF frames,
   *  and the runaway cap bounds how much clock it can ever need. */
  function settleGlide(): void {
    act(() => {
      vi.advanceTimersByTime(SCROLL_GLIDE_MAX_MS + 100);
    });
  }

  it("one move at a time: the send parks at the content bottom, the climb waits for the landing", () => {
    // User 2026-07-30: the page used to climb into the reserved room WHILE the
    // bubble was still flying across it. Codex flies first, then climbs.
    vi.useFakeTimers();
    const flight = stubFlight();
    try {
      const { container, spacer, send } = setup({ overlay: true });
      const ANCHOR_TOP = 3000;
      const geo = fakeGeometry(container, ANCHOR_TOP);
      const pane = container.querySelector(".conversation") as HTMLElement;
      send();
      // Reserved, as before…
      expect(spacer.dataset.armed).toBe("true");
      // …but parked at the bottom of the REAL content — the message sits flush
      // against the bottom edge and the room below is still off screen. The
      // reserved bottom is further down; landing there now would be the jump.
      const contentBottom = ANCHOR_TOP + BUBBLE;
      const parked = contentBottom - VIEW;
      expect(pane.scrollTop).toBe(parked);
      expect(geo.maxScroll()).toBeGreaterThan(pane.scrollTop);
      // Time passes with the bubble still in the air: the page must NOT move.
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(pane.scrollTop).toBe(parked);
      // The bubble lands → NOW the page climbs, all the way into the room.
      act(() => {
        flight.finish();
      });
      settleGlide();
      expect(pane.scrollTop).toBe(geo.maxScroll());
      geo.restore();
    } finally {
      delete (HTMLElement.prototype as unknown as { animate?: unknown })
        .animate;
      vi.useRealTimers();
    }
  });

  it("a scroll during the PARK hands the pane to the reader — the climb never fires (review 2026-07-31)", () => {
    // The park window (bubble in the air, climb queued) used to ignore
    // every scroll: pin/ratchet skipped, and when the flight settled the
    // queued climb dragged the reader straight back down from wherever
    // they had scrolled to.
    vi.useFakeTimers();
    const flight = stubFlight();
    try {
      const { container, send } = setup({ overlay: true });
      const ANCHOR_TOP = 3000;
      const geo = fakeGeometry(container, ANCHOR_TOP);
      const pane = container.querySelector(".conversation") as HTMLElement;
      send();
      const parked = pane.scrollTop;
      expect(parked).toBeGreaterThan(0);
      // The reader scrolls up mid-flight (wheel, drag, keys — any source).
      act(() => {
        geo.scrollTo(parked - 300);
      });
      // The flight lands: the queued climb must NOT fire — the reader owns
      // the pane now.
      act(() => {
        flight.finish();
      });
      settleGlide();
      expect(pane.scrollTop).toBe(parked - 300);
      geo.restore();
    } finally {
      delete (HTMLElement.prototype as unknown as { animate?: unknown })
        .animate;
      vi.useRealTimers();
    }
  });

  it("a send with nothing to fly still climbs immediately", () => {
    // Reduced motion, or no overlay: there is no settle to wait for, so
    // deferring the climb would leave the reserved room permanently off screen.
    vi.useFakeTimers();
    try {
      const { container, spacer, send } = setup(); // no overlay → no flight
      const geo = fakeGeometry(container, 3000);
      const pane = container.querySelector(".conversation") as HTMLElement;
      send();
      expect(spacer.dataset.armed).toBe("true");
      settleGlide();
      expect(pane.scrollTop).toBe(geo.maxScroll());
      geo.restore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a session switch mid-flight cancels the climb it was owed", () => {
    // The clone unmounts on the switch, which fires the same settle effect the
    // climb hangs off — in a session that never asked for room.
    vi.useFakeTimers();
    const flight = stubFlight();
    try {
      const { container, mock, send } = setup({ overlay: true });
      const geo = fakeGeometry(container, 3000);
      const pane = container.querySelector(".conversation") as HTMLElement;
      send();
      const parked = pane.scrollTop;
      act(() => {
        mock.emitReset({
          sessionId: "elsewhere",
          workspaceRoot: "/r",
          record: [{ kind: "user", text: "other" }],
          overlay: null,
          backendWorkspace: "/r",
          backendWorkspaceIsDefault: true,
        });
      });
      act(() => {
        flight.finish();
      });
      settleGlide();
      // No climb ran in the session we arrived in.
      expect(pane.scrollTop).toBe(parked);
      geo.restore();
    } finally {
      delete (HTMLElement.prototype as unknown as { animate?: unknown })
        .animate;
      vi.useRealTimers();
    }
  });

  it("the climb starts at the OUTGOING landing even when the reply is already flying", () => {
    // The race the 2026-07-30 review found: gating the climb on BOTH clones
    // let a fast first delta steal it — the pending climb expired against the
    // park's fallback timer and the eventual catch-up SNAPPED the page. The
    // incoming rise aims at the post-climb slot (owedScroll), so climbing
    // under it is the designed interaction.
    vi.useFakeTimers();
    const flight = stubFlight();
    try {
      const { container, mock, send } = setup({ overlay: true });
      const geo = fakeGeometry(container, 3000);
      const pane = container.querySelector(".conversation") as HTMLElement;
      send();
      const parked = pane.scrollTop;
      // The reply starts streaming while the outgoing bubble is still in the
      // air — the incoming clone mounts.
      act(() => {
        mock.emitTurn({ kind: "started", turnId: "t1" });
        mock.emitAgent({
          kind: "agent",
          event: {
            type: "assistant.delta",
            layer: "actor",
            text: "嗯",
          } as never,
        });
      });
      expect(pane.scrollTop).toBe(parked); // still parked: outgoing in the air
      act(() => {
        flight.finish(); // the OUTGOING lands; the incoming keeps flying
      });
      settleGlide();
      // The climb ran — it did not wait for the incoming clone to land.
      expect(pane.scrollTop).toBe(geo.maxScroll());
      geo.restore();
    } finally {
      delete (HTMLElement.prototype as unknown as { animate?: unknown })
        .animate;
      vi.useRealTimers();
    }
  });

  it("the pinned follow keeps running under the INCOMING flight — a reply that starts at a full pane (owner 2026-10-07)", () => {
    // Frozen for the whole flight, a reply that began right under the 板砖
    // row grew below the fold: the clone grew up over the row, and the page
    // caught up in one jump at the hand-off. The clone now tracks its slot
    // live, so the follow need not wait for it.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1); // hold the clone in the air
    try {
      const { container, mock } = setup({ overlay: true });
      const geo = fakeGeometry(container, 3000); // full pane, nothing reserved
      const pane = container.querySelector(".conversation") as HTMLElement;
      act(() => {
        mock.emitTurn({ kind: "started", turnId: "t1" });
        mock.emitAgent({
          kind: "agent",
          event: {
            type: "assistant.delta",
            layer: "actor",
            text: "引擎、页面、测试、说明都齐了。",
          } as never,
        });
      });
      expect(
        container.querySelector(".morph-clone.herta-bubble"),
      ).toBeInTheDocument();
      // The flow grows under the flying reply, and a follow trigger fires.
      geo.setContent(3000 + BUBBLE + 300);
      act(() => {
        mock.emitRecord({
          kind: "block",
          blockId: "op1",
          block: {
            kind: "system",
            label: "差分协处理器",
            body: "Reading a.ts",
            digest: { kind: "op", verb: "Reading", arg: "a.ts" },
          },
        });
      });
      // Still in the air — and the view followed.
      expect(
        container.querySelector(".morph-clone.herta-bubble"),
      ).toBeInTheDocument();
      expect(pane.scrollTop).toBe(geo.maxScroll());
      geo.restore();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a scroll the BROWSER clamped does not spend reserved room", () => {
    // Half of the approval-panel drift (user 2026-07-30, measured live at
    // 399px over two steps). The panel's reserve is bottom padding on the
    // scroller; when it goes away the scroller shrinks under a pinned view and
    // the browser clamps scrollTop down. That scroll event is not the reader
    // leaving the room, but the ratchet read it as one and spent 200px —
    // unrecoverably, since a spent reservation does not come back.
    //
    // The guard is "at the bottom of the CURRENT layout, nothing is being
    // spent", so this drives exactly that: land a scroll at the live bottom
    // and require the reservation to survive it.
    vi.useFakeTimers();
    const { container, spacer, mock, send } = setup();
    const geo = fakeGeometry(container, 3000);
    send();
    act(() => {
      vi.advanceTimersByTime(SCROLL_GLIDE_MAX_MS + 100);
    });
    const reserved = Number.parseInt(spacer.style.height, 10);
    expect(reserved).toBeGreaterThan(200);
    const extentHeld = geo.extent();

    // The panel opens and the spacer absorbs its reserve, so the extent still
    // matches the layout. (A first version of this test stopped here and
    // passed WITHOUT the fix: while extent and layout agree, the older
    // at-the-stored-extent test already caught the bottom. The bug needs the
    // extent to be stale relative to a SHRUNKEN layout, which is the next step.)
    act(() => {
      geo.setPad(200);
    });
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b-sync",
        block: { kind: "herta", surface: "speech", text: "同步" },
      });
    });
    expect(Number.parseInt(spacer.style.height, 10)).toBe(reserved - 200);
    // The TOTAL scrollable height — content + spacer + reserve — is what holds
    // the anchored message still, and it is unchanged.
    expect(geo.extent() + 200).toBe(extentHeld);

    // The panel closes: the scroller shrinks by the reserve under a pinned
    // view, the browser clamps scrollTop, and THAT scroll must not be read as
    // the reader stepping out of the room.
    act(() => {
      geo.setPad(0);
    });
    expect(Number.parseInt(spacer.style.height, 10)).toBe(reserved - 200);
    // The room is intact: a re-sync restores the full spacer rather than
    // leaving 200px permanently spent.
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b-sync2",
        block: { kind: "herta", surface: "speech", text: "再同步" },
      });
    });
    expect(Number.parseInt(spacer.style.height, 10)).toBe(reserved);

    // …and the ratchet still works for a REAL scroll up out of the room.
    act(() => {
      geo.scrollTo(geo.maxScroll() - 100);
    });
    expect(Number.parseInt(spacer.style.height, 10)).toBe(reserved - 100);
    geo.restore();
    vi.useRealTimers();
  });

  it("a pinned follow lands at the TRUE bottom, past the reserve", () => {
    // `scrollIntoView` aligns an element; the scroller's bottom padding is
    // inside the scrollport, so aligning `endRef` stops short by exactly the
    // reserve. Writing `scrollHeight - clientHeight` is the bottom by
    // definition, whatever padding is in play.
    vi.useFakeTimers();
    const { container, mock, send } = setup();
    const geo = fakeGeometry(container, 3000);
    send();
    act(() => {
      vi.advanceTimersByTime(SCROLL_GLIDE_MAX_MS + 100);
    });
    act(() => {
      geo.setPad(200);
    });
    // A block lands while pinned with the gate open — the follow must reach the
    // real bottom, not the reserve's near edge.
    geo.setContent(3260);
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b-pad",
        block: { kind: "herta", surface: "speech", text: "答复" },
      });
    });
    expect(geo.scrollTop()).toBe(geo.maxScroll());
    geo.restore();
    vi.useRealTimers();
  });

  it("reserves nothing on a pane the history does not fill", () => {
    // The message lands with open space beneath it already; reserving would
    // scroll the short history out of view to manufacture room that was
    // never missing (user 2026-07-29).
    const { container, spacer, send } = setup();
    const geo = fakeGeometry(container, 120);
    send();
    geo.restore();
    expect(spacer.dataset.armed).toBe("false");
    expect(spacer.style.height).toBe("0px");
  });

  it("leaves the NEXT message alone while the room it made is still open", () => {
    // The reported bug (user 2026-07-29): turn 3 reserved a pane's worth,
    // its answer was short and used little of it, and turn 4 — looking only
    // at how much history sat above it — reserved all over again, scrolling
    // the thread up to make room that was already on screen.
    const { container, spacer, mock, send } = setup();
    const geo = fakeGeometry(container, 3000);
    send();
    expect(spacer.dataset.armed).toBe("true");
    const heldExtent = geo.extent();

    // A SHORT answer lands: it eats some of the reservation, and a growth
    // trigger re-syncs the spacer — extent unchanged, nothing moved.
    geo.setContent(3260);
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b-ans",
        block: { kind: "herta", surface: "speech", text: "short answer" },
      });
    });
    expect(geo.extent()).toBe(heldExtent);
    const roomLeft = Number.parseInt(spacer.style.height, 10);
    expect(roomLeft).toBeGreaterThan(VIEW * 0.3);

    // Now send again. There is already somewhere to land, so nothing is
    // re-reserved and the total extent does not budge.
    geo.setAnchor(3260);
    send();
    geo.restore();
    expect(geo.extent()).toBe(heldExtent);
  });

  it("spends the reserved room as the reader scrolls up out of it", () => {
    // Room is slack: scroll up 100px into a 500px blank and it becomes a
    // 400px blank with the bottom having come up to meet you, so there is
    // nothing to scroll back down to (user 2026-07-29, matching Codex).
    vi.useFakeTimers();
    const { container, spacer, send } = setup();
    const geo = fakeGeometry(container, 3000);
    send();
    const reserved = Number.parseInt(spacer.style.height, 10);
    expect(reserved).toBeGreaterThan(200);
    // Run the climb out (fake timers drive its rAF; the runaway cap bounds
    // it): until it lands the send owns the scroller and the handler stands
    // down, so nothing the reader does registers.
    act(() => {
      vi.advanceTimersByTime(SCROLL_GLIDE_MAX_MS + 100);
    });

    act(() => {
      geo.scrollTo(geo.maxScroll() - 100);
    });
    expect(Number.parseInt(spacer.style.height, 10)).toBe(reserved - 100);
    // The reader is AT the new bottom, not 100px above it.
    expect(geo.maxScroll()).toBe(3060 + reserved - 100 - VIEW);

    // Scrolling back down does not hand the room back.
    act(() => {
      geo.scrollTo(geo.maxScroll());
    });
    expect(Number.parseInt(spacer.style.height, 10)).toBe(reserved - 100);
    geo.restore();
    vi.useRealTimers();
  });

  it("gives the room up entirely once the reader clears it", () => {
    vi.useFakeTimers();
    const { container, spacer, send } = setup();
    const geo = fakeGeometry(container, 3000);
    send();
    expect(spacer.dataset.armed).toBe("true");
    act(() => {
      vi.advanceTimersByTime(SCROLL_GLIDE_MAX_MS + 100);
    });
    act(() => {
      geo.scrollTo(0); // all the way up into the history
    });
    expect(spacer.dataset.armed).toBe("false");
    expect(spacer.style.height).toBe("0px");
    geo.restore();
    vi.useRealTimers();
  });

  it("climbs (damped) when it makes room, and lands immediately when room exists", () => {
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => undefined;
    }
    const spy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);

    // Making room moves the view most of a pane — it must TRAVEL there (the
    // damped glide; its curve is pinned in scroll-glide.test.ts), never
    // arrive as if the page had been replaced.
    vi.useFakeTimers();
    const full = setup();
    let geo = fakeGeometry(full.container, 3000);
    const pane = full.container.querySelector(".conversation") as HTMLElement;
    spy.mockClear();
    full.send();
    const atSend = pane.scrollTop;
    settleGlide();
    expect(pane.scrollTop).toBe(geo.maxScroll());
    expect(pane.scrollTop).toBeGreaterThan(atSend);
    geo.restore();
    vi.useRealTimers();

    cleanup();
    // Room that already exists has nothing to travel: that path keeps the
    // immediate landing it has always had — at the pane's true bottom.
    const short = setup();
    geo = fakeGeometry(short.container, 120);
    const shortPane = short.container.querySelector(
      ".conversation",
    ) as HTMLElement;
    short.send();
    expect(shortPane.scrollTop).toBe(geo.maxScroll());
    geo.restore();
    spy.mockRestore();
  });

  it("stays disarmed through a blanking reset (session deleted)", () => {
    const { spacer, mock, send } = setup();
    send();
    act(() => {
      mock.emitReset({ noSession: true });
    });
    expect(spacer.dataset.armed).toBe("false");
  });
});

describe("Conversation jump-to-latest chip", () => {
  /** Render, load a session, and unpin the pane (scrolled far from the
   *  bottom). Returns the scroll pane for further scroll simulation. */
  function setupUnpinned(mock: ReturnType<typeof createMockHertaBridge>): {
    pane: HTMLElement;
  } {
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "hi" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const pane = container.querySelector(".conversation") as HTMLElement;
    Object.defineProperty(pane, "scrollTop", {
      value: 0,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(pane, "clientHeight", {
      value: 100,
      configurable: true,
    });
    Object.defineProperty(pane, "scrollHeight", {
      value: 1000,
      configurable: true,
    });
    fireEvent.scroll(pane); // unpin
    return { pane };
  }

  it("appears when new content lands while unpinned; a click glides back and melts it away", () => {
    vi.useFakeTimers();
    // The chip scrolls the PANE to its true bottom now, not `endRef` into
    // view: aligning the element leaves the approval reserve unscrolled, so
    // with a gate open the chip landed short and left its own condition true
    // (2026-07-30). jsdom has no scrollTo — record the call.
    const scrollToSpy = vi.fn();
    (Element.prototype as unknown as { scrollTo: unknown }).scrollTo =
      scrollToSpy;
    const mock = createMockHertaBridge();
    setupUnpinned(mock);
    // Unpinned but nothing new yet — no chip.
    expect(screen.queryByText("Back to bottom")).not.toBeInTheDocument();
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b2",
        block: { kind: "herta", surface: "speech", text: "answer" },
      });
    });
    const chip = screen.getByText("Back to bottom");
    // The arming rAF opens the entrance transition one frame after mount.
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(chip.className).toContain("is-open");
    scrollToSpy.mockClear();
    fireEvent.click(chip);
    // The click glides (smooth) to the pane's true bottom; the chip starts its
    // exit transition immediately (is-open drops) while staying mounted…
    expect(scrollToSpy).toHaveBeenCalledWith({
      top: expect.any(Number),
      behavior: "smooth",
    });
    expect(chip.className).not.toContain("is-open");
    expect(chip).toBeInTheDocument();
    // …and unmounts once the slide-fade completes.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("Back to bottom")).not.toBeInTheDocument();
    delete (Element.prototype as unknown as { scrollTo?: unknown }).scrollTo;
    vi.useRealTimers();
  });

  it("never appears while pinned at the bottom", () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "hi" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b2",
        block: { kind: "herta", surface: "speech", text: "answer" },
      });
    });
    expect(screen.queryByText("Back to bottom")).not.toBeInTheDocument();
  });

  it("clears when the reader scrolls back to the bottom themselves", () => {
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    const { pane } = setupUnpinned(mock);
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b2",
        block: { kind: "herta", surface: "speech", text: "answer" },
      });
    });
    expect(screen.getByText("Back to bottom")).toBeInTheDocument();
    // Scroll to the bottom: scrollTop + clientHeight reaches scrollHeight
    // within the pin threshold → re-pinned, the chip melts away with no
    // click (exit transition, then unmount).
    Object.defineProperty(pane, "scrollTop", {
      value: 900,
      configurable: true,
      writable: true,
    });
    fireEvent.scroll(pane);
    expect(screen.getByText("Back to bottom").className).not.toContain(
      "is-open",
    );
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("Back to bottom")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("melts away when a layout SHRINK lands the reader at the bottom with no scroll event (a disclosure collapsing under them, owner 2026-09-02)", () => {
    // The scroll handler was the only place the pin was recomputed, so
    // collapsing a 板砖 detail row while scrolled up — the flow shrinks, no
    // scroll event, the whole bubble now on screen — left the chip up for
    // good and the follow off. The scroller's ResizeObserver now watches
    // the flow wrapper too and re-derives the pin from geometry on a
    // SHRINK (growth never can bring a reader to the bottom, and it
    // arrives on every reveal frame).
    vi.useFakeTimers();
    const observers: Array<{
      cb: ResizeObserverCallback;
      targets: Element[];
    }> = [];
    class FakeRO {
      targets: Element[] = [];
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        observers.push(this);
      }
      observe(t: Element): void {
        this.targets.push(t);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", FakeRO);
    try {
      const mock = createMockHertaBridge();
      const { pane } = setupUnpinned(mock);
      const flow = pane.querySelector(".conversation-flow") as HTMLElement;
      expect(flow).not.toBeNull();
      /** Deliver a flow-wrapper entry to every observer watching it (the
       *  scroller's and useScrollEdges'), as a real observer would. */
      const deliver = (height: number): void => {
        const entry = {
          target: flow,
          contentRect: { height },
        } as unknown as ResizeObserverEntry;
        act(() => {
          for (const o of observers) {
            if (o.targets.includes(flow))
              o.cb([entry], o as unknown as ResizeObserver);
          }
        });
      };
      deliver(1000); // the baseline the shrink test compares against
      act(() => {
        mock.emitRecord({
          kind: "block",
          blockId: "b2",
          block: { kind: "herta", surface: "speech", text: "answer" },
        });
      });
      act(() => {
        vi.advanceTimersByTime(32);
      });
      expect(screen.getByText("Back to bottom").className).toContain("is-open");
      // Growth alone never re-derives: the reader is still 900px up.
      deliver(1500);
      expect(screen.getByText("Back to bottom").className).toContain("is-open");
      // The collapse: the flow shrinks until the pane shows everything
      // (scrollTop 0 + 100 viewport ≥ 120 − pin threshold) — no scroll
      // event, no click, and the chip melts away on its own.
      Object.defineProperty(pane, "scrollHeight", {
        value: 120,
        configurable: true,
      });
      deliver(120);
      expect(screen.getByText("Back to bottom").className).not.toContain(
        "is-open",
      );
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.queryByText("Back to bottom")).not.toBeInTheDocument();
      // …and the follow is back on: the next block does not re-light it.
      act(() => {
        mock.emitRecord({
          kind: "block",
          blockId: "b3",
          block: { kind: "herta", surface: "speech", text: "more" },
        });
      });
      expect(screen.queryByText("Back to bottom")).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("a disclosure opened AFTER a real scroll-away leaves the chip armed", () => {
    // `unpin` marks a DISCLOSURE unpin synthetic so the chip does not light
    // for a reader who never left the bottom (2026-07-24). It did so even
    // when the reader had already scrolled away for real — and from then on
    // growth below them lit nothing until their next scroll. Scroll-then-
    // expand is reading history exactly as expand-then-scroll is (the
    // 2026-08-10 rule), so the unpin is a no-op for an unpinned reader.
    vi.useFakeTimers();
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [
          { kind: "user", text: "fix it @板砖" },
          { kind: "system", label: "差分协处理器", body: "Reading scripts" },
        ],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const pane = container.querySelector(".conversation") as HTMLElement;
    Object.defineProperty(pane, "scrollTop", {
      value: 0,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(pane, "clientHeight", {
      value: 100,
      configurable: true,
    });
    Object.defineProperty(pane, "scrollHeight", {
      value: 1000,
      configurable: true,
    });
    fireEvent.scroll(pane); // the reader scrolls up — a REAL unpin
    const line = container.querySelector(".activity-line") as HTMLElement;
    expect(line).not.toBeNull();
    fireEvent.click(line); // …then opens the 板砖 history
    act(() => {
      mock.emitRecord({
        kind: "block",
        blockId: "b2",
        block: { kind: "herta", surface: "speech", text: "answer" },
      });
    });
    expect(screen.getByText("Back to bottom")).toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe("Conversation load-earlier paging (long sessions)", () => {
  it("shows the load-earlier row when older blocks exist; clicking pages them in", async () => {
    const mock = createMockHertaBridge({
      recordSliceResult: {
        start: 1,
        blocks: [{ kind: "user", text: "an older message" }],
      },
    });
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "the visible tail" }],
        recordStart: 2,
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    // The row names how much older history exists.
    const btn = screen.getByText("Load 2 earlier entries");
    expect(screen.queryByText("an older message")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(mock.calls.recordSlice).toEqual([["s", 2, 200]]);
    // The older block renders ABOVE the tail; one older block remains, so
    // the row stays with the updated count.
    expect(screen.getByText("an older message")).toBeInTheDocument();
    expect(screen.getByText("the visible tail")).toBeInTheDocument();
    expect(screen.getByText("Load 1 earlier entries")).toBeInTheDocument();
  });

  it("hides the row when the whole record is loaded", () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "hi" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(screen.queryByText(/earlier entries/)).not.toBeInTheDocument();
  });
});

describe("Conversation unpinned live-window trim", () => {
  /** Row pitch in the faked layout. Rows are laid out in flow order at this
   *  spacing, so a row's viewport-relative top is derivable from its index
   *  and the scroll position — which is all the trim's binary search reads. */
  const ROW_PX = 40;
  const VIEW_PX = 600;

  /**
   * A conversation whose geometry is faked well enough for the trim's two
   * reads: the pane's scroll position/size, and each `[data-abs-index]`
   * row's viewport-relative top. jsdom has no layout, so both are stubbed
   * from the row's ABSOLUTE index — content therefore behaves as if every
   * block above the window start is still laid out, which is what makes the
   * anchor arithmetic (scrollHeight shrinking by the trimmed rows' height)
   * meaningful here.
   */
  const userBlocks = (n: number, tag = "m") =>
    Array.from({ length: n }, (_, i) => ({
      kind: "user" as const,
      text: `${tag}${i}`,
    }));

  function setup(opts: {
    blocks: number;
    /** Where the reader ends up before the scenario's append. */
    readAt: number;
    recordStart?: number;
    /** Seeds the load-earlier page (its `start + blocks.length` must equal
     *  `recordStart`, or the store drops the response as stale). */
    recordSlice?: {
      start: number;
      blocks: ReturnType<typeof userBlocks>;
    };
  }): {
    container: HTMLElement;
    mock: ReturnType<typeof createMockHertaBridge>;
    pane: HTMLElement;
    rows: () => number;
    scrollTop: () => number;
    append: (text: string) => void;
    patchRows: () => void;
  } {
    const mock = createMockHertaBridge(
      opts.recordSlice !== undefined
        ? { recordSliceResult: opts.recordSlice }
        : {},
    );
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    // Open SHORT. A long opening record would trip the PINNED trim before
    // the scenario starts (the reader is pinned on arrival), so the long
    // window is grown below, after unpinning — which is also how a real
    // session reaches this state: a marathon run under a reading user.
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: userBlocks(4, "seed"),
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const pane = container.querySelector(".conversation") as HTMLElement;
    let scrollTop = 0;
    Object.defineProperty(pane, "scrollTop", {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
      configurable: true,
    });
    Object.defineProperty(pane, "clientHeight", {
      get: () => VIEW_PX,
      configurable: true,
    });
    // scrollHeight follows the MOUNTED rows: a trim removes rows above, so
    // the scroller shrinks by exactly their height — the delta the anchor
    // compensates with.
    Object.defineProperty(pane, "scrollHeight", {
      get: () =>
        container.querySelectorAll("[data-abs-index]").length * ROW_PX +
        VIEW_PX,
      configurable: true,
    });
    pane.getBoundingClientRect = () => ({ top: 0, bottom: VIEW_PX }) as DOMRect;
    // Each row's top: its position among the MOUNTED rows, minus the scroll.
    const patchRows = (): void => {
      const rows = container.querySelectorAll<HTMLElement>("[data-abs-index]");
      rows.forEach((row, i) => {
        row.getBoundingClientRect = () =>
          ({
            top: i * ROW_PX - scrollTop,
            bottom: i * ROW_PX - scrollTop + ROW_PX,
          }) as DOMRect;
      });
    };
    patchRows();
    const scrollTo = (to: number): void => {
      act(() => {
        pane.scrollTop = to;
        fireEvent.scroll(pane);
      });
      patchRows();
    };
    // Unpin FIRST (a wheel notch up off the bottom), then grow the window to
    // its full length as a same-session record reset — the pinned trim stands
    // down for an unpinned reader, so the long window survives to be the
    // subject of these tests.
    scrollTo(0);
    act(() => {
      mock.emitRecord({
        kind: "reset",
        record: userBlocks(opts.blocks),
        start: opts.recordStart ?? 0,
      });
    });
    patchRows();
    scrollTo(opts.readAt);
    return {
      container,
      mock,
      pane,
      rows: () => container.querySelectorAll("[data-abs-index]").length,
      scrollTop: () => scrollTop,
      patchRows,
      append: (text: string) => {
        act(() => {
          mock.emitRecord({
            kind: "block",
            blockId: `b-${text}`,
            block: { kind: "user", text },
          });
        });
        patchRows();
      },
    };
  }

  it("trims history above an unpinned reader and holds the viewport still", () => {
    // Reading deep in the history of a long window, far above the fold.
    const s = setup({ blocks: UNPINNED_TRIM_AT + 1, readAt: 12_000 });
    const before = s.rows();
    const scrollBefore = s.scrollTop();
    s.append("live append");
    const after = s.rows();
    // Rows left, from ABOVE — the append added one, so a pure append would
    // have grown the count.
    expect(after).toBeLessThan(before);
    // …and the reader's view did not move: scrollTop slid down by exactly
    // the removed rows' height (the trimmed count, plus the appended row).
    const removed = before + 1 - after;
    expect(s.scrollTop()).toBe(scrollBefore - removed * ROW_PX);
  });

  it("keeps the newest blocks whatever the cut (scrolling back down lands on history, not a paging button)", () => {
    const s = setup({ blocks: UNPINNED_TRIM_AT + 1, readAt: 12_000 });
    const before = s.rows();
    s.append("live append");
    // A cut really happened (else the tail bound below proves nothing)…
    expect(s.rows()).toBeLessThan(before + 1);
    // …the tail bound held…
    expect(s.rows()).toBeGreaterThanOrEqual(UNPINNED_TRIM_KEEP_TAIL);
    // …and the newest blocks — the live append and the ones before it — are
    // the survivors, so scrolling back down lands on real history.
    expect(screen.getByText("live append")).toBeInTheDocument();
    expect(
      screen.getByText(`m${UNPINNED_TRIM_AT}`), // the last pre-append block
    ).toBeInTheDocument();
  });

  it("never trims rows the reader can see — the cut stays a viewport above the fold", () => {
    // Scrolled up only slightly: less than one viewport of content sits
    // above the fold, so no cut respects the margin and none is made.
    const s = setup({ blocks: UNPINNED_TRIM_AT + 1, readAt: VIEW_PX - 10 });
    const before = s.rows();
    s.append("live append");
    expect(s.rows()).toBe(before + 1);
  });

  it("does not trim a window that is merely long — the threshold is mounted rows", () => {
    const s = setup({ blocks: UNPINNED_TRIM_AT - 100, readAt: 5_000 });
    const before = s.rows();
    s.append("live append");
    expect(s.rows()).toBe(before + 1);
  });

  it("a load-earlier prepend never trips a trim — the reader ASKED for those rows", async () => {
    const s = setup({
      blocks: 400,
      readAt: 9_000,
      recordStart: 200,
      recordSlice: { start: 0, blocks: userBlocks(200, "old") },
    });
    // The prepend takes the window to 600 blocks — past the trim threshold,
    // with plenty of trimmable content above the fold. It must survive:
    // paging history in and immediately dropping it is a treadmill.
    await act(async () => {
      fireEvent.click(screen.getByText(/earlier entries/));
      await Promise.resolve();
    });
    s.patchRows();
    expect(s.rows()).toBe(600);
  });
});

describe("Conversation topic-rail gutter", () => {
  it("the shell carries has-topic-rail exactly when the rail is visible (≥2 topics)", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    const topic = (i: number) => ({
      title: `T${i}`,
      anchorIndex: i,
      anchorText: `q${i}`,
      at: "t",
    });
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [{ kind: "user", text: "hi" }],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
        topics: [topic(0)],
      });
    });
    // One topic: no rail, no gutter class.
    expect(
      container.querySelector(".conversation-shell.has-topic-rail"),
    ).toBeNull();
    act(() => {
      mock.emitTitle({
        kind: "title",
        sessionId: "s",
        title: "T1",
        topic: topic(1),
      });
    });
    // Two topics: the rail mounts and the shell reserves the gutter.
    expect(
      container.querySelector(".conversation-shell.has-topic-rail"),
    ).not.toBeNull();
    expect(container.querySelector(".topic-rail")).not.toBeNull();
  });
});

describe("Conversation scroll-edge fade", () => {
  it("renders the shell-wrapped scroll viewport without fade classes while content fits", () => {
    const mock = createMockHertaBridge();
    const { container } = renderWithLocale(
      <WorkspaceRefsProvider>
        <HertaBridgeProvider bridge={mock.bridge}>
          <Conversation />
        </HertaBridgeProvider>
      </WorkspaceRefsProvider>,
    );
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    const shell = container.querySelector(".conversation-shell");
    expect(shell).not.toBeNull();
    const conv = shell?.querySelector(".conversation");
    expect(conv).not.toBeNull();
    // The fade is a mask on the scroll container, gated by useScrollEdges
    // class toggles. jsdom: zero layout metrics → nothing overflows →
    // neither class applied.
    expect(conv?.classList.contains("has-fog-top")).toBe(false);
    expect(conv?.classList.contains("has-fog-bottom")).toBe(false);
    // The old overlay strips are retired (Chromium can't mask a
    // backdrop-filter's output).
    expect(container.querySelector(".edge-fog")).toBeNull();
  });
});
