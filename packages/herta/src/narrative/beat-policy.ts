import type { AgentEvent } from "@herta/core";

/**
 * Beat trigger spec. A signature is a stable, deduplicate-by-string key
 * (multiple events with the same signature collapse to one beat per
 * `reset` cycle). The classifier's whole job is fire/don't-fire plus
 * this dedup key — the beat prompt itself is built from the terminal
 * record (the `→ 系统` / `→ 差分协处理器` blocks the event already
 * projected), so the spec carries no per-event user-facing message.
 * A `userMessage` field existed here historically (ported from
 * `microburst-narrator.ts`); it was never consumed by the drain loop
 * and duplicated what the record already shows, so it was removed
 * (see CLAUDE.md "Terminal scrollback").
 *
 * SPEC v0.2 §6.4.
 */
export interface TriggerSpec {
  readonly signature: string;
}

/**
 * Map a backend tool name to a coarse workflow kind. Post-N2 this is
 * only consulted by the `tool.call.finished` failure branch — the
 * `tool.call.started` beats were dropped in the 2026-05-23
 * tightening, so the historical "collapse multiple tools of the same
 * kind to one beat" rationale only applies to the (rare) failure
 * case now. The function is still exported because consumers of
 * `@herta/herta` (e.g., CLI labelling utilities) may use it.
 */
export function workflowKindForBeat(tool: string): string | null {
  switch (tool) {
    case "read_file":
    case "list_files":
    case "search_text":
    case "glob":
      return "read";
    case "edit_file":
    case "write_new_file":
    // Minimal contract (ADR 0040): the editor's view is a read, but this
    // coarse map only feeds the failure-beat signature — "write" is the
    // honest bucket for a tool that can write.
    case "str_replace_editor":
      return "write";
    case "run_command":
    case "bash":
    case "command_output":
    case "command_stop":
      return "run";
    case "todo_write":
      return "plan";
    case "git_status":
    case "git_diff":
      return "inspect";
    case "memory_save":
      return "save_memory";
    default:
      return null;
  }
}

/**
 * Pure classifier from `AgentEvent` to a `TriggerSpec`. Returns null
 * when the event does not warrant a beat.
 *
 * Rules (post-2026-05-23 tightening — see N2 below):
 *  - Actor-layer events → null.
 *  - `tool.call.started` ANY kind → null (was previously `tool.started:${kind}`).
 *  - `tool.call.finished` success → null.
 *  - `tool.call.finished` permission_denied/permission_failed → null.
 *  - `tool.call.finished` other failure → `tool.fail:${tool}:${code}`.
 *  - `patch.preview` → `patch.preview:first`.
 *  - `verification.finished` with `passed: false` → `verification.finished`;
 *    a passing run (or one whose outcome is unknown) → null (2026-09-03).
 *  - `plan.updated` → null.
 *  - Turn lifecycle events → null (handled separately via reset()).
 *
 * **N2 (2026-05-23)**: previously `tool.call.started` fired a beat
 * for every known workflow kind (read / write / run / plan / inspect /
 * save_memory). Empirically this made Herta chime in on every file
 * read, every plan step, every git_status — too chatty and the
 * commentary often had nothing meaningful to say (the START event
 * has no actual output yet). The user explicitly asked for beats to
 * fire only when the CLI surfaces substantive content. So now:
 *
 *  - patch.preview (new code shown to the user) → beat
 *  - verification.finished (test/lint results) → beat
 *  - tool.call.finished failure (something broke) → beat
 *  - everything else → no beat
 *
 * The `→ 差分协处理器` system blocks still appear in the record on
 * every tool start (backend-bridge.ts owns that projection); Herta
 * just doesn't narrate them individually.
 */
export function classifyBeatTrigger(event: AgentEvent): TriggerSpec | null {
  if (event.layer !== "backend") return null;

  switch (event.type) {
    case "tool.call.started":
      // N2: no beats on workflow start — see the function-level
      // JSDoc above for the rationale.
      return null;
    case "tool.call.finished": {
      if (event.result.ok === true) return null;
      const code = event.result.error?.code;
      if (code === "permission_denied" || code === "permission_failed") {
        return null;
      }
      // Crash collapse (2026-07-23, owner-approved): tool_crashed is a
      // harness-level containment result (ADR 0025 slice 5), and a parallel
      // batch can crash on several DIFFERENT tools at once — per-tool
      // signatures would fire up to N snarky beats for what is one
      // incident. One shared signature → at most one crash beat per
      // dispatch (signature dedup resets on turn.started). Checked BEFORE
      // the workflow-kind allowlist: containment applies to ANY tool,
      // including one a future edit forgets to add to workflowKindForBeat —
      // the crash beat must not silently vanish with it (consumer audit
      // 2026-07-23).
      if (code === "tool_crashed") {
        return { signature: "tool.fail:crash" };
      }
      const kind = workflowKindForBeat(event.tool);
      if (kind === null) return null;
      return {
        signature: `tool.fail:${event.tool}:${code ?? "unknown"}`,
      };
    }
    case "patch.preview":
      return { signature: "patch.preview:first" };
    case "verification.finished":
      // A RED run only (owner 2026-09-03). A green run drew a beat ("全绿，
      // 0.22 秒…拿着用吧") and, when it was the brief's last step, Herta's
      // synthesis said the same thing again seconds later. A pass mid-run
      // is a status row; the reaction that earns its place is to a failure,
      // while 板砖 is still there to fix it. The producer sends `passed`;
      // an emitter that does not know sends nothing, and gets no beat.
      return event.result.passed === false
        ? { signature: "verification.finished" }
        : null;
    default:
      return null;
  }
}

export interface BeatPolicyOpts {
  /** Default 3000ms. Minimum spacing between dispatched beats. */
  readonly minInterBurstMs?: number;
  /** Test seam. Defaults to Date.now. */
  readonly clock?: () => number;
}

/**
 * Throttle + dedup state for in-turn beats. Mirrors `MicroburstNarrator`
 * policy. Lifetime: per `invokeBanzhuanBridge` call — a fresh `BeatPolicy`
 * is constructed each time the actor turn loop fires `@板砖`.
 *
 * Staging and firing are separate moments (the bridge defers beats across
 * permission prompts and drain cycles), so the policy splits accordingly
 * (2026-07-04, M3): `shouldStage` is classification + dedup only, and the
 * throttle window is enforced by `readyToFire()` at FIRE time. The old
 * single `shouldFire` evaluated the window at ARRIVAL time, which was
 * wrong twice over — an event landing inside the window was dropped
 * forever even though its beat would have fired well after the window
 * elapsed, and two triggers arriving in one burst both passed (lastBurstAt
 * is stale until `markFired`) and then fired back-to-back with no spacing.
 *
 * Usage (the bridge's drain loop):
 *   // PROCESS: stage triggers as events arrive
 *   const trigger = policy.shouldStage(event);
 *   if (trigger) staged.push(trigger);
 *   // FIRE: spacing enforced against the actual fire timeline
 *   if (policy.readyToFire()) {
 *     const beat = await fireBeat(...);
 *     policy.markFired(trigger.signature, policy.now());
 *   }
 *
 * On backend `turn.started`, call `policy.reset()` to clear dedup.
 * (lastBurstAt is intentionally NOT reset — that's how the narrator
 * prevents a flood at turn-2 right after a busy turn-1.)
 */
export class BeatPolicy {
  private readonly minInterBurstMs: number;
  private readonly clock: () => number;
  private readonly dedup = new Set<string>();
  /** Negative-infinity so the first beat is never rate-limited regardless
   *  of what clock() returns (test seams may pin clock at 0). */
  private lastBurstAt = Number.NEGATIVE_INFINITY;

  constructor(opts: BeatPolicyOpts = {}) {
    this.minInterBurstMs = opts.minInterBurstMs ?? 3000;
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * Returns the trigger if the event qualifies for a beat and the
   * signature has not already fired. Deliberately clock-free: staging
   * happens at event-arrival time, but the beat fires later (deferred
   * across permission prompts and drain cycles), so the throttle window
   * belongs to `readyToFire()` at the fire site — not here. The
   * signature enters dedup only via `markFired`, so a staged-but-never-
   * fired trigger (dropped beat, provider error) may stage again on a
   * later identical event; in-flight duplicates are the bridge's
   * staged/ready scan's job.
   */
  shouldStage(event: AgentEvent): TriggerSpec | null {
    const trigger = classifyBeatTrigger(event);
    if (trigger === null) return null;
    if (this.dedup.has(trigger.signature)) return null;
    return trigger;
  }

  /**
   * True when the min-inter-burst window since the last ACTUAL fire has
   * elapsed (always true before the first fire). The drain checks this
   * per fire attempt: a held trigger simply waits in `ready` until the
   * window opens, giving real spacing between consecutive beats instead
   * of the arrival-time check that either dropped or bunched them.
   */
  readyToFire(): boolean {
    return this.clock() - this.lastBurstAt >= this.minInterBurstMs;
  }

  /** Returns the current time per the policy's injected clock. Use this
   *  to get the `now` value passed to `markFired` so test seams stay consistent. */
  now(): number {
    return this.clock();
  }

  /** Record that a beat was dispatched for `signature` at `now`. */
  markFired(signature: string, now: number): void {
    this.dedup.add(signature);
    this.lastBurstAt = now;
  }

  /** Clear dedup state. Called on backend `turn.started`. Does NOT reset lastBurstAt. */
  reset(): void {
    this.dedup.clear();
  }
}
