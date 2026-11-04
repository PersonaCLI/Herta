import {
  type ActivityRow,
  type ActivitySummary,
  activityRows,
  activitySummary,
  type RunEntry,
  type SteerBlock,
  type SystemBlock,
} from "./group-record.js";
import { opPhase, type TracePhase } from "./op-phase.js";
import { runOps, type TraceOp } from "./trace-context.js";

/** A live run's state, in the device's own words (ADR 0085 §9). */
export type RunLiveState = "working" | "verifying" | "waiting";

/** What a run's row and its 完整记录 tab say about it, from its blocks
 *  alone (D7: nothing the record does not hold). */
export interface RunFacts {
  readonly ops: readonly TraceOp[];
  /** Its op rows: the `N 步`. */
  readonly steps: number;
  /** Distinct files written. */
  readonly files: number;
  /** The marker's roll-up; null while it runs, or for a run the record
   *  holds no marker for (one cut short before the bridge could write it). */
  readonly summary: ActivitySummary | null;
  /** The phase of its newest step. */
  readonly phase: TracePhase | undefined;
  /** When it started: her dispatching bubble, else its first row. */
  readonly startedAt: string | undefined;
  /** When it ended: its marker's stamp. */
  readonly endedAt: string | undefined;
}

export function runFacts(
  blocks: readonly SystemBlock[],
  dispatchedAt?: string,
): RunFacts {
  const ops = runOps(blocks);
  const marker = blocks.find(
    (b) => b.role === "done-marker" || b.role === "noop-marker",
  );
  return {
    ops,
    steps: ops.length,
    files: new Set(ops.filter((o) => o.verb === "Writing").map((o) => o.arg))
      .size,
    summary: activitySummary(blocks),
    phase: ops[ops.length - 1]?.phase,
    startedAt: dispatchedAt ?? blocks[0]?.at,
    endedAt: marker?.at,
  };
}

/** The live row's state word: an approval holds it; a check reads as one. */
export function liveState(
  phase: TracePhase | undefined,
  waiting: boolean,
): RunLiveState {
  if (waiting) return "waiting";
  return phase === "verify" ? "verifying" : "working";
}

/** How long it took, from the record's stamps; null when they say nothing. */
export function runTookMs(facts: RunFacts): number | null {
  if (facts.startedAt === undefined || facts.endedAt === undefined) return null;
  const ms = Date.parse(facts.endedAt) - Date.parse(facts.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** `42s`, `3:07` — the activity line's own form. */
export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${`${s}`.padStart(2, "0")}`;
}

/** A stretch of the 完整记录 tab (ADR 0085 amendment 2026-11-04): rows of
 *  one phase under its heading, or a steer where 板砖 took it. `key` is the
 *  run entry it starts at, stable as rows arrive. */
export type RunSection =
  | {
      readonly kind: "phase";
      readonly key: string;
      readonly phase: TracePhase;
      readonly rows: readonly ActivityRow[];
    }
  | {
      readonly kind: "steer";
      readonly key: string;
      readonly block: SteerBlock;
    };

/**
 * The run's rows under the card's phases (探索 / 修改 / 验证), none
 * summarised, in record order; a steer breaks the stretch it lands in. A
 * row takes the phase of the step it belongs to — a result, a finding, a
 * diff its op's — and a test run is a check whatever its command looked
 * like, as on the card (`trace-context.ts`). The marker is not a row: the
 * tab ends on its facts.
 */
export function runSections(entries: readonly RunEntry[]): RunSection[] {
  const at = new Map<SystemBlock | SteerBlock, number>();
  for (const [i, e] of entries.entries()) at.set(e.block, i);
  const out: RunSection[] = [];
  let pending: SystemBlock[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    const rows = activityRows(pending);
    pending = [];
    const phases = rowPhases(rows);
    let start = 0;
    for (let i = 1; i <= rows.length; i++) {
      if (i < rows.length && phases[i] === phases[start]) continue;
      const first = rows[start];
      const phase = phases[start];
      if (first !== undefined && phase !== undefined) {
        out.push({
          kind: "phase",
          key: `p${at.get(first.patch ?? first.block) ?? start}`,
          phase,
          rows: rows.slice(start, i),
        });
      }
      start = i;
    }
  };
  entries.forEach((e, i) => {
    if (e.kind === "row") {
      pending.push(e.block);
      return;
    }
    flush();
    out.push({ kind: "steer", key: `t${i}`, block: e.block });
  });
  flush();
  return out;
}

/** Each row's phase: its op's, or — before any op — the first op's. A test
 *  result makes its command a check; a test result with no command before it
 *  (an older record's) is a check on its own, and leaves the read before it
 *  where it was (lab 2026-11-04). */
function rowPhases(rows: readonly ActivityRow[]): TracePhase[] {
  const phases: (TracePhase | undefined)[] = [];
  let lastOp = -1;
  rows.forEach((row, i) => {
    const d = row.block.digest;
    const opAt = rows[lastOp]?.block.digest;
    if (d?.kind === "op") {
      phases.push(d.runsTests === true ? "verify" : opPhase(d.verb, d.arg));
      lastOp = i;
    } else if (d?.kind === "tests") {
      if (opAt?.kind === "op" && opAt.verb === "Running")
        for (let j = lastOp; j < i; j++) phases[j] = "verify";
      phases.push("verify");
    } else {
      phases.push(lastOp === -1 ? undefined : phases[lastOp]);
    }
  });
  const firstOp = phases.find((p) => p !== undefined) ?? "explore";
  return phases.map((p) => p ?? firstOp);
}
