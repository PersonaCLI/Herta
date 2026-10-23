/**
 * Whether something is moving the viewer by hand (ADR 0083 §3): the divider
 * drag raises it on press and clears it on release. The browser page gives
 * way to its still frame at once on the raise — not when the panel first
 * moves — because a native page under the pointer takes the mouse from the
 * window: a drag that crossed into it stopped following the pointer
 * (spike, 2026-10-23).
 */

let moving = 0;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const l of listeners) l();
};

export function beginPageMotion(): void {
  moving += 1;
  emit();
}

export function endPageMotion(): void {
  moving = Math.max(0, moving - 1);
  emit();
}

export function pageInMotion(): boolean {
  return moving > 0;
}

export function subscribePageMotion(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
