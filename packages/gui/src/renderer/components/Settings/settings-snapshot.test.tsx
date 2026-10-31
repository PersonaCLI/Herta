import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import type { DeepSeekKeyStatus } from "../../ipc/bridge-types.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { DeepSeekSettings } from "./DeepSeekSettings.js";
import { FlowSettings } from "./FlowSettings.js";
import { SettingsModal } from "./SettingsModal.js";
import {
  peekSetting,
  primeSettings,
  rememberSetting,
} from "./settings-snapshot.js";

const CONNECTED: DeepSeekKeyStatus = {
  set: true,
  hint: "30fc",
  encrypted: true,
};

/** Let every already-resolved promise chain run (the mock bridge's reads
 *  are plain async functions). */
const settle = (): Promise<void> => act(async () => {});

describe("settings snapshot — a pane's first frame shows the last-known state (owner 2026-09-18)", () => {
  it("primeSettings reads what the panes read and keeps it per bridge", async () => {
    const a = createMockHertaBridge({
      deepSeekKeyStatus: CONNECTED,
      getDreamConfigResult: { enabled: false },
    });
    const b = createMockHertaBridge();
    expect(peekSetting(a.bridge, "deepseek.keyStatus")).toBeUndefined();
    primeSettings(a.bridge);
    await settle();
    expect(peekSetting(a.bridge, "deepseek.keyStatus")).toEqual(CONNECTED);
    expect(peekSetting(a.bridge, "dream.enabled")).toBe(false);
    expect(peekSetting(a.bridge, "voice.engine")).toBeDefined();
    // Another bridge — another app, or the next test — starts empty.
    expect(peekSetting(b.bridge, "deepseek.keyStatus")).toBeUndefined();
  });

  it("a prime that began before a pane's write does not put the older value back", async () => {
    const mock = createMockHertaBridge({
      getDreamConfigResult: { enabled: true },
    });
    primeSettings(mock.bridge); // in flight, will answer `true`
    rememberSetting(mock.bridge, "dream.enabled", false); // the user's flip
    await settle();
    expect(peekSetting(mock.bridge, "dream.enabled")).toBe(false);
  });

  it("DeepSeek pane: a primed status is on the FIRST frame — no 检查中… and the delete link already there", async () => {
    const mock = createMockHertaBridge({ deepSeekKeyStatus: CONNECTED });
    primeSettings(mock.bridge);
    await settle();
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeepSeekSettings />
      </HertaBridgeProvider>,
    );
    // Synchronously after render — before the pane's own read can answer.
    expect(container.querySelector(".settings-key-state")?.textContent).toBe(
      "Connected · …30fc",
    );
    expect(container.querySelector(".settings-key-delete")).not.toBeNull();
    await settle();
  });

  it("DeepSeek pane, nothing read yet: still says it is checking, then lands — the old behavior is the fallback", async () => {
    const mock = createMockHertaBridge({ deepSeekKeyStatus: CONNECTED });
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DeepSeekSettings />
      </HertaBridgeProvider>,
    );
    expect(container.querySelector(".settings-key-state")?.textContent).toBe(
      "Checking…",
    );
    await waitFor(() =>
      expect(container.querySelector(".settings-key-state")?.textContent).toBe(
        "Connected · …30fc",
      ),
    );
    // …and what it learned is what the next mount starts from.
    expect(peekSetting(mock.bridge, "deepseek.keyStatus")).toEqual(CONNECTED);
  });

  it("the modal primes on open: switching into Voice on the cloud engine paints the key rows at once, never the local-model row", async () => {
    const mock = createMockHertaBridge({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        engine: "minimax",
      },
    });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SettingsModal open={true} onClose={() => {}} />
      </HertaBridgeProvider>,
    );
    await settle(); // the prime answers while the first section is up
    fireEvent.click(screen.getByRole("button", { name: "Voice" }));
    // Synchronously after the click: the pane's own read has not answered.
    expect(screen.queryByText("Voice model")).toBeNull();
    expect(screen.getByLabelText("MiniMax API key")).toBeTruthy();
  });

  it("a change made in a pane is what the pane shows on the way back", async () => {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SettingsModal open={true} onClose={() => {}} />
      </HertaBridgeProvider>,
    );
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Window" }));
    const toggle = screen.getByLabelText("Close to tray");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Dream" }));
    fireEvent.click(screen.getByRole("button", { name: "Window" }));
    // First frame of the remount — the mock's read would still say `true`
    // only if the write had been lost; the store already says `false`.
    expect(
      screen.getByLabelText("Close to tray").getAttribute("aria-checked"),
    ).toBe("false");
    await settle();
  });

  it("信息流 pane: the switch and the picked chips are on in the FIRST frame (owner 2026-10-31)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      flowSettings: async () => ({ enabled: true, topics: ["ai", "space"] }),
      flowState: async () => ({
        enabled: true,
        gathering: null,
        failed: null,
        unreadIssueId: null,
        refreshesLeft: 2,
      }),
    });
    primeSettings(mock.bridge);
    await settle();
    const { container } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <FlowSettings />
      </HertaBridgeProvider>,
    );
    // Before the pane's own reads answer: already on, nothing to switch.
    expect(
      screen.getByLabelText("Turn on Flow").getAttribute("aria-checked"),
    ).toBe("true");
    expect(container.querySelectorAll(".flow-topic-chip.is-on")).toHaveLength(
      2,
    );
    await settle();
  });
});
