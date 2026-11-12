/**
 * The trace card's ticker, paced for the eye (2026-09-30).
 *
 * The live feed lands ten times a second, and a flash model writes a file in
 * two or three of those: shown as it lands, the ticker flashed half-written
 * fragments (`  if (!`, `  const`) for 100 ms each — 47 of 83 ticker states in
 * three lab runs — and then parked on whatever the step's last line was,
 * often a lone `}`, until the next step began. The pacer sits between the
 * feed and the line:
 *
 * - a shown line holds for `dwellMs` at least; after that the ticker jumps to
 *   the newest line, passing over the ones in between (not every line has to
 *   be seen — the stream has to read as a stream);
 * - only whole lines of what is written: a line still growing waits until a
 *   newer one begins, or until it stops changing — except a command being
 *   written, whose growing END shows (a one-line command is never whole
 *   until it runs, and its newest characters are the news);
 * - lines with no words pass: `}`, `});`, `]`, a bare `//`;
 * - when the step ends it settles on its headline — what the step DID: a
 *   written file's first declaration, an edit's first added line, a
 *   command's last line of output;
 * - a step over before two of its lines were seen plays two of them on the
 *   way to its headline, so even an instant write reads as content flowing.
 *
 * Pure: the caller hands it the view and the time and re-asks at `wakeAt`
 * when nothing new lands. Display only, like the ticker itself (ADR 0073).
 */
import type { LiveToolView } from "../../ipc/bridge-types.js";

export interface TickerOptions {
  /** Hold each shown line at least this long; 0 follows every snapshot. */
  readonly dwellMs: number;
  /** Only whole lines of content (see the header); a command being
   *  written still shows as it grows. */
  readonly wholeLines: boolean;
  /** Pass over lines with no letter or digit. */
  readonly skipTrivial: boolean;
  /** Settle a finished step on its headline, not its last line. */
  readonly headline: boolean;
  /** A step over before two lines were seen plays two on the way out. */
  readonly flyby: boolean;
  /** A command being written shows its newest end, not its frozen start. */
  readonly commandEnd: boolean;
}

/** The ticker as it shipped with ADR 0073: the newest line, every snapshot. */
export const TICKER_AS_SHIPPED: TickerOptions = {
  dwellMs: 0,
  wholeLines: false,
  skipTrivial: false,
  headline: false,
  flyby: false,
  commandEnd: false,
};

/** The paced ticker. */
export const TICKER_PACED: TickerOptions = {
  dwellMs: 320,
  wholeLines: true,
  skipTrivial: true,
  headline: true,
  flyby: true,
  commandEnd: true,
};

/** A fly-by line's hold: brisk, the step is already over. */
export const FLYBY_MS = 200;
/** A last line unchanged this long is taken as whole (a command's output
 *  arrives in whole lines; a line still being written keeps changing). */
export const STABLE_MS = 180;

export interface TickerFrame {
  readonly text: string;
  readonly sign: "+" | "-" | null;
  /** Changes exactly when a different line shows (the renderer's key: a new
   *  line rises in; the same line growing just flows). */
  readonly key: number;
  /** The step's closing line: it is done and nothing follows. */
  readonly settled: boolean;
  /** A command still being written: its newest end is what shows. */
  readonly growing: boolean;
}

export interface TickerStep {
  readonly frame: TickerFrame | null;
  /** When to ask again if no new view lands (a hold ends, a line turns
   *  stable, the fly-by moves on); null when nothing is pending. */
  readonly wakeAt: number | null;
}

export interface Ticker {
  /** The call this ticker follows; a new call needs a new ticker. */
  readonly id: string;
  next(view: LiveToolView, now: number): TickerStep;
}

interface Line {
  readonly text: string;
  readonly sign: "+" | "-" | null;
  /** Its line number in the WHOLE text (the tail is its last lines). */
  readonly index: number;
  /** Which text it is a line of: what the call writes, or what a command
   *  prints. A command's first output line has the same number as its
   *  command line — it is still a new line. */
  readonly stream: "writing" | "running";
}

const sameLine = (a: Line, b: Line): boolean =>
  a.stream === b.stream && a.index === b.index;
/** Whether `a` comes after `b` in what the call produces: its output after
 *  its command, else later in the same text. */
const after = (a: Line, b: Line): boolean =>
  a.stream !== b.stream ? a.stream === "running" : a.index > b.index;

/** A line that names what code defines. */
const DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|pub|struct|impl|trait|module|package|func|public|private|protected|static)\b/;
/** A Markdown heading — only in a Markdown file: in code a `#` line is a
 *  comment (Python, shell). */
const HEADING = /^\s*#{1,3}\s+\S/;
const MARKDOWN = /\.(?:md|markdown|mdx)$/i;
const COMMENT = /^\s*(?:\/\/|\/\*|\*|#|--|<!--)/;
const WORD = /[\p{L}\p{N}]/u;

const isCommand = (v: LiveToolView): boolean => v.tool === "bash";

/** The tail's non-blank lines with their places in the whole text. */
function linesOf(view: LiveToolView): Line[] {
  const raw = view.tail.split("\n");
  const out: Line[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i] ?? "";
    const signed =
      view.mode === "diff" && (line.startsWith("+") || line.startsWith("-"));
    const body = (view.mode === "diff" ? line.slice(1) : line).trimEnd();
    if (body.trim().length === 0) continue;
    out.push({
      text: body,
      sign: signed ? (line[0] as "+" | "-") : null,
      index: view.lines - (raw.length - 1 - i),
      stream: view.stage,
    });
  }
  return out;
}

const indentOf = (l: Line): number => l.text.length - l.text.trimStart().length;

/** The strongest headline in this view's tail, if it has one: a document's
 *  first heading, an edit's first added line, code's top-most declaration
 *  (least indented, then first — a file's `class Parser`, not its methods).
 *  Null for a command's output, whose headline is its LAST line. */
function titleIn(view: LiveToolView): Line | null {
  if (view.stage === "running") return null;
  const lines = linesOf(view).filter((l) => WORD.test(l.text));
  if (view.mode === "diff") return lines.find((l) => l.sign === "+") ?? null;
  if (view.path !== undefined && MARKDOWN.test(view.path)) {
    return lines.find((l) => HEADING.test(l.text)) ?? null;
  }
  let best: Line | null = null;
  for (const l of lines) {
    if (!DECLARATION.test(l.text)) continue;
    if (best === null || indentOf(l) < indentOf(best)) best = l;
  }
  return best;
}

/** Whether `a` is a stronger title than `b` (both from titleIn). */
const outranks = (a: Line, b: Line): boolean =>
  indentOf(a) < indentOf(b) ||
  (indentOf(a) === indentOf(b) && a.index < b.index);

/** What a finished step did, in one of its lines — from this view alone. */
export function headlineOf(view: LiveToolView): Line | null {
  const lines = linesOf(view).filter((l) => WORD.test(l.text));
  if (lines.length === 0) return null;
  // A command's output: its last line is usually its verdict.
  if (view.stage === "running") return lines.at(-1) ?? null;
  const title = titleIn(view);
  if (title !== null) return title;
  if (view.mode === "diff") return lines.find((l) => l.sign === "-") ?? null;
  // No declaration or heading: the first line that is not a comment.
  return lines.find((l) => !COMMENT.test(l.text)) ?? lines.at(-1) ?? null;
}

export function createTicker(id: string, opts: TickerOptions): Ticker {
  let shown: (Line & { settled: boolean; growing: boolean }) | null = null;
  let shownAt = 0;
  let key = 0;
  let seen = 0;
  let plan: Line[] | null = null;
  // The newest line as last seen, and since when it has read the same.
  let last: (Line & { since: number }) | null = null;
  // The strongest title seen while the call streamed: the tail keeps only
  // the last lines, and by the end a long file's top has scrolled out of it.
  let title: Line | null = null;

  const show = (
    line: Line,
    now: number,
    extra: { settled?: boolean; growing?: boolean } = {},
  ): void => {
    // The same line growing, or settling where it stands, does not rise in
    // again.
    const same = shown !== null && sameLine(shown, line);
    if (!same) {
      key += 1;
      shownAt = now;
      seen += 1;
    }
    shown = {
      ...line,
      settled: extra.settled ?? false,
      growing: extra.growing ?? false,
    };
  };
  const frame = (): TickerFrame | null =>
    shown === null
      ? null
      : {
          text: shown.text,
          sign: shown.sign,
          key,
          settled: shown.settled,
          growing: shown.growing,
        };

  return {
    id,
    next(view, now) {
      const all = linesOf(view);
      const newest = all.at(-1);
      if (newest !== undefined) {
        if (
          last === null ||
          !sameLine(last, newest) ||
          last.text !== newest.text
        ) {
          last = { ...newest, since: now };
        }
      }
      const seenTitle = titleIn(view);
      if (
        seenTitle !== null &&
        (title === null || outranks(seenTitle, title))
      ) {
        title = seenTitle;
      }
      const growingCommand =
        !view.done && view.stage === "writing" && isCommand(view);
      const wordy = (l: Line): boolean =>
        !opts.skipTrivial || WORD.test(l.text);
      // What may show now: whole lines, and the newest line once it holds
      // still — or, for a command being written, as it grows.
      const newestWaits =
        opts.wholeLines &&
        !view.done &&
        !growingCommand &&
        newest !== undefined &&
        wordy(newest) &&
        last !== null &&
        now - last.since < STABLE_MS;
      const wakeAt: number | null =
        newestWaits && last !== null ? last.since + STABLE_MS : null;
      const candidates = all.filter(
        (l) => wordy(l) && !(newestWaits && l === newest),
      );

      const growing = (l: Line): boolean =>
        opts.commandEnd && growingCommand && l === newest;

      if (opts.dwellMs === 0 && !(view.done && opts.headline)) {
        const target = candidates.at(-1);
        if (target !== undefined)
          show(target, now, { growing: growing(target) });
        return { frame: frame(), wakeAt };
      }

      if (!view.done) {
        const target = candidates.at(-1);
        if (target === undefined) return { frame: frame(), wakeAt };
        if (shown === null || sameLine(target, shown)) {
          show(target, now, { growing: growing(target) });
          return { frame: frame(), wakeAt };
        }
        if (after(target, shown)) {
          if (now - shownAt >= opts.dwellMs) {
            show(target, now, { growing: growing(target) });
            return { frame: frame(), wakeAt };
          }
          const holdEnds = shownAt + opts.dwellMs;
          return {
            frame: frame(),
            wakeAt: wakeAt === null ? holdEnds : Math.min(wakeAt, holdEnds),
          };
        }
        return { frame: frame(), wakeAt };
      }

      // Done: play out, then settle on the headline — the strongest title
      // seen on the way (a command's output has none: its last line).
      const end = opts.headline
        ? view.stage === "running"
          ? headlineOf(view)
          : (title ?? headlineOf(view))
        : (candidates.at(-1) ?? null);
      if (end === null) {
        if (shown !== null && !shown.settled)
          show(shown, now, { settled: true });
        return { frame: frame(), wakeAt: null };
      }
      if (shown?.settled === true) return { frame: frame(), wakeAt: null };
      if (plan === null) {
        plan = [];
        const pool = candidates.filter(
          (l) => !sameLine(l, end) && WORD.test(l.text),
        );
        if (opts.flyby && seen < 2 && pool.length >= 2) {
          // Two lines from across what was written, in order.
          const a = pool[Math.floor(pool.length / 3)];
          const b = pool[Math.floor((pool.length * 2) / 3)];
          if (a !== undefined) plan.push(a);
          if (b !== undefined && b !== a) plan.push(b);
        }
      }
      // The line on screen keeps a hold — a brisk one: the step is over.
      const hold = shown === null ? 0 : Math.min(opts.dwellMs, FLYBY_MS);
      if (shown !== null && now - shownAt < hold) {
        return { frame: frame(), wakeAt: shownAt + hold };
      }
      const nextLine = plan.shift();
      if (nextLine !== undefined) {
        show(nextLine, now);
        return { frame: frame(), wakeAt: now + FLYBY_MS };
      }
      show(end, now, { settled: true });
      return { frame: frame(), wakeAt: null };
    },
  };
}
