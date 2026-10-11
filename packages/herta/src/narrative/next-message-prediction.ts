import type {
  CompletionProviderAdapter,
  SystemBlock,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import { STOP_CLOSER_USER, STOP_OPENER_USER } from "./actor-turn-stream.js";
import { buildCompactionBody } from "./compact-record.js";
import { parseHertaBlock } from "./parse.js";
import type { PromptLang } from "./prompt-lang.js";
import { serializeBlock } from "./serialize.js";

/**
 * Composer predictions (owner 2026-10-10, after Codex's): once Herta has
 * finished a reply, guess the Trailblazer's NEXT message, for the composer to
 * offer as a suggestion the user can take with Tab or ignore by typing.
 *
 * WHAT IT READS — the last few turns, with guidance (owner 2026-10-10: "we
 * do not need to send herta's prefix prompt … just last few 大黑塔 and 开拓者's
 * turns plus banzhuan compressed turn with guidance"). A short frame says who
 * is who; then the window from the Trailblazer's `RECENT_TURNS`-th last
 * message on, in the record's own grammar (D8): their messages, Herta's
 * spoken replies (each cut to its last `MAX_REPLY_CHARS`), and each run of
 * 板砖's rows folded into the actor's own compact digest
 * (`buildCompactionBody`, its last `MAX_RUN_LINES` lines); then the voice
 * note; then the open `（开拓者 说）` the model completes. No static prefix,
 * no thoughts. The first build re-sent Herta's whole prompt (~31 000 tokens,
 * nearly all cache hits); its bio, lore and few-shot dialogue were where the
 * inventions came from (「板砖上次那个补丁跑完了吗？」 on a fresh session).
 *
 * TWO PROMPTS (owner 2026-10-11: "split the banzhuan case and normal case").
 * A window with 板砖 in it — a run of his rows, or a message that called
 * him — gets the WORK prompt, which explains `→ 差分协处理器` and @板砖 and
 * points at his next step. Any other window gets the CHAT prompt, which
 * never names him, and a chat line that calls him is dropped: told about
 * 板砖, the model reached for `@板砖` in plain talk, where no one would.
 *
 * WHEN THERE IS NOTHING TO GO ON — a single message and no work of 板砖's
 * (「在吗？」 / 「在。」) — there is no prediction: the model can only invent
 * the request it has not been told.
 *
 * THE VOICE (owner 2026-10-10: "should sounds like 开拓者 talking to 大黑塔")
 * is described from the game's own scripts (data/plot_html, scanned
 * 2026-10-11) — see `VOICE` — not quoted from them.
 *
 * WHAT IT NEVER DOES. The prediction is user-side composer chrome (D7): it
 * never enters the record, and Herta never sees it unless the user sends it,
 * when it is simply their message. It is never sent on its own.
 */

/** Which prompt a window gets: `work` when 板砖 is in it, `chat` when not. */
export type PredictionMode = "work" | "chat";

/** Who is who, before the recent turns. NEVER persisted. */
export const PREDICTION_FRAME: Record<
  PredictionMode,
  Record<PromptLang, string>
> = {
  work: {
    zh: "〔下面是开拓者和大黑塔在终端里最近几轮的对话：（开拓者 说）是开拓者打的话，（我 说）是大黑塔说的话，→ 差分协处理器 是板砖干活的摘要。开拓者要板砖动手干活时，会在话里写 @板砖。〕",
    en: "〔Below are the last few turns between the Trailblazer and the Herta in the terminal: （开拓者 说） is what the Trailblazer typed, （我 说） is what the Herta said, and → 差分协处理器 is a digest of what 板砖 did. When the Trailblazer wants 板砖 to do the work, they write @板砖 in the line.〕",
  },
  chat: {
    zh: "〔下面是开拓者和大黑塔在终端里最近几轮的对话：（开拓者 说）是开拓者打的话，（我 说）是大黑塔说的话。〕",
    en: "〔Below are the last few turns between the Trailblazer and the Herta in the terminal: （开拓者 说） is what the Trailblazer typed, and （我 说） is what the Herta said.〕",
  },
};

/**
 * How the Trailblazer talks to her, described from the game's scripts
 * (data/plot_html, scanned 2026-10-11): ~20 700 dialogue choices and 2 588
 * spoken lines, median 9 characters, a quarter of them questions and an
 * eighth trailing off in 「…」. The 247 distinct lines said to 黑塔 echo a
 * word of hers back as a question, deadpan a jab or puncture her boasting,
 * fake-flatter her as 「黑塔大人」, blurt something absurd, or angle for a
 * reward — and call her plain 「黑塔」, or nothing; 「黑塔女士」 is how
 * others speak of her, and 「大黑塔」 never comes up. Fans read the same:
 * dry wit in sudden moments, the blunt 「啊？」, sarcasm toward the pompous.
 */
const VOICE: Record<PromptLang, string> = {
  zh: "开拓者话少，常常就是个问句：抓住她话里的一个词反问回去，面无表情地呛她一句、拆她的台，偶尔假意捧一声「黑塔大人」，偶尔冒出一句不着边际的怪话，或者顺手讨点好处。叫她就叫「黑塔」，多数时候不带称呼。",
  en: 'The Trailblazer says little, often just a question: they pick a word out of what she said and throw it back, deadpan a jab or puncture her boasting, now and then fake-flatter her, blurt out something absurd, or angle for a reward. They call her "Herta", and mostly use no address at all.',
};

/** What the line is for, per prompt. */
const LEAD: Record<PredictionMode, Record<PromptLang, string>> = {
  work: {
    zh: "接下来是开拓者在终端里打给大黑塔的下一句，一句话。多半是让板砖接着做下一步（就像平时一样写 @板砖，把活交代清楚），或者回她刚才那句；只提上面真实出现过的文件、命令和结果，不编造没发生过的事。",
    en: "What follows is the Trailblazer's next line to the Herta, typed into the terminal: one line. Most likely the next step for 板砖 (they write @板砖 as usual and say what to do), or an answer to her last line; mention only files, commands and results that actually appear above, and invent nothing that did not happen.",
  },
  chat: {
    zh: "接下来是开拓者在终端里打给大黑塔的下一句，一句，十来个字。多半是接她刚才那句：顺着问一句、随口答一句，或者呛她一句；只接上面聊过的话，不编造没发生过的事。",
    en: "What follows is the Trailblazer's next line to the Herta, typed into the terminal: one line, about ten words. Most likely it picks up her last line: a follow-up question, an offhand answer, or a jab; keep to what was said above, and invent nothing that did not happen.",
  },
};

const CLOSE: Record<PromptLang, string> = {
  zh: "不复述说过的话，不替大黑塔说话。",
  en: "Don't repeat what was already said, and don't speak for the Herta.",
};

const hint = (mode: PredictionMode): Record<PromptLang, string> => ({
  zh: `〔${LEAD[mode].zh}${VOICE.zh}${CLOSE.zh}〕`,
  en: `〔${LEAD[mode].en} ${VOICE.en} ${CLOSE.en}〕`,
});

/** The note before the opened `（开拓者 说）`. NEVER persisted. */
export const PREDICTION_HINT: Record<
  PredictionMode,
  Record<PromptLang, string>
> = { work: hint("work"), chat: hint("chat") };

/** How many of the Trailblazer's messages the prediction reads back. */
export const RECENT_TURNS = 3;
/** A reply longer than this keeps only its end — what she said last is what
 *  the next line answers. Messages are kept whole up to the same bound. */
export const MAX_REPLY_CHARS = 400;
/** A 板砖 run's digest keeps its header and its last lines: what it did last
 *  is what the next line follows. */
export const MAX_RUN_LINES = 12;
/** A typed line is short: anything longer is the model writing a speech. */
const MAX_PREDICTION_CHARS = 60;
/** A cap on the completion; a well-formed line closes far below it. */
const PREDICTION_MAX_TOKENS = 80;
/** The likely line, not an inventive one: a live check (2026-10-10) at the
 *  default had the Trailblazer recall typos and errands that never happened. */
const PREDICTION_TEMPERATURE = 0.5;
/** Zero-width characters — the serializer breaks `@板砖` in user text with
 *  one, and the model copies what it reads. */
const ZERO_WIDTH = /[​-‍⁠﻿]/g;

export interface PredictionDeps {
  readonly provider: CompletionProviderAdapter;
  readonly model: string;
  /** The record as the turn left it, ending on Herta's speech. */
  readonly record: TerminalRecord;
  readonly lang: PromptLang;
}

/** `text` cut to its last `max` characters, marked as cut. */
function tail(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `…${chars.slice(-max).join("")}`;
}

export interface PredictionPrompt {
  readonly mode: PredictionMode;
  readonly text: string;
}

/**
 * The prediction's whole prompt and which one it is, or null when the
 * record holds nothing to go on. Pure.
 */
export function predictionPrompt(
  record: TerminalRecord,
  lang: PromptLang,
): PredictionPrompt | null {
  // The window opens at the Trailblazer's RECENT_TURNS-th last message.
  let start = -1;
  let messages = 0;
  for (let i = record.length - 1; i >= 0 && messages < RECENT_TURNS; i--) {
    if (record[i]?.kind === "user") {
      start = i;
      messages += 1;
    }
  }
  if (start < 0) return null;
  const picked: TerminalRecordBlock[] = [];
  let run: SystemBlock[] = [];
  let runs = 0;
  let called = false;
  const fold = (): void => {
    if (run.length === 0) return;
    const lines = buildCompactionBody(run, lang).split("\n");
    run = [];
    if (lines.join("").trim().length === 0) return;
    const kept =
      lines.length <= MAX_RUN_LINES
        ? lines
        : [lines[0] ?? "", "…", ...lines.slice(-(MAX_RUN_LINES - 1))];
    picked.push({
      kind: "system",
      label: "差分协处理器",
      body: kept.join("\n"),
    });
    runs += 1;
  };
  for (const b of record.slice(start)) {
    if (b.kind === "system") {
      run.push(b);
      continue;
    }
    fold();
    if (b.kind === "user" || (b.kind === "herta" && b.surface === "speech"))
      picked.push({ ...b, text: tail(b.text, MAX_REPLY_CHARS) });
    if (b.kind === "user" && parseHertaBlock(b.text).hasBanzhuanTrigger)
      called = true;
  }
  fold();
  // Nothing to continue from: one message, and no work of 板砖's.
  if (messages < 2 && runs === 0) return null;
  const mode: PredictionMode = runs > 0 || called ? "work" : "chat";
  const turns = picked.map((b) => serializeBlock(b)).join("\n\n");
  return {
    mode,
    text: `${PREDICTION_FRAME[mode][lang]}\n\n${turns}\n\n${PREDICTION_HINT[mode][lang]}\n${STOP_OPENER_USER}\n`,
  };
}

/**
 * The Trailblazer's likely next message, or null when there is nothing worth
 * offering (no message to go on, the model skipped it, or the line failed
 * `acceptPrediction`). Rejects only with the caller's abort; a provider
 * failure is null.
 */
export async function predictNextUserMessage(
  deps: PredictionDeps,
  signal: AbortSignal,
): Promise<string | null> {
  const prompt = predictionPrompt(deps.record, deps.lang);
  if (prompt === null) return null;
  let text = "";
  try {
    for await (const ev of deps.provider.streamCompletion(
      {
        model: deps.model,
        prompt: prompt.text,
        // The Trailblazer's close ends the line; Herta's next block, or a
        // second Trailblazer block, means the model ran past it.
        stop: [STOP_CLOSER_USER, STOP_OPENER_USER, "（我 说）", "（我 想）"],
        maxTokens: PREDICTION_MAX_TOKENS,
        temperature: PREDICTION_TEMPERATURE,
      },
      signal,
    )) {
      if (ev.type === "text-delta") text += ev.text;
      else if (ev.type === "finish") break;
    }
  } catch (err) {
    if (signal.aborted) throw err;
    return null;
  }
  if (signal.aborted) return null;
  return acceptPrediction(text, deps.record, prompt.mode);
}

/**
 * The line as the composer would show it, or null when it is no message a
 * user would type: empty, more than one line, too long, a tag or hint the
 * model echoed, an action or thought in brackets (「（展示照片）」), a
 * placeholder with no word in it (「xxx」, 「……」), one of the user's last
 * messages again, or — in plain talk — a call to 板砖.
 * Pure.
 */
export function acceptPrediction(
  raw: string,
  record: TerminalRecord,
  mode: PredictionMode,
): string | null {
  let text = raw.replace(ZERO_WIDTH, "");
  // A stop the provider streamed past: keep what came before any tag.
  const tag = text.search(/（\/|（我 |（开拓者 /);
  if (tag >= 0) text = text.slice(0, tag);
  text = text.trim();
  if (text.length === 0) return null;
  if (/[\r\n]/.test(text)) return null;
  if ([...text].length > MAX_PREDICTION_CHARS) return null;
  if (/[〔〕]/.test(text)) return null;
  if (/^[（(［[【].*[）)］\]】]$/.test(text)) return null;
  // A placeholder, not a line: no word at all, or one letter run (「xxx」,
  // seen live 2026-10-11).
  if (!/[\p{L}\p{N}]/u.test(text) || /^([a-z])\1+$/i.test(text)) return null;
  if (mode === "chat" && parseHertaBlock(text).hasBanzhuanTrigger) return null;
  // A message the window already holds, @板砖 or not (seen live 2026-10-11:
  // the hello.mjs request offered back without its call).
  const line = sameLine(text);
  if (
    record
      .filter((b) => b.kind === "user")
      .slice(-RECENT_TURNS)
      .some((b) => sameLine(b.text) === line)
  )
    return null;
  return text;
}

/** A message as compared for a repeat: no call, no break, one space. */
function sameLine(text: string): string {
  return text
    .replace(ZERO_WIDTH, "")
    .replaceAll("@板砖", "")
    .replace(/\s+/g, " ")
    .trim();
}
