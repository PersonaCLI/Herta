import type { TerminalRecord } from "@herta/core";
import { describe, expect, it } from "vitest";
import { extractUserMessages } from "./backend-user-history.js";

describe("extractUserMessages — what 板砖 is told the user asked", () => {
  it("a 继续 block is the harness's own turn, not a task the user set (review 2026-09-30)", () => {
    const record = [
      { kind: "user", text: "修 parser" },
      { kind: "herta", surface: "speech", text: "好。" },
      { kind: "user", text: "继续", resume: true },
      { kind: "user", text: "再跑一遍测试" },
    ] as unknown as TerminalRecord;
    expect(extractUserMessages(record).messages.map((m) => m.text)).toEqual([
      "修 parser",
      "再跑一遍测试",
    ]);
  });

  describe("what was said during a run is not the next run's task (review 2026-11-05)", () => {
    const texts = (record: TerminalRecord): string[] =>
      extractUserMessages(record).messages.map((m) => m.text);

    it("an aside to Herta and a steer stay in the replay, ahead of the message that opened the turn", () => {
      const record = [
        { kind: "user", text: "登录点了没反应，查一下" },
        { kind: "herta", surface: "speech", text: "@板砖 查一下" },
        { kind: "user", text: "周末那个会几点？", duringRun: true },
        { kind: "herta", surface: "speech", text: "不知道。", duringRun: true },
        { kind: "user", text: "先别动 api 目录", steer: true },
        { kind: "herta", surface: "speech", text: "@板砖 把空指针修掉" },
      ] as unknown as TerminalRecord;
      // The frame calls the newest message the task.
      expect(texts(record)).toEqual([
        "周末那个会几点？",
        "先别动 api 目录",
        "登录点了没反应，查一下",
      ]);
    });

    it("the message that opened the turn takes its attachment with it, and talk takes its own", () => {
      const attachment = (name: string) => ({
        kind: "system",
        label: "系统",
        body: name,
        digest: { kind: "attachment", name, path: `.herta/${name}` },
      });
      const record = [
        { kind: "user", text: "看这份" },
        attachment("spec.md"),
        { kind: "user", text: "顺便问下", duringRun: true },
        attachment("note.md"),
      ] as unknown as TerminalRecord;
      const got = texts(record);
      expect(got[0]).toBe("顺便问下");
      expect(got[1]).toContain("note.md");
      expect(got[2]).toBe("看这份");
      expect(got[3]).toContain("spec.md");
    });

    it("an earlier turn's talk stays where it fell, and a new turn's message is the task", () => {
      const record = [
        { kind: "user", text: "第一件事" },
        { kind: "user", text: "顺便问下", duringRun: true },
        { kind: "user", text: "第二件事" },
      ] as unknown as TerminalRecord;
      expect(texts(record)).toEqual(["第一件事", "顺便问下", "第二件事"]);
    });

    it("with no message that opens a turn, the order stands", () => {
      const record = [
        { kind: "user", text: "一", duringRun: true },
        { kind: "user", text: "二", steer: true },
      ] as unknown as TerminalRecord;
      expect(texts(record)).toEqual(["一", "二"]);
    });
  });
});
