import { describe, expect, it } from "vitest";
import { appCommandForPageKey, type PageInput } from "./page-keys.js";

const key = (over: Partial<PageInput>): PageInput => ({
  type: "keyDown",
  key: "a",
  code: "KeyA",
  control: false,
  meta: false,
  shift: false,
  alt: false,
  isAutoRepeat: false,
  ...over,
});

describe("a key pressed inside the browser page (ADR 0083 §3)", () => {
  it("an app command is the app's: kept from the page and named", () => {
    expect(
      appCommandForPageKey(
        key({ key: "/", code: "Slash", control: true }),
        false,
      ),
    ).toBe("showShortcuts");
    expect(
      appCommandForPageKey(
        key({ key: "B", code: "KeyB", control: true, shift: true }),
        false,
      ),
    ).toBe("openBrowser");
    expect(
      appCommandForPageKey(key({ key: "k", code: "KeyK", meta: true }), true),
    ).toBe("searchSessions");
  });

  it("every other key is the page's own — Escape included, and Ctrl on a Mac", () => {
    expect(
      appCommandForPageKey(key({ key: "Escape", code: "Escape" }), false),
    ).toBeNull();
    expect(appCommandForPageKey(key({}), false)).toBeNull();
    expect(
      appCommandForPageKey(
        key({ key: "k", code: "KeyK", control: true }),
        true,
      ),
    ).toBeNull();
    // Ctrl+C and Ctrl+V are the page's text editing.
    expect(
      appCommandForPageKey(
        key({ key: "c", code: "KeyC", control: true }),
        false,
      ),
    ).toBeNull();
  });

  it("only a key going down, never its release or a repeat", () => {
    const ctrlSlash = { key: "/", code: "Slash", control: true };
    expect(
      appCommandForPageKey(key({ ...ctrlSlash, type: "keyUp" }), false),
    ).toBeNull();
    expect(
      appCommandForPageKey(key({ ...ctrlSlash, isAutoRepeat: true }), false),
    ).toBeNull();
  });
});
