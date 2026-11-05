import { useSyncExternalStore } from "react";
import female from "../assets/trailblazer-avatar-female.png";
import male from "../assets/trailblazer-avatar-male.png";

/**
 * The Trailblazer's avatar (ADR 0085 amendment 2026-11-05): two drawn marks,
 * and the Trailblazer picks one in Settings → Window. It is their own look,
 * not Herta's identity (D1), and only this window's drawing: it never reaches
 * the record or her prompt, so it is kept here, beside the voice prefs, not
 * in main. Before a pick, the male mark: her prompts say 他.
 */
export type TrailblazerAvatar = "female" | "male";

export const TRAILBLAZER_AVATARS: Readonly<Record<TrailblazerAvatar, string>> =
  { female, male };

const KEY = "herta.trailblazer.avatar";
const DEFAULT_AVATAR: TrailblazerAvatar = "male";

function read(): TrailblazerAvatar {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === "female" || raw === "male" ? raw : DEFAULT_AVATAR;
  } catch {
    return DEFAULT_AVATAR;
  }
}

let current = read();
const listeners = new Set<() => void>();

/** Set (and persist) the pick. Every avatar on screen follows. */
export function setTrailblazerAvatar(next: TrailblazerAvatar): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // ignore — best-effort persistence
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useTrailblazerAvatar(): TrailblazerAvatar {
  return useSyncExternalStore(subscribe, () => current);
}

/** Test seam: forget the pick. */
export function resetTrailblazerAvatarForTest(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  current = read();
  for (const l of listeners) l();
}
