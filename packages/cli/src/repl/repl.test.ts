import {
  type AgentEvent,
  type CodingAgentRuntime,
  type CompletionEvent,
  type CompletionProviderAdapter,
  type CompletionRequest,
  type HertaToAgentBrief,
  InMemoryEventBus,
  InMemoryToolRegistry,
  type ProviderAdapter,
  type ProviderEvent,
  type TerminalRecord,
} from "@herta/core";
import { type MetaThinkCorpus, V2ActorDriver } from "@herta/herta";
import { describe, expect, it, vi } from "vitest";
import { NarrativeRenderer } from "../render/narrative-renderer.js";
import { makeStyle } from "../render/style.js";
import { MockReadable, MockWritable } from "../testing/mock-streams.js";
import { Input } from "./input.js";
import { repl } from "./repl.js";

const style = makeStyle({ enabled: false });

// ---------------------------------------------------------------------------
// v0.2 harness helpers
// ---------------------------------------------------------------------------

async function* streamOf(
  events: CompletionEvent[],
): AsyncGenerator<CompletionEvent> {
  for (const e of events) yield e;
}

function mkV2Provider(
  scripts: ReadonlyArray<CompletionEvent[]>,
): CompletionProviderAdapter {
  let idx = 0;
  return {
    streamCompletion(_req: CompletionRequest): AsyncIterable<CompletionEvent> {
      const script = scripts[idx] ?? [{ type: "finish", reason: "stop" }];
      idx += 1;
      return streamOf(script);
    },
  };
}

function mkV2Driver(provider: CompletionProviderAdapter): V2ActorDriver {
  const noopRuntime: CodingAgentRuntime = {
    runBrief: async (brief: HertaToAgentBrief) => ({
      taskId: brief.taskId,
      status: "completed" as const,
      evidence: [],
      changedFiles: [],
      tests: [],
      permissions: [],
      residualRisks: [],
      nextActions: [],
    }),
  } as unknown as CodingAgentRuntime;
  const noopRouter: ProviderAdapter = {
    streamChat: async function* (): AsyncIterable<ProviderEvent> {
      yield { type: "text-delta", text: "不变" } as const;
      yield { type: "finish", reason: "stop" } as const;
    },
  };
  const emptyCorpus: MetaThinkCorpus = {
    preThink: {
      默认: "",
      被烦版: "",
      教学版: "",
      被戳穿版: "",
      任务部署版: "",
      板砖代答版: "",
      被顶嘴版: "",
      倾听版: "",
    },
    preSpeak: {
      默认: "",
      被烦版: "",
      教学版: "",
      被戳穿版: "",
      任务部署版: "",
      板砖代答版: "",
      被顶嘴版: "",
      倾听版: "",
    },
  };
  return new V2ActorDriver({
    provider,
    model: "test-model",
    staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
    bus: new InMemoryEventBus<AgentEvent>(),
    runtimeFactory: () => noopRuntime,
    routerProvider: noopRouter,
    metaThinkCorpus: emptyCorpus,
  });
}

// ---------------------------------------------------------------------------
// REPL tests (v0.2 path only — v0.1 tests deleted with ReplDeps collapse)
// ---------------------------------------------------------------------------

describe("repl", () => {
  it("runs one turn via V2ActorDriver and renders Herta output", async () => {
    // Every turn thinks before it speaks (2026-09-03): call 1 answers the
    // `（我 想）` prompt, call 2 the forced `（我 说）` prompt.
    const provider = mkV2Provider([
      [
        { type: "text-delta", text: "想想看。（/我 想）" },
        { type: "finish", reason: "stop" },
      ],
      [
        { type: "text-delta", text: "你好。" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const driver = mkV2Driver(provider);
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const tools = new InMemoryToolRegistry();
    const input = new Input(stdin, stdout);
    const renderer = new NarrativeRenderer(stdout, style);

    stdin.feed("在吗\n");
    stdin.feed("/quit\n");
    stdin.end();

    await repl({
      actor: driver,
      tools,
      input,
      renderer,
      out: stdout,
      style,
    });

    expect(stdout.full()).toContain("你好。");
    // The thought is internal monologue: the renderer shows only its
    // `(思考中…)` indicator (then clears it) and skips the committed block.
    expect(stdout.full()).not.toContain("想想看");
  });
});

describe("repl — mid-stream error recovery (Slice 9)", () => {
  it("calls renderer.cancelStream() if the actor throws mid-turn", async () => {
    // Set up a renderer with a cancelStream spy. Other methods are minimal mocks.
    const cancelStreamSpy = vi.fn();
    const renderer = {
      update: vi.fn(),
      streamHertaToken: vi.fn(),
      endHertaStream: vi.fn(),
      flushBlocks: vi.fn(),
      cancelStream: cancelStreamSpy,
    } as unknown as NarrativeRenderer;

    // Driver whose runTurn throws.
    const driver = {
      runTurn: vi.fn(async () => {
        throw new Error("simulated stream interrupt");
      }),
      getRecord: vi.fn(() => [] as TerminalRecord),
      loadRecord: vi.fn(),
      setPersister: vi.fn(),
    } as unknown as V2ActorDriver;

    const stdout = new MockWritable();
    const tools = new InMemoryToolRegistry();
    // Input that types one line then EOF, so the loop runs the failing turn
    // then exits cleanly.
    const stdin = new MockReadable();
    const input = new Input(stdin, stdout);
    stdin.feed("test message\n");
    stdin.feed("/quit\n");
    stdin.end();

    await repl({
      actor: driver,
      renderer,
      tools,
      input,
      out: stdout,
      style,
    });

    // cancelStream should have been called as part of the catch block.
    expect(cancelStreamSpy).toHaveBeenCalledOnce();
    // The error message should follow on a new line.
    expect(stdout.full()).toContain("✗ internal: simulated stream interrupt");
  });

  it("works gracefully when the renderer does not implement cancelStream (defensive)", async () => {
    // A renderer-shaped object without cancelStream — should not crash.
    const renderer = {
      update: vi.fn(),
    } as unknown as NarrativeRenderer;

    const driver = {
      runTurn: vi.fn(async () => {
        throw new Error("test error");
      }),
      getRecord: vi.fn(() => [] as TerminalRecord),
      loadRecord: vi.fn(),
      setPersister: vi.fn(),
    } as unknown as V2ActorDriver;

    const stdout = new MockWritable();
    const stdin = new MockReadable();
    const input = new Input(stdin, stdout);
    stdin.feed("msg\n");
    stdin.feed("/quit\n");
    stdin.end();

    // Should NOT throw "cancelStream is not a function".
    await expect(
      repl({
        actor: driver,
        renderer,
        tools: new InMemoryToolRegistry(),
        input,
        out: stdout,
        style,
      }),
    ).resolves.not.toThrow();
  });
});
