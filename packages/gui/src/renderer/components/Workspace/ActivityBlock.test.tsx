import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { renderWithSession } from "../../testing/renderWithSession.js";
import { FileViewerPanel } from "../FileViewer/FileViewerPanel.js";
import { FileViewerProvider } from "../FileViewer/file-viewer-context.js";
import { ActivityBlock, type ActivityBlockProps } from "./ActivityBlock.js";
import type { SystemBlock } from "./group-record.js";

const step = (body: string): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body,
});

/** Existing cases render under the default UI locale "en" and assert English
 *  labels; record labels now follow the SESSION lang (this change), so default
 *  lang="en" here. A per-case `lang` overrides it — the parity cases below
 *  pass "zh" to prove the labels track the session, not the UI locale. */
function A(
  props: Omit<ActivityBlockProps, "lang"> & { lang?: "zh" | "en" },
): JSX.Element {
  const { lang = "en", ...rest } = props;
  return <ActivityBlock lang={lang} {...rest} />;
}

describe("ActivityBlock — a group that stands on its own line", () => {
  // 板砖's runs have their own row since ADR 0085 (RunRow.test.tsx); what is
  // left here is the line every other group keeps: the chip, a click that
  // opens its quiet history, and nothing live.
  it("is never live: no pulsing LED, no shimmer, no duration", () => {
    const { container } = renderWithLocale(
      <A blocks={[step("Reading scripts"), step("Writing a.ts")]} />,
    );
    expect(
      container.querySelector(".activity-line__led.is-pulsing"),
    ).toBeNull();
    expect(container.querySelector(".swap-text")).toBeNull();
    expect(container.querySelector(".activity-line__duration")).toBeNull();
  });

  it("localizes op verbs from the digest under zh in its rows, keeping the canonical icon (bug 4)", () => {
    const opStep = (
      verb: "Reading" | "Writing" | "Running",
      arg: string,
    ): SystemBlock => ({
      kind: "system",
      label: "差分协处理器",
      body: `${verb} ${arg}`,
      digest: { kind: "op", verb, arg },
    });
    const { container } = renderWithLocale(
      <A lang="zh" blocks={[opStep("Writing", "scripts/a.py")]} />,
      { locale: "zh" },
    );
    // Display verb localized (D7: display-only — the canonical body keeps
    // the English verb; that is what Herta's prompt reads), with the icon
    // still keyed off the canonical English body.
    fireEvent.click(container.querySelector(".activity-line") as Element);
    expect(
      container.querySelector(".activity-line__history .activity-step__body")
        ?.textContent,
    ).toBe("写入 scripts/a.py");
    expect(
      container.querySelector('.activity-step [data-icon="write"]'),
    ).not.toBeNull();
  });

  it("the history's rows mount on the FIRST expand and stay mounted after a collapse (ADR 0068 §11)", () => {
    // A session carries many groups; before this, every historical group
    // built and mounted all of its rows — and folded every write's diff — at
    // session switch, for a panel nobody had opened. Measured in jsdom, 40
    // groups × 13 rows with four 300-line diffs each: mount 531 → 72 ms,
    // 5401 → 401 DOM nodes.
    const { container } = renderWithLocale(
      <A blocks={[step("Reading scripts"), step("Writing a.ts")]} />,
    );
    // Collapsed at mount: the panel exists (the reveal needs an element to
    // size), its rows do not.
    expect(container.querySelector(".activity-line__history")).not.toBeNull();
    expect(container.querySelectorAll(".activity-step")).toHaveLength(0);
    expect(screen.queryByText("Reading scripts")).toBeNull();
    // The first open mounts them, in the same commit as the toggle.
    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelectorAll(".activity-step")).toHaveLength(2);
    expect(screen.getByText("Reading scripts")).toBeInTheDocument();
    // Collapsing keeps them — the collapse animates the rows out rather than
    // dropping them, and a re-open has nothing to rebuild.
    fireEvent.click(screen.getByRole("button"));
    expect(
      container.querySelector(".activity-line__history.is-open"),
    ).toBeNull();
    expect(container.querySelectorAll(".activity-step")).toHaveLength(2);
  });

  it("the toggle is the CONTENT, not the whole row — dead space is not clickable", () => {
    // Owner 2026-07-27: `.activity-line` was `width: 100%`, so the wide gap
    // between the summary and the right edge belonged to the button — the
    // cursor turned into a pointer over empty space and clicking there
    // expanded the row, with no affordance anywhere near the click.
    const { container } = renderWithLocale(
      <A blocks={[step("Reading scripts")]} />,
    );
    const row = container.querySelector(".activity-line-row");
    const button = screen.getByRole("button");
    expect(row).not.toBeNull();
    // The button is a CHILD of the full-width row, not the row itself.
    expect(button.classList.contains("activity-line-row")).toBe(false);
    expect(row?.contains(button)).toBe(true);
    // Everything the user can see as "the toggle" is inside it.
    expect(button.querySelector(".activity-line__led")).not.toBeNull();
    expect(button.querySelector("svg.activity-line__chevron")).not.toBeNull();
  });

  it("record labels follow the SESSION lang, not the UI locale (parity with @Brick)", () => {
    // UI locale is EN (renderWithLocale default) but the session is zh: the
    // chip renders in Chinese, proving the line tracks the session
    // interaction language, not the app chrome.
    renderWithLocale(<A lang="zh" blocks={[step("Reading a.ts")]} />);
    expect(screen.getByText("差分协处理器")).toBeInTheDocument();
    expect(screen.queryByText("Coprocessor")).toBeNull();
  });
});

describe("ActivityBlock — attachment groups (ADR 0033, owner 2026-08-10)", () => {
  const attach = (name: string, over: { at?: string } = {}): SystemBlock => ({
    kind: "system",
    label: "系统",
    body: `附件 ${name} · 87 行 · 1.3K 字 · .herta/attachments/s/${name}`,
    digest: {
      kind: "attachment",
      name,
      path: `.herta/attachments/s/${name}`,
      lines: 87,
      chars: 1300,
    },
    ...over,
  });

  it("defaults OPEN — the filenames are the point of the row", () => {
    const { container } = renderWithLocale(
      <A blocks={[attach("spec.md"), attach("notes.txt")]} />,
    );
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "true",
    );
    const history = container.querySelector(".activity-line__history.is-open");
    expect(history).not.toBeNull();
    expect(history?.textContent).toContain("spec.md");
    expect(history?.textContent).toContain("notes.txt");
    // …with the composer's paperclip glyph, not the generic dot.
    expect(history?.querySelector('[data-icon="attach"]')).not.toBeNull();
  });

  it("the user can still collapse it", () => {
    const { container } = renderWithLocale(<A blocks={[attach("spec.md")]} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(
      container.querySelector(".activity-line__history.is-open"),
    ).toBeNull();
  });

  it("a mixed group counts as backend activity and stays collapsed", () => {
    renderWithLocale(<A blocks={[attach("spec.md"), step("Reading a.ts")]} />);
    expect(screen.getByRole("button").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("shortens a long filename from the MIDDLE, keeping the extension", () => {
    // Owner 2026-08-10: a long name wrapped the row onto three lines. The
    // extension is the most informative part, so the cut is in the middle.
    const long =
      "jiuwen-vs-aisf-sysagent-multi-intent-summary-20260806-超级无敌长的文件-这个文件就很长长长长长.txt";
    renderWithLocale(
      <A
        blocks={[
          {
            ...attach("x"),
            digest: {
              kind: "attachment",
              name: long,
              path: ".herta/attachments/s/x.txt",
              lines: 3,
              chars: 128,
            },
          },
        ]}
      />,
    );
    const row = screen.getByText(/jiuwen-vs-aisf/);
    expect(row.textContent).toContain("…");
    expect(row.textContent).toContain(".txt");
    expect(row.textContent).not.toContain(long);
    // The record itself is untouched — only the row is shortened.
    expect(long.length).toBeGreaterThan(60);
  });

  it("offers a take-back only where it can work, and passes the stored path", () => {
    const removed: string[] = [];
    const { container } = renderWithLocale(
      <A
        blocks={[
          attach("spec.md"),
          // Already withdrawn — no second ✕.
          {
            ...attach("old.md"),
            digest: {
              kind: "attachment",
              name: "old.md",
              path: ".herta/attachments/s/old.md",
              lines: 0,
              chars: 0,
              unreadable: "removed",
            },
          },
          // Nothing on disk to delete — no ✕ either.
          {
            ...attach("id_rsa"),
            digest: {
              kind: "attachment",
              name: "id_rsa",
              path: "",
              lines: 0,
              chars: 0,
              unreadable: "denied",
            },
          },
        ]}
        onRemoveAttachment={(p) => () => removed.push(p)}
      />,
    );
    const buttons = container.querySelectorAll(".activity-step__remove");
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as Element);
    expect(removed).toEqual([".herta/attachments/s/spec.md"]);
  });

  it("a document's row opens the ORIGINAL in the viewer and takes it back by whichever path it has (ADR 0038 amendment / ADR 0054)", async () => {
    const removed: string[] = [];
    const mock = createMockHertaBridge();
    const readWorkspaceFile = vi.fn(async () => ({
      ok: true as const,
      content: "",
      truncated: false,
      size: 0,
      relative: "x",
    }));
    const readWorkspaceBytes = vi.fn(async (_s: string, p: string) => ({
      ok: true as const,
      bytes: new Uint8Array([1]),
      size: 1,
      relative: p,
    }));
    Object.assign(mock.bridge, { readWorkspaceFile, readWorkspaceBytes });
    const h = renderWithSession(
      <FileViewerProvider>
        <A
          blocks={[
            // A PDF with its text extracted: the row names the PDF, the
            // viewer draws the PDF, the take-back addresses the TEXT path.
            {
              ...attach("report.pdf"),
              digest: {
                kind: "attachment",
                name: "report.pdf",
                path: ".herta/attachments/s/report-ab12cd34.pdf.txt",
                source: ".herta/attachments/s/report-ab12cd34.pdf",
                lines: 40,
                chars: 900,
                format: "pdf",
                pages: 2,
              },
            },
            // A spreadsheet: no text for 板砖, the file itself for the
            // viewer, the take-back addresses the SOURCE path.
            {
              ...attach("sheet.xlsx"),
              digest: {
                kind: "attachment",
                name: "sheet.xlsx",
                path: "",
                source: ".herta/attachments/s/sheet-ab12cd34.xlsx",
                lines: 0,
                chars: 0,
                unreadable: "unsupported",
              },
            },
          ]}
          onRemoveAttachment={(p) => () => removed.push(p)}
        />
        <FileViewerPanel />
      </FileViewerProvider>,
      { mock },
    );
    h.openSession("s1");
    const names = h.container.querySelectorAll(".file-open-name");
    expect([...names].map((n) => n.textContent)).toEqual([
      "report.pdf",
      "sheet.xlsx",
    ]);
    fireEvent.click(names[1] as Element);
    await waitFor(() =>
      expect(readWorkspaceBytes).toHaveBeenCalledWith(
        "s1",
        ".herta/attachments/s/sheet-ab12cd34.xlsx",
      ),
    );
    fireEvent.click(names[0] as Element);
    await waitFor(() =>
      expect(readWorkspaceBytes).toHaveBeenCalledWith(
        "s1",
        ".herta/attachments/s/report-ab12cd34.pdf",
      ),
    );
    expect(readWorkspaceFile).not.toHaveBeenCalled();
    const xs = h.container.querySelectorAll(".activity-step__remove");
    expect(xs).toHaveLength(2);
    fireEvent.click(xs[0] as Element);
    fireEvent.click(xs[1] as Element);
    expect(removed).toEqual([
      ".herta/attachments/s/report-ab12cd34.pdf.txt",
      ".herta/attachments/s/sheet-ab12cd34.xlsx",
    ]);
  });

  it("shows no take-back at all when the factory is absent (mid-turn)", () => {
    // Conversation withholds the factory while a turn runs — the removal
    // rides the same out-of-turn record write as the attach, so an ✕ that
    // could only earn a refusal is not rendered.
    const { container } = renderWithLocale(<A blocks={[attach("spec.md")]} />);
    expect(container.querySelector(".activity-step__remove")).toBeNull();
  });

  it("a removed attachment renders its state instead of counts", () => {
    renderWithLocale(
      <A
        blocks={[
          {
            ...attach("spec.md"),
            body: "附件 spec.md · 已移除",
            digest: {
              kind: "attachment",
              name: "spec.md",
              path: ".herta/attachments/s/spec.md",
              lines: 0,
              chars: 0,
              unreadable: "removed",
            },
          },
        ]}
      />,
    );
    expect(
      screen.getByText(/attachment spec\.md · removed/i),
    ).toBeInTheDocument();
  });

  it("a LIVE attach mounts with the entrance; a loaded one does not", () => {
    // Recency-gated off the block's own `at` stamp, decided once at mount —
    // no store flag, no cross-component state (the 2026-07-24 audit class).
    const live = renderWithLocale(
      <A blocks={[attach("spec.md", { at: new Date().toISOString() })]} />,
    );
    expect(live.container.querySelector(".is-attach-enter")).not.toBeNull();
    live.unmount();

    const loaded = renderWithLocale(
      <A
        blocks={[
          attach("spec.md", {
            at: new Date(Date.now() - 60_000).toISOString(),
          }),
        ]}
      />,
    );
    expect(loaded.container.querySelector(".is-attach-enter")).toBeNull();
    loaded.unmount();

    // No timestamp at all (pre-stamp records): never animate.
    const unstamped = renderWithLocale(<A blocks={[attach("spec.md")]} />);
    expect(unstamped.container.querySelector(".is-attach-enter")).toBeNull();
  });

  it("a recent backend group never borrows the attach entrance", () => {
    const { container } = renderWithLocale(
      <A
        blocks={[
          {
            ...step("Reading a.ts"),
            at: new Date().toISOString(),
          },
        ]}
      />,
    );
    expect(container.querySelector(".is-attach-enter")).toBeNull();
  });
});
