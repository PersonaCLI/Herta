import { useEffect, useMemo } from "react";
import { opVerbOf } from "../../../shared/op-verb.js";
import { useApprovalPending } from "../../hooks/useApprovalPending.js";
import {
  useSessionScoped,
  useSessionScopedRef,
  useSessionScopedTimer,
} from "../../hooks/useSessionScoped.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import type { LiveToolSnapshot, LiveToolView } from "../../ipc/bridge-types.js";
import { commandPhase, opPhase } from "../Workspace/op-phase.js";
import {
  buildTrace,
  type PendingOp,
  type TraceContext,
  type TraceFocus,
  type TraceOp,
  type TraceScope,
  traceScope,
} from "../Workspace/trace-context.js";
import {
  withoutWorkspaceCd,
  workspaceRelative,
} from "../Workspace/workspace-path.js";
import { CARD_HOLD_MS, CARD_SLIDE_MS } from "./card-motion.js";

/** Slack past the slide before the retracted card is dropped (see
 *  useRepoCard's REPO_UNMOUNT_SLACK_MS for why it runs long). */
const TRACE_UNMOUNT_SLACK_MS = 120;

/** A run whose first call is being written before any of its rows landed:
 *  read as a first dispatch is, with nothing in the record yet. */
const FRESH_DISPATCH: TraceScope = { kind: "absent" };

const NO_PENDING: ReturnType<typeof pendingSteps> = {
  steps: [],
  focus: null,
};

export interface TraceCardState {
  readonly trace: TraceContext | null;
  /** The call the ticker follows (ADR 0073) while the run is live — the
   *  most recently heard-from one, when its step is the one in flight.
   *  Null otherwise. */
  readonly live: LiveToolView | null;
  readonly open: boolean;
  /** Parked on a permission gate: the newest op is WAITING, not being
   *  worked (audit 2026-07-26). */
  readonly waiting: boolean;
  /** A first trace has been on screen: appended rows are CHANGES and enter
   *  with the row motion (ADR 0058 §5.7); false while the card retracts. */
  readonly settled: boolean;
}

/**
 * A live call as the step it is (or will be, while still being written):
 * the verb its op row carries, the argument, the phase, and the status the
 * view knows. Null for a call that makes no op row.
 *
 * Once dispatched, the step is named by the record's own summary, so it
 * reads exactly as the row that replaces it; before, by what the arguments
 * say — a path only once it has streamed in whole, relative to the
 * workspace as the record spells it.
 */
export function stepOf(
  view: LiveToolView,
  workspace: string | null = null,
): PendingOp | null {
  const verb = opVerbOf(
    view.tool,
    view.tool === "str_replace_editor" && !view.streams,
  );
  if (verb === null) return null;
  const status: PendingOp["status"] = !view.done
    ? "running"
    : view.ok === false
      ? "fail"
      : "ok";
  const arg =
    view.summary !== undefined
      ? // The editor's summary leads with its command word; the row does not.
        view.tool === "str_replace_editor"
        ? view.summary
            .replace(/^(view|create|str_replace|insert)\s*/, "")
            .trim()
        : view.summary.trim()
      : verb === "Running"
        ? withoutWorkspaceCd(view.commandLine ?? "", workspace)
        : workspaceRelative(view.path ?? "", workspace);
  return {
    verb,
    arg,
    // A recognised test run is 验证 whatever its command — known at
    // dispatch, as the record's op row knows it (ADR 0073 amendment
    // 2026-10-08), so the step does not change node when its row lands.
    phase:
      view.runsTests === true
        ? "verify"
        : verb === "Running"
          ? commandPhase(arg)
          : opPhase(verb, arg),
    status,
    ...(verb === "Running" && arg.length === 0
      ? { tentative: true as const }
      : {}),
  };
}

/**
 * The run's steps the record does not have yet, in order — the card's tail.
 *
 * The record trails the backend: by a moment when a call is dispatched, by
 * seconds — several steps — while Herta speaks a beat (its drain waits on
 * her, lab 2026-09-30). Main numbers each op-making call as the record will
 * number its row, so the steps missing from the record are exactly those
 * numbered at or past its op count: no text is matched. Calls still being
 * written come after them — unless the record is already AHEAD of the feed
 * (a row landed before the snapshot that dispatched it), when a draft may
 * be that very row.
 *
 * A call written but not dispatched, and not the one being written, is
 * QUEUED: one message's calls run one after another, so it waits behind the
 * call in flight (lab 2026-09-30: a file drafted behind a running command
 * was drawn as the step in flight, the command's output under it).
 *
 * `focus`: the focused call's step — the one the ticker follows — by its
 * whole-dispatch index, with the status its view knows (ahead of the
 * record's, whose result row may not have landed); null when it has none.
 *
 * `recordOps` null: the record window was cut short of the dispatch's start
 * and cannot be counted — nothing is appended rather than a guess.
 */
export function pendingSteps(
  live: LiveToolSnapshot,
  recordOps: number | null,
  workspace: string | null = null,
): { readonly steps: PendingOp[]; readonly focus: TraceFocus | null } {
  if (recordOps === null) return { steps: [], focus: null };
  const focus = live.views.find((v) => v.id === live.focus);
  const focusStep = focus !== undefined ? stepOf(focus, workspace) : null;
  let focusOp =
    focus?.ordinal !== undefined && focus.ordinal < recordOps
      ? focus.ordinal
      : null;
  const dispatched = live.views
    .filter((v) => v.ordinal !== undefined && v.ordinal >= recordOps)
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  const drafts =
    recordOps <= live.startedOps ? live.views.filter((v) => !v.started) : [];
  const steps: PendingOp[] = [];
  for (const v of [...dispatched, ...drafts]) {
    const step = stepOf(v, workspace);
    if (step === null) continue;
    if (v === focus) focusOp = recordOps + steps.length;
    steps.push(
      !v.started && v !== focus ? { ...step, status: "queued" } : step,
    );
  }
  return {
    steps,
    focus:
      focusOp !== null && focusStep !== null
        ? { op: focusOp, status: focusStep.status }
        : null,
  };
}

/**
 * The rail 操作轨迹 card (2026-08-17; the timeline, ADR 0073) — the one
 * rail card that says what 板砖 is doing. Session-scoped state, a
 * hold-then-slide retract, and the unknown-scope hold, as the repository
 * card has them.
 *
 * The record decides the steps; the live views add what the record cannot
 * have yet — the steps it has not caught up with, the call the model is
 * still writing, and what the step in flight is producing (the ticker). A
 * dispatch whose first step is still being written already opens the card.
 */
export function useTraceCard(): TraceCardState {
  const record = useSessionSelector((s) => s.record);
  const liveSnapshot = useSessionSelector((s) => s.live);
  const backendActive = useSessionSelector((s) => s.backendActive);
  const workspace = useSessionSelector((s) => s.backendWorkspace);
  const waiting = useApprovalPending();
  // One scan per record commit (not per streaming delta).
  const recordScope = useMemo(() => traceScope(record), [record]);
  // A dispatch chained in the same actor turn: the record's last block is
  // still the previous run's marker while the new run's first call is being
  // written. A live view not yet done says so — the previous run's views are
  // all done once it ended — and the card opens on the new run as it does
  // for a first dispatch, rather than drawing the old one settled (review
  // 2026-09-30).
  const scope: TraceScope =
    recordScope.kind === "ended" &&
    backendActive &&
    liveSnapshot.views.some((v) => !v.done)
      ? FRESH_DISPATCH
      : recordScope;
  // The views outlive the backend's own end until the record catches up
  // (the store keeps them); once the record says the dispatch ended, they
  // describe nothing on it — unless a new run is already writing.
  const usable = backendActive || scope.kind === "trace";
  const recordOps =
    scope.kind === "trace" ? (scope.complete ? scope.ops.length : null) : 0;
  // By value: a live snapshot lands ten times a second, and the tail steps
  // (their verbs, arguments, statuses) change a few times a call — the
  // timeline is rebuilt only then.
  const pendingJson = JSON.stringify(
    usable ? pendingSteps(liveSnapshot, recordOps, workspace) : NO_PENDING,
  );
  const { steps: pending, focus: focusStep } = useMemo(
    () => JSON.parse(pendingJson) as ReturnType<typeof pendingSteps>,
    [pendingJson],
  );
  const focus = usable
    ? (liveSnapshot.views.find((v) => v.id === liveSnapshot.focus) ?? null)
    : null;

  const [ops, setOps] = useSessionScoped<readonly TraceOp[] | null>(null);
  /** The dispatch's marker landed: the held view shows it finished. */
  const [ended, setEnded] = useSessionScoped(false);
  const [open, setOpen] = useSessionScoped(false);
  const [settled, setSettled] = useSessionScoped(false);
  const showing = useSessionScopedRef(false);
  const retract = useSessionScopedTimer();
  const unmount = useSessionScopedTimer();
  const hasPending = pending.length > 0;

  useEffect(() => {
    if (scope.kind === "trace" || hasPending) {
      retract.clear();
      unmount.clear();
      setOps(scope.kind === "trace" ? scope.ops : []);
      setEnded(false);
      setOpen(true);
      showing.current = true;
      return;
    }
    if (scope.kind === "unknown") return;
    if (!showing.current) return;
    // "ended": the held view settles its running tail — the marker landed,
    // nothing is in flight anymore — and keeps the run as the record has it.
    if (scope.kind === "ended") {
      setEnded(true);
      if (scope.ops.length > 0) setOps(scope.ops);
    }
    retract.arm(() => {
      showing.current = false;
      setOpen(false);
      unmount.arm(() => setOps(null), CARD_SLIDE_MS + TRACE_UNMOUNT_SLACK_MS);
    }, CARD_HOLD_MS);
  }, [scope, hasPending, retract, unmount, setOps, setEnded, setOpen, showing]);

  // The record as it is NOW while it has the dispatch in view — the live
  // one, or the one whose marker just landed — not the state copy, which
  // the effect above updates a commit later (lab 2026-09-30: pairing the
  // copy with the current live views dropped a landed step for a frame; at
  // the marker, the copy drew a step long done in flight again). The copy
  // is what the held view keeps once the scope has moved on.
  const isEnded = scope.kind === "ended" || (scope.kind !== "trace" && ended);
  const current =
    ops === null
      ? null
      : scope.kind === "trace"
        ? scope.ops
        : scope.kind === "ended" && scope.ops.length > 0
          ? scope.ops
          : ops;
  const trace = useMemo(
    () =>
      current === null
        ? null
        : buildTrace(current, {
            pending: isEnded ? [] : pending,
            focus: isEnded ? null : focusStep,
            settled: isEnded,
          }),
    [current, pending, focusStep, isEnded],
  );

  // One commit behind what is on screen: the render that first draws an
  // open card lands its rows still; this arms motion for the changes after.
  const hasTrace = trace !== null;
  useEffect(() => {
    setSettled(open && hasTrace);
  }, [open, hasTrace, setSettled]);

  return {
    trace,
    // The ticker is the focused call's: it goes under the step in flight
    // only when that step IS the focused call's.
    live:
      open &&
      !isEnded &&
      focusStep !== null &&
      trace?.current?.op === focusStep.op
        ? focus
        : null,
    open,
    waiting,
    settled,
  };
}
