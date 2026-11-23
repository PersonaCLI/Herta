import { afterEach, describe, expect, it, vi } from "vitest";
import type { HertaBridge } from "../ipc/bridge-types.js";
import {
  applyThemePref,
  initTheme,
  resetThemeForTest,
  themePref,
} from "./theme.js";

/** Controllable prefers-color-scheme fake. */
function fakeMatchMedia(initialDark: boolean): {
  flip: (dark: boolean) => void;
  restore: () => void;
} {
  let dark = initialDark;
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const original = window.matchMedia;
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes("dark") ? dark : false,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
        listeners.add(cb);
      },
      removeEventListener: (
        _: string,
        cb: (e: { matches: boolean }) => void,
      ) => {
        listeners.delete(cb);
      },
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  return {
    flip: (d) => {
      dark = d;
      for (const cb of listeners) cb({ matches: d });
    },
    restore: () => {
      window.matchMedia = original;
    },
  };
}

afterEach(() => {
  resetThemeForTest();
});

describe("theme controller", () => {
  it("stamps data-theme for explicit light/dark", () => {
    applyThemePref("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(themePref()).toBe("dark");
    applyThemePref("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("mirrors the RESOLVED theme to localStorage (the index.html early stamp)", () => {
    applyThemePref("dark");
    expect(localStorage.getItem("herta-theme-resolved")).toBe("dark");
    applyThemePref("light");
    expect(localStorage.getItem("herta-theme-resolved")).toBe("light");
  });

  it("system resolves via prefers-color-scheme and follows a live OS flip", () => {
    const mm = fakeMatchMedia(true);
    applyThemePref("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    mm.flip(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    mm.flip(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    mm.restore();
  });

  it("leaving system disarms the OS listener (no stale flips)", () => {
    const mm = fakeMatchMedia(false);
    applyThemePref("system");
    applyThemePref("light");
    mm.flip(true); // must NOT re-stamp dark — the listener is gone
    expect(document.documentElement.dataset.theme).toBe("light");
    mm.restore();
  });

  it("re-rasters the masked scrollers on a flip (stale mask-group paint, 2026-07-14)", () => {
    // Chromium sometimes kept the fog'd scrollers' cached textures across a
    // token flip — sidebar cards rendered with the previous theme's ink
    // until hovered. stamp() must drop each mask for one frame and restore.
    const rafCbs: FrameRequestCallback[] = [];
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        rafCbs.push(cb);
        return rafCbs.length;
      });
    const list = document.createElement("div");
    list.className = "sidebar-list";
    const pane = document.createElement("div");
    pane.className = "conversation";
    document.body.append(list, pane);
    applyThemePref("dark");
    expect(list.style.maskImage).toBe("none");
    expect(pane.style.maskImage).toBe("none");
    for (const cb of rafCbs.splice(0)) cb(0);
    expect(list.style.maskImage).toBe("");
    expect(pane.style.maskImage).toBe("");
    list.remove();
    pane.remove();
    rafSpy.mockRestore();
  });

  it("initTheme applies the bridge's persisted preference", async () => {
    const bridge = {
      settingKeys: ["theme"],
      getSetting: vi.fn(async () => "dark" as const),
    } as unknown as HertaBridge;
    await initTheme(bridge);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("initTheme defaults to SYSTEM when the host lacks the theme setting or the read rejects (first launch follows the OS)", async () => {
    const mm = fakeMatchMedia(true); // dark OS
    await initTheme({ settingKeys: [] } as unknown as HertaBridge);
    expect(themePref()).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    const failing = {
      settingKeys: ["theme"],
      getSetting: vi.fn(async () => {
        throw new Error("io");
      }),
    } as unknown as HertaBridge;
    mm.flip(false); // light OS
    await initTheme(failing);
    expect(themePref()).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("light");
    mm.restore();
  });
});
