/**
 * Every key the app answers, in one table (ADR 0082): main builds its menu
 * accelerators from it, the renderer matches and lists from it, so a key the
 * cheat sheet shows is the key that works.
 *
 * Pure: the matching runs over a key event's fields, so it unit-tests
 * without a DOM, and main can import it.
 */

export type ShortcutGroup = "sessions" | "window" | "composer" | "approval";

export type ShortcutId =
  | "newSession"
  | "searchSessions"
  | "prevSession"
  | "nextSession"
  | "moveInList"
  | "renameSession"
  | "toggleSidebar"
  | "openSettings"
  | "closeTab"
  | "showShortcuts"
  | "focusComposer"
  | "send"
  | "newline"
  | "attachFiles"
  | "recallLast"
  | "chipMenu"
  | "stopRun"
  | "approve"
  | "approveMore"
  | "deny";

/** One key with its modifiers. `mod` is the primary modifier: ⌘ on macOS,
 *  Ctrl elsewhere. `key` is a lower-case letter or digit, a punctuation
 *  character as a US layout gives it unshifted, or a named key (`Enter`,
 *  `Escape`, `F2`, `ArrowUp`, …). */
export interface Binding {
  readonly mod?: true;
  readonly shift?: true;
  readonly alt?: true;
  readonly key: string;
}

export interface ShortcutDef {
  readonly id: ShortcutId;
  readonly group: ShortcutGroup;
  /**
   * Who answers it.
   * - `window`: the renderer's one dispatcher.
   * - `menu`: an application-menu accelerator; main sends the renderer the
   *   command (the menu is never seen on Windows and Linux, but its
   *   accelerators are live).
   * - `local`: a component answers it itself — listed for the cheat sheet,
   *   never matched by the dispatcher.
   */
  readonly channel: "window" | "menu" | "local";
  /** Alternatives, drawn side by side (↑ ↓, 2 3). The first is THE key. */
  readonly keys: readonly Binding[];
}

const mod = (key: string): Binding => ({ mod: true, key });

/** The table, in the cheat sheet's order. */
export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: "newSession", group: "sessions", channel: "window", keys: [mod("n")] },
  {
    id: "searchSessions",
    group: "sessions",
    channel: "window",
    keys: [mod("k")],
  },
  {
    id: "prevSession",
    group: "sessions",
    channel: "window",
    keys: [{ mod: true, shift: true, key: "[" }],
  },
  {
    id: "nextSession",
    group: "sessions",
    channel: "window",
    keys: [{ mod: true, shift: true, key: "]" }],
  },
  {
    id: "moveInList",
    group: "sessions",
    channel: "local",
    keys: [{ key: "ArrowUp" }, { key: "ArrowDown" }],
  },
  {
    id: "renameSession",
    group: "sessions",
    channel: "local",
    keys: [{ key: "F2" }],
  },
  { id: "toggleSidebar", group: "window", channel: "window", keys: [mod("b")] },
  { id: "openSettings", group: "window", channel: "menu", keys: [mod(",")] },
  { id: "closeTab", group: "window", channel: "menu", keys: [mod("w")] },
  { id: "showShortcuts", group: "window", channel: "window", keys: [mod("/")] },
  {
    id: "focusComposer",
    group: "composer",
    channel: "window",
    keys: [mod("l")],
  },
  { id: "send", group: "composer", channel: "local", keys: [{ key: "Enter" }] },
  {
    id: "newline",
    group: "composer",
    channel: "local",
    keys: [{ shift: true, key: "Enter" }],
  },
  { id: "attachFiles", group: "composer", channel: "window", keys: [mod("u")] },
  {
    id: "recallLast",
    group: "composer",
    channel: "local",
    keys: [{ key: "ArrowUp" }],
  },
  {
    id: "chipMenu",
    group: "composer",
    channel: "local",
    keys: [{ shift: true, key: "F10" }],
  },
  {
    id: "stopRun",
    group: "composer",
    channel: "local",
    keys: [{ key: "Escape" }],
  },
  { id: "approve", group: "approval", channel: "local", keys: [{ key: "1" }] },
  {
    id: "approveMore",
    group: "approval",
    channel: "local",
    keys: [{ key: "2" }, { key: "3" }],
  },
  {
    id: "deny",
    group: "approval",
    channel: "local",
    keys: [{ key: "Escape" }],
  },
];

export function shortcut(id: ShortcutId): ShortcutDef {
  const def = SHORTCUTS.find((s) => s.id === id);
  if (def === undefined) throw new Error(`no shortcut ${id}`);
  return def;
}

/** A command's key — the first of its alternatives. */
export function primaryKey(id: ShortcutId): Binding {
  const b = shortcut(id).keys[0];
  if (b === undefined) throw new Error(`shortcut ${id} has no key`);
  return b;
}

/** The fields of a key event the matching reads. */
export interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/** A key event that is never a shortcut: an IME composition (Chromium
 *  reports keyCode 229 / `Process` for its keys), a dead key, a repeat. */
export function isInertKey(e: KeyLike): boolean {
  return (
    e.isComposing === true ||
    e.keyCode === 229 ||
    e.key === "Process" ||
    e.key === "Dead" ||
    e.key === "Unidentified" ||
    e.repeat
  );
}

/** A US layout's shifted punctuation, back to its key. */
const US_UNSHIFT: Readonly<Record<string, string>> = {
  "{": "[",
  "}": "]",
  "?": "/",
  "<": ",",
  ">": ".",
  "|": "\\",
  ":": ";",
  '"': "'",
  "~": "`",
  _: "-",
  "+": "=",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
};

/** A key's position, for a layout whose characters are not Latin. */
const CODE_KEY: Readonly<Record<string, string>> = {
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};

/** The key a binding would name for this event. */
export function bindingKeyOf(e: KeyLike): string {
  const k = e.key;
  if (k.length !== 1) return k;
  if (/[\x21-\x7e]/u.test(k)) {
    const lower = k.toLowerCase();
    return e.shiftKey ? (US_UNSHIFT[k] ?? lower) : lower;
  }
  // Not a US character (Cyrillic, Greek, a macOS Option glyph): the key's
  // position names it.
  const code = e.code;
  if (code.startsWith("Key") && code.length === 4)
    return code.slice(3).toLowerCase();
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return CODE_KEY[code] ?? k.toLowerCase();
}

/** Whether the event is this binding. Modifiers match exactly — Ctrl+Alt
 *  (Windows AltGr) is never a Ctrl binding — and on macOS Ctrl is left to
 *  the text fields. */
export function matchesBinding(e: KeyLike, b: Binding, mac: boolean): boolean {
  const primary = mac ? e.metaKey : e.ctrlKey;
  const other = mac ? e.ctrlKey : e.metaKey;
  if ((b.mod === true) !== primary || other) return false;
  if ((b.shift === true) !== e.shiftKey) return false;
  if ((b.alt === true) !== e.altKey) return false;
  return bindingKeyOf(e) === b.key;
}

/** The window command this event is, or null. */
export function matchWindowShortcut(
  e: KeyLike,
  mac: boolean,
): ShortcutId | null {
  if (isInertKey(e)) return null;
  for (const s of SHORTCUTS) {
    if (s.channel !== "window") continue;
    if (s.keys.some((b) => matchesBinding(e, b, mac))) return s.id;
  }
  return null;
}

const NAMED_WIN: Readonly<Record<string, string>> = {
  Enter: "Enter",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};
const NAMED_MAC: Readonly<Record<string, string>> = {
  ...NAMED_WIN,
  Enter: "↩",
};

/** A binding as keycaps, one per key: symbols on macOS in Apple's order
 *  (⌥ ⇧ ⌘), words elsewhere (Ctrl Shift Alt). Not translated. */
export function bindingCaps(b: Binding, mac: boolean): string[] {
  const caps: string[] = [];
  if (mac) {
    if (b.alt === true) caps.push("⌥");
    if (b.shift === true) caps.push("⇧");
    if (b.mod === true) caps.push("⌘");
  } else {
    if (b.mod === true) caps.push("Ctrl");
    if (b.shift === true) caps.push("Shift");
    if (b.alt === true) caps.push("Alt");
  }
  const named = (mac ? NAMED_MAC : NAMED_WIN)[b.key];
  caps.push(named ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key));
  return caps;
}

/** A binding as an Electron accelerator (the menu channel). */
export function accelerator(b: Binding): string {
  const parts: string[] = [];
  if (b.mod === true) parts.push("CmdOrCtrl");
  if (b.alt === true) parts.push("Alt");
  if (b.shift === true) parts.push("Shift");
  parts.push(b.key.length === 1 ? b.key.toUpperCase() : b.key);
  return parts.join("+");
}
