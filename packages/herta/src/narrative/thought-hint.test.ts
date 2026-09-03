import { describe, expect, it } from "vitest";
import { SUPERVISOR_VETO_TEMPLATE } from "./actor-hints.js";
import {
  actorHintTexts,
  BEAT_HINT_PATCH_PREVIEW,
  BEAT_HINT_TOOL_FAIL,
  BEAT_HINT_VERIFICATION_FINISHED,
  BEAT_NO_BANZHUAN_CLAUSE,
  buildSupervisorVetoHint,
  FORCED_SPEECH_OPEN_TAG,
  PHASE_TWO_SPEECH_HINT,
  PHASE_TWO_SPEECH_RETRY_HINT,
  PHASE_TWO_SPEECH_RETRY_HINTS,
  PHASE_TWO_THOUGHT_HINT,
  PHASE_TWO_THOUGHT_RETRY_HINT,
  PHASE_TWO_THOUGHT_RETRY_HINTS,
  STOP_SPEECH_CLOSE,
  STOP_THOUGHT_CLOSE,
} from "./thought-hint.js";

describe("thought-hint constants", () => {
  it("FORCED_SPEECH_OPEN_TAG forces speech (used by soft guard and beats)", () => {
    expect(FORCED_SPEECH_OPEN_TAG).toBe("（我 说）");
  });

  it("STOP_SPEECH_CLOSE matches the speech close tag", () => {
    expect(STOP_SPEECH_CLOSE).toBe("（/我 说）");
  });

  it("STOP_THOUGHT_CLOSE matches the thought close tag", () => {
    expect(STOP_THOUGHT_CLOSE).toBe("（/我 想）");
  });
});

describe("speech-hint unified bracket (imperative-speech + tool-format)", () => {
  // 2026-05-23 (initial): two separate `〔…〕` brackets — one for
  // imperative speech, one for the tool-format reminder — joined with
  // \n. Read as two stilted checklist items.
  // 2026-05-23 (revised): merged into a single `〔…〕` bracket per
  // speech-hint. Reads as one coherent directive. Both directives
  // remain present, just visually unified.

  it("PHASE_TWO_SPEECH_HINT is a single bracketed directive", () => {
    expect(PHASE_TWO_SPEECH_HINT.startsWith("〔")).toBe(true);
    expect(PHASE_TWO_SPEECH_HINT.endsWith("〕")).toBe(true);
    // Only ONE open-close pair (post-merge). If a future refactor
    // re-splits into two brackets, the inner `〕〔` boundary would
    // appear and this would catch it.
    expect(PHASE_TWO_SPEECH_HINT).not.toContain("〕\n〔");
    expect(PHASE_TWO_SPEECH_HINT).not.toContain("〕〔");
  });

  it("PHASE_TWO_SPEECH_HINT contains the imperative-speech directive", () => {
    expect(PHASE_TWO_SPEECH_HINT).toContain("接下来是我实际说给开拓者听的话");
    expect(PHASE_TWO_SPEECH_HINT).toContain(
      "以（我 说）开始，以（/我 说）结束",
    );
    expect(PHASE_TWO_SPEECH_HINT).toContain("不能空白");
  });

  it("PHASE_TWO_SPEECH_HINT no longer carries any tool-format clause", () => {
    // 2026-05-23: inline tools (read_file / list_files) were removed
    // entirely from Herta the actor. Herta delegates file reads via
    // `@板砖` instead. The speech hint must NOT mention any tool-call
    // syntax — that would prime the model to emit prose-shaped tool
    // calls that the harness won't fire AND the supervisor will veto.
    expect(PHASE_TWO_SPEECH_HINT).not.toContain('read_file("路径")');
    expect(PHASE_TWO_SPEECH_HINT).not.toContain('list_files("路径")');
    expect(PHASE_TWO_SPEECH_HINT).not.toContain("工具名紧贴左括号");
    expect(PHASE_TWO_SPEECH_HINT).not.toContain("无效输出");
  });

  it("PHASE_TWO_SPEECH_RETRY_HINT is a single bracketed directive with no tool clause", () => {
    expect(PHASE_TWO_SPEECH_RETRY_HINT.startsWith("〔")).toBe(true);
    expect(PHASE_TWO_SPEECH_RETRY_HINT.endsWith("〕")).toBe(true);
    expect(PHASE_TWO_SPEECH_RETRY_HINT).not.toContain("〕〔");
    expect(PHASE_TWO_SPEECH_RETRY_HINT).not.toContain("〕\n〔");
    // Stronger no-empty reinforcement specific to the retry path.
    expect(PHASE_TWO_SPEECH_RETRY_HINT).toContain("空白不行");
    expect(PHASE_TWO_SPEECH_RETRY_HINT).toContain("冷评、判断、反问都可以");
    // Tool-format clause is gone (2026-05-23 inline-tool removal).
    expect(PHASE_TWO_SPEECH_RETRY_HINT).not.toContain('read_file("路径")');
    expect(PHASE_TWO_SPEECH_RETRY_HINT).not.toContain("list_files ./");
  });

  it("buildSupervisorVetoHint is a single bracket with no tool clause", () => {
    const hint = buildSupervisorVetoHint(SUPERVISOR_VETO_TEMPLATE, "称呼漂移");
    expect(hint.startsWith("〔")).toBe(true);
    expect(hint.endsWith("〕")).toBe(true);
    expect(hint).not.toContain("〕〔");
    expect(hint).not.toContain("〕\n〔");
    expect(hint).toContain("称呼漂移"); // veto reason interpolated
    // Tool-format clause is gone (2026-05-23 inline-tool removal).
    expect(hint).not.toContain('read_file("路径")');
    expect(hint).not.toContain("list_files ./");
  });

  it("PHASE_TWO_THOUGHT_HINT does NOT include the tool-format clause", () => {
    // Thought hints have never carried tool-format clauses. Post-
    // 2026-05-23 the speech hint matches — Herta no longer has any
    // inline tools at all.
    expect(PHASE_TWO_THOUGHT_HINT).not.toContain('read_file("路径")');
    expect(PHASE_TWO_THOUGHT_HINT).not.toContain('list_files("路径")');
    expect(PHASE_TWO_THOUGHT_HINT).not.toContain("无效输出");
  });
});

describe("retry-hint variant ladders (2026-05-23)", () => {
  // Adds 2 more variants per surface beyond the base retry hint, so
  // the empty-output recovery ladder rotates HINTS as well as
  // temperature. Each variant attacks the failure from a different
  // angle so the model has a new frame on each attempt.

  it("PHASE_TWO_SPEECH_RETRY_HINTS has 3 variants, all single-bracket form", () => {
    expect(PHASE_TWO_SPEECH_RETRY_HINTS).toHaveLength(3);
    for (const hint of PHASE_TWO_SPEECH_RETRY_HINTS) {
      expect(hint.startsWith("〔")).toBe(true);
      expect(hint.endsWith("〕")).toBe(true);
      // Single bracket — no inner boundary.
      expect(hint).not.toContain("〕〔");
      expect(hint).not.toContain("〕\n〔");
    }
  });

  it("PHASE_TWO_SPEECH_RETRY_HINTS[0] is the base hint exported separately", () => {
    expect(PHASE_TWO_SPEECH_RETRY_HINTS[0]).toBe(PHASE_TWO_SPEECH_RETRY_HINT);
  });

  it("each PHASE_TWO_SPEECH_RETRY_HINTS variant has a unique angle marker", () => {
    // Variant 0 (base): direct "you closed empty" + cold-remark
    // alternative. Marker: "冷评、判断、反问都可以".
    expect(PHASE_TWO_SPEECH_RETRY_HINTS[0]).toContain(
      "冷评、判断、反问都可以，空白不行",
    );
    // Variant 1: pivot to a specific anchor point in the user's last
    // message. Marker: "抓住开拓者那句话里最具体的一个点".
    expect(PHASE_TWO_SPEECH_RETRY_HINTS[1]).toContain(
      "抓住开拓者那句话里最具体的一个点",
    );
    // Variant 2: mechanical first-character forcing. Marker:
    // "强制开始：先写出第一个字" / "拎一个出来，借力开口".
    expect(PHASE_TWO_SPEECH_RETRY_HINTS[2]).toContain(
      "强制开始：先写出第一个字",
    );
    expect(PHASE_TWO_SPEECH_RETRY_HINTS[2]).toContain("借力开口");
  });

  it("no PHASE_TWO_SPEECH_RETRY_HINTS variant carries any tool-format clause", () => {
    // 2026-05-23: inline tools removed. Retry variants must NOT
    // reintroduce them — would re-prime the model to emit prose-
    // shaped tool calls in the retry, which the supervisor would
    // then veto, looping the failure.
    for (const hint of PHASE_TWO_SPEECH_RETRY_HINTS) {
      expect(hint).not.toContain('read_file("路径")');
      expect(hint).not.toContain('list_files("路径")');
      expect(hint).not.toContain("list_files ./");
    }
  });

  it("PHASE_TWO_THOUGHT_RETRY_HINTS has 3 variants, all single-bracket form", () => {
    expect(PHASE_TWO_THOUGHT_RETRY_HINTS).toHaveLength(3);
    for (const hint of PHASE_TWO_THOUGHT_RETRY_HINTS) {
      expect(hint.startsWith("〔")).toBe(true);
      expect(hint.endsWith("〕")).toBe(true);
      expect(hint).not.toContain("〕〔");
      expect(hint).not.toContain("〕\n〔");
    }
  });

  it("PHASE_TWO_THOUGHT_RETRY_HINTS[0] is the base hint exported separately", () => {
    expect(PHASE_TWO_THOUGHT_RETRY_HINTS[0]).toBe(PHASE_TWO_THOUGHT_RETRY_HINT);
  });

  it("each PHASE_TWO_THOUGHT_RETRY_HINTS variant has a unique angle marker", () => {
    // Variant 0 (base): "you closed empty, write a concrete
    // judgement". Marker: "中间至少要写出一句针对开拓者刚才那句话的具体判断".
    expect(PHASE_TWO_THOUGHT_RETRY_HINTS[0]).toContain(
      "中间至少要写出一句针对开拓者刚才那句话的具体判断",
    );
    // Variant 1: pivot to specific anchors (odd word / suspicious
    // tone / inappropriate appellation / hidden motive). Marker
    // phrase enumerates the anchor types.
    expect(PHASE_TWO_THOUGHT_RETRY_HINTS[1]).toContain(
      "异常的词、可疑的语气、不该出现的称呼、藏在底下的真正动机",
    );
    // Variant 2: mechanical first-phrase forcing. Marker:
    // '"他这一句……"或者"他这次问的……"'.
    expect(PHASE_TWO_THOUGHT_RETRY_HINTS[2]).toContain('"他这一句……"');
    expect(PHASE_TWO_THOUGHT_RETRY_HINTS[2]).toContain('"他这次问的……"');
  });

  it("PHASE_TWO_THOUGHT_RETRY_HINTS variants do NOT include the tool-format clause", () => {
    // Inline tools are speech-only — keeping the thought retry hints
    // clean of tool syntax mentions.
    for (const hint of PHASE_TWO_THOUGHT_RETRY_HINTS) {
      expect(hint).not.toContain('read_file("路径")');
      expect(hint).not.toContain('list_files("路径")');
      expect(hint).not.toContain("无效输出");
    }
  });
});

describe("buildSupervisorVetoHint", () => {
  it("substitutes {{reason}} and strips trailing punctuation", () => {
    const tpl = "〔否了：{{reason}}。重说。〕";
    expect(buildSupervisorVetoHint(tpl, "我不该叫杨叔。")).toBe(
      "〔否了：我不该叫杨叔。重说。〕",
    );
  });
  it("returns the template unchanged when it has no {{reason}}", () => {
    expect(buildSupervisorVetoHint("〔固定提示〕", "x")).toBe("〔固定提示〕");
  });
  it("strips every trailing-punctuation variant + runs before substituting (N7)", () => {
    const tpl = "〔X：{{reason}}。〕";
    expect(buildSupervisorVetoHint(tpl, "怎么又来！")).toBe(
      "〔X：怎么又来。〕",
    );
    expect(buildSupervisorVetoHint(tpl, "为什么？")).toBe("〔X：为什么。〕");
    expect(buildSupervisorVetoHint(tpl, "stop!")).toBe("〔X：stop。〕");
    expect(buildSupervisorVetoHint(tpl, "really?")).toBe("〔X：really。〕");
    expect(buildSupervisorVetoHint(tpl, "够了。。！")).toBe("〔X：够了。〕");
  });
});

describe("formatSelfCorrectionText (N8/N8b, 2026-05-23)", () => {
  it("returns the reason verbatim, ready to be wrapped as ——<text>\\n\\n prose by the serializer", async () => {
    const { formatSelfCorrectionText } = await import("./thought-hint.js");
    // N8b: no longer prefixed with `自我修正：` — the serializer's
    // leading `——` is the only marker. Helper just normalizes.
    expect(formatSelfCorrectionText("我不该把瓦尔特叫成杨叔")).toBe(
      "我不该把瓦尔特叫成杨叔",
    );
  });

  it("strips trailing sentence-final punctuation (the serializer's `——` prefix doesn't need it)", async () => {
    const { formatSelfCorrectionText } = await import("./thought-hint.js");
    expect(formatSelfCorrectionText("我不该叫瓦尔特杨叔。")).toBe(
      "我不该叫瓦尔特杨叔",
    );
    expect(formatSelfCorrectionText("foo.")).toBe("foo");
    expect(formatSelfCorrectionText("foo!")).toBe("foo");
    expect(formatSelfCorrectionText("foo？")).toBe("foo");
  });

  it("trims leading/trailing whitespace", async () => {
    const { formatSelfCorrectionText } = await import("./thought-hint.js");
    expect(formatSelfCorrectionText("  reason text  ")).toBe("reason text");
  });
});

describe("BEAT_HINT_* — N9 (2026-05-23): forbid @板砖 in beats", () => {
  it("explicitly tells Herta not to write @板砖 in any beat hint", async () => {
    const {
      BEAT_HINT_PATCH_PREVIEW,
      BEAT_HINT_VERIFICATION_FINISHED,
      BEAT_HINT_TOOL_FAIL,
    } = await import("./thought-hint.js");
    // Each hint must contain the "no @板砖" clause AND must mention
    // both `@板砖` (the prohibited token) and "板砖正在工作中"
    // (the reason it's prohibited).
    for (const hint of [
      BEAT_HINT_PATCH_PREVIEW,
      BEAT_HINT_VERIFICATION_FINISHED,
      BEAT_HINT_TOOL_FAIL,
    ]) {
      expect(hint).toContain("@板砖");
      expect(hint).toContain("板砖正在工作中");
      expect(hint).toContain("新任务等它做完再说");
    }
  });
});

describe("actorHintTexts (EN interaction slice 3b)", () => {
  it('defaults to "zh" and returns the exact exported consts (byte-identical)', () => {
    for (const texts of [actorHintTexts(), actorHintTexts("zh")]) {
      expect(texts.phase2Thought).toBe(PHASE_TWO_THOUGHT_HINT);
      expect(texts.phase2Speech).toBe(PHASE_TWO_SPEECH_HINT);
      expect(texts.speechRetry).toEqual(PHASE_TWO_SPEECH_RETRY_HINTS);
      expect(texts.thoughtRetry).toEqual(PHASE_TWO_THOUGHT_RETRY_HINTS);
      expect(texts.beatNoBanzhuanClause).toBe(BEAT_NO_BANZHUAN_CLAUSE);
      expect(texts.beatPatchPreview).toBe(BEAT_HINT_PATCH_PREVIEW);
      expect(texts.beatVerification).toBe(BEAT_HINT_VERIFICATION_FINISHED);
      expect(texts.beatToolFail).toBe(BEAT_HINT_TOOL_FAIL);
    }
  });

  it('lang:"en" hints are English prose that keep the CN structural tokens', () => {
    const en = actorHintTexts("en");
    // Distinctive EN sentinels per surface.
    expect(en.phase2Thought).toContain("What follows is my thinking");
    expect(en.phase2Speech).toContain("What follows is what I say out loud");
    // Every 〔…〕 hint keeps the bracket form and the CN narrative
    // fences — the EN actor reads the same grammar (D2/D7/D8).
    const all = [
      en.phase2Thought,
      en.phase2Speech,
      ...en.speechRetry,
      ...en.thoughtRetry,
      en.beatPatchPreview,
      en.beatVerification,
      en.beatToolFail,
    ];
    for (const hint of all) {
      expect(hint.startsWith("〔")).toBe(true);
      expect(hint.endsWith("〕")).toBe(true);
      expect(hint).not.toContain("〕〔");
      expect(hint).not.toContain("〕\n〔");
    }
    // Speech-surface hints name the speech fences; thought-surface
    // hints name the thought fences.
    for (const hint of [en.phase2Speech, ...en.speechRetry]) {
      expect(hint).toContain("（我 说）");
      expect(hint).toContain("（/我 说）");
    }
    for (const hint of [en.phase2Thought, ...en.thoughtRetry]) {
      expect(hint).toContain("（我 想）");
      expect(hint).toContain("（/我 想）");
    }
  });

  it('lang:"en" retry ladders have 3 distinct variants per surface', () => {
    const en = actorHintTexts("en");
    expect(new Set(en.speechRetry).size).toBe(3);
    expect(new Set(en.thoughtRetry).size).toBe(3);
  });

  it('lang:"en" beat hints keep the @板砖/板砖 tokens and the no-dispatch clause (N9)', () => {
    const en = actorHintTexts("en");
    expect(en.beatNoBanzhuanClause).toContain("@板砖");
    expect(en.beatNoBanzhuanClause).toContain("mid-job");
    for (const hint of [
      en.beatPatchPreview,
      en.beatVerification,
      en.beatToolFail,
    ]) {
      expect(hint).toContain("板砖");
      expect(hint).toContain(en.beatNoBanzhuanClause);
      expect(hint).toContain("（我 说）");
      expect(hint).toContain("（/我 说）");
    }
  });
});
