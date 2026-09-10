import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { DeviceCard, SCENE_PATIENCE_MS } from "./DeviceCard.js";
import { resetDeviceSceneBackendForTest } from "./device-scene/capability.js";
import { resetDeviceScenePrefForTest } from "./device-scene/device-scene-prefs.js";
import {
  clearFrostForTest,
  readFrost,
  writeFrost,
} from "./device-scene/frost-store.js";
import { IDLE_MOUNT_SETTLE_MS } from "./device-scene/use-idle-mount.js";

// A scene stand-in that hands its callbacks to the test: what the card
// shows while the real one builds is the subject here (ADR 0057 §2.13).
const latest: {
  onLive: ((live: boolean) => void) | null;
  onSnapshot: ((dataUrl: string) => void) | null;
} = { onLive: null, onSnapshot: null };
vi.mock("./device-scene/DeviceScene.js", () => ({
  DeviceScene: (props: {
    onLive: (live: boolean) => void;
    onSnapshot?: (dataUrl: string) => void;
  }) => {
    latest.onLive = props.onLive;
    latest.onSnapshot = props.onSnapshot ?? null;
    return <canvas className="device-scene-canvas" />;
  },
}));
// The GPU path, as the card now asks it at mount (2026-09-10): jsdom has
// no WebGL2, so the real probe would answer "none" and every card here
// would be flat from the start. A machine with a path unless a test says
// otherwise.
const gpu = vi.hoisted(() => ({ backend: "webgpu" as string | null }));
vi.mock("./device-scene/capability.js", () => ({
  detectDeviceSceneBackend: () => Promise.resolve(gpu.backend),
  resetDeviceSceneBackendForTest: () => undefined,
}));

const FROST = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

const sceneAttr = (container: HTMLElement): string | null =>
  container.querySelector(".device-card")?.getAttribute("data-scene") ?? null;

describe("DeviceCard — what shows while the 3D scene builds (ADR 0057 §2.13)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    latest.onLive = null;
    latest.onSnapshot = null;
    gpu.backend = "webgpu";
    clearFrostForTest();
  });
  afterEach(() => {
    // No automatic RTL cleanup here: a card left mounted keeps re-rendering
    // the mock and steals `latest.onLive` from the next test's card.
    cleanup();
    vi.useRealTimers();
    resetDeviceScenePrefForTest();
    resetDeviceSceneBackendForTest();
    clearFrostForTest();
  });

  it("with a stored picture of the scene, the glass is that picture and the flat art is not shown; the scene's snapshot stores the next one per theme", async () => {
    writeFrost("light", FROST);
    const mock = createMockHertaBridge({ deviceSceneResult: true });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    expect(sceneAttr(container)).toBe("pending");
    const card = container.querySelector(".device-card");
    expect(card?.classList.contains("has-frost")).toBe(true);
    const img = container.querySelector("img.device-frost");
    expect(img?.getAttribute("src")).toBe(FROST);
    // The scene arrives and, settled, hands over a fresh picture.
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(IDLE_MOUNT_SETTLE_MS);
    });
    act(() => {
      latest.onLive?.(true);
    });
    expect(sceneAttr(container)).toBe("live");
    const fresh = "data:image/jpeg;base64,/9j/AAAA";
    act(() => {
      latest.onSnapshot?.(fresh);
    });
    expect(readFrost("light")).toBe(fresh);
    expect(readFrost("dark")).toBeNull();
    // Live keeps the picture in the DOM for its fade; the CSS hides it.
    expect(
      container.querySelector("img.device-frost")?.getAttribute("src"),
    ).toBe(fresh);
  });

  it("without a stored picture the glass is the bundled rendering of the scene, per theme — never the flat art (owner 2026-09-07)", async () => {
    const mock = createMockHertaBridge({ deviceSceneResult: true });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    expect(sceneAttr(container)).toBe("pending");
    const img = container.querySelector("img.device-frost");
    expect(img?.getAttribute("src")).toContain("agent_frost");
    expect(img?.getAttribute("src")).not.toContain("night");
    expect(
      container.querySelector(".device-card")?.classList.contains("has-frost"),
    ).toBe(true);
    // The resolved theme follows <html data-theme> through a
    // MutationObserver — a microtask away.
    await act(async () => {
      document.documentElement.dataset.theme = "dark";
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(
      container.querySelector("img.device-frost")?.getAttribute("src"),
    ).toContain("agent_frost_night");
    await act(async () => {
      delete document.documentElement.dataset.theme;
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
  });

  it("holds the device back from the first paint while the setting is unknown or on, then fades the 3D in on its first frame", async () => {
    const mock = createMockHertaBridge({ deviceSceneResult: true });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    // Before the pref has even loaded: pending, never a flash of flat art.
    expect(sceneAttr(container)).toBe("pending");
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(sceneAttr(container)).toBe("pending");
    await act(async () => {
      vi.advanceTimersByTime(IDLE_MOUNT_SETTLE_MS);
    });
    expect(container.querySelector(".device-scene-canvas")).not.toBeNull();
    expect(sceneAttr(container)).toBe("pending");
    act(() => {
      latest.onLive?.(true);
    });
    expect(sceneAttr(container)).toBe("live");
  });

  it("shows the flat art when the scene cannot come, and when patience runs out — then still takes a late first frame", async () => {
    const mock = createMockHertaBridge({ deviceSceneResult: true });
    const first = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    const { container } = first;
    // The pref lands in one act; the idle gate's timer starts on the
    // re-render that follows, so the advance is a second act.
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(IDLE_MOUNT_SETTLE_MS);
    });
    expect(container.querySelector(".device-scene-canvas")).not.toBeNull();
    expect(sceneAttr(container)).toBe("pending");
    act(() => {
      latest.onLive?.(false); // no GPU path / a failure
    });
    expect(sceneAttr(container)).toBeNull();
    // The pref store is module-level and loads once: start the next card
    // clean, and unmount this one so `latest.onLive` is the next card's.
    first.unmount();
    resetDeviceScenePrefForTest();

    // A fresh card whose scene never reports: patience.
    const second = createMockHertaBridge({ deviceSceneResult: true });
    const again = renderWithLocale(
      <HertaBridgeProvider bridge={second.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(sceneAttr(again.container)).toBe("pending");
    act(() => {
      vi.advanceTimersByTime(SCENE_PATIENCE_MS);
    });
    expect(sceneAttr(again.container)).toBeNull();
    act(() => {
      latest.onLive?.(true);
    });
    expect(sceneAttr(again.container)).toBe("live");
  });

  it("no GPU path: flat as soon as the probe answers, never the glass and then a cut (2026-09-10)", async () => {
    gpu.backend = null;
    const mock = createMockHertaBridge({ deviceSceneResult: true });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    // The probe and the pref land in the same few microtasks.
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(sceneAttr(container)).toBeNull();
    expect(container.querySelector("img.device-frost")).toBeNull();
    // …and the scene is never asked for, idle gate or not.
    await act(async () => {
      vi.advanceTimersByTime(IDLE_MOUNT_SETTLE_MS * 2);
    });
    expect(container.querySelector(".device-scene-canvas")).toBeNull();
  });

  it("a pref read that fails leaves the card flat once it has settled, not behind the glass for the patience", async () => {
    const mock = createMockHertaBridge({ deviceSceneResult: true });
    const bridge = {
      ...mock.bridge,
      getDeviceScene: async (): Promise<boolean> => {
        throw new Error("settings unreadable");
      },
    };
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    expect(sceneAttr(container)).toBe("pending"); // in flight
    await act(async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(sceneAttr(container)).toBeNull();
  });

  it("a bridge without the surface, or the setting off, is flat from the start / as soon as known", async () => {
    const off = createMockHertaBridge(); // no setDeviceScene surface
    const first = renderWithLocale(
      <HertaBridgeProvider bridge={off.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    expect(sceneAttr(first.container)).toBeNull();
    first.unmount();
    resetDeviceScenePrefForTest();

    const disabled = createMockHertaBridge({ deviceSceneResult: false });
    const second = renderWithLocale(
      <HertaBridgeProvider bridge={disabled.bridge}>
        <DeviceCard />
      </HertaBridgeProvider>,
    );
    expect(sceneAttr(second.container)).toBe("pending"); // the pref is in flight
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(sceneAttr(second.container)).toBeNull();
  });
});
