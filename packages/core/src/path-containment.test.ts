import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { isPathInside, isPathInsideWith } from "./path-containment.js";

describe("isPathInside", () => {
  it("posix: the root itself, a child, a deep child; not a sibling, a parent, or a `..` climb", () => {
    const p = posix;
    expect(isPathInsideWith(p, "/ws", "/ws")).toBe(true);
    expect(isPathInsideWith(p, "/ws", "/ws", { strict: true })).toBe(false);
    expect(isPathInsideWith(p, "/ws", "/ws/a")).toBe(true);
    expect(isPathInsideWith(p, "/ws", "/ws/a/b/c", { strict: true })).toBe(
      true,
    );
    expect(isPathInsideWith(p, "/ws", "/ws2")).toBe(false);
    expect(isPathInsideWith(p, "/ws", "/")).toBe(false);
    expect(isPathInsideWith(p, "/ws", "/ws/../etc")).toBe(false);
    expect(isPathInsideWith(p, "/ws", "/ws/a/../../etc/passwd")).toBe(false);
    // A CHILD whose name starts with two dots is inside — the old
    // `startsWith("..")` tests read it as an escape.
    expect(isPathInsideWith(p, "/ws", "/ws/..foo")).toBe(true);
    expect(isPathInsideWith(p, "/ws", "/ws/..")).toBe(false);
  });

  it("posix: case is exact; relative inputs resolve against the cwd the api gives", () => {
    const p = posix;
    expect(isPathInsideWith(p, "/ws", "/WS/a")).toBe(false);
    expect(isPathInsideWith(p, "/ws/", "/ws/a")).toBe(true);
    expect(isPathInsideWith(p, "/ws/./x/..", "/ws/a")).toBe(true);
  });

  it("win32: case folds (the platform's rule), drive letters too; another drive is outside", () => {
    const w = win32;
    expect(isPathInsideWith(w, "C:\\ws", "c:\\WS\\a")).toBe(true);
    expect(isPathInsideWith(w, "C:\\ws", "C:\\ws")).toBe(true);
    expect(isPathInsideWith(w, "C:\\ws", "C:\\ws", { strict: true })).toBe(
      false,
    );
    expect(isPathInsideWith(w, "C:\\ws", "D:\\ws\\a")).toBe(false);
    expect(isPathInsideWith(w, "C:\\ws", "C:\\ws\\..\\other")).toBe(false);
    expect(isPathInsideWith(w, "C:\\ws", "C:\\ws2\\a")).toBe(false);
    expect(isPathInsideWith(w, "C:\\ws", "C:\\ws\\..foo")).toBe(true);
    // Forward slashes are separators on win32 too.
    expect(isPathInsideWith(w, "C:/ws", "C:/ws/a/b")).toBe(true);
  });

  it("the native flavour agrees with itself on this platform", () => {
    const root = process.platform === "win32" ? "C:\\ws" : "/ws";
    const child = process.platform === "win32" ? "C:\\ws\\a" : "/ws/a";
    const out = process.platform === "win32" ? "C:\\other" : "/other";
    expect(isPathInside(root, child)).toBe(true);
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, root, { strict: true })).toBe(false);
    expect(isPathInside(root, out)).toBe(false);
  });
});
