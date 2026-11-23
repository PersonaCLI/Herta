import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { createMockHertaBridge, withSetting } from "./ipc/mock-bridge.js";

vi.mock("./components/Opening/pick-opening-segment.js", () => ({
  // Never-resolving loader: the splash overlay mounts (empty) but does not
  // load a real asset or progress in App-level tests.
  pickOpeningSegment: () => () => new Promise<never>(() => {}),
}));

describe("App", () => {
  beforeEach(() => window.localStorage.clear());

  it("renders the three layout regions plus the top bar", () => {
    const { bridge } = createMockHertaBridge();
    render(<App bridge={bridge} />);
    expect(screen.getByTestId("topbar")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("workspace")).toBeInTheDocument();
    expect(screen.getByTestId("utility-rail")).toBeInTheDocument();
  });

  // macOS draws its traffic lights inside our frameless window's top-left, over
  // whatever the renderer puts there — and the topbar's first icons sat under
  // them until .app.is-mac reserved the room (reference-ux.css). Only the
  // native screencapture of a mac build showed it; CDP captures web contents
  // without OS chrome, so it stayed invisible to every automated check.
  it("marks the root is-mac on darwin so the topbar clears the traffic lights", () => {
    const { bridge } = createMockHertaBridge({ platform: "darwin" });
    const { container } = render(<App bridge={bridge} />);
    expect(container.querySelector(".app")?.classList.contains("is-mac")).toBe(
      true,
    );
  });

  it("does NOT mark is-mac elsewhere — Windows/Linux have no traffic lights", () => {
    const { bridge } = createMockHertaBridge({ platform: "win32" });
    const { container } = render(<App bridge={bridge} />);
    expect(container.querySelector(".app")?.classList.contains("is-mac")).toBe(
      false,
    );
  });

  it("in full screen the Mac top bar stops reserving room for the hidden traffic lights (2026-09-23)", async () => {
    const mock = createMockHertaBridge({
      platform: "darwin",
      windowIsFullScreenResult: true,
    });
    const { container } = render(<App bridge={mock.bridge} />);
    const root = (): Element | null => container.querySelector(".app");
    // Seeded from main on mount (a reload inside a full-screen window).
    await waitFor(() =>
      expect(root()?.classList.contains("is-fullscreen")).toBe(true),
    );
    act(() => mock.emitWindowFullScreen(false));
    expect(root()?.classList.contains("is-fullscreen")).toBe(false);
    act(() => mock.emitWindowFullScreen(true));
    expect(root()?.classList.contains("is-fullscreen")).toBe(true);
  });

  it("the application menu's Settings… (Cmd+,) opens Settings (2026-09-23)", async () => {
    const mock = createMockHertaBridge({ platform: "darwin" });
    render(<App bridge={mock.bridge} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => mock.emitOpenSettings());
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  });

  it("shows the error panel when bootstrap reports an error", () => {
    const mock = createMockHertaBridge();
    render(<App bridge={mock.bridge} />);
    act(() => {
      mock.emitReset({ error: "DeepSeek API key not found" });
    });
    expect(screen.getByTestId("app-error")).toBeInTheDocument();
    expect(screen.getByText("DeepSeek API key not found")).toBeInTheDocument();
    // Localized heading renders in English under the default en locale.
    expect(screen.getByText("Herta could not start")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
  });

  it("toggles the sidebar from the top bar with no floating overlay button", () => {
    const { bridge } = createMockHertaBridge();
    const { container } = render(<App bridge={bridge} />);
    const app = container.querySelector(".app");
    const toggle = screen.getByLabelText("Toggle sidebar");
    expect(app?.classList.contains("sidebar-collapsed")).toBe(false);
    expect(screen.queryByTestId("sidebar-reopen")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(app?.classList.contains("sidebar-collapsed")).toBe(true);
    expect(screen.getByLabelText("Toggle sidebar")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByTestId("sidebar-reopen")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Toggle sidebar"));
    expect(app?.classList.contains("sidebar-collapsed")).toBe(false);
  });

  it("restores the persisted collapsed state on mount", () => {
    window.localStorage.setItem("herta.sidebar.collapsed", "1");
    const { bridge } = createMockHertaBridge();
    const { container } = render(<App bridge={bridge} />);
    expect(
      container.querySelector(".app")?.classList.contains("sidebar-collapsed"),
    ).toBe(true);
    expect(screen.getByLabelText("Toggle sidebar")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("opening search while collapsed expands the sidebar and shows the field", () => {
    window.localStorage.setItem("herta.sidebar.collapsed", "1");
    const { bridge } = createMockHertaBridge();
    const { container } = render(<App bridge={bridge} />);
    const app = container.querySelector(".app");
    expect(app?.classList.contains("sidebar-collapsed")).toBe(true);
    fireEvent.click(screen.getByLabelText("Search sessions"));
    expect(app?.classList.contains("sidebar-collapsed")).toBe(false);
    expect(screen.getByPlaceholderText("Search sessions")).toBeInTheDocument();
  });

  it("returns focus to the search button when search closes via Escape", () => {
    const { bridge } = createMockHertaBridge();
    render(<App bridge={bridge} />);
    fireEvent.click(screen.getByLabelText("Search sessions"));
    const input = screen.getByPlaceholderText("Search sessions");
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByLabelText("Search sessions")).toHaveFocus();
  });

  it("shows an error screen (not a blank crash) when the bridge is unavailable", () => {
    const prior = (window as { herta?: unknown }).herta;
    (window as { herta?: unknown }).herta = undefined;
    try {
      render(<App />);
      expect(screen.getByTestId("app-error")).toBeInTheDocument();
      expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
    } finally {
      (window as { herta?: unknown }).herta = prior;
    }
  });

  it("the no-bridge screen still has a way to close the frameless window (2026-09-23)", () => {
    const prior = (window as { herta?: unknown }).herta;
    (window as { herta?: unknown }).herta = undefined;
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    try {
      render(<App />);
      fireEvent.click(screen.getByLabelText("Close"));
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      (window as { herta?: unknown }).herta = prior;
    }
  });

  it("shows the opening splash over the workspace on a normal launch", () => {
    const { bridge } = createMockHertaBridge();
    render(<App bridge={bridge} />);
    expect(screen.getByTestId("opening-ascii")).toBeInTheDocument();
    // Workbench mounts underneath the splash from the start.
    expect(screen.getByTestId("workspace")).toBeInTheDocument();
  });

  it("does not show the opening splash on the bridge-unavailable error path", () => {
    const prior = (window as { herta?: unknown }).herta;
    (window as { herta?: unknown }).herta = undefined;
    try {
      render(<App />);
      expect(screen.queryByTestId("opening-ascii")).not.toBeInTheDocument();
      expect(screen.getByTestId("app-error")).toBeInTheDocument();
    } finally {
      (window as { herta?: unknown }).herta = prior;
    }
  });

  it("fetches the locale from the bridge on mount", async () => {
    const getLocale = vi.fn(async () => "zh" as const);
    const { bridge } = createMockHertaBridge();
    const bridgeWithLocale = withSetting(bridge, "locale", { get: getLocale });
    render(<App bridge={bridgeWithLocale} />);
    await waitFor(() => expect(getLocale).toHaveBeenCalled());
    // The workbench is still present after locale fetch.
    expect(screen.getByTestId("workspace")).toBeInTheDocument();
  });
});

describe("disconnected state gating", () => {
  beforeEach(() => window.localStorage.clear());

  it("does NOT mark disconnected before bootstrap (no reset yet)", () => {
    const mock = createMockHertaBridge();
    const { container } = render(<App bridge={mock.bridge} />);
    expect(container.querySelector(".app.is-disconnected")).toBeNull();
  });

  it("marks the shell disconnected after deleting the active session", () => {
    const mock = createMockHertaBridge();
    const { container } = render(<App bridge={mock.bridge} />);
    act(() => {
      mock.emitReset({
        sessionId: "s1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    expect(container.querySelector(".app.is-disconnected")).toBeNull();
    act(() => {
      mock.emitSessionDeleted({ sessionId: "s1" });
    });
    expect(container.querySelector(".app.is-disconnected")).not.toBeNull();
  });
});
