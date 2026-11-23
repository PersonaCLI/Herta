/**
 * Forbidden substrings inside user-authored （开拓者 说）...（/开拓者 说）
 * blocks. If a user could embed any of these literally, they could forge:
 *
 * - block delimiters (close their own user block early, open a Herta or
 *   system block, then inject content that the model would read as
 *   harness-authored ground truth);
 * - inline tool envelopes that the post-block scanner (Slice 4) would
 *   match and execute;
 * - the @板砖 backend-delegation trigger.
 *
 * SPEC v0.2 §11.1 enumerates the forbidden patterns. This module
 * neutralizes them by inserting a zero-width space (U+200B) after the
 * first character — visually invisible to the user, but no longer a
 * literal substring match for any scanner.
 *
 * Defense in depth: SPEC §11.2 says scanners run only over
 * Herta-authored finalized text, never over user blocks. escapeUserText
 * is a second layer in case that scope check is ever bypassed.
 */
import { quotationRanges, stripDisplayUnsafe } from "@herta/core";

const ZWSP = "​";

/** Every cross-role block delimiter + evidence label that must never
 *  appear LIVE inside actor-authored or backend-derived content. */
const ACTOR_MARKERS: readonly string[] = [
  "（开拓者 说）",
  "（/开拓者 说）",
  "（我 说）",
  "（/我 说）",
  "（我 想）",
  "（/我 想）",
  "→ 系统",
  "→ 差分协处理器",
] as const;

/** DERIVED from ACTOR_MARKERS, not restated (audit 2026-07-10, finding 16):
 *  the two lists had drifted — `（我 想）`/`（/我 想）` and the OPEN
 *  `（开拓者 说）` were neutralized for actor text but not for user text, so
 *  a user message containing `（我 想）…（/我 想）` was inserted verbatim
 *  into every actor/supervisor/router prompt, fabricating a Herta
 *  interior-monologue block that re-entered every future prompt. Deriving
 *  makes the boundaries structurally unable to drift again. `@板砖` is the
 *  one user-side addition (the inverse of sanitizeActorText's carve-out):
 *  live delegation belongs to Herta's speech alone — user text never
 *  carries a live trigger. */
export const FORBIDDEN_USER_PATTERNS: readonly string[] = [
  ...ACTOR_MARKERS,
  "@板砖",
] as const;

/** Inline-tool envelope prefix. Both `<｜read_file(...)｜>` and
 *  `<｜list_files(...)｜>` start with `<｜`, so neutralizing the prefix
 *  defeats both. The closing `｜>` is harmless on its own. */
const TOOL_ENVELOPE_PREFIX = "<｜";

/** ZWSP-break every occurrence of `pattern` in `text` — visually
 *  invisible, but no longer a literal substring match for any scanner. */
function breakPattern(text: string, pattern: string): string {
  if (!text.includes(pattern)) return text;
  const broken = `${pattern[0]}${ZWSP}${pattern.slice(1)}`;
  return text.split(pattern).join(broken);
}

/**
 * Invisible characters the display hygiene keeps (ADR 0015 amendment
 * 2026-11-23): the zero-width joiner (kept for emoji sequences), the soft
 * hyphen, the Mongolian vowel separator, the combining grapheme joiner, the
 * Hangul fillers, the Khmer inherent vowels and the variation selectors. Any
 * of them inside `@板砖` leaves a token that reads as the trigger and never
 * dispatches. ZWSP, ZWNJ, the word joiner and BOM are not here:
 * `stripDisplayUnsafe` removes those, so the token they split becomes the
 * real one, and dispatch and display agree.
 */
const KEPT_INVISIBLE =
  "\\u00AD\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u200D\\u3164\\uFE00-\\uFE0F\\uFFA0\\u{E0100}-\\u{E01EF}";
const LOOK_ALIKE_TRIGGER = new RegExp(
  `@[${KEPT_INVISIBLE}]*板[${KEPT_INVISIBLE}]*砖`,
  "gu",
);

/**
 * A `@板砖` spelled with an invisible character inside (ADR 0015 amendment
 * 2026-11-23, owner): it read as a call on the screen and in the record
 * Herta reads back, and no run followed — the shape the fabrication chain
 * starts from (ADR 0036). Outside quotation it becomes the quoted mention
 * `` `@板砖` ``, the form a non-dispatching token takes everywhere
 * (`neutralizeBanzhuanTrigger`); inside a code span it is already a
 * mention, and only loses the invisible character. The real token is not
 * touched. Idempotent: the result holds no look-alike.
 */
export function quoteLookAlikeTriggers(text: string): string {
  if (!/[@][^板]{0,8}板/u.test(text)) return text;
  const spelled = (s: string): string =>
    s.replace(LOOK_ALIKE_TRIGGER, (m) => (m === "@板砖" ? m : "\u0000"));
  if (!spelled(text).includes("\u0000")) return text;
  const inQuote = (s: string): string =>
    s.replace(LOOK_ALIKE_TRIGGER, () => "@板砖");
  let out = "";
  let last = 0;
  for (const [s, e] of quotationRanges(text)) {
    out += spelled(text.slice(last, s)).split("\u0000").join("`@板砖`");
    out += inQuote(text.slice(s, e));
    last = e;
  }
  out += spelled(text.slice(last)).split("\u0000").join("`@板砖`");
  return out;
}

export function escapeUserText(text: string): string {
  // stripDisplayUnsafe FIRST — same ordering as `sanitizeActorText`, and for
  // the same two reasons (fence-fuzz 2026-07-09 found the two paths had
  // diverged): (1) user text lands verbatim in the prompt via `serializeBlock`
  // and on the render surface, so a bidi override / C0 control the user typed
  // would spoof both — it must be stripped, not just marker-broken; (2) it
  // removes any ZWSP the user smuggled INTO a marker (`（/开拓者​ 说）`), so the
  // marker becomes literal and the break below actually neutralizes it instead
  // of passing the obfuscated form straight through. The break then re-inserts
  // ZWSP as its separator, so the pass is idempotent (a second run strips those
  // separators and re-inserts them identically).
  let escaped = stripDisplayUnsafe(text);
  for (const pattern of FORBIDDEN_USER_PATTERNS) {
    escaped = breakPattern(escaped, pattern);
  }
  if (escaped.includes(TOOL_ENVELOPE_PREFIX)) {
    const broken = `<${ZWSP}｜`;
    escaped = escaped.split(TOOL_ENVELOPE_PREFIX).join(broken);
  }
  return escaped;
}

/**
 * Which trust boundary the text is crossing. The marker set differs by
 * one deliberate carve-out: `@板砖` stays LIVE in Herta's own speech and
 * thoughts (in speech it is the real dispatch trigger — the literal-token
 * contract; in a thought it is inert prose by design), while a system
 * body (a diff, command output, an error message) must never carry a
 * live trigger or open a fake block of ANY role.
 */
export type ActorTextRole = "speech" | "thought" | "system-body";

/**
 * The trust boundary for MODEL-authored and backend-derived text (the
 * companion of `escapeUserText`, which guards user-typed text). Because
 * the record is the prompt, one hostile completion that embeds a forged
 * `→ 系统` label (or opens a fake （开拓者 说） block) inside committed
 * text would re-inject that forgery into every future prompt as harness
 * ground truth, permanently. Applied at BLOCK CONSTRUCTION — the stored
 * record is already safe, so every downstream projection (serialize,
 * recap, supervisor, disk, GUI) inherits it.
 *
 * Two passes, in a pinned order:
 *   1. `stripDisplayUnsafe` — control/bidi/zero-width hygiene. Runs
 *      FIRST because it strips ZWSP, the very separator pass 2 inserts
 *      (reversed order would undo the neutralization). Together the
 *      passes are idempotent: re-sanitizing strips pass-2 ZWSPs and
 *      re-inserts them identically.
 *   2. ZWSP-break the marker set for the role (see `ActorTextRole` for
 *      the `@板砖` carve-out), plus the `<｜` tool-envelope prefix.
 *
 * Note the strip can SPLICE a live `@板砖` out of `@␀板砖`-style input;
 * speech keeps it live by design, and the actor turn loop parses the
 * dispatch trigger from this sanitized committed text, so display and
 * dispatch always agree.
 */
export function sanitizeActorText(
  text: string,
  opts: { readonly role: ActorTextRole },
): string {
  let out = quoteLookAlikeTriggers(stripDisplayUnsafe(text));
  for (const pattern of ACTOR_MARKERS) {
    out = breakPattern(out, pattern);
  }
  if (opts.role === "system-body") {
    out = breakPattern(out, "@板砖");
  }
  if (out.includes(TOOL_ENVELOPE_PREFIX)) {
    out = out.split(TOOL_ENVELOPE_PREFIX).join(`<${ZWSP}｜`);
  }
  return out;
}
