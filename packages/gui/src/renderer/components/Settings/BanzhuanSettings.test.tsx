import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import type { HertaBridge, Locale } from "../../ipc/bridge-types.js";
import {
  createMockHertaBridge,
  type MockHertaBridge,
} from "../../ipc/mock-bridge.js";
import { resetDeviceScenePrefForTest } from "../UtilityRail/device-scene/device-scene-prefs.js";
import { BanzhuanSettings } from "./BanzhuanSettings.js";

const captionName = (c: HTMLElement): string | null =>
  c.querySelector(".settings-bz-caption-name")?.textContent ?? null;

function renderPane(
  mock: MockHertaBridge = createMockHertaBridge(),
  locale?: Locale,
): ReturnType<typeof renderWithLocale> {
  return renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <BanzhuanSettings />
    </HertaBridgeProvider>,
    locale !== undefined ? { locale } : {},
  );
}

describe("BanzhuanSettings", () => {
  describe("demo card + legend", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("renders the explainer, the demo card, an idle caption, and a 5-state legend", () => {
      const { container, getByText } = renderPane();
      // The intro prose (en locale; in Herta's own hand since 2026-09-29, and
      // compact so the pane stays inside the card's stable height floor).
      expect(getByText(/I call it the Brick/)).toBeTruthy();
      expect(container.querySelector(".settings-bz-card")).toBeTruthy();
      // Caption shows the single locale word for the current state.
      expect(captionName(container)).toBe("Idle");
      expect(
        container.querySelectorAll(".settings-bz-legend-item").length,
      ).toBe(5);
    });

    it("shows @板砖 as the code trigger under a zh UI", () => {
      const { container } = renderPane(undefined, "zh");
      expect(container.querySelector("code")?.textContent).toBe("@板砖");
    });

    it("shows @Brick as the code trigger under an en UI (no lone CJK token in an English panel)", () => {
      // The token follows the UI locale like the surrounding prose — the pane can
      // be open with no active session, so it must not depend on session lang.
      const { container } = renderPane(undefined, "en");
      expect(container.querySelector("code")?.textContent).toBe("@Brick");
    });

    it("advances the caption as the cycle runs, and hover pauses it", () => {
      const { container } = renderPane();
      act(() => vi.advanceTimersByTime(1600));
      expect(captionName(container)).toBe("Working");
      // Hover the card → the cycle holds.
      const card = container.querySelector(".settings-bz-card") as HTMLElement;
      fireEvent.mouseEnter(card);
      act(() => vi.advanceTimersByTime(10_000));
      expect(captionName(container)).toBe("Working");
    });
  });

  describe("thinking-effort row", () => {
    it("loads the persisted tier into the Select", async () => {
      const mock = createMockHertaBridge({
        getBackendConfigResult: { thinking: "low" },
      });
      renderPane(mock);
      const trigger = screen.getByLabelText("Thinking effort");
      await waitFor(() => expect(trigger.textContent).toContain("Low"));
      expect(mock.calls.getBackendConfig).toBe(1);
    });

    it("a pick persists via the bridge, with no dynamic restart note (the description carries it)", async () => {
      const mock = createMockHertaBridge();
      const { queryByText } = renderPane(mock);
      const trigger = screen.getByLabelText("Thinking effort");
      await waitFor(() => expect(trigger.textContent).toContain("High"));

      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("option", { name: "Max" }));
      expect(mock.calls.setBackendConfig).toEqual([{ thinking: "max" }]);
      // No appearing note — it re-flowed the pane height (owner 2026-08-03);
      // "Applies on the next launch" lives in the row description instead.
      expect(queryByText("Restart to apply")).toBeNull();
      // (both the thinking and the tool-contract descriptions carry it)
      expect(screen.queryAllByText(/next launch/).length).toBeGreaterThan(0);
    });

    it("the row sits ABOVE the demo card so the Select menu opens into the demo's space", async () => {
      const { container } = renderPane();
      const row = container.querySelector(".settings-row");
      const demo = container.querySelector(".settings-bz-demo");
      expect(row).toBeTruthy();
      expect(demo).toBeTruthy();
      // DOM order pins the layout decision: menu is an in-flow absolute box
      // (no portal), so at the pane's bottom edge it clipped against the card.
      expect(
        row!.compareDocumentPosition(demo!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("a failed write snaps back and surfaces the error", async () => {
      const mock = createMockHertaBridge({ failSetBackendConfig: true });
      const { queryByText } = renderPane(mock);
      const trigger = screen.getByLabelText("Thinking effort");
      await waitFor(() => expect(trigger.textContent).toContain("High"));

      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("option", { name: "Low" }));
      await waitFor(() =>
        expect(queryByText("Could not save — try again.")).toBeTruthy(),
      );
      // Snapped back to the value on disk; no restart note for a failed write.
      expect(trigger.textContent).toContain("High");
      expect(queryByText("Restart to apply")).toBeNull();
    });

    it("hides the row entirely when the bridge lacks the surface (fakes / website demo)", () => {
      const mock = createMockHertaBridge();
      const { setBackendConfig: _omit, ...rest } = mock.bridge;
      renderWithLocale(
        <HertaBridgeProvider bridge={rest as HertaBridge}>
          <BanzhuanSettings />
        </HertaBridgeProvider>,
      );
      expect(screen.queryByLabelText("Thinking effort")).toBeNull();
    });
  });

  describe("tool-contract row (ADR 0040)", () => {
    it("loads the persisted contract; a pick persists {thinking, contract} together", async () => {
      const mock = createMockHertaBridge({
        getBackendConfigResult: {
          thinking: "low",
          contract: "minimal",
          bashFound: true,
        },
      });
      const { queryByText } = renderPane(mock);
      // The row appears once the config (with `contract`) has loaded.
      const trigger = await screen.findByLabelText("Tool contract");
      await waitFor(() => expect(trigger.textContent).toContain("Minimal"));
      // bash present → no fallback sentence
      expect(queryByText(/No bash was found/)).toBeNull();
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("option", { name: "Standard" }));
      expect(mock.calls.setBackendConfig).toEqual([
        { thinking: "low", contract: "standard" },
      ]);
    });

    it("says so in the description when no bash was found (Minimal would run as Standard)", async () => {
      const mock = createMockHertaBridge({
        getBackendConfigResult: {
          thinking: "high",
          contract: "standard",
          bashFound: false,
        },
      });
      const { queryByText } = renderPane(mock);
      await waitFor(() =>
        expect(queryByText(/No bash on this machine/)).toBeTruthy(),
      );
      // ADR 0044: the sentence names the remedy, not just the problem.
      expect(queryByText(/Install Git for Windows/)).toBeTruthy();
    });

    it("is on the FIRST paint beside the thinking row — never two rows then three (owner 2026-09-07); a config without `contract` keeps the default", async () => {
      const mock = createMockHertaBridge({
        getBackendConfigResult: { thinking: "high" },
      });
      const { container } = renderPane(mock);
      // Synchronously, before the config read resolves: both backend rows
      // (the 3D row hides on this mock, which lacks its surface).
      expect(screen.getByLabelText("Tool contract")).toBeInTheDocument();
      expect(container.querySelectorAll(".settings-row")).toHaveLength(2);
      const thinking = screen.getByLabelText("Thinking effort");
      await waitFor(() => expect(thinking.textContent).toContain("High"));
      // The row stays, on the handler's default, when the config says nothing.
      expect(screen.getByLabelText("Tool contract").textContent).toContain(
        "Minimal",
      );
      expect(container.querySelectorAll(".settings-row")).toHaveLength(2);
    });

    it("a failed write snaps back and surfaces the error", async () => {
      const mock = createMockHertaBridge({ failSetBackendConfig: true });
      const { queryByText } = renderPane(mock);
      const trigger = await screen.findByLabelText("Tool contract");
      // Default minimal (owner flip 2026-08-17); the failed pick of
      // Standard snaps back to it.
      await waitFor(() => expect(trigger.textContent).toContain("Minimal"));
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("option", { name: "Standard" }));
      await waitFor(() =>
        expect(queryByText("Could not save — try again.")).toBeTruthy(),
      );
      expect(trigger.textContent).toContain("Minimal");
    });
  });

  describe("the 3D device (ADR 0057)", () => {
    afterEach(() => resetDeviceScenePrefForTest());

    it("has no row — the lit device is always on where the GPU allows it (owner 2026-10-01, §2.7 amended)", () => {
      // Even on the desktop's bridge, which draws the scene.
      const { container } = renderPane(
        createMockHertaBridge({ deviceSceneResult: true }),
      );
      expect(screen.queryByLabelText("3D device")).toBeNull();
      expect(container.textContent).not.toContain("3D device");
    });

    it("the demo card below stays on the flat renders — one GPU scene per app", () => {
      const mock = createMockHertaBridge({ deviceSceneResult: true });
      const { container } = renderPane(mock);
      expect(
        container.querySelector(".settings-bz-card .device-scene-canvas"),
      ).toBeNull();
      expect(
        container.querySelector(".settings-bz-card img.agent-device-img"),
      ).not.toBeNull();
    });
  });

  describe("PDF picture transcription row (2026-10-01)", () => {
    it("hides the row when the bridge lacks the surface (fakes / website demo)", () => {
      renderPane(createMockHertaBridge());
      expect(screen.queryByLabelText("Transcribe PDF pictures")).toBeNull();
    });

    it("loads the stored value, and a flip persists through the bridge", async () => {
      const mock = createMockHertaBridge({
        pdfPictureTranscriptsResult: false,
      });
      renderPane(mock);
      const toggle = await screen.findByLabelText("Transcribe PDF pictures");
      await waitFor(() =>
        expect(toggle.getAttribute("aria-checked")).toBe("false"),
      );
      fireEvent.click(toggle);
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      await waitFor(() =>
        expect(mock.calls.setPdfPictureTranscripts).toEqual([true]),
      );
    });

    it("a failed write snaps back and says it could not save", async () => {
      const mock = createMockHertaBridge({
        pdfPictureTranscriptsResult: true,
        failSetPdfPictureTranscripts: true,
      });
      const { queryByText } = renderPane(mock);
      const toggle = await screen.findByLabelText("Transcribe PDF pictures");
      await waitFor(() =>
        expect(toggle.getAttribute("aria-checked")).toBe("true"),
      );
      fireEvent.click(toggle);
      await waitFor(() =>
        expect(queryByText("Could not save — try again.")).toBeTruthy(),
      );
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });
  });
});
