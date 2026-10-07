import type { UndoTurnEditsResult } from "@herta/app-server";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  HertaBridgeProvider,
  useHertaBridge,
} from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import type { SessionStore } from "../../store/session-store.js";
import { Composer } from "./Composer.js";
import { WorkspaceRefsProvider } from "./WorkspaceRefs.js";

afterEach(() => {
  cleanup();
});

function StoreProbe(props: { onStore: (s: SessionStore) => void }) {
  props.onStore(useHertaBridge().sessionStore);
  return null;
}

function renderComposer(result?: UndoTurnEditsResult) {
  const mock = createMockHertaBridge(
    result !== undefined ? { undoLastTurnEditsResult: result } : {},
  );
  let store: SessionStore | null = null;
  renderWithLocale(
    <WorkspaceRefsProvider>
      <HertaBridgeProvider bridge={mock.bridge}>
        <StoreProbe
          onStore={(s) => {
            store = s;
          }}
        />
        <Composer />
      </HertaBridgeProvider>
    </WorkspaceRefsProvider>,
  );
  act(() =>
    mock.emitReset({
      sessionId: "s1",
      workspaceRoot: "/r",
      record: [],
      overlay: null,
      title: null,
      backendWorkspace: "/r",
      backendWorkspaceIsDefault: true,
      lang: "en",
    }),
  );
  return {
    mock,
    store: (): SessionStore => {
      if (store === null) throw new Error("store probe never rendered");
      return store;
    },
  };
}

const ok = (
  files: Array<{ path: string; result: "restored" | "changed_since" }>,
): UndoTurnEditsResult => ({
  ok: true,
  files,
  commands: [],
  commandsUnknown: false,
  incomplete: false,
});

const action = () => screen.queryByRole("button", { name: "Undo changes" });

describe("the rewind notice can take the withdrawn turn's edits back (ADR 0074 §4)", () => {
  it("offers Undo changes when the rewound turn's edits are undoable, and taking it undoes them", async () => {
    const { mock, store } = renderComposer(
      ok([{ path: "a.ts", result: "restored" }]),
    );
    act(() =>
      store().requestComposerDraft(
        "the rewound message",
        "Edited files were not reverted",
        undefined,
        true,
      ),
    );
    expect(screen.getByText("Edited files were not reverted")).toBeTruthy();
    await act(async () => {
      fireEvent.click(action() as HTMLElement);
    });
    expect(mock.calls.undoLastTurnEdits).toEqual([["s1", "withdrawn"]]);
    expect(screen.getByText("Changes undone")).toBeTruthy();
    expect(action()).toBeNull();
  });

  it("names the files it left alone — the withdrawn turn writes no record line, so the notice is where they show", async () => {
    const { store } = renderComposer(
      ok([
        { path: "a.ts", result: "restored" },
        { path: "README.md", result: "changed_since" },
      ]),
    );
    act(() =>
      store().requestComposerDraft(
        "x",
        "Edited files were not reverted",
        undefined,
        true,
      ),
    );
    await act(async () => {
      fireEvent.click(action() as HTMLElement);
    });
    expect(
      screen.getByText("Changes undone; not restored: README.md"),
    ).toBeTruthy();
  });

  it("an undo that cannot happen says so", async () => {
    const { store } = renderComposer({ ok: false, reason: "nothing_to_undo" });
    act(() =>
      store().requestComposerDraft(
        "x",
        "Edited files were not reverted",
        undefined,
        true,
      ),
    );
    await act(async () => {
      fireEvent.click(action() as HTMLElement);
    });
    expect(screen.getByText("Undo failed")).toBeTruthy();
    expect(action()).toBeNull();
  });

  it("no offer without undoable edits — the notice stands alone", () => {
    const { store } = renderComposer();
    act(() =>
      store().requestComposerDraft("x", "Edited files were not reverted"),
    );
    expect(screen.getByText("Edited files were not reverted")).toBeTruthy();
    expect(action()).toBeNull();
  });
});
