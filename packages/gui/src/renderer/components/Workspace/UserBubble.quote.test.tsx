import { fireEvent, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithLocale } from "../../i18n/test-util.js";
import { composeQuotedMessage, postQuote } from "../../lib/quote-format.js";
import { MorphClone } from "./MorphClone.js";
import { UserBubble } from "./UserBubble.js";

describe("UserBubble — a quote reads as a card (ADR 0078 §7)", () => {
  it("shows the label and the first lines, then what was said", () => {
    const text = composeQuotedMessage(
      [
        {
          id: "q1",
          path: "src/calc.js",
          from: 9,
          to: 14,
          text: "export function div(a, b) {\n  return a / b;\n}\n// four",
          fence: "js",
        },
      ],
      "为什么不判零？",
      "zh",
    );
    const { container } = renderWithLocale(<UserBubble text={text} />);
    expect(screen.getByText("src/calc.js:9–14")).toBeInTheDocument();
    const preview = container.querySelector(".message-quote__text");
    expect(preview?.textContent).toBe(
      "export function div(a, b) {\n  return a / b;\n}",
    );
    expect(screen.getByText("为什么不判零？")).toBeInTheDocument();
    // The raw header and fence never show.
    expect(container.textContent).not.toContain("```");
  });

  it("a message with no quote renders as before", () => {
    const { container } = renderWithLocale(<UserBubble text="hello" />);
    expect(container.querySelector(".message-quote")).toBeNull();
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
});

describe("MorphClone — the flying bubble reads like the one it lands as (owner 2026-10-29)", () => {
  it("draws a sent quote as its card, never as the header and fence, the same as the landed bubble", () => {
    const text = composeQuotedMessage(
      [
        {
          id: "q1",
          path: "docs/report.docx",
          from: 6,
          to: 9,
          unit: "para",
          title: "2 研究方法",
          text: "2 研究方法\n\n2.1 数据\n\n样本取自……\n\n调用方\t次数",
        },
      ],
      "这段的数据够不够？",
      "zh",
    );
    const overlay = document.createElement("div");
    document.body.append(overlay);
    const ref = { current: overlay };
    const { container } = renderWithLocale(
      <>
        <MorphClone
          ref={createRef<HTMLDivElement>()}
          overlay={ref}
          variant="user"
          text={text}
          lang="zh"
        />
        <UserBubble text={text} />
      </>,
    );
    // It flew expanded — the whole source as text — and collapsed to the
    // card on landing.
    const clone = overlay.querySelector(".morph-clone") as HTMLElement;
    expect(clone.textContent).not.toContain("```");
    expect(clone.textContent).not.toContain("〔引用");
    const landed = container.querySelector(".user-bubble") as HTMLElement;
    expect(clone.innerHTML).toBe(landed.innerHTML);
    // Inert while it flies: nothing in it takes the keyboard.
    expect(
      clone.querySelector(".message-quote__label")?.getAttribute("tabindex"),
    ).toBe(overlay.querySelector("button") === null ? null : "-1");
    overlay.remove();
  });
});

describe("UserBubble — a quoted Flow post (ADR 0084 §9)", () => {
  it("names its site and title; the label opens the page", () => {
    const quote = postQuote(
      {
        id: "d/0",
        url: "https://nodejs.org/en/blog/release/v24",
        site: "Node.js",
        date: "2026-10-30",
        title: "Node.js 24 is out",
        detail: "The full write-up.",
        word: null,
      },
      "en",
    );
    if (quote === undefined) throw new Error("no quote");
    const text = composeQuotedMessage([quote], "Upgrade now?", "en");
    const onOpenWebPage = vi.fn();
    const { container } = renderWithLocale(
      <UserBubble text={text} lang="en" onOpenWebPage={onOpenWebPage} />,
    );
    fireEvent.click(screen.getByText("nodejs.org · Node.js 24 is out"));
    expect(onOpenWebPage).toHaveBeenCalledWith(
      "https://nodejs.org/en/blog/release/v24",
    );
    expect(container.textContent).not.toContain("https://");
    expect(screen.getByText("Upgrade now?")).toBeInTheDocument();
  });
});
