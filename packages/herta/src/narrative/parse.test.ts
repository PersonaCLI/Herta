import { describe, expect, it } from "vitest";
import { userTextPreemptsDispatch } from "./actor-turn.js";
import {
  neutralizeBanzhuanTrigger,
  type ParsedHertaBlock,
  parseHertaBlock,
  stripBanzhuanTrigger,
} from "./parse.js";

describe("parseHertaBlock — text passthrough", () => {
  it("returns text unmodified and no trigger for plain prose", () => {
    const parsed = parseHertaBlock("说事。你最好真的有事。");
    expect(parsed.text).toBe("说事。你最好真的有事。");
    expect(parsed.hasBanzhuanTrigger).toBe(false);
  });

  it("returns text unchanged even when prose mentions tool-like names", () => {
    // 2026-05-23: Herta no longer has inline tools. Any read_file /
    // list_files / tool() text the model emits is just prose; the
    // parser doesn't extract or strip it.
    const input = "我用 read_file 看看，再 list_files 一下。";
    const parsed = parseHertaBlock(input);
    expect(parsed.text).toBe(input);
    expect(parsed.hasBanzhuanTrigger).toBe(false);
  });

  it("returns text unchanged even for a syntactically valid tool-call shape", () => {
    // Defensive: even if the model emits a tool-call-shaped string,
    // it's prose now. The supervisor's rule 7 vetoes any speech that
    // contains tool-call shapes (see supervisor-system-prompt.ts), so
    // the parser doesn't need to act on them.
    const input = '看一眼 read_file("foo.ts") 一下';
    const parsed = parseHertaBlock(input);
    expect(parsed.text).toBe(input);
  });
});

describe("parseHertaBlock — @板砖 trigger", () => {
  it("detects @板砖 at start of text", () => {
    const parsed = parseHertaBlock("@板砖，跑一下测试。");
    expect(parsed.hasBanzhuanTrigger).toBe(true);
  });

  it("detects @板砖 in the middle of a sentence", () => {
    const parsed = parseHertaBlock("我要让 @板砖 处理这个。");
    expect(parsed.hasBanzhuanTrigger).toBe(true);
  });

  it("detects @板砖 at the end of text", () => {
    const parsed = parseHertaBlock("这事得让它干。@板砖");
    expect(parsed.hasBanzhuanTrigger).toBe(true);
  });

  it("returns true for multiple occurrences (collapses to single trigger)", () => {
    const parsed = parseHertaBlock("@板砖 一次 @板砖 两次 @板砖");
    expect(parsed.hasBanzhuanTrigger).toBe(true);
  });

  it("returns false when @板砖 is absent", () => {
    const parsed = parseHertaBlock("板砖蹲在桌角，但我没叫它。");
    expect(parsed.hasBanzhuanTrigger).toBe(false);
  });

  it("returns false when 板砖 appears without the @ prefix", () => {
    const parsed = parseHertaBlock("板砖会处理。");
    expect(parsed.hasBanzhuanTrigger).toBe(false);
  });

  it("returns false when @板砖 has a different prefix character", () => {
    const parsed = parseHertaBlock("#板砖 不是触发器");
    expect(parsed.hasBanzhuanTrigger).toBe(false);
  });
});

describe("parseHertaBlock — backtick exemption (2026-06-11 trigger discipline)", () => {
  // Supervisor §8 exempts `@板砖` inside backticks ("反引号里的引用……
  // 不会触发调度"). The parser must make that claim true: a trigger
  // inside a `…` inline code span is quotation, not dispatch.

  it("returns false when @板砖 appears only inside an inline code span", () => {
    const parsed = parseHertaBlock("反引号里的 `@板砖` 只是举例，不派活。");
    expect(parsed.hasBanzhuanTrigger).toBe(false);
  });

  it("returns false when the whole dispatch syntax is quoted in backticks", () => {
    const parsed = parseHertaBlock("格式是 `@板砖 <任务>`，没别的写法。");
    expect(parsed.hasBanzhuanTrigger).toBe(false);
  });

  it("returns true when a bare @板砖 appears outside a code span", () => {
    const parsed = parseHertaBlock(
      "先看 `@板砖 跑测试` 这个写法。@板砖 真的跑一下。",
    );
    expect(parsed.hasBanzhuanTrigger).toBe(true);
  });

  it("returns true for a bare @板砖 between two separate code spans", () => {
    const parsed = parseHertaBlock("`a` @板砖 `b`");
    expect(parsed.hasBanzhuanTrigger).toBe(true);
  });

  it("returns true when the backtick is unpaired (not a code span)", () => {
    const parsed = parseHertaBlock("一个反引号 `@板砖 没闭合，照样触发");
    expect(parsed.hasBanzhuanTrigger).toBe(true);
  });

  it("returns text unmodified even when code spans are present", () => {
    const input = "格式是 `@板砖 <任务>`，记住。";
    const parsed = parseHertaBlock(input);
    expect(parsed.text).toBe(input);
  });

  it("does not invent a trigger by deleting a code span between @ and 板砖", () => {
    // Removing the span must not splice "@" and "板砖" into a token
    // that was never in the text.
    const parsed = parseHertaBlock("@`x`板砖");
    expect(parsed.hasBanzhuanTrigger).toBe(false);
  });

  it("returns false when @板砖 appears only inside a fenced code block", () => {
    const parsed = parseHertaBlock("```\n@板砖 跑测试\n```\n以上是格式示例。");
    expect(parsed.hasBanzhuanTrigger).toBe(false);
  });
});

describe("neutralizeBanzhuanTrigger", () => {
  // 2026-08-17 (owner): the inert form is the QUOTED token, not the
  // stripped one — "要我就 板砖 再开一轮" read broken on screen; the
  // sentence needs the @ to mean "the @-call". Backticked `@板砖` is the
  // record's established quotation form: never dispatches, the bubble shows
  // it monospace instead of the chip.
  it("quotes a bare @板砖 (keeps it visible, makes it inert)", () => {
    const out = neutralizeBanzhuanTrigger("要吗？要我就 @板砖 再开一轮。");
    expect(out).toBe("要吗？要我就 `@板砖` 再开一轮。");
    expect(parseHertaBlock(out).hasBanzhuanTrigger).toBe(false);
  });

  it("quotes every bare occurrence", () => {
    expect(neutralizeBanzhuanTrigger("@板砖 一次，@板砖 两次")).toBe(
      "`@板砖` 一次，`@板砖` 两次",
    );
  });

  it("preserves @板砖 inside an inline code span", () => {
    const input = "用法是 `@板砖 跑测试`，别记错。";
    expect(neutralizeBanzhuanTrigger(input)).toBe(input);
  });

  it("quotes bare occurrences while leaving already-backticked ones alone", () => {
    expect(
      neutralizeBanzhuanTrigger("就算@板砖再快——格式才是 `@板砖 <任务>`。"),
    ).toBe("就算`@板砖`再快——格式才是 `@板砖 <任务>`。");
  });

  it("falls back to the stripped form when an unpaired backtick would mis-pair the quote", () => {
    // "`abc " is an open span; wrapping would close it on our opening tick
    // and leave the token bare again — so the old `板砖` form is used.
    const out = neutralizeBanzhuanTrigger("`abc @板砖 def");
    expect(out).toBe("`abc 板砖 def");
    expect(parseHertaBlock(out).hasBanzhuanTrigger).toBe(false);
  });

  it("returns text unchanged when no trigger is present", () => {
    const input = "板砖蹲在桌角，但我没叫它。";
    expect(neutralizeBanzhuanTrigger(input)).toBe(input);
  });

  // Fixed-point discipline: a single replacement pass can FABRICATE a live
  // trigger from its own seam — "@@板砖" one pass → "@" + "板砖" = "@板砖",
  // which would dispatch the backend for exactly the sentence the
  // supervisor just ruled non-dispatch. The postcondition is absolute:
  // after neutralize, the parser must see no trigger.

  it("iterates to a fixed point on the @@板砖 seam", () => {
    const out = neutralizeBanzhuanTrigger("@@板砖 干活");
    expect(parseHertaBlock(out).hasBanzhuanTrigger).toBe(false);
  });

  it("postcondition holds for nested seams (@@@板砖)", () => {
    const out = neutralizeBanzhuanTrigger("看好了 @@@板砖 一起上");
    expect(parseHertaBlock(out).hasBanzhuanTrigger).toBe(false);
  });
});

describe("stripBanzhuanTrigger", () => {
  // Used by the user-typed pre-empt (actor-turn SPEC §7) to form the
  // backend brief: bare triggers are removed, backticked quotations
  // stay part of the brief text.

  it("removes a bare @板砖", () => {
    expect(stripBanzhuanTrigger("@板砖 跑一下测试")).toBe(" 跑一下测试");
  });

  it("removes every bare occurrence", () => {
    expect(stripBanzhuanTrigger("@板砖 先这个 @板砖 再那个")).toBe(
      " 先这个  再那个",
    );
  });

  it("preserves @板砖 inside an inline code span", () => {
    expect(stripBanzhuanTrigger("@板砖 解释一下 `@板砖` 的用法")).toBe(
      " 解释一下 `@板砖` 的用法",
    );
  });

  it("returns text unchanged when only a backticked trigger is present", () => {
    const input = "`@板砖` 这个符号是干嘛的？";
    expect(stripBanzhuanTrigger(input)).toBe(input);
  });

  it("iterates to a fixed point when removal re-splices a trigger", () => {
    // "@板@板砖砖" one removal pass → "@板" + "砖" = "@板砖" — a live
    // trigger fabricated by the deletion seam. The brief text handed to
    // the backend must contain no dispatch-effective token.
    const out = stripBanzhuanTrigger("@板@板砖砖 修一下");
    expect(parseHertaBlock(out).hasBanzhuanTrigger).toBe(false);
  });
});

describe("parseHertaBlock — shape", () => {
  it("returns a ParsedHertaBlock with exactly { text, hasBanzhuanTrigger }", () => {
    const parsed: ParsedHertaBlock = parseHertaBlock(
      "先看一下，再 @板砖 改一改。",
    );
    expect(parsed.text).toBe("先看一下，再 @板砖 改一改。");
    expect(parsed.hasBanzhuanTrigger).toBe(true);
    // The shape is intentionally minimal — no inlineCalls field as of
    // the 2026-05-23 inline-tool removal sweep.
    expect(Object.keys(parsed).sort()).toEqual(["hasBanzhuanTrigger", "text"]);
  });
});

describe("parseHertaBlock — a closed fenced block is quotation (ADR 0078 amendment 2026-10-21)", () => {
  const tick = "`";
  const f3 = tick.repeat(3);
  const f4 = tick.repeat(4);

  it("a quoted passage holding an inline-code @板砖 is no trigger — the span rule alone mis-paired inside the fence", () => {
    const text = `〔引用 CLAUDE.md:120–122〕\n${f3}md\nthe ${tick}@板砖${tick} delegation token\n${f3}\n\n讲讲这段`;
    expect(parseHertaBlock(text).hasBanzhuanTrigger).toBe(false);
    expect(userTextPreemptsDispatch(text)).toBe(false);
  });

  it("nor is a four-backtick fence (a quoted section that holds a code block)", () => {
    const text = `〔引用 docs/x.md:1–9〕\n${f4}md\n${f3}ts\ncode\n${f3}\nwrite @板砖 to delegate\n${f4}\n\n讲讲这段`;
    expect(parseHertaBlock(text).hasBanzhuanTrigger).toBe(false);
    expect(userTextPreemptsDispatch(text)).toBe(false);
  });

  it("nor a tilde fence", () => {
    expect(
      parseHertaBlock("~~~\nask @板砖 for it\n~~~").hasBanzhuanTrigger,
    ).toBe(false);
  });

  it("the Trailblazer's own @板砖 after a quote still dispatches, and the brief keeps the quote whole", () => {
    const text = `〔引用 notes.md:3〕\n${f3}\nask @板砖 for it\n${f3}\n\n@板砖 按这段改`;
    expect(userTextPreemptsDispatch(text)).toBe(true);
    const brief = stripBanzhuanTrigger(text);
    expect(brief).toContain("ask @板砖 for it");
    expect(brief.endsWith(" 按这段改")).toBe(true);
  });

  it("an UNCLOSED fence quotes nothing — a stray fence never swallows a real @板砖", () => {
    expect(parseHertaBlock(`${f3}\n@板砖 看看`).hasBanzhuanTrigger).toBe(true);
    // A shorter or different closing line does not close it.
    expect(
      parseHertaBlock(`${f4}\nx\n${f3}\n@板砖 看看`).hasBanzhuanTrigger,
    ).toBe(true);
    expect(
      parseHertaBlock(`${f3}\nx\n~~~\n@板砖 看看`).hasBanzhuanTrigger,
    ).toBe(true);
  });

  it("neutralize leaves a fenced @板砖 as it was", () => {
    const text = `${f3}\n@板砖 in code\n${f3}\n@板砖 live`;
    const out = neutralizeBanzhuanTrigger(text);
    expect(out).toContain("@板砖 in code");
    expect(out).toContain(`${tick}@板砖${tick} live`);
    expect(parseHertaBlock(out).hasBanzhuanTrigger).toBe(false);
  });
});
