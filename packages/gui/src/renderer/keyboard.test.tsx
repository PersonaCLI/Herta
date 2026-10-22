import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHORTCUTS } from "../shared/shortcuts.js";
import { App } from "./App.js";
import { en } from "./i18n/messages/en.js";
import { zh } from "./i18n/messages/zh.js";
import { createMockHertaBridge } from "./ipc/mock-bridge.js";
import { OVERLAY_Z, popOverlay, pushOverlay } from "./lib/overlay-stack.js";
import { mockSessionList } from "./mocks/sessions.js";

vi.mock("./components/Opening/pick-opening-segment.js", () => ({
  pickOpeningSegment: () => () => new Promise<never>(() => {}),
}));

const ctrl = (key: string, over: Record<string, unknown> = {}): void => {
  fireEvent.keyDown(document.activeElement ?? document.body, {
    key,
    ctrlKey: true,
    ...over,
  });
};

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mountWithSession(
  opts: Parameters<typeof createMockHertaBridge>[0] = {},
) {
  const mock = createMockHertaBridge(opts);
  const r = render(<App bridge={mock.bridge} />);
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
  return { ...r, mock };
}

describe("the keyboard (ADR 0082)", () => {
  beforeEach(() => window.localStorage.clear());

  it("every command and group has its label in both languages", () => {
    for (const s of SHORTCUTS) {
      for (const m of [zh, en] as const) {
        expect(m).toHaveProperty(`shortcut.${s.id}`);
        expect(m).toHaveProperty(`shortcut.group.${s.group}`);
      }
    }
  });

  it("Ctrl+/ opens the cheat sheet — every row of the table, in two columns — and Escape closes it, giving the focus back", () => {
    mountWithSession();
    const before = document.activeElement;
    ctrl("/", { code: "Slash" });
    const sheet = screen.getByTestId("shortcuts-sheet");
    expect(sheet.querySelectorAll(".shortcuts-row")).toHaveLength(
      SHORTCUTS.length,
    );
    expect(sheet.querySelectorAll(".shortcuts-card__cols > div")).toHaveLength(
      2,
    );
    // Windows draws words, one cap per key.
    expect(
      [...sheet.querySelectorAll(".shortcuts-row")][0]?.querySelectorAll(
        ".keycap",
      ),
    ).toHaveLength(2);
    expect(sheet.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByTestId("shortcuts-sheet")).toBeNull();
    expect(document.activeElement).toBe(before);
  });

  it("Ctrl+/ again closes the sheet it opened", () => {
    mountWithSession();
    ctrl("/", { code: "Slash" });
    expect(screen.getByTestId("shortcuts-sheet")).toBeInTheDocument();
    ctrl("/", { code: "Slash" });
    expect(screen.queryByTestId("shortcuts-sheet")).toBeNull();
  });

  it("macOS draws the keys as symbols", () => {
    mountWithSession({ platform: "darwin" });
    fireEvent.keyDown(document.body, {
      key: "/",
      metaKey: true,
      code: "Slash",
    });
    const caps = [
      ...screen.getByTestId("shortcuts-sheet").querySelectorAll(".keycap"),
    ].map((k) => k.textContent);
    expect(caps).toContain("⌘");
    expect(caps).not.toContain("Ctrl");
  });

  it("Ctrl+B shows and hides the sidebar; Ctrl+K opens the search with the caret in it", () => {
    const { container } = mountWithSession();
    const app = (): Element | null => container.querySelector(".app");
    ctrl("b");
    expect(app()?.classList.contains("sidebar-collapsed")).toBe(true);
    ctrl("b");
    expect(app()?.classList.contains("sidebar-collapsed")).toBe(false);
    ctrl("k");
    expect(document.activeElement?.classList.contains("sidebar-search")).toBe(
      true,
    );
  });

  it("Ctrl+N is the new-session button, with its guards", () => {
    const { mock } = mountWithSession();
    ctrl("n");
    expect(mock.calls.createSession).toHaveLength(1);
  });

  it("over Settings the window keys do nothing — the dialog owns the keyboard", async () => {
    const { mock } = mountWithSession();
    act(() => mock.emitOpenSettings());
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    ctrl("n");
    expect(mock.calls.createSession).toHaveLength(0);
  });

  it("the menu's Close closes the window when no viewer is open", () => {
    const { mock } = mountWithSession();
    act(() => mock.emitCloseRequested());
    expect(mock.calls.windowClose).toBe(1);
  });

  it("the menu's Settings… closes the cheat sheet on its way", async () => {
    const { mock } = mountWithSession();
    ctrl("/", { code: "Slash" });
    act(() => mock.emitOpenSettings());
    expect(screen.queryByTestId("shortcuts-sheet")).toBeNull();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
  });

  it("the menu's Settings… does nothing over the key prompt or the lightbox — Settings would open behind it and take its focus (release review 2026-10-22)", async () => {
    const { mock } = mountWithSession();
    for (const [id, z] of [
      ["keyPrompt", OVERLAY_Z.keyPrompt],
      ["lightbox", OVERLAY_Z.lightbox],
    ] as const) {
      act(() => pushOverlay(id, z));
      try {
        act(() => mock.emitOpenSettings());
        await settle();
        expect(document.querySelector(".settings-nav"), id).toBeNull();
      } finally {
        act(() => popOverlay(id));
      }
    }
    act(() => mock.emitOpenSettings());
    await waitFor(() =>
      expect(document.querySelector(".settings-nav")).toBeInTheDocument(),
    );
  });

  it("Ctrl+L puts the caret in the composer", () => {
    mountWithSession();
    (document.activeElement as HTMLElement | null)?.blur();
    ctrl("l");
    expect(document.activeElement?.classList.contains("composer-input")).toBe(
      true,
    );
  });

  it("Ctrl+Shift+] opens the session below the open one; ↑/↓ walk the cards", async () => {
    const { mock } = mountWithSession({ listSessionsResult: mockSessionList });
    await settle();
    const cards = screen.getAllByTestId("session-card");
    expect(cards.length).toBeGreaterThan(1);
    const first = cards[0]?.dataset.flipKey;
    // No card is the open one ("s1" is not in the list): ] starts at the top.
    ctrl("}", { shiftKey: true, code: "BracketRight" });
    expect(mock.calls.openSession).toEqual([first]);
    // ↓ on a card moves to the next one, without opening it.
    (cards[0] as HTMLElement).focus();
    fireEvent.keyDown(cards[0] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(cards[1]);
    expect(mock.calls.openSession).toHaveLength(1);
  });
});

describe("Escape stops the run (ADR 0082 §5)", () => {
  beforeEach(() => window.localStorage.clear());

  const flush = async (): Promise<void> => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  it("on the bare page, mid-turn, Escape interrupts — as the Stop button does", async () => {
    const { mock } = mountWithSession();
    act(() => mock.emitTurn({ kind: "started", turnId: "t1" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    await flush();
    expect(mock.calls.interrupt).toHaveLength(1);
  });

  it("not when idle, not on a repeat, and not when another surface answered it", async () => {
    const { mock } = mountWithSession();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await flush();
    expect(mock.calls.interrupt).toHaveLength(0);
    act(() => mock.emitTurn({ kind: "started", turnId: "t1" }));
    fireEvent.keyDown(document.body, { key: "Escape", repeat: true });
    await flush();
    expect(mock.calls.interrupt).toHaveLength(0);
    // A listener that answers Escape marks it: the stop stands down,
    // whichever listener ran first.
    const claim = (e: KeyboardEvent): void => {
      if (e.key === "Escape") e.preventDefault();
    };
    window.addEventListener("keydown", claim);
    fireEvent.keyDown(document.body, { key: "Escape" });
    window.removeEventListener("keydown", claim);
    await flush();
    expect(mock.calls.interrupt).toHaveLength(0);
  });

  it("not while an overlay is open — the Escape closes it instead", async () => {
    const { mock } = mountWithSession();
    act(() => mock.emitTurn({ kind: "started", turnId: "t1" }));
    ctrl("/", { code: "Slash" });
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await flush();
    expect(screen.queryByTestId("shortcuts-sheet")).toBeNull();
    expect(mock.calls.interrupt).toHaveLength(0);
  });

  it("not from another text field", async () => {
    const { mock } = mountWithSession();
    act(() => mock.emitTurn({ kind: "started", turnId: "t1" }));
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    fireEvent.keyDown(field, { key: "Escape" });
    await flush();
    field.remove();
    expect(mock.calls.interrupt).toHaveLength(0);
  });
});

describe("Settings shows where the cheat sheet is (ADR 0082 amendment 2026-10-21)", () => {
  beforeEach(() => window.localStorage.clear());

  async function openSettings() {
    const r = mountWithSession();
    act(() => r.mock.emitOpenSettings());
    await waitFor(() =>
      expect(document.querySelector(".settings-nav-foot")).toBeInTheDocument(),
    );
    return r;
  }

  it("the nav's foot row names the keys and opens the sheet over Settings; a press inside the sheet leaves Settings open, and Escape closes the sheet alone", async () => {
    await openSettings();
    const foot = document.querySelector(".settings-nav-foot") as HTMLElement;
    expect(foot.textContent).toContain("Shortcuts");
    expect(
      [...foot.querySelectorAll(".keycap")].map((k) => k.textContent),
    ).toEqual(["Ctrl", "/"]);
    fireEvent.click(foot);
    const sheet = screen.getByTestId("shortcuts-sheet");
    fireEvent.mouseDown(sheet.querySelector(".shortcuts-card") as Element);
    expect(document.querySelector(".settings-card")).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByTestId("shortcuts-sheet")).toBeNull();
    expect(document.querySelector(".settings-card")).toBeInTheDocument();
  });

  it("a press on the sheet's empty backdrop closes the sheet alone — Settings under it stays open (owner 2026-10-21)", async () => {
    await openSettings();
    fireEvent.click(document.querySelector(".settings-nav-foot") as Element);
    const backdrop = screen.getByTestId("shortcuts-sheet");
    // Pins the intended behaviour. The bug itself needs the browser's
    // timing — the sheet's close lands in React between the press's
    // listeners, before it reaches the document where Settings listens —
    // which a press dispatched in jsdom does not have; it was reproduced and
    // checked with a real click in the dev renderer.
    fireEvent.mouseDown(backdrop);
    expect(screen.queryByTestId("shortcuts-sheet")).toBeNull();
    expect(document.querySelector(".settings-card")).toBeInTheDocument();
  });

  it("Ctrl+/ opens the sheet over Settings too", async () => {
    await openSettings();
    ctrl("/", { code: "Slash" });
    expect(screen.getByTestId("shortcuts-sheet")).toBeInTheDocument();
  });
});
