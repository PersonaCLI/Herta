import { describe, expect, it } from "vitest";
import {
  aliasBanzhuanDisplay,
  aliasBanzhuanPlain,
  aliasBrickInput,
} from "./banzhuan-alias.js";

describe("aliasBanzhuanPlain (display alias)", () => {
  it("maps @板砖→@Brick and bare 板砖→Brick in an EN string", () => {
    expect(aliasBanzhuanPlain("hand it to @板砖. 板砖 is idle.", "en")).toBe(
      "hand it to @Brick. Brick is idle.",
    );
  });

  it("leaves a zh string byte-identical", () => {
    expect(aliasBanzhuanPlain("交给 @板砖，板砖 闲着。", "zh")).toBe(
      "交给 @板砖，板砖 闲着。",
    );
  });

  it("is a no-op when there is no 板砖", () => {
    expect(aliasBanzhuanPlain("just plain english", "en")).toBe(
      "just plain english",
    );
  });
});

describe("aliasBrickInput (input reverse alias, @-form only)", () => {
  it("maps a typed @Brick back to the wire token @板砖 (EN)", () => {
    expect(aliasBrickInput("hand @Brick the parser bug", "en")).toBe(
      "hand @板砖 the parser bug",
    );
  });

  it("is case-insensitive on the @-form", () => {
    expect(aliasBrickInput("try @brick and @BRICK", "en")).toBe(
      "try @板砖 and @板砖",
    );
  });

  it("never touches the bare English word 'brick' (no @)", () => {
    expect(aliasBrickInput("a brick wall, not a trigger", "en")).toBe(
      "a brick wall, not a trigger",
    );
  });

  it("requires a trailing word boundary — @Bricks does NOT dispatch", () => {
    expect(aliasBrickInput("tell @Bricks apart", "en")).toBe(
      "tell @Bricks apart",
    );
  });

  it("requires the @ to START a mention — an embedded @brick is NOT dispatched", () => {
    // An email / scoped-package token must not false-dispatch the backend.
    expect(aliasBrickInput("email me at bob@brick.io", "en")).toBe(
      "email me at bob@brick.io",
    );
    expect(aliasBrickInput("install pkg@brick", "en")).toBe(
      "install pkg@brick",
    );
    // A genuine standalone mention (after a space or at the start) still fires.
    expect(aliasBrickInput("@brick fix it", "en")).toBe("@板砖 fix it");
    expect(aliasBrickInput("(@Brick)", "en")).toBe("(@板砖)");
  });

  it("is a no-op for zh", () => {
    expect(aliasBrickInput("交给 @Brick 处理", "zh")).toBe("交给 @Brick 处理");
  });

  // Code-span exemption (audit 2026-07-16): a backticked `@brick` is the
  // user QUOTING the token, not typing it. Kept in lockstep with the GUI
  // composer's aliasBrickInput (banzhuan-mention.ts).
  it("leaves a backticked `@brick` untouched", () => {
    expect(aliasBrickInput("how do I write `@brick` here?", "en")).toBe(
      "how do I write `@brick` here?",
    );
  });

  it("converts outside spans on a mixed line, spans verbatim", () => {
    expect(
      aliasBrickInput(
        "send @brick this: `@brick --help` then ask @Brick",
        "en",
      ),
    ).toBe("send @板砖 this: `@brick --help` then ask @板砖");
  });

  it("an unclosed backtick is not a span — the mention still converts", () => {
    expect(aliasBrickInput("odd `tick and @brick fires", "en")).toBe(
      "odd `tick and @板砖 fires",
    );
  });
});

describe("aliasBanzhuanDisplay (code-aware display alias)", () => {
  it("aliases prose but keeps a single-backtick span verbatim (EN)", () => {
    expect(
      aliasBanzhuanDisplay("run `cat 板砖.md`; ask @板砖 nicely", "en"),
    ).toBe("run `cat 板砖.md`; ask @Brick nicely");
  });

  // Owner 2026-11-13: past the dispatch budget a further `@板砖` of Herta's
  // is committed quoted, and an English conversation showed the wire token.
  it("the trigger token quoted in a span reads `@Brick`, still quoted (EN)", () => {
    expect(
      aliasBanzhuanDisplay("the token is `@板砖`; ask @板砖 nicely", "en"),
    ).toBe("the token is `@Brick`; ask @Brick nicely");
    expect(
      aliasBanzhuanDisplay("say `@板砖 run the tests` and it goes", "en"),
    ).toBe("say `@Brick run the tests` and it goes");
    // zh is byte-identical, and a fenced block is verbatim in both.
    expect(aliasBanzhuanDisplay("令牌是 `@板砖`", "zh")).toBe("令牌是 `@板砖`");
    expect(aliasBanzhuanDisplay("```\n`@板砖`\n```", "en")).toBe(
      "```\n`@板砖`\n```",
    );
  });

  it("keeps a ``` fenced region verbatim, aliasing the prose around it (EN)", () => {
    expect(
      aliasBanzhuanDisplay(
        "ask @板砖 first\n```sh\necho 板砖\n```\nthen 板砖 rests",
        "en",
      ),
    ).toBe("ask @Brick first\n```sh\necho 板砖\n```\nthen Brick rests");
  });

  it("an unclosed fence extends to the end of the text (pacer parity)", () => {
    expect(aliasBanzhuanDisplay("say @板砖\n```\n板砖 forever", "en")).toBe(
      "say @Brick\n```\n板砖 forever",
    );
  });

  it("inline spans inside a fence need no special casing — the fence already exempts", () => {
    expect(
      aliasBanzhuanDisplay("```\n`板砖` in a fence\n```\n板砖 outside", "en"),
    ).toBe("```\n`板砖` in a fence\n```\nBrick outside");
  });

  it("matches aliasBanzhuanPlain on code-free text (EN)", () => {
    const text = "hand it to @板砖. 板砖 is idle.";
    expect(aliasBanzhuanDisplay(text, "en")).toBe(
      aliasBanzhuanPlain(text, "en"),
    );
  });

  it("zh is byte-identical, fences or not", () => {
    const text = "交给 @板砖：\n```\n板砖 --help\n```";
    expect(aliasBanzhuanDisplay(text, "zh")).toBe(text);
  });
});
