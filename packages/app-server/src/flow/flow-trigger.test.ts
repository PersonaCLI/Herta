import { describe, expect, it, vi } from "vitest";
import { EMPTY_FLOW_STATE, type FlowStateFile } from "./flow-store.js";
import {
  FLOW_ATTEMPTS_PER_DAY,
  FLOW_REFRESHES_PER_DAY,
  FLOW_RETRY_MS,
  type FlowRunOutcome,
  FlowTrigger,
  type FlowTriggerOptions,
  refreshesLeft,
} from "./flow-trigger.js";
import type { FlowSettings } from "./flow-types.js";

/** When an issue is gathered (ADR 0084 §6): every gate is harness code. */

const ON: FlowSettings = { enabled: true, topics: ["ai"] };

/** A local moment on a day of October 2026. */
const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 9, day, hour, minute).getTime();

function setup(over: Partial<FlowTriggerOptions> = {}) {
  const clock = { t: at(30, 9) };
  let state: FlowStateFile = EMPTY_FLOW_STATE;
  const issueDays = new Set<string>();
  const busy = { now: false };
  const settings = { now: ON };
  /** Each run waits for its release, so a test can hold one in flight. */
  const pending: ((o: FlowRunOutcome) => void)[] = [];
  const runIssue = vi.fn(
    (_kind: string, _date: string) =>
      new Promise<FlowRunOutcome>((r) => pending.push(r)),
  );
  const settled = vi.fn();
  const trig = new FlowTrigger({
    now: () => clock.t,
    settings: () => settings.now,
    hasKey: () => true,
    isBusy: () => busy.now,
    store: {
      hasIssueFor: async (d) => issueDays.has(d),
      readState: async () => state,
      updateState: async (change) => {
        state = change(state);
        return state;
      },
    },
    runIssue,
    onSettled: settled,
    ...over,
  });
  /** Settle the run in flight and wait for the trigger to record it. */
  const finish = async (o: FlowRunOutcome): Promise<void> => {
    const r = pending.shift();
    if (r === undefined) throw new Error("no run in flight");
    r(o);
    await trig.idle();
  };
  return {
    trig,
    clock,
    busy,
    settings,
    issueDays,
    runIssue,
    settled,
    finish,
    state: () => state,
  };
}

const OK = (id = "2026-10-30-1"): FlowRunOutcome => ({
  ok: true,
  issueId: id,
  cards: 3,
});

describe("FlowTrigger.tick", () => {
  it("is off until Flow is on, and needs the key", async () => {
    const off = setup();
    off.settings.now = { ...ON, enabled: false };
    expect(await off.trig.tick()).toBe("off");
    const noKey = setup({ hasKey: () => false });
    expect(await noKey.trig.tick()).toBe("no_key");
    expect(off.runIssue).not.toHaveBeenCalled();
  });

  it("waits for 08:00 local, then starts today's issue", async () => {
    const t = setup();
    t.clock.t = at(30, 7, 59);
    expect(await t.trig.tick()).toBe("early");
    t.clock.t = at(30, 8, 0);
    expect(await t.trig.tick()).toBe("started");
    expect(t.runIssue).toHaveBeenCalledWith("auto", "2026-10-30");
    expect(t.state().attempts).toBe(1);
    expect(t.state().lastAttemptAt).toBe(at(30, 8, 0));
  });

  it("never starts while a turn is in flight, and that is no attempt", async () => {
    const t = setup();
    t.busy.now = true;
    expect(await t.trig.tick()).toBe("busy");
    expect(t.state().attempts).toBe(0);
    t.busy.now = false;
    expect(await t.trig.tick()).toBe("started");
  });

  it("does nothing once today has an issue; a missed day is not backfilled", async () => {
    const t = setup();
    t.issueDays.add("2026-10-30");
    expect(await t.trig.tick()).toBe("done_today");
    t.issueDays.clear();
    expect(await t.trig.tick()).toBe("started");
    expect(t.runIssue).toHaveBeenLastCalledWith("auto", "2026-10-30");
  });

  it("guards a run in flight against a second tick and a refresh", async () => {
    const t = setup();
    expect(await t.trig.tick()).toBe("started");
    expect(t.trig.running).toBe(true);
    expect(await t.trig.tick()).toBe("running");
    expect(await t.trig.refresh()).toBe("running");
    await t.finish(OK());
    expect(t.trig.running).toBe(false);
    expect(t.runIssue).toHaveBeenCalledTimes(1);
    expect(t.settled).toHaveBeenCalledWith(OK(), "auto");
  });

  it("backs off an hour after a failure, and a success clears it", async () => {
    const t = setup();
    await t.trig.tick();
    await t.finish({ ok: false, reason: "network" });
    expect(t.state().lastFailure).toEqual({ at: at(30, 9), reason: "network" });
    t.clock.t = at(30, 9) + FLOW_RETRY_MS - 1;
    expect(await t.trig.tick()).toBe("backoff");
    t.clock.t = at(30, 9) + FLOW_RETRY_MS;
    expect(await t.trig.tick()).toBe("started");
    await t.finish(OK());
    expect(t.state().lastFailure).toBeNull();
  });

  it("makes at most three automatic attempts a day, and counts afresh tomorrow", async () => {
    const t = setup();
    for (let i = 0; i < FLOW_ATTEMPTS_PER_DAY; i++) {
      expect(await t.trig.tick()).toBe("started");
      await t.finish({ ok: false, reason: "error" });
      t.clock.t += FLOW_RETRY_MS;
    }
    expect(await t.trig.tick()).toBe("attempts");
    t.clock.t = at(31, 8);
    expect(await t.trig.tick()).toBe("started");
    expect(t.runIssue).toHaveBeenLastCalledWith("auto", "2026-10-31");
    expect(t.state().attempts).toBe(1);
  });

  it("leaves no backoff for an aborted run (the app quitting)", async () => {
    const t = setup();
    await t.trig.tick();
    await t.finish({ ok: false, reason: "aborted" });
    expect(t.state().lastFailure).toBeNull();
    expect(await t.trig.tick()).toBe("started");
  });

  it("treats a run that throws as a failure, not a stuck guard", async () => {
    const t = setup({
      runIssue: async () => {
        throw new Error("boom");
      },
    });
    expect(await t.trig.tick()).toBe("started");
    await t.trig.idle();
    expect(t.trig.running).toBe(false);
    expect(t.state().lastFailure?.reason).toBe("error");
  });
});

describe("FlowTrigger.refresh", () => {
  it("runs at once — early, busy or backing off — at most three a day", async () => {
    const t = setup();
    t.clock.t = at(30, 6);
    t.busy.now = true;
    for (let i = 0; i < FLOW_REFRESHES_PER_DAY; i++) {
      expect(await t.trig.refresh()).toBe("started");
      await t.finish({ ok: false, reason: "network" });
    }
    expect(await t.trig.refresh()).toBe("limit");
    expect(refreshesLeft(t.state(), "2026-10-30")).toBe(0);
    expect(refreshesLeft(t.state(), "2026-10-31")).toBe(FLOW_REFRESHES_PER_DAY);
    expect(t.runIssue).toHaveBeenCalledWith("refresh", "2026-10-30");
    t.clock.t = at(31, 6);
    expect(await t.trig.refresh()).toBe("started");
  });

  it("is off and keyless like a tick", async () => {
    const t = setup({ hasKey: () => false });
    expect(await t.trig.refresh()).toBe("no_key");
    t.settings.now = { ...ON, enabled: false };
    expect(await t.trig.refresh()).toBe("off");
  });
});
