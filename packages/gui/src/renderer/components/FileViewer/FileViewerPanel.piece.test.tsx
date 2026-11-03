import {
  act,
  configure,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

configure({ asyncUtilTimeout: 5000 });

import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import type { SessionStore } from "../../store/session-store.js";
import { renderWithSession } from "../../testing/renderWithSession.js";
import { FileViewerPanel } from "./FileViewerPanel.js";
import {
  FileViewerProvider,
  useFileViewerOpen,
} from "./file-viewer-context.js";
import { PIECE_REST_MS } from "./PieceQuote.js";

if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:jsdom";
  URL.revokeObjectURL = () => undefined;
}

let store: SessionStore | null = null;

function Probe(): JSX.Element {
  const open = useFileViewerOpen();
  store = useHertaBridge().sessionStore;
  return (
    <>
      <button
        type="button"
        data-testid="open-code"
        onClick={() => open?.("src/a.ts")}
      >
        code
      </button>
      <button
        type="button"
        data-testid="open-png"
        onClick={() => open?.("shots/one.png")}
      >
        png
      </button>
      <button
        type="button"
        data-testid="open-docx"
        onClick={() => open?.("docs/report.docx")}
      >
        docx
      </button>
    </>
  );
}

function ui(): JSX.Element {
  return (
    <FileViewerProvider>
      <Probe />
      <FileViewerPanel />
    </FileViewerProvider>
  );
}

async function openCode() {
  const mock = createMockHertaBridge();
  Object.assign(mock.bridge, {
    readWorkspaceFile: vi.fn(async () => ({
      ok: true as const,
      content: "const a = 1;\n\nconst b = 2;\n",
      truncated: false,
      size: 26,
      relative: "src/a.ts",
    })),
  });
  const h = renderWithSession(ui(), { mock });
  h.openSession("s1");
  fireEvent.click(screen.getByTestId("open-code"));
  await waitFor(() =>
    expect(
      screen.getByTestId("file-viewer").querySelector(".file-viewer__text")
        ?.textContent,
    ).toContain("const b"),
  );
  return h;
}

describe("FileViewerPanel — piece quoting (ADR 0078)", () => {
  beforeEach(() => window.localStorage.removeItem("herta.viewer.pieceQuote"));
  afterEach(() => vi.useRealTimers());

  it("the header switch is on by default, says what a click does, and is remembered", async () => {
    await openCode();
    const sw = screen.getByTestId("viewer-piece-switch");
    expect(sw.getAttribute("aria-pressed")).toBe("true");
    expect(sw.getAttribute("aria-label")).toBe("Turn off piece quoting");
    expect(
      sw.querySelector(".piece-quote-icon")?.classList.contains("is-off"),
    ).toBe(false);
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-pressed")).toBe("false");
    expect(sw.getAttribute("aria-label")).toBe("Turn on piece quoting");
    expect(
      sw.querySelector(".piece-quote-icon")?.classList.contains("is-off"),
    ).toBe(true);
    expect(window.localStorage.getItem("herta.viewer.pieceQuote")).toBe("0");
  });

  it("a picked piece lands in the composer's quotes, with the workspace path", async () => {
    await openCode();
    vi.useFakeTimers();
    const host = screen
      .getByTestId("file-viewer")
      .querySelector(".file-viewer__code-inner") as HTMLElement;
    fireEvent.pointerMove(host);
    act(() => vi.advanceTimersByTime(PIECE_REST_MS));
    const pieces = host.querySelectorAll(".piece-mask__piece");
    expect(pieces).toHaveLength(2);
    fireEvent.pointerDown(pieces[1] as Element);
    fireEvent.pointerUp(window);
    fireEvent.click(screen.getByText("Quote"));
    expect(store?.getSnapshot().composerQuotes).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        from: 3,
        to: 3,
        text: "const b = 2;",
        fence: "typescript",
      }),
    ]);
  });

  it("a Word document's section lands as a paragraph quote, titled by its heading (amendment 2026-10-29)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const docx = new Uint8Array(
      readFileSync(
        join(__dirname, "renderers", "__fixtures__", "fixture.docx"),
      ),
    );
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      // The viewer opens only on a bridge that reads files.
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "binary",
      })),
      readWorkspaceBytes: vi.fn(async () => ({
        ok: true as const,
        bytes: docx,
        size: docx.length,
        relative: "docs/report.docx",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("open-docx"));
    await waitFor(() =>
      expect(
        screen.getByTestId("file-viewer").querySelector("section.docx")
          ?.textContent,
      ).toContain("Plain, bold and italic."),
    );
    // The text is drawn before docx-preview's render settles; the mask (and
    // the heading styles it splits by) comes only once it has. The fake
    // clock below stops anything still pending, so wait for the mask first:
    // in a loaded suite the text alone was not enough (2026-11-03).
    const host = screen
      .getByTestId("file-viewer")
      .querySelector(
        ".file-viewer__docx .file-viewer__doc-host",
      ) as HTMLElement;
    await waitFor(() =>
      expect(host.querySelector(".piece-mask")).not.toBeNull(),
    );
    expect(screen.getByTestId("viewer-piece-switch")).toBeTruthy();
    vi.useFakeTimers();
    fireEvent.pointerMove(host);
    act(() => vi.advanceTimersByTime(PIECE_REST_MS));
    // One heading, so one section: the heading and everything after it.
    const pieces = host.querySelectorAll(".piece-mask__piece");
    expect(pieces).toHaveLength(1);
    fireEvent.pointerDown(pieces[0] as Element);
    fireEvent.pointerUp(window);
    fireEvent.click(screen.getByText("Quote"));
    const [quote] = store?.getSnapshot().composerQuotes ?? [];
    expect(quote).toMatchObject({
      path: "docs/report.docx",
      unit: "para",
      from: 1,
      to: 5,
      title: "Viewer fixture 文档",
    });
    expect(quote?.text).toContain("first bullet");
    expect(quote?.text).toContain("Name\tValue\nalpha\t1");
    expect(quote?.fence).toBeUndefined();
    // Two waits of up to `asyncUtilTimeout` each, over a real docx render:
    // the default 5 s would end the test before either wait could.
  }, 15_000);

  it("no switch where the page does not split (a picture)", async () => {
    const mock = createMockHertaBridge();
    Object.assign(mock.bridge, {
      readWorkspaceFileBytes: vi.fn(async () => ({
        ok: true as const,
        bytes: new Uint8Array([137, 80, 78, 71]),
        size: 4,
        relative: "shots/one.png",
      })),
      readWorkspaceFile: vi.fn(async () => ({
        ok: false as const,
        reason: "binary",
      })),
    });
    const h = renderWithSession(ui(), { mock });
    h.openSession("s1");
    fireEvent.click(screen.getByTestId("open-png"));
    await waitFor(() =>
      expect(screen.getByTestId("file-viewer")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("viewer-piece-switch")).toBeNull();
  });
});
