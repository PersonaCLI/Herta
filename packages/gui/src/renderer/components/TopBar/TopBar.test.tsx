import { act, fireEvent, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import {
  createMockHertaBridge,
  type MockHertaBridge,
} from "../../ipc/mock-bridge.js";
import { useShortcut } from "../../lib/shortcut-registry.js";
import { TopBar } from "./TopBar.js";

function renderTopBar(
  overrides: Partial<Parameters<typeof TopBar>[0]> = {},
): ReturnType<typeof createMockHertaBridge> & {
  container: HTMLElement;
  onToggleCollapse: ReturnType<typeof vi.fn>;
  onToggleSearch: ReturnType<typeof vi.fn>;
} {
  const mock = createMockHertaBridge();
  const onToggleCollapse = vi.fn();
  const onToggleSearch = vi.fn();
  const { container } = renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <TopBar
        collapsed={false}
        onToggleCollapse={onToggleCollapse}
        searchActive={false}
        onToggleSearch={onToggleSearch}
        {...overrides}
      />
    </HertaBridgeProvider>,
  );
  return { ...mock, container, onToggleCollapse, onToggleSearch };
}

describe("TopBar", () => {
  it("renders three inline SVG icons for the three controls (no raster imgs)", () => {
    const { container } = renderTopBar();
    // Inline SVG (not <img>) so CSS can drive stroke-width/color on hover.
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(
      container.querySelectorAll("svg.sidebar-header-icon-svg"),
    ).toHaveLength(3);
    expect(
      container.querySelector('[data-icon="panel-toggle"]'),
    ).toBeInTheDocument();
    expect(container.querySelector('[data-icon="search"]')).toBeInTheDocument();
    expect(
      container.querySelector('[data-icon="new-session"]'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Toggle sidebar")).toBeInTheDocument();
    expect(screen.getByLabelText("Search sessions")).toBeInTheDocument();
    expect(screen.getByLabelText("New session")).toBeInTheDocument();
  });

  it("reports aria-expanded=true when expanded", () => {
    const { container } = renderTopBar({ collapsed: false });
    expect(
      container.querySelector('[aria-label="Toggle sidebar"]'),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("reports aria-expanded=false when collapsed", () => {
    const { container } = renderTopBar({ collapsed: true });
    expect(
      container.querySelector('[aria-label="Toggle sidebar"]'),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("marks the search button active when searchActive is true", () => {
    renderTopBar({ searchActive: true });
    expect(screen.getByLabelText("Search sessions").className).toContain(
      "is-active",
    );
  });

  it("forwards searchButtonRef to the search button", () => {
    const mock = createMockHertaBridge();
    const searchButtonRef = createRef<HTMLButtonElement>();
    renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <TopBar
          collapsed={false}
          onToggleCollapse={() => {}}
          searchActive={false}
          onToggleSearch={() => {}}
          searchButtonRef={searchButtonRef}
        />
      </HertaBridgeProvider>,
    );
    expect(searchButtonRef.current).not.toBeNull();
    expect(searchButtonRef.current?.tagName).toBe("BUTTON");
    expect(searchButtonRef.current?.getAttribute("aria-label")).toBe(
      "Search sessions",
    );
  });

  it("clicking toggle / search calls the handlers; new calls createSession", () => {
    const { onToggleCollapse, onToggleSearch, calls } = renderTopBar();
    fireEvent.click(screen.getByLabelText("Toggle sidebar"));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Search sessions"));
    expect(onToggleSearch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("New session"));
    expect(calls.createSession).toHaveLength(1);
  });
});

function emitPending(mock: MockHertaBridge): void {
  act(() => {
    mock.emitOverlay({
      kind: "pending",
      overlay: {
        kind: "pending-permission",
        requestId: "r1",
        risk: "workspace_write",
        tool: "write_new_file",
        summary: "x",
      },
    });
  });
}

describe("TopBar tooltips", () => {
  it("uses styled tooltips, not native title, on the icons", () => {
    renderTopBar();
    expect(
      screen.getByRole("button", { name: "Toggle sidebar" }),
    ).not.toHaveAttribute("title");
    expect(
      screen.getByRole("button", { name: "Search sessions" }),
    ).not.toHaveAttribute("title");
    expect(
      screen.getByRole("button", { name: "New session" }),
    ).not.toHaveAttribute("title");
    expect(screen.getAllByRole("tooltip")).toHaveLength(3);
    expect(screen.getByText("Toggle sidebar")).toBeInTheDocument();
    expect(screen.getByText("Search sessions")).toBeInTheDocument();
  });

  it("shows the guard hint as the New-session tooltip while a gate is pending", () => {
    const mock = renderTopBar();
    emitPending(mock);
    expect(
      screen.getByText("Resolve the pending approval first"),
    ).toBeInTheDocument();
  });
});

describe("TopBar session title", () => {
  function emitSession(
    mock: ReturnType<typeof renderTopBar>,
    title: string | null = null,
  ): void {
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
  }

  it("does NOT render a title on the connect screen (no active session)", () => {
    // The bug: collapsing the sidebar with no session showed an "Untitled"
    // placeholder. With no active session there is no title at all.
    const { container } = renderTopBar({ collapsed: true });
    expect(container.querySelector("h1.topbar-title")).toBeNull();
    expect(screen.queryByText("Untitled")).toBeNull();
  });

  it("renders the title as an h1 after the controls (in a session)", () => {
    const mock = renderTopBar();
    emitSession(mock, "标题");
    const h1 = mock.container.querySelector("h1.topbar-title");
    expect(h1).not.toBeNull();
    // The title element comes after the three control buttons in DOM order.
    const bar = mock.container.querySelector(".topbar");
    const children = Array.from(bar?.children ?? []);
    // Last child: after all three control buttons (their tooltip wrappers).
    expect(children.indexOf(h1 as Element)).toBe(children.length - 1);
  });

  it("renders a disk-loaded title from a reset (instantly)", () => {
    const mock = renderTopBar();
    emitSession(mock, "已有标题");
    expect(screen.getByText("已有标题")).toBeInTheDocument();
  });

  it("shows a live-generated title (typed in after the reveal)", async () => {
    const mock = renderTopBar();
    emitSession(mock, null);
    act(() => {
      mock.emitTitle({ kind: "title", sessionId: "s-1", title: "新生成标题" });
    });
    expect(
      await screen.findByText("新生成标题", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
  });

  it("falls back to Untitled for a session with no generated title yet", () => {
    const mock = renderTopBar();
    emitSession(mock, null);
    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });

  it("fades the title out (is-tucked) while the sidebar is shown", () => {
    const mock = renderTopBar({ collapsed: false });
    emitSession(mock, "标题");
    expect(
      mock.container.querySelector("h1.topbar-title")?.className,
    ).toContain("is-tucked");
  });

  it("reveals the title (no is-tucked) when the sidebar is collapsed", () => {
    const mock = renderTopBar({ collapsed: true });
    emitSession(mock, "标题");
    expect(
      mock.container.querySelector("h1.topbar-title")?.className,
    ).not.toContain("is-tucked");
  });
});

describe("TopBar new-session guard", () => {
  it("creates a session when no gate is pending", () => {
    const { calls } = renderTopBar();
    const btn = screen.getByRole("button", { name: "New session" });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(calls.createSession).toHaveLength(1);
  });

  it("disables New Session and blocks create while a gate is pending", () => {
    const mock = renderTopBar();
    emitPending(mock);
    const btn = screen.getByRole("button", { name: "New session" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(mock.calls.createSession).toEqual([]);
  });

  it("leaves panel-toggle and search clickable while a gate is pending", () => {
    const mock = renderTopBar();
    emitPending(mock);
    expect(
      screen.getByRole("button", { name: "Toggle sidebar" }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Search sessions" }),
    ).not.toBeDisabled();
  });
});

describe("TopBar new-session mid-turn guard (2026-07-12)", () => {
  it("the first click mid-turn ARMS instead of creating; the second click creates", () => {
    const bar = renderTopBar();
    act(() => {
      bar.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      bar.emitTurn({ kind: "started", turnId: "t1" });
    });
    const btn = screen.getByLabelText("New session");
    fireEvent.click(btn);
    expect(bar.calls.createSession).toHaveLength(0);
    expect(btn.className).toContain("is-armed");
    fireEvent.click(btn);
    expect(bar.calls.createSession).toHaveLength(1);
    expect(btn.className).not.toContain("is-armed");
  });

  it("a DOUBLE-click mid-turn only arms — the second click of it is not the confirm (UX review 2026-09-22, item 3)", () => {
    const bar = renderTopBar();
    act(() => {
      bar.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      bar.emitTurn({ kind: "started", turnId: "t1" });
    });
    const btn = screen.getByLabelText("New session");
    fireEvent.click(btn, { detail: 1 });
    fireEvent.click(btn, { detail: 2 });
    expect(bar.calls.createSession).toHaveLength(0);
    expect(btn.className).toContain("is-armed");
    fireEvent.click(btn, { detail: 1 });
    expect(bar.calls.createSession).toHaveLength(1);
  });

  it("disarms when the turn ends; an idle click creates immediately", () => {
    const bar = renderTopBar();
    act(() => {
      bar.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      bar.emitTurn({ kind: "started", turnId: "t1" });
    });
    const btn = screen.getByLabelText("New session");
    fireEvent.click(btn); // arms
    act(() => {
      bar.emitTurn({ kind: "finished", turnId: "t1" });
    });
    expect(btn.className).not.toContain("is-armed");
    fireEvent.click(btn);
    expect(bar.calls.createSession).toHaveLength(1);
  });

  it("the arm times out and a later click re-arms rather than creating", () => {
    vi.useFakeTimers();
    const bar = renderTopBar();
    act(() => {
      bar.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      bar.emitTurn({ kind: "started", turnId: "t1" });
    });
    const btn = screen.getByLabelText("New session");
    fireEvent.click(btn);
    expect(btn.className).toContain("is-armed");
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(btn.className).not.toContain("is-armed");
    fireEvent.click(btn);
    expect(bar.calls.createSession).toHaveLength(0); // re-armed, still guarded
    vi.useRealTimers();
  });

  it("a tray new-chat refusal (navBlocked target null) ARMS the icon; a session-targeted one does not (2026-07-13)", () => {
    const bar = renderTopBar();
    act(() => {
      bar.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      bar.emitTurn({ kind: "started", turnId: "t1" });
    });
    const btn = screen.getByLabelText("New session");
    act(() => {
      bar.emitNavBlocked({ target: "some-session" }); // sidebar's, not ours
    });
    expect(btn.className).not.toContain("is-armed");
    act(() => {
      bar.emitNavBlocked({ target: null });
    });
    expect(btn.className).toContain("is-armed");
    // The tray attempt was the first step — a direct click now creates.
    fireEvent.click(btn);
    expect(bar.calls.createSession).toHaveLength(1);
  });

  it("the browser's button opens the page tab, with a session and pages (ADR 0083)", () => {
    const mock = createMockHertaBridge();
    const bridge = { ...mock.bridge, pageShow: vi.fn() };
    const opened = vi.fn(() => true);
    function Host(): null {
      useShortcut("openBrowser", opened, true);
      return null;
    }
    renderWithLocale(
      <HertaBridgeProvider bridge={bridge}>
        <Host />
        <TopBar
          collapsed={false}
          onToggleCollapse={vi.fn()}
          searchActive={false}
          onToggleSearch={vi.fn()}
        />
      </HertaBridgeProvider>,
    );
    // No session yet: no page to open.
    expect(screen.queryByRole("button", { name: "Browser" })).toBeNull();
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        title: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Browser" }));
    expect(opened).toHaveBeenCalledTimes(1);
  });
});

describe("TopBar — Flow's radio (owner 2026-10-31)", () => {
  const flowButton = (c: HTMLElement) =>
    c.querySelector<SVGElement>("svg[data-icon='flow']");

  it("takes the shared icon treatment, as the globe and the rest do", () => {
    const { container } = renderTopBar({
      flow: { open: false, unread: false, gathering: false },
    });
    const svg = flowButton(container);
    expect(svg?.classList.contains("sidebar-header-icon-svg")).toBe(true);
    // No fixed stroke: CSS owns it, so hover can thicken it.
    expect(svg?.getAttribute("stroke-width")).toBeNull();
    expect(svg?.classList.contains("is-gathering")).toBe(false);
    expect(svg?.classList.contains("is-ready")).toBe(false);
  });

  // Owner 2026-10-31: one animation for both hid when the issue was ready.
  it("pulses only while gathering; a ready issue holds still under the dot", () => {
    const state = (flow: {
      open: boolean;
      unread: boolean;
      gathering: boolean;
    }) => {
      const { container } = renderTopBar({ flow });
      const svg = flowButton(container);
      return {
        gathering: svg?.classList.contains("is-gathering") ?? false,
        ready: svg?.classList.contains("is-ready") ?? false,
        dot: container.querySelector(".flow-button-dot") !== null,
      };
    };
    expect(state({ open: false, unread: false, gathering: true })).toEqual({
      gathering: true,
      ready: false,
      dot: false,
    });
    expect(state({ open: false, unread: true, gathering: false })).toEqual({
      gathering: false,
      ready: true,
      dot: true,
    });
    // A refresh over an unread issue: still gathering, the dot still says
    // there is one to read.
    expect(state({ open: false, unread: true, gathering: true })).toEqual({
      gathering: true,
      ready: false,
      dot: true,
    });
    expect(state({ open: true, unread: true, gathering: true })).toEqual({
      gathering: false,
      ready: false,
      dot: false,
    });
  });
});
