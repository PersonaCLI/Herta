import {
  type AgentEvent,
  type CodingAgentRuntime,
  type CompletionEvent,
  type CompletionProviderAdapter,
  type CompletionRequest,
  type HertaToAgentBrief,
  InMemoryEventBus,
  publishWithLayer,
  type TerminalRecord,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import { type ActorTurnDeps, runActorCompletionTurn } from "./actor-turn.js";
import type { ActorStreamingSink } from "./streaming-sink.js";

// ---------------------------------------------------------------------------
// Helpers for the end-to-end describe blocks below.
// Duplicated here (vs. imported from actor-turn.test.ts) to keep test files
// independent — independence is preferred over DRY across test modules.
// ---------------------------------------------------------------------------

/** Canned thought the default `mkProvider` answers every thought prompt with. */
const AUTO_THOUGHT = "想想看。";

/** The phase-2 thought prompt ends with its forced open tag (a complete open
 *  tag gets a trailing newline in `serializeActorPrompt`). */
function isThoughtPrompt(req: CompletionRequest): boolean {
  return req.prompt.endsWith("（我 想）\n");
}

/**
 * Scripted actor provider. Every turn thinks before it speaks (2026-09-03:
 * the single-phase surface pick is gone), so by default a thought prompt is
 * answered with `AUTO_THOUGHT` WITHOUT consuming a script and `scripts` lists
 * only the speech completions in order. `scriptThoughts: true` opts out:
 * every call consumes the next script, thought prompts included, for tests
 * that assert on the thought text.
 */
function mkProvider(
  scripts: ReadonlyArray<CompletionEvent[]>,
  opts: { scriptThoughts?: boolean } = {},
): {
  provider: CompletionProviderAdapter;
  prompts: string[];
} {
  const prompts: string[] = [];
  let idx = 0;
  const provider: CompletionProviderAdapter = {
    streamCompletion(req: CompletionRequest): AsyncIterable<CompletionEvent> {
      prompts.push(req.prompt);
      let script: CompletionEvent[];
      if (opts.scriptThoughts !== true && isThoughtPrompt(req)) {
        script = [
          { type: "text-delta", text: `${AUTO_THOUGHT}（/我 想）` },
          { type: "finish", reason: "stop" },
        ];
      } else {
        script = scripts[idx] ?? [{ type: "finish", reason: "stop" }];
        idx += 1;
      }
      return (async function* () {
        for (const e of script) yield e;
      })();
    },
  };
  return { provider, prompts };
}

function mkDeps(opts: {
  provider: CompletionProviderAdapter;
  bus?: InMemoryEventBus<AgentEvent>;
  runtimeFactory?: () => CodingAgentRuntime;
}): ActorTurnDeps {
  const bus = opts.bus ?? new InMemoryEventBus<AgentEvent>();
  const noopRuntime: CodingAgentRuntime = {
    runBrief: async (brief: HertaToAgentBrief) =>
      ({
        taskId: brief.taskId,
        status: "completed",
        evidence: [],
        changedFiles: [],
        tests: [],
        permissions: [],
        residualRisks: [],
        nextActions: [],
      }) as never,
  } as unknown as CodingAgentRuntime;
  return {
    provider: opts.provider,
    model: "deepseek-v4-completion",
    staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
    bus,
    runtimeFactory: opts.runtimeFactory ?? (() => noopRuntime),
    signal: new AbortController().signal,
    // Required since 2026-09-03; the neutral mood. No meta-think attachment
    // is passed, so the turn thinks then speaks without a preamble.
    intentState: "默认",
  };
}

function mkSink(): {
  sink: ActorStreamingSink;
  tokens: string[];
  endStreamCalls: number;
  beginCalls: Array<"speech" | "thought">;
} {
  const tokens: string[] = [];
  const beginCalls: Array<"speech" | "thought"> = [];
  let endStreamCalls = 0;
  const sink: ActorStreamingSink = {
    beginHertaStream: (surface) => {
      beginCalls.push(surface);
    },
    streamHertaToken: (t: string) => {
      tokens.push(t);
    },
    endHertaStream: () => {
      endStreamCalls += 1;
    },
    flushBlocks: (_record) => {},
  };
  return {
    sink,
    tokens,
    get endStreamCalls() {
      return endStreamCalls;
    },
    beginCalls,
  } as unknown as {
    sink: ActorStreamingSink;
    tokens: string[];
    endStreamCalls: number;
    beginCalls: Array<"speech" | "thought">;
  };
}

// ---------------------------------------------------------------------------

describe("runActorCompletionTurn — end-to-end (think → speak rhythm)", () => {
  it("thought-then-speech flow: record has both, only speech reaches sink tokens", async () => {
    // Both phases scripted: iteration 1 is the thought (prompt forces
    // `（我 想）`), iteration 2 the forced speech (prompt forces `（我 说）`).
    const { provider } = mkProvider(
      [
        [
          { type: "text-delta", text: "板砖按教科书写的。（/我 想）" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text-delta", text: "行了。（/我 说）" },
          { type: "finish", reason: "stop" },
        ],
      ],
      { scriptThoughts: true },
    );
    const sinkBundle = mkSink();
    const deps = mkDeps({ provider });
    const { record } = await runActorCompletionTurn(
      { record: [] as TerminalRecord },
      "在吗",
      { ...deps, sink: sinkBundle.sink },
    );
    expect(record).toEqual([
      { kind: "user", text: "在吗" },
      { kind: "herta", surface: "thought", text: "板砖按教科书写的。" },
      { kind: "herta", surface: "speech", text: "行了。" },
    ]);
    expect(sinkBundle.beginCalls).toEqual(["thought", "speech"]);
    const tokenJoin = sinkBundle.tokens.join("");
    expect(tokenJoin).toContain("行了。");
    expect(tokenJoin).not.toContain("板砖按教科书写的。");
  });

  it("does not leak a dangling close-marker prefix when the stream ends mid-marker", async () => {
    // Regression for record 53e0e3c8: the model began the speech close
    // marker （/我 说） but the completion stream finished after only the
    // 2-char prefix （/ had streamed. The orphaned （/ must not survive into
    // the committed block (nor reach the sink). The thought phase is
    // auto-answered; the cut is exercised on the forced speech.
    const { provider } = mkProvider([
      [
        { type: "text-delta", text: "补上？\n（/" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const sinkBundle = mkSink();
    const deps = mkDeps({ provider });
    const { record } = await runActorCompletionTurn(
      { record: [] as TerminalRecord },
      "在吗",
      { ...deps, sink: sinkBundle.sink },
    );
    const speech = record.find(
      (b) =>
        b.kind === "herta" && (b as { surface: string }).surface === "speech",
    ) as { text: string } | undefined;
    expect(speech?.text).toBe("补上？");
    expect(speech?.text ?? "").not.toContain("（/");
    expect(sinkBundle.tokens.join("")).not.toContain("（/");
  });

  it("preserves prose ending in （ right before a complete close marker (no over-strip)", async () => {
    // Guard against over-stripping: the model wrote a lone full-width （ as
    // prose, immediately followed by the COMPLETE close marker （/我 说）. The
    // （ was already streamed to the user, so it must survive into the
    // committed block — the dangling-prefix strip must stop at the complete
    // marker's boundary, not eat the prose before it.
    const { provider } = mkProvider([
      [
        { type: "text-delta", text: "开始（（/我 说）" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const deps = mkDeps({ provider });
    const { record } = await runActorCompletionTurn(
      { record: [] as TerminalRecord },
      "在吗",
      deps,
    );
    const speech = record.find(
      (b) =>
        b.kind === "herta" && (b as { surface: string }).surface === "speech",
    ) as { text: string } | undefined;
    expect(speech?.text).toBe("开始（");
  });

  it("user @板砖 pre-empt: backend events appear in record before Herta's commentary speech", async () => {
    const { provider } = mkProvider([
      [
        { type: "text-delta", text: "完事，没意外。（/我 说）" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const bus = new InMemoryEventBus<AgentEvent>();
    const runtime: CodingAgentRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => {
        publishWithLayer(bus, "backend", {
          type: "tool.call.started",
          id: "t1",
          tool: "read_file",
          inputSummary: "foo.ts",
        });
        return {
          taskId: brief.taskId,
          status: "completed",
          evidence: [],
          changedFiles: [],
          tests: [],
          permissions: [],
          residualRisks: [],
          nextActions: [],
        } as never;
      },
    } as unknown as CodingAgentRuntime;
    const deps = mkDeps({
      provider,
      bus,
      runtimeFactory: () => runtime,
    });
    const { record } = await runActorCompletionTurn(
      { record: [] as TerminalRecord },
      "@板砖 看一下 foo.ts",
      deps,
    );
    // Expected order: user, system(差分协处理器:Reading), then Herta's
    // commentary — the pre-empt dispatch runs before any completion, so both
    // her thought and the speech that follows it land AFTER the projection.
    expect(record[0]?.kind).toBe("user");
    const sysIdx = record.findIndex((b) => b.kind === "system");
    const firstHertaIdx = record.findIndex((b) => b.kind === "herta");
    const speechIdx = record.findIndex(
      (b) => b.kind === "herta" && b.surface === "speech",
    );
    expect(sysIdx).toBeGreaterThan(-1);
    expect(firstHertaIdx).toBeGreaterThan(sysIdx);
    expect(speechIdx).toBeGreaterThan(firstHertaIdx);
    expect(record[speechIdx]).toEqual({
      kind: "herta",
      surface: "speech",
      text: "完事，没意外。",
    });
  });
});

describe("runActorCompletionTurn — Slice 13 end-to-end (mood routing)", () => {
  it("always-think: phase 2 injects meta-think per surface; committed blocks contain no meta-think text", async () => {
    // With always-think: iteration 1 = thought (THINK_TXT injected in prompt),
    // iteration 2 = forced-speech (SPEAK_TXT injected in prompt).
    // Neither committed block should contain the meta-think text.
    const { provider } = mkProvider(
      [
        [
          { type: "text-delta", text: "考虑了。（/我 想）" },
          { type: "finish", reason: "stop" },
        ],
        [
          { type: "text-delta", text: "在。（/我 说）" },
          { type: "finish", reason: "stop" },
        ],
      ],
      { scriptThoughts: true },
    );
    const corpus = {
      preThink: {
        默认: "THINK_TXT",
        被烦版: "",
        教学版: "",
        被戳穿版: "",
        任务部署版: "",
        板砖代答版: "",
        被顶嘴版: "",
      },
      preSpeak: {
        默认: "SPEAK_TXT",
        被烦版: "",
        教学版: "",
        被戳穿版: "",
        任务部署版: "",
        板砖代答版: "",
        被顶嘴版: "",
      },
    };
    const sinkBundle = mkSink();
    const deps = mkDeps({ provider });
    const { record } = await runActorCompletionTurn(
      { record: [] as TerminalRecord },
      "在吗",
      {
        ...deps,
        intentState: "默认",
        attachedMetaThink: {
          state: "默认",
          beforeThinkIndex: 1, // user at 0, thought at 1
          beforeSpeakIndex: 2, // speak at 2 (after thought)
          preThinkText: corpus.preThink.默认!,
          preSpeakText: corpus.preSpeak.默认!,
        },
        sink: sinkBundle.sink,
      },
    );
    expect(record).toHaveLength(3); // user, thought, speech
    expect(record[2]).toEqual({
      kind: "herta",
      surface: "speech",
      text: "在。",
    });
    // Sink saw speech body only, NOT the meta-think text.
    const joined = sinkBundle.tokens.join("");
    expect(joined).toContain("在。");
    expect(joined).not.toContain("SPEAK_TXT");
    expect(joined).not.toContain("THINK_TXT");
  });

  it("salvages a beat abandoned mid-stream: sink begin/end balanced, emitted text committed (hang-audit M1)", async () => {
    // The beat's provider stream emits a partial reaction, then dies
    // (provider error / interrupt). Pre-fix, `beginHertaStream` had been
    // called with no balancing `endHertaStream` — streamingSurface leaked
    // across turns and later flushes rendered at the wrong offset. Now the
    // beat firer settles the sink and commits exactly the text already on
    // screen as the beat block (screen == record).
    const bus = new InMemoryEventBus<AgentEvent>();
    const runtime: CodingAgentRuntime = {
      runBrief: async (brief: HertaToAgentBrief) => {
        publishWithLayer(bus, "backend", {
          type: "patch.preview",
          diff: "+x",
          files: ["a.ts"],
        });
        // Keep the brief pending long enough for the drain to fire the beat.
        await new Promise<void>((r) => setTimeout(r, 50));
        return {
          taskId: brief.taskId,
          status: "completed",
          evidence: [],
          changedFiles: [],
          tests: [],
          permissions: [],
          residualRisks: [],
          nextActions: [],
        } as never;
      },
    } as unknown as CodingAgentRuntime;

    let call = 0;
    const provider: CompletionProviderAdapter = {
      streamCompletion(req: CompletionRequest): AsyncIterable<CompletionEvent> {
        call += 1;
        const n = call;
        const thoughtPrompt = isThoughtPrompt(req);
        return (async function* () {
          if (n === 1) {
            // The beat (fires first — user-preempt dispatch runs before any
            // primary completion): partial text, then a mid-stream death.
            yield { type: "text-delta", text: "诶，这个 diff——" } as const;
            throw new Error("provider died mid-beat");
          }
          if (thoughtPrompt) {
            // The primary turn's thought phase after the bridge returns.
            yield {
              type: "text-delta",
              text: `${AUTO_THOUGHT}（/我 想）`,
            } as const;
            yield { type: "finish", reason: "stop" } as const;
            return;
          }
          // The forced speech after the thought.
          yield { type: "text-delta", text: "收尾。（/我 说）" } as const;
          yield { type: "finish", reason: "stop" } as const;
        })();
      },
    };

    const sinkBundle = mkSink();
    const deps = mkDeps({
      provider,
      bus,
      runtimeFactory: () => runtime,
    });
    // User-typed @板砖 pre-empt: dispatches the bridge (and its beat) before
    // the primary completion call.
    const { record } = await runActorCompletionTurn(
      { record: [] as TerminalRecord },
      "@板砖 修一下 a.ts",
      { ...deps, sink: sinkBundle.sink },
    );

    // Sink balanced: beat (salvaged) + the primary turn's thought + its
    // forced speech = 3 begins, 3 ends.
    expect(sinkBundle.beginCalls).toEqual(["speech", "thought", "speech"]);
    expect(sinkBundle.endStreamCalls).toBe(3);
    // The emitted portion of the dead beat was committed as a herta block.
    const beatBlock = record.find(
      (b) => b.kind === "herta" && b.text.includes("诶，这个 diff"),
    );
    expect(beatBlock).toBeDefined();
    // The turn still ran to completion: done-marker + primary speech present.
    expect(
      record.some(
        (b) =>
          b.kind === "system" &&
          (b as { role?: string }).role === "done-marker",
      ),
    ).toBe(true);
    expect(
      record.some((b) => b.kind === "herta" && b.text.includes("收尾")),
    ).toBe(true);
  });
});
