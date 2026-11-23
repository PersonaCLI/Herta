import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import {
  createMockHertaBridge,
  type MockHertaBridgeOpts,
  withSetting,
} from "../../ipc/mock-bridge.js";
import { LanguageSettings } from "./LanguageSettings.js";

function setup(opts: MockHertaBridgeOpts = {}) {
  const mock = createMockHertaBridge(opts);
  renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <LanguageSettings />
    </HertaBridgeProvider>,
  );
  return mock;
}

describe("LanguageSettings — the UI-language row persists, and says when it could not (UX review 2026-09-22, item 17)", () => {
  it("a pick applies live and is written through the bridge", async () => {
    const mock = createMockHertaBridge();
    const setLocale = vi.fn(async () => undefined);
    Object.assign(
      mock.bridge,
      withSetting(mock.bridge, "locale", { set: setLocale }),
    );
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <LanguageSettings />
      </HertaBridgeProvider>,
    );
    fireEvent.click(screen.getByLabelText("Display language"));
    fireEvent.click(screen.getByRole("option", { name: "中文" }));
    expect(setLocale).toHaveBeenCalledWith("zh");
    // Live: the pane itself now speaks Chinese.
    expect(
      screen.queryByRole("button", { name: "Display language" }),
    ).toBeNull();
  });

  it("a failed write snaps the UI back to the stored language and says it could not save", async () => {
    const mock = createMockHertaBridge();
    Object.assign(
      mock.bridge,
      withSetting(mock.bridge, "locale", {
        set: async () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    );
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <LanguageSettings />
      </HertaBridgeProvider>,
    );
    fireEvent.click(screen.getByLabelText("Display language"));
    fireEvent.click(screen.getByRole("option", { name: "中文" }));
    expect(
      await screen.findByText("Could not save — try again."),
    ).toBeInTheDocument();
    // Back in English: the trigger is labelled in the stored language again.
    expect(
      screen.getByRole("button", { name: "Display language" }).textContent,
    ).toContain("English");
  });
});

describe("LanguageSettings — interaction-language row (slice 4)", () => {
  it("renders the interaction row next to the UI-language row", () => {
    setup();
    expect(screen.getByLabelText("Display language")).toBeInTheDocument();
    expect(screen.getByLabelText("Interaction language")).toBeInTheDocument();
    // The description says it applies to NEW sessions and that EN sessions
    // have no voice this release.
    expect(
      screen.getByText(
        "The language Herta speaks in. Applies to new sessions; English sessions have no voice yet.",
      ),
    ).toBeInTheDocument();
  });

  it("defaults to Follow UI language and loads a stored choice", async () => {
    setup({ interactionLanguageResult: "en" });
    // The stored "en" loads async and replaces the "follow" default.
    await waitFor(() =>
      expect(
        screen.getByLabelText("Interaction language").textContent,
      ).toContain("English"),
    );
  });

  it("persists a picked language through the bridge", async () => {
    const mock = setup();
    await waitFor(() =>
      expect(mock.calls.getInteractionLanguage).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByLabelText("Interaction language"));
    fireEvent.click(screen.getByText("中文"));
    expect(mock.calls.setInteractionLanguage).toEqual(["zh"]);
  });

  it('persists "follow" (deletes the stored field server-side)', async () => {
    const mock = setup({ interactionLanguageResult: "en" });
    await waitFor(() =>
      expect(
        screen.getByLabelText("Interaction language").textContent,
      ).toContain("English"),
    );
    fireEvent.click(screen.getByLabelText("Interaction language"));
    fireEvent.click(screen.getByText("Follow UI language"));
    expect(mock.calls.setInteractionLanguage).toEqual(["follow"]);
  });

  it("snaps back and shows an error note when the write fails", async () => {
    const mock = setup({ failSetInteractionLanguage: true });
    await waitFor(() =>
      expect(mock.calls.getInteractionLanguage).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByLabelText("Interaction language"));
    fireEvent.click(screen.getByText("中文"));
    // The failed persist reverts the optimistic pick to the "follow" default.
    await waitFor(() =>
      expect(
        screen.getByLabelText("Interaction language").textContent,
      ).toContain("Follow UI language"),
    );
    expect(mock.calls.setInteractionLanguage).toEqual(["zh"]);
    expect(screen.getByText("Could not save — try again.")).toBeInTheDocument();
  });
});
