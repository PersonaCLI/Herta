import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { resetThemeForTest } from "../../lib/theme.js";
import { resetTrailblazerAvatarForTest } from "../../lib/trailblazer-avatar.js";
import { WindowSettings } from "./WindowSettings.js";

afterEach(() => {
  resetThemeForTest();
  resetTrailblazerAvatarForTest();
});

function setup(platform?: string) {
  const mock = createMockHertaBridge(
    platform !== undefined ? { platform } : {},
  );
  renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <WindowSettings />
    </HertaBridgeProvider>,
  );
  return mock;
}

describe("WindowSettings avatar row (ADR 0085 amendment 2026-11-05)", () => {
  it("offers both avatars with the male mark picked, and a pick persists", () => {
    setup();
    expect(screen.getByRole("radiogroup", { name: "Avatar" })).toBeTruthy();
    const male = screen.getByRole("radio", { name: "Male" });
    const female = screen.getByRole("radio", { name: "Female" });
    expect(male).toBeChecked();
    fireEvent.click(female);
    expect(female).toBeChecked();
    expect(male).not.toBeChecked();
    expect(localStorage.getItem("herta.trailblazer.avatar")).toBe("female");
  });
});

describe("WindowSettings appearance row (night-mode slice 2)", () => {
  it("renders the Appearance select alongside close-to-tray", () => {
    setup();
    expect(screen.getByLabelText("Appearance")).toBeInTheDocument();
    expect(screen.getByLabelText("Close to tray")).toBeInTheDocument();
  });

  it("on a Mac the row says menu bar, and does not claim that turning it off quits (2026-09-23)", () => {
    setup("darwin");
    expect(screen.getByLabelText("Close to menu bar")).toBeInTheDocument();
    expect(screen.queryByText(/system tray/)).toBeNull();
    expect(screen.getByText(/stays in the Dock until you quit/)).toBeTruthy();
  });

  it("picking Dark stamps <html data-theme> LIVE and persists via the bridge", () => {
    const mock = setup();
    fireEvent.click(screen.getByLabelText("Appearance"));
    fireEvent.click(screen.getByText("Dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(mock.calls.setTheme).toEqual(["dark"]);
  });

  it("picking System resolves via prefers-color-scheme (stub: light)", () => {
    const mock = setup();
    fireEvent.click(screen.getByLabelText("Appearance"));
    fireEvent.click(screen.getByText("System"));
    // The setup-tests matchMedia stub reports matches:false → light.
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(mock.calls.setTheme).toEqual(["system"]);
  });
});

describe("WindowSettings — composer predictions (2026-10-10)", () => {
  it("shows the switch when the bridge has it, reads it, and persists a change", async () => {
    const mock = createMockHertaBridge({ composerPredictionsResult: true });
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <WindowSettings />
      </HertaBridgeProvider>,
    );
    const toggle = await screen.findByLabelText("Composer predictions");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(mock.calls.setComposerPredictions).toEqual([false]);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("hides the row when the bridge has no such surface (the website demo)", () => {
    setup();
    expect(screen.queryByLabelText("Composer predictions")).toBeNull();
  });
});
