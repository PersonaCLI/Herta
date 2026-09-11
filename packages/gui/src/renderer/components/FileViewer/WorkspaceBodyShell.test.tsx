import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { renderWithSession } from "../../testing/renderWithSession.js";
import {
  FileViewerProvider,
  useFileViewerOpen,
} from "./file-viewer-context.js";
import { DOCK_SLIDE_MS, WorkspaceBodyShell } from "./WorkspaceBodyShell.js";

// jsdom has no ResizeObserver and measures every box at 0; the shell's own
// measure reads the body's rect, so the test hands it a width through a
// rect stub and a no-op observer.
class FakeRO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function Probe(): JSX.Element {
  const open = useFileViewerOpen();
  return (
    <button type="button" data-testid="probe" onClick={() => open?.("a.ts")}>
      open
    </button>
  );
}

function ui(): JSX.Element {
  return (
    <FileViewerProvider>
      <WorkspaceBodyShell>
        <Probe />
      </WorkspaceBodyShell>
    </FileViewerProvider>
  );
}

function setup(bodyWidth: number): { body: () => HTMLElement } {
  vi.stubGlobal("ResizeObserver", FakeRO);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: bodyWidth,
    bottom: 0,
    width: bodyWidth,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect);
  const mock = createMockHertaBridge();
  Object.assign(mock.bridge, {
    readWorkspaceFile: vi.fn(async () => ({
      ok: true as const,
      content: "one\n",
      truncated: false,
      size: 4,
      relative: "a.ts",
    })),
  });
  const h = renderWithSession(ui(), { mock });
  h.openSession("s1");
  return {
    body: () => h.container.querySelector(".workspace-body") as HTMLElement,
  };
}

function gridTransitionEnd(propertyName: string): Event {
  const ev = new Event("transitionend", { bubbles: true });
  Object.defineProperty(ev, "propertyName", { value: propertyName });
  return ev;
}

describe("WorkspaceBodyShell — the docked open slide holds the final layout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("holds `viewer-opening` beside `viewer-docked` from the first frame until the grid's OWN track transition ends", () => {
    const { body } = setup(1400);
    expect(body().className).toBe("workspace-body");
    fireEvent.click(screen.getByTestId("probe"));
    expect(body().classList.contains("viewer-docked")).toBe(true);
    expect(body().classList.contains("viewer-opening")).toBe(true);

    // The rail's transform and the panel's opacity end on the same clock
    // and bubble through the body — neither is the slide.
    const panel = screen.getByTestId("file-viewer");
    act(() => {
      panel.dispatchEvent(gridTransitionEnd("grid-template-columns"));
    });
    expect(body().classList.contains("viewer-opening")).toBe(true);
    act(() => {
      body().dispatchEvent(gridTransitionEnd("opacity"));
    });
    expect(body().classList.contains("viewer-opening")).toBe(true);

    act(() => {
      body().dispatchEvent(gridTransitionEnd("grid-template-columns"));
    });
    expect(body().classList.contains("viewer-opening")).toBe(false);
    expect(body().classList.contains("viewer-docked")).toBe(true);
  });

  it("with no transition to end (reduced motion, a cancelled slide) the hold drops after the slide's length", () => {
    vi.useFakeTimers();
    const { body } = setup(1400);
    fireEvent.click(screen.getByTestId("probe"));
    expect(body().classList.contains("viewer-opening")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(DOCK_SLIDE_MS);
    });
    expect(body().classList.contains("viewer-opening")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(body().classList.contains("viewer-opening")).toBe(false);
    expect(body().classList.contains("viewer-docked")).toBe(true);
  });

  it("closing mid-slide drops the hold with the panel", () => {
    const { body } = setup(1400);
    fireEvent.click(screen.getByTestId("probe"));
    expect(body().classList.contains("viewer-opening")).toBe(true);
    fireEvent.keyDown(screen.getByTestId("file-viewer"), { key: "Escape" });
    expect(body().className).toBe("workspace-body");
  });

  it("the overlay sheet (a body too narrow to dock) never holds — nothing reflows there", () => {
    const { body } = setup(800);
    fireEvent.click(screen.getByTestId("probe"));
    expect(body().classList.contains("viewer-overlay")).toBe(true);
    expect(body().classList.contains("viewer-opening")).toBe(false);
  });
});
