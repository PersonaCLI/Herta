import {
  type KeyLike,
  matchWindowShortcut,
  type ShortcutId,
} from "../../shared/shortcuts.js";

/** The fields of Electron's `before-input-event` input the routing reads. */
export interface PageInput {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly isAutoRepeat: boolean;
}

/**
 * The app's command a key pressed inside the page is, or null (ADR 0083
 * §3). A focused page hears keys before the renderer, so ADR 0082's
 * capture-phase listener never would: main reads each key the page gets and
 * matches it against the shared table. A window command — every binding
 * with the primary modifier — is the app's: it is kept from the page and
 * sent to the renderer. Every other key is the page's own, Escape included:
 * it does not stop 板砖's run while the page has the focus.
 */
export function appCommandForPageKey(
  input: PageInput,
  mac: boolean,
): ShortcutId | null {
  if (input.type !== "keyDown") return null;
  const e: KeyLike = {
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    metaKey: input.meta,
    shiftKey: input.shift,
    altKey: input.alt,
    repeat: input.isAutoRepeat,
  };
  return matchWindowShortcut(e, mac);
}
