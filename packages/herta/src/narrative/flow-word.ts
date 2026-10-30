import type { CompletionProviderAdapter, ProviderAdapter } from "@herta/core";
import { sanitizeActorText } from "./escape.js";
import { promptAssetsFor } from "./prompt-assets.js";
import type { PromptLang } from "./prompt-lang.js";
import { STOP_SPEECH_CLOSE } from "./thought-hint.js";

/**
 * Herta's word on one Flow post (ADR 0084 §7, amended 2026-10-30): her own
 * narrative completion (D8) in a frame of Flow's own, compiled from
 * `prompts/flow/word.txt` (zh) and `prompts-en/flow/word.txt` (en) — the
 * broadcast scene, then worked examples in her block grammar, then this
 * post and an open `（我 说）`.
 *
 * Not her conversation prefix. The owner found her comments "weird", and
 * the lab showed why: with the prefix a post read as a task pushed to her
 * (「这种条目就别推给我了」, orders to 板砖), she invented figures, and she ran
 * on for paragraphs — the predictions' lesson again (ADR 0076). A
 * description alone left the shape to chance; the examples fix it, as her
 * 废案 few-shots shape her turns.
 *
 * The word is checked before it is shown. By code: a label prefix or a
 * wrapping bracket is stripped; a list, an aside, a link, an empty or an
 * overlong word is refused; every number in it must appear in the post.
 * Then by Flow's own judge (`prompts/flow/judge.txt`), which lists each
 * factual claim against the post and reads the voice. Either failing: one
 * retry, then no word at all. Never a fallback text in her name.
 *
 * Display only: the word never dispatches. `@板砖` in it is made inert, as
 * a quoted title or a pick is.
 */

/** The post as her frame shows it. */
export interface FlowWordPost {
  readonly title: string;
  readonly site: string;
  readonly date: string | null;
  readonly summary: string;
  readonly why: string;
}

export interface FlowWordDeps {
  readonly provider: CompletionProviderAdapter;
  readonly model: string;
  readonly lang: PromptLang;
  /** Flow's judge on a candidate word; absent → code checks only. */
  readonly judge?: FlowWordJudge;
}

export type FlowWordJudge = (
  word: string,
  post: FlowWordPost,
  signal: AbortSignal,
) => Promise<boolean>;

/** A backstop: the close mark or a blank line ends a word long before. */
const WORD_MAX_TOKENS = 160;
/** About two sentences. */
const MAX_WORD_CHARS: Record<PromptLang, number> = { zh: 80, en: 220 };
const ATTEMPTS = 2;
/** A word is one paragraph: a blank line, or the next record block, ends it. */
const STOPS = [STOP_SPEECH_CLOSE, "（/我 想）", "\n→", "\n###", "\n\n"];

/** The whole prompt: Flow's frame with its examples, then this post. */
export function flowWordPrompt(post: FlowWordPost, lang: PromptLang): string {
  const frame = (promptAssetsFor(lang).flow.word ?? "").trimEnd();
  const when = post.date !== null ? ` · ${post.date.slice(0, 10)}` : "";
  const item =
    lang === "en"
      ? `→ Broadcast: ${post.title} (${post.site}${when})\n${post.summary}\nWhy the Trailblazer: ${post.why}`
      : `→ 播报：${post.title}（${post.site}${when}）\n${post.summary}\n和开拓者的关系：${post.why}`;
  return `${frame}\n\n${item}\n\n（我 说）\n`;
}

/** A label the model sometimes writes before the word, and brackets it
 *  sometimes wraps the word in (lab 2026-10-30). */
const LABEL =
  /^(?:她批|黑塔批|大黑塔批|批注|批|她说|黑塔|大黑塔|Herta|The Herta|Remark)[：:]\s*/iu;
const WRAP = /^[【[「“"](.*)[】\]」”"]$/su;

/** The word as it may be shown, or why it may not. */
export function normalizeFlowWord(
  raw: string,
  post: FlowWordPost,
  lang: PromptLang,
):
  | { readonly ok: true; readonly word: string }
  | {
      readonly ok: false;
      readonly why: "empty" | "list" | "aside" | "too_long" | "link" | "number";
    } {
  let word = sanitizeActorText(raw.trim(), { role: "speech" })
    .trim()
    .replace(LABEL, "")
    .trim();
  const wrapped = WRAP.exec(word);
  if (wrapped !== null) word = (wrapped[1] ?? "").trim();
  if (word.length === 0) return { ok: false, why: "empty" };
  if (/^[-*•]|\n\s*[-*•]|\n[^\n]*[：:]\s*\S/u.test(word))
    return { ok: false, why: "list" };
  if (/^[（(].*[)）]$/su.test(word)) return { ok: false, why: "aside" };
  word = word
    .replace(/\s*\n\s*/g, lang === "en" ? " " : "")
    // 「？。」: a question the model then also closed (lab 2026-10-30).
    .replace(/([？！?!])[。.]/gu, "$1");
  if (Array.from(word).length > MAX_WORD_CHARS[lang])
    return { ok: false, why: "too_long" };
  if (/https?:\/\/|www\./i.test(word)) return { ok: false, why: "link" };
  const card = [post.title, post.summary, post.why, post.site, post.date ?? ""]
    .join("\n")
    .toLowerCase();
  for (const n of word.match(/\d+(?:[.,:]\d+)*%?/g) ?? []) {
    if (!card.includes(n.toLowerCase())) return { ok: false, why: "number" };
  }
  return { ok: true, word };
}

/** `@板砖` and `@brick` broken by a zero-width space: shown, never a token. */
export function inertFlowWord(word: string): string {
  return word.replace(/@(?=板砖|brick)/giu, "@​");
}

/**
 * Her word on the post, or null when no candidate passed in `ATTEMPTS`
 * tries. Rejects only with the caller's abort; a provider failure is null.
 */
export async function hertaWordOn(
  post: FlowWordPost,
  deps: FlowWordDeps,
  signal: AbortSignal,
): Promise<string | null> {
  const prompt = flowWordPrompt(post, deps.lang);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    let text = "";
    try {
      for await (const ev of deps.provider.streamCompletion(
        { model: deps.model, prompt, stop: STOPS, maxTokens: WORD_MAX_TOKENS },
        signal,
      )) {
        if (ev.type === "text-delta") text += ev.text;
        else if (ev.type === "finish") {
          if (ev.reason === "error") throw new Error("completion failed");
          break;
        }
      }
    } catch (err) {
      if (signal.aborted) throw err;
      return null;
    }
    const checked = normalizeFlowWord(text, post, deps.lang);
    if (!checked.ok) continue;
    if (
      deps.judge !== undefined &&
      !(await deps.judge(checked.word, post, signal))
    )
      continue;
    return inertFlowWord(checked.word);
  }
  return null;
}

/**
 * Flow's judge (`prompts/flow/judge.txt`): it lists each factual claim in
 * her word against the post, then reads the voice, and ends on OK or
 * BLOCK. Run where her supervisor runs — flash, reasoning on: with
 * reasoning off it passed 「论文里都写着」 and 「修了几个 bug」, which no post
 * said (lab 2026-10-30). Fail-soft on a provider failure, like her
 * supervisor: the code checks have already read the word. An abort rejects.
 */
export function flowWordJudge(deps: {
  readonly provider: ProviderAdapter;
  readonly lang: PromptLang;
}): FlowWordJudge {
  const system = promptAssetsFor(deps.lang).flow.judge ?? "";
  return async (word, post, signal) => {
    const item =
      deps.lang === "en"
        ? `Item: ${post.title} (${post.site}${post.date !== null ? ` · ${post.date.slice(0, 10)}` : ""})\n${post.summary}\n\nRemark: ${word}`
        : `条目：${post.title}（${post.site}${post.date !== null ? ` · ${post.date.slice(0, 10)}` : ""}）\n${post.summary}\n\n批注：${word}`;
    let out = "";
    try {
      for await (const ev of deps.provider.streamChat(
        {
          stableSystem: system,
          memoryContext: "",
          retrievedLore: "",
          messages: [
            { role: "user", text: item, ts: new Date(0).toISOString() },
          ],
          toolSchemas: [],
        },
        signal,
      )) {
        if (ev.type === "text-delta") out += ev.text;
        else if (ev.type === "finish") break;
      }
    } catch (err) {
      if (signal.aborted) throw err;
      return true;
    }
    return flowJudgeVerdict(out);
  };
}

/** The judge's last non-empty line: OK passes; anything else blocks. */
export function flowJudgeVerdict(out: string): boolean {
  const last = out
    .trim()
    .split("\n")
    .map((l) => l.replace(/[*_`#]/g, "").trim())
    .filter((l) => l.length > 0)
    .at(-1);
  return last === "OK";
}
