import { aliasQuotedTrigger } from "@herta/core/banzhuan-alias";
import { Fragment, type ReactNode } from "react";
import { tokenizeBanzhuanMentions } from "./banzhuan-mention.js";
import { measureRevealSpan } from "./reveal-perf.js";

/**
 * Render `text` with every bare `@板砖` wrapped in a chip span. `variant`
 * "bubble" uses the full padded pill; "composer" uses the metric-safe class
 * (no padding, inherited weight) so the textarea caret never drifts. Plain
 * text nodes render as bare fragments, so a mention-free string stays a single
 * text node (existing getByText queries keep working).
 *
 * `lang` localizes the USER-FACING presentation of 板砖 to the conversation's
 * language: an EN conversation displays the trigger chip as `@Brick` and bare
 * 板砖 references as `Brick`. This is DISPLAY-ONLY — the record/wire token stays
 * 板砖 (Herta emits it, the harness dispatches on it). The alias applies only to
 * the committed `bubble` variant: the `composer` overlay must stay
 * metric-identical to the textarea (a CJK→Latin swap would drift the caret), so
 * it never substitutes.
 *
 * The EN composer additionally CHIPS a typed `@brick` (any case) — the input
 * form an EN user actually types — but renders the node's literal matched
 * text, never a substitution (caret metrics again). Bubbles don't need this:
 * a committed record never contains `@brick` (translated to the wire token on
 * send).
 */
export function renderBanzhuanText(
  text: string,
  variant: "bubble" | "composer",
  lang: "zh" | "en" = "zh",
): ReactNode[] {
  const cls = variant === "composer" ? "composer-mention" : "banzhuan-mention";
  const alias = variant === "bubble" && lang === "en";
  const matchBrickInput = variant === "composer" && lang === "en";
  const nodes = measureRevealSpan(
    "bubble.tokenize",
    () => tokenizeBanzhuanMentions(text, { matchBrickInput }),
    () => text.length,
  );
  return nodes.map((node, i) => {
    if (node.kind === "mention") {
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable positional split of one string
        <span key={i} className={cls}>
          {alias ? "@Brick" : node.value}
        </span>
      );
    }
    if (node.kind === "code" && variant === "bubble") {
      // Inline code renders monospace, WITHOUT its backticks (owner
      // 2026-07-27: `truncate` showed the literal delimiters, reading as
      // unrendered markup next to any other chat client). Slice 5 kept them
      // on the argument that the streaming→committed settle should never
      // change the text — but that traded a permanent wart for a momentary
      // one: the span only tokenizes once its CLOSING backtick arrives, so
      // mid-stream it is plain text either way, and the only difference is
      // whether the delimiters vanish at that instant or never. They vanish.
      //
      // Display-only (D7): the record keeps the backticks — that is what
      // Herta's prompt reads, what the CLI prints, and what the composer
      // overlay must keep to stay metric-identical to the textarea.
      //
      // The quoted trigger token reads `@Brick` in an EN conversation (owner
      // 2026-11-13, `aliasQuotedTrigger`): still code, never a chip.
      const inner = aliasQuotedTrigger(
        node.value.slice(1, -1),
        alias ? "en" : "zh",
      );
      if (inner.length > 0) {
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable positional split of one string
          <code key={i} className="inline-code">
            {inner}
          </code>
        );
      }
      // An empty span (``) has nothing to set — render it literally rather
      // than painting a bare chip with no content in it.
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable positional split of one string
        <Fragment key={i}>{node.value}</Fragment>
      );
    }
    // Bare 板砖 (a casual reference WITHOUT the @ — never a dispatch) → Brick in
    // an EN bubble. Text nodes never contain the `@板砖` trigger (it is split
    // out as a `mention` node above), so this only touches the plain nickname.
    const value = alias
      ? (node.value as string).replaceAll("板砖", "Brick")
      : node.value;
    // biome-ignore lint/suspicious/noArrayIndexKey: stable positional split of one string
    return <Fragment key={i}>{value}</Fragment>;
  });
}
