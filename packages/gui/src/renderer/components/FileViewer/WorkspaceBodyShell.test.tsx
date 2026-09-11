import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { renderWithSession } from "../../testing/renderWithSession.js";
import {
  FileViewerProvider,
  useFileViewerOpen,
} from "./file-viewer-context.js";
import {
  DOCK_HOLD_FLOOR_MS,
  DOCK_SLIDE_MS,
  WorkspaceBodyShell,
} from "./WorkspaceBodyShell.js";

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
    <>
      <button type="button" data-testid="probe" onClick={() => open?.("a.ts")}>
        open
      </button>
      <button
        type="button"
        data-testid="probe-b"
        onClick={() => open?.("b.ts")}
      >
        open b
      </button>
    </>
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

function transitionEnd(propertyName: string): Event {
  const ev = new Event("transitionend", { bubbles: true });
  Object.defineProperty(ev, "propertyName", { value: propertyName });
  return ev;
}

/** The grid's own track transition ending on the body. */
function endGridSlide(body: HTMLElement): void {
  act(() => {
    body.dispatchEvent(transitionEnd("grid-template-columns"));
  });
}

const closePanel = (): void => {
  fireEvent.keyDown(screen.getByTestId("file-viewer"), { key: "Escape" });
};

describe("WorkspaceBodyShell — the docked slides hold their finished layouts", () => {
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
      panel.dispatchEvent(transitionEnd("grid-template-columns"));
    });
    expect(body().classList.contains("viewer-opening")).toBe(true);
    act(() => {
      body().dispatchEvent(transitionEnd("opacity"));
    });
    expect(body().classList.contains("viewer-opening")).toBe(true);

    endGridSlide(body());
    expect(body().className).toBe("workspace-body viewer-docked");
  });

  it("a second tab while open is not a slide — the finished hold stays off", () => {
    const { body } = setup(1400);
    fireEvent.click(screen.getByTestId("probe"));
    endGridSlide(body());
    fireEvent.click(screen.getByTestId("probe-b"));
    expect(body().className).toBe("workspace-body viewer-docked");
  });

  it("with no transition to end (reduced motion, a cancelled slide) the hold drops on the floor timer, which sits past the slide", () => {
    vi.useFakeTimers();
    const { body } = setup(1400);
    fireEvent.click(screen.getByTestId("probe"));
    expect(body().classList.contains("viewer-opening")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(DOCK_SLIDE_MS);
    });
    // A busy main thread ends the grid transition late; the floor must not
    // beat it.
    expect(body().classList.contains("viewer-opening")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(DOCK_HOLD_FLOOR_MS - DOCK_SLIDE_MS);
    });
    expect(body().className).toBe("workspace-body viewer-docked");
  });

  it("closing after a finished open holds `viewer-closing` — the rail's slide-back — until the grid's own transition ends (owner 2026-09-11)", () => {
    const { body } = setup(1400);
    fireEvent.click(screen.getByTestId("probe"));
    endGridSlide(body());
    closePanel();
    expect(body().className).toBe("workspace-body viewer-closing");
    act(() => {
      body().dispatchEvent(transitionEnd("transform"));
    });
    expect(body().className).toBe("workspace-body viewer-closing");
    endGridSlide(body());
    expect(body().className).toBe("workspace-body");
  });

  it("closing mid-slide swaps the opening hold for the closing one", () => {
    const { body } = setup(1400);
    fireEvent.click(screen.getByTestId("probe"));
    expect(body().classList.contains("viewer-opening")).toBe(true);
    closePanel();
    expect(body().className).toBe("workspace-body viewer-closing");
    endGridSlide(body());
    expect(body().className).toBe("workspace-body");
  });

  it("the closing hold also drops on the floor timer", () => {
    vi.useFakeTimers();
    const { body } = setup(1400);
    fireEvent.click(screen.getByTestId("probe"));
    act(() => {
      vi.advanceTimersByTime(DOCK_HOLD_FLOOR_MS);
    });
    closePanel();
    expect(body().className).toBe("workspace-body viewer-closing");
    act(() => {
      vi.advanceTimersByTime(DOCK_HOLD_FLOOR_MS);
    });
    expect(body().className).toBe("workspace-body");
  });

  it("reopening during the close slide goes straight back to an opening hold", () => {
    const { body } = setup(1400);
    fireEvent.click(screen.getByTestId("probe"));
    endGridSlide(body());
    closePanel();
    expect(body().className).toBe("workspace-body viewer-closing");
    fireEvent.click(screen.getByTestId("probe"));
    expect(body().className).toBe(
      "workspace-body viewer-docked viewer-opening",
    );
  });

  it("the overlay sheet (a body too narrow to dock) never holds — nothing reflows there", () => {
    const { body } = setup(800);
    fireEvent.click(screen.getByTestId("probe"));
    expect(body().classList.contains("viewer-overlay")).toBe(true);
    expect(body().classList.contains("viewer-opening")).toBe(false);
    closePanel();
    expect(body().className).toBe("workspace-body");
  });
});
