import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageState } from "../../../shared/browser-page.js";
import {
  createMockHertaBridge,
  type MockHertaBridge,
} from "../../ipc/mock-bridge.js";
import { OVERLAY_Z, popOverlay, pushOverlay } from "../../lib/overlay-stack.js";
import { beginPageMotion, endPageMotion } from "../../lib/page-motion.js";
import { runShortcut } from "../../lib/shortcut-registry.js";
import { renderWithSession } from "../../testing/renderWithSession.js";
import { FileViewerPanel } from "./FileViewerPanel.js";
import {
  FileViewerProvider,
  MAX_VIEWER_TABS,
  useFileViewerOpen,
} from "./file-viewer-context.js";

/** The browser page tab (ADR 0083 §2–§4) over a fake main. */

function Probe(): JSX.Element {
  const open = useFileViewerOpen();
  return (
    <button
      type="button"
      data-testid="open-many"
      onClick={() => {
        for (let i = 0; i < MAX_VIEWER_TABS + 2; i += 1) open?.(`src/f${i}.ts`);
      }}
    >
      open many
    </button>
  );
}

function ui(): JSX.Element {
  return (
    <FileViewerProvider>
      <Probe />
      <FileViewerPanel />
    </FileViewerProvider>
  );
}

function withPage(mock: MockHertaBridge) {
  let push: ((s: PageState) => void) | null = null;
  const page = {
    show: vi.fn(),
    hide: vi.fn(),
    freeze: vi.fn(async () => "data:image/jpeg;base64,AAAA"),
    navigate: vi.fn(),
    state: vi.fn(async (): Promise<PageState | null> => null),
  };
  Object.assign(mock.bridge, {
    readWorkspaceFile: vi.fn(async () => ({
      ok: true as const,
      content: "x\n",
      truncated: false,
      size: 2,
      relative: "src/a.ts",
    })),
    pageShow: page.show,
    pageHide: page.hide,
    pageFreeze: page.freeze,
    pageNavigate: page.navigate,
    pageState: page.state,
    pageOpenExternal: vi.fn(async () => undefined),
    onPageState: (cb: (s: PageState) => void) => {
      push = cb;
      return () => {
        push = null;
      };
    },
  });
  return {
    page,
    emit: (s: Partial<PageState>) =>
      act(() =>
        push?.({
          sessionId: "s1",
          url: "http://localhost:5173/login",
          title: "Vite + React",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          ...s,
        }),
      ),
  };
}

const tabNames = (): string[] =>
  [...document.querySelectorAll(".file-viewer__tab-name")].map(
    (t) => t.textContent ?? "",
  );

afterEach(() => {
  popOverlay("settings");
});

describe("the browser page tab (ADR 0083)", () => {
  it("Ctrl/⌘+Shift+B opens it pinned first; the address typed goes to main to read", async () => {
    const mock = createMockHertaBridge();
    const { page } = withPage(mock);
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("open-many"));
    act(() => {
      expect(runShortcut("openBrowser")).toBe(true);
    });
    await waitFor(() => expect(screen.getByTestId("page-view")).toBeTruthy());
    expect(tabNames()[0]).toBe("Browser");
    const url = screen.getByLabelText("Address") as HTMLInputElement;
    fireEvent.change(url, { target: { value: "localhost:5173/login" } });
    fireEvent.submit(url.closest("form") as HTMLFormElement);
    expect(page.navigate).toHaveBeenCalledWith("s1", {
      url: "localhost:5173/login",
    });
    // Escape in the field puts the address back; it is the field's.
    fireEvent.change(url, { target: { value: "typo" } });
    fireEvent.keyDown(url, { key: "Escape" });
    expect(url.value).toBe("");
    expect(screen.getByTestId("page-view")).toBeTruthy();
  });

  it("is never evicted by the tab cap", () => {
    const mock = createMockHertaBridge();
    withPage(mock);
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    act(() => {
      runShortcut("openBrowser");
    });
    fireEvent.click(screen.getByTestId("open-many"));
    const names = tabNames();
    expect(names).toHaveLength(MAX_VIEWER_TABS);
    expect(names[0]).toBe("Browser");
  });

  it("the header follows main: the address, and back / forward as the history allows", async () => {
    const mock = createMockHertaBridge();
    const { emit } = withPage(mock);
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    act(() => {
      runShortcut("openBrowser");
    });
    await waitFor(() => expect(screen.getByTestId("page-view")).toBeTruthy());
    expect(
      screen.getByText("Type an address above to open a page."),
    ).toBeTruthy();
    emit({ canGoBack: true });
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe(
      "http://localhost:5173/login",
    );
    expect(screen.getByLabelText("Back")).not.toBeDisabled();
    expect(screen.getByLabelText("Forward")).toBeDisabled();
    expect(
      screen.queryByText("Type an address above to open a page."),
    ).toBeNull();
    // Another session's page says nothing here.
    emit({ sessionId: "s2", url: "http://localhost:3000/" });
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe(
      "http://localhost:5173/login",
    );
  });

  it("without a page on the bridge there is no page tab to open", () => {
    const h = renderWithSession(ui());
    h.openSession("s1");
    let ran = true;
    act(() => {
      ran = runShortcut("openBrowser");
    });
    expect(ran).toBe(false);
    expect(screen.queryByTestId("page-view")).toBeNull();
  });

  it("laid over the tab once it holds still; an overlay or the divider's press freezes it at once, and it comes back after", async () => {
    const mock = createMockHertaBridge();
    const { page, emit } = withPage(mock);
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    act(() => {
      runShortcut("openBrowser");
    });
    await waitFor(() => expect(screen.getByTestId("page-view")).toBeTruthy());
    const body = document.querySelector(".page-view__body") as HTMLElement;
    body.getBoundingClientRect = () =>
      ({ left: 900, top: 140, width: 600, height: 700 }) as DOMRect;
    emit({});
    await waitFor(() =>
      expect(page.show).toHaveBeenCalledWith("s1", {
        x: 900,
        y: 140,
        width: 600,
        height: 700,
      }),
    );
    // Settings opens over the viewer: frozen in the same turn, no frame wait.
    act(() => pushOverlay("settings", OVERLAY_Z.settings));
    expect(page.freeze).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        (document.querySelector(".page-view__still") as HTMLImageElement)?.src,
      ).toContain("data:image/jpeg"),
    );
    const shows = page.show.mock.calls.length;
    act(() => popOverlay("settings"));
    await waitFor(() =>
      expect(page.show.mock.calls.length).toBeGreaterThan(shows),
    );
    // The divider's press does the same.
    act(() => beginPageMotion());
    expect(page.freeze).toHaveBeenCalledTimes(2);
    act(() => endPageMotion());
  });
});
