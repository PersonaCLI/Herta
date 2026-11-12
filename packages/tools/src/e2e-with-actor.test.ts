import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentEvent,
  BackendContextBuilder,
  BackgroundHost,
  CodingAgentRuntime,
  FindingsLedger,
  type HertaToAgentBrief,
  type HertaTool,
  InMemoryEventBus,
  InMemoryToolRegistry,
  NoopMemoryManager,
  type PermissionEngine,
  ReadLedger,
  RulePermissionEngine,
} from "@herta/core";
import { FakeAskResolver, FakeProvider } from "@herta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMinimalTools,
  registerStrReplaceEditorRule,
  reportFindingTool,
  showExcerptTool,
  strReplaceEditorTool,
} from "./index.js";
import { mkTmpWorkspace, type TmpWorkspace } from "./testing/tmp-workspace.js";

/**
 * The tool set end-to-end. These ran the standard set until it was deleted
 * (ADR 0086); they now run the tools 板砖 has, minus `bash` itself, which
 * needs a real shell and has its own suite. Drives
 * `CodingAgentRuntime.runBrief` directly with a synthesized brief. The earlier version of this file ran turns through
 * the deterministic V1 actor wrapper; with V1 deleted, the actor added no
 * signal here — the assertions are about the tool/turn-loop integration,
 * not actor framing — so we drive the backend runtime directly.
 */

interface RuntimeHarness {
  runtime: CodingAgentRuntime;
  bus: InMemoryEventBus<AgentEvent>;
  tools: InMemoryToolRegistry;
  permissions: PermissionEngine;
  ask: FakeAskResolver;
  workspaceRoot: string;
}

function mkRuntime(opts: {
  provider: FakeProvider;
  permissions?: PermissionEngine;
  tools?: InMemoryToolRegistry;
  ask?: FakeAskResolver;
  workspaceRoot?: string;
}): RuntimeHarness {
  const ask = opts.ask ?? new FakeAskResolver();
  const permissions = opts.permissions ?? new RulePermissionEngine({ ask });
  const tools = opts.tools ?? new InMemoryToolRegistry();
  const bus = new InMemoryEventBus<AgentEvent>();
  const backendBuilder = new BackendContextBuilder({ tools });
  const workspaceRoot = opts.workspaceRoot ?? "/repo";
  const runtime = new CodingAgentRuntime({
    sessionId: "test",
    provider: opts.provider,
    tools,
    permissions,
    backendBuilder,
    bus,
    clock: () => new Date("2026-05-08T00:00:00.000Z"),
    workspaceRoot,
    memory: new NoopMemoryManager(),
  });
  return { runtime, bus, tools, permissions, ask, workspaceRoot };
}

function brief(_text: string, taskId = "tools-e2e-1"): HertaToAgentBrief {
  return { taskId };
}

function userMessages(text: string): ReadonlyArray<{ text: string }> {
  return [{ text }];
}

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

/** The set as the app builds it, on a bash that is never started here. */
const toolSet = (opts: { vision?: boolean } = {}): HertaTool[] =>
  createMinimalTools({
    bashPath: "/nonexistent/bash",
    workspaceShellPath: () => "/ws",
    digestModel: null,
    ...opts,
  });

/** The editor alone, on native paths, with its rule behind an engine. */
function editorOn(permissions: RulePermissionEngine, bus: unknown) {
  registerStrReplaceEditorRule(permissions, {
    bus: bus as InMemoryEventBus<AgentEvent>,
    bashPath: null,
  });
}
const editor = (root: () => string): HertaTool =>
  strReplaceEditorTool({ bashPath: null, workspaceShellPath: root });

describe("the tool set end-to-end with CodingAgentRuntime", () => {
  it("the model can call a tool and the result flows through the turn loop", async () => {
    ws = await mkTmpWorkspace({
      "src/hello.ts": "export const hello = 'world';\n",
    });

    const provider = new FakeProvider({
      turns: [
        [
          { type: "text-delta", text: "let me show the file" },
          {
            type: "tool-call-request",
            call: {
              id: "tc1",
              tool: "show_excerpt",
              input: { path: "src/hello.ts", fromLine: 1, toLine: 1 },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "got it" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });

    const tools = new InMemoryToolRegistry();
    tools.register(showExcerptTool());
    const { runtime, bus } = mkRuntime({
      provider,
      tools,
      workspaceRoot: ws.root,
    });

    const events: AgentEvent[] = [];
    bus.onAny((e) => events.push(e));
    await runtime.runBrief(brief("what's in hello.ts?"), {
      userMessages: userMessages("what's in hello.ts?"),
    });

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "assistant.delta",
      "assistant.final",
      "tool.call.started",
      "tool.call.finished",
      "assistant.delta",
      "assistant.final",
      "turn.finished",
    ]);

    const finished = events.find((e) => e.type === "tool.call.finished");
    expect(finished).toBeDefined();
    if (finished?.type === "tool.call.finished") {
      expect(finished.id).toBe("tc1");
      expect(finished.result.ok).toBe(true);
      expect(JSON.stringify(finished.result.data)).toContain("hello");
    }
  });

  it("marks exactly the pure-read tools readOnly (parallel-batch safety, ADR 0025 slice 5)", () => {
    const flags = new Map(
      toolSet({ vision: true }).map((t) => [t.name, t.readOnly === true]),
    );
    const readOnly = [...flags.entries()]
      .filter(([, v]) => v)
      .map(([k]) => k)
      .sort();
    expect(readOnly).toEqual([
      // digest_document reads an attachment and writes only its own sidecar
      // under .herta (ADR 0043) — nothing another read could observe change.
      "digest_document",
      // show_excerpt reads and presents; it mutates nothing (ADR 0027).
      "show_excerpt",
      // view_image looks; it is path-guarded like show_excerpt.
      "view_image",
    ]);
    // Mutators must never opt in — the flag is the batch-safety contract.
    // `bash` decides per call, from the line it was given, never by a flag
    // on the tool; the editor writes.
    for (const mutator of [
      "bash",
      "str_replace_editor",
      "memory_save",
      // Appends to the per-brief findings ledger (ADR 0039) — harness state;
      // serial keeps finding indices in order.
      "report_finding",
    ]) {
      expect(flags.get(mutator), mutator).toBe(false);
    }
  });

  it("view_image mounts ONLY on a vision-capable model (ADR 0048 §5)", () => {
    // A model without vision answers 400 to an image part, and a tool the
    // model is told it has but cannot use is worse than no tool: it invites a
    // call that fails, and invites the model to believe it looked.
    const names = (vision: boolean) => toolSet({ vision }).map((t) => t.name);
    expect(names(false)).not.toContain("view_image");
    expect(names(true)).toContain("view_image");
  });

  it("createMinimalTools (ADR 0040): the trained pair plus the record channels (digest ADR 0043), and the record channels accept the shell's path spelling", async () => {
    ws = await mkTmpWorkspace({ "src/a.ts": "one\ntwo\nthree\n" });
    const tools = createMinimalTools({
      bashPath: "/nonexistent/bash",
      workspaceShellPath: () => ws.root,
      digestModel: null,
    });
    expect(tools.map((t) => t.name).sort()).toEqual([
      "bash",
      "digest_document",
      "memory_save",
      "report_finding",
      "show_excerpt",
      "str_replace_editor",
    ]);
    // Native and forward-slash spellings of the workspace pass; a relative
    // path passes; on Windows the /e/… MSYS form is understood too (live GUI
    // 2026-08-17: `/tmp/…` reached show_excerpt as `E:\tmp\…` — outside).
    const excerpt = tools.find((t) => t.name === "show_excerpt") as HertaTool;
    const ctx = {
      sessionId: "s",
      signal: new AbortController().signal,
      workspaceRoot: ws.root,
      reads: new ReadLedger(),
      bg: new BackgroundHost(),
      bus: new InMemoryEventBus<AgentEvent>(),
      memory: new NoopMemoryManager(),
      findings: new FindingsLedger(),
    };
    const spellings = [
      "src/a.ts",
      join(ws.root, "src", "a.ts"),
      `${ws.root.replace(/\\/g, "/")}/src/a.ts`,
    ];
    if (process.platform === "win32") {
      spellings.push(
        `${ws.root.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`)}/src/a.ts`,
      );
    }
    for (const p of spellings) {
      const r = await excerpt.run(
        {
          id: "e",
          tool: "show_excerpt",
          input: { path: p, fromLine: 1, toLine: 2 },
        },
        ctx,
        () => {},
      );
      expect(r.ok, p).toBe(true);
    }
    const finding = tools.find((t) => t.name === "report_finding") as HertaTool;
    const r = await finding.run(
      {
        id: "f",
        tool: "report_finding",
        input: {
          claim: "a.ts has three lines",
          cites: [`${spellings[spellings.length - 1]}:1-3`],
        },
      },
      ctx,
      () => {},
    );
    expect(r.ok).toBe(true);
    // …and the recorded cite is workspace-relative regardless of spelling.
    expect((r.data as { cites: string[] }).cites).toEqual(["src/a.ts:1-3"]);
  });

  it("e2e: an edit with the ask-allow flow: the preview, then the question, then the write", async () => {
    ws = await mkTmpWorkspace({ "x.txt": "alpha\nbeta\n" });
    const abs = join(ws.root, "x.txt");
    const ask = new FakeAskResolver();
    const permissions = new RulePermissionEngine({ ask });
    const tools = new InMemoryToolRegistry();
    tools.register(editor(() => ws.root));
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "p1",
              tool: "str_replace_editor",
              input: {
                command: "str_replace",
                path: abs,
                old_str: "alpha",
                new_str: "ALPHA",
              },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime, bus } = mkRuntime({
      provider,
      tools,
      permissions,
      ask,
      workspaceRoot: ws.root,
    });
    editorOn(permissions, bus);

    const events: AgentEvent[] = [];
    bus.onAny((e) => events.push(e));
    bus.onAny((e) => {
      if (e.type === "permission.requested") ask.allow();
    });

    await runtime.runBrief(brief("patch alpha"), {
      userMessages: userMessages("patch alpha"),
    });

    const types = events.map((e) => e.type);
    const previewIdx = types.indexOf("patch.preview");
    const requestIdx = types.indexOf("permission.requested");
    const resolvedIdx = types.indexOf("permission.resolved");
    expect(previewIdx).toBeGreaterThanOrEqual(0);
    expect(previewIdx).toBeLessThan(requestIdx);
    expect(requestIdx).toBeLessThan(resolvedIdx);

    const reqEvt = events.find(
      (e) =>
        e.type === "permission.requested" &&
        e.request.call.tool === "str_replace_editor",
    );
    expect(reqEvt).toBeDefined();
    if (reqEvt?.type !== "permission.requested") throw new Error();
    expect(reqEvt.request.diff).toContain("+ALPHA");
    expect(reqEvt.request.files).toEqual(["x.txt"]);

    const fin = events.find(
      (e) => e.type === "tool.call.finished" && e.id === "p1",
    );
    expect(fin?.type).toBe("tool.call.finished");
    if (fin?.type !== "tool.call.finished") throw new Error();
    expect(fin.result.ok).toBe(true);
    expect(await readFile(abs, "utf-8")).toBe("ALPHA\nbeta\n");
  });

  it("e2e: a denied edit writes nothing and the run goes on", async () => {
    ws = await mkTmpWorkspace({ "x.txt": "alpha\n" });
    const abs = join(ws.root, "x.txt");
    const ask = new FakeAskResolver();
    const permissions = new RulePermissionEngine({ ask });
    const tools = new InMemoryToolRegistry();
    tools.register(editor(() => ws.root));
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "p1",
              tool: "str_replace_editor",
              input: {
                command: "str_replace",
                path: abs,
                old_str: "alpha",
                new_str: "ALPHA",
              },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "understood" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime, bus } = mkRuntime({
      provider,
      tools,
      permissions,
      ask,
      workspaceRoot: ws.root,
    });
    editorOn(permissions, bus);
    const events: AgentEvent[] = [];
    bus.onAny((e) => events.push(e));
    bus.onAny((e) => {
      if (e.type === "permission.requested") ask.deny();
    });

    await runtime.runBrief(brief("patch alpha"), {
      userMessages: userMessages("patch alpha"),
    });

    const fin = events.find(
      (e) => e.type === "tool.call.finished" && e.id === "p1",
    );
    if (fin?.type !== "tool.call.finished") throw new Error("no result");
    expect(fin.result.ok).toBe(false);
    expect(fin.result.error?.code).toBe("permission_denied");
    expect(fin.result.error?.retryable).toBe(false);
    expect(await readFile(abs, "utf-8")).toBe("alpha\n");
    expect(events.at(-1)?.type).toBe("turn.finished");
  });

  it("e2e: a create with the ask-allow flow, then an edit of the new file in the same batch", async () => {
    ws = await mkTmpWorkspace({});
    const abs = join(ws.root, "src", "created.ts");
    const ask = new FakeAskResolver();
    const permissions = new RulePermissionEngine({ ask });
    const tools = new InMemoryToolRegistry();
    tools.register(editor(() => ws.root));
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "w1",
              tool: "str_replace_editor",
              input: {
                command: "create",
                path: abs,
                file_text: "export const value = 1;\n",
              },
            },
          },
          {
            type: "tool-call-request",
            call: {
              id: "p1",
              tool: "str_replace_editor",
              input: {
                command: "str_replace",
                path: abs,
                old_str: "value = 1",
                new_str: "value = 2",
              },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
      ],
    });
    const { runtime, bus } = mkRuntime({
      provider,
      tools,
      permissions,
      ask,
      workspaceRoot: ws.root,
    });
    editorOn(permissions, bus);

    const events: AgentEvent[] = [];
    bus.onAny((e) => events.push(e));
    let permIdx = 0;
    bus.onAny((e) => {
      if (e.type === "permission.requested") {
        ask.allow(permIdx);
        permIdx += 1;
      }
    });

    await runtime.runBrief(brief("create then edit"), {
      userMessages: userMessages("create then edit"),
    });

    const writePreview = events.find(
      (e) => e.type === "patch.preview" && e.diff.includes("--- /dev/null"),
    );
    expect(writePreview).toBeDefined();

    for (const id of ["w1", "p1"]) {
      const fin = events.find(
        (e) => e.type === "tool.call.finished" && e.id === id,
      );
      if (fin?.type !== "tool.call.finished") throw new Error(`no ${id}`);
      expect(fin.result.ok, id).toBe(true);
    }
    expect(await readFile(abs, "utf-8")).toBe("export const value = 2;\n");
  });

  it("e2e: a run that records its finding and stops reports completed at that stop — no end-of-run check, no todo carry-over (ADR 0073)", async () => {
    ws = await mkTmpWorkspace({
      "src/parser.ts": "export const cursor = 0;\n",
    });
    const tools = new InMemoryToolRegistry();
    tools.register(reportFindingTool());
    const provider = new FakeProvider({
      turns: [
        [
          {
            type: "tool-call-request",
            call: {
              id: "f1",
              tool: "report_finding",
              input: {
                claim: "the cursor starts at 0 and is never reset",
                cites: ["src/parser.ts:1"],
              },
            },
          },
          { type: "finish", reason: "tool_calls" },
        ],
        [
          { type: "text-delta", text: "done" },
          { type: "finish", reason: "stop" },
        ],
        // A third call would exhaust the script and fail the run.
      ],
    });
    const { runtime } = mkRuntime({ provider, tools, workspaceRoot: ws.root });

    const report = await runtime.runBrief(brief("fix the parser"), {
      userMessages: userMessages("fix the parser"),
    });
    expect(report.status).toBe("completed");
    expect("nextActions" in report).toBe(false);
  });
});
