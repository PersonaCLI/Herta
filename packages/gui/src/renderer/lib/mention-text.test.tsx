import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderMentionText } from "./mention-text.js";

/** A sent message's chips (ADR 0072 amendment 2026-10-20, ADR 0083 §4). */
describe("renderMentionText", () => {
  const pick = {
    line: 'localhost:5173/login · button "Sign in" · <button>Sign in</button>',
    element: 'button "Sign in"',
    route: "localhost:5173/login",
  };

  it("draws a picked element's line as its chip, in the session's words, beside a file chip", () => {
    const text = `${pick.line} fails, see src/login.ts`;
    const { container } = render(
      <p>
        {renderMentionText(text, ["src/login.ts"], (s) => s, undefined, {
          list: [pick],
          lang: "en",
        })}
      </p>,
    );
    const chips = [...container.querySelectorAll(".message-chip")];
    expect(
      chips.map((c) => c.querySelector(".message-chip__name")?.textContent),
    ).toEqual(['button "Sign in"', "login.ts"]);
    expect(chips[0]?.classList.contains("message-chip--pick")).toBe(true);
    expect(container.textContent).not.toContain("<button>");
  });

  it("names the element in Chinese in a zh session", () => {
    const { container } = render(
      <p>
        {renderMentionText(pick.line, undefined, (s) => s, undefined, {
          list: [pick],
          lang: "zh",
        })}
      </p>,
    );
    expect(container.textContent).toBe("按钮「Sign in」");
  });
});
