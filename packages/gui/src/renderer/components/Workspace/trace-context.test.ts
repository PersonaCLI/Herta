import type { TerminalRecordBlock } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import {
  buildTrace,
  TRACE_MAX_SEGMENTS,
  type TraceOp,
  tallySegment,
  traceScope,
} from "./trace-context.js";

const user = (text = "修一下"): TerminalRecordBlock =>
  ({ kind: "user", text }) as TerminalRecordBlock;
const herta = (text = "看着。"): TerminalRecordBlock =>
  ({ kind: "herta", surface: "speech", text }) as TerminalRecordBlock;
const marker: TerminalRecordBlock = {
  kind: "system",
  label: "差分协处理器",
  body: "完成 · 1 个文件",
  role: "done-marker",
} as TerminalRecordBlock;
const sys = (digest: unknown, body = "row"): TerminalRecordBlock =>
  ({
    kind: "system",
    label: "差分协处理器",
    body,
    digest,
  }) as TerminalRecordBlock;
const op = (verb: string, arg: string) => sys({ kind: "op", verb, arg });
const exit = (exitCode: number | null, lineCount = 3) =>
  sys({ kind: "text", exitCode, lineCount });

function opsOf(record: TerminalRecordBlock[]): readonly TraceOp[] {
  const s = traceScope(record);
  if (s.kind !== "trace") throw new Error(`expected a trace, got ${s.kind}`);
  return s.ops;
}

describe("traceScope", () => {
  it("collects the current dispatch's ops in order, with phases; results settle statuses", () => {
    expect(
      opsOf([
        user(),
        op("Reading", "src/store.mjs"),
        op("Running", "npm test"),
        exit(1),
        op("Writing", "src/store.mjs"),
        op("Running", "node --test test/"),
        sys({ kind: "tests", status: "passed", summary: "3 passed" }),
        op("Running", "git add -A && git commit -m x"),
      ]),
    ).toEqual([
      {
        verb: "Reading",
        arg: "src/store.mjs",
        status: "ok",
        phase: "explore",
      },
      {
        verb: "Running",
        arg: "npm test",
        status: "fail",
        note: { kind: "exit", code: 1 },
        phase: "verify",
      },
      // No result row of its own — settled by the next op starting.
      { verb: "Writing", arg: "src/store.mjs", status: "ok", phase: "modify" },
      {
        verb: "Running",
        arg: "node --test test/",
        status: "ok",
        note: { kind: "tests", summary: "3 passed", failed: false },
        phase: "verify",
      },
      {
        verb: "Running",
        arg: "git add -A && git commit -m x",
        status: "running",
        phase: "modify",
      },
    ]);
  });

  it("a recognised test run is a check whatever its command looked like", () => {
    const [run] = opsOf([
      user(),
      op("Running", "./scripts/check.sh"),
      sys({ kind: "tests", status: "failed", summary: "1 failed" }),
    ]);
    expect(run?.phase).toBe("verify");
    expect(run?.status).toBe("fail");
  });

  it("herta beats do not stop the scan; the trace spans the whole dispatch", () => {
    expect(
      opsOf([
        user(),
        op("Reading", "src/store.mjs"),
        exit(0),
        herta(),
        op("Writing", "src/store.mjs"),
      ]).map((o) => o.verb),
    ).toEqual(["Reading", "Writing"]);
  });

  it("signal exits, tool failures and search notes attach to the last op", () => {
    const ops = opsOf([
      user(),
      op("Running", "kill 574"),
      exit(null),
      op("Searching", '"TODO" in src'),
      sys({ kind: "search", matches: 5, files: 2, truncated: false }),
      op("Running", "node x.mjs"),
      sys({ kind: "tool-fail", tool: "bash", code: "timeout" }),
    ]);
    expect(ops[0]?.status).toBe("fail");
    expect(ops[0]?.note).toEqual({ kind: "signal" });
    expect(ops[1]?.note).toEqual({ kind: "matches", n: 5 });
    expect(ops[2]?.status).toBe("fail");
    expect(ops[2]?.note).toEqual({ kind: "fail", code: "timeout" });
  });

  it("a legacy todo row (records before ADR 0073) is not an op", () => {
    expect(
      opsOf([
        user(),
        sys({ kind: "todo", total: 2, completed: 0 }, "todo list (2):"),
        op("Reading", "a.ts"),
      ]),
    ).toHaveLength(1);
  });

  it("boundaries: marker → ended, with the ended run's own ops; user with no ops → absent; off-start with no ops → unknown", () => {
    const ended = traceScope([
      user(),
      op("Running", "npm test"),
      marker,
      herta(),
      op("Running", "ls"),
      exit(0),
      marker,
    ]);
    expect(ended.kind).toBe("ended");
    // Only the marker's own run — back to the marker before it.
    expect(ended.kind === "ended" && ended.ops.map((o) => o.arg)).toEqual([
      "ls",
    ]);
    expect(traceScope([user(), herta()]).kind).toBe("absent");
    expect(traceScope([herta()]).kind).toBe("unknown");
  });

  it("ops after a marker belong to a NEWER chained dispatch — trace, not ended", () => {
    expect(
      opsOf([
        user(),
        op("Running", "npm test"),
        marker,
        herta(),
        op("Running", "git push"),
      ]).map((o) => o.arg),
    ).toEqual(["git push"]);
  });

  it("a partial window still yields the ops in hand (recency, not completeness)", () => {
    expect(opsOf([op("Running", "npm test"), exit(0)])).toHaveLength(1);
  });
});

describe("traceScope — a test run recognised at dispatch (ADR 0073 amendment 2026-10-08)", () => {
  it("is a check from its op row on, before its test row lands — even when the 80-char header shows only the setup", () => {
    const flagged = sys({
      kind: "op",
      verb: "Running",
      arg: "mkdir -p /tmp/negcheck && cp test_hello.py /tmp/negcheck/ && cd …",
      runsTests: true,
    });
    const [ran] = opsOf([user(), flagged]);
    expect(ran?.phase).toBe("verify");
    // Rows written before the flag still read the header, until their test
    // row says otherwise.
    const [old] = opsOf([
      user(),
      op(
        "Running",
        "mkdir -p /tmp/negcheck && cp test_hello.py /tmp/negcheck/",
      ),
    ]);
    expect(old?.phase).toBe("modify");
  });
});

describe("buildTrace — phase segments (ADR 0073)", () => {
  const story = opsOf([
    user(),
    op("Reading", "src/parser.ts"),
    op("Searching", '"cursor" in src'),
    op("Reading", "src/lexer.ts"),
    op("Writing", "src/parser.ts"),
    op("Running", "npm test"),
    exit(1),
    op("Writing", "src/parser.ts"),
    op("Running", "npm test"),
  ]);

  it("groups consecutive ops of one phase; a phase the run comes back to is a new segment", () => {
    const trace = buildTrace(story);
    expect(
      trace.segments.map((s) => [s.phase, s.ops.length, s.status]),
    ).toEqual([
      ["explore", 3, "ok"],
      ["modify", 1, "ok"],
      ["verify", 1, "fail"],
      ["modify", 1, "ok"],
      ["verify", 1, "running"],
    ]);
    expect(trace.segments.map((s) => s.firstOpOrdinal)).toEqual([
      0, 3, 4, 5, 6,
    ]);
    expect(trace.steps).toBe(7);
    expect(trace.writes).toBe(1);
    // The step being worked: the newest, in the newest segment.
    expect(trace.current).toEqual({ segment: 4, op: 6 });
  });

  it("the held view settles the running tail: nothing in flight, the last segment finished", () => {
    const trace = buildTrace(story, { settled: true });
    expect(trace.live).toBe(false);
    expect(trace.current).toBeNull();
    expect(trace.segments[trace.segments.length - 1]?.status).toBe("ok");
  });

  it("a pending step (the call still being written) becomes the running tail — its own segment when its phase differs", () => {
    const reading = opsOf([user(), op("Reading", "a.ts")]);
    const writing = {
      verb: "Writing",
      arg: "a.ts",
      phase: "modify",
      status: "running",
    } as const;
    const trace = buildTrace(reading, { pending: [writing] });
    expect(trace.segments.map((s) => [s.phase, s.status])).toEqual([
      ["explore", "ok"],
      ["modify", "running"],
    ]);
    expect(trace.steps).toBe(2);
    expect(trace.current).toEqual({ segment: 1, op: 1 });
    // A dispatch whose first step is still being written already has a trace.
    expect(
      buildTrace([], { pending: [{ ...writing, arg: "b.ts" }] }).segments,
    ).toHaveLength(1);
    // Settled, a pending step is dropped: the run is over.
    expect(
      buildTrace(reading, { pending: [writing], settled: true }).steps,
    ).toBe(1);
  });

  it("steps that already ran while the record lagged behind Herta's beats keep their statuses, in order; the dispatch is still live", () => {
    const reading = opsOf([user(), op("Reading", "a.ts")]);
    const trace = buildTrace(reading, {
      pending: [
        { verb: "Writing", arg: "a.ts", phase: "modify", status: "ok" },
        { verb: "Running", arg: "npm test", phase: "verify", status: "fail" },
      ],
    });
    expect(trace.segments.map((s) => [s.phase, s.status])).toEqual([
      ["explore", "ok"],
      ["modify", "ok"],
      ["verify", "fail"],
    ]);
    // Nothing runs this instant, but the dispatch goes on: its newest
    // segment is still the one being worked.
    expect(trace.live).toBe(true);
    expect(trace.current).toEqual({ segment: 2, op: 2 });
  });

  it("a step written behind the one in flight is QUEUED: the node in flight is the running one, and its record row stays running (lab 2026-09-30)", () => {
    // One message: a command, then a file. The command runs; the file waits.
    const running = opsOf([user(), op("Running", "pwd && ls")]);
    const trace = buildTrace(running, {
      pending: [
        { verb: "Writing", arg: "fib.js", phase: "modify", status: "queued" },
      ],
      focus: { op: 0, status: "running" },
    });
    expect(trace.segments.map((s) => [s.phase, s.status])).toEqual([
      ["explore", "running"],
      ["modify", "queued"],
    ]);
    expect(trace.current).toEqual({ segment: 0, op: 0 });
    // The command finished — its view knows before its exit row lands: the
    // file is next.
    const next = buildTrace(running, {
      pending: [
        { verb: "Writing", arg: "fib.js", phase: "modify", status: "queued" },
      ],
      focus: { op: 0, status: "ok" },
    });
    expect(next.segments.map((s) => s.status)).toEqual(["ok", "queued"]);
    expect(next.current).toEqual({ segment: 1, op: 1 });
  });

  it("a command whose line is still being written stays with the phase before it — it opens no node that could fold back a moment later", () => {
    const checked = opsOf([user(), op("Running", "npm test"), exit(0)]);
    const trace = buildTrace(checked, {
      pending: [
        {
          verb: "Running",
          arg: "",
          phase: "explore",
          status: "running",
          tentative: true,
        },
      ],
    });
    expect(trace.segments.map((s) => [s.phase, s.ops.length])).toEqual([
      ["verify", 2],
    ]);
    expect(trace.current).toEqual({ segment: 0, op: 1 });
  });

  it("with nothing running, the first queued step is the one in flight: it is next — or parked on an approval", () => {
    const ran = opsOf([user(), op("Running", "pwd"), exit(0)]);
    const trace = buildTrace(ran, {
      pending: [
        { verb: "Writing", arg: "a.ts", phase: "modify", status: "queued" },
        {
          verb: "Running",
          arg: "node a.ts",
          phase: "verify",
          status: "queued",
        },
      ],
      focus: { op: 0, status: "ok" },
    });
    expect(trace.current).toEqual({ segment: 1, op: 1 });
    // Settled, nothing waits any longer.
    expect(
      buildTrace(ran, {
        pending: [
          { verb: "Writing", arg: "a.ts", phase: "modify", status: "queued" },
        ],
        settled: true,
      }).segments.map((s) => s.status),
    ).toEqual(["ok"]);
  });

  it("keeps the newest TRACE_MAX_SEGMENTS segments; counts stay whole-dispatch", () => {
    const blocks: TerminalRecordBlock[] = [user()];
    for (let i = 0; i < 12; i += 1) {
      blocks.push(op("Reading", `f${i}.ts`), op("Writing", `f${i}.ts`));
    }
    const trace = buildTrace(opsOf(blocks));
    expect(trace.segments).toHaveLength(TRACE_MAX_SEGMENTS);
    // The window is the TAIL, keyed by whole-dispatch ordinals.
    expect(trace.segments[0]?.ordinal).toBe(24 - TRACE_MAX_SEGMENTS);
    expect(trace.steps).toBe(24);
    expect(trace.writes).toBe(12);
  });

  it("between steps, while 板砖 thinks, the newest step is the one in flight", () => {
    const trace = buildTrace(
      opsOf([user(), op("Reading", "a.ts"), op("Running", "ls"), exit(0)]),
    );
    expect(trace.current).toEqual({ segment: 0, op: 1 });
  });
});

describe("tallySegment", () => {
  it("counts what a segment did, with distinct files in first-seen order", () => {
    const ops = opsOf([
      user(),
      op("Reading", "src/a.ts"),
      op("Reading", "src/b.ts"),
      op("Reading", "src/a.ts"),
      op("Searching", '"x"'),
      op("Searching", '"y"'),
      op("Inspecting", ""),
    ]);
    expect(tallySegment(ops)).toEqual({
      reads: ["src/a.ts", "src/b.ts"],
      searches: 2,
      inspects: 1,
      writes: [],
      runs: [],
      digests: 0,
      memories: 0,
      stops: 0,
    });
  });
});
