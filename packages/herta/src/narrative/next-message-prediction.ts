import type {
  CompletionProviderAdapter,
  SystemBlock,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import { STOP_CLOSER_USER, STOP_OPENER_USER } from "./actor-turn-stream.js";
import { buildCompactionBody } from "./compact-record.js";
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
 * WHEN THERE IS NOTHING TO GO ON — a single message and no work of 板砖's
 * (「在吗？」 / 「在。」) — there is no prediction: the model can only invent
 * the request it has not been told.
 *
 * THE VOICE (owner 2026-10-10): the line should sound like 开拓者 talking to
 * 大黑塔. The game's scripts (data/plot_html) hold only a couple of dozen
 * lines the player says to her — too few to quote from — so the note
 * describes the voice the game gives the Trailblazer instead: brief, direct,
 * deadpan, now and then absurd or teasing.
 *
 * WHAT IT NEVER DOES. The prediction is user-side composer chrome (D7): it
 * never enters the record, and Herta never sees it unless the user sends it,
 * when it is simply their message. It is never sent on its own.
 */

/** Who is who, before the recent turns. NEVER persisted. */
export const PREDICTION_FRAME: Record<PromptLang, string> = {
  zh: "〔下面是开拓者和大黑塔在终端里最近几轮的对话：（开拓者 说）是开拓者打的话，（我 说）是大黑塔说的话，→ 差分协处理器 是板砖干活的摘要。开拓者要板砖动手干活时，会在话里写 @板砖。〕",
  en: "〔Below are the last few turns between the Trailblazer and the Herta in the terminal: （开拓者 说） is what the Trailblazer typed, （我 说） is what the Herta said, and → 差分协处理器 is a digest of what 板砖 did. When the Trailblazer wants 板砖 to do the work, they write @板砖 in the line.〕",
};

/** The note before the opened `（开拓者 说）`. NEVER persisted. */
export const PREDICTION_HINT: Record<PromptLang, string> = {
  zh: "〔接下来是开拓者对大黑塔说的下一句，也就是开拓者会在终端里打下的那句话。多半是对大黑塔刚才那句的简短回应，或者让板砖接着做下一步；只提上面对话里真实出现过的东西（文件、命令、结果），不编造没发生过的事。一句，二十来个字以内。开拓者说话随性，有时冷不丁来句玩笑或调侃，叫她「大黑塔」或「黑塔女士」；要动手干活时，就像平时一样 @板砖。不复述说过的话，不替大黑塔说话。〕",
  en: '〔What follows is the Trailblazer\'s next line to the Herta — the one they would type into the terminal next. Most likely a short answer to what she just said, or the next step for 板砖; mention only things that actually appear above (files, commands, results), and invent nothing that did not happen. One line, about fifteen words at most. The Trailblazer talks casually, now and then with a deadpan joke or a tease, and calls her "Herta" or "Madam Herta"; when something needs doing, they @板砖 as usual. Don\'t repeat what was already said, and don\'t speak for the Herta.〕',
};

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

/**
 * The prediction's whole prompt, or null when the record holds no message of
 * the Trailblazer's to go on. Pure.
 */
export function predictionPrompt(
  record: TerminalRecord,
  lang: PromptLang,
): string | null {
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
  }
  fold();
  // Nothing to continue from: one message, and no work of 板砖's.
  if (messages < 2 && runs === 0) return null;
  const turns = picked.map((b) => serializeBlock(b)).join("\n\n");
  return `${PREDICTION_FRAME[lang]}\n\n${turns}\n\n${PREDICTION_HINT[lang]}\n${STOP_OPENER_USER}\n`;
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
        prompt,
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
  return acceptPrediction(text, deps.record);
}

/**
 * The line as the composer would show it, or null when it is no message a
 * user would type: empty, more than one line, too long, a tag or hint the
 * model echoed, an action or thought in brackets (「（展示照片）」), or the
 * last thing the user already said. Pure.
 */
export function acceptPrediction(
  raw: string,
  record: TerminalRecord,
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
  const lastUser = [...record].reverse().find((b) => b.kind === "user");
  if (
    lastUser !== undefined &&
    lastUser.text.replace(ZERO_WIDTH, "").trim() === text
  )
    return null;
  return text;
}
