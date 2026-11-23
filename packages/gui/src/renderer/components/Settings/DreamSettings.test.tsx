import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge, withSetting } from "../../ipc/mock-bridge.js";
import { DreamSettings } from "./DreamSettings.js";

describe("DreamSettings", () => {
  it("is OFF on the first frame when nothing has been read, and says what turning it on costs (opt-in, 2026-09-21)", () => {
    // A read that never answers: what paints is the pane's own fallback.
    const mock = createMockHertaBridge();
    Object.assign(
      mock.bridge,
      withSetting(mock.bridge, "dream", { get: () => new Promise(() => {}) }),
    );
    const { getByLabelText, getByText } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DreamSettings />
      </HertaBridgeProvider>,
    );
    expect(getByLabelText("Enable Dream").getAttribute("aria-checked")).toBe(
      "false",
    );
    // The row names the one trade-off that makes this a choice.
    expect(getByText(/uses your DeepSeek API quota/)).toBeTruthy();
  });

  it("reflects the persisted value, writes on toggle, shows the restart note", async () => {
    const mock = createMockHertaBridge({
      getDreamConfigResult: { enabled: false },
    });
    const { getByLabelText, queryByText } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DreamSettings />
      </HertaBridgeProvider>,
    );
    const toggle = getByLabelText("Enable Dream");
    // The async Dream read resolves → toggle reflects enabled:false.
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    // No restart note until the user changes it.
    expect(queryByText("Restart to apply")).toBeNull();
    fireEvent.click(toggle);
    expect(mock.calls.setDreamConfig).toEqual([{ enabled: true }]);
    expect(queryByText("Restart to apply")).toBeTruthy();
  });

  it("hides the restart note when toggled back to the original value", async () => {
    const mock = createMockHertaBridge({
      getDreamConfigResult: { enabled: true },
    });
    const { getByLabelText, queryByText } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DreamSettings />
      </HertaBridgeProvider>,
    );
    const toggle = getByLabelText("Enable Dream");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    fireEvent.click(toggle); // off → differs from the loaded value
    expect(queryByText("Restart to apply")).toBeTruthy();
    fireEvent.click(toggle); // back on → matches the loaded value
    expect(queryByText("Restart to apply")).toBeNull();
  });

  it("compares against what the RUNNING app uses, so a pane reopened after a change still says restart (dream review 2026-09-22, finding 20)", async () => {
    // Saved ON in an earlier visit to the pane; the app still runs with OFF.
    const mock = createMockHertaBridge({
      getDreamConfigResult: { enabled: true, running: false },
    });
    const { getByLabelText, queryByText } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DreamSettings />
      </HertaBridgeProvider>,
    );
    const toggle = getByLabelText("Enable Dream");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    expect(queryByText("Restart to apply")).toBeTruthy();
    fireEvent.click(toggle); // back to what the app runs with
    expect(queryByText("Restart to apply")).toBeNull();
  });

  it("reverts and surfaces an error if the write fails", async () => {
    const mock = createMockHertaBridge({
      getDreamConfigResult: { enabled: true },
    });
    Object.assign(
      mock.bridge,
      withSetting(mock.bridge, "dream", {
        set: async () => {
          throw new Error("disk full");
        },
      }),
    );
    const { getByLabelText, queryByText } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <DreamSettings />
      </HertaBridgeProvider>,
    );
    const toggle = getByLabelText("Enable Dream");
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    fireEvent.click(toggle); // optimistic off → write fails → snaps back on
    await waitFor(() =>
      expect(queryByText("Could not save — try again.")).toBeTruthy(),
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(queryByText("Restart to apply")).toBeNull();
  });
});
