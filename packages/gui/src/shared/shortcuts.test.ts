import { describe, expect, it } from "vitest";
import {
  accelerator,
  bindingCaps,
  isInertKey,
  type KeyLike,
  matchesBinding,
  matchWindowShortcut,
  SHORTCUTS,
} from "./shortcuts.js";

function key(k: string, over: Partial<KeyLike> = {}): KeyLike {
  return {
    key: k,
    code: k.length === 1 && /[a-z]/iu.test(k) ? `Key${k.toUpperCase()}` : "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    ...over,
  };
}

describe("the shortcut table (ADR 0082)", () => {
  it("names each command once, and every window or menu key carries the primary modifier", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SHORTCUTS) {
      expect(s.keys.length).toBeGreaterThan(0);
      if (s.channel === "local") continue;
      // §3: they fire while typing, so a bare key would eat a letter.
      for (const b of s.keys) expect(b.mod).toBe(true);
    }
  });

  it("no two window or menu commands share a key", () => {
    const seen = new Set<string>();
    for (const s of SHORTCUTS) {
      if (s.channel === "local") continue;
      for (const b of s.keys) {
        const k = accelerator(b);
        expect(seen.has(k), k).toBe(false);
        seen.add(k);
      }
    }
  });
});

describe("matching a key event", () => {
  it("Ctrl on Windows and Linux, ⌘ on macOS — with exact modifiers", () => {
    expect(matchWindowShortcut(key("n", { ctrlKey: true }), false)).toBe(
      "newSession",
    );
    expect(matchWindowShortcut(key("n", { metaKey: true }), true)).toBe(
      "newSession",
    );
    // On a Mac, Ctrl is the text fields' (Ctrl+N moves the caret down).
    expect(matchWindowShortcut(key("n", { ctrlKey: true }), true)).toBeNull();
    // Windows AltGr arrives as Ctrl+Alt: never a Ctrl binding.
    expect(
      matchWindowShortcut(key("n", { ctrlKey: true, altKey: true }), false),
    ).toBeNull();
    expect(
      matchWindowShortcut(key("n", { ctrlKey: true, shiftKey: true }), false),
    ).toBeNull();
    // A bare letter is typing.
    expect(matchWindowShortcut(key("n"), false)).toBeNull();
  });

  it("a shifted punctuation key matches as the key a US layout names (Ctrl+Shift+[ arrives as `{`)", () => {
    expect(
      matchWindowShortcut(
        key("{", { ctrlKey: true, shiftKey: true, code: "BracketLeft" }),
        false,
      ),
    ).toBe("prevSession");
    expect(
      matchWindowShortcut(
        key("}", { ctrlKey: true, shiftKey: true, code: "BracketRight" }),
        false,
      ),
    ).toBe("nextSession");
    expect(
      matchWindowShortcut(key("/", { ctrlKey: true, code: "Slash" }), false),
    ).toBe("showShortcuts");
  });

  it("a non-Latin layout falls back to the key's position", () => {
    // Russian: the B key gives "и".
    expect(
      matchWindowShortcut(key("и", { ctrlKey: true, code: "KeyB" }), false),
    ).toBe("toggleSidebar");
    // A macOS Option glyph is not a shortcut's letter either.
    expect(
      matchesBinding(
        key("˚", { metaKey: true, altKey: true, code: "KeyK" }),
        { mod: true, alt: true, key: "k" },
        true,
      ),
    ).toBe(true);
  });

  it("never during an IME composition, for a dead key, or on a repeat", () => {
    expect(isInertKey(key("n", { isComposing: true }))).toBe(true);
    expect(isInertKey(key("Process", { keyCode: 229 }))).toBe(true);
    expect(isInertKey(key("Dead"))).toBe(true);
    expect(
      matchWindowShortcut(key("n", { ctrlKey: true, repeat: true }), false),
    ).toBeNull();
  });

  it("local and menu keys are never the dispatcher's", () => {
    // Ctrl+W and Ctrl+, are menu accelerators (§2): the window listener
    // leaves them to the menu.
    expect(matchWindowShortcut(key("w", { ctrlKey: true }), false)).toBeNull();
    expect(
      matchWindowShortcut(key(",", { ctrlKey: true, code: "Comma" }), false),
    ).toBeNull();
    expect(matchWindowShortcut(key("Escape"), false)).toBeNull();
    expect(matchWindowShortcut(key("Enter"), false)).toBeNull();
  });
});

describe("drawing a key", () => {
  it("words on Windows, symbols in Apple's order on macOS — one cap per key", () => {
    const b = { mod: true, shift: true, key: "[" } as const;
    expect(bindingCaps(b, false)).toEqual(["Ctrl", "Shift", "["]);
    expect(bindingCaps(b, true)).toEqual(["⇧", "⌘", "["]);
    expect(bindingCaps({ key: "Enter" }, true)).toEqual(["↩"]);
    expect(bindingCaps({ key: "Escape" }, false)).toEqual(["Esc"]);
    expect(bindingCaps({ mod: true, key: "n" }, false)).toEqual(["Ctrl", "N"]);
  });

  it("as an Electron accelerator", () => {
    expect(accelerator({ mod: true, key: "w" })).toBe("CmdOrCtrl+W");
    expect(accelerator({ mod: true, key: "," })).toBe("CmdOrCtrl+,");
    expect(accelerator({ mod: true, shift: true, key: "[" })).toBe(
      "CmdOrCtrl+Shift+[",
    );
  });
});
