import type { SessionMetadata } from "@herta/app-server";
import { deriveTitle } from "./derive-title.js";
import { mockRecord } from "./record.js";

/**
 * Mock session list. Matches the reference image's sidebar:
 * 2 Today entries, 3 Yesterday entries, 3 Previous 7 Days entries.
 *
 * "today-1" carries its title as ordinary metadata, derived from the mock
 * record the way the Slice 3 sidebar used to derive it at display time
 * (2026-09-03: the display rule moved to the Sidebar and stopped
 * special-casing this id, so the mock supplies what the sidecar would).
 */
export const mockSessionList: SessionMetadata[] = [
  // Today
  {
    sessionId: "today-1",
    workspaceRoot: "/repo",
    startedAt: "2026-05-28T09:00:00Z",
    lastActivityAt: "2026-05-28T10:25:00Z",
    title: deriveTitle(mockRecord),
  },
  {
    sessionId: "today-2",
    workspaceRoot: "/repo",
    startedAt: "2026-05-28T08:30:00Z",
    lastActivityAt: "2026-05-28T09:15:00Z",
  },
  // Yesterday
  {
    sessionId: "yesterday-1",
    workspaceRoot: "/repo",
    startedAt: "2026-05-27T14:00:00Z",
    lastActivityAt: "2026-05-27T15:00:00Z",
  },
  {
    sessionId: "yesterday-2",
    workspaceRoot: "/repo",
    startedAt: "2026-05-27T11:00:00Z",
    lastActivityAt: "2026-05-27T11:45:00Z",
  },
  {
    sessionId: "yesterday-3",
    workspaceRoot: "/repo",
    startedAt: "2026-05-27T09:00:00Z",
    lastActivityAt: "2026-05-27T09:30:00Z",
  },
  // Previous 7 Days
  {
    sessionId: "previous-1",
    workspaceRoot: "/repo",
    startedAt: "2026-05-25T10:00:00Z",
    lastActivityAt: "2026-05-25T11:00:00Z",
  },
  {
    sessionId: "previous-2",
    workspaceRoot: "/repo",
    startedAt: "2026-05-24T13:00:00Z",
    lastActivityAt: "2026-05-24T13:30:00Z",
  },
  {
    sessionId: "previous-3",
    workspaceRoot: "/repo",
    startedAt: "2026-05-23T16:00:00Z",
    lastActivityAt: "2026-05-23T16:45:00Z",
  },
];
