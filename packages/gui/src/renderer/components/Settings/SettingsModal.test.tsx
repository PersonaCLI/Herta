import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { setVoiceMuted } from "../../voice/voice-prefs.js";
import { SettingsModal } from "./SettingsModal.js";

/** Wrap in a mock bridge provider: the modal opens on the Language pane,
 *  whose interaction-language row reads the bridge (slice 4). */
function wrap(ui: JSX.Element): JSX.Element {
  return (
    <HertaBridgeProvider bridge={createMockHertaBridge().bridge}>
      {ui}
    </HertaBridgeProvider>
  );
}

describe("SettingsModal", () => {
  afterEach(() => setVoiceMuted(false));

  it("every section's `rows` flag matches the pane: .has-rows exactly when a .settings-rows list is a direct child (2026-09-24)", () => {
    // The flag replaced `.settings-content:has(> .settings-rows)` in the CSS
    // (that selector restyled ~400 elements on every send, Settings closed).
    // A pane that gains or loses its scrolling rows must move its flag too,
    // or it keeps the old layout — this walks every section to say so.
    const { container } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    const items = [
      ...container.querySelectorAll<HTMLButtonElement>(".settings-nav-item"),
    ];
    expect(items.length).toBeGreaterThan(5);
    const seen: string[] = [];
    for (const item of items) {
      fireEvent.click(item);
      const content = container.querySelector(".settings-content");
      const hasList = content?.querySelector(":scope > .settings-rows") != null;
      expect(
        content?.classList.contains("has-rows"),
        `${item.textContent}: has-rows should be ${hasList}`,
      ).toBe(hasList);
      if (hasList) seen.push(item.textContent ?? "");
    }
    // Not vacuous: the panes with scrolling rows are among them.
    expect(seen).toEqual(["Voice", "Flow", "Coprocessor"]);
  });

  it("renders nothing when closed", () => {
    const { queryByRole } = renderWithLocale(
      wrap(<SettingsModal open={false} onClose={() => {}} />),
    );
    expect(queryByRole("dialog")).toBeNull();
  });

  it("renders the dialog when open and focuses it", () => {
    const { getByRole } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    const dialog = getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(document.activeElement).toBe(dialog);
  });

  it("opened from the CLOSED state, focus lands in the card — the trap engages (UX review 2026-09-22, item 10)", () => {
    // The card does not exist in the flush that first sees `open`: a focus
    // keyed on `open` alone found nothing, and Tab walked the workspace
    // behind the backdrop.
    const mock = createMockHertaBridge();
    const ui = (open: boolean): JSX.Element => (
      <HertaBridgeProvider bridge={mock.bridge}>
        <SettingsModal open={open} onClose={() => {}} />
      </HertaBridgeProvider>
    );
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    try {
      trigger.focus();
      const { rerender, getByRole } = renderWithLocale(ui(false));
      rerender(ui(true));
      expect(document.activeElement).toBe(getByRole("dialog"));
    } finally {
      trigger.remove();
    }
  });

  it("does NOT steal focus to the Settings button on initial mount (closed)", () => {
    const btn = document.createElement("button");
    btn.className = "sidebar-settings";
    document.body.appendChild(btn);
    renderWithLocale(wrap(<SettingsModal open={false} onClose={() => {}} />));
    expect(document.activeElement).not.toBe(btn);
    btn.remove();
  });

  it("restores focus to the Settings button after a real open→close", () => {
    const btn = document.createElement("button");
    btn.className = "sidebar-settings";
    document.body.appendChild(btn);
    const { rerender } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    rerender(wrap(<SettingsModal open={false} onClose={() => {}} />));
    expect(document.activeElement).toBe(btn);
    btn.remove();
  });

  it("re-opens on the first section (Language), not the last-viewed one", () => {
    const mock = createMockHertaBridge();
    const ui = (open: boolean): JSX.Element => (
      <HertaBridgeProvider bridge={mock.bridge}>
        <SettingsModal open={open} onClose={() => {}} />
      </HertaBridgeProvider>
    );
    const { getByRole, rerender } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SettingsModal open={true} onClose={() => {}} />
      </HertaBridgeProvider>,
    );
    // Switch to a non-default section.
    fireEvent.click(getByRole("button", { name: "DeepSeek" }));
    expect(getByRole("heading", { name: "DeepSeek" })).toBeTruthy();
    // Close, then reopen — it should be back on Language, not DeepSeek.
    // Note: rerender replaces the whole tree, so wrap in the full provider stack.
    rerender(ui(false));
    rerender(ui(true));
    expect(getByRole("heading", { name: "Language" })).toBeTruthy();
  });

  it("groups the nav under 通用/黑塔/引擎 labels (General, Herta, Engine)", () => {
    const { getByText } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    expect(getByText("General")).toBeTruthy();
    expect(getByText("Herta")).toBeTruthy();
    expect(getByText("Engine")).toBeTruthy();
  });

  it("includes a Window section with the close-to-tray toggle wired to the bridge", async () => {
    const mock = createMockHertaBridge();
    const { getByRole, findByLabelText } = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SettingsModal open={true} onClose={() => {}} />
      </HertaBridgeProvider>,
    );
    fireEvent.click(getByRole("button", { name: "Window" }));
    const toggle = await findByLabelText("Close to tray");
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true"); // default ON
    fireEvent.click(toggle);
    expect(mock.calls.setCloseToTray).toEqual([false]);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("shows the attention rows only where the bridge reads them, writes one flag per toggle, and snaps back on a failed write (ADR 0072 §1)", async () => {
    // A bridge without the surface (the website demo): no rows.
    const bare = createMockHertaBridge();
    const first = renderWithLocale(
      <HertaBridgeProvider bridge={bare.bridge}>
        <SettingsModal open={true} onClose={() => {}} />
      </HertaBridgeProvider>,
    );
    fireEvent.click(first.getByRole("button", { name: "Window" }));
    await first.findByLabelText("Close to tray");
    expect(first.queryByLabelText("Notifications")).toBeNull();
    first.unmount();

    const mock = createMockHertaBridge({
      attentionResult: { notifications: true, keepAwake: false },
    });
    const second = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <SettingsModal open={true} onClose={() => {}} />
      </HertaBridgeProvider>,
    );
    fireEvent.click(second.getByRole("button", { name: "Window" }));
    const notify = await second.findByLabelText("Notifications");
    const awake = await second.findByLabelText("Keep awake during runs");
    await waitFor(() =>
      expect(awake.getAttribute("aria-checked")).toBe("false"),
    );
    expect(notify.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(awake);
    expect(mock.calls.setAttention).toEqual([{ keepAwake: true }]);
    expect(awake.getAttribute("aria-checked")).toBe("true");
    second.unmount();

    const failing = createMockHertaBridge({
      attentionResult: { notifications: true, keepAwake: true },
      failSetAttention: true,
    });
    const third = renderWithLocale(
      <HertaBridgeProvider bridge={failing.bridge}>
        <SettingsModal open={true} onClose={() => {}} />
      </HertaBridgeProvider>,
    );
    fireEvent.click(third.getByRole("button", { name: "Window" }));
    const notify3 = await third.findByLabelText("Notifications");
    fireEvent.click(notify3);
    expect(failing.calls.setAttention).toEqual([{ notifications: false }]);
    await waitFor(() =>
      expect(notify3.getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("includes a Coprocessor section that switches to its pane", () => {
    const { getByRole } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    fireEvent.click(getByRole("button", { name: "Coprocessor" }));
    expect(getByRole("heading", { name: "Coprocessor" })).toBeTruthy();
  });

  it("renders the Coprocessor delegation trigger as @Brick under the English UI (chrome-consistent, no active session needed)", () => {
    // renderWithLocale defaults to the "en" UI locale; the token follows the UI
    // locale like the surrounding prose, so an all-English panel never shows a
    // lone CJK @板砖 — including with no session active (this pane's common case).
    // Per-locale keying is unit-tested directly in BanzhuanSettings.test.tsx.
    const { container } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    fireEvent.click(screen.getByRole("button", { name: "Coprocessor" }));
    expect(container.querySelector(".settings-intro code")?.textContent).toBe(
      "@Brick",
    );
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderWithLocale(wrap(<SettingsModal open={true} onClose={onClose} />));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape with a Select dropdown open closes ONLY the dropdown; a second Escape closes the modal", () => {
    // Pre-fix, one Escape closed the dropdown AND the whole modal because both
    // document keydown listeners fired (adversarial review 2026-07-15). The
    // open Select now owns the topmost overlay, so the modal defers.
    const onClose = vi.fn();
    renderWithLocale(wrap(<SettingsModal open={true} onClose={onClose} />));
    const trigger = screen.getByLabelText("Display language");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // First Escape: dropdown closes, modal stays.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    // Second Escape: nothing above the modal now, so it closes.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on an outside (backdrop) mousedown, not an inside one", () => {
    const onClose = vi.fn();
    const { getByRole } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={onClose} />),
    );
    fireEvent.mouseDown(getByRole("dialog")); // inside the card
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body); // outside
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("the close button calls onClose", () => {
    const onClose = vi.fn();
    const { getByLabelText } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={onClose} />),
    );
    fireEvent.click(getByLabelText("Close settings"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab focus within the modal", () => {
    const { getByRole, getByLabelText } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    const navItem = getByRole("button", { name: "Language" }); // first focusable
    // Last focusable (Language pane): the interaction-language Select's
    // trigger button (slice 4 — it sits below the UI-language row).
    const trigger = getByLabelText("Interaction language");
    // Tab on the last wraps to the first.
    trigger.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(navItem);
    // Shift+Tab on the first wraps to the last.
    navItem.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(trigger);
  });

  it("shows the Voice section's mute toggle", () => {
    const { getByRole, getByLabelText } = renderWithLocale(
      wrap(<SettingsModal open={true} onClose={() => {}} />),
    );
    fireEvent.click(getByRole("button", { name: "Voice" }));
    expect(getByLabelText("Mute voice").getAttribute("role")).toBe("switch");
  });

  it("shows a Language section that switches locale live (custom Select)", () => {
    renderWithLocale(wrap(<SettingsModal open onClose={() => {}} />));
    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    // The custom Select: trigger opens the popover, picking 中文 applies live.
    const trigger = screen.getByLabelText("Display language");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "中文" }));
    expect(screen.getByText("设置")).toBeInTheDocument(); // eyebrow flips to zh
  });
});
