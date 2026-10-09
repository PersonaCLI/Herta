import {
  act,
  fireEvent,
  screen,
  waitForElementToBeRemoved,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import { getHoverTip, hideHoverTip } from "../common/hover-tip.js";
import { CardMenu } from "./CardMenu.js";

describe("CardMenu", () => {
  it("renders the ⋯ button and hides the tooltip by default", () => {
    renderWithLocale(<CardMenu cardKind="device" />);
    expect(screen.getByLabelText("device card info")).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("toggles the tooltip on click", async () => {
    renderWithLocale(<CardMenu cardKind="device" />);
    const btn = screen.getByLabelText("device card info");
    fireEvent.click(btn);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.getByText(/differential coprocessor/)).toBeInTheDocument();
    fireEvent.click(btn);
    // The menu stays mounted briefly for its exit animation, then unmounts.
    await waitForElementToBeRemoved(() => screen.queryByRole("tooltip"));
  });

  it("device card menu shows the current workspace + set/reset actions", () => {
    const onSet = vi.fn();
    const onReset = vi.fn();
    renderWithLocale(
      <CardMenu
        cardKind="device"
        activeWorkspace="/home/u/project"
        isDefault={false}
        onSetWorkspace={onSet}
        onResetWorkspace={onReset}
      />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByText("/home/u/project")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Set workspace/ }));
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it("reset is disabled when the workspace is the default", () => {
    renderWithLocale(
      <CardMenu
        cardKind="device"
        activeWorkspace="/d"
        isDefault={true}
        onSetWorkspace={vi.fn()}
        onResetWorkspace={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(
      screen.getByRole("button", { name: /Reset to default/ }),
    ).toBeDisabled();
  });

  it("device card WITHOUT workspace handlers still shows the static tooltip", () => {
    renderWithLocale(<CardMenu cardKind="device" />);
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("device card menu shows a default hint when the workspace is the default", () => {
    renderWithLocale(
      <CardMenu
        cardKind="device"
        activeWorkspace="/managed/default"
        isDefault={true}
        onSetWorkspace={vi.fn()}
        onResetWorkspace={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(screen.getByText(/· default/)).toBeInTheDocument();
  });

  it("keeps the menu open after invoking Set workspace (so errors stay visible)", () => {
    renderWithLocale(
      <CardMenu
        cardKind="device"
        activeWorkspace="/p"
        isDefault={false}
        onSetWorkspace={vi.fn()}
        onResetWorkspace={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    fireEvent.click(screen.getByRole("button", { name: /Set workspace/ }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("renders the validation error as an alert when errorText is set", () => {
    renderWithLocale(
      <CardMenu
        cardKind="device"
        activeWorkspace="/p"
        isDefault={false}
        onSetWorkspace={vi.fn()}
        onResetWorkspace={vi.fn()}
        errorText="nope"
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(screen.getByRole("alert")).toHaveTextContent("nope");
  });

  it("closes the menu on an outside mousedown", async () => {
    renderWithLocale(
      <CardMenu
        cardKind="device"
        activeWorkspace="/p"
        isDefault={false}
        onSetWorkspace={vi.fn()}
        onResetWorkspace={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    await waitForElementToBeRemoved(() => screen.queryByRole("menu"));
  });

  it("closes the menu on Escape", async () => {
    renderWithLocale(
      <CardMenu
        cardKind="device"
        activeWorkspace="/p"
        isDefault={false}
        onSetWorkspace={vi.fn()}
        onResetWorkspace={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitForElementToBeRemoved(() => screen.queryByRole("menu"));
  });

  it("keeps the menu open on a mousedown inside it", () => {
    renderWithLocale(
      <CardMenu
        cardKind="device"
        activeWorkspace="/p"
        isDefault={false}
        onSetWorkspace={vi.fn()}
        onResetWorkspace={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  // ── Project command rules (ADR 0030) ──────────────────────────────────────
  // PRESENTATIONAL ONLY. Every case here renders CardMenu with NO
  // HertaBridgeProvider on purpose: a first cut fetched rules from the bridge
  // inside this component and broke all 11 tests above (CI 2026-08-04). The
  // data belongs to DeviceCard; these props are the seam.
  const rulesProps = {
    cardKind: "device" as const,
    activeWorkspace: "/p",
    isDefault: false,
    onSetWorkspace: vi.fn(),
    onResetWorkspace: vi.fn(),
  };

  it("renders the rules section from props, with no bridge in scope", () => {
    renderWithLocale(
      <CardMenu {...rulesProps} rules={["node src/index.mjs:*"]} />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(screen.getByText("Remembered commands")).toBeInTheDocument();
    expect(screen.getByText("node src/index.mjs:*")).toBeInTheDocument();
  });

  it("its tips are the app's own: none on the wrapping path, and a rule's only while it is cut off (owner 2026-10-08)", () => {
    renderWithLocale(
      <CardMenu {...rulesProps} rules={["node src/index.mjs:*"]} />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    // No OS tooltip anywhere in the menu (a portal at the body).
    expect(
      document.querySelectorAll(".card-menu-tooltip [title]"),
    ).toHaveLength(0);
    const rule = screen.getByText("node src/index.mjs:*");
    const tip = (): string | undefined => {
      act(() => {
        fireEvent.focusIn(rule);
      });
      const text = getHoverTip()?.text;
      act(() => {
        hideHoverTip();
      });
      return text;
    };
    // Seen whole (jsdom lays out nothing): no tip.
    expect(tip()).toBeUndefined();
    Object.defineProperty(rule, "scrollWidth", { value: 300 });
    Object.defineProperty(rule, "clientWidth", { value: 120 });
    expect(tip()).toBe("node src/index.mjs:*");
  });

  it("the path opens the workspace folder, and stays text when it cannot (owner 2026-10-08)", () => {
    const onOpen = vi.fn();
    const { unmount } = renderWithLocale(
      <CardMenu
        cardKind="device"
        activeWorkspace={"C:\\Users\\u\\.herta\\workspaces\\a335"}
        isDefault={true}
        onSetWorkspace={vi.fn()}
        onResetWorkspace={vi.fn()}
        onOpenWorkspace={onOpen}
      />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    const path = document.querySelector(".card-menu-path");
    expect(path?.tagName).toBe("BUTTON");
    expect(path?.textContent).toBe("C:\\Users\\u\\.herta\\workspaces\\a335");
    // Its tip names the action — the path itself is already whole.
    act(() => {
      fireEvent.focusIn(path as Element);
    });
    expect(getHoverTip()?.text).toBe("Open the workspace folder");
    act(() => {
      hideHoverTip();
    });
    fireEvent.click(path as Element);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The menu stays, so a refusal can be said in its error row.
    expect(screen.getByRole("menu")).toBeInTheDocument();
    unmount();

    renderWithLocale(
      <CardMenu
        cardKind="device"
        activeWorkspace="/p"
        onSetWorkspace={vi.fn()}
        onResetWorkspace={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(document.querySelector(".card-menu-path")?.tagName).toBe("SPAN");
  });

  it("the copy icon copies the path and says so — and says a refusal too", async () => {
    const writeText = vi.fn(async (_: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    try {
      renderWithLocale(
        <CardMenu
          cardKind="device"
          activeWorkspace="/home/u/project"
          onSetWorkspace={vi.fn()}
          onResetWorkspace={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByLabelText("device card info"));
      const copy = screen.getByRole("button", { name: "Copy path" });
      await act(async () => {
        fireEvent.click(copy);
      });
      expect(writeText).toHaveBeenCalledWith("/home/u/project");
      expect(copy).toHaveAccessibleName("Copied");
      expect(getHoverTip()?.text).toBe("Copied");

      writeText.mockRejectedValueOnce(new Error("denied"));
      await act(async () => {
        fireEvent.click(copy);
      });
      expect(copy).toHaveAccessibleName("Copy failed");
      expect(getHoverTip()?.text).toBe("Copy failed");
    } finally {
      act(() => {
        hideHoverTip();
      });
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("offers the auto-review switch only when a reviewer is available (ADR 0075)", () => {
    const onSetAutoReview = vi.fn();
    const base = {
      cardKind: "device" as const,
      activeWorkspace: "/p",
      onSetWorkspace: vi.fn(),
      onResetWorkspace: vi.fn(),
      onSetTrust: vi.fn(),
      onSetAutoReview,
    };
    const trust = {
      effective: "ask" as const,
      explicit: null,
      isDefaultWorkspace: false,
    };
    const { unmount } = renderWithLocale(
      <CardMenu {...base} trust={{ ...trust, autoReviewAvailable: false }} />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(document.querySelector(".card-menu-review")).toBeNull();
    unmount();

    renderWithLocale(
      <CardMenu
        {...base}
        trust={{ ...trust, autoReviewAvailable: true, autoReview: false }}
      />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(screen.getByText(/you decide commands/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on auto-review" }),
    );
    expect(onSetAutoReview).toHaveBeenCalledWith(true);
  });

  it("an opted-in workspace says so and offers to turn it off", () => {
    const onSetAutoReview = vi.fn();
    renderWithLocale(
      <CardMenu
        cardKind="device"
        activeWorkspace="/p"
        onSetWorkspace={vi.fn()}
        onResetWorkspace={vi.fn()}
        trust={{
          effective: "workspace",
          explicit: "workspace",
          isDefaultWorkspace: false,
          autoReviewAvailable: true,
          autoReview: true,
        }}
        onSetTrust={vi.fn()}
        onSetAutoReview={onSetAutoReview}
      />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(screen.getByText(/a model reviews commands/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Turn off auto-review" }),
    );
    expect(onSetAutoReview).toHaveBeenCalledWith(false);
  });

  it("shows the empty note for an empty rule list", () => {
    renderWithLocale(<CardMenu {...rulesProps} rules={[]} />);
    fireEvent.click(screen.getByLabelText("device card info"));
    expect(screen.getByText("No commands remembered")).toBeInTheDocument();
  });

  it("omits the section entirely when rules are undefined (no rule surface)", () => {
    renderWithLocale(<CardMenu {...rulesProps} />);
    fireEvent.click(screen.getByLabelText("device card info"));
    // The menu is a portal at the body (2026-09-17): assert document-wide.
    expect(document.querySelector(".card-menu-rules")).toBeNull();
    // The workspace half is unaffected by the rules gate.
    expect(screen.getByRole("button", { name: /Set workspace/ })).toBeTruthy();
  });

  it("✕ delegates removal to the parent", () => {
    const onRemoveRule = vi.fn();
    renderWithLocale(
      <CardMenu
        {...rulesProps}
        rules={["node a.js:*"]}
        onRemoveRule={onRemoveRule}
      />,
    );
    fireEvent.click(screen.getByLabelText("device card info"));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove rule node a.js:*" }),
    );
    expect(onRemoveRule).toHaveBeenCalledWith("node a.js:*");
  });

  it("fires onOpen on each OPEN edge only (the parent's refresh trigger)", () => {
    const onOpen = vi.fn();
    renderWithLocale(<CardMenu {...rulesProps} rules={[]} onOpen={onOpen} />);
    const btn = screen.getByLabelText("device card info");
    expect(onOpen).toHaveBeenCalledTimes(0); // closed at mount → no fetch
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(btn); // close — not an open edge
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(btn); // reopen → refresh
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  // ── Keyboard (UX review 2026-09-22, item 25) ──────────────────────────────
  // The menu is a portal at the body, so Tab from ⋯ never reaches it: without
  // focus moving in on open, the keyboard could open the menu and do nothing
  // with it. Arrows walk its enabled buttons; Escape / Tab hand focus back.
  describe("keyboard", () => {
    const keyProps = {
      cardKind: "device" as const,
      activeWorkspace: "/p",
      isDefault: true, // Reset is disabled — the arrows must skip it
      onSetWorkspace: vi.fn(),
      onResetWorkspace: vi.fn(),
      trust: {
        effective: "ask" as const,
        explicit: null,
        isDefaultWorkspace: false,
      },
      onSetTrust: vi.fn(),
      rules: ["node a.js:*"],
      onRemoveRule: vi.fn(),
    };

    it("moves focus to the first action when the menu opens", () => {
      renderWithLocale(<CardMenu {...keyProps} />);
      fireEvent.click(screen.getByLabelText("device card info"));
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /Set workspace/ }),
      );
    });

    it("walks the enabled actions with the arrows, wrapping at both ends", () => {
      renderWithLocale(<CardMenu {...keyProps} />);
      fireEvent.click(screen.getByLabelText("device card info"));
      const set = screen.getByRole("button", { name: /Set workspace/ });
      const trust = screen.getByRole("button", { name: /Trust/ });
      const remove = screen.getByRole("button", {
        name: "Remove rule node a.js:*",
      });
      const down = (): void => {
        fireEvent.keyDown(document.activeElement as Element, {
          key: "ArrowDown",
        });
      };
      const copy = screen.getByRole("button", { name: "Copy path" });
      down();
      expect(document.activeElement).toBe(trust); // Reset (disabled) skipped
      down();
      expect(document.activeElement).toBe(remove);
      down();
      // Wraps to the top: the path's copy icon, above the items.
      expect(document.activeElement).toBe(copy);
      down();
      expect(document.activeElement).toBe(set);
      fireEvent.keyDown(set, { key: "ArrowUp" });
      expect(document.activeElement).toBe(copy);
      fireEvent.keyDown(copy, { key: "ArrowUp" });
      expect(document.activeElement).toBe(remove); // and to the bottom
    });

    it("hands focus back to ⋯ when Escape closes the menu", async () => {
      renderWithLocale(<CardMenu {...keyProps} />);
      const button = screen.getByLabelText("device card info");
      fireEvent.click(button);
      fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
      await waitForElementToBeRemoved(() => screen.queryByRole("menu"));
      expect(document.activeElement).toBe(button);
    });

    it("closes on Tab and hands focus back to ⋯, never stranding it at the body's end", async () => {
      renderWithLocale(<CardMenu {...keyProps} />);
      const button = screen.getByLabelText("device card info");
      fireEvent.click(button);
      fireEvent.keyDown(document.activeElement as Element, { key: "Tab" });
      await waitForElementToBeRemoved(() => screen.queryByRole("menu"));
      expect(document.activeElement).toBe(button);
    });
  });
});
