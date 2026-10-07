import { describe, expect, it } from "vitest";
import { undoNoteBody } from "./undo-note.js";

const everything = {
  files: [
    { path: "src/parser.ts", result: "restored" as const },
    { path: "src/lexer.ts", result: "restored" as const },
    { path: "src/tokens.ts", result: "deleted" as const },
    { path: "src/same.ts", result: "unchanged" as const },
    { path: "README.md", result: "changed_since" as const },
    { path: "big.bin", result: "not_kept" as const },
    { path: "../out.ts", result: "outside_workspace" as const },
    { path: "locked.ts", result: "failed" as const },
  ],
  commands: ["package-lock.json"],
  commandsUnknown: false,
  incomplete: true,
};

describe("the → 系统 line an undo leaves in the record (ADR 0074 §4)", () => {
  it("zh: what came back, then everything still changed and why — nothing already as it was", () => {
    expect(undoNoteBody(everything, "zh")).toBe(
      "已撤销本轮板砖的文件改动：已还原 src/parser.ts、src/lexer.ts；已删除 src/tokens.ts（本轮新建）；README.md 此后已修改，未还原；big.bin 无原内容备份，未还原；../out.ts 不在工作区内，未还原；locked.ts 写回失败，未还原；package-lock.json 由命令修改，未还原。",
    );
  });

  it("en: the same, with 板砖 kept as the record keeps it", () => {
    expect(undoNoteBody(everything, "en")).toBe(
      "Undid 板砖's file changes from this turn: restored src/parser.ts, src/lexer.ts; deleted src/tokens.ts (created this turn); README.md modified since, not restored; big.bin had no backup kept, not restored; ../out.ts outside the workspace, not restored; locked.ts could not be written back, not restored; package-lock.json modified by a command, not restored.",
    );
  });

  it("nothing came back: it says so, and still names what is changed", () => {
    expect(
      undoNoteBody(
        {
          files: [{ path: "a.ts", result: "changed_since" }],
          commands: [],
          commandsUnknown: false,
          incomplete: false,
        },
        "zh",
      ),
    ).toBe(
      "已撤销本轮板砖的文件改动：无可还原的文件；a.ts 此后已修改，未还原。",
    );
  });

  it("commands whose changes could not be read are owned up to", () => {
    const r = {
      files: [{ path: "a.ts", result: "restored" as const }],
      commands: [],
      commandsUnknown: true,
      incomplete: false,
    };
    expect(undoNoteBody(r, "zh")).toBe(
      "已撤销本轮板砖的文件改动：已还原 a.ts；本轮执行过命令，其改动（如有）未还原。",
    );
    expect(undoNoteBody(r, "en")).toBe(
      "Undid 板砖's file changes from this turn: restored a.ts; commands ran this turn; any changes they made were not restored.",
    );
  });
});
