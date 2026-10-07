import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryEventBus } from "../event-bus.js";
import { NoopMemoryManager } from "../memory-manager.js";
import { NoopPermissionEngine } from "../permission-engine.js";
import { FakeProvider } from "../testing/fake-provider.js";
import { InMemoryToolRegistry } from "../tool-registry.js";
import type { AgentEvent } from "../types/events.js";
import type { ToolContext, ToolResult } from "../types/tool.js";
import { BackendContextBuilder } from "./backend-context-builder.js";
import {
  CodingAgentRuntime,
  type CodingAgentRuntimeDeps,
} from "./coding-agent-runtime.js";
import { dispatchJournalPath } from "./dispatch-journal.js";
import { readUndoIndex, undoSegments, undoStoreDir } from "./undo-store.js";

let root: string;
let slowStarted = false;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herta-runtime-undo-"));
  slowStarted = false;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/** One inference that calls each of `tools`, then one that stops. A tool
 *  given as `[name, input]` gets that input. */
function calling(
  ...tools: Array<string | [string, Record<string, unknown>]>
): FakeProvider {
  return new FakeProvider({
    turns: [
      [
        ...tools.map((t, i) => ({
          type: "tool-call-request" as const,
          call: {
            id: `c${i + 1}`,
            tool: typeof t === "string" ? t : t[0],
            input: typeof t === "string" ? {} : t[1],
          },
        })),
        { type: "finish" as const, reason: "tool_calls" as const },
      ],
      [{ type: "finish", reason: "stop" }],
    ],
  });
}

const schema = (name: string) => () => ({
  name,
  description: name,
  inputSchema: { type: "object" as const, properties: {} },
});

function runtimeWith(
  provider: FakeProvider,
  opts: {
    undoDir?: string;
    journalPath?: string;
    repoProbe?: CodingAgentRuntimeDeps["repoProbe"];
  },
) {
  const tools = new InMemoryToolRegistry();
  /** What each call's context carried for undo. */
  const seen: Array<ToolContext["undo"]> = [];
  // An editor: captures what it replaces, reports the path it wrote.
  tools.register({
    name: "edit_file",
    schema: schema("edit_file"),
    run: async (_call: unknown, ctx: ToolContext): Promise<ToolResult> => {
      seen.push(ctx.undo);
      await ctx.undo?.captureWrite({
        path: join(root, "ws", "a.ts"),
        before: Buffer.from("old"),
        after: "after-sha",
      });
      return {
        ok: true,
        summary: "edited",
        data: { relPath: "a.ts", diff: "" },
      };
    },
  });
  // A command: changes nothing the run can see by itself. Its input says
  // whether the classifier took it for a read (`readOnly`).
  tools.register({
    name: "bash",
    schema: schema("bash"),
    run: async (call: { input: unknown }): Promise<ToolResult> => ({
      ok: true,
      summary: "ran",
      data: {
        exitCode: 0,
        readOnly: (call.input as { readOnly?: boolean }).readOnly === true,
      },
    }),
  });
  // A step that runs until the run is stopped (a run to continue).
  tools.register({
    name: "slow",
    schema: schema("slow"),
    run: (_call: unknown, ctx: ToolContext): Promise<ToolResult> => {
      slowStarted = true;
      return new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    },
  });
  const runtime = new CodingAgentRuntime({
    sessionId: "s-1",
    provider,
    tools,
    permissions: new NoopPermissionEngine(),
    backendBuilder: new BackendContextBuilder({ tools }),
    bus: new InMemoryEventBus<AgentEvent>(),
    clock: () => new Date("2026-10-07T10:00:00.000Z"),
    workspaceRoot: join(root, "ws"),
    memory: new NoopMemoryManager(),
    ...(opts.journalPath !== undefined
      ? { journalPath: opts.journalPath }
      : {}),
    ...(opts.undoDir !== undefined ? { undoDir: opts.undoDir } : {}),
    ...(opts.repoProbe !== undefined ? { repoProbe: opts.repoProbe } : {}),
  });
  return { runtime, seen };
}

const undoDirFor = (): string => undoStoreDir(join(root, "sessions"), "sess");
const views = async () => undoSegments(await readUndoIndex(undoDirFor()));

describe("a run keeps what its editors replace (ADR 0074 §1)", () => {
  it("a dispatch opens a segment at its record length, and its tools capture into it", async () => {
    const { runtime, seen } = runtimeWith(calling("edit_file"), {
      undoDir: undoDirFor(),
    });
    await runtime.runBrief(
      { taskId: "task-1" },
      { userMessages: [{ text: "edit it" }], recordLength: 12 },
    );
    expect(seen[0]).toBeDefined();
    expect(await readUndoIndex(undoDirFor())).toEqual([
      { kind: "segment", seg: 1, at: 12, taskId: "task-1" },
      {
        kind: "write",
        seg: 1,
        path: join(root, "ws", "a.ts"),
        before: expect.any(String),
        after: "after-sha",
      },
    ]);
  });

  it("no undo folder (the CLI, tests), or no record length to key it by: the tools get no undo", async () => {
    const none = runtimeWith(calling("edit_file"), {});
    await none.runtime.runBrief(
      { taskId: "task-1" },
      { userMessages: [{ text: "edit it" }], recordLength: 12 },
    );
    expect(none.seen).toEqual([undefined]);

    const unkeyed = runtimeWith(calling("edit_file"), {
      undoDir: undoDirFor(),
    });
    await unkeyed.runtime.runBrief(
      { taskId: "task-1" },
      { userMessages: [{ text: "edit it" }] },
    );
    expect(unkeyed.seen).toEqual([undefined]);
    expect(await readUndoIndex(undoDirFor())).toEqual([]);
  });

  it("a 继续 continuation opens its own segment, at the record length it was asked at", async () => {
    const journalPath = dispatchJournalPath(join(root, "sessions"), "sess");
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "c1", tool: "slow", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          {
            type: "tool-call-request",
            call: { id: "c2", tool: "edit_file", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [{ type: "finish", reason: "stop" }],
      ],
    });
    const { runtime } = runtimeWith(provider, {
      undoDir: undoDirFor(),
      journalPath,
    });
    const stop = new AbortController();
    const first = runtime.runBrief(
      { taskId: "task-1" },
      {
        signal: stop.signal,
        userMessages: [{ text: "edit it" }],
        recordLength: 3,
      },
    );
    while (!slowStarted) await new Promise((r) => setTimeout(r, 5));
    stop.abort();
    expect((await first).status).toBe("interrupted");

    await runtime.resumeBrief({ recordLength: 6 });
    expect(
      (await views()).map((v) => [v.seg, v.at, v.taskId, v.writes.length]),
    ).toEqual([
      [1, 3, "task-1", 0],
      [2, 6, "task-1", 1],
    ]);
  });
});

describe("a run notes what its commands changed (ADR 0074 §2)", () => {
  it("the files commands changed, not the ones its editors wrote", async () => {
    const snapshots = [
      { head: "h1", dirty: [] },
      { head: "h1", dirty: ["a.ts", "package-lock.json"] },
    ];
    let call = 0;
    const { runtime } = runtimeWith(calling("edit_file", "bash"), {
      undoDir: undoDirFor(),
      repoProbe: async () => snapshots[call++] ?? null,
    });
    await runtime.runBrief(
      { taskId: "task-1" },
      { userMessages: [{ text: "edit and install" }], recordLength: 12 },
    );
    expect((await views())[0]?.commands).toEqual({
      paths: ["package-lock.json"],
      unknown: false,
    });
  });

  it("with no repository to read, a run that ran a command says what it changed is unknown", async () => {
    const { runtime } = runtimeWith(calling("bash"), { undoDir: undoDirFor() });
    await runtime.runBrief(
      { taskId: "task-1" },
      { userMessages: [{ text: "run it" }], recordLength: 12 },
    );
    expect((await views())[0]?.commands).toEqual({ paths: [], unknown: true });
  });

  it("a read-only command — `git status` in a folder that is no repository — notes nothing (live check, 2026-10-07)", async () => {
    const { runtime } = runtimeWith(
      calling("edit_file", ["bash", { readOnly: true }]),
      { undoDir: undoDirFor() },
    );
    await runtime.runBrief(
      { taskId: "task-1" },
      { userMessages: [{ text: "edit it" }], recordLength: 12 },
    );
    expect((await views())[0]?.commands).toEqual({ paths: [], unknown: false });
  });

  it("a run that ran no command notes nothing", async () => {
    const { runtime } = runtimeWith(calling("edit_file"), {
      undoDir: undoDirFor(),
    });
    await runtime.runBrief(
      { taskId: "task-1" },
      { userMessages: [{ text: "edit it" }], recordLength: 12 },
    );
    expect((await views())[0]?.commands).toEqual({ paths: [], unknown: false });
  });
});
