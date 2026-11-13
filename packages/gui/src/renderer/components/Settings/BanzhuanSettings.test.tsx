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

    it("the ring in the drawing takes the legend's swatch for the state on show", () => {
      // One colour per state, said once (STATE_META): the drawing cannot
      // drift from the legend under it.
      const { container } = renderPane();
      const card = container.querySelector(".settings-bz-card") as HTMLElement;
      const led = (): string => {
        const hex = card.style.getPropertyValue("--bz-led");
        const [r, g, b] = [1, 3, 5].map((i) =>
          Number.parseInt(hex.slice(i, i + 2), 16),
        );
        return `rgb(${r}, ${g}, ${b})`;
      };
      const swatch = (label: string): string => {
        const item = [
          ...container.querySelectorAll(".settings-bz-legend-item"),
        ].find((el) => el.textContent === label);
        return (item?.querySelector(".settings-bz-dot") as HTMLElement).style
          .backgroundColor;
      };
      expect(led()).toBe(swatch("Idle"));
      act(() => vi.advanceTimersByTime(1600));
      expect(card.getAttribute("data-state")).toBe("delegated");
      expect(led()).toBe(swatch("Working"));
      act(() => vi.advanceTimersByTime(2600));
      expect(card.getAttribute("data-state")).toBe("waitingApproval");
      expect(led()).toBe(swatch("Awaiting approval"));
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
      // when it applies lives in the row descriptions instead: the effort
      // from the next delegation (ADR 0081).
      expect(queryByText("Restart to apply")).toBeNull();
      expect(screen.queryAllByText(/next delegation/).length).toBeGreaterThan(
        0,
      );
      // Nothing in this pane waits for a restart any more (ADR 0086): the
      // row that did, the tool-set choice, is gone.
      expect(screen.queryAllByText(/next launch/)).toHaveLength(0);
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

  describe("a machine with no bash (ADR 0086)", () => {
    it("has no tool-set choice any more, with or without a bash", async () => {
      const mock = createMockHertaBridge({
        getBackendConfigResult: { thinking: "low", bashFound: true },
      });
      const { container, queryByText } = renderPane(mock);
      const thinking = screen.getByLabelText("Thinking effort");
      await waitFor(() => expect(thinking.textContent).toContain("Low"));
      expect(screen.queryByLabelText("Tool contract")).toBeNull();
      expect(queryByText(/No bash on this machine/)).toBeNull();
      // One backend row on this mock: the effort.
      expect(container.querySelectorAll(".settings-row")).toHaveLength(1);
    });

    it("says that 板砖 cannot run, and what to install", async () => {
      const mock = createMockHertaBridge({
        getBackendConfigResult: { thinking: "high", bashFound: false },
      });
      const { queryByText } = renderPane(mock);
      await waitFor(() =>
        expect(queryByText("No bash on this machine")).toBeTruthy(),
      );
      // The sentence names the remedy, not just the problem.
      expect(queryByText(/Git for Windows/)).toBeTruthy();
      expect(queryByText(/takes no coding work/)).toBeTruthy();
    });

    it("says nothing until it knows: a config that does not report it draws no warning", async () => {
      const mock = createMockHertaBridge({
        getBackendConfigResult: { thinking: "high" },
      });
      const { container, queryByText } = renderPane(mock);
      const thinking = screen.getByLabelText("Thinking effort");
      await waitFor(() => expect(thinking.textContent).toContain("High"));
      expect(queryByText("No bash on this machine")).toBeNull();
      expect(container.querySelectorAll(".settings-row")).toHaveLength(1);
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

    it("the demo card below is a line drawing: no scene, no canvas, no image (§2.4 amended 2026-11-13)", () => {
      // One GPU scene per app, in the rail. The pane's picture of the
      // device is inline SVG, so it opens no context of any kind.
      const mock = createMockHertaBridge({ deviceSceneResult: true });
      const { container } = renderPane(mock);
      const card = container.querySelector(".settings-bz-card");
      expect(card?.querySelector(".device-scene-canvas")).toBeNull();
      expect(card?.querySelector("canvas")).toBeNull();
      expect(card?.querySelector("img")).toBeNull();
      expect(card?.querySelector("svg.bz-art .bz-art-led")).not.toBeNull();
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

  describe("browser data (ADR 0083 §8)", () => {
    it("a first press arms, a second clears the page tab's data", async () => {
      const mock = createMockHertaBridge();
      const clear = vi.fn(async () => true);
      const bridge: HertaBridge = { ...mock.bridge, pageClearData: clear };
      renderWithLocale(
        <HertaBridgeProvider bridge={bridge}>
          <BanzhuanSettings />
        </HertaBridgeProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(clear).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Confirm clear" }));
      await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
      // Cleared is an answer: a press on it does not arm again.
      fireEvent.click(await screen.findByRole("button", { name: "Cleared" }));
      expect(screen.getByRole("button", { name: "Cleared" })).toBeTruthy();
      expect(clear).toHaveBeenCalledTimes(1);
    });

    it("keeps one width: every label is in the button, one shown (owner 2026-10-24)", () => {
      const mock = createMockHertaBridge();
      const bridge: HertaBridge = {
        ...mock.bridge,
        pageClearData: vi.fn(async () => true),
      };
      renderWithLocale(
        <HertaBridgeProvider bridge={bridge}>
          <BanzhuanSettings />
        </HertaBridgeProvider>,
      );
      const button = screen.getByRole("button", { name: "Clear" });
      const labels = [
        ...button.querySelectorAll(".settings-btn__stack > span"),
      ];
      expect(labels.map((l) => l.textContent)).toEqual([
        "Clear",
        "Confirm clear",
        "Cleared",
        "Clear failed",
      ]);
      expect(
        labels.filter((l) => !l.classList.contains("is-off")),
      ).toHaveLength(1);
    });

    it("armed, a press anywhere else takes it back at once", () => {
      const mock = createMockHertaBridge();
      const clear = vi.fn(async () => true);
      const bridge: HertaBridge = { ...mock.bridge, pageClearData: clear };
      renderWithLocale(
        <HertaBridgeProvider bridge={bridge}>
          <BanzhuanSettings />
        </HertaBridgeProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(
        screen.getByRole("button", { name: "Confirm clear" }),
      ).toBeTruthy();
      fireEvent.pointerDown(document.body);
      expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
      expect(clear).not.toHaveBeenCalled();
    });

    it("is not offered without a page tab", () => {
      renderPane();
      expect(screen.queryByText("Browser data")).toBeNull();
    });
  });
});
