import type { AgentEvent } from "@herta/app-server";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  HertaBridgeProvider,
  useHertaBridge,
} from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import type { ComposerQuote } from "../../lib/quote-format.js";
import type { SessionStore } from "../../store/session-store.js";
import { Composer } from "./Composer.js";
import { WorkspaceRefsProvider } from "./WorkspaceRefs.js";

afterEach(() => cleanup());

function StoreProbe(props: { onStore: (s: SessionStore) => void }) {
  props.onStore(useHertaBridge().sessionStore);
  return null;
}

function renderComposer() {
  const mock = createMockHertaBridge();
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
  return {
    mock,
    store: (): SessionStore => {
      if (store === null) throw new Error("store probe never rendered");
      return store;
    },
  };
}

const DIV: ComposerQuote = {
  id: "q1",
  path: "src/calc.js",
  from: 9,
  to: 14,
  text: "export function div(a, b) {\n  return a / b;\n}",
  fence: "js",
};

describe("Composer — quotes from the viewer's page (ADR 0078 §6)", () => {
  it("a staged quote shows as a chip; × takes it back", () => {
    const { store } = renderComposer();
    act(() => store().addComposerQuote(DIV));
    expect(screen.getByText("src/calc.js:9–14")).toBeInTheDocument();
    expect(screen.getByText("export function div(a, b) {")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove this quote src/calc.js:9–14",
      }),
    );
    expect(screen.queryByText("src/calc.js:9–14")).toBeNull();
    expect(store().getSnapshot().composerQuotes).toEqual([]);
  });

  it("quotes alone are a message: the source goes first, and the chips clear", () => {
    const { mock, store } = renderComposer();
    act(() => store().addComposerQuote(DIV));
    const input = screen.getByPlaceholderText(
      "Ask about this…",
    ) as HTMLTextAreaElement;
    const send = input
      .closest("form")
      ?.querySelector("button[type='submit']") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    const sent = mock.calls.submitText[0] ?? "";
    expect(sent).toContain("src/calc.js:9–14");
    expect(sent).toContain("```js\nexport function div(a, b) {");
    expect(store().getSnapshot().composerQuotes).toEqual([]);
  });

  it("typed words follow the quotes", () => {
    const { mock, store } = renderComposer();
    act(() => store().addComposerQuote(DIV));
    const input = screen.getByPlaceholderText(
      "Ask about this…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "为什么不判零？" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    const sent = mock.calls.submitText[0] ?? "";
    expect(sent.endsWith("```\n\n为什么不判零？")).toBe(true);
  });
});

describe("Composer — a held message keeps its quotes (ADR 0078 amendment 2026-10-21)", () => {
  const backendStarted: AgentEvent = {
    type: "turn.started",
    layer: "backend",
    userText: "task",
  };
  function startCommission(
    mock: ReturnType<typeof createMockHertaBridge>,
  ): void {
    act(() => {
      mock.emitReset({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
      mock.emitTurn({ kind: "started", turnId: "t1" });
      mock.emitAgent({ kind: "agent", event: backendStarted });
    });
  }

  it("held while 板砖 works, the quotes go with the words — the card names them — and leave the composer", () => {
    const { mock, store } = renderComposer();
    startCommission(mock);
    act(() => store().addComposerQuote(DIV));
    const input = screen.getByPlaceholderText(
      "Ask about this…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "为什么不判零？" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const card = screen.getByTestId("composer-held");
    expect(card.textContent).toContain("〔src/calc.js:9–14〕 为什么不判零？");
    expect(card.textContent).not.toContain("```");
    expect(store().getSnapshot().composerQuotes).toEqual([]);
    // The turn ends: the hold goes as the next message, quotes first.
    act(() => mock.emitTurn({ kind: "finished", turnId: "t1" }));
    const sent = mock.calls.submitText[0] ?? "";
    expect(sent).toContain("```js\nexport function div(a, b) {");
    expect(sent.endsWith("为什么不判零？")).toBe(true);
  });

  it("Edit puts the words back in the field and the quotes back as chips", () => {
    const { mock, store } = renderComposer();
    startCommission(mock);
    act(() => store().addComposerQuote(DIV));
    const input = screen.getByPlaceholderText(
      "Ask about this…",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "为什么不判零？" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(input.value).toBe("为什么不判零？");
    const back = store().getSnapshot().composerQuotes;
    expect(back.map((q) => [q.path, q.from, q.to, q.fence])).toEqual([
      ["src/calc.js", 9, 14, "js"],
    ]);
    expect(back[0]?.text).toBe(DIV.text);
  });
});
