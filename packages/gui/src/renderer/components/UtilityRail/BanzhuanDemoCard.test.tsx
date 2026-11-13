import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BanzhuanDemoCard } from "./BanzhuanDemoCard.js";

describe("BanzhuanDemoCard", () => {
  it("draws the device as one inline SVG, with the state on the card", () => {
    const { container } = render(
      <BanzhuanDemoCard state="delegated" led="#4d86ff" />,
    );
    const card = container.querySelector(".settings-bz-card");
    expect(card?.getAttribute("data-state")).toBe("delegated");
    // The device's outline, and the ring on its face with the arc that runs
    // round it while it works.
    expect(card?.querySelectorAll("svg.bz-art")).toHaveLength(1);
    expect(card?.querySelector(".bz-art-outline")).not.toBeNull();
    expect(card?.querySelector("circle.bz-art-led")).not.toBeNull();
    expect(card?.querySelector("circle.bz-art-spin")).not.toBeNull();
  });

  it("loads no image and opens no canvas (ADR 0057 §2.4 as amended 2026-11-13)", () => {
    // The flat renders and the WebGL lamp are the rail card's. Here the
    // picture is lines, so the pane costs no decode and no GPU context.
    const { container } = render(
      <BanzhuanDemoCard state="idle" led="#7ba3f0" />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("hands the state's colour to the drawing as --bz-led", () => {
    const { container, rerender } = render(
      <BanzhuanDemoCard state="idle" led="#7ba3f0" />,
    );
    const card = container.querySelector(".settings-bz-card") as HTMLElement;
    expect(card.style.getPropertyValue("--bz-led")).toBe("#7ba3f0");
    rerender(<BanzhuanDemoCard state="failed" led="#f2655f" />);
    expect(card.style.getPropertyValue("--bz-led")).toBe("#f2655f");
    expect(card.getAttribute("data-state")).toBe("failed");
  });

  it("is hidden from assistive technology: the caption and the legend say it", () => {
    const { container } = render(
      <BanzhuanDemoCard state="idle" led="#7ba3f0" />,
    );
    expect(
      container.querySelector(".settings-bz-card")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("gives two cards on one page their own mask ids", () => {
    // `url(#id)` is resolved against the whole document: a shared id would
    // let one card's drawing be cut by the other's mask.
    const { container } = render(
      <>
        <BanzhuanDemoCard state="idle" led="#7ba3f0" />
        <BanzhuanDemoCard state="idle" led="#7ba3f0" />
      </>,
    );
    const ids = [...container.querySelectorAll("mask")].map((m) => m.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    for (const g of container.querySelectorAll("g[mask]")) {
      const ref = /^url\(#(.+)\)$/.exec(g.getAttribute("mask") ?? "")?.[1];
      expect(ref).toBeDefined();
      expect(ids).toContain(ref);
      // An id with a ":" does not resolve inside url(#…).
      expect(ref).not.toContain(":");
    }
  });

  it("is non-interactive (renders no button)", () => {
    const { container } = render(
      <BanzhuanDemoCard state="idle" led="#7ba3f0" />,
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("reports hover changes for pause-on-hover", () => {
    const onHoverChange = vi.fn();
    const { container } = render(
      <BanzhuanDemoCard
        state="idle"
        led="#7ba3f0"
        onHoverChange={onHoverChange}
      />,
    );
    const card = container.querySelector(".settings-bz-card") as HTMLElement;
    fireEvent.mouseEnter(card);
    expect(onHoverChange).toHaveBeenLastCalledWith(true);
    fireEvent.mouseLeave(card);
    expect(onHoverChange).toHaveBeenLastCalledWith(false);
  });
});
