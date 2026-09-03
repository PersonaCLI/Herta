import { describe, expect, it } from "vitest";
import { sessionDisplayTitle } from "./session-display-title.js";

const base = {
  sessionId: "s-1",
  workspaceRoot: "/repo",
  startedAt: "2026-05-28T09:00:00Z",
  lastActivityAt: "2026-05-28T10:00:00Z",
};

describe("sessionDisplayTitle", () => {
  it("shows the generated title when the session has one", () => {
    expect(sessionDisplayTitle({ ...base, title: "排查解析报错" })).toBe(
      "排查解析报错",
    );
  });

  it("falls back to the 'Untitled' sentinel with no title or an empty one", () => {
    expect(sessionDisplayTitle(base)).toBe("Untitled");
    expect(sessionDisplayTitle({ ...base, title: "" })).toBe("Untitled");
  });
});
