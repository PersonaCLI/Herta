import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { stripInlineCodeTicks } from "./banzhuan-mention.js";
import { renderBanzhuanText } from "./banzhuan-text.js";

describe("renderBanzhuanText — 板砖→Brick surface alias", () => {
  it("renders @板砖 as @Brick and bare 板砖 as Brick in an EN bubble", () => {
    const { container } = render(
      renderBanzhuanText("Hand it to @板砖. 板砖 is idle.", "bubble", "en"),
    );
    // Display is aliased…
    expect(container.textContent).toBe("Hand it to @Brick. Brick is idle.");
    // …and the trigger still renders as the styled mention chip (the record
    // value stays @板砖; only the label changes).
    expect(container.querySelector(".banzhuan-mention")?.textContent).toBe(
      "@Brick",
    );
  });

  it("keeps 板砖 literal in a zh bubble (byte-identical to before)", () => {
    const { container } = render(
      renderBanzhuanText("交给 @板砖。板砖 闲着。", "bubble", "zh"),
    );
    expect(container.textContent).toBe("交给 @板砖。板砖 闲着。");
    expect(container.querySelector(".banzhuan-mention")?.textContent).toBe(
      "@板砖",
    );
  });

  it("NEVER substitutes in the composer variant, even in EN (caret-metric safety)", () => {
    const { container } = render(
      renderBanzhuanText("@板砖 板砖", "composer", "en"),
    );
    expect(container.textContent).toBe("@板砖 板砖");
  });

  it("EN composer chips a typed @brick with its LITERAL text (never substitutes)", () => {
    const { container } = render(
      <div>{renderBanzhuanText("hand @Brick this", "composer", "en")}</div>,
    );
    // Metric identity: the overlay shows exactly what the textarea holds…
    expect(container.textContent).toBe("hand @Brick this");
    // …and the typed form carries the composer chip class.
    expect(container.querySelector(".composer-mention")?.textContent).toBe(
      "@Brick",
    );
  });

  it("zh composer does NOT chip a typed @brick (the input alias is EN-only)", () => {
    const { container } = render(
      <div>{renderBanzhuanText("hand @brick this", "composer", "zh")}</div>,
    );
    expect(container.textContent).toBe("hand @brick this");
    expect(container.querySelector(".composer-mention")).toBeNull();
  });

  it("EN bubble does NOT chip @brick (committed records never contain it)", () => {
    const { container } = render(
      <div>{renderBanzhuanText("hand @brick this", "bubble", "en")}</div>,
    );
    expect(container.textContent).toBe("hand @brick this");
    expect(container.querySelector(".banzhuan-mention")).toBeNull();
  });

  // Owner 2026-11-13. It showed the wire token: past the dispatch budget a
  // further `@板砖` of Herta's is committed quoted, and an English
  // conversation then had a lone CJK token in the middle of her sentence.
  it("a backticked @板砖 is a quotation, not a mention, and reads @Brick in EN", () => {
    const { container } = render(
      renderBanzhuanText("write `@板砖` here", "bubble", "en"),
    );
    // Still a code span, so no chip; the delimiters are display-stripped
    // (2026-07-27); the token has the name an EN user reads and types.
    expect(container.querySelector(".inline-code")?.textContent).toBe("@Brick");
    expect(container.querySelector(".banzhuan-mention")).toBeNull();
    expect(container.textContent).toBe("write @Brick here");
  });

  it("only the token is renamed in a span; zh and other code are verbatim", () => {
    const zh = render(renderBanzhuanText("写 `@板砖` 就行", "bubble", "zh"));
    expect(zh.container.querySelector(".inline-code")?.textContent).toBe(
      "@板砖",
    );
    const code = render(
      renderBanzhuanText("see `docs/板砖.md` and `@板砖 run`", "bubble", "en"),
    );
    expect(
      [...code.container.querySelectorAll(".inline-code")].map(
        (c) => c.textContent,
      ),
    ).toEqual(["docs/板砖.md", "@Brick run"]);
  });

  it("the COMPOSER overlay keeps its backticks (caret metrics)", () => {
    // The overlay sits on top of the textarea and must stay
    // metric-identical to it: dropping two characters would drift the
    // caret. Only the bubble strips.
    const { container } = render(
      <div>{renderBanzhuanText("用 `read_file` 去看", "composer", "zh")}</div>,
    );
    expect(container.textContent).toBe("用 `read_file` 去看");
  });

  it("an EMPTY span renders literally rather than as a bare chip", () => {
    const { container } = render(
      <div>{renderBanzhuanText("a `` b", "bubble", "zh")}</div>,
    );
    expect(container.querySelector(".inline-code")).toBeNull();
    expect(container.textContent).toBe("a `` b");
  });

  it("several spans in one line each drop their own delimiters", () => {
    const { container } = render(
      <div>
        {renderBanzhuanText("`slugify` 和 `truncate` 都补了", "bubble", "zh")}
      </div>,
    );
    const codes = [...container.querySelectorAll(".inline-code")].map(
      (c) => c.textContent,
    );
    expect(codes).toEqual(["slugify", "truncate"]);
    expect(container.textContent).toBe("slugify 和 truncate 都补了");
  });
});

describe("stripInlineCodeTicks — compact single-line labels", () => {
  // The sidebar card preview, a search snippet, and a topic-rail title take
  // the plain-string path (no chips — they are one line of small text), so
  // without this they showed a user's `truncate` with its delimiters.
  it("drops the delimiters and keeps the inside", () => {
    expect(stripInlineCodeTicks("`truncate` 里加了类型和边界检查")).toBe(
      "truncate 里加了类型和边界检查",
    );
  });

  it("handles several spans in one label", () => {
    expect(stripInlineCodeTicks("改 `slugify` 和 `truncate`")).toBe(
      "改 slugify 和 truncate",
    );
  });

  it("leaves an empty span literal rather than deleting characters", () => {
    expect(stripInlineCodeTicks("a `` b")).toBe("a `` b");
  });

  it("leaves an unpaired backtick alone", () => {
    expect(stripInlineCodeTicks("a ` b")).toBe("a ` b");
  });

  it("is identity for text with no spans", () => {
    expect(stripInlineCodeTicks("普通一句话")).toBe("普通一句话");
  });
});
