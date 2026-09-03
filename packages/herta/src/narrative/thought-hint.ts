import type { PromptLang } from "./prompt-lang.js";

/**
 * Constants for the thought/speech fences of the actor's prompts.
 *
 * `FORCED_SPEECH_OPEN_TAG` opens every speech call: the forced-speech
 * phase that follows each thought (the only rhythm since 2026-09-03, ADR
 * 0055) and the in-turn beats (reactions to backend events are always
 * speech, SPEC §3 H).
 *
 * `BRANCH_OPEN_TAG` and `THOUGHT_HINT_LINE` are vestiges of the Slice 10
 * single-phase path: the partial tag's trailing space let DeepSeek
 * complete `想）` or `说）` itself, and the hint narrowed that choice to
 * {思考, 说话}. No prompt carries either any more; the constant and the
 * `thought_hint_line` asset key stay until the prompt-asset pipeline
 * drops them (ADR 0055 §3).
 *
 * Language (EN interaction slice 3b): every `〔…〕` hint below exists in
 * zh + en, co-located in a `Record<PromptLang, string>` and selected via
 * `actorHintTexts(lang)`. The bare exported consts are the zh variants
 * (byte-identical to the pre-slice-3b values) so existing callers are
 * unchanged. Structural narrative-grammar tokens stay CN in BOTH
 * variants (D2/D7/D8): the （我 想）/（我 说）/（/我 想）/（/我 说）
 * fences, the @板砖 dispatch token and inert 板砖, and the `〔…〕`
 * hint brackets. The open/close tags themselves (`BRANCH_OPEN_TAG`
 * etc.) and `FINAL_RETRY_BODY_SEED` are grammar/record content, not
 * instructional prose — single-variant by design.
 *
 * SPEC v0.2 Slice 10 §3 (C, E, H), §5.1.
 */

export const BRANCH_OPEN_TAG = "（我 ";
export const FORCED_SPEECH_OPEN_TAG = "（我 说）";

export const STOP_SPEECH_CLOSE = "（/我 说）";
export const STOP_THOUGHT_CLOSE = "（/我 想）";

const THOUGHT_HINT_LINE_TEXT: Record<PromptLang, string> = {
  zh: "〔接下来：（我 想）思考 或（我 说）说话〕",
  en: "〔Next: （我 想） to think, or （我 说） to speak〕",
};

export const THOUGHT_HINT_LINE = THOUGHT_HINT_LINE_TEXT.zh;

/**
 * Body seed appended to the open tag on the FINAL empty-output retry
 * (the last attempt of the temperature/hint ladder).
 *
 * Why: when the model is deterministically stuck emitting the close
 * tag at position 0, no amount of temperature bumping or hint
 * rephrasing might break it. Seeding the body with `……` gives the
 * model two graceful escape paths:
 *   - Continue writing after `……` — natural extension.
 *   - Close immediately and let `……` stand as the body content —
 *     a meaningful Herta-voice fallback (dismissive trailing-off in
 *     speech; contemplative blank in thought).
 *
 * The prompt's open tag becomes `（我 说）……` (or `（我 想）……`).
 * The committed body is `……` + whatever the model generates. If the
 * model generates nothing, the body is just `……` — non-empty,
 * voice-consistent, and the turn produces visible output instead of
 * the previous silent-failure mode.
 *
 * Used only by the final ladder step (`retryAttemptIndex === 2` —
 * the highest index in `EMPTY_SPEECH_RETRY_TEMPERATURES`). Earlier
 * attempts get a fresh chance without the seed so the model can
 * produce naturally-flowing content first.
 *
 * Chinese typography: `……` is the standard Chinese ellipsis (two
 * U+2026 chars), NOT three ASCII dots. Matches the corpus voice.
 */
export const FINAL_RETRY_BODY_SEED = "……";

/**
 * Phase-2 surface-specific format-enforcement hints. Appended right
 * before the corresponding open tag in two-phase prompts so the model
 * knows exactly what bracketing to produce.
 *
 * Stronger than `THOUGHT_HINT_LINE` (which only narrows the surface
 * space to {思考, 说话}): these spell out the exact open AND close
 * tags. Originally needed because the meta-think `## 注释` /
 * `## 注释完` section markers had a tendency to leak into the model's
 * output (mimicked formatting, stray closes, etc.). Those heading
 * markers have since been dropped — the meta-think text is now
 * injected as bare preamble — but the explicit-tag pattern these
 * hints establish remains useful for keeping the model from drifting
 * out of the `（我 想）...（/我 想）` bracketing on long generations.
 *
 * NEVER persisted — these are appended fresh per LLM call inside
 * `runPhaseTwo` and `makeFireBeat`. They never enter `TerminalRecord`.
 */
const PHASE_TWO_THOUGHT_HINT_TEXT: Record<PromptLang, string> = {
  zh: "〔接下来是我针对这一回的具体思考，必须以（我 想）开始，以（/我 想）结束。写完 `（/我 想）` 就停笔——不要在同一段里继续写 `（我 说）` 那段说话内容，说话是另一段单独写出来的，不要塞进这里。注意：紧贴在开拓者这句话上面的那段我先写下的旁注，是关于「我这一档该怎么想」的提示，不是我已经想好的话；这一段我要针对开拓者刚刚那句话的具体内容，写一段当下的、新的思考，不要照抄上面那段旁注的句子，也不要把它的方法论原样复述一遍〕",
  en: "〔What follows is my thinking. Must start with （我 想） and end with （/我 想）. Stop after writing `（/我 想）` — do not chain `（我 说）` onto the same block; the spoken part gets its own block. The side-note pasted above is only a directional hint, not a conclusion I've already reached; this block has to think fresh about what they just said — don't copy the side-note, and don't parrot the hint back as thought.〕",
};

export const PHASE_TWO_THOUGHT_HINT = PHASE_TWO_THOUGHT_HINT_TEXT.zh;

/**
 * Per-call SPEECH hint — a single bracketed directive enforcing the
 * imperative-speech rule (open tag, close tag, must produce a real
 * sentence, no empty-on-close).
 *
 * History note: previously this hint also taught the inline-tool
 * format (`read_file("path")` / `list_files("path")`). Inline tools
 * were removed entirely in the 2026-05-23 sweep — Herta the actor
 * no longer reads files directly; if she needs to look at something,
 * she delegates via `@板砖`. The tool-format clause was dropped
 * from this hint at the same time.
 *
 * NEVER persisted.
 */
const PHASE_TWO_SPEECH_HINT_TEXT: Record<PromptLang, string> = {
  zh: "〔接下来是我实际说给开拓者听的话，必须以（我 说）开始，以（/我 说）结束。不能空白，不能把思考当成回答；想清楚之后，至少说出一句真正能被开拓者听见的话。〕",
  en: "〔What follows is what I say out loud to the Trailblazer. Must start with （我 说） and end with （/我 说）. It cannot be blank. Thinking is thinking, speaking is speaking — don't hand over the internal monologue as the reply. Once it's thought through, say at least one line they can actually hear.〕",
};

export const PHASE_TWO_SPEECH_HINT = PHASE_TWO_SPEECH_HINT_TEXT.zh;

/**
 * SPEECH retry hint variants, paired with the temperature ladder in
 * `actor-turn.ts`'s `recoverEmptySpeech` helper. Each variant attacks
 * the empty-output failure from a different angle:
 *
 *   - Variant 1 (base — `PHASE_TWO_SPEECH_RETRY_HINT`): names the
 *     failure mode head-on ("you closed empty, write at least one
 *     sentence — cold remark / judgement / rhetorical question all
 *     fine, blank is not"). Used at retry temperature 1.1.
 *
 *   - Variant 2 (`PHASE_TWO_SPEECH_RETRY_HINT_2`): same imperative
 *     core but redirects the model to a SPECIFIC anchor point in the
 *     user's last message — pick a concrete word/action/oddity in
 *     the user's utterance and answer THAT. Used at temp 1.2.
 *
 *   - Variant 3 (`PHASE_TWO_SPEECH_RETRY_HINT_3`): mechanical force
 *     — name the failure as model inertia, demand the model write a
 *     first character first and let the rest follow. Suggests a
 *     concrete starting hook ("用他的称呼/动词/语气当起点"). Used at
 *     temp 1.3.
 *
 * As of the 2026-05-23 inline-tool removal sweep, none of the
 * variants carry the tool-format clause — Herta the actor no longer
 * calls inline tools (see `PHASE_TWO_SPEECH_HINT`'s JSDoc).
 *
 * The array is consumed by `runPhaseTwo` via `retryAttemptIndex` so
 * the caller can pick a specific variant per attempt. Out-of-range
 * indexes fall back to the base hint (defensive).
 */
const PHASE_TWO_SPEECH_RETRY_HINT_TEXT: Record<PromptLang, string> = {
  zh: "〔接下来是我实际说给开拓者听的话，必须以（我 说）开始，以（/我 说）结束。中间不能空白，不能只留下一个漂亮的闭合符号；至少说出一句完整、有效、能被开拓者听见的话。冷评、判断、反问都可以，空白不行。〕",
  en: "〔What follows is what I say out loud to the Trailblazer. Must start with （我 说） and end with （/我 说）. Nothing blank in between, and no leaving just a tidy closing marker. At least one complete line someone can actually hear — a cold remark, a verdict, a rhetorical question, anything. Blank is not an option.〕",
};

export const PHASE_TWO_SPEECH_RETRY_HINT = PHASE_TWO_SPEECH_RETRY_HINT_TEXT.zh;

const PHASE_TWO_SPEECH_RETRY_HINT_2_TEXT: Record<PromptLang, string> = {
  zh: "〔我刚才已经重写过一次了，还是闭合得太快。这次换个角度：抓住开拓者那句话里最具体的一个点——一个词、一个动作、一个不对劲的地方——直接对它说一句。不是写感想，是正面回它一句。必须以（我 说）开始，以（/我 说）结束，中间至少要有一句完整的话能落到开拓者耳朵里。〕",
  en: "〔I already rewrote this once and still closed too fast. Different angle this time: grab the most concrete point in the Trailblazer's last line — a word, an action, something off about it — and answer exactly that. Not impressions; answer that one point head-on. Must start with （我 说） and end with （/我 说）, with at least one complete sentence in between that actually lands on the Trailblazer's ears.〕",
};

export const PHASE_TWO_SPEECH_RETRY_HINT_2 =
  PHASE_TWO_SPEECH_RETRY_HINT_2_TEXT.zh;

const PHASE_TWO_SPEECH_RETRY_HINT_3_TEXT: Record<PromptLang, string> = {
  zh: "〔连着两次都直接闭合了，这是惯性偷懒，不是没东西可说。强制开始：先写出第一个字，再顺着写下去。可以从开拓者刚才那句话里挑一个词当起点——他用了什么称呼？什么动词？什么语气？拎一个出来，借力开口。不能空白，不能只留一个标点。以（我 说）开始，写完一句完整的话再闭合（/我 说）。〕",
  en: "〔Closed empty twice in a row — that's inertia slacking off, not having nothing to say. Forced start: write the first word, then follow it. Pick one word out of what the Trailblazer just said as a starting point — what did they call me? What verb did they use? What tone? Lift one out and lean on it to get talking. Not blank, not a lone punctuation mark. Start with （我 说）, write one complete sentence, then close with （/我 说）.〕",
};

export const PHASE_TWO_SPEECH_RETRY_HINT_3 =
  PHASE_TWO_SPEECH_RETRY_HINT_3_TEXT.zh;

const PHASE_TWO_SPEECH_SLOT_RETRY_HINT_TEXT: Record<PromptLang, string> = {
  zh: "〔我刚才没说话，我写了个占位符——括号夹着一句“这儿该说什么”的说明。那是模板上给话留的空位，不是话本身；开拓者读到的会是一行括号。现在把那句话真的说出来：必须以（我 说）开始，以（/我 说）结束，中间是我对开拓者讲的原话，不是对“我该说点什么”的描述。冷评、判断、反问都可以，占位符不行。〕",
  en: "〔That wasn't speech, that was a placeholder — brackets wrapped around a note about what ought to go there. That is the blank a template leaves FOR a line, not the line; what the Trailblazer would read is a row of brackets. Now actually say it: start with （我 说）, end with （/我 说）, and in between put the words I'm saying to the Trailblazer, not a description of what I ought to say. A cold remark, a verdict, a rhetorical question — any of those. A placeholder, no.〕",
};

const PHASE_TWO_SPEECH_SLOT_RETRY_HINT_2_TEXT: Record<PromptLang, string> = {
  zh: "〔又是占位符。我大概是在想“这里该说点什么”，然后把这个念头本身写了出来——那不叫说话，那叫描述我要说话。换个走法：抓住开拓者那句话里最具体的一个点——一个词、一个动作、一个不对劲的地方——直接对它开口，第一个字就是台词。必须以（我 说）开始，以（/我 说）结束，中间不许再出现任何被括号围起来的空位。〕",
  en: "〔A placeholder again. I was presumably thinking “something goes here” and then wrote the thought itself down — that isn't speaking, that's describing that I intend to speak. Different approach: grab the most concrete point in the Trailblazer's last line — a word, an action, something off about it — and open straight at it, first character already dialogue. Start with （我 说）, end with （/我 说）, and no more bracketed blanks anywhere in between.〕",
};

const PHASE_TWO_SPEECH_SLOT_RETRY_HINT_3_TEXT: Record<PromptLang, string> = {
  zh: "〔连着两次都在写占位符，这是惯性，不是没东西可说。强制开始：从开拓者刚才那句话里挑一个词，把它抄进我的第一句里，然后顺着说下去——他用了什么称呼？什么动词？什么语气？拎一个出来，借力开口。写出来的每一个字都得是我要让他听见的话；只要开口又是个括号——大括号、尖括号、方括号都算——就是又写错了，删掉重来。以（我 说）开始，写完一句完整的话再闭合（/我 说）。〕",
  en: "〔Two placeholders in a row — that's inertia, not having nothing to say. Forced start: take one word out of what the Trailblazer just said, copy it into my first sentence, and carry on from there — what did they call me? What verb did they use? What tone? Lift one out and lean on it to get talking. Every character I write has to be something meant for them to hear; if it opens with a bracket again — curly, angle, square, any of them — it's gone wrong once more, so delete it and start over. Start with （我 说）, write one complete sentence, then close with （/我 说）.〕",
};

/**
 * Ordered array of speech retry hint variants, indexed by retry
 * attempt (0 = first retry, 1 = second, 2 = third). Aligned with
 * `EMPTY_SPEECH_RETRY_TEMPERATURES` in `actor-turn.ts` so the
 * temperature bump and hint variation step together.
 */
export const PHASE_TWO_SPEECH_RETRY_HINTS = [
  PHASE_TWO_SPEECH_RETRY_HINT,
  PHASE_TWO_SPEECH_RETRY_HINT_2,
  PHASE_TWO_SPEECH_RETRY_HINT_3,
] as const;

/**
 * SLOT retry hints — the second ladder (2026-08-12).
 *
 * The ladder above is written entirely for EMPTINESS ("闭合得太快",
 * "不能空白"), which is the wrong accusation when the model emitted a
 * template placeholder instead: it did not close early, it wrote
 * something. Reusing the empty hints there meant recovery worked by
 * RE-ROLLING rather than by correcting — the model was never told what
 * it actually did.
 *
 * So the two failures get two ladders, selected per attempt by
 * `RetryCause`. Same three-beat escalation as the empty ladder —
 * base / different-angle / mechanical forcing — but the accusation
 * names the placeholder, and variant 3 gives a concrete abort signal
 * (`{` or `<` appearing at all) rather than "don't be blank".
 *
 * The cause is recomputed after EVERY attempt, so a run that starts
 * empty and turns into a slot (or the reverse) switches ladders
 * mid-flight instead of finishing with the wrong correction.
 */
export const PHASE_TWO_SPEECH_SLOT_RETRY_HINTS = [
  PHASE_TWO_SPEECH_SLOT_RETRY_HINT_TEXT.zh,
  PHASE_TWO_SPEECH_SLOT_RETRY_HINT_2_TEXT.zh,
  PHASE_TWO_SPEECH_SLOT_RETRY_HINT_3_TEXT.zh,
] as const;

/**
 * THOUGHT retry hint variants, paired with the temperature ladder in
 * `actor-turn.ts`'s `recoverEmptyThought` helper. Same three-variant
 * structure as the speech retry hints:
 *
 *   - Variant 1 (base — `PHASE_TWO_THOUGHT_RETRY_HINT`): direct
 *     accusation ("you closed empty, write a concrete judgement").
 *     Used at retry temperature 1.1.
 *
 *   - Variant 2 (`PHASE_TWO_THOUGHT_RETRY_HINT_2`): pivot to specific
 *     anchors in the user's last message (an odd word, a suspicious
 *     tone, an inappropriate appellation, a hidden motive). Pick one
 *     and write about it. Used at temp 1.2.
 *
 *   - Variant 3 (`PHASE_TWO_THOUGHT_RETRY_HINT_3`): mechanical force
 *     — name the failure as model inertia, demand a starting phrase
 *     ("他这一句…" / "他这次问的…") so the model has something to
 *     extend. Used at temp 1.3.
 *
 * Thought hints contain no tool-format clauses — inline tools were
 * removed entirely in the 2026-05-23 sweep (see `PHASE_TWO_SPEECH_HINT`'s
 * JSDoc). Herta the actor delegates file reads via `@板砖` instead.
 *
 * Indexed by retry attempt via `runPhaseTwo`'s `retryAttemptIndex`.
 * Out-of-range indexes fall back to the base hint.
 */
const PHASE_TWO_THOUGHT_RETRY_HINT_TEXT: Record<PromptLang, string> = {
  zh: "〔我刚才直接闭合了思考段落，一句心里话都没写出来。现在重来一次：以（我 想）开始，以（/我 想）结束，中间至少要写出一句针对开拓者刚才那句话的具体判断——可以短，但不能空。上面那段旁注里的内容不是我已经想好的话，重复它不算想。这一回我必须真的过一下脑子〕",
  en: "〔That thought block closed with nothing written in it — same as not thinking at all. Again: start with （我 想）, end with （/我 想）, with at least one concrete judgment in between aimed at what the Trailblazer just said — short is fine, empty is not. The side-note above is not a conclusion I've already reached; repeating it doesn't count as thinking. This time the brain actually has to run〕",
};

export const PHASE_TWO_THOUGHT_RETRY_HINT =
  PHASE_TWO_THOUGHT_RETRY_HINT_TEXT.zh;

const PHASE_TWO_THOUGHT_RETRY_HINT_2_TEXT: Record<PromptLang, string> = {
  zh: "〔我刚才已经重试过一次，还是没写出来。换个方法：从开拓者刚才那句话里抓一个最值得我留意的点——异常的词、可疑的语气、不该出现的称呼、藏在底下的真正动机——挑一个写出来。一句话就够。以（我 想）开始，以（/我 想）结束，中间至少要有一个具体判断。上面那段旁注是方法论提示，不是我的想法，不要照抄〕",
  en: "〔Already retried once and still wrote nothing. New method: grab the one thing in the Trailblazer's last line most worth my attention — an odd word, a suspicious tone, a form of address that shouldn't be there, a motive hiding underneath — pick one and write it down. One sentence is enough. Start with （我 想）, end with （/我 想）, with at least one concrete judgment in between. The side-note above is methodology, not my thought — don't copy it〕",
};

export const PHASE_TWO_THOUGHT_RETRY_HINT_2 =
  PHASE_TWO_THOUGHT_RETRY_HINT_2_TEXT.zh;

const PHASE_TWO_THOUGHT_RETRY_HINT_3_TEXT: Record<PromptLang, string> = {
  zh: '〔连着两次空想，这是模型卡顿，不是脑子里真的没东西。强制开始：先写"他这一句……"或者"他这次问的……"当开头，接续下去。不要重复旁注的句子，不要复述方法论。给一句对当下这条消息的具体判断，写完再闭合（/我 想）〕',
  en: "〔Two empty thoughts in a row — that's the model stalling, not a genuinely empty head. Forced start: begin with （我 想）, open on \"That line of theirs...\" or \"What they're asking this time...\" and continue from there. Don't repeat the side-note's sentences, don't recite methodology. Give one concrete judgment about this exact message, then close with （/我 想）〕",
};

export const PHASE_TWO_THOUGHT_RETRY_HINT_3 =
  PHASE_TWO_THOUGHT_RETRY_HINT_3_TEXT.zh;

/**
 * Ordered array of thought retry hint variants, indexed by retry
 * attempt. Aligned with `EMPTY_SPEECH_RETRY_TEMPERATURES` (the same
 * ladder is reused for thought retries — the temperature trajectory
 * works equally well for both surfaces).
 */
export const PHASE_TWO_THOUGHT_RETRY_HINTS = [
  PHASE_TWO_THOUGHT_RETRY_HINT,
  PHASE_TWO_THOUGHT_RETRY_HINT_2,
  PHASE_TWO_THOUGHT_RETRY_HINT_3,
] as const;

const PHASE_TWO_THOUGHT_SLOT_RETRY_HINT_TEXT: Record<PromptLang, string> = {
  zh: "〔我刚才没在想，我写了个占位符——括号夹着一句“这儿该想点什么”的说明。那是模板给念头留的空位，不是念头本身。现在真的过一遍脑子：以（我 想）开始，以（/我 想）结束，中间是我对开拓者刚才那句话的具体判断，不是对“我该想点什么”的描述。短可以，占位符不行。〕",
  en: "〔That wasn't thinking, that was a placeholder — brackets wrapped around a note about what ought to go there. That is the blank a template leaves FOR a thought, not the thought. Now actually run the brain: start with （我 想）, end with （/我 想）, and in between put a concrete judgment about what the Trailblazer just said, not a description of what I ought to be thinking. Short is fine. A placeholder is not.〕",
};

const PHASE_TWO_THOUGHT_SLOT_RETRY_HINT_2_TEXT: Record<PromptLang, string> = {
  zh: "〔又是占位符。我大概是在想“这里该有个判断”，然后把这个念头本身写了下来——那不叫想，那叫描述我要想。换个走法：挑开拓者那句话里最具体的一个点——一个词、一个语气、一个不对劲的地方——直接对它下一句判断，第一个字就是想法本身。以（我 想）开始，以（/我 想）结束，中间不许再出现被括号围起来的空位。〕",
  en: "〔A placeholder again. I was presumably thinking “a judgment goes here” and then wrote that thought down instead of having one — that isn't thinking, that's describing that I intend to think. Different approach: pick the most concrete point in the Trailblazer's last line — a word, a tone, something off about it — and land a judgment directly on it, first character already the thought itself. Start with （我 想）, end with （/我 想）, and no more bracketed blanks anywhere in between.〕",
};

const PHASE_TWO_THOUGHT_SLOT_RETRY_HINT_3_TEXT: Record<PromptLang, string> = {
  zh: "〔连着两次都在写占位符，这是惯性，不是没东西可想。强制开始：从开拓者刚才那句话里挑一个词，把它抄进我的第一句里，然后顺着想下去——他用了什么称呼？什么动词？什么语气？拎一个出来，借力起念。写出来的每一个字都得是我真在过的念头；只要开口又是个括号——大括号、尖括号、方括号都算——就是又写错了，删掉重来。以（我 想）开始，写完一句完整的判断再闭合（/我 想）。〕",
  en: "〔Two placeholders in a row — that's inertia, not having nothing to think. Forced start: take one word out of what the Trailblazer just said, copy it into my first sentence, and think onward from there — what did they call me? What verb did they use? What tone? Lift one out and lean on it. Every character I write has to be a thought I am actually having; if it opens with a bracket again — curly, angle, square, any of them — it's gone wrong once more, so delete it and start over. Start with （我 想）, write one complete judgment, then close with （/我 想）.〕",
};

/**
 * The THOUGHT slot ladder (2026-08-12) — the thought-lane mirror of
 * `PHASE_TWO_SPEECH_SLOT_RETRY_HINTS`, and it exists for the same reason:
 * the empty thought hints accuse the model of closing the block with
 * nothing in it, which is false when it wrote a placeholder instead.
 *
 * A slot-only thought never reaches the user, but it is NOT harmless — it
 * lands in the record and therefore in next turn's prompt, where it reads
 * as something Herta actually thought.
 */
export const PHASE_TWO_THOUGHT_SLOT_RETRY_HINTS = [
  PHASE_TWO_THOUGHT_SLOT_RETRY_HINT_TEXT.zh,
  PHASE_TWO_THOUGHT_SLOT_RETRY_HINT_2_TEXT.zh,
  PHASE_TWO_THOUGHT_SLOT_RETRY_HINT_3_TEXT.zh,
] as const;

/**
 * Build the format-enforcement hint used when the supervisor vetoes a
 * candidate speech and the actor retries phase-2 speech. The template
 * is supplied by the caller (from `deps.hints.supervisorVetoTemplate`)
 * and carries the `{{reason}}` placeholder which is substituted with
 * the trimmed, punctuation-stripped veto reason.
 *
 * Trailing sentence-final punctuation is stripped from `reason` before
 * substitution — the hint template typically appends its own `。`, so
 * a reason already ending in `。` would produce `。。` without the strip
 * (N7 fix, 2026-05-23).
 *
 * NEVER persisted — recomputed per LLM call inside `runPhaseTwo`.
 *
 * SPEC v0.2 Supervisor design §4.6.
 */
export function buildSupervisorVetoHint(
  template: string,
  reason: string,
): string {
  const trimmed = reason.trim().replace(/[。.!?！？]+$/u, "");
  return template.split("{{reason}}").join(trimmed);
}

/**
 * Normalize a supervisor-veto reason for use as a `HertaBlock.selfCorrection`
 * value (N8/N8b, 2026-05-23). Strips trailing sentence-final punctuation
 * and trims whitespace — the serializer will wrap the result as
 * `——<text>\n\n` prose before the speech envelope, so we just want
 * the clean reason text.
 *
 * Previously this returned `自我修正：${trimmed}。` for inclusion in a
 * `→ 系统` block body (N8 first attempt). N8b dropped the system-block
 * approach in favor of a typed `selfCorrection` field on `HertaBlock`
 * that the CLI ignores and the serializer formats as plain prose.
 */
export function formatSelfCorrectionText(reason: string): string {
  return reason.trim().replace(/[。.!?！？]+$/u, "");
}

/**
 * Beat-specific format hints. Beats are in-turn reactive speech that
 * fires the moment the backend (板砖) produces a substantive event.
 * Pre-N5 (2026-05-23) all beats used the generic
 * `PHASE_TWO_SPEECH_HINT`, which says "speak now" without naming
 * what just happened — the model had to infer the trigger from the
 * record alone, and often produced bland "板砖跑完了" filler.
 *
 * Each hint below names the specific event shape (patch preview /
 * verification result / tool failure) and steers Herta toward a
 * one-line reaction with the right register. The hints sit at the
 * tail of the beat prompt, just before the `（我 说）` open tag.
 *
 * NEVER persisted — recomputed per beat call inside `makeFireBeat`.
 */
/**
 * Shared clause appended to every beat hint: beats are reactive
 * commentary while 板砖 is mid-task, NOT a slot to issue new
 * commands. Emitting `@板砖 ...` here would (a) read as Herta
 * trying to interrupt her own running task and (b) clutter the
 * record with would-be dispatches that the one-bridge-per-turn
 * cap prevents from firing anyway. The clause names the prohibition
 * explicitly so the model doesn't reach for the trigger token
 * as a reflex when narrating progress (N9, 2026-05-23 — user
 * observed Herta saying "继续，@板砖——换个名" in a tool.fail beat).
 */
const BEAT_NO_BANZHUAN_CLAUSE_TEXT: Record<PromptLang, string> = {
  zh: "不要在这一句里写 `@板砖` —— 板砖正在工作中，新任务等它做完再说，现在只点评眼前这一步。",
  en: "Do not write `@板砖` in this line. Mentioning `板砖` is fine, just without the `@` — 板砖 is mid-job right now; new tasks wait until it's done, only comment on the step at hand.",
};

export const BEAT_NO_BANZHUAN_CLAUSE = BEAT_NO_BANZHUAN_CLAUSE_TEXT.zh;

const BEAT_HINT_PATCH_PREVIEW_TEXT: Record<PromptLang, string> = {
  zh: `〔板砖刚把补丁亮在记录上方了。现在我说一句话点评：看 diff 的形状是不是干净 / 哪里值得提一嘴 / 有没有可疑的地方。不复述代码（开拓者自己能看见），不解释 diff 在做什么。短促、带判断。${BEAT_NO_BANZHUAN_CLAUSE_TEXT.zh}必须以（我 说）开始，以（/我 说）结束。〕`,
  en: `〔板砖 just laid its patch out above in the record. Toss out one line: is the diff's shape clean or messy? Which part deserves a mention, which part looks off. Don't recite the code (the Trailblazer can see it), don't explain what the diff does. Short, with a verdict. ${BEAT_NO_BANZHUAN_CLAUSE_TEXT.en} Must start with （我 说） and end with （/我 说）.〕`,
};

export const BEAT_HINT_PATCH_PREVIEW = BEAT_HINT_PATCH_PREVIEW_TEXT.zh;

const BEAT_HINT_VERIFICATION_FINISHED_TEXT: Record<PromptLang, string> = {
  zh: `〔板砖刚跑完了一步验证（测试 / 编译 / lint）。结果就在记录上方。现在我说一句话：过了就点一下，挂了就指出哪里挂了 / 可疑。不复述全部输出，不读 stack trace。短促、冷静。${BEAT_NO_BANZHUAN_CLAUSE_TEXT.zh}必须以（我 说）开始，以（/我 说）结束。〕`,
  en: `〔板砖 just finished a verification step (tests / compile / lint). The result is right above in the record. One line from me: if it passed, a quick nod; if it failed, point at where it blew up or what looks suspicious. Don't recite the full output, don't read the stack trace. Short, cool. ${BEAT_NO_BANZHUAN_CLAUSE_TEXT.en} Must start with （我 说） and end with （/我 说）.〕`,
};

export const BEAT_HINT_VERIFICATION_FINISHED =
  BEAT_HINT_VERIFICATION_FINISHED_TEXT.zh;

const BEAT_HINT_TOOL_FAIL_TEXT: Record<PromptLang, string> = {
  zh: `〔板砖刚一步失败了。失败原因写在记录上方。现在我说一句话：把失败点拎出来用人话讲（不要照搬错误信息），态度可以冷 / 嘲讽，但不要装作这事不要紧。一句话。${BEAT_NO_BANZHUAN_CLAUSE_TEXT.zh}必须以（我 说）开始，以（/我 说）结束。〕`,
  en: `〔板砖 just failed a step. The reason is written above in the record. One line from me: lift the failure point out and say it in plain words (don't parrot the error message). Cold or cutting is fine — just don't pretend it doesn't matter. One line only. ${BEAT_NO_BANZHUAN_CLAUSE_TEXT.en} Must start with （我 说） and end with （/我 说）.〕`,
};

export const BEAT_HINT_TOOL_FAIL = BEAT_HINT_TOOL_FAIL_TEXT.zh;

/**
 * The full set of language-selectable actor hint texts (EN interaction
 * slice 3b). Shape mirrors `ActorHints` in `actor-hints.ts` minus
 * `supervisorVetoTemplate` (that default lives there), plus the shared
 * `beatNoBanzhuanClause`. At `lang: "zh"` every field is byte-identical
 * to the corresponding exported const above. This is the slice-4 hookup
 * point for building an EN default-hint set.
 */
export interface ActorHintTexts {
  readonly thoughtHintLine: string;
  readonly phase2Thought: string;
  readonly phase2Speech: string;
  readonly speechRetry: readonly [string, string, string];
  /** The SLOT ladder — used when the failing attempt emitted a template
   *  placeholder rather than nothing (2026-08-12). */
  readonly speechSlotRetry: readonly [string, string, string];
  readonly thoughtRetry: readonly [string, string, string];
  /** The thought-lane SLOT ladder — same split, same reason (2026-08-12). */
  readonly thoughtSlotRetry: readonly [string, string, string];
  readonly beatNoBanzhuanClause: string;
  readonly beatPatchPreview: string;
  readonly beatVerification: string;
  readonly beatToolFail: string;
}

export function actorHintTexts(lang: PromptLang = "zh"): ActorHintTexts {
  return {
    thoughtHintLine: THOUGHT_HINT_LINE_TEXT[lang],
    phase2Thought: PHASE_TWO_THOUGHT_HINT_TEXT[lang],
    phase2Speech: PHASE_TWO_SPEECH_HINT_TEXT[lang],
    speechRetry: [
      PHASE_TWO_SPEECH_RETRY_HINT_TEXT[lang],
      PHASE_TWO_SPEECH_RETRY_HINT_2_TEXT[lang],
      PHASE_TWO_SPEECH_RETRY_HINT_3_TEXT[lang],
    ],
    speechSlotRetry: [
      PHASE_TWO_SPEECH_SLOT_RETRY_HINT_TEXT[lang],
      PHASE_TWO_SPEECH_SLOT_RETRY_HINT_2_TEXT[lang],
      PHASE_TWO_SPEECH_SLOT_RETRY_HINT_3_TEXT[lang],
    ],
    thoughtRetry: [
      PHASE_TWO_THOUGHT_RETRY_HINT_TEXT[lang],
      PHASE_TWO_THOUGHT_RETRY_HINT_2_TEXT[lang],
      PHASE_TWO_THOUGHT_RETRY_HINT_3_TEXT[lang],
    ],
    thoughtSlotRetry: [
      PHASE_TWO_THOUGHT_SLOT_RETRY_HINT_TEXT[lang],
      PHASE_TWO_THOUGHT_SLOT_RETRY_HINT_2_TEXT[lang],
      PHASE_TWO_THOUGHT_SLOT_RETRY_HINT_3_TEXT[lang],
    ],
    beatNoBanzhuanClause: BEAT_NO_BANZHUAN_CLAUSE_TEXT[lang],
    beatPatchPreview: BEAT_HINT_PATCH_PREVIEW_TEXT[lang],
    beatVerification: BEAT_HINT_VERIFICATION_FINISHED_TEXT[lang],
    beatToolFail: BEAT_HINT_TOOL_FAIL_TEXT[lang],
  };
}
