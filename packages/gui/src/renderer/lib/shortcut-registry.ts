import { useEffect, useRef } from "react";
import {
  isInertKey,
  matchWindowShortcut,
  type ShortcutId,
} from "../../shared/shortcuts.js";
import { OVERLAY_Z, topOverlay, topOverlayZ } from "./overlay-stack.js";

/**
 * The renderer's half of ADR 0082: components register what a command does
 * (`useShortcut`), and one capture-phase `keydown` listener on `window`
 * (`useShortcutDispatcher`, mounted once by the workbench) matches the table
 * and calls the most recently mounted handler for the command.
 *
 * Deliberately not React context, like the overlay stack: the handlers live
 * in different subtrees (the top bar, the sidebar, the composer), and the
 * dispatcher needs a synchronous read.
 */

/** What a command does. `false`: not now — the key is left alone and its
 *  default runs. */
export type ShortcutHandler = () => boolean | undefined;

const handlers = new Map<
  ShortcutId,
  Array<{ readonly run: ShortcutHandler }>
>();

/** Register `handler` for `id` while mounted (and `enabled`). The latest
 *  handler is always the one called: it is read through a ref, so a
 *  re-render never re-registers. */
export function useShortcut(
  id: ShortcutId,
  handler: ShortcutHandler,
  enabled = true,
): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const entry = { run: (): boolean | undefined => ref.current() };
    const list = handlers.get(id) ?? [];
    list.push(entry);
    handlers.set(id, list);
    return () => {
      const l = handlers.get(id);
      if (l === undefined) return;
      const i = l.indexOf(entry);
      if (i !== -1) l.splice(i, 1);
    };
  }, [id, enabled]);
}

/** Run the command now, as its key would. True when something answered. */
export function runShortcut(id: ShortcutId): boolean {
  const list = handlers.get(id);
  const top = list?.[list.length - 1];
  if (top === undefined) return false;
  return top.run() !== false;
}

/** Whether an overlay that owns the keyboard is open: Settings, the key
 *  prompt, the lightbox, a card menu, the cheat sheet. A pending approval
 *  (the lowest layer) does not count — each command decides for itself, as
 *  its button does. */
function keyboardOwned(id: ShortcutId): boolean {
  // Ctrl+/ opens the sheet over any of them — it is above them all — and
  // closes the sheet it opened (ADR 0082 amendment 2026-10-21: Settings'
  // nav foot opens it over Settings, so the key does too).
  if (id === "showShortcuts") return false;
  const z = topOverlayZ();
  return z !== null && z > OVERLAY_Z.approval;
}

/** The one window listener. Mounted once, by the workbench. */
export function useShortcutDispatcher(mac: boolean): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      const id = matchWindowShortcut(e, mac);
      if (id === null || keyboardOwned(id)) return;
      if (!runShortcut(id)) return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [mac]);
}

/** Where an Escape is somebody else's even if nothing marks it: a text field
 *  (but the composer's own), a menu, a list box, a dialog, the file viewer. */
function escapeBelongsElsewhere(
  target: EventTarget | null,
  composer: HTMLElement | null,
): boolean {
  if (!(target instanceof Element)) return false;
  if (composer !== null && target === composer) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  ) {
    return true;
  }
  return (
    target.closest(
      '[role="menu"], [role="listbox"], [role="dialog"], [aria-modal="true"], .file-viewer',
    ) !== null
  );
}

/**
 * Escape stops the run (ADR 0082 §5) — only when nothing else answered it.
 *
 * Three steps, so the order listeners were registered in does not matter:
 * the capture phase notes whether an overlay was open as the key went down
 * (closing one under this very Escape pops it before the event is done);
 * the bubble phase sees only an Escape nobody stopped, from a place that is
 * not somebody else's; and the stop waits until the event has been
 * dispatched, then runs only if no listener marked it (`preventDefault`).
 */
export function useEscapeStop(
  enabled: boolean,
  stop: () => void,
  composerRef: { readonly current: HTMLElement | null },
): void {
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    if (!enabled) return;
    const overlayAtPress = new WeakSet<Event>();
    const onCapture = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && topOverlay() !== null) overlayAtPress.add(e);
    };
    const onBubble = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || isInertKey(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (overlayAtPress.has(e)) return;
      if (escapeBelongsElsewhere(e.target, composerRef.current)) return;
      window.setTimeout(() => {
        if (!e.defaultPrevented) stopRef.current();
      }, 0);
    };
    window.addEventListener("keydown", onCapture, { capture: true });
    window.addEventListener("keydown", onBubble);
    return () => {
      window.removeEventListener("keydown", onCapture, { capture: true });
      window.removeEventListener("keydown", onBubble);
    };
  }, [enabled, composerRef]);
}
