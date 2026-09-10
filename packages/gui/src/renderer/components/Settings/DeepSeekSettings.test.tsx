import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { DeepSeekSettings } from "./DeepSeekSettings.js";

function renderPane(mock: ReturnType<typeof createMockHertaBridge>) {
  return renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <DeepSeekSettings />
    </HertaBridgeProvider>,
  );
}

describe("DeepSeekSettings", () => {
  it("shows 'No key set' when no key is stored", async () => {
    const mock = createMockHertaBridge();
    const { queryByText } = renderPane(mock);
    await waitFor(() => expect(queryByText("No key set")).toBeTruthy());
  });

  it("shows the masked Connected status (…last4)", async () => {
    const mock = createMockHertaBridge({
      deepSeekKeyStatus: { set: true, hint: "1234", encrypted: true },
    });
    const { queryByText } = renderPane(mock);
    await waitFor(() => expect(queryByText(/Connected · …1234/)).toBeTruthy());
  });

  it("Save sends the key and refreshes to Connected", async () => {
    const mock = createMockHertaBridge();
    const { getByLabelText, getByText, queryByText } = renderPane(mock);
    await waitFor(() => expect(queryByText("No key set")).toBeTruthy());
    fireEvent.change(getByLabelText("DeepSeek API key"), {
      target: { value: "sk-zzzz9876" },
    });
    fireEvent.click(getByText("Save"));
    await waitFor(() =>
      expect(mock.calls.setDeepSeekKey).toEqual(["sk-zzzz9876"]),
    );
    await waitFor(() => expect(queryByText(/Connected · …9876/)).toBeTruthy());
  });

  it("a rejected key shows an error and does NOT become Connected", async () => {
    const mock = createMockHertaBridge({ rejectDeepSeekKey: true });
    const { getByLabelText, getByText, queryByText } = renderPane(mock);
    await waitFor(() => expect(queryByText("No key set")).toBeTruthy());
    fireEvent.change(getByLabelText("DeepSeek API key"), {
      target: { value: "sk-wrong-key" },
    });
    fireEvent.click(getByText("Save"));
    await waitFor(() =>
      expect(queryByText(/DeepSeek rejected that key/)).toBeTruthy(),
    );
    // Still not connected — the wrong key was never stored.
    expect(queryByText("No key set")).toBeTruthy();
    expect(queryByText(/Connected/)).toBeNull();
  });

  describe("model rows (2026-08-17)", () => {
    it("loads the persisted choice into both Selects", async () => {
      const mock = createMockHertaBridge({
        getModelConfigResult: {
          actor: "deepseek-flash",
          backend: "deepseek-v4-pro",
        },
      });
      const { getByLabelText } = renderPane(mock);
      const actor = getByLabelText("Conversation model");
      const backend = getByLabelText("Coprocessor model");
      await waitFor(() => expect(actor.textContent).toContain("Flash"));
      expect(backend.textContent).toContain("Pro");
      expect(mock.calls.getModelConfig).toBe(1);
    });

    it("a pick persists the FULL config (both stages) and shows no dynamic restart note", async () => {
      const mock = createMockHertaBridge();
      const { getByLabelText, getByRole, queryByText } = renderPane(mock);
      const actor = getByLabelText("Conversation model");
      await waitFor(() => expect(actor.textContent).toContain("Pro"));
      fireEvent.click(actor);
      fireEvent.click(getByRole("option", { name: "Flash" }));
      // Backend rides along at its default (the flash — the vision-capable
      // one since the 2026-09 rename, ADR 0048 §5a/§5b).
      expect(mock.calls.setModelConfig).toEqual([
        { actor: "deepseek-flash", backend: "deepseek-flash" },
      ]);
      // The restart fact lives in the intro (static), like the thinking row.
      expect(queryByText("Restart to apply")).toBeNull();
      expect(queryByText(/apply after a restart/)).toBeTruthy();
    });

    it("a failed write snaps back and shows the error note", async () => {
      const mock = createMockHertaBridge({ failSetModelConfig: true });
      const { getByLabelText, getByRole, queryByText } = renderPane(mock);
      const backend = getByLabelText("Coprocessor model");
      // Default flash (2026-08-17); the failed pick of Pro snaps back to it.
      await waitFor(() => expect(backend.textContent).toContain("Flash"));
      fireEvent.click(backend);
      fireEvent.click(getByRole("option", { name: "Pro" }));
      await waitFor(() => expect(queryByText(/Couldn't save/)).toBeTruthy());
      expect(backend.textContent).toContain("Flash");
    });

    it("hides the rows when the bridge has no setModelConfig", async () => {
      const mock = createMockHertaBridge();
      const { setModelConfig: _s, getModelConfig: _g, ...bare } = mock.bridge;
      const { queryByLabelText, queryByText } = renderWithLocale(
        <HertaBridgeProvider bridge={bare as typeof mock.bridge}>
          <DeepSeekSettings />
        </HertaBridgeProvider>,
      );
      await waitFor(() => expect(queryByText("No key set")).toBeTruthy());
      expect(queryByLabelText("Conversation model")).toBeNull();
    });
  });

  it("Delete clears the key and returns to 'No key set'", async () => {
    const mock = createMockHertaBridge({
      deepSeekKeyStatus: { set: true, hint: "1234", encrypted: true },
    });
    const { getByText, queryByText } = renderPane(mock);
    await waitFor(() => expect(queryByText(/Connected/)).toBeTruthy());
    fireEvent.click(getByText("Delete key"));
    await waitFor(() => expect(mock.calls.clearDeepSeekKey).toBe(1));
    await waitFor(() => expect(queryByText("No key set")).toBeTruthy());
  });

  it("guards Delete against a double-click while one is in flight", async () => {
    const mock = createMockHertaBridge({
      deepSeekKeyStatus: { set: true, hint: "1234", encrypted: true },
    });
    // Make clearDeepSeekKey hang so the first click stays in flight.
    let calls = 0;
    Object.assign(mock.bridge, {
      clearDeepSeekKey: () => {
        calls += 1;
        return new Promise(() => {}); // never resolves
      },
    });
    const { getByText, queryByText } = renderPane(mock);
    await waitFor(() => expect(queryByText(/Connected/)).toBeTruthy());
    const del = getByText("Delete key");
    fireEvent.click(del);
    // The button now reads "Deleting…" and is disabled — a second click no-ops.
    await waitFor(() => expect(queryByText("Deleting…")).toBeTruthy());
    fireEvent.click(getByText("Deleting…"));
    expect(calls).toBe(1);
  });

  it("disables Save and Delete mid-turn with a guard note", async () => {
    const mock = createMockHertaBridge({
      deepSeekKeyStatus: { set: true, hint: "1234", encrypted: true },
    });
    const { getByText, getByLabelText, queryByText } = renderPane(mock);
    await waitFor(() => expect(queryByText(/Connected/)).toBeTruthy());
    // A turn starts → the store goes busy (thinking).
    mock.emitTurn({ kind: "started", turnId: "t1" });
    await waitFor(() =>
      expect(queryByText("Finish the current turn first")).toBeTruthy(),
    );
    expect((getByText("Save") as HTMLButtonElement).disabled).toBe(true);
    expect((getByText("Delete key") as HTMLButtonElement).disabled).toBe(true);
    expect(
      (getByLabelText("DeepSeek API key") as HTMLInputElement).disabled,
    ).toBe(true);
  });
});
