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
import type { ActorStreamingSink } from "./streaming-sink.js";

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
    tool: "str_replace_editor",
    inputSummary: `view ${file}`,
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
          // The run works on: an answer is for a run still working.
          while (calls < 2) await tick();
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
            tool: "str_replace_editor",
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

  describe("the end of the run (review 2026-11-05)", () => {
    const finished = (bus: InMemoryEventBus<AgentEvent>) =>
      publishWithLayer(bus, "backend", { type: "turn.finished" } as never);

    it("talk still waiting when the run is over goes to her verdict: no answer says 板砖 is working", async () => {
      const bus = new InMemoryEventBus<AgentEvent>();
      const answerTalk = vi.fn<AnswerFirer>(async () =>
        answerBlock("还在跑。"),
      );
      const out = await invokeBanzhuanBridge([], [], {
        bus,
        runtimeFactory: () =>
          runtimeOf(async (b) => {
            read(b, "c1", "a.ts");
            talk(b, "t1", "进展如何？");
            finished(b);
            // The runtime's own closing work, after its loop's last head.
            await tick();
            await tick();
            await tick();
          }, bus),
        signal: new AbortController().signal,
        answerTalk,
      });
      expect(answerTalk).not.toHaveBeenCalled();
      expect(shape(out)).toEqual([
        "row:Reading a.ts",
        "user(talk):进展如何？",
        "done-marker",
      ]);
    });

    it("her @板砖 after the loop's last head is no steer: nothing is handed to a run that is over", async () => {
      const bus = new InMemoryEventBus<AgentEvent>();
      const steerBackend = vi.fn();
      let release: () => void = () => undefined;
      const composing = new Promise<void>((r) => {
        release = r;
      });
      let canSteerAtTheEnd: boolean | undefined;
      await invokeBanzhuanBridge([], [], {
        bus,
        runtimeFactory: () =>
          runtimeOf(async (b) => {
            talk(b, "t1", "让它顺便补个测试");
            await tick();
            await tick();
            finished(b);
            release();
            await tick();
            await tick();
            await tick();
          }, bus),
        signal: new AbortController().signal,
        answerTalk: async (_record, _signal, canSteer) => {
          await composing;
          canSteerAtTheEnd = canSteer();
          return answerBlock(
            "好。@板砖 顺便补个测试。",
            "@板砖 顺便补个测试。",
          );
        },
        steerBackend,
      });
      expect(canSteerAtTheEnd).toBe(false);
      expect(steerBackend).not.toHaveBeenCalled();
    });

    it("a failed loop ends the run the same way", async () => {
      const bus = new InMemoryEventBus<AgentEvent>();
      const answerTalk = vi.fn<AnswerFirer>(async () => answerBlock("答。"));
      await invokeBanzhuanBridge([], [], {
        bus,
        runtimeFactory: () =>
          runtimeOf(async (b) => {
            talk(b, "t1", "怎么了？");
            publishWithLayer(b, "backend", {
              type: "turn.failed",
              error: { kind: "provider", message: "boom" },
            } as never);
            await tick();
            await tick();
          }, bus),
        signal: new AbortController().signal,
        answerTalk,
      });
      expect(answerTalk).not.toHaveBeenCalled();
    });
  });

  describe("Stop while she writes (review 2026-11-05)", () => {
    const steer = (
      bus: InMemoryEventBus<AgentEvent>,
      id: string,
      text: string,
    ) => bus.publish({ type: "user.steer", layer: "actor", id, text });

    /** An answer she is still writing when the turn stops: it ends the way
     *  a completion ends on an abort. */
    function writing() {
      let release: () => void = () => undefined;
      const composing = new Promise<void>((r) => {
        release = r;
      });
      const answerTalk = vi.fn<AnswerFirer>(async () => {
        await composing;
        throw new DOMException("Interrupted", "AbortError");
      });
      return { answerTalk, release };
    }

    it("what queued behind her answer lands, in order, and reaches the sink", async () => {
      const bus = new InMemoryEventBus<AgentEvent>();
      const stop = new AbortController();
      const { answerTalk, release } = writing();
      let flushed: TerminalRecord = [];
      const sink: ActorStreamingSink = {
        beginHertaStream: () => undefined,
        streamHertaToken: () => undefined,
        endHertaStream: () => undefined,
        flushBlocks: (record) => {
          flushed = record;
        },
      };
      const out = await invokeBanzhuanBridge([], [], {
        bus,
        runtimeFactory: () =>
          runtimeOf(async (b) => {
            read(b, "c1", "a.ts");
            talk(b, "t1", "进展如何？");
            await tick();
            await tick();
            // She is writing, and 板砖 goes on.
            publishWithLayer(b, "backend", {
              type: "tool.call.started",
              id: "c2",
              tool: "str_replace_editor",
              inputSummary: "create src/new.ts",
            } as never);
            talk(b, "t2", "对了，控制台也看一眼。");
            steer(b, "s1", "先别动 api 目录");
            read(b, "c3", "b.ts");
            await tick();
            stop.abort(new DOMException("Interrupted", "AbortError"));
            release();
            await tick();
            await tick();
            // The run's closing rows come after the abort, as a command being
            // killed reports them.
            read(b, "c4", "c.ts");
          }, bus),
        signal: stop.signal,
        answerTalk,
        sink,
      });
      const rows = shape(out);
      expect(rows).toEqual([
        "row:Reading a.ts",
        "user(talk):进展如何？",
        "row:Writing src/new.ts",
        "user(talk):对了，控制台也看一眼。",
        "user:先别动 api 目录",
        "row:Reading b.ts",
        "row:Reading c.ts",
        "done-marker",
      ]);
      expect(out[4]).toMatchObject({ kind: "user", steer: true });
      // The persisted copy holds them too, and nothing more was answered.
      expect(flushed.length).toBe(out.length);
      expect(answerTalk).toHaveBeenCalledTimes(1);
    });

    it("a run that finished while she wrote keeps its rows: it does not read 无产出", async () => {
      const bus = new InMemoryEventBus<AgentEvent>();
      const stop = new AbortController();
      const { answerTalk, release } = writing();
      const out = await invokeBanzhuanBridge([], [], {
        bus,
        runtimeFactory: () =>
          runtimeOf(async (b) => {
            talk(b, "t1", "几点？");
            await tick();
            await tick();
            read(b, "c1", "a.ts");
            read(b, "c2", "b.ts");
            publishWithLayer(b, "backend", { type: "turn.finished" } as never);
            await tick();
            stop.abort(new DOMException("Interrupted", "AbortError"));
            release();
          }, bus),
        signal: stop.signal,
        answerTalk,
      });
      expect(shape(out)).toEqual([
        "user(talk):几点？",
        "row:Reading a.ts",
        "row:Reading b.ts",
        "done-marker",
      ]);
    });

    it("a salvaged answer keeps its place, ahead of the rows that waited for it", async () => {
      const bus = new InMemoryEventBus<AgentEvent>();
      const stop = new AbortController();
      let release: () => void = () => undefined;
      const composing = new Promise<void>((r) => {
        release = r;
      });
      const out = await invokeBanzhuanBridge([], [], {
        bus,
        runtimeFactory: () =>
          runtimeOf(async (b) => {
            talk(b, "t1", "几点？");
            await tick();
            await tick();
            read(b, "c1", "a.ts");
            await tick();
            stop.abort(new DOMException("Interrupted", "AbortError"));
            release();
            await tick();
          }, bus),
        signal: stop.signal,
        answerTalk: async () => {
          await composing;
          return answerBlock("三点，不过");
        },
      });
      expect(shape(out)).toEqual([
        "user(talk):几点？",
        "herta(answer):三点，不过",
        "row:Reading a.ts",
        "done-marker",
      ]);
    });

    it("talk that lands after Stop is recorded and nobody writes an answer to it", async () => {
      const bus = new InMemoryEventBus<AgentEvent>();
      const stop = new AbortController();
      const answerTalk = vi.fn<AnswerFirer>(async () => answerBlock("答。"));
      const out = await invokeBanzhuanBridge([], [], {
        bus,
        runtimeFactory: () =>
          runtimeOf(async (b) => {
            read(b, "c1", "a.ts");
            stop.abort(new DOMException("Interrupted", "AbortError"));
            talk(b, "t1", "停了吗？");
            read(b, "c2", "b.ts");
            await tick();
            await tick();
          }, bus),
        signal: stop.signal,
        answerTalk,
      });
      expect(shape(out)).toEqual([
        "row:Reading a.ts",
        "user(talk):停了吗？",
        "row:Reading b.ts",
        "done-marker",
      ]);
      expect(answerTalk).not.toHaveBeenCalled();
    });

    it("no beat fires over a stopped run", async () => {
      const bus = new InMemoryEventBus<AgentEvent>();
      const stop = new AbortController();
      const fireBeat = vi.fn(async () => ({
        kind: "herta" as const,
        surface: "speech" as const,
        text: "beat",
      }));
      await invokeBanzhuanBridge([], [], {
        bus,
        runtimeFactory: () =>
          runtimeOf(async (b) => {
            stop.abort(new DOMException("Interrupted", "AbortError"));
            publishWithLayer(b, "backend", {
              type: "tool.call.finished",
              id: "c1",
              tool: "str_replace_editor",
              result: {
                ok: false,
                error: { code: "not_found", message: "no a.ts" },
              },
            } as never);
            await tick();
            await tick();
            await tick();
          }, bus),
        signal: stop.signal,
        beatPolicy: new BeatPolicy(),
        fireBeat,
      });
      expect(fireBeat).not.toHaveBeenCalled();
    });
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
