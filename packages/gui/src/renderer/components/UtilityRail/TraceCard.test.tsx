import type { TerminalRecordBlock } from "@herta/app-server";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveToolSnapshot, LiveToolView } from "../../ipc/bridge-types.js";
import { renderWithSession } from "../../testing/renderWithSession.js";
import {
  CARD_HOLD_MS,
  CARD_SLIDE_MS,
  CARD_TICKER_HOLD_MS,
  CARD_TICKER_MS,
} from "./card-motion.js";
import { TraceCard } from "./TraceCard.js";
import { pendingSteps, stepOf } from "./useTraceCard.js";

afterEach(() => {
  vi.useRealTimers();
});

const user = (text = "修一下"): TerminalRecordBlock =>
  ({ kind: "user", text }) as TerminalRecordBlock;
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
const doneMarker: TerminalRecordBlock = {
  kind: "system",
  label: "差分协处理器",
  body: "完成 · 1 个文件",
  role: "done-marker",
} as TerminalRecordBlock;

function push(
  h: ReturnType<typeof renderWithSession>,
  ...blocks: TerminalRecordBlock[]
): void {
  act(() => {
    for (const [i, block] of blocks.entries()) {
      h.mock.emitRecord({
        kind: "block",
        blockId: `t${Date.now()}-${i}`,
        block,
      });
    }
  });
}

/** Main's snapshot: `startedOps` defaults to one past the highest ordinal;
 *  the ticker follows the last view. */
function live(
  h: ReturnType<typeof renderWithSession>,
  views: LiveToolView[],
  startedOps = views.reduce((n, v) => Math.max(n, (v.ordinal ?? -1) + 1), 0),
): void {
  const focus = views[views.length - 1]?.id;
  act(() => {
    h.mock.emitLive({
      views,
      startedOps,
      ...(focus !== undefined ? { focus } : {}),
    });
  });
}

const view = (over: Partial<LiveToolView>): LiveToolView => ({
  id: "c1",
  tool: "str_replace_editor",
  stage: "writing",
  started: false,
  done: false,
  streams: true,
  mode: "text",
  tail: "",
  lines: 0,
  ...over,
});

const card = () => document.querySelector('[data-testid="trace-card"]');
const isOpen = () => card()?.className.includes("is-open") ?? false;
const nodes = () => [...document.querySelectorAll(".trace-node")];
/** Each node as "<phase>[*] <text>[ [note]]" — `*` marks the node in flight. */
const lines = () =>
  nodes().map((n) => {
    const phase = n.querySelector(".trace-node__phase")?.textContent ?? "";
    const text = n.querySelector(".trace-card__text")?.textContent ?? "";
    const note = n.querySelector(".trace-card__note")?.textContent;
    return `${phase}${n.className.includes("is-in-flight") ? "*" : ""} ${text}${
      note !== undefined ? ` [${note}]` : ""
    }`;
  });
/** The LIVE ticker. A node that just folded keeps its last ticker while the
 *  line eases shut (TickerSlot, 2026-10-08) — hidden, and not the step's. */
const ticker = () =>
  document.querySelector(
    '.trace-node__slot:not(.is-closing) [data-testid="trace-ticker"]',
  );
const tickerText = () =>
  ticker()?.querySelector(".trace-ticker__line")?.textContent;
/** Let the paced ticker catch up (ticker-pacer.ts: a hold is 320 ms). */
const settle = (ms = 400) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe("TraceCard — the timeline (ADR 0073)", () => {
  it("is absent for a session with no dispatch ops", () => {
    const h = renderWithSession(<TraceCard />);
    expect(card()).toBeNull();
    push(h, user());
    expect(card()).toBeNull();
  });

  it("one node per phase stretch: finished ones fold to a counted line with how they ended; the one in flight names its step", () => {
    const h = renderWithSession(<TraceCard />);
    push(
      h,
      user(),
      op("Reading", "src/parser.ts"),
      op("Searching", '"cursor"'),
      op("Reading", "src/lexer.ts"),
      op("Running", "npm test"),
      exit(1),
      op("Writing", "src/parser.ts"),
      op("Writing", "src/lexer.ts"),
    );
    expect(isOpen()).toBe(true);
    expect(lines()).toEqual([
      "Explore Read 2 files, parser.ts first · Searched once",
      "Verify Ran npm test [exit 1]",
      "Edit* Writing src/lexer.ts",
    ]);
    const n = nodes();
    expect(n[0]?.className).toContain("is-ok");
    expect(n[1]?.className).toContain("is-fail");
    expect(n[1]?.querySelector(".trace-card__note")?.className).toContain(
      "is-fail",
    );
    // No live view: no ticker.
    expect(ticker()).toBeNull();
    // Header counts cover the whole dispatch.
    expect(document.querySelector(".plan-card__count")?.textContent).toBe(
      "6 steps · 2 files",
    );
  });

  it("zh: phases and summaries speak the UI language", () => {
    const h = renderWithSession(<TraceCard />, { locale: "zh" });
    push(
      h,
      user(),
      op("Reading", "src/a.ts"),
      op("Reading", "src/b.ts"),
      op("Reading", "src/c.ts"),
      op("Writing", "src/a.ts"),
    );
    expect(lines()).toEqual([
      "探索 读取 a.ts 等 3 个文件",
      "修改* 写入 src/a.ts",
    ]);
  });

  it("HOLDS past the done-marker with every node folded, then slides back and unmounts", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<TraceCard />);
    push(h, user(), op("Running", "npm test"));
    expect(lines()).toEqual(["Verify* Running npm test"]);
    push(h, doneMarker);
    // Held open; nothing is in flight after the marker.
    expect(isOpen()).toBe(true);
    expect(lines()).toEqual(["Verify Ran npm test"]);
    act(() => {
      vi.advanceTimersByTime(CARD_HOLD_MS + 100);
    });
    expect(isOpen()).toBe(false);
    expect(nodes()).toHaveLength(1); // content kept through the slide
    act(() => {
      vi.advanceTimersByTime(CARD_SLIDE_MS + 200);
    });
    expect(card()).toBeNull();
  });

  it("parked on a permission gate, the card says so (is-waiting)", () => {
    const h = renderWithSession(<TraceCard />);
    push(h, user(), op("Running", "npm install"));
    act(() => {
      h.mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "r1",
          risk: "network",
          tool: "bash",
          summary: "npm install",
          cacheable: false,
        },
      });
    });
    expect(card()?.className).toContain("is-waiting");
    act(() => {
      h.mock.emitOverlay({ kind: "resolved", requestId: "r1" });
    });
    expect(card()?.className).not.toContain("is-waiting");
  });

  it("a chained dispatch after the first's marker restarts the timeline with the new ops", () => {
    const h = renderWithSession(<TraceCard />);
    push(h, user(), op("Running", "npm test"), exit(0), doneMarker);
    push(h, op("Running", "git push"));
    expect(lines()).toEqual(["Edit* Running git push"]);
  });
});

describe("TraceCard — the ticker (ADR 0073)", () => {
  it("flows the file's whole lines as the model writes it — before the step's op row exists; a line still being written waits", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<TraceCard />);
    h.startBackend();
    push(h, user(), op("Reading", "src/a.ts"));
    live(
      h,
      [
        view({
          path: "src/new.ts",
          tail: "export const a = 1;\nexport const b",
          lines: 2,
        }),
      ],
      1,
    );
    // The call being written is the node in flight, in its own phase.
    expect(lines()).toEqual([
      "Explore Read a.ts",
      "Edit* Writing src/new.ts [2 lines]",
    ]);
    // `export const b` is still being written: the whole line before it
    // shows, and the half one only once it has held still.
    expect(tickerText()).toBe("export const a = 1;");
    expect(ticker()?.querySelector(".trace-ticker__cursor")).not.toBeNull();
    settle();
    expect(tickerText()).toBe("export const b");
  });

  it("the ticker eases shut under a node that folds while the next node opens its own — the card never drops a line in one frame (owner 2026-10-08)", () => {
    // "The new row appeared like a flash": the folded node lost its ticker
    // line in the same frame the new node arrived, so the card dipped by a
    // line and grew back.
    vi.useFakeTimers();
    const h = renderWithSession(<TraceCard />);
    h.startBackend();
    push(h, user(), op("Running", "npm test"));
    const test = view({
      tool: "bash",
      stage: "running",
      started: true,
      ordinal: 0,
      commandLine: "npm test",
      tail: "PASS a.test.ts",
      lines: 1,
    });
    live(h, [test]);
    settle();
    expect(tickerText()).toBe("PASS a.test.ts");
    // The test passes and 板砖 starts on a file: a new node, another phase.
    push(h, exit(0, 1), op("Writing", "src/a.ts"));
    live(h, [
      { ...test, done: true, ok: true },
      view({
        id: "c2",
        started: true,
        ordinal: 1,
        path: "src/a.ts",
        tail: "export const a = 1;",
        lines: 1,
      }),
    ]);
    expect(lines()).toEqual([
      "Verify Ran npm test [exit 0]",
      "Edit* Writing src/a.ts [1 line]",
    ]);
    // The folded node keeps its last line while it eases shut — hidden…
    const closing = document.querySelector(".trace-node__slot.is-closing");
    expect(closing?.getAttribute("aria-hidden")).toBe("true");
    expect(closing?.textContent).toContain("PASS a.test.ts");
    expect(nodes()[0]?.contains(closing ?? null)).toBe(true);
    // …the node in flight has its own…
    expect(nodes()[1]?.contains(ticker())).toBe(true);
    // …and once the line has eased shut, it is gone.
    act(() => {
      vi.advanceTimersByTime(CARD_TICKER_MS + 20);
    });
    expect(document.querySelector(".trace-node__slot.is-closing")).toBeNull();
    expect(nodes()[0]?.querySelector(".trace-node__slot")).toBeNull();
  });

  it("the node still in flight keeps its ticker through a momentary gap, and lets it go when the gap lasts (lab 2026-10-08)", () => {
    // While 板砖 writes its next call, the ticker's call is briefly that
    // draft — here one that makes no op row — and the line used to ease half
    // shut and open again on every step.
    vi.useFakeTimers();
    const h = renderWithSession(<TraceCard />);
    h.startBackend();
    push(h, user(), op("Running", "npm test"));
    const test = view({
      tool: "bash",
      stage: "running",
      started: true,
      ordinal: 0,
      commandLine: "npm test",
      tail: "PASS a.test.ts",
      lines: 1,
    });
    const draft = view({ id: "c2", tool: "report_finding", streams: false });
    live(h, [test]);
    settle();
    expect(tickerText()).toBe("PASS a.test.ts");
    live(h, [test, draft]);
    // Still the step in flight…
    expect(lines()).toEqual(["Verify* Running npm test"]);
    // …and it holds its ticker: still the live one, not closing.
    expect(tickerText()).toBe("PASS a.test.ts");
    live(h, [test]);
    expect(tickerText()).toBe("PASS a.test.ts");
    // A gap that lasts: it lets go.
    live(h, [test, draft]);
    act(() => {
      vi.advanceTimersByTime(CARD_TICKER_HOLD_MS + 20);
    });
    expect(ticker()).toBeNull();
  });

  it("an edit's lines carry their sign as a tint, not a character", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<TraceCard />);
    h.startBackend();
    push(h, user(), op("Writing", "src/a.ts"));
    live(h, [
      view({
        started: true,
        ordinal: 0,
        path: "src/a.ts",
        mode: "diff",
        tail: "-const a = 1;\n+const a = 2;",
        lines: 2,
      }),
    ]);
    const first = ticker()?.querySelector(".trace-ticker__line");
    expect(first?.textContent).toBe("const a = 1;");
    expect(first?.className).toContain("is-del");
    settle();
    const next = ticker()?.querySelector(".trace-ticker__line");
    expect(next?.textContent).toBe("const a = 2;");
    expect(next?.className).toContain("is-add");
    // Its op row is in the record: no pending duplicate.
    expect(lines()).toEqual(["Edit* Writing src/a.ts [2 lines]"]);
  });

  it("a command's output flows under its step; before any, the ticker says so", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<TraceCard />);
    h.startBackend();
    push(h, user(), op("Running", "npm test"));
    const running = {
      tool: "bash",
      stage: "running" as const,
      started: true,
      ordinal: 0,
      commandLine: "npm test",
    };
    live(h, [view(running)]);
    expect(ticker()?.querySelector(".trace-ticker__empty")?.textContent).toBe(
      "No output yet",
    );
    live(h, [
      view({ ...running, tail: "PASS a.test.ts\nFAIL b.test.ts", lines: 2 }),
    ]);
    expect(tickerText()).toBe("PASS a.test.ts");
    settle();
    expect(tickerText()).toBe("FAIL b.test.ts");
    // Finished: it settles on the output's last word, and the cursor goes.
    live(h, [
      view({ ...running, done: true, ok: true, tail: "PASS a\nok", lines: 2 }),
    ]);
    settle();
    expect(tickerText()).toBe("ok");
    expect(ticker()?.className).toContain("is-done");
  });

  it("a file written in one breath does not end on its last `}`: it plays through, then settles on what it declares (owner 2026-09-30)", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<TraceCard />);
    h.startBackend();
    push(h, user(), op("Reading", "src/a.ts"));
    const file = [
      "// Fibonacci, iteratively.",
      "export function fib(n) {",
      "  let a = 0, b = 1;",
      "  for (let i = 0; i < n; i++) {",
      "    [a, b] = [b, a + b];",
      "  }",
      "  return a;",
      "}",
    ].join("\n");
    // The whole file lands in the snapshot that also says the call is done
    // (dispatched as the run's second op; its row has not landed yet).
    live(h, [
      view({
        path: "src/fib.js",
        started: true,
        ordinal: 1,
        done: true,
        ok: true,
        tail: file,
        lines: 8,
      }),
    ]);
    const seen = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const text = tickerText();
      if (text !== undefined) seen.add(text);
      settle(100);
    }
    expect(tickerText()).toBe("export function fib(n) {");
    expect(ticker()?.className).toContain("is-done");
    // It read as a stream on the way — and never showed a bare brace.
    expect(seen.size).toBeGreaterThanOrEqual(3);
    expect([...seen].some((s) => s.trim() === "}")).toBe(false);
  });

  it("a read has no ticker: its node names the step, and that is all", () => {
    const h = renderWithSession(<TraceCard />);
    h.startBackend();
    push(h, user(), op("Reading", "a.ts"));
    live(h, [
      view({
        tool: "read_file",
        streams: false,
        started: true,
        ordinal: 0,
        summary: "a.ts",
      }),
    ]);
    expect(lines()).toEqual(["Explore* Reading a.ts"]);
    expect(ticker()).toBeNull();
  });

  it("outlives the backend's end until the record catches up, then goes with the done-marker; a late snapshot does not bring it back", () => {
    const h = renderWithSession(<TraceCard />);
    h.startBackend();
    push(h, user(), op("Running", "npm test"));
    const done = view({
      tool: "bash",
      stage: "running",
      started: true,
      ordinal: 0,
      done: true,
      commandLine: "npm test",
      tail: "x",
      lines: 1,
    });
    live(h, [done]);
    h.finishBackend();
    // The record has not caught up (it waits on Herta's beats): still shown.
    expect(ticker()).not.toBeNull();
    push(h, doneMarker);
    expect(ticker()).toBeNull();
    live(h, [done]);
    expect(ticker()).toBeNull();
  });

  it("steps that ran while the record lagged stay on the timeline, with their own status, until their rows land (lab 2026-09-30)", () => {
    const h = renderWithSession(<TraceCard />);
    h.startBackend();
    push(h, user(), op("Writing", "fib.js"));
    const ran = view({
      id: "c2",
      tool: "bash",
      stage: "running",
      started: true,
      ordinal: 1,
      done: true,
      ok: false,
      summary: "node fib.js",
      commandLine: "node fib.js",
    });
    const reading = view({
      id: "c3",
      tool: "read_file",
      streams: false,
      started: true,
      ordinal: 2,
      summary: "fib.js",
    });
    // Two steps past the record: the command that failed, then a read.
    live(h, [ran, reading]);
    expect(lines()).toEqual([
      "Edit Edited fib.js",
      "Verify Ran node fib.js",
      "Explore* Reading fib.js",
    ]);
    expect(nodes()[1]?.className).toContain("is-fail");
    // One row lands: the record's own op takes its place; the rest stays.
    push(h, op("Running", "node fib.js"), exit(1));
    expect(lines()).toEqual([
      "Edit Edited fib.js",
      "Verify Ran node fib.js [exit 1]",
      "Explore* Reading fib.js",
    ]);
    // The other lands: nothing is doubled.
    push(h, op("Reading", "fib.js"));
    expect(lines()).toEqual([
      "Edit Edited fib.js",
      "Verify Ran node fib.js [exit 1]",
      "Explore* Reading fib.js",
    ]);
  });

  it("a file written behind a running command waits below it: the command is in flight, its output under it (lab 2026-09-30)", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<TraceCard />);
    h.startBackend();
    push(h, user(), op("Running", "pwd && ls"));
    const drafted = view({
      id: "c2",
      path: "fib.js",
      tail: "main();",
      lines: 36,
    });
    const cmd = view({
      id: "c1",
      tool: "bash",
      stage: "running",
      started: true,
      ordinal: 0,
      commandLine: "pwd && ls",
      tail: "/ws\nfib.js",
      lines: 2,
    });
    // The command was the last heard from: it runs; the file waits.
    act(() => {
      h.mock.emitLive({ views: [cmd, drafted], startedOps: 1, focus: "c1" });
    });
    expect(lines()).toEqual([
      "Explore* Running pwd && ls [2 lines]",
      // Nothing written yet: what it is going to do, not what it did.
      "Edit Writing fib.js",
    ]);
    expect(nodes()[1]?.className).toContain("is-queued");
    settle();
    expect(tickerText()).toBe("fib.js");
    // The command finished and nothing else runs: the file is next.
    act(() => {
      h.mock.emitLive({
        views: [{ ...cmd, done: true, ok: true }, drafted],
        startedOps: 1,
        focus: "c1",
      });
    });
    expect(lines()).toEqual(["Explore Ran pwd && ls", "Edit* Writing fib.js"]);
    // Not the focused call's step: no ticker under it.
    expect(ticker()).toBeNull();
  });

  it("a second dispatch chained in the same turn opens on its first call while the record still ends at the previous marker (review 2026-09-30)", () => {
    vi.useFakeTimers();
    const h = renderWithSession(<TraceCard />);
    h.startBackend();
    push(h, user(), op("Reading", "a.ts"));
    const done = { started: true, done: true, ok: true, streams: false };
    live(h, [view({ id: "c1", ...done, ordinal: 0, summary: "view a.ts" })]);
    // The first run ends and its marker lands: the card settles it.
    h.finishBackend();
    push(h, doneMarker);
    expect(lines()).toEqual(["Explore Read a.ts"]);
    // Herta chains @板砖 in the same turn: a new run starts and its first
    // call — a file being written — streams before any row of it lands.
    h.startBackend();
    live(h, [view({ id: "c2", path: "b.ts", tail: "x", lines: 1 })], 0);
    expect(lines()).toEqual(["Edit* Writing b.ts [1 line]"]);
    // The ticker under it flows what the file holds so far — its one line
    // once it has held still.
    settle();
    expect(tickerText()).toBe("x");
  });

  it("the record catching up with its marker settles the whole run in that very commit — no step long done goes back in flight on the way (lab 2026-09-30)", () => {
    const h = renderWithSession(<TraceCard />);
    h.startBackend();
    push(h, user(), op("Writing", "fib.js"));
    const done = { started: true, done: true, ok: true, streams: false };
    act(() => {
      h.mock.emitLive({
        views: [
          view({
            id: "c2",
            tool: "bash",
            ordinal: 1,
            summary: "node fib.js",
            ...done,
          }),
          view({
            id: "c3",
            tool: "read_file",
            ordinal: 2,
            summary: "fib.js",
            ...done,
          }),
        ],
        startedOps: 3,
        focus: "c3",
      });
    });
    h.finishBackend();
    expect(lines()).toEqual([
      "Edit Edited fib.js",
      "Verify Ran node fib.js",
      "Explore* Reading fib.js",
    ]);
    // Every class the Edit node takes on while the rest of the run lands.
    const edit = nodes()[0] as Element;
    const seen = new MutationObserver(() => {});
    seen.observe(edit, { attributes: true, attributeOldValue: true });
    push(
      h,
      op("Running", "node fib.js"),
      exit(0),
      op("Reading", "fib.js"),
      doneMarker,
    );
    const classes = [
      ...seen.takeRecords().map((r) => r.oldValue ?? ""),
      edit.className,
    ];
    seen.disconnect();
    expect(classes.some((c) => c.includes("is-in-flight"))).toBe(false);
    expect(lines()).toEqual([
      "Edit Edited fib.js",
      "Verify Ran node fib.js [exit 0]",
      "Explore Read fib.js",
    ]);
  });

  it("does not follow the run to another session", () => {
    const h = renderWithSession(<TraceCard />);
    h.startBackend();
    push(h, user(), op("Running", "npm test"));
    live(h, [
      view({
        tool: "bash",
        stage: "running",
        started: true,
        ordinal: 0,
        commandLine: "npm test",
        tail: "x",
        lines: 1,
      }),
    ]);
    expect(ticker()).not.toBeNull();
    h.switchSession("other");
    expect(ticker()).toBeNull();
    expect(card()).toBeNull();
  });
});

describe("stepOf", () => {
  it("names the step a live call is, with the status the view knows", () => {
    expect(stepOf(view({ path: "a.ts" }))).toEqual({
      verb: "Writing",
      arg: "a.ts",
      phase: "modify",
      status: "running",
    });
    expect(stepOf(view({ tool: "bash", commandLine: "npm test" }))).toEqual({
      verb: "Running",
      arg: "npm test",
      phase: "verify",
      status: "running",
    });
    expect(
      stepOf(view({ tool: "bash", commandLine: "cat > a.ts <<'EOF'" }))?.phase,
    ).toBe("modify");
    expect(stepOf(view({ done: true, ok: false, path: "a.ts" }))?.status).toBe(
      "fail",
    );
    // A call with no op row is no step.
    expect(stepOf(view({ tool: "report_finding" }))).toBeNull();
  });

  it("once dispatched, is named by the record's own summary — the row that replaces it reads the same", () => {
    expect(
      stepOf(
        view({
          tool: "read_file",
          streams: false,
          started: true,
          summary: "a.ts",
        }),
      ),
    ).toEqual({
      verb: "Reading",
      arg: "a.ts",
      phase: "explore",
      status: "running",
    });
    // The editor's summary leads with its command word; the row does not.
    expect(
      stepOf(
        view({ streams: false, started: true, summary: "view fib.js:1-36" }),
      ),
    ).toMatchObject({ verb: "Reading", arg: "fib.js:1-36" });
    expect(
      stepOf(
        view({ started: true, summary: "create fib.js", path: "/abs/fib.js" }),
      ),
    ).toMatchObject({ verb: "Writing", arg: "fib.js", phase: "modify" });
  });

  it("before that, a path as the record spells it: relative to the workspace, in any spelling", () => {
    expect(
      stepOf(
        view({ path: "/c/Users/me/.herta/workspaces/abc/fib.js" }),
        "C:\\Users\\me\\.herta\\workspaces\\abc",
      )?.arg,
    ).toBe("fib.js");
  });

  it("a command being written drops the model's `cd <workspace> &&`, as its row will", () => {
    expect(
      stepOf(
        view({
          tool: "bash",
          commandLine: "cd /c/Users/me/ws && node fib.js | tail -n 5",
        }),
        "C:\\Users\\me\\ws",
      )?.arg,
    ).toBe("node fib.js | tail -n 5");
  });
});

describe("pendingSteps", () => {
  const snap = (
    views: LiveToolView[],
    startedOps: number,
  ): LiveToolSnapshot => ({
    views,
    startedOps,
  });
  const read = (id: string, ordinal: number, summary: string) =>
    view({
      id,
      tool: "read_file",
      streams: false,
      started: true,
      ordinal,
      summary,
    });

  it("appends exactly the dispatched steps the record has not counted yet, in order — however far it lags", () => {
    const s = snap(
      [read("a", 0, "a.ts"), read("b", 1, "b.ts"), read("c", 2, "c.ts")],
      3,
    );
    const args = (n: number) => pendingSteps(s, n).steps.map((p) => p.arg);
    expect(args(3)).toEqual([]);
    expect(args(2)).toEqual(["c.ts"]);
    expect(args(0)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("a call still being written comes last — unless the record is already ahead of the feed", () => {
    const s = snap(
      [read("a", 0, "a.ts"), view({ id: "d", path: "new.ts" })],
      1,
    );
    const args = (n: number) => pendingSteps(s, n).steps.map((p) => p.arg);
    expect(args(1)).toEqual(["new.ts"]);
    expect(args(0)).toEqual(["a.ts", "new.ts"]);
    // The record counts more rows than the feed has dispatched: a row landed
    // before the snapshot that would dispatch the draft — it may be the draft.
    expect(args(2)).toEqual([]);
  });

  it("names the focused call's step by its place in the dispatch — in the record or past it — with the status its view knows", () => {
    const s = (focus: string): LiveToolSnapshot => ({
      views: [
        { ...read("a", 0, "a.ts"), done: true, ok: true },
        read("b", 1, "b.ts"),
      ],
      startedOps: 2,
      focus,
    });
    expect(pendingSteps(s("a"), 2).focus).toEqual({ op: 0, status: "ok" });
    expect(pendingSteps(s("b"), 1).focus).toEqual({
      op: 1,
      status: "running",
    });
    expect(pendingSteps(s("zz"), 1).focus).toBeNull();
  });

  it("a call written but not run, and not the one being written, is queued", () => {
    const s: LiveToolSnapshot = {
      views: [
        view({ id: "x", tool: "bash", commandLine: "pwd" }),
        view({ id: "y", path: "fib.js" }),
      ],
      startedOps: 0,
      focus: "y",
    };
    expect(pendingSteps(s, 0).steps.map((p) => [p.arg, p.status])).toEqual([
      ["pwd", "queued"],
      ["fib.js", "running"],
    ]);
    expect(pendingSteps(s, 0).focus?.op).toBe(1);
  });

  it("a record window cut short of the dispatch's start cannot be counted: nothing is appended", () => {
    expect(pendingSteps(snap([read("a", 0, "a.ts")], 1), null)).toEqual({
      steps: [],
      focus: null,
    });
  });
});
