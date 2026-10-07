import type { TerminalRecordBlock } from "@herta/app-server";
import type { SystemBlock } from "./group-record.js";
import { opPhase, type TracePhase } from "./op-phase.js";

export type { TracePhase } from "./op-phase.js";

/** The op member of the system-block digest union (no name-import needed). */
type OpDigest = Extract<NonNullable<SystemBlock["digest"]>, { kind: "op" }>;

/**
 * A structured result note for one op row. Structured, not a string, for the
 * same reason every digest is: the CARD localizes its chrome on the UI
 * locale, and a pre-baked string would freeze one language into the
 * derivation.
 */
export type TraceNote =
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "signal" }
  | {
      readonly kind: "tests";
      readonly summary: string;
      readonly failed: boolean;
    }
  | { readonly kind: "fail"; readonly code: string }
  | { readonly kind: "matches"; readonly n: number };

export interface TraceOp {
  readonly verb: OpDigest["verb"];
  /** The op's argument — the record row's own string, verbatim (D7). */
  readonly arg: string;
  /** "running" = no result row yet and no later op has started.
   *  "queued" (a pending step only) = written by the model, waiting behind
   *  the step in flight — the calls of one message run one after another. */
  readonly status: "running" | "ok" | "fail" | "queued";
  readonly note?: TraceNote;
  readonly phase: TracePhase;
}

/**
 * A step not in the record yet (ADR 0073), seen through its live view: the
 * call the model is still writing, one written and waiting its turn, or one
 * that ran while the record lagged behind (it waits on Herta's beats). Shown
 * at the tail until its own op row lands, with the status the live view
 * knows.
 */
export interface PendingOp {
  readonly verb: OpDigest["verb"];
  readonly arg: string;
  readonly phase: TracePhase;
  readonly status: TraceOp["status"];
  /** Its phase is not known yet (a command whose line is still being
   *  written): it stays with the phase before it rather than open a node
   *  that may fold back into that one a moment later. */
  readonly tentative?: true;
}

/**
 * The step the live views last heard from (ADR 0073): its whole-dispatch
 * index, and its status as the view knows it — ahead of the record, whose
 * result row may not have landed yet.
 */
export interface TraceFocus {
  readonly op: number;
  readonly status: TraceOp["status"];
}

/**
 * Consecutive ops of one phase (ADR 0073, the trace card's variant C): the
 * run reads as looked → changed → checked, a phase at a time, and a phase
 * the run came back to is a new segment — 修改 → 验证 ✗ → 修改 → 验证 ✓ is
 * the story of a fix.
 */
export interface TraceSegment {
  /** 0-based index of the segment within the dispatch (the row key). */
  readonly ordinal: number;
  readonly phase: TracePhase;
  readonly ops: readonly TraceOp[];
  /** 0-based index of `ops[0]` within the dispatch (the op rows' keys). */
  readonly firstOpOrdinal: number;
  /** As its last op stands: "running" while it runs, "queued" while it
   *  waits its turn, else as it ended. */
  readonly status: TraceOp["status"];
  /** Ops of the segment that failed. */
  readonly failures: number;
}

/** Segments the card keeps (the newest); older ones leave at the head.
 *  The counts stay whole-dispatch. */
export const TRACE_MAX_SEGMENTS = 8;

export interface TraceContext {
  /** The newest segments of the dispatch (≤ TRACE_MAX_SEGMENTS), oldest
   *  first. */
  readonly segments: readonly TraceSegment[];
  /** Total op count of the dispatch (the header's `N 步`). */
  readonly steps: number;
  /** Distinct files written (Writing-verb args), over the whole dispatch. */
  readonly writes: number;
  /** The dispatch is live (its marker has not landed). */
  readonly live: boolean;
  /** While live: the step being worked — `op` its whole-dispatch index,
   *  `segment` the ordinal of the segment holding it. Not always the newest:
   *  steps written behind it wait their turn. Between steps, while 板砖
   *  thinks, the newest. Null once settled. */
  readonly current: { readonly segment: number; readonly op: number } | null;
}

/**
 * Why there is no trace in scope: a caller that RETRACTS on the answer must
 * know whether the dispatch ENDED or the window merely truncated the scan.
 */
export type TraceScope =
  | {
      readonly kind: "trace";
      readonly ops: readonly TraceOp[];
      /** The scan reached the dispatch's start (a user block or an earlier
       *  marker): `ops` is the whole dispatch, not the tail a truncated
       *  record window left — so its length counts the dispatch's op rows. */
      readonly complete: boolean;
    }
  | {
      readonly kind: "ended";
      /** The ended dispatch's ops (the marker's own run) — what the held
       *  view shows, re-read from the record rather than from a copy taken
       *  a commit earlier (lab 2026-09-30). Empty when the window holds
       *  none of them. */
      readonly ops: readonly TraceOp[];
    }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

/**
 * The CURRENT dispatch's operations, derived from the record's own activity
 * rows (the 操作轨迹 rail card, 2026-08-17; phases ADR 0073). Nothing new is
 * emitted: every string shown is a digest field of a block the user (and
 * Herta) already has (D7).
 *
 * Scan boundaries:
 *   - herta blocks do NOT stop the scan (a beat splits one run into several
 *     activity groups; the trace is a property of the dispatch);
 *   - a user block stops it (turn boundary) — ops found → trace, none →
 *     absent; a steer (ADR 0063 §1.10) sits inside the run it interrupted;
 *   - a terminal marker stops it — ops found ABOVE it belong to a NEWER
 *     chained dispatch → trace; none → ended;
 *   - running off the start of the windowed array concludes nothing: ops in
 *     hand are still shown (a partial trace claims recency, not
 *     completeness), but with none the answer is unknown and a live card
 *     should HOLD (outcome-inference rule, audit 2026-07-26).
 *
 * Status attach is serial by construction: result rows (`↳ 退出 …`, `↳ 测试
 * …`, failure rows) land immediately after their op, so a new op starting
 * settles the previous one as "ok" if no result row claimed otherwise.
 */
export function traceScope(record: readonly TerminalRecordBlock[]): TraceScope {
  const collected: SystemBlock[] = [];
  for (let i = record.length - 1; i >= 0; i -= 1) {
    const block = record[i];
    if (block === undefined) continue;
    if (block.kind === "user" && block.steer === true) continue;
    if (block.kind === "user") {
      const ops = collectOps(collected);
      return ops.length > 0
        ? { kind: "trace", ops, complete: true }
        : { kind: "absent" };
    }
    if (block.kind !== "system") continue;
    if (block.role === "done-marker" || block.role === "noop-marker") {
      const ops = collectOps(collected);
      return ops.length > 0
        ? { kind: "trace", ops, complete: true }
        : { kind: "ended", ops: endedOps(record, i) };
    }
    collected.push(block);
  }
  const ops = collectOps(collected);
  return ops.length > 0
    ? { kind: "trace", ops, complete: false }
    : { kind: "unknown" };
}

/** The ops of the dispatch whose marker sits at `markerAt`: back to the
 *  user block or the marker before it. */
function endedOps(
  record: readonly TerminalRecordBlock[],
  markerAt: number,
): TraceOp[] {
  const collected: SystemBlock[] = [];
  for (let i = markerAt - 1; i >= 0; i -= 1) {
    const block = record[i];
    if (block === undefined) continue;
    if (block.kind === "user" && block.steer !== true) break;
    if (block.kind !== "system") continue;
    if (block.role === "done-marker" || block.role === "noop-marker") break;
    collected.push(block);
  }
  return collectOps(collected);
}

/** Collected newest-first; processed oldest-first. */
function collectOps(collectedNewestFirst: readonly SystemBlock[]): TraceOp[] {
  const ops: TraceOp[] = [];
  const amendLast = (patch: Partial<TraceOp>): void => {
    const last = ops[ops.length - 1];
    if (last === undefined) return;
    ops[ops.length - 1] = { ...last, ...patch };
  };
  for (let i = collectedNewestFirst.length - 1; i >= 0; i -= 1) {
    const d = collectedNewestFirst[i]?.digest;
    if (d === undefined) continue;
    switch (d.kind) {
      case "op": {
        // Serial completion: the next op starting means the previous one
        // finished; a result row would already have settled it.
        const last = ops[ops.length - 1];
        if (last !== undefined && last.status === "running") {
          amendLast({ status: "ok" });
        }
        ops.push({
          verb: d.verb,
          arg: d.arg,
          status: "running",
          // A test run recognised at dispatch is a check from its op row on
          // (ADR 0073 amendment 2026-10-08): `arg` is the 80-char header,
          // which can cut the test run off, and waiting for the test row
          // re-sorted the card when it landed. Rows written before the flag
          // still wait for that row (below).
          phase: d.runsTests === true ? "verify" : opPhase(d.verb, d.arg),
        });
        break;
      }
      case "text": {
        if (d.exitCode === undefined) break; // generic text row, not a result
        if (d.exitCode === null) {
          amendLast({ status: "fail", note: { kind: "signal" } });
        } else {
          amendLast({
            status: d.exitCode === 0 ? "ok" : "fail",
            note: { kind: "exit", code: d.exitCode },
          });
        }
        break;
      }
      case "tests": {
        const failed = d.status === "failed";
        // A test run is a check, whatever the command looked like.
        amendLast({
          status: failed ? "fail" : "ok",
          note: { kind: "tests", summary: d.summary, failed },
          phase: "verify",
        });
        break;
      }
      case "tool-fail":
        amendLast({ status: "fail", note: { kind: "fail", code: d.code } });
        break;
      case "search":
        amendLast({ note: { kind: "matches", n: d.matches } });
        break;
      default:
        break; // bg / excerpt / finding / attachment / skip / legacy todo
    }
  }
  return ops;
}

/**
 * The card's view of a dispatch: its ops grouped into phase segments, the
 * newest window of them, and the header's counts and chips.
 *
 * `pending` are the run's calls with no op row yet (ADR 0073), in order —
 * appended as the tail, so the card already says what is coming, and what
 * ran while the record lagged behind Herta's beats. `focus` is the step the
 * live views last heard from; its finish settles its record row before the
 * result row lands. `settled` is the held post-run view: the marker landed,
 * nothing is in flight, so a running tail is finished.
 *
 * The step being worked: the focused one while it runs; else one that runs;
 * else the first one waiting its turn (it is next — or parked on an
 * approval); else the newest (板砖 is thinking).
 */
export function buildTrace(
  recordOps: readonly TraceOp[],
  opts: {
    readonly pending?: readonly PendingOp[];
    readonly focus?: TraceFocus | null;
    readonly settled?: boolean;
  } = {},
): TraceContext {
  let ops: readonly TraceOp[] = recordOps;
  const pending = opts.pending ?? [];
  const focus = opts.settled ? null : (opts.focus ?? null);
  if (
    focus !== null &&
    (focus.status === "ok" || focus.status === "fail") &&
    ops[focus.op]?.status === "running"
  ) {
    ops = ops.map((op, i) =>
      i === focus.op ? { ...op, status: focus.status } : op,
    );
  }
  if (pending.length > 0 && !opts.settled) {
    // A later step started (or is being written: the model writes only once
    // every call before has finished) — the record's running tail is
    // finished. One merely waiting behind it says nothing of the kind.
    const last = ops[ops.length - 1];
    const later = pending.some((p) => p.status !== "queued");
    const merged: TraceOp[] =
      later && last?.status === "running"
        ? [...ops.slice(0, -1), { ...last, status: "ok" as const }]
        : [...ops];
    for (const { tentative, ...p } of pending) {
      const before = merged[merged.length - 1]?.phase;
      merged.push(
        tentative && before !== undefined ? { ...p, phase: before } : p,
      );
    }
    ops = merged;
  }
  if (opts.settled) {
    ops = ops.map((op) =>
      op.status === "running" || op.status === "queued"
        ? { ...op, status: "ok" as const }
        : op,
    );
  }

  const segments: TraceSegment[] = [];
  let current: TraceOp[] = [];
  let firstOp = 0;
  const close = (): void => {
    const phase = current[0]?.phase;
    if (phase === undefined) return;
    const last = current[current.length - 1] as TraceOp;
    segments.push({
      ordinal: segments.length,
      phase,
      ops: current,
      firstOpOrdinal: firstOp,
      status: last.status,
      failures: current.filter((o) => o.status === "fail").length,
    });
  };
  ops.forEach((op, i) => {
    if (current.length > 0 && current[0]?.phase !== op.phase) {
      close();
      current = [];
      firstOp = i;
    }
    current.push(op);
  });
  close();

  const live = opts.settled !== true;
  let inFlight: TraceContext["current"] = null;
  if (live && ops.length > 0) {
    let running = -1;
    ops.forEach((o, i) => {
      if (o.status === "running") running = i;
    });
    const next = ops.findIndex((o) => o.status === "queued");
    const op =
      focus !== null && ops[focus.op]?.status === "running"
        ? focus.op
        : running !== -1
          ? running
          : next !== -1
            ? next
            : ops.length - 1;
    let segment: TraceSegment | undefined;
    for (const s of segments) if (s.firstOpOrdinal <= op) segment = s;
    if (segment !== undefined) inFlight = { segment: segment.ordinal, op };
  }

  return {
    segments:
      segments.length > TRACE_MAX_SEGMENTS
        ? segments.slice(-TRACE_MAX_SEGMENTS)
        : segments,
    steps: ops.length,
    writes: new Set(
      ops.filter((op) => op.verb === "Writing").map((op) => op.arg),
    ).size,
    live,
    current: inFlight,
  };
}

/** What a segment did, counted for its one-line summary (the card composes
 *  the words). Names are the ops' own arguments, verbatim (D7). */
export interface SegmentTally {
  /** Distinct files read, in first-read order. */
  readonly reads: readonly string[];
  readonly searches: number;
  readonly inspects: number;
  /** Distinct files written, in first-write order. */
  readonly writes: readonly string[];
  /** Commands run, in order. */
  readonly runs: readonly string[];
  readonly digests: number;
  readonly memories: number;
  readonly stops: number;
}

export function tallySegment(ops: readonly TraceOp[]): SegmentTally {
  const reads: string[] = [];
  const writes: string[] = [];
  const runs: string[] = [];
  let searches = 0;
  let inspects = 0;
  let digests = 0;
  let memories = 0;
  let stops = 0;
  for (const op of ops) {
    switch (op.verb) {
      case "Reading":
        if (!reads.includes(op.arg)) reads.push(op.arg);
        break;
      case "Writing":
        if (!writes.includes(op.arg)) writes.push(op.arg);
        break;
      case "Running":
        runs.push(op.arg);
        break;
      case "Searching":
        searches += 1;
        break;
      case "Inspecting":
        inspects += 1;
        break;
      case "Digesting":
        digests += 1;
        break;
      case "Saving memory":
        memories += 1;
        break;
      case "Stopping":
        stops += 1;
        break;
      default:
        break;
    }
  }
  return { reads, searches, inspects, writes, runs, digests, memories, stops };
}
