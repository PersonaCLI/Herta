import { mapOutsideQuotation, quotationRanges } from "@herta/core";

/**
 * Structured view of a Herta-authored finalized block.
 *
 * `text` is the original input string, unmodified. As of the
 * 2026-05-23 inline-tool removal sweep, the actor no longer carries
 * any inline tools — `parseHertaBlock` only looks for the `@板砖`
 * backend-dispatch trigger token.
 *
 * Historical note: earlier versions extracted `read_file("…")` /
 * `list_files("…")` inline calls into a `inlineCalls` field. Those
 * tools were removed because the model occasionally hallucinated
 * calls against non-existent paths during casual conversation,
 * breaking the dialogue surface. File reads and directory listings
 * are now delegated to the backend via `@板砖`.
 */
export interface ParsedHertaBlock {
  readonly text: string;
  readonly hasBanzhuanTrigger: boolean;
}

const BANZHUAN_TRIGGER = "@板砖";

/**
 * A `@板砖` inside quotation is a mention, not a dispatch: a `…` inline
 * code span (single backticks, no inner backtick) — this keeps the
 * supervisor §8 backtick exemption factually true (2026-06-11 trigger
 * discipline) — and, since 2026-10-21, a CLOSED fenced code block
 * (`quotationRanges`, ADR 0078 amendment 2026-10-21): a quoted file
 * passage holding `` `@板砖` `` dispatched 板砖 by itself, because inside a
 * fence the span rule mis-paired. Unpaired backticks form no span and an
 * unclosed fence quotes nothing, so the text after them still counts as
 * outside.
 */
export function parseHertaBlock(text: string): ParsedHertaBlock {
  // Quotation is replaced with a space, not deleted: deleting would
  // splice the surrounding text and could fabricate a trigger that was
  // never in the input (e.g. "@`x`板砖").
  let outside = "";
  let last = 0;
  for (const [s, e] of quotationRanges(text)) {
    outside += `${text.slice(last, s)} `;
    last = e;
  }
  outside += text.slice(last);
  return { text, hasBanzhuanTrigger: outside.includes(BANZHUAN_TRIGGER) };
}

/** Replace every `@板砖` OUTSIDE quotation; quotation passes through. */
function replaceBareTrigger(text: string, replacement: string): string {
  return mapOutsideQuotation(text, (seg) =>
    seg.split(BANZHUAN_TRIGGER).join(replacement),
  );
}

/**
 * Make every dispatch-effective `@板砖` inert while keeping it VISIBLE:
 * wrap it in backticks — `` `@板砖` `` — the record's established
 * quotation form (a code-span token never dispatches: this parser, the
 * composer, supervisor §8, and the 废案 essays she reads all treat it
 * so). Occurrences already inside inline code spans are untouched.
 *
 * Until 2026-08-17 this stripped the `@` (`@板砖` → `板砖`). The owner
 * read the result on screen — "要我就 板砖 再开一轮。" — and it reads
 * broken: the sentence needs the @ to mean "the @-call". The bare token
 * must not stay (bare `@板砖` in her own speech IS the dispatch contract
 * the record and Herta both read; an un-fired one is the shape the ADR
 * 0036 fabrication chain starts from, and the GUI chip would claim a
 * call that never happened), so the visible-but-inert form is the
 * quoted one: the bubble shows `@板砖` in monospace instead of the chip,
 * the record and the CLI keep the backticks, and what she reads back is
 * a mention, not a call.
 *
 * Fallback: if the speech already carries an UNPAIRED backtick, wrapping
 * would mis-pair spans (`` `abc `@板砖` def `` — the first span closes on
 * our opening tick and the token is bare again). Detected by re-parsing:
 * when one wrapping pass does not leave the text trigger-free, the old
 * `板砖` form is used on the ORIGINAL text instead — always inert, just
 * not pretty, and only on already-malformed speech.
 *
 * Both forms are checked to a fixed point, because a single replacement
 * pass can FABRICATE a live trigger from its own seam (`@@板砖` →
 * `@板砖`), which would dispatch the backend for exactly the sentence the
 * judge just ruled non-dispatch. Postcondition either way:
 * `parseHertaBlock(result).hasBanzhuanTrigger === false`.
 */
export function neutralizeBanzhuanTrigger(text: string): string {
  if (!parseHertaBlock(text).hasBanzhuanTrigger) return text;
  const quoted = replaceBareTrigger(text, "`@板砖`");
  if (!parseHertaBlock(quoted).hasBanzhuanTrigger) return quoted;
  // Mis-paired backticks (or a seam-fabricated token): fall back to the
  // strip-the-@ form, iterated to a fixed point.
  let result = text;
  while (parseHertaBlock(result).hasBanzhuanTrigger) {
    const next = replaceBareTrigger(result, "板砖");
    if (next === result) break; // defensive; predicate ⇒ replaceable
    result = next;
  }
  return result;
}

/**
 * Remove every dispatch-effective `@板砖`, leaving occurrences inside
 * inline code spans untouched. Used by the user-typed pre-empt
 * (actor-turn SPEC §7) to form the backend brief: the bare trigger
 * token is not part of the task, but a backticked quotation of it is.
 * Iterated to a fixed point for the same seam-fabrication reason as
 * `neutralizeBanzhuanTrigger` (`@板` + `@板砖` + `砖` re-splices).
 */
export function stripBanzhuanTrigger(text: string): string {
  let result = text;
  while (parseHertaBlock(result).hasBanzhuanTrigger) {
    const next = replaceBareTrigger(result, "");
    if (next === result) break; // defensive; predicate ⇒ replaceable
    result = next;
  }
  return result;
}

/** Whether the character at `i` ends a sentence: 。！？ always, `!` and `?`
 *  before a space (`if (!x)` goes on), and a line break unless a colon leads
 *  into the next line. A semicolon joins clauses of one sentence. */
function endsSentence(text: string, i: number): boolean {
  const c = text[i];
  if (c === "。" || c === "！" || c === "？") return true;
  if (c === "!" || c === "?") return /\s/.test(text[i + 1] ?? " ");
  return c === "\n" && text[i - 1] !== "：" && text[i - 1] !== ":";
}

/**
 * The sentences of her speech that carry a live `@板砖` — what reaches the
 * running 板砖 when she writes one during a run (ADR 0085 §4; owner
 * 2026-11-04: "the sentence with @板砖", not the whole reply, so her talk to
 * the Trailblazer stays out of 板砖's run). Quotation is read over the whole
 * speech (review 2026-11-05): cut first, a fence or a code span opened in one
 * piece and closed in another quoted nothing, and the `@板砖` inside went out
 * as an instruction. Nothing inside quotation ends a sentence or carries a
 * call. A sentence that is only the token runs on to what it is for. Joined
 * as she wrote them; empty when none does.
 */
export function banzhuanSentences(text: string): string {
  const ranges = quotationRanges(text);
  const quoted = (i: number): boolean =>
    ranges.some(([start, end]) => i >= start && i < end);
  const calls = (from: number, to: number): boolean => {
    let at = text.indexOf(BANZHUAN_TRIGGER, from);
    while (at !== -1 && at < to) {
      if (!quoted(at)) return true;
      at = text.indexOf(BANZHUAN_TRIGGER, at + 1);
    }
    return false;
  };
  const ends: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (!quoted(i) && endsSentence(text, i)) ends.push(i + 1);
  }
  ends.push(text.length);
  const sentences: string[] = [];
  let start = 0;
  for (let k = 0; k < ends.length; k += 1) {
    let end = ends[k] as number;
    if (calls(start, end)) {
      while (k + 1 < ends.length && !saysAnything(text.slice(start, end))) {
        k += 1;
        end = ends[k] as number;
      }
      sentences.push(text.slice(start, end).trim());
    }
    start = end;
  }
  return sentences.join(" ").trim();
}

/** Whether a sentence says more than the token and its punctuation. */
function saysAnything(sentence: string): boolean {
  return /[\p{L}\p{N}]/u.test(sentence.replaceAll(BANZHUAN_TRIGGER, ""));
}
