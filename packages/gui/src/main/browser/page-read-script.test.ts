import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { READ_SCRIPT } from "./page-read-script.js";

/** The harness's own read script, run in a DOM as the debugger's isolated
 *  world runs it. jsdom lays nothing out, so every element gets a box and
 *  the calls it does not implement are stubbed. */

interface Herta {
  snapshot(
    all: boolean,
    rootRef: string | null,
    budget: number,
    from: number,
  ): { lines: string; last: number } | { missing: true };
  find(
    query: string,
    max: number,
    budget: number,
    from: number,
  ): { lines: string; last: number };
  locate(ref: string): { missing: true } | { target: string };
  focusedPassword(): boolean;
}

const herta = (): Herta =>
  (globalThis as unknown as { __herta: Herta }).__herta;
const box = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  delete (globalThis as { __herta?: unknown }).__herta;
  Element.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 10,
      bottom: 10,
      width: 10,
      height: 10,
    }) as DOMRect;
  Element.prototype.scrollIntoView = () => undefined;
  document.elementFromPoint = () => null;
  // jsdom has no innerText; the script names an element by it.
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent;
    },
  });
  // Run as the debugger runs it: the whole script, at the top level.
  new Function(READ_SCRIPT)();
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = box;
  document.body.innerHTML = "";
});

describe("the read script's refs count on across reads (review 2026-10-30, M1)", () => {
  it("a newer read hands out new refs, and an older one names nothing", () => {
    document.body.innerHTML = "<button>Sign in</button>";
    expect(herta().snapshot(false, null, 1000, 0)).toMatchObject({
      lines: 'e1 button "Sign in"',
      last: 1,
    });
    document.body.innerHTML = "<button>Docs</button>";
    expect(herta().snapshot(false, null, 1000, 1)).toMatchObject({
      lines: 'e2 button "Docs"',
      last: 2,
    });
    expect(herta().locate("e1")).toEqual({ missing: true });
    expect(herta().locate("e2")).toMatchObject({ target: 'button "Docs"' });
    expect(herta().find("docs", 20, 1000, 2)).toMatchObject({
      lines: 'e3 button "Docs"',
      last: 3,
    });
  });
});

describe("where typed text lands (review 2026-10-30, M6)", () => {
  it("says a focused password field is one, and a plain field is not", () => {
    document.body.innerHTML =
      '<input id="p" type="password"><input id="t" type="text">';
    (document.getElementById("p") as HTMLInputElement).focus();
    expect(herta().focusedPassword()).toBe(true);
    (document.getElementById("t") as HTMLInputElement).focus();
    expect(herta().focusedPassword()).toBe(false);
  });
});
