import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageState } from "../../../shared/browser-page.js";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import {
  createMockHertaBridge,
  type MockHertaBridge,
} from "../../ipc/mock-bridge.js";
import { OVERLAY_Z, popOverlay, pushOverlay } from "../../lib/overlay-stack.js";
import { beginPageMotion, endPageMotion } from "../../lib/page-motion.js";
import { runShortcut } from "../../lib/shortcut-registry.js";
import type { SessionStore } from "../../store/session-store.js";
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
    // Escape in the field puts the address back — here the one on its way;
    // it is the field's.
    fireEvent.change(url, { target: { value: "typo" } });
    fireEvent.keyDown(url, { key: "Escape" });
    expect(url.value).toBe("localhost:5173/login");
    expect(screen.getByTestId("page-view")).toBeTruthy();
  });

  it("the address sent with Enter stays in the bar until the page gets there (owner 2026-10-28)", async () => {
    const mock = createMockHertaBridge();
    const { page, emit } = withPage(mock);
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    act(() => {
      runShortcut("openBrowser");
    });
    await waitFor(() => expect(screen.getByTestId("page-view")).toBeTruthy());
    const url = screen.getByLabelText("Address") as HTMLInputElement;
    const enter = (text: string) => {
      fireEvent.change(url, { target: { value: text } });
      fireEvent.submit(url.closest("form") as HTMLFormElement);
    };
    // A new tab: the bar was emptied on Enter, until the server answered.
    enter("www.google.com");
    expect(url.value).toBe("www.google.com");
    emit({ url: "", loading: true });
    expect(url.value).toBe("www.google.com");
    emit({ url: "https://www.google.com/", loading: true });
    expect(url.value).toBe("https://www.google.com/");
    emit({ url: "https://www.google.com/", loading: false });
    // A load that fails where it began gives the page's own address back.
    enter("unreachable.example");
    emit({ url: "https://www.google.com/", loading: true });
    expect(url.value).toBe("unreachable.example");
    emit({ url: "https://www.google.com/", loading: false });
    expect(url.value).toBe("https://www.google.com/");
    // An address main would not load stays to be put right, and goes nowhere.
    page.navigate.mockClear();
    enter("not an address");
    expect(page.navigate).not.toHaveBeenCalled();
    expect(url.value).toBe("not an address");
  });

  it("closing the page tab ends the page, so it opens next on the server list (owner 2026-10-23)", () => {
    const mock = createMockHertaBridge();
    withPage(mock);
    const close = vi.fn();
    Object.assign(mock.bridge, { pageClose: close });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    act(() => {
      runShortcut("openBrowser");
    });
    fireEvent.click(screen.getByRole("button", { name: "Close file Browser" }));
    expect(close).toHaveBeenCalledWith("s1");
  });

  it("the picker: on while live, and a pick goes to the composer (ADR 0083 §4)", async () => {
    const mock = createMockHertaBridge();
    const { emit } = withPage(mock);
    const pick = vi.fn();
    let picked:
      | ((e: {
          sessionId: string;
          pick: { element: string; route: string; html: string } | null;
        }) => void)
      | null = null;
    Object.assign(mock.bridge, {
      pagePick: pick,
      onPagePicked: (cb: NonNullable<typeof picked>) => {
        picked = cb;
        return () => {
          picked = null;
        };
      },
    });
    let store: SessionStore | null = null;
    function StoreProbe(): null {
      store = useHertaBridge().sessionStore;
      return null;
    }
    const h = renderWithSession(
      <>
        <StoreProbe />
        {ui()}
      </>,
      { mock },
    );
    h.openSession("s1");
    act(() => {
      runShortcut("openBrowser");
    });
    await waitFor(() => expect(screen.getByTestId("page-view")).toBeTruthy());
    const button = screen.getByLabelText("Pick an element on the page");
    expect(button).toBeDisabled();
    emit({});
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(pick).toHaveBeenLastCalledWith("s1", true);
    expect(
      screen.getByLabelText("Stop picking (Esc)").getAttribute("aria-pressed"),
    ).toBe("true");
    const element = {
      element: 'button "Sign in"',
      route: "localhost:5173/login",
      html: "<button>Sign in</button>",
    };
    act(() => picked?.({ sessionId: "s1", pick: element }));
    expect((store as SessionStore | null)?.getSnapshot().composerPicks).toEqual(
      [element],
    );
    expect(
      screen
        .getByLabelText("Pick an element on the page")
        .getAttribute("aria-pressed"),
    ).toBe("false");
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
    emit({ canGoBack: true });
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe(
      "http://localhost:5173/login",
    );
    expect(screen.getByLabelText("Back")).not.toBeDisabled();
    expect(screen.getByLabelText("Forward")).toBeDisabled();
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

  describe("the new-tab page: the launcher's servers (ADR 0083 §4; pick B)", () => {
    it("lists a card per server; an ask-class Run confirms in its card first", async () => {
      const mock = createMockHertaBridge();
      withPage(mock);
      let state: "idle" | "ready" = "idle";
      const start = vi.fn(
        async (_s: string, _n: string, confirmed: boolean) => {
          if (!confirmed)
            return {
              ok: false as const,
              reason: "confirm" as const,
              command: "npm run dev",
              code: "command_ask_unknown",
            };
          state = "ready";
          return {
            ok: true as const,
            already: false,
            url: "http://localhost:5173/",
          };
        },
      );
      Object.assign(mock.bridge, {
        serversList: vi.fn(async () => ({
          ok: true as const,
          entries: [
            {
              name: "web",
              command: "npm run dev",
              port: 5173,
              url: "http://localhost:5173/",
              state,
            },
          ],
        })),
        serversStart: start,
        serversStop: vi.fn(async () => ({ ok: true })),
        onServersChanged: () => () => undefined,
      });
      const h = renderWithSession(ui(), { mock });
      h.openSession("s1");
      act(() => {
        runShortcut("openBrowser");
      });
      expect(await screen.findByText("web")).toBeTruthy();
      expect(screen.getByText("npm run dev")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      expect(await screen.findByRole("button", { name: "Run" })).toBeTruthy();
      expect(start).toHaveBeenLastCalledWith("s1", "web", false);
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      await waitFor(() =>
        expect(start).toHaveBeenLastCalledWith("s1", "web", true),
      );
      expect(await screen.findByRole("button", { name: "Stop" })).toBeTruthy();
    });

    it("a running server's log opens in a viewer tab", async () => {
      const mock = createMockHertaBridge();
      withPage(mock);
      Object.assign(mock.bridge, {
        serversList: vi.fn(async () => ({
          ok: true as const,
          entries: [
            {
              name: "web",
              command: "npm run dev",
              port: 5173,
              url: "http://localhost:5173/",
              state: "ready" as const,
              logPath: ".herta/logs/servers/web-1.log",
            },
          ],
        })),
        onServersChanged: () => () => undefined,
      });
      const h = renderWithSession(ui(), { mock });
      h.openSession("s1");
      act(() => {
        runShortcut("openBrowser");
      });
      fireEvent.click(await screen.findByRole("button", { name: "Log" }));
      await waitFor(() => expect(tabNames()).toContain("web · Log"));
    });

    it("without a launch file it shows nothing (owner 2026-10-24)", async () => {
      const mock = createMockHertaBridge();
      withPage(mock);
      Object.assign(mock.bridge, {
        serversList: vi.fn(async () => ({
          ok: false as const,
          reason: "no_launch_file" as const,
        })),
        onServersChanged: () => () => undefined,
      });
      const h = renderWithSession(ui(), { mock });
      h.openSession("s1");
      act(() => {
        runShortcut("openBrowser");
      });
      await waitFor(() => expect(mock.bridge.serversList).toHaveBeenCalled());
      expect(document.querySelector(".page-servers")).toBeNull();
      expect(document.querySelector(".page-view__empty")).toBeNull();
    });
  });
});
