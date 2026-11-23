import type { HertaBridge, ThemePref } from "../ipc/bridge-types.js";

/**
 * Theme controller (night-mode slice 2, 2026-07-13). Owns the ONE mutation
 * that themes the app: `data-theme` on <html>, which the stylesheet's
 * `:root[data-theme="dark"]` token block keys on. Pure DOM + matchMedia —
 * no React state: the theme is global chrome, not component state, and the
 * Settings pane and App boot both drive it through these functions.
 *
 * "system" resolves via prefers-color-scheme and RE-RESOLVES live when the
 * OS flips (the media-query listener stays armed only while the pref is
 * "system"). Fakes/demo bridges without the theme setting follow the OS too (the
 * "system" default, user 2026-07-14) — light where matchMedia is absent.
 */

let currentPref: ThemePref = "light";
let mql: MediaQueryList | null = null;

function resolved(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Invalidate the scroll-fog mask-group textures Chromium caches on
 * `.sidebar-list` / `.conversation`. These elements carry a persistent
 * `mask-image` gradient; Chromium sometimes keeps the mask group's cached
 * texture across a re-render, so the content renders with a STALE mask —
 * session cards dimmed (or the previous theme's ink) until a hover forces a
 * per-item repaint. Dropping the mask for one frame and restoring it always
 * re-rasters the group. The one unmasked frame is imperceptible (no fog when
 * the list doesn't overflow; during a whole-window repaint otherwise).
 *
 * Triggers found so far: a theme flip (the token change alone; user
 * 2026-07-14) and a sidebar card add/remove after a theme flip has primed
 * the group (delete-into-connect-screen; user 2026-07-15). Callers fire this
 * on those edges; it is a cheap DOM-only no-op when nothing is masked.
 */
export function rerasterMaskedScrollers(): void {
  const masked = document.querySelectorAll<HTMLElement>(
    ".sidebar-list, .conversation, .plan-card__list",
  );
  if (masked.length === 0) return;
  for (const el of masked) el.style.maskImage = "none";
  requestAnimationFrame(() => {
    for (const el of masked) el.style.maskImage = "";
  });
}

function stamp(): void {
  const r = resolved(currentPref);
  document.documentElement.dataset.theme = r;
  // Mirror for the index.html early stamp: the persisted pref is an async
  // IPC away at launch, so the LAST RESOLVED theme doubles as the first-
  // paint hint (boot splash + opening canvas). Best-effort — a blocked
  // localStorage just means the old light-flash on dark launches.
  try {
    localStorage.setItem("herta-theme-resolved", r);
  } catch {
    /* storage unavailable — hint skipped */
  }
  // A theme flip changes only inherited custom properties, which can leave
  // the mask groups' cached textures stale (see rerasterMaskedScrollers).
  rerasterMaskedScrollers();
}

const onSystemFlip = (): void => stamp();

/** Apply a preference: stamp <html data-theme> and (dis)arm the OS listener. */
export function applyThemePref(pref: ThemePref): void {
  currentPref = pref;
  if (pref === "system") {
    if (mql === null && window.matchMedia !== undefined) {
      mql = window.matchMedia("(prefers-color-scheme: dark)");
      mql.addEventListener("change", onSystemFlip);
    }
  } else if (mql !== null) {
    mql.removeEventListener("change", onSystemFlip);
    mql = null;
  }
  stamp();
}

/** The active preference (for the Settings row's initial value). */
export function themePref(): ThemePref {
  return currentPref;
}

/** Boot: read the persisted preference and apply it. No stored preference
 *  (first launch, fakes, the website demo) → "system": follow the OS. */
export async function initTheme(bridge: HertaBridge): Promise<void> {
  const pref = bridge.settingKeys.includes("theme")
    ? await bridge.getSetting("theme").catch(() => undefined)
    : undefined;
  applyThemePref(pref ?? "system");
}

/** Test hook: reset module state between specs. */
export function resetThemeForTest(): void {
  if (mql !== null) {
    mql.removeEventListener("change", onSystemFlip);
    mql = null;
  }
  currentPref = "light";
  delete document.documentElement.dataset.theme;
}
