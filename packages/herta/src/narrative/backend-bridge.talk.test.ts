import {
  type AgentEvent,
  type AgentExecutionReport,
  type CodingAgentRuntime,
  type HertaBlock,
  type HertaToAgentBrief,
  InMemoryEventBus,
  publishWithLayer,
  type TerminalRecord,
} from "@herta/core";
import { describe, expect, it, vi } from "vitest";
import { type AnswerFirer, invokeBanzhuanBridge } from "./backend-bridge.js";
import { BeatPolicy } from "./beat-policy.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const report = (taskId: string): AgentExecutionReport => ({
  taskId,
  status: "completed",
  changedFiles: [],
  evidence: [],
  tests: [],
  permissions: [],
  residualRisks: [],
});

const read = (bus: InMemoryEventBus<AgentEvent>, id: string, file: string) =>
  publishWithLayer(bus, "backend", {
    type: "tool.call.started",
    id,
    tool: "read_file",
    inputSummary: file,
  } as never);

const talk = (bus: InMemoryEventBus<AgentEvent>, id: string, text: string) =>
  bus.publish({ type: "user.talk", layer: "actor", id, text });

const answerBlock = (text: string, steered?: string): HertaBlock => ({
  kind: "herta",
  surface: "speech",
  text,
  duringRun: true,
  ...(steered !== undefined ? { steered } : {}),
});

/** A run whose script publishes its events, awaiting between them. */
function runtimeOf(
  script: (bus: InMemoryEventBus<AgentEvent>) => Promise<void>,
  bus: InMemoryEventBus<AgentEvent>,
): CodingAgentRuntime {
  return {
    runBrief: async (brief: HertaToAgentBrief) => {
      publishWithLayer(bus, "backend", {
        type: "turn.started",
        userText: "task",
      } as never);
      await script(bus);
      return report(brief.taskId);
    },
  } as unknown as CodingAgentRuntime;
}

const shape = (out: TerminalRecord): string[] =>
  out.map((b) =>
    b.kind === "user"
      ? `user${b.duringRun === true ? "(talk)" : ""}:${b.text}`
      : b.kind === "herta"
        ? `herta${b.duringRun === true ? "(answer)" : ""}:${b.text}`
        : b.role !== undefined
          ? b.role
          : `row:${b.body}`,
  );

describe("talk while 板砖 works (ADR 0085 step 3)", () => {
  it("talk enters the record as `duringRun`, she answers it, and none of it reaches 板砖", async () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const steerBackend = vi.fn();
    const answerTalk = vi.fn<AnswerFirer>(async (record) => {
      const last = record[record.length - 1];
      return answerBlock(`答：${last?.kind === "user" ? last.text : "?"}`);
    });
    const out = await invokeBanzhuanBridge([], [], {
      bus,
      runtimeFactory: () =>
        runtimeOf(async (b) => {
          read(b, "c1", "a.ts");
          await tick();
          talk(b, "t1", "周末那个会几点？");
          await tick();
          await tick();
          read(b, "c2", "b.ts");
        }, bus),
      signal: new AbortController().signal,
      answerTalk,
      steerBackend,
    });
    expect(shape(out)).toEqual([
      "row:Reading a.ts",
      "user(talk):周末那个会几点？",
      "herta(answer):答：周末那个会几点？",
      "row:Reading b.ts",
      "done-marker",
    ]);
    expect(answerTalk).toHaveBeenCalledTimes(1);
    expect(steerBackend).not.toHaveBeenCalled();
  });

  it("two messages before she answers get one answer; one that lands while she answers gets the next", async () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    let release: () => void = () => undefined;
    const composing = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const answerTalk: AnswerFirer = async (record) => {
      calls += 1;
      const talks = record.filter(
        (b) => b.kind === "user" && b.duringRun === true,
      ).length;
      if (calls === 1) await composing;
      return answerBlock(`answer ${calls} (${talks} talk)`);
    };
    const out = await invokeBanzhuanBridge([], [], {
      bus,
      runtimeFactory: () =>
        runtimeOf(async (b) => {
          read(b, "c1", "a.ts");
          talk(b, "t1", "one");
          talk(b, "t2", "two");
          await tick();
          await tick();
          // She is composing her first answer now.
          talk(b, "t3", "three");
          read(b, "c2", "b.ts");
          release();
          await tick();
        }, bus),
      signal: new AbortController().signal,
      answerTalk,
    });
    expect(shape(out)).toEqual([
      "row:Reading a.ts",
      "user(talk):one",
      "user(talk):two",
      "herta(answer):answer 1 (2 talk)",
      // Rows that came while she wrote wait for her answer (owner
      // 2026-11-04: "Rows wait, as beats do").
      "user(talk):three",
      "row:Reading b.ts",
      "herta(answer):answer 2 (3 talk)",
      "done-marker",
    ]);
  });

  it("her @板砖 sentence steers the run while it works; once the run has ended it steers nothing", async () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const steerBackend = vi.fn();
    const answerTalk: AnswerFirer = async (_record, _signal, canSteer) =>
      canSteer()
        ? answerBlock("三点。@板砖 先补测试。", "@板砖 先补测试。")
        : answerBlock("三点。");
    await invokeBanzhuanBridge([], [], {
      bus,
      runtimeFactory: () =>
        runtimeOf(async (b) => {
          talk(b, "t1", "几点？");
          await tick();
          await tick();
          read(b, "c1", "a.ts");
        }, bus),
      signal: new AbortController().signal,
      answerTalk,
      steerBackend,
    });
    expect(steerBackend).toHaveBeenCalledWith("@板砖 先补测试。");

    // The run ends while she writes: her answer still lands, before the
    // marker, and nothing is handed to a run that is over.
    const bus2 = new InMemoryEventBus<AgentEvent>();
    const late = vi.fn();
    let release: () => void = () => undefined;
    const composing = new Promise<void>((r) => {
      release = r;
    });
    const out = await invokeBanzhuanBridge([], [], {
      bus: bus2,
      runtimeFactory: () =>
        runtimeOf(async (b) => {
          read(b, "c1", "a.ts");
          talk(b, "t1", "几点？");
          await tick();
          await tick();
          setTimeout(release, 0);
        }, bus2),
      signal: new AbortController().signal,
      answerTalk: async () => {
        await composing;
        return answerBlock("三点。@板砖 先补测试。", "@板砖 先补测试。");
      },
      steerBackend: late,
    });
    expect(shape(out).slice(-2)).toEqual([
      "herta(answer):三点。@板砖 先补测试。",
      "done-marker",
    ]);
    expect(late).not.toHaveBeenCalled();
  });

  it("her answer stands in for the beats ready at that moment: she does not speak twice", async () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const fireBeat = vi.fn(async () => ({
      kind: "herta" as const,
      surface: "speech" as const,
      text: "beat",
    }));
    const out = await invokeBanzhuanBridge([], [], {
      bus,
      runtimeFactory: () =>
        runtimeOf(async (b) => {
          // A failing read stages a beat, and talk lands in the same pass.
          publishWithLayer(b, "backend", {
            type: "tool.call.finished",
            id: "c1",
            tool: "read_file",
            result: {
              ok: false,
              error: { code: "not_found", message: "no a.ts" },
            },
          } as never);
          talk(b, "t1", "怎么了？");
          await tick();
          await tick();
          await tick();
        }, bus),
      signal: new AbortController().signal,
      beatPolicy: new BeatPolicy(),
      fireBeat,
      answerTalk: async () => answerBlock("它找不到 a.ts。"),
    });
    expect(shape(out).filter((s) => s.startsWith("herta"))).toEqual([
      "herta(answer):它找不到 a.ts。",
    ]);
    expect(fireBeat).not.toHaveBeenCalled();
  });

  it("with no answer lane (the CLI) talk is recorded and left for her next completion", async () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const out = await invokeBanzhuanBridge([], [], {
      bus,
      runtimeFactory: () =>
        runtimeOf(async (b) => {
          talk(b, "t1", "在吗？");
          read(b, "c1", "a.ts");
        }, bus),
      signal: new AbortController().signal,
    });
    expect(shape(out)).toEqual([
      "user(talk):在吗？",
      "row:Reading a.ts",
      "done-marker",
    ]);
  });
});
