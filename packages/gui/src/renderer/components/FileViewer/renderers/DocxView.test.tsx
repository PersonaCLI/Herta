import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, waitFor } from "@testing-library/react";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { LocaleProvider } from "../../../i18n/LocaleProvider.js";
import type { ViewerAnchor } from "../file-viewer-context.js";
import { DocxView } from "./DocxView.js";

/** A Word quote's label reopens the document at its paragraph (ADR 0078
 *  amendment 2026-10-29). */

const FIXTURE = readFileSync(join(__dirname, "__fixtures__", "fixture.docx"));

/** A wait over one real docx render: FileViewerPanel.piece.test.tsx's. */
const RENDER_WAIT = { timeout: 5_000 };

function view(
  bytes: Uint8Array,
  anchor: ViewerAnchor | undefined,
): JSX.Element {
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
    // A real docx-preview render stands between each read and its scroll:
    // past the default 1 s wait in a loaded suite (2026-11-03).
    await waitFor(() => expect(scrolled).toHaveLength(1), RENDER_WAIT);
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
    }, RENDER_WAIT);
    // The same read and anchor rendered again: the reader stays put.
    const count = scrolled.length;
    ui.rerender(view(reread, again));
    await new Promise((r) => setTimeout(r, 200));
    expect(scrolled).toHaveLength(count);
    // Two waits of up to RENDER_WAIT each: more than the default 5 s.
  }, 15_000);
});

/** A Word package can embed a whole HTML document (an `altChunk` part).
 *  docx-preview draws one as an `<iframe srcdoc>` unless told not to, and
 *  a script that frame names by a `file:` URL runs there, with `parent` the
 *  app's own window (ADR 0054 amendment 2026-11-10). */
describe("DocxView — an embedded HTML part", () => {
  function withEmbeddedHtml(): Uint8Array {
    const parts = unzipSync(new Uint8Array(FIXTURE));
    const rels = parts["word/_rels/document.xml.rels"];
    const doc = parts["word/document.xml"];
    if (rels === undefined || doc === undefined)
      throw new Error("the fixture has no document part");
    parts["word/embedded.html"] = strToU8(
      "<html><body><script>parent.reached = true</script>embedded</body></html>",
    );
    parts["word/_rels/document.xml.rels"] = strToU8(
      strFromU8(rels).replace(
        "</Relationships>",
        '<Relationship Id="rIdAlt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="embedded.html"/></Relationships>',
      ),
    );
    const body = strFromU8(doc);
    expect(body).toContain("<w:sectPr>");
    parts["word/document.xml"] = strToU8(
      body.replace("<w:sectPr>", '<w:altChunk r:id="rIdAlt"/><w:sectPr>'),
    );
    return zipSync(parts);
  }

  it("is not drawn: the page has no frame", async () => {
    const ui = render(view(withEmbeddedHtml(), undefined));
    await waitFor(
      () =>
        expect(ui.container.textContent).toContain("Plain, bold and italic."),
      RENDER_WAIT,
    );
    expect(ui.container.querySelector("iframe")).toBeNull();
  }, 10_000);
});
