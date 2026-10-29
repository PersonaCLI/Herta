import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LocaleProvider } from "../../../i18n/LocaleProvider.js";
import type { ViewerAnchor } from "../file-viewer-context.js";
import { DocxView } from "./DocxView.js";

/** A Word quote's label reopens the document at its paragraph (ADR 0078
 *  amendment 2026-10-29). */

const FIXTURE = readFileSync(join(__dirname, "__fixtures__", "fixture.docx"));

function view(bytes: Uint8Array, anchor: ViewerAnchor): JSX.Element {
  return (
    <LocaleProvider locale="en" onLocaleChange={() => {}}>
      <DocxView bytes={bytes} anchor={anchor} />
    </LocaleProvider>
  );
}

describe("DocxView — a quote's anchor", () => {
  const scrolled: Element[] = [];
  const real = Element.prototype.scrollIntoView;
  afterEach(() => {
    Element.prototype.scrollIntoView = real;
    scrolled.length = 0;
  });

  it("lands on the page the label's read draws, and a render with nothing new keeps the reader's place", async () => {
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const first = new Uint8Array(FIXTURE);
    const anchor: ViewerAnchor = { from: 2, to: 3, unit: "para" };
    const ui = render(view(first, anchor));
    await waitFor(() => expect(scrolled).toHaveLength(1));
    // The label clicked again. The panel takes the new target at once and
    // reads the file anew: the anchor arrives while the old page is up, the
    // bytes after it, and docx-preview draws the page anew. Scrolled once
    // per anchor, the scroll stayed with the old page and the document
    // opened at the top (seen in the dev app, 2026-10-29).
    const again: ViewerAnchor = { ...anchor };
    ui.rerender(view(first, again));
    const reread = new Uint8Array(FIXTURE);
    ui.rerender(view(reread, again));
    await waitFor(() => {
      const last = scrolled[scrolled.length - 1];
      expect(last?.isConnected).toBe(true);
      expect(last?.textContent).toBe("Plain, bold and italic.");
    });
    // The same read and anchor rendered again: the reader stays put.
    const count = scrolled.length;
    ui.rerender(view(reread, again));
    await new Promise((r) => setTimeout(r, 200));
    expect(scrolled).toHaveLength(count);
  });
});
