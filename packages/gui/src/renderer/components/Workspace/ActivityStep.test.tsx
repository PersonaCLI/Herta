import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LocaleProvider, makeT } from "../../i18n/LocaleProvider.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { ActivityStep } from "./ActivityStep.js";
import { ConversationPinProvider } from "./ConversationPin.js";

const tEn = makeT("en");

describe("ActivityStep", () => {
  it("renders the body text and a verb icon", () => {
    const { container } = renderWithLocale(
      <ActivityStep body="Reading scripts" t={tEn} active={false} />,
    );
    expect(screen.getByText("Reading scripts")).toBeInTheDocument();
    expect(container.querySelector('svg[data-icon="read"]')).not.toBeNull();
  });

  it("a screenshot row shows its picture at the row's end, and opens it (ADR 0083 §11)", () => {
    const onOpen = vi.fn();
    const { container } = renderWithLocale(
      <ActivityStep
        body="↳ localhost:5173/login · 375×812"
        t={tEn}
        icon="result"
        active={false}
        thumb={{
          src: "herta-attachment://file/.herta/browser/s/shot-1.png",
          onOpen,
          ariaLabel: "Enlarge the screenshot of localhost:5173/login",
        }}
      />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "herta-attachment://file/.herta/browser/s/shot-1.png",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Enlarge the screenshot of localhost:5173/login",
      }),
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("adds is-active only when active", () => {
    const { container, rerender } = renderWithLocale(
      <ActivityStep body="Writing a.ts" t={tEn} active={false} />,
    );
    expect(container.querySelector(".activity-step.is-active")).toBeNull();
    rerender(
      <LocaleProvider locale="en" onLocaleChange={() => {}}>
        <ActivityStep body="Writing a.ts" t={tEn} active={true} />
      </LocaleProvider>,
    );
    expect(container.querySelector(".activity-step.is-active")).not.toBeNull();
  });

  it("strips the literal ↳ on a continuation row (the result icon conveys it; no doubled arrow)", () => {
    const { container } = renderWithLocale(
      <ActivityStep
        body="↳ write_new_file failed: file_exists: scripts/sort.py already exists"
        t={tEn}
        active={false}
      />,
    );
    // The result arrow icon stands in for the continuation marker.
    expect(container.querySelector('svg[data-icon="result"]')).not.toBeNull();
    expect(
      container.querySelector(".activity-step.is-continuation"),
    ).not.toBeNull();
    // The rendered text no longer carries the literal ↳ (no "↳ ↳").
    const body = container.querySelector(".activity-step__body");
    expect(body?.textContent).toBe(
      "write_new_file failed: file_exists: scripts/sort.py already exists",
    );
    expect(body?.textContent?.includes("↳")).toBe(false);
  });

  it("leaves a non-continuation body untouched", () => {
    const { container } = renderWithLocale(
      <ActivityStep body="Reading scripts/sort.py" t={tEn} active={false} />,
    );
    expect(container.querySelector(".activity-step__body")?.textContent).toBe(
      "Reading scripts/sort.py",
    );
  });

  it("the file NAME — not the row — becomes the viewer's click target (ADR 0050)", () => {
    const onOpen = vi.fn();
    const { container } = renderWithLocale(
      <ActivityStep
        body="Writing src/a.ts"
        t={tEn}
        active={false}
        file={{ path: "src/a.ts", onOpen, ariaLabel: "View file src/a.ts" }}
      />,
    );
    const name = container.querySelector(".file-open-name");
    expect(name?.textContent).toBe("src/a.ts");
    // The verb stays outside the control.
    expect(container.querySelector(".activity-step__body")?.textContent).toBe(
      "Writing src/a.ts",
    );
    fireEvent.click(name as Element);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("an attachment row splits on the display NAME and opens the stored path", () => {
    const onOpen = vi.fn();
    const { container } = renderWithLocale(
      <ActivityStep
        body="文本文件 notes.txt · 12 行"
        t={tEn}
        active={false}
        file={{
          path: ".herta/attachments/ab12-notes.txt",
          name: "notes.txt",
          onOpen,
          ariaLabel: "View file notes.txt",
        }}
      />,
    );
    const name = container.querySelector(".file-open-name");
    expect(name?.textContent).toBe("notes.txt");
    fireEvent.click(name as Element);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("a finding row's cites each become their own target (ADR 0050 v1.5)", () => {
    const openA = vi.fn();
    const openB = vi.fn();
    const { container } = renderWithLocale(
      <ActivityStep
        body="↳ 结论: the bug lives here — src/x.ts:12-30, src/y.ts:5"
        t={tEn}
        active={false}
        links={[
          { text: "src/x.ts:12-30", onOpen: openA, ariaLabel: "View src/x.ts" },
          { text: "src/y.ts:5", onOpen: openB, ariaLabel: "View src/y.ts" },
        ]}
      />,
    );
    const spans = container.querySelectorAll(".file-open-name");
    expect(spans.length).toBe(2);
    fireEvent.click(spans[1] as Element);
    expect(openB).toHaveBeenCalledTimes(1);
    expect(openA).not.toHaveBeenCalled();
  });

  it("detailLinks make the 改动文件 paths in the detail pane clickable", () => {
    const onOpen = vi.fn();
    const { container } = renderWithLocale(
      <ConversationPinProvider unpin={() => {}}>
        <ActivityStep
          body="detail"
          t={tEn}
          active={false}
          detail={"↳ 改动文件: src/a.ts, src/b.ts"}
          detailLinks={[
            { text: "src/a.ts", onOpen, ariaLabel: "View src/a.ts" },
            { text: "src/b.ts", onOpen: vi.fn(), ariaLabel: "View src/b.ts" },
          ]}
        />
      </ConversationPinProvider>,
    );
    fireEvent.click(
      container.querySelector(".activity-step__detail-toggle") as Element,
    );
    const spans = container.querySelectorAll(
      ".activity-step__detail .file-open-name",
    );
    expect(spans.length).toBe(2);
    fireEvent.click(spans[0] as Element);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("a body that no longer carries the path degrades to plain text", () => {
    const { container } = renderWithLocale(
      <ActivityStep
        body="Writing something else entirely"
        t={tEn}
        active={false}
        file={{ path: "src/a.ts", onOpen: vi.fn(), ariaLabel: "View file" }}
      />,
    );
    expect(container.querySelector(".file-open-name")).toBeNull();
  });

  it("inside a patch row, clicking the name opens the viewer WITHOUT toggling the fold", () => {
    const onOpen = vi.fn();
    const { container } = renderWithLocale(
      <ConversationPinProvider unpin={() => {}}>
        <ActivityStep
          body="已编辑 src/a.ts"
          t={tEn}
          active={false}
          patch={{ stat: { add: 2, del: 0 }, diff: "-a\n+b" }}
          file={{ path: "src/a.ts", onOpen, ariaLabel: "View file src/a.ts" }}
        />
      </ConversationPinProvider>,
    );
    const head = container.querySelector(".activity-step__fold-head");
    expect(head?.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(container.querySelector(".file-open-name") as Element);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // stopPropagation held: the fold did not open on the name click.
    expect(head?.getAttribute("aria-expanded")).toBe("false");
  });

  it("marks failure rows with is-failure and the ✗ icon (2026-07-23)", () => {
    const { container } = renderWithLocale(
      <ActivityStep
        body="↳ read_file failed: tool_crashed: boom"
        t={tEn}
        icon="fail"
        active={false}
        failed
      />,
    );
    expect(container.querySelector(".activity-step.is-failure")).not.toBeNull();
    expect(container.querySelector('svg[data-icon="fail"]')).not.toBeNull();
    // fail is a continuation icon — the literal arrow is stripped.
    expect(
      container
        .querySelector(".activity-step__body")
        ?.textContent?.includes("↳"),
    ).toBe(false);
  });

  it("renders evidenceDetail behind a collapsed toggle (2026-07-23)", () => {
    const { container } = renderWithLocale(
      <ActivityStep
        body="↳ exit 0 · 3 lines"
        t={tEn}
        active={false}
        detail={"↳ 输出:\nhello world"}
      />,
    );
    // Collapsed by default: toggle present, detail absent.
    const toggle = container.querySelector(".activity-step__detail-toggle");
    expect(toggle).not.toBeNull();
    expect(container.querySelector(".activity-step__detail")).toBeNull();
    fireEvent.click(toggle as HTMLButtonElement);
    expect(
      container.querySelector(".activity-step__detail")?.textContent,
    ).toContain("hello world");
  });

  it("the detail pane rides the same animated fold as the patch (2026-08-26)", () => {
    // It used to mount/unmount bare — popping open and vanishing next to a
    // diff that eased through .activity-step__fold. Same wrapper now: open
    // marks the fold, close keeps the pane mounted so the collapse can
    // animate out.
    const { container } = renderWithLocale(
      <ActivityStep
        body="↳ exit 0 · 3 lines"
        t={tEn}
        active={false}
        detail={"↳ 输出:\nhello world"}
      />,
    );
    const toggle = container.querySelector(
      ".activity-step__detail-toggle",
    ) as HTMLButtonElement;
    fireEvent.click(toggle); // open
    const fold = container.querySelector(".activity-step__fold.is-open");
    expect(fold).not.toBeNull();
    expect(fold?.querySelector(".activity-step__detail")).not.toBeNull();
    fireEvent.click(toggle); // close
    expect(container.querySelector(".activity-step__fold.is-open")).toBeNull();
    expect(container.querySelector(".activity-step__detail")).not.toBeNull();
  });

  it("shows no detail toggle without evidenceDetail", () => {
    const { container } = renderWithLocale(
      <ActivityStep body="Reading a.ts" t={tEn} active={false} />,
    );
    expect(container.querySelector(".activity-step__detail-toggle")).toBeNull();
  });

  it("unpins the conversation when OPENING the detail pane, not when closing", () => {
    // Opening grows the flow below the toggle. The scroller's ResizeObserver
    // watches the scroller's own box, so it never fires for content growth,
    // and the focus-scroll that follows the click reaches the scroll handler
    // as a plain "reader left the bottom" — lighting the jump chip and
    // disarming the next send's flight (owner 2026-08-10). The activity
    // history's chevron has always declared its disclosure; this toggle did
    // not. Closing must NOT unpin: nothing grows, and a reader sitting at the
    // bottom should stay followed.
    const unpin = vi.fn();
    const { container } = renderWithLocale(
      <ConversationPinProvider unpin={unpin}>
        <ActivityStep
          body="Reading a.ts"
          t={tEn}
          active={false}
          detail="↳ output:\nline"
        />
      </ConversationPinProvider>,
    );
    const toggle = container.querySelector(
      ".activity-step__detail-toggle",
    ) as HTMLElement;
    fireEvent.click(toggle); // open
    expect(unpin).toHaveBeenCalledTimes(1);
    fireEvent.click(toggle); // close
    expect(unpin).toHaveBeenCalledTimes(1);
  });
});

/**
 * The folded write row (owner, 2026-08-25 evening): "the working history
 * rendering order is weird, the content shows above the corresponding
 * actions". `patch.preview` is published by the permission RULE, before the
 * tool runs — so the record holds diff-then-write. `activityRows` pairs them
 * and this row renders the pair: the action and its magnitude, the diff a
 * click below.
 */
describe("ActivityStep — folded patch", () => {
  const patch = { stat: { add: 11, del: 1 }, diff: " keep\n-old\n+new" };

  it("states the action first and hides the diff until asked", () => {
    const { container } = renderWithLocale(
      <ActivityStep
        body="写入 package.json"
        t={tEn}
        active={false}
        patch={patch}
      />,
    );
    const head = container.querySelector(
      ".activity-step__fold-head",
    ) as HTMLElement;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    // The action is the first thing in the row, before any diff content.
    expect(head.textContent?.startsWith("写入 package.json")).toBe(true);
    expect(container.querySelector(".diff-body")).toBeNull();

    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".diff-body")?.textContent).toContain("new");
  });

  it("keeps the diff mounted after a close, so collapsing can animate", () => {
    const { container } = renderWithLocale(
      <ActivityStep body="写入 a.ts" t={tEn} active={false} patch={patch} />,
    );
    const head = container.querySelector(
      ".activity-step__fold-head",
    ) as HTMLElement;
    fireEvent.click(head);
    fireEvent.click(head);
    expect(container.querySelector(".diff-body")).not.toBeNull();
    expect(container.querySelector(".activity-step__fold.is-open")).toBeNull();
  });

  it("carries the magnitude on the action row itself", async () => {
    const { container } = renderWithLocale(
      <ActivityStep body="写入 a.ts" t={tEn} active={false} patch={patch} />,
    );
    await waitFor(() => {
      expect(container.querySelector(".diff-stat")?.textContent).toBe("+11−1");
    });
  });

  it("shows no magnitude, and no sentence about its absence, when unmeasured", () => {
    const { container } = renderWithLocale(
      <ActivityStep
        body="写入 a.ts"
        t={tEn}
        active={false}
        patch={{ stat: "unmeasured", diff: "" }}
      />,
    );
    expect(container.querySelector(".diff-stat")).toBeNull();
    expect(
      container.querySelector(".activity-step__fold-head")?.textContent,
    ).toBe("写入 a.ts");
  });

  it("unpins on OPEN only — the diff can grow the flow by thousands of px", () => {
    const unpin = vi.fn();
    const { container } = renderWithLocale(
      <ConversationPinProvider unpin={unpin}>
        <ActivityStep body="写入 a.ts" t={tEn} active={false} patch={patch} />
      </ConversationPinProvider>,
    );
    const head = container.querySelector(
      ".activity-step__fold-head",
    ) as HTMLElement;
    fireEvent.click(head);
    expect(unpin).toHaveBeenCalledTimes(1);
    fireEvent.click(head);
    expect(unpin).toHaveBeenCalledTimes(1);
  });
});
