import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryEventBus } from "../event-bus.js";
import { NoopMemoryManager } from "../memory-manager.js";
import { NoopPermissionEngine } from "../permission-engine.js";
import { FakeProvider } from "../testing/fake-provider.js";
import { InMemoryToolRegistry } from "../tool-registry.js";
import type { AgentEvent } from "../types/events.js";
import type { ProviderPromptFrame } from "../types/provider.js";
import type { ToolResult } from "../types/tool.js";
import { BackendContextBuilder } from "./backend-context-builder.js";
import { CodingAgentRuntime } from "./coding-agent-runtime.js";
import {
  dispatchJournalPath,
  readDispatchJournal,
  readJournalIndex,
} from "./dispatch-journal.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herta-runtime-journal-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

/** One inference that calls `calls` in order, then one that stops. */
function scripted(calls: Array<{ id: string; tool: string }>): FakeProvider {
  return new FakeProvider({
    turns: [
      [
        ...calls.map((c) => ({
          type: "tool-call-request" as const,
          call: { id: c.id, tool: c.tool, input: {} },
        })),
        { type: "finish" as const, reason: "tool_calls" as const },
      ],
      [{ type: "finish" as const, reason: "stop" as const }],
    ],
  });
}

function runtimeWith(provider: FakeProvider, journalPath: string) {
  const tools = new InMemoryToolRegistry();
  const ran: string[] = [];
  /** The open index as each tool saw it while it ran. */
  const indexDuringRun: string[][] = [];
  const tool = (name: string, readOnly: boolean) => ({
    name,
    ...(readOnly ? { readOnly: true } : {}),
    schema: () => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
    }),
    run: async (): Promise<ToolResult> => {
      ran.push(name);
      indexDuringRun.push(await readJournalIndex(dirname(journalPath)));
      return { ok: true, summary: `${name} ok` };
    },
  });
  tools.register(tool("look", true));
  tools.register(tool("change", false));
  // A step that fails, for the report's per-tool risks.
  tools.register({
    name: "broken",
    readOnly: true,
    schema: () => ({
      name: "broken",
      description: "broken",
      inputSchema: { type: "object", properties: {} },
    }),
    run: async (): Promise<ToolResult> => ({
      ok: false,
      error: { code: "boom", message: "it broke", retryable: false },
      summary: "failed: boom",
    }),
  });
  // A step that runs until the run is stopped.
  tools.register({
    name: "slow",
    schema: () => ({
      name: "slow",
      description: "slow",
      inputSchema: { type: "object", properties: {} },
    }),
    run: (
      _call: unknown,
      ctx: { signal: AbortSignal },
    ): Promise<ToolResult> => {
      ran.push("slow");
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
    clock: () => new Date("2026-09-28T10:00:00.000Z"),
    workspaceRoot: join(root, "ws"),
    memory: new NoopMemoryManager(),
    journalPath,
    contract: "minimal",
  });
  return { runtime, ran, indexDuringRun };
}

describe("a run keeps its journal (ADR 0071 §1.1)", () => {
  it("start, the assistant's calls, each call dispatched before its result, then the end", async () => {
    const path = dispatchJournalPath(join(root, "sessions"), "sess");
    const { runtime, ran } = runtimeWith(
      scripted([{ id: "c1", tool: "change" }]),
      path,
    );
    const report = await runtime.runBrief(
      { taskId: "task-1" },
      { userMessages: [{ text: "do it" }], recordLength: 12 },
    );
    expect(ran).toEqual(["change"]);
    const entries = (await readDispatchJournal(path)) ?? [];
    expect(
      entries.map((e) =>
        e.kind === "message" ? `message:${e.message.role}` : e.kind,
      ),
    ).toEqual([
      "start",
      "message:assistant",
      "dispatch",
      "message:tool",
      "message:assistant",
      "end",
    ]);
    expect(entries[0]).toMatchObject({
      kind: "start",
      taskId: "task-1",
      contract: "minimal",
      recordLength: 12,
      frame: { userMessages: [{ text: "do it" }], lang: "zh" },
    });
    expect(entries[2]).toEqual({ kind: "dispatch", callIds: ["c1"] });
    expect(entries.at(-1)).toEqual({ kind: "end", status: report.status });
  });

  it("names its workspace and process, is listed in the open index while it runs, and unlisted at its end", async () => {
    const path = dispatchJournalPath(join(root, "sessions"), "sess");
    const { runtime, indexDuringRun } = runtimeWith(
      scripted([
        { id: "c1", tool: "look" },
        { id: "c2", tool: "change" },
      ]),
      path,
    );
    await runtime.runBrief({ taskId: "task-1" });
    const entries = (await readDispatchJournal(path)) ?? [];
    expect(entries[0]).toMatchObject({
      kind: "start",
      workspaceRoot: join(root, "ws"),
      host: { pid: process.pid },
    });
    // A read-only dispatch says so; a mutating one does not.
    expect(entries.filter((e) => e.kind === "dispatch")).toEqual([
      { kind: "dispatch", callIds: ["c1"], readOnly: true },
      { kind: "dispatch", callIds: ["c2"] },
    ]);
    expect(indexDuringRun).toEqual([["sess.jsonl"], ["sess.jsonl"]]);
    expect(await readJournalIndex(dirname(path))).toEqual([]);
  });

  it("a run the user stopped mid-step continues from its journal (ADR 0071 §1.5)", async () => {
    const path = dispatchJournalPath(join(root, "sessions"), "sess");
    let continued: ProviderPromptFrame | undefined;
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "c1", tool: "slow", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        (frame) => {
          continued = frame;
          return [{ type: "finish", reason: "stop" }];
        },
      ],
    });
    const { runtime, ran } = runtimeWith(provider, path);
    const stop = new AbortController();
    const first = runtime.runBrief(
      { taskId: "task-1" },
      {
        signal: stop.signal,
        userMessages: [{ text: "run the slow thing" }],
        recordLength: 3,
      },
    );
    while (!ran.includes("slow")) {
      await new Promise((r) => setTimeout(r, 5));
    }
    stop.abort();
    expect((await first).status).toBe("interrupted");

    // (The scripted model does nothing more, so the run reports `partial`
    // under the ordinary status rules.)
    await runtime.resumeBrief({ recordLength: 6 });
    // The same base frame: the original brief's own words.
    const sent = JSON.stringify(continued ?? {});
    expect(sent).toContain("run the slow thing");
    // The open step closed in the stop's words, then the note.
    expect(sent).toContain("stopped_outcome_unknown");
    expect(sent).toContain("开拓者按了停止");
    const messages = continued?.messages ?? [];
    expect(messages.at(-1)?.role).toBe("user");

    const kinds = ((await readDispatchJournal(path)) ?? []).map((e) =>
      e.kind === "message" ? `message:${e.message.role}` : e.kind,
    );
    expect(kinds).toEqual([
      "start",
      "message:assistant",
      "dispatch",
      "end",
      "closer",
      "resume",
      "message:assistant",
      "end",
    ]);
  });

  it("a run that reaches the step limit stops like an interruption, says why first, and is continued with a fresh budget (2026-09-29)", async () => {
    const path = dispatchJournalPath(join(root, "sessions"), "sess");
    let continued: ProviderPromptFrame | undefined;
    const step = (i: number) => [
      {
        type: "tool-call-request" as const,
        // Six failing steps first: their risks must not push the reason out.
        call: { id: `c${i}`, tool: i < 6 ? "broken" : "look", input: {} },
      },
      { type: "finish" as const, reason: "tool_calls" as const },
    ];
    const provider = new FakeProvider({
      turns: [
        ...Array.from({ length: 100 }, (_, i) => step(i)),
        (frame: ProviderPromptFrame) => {
          continued = frame;
          return [{ type: "finish", reason: "stop" }];
        },
      ],
    });
    const { runtime } = runtimeWith(provider, path);
    const stopped = await runtime.runBrief(
      { taskId: "task-1" },
      { userMessages: [{ text: "keep going" }], recordLength: 3 },
    );
    expect(stopped.status).toBe("interrupted");
    expect(stopped.endedBy).toBe("step_limit");
    expect(stopped.residualRisks[0]).toBe(
      "Turn stopped: reached the step limit (100 steps)",
    );
    expect(stopped.residualRisks.length).toBeGreaterThan(5);
    const entries = (await readDispatchJournal(path)) ?? [];
    expect(entries.at(-1)).toEqual({
      kind: "end",
      status: "interrupted",
      cause: "step-limit",
    });

    // Continued from the journal: told why it stopped, and it runs on.
    await runtime.resumeBrief({ recordLength: 6 });
    const sent = JSON.stringify(continued ?? {});
    expect(sent).toContain("达到了这次运行的步数上限");
    // The limit is the runtime's own (100 steps), each journaled in a real
    // file before it runs: well under a second alone, past the default 5 s
    // in a loaded suite (2026-11-03).
  }, 30_000);

  it("will not continue a run that ended, or one started under another contract", async () => {
    const path = dispatchJournalPath(join(root, "sessions"), "sess");
    const { runtime } = runtimeWith(
      scripted([{ id: "c1", tool: "change" }]),
      path,
    );
    await runtime.runBrief({ taskId: "task-1" });
    await expect(runtime.resumeBrief({})).rejects.toMatchObject({
      kind: "resume_unavailable",
    });
  });

  it("fails closed: with no journal, a mutating call does not run and says why; a read still runs", async () => {
    const sessions = join(root, "sessions");
    // The journal folder's place is taken by a file: nothing can be recorded.
    rmSync(sessions, { recursive: true, force: true });
    writeFileSync(join(root, "sessions"), "");
    const path = join(root, "sessions", "journal", "sess.jsonl");
    let secondRequest: ProviderPromptFrame | undefined;
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: { id: "c1", tool: "look", input: {} },
          },
          {
            type: "tool-call-request",
            call: { id: "c2", tool: "change", input: {} },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        (frame) => {
          secondRequest = frame;
          return [{ type: "finish", reason: "stop" }];
        },
      ],
    });
    const { runtime, ran } = runtimeWith(provider, path);
    const report = await runtime.runBrief({ taskId: "task-1" });
    expect(ran).toEqual(["look"]);
    expect(report.residualRisks.join("\n")).toContain("journal");
    // The model was told, in the refused call's own result.
    expect(JSON.stringify(secondRequest?.messages ?? [])).toContain(
      "journal_unavailable",
    );
  });
});
