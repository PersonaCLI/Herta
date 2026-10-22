/**
 * 板砖 → Brick display/input aliasing (ADR 0015) — the SINGLE shared
 * implementation behind the CLI renderer (packages/cli/src/render/
 * banzhuan-alias.ts), the GUI renderer (src/renderer/lib/banzhuan-mention.ts),
 * and the GUI main process (src/main/tray-menu.ts), which previously carried
 * hand-synced "lockstep" copies of these helpers.
 *
 * DISPLAY/INPUT-LAYER ONLY (D2): an EN session SHOWS `@Brick` / `Brick` and
 * lets the user TYPE `@Brick`, but the wire token `@板砖` (BANZHUAN_TRIGGER in
 * packages/herta/src/narrative/parse.ts), the persisted TerminalRecord, and
 * dispatch (which reads the committed text, never the rendered output) all
 * keep 板砖. zh text is returned byte-identical by every helper here.
 *
 * Pure string code with NO node imports — like text-sanitize, the GUI
 * renderer imports it via the `@herta/core/banzhuan-alias` subpath so the
 * browser bundle never touches the node-only modules the package root
 * re-exports.
 */

/** A `…` inline code span (single backticks, no inner backtick). Same span
 *  rule as the GUI mention tokenizer and parse.ts: a 板砖 / `@brick` inside
 *  such a span is quotation, not a mention. */
export const INLINE_CODE_SPAN = /`[^`]*`/g;

/** A typed `@brick` (any case) at a mention boundary — the EN input form of
 *  the trigger (matched by the GUI's overlay tokenizer and translated to the
 *  wire token by `aliasBrickInput`): the `@` must start the mention — the
 *  negative lookbehind `(?<![\w@])` rejects an embedded `@brick`
 *  (`bob@brick.io`, a scoped `pkg@brick`) so it never false-dispatches — and
 *  the trailing `\b` rejects `@Bricks`. */
export const BRICK_INPUT_MENTION = /(?<![\w@])@brick\b/gi;

/** Fence-line shapes for the display alias — same shapes as
 *  slow-stream-pacing's FENCE_OPEN_LINE / FENCE_CLOSE_LINE (reimplemented
 *  locally: the constants aren't exported, and the pacing module scans
 *  code-point arrays, not strings). */
const FENCE_OPEN_LINE = /^\s*```[^`\n]*\s*$/;
const FENCE_CLOSE_LINE = /^\s*```\s*$/;

/** A fence line (CommonMark): up to three spaces, then three or more
 *  backticks or tildes, then the info string. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The stretches of `text` that are QUOTATION, not speech, as `[start, end)`
 * offsets in order: each CLOSED fenced code block, from its opening fence
 * line through its closing one, and — outside those — each single-backtick
 * inline code span.
 *
 * A fenced block is quoted text as surely as a span is (ADR 0078 amendment
 * 2026-10-21): a quoted file passage arrives fenced, and inside a fence the
 * span rule alone mis-paired — a passage holding `` `@板砖` ``, or one fenced
 * with four backticks because it holds a code block, left the token bare
 * and dispatched 板砖 on the Trailblazer's behalf. A fence closes on a line
 * of the same character, at least as long, and nothing else; an UNCLOSED
 * fence quotes nothing, so a stray fence can never swallow a real `@板砖`.
 */
export function quotationRanges(
  text: string,
): Array<readonly [number, number]> {
  const fenced: Array<readonly [number, number]> = [];
  const lines = text.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_LINE.exec(lines[i] ?? "");
    if (open === null) continue;
    const mark = open[1] ?? "";
    // A backtick fence's info string holds no backtick (CommonMark).
    if (mark.startsWith("`") && (open[2] ?? "").includes("`")) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const close = FENCE_LINE.exec(lines[j] ?? "");
      if (
        close !== null &&
        (close[1] ?? "")[0] === mark[0] &&
        (close[1] ?? "").length >= mark.length &&
        (close[2] ?? "").trim() === ""
      ) {
        fenced.push([
          starts[i] ?? 0,
          (starts[j] ?? 0) + (lines[j] ?? "").length,
        ]);
        i = j;
        break;
      }
    }
  }
  const out: Array<readonly [number, number]> = [];
  let last = 0;
  const spansIn = (from: number, to: number): void => {
    for (const m of text.slice(from, to).matchAll(INLINE_CODE_SPAN)) {
      const s = from + (m.index ?? 0);
      out.push([s, s + m[0].length]);
    }
  };
  for (const r of fenced) {
    spansIn(last, r[0]);
    out.push(r);
    last = r[1];
  }
  spansIn(last, text.length);
  return out;
}

/** Apply `map` to the stretches of `text` OUTSIDE quotation (closed fenced
 *  blocks and inline code spans, `quotationRanges`), leaving the quotation
 *  verbatim. */
export function mapOutsideQuotation(
  text: string,
  map: (segment: string) => string,
): string {
  let out = "";
  let last = 0;
  for (const [s, e] of quotationRanges(text)) {
    out += map(text.slice(last, s));
    out += text.slice(s, e);
    last = e;
  }
  return out + map(text.slice(last));
}

/** Apply `map` to the stretches of `text` OUTSIDE single-backtick inline
 *  code spans, leaving the spans (backticks included) verbatim. */
export function mapOutsideInlineSpans(
  text: string,
  map: (segment: string) => string,
): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(INLINE_CODE_SPAN)) {
    const idx = m.index ?? 0;
    out += map(text.slice(last, idx));
    out += m[0];
    last = idx + m[0].length;
  }
  return out + map(text.slice(last));
}

/**
 * Plain-string 板砖 → Brick DISPLAY alias for surfaces that render a raw
 * string with no mention chip and no code styling — the GUI sidebar card
 * preview, the tray menu, the CLI's session-list previews and raw chunk
 * lane. An EN session shows `@Brick` / `Brick`; one `replaceAll` covers both
 * (the `板砖` inside `@板砖` maps to `Brick`, giving `@Brick`). Does NOT
 * exempt code spans — preview snippets are plain text, so there is no code
 * styling to preserve; committed/streamed speech rendering uses
 * `aliasBanzhuanDisplay` (CLI) or the mention tokenizer (GUI) instead.
 * DISPLAY-ONLY — the stored record keeps the wire token 板砖 (D2); zh is
 * returned byte-identical.
 */
export function aliasBanzhuanPlain(text: string, lang: "zh" | "en"): string {
  return lang === "en" ? text.replaceAll("板砖", "Brick") : text;
}

/**
 * Code-aware 板砖 → Brick DISPLAY alias (EN only) for the CLI's speech
 * rendering: like `aliasBanzhuanPlain`, but a 板砖 inside a single-backtick
 * inline span or a ``` fenced region stays verbatim — parity with the GUI,
 * whose tokenizer exempts code nodes and whose bubble exempts fence
 * segments. The fence scan is line-based (shapes above); an unclosed fence
 * extends to the end of the text, matching the pacer's stance. Inline spans
 * are only recognised OUTSIDE fences (inside a fence everything is verbatim
 * anyway). zh is returned byte-identical.
 */
export function aliasBanzhuanDisplay(text: string, lang: "zh" | "en"): string {
  if (lang !== "en") return text;
  const out: string[] = [];
  /** Pending non-fence lines, aliased as ONE region so an inline span is
   *  matched with the same whole-text semantics as the GUI tokenizer. */
  let plain: string[] = [];
  let inFence = false;
  const flushPlain = (): void => {
    if (plain.length === 0) return;
    out.push(
      mapOutsideInlineSpans(plain.join("\n"), (seg) =>
        seg.replaceAll("板砖", "Brick"),
      ),
    );
    plain = [];
  };
  for (const line of text.split("\n")) {
    if (inFence) {
      out.push(line);
      if (FENCE_CLOSE_LINE.test(line)) inFence = false;
    } else if (FENCE_OPEN_LINE.test(line)) {
      flushPlain();
      out.push(line);
      inFence = true;
    } else {
      plain.push(line);
    }
  }
  flushPlain();
  return out.join("\n");
}

/**
 * The INPUT reverse alias: an EN user types `@Brick` (any case), which is
 * translated back to the wire token `@板砖` BEFORE it enters the
 * record/dispatch, so everything downstream (detection, prompt round-trip)
 * is unchanged. Boundary rules per BRICK_INPUT_MENTION — an embedded
 * `bob@brick.io` / `pkg@brick` or a suffixed `@Bricks` never dispatches, and
 * the bare word "brick" (no `@`) is never a trigger. A single-backtick
 * inline code span is exempt (audit 2026-07-16): a quoted `` `@brick` `` is
 * the user MENTIONING the token, not typing it (same span rule as the GUI
 * tokenizer / parse.ts). So is a closed fenced block (ADR 0078 amendment
 * 2026-10-21): a quoted passage that says `@brick` is not the user typing it.
 * zh is unchanged.
 */
export function aliasBrickInput(text: string, lang: "zh" | "en"): string {
  if (lang !== "en") return text;
  return mapOutsideQuotation(text, (seg) =>
    seg.replace(BRICK_INPUT_MENTION, "@板砖"),
  );
}

/**
 * The composer-draft round-trip of {@link aliasBanzhuanPlain}: a rewind
 * restores the RECORD's text (wire token `@板砖`) into the composer, but an EN
 * user only ever typed/saw `@Brick` — map the @ trigger form back so the
 * restored draft reads like what they sent. Only `@板砖` is mapped: a bare 板砖
 * an EN user literally typed stays untouched. Safe round-trip (ADR 0015 §3):
 * the composer's input alias (`aliasBrickInput`) translates `@Brick` back to
 * `@板砖` on send. zh is returned byte-identical.
 */
export function dealiasBrickDraft(text: string, lang: "zh" | "en"): string {
  // Outside quotation only, as `aliasBrickInput` maps: a quote's fenced
  // source keeps its own `@板砖` (release review 2026-10-22: the recall
  // rewrote it, and the re-sent quote no longer matched the file).
  return lang === "en"
    ? mapOutsideQuotation(text, (seg) => seg.replaceAll("@板砖", "@Brick"))
    : text;
}
