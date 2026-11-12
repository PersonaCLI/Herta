import { describe, expect, it } from "vitest";
import { liveEndView } from "./live-end.js";

const turn = {
  status: "speaking" as const,
  streamingText: "mid-sentence",
  retryText: "again",
  pendingUser: "sent",
  pendingUserImages: null,
  pendingUserMentions: ["a.ts"],
  pendingUserPicks: null,
  pendingTalk: [{ text: "talk", at: "t", mentions: null, picks: null }],
  retracting: true,
  retractKeepLen: 3,
  turnStartedAt: 1,
  backendStartedAt: 2,
  backendActive: true,
  recapCompacting: true,
  supervisorChecking: true,
  turnFailed: true,
  turnFailedStatus: 500,
  turnFailedProviderCode: "x",
  undoable: true,
  // Not the turn's: it passes through either way.
  sessionId: "s",
};

describe("what the chat shows of the turn in flight (owner 2026-11-12)", () => {
  it("on the trailing window, the turn as it is, the same object", () => {
    expect(liveEndView(turn, true)).toBe(turn);
  });

  it("on a window of history, an idle turn: nothing of the one in flight is drawn under it", () => {
    const view = liveEndView(turn, false);
    expect(view).toEqual({
      status: "idle",
      streamingText: null,
      retryText: null,
      pendingUser: null,
      pendingUserImages: null,
      pendingUserMentions: null,
      pendingUserPicks: null,
      pendingTalk: [],
      retracting: false,
      retractKeepLen: null,
      turnStartedAt: null,
      backendStartedAt: null,
      backendActive: false,
      recapCompacting: false,
      supervisorChecking: false,
      turnFailed: false,
      turnFailedStatus: null,
      turnFailedProviderCode: null,
      undoable: false,
      sessionId: "s",
    });
  });

  it("the empty talk list is one list, so a row that takes it does not re-render per commit", () => {
    expect(liveEndView(turn, false).pendingTalk).toBe(
      liveEndView(turn, false).pendingTalk,
    );
  });
});
