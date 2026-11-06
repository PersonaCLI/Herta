import { sep } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDirsFor } from "./config-helpers.js";

/** Normalize path separators for cross-platform comparison. */
function norm(p: string): string {
  return p.replaceAll("\\", "/");
}

describe("defaultDirsFor", () => {
  it("computes standard .herta/* dirs from a POSIX workspaceRoot + homedir", () => {
    const dirs = defaultDirsFor({
      workspaceRoot: sep === "\\" ? "C:\\repo\\x" : "/repo/x",
      homedir: sep === "\\" ? "C:\\home\\u" : "/home/u",
    });
    // Normalize to forward slashes for stable cross-platform assertions.
    expect(norm(dirs.transcriptDir)).toMatch(/\.herta\/transcript\/v2$/);
    expect(norm(dirs.projectMemoryDir)).toMatch(/\.herta\/memory$/);
    expect(norm(dirs.userMemoryDir)).toMatch(/\.herta\/memory$/);
    expect(norm(dirs.narrativeDir)).toMatch(/\.herta\/narrative$/);
    // Voice clips: dev default under the workspace (packaged GUIs override).
    expect(norm(dirs.voiceAssetsDir)).toMatch(/data\/voice$/);
    // workspaceRoot is the root of transcriptDir, projectMemoryDir, etc.
    const root = sep === "\\" ? "C:/repo/x" : "/repo/x";
    expect(norm(dirs.transcriptDir).startsWith(root)).toBe(true);
    // userMemoryDir is rooted at homedir, not workspaceRoot
    const home = sep === "\\" ? "C:/home/u" : "/home/u";
    expect(norm(dirs.userMemoryDir).startsWith(home)).toBe(true);
  });

  it("handles a Windows-style workspaceRoot", () => {
    const dirs = defaultDirsFor({
      workspaceRoot: "C:\\Users\\trailblazer\\Project\\app",
      homedir: "C:\\Users\\trailblazer",
    });
    // path.join normalizes separators per platform; on Windows
    // this produces backslashes, on POSIX it produces forward
    // slashes. We just assert the suffix is correct.
    expect(
      dirs.transcriptDir.endsWith(".herta/transcript/v2") ||
        dirs.transcriptDir.endsWith(".herta\\transcript\\v2"),
    ).toBe(true);
    expect(
      dirs.userMemoryDir.endsWith(".herta/memory") ||
        dirs.userMemoryDir.endsWith(".herta\\memory"),
    ).toBe(true);
  });
});
