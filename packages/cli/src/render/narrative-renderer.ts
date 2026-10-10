import {
  type SystemBlock,
  stripDisplayUnsafe,
  type TerminalRecord,
  type TerminalRecordBlock,
} from "@herta/core";
import {
  type ActorStreamingSink,
  collapseLongDiffs,
  createRevealDriver,
  humanizedCharDelay,
  type PacingMode,
  type PromptLang,
  type RevealDriver,
  type SlowStreamController,
} from "@herta/herta";
import { aliasBanzhuanDisplay, aliasBanzhuanPlain } from "./banzhuan-alias.js";
import type { Style } from "./style.js";
import { localizeSystemBlock } from "./system-localize.js";

/**
 * Differential renderer for v0.2 narrative `TerminalRecord` snapshots,
 * AND streaming sink for the actor turn loop.
 *
 * Each `update(record)` call walks the record from the count of blocks
 * already rendered and writes only the appended blocks. The renderer
 * holds an internal cursor — callers should pass the SAME growing record
 * across turns (the v0.2 actor returns `{ record }` from each turn).
 *
 * Streaming methods (Slice 9 + Slice 10):
 *   - `beginHertaStream(surface)`: surface="speech" prepares for token
 *     output; surface="thought" writes the dim `(思考中…)` indicator.
 *   - `streamHertaToken(text)`: writes a token chunk to stdout in bright
 *     (no-op while in thought surface).
 *   - `endHertaStream()`: for speech, writes trailing newline + advances
 *     cursor by 1. For thought, clears the indicator line.
 *   - `flushBlocks(record)`: alias for `update(record)`. SKIPS herta
 *     blocks with `surface: "thought"` (Slice 10).
 *   - `cancelStream()`: mid-stream error recovery. Clears thought
 *     indicator OR writes speech trailing newline. Does NOT advance.
 *
 * Render rules:
 *   - `user`  blocks: skipped (the user typed them; no echo).
 *   - `herta` speech: text in bright color, trailing `\n` if not already.
 *   - `herta` thought: skipped (internal monologue, never rendered).
 *   - `system` blocks: dim `→ <label>` header, then body with 2-space
 *     indentation per line, in dim color.
 *
 * SPEC v0.2 §9 (rendering), §5.3 (system labels), Slice 9 §5, Slice 10 §6.
 */

// Per-lang transient chrome (session interaction language, not the record):
// zh stays byte-identical; EN sessions get English indicators.
const THOUGHT_INDICATOR: Record<PromptLang, string> = {
  zh: "(思考中…)",
  en: "(thinking…)",
};
// `\r\x1b[K` = return to column 0, clear to end of line.
// The indicator is written WITHOUT a trailing newline so the cursor stays on
// the indicator's line. When the thought ends (or speech begins as a follow-up),
// this sequence cleanly wipes the indicator in place, and the next content
// stream (speech) overwrites the same line. If we had written `\n` after the
// indicator, the cursor would land on a fresh empty line below and `\r\x1b[K`
// would clear that empty line, leaving the indicator visible — exactly the
// post-Slice-10 hotfix bug that this comment exists to prevent.
const CLEAR_LINE = "\r\x1b[K";

/**
 * Transient status indicator shown while the long-session recap summarizer
 * LLM is running (recap.compaction phase:"start" → phase:"end"). Same
 * no-trailing-newline + CLEAR_LINE pattern as THOUGHT_INDICATOR so it
 * disappears cleanly when the slow router call settles. The EN wording
 * reuses the GUI's `workspace.recapping` string ("Tidying conversation
 * history…") for cross-frontend consistency.
 */
const COMPACTION_INDICATOR: Record<PromptLang, string> = {
  zh: "⋯ 正在压缩对话记忆…",
  en: "⋯ Tidying conversation history…",
};

/**
 * Maximum number of diff lines shown inside a system block before
 * the renderer collapses the rest with a `… (N more lines suppressed)`
 * footer. The full diff stays in `TerminalRecord` and the JSONL session
 * file — this only affects what scrolls past in the live CLI. Operators
 * can raise the cap via `HERTA_DIFF_PREVIEW_MAX_LINES` if they want
 * fuller previews (set to 0 or `unlimited` to disable collapse).
 *
 * Chosen empirically: small scripts (a single 20-50 line diff) render
 * in full, multi-hundred-line diffs collapse to a tidy preview. The
 * actor's next turn still sees the full diff via the record.
 */
const DEFAULT_DIFF_PREVIEW_MAX_LINES = 20;

function resolveDiffPreviewMaxLines(): number {
  const raw = process.env.HERTA_DIFF_PREVIEW_MAX_LINES;
  if (raw === undefined || raw === "") return DEFAULT_DIFF_PREVIEW_MAX_LINES;
  if (raw === "unlimited" || raw === "0") return Number.POSITIVE_INFINITY;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return DEFAULT_DIFF_PREVIEW_MAX_LINES;
  }
  return parsed;
}

/**
 * `collapseLongDiffs` was moved to `@herta/herta`
 * (`packages/herta/src/narrative/diff-collapse.ts`) in 2026-05-23 N6
 * so both the CLI renderer (this file) and the LLM prompt serializer
 * (`@herta/herta` `serialize.ts`) can share the same diff-truncation
 * logic. Imported above; this file no longer defines its own copy.
 *
 * The two call-sites resolve their own max-lines independently:
 *   - CLI display:  `resolveDiffPreviewMaxLines()` (this file,
 *                   `HERTA_DIFF_PREVIEW_MAX_LINES`)
 *   - LLM prompt:   `resolveDiffPromptMaxLines()` (in `diff-collapse.ts`,
 *                   `HERTA_DIFF_PROMPT_MAX_LINES`)
 * so an operator can see full diffs on screen (`unlimited`) while
 * still keeping the LLM's prompt compact.
 */

/** Base per-character delay during slow-stream forward emission, in ms (~10 chars/s — a read-along pace; user-tuned 2026-06-11, was 35ms). */
export const SLOW_STREAM_BASE_DELAY_MS = 100;
/** Per-character delay during retract animation, in ms (uniform, no jitter). */
const SLOW_STREAM_RETRACT_DELAY_MS = 25;

/**
 * Return the terminal column-width of `ch` for retract-math purposes.
 * 2 for East Asian Wide / Fullwidth codepoints (CJK ideographs,
 * fullwidth punctuation, hiragana/katakana, hangul); 1 otherwise.
 *
 * Lightweight subset of `wcwidth` — covers Herta's prompt domain
 * (Chinese + ASCII + common emoji-less punctuation) without pulling
 * in a 100+ KB Unicode table dependency. Codepoints outside this
 * scope (zero-width joiners, combining marks, emoji ZWJ sequences,
 * and — notably — East-Asian-AMBIGUOUS characters like `……`/`——`,
 * which DO appear in Herta's prose) are treated as width-1. That is
 * correct for modern terminals' default ambiguous-narrow rendering
 * (Windows Terminal et al.); on a terminal configured ambiguous-WIDE
 * the retract mis-erases by one column per such char. A configurable
 * ambiguous-width mode is the known follow-up if that setup matters.
 */
function charWidth(ch: string): 1 | 2 {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 1;
  // CJK Unified Ideographs.
  if (cp >= 0x4e00 && cp <= 0x9fff) return 2;
  // CJK Compatibility Ideographs.
  if (cp >= 0xf900 && cp <= 0xfaff) return 2;
  // CJK Symbols and Punctuation, Hiragana, Katakana.
  if (cp >= 0x3000 && cp <= 0x30ff) return 2;
  // Fullwidth Forms.
  if (cp >= 0xff00 && cp <= 0xff60) return 2;
  // Halfwidth Forms.
  if (cp >= 0xffe0 && cp <= 0xffe6) return 2;
  // Hangul Syllables.
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2;
  // CJK Extension A.
  if (cp >= 0x3400 && cp <= 0x4dbf) return 2;
  // CJK Extension B–F (supplementary).
  if (cp >= 0x20000 && cp <= 0x2ebef) return 2;
  // Emoji & pictographs (slice 6): Misc Symbols and Pictographs through
  // Symbols and Pictographs Extended-A — East-Asian-Wide per UAX #11, so a
  // retract over "🚀" must erase two columns, not one. (VS16-promoted
  // narrow symbols like ☺️ remain the known ambiguous-width follow-up.)
  if (cp >= 0x1f300 && cp <= 0x1faff) return 2;
  // CJK Radicals Supplement, Kangxi Radicals — wide.
  if (cp >= 0x2e80 && cp <= 0x2fdf) return 2;
  return 1;
}

export class NarrativeRenderer implements ActorStreamingSink {
  private rendered = 0;
  private streamingSurface: "speech" | "thought" | null = null;

  constructor(
    private readonly out: NodeJS.WritableStream,
    private readonly style: Style,
    opts: {
      /**
       * Override TTY detection. When omitted, the renderer checks
       * `(out as { isTTY?: boolean }).isTTY === true`. Set explicitly
       * in tests that need to exercise the TTY-on slow-stream paths
       * with a `MockWritable` (which is non-TTY by default).
       */
      isTTY?: boolean;
      /**
       * Random source for jitter computations. Defaults to
       * `Math.random`. Tests pass a deterministic source.
       */
      random?: () => number;
      /**
       * Session interaction language. `en` reveals speech at WORD granularity
       * (mode `word`) and renders the 板砖→Brick display alias; `zh` (default)
       * keeps the byte-identical per-code-point `cjk` cadence and no alias.
       * Session-constant, so it is a constructor opt — no per-call plumbing.
       */
      lang?: PromptLang;
    } = {},
  ) {
    this.isTTY = opts.isTTY ?? (out as { isTTY?: boolean }).isTTY === true;
    this.random = opts.random ?? Math.random;
    this.lang = opts.lang ?? "zh";
  }

  private readonly isTTY: boolean;
  private readonly random: () => number;
  private readonly lang: PromptLang;

  /** Reveal granularity derived from the session language. */
  private get mode(): PacingMode {
    return this.lang === "en" ? "word" : "cjk";
  }

  /**
   * Cross-chunk hold for the raw-provider-chunk lane (streamHertaToken): the
   * ONLY way `板砖` can split across two chunks is a chunk ending in a lone `板`
   * whose next chunk opens `砖…`. We hold that trailing `板` here so the alias's
   * `replaceAll("板砖","Brick")` still fires once the `砖` arrives. Flushed on
   * endHertaStream / cancelStream, cleared on beginHertaStream. EN-only; the
   * paced (runSlowStream) path never touches this — it aliases the whole string
   * up front and writes via `writeSpeechChunk`.
   */
  private pendingBrickTail = "";

  /**
   * The raw lane's paced reveal on a TTY (owner 2026-10-10: a beat "pops up
   * without streaming"). In-turn beats — and the whole reply when the
   * supervisor is off — arrive as DeepSeek generates them, a line in about a
   * second, while the supervised reply reads at the paced cadence. On a TTY
   * the chunks now go through the shared reveal driver at that cadence:
   * `beatReveal` while the actor is still streaming into it, `revealing`
   * once `endHertaStream` has handed it the last chunk and the actor has
   * moved on. Non-TTY output keeps the raw writes.
   */
  private beatReveal: RevealDriver | null = null;
  private revealing: RevealDriver | null = null;
  /** A record update that arrived while a finished beat was still revealing:
   *  the rows behind it print when it ends, so they never cut into its line. */
  private deferredRecord: TerminalRecord | null = null;

  /**
   * Resolves once the raw lane's reveal (if any) has finished at its own
   * pace. The REPL awaits it before printing the prompt, so a beat — or an
   * unsupervised reply — is never cut short at turn end.
   */
  async settled(): Promise<void> {
    for (;;) {
      const d = this.revealing ?? this.beatReveal;
      if (d === null) return;
      await d.done.catch(() => undefined);
    }
  }

  /** Land a reveal still running — its tail at once, its newline, and the
   *  rows held behind it — before anything else is written. */
  private landReveal(): void {
    (this.beatReveal ?? this.revealing)?.flushTail();
  }

  private makeBeatReveal(): RevealDriver {
    const driver = createRevealDriver({
      mode: this.mode,
      baseMs: SLOW_STREAM_BASE_DELAY_MS,
      random: this.random,
      maxRevealMs: Number.POSITIVE_INFINITY,
      fences: false,
      completionTick: false,
      firstDelayMs: this.computeFirstDelay(),
      emitRange: (chunk) => this.writeSpeechChunk(chunk),
      onBegin: () => undefined,
      onFinish: (begun) => {
        if (begun && this.streamingSurface === "speech") this.out.write("\n");
        if (this.beatReveal === driver) {
          // Landed before the actor ended it (an error mid-beat): the
          // actor's own end/cancel follows and must find no open stream.
          this.beatReveal = null;
        }
        if (this.revealing === driver) this.revealing = null;
        this.streamingSurface = null;
        const deferred = this.deferredRecord;
        this.deferredRecord = null;
        if (deferred !== null) this.update(deferred);
      },
    });
    return driver;
  }

  // -- ActorStreamingSink methods ------------------------------------------

  beginHertaStream(surface: "speech" | "thought"): void {
    this.openStream(surface);
    if (surface === "speech" && this.isTTY) {
      this.beatReveal = this.makeBeatReveal();
    }
  }

  /** The stream bookkeeping every lane shares; the paced controller opens
   *  through here without starting a second reveal of its own. */
  private openStream(surface: "speech" | "thought"): void {
    this.landReveal();
    // Defensive: a new stream must never inherit a prior stream's held tail
    // (every real path flushes on end/cancel; this guards an unbalanced edge).
    this.pendingBrickTail = "";
    if (this.streamingSurface === "thought") {
      this.out.write(CLEAR_LINE);
    }
    this.streamingSurface = surface;
    if (surface === "thought") {
      // No trailing newline — see CLEAR_LINE comment above. The indicator
      // sits on the current cursor's line and `\r\x1b[K` wipes it when the
      // thought ends.
      this.out.write(this.style.dim(THOUGHT_INDICATOR[this.lang]));
    }
  }

  /**
   * Raw strip + bright write of a whole speech unit — no aliasing, no
   * buffering. The paced path (runSlowStream, aliased at entry) and the
   * raw-chunk lane (streamHertaToken, aliased with a cross-chunk hold) both
   * funnel here, so the write primitive stays single and simple.
   */
  private writeSpeechChunk(text: string): void {
    if (this.streamingSurface === "thought") return; // hidden
    // stripDisplayUnsafe BEFORE the style wrap (slice 6): a raw TTY is the
    // most dangerous sink — an ESC/OSC/CSI in model output could retitle
    // the window, wipe the screen, or write the clipboard (OSC-52). The
    // renderer's OWN ANSI (style.bright) is applied AFTER the strip and is
    // never touched.
    const safe = stripDisplayUnsafe(text);
    if (safe.length > 0) this.out.write(this.style.bright(safe));
    if (this.streamingSurface === null) this.streamingSurface = "speech";
  }

  streamHertaToken(text: string): void {
    if (text.length === 0) return;
    if (this.streamingSurface === "thought") return; // hidden
    // Raw-provider-chunk lane (unsupervised speech / in-turn beats): apply
    // the 板砖→Brick alias with a one-char cross-chunk
    // hold, since a chunk can end mid-token (…板 | 砖…). EN only; zh writes raw.
    let chunk = text;
    if (this.lang === "en") {
      let s = this.pendingBrickTail + text;
      this.pendingBrickTail = "";
      if (s.endsWith("板")) {
        this.pendingBrickTail = "板"; // hold a possibly-splitting trailing 板
        s = s.slice(0, -1);
      }
      chunk = aliasBanzhuanPlain(s, this.lang);
    }
    // On a TTY the chunk joins the paced reveal; elsewhere it is written now.
    if (this.beatReveal !== null) this.beatReveal.pushToken(chunk);
    else this.writeSpeechChunk(chunk);
  }

  /** Write and clear any held cross-chunk `板` — a genuine standalone 板 that
   *  turned out NOT to be part of `板砖` — styled like normal speech. */
  private flushBrickTail(): void {
    if (this.pendingBrickTail.length > 0) {
      this.out.write(
        this.style.bright(stripDisplayUnsafe(this.pendingBrickTail)),
      );
      this.pendingBrickTail = "";
    }
  }

  endHertaStream(): void {
    if (this.streamingSurface === "thought") {
      this.out.write(CLEAR_LINE);
      this.streamingSurface = null;
      this.rendered += 1;
      return;
    }
    if (this.beatReveal !== null) {
      // The actor is done with this line; the reveal is not. A held 板 joins
      // it, the block is counted now (the sink contract), and the newline
      // and any rows behind it wait for the reveal's own finish.
      const driver = this.beatReveal;
      this.beatReveal = null;
      if (this.pendingBrickTail.length > 0) {
        driver.pushToken(this.pendingBrickTail);
        this.pendingBrickTail = "";
      }
      this.revealing = driver;
      this.rendered += 1;
      driver.finishInput();
      return;
    }
    if (this.streamingSurface === "speech") {
      this.flushBrickTail(); // a held 板 renders BEFORE the trailing newline
      this.out.write("\n");
      this.streamingSurface = null;
    }
    this.rendered += 1;
  }

  flushBlocks(record: TerminalRecord): void {
    this.update(record);
  }

  slowStreamSpeech(
    text: string,
    opts?: { verdictPending?: Promise<void>; baseMsOverride?: number },
  ): SlowStreamController {
    return this.runSlowStream(text, opts);
  }

  private runSlowStream(
    text: string,
    opts?: { verdictPending?: Promise<void>; baseMsOverride?: number },
  ): SlowStreamController {
    // Display hygiene at the entry (slice 6): the paced chars, the retract
    // width math, and the committed text all derive from the same safe
    // string — see writeSpeechChunk.
    // 板砖→Brick alias applied ONCE here (EN only), BEFORE the split — so
    // `chars`, the per-code-point emittedChars widths, the wrap simulation, the
    // retract erase, AND the non-TTY emit all derive from the SAME aliased
    // string. The record/wire token is unaffected (this is display-only).
    // Code-aware variant: a fenced snippet or backticked `板砖` quotation
    // stays verbatim, like the GUI's code-exempt tokenizer.
    const aliasedText = aliasBanzhuanDisplay(text, this.lang);
    const mode = this.mode;
    // A beat still revealing lands before this reply's first glyph.
    this.landReveal();
    const chars = Array.from(stripDisplayUnsafe(aliasedText));
    // Per-char base cadence: a voiced stream overrides it to match its clip;
    // otherwise the read-along default. (No CLI audio today, so it's unset here,
    // but the seam keeps the CLI a faithful ActorStreamingSink.)
    const baseMs = opts?.baseMsOverride ?? SLOW_STREAM_BASE_DELAY_MS;

    // Non-TTY path: defer emission until the supervisor verdict is
    // known. We can't animate retract over a non-TTY stream, but we
    // CAN preserve the verdict-gating invariant — the rejected
    // speech must never reach stdout. Behavior:
    //   - On construction: buffer `text`, emit nothing.
    //   - `fastForward()`: emit the full buffered text via begin/
    //     token/end and resolve `done`. This is the OK-verdict path.
    //   - `cancelAndBackspace()`: discard the buffered text and
    //     reject `done`. Nothing reaches the sink. This is the
    //     veto path.
    //   - If `fastForward` is never called and `cancelAndBackspace`
    //     is never called either, the speech never renders — same
    //     observable behavior as the actor's old defer + unified
    //     replay path the supervisor block used to take when no
    //     slow-stream was available.
    // (Pre-2026-05-22 this branch emitted the text synchronously
    // on construction, which broke verdict gating in non-TTY
    // environments — the rejected speech was visible AND the retry
    // appended below it.)
    if (!this.isTTY) {
      let resolveDone!: () => void;
      let rejectDone!: (err: Error) => void;
      const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      // Suppress unhandled-rejection warnings for callers that drive
      // the controller via cancelAndBackspace and never `await done`.
      // Callers that DO await done still receive the rejection through
      // their own await — this only silences Node's process-level
      // unhandled-rejection handler.
      done.catch(() => {});
      let nonTtyResolved = false;
      return {
        done,
        fastForward: async () => {
          if (nonTtyResolved) return;
          nonTtyResolved = true;
          if (chars.length > 0) {
            this.beginHertaStream("speech");
            // aliasedText, not the raw param — non-TTY shows Brick like TTY.
            // writeSpeechChunk (not streamHertaToken) skips the raw-lane
            // cross-chunk buffering: this is a whole, already-aliased string.
            this.writeSpeechChunk(aliasedText);
            this.endHertaStream();
          }
          resolveDone();
        },
        cancelAndBackspace: async () => {
          if (nonTtyResolved) return;
          nonTtyResolved = true;
          // Reject so any awaiters of `done` see the cancellation,
          // matching the TTY contract. The `done.catch(() => {})`
          // above suppresses unhandled-rejection on the global
          // promise — callers that explicitly `await done` still
          // observe the error.
          rejectDone(new Error("slow-stream cancelled (non-TTY)"));
        },
      };
    }

    // TTY path: the shared reveal driver (`createRevealDriver` in
    // @herta/herta) owns the timer loop — cursor, verdict ramp/hold,
    // supervised startup front-load, word/char branches — while this wrapper
    // owns the terminal-specific pieces: TTY writes with per-code-point
    // width bookkeeping (for the column-accurate retract), begin/end stream
    // discipline, and the retract/erase animation on veto.
    //
    // Driver knobs that pin the CLI's historical behavior:
    //   - completionTick: the trailing `\n` lands on a SEPARATE tick after
    //     the last unit (one unit-delay later), exactly as before.
    //   - fences: false — the CLI has never had the GUI's atomic fence
    //     emit; each write carries its own style wrap, so enabling it would
    //     change the zh byte stream.
    //   - maxRevealMs: Infinity — the CLI has no reveal ceiling (and no
    //     flushRemainder on its controller).
    //   - firstDelayMs: the humanized first delay, computed HERE so the
    //     construction-time `random` draw order is preserved.

    /** Array of { ch, width } in emission order. Used by retract. */
    const emittedChars: { ch: string; width: 1 | 2 }[] = [];
    /** Column width of the terminal at the moment forward emission
     *  started. Cached for retract math (we don't poll for resize). */
    const termCols = Math.max(
      1,
      (this.out as { columns?: number }).columns ?? 80,
    );

    // Tracks whether the driver's finish path called `endHertaStream`. When
    // the slow-stream completes naturally BEFORE the supervisor verdict
    // arrives, this flag is set true: the trailing `\n` was written (cursor
    // is now on the new line below the rejected text) and `rendered` was
    // incremented. A subsequent `cancelAndBackspace` must reposition the
    // cursor back to the end of the last text row before retracting —
    // otherwise the `\b \b` sequences land on an empty line and don't
    // visually erase anything (the 2026-05-23 regression that left both
    // rejected and retry speech visible on screen).
    let endHertaStreamCalled = false;

    const driver = createRevealDriver({
      mode,
      baseMs,
      random: this.random,
      maxRevealMs: Number.POSITIVE_INFINITY,
      fences: false,
      completionTick: true,
      firstDelayMs: this.computeFirstDelay(baseMs),
      // Verdict-pending gate: while the supervisor LLM call hasn't returned,
      // the shared pacingDecision policy ramps the per-unit cadence in the
      // back portion and then HOLDS near the end (timer unarmed) so the
      // visible stream never completes before the verdict; a supervised
      // short line waits UP FRONT (startup buffer) instead of parking the
      // last unit behind the hold. `undefined` means no supervisor in the
      // loop: never ramps, never holds, no front buffer.
      verdictPending: opts?.verdictPending,
      emitRange: (chunk) => {
        // One write per reveal unit, but each code point is pushed to
        // emittedChars so the column-accurate retract stays per-column.
        this.writeSpeechChunk(chunk);
        for (const ch of chunk) {
          emittedChars.push({ ch, width: charWidth(ch) });
        }
      },
      // openStream, not beginHertaStream: this driver IS the pacing, and the
      // raw lane's reveal must not open under it.
      onBegin: () => this.openStream("speech"),
      onFinish: (begun) => {
        // Empty-text case: nothing was emitted, so endHertaStream must not
        // be called (it would write `\n` and advance the block cursor).
        if (begun) {
          this.endHertaStream();
          endHertaStreamCalled = true;
        }
      },
    });
    // Fixed text is the degenerate live call pattern (see the driver docs):
    // push everything, then finish — the live-only guards become no-ops.
    driver.pushToken(chars.join(""));
    driver.finishInput();

    return {
      done: driver.done,
      // The driver's fastForward ALWAYS awaits `done` — even when all units
      // are already emitted the completion tick may still be pending, and
      // the actor's downstream speech-commit + flushBlocks must not run
      // before `endHertaStream` advances the cursor (2026-05-23
      // double-render regression).
      fastForward: () => driver.fastForward(),
      cancelAndBackspace: async () => {
        // driver.cancel() stops the loop and rejects `done`; false → a
        // repeat call (idempotent). It returns true after natural completion
        // too — that is the reposition case below.
        if (!driver.cancel()) return;

        // Retract every emitted character in reverse order.
        // Cursor-position tracking is virtual — we don't query the
        // terminal; we mirror what we've emitted to compute where
        // the cursor is after each backspace.
        //
        // Simulate the same wrapping as we walked forward, then
        // retract row-by-row from the last row backwards.
        type Row = { width: number };
        const rows: Row[] = [{ width: 0 }];
        const charsByRow: { ch: string; width: 1 | 2 }[][] = [[]];
        for (const e of emittedChars) {
          const current = rows[rows.length - 1];
          if (current === undefined) break;
          if (e.ch === "\n") {
            rows.push({ width: 0 });
            charsByRow.push([]);
            continue;
          }
          if (current.width + e.width > termCols) {
            rows.push({ width: e.width });
            charsByRow.push([e]);
          } else {
            current.width += e.width;
            const lastRowChars = charsByRow[charsByRow.length - 1];
            if (lastRowChars !== undefined) lastRowChars.push(e);
          }
        }

        // If the driver naturally completed before the verdict arrived,
        // it already called endHertaStream (wrote `\n`, advanced
        // cursor to the row BELOW the last text row, set
        // streamingSurface to null, incremented rendered). The
        // retract loop below assumes cursor is at the END of the
        // last emitted char — reposition the cursor and undo the
        // bookkeeping.
        //
        // Sequence emitted:
        //   `\x1b[1A`               — cursor up 1 row (now at col 0
        //                             of last text row)
        //   `\x1b[<lastRowWidth>C`  — cursor right to end of last
        //                             text row (skipped if width 0,
        //                             which only happens for a row
        //                             that is purely a `\n` boundary)
        //
        // Bookkeeping reversal: `rendered` decremented (the cycle
        // ultimately commits nothing — the retry's stream advances
        // `rendered` separately when it commits its own block).
        if (endHertaStreamCalled) {
          const lastRow = charsByRow[charsByRow.length - 1];
          const lastRowWidth =
            lastRow !== undefined
              ? lastRow.reduce((sum, c) => sum + c.width, 0)
              : 0;
          this.out.write("\x1b[1A");
          if (lastRowWidth > 0) {
            this.out.write(`\x1b[${lastRowWidth}C`);
          }
          this.rendered -= 1;
        }

        // Retract row-by-row from the last row backwards.
        for (let r = charsByRow.length - 1; r >= 0; r--) {
          const row = charsByRow[r];
          if (row === undefined) continue;
          for (let i = row.length - 1; i >= 0; i--) {
            await this.sleep(SLOW_STREAM_RETRACT_DELAY_MS);
            const e = row[i];
            if (e === undefined) continue;
            // `\b \b` per column. CJK chars span 2 columns → two pairs.
            for (let w = 0; w < e.width; w++) {
              this.out.write("\b \b");
            }
          }
          // If there are more rows above, jump to the previous row's END so
          // its per-char loop actually erases. The old jump was
          // `\x1b[1A\x1b[2K` — up (column preserved, i.e. col 0) + clear the
          // ENTIRE line: upper rows vanished whole-line at once, and the
          // per-char loop then no-op'd its `\b \b` pairs at col 0 while still
          // sleeping per character — a frozen dead beat per wrapped row.
          if (r > 0) {
            await this.sleep(SLOW_STREAM_RETRACT_DELAY_MS);
            const prevRow = charsByRow[r - 1];
            const prevWidth =
              prevRow !== undefined
                ? prevRow.reduce((sum, c) => sum + c.width, 0)
                : 0;
            this.out.write("\x1b[1A");
            if (prevWidth > 0) this.out.write(`\x1b[${prevWidth}C`);
          }
        }

        // After retract: cursor at col 0 of the first text row, all
        // emitted chars overwritten with spaces. Reset streamingSurface
        // so the next renderer call starts from a clean state, but DO
        // NOT write a trailing `\n` — that would push the cursor below
        // the (blanked) row where the rejected text was, and the retry
        // would render BELOW that blank line. By leaving the cursor at
        // col 0 of row 0, the retry's `streamHertaToken` overwrites
        // the blanked chars directly and the user sees no blank line
        // between the prior content and the retry. (2026-05-23 fix —
        // user-reported "empty line before retry" regression.)
        this.streamingSurface = null;
      },
    };
  }

  private computeFirstDelay(
    baseMs: number = SLOW_STREAM_BASE_DELAY_MS,
  ): number {
    return humanizedCharDelay({
      emittedChar: "",
      baseMs,
      random: this.random,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // -- Compaction hint (transient, ephemeral) --------------------------------

  /**
   * Show the transient `⋯ 正在压缩对话记忆…` status line while the recap
   * summarizer is running. Written WITHOUT a trailing newline so
   * `endCompactionHint()` can wipe it in place with `CLEAR_LINE`.
   * Must be paired with exactly one `endCompactionHint()` call.
   */
  beginCompactionHint(): void {
    this.out.write(this.style.dim(COMPACTION_INDICATOR[this.lang]));
  }

  /**
   * Erase the compaction status line written by `beginCompactionHint()`.
   * Uses the same `\r\x1b[K` clear-to-EOL sequence as the thought indicator.
   */
  endCompactionHint(): void {
    this.out.write(CLEAR_LINE);
  }

  // -- Mid-stream recovery -------------------------------------------------

  cancelStream(): void {
    // A reveal lands whole first (its own newline included): what the actor
    // already handed over stays on screen, as raw writes did.
    if (this.beatReveal !== null || this.revealing !== null) {
      this.landReveal();
      this.pendingBrickTail = "";
      this.streamingSurface = null;
      return;
    }
    if (this.streamingSurface === "thought") {
      this.out.write(CLEAR_LINE);
    } else if (this.streamingSurface === "speech") {
      this.flushBrickTail(); // a held 板 renders BEFORE the trailing newline
      this.out.write("\n");
    }
    this.streamingSurface = null;
  }

  // -- Differential block rendering ----------------------------------------

  update(record: TerminalRecord): void {
    // A finished beat still revealing: its rows print when it ends.
    if (this.revealing !== null) {
      this.deferredRecord = record;
      return;
    }
    while (this.rendered < record.length) {
      const block = record[this.rendered];
      if (block !== undefined) this.renderBlock(block);
      this.rendered += 1;
    }
  }

  private renderBlock(block: TerminalRecordBlock): void {
    switch (block.kind) {
      case "user":
        return; // the user typed it; no echo
      case "herta":
        if (block.surface === "thought") return;
        this.renderHerta(block.text);
        return;
      case "system":
        this.renderSystem(block);
        return;
    }
  }

  private renderHerta(text: string): void {
    // Defensive trim: the actor's commit sites already trim, but
    // renderHerta is invoked from `update()` on whatever's in the
    // record. Belt-and-suspenders so a stray leading/trailing `\n`
    // in committed text never produces a blank line on screen.
    // stripDisplayUnsafe covers disk-loaded legacy records the commit-side
    // sanitizer (slice 2) never saw — see writeSpeechChunk.
    // 板砖→Brick display alias (EN only) — the opening seed (record block 0)
    // and every committed/resumed speech block render through here, so the
    // record's @板砖 shows as @Brick without touching the stored text.
    // Code-aware variant (like the GUI): fenced / backticked 板砖 is verbatim.
    const trimmed = stripDisplayUnsafe(
      aliasBanzhuanDisplay(text, this.lang),
    ).trim();
    if (trimmed.length === 0) return;
    this.out.write(this.style.bright(trimmed));
    this.out.write("\n");
  }

  private renderSystem(block: SystemBlock): void {
    // Display-only localization (EN sessions): the stored record keeps the CN
    // machine label (系统 / 差分协处理器) and canonical CN done-marker body — for
    // Herta, the transcript, parsers, and dedup — while the TTY shows the
    // English twin (System / Coprocessor, Done · N files · tests P/F). zh is
    // byte-identical. Mirrors the GUI's ActivityBlock. See system-localize.ts.
    const { label, body } = localizeSystemBlock(block, this.lang);
    // A legacy todo block (records before ADR 0073) prints as the body the
    // record holds, like any other row.
    this.writeSystemBlock(label, body);
  }

  /** `→ <label>` header + 2-space-indented dim body. The single write path
   *  for every system block. */
  private writeSystemBlock(label: string, body: string): void {
    this.out.write(`${this.style.dim(`→ ${label}`)}\n`);
    // Collapse long diff previews for visual density. The full diff
    // remains in TerminalRecord (so Herta sees it on her next turn)
    // and in the JSONL transcript — only this TTY rendering is
    // truncated. Operators can disable via
    // `HERTA_DIFF_PREVIEW_MAX_LINES=unlimited`.
    // stripDisplayUnsafe: backend bodies carry command output / diffs — a
    // raw ESC from a hostile repo's build output must not reach the TTY.
    // The suppression footer is the one localized part (ADR 0018's rule:
    // the record stays canonical, the screen follows the session language).
    const collapsed = collapseLongDiffs(
      stripDisplayUnsafe(body),
      resolveDiffPreviewMaxLines(),
      this.lang,
    );
    const lines = collapsed.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      this.out.write(`  ${this.style.dim(line)}\n`);
    }
  }
}
