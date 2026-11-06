import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { renderWithSession } from "../../testing/renderWithSession.js";
import { Composer } from "./Composer.js";
import { Conversation } from "./Conversation.js";
import { useUndoTurn } from "./useUndoTurn.js";
import { WorkspaceRefsProvider } from "./WorkspaceRefs.js";

afterEach(() => cleanup());

describe("what the chat shows of messages not yet in the record", () => {
  it("both messages to Herta stay on screen while she writes (review 2026-11-05, N3)", async () => {
    const mock = createMockHertaBridge();
    const h = renderWithSession(
      <WorkspaceRefsProvider>
        <Conversation />
        <Composer />
      </WorkspaceRefsProvider>,
      { mock, lang: "en", sessionId: "s1" },
    );
    act(() =>
      mock.emitReset({
        sessionId: "s1",
        workspaceRoot: "/r",
        record: [
          { kind: "user", text: "the task" },
          { kind: "herta", surface: "speech", text: "@板砖 go" },
          {
            kind: "system",
            label: "差分协处理器",
            body: "Reading a.ts",
            digest: { kind: "op", verb: "Reading", arg: "a.ts" },
          },
        ],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
        lang: "en",
      }),
    );
    h.startTurn();
    h.startBackend();
    const input = h.container.querySelector(
      "textarea.composer-input",
    ) as HTMLTextAreaElement;
    const shown = (text: string): number =>
      (h.container.textContent ?? "").split(text).length - 1;
    const send = async (text: string, n: number): Promise<void> => {
      fireEvent.change(input, { target: { value: text } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(mock.calls.talkText).toHaveLength(n));
    };
    await send("FIRST-QUESTION", 1);
    await send("SECOND-QUESTION", 2);
    expect(shown("FIRST-QUESTION")).toBe(1);
    expect(shown("SECOND-QUESTION")).toBe(1);
    // Her utterance ends and the drain writes the first message's block.
    act(() =>
      mock.emitRecord({
        kind: "block",
        blockId: "u1",
        block: { kind: "user", text: "FIRST-QUESTION", duringRun: true },
      }),
    );
    expect(shown("FIRST-QUESTION")).toBe(1);
    expect(shown("SECOND-QUESTION")).toBe(1);
    act(() =>
      mock.emitRecord({
        kind: "block",
        blockId: "u2",
        block: { kind: "user", text: "SECOND-QUESTION", duringRun: true },
      }),
    );
    expect(shown("FIRST-QUESTION")).toBe(1);
    expect(shown("SECOND-QUESTION")).toBe(1);
  });
});

describe("撤销 from the row and from the tab (review 2026-11-05, N8)", () => {
  function TwoSurfaces(): JSX.Element {
    const { sessionStore } = useHertaBridge();
    const row = useUndoTurn(sessionStore);
    const tab = useUndoTurn(sessionStore);
    return (
      <>
        <button type="button" onClick={() => void row.handleUndo()}>
          row
        </button>
        <button type="button" onClick={() => void tab.handleUndo()}>
          tab
        </button>
        <output>{tab.undoBusy ? "busy" : "free"}</output>
      </>
    );
  }

  it("one request goes, and the other surface shows it busy", async () => {
    const mock = createMockHertaBridge();
    let finish: () => void = () => undefined;
    const answered = new Promise<void>((r) => {
      finish = r;
    });
    const asked: string[] = [];
    Object.assign(mock.bridge, {
      undoLastTurnEdits: async (sessionId: string) => {
        asked.push(sessionId);
        await answered;
        return { ok: true, files: [] };
      },
    });
    const h = renderWithSession(<TwoSurfaces />, { mock, sessionId: "s1" });
    const press = (name: string): void => {
      fireEvent.click(
        Array.from(h.container.querySelectorAll("button")).find(
          (b) => b.textContent === name,
        ) as HTMLElement,
      );
    };
    await act(async () => {
      press("row");
    });
    expect(h.container.querySelector("output")?.textContent).toBe("busy");
    await act(async () => {
      press("tab");
    });
    expect(asked).toHaveLength(1);
    await act(async () => {
      finish();
      await answered;
    });
    await waitFor(() =>
      expect(h.container.querySelector("output")?.textContent).toBe("free"),
    );
  });
});
