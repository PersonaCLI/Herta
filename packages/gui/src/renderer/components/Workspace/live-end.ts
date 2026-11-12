// What the chat shows of the turn in flight, given which window it shows
// (owner 2026-11-12).
//
// The chat used to show the trailing window, always, so the turn in flight
// was drawn under its last row: the echo of the message just sent, her reply
// as it streams, 板砖's activity, a failure notice. After a far jump it shows
// a window of history that ends weeks before that (the store's `away`).
// Drawn there, those rows would read as an answer to a message from last
// month.
//
// So a chat that shows a window of history shows history only: every machine
// that draws the turn in flight is handed an idle turn. Coming back to the
// latest hands them the real one, the way a window reloaded mid-turn finds
// it. The turn itself is untouched: the store keeps every field, and the
// trailing window underneath goes on following the live end.

import type { SessionSnapshotView } from "../../store/session-store.js";

type LiveEnd = Pick<
  SessionSnapshotView,
  | "status"
  | "streamingText"
  | "retryText"
  | "pendingUser"
  | "pendingUserImages"
  | "pendingUserMentions"
  | "pendingUserPicks"
  | "pendingTalk"
  | "retracting"
  | "retractKeepLen"
  | "turnStartedAt"
  | "backendStartedAt"
  | "backendActive"
  | "recapCompacting"
  | "supervisorChecking"
  | "turnFailed"
  | "turnFailedStatus"
  | "turnFailedProviderCode"
  | "undoable"
>;

const NO_TALK: SessionSnapshotView["pendingTalk"] = [];

export function liveEndView<T extends LiveEnd>(session: T, atLive: boolean): T {
  if (atLive) return session;
  return {
    ...session,
    status: "idle",
    streamingText: null,
    retryText: null,
    pendingUser: null,
    pendingUserImages: null,
    pendingUserMentions: null,
    pendingUserPicks: null,
    pendingTalk: NO_TALK,
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
  };
}
