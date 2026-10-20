import type { TerminalRecord } from "@herta/core";
import { dealiasBrickDraft } from "./banzhuan-mention.js";

/**
 * Up-arrow recall (ADR 0072 §3): the last message the user SENT in this
 * session, for an empty composer. A steer (ADR 0063) and a 继续 (ADR 0071)
 * are not messages the user composed there, so they are passed over; a
 * picture-only message has no text to recall. The record stores the wire
 * token `@板砖`; an EN session's draft gets `@Brick` back, as rewind does.
 * Null when there is nothing to recall.
 */
export function recallLastMessage(
  record: TerminalRecord,
  lang: "zh" | "en",
): string | null {
  return recallLastUserMessage(record, lang)?.text ?? null;
}

/** The same message with the paths it mentioned with the composer's `@`
 *  (ADR 0072 amendment 2026-10-20), so the recall can put the chips back. */
export function recallLastUserMessage(
  record: TerminalRecord,
  lang: "zh" | "en",
): { readonly text: string; readonly mentions?: readonly string[] } | null {
  for (let i = record.length - 1; i >= 0; i -= 1) {
    const b = record[i];
    if (b?.kind !== "user" || b.steer === true || b.resume === true) continue;
    if (b.text.trim().length === 0) continue;
    const text = dealiasBrickDraft(b.text, lang);
    return b.mentions !== undefined ? { text, mentions: b.mentions } : { text };
  }
  return null;
}
