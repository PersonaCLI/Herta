import { useEffect, useMemo, useReducer, useRef } from "react";
import { useListTransitions } from "../../hooks/useListTransitions.js";
import { usePresence } from "../../hooks/usePresence.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type { LiveToolView } from "../../ipc/bridge-types.js";
import { VERB_KEY } from "../Workspace/step-display.js";
import {
  type TraceNote,
  type TraceSegment,
  tallySegment,
} from "../Workspace/trace-context.js";
import { useScrollEdges } from "../Workspace/useScrollEdges.js";
import {
  CARD_ROW_ENTER_MS,
  CARD_TICKER_HOLD_MS,
  CARD_TICKER_MS,
  cardRowMotion,
  rowPhaseClass,
} from "./card-motion.js";
import {
  createTicker,
  TICKER_PACED,
  type Ticker,
  type TickerFrame,
  type TickerOptions,
} from "./ticker-pacer.js";
import { useTraceCard } from "./useTraceCard.js";

type T = ReturnType<typeof useT>;

const PHASE_KEY = {
  explore: "trace.phase.explore",
  modify: "trace.phase.modify",
  verify: "trace.phase.verify",
} as const;

/**
 * 板砖's 操作轨迹 as a rail card (2026-08-17), as a timeline of phases (ADR
 * 0073; the owner's pick, 2026-09-30: "timeline + one flowing ticker line").
 *
 * One node per stretch of one phase — 探索, 修改, 验证 — down a hairline, so
 * the run reads as the path it took. A finished node folds to one counted
 * line (`探索 · 读取 parser.ts 等 3 个文件，检索 2 次`) with how it ended; the
 * node in flight names its current step and, under it, one ticker line:
 * the newest line of what that step is producing — the file as the model
 * writes it, the command's output as it prints — flowing as it arrives. No
 * code box: a step's output is often over in a moment, and a pane that
 * appears and vanishes reads as flicker, not information. A step the model
 * has written but not run yet waits below the one in flight, faint.
 *
 * Every node is the record's own op rows, re-read (D7); the ticker is the
 * one thing the record does not carry, and it is screen-only — gone with the
 * run. Chrome: the .plan-card family (glass, slide-in, fog). Form, not
 * motion (2026-07-27): the node in flight is a hollow LED ring, dashed while
 * parked on an approval; the only thing that moves is the text itself.
 */
export function TraceCard(): JSX.Element | null {
  const t = useT();
  const { trace, live, open, waiting, settled } = useTraceCard();
  const reduced = useReducedMotion();
  const listRef = useRef<HTMLOListElement>(null);
  const edges = useScrollEdges(listRef, trace);

  const keyed = useMemo(
    () =>
      (trace?.segments ?? EMPTY).map((segment) => ({
        id: String(segment.ordinal),
        segment,
      })),
    [trace],
  );
  const rows = useListTransitions(
    keyed,
    keyOf,
    cardRowMotion(reduced, settled),
  );

  // Follow the tail — the node in flight is the one being watched — unless
  // the reader scrolled up to look at an earlier one (the pin releases past
  // ~1½ rows of drift).
  //
  // Frame by frame through the entrance (2026-10-08): an entering node opens
  // from zero height and its ticker eases open under it, so following once
  // up front left the new node growing below the fold, and the catch-up when
  // its entrance ended jumped the list by a whole node. Tracking the tail
  // while it grows makes the list glide with it. A scroll the loop did not
  // write is the reader's, and ends it.
  useEffect(() => {
    const el = listRef.current;
    if (el === null || trace === null) return;
    const drift = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (drift >= 40 && el.scrollTop !== 0) return;
    const until = performance.now() + CARD_ROW_ENTER_MS + CARD_TICKER_MS;
    let written: number | null = null;
    let frame = 0;
    const follow = (now: number): void => {
      if (written !== null && Math.abs(el.scrollTop - written) > 2) return;
      el.scrollTop = el.scrollHeight;
      written = el.scrollTop;
      if (now < until) frame = requestAnimationFrame(follow);
    };
    follow(performance.now());
    return () => cancelAnimationFrame(frame);
  }, [trace]);

  if (trace === null) return null;

  // Counts cover the WHOLE dispatch; the timeline is the recent window.
  const counts = [t("trace.card.steps", { n: String(trace.steps) })];
  if (trace.writes > 0) {
    counts.push(t("trace.card.files", { n: String(trace.writes) }));
  }
  const current = trace.current;
  // A row's segment as THIS trace has it: the transition list hands its
  // items back a commit late, and the node in flight must be drawn from the
  // same trace that says it is in flight.
  const now = new Map(trace.segments.map((s) => [s.ordinal, s]));

  return (
    <section
      className={`plan-card trace-card${open ? " is-open" : ""}${
        waiting ? " is-waiting" : ""
      }`}
      data-testid="trace-card"
      aria-label={t("trace.card.title")}
      aria-hidden={!open}
    >
      <header className="plan-card__head">
        <span className="plan-card__title">{t("trace.card.title")}</span>
        <span className="plan-card__count">{counts.join(" · ")}</span>
      </header>
      <ol
        ref={listRef}
        className={`plan-card__list trace-card__list${
          edges.top ? " has-fog-top" : ""
        }${edges.bottom ? " has-fog-bottom" : ""}`}
      >
        {rows.map((row) => {
          const segment =
            (row.phase !== "leave"
              ? now.get(row.item.segment.ordinal)
              : undefined) ?? row.item.segment;
          // The node holding the step being worked, while the dispatch is
          // live — the newest between steps, while 板砖 thinks; one with
          // steps queued behind it while they wait their turn.
          const inFlight =
            current !== null &&
            row.phase !== "leave" &&
            segment.ordinal === current.segment;
          // A read has no stream: its node names the step, and that is all.
          const stream = inFlight && live?.streams === true ? live : null;
          return (
            <li
              key={row.key}
              className={`trace-card__segment trace-node is-${segment.phase} is-${segment.status}${
                inFlight ? " is-in-flight" : ""
              }${rowPhaseClass(row.phase)}`}
              aria-hidden={row.phase === "leave" || undefined}
            >
              <span className="trace-node__dot" aria-hidden="true" />
              <div className="trace-node__body">
                {inFlight ? (
                  <InFlight
                    segment={segment}
                    step={segment.ops[current.op - segment.firstOpOrdinal]}
                    live={stream}
                    t={t}
                  />
                ) : (
                  <div className="trace-node__line">
                    <span className="trace-node__phase">
                      {t(PHASE_KEY[segment.phase])}
                    </span>
                    <span
                      className="trace-card__text"
                      title={foldedText(segment, t)}
                    >
                      {foldedText(segment, t)}
                    </span>
                    {segmentNote(segment, t)}
                  </div>
                )}
                <TickerSlot inFlight={inFlight}>
                  {stream !== null ? <LiveTicker live={stream} t={t} /> : null}
                </TickerSlot>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * The node in flight: its phase and current step, and how many lines the
 * step has produced. What it is producing — the ticker — is its own
 * component below the line ({@link TickerSlot}), so it can ease shut when
 * the node folds instead of vanishing with it.
 */
function InFlight(props: {
  readonly segment: TraceSegment;
  readonly step: TraceSegment["ops"][number] | undefined;
  /** The step's streaming view, if it has one (a read has none). */
  readonly live: LiveToolView | null;
  readonly t: T;
}): JSX.Element {
  const { segment, step, live, t } = props;
  const text =
    step === undefined
      ? ""
      : `${verbText(step.verb, t)} ${step.arg.length > 0 ? step.arg : "…"}`;
  return (
    <div className="trace-node__line">
      <span className="trace-node__phase">{t(PHASE_KEY[segment.phase])}</span>
      <span className="trace-card__text" title={text}>
        {text}
      </span>
      {live !== null && live.lines > 0 ? (
        <span className="trace-card__note">
          {t(live.lines === 1 ? "trace.live.lineOne" : "trace.live.lines", {
            n: String(live.lines),
          })}
        </span>
      ) : (
        step?.note !== undefined && (
          <span
            className={`trace-card__note${
              step.status === "fail" ? " is-fail" : ""
            }`}
          >
            {noteText(step.note, t)}
          </span>
        )
      )}
    </div>
  );
}

/**
 * The ticker under the node in flight: what the step is producing, paced for
 * the eye (ticker-pacer.ts). Each new line rises into place and holds long
 * enough to be read; a line still being written waits until it is whole; when
 * the step ends the ticker settles on what it did, not on its last `}`.
 */
function LiveTicker(props: {
  readonly live: LiveToolView;
  readonly t: T;
}): JSX.Element {
  const { live, t } = props;
  const ticker = useTickerFrame(live, TICKER_PACED);
  // The step is over once its ticker has settled — a fly-by still playing
  // keeps its cursor.
  const settled = ticker !== null ? ticker.settled : live.done === true;
  return (
    <div
      className={`trace-ticker${settled ? " is-done" : ""}${
        live.ok === false ? " is-fail" : ""
      }${ticker?.growing === true ? " is-growing" : ""}`}
      data-testid="trace-ticker"
    >
      {ticker === null ? (
        <span className="trace-ticker__empty">
          {live.stage === "running" ? t("trace.live.noOutput") : "…"}
        </span>
      ) : (
        <span
          // A new line rises into place; the same line growing does not
          // remount, so its characters simply flow in.
          key={ticker.key}
          className={`trace-ticker__line${
            ticker.sign === "+"
              ? " is-add"
              : ticker.sign === "-"
                ? " is-del"
                : ""
          }`}
        >
          <span className="trace-ticker__text">{ticker.text}</span>
        </span>
      )}
      <span className="trace-ticker__cursor" aria-hidden="true" />
    </div>
  );
}

/**
 * The ticker's place under a node, eased open and shut (owner 2026-10-08:
 * "the new row appeared like a flash"). It used to come and go with the
 * node's in-flight state, in one frame: when the next node arrived, the
 * previous one lost its ticker line at once — the card dipped by a line —
 * and the new one opened from nothing, so every step change jolted the card.
 *
 * Closing, it keeps the last ticker it was given (the same element, so the
 * ticker inside renders exactly what it last showed) while the row eases
 * shut, marked hidden; a node that comes back in flight mid-close re-opens in
 * place. Reduced motion: the CSS drops the transition.
 *
 * A node still in flight that loses its ticker for a moment keeps it for
 * {@link CARD_TICKER_HOLD_MS} first (lab 2026-10-08): while 板砖 starts
 * writing its next call, the ticker's call is briefly that queued draft, not
 * the step in flight, and the line eased half shut and open again — a blink
 * on every step. A node that FOLDS lets go at once.
 */
function TickerSlot(props: {
  readonly inFlight: boolean;
  readonly children: JSX.Element | null;
}): JSX.Element | null {
  const has = props.children !== null;
  const seenAt = useRef(0);
  const [, recheck] = useReducer((n: number) => n + 1, 0);
  const now = Date.now();
  if (has) seenAt.current = now;
  const held =
    !has && props.inFlight && now - seenAt.current < CARD_TICKER_HOLD_MS;
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(
      recheck,
      CARD_TICKER_HOLD_MS - (Date.now() - seenAt.current) + 1,
    );
    return () => clearTimeout(timer);
  }, [held]);
  const active = has || held;
  const { mounted, open } = usePresence(active, CARD_TICKER_MS);
  const last = useRef<JSX.Element | null>(null);
  if (props.children !== null) last.current = props.children;
  if (!mounted || last.current === null) return null;
  return (
    <div
      className={`trace-node__slot${open ? " is-open" : ""}${
        active ? "" : " is-closing"
      }`}
      aria-hidden={active ? undefined : true}
    >
      <div className="trace-node__slot-inner">{last.current}</div>
    </div>
  );
}

/**
 * The ticker's frame for a live view: one pacer per call (a new call starts
 * fresh), asked again on every snapshot and whenever it said something is
 * due (a hold ends, a line turns whole, the fly-by moves on).
 */
function useTickerFrame(
  live: LiveToolView | null,
  opts: TickerOptions,
): TickerFrame | null {
  const ticker = useRef<Ticker | null>(null);
  const [, wake] = useReducer((n: number) => n + 1, 0);
  let frame: TickerFrame | null = null;
  let wakeAt: number | null = null;
  if (live !== null) {
    if (ticker.current === null || ticker.current.id !== live.id) {
      ticker.current = createTicker(live.id, opts);
    }
    const next = ticker.current.next(live, Date.now());
    frame = next.frame;
    wakeAt = next.wakeAt;
  }
  useEffect(() => {
    if (wakeAt === null) return;
    const timer = setTimeout(wake, Math.max(0, wakeAt - Date.now()));
    return () => clearTimeout(timer);
  }, [wakeAt]);
  return frame;
}

const EMPTY: readonly TraceSegment[] = [];
const keyOf = (k: { readonly id: string }): string => k.id;

/** Localized verb via the record rows' own map; an unknown verb (a newer
 *  record on an older renderer) falls back to the raw token. */
function verbText(verb: string, t: T): string {
  const key = VERB_KEY[verb];
  return key !== undefined ? t(key) : verb;
}

function noteText(note: TraceNote, t: T): string {
  switch (note.kind) {
    case "exit":
      return `${t("activity.result.exit")} ${note.code}`;
    case "signal":
      return t("activity.bg.signal");
    case "tests":
      return `${t("activity.result.tests")} ${note.summary}`;
    case "fail":
      return note.code;
    case "matches":
      return `${note.n} ${t("activity.result.matches")}`;
  }
}

/** A path's last part: the name a reader recognises. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

type MessageKeyOf = Parameters<T>[0];

/** A folded node's line: what it did — or, while it waits its turn, what it
 *  is going to do, step by step (nothing has happened to count yet). */
function foldedText(segment: TraceSegment, t: T): string {
  if (segment.status !== "queued") return segmentSummary(segment, t);
  return segment.ops
    .map((op) => `${verbText(op.verb, t)} ${op.arg.length > 0 ? op.arg : "…"}`)
    .join(t("trace.sum.sep"));
}

/** A finished segment in one line: what it did, counted (the ops' own
 *  arguments for the names, verbatim). */
export function segmentSummary(segment: TraceSegment, t: T): string {
  const tally = tallySegment(segment.ops);
  const parts: string[] = [];
  const [firstRead] = tally.reads;
  if (firstRead !== undefined) {
    parts.push(
      tally.reads.length === 1
        ? t("trace.sum.readOne", { name: baseName(firstRead) })
        : t("trace.sum.readMany", {
            name: baseName(firstRead),
            n: String(tally.reads.length),
          }),
    );
  }
  if (tally.searches > 0) {
    parts.push(
      tally.searches === 1
        ? t("trace.sum.searchOne")
        : t("trace.sum.searchMany", { n: String(tally.searches) }),
    );
  }
  if (tally.inspects > 0) parts.push(t("trace.sum.inspect"));
  const [firstWrite] = tally.writes;
  if (firstWrite !== undefined) {
    parts.push(
      tally.writes.length === 1
        ? t("trace.sum.writeOne", { name: baseName(firstWrite) })
        : t("trace.sum.writeMany", {
            name: baseName(firstWrite),
            n: String(tally.writes.length),
          }),
    );
  }
  const [firstRun] = tally.runs;
  if (firstRun !== undefined) {
    parts.push(
      tally.runs.length === 1
        ? t("trace.sum.runOne", { cmd: firstRun })
        : t("trace.sum.runMany", { n: String(tally.runs.length) }),
    );
  }
  const counted = (n: number, one: MessageKeyOf, many: MessageKeyOf): void => {
    if (n === 0) return;
    parts.push(n === 1 ? t(one) : t(many, { n: String(n) }));
  };
  counted(tally.digests, "trace.sum.digestOne", "trace.sum.digestMany");
  counted(tally.memories, "trace.sum.memoryOne", "trace.sum.memoryMany");
  counted(tally.stops, "trace.sum.stopOne", "trace.sum.stopMany");
  return parts.join(t("trace.sum.sep"));
}

/** How a finished segment ended: its last step's result, or how many of
 *  its steps failed when the last one did not. */
function segmentNote(segment: TraceSegment, t: T): JSX.Element | null {
  const last = segment.ops[segment.ops.length - 1];
  if (last?.note !== undefined) {
    return (
      <span
        className={`trace-card__note${last.status === "fail" ? " is-fail" : ""}`}
      >
        {noteText(last.note, t)}
      </span>
    );
  }
  if (segment.failures > 0 && last?.status !== "fail") {
    return (
      <span className="trace-card__note is-fail">
        {t("trace.sum.failed", { n: String(segment.failures) })}
      </span>
    );
  }
  return null;
}
