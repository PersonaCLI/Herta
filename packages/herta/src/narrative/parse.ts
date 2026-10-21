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
