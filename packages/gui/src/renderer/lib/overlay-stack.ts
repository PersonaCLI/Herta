import { useEffect, useSyncExternalStore } from "react";

/**
 * A tiny global registry of the currently-open modal overlays (settings, the
 * approval panel, the key prompt, card menus). The TOPMOST overlay owns
 * global keyboard semantics — Escape, autofocus.
 *
 * Why: these surfaces each attached their own document/window keydown
 * listeners with no coordination, so with Settings open over a pending
 * permission gate, one Escape press closed Settings AND silently DENIED the
 * approval behind the frosted backdrop; the approval panel also stole
 * keyboard focus from inside the Settings card, letting a stray Enter
 * approve an invisible request (GUI review 2026-07-04, H1/H2).
 *
 * "Topmost" is decided by an explicit z-level MIRRORING the CSS stacking
 * (see the constants below), NOT registration order: the approval panel is
 * an inline layer (z 40) that a later-arriving Settings backdrop (z 60)
 * visually covers — and equally, a gate arriving while Settings is already
 * open must slot in BELOW it. Ties break to the most recently opened.
 *
 * Deliberately not React context: the stack is genuinely global (overlays
 * mount in different subtrees), and handlers need a synchronous read.
 */

/** Mirror of the CSS stacking order (reference-ux.css): the approval panel
 *  sits under the settings/key-prompt backdrops; the image lightbox floats
 *  over those (an intentional viewer the user just opened); menus above all. */
export const OVERLAY_Z = {
  approval: 40,
  settings: 60,
  keyPrompt: 60,
  lightbox: 64,
  /** The keyboard cheat sheet (ADR 0082 §7): over Settings and the
   *  lightbox it can be opened from, under the menus. */
  shortcuts: 66,
  cardMenu: 70,
} as const;

type Listener = () => void;
interface Entry {
  readonly id: string;
  readonly z: number;
  readonly seq: number;
}

const entries: Entry[] = [];
const listeners = new Set<Listener>();
let seqCounter = 0;

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeOverlayStack(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pushOverlay(id: string, z: number): void {
  seqCounter += 1;
  entries.push({ id, z, seq: seqCounter });
  emit();
}

export function popOverlay(id: string): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.id === id) {
      entries.splice(i, 1);
      emit();
      return;
    }
  }
}

/** The overlay that currently owns global keyboard semantics, or null:
 *  highest z-level wins; ties go to the most recently opened. */
export function topOverlay(): string | null {
  let top: Entry | null = null;
  for (const e of entries) {
    if (top === null || e.z > top.z || (e.z === top.z && e.seq > top.seq)) {
      top = e;
    }
  }
  return top?.id ?? null;
}

/** Whether an overlay above level `z` is open, leaving out `except`. */
export function overlayOpenAbove(
  z: number,
  except: readonly string[] = [],
): boolean {
  return entries.some((e) => e.z > z && !except.includes(e.id));
}

/** The topmost overlay's z-level, or null when none is open. */
export function topOverlayZ(): number | null {
  let z: number | null = null;
  for (const e of entries) if (z === null || e.z > z) z = e.z;
  return z;
}

/**
 * Register `id` at CSS-mirroring level `z` while `active`, and reactively
 * report whether it is the TOPMOST overlay. An inactive overlay is never top.
 *
 * Handlers should gate on the returned flag (or call `topOverlay()`
 * synchronously); focus effects can depend on it so an overlay regains
 * focus when the one above it closes.
 */
export function useModalOverlay(
  id: string,
  active: boolean,
  z: number,
): boolean {
  useEffect(() => {
    if (!active) return;
    pushOverlay(id, z);
    return () => popOverlay(id);
  }, [id, active, z]);
  return useSyncExternalStore(
    subscribeOverlayStack,
    () => active && topOverlay() === id,
  );
}
