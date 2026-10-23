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
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  return {
    mock,
    input,
    store: (): SessionStore => {
      if (store === null) throw new Error("store probe never rendered");
      return store;
    },
  };
}

const PICKED = {
  element: 'button "Sign in"',
  route: "localhost:5173/login",
  html: '<button class="cta">Sign in</button>',
};
const LINE =
  'localhost:5173/login · button "Sign in" · <button class="cta">Sign in</button>';

describe("Composer — an element picked on the page (ADR 0083 §4)", () => {
  it("lands as a chip at the caret, in Herta's words, and goes as its line recorded as a pick", () => {
    const { mock, input, store } = renderComposer();
    fireEvent.change(input, {
      target: { value: "this does nothing", selectionStart: 4 },
    });
    input.setSelectionRange(4, 4);
    act(() => store().addComposerPick(PICKED));
    expect(input.value).toBe("this @按钮「Sign in」 does nothing");
    expect(store().getSnapshot().composerPicks).toEqual([]);
    const chip = document.querySelector(".composer-chip");
    expect(chip?.textContent).toBe("@按钮「Sign in」");
    expect(chip?.querySelector(".pick-icon")).not.toBeNull();

    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(mock.calls.submitText).toEqual([`this ${LINE} does nothing`]);
    expect(mock.calls.submitTextPicks).toEqual([
      [{ element: PICKED.element, route: PICKED.route, line: LINE }],
    ]);
    // The echo draws it as the record's block will.
    expect(store().getSnapshot().pendingUserPicks).toEqual([
      { element: PICKED.element, route: PICKED.route, line: LINE },
    ]);
  });

  it("a picked element's menu is Remove alone", () => {
    const { input, store } = renderComposer();
    act(() => store().addComposerPick(PICKED));
    const chip = document.querySelector(".composer-chip") as HTMLElement;
    chip.getClientRects = () =>
      [{ left: 40, right: 120, top: 10, bottom: 30 }] as unknown as DOMRectList;
    chip.getBoundingClientRect = () =>
      ({ left: 40, right: 120, top: 10, bottom: 30 }) as DOMRect;
    fireEvent.mouseDown(input, { button: 0, clientX: 60, clientY: 20 });
    expect(
      [...document.querySelectorAll(".composer-chip-menu__item")].map(
        (b) => b.textContent,
      ),
    ).toEqual(["Remove"]);
  });

  it("a message without a pick sends none", () => {
    const { mock, input } = renderComposer();
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(mock.calls.submitTextPicks).toEqual([undefined]);
  });
});
