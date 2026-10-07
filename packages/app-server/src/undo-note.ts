import type { UndoFileResult } from "@herta/core";

/**
 * The `→ 系统` line an undo leaves in the record (ADR 0074 §4). Herta reads
 * it at her next turn, so it says what came back AND what is still changed,
 * and why — a skipped file or a command's edit is on disk, and "the edits
 * were undone" alone would let her assume a clean tree. Files already as
 * they were are left out: nothing happened to them. 板砖 stays 板砖 in both
 * languages, as the record keeps it (the display layer aliases it).
 */
export interface UndoNoteInput {
  readonly files: readonly {
    readonly path: string;
    readonly result: UndoFileResult;
  }[];
  readonly commands: readonly string[];
  readonly commandsUnknown: boolean;
  readonly incomplete: boolean;
}

const TEXT = {
  zh: {
    lead: "已撤销本轮板砖的文件改动：",
    none: "无可还原的文件",
    restored: (l: string) => `已还原 ${l}`,
    deleted: (l: string) => `已删除 ${l}（本轮新建）`,
    changed_since: (l: string) => `${l} 此后已修改，未还原`,
    not_kept: (l: string) => `${l} 无原内容备份，未还原`,
    outside_workspace: (l: string) => `${l} 不在工作区内，未还原`,
    failed: (l: string) => `${l} 写回失败，未还原`,
    commands: (l: string) => `${l} 由命令修改，未还原`,
    commandsUnknown: "本轮执行过命令，其改动（如有）未还原",
    join: "、",
    sep: "；",
    end: "。",
  },
  en: {
    lead: "Undid 板砖's file changes from this turn: ",
    none: "no files to restore",
    restored: (l: string) => `restored ${l}`,
    deleted: (l: string) => `deleted ${l} (created this turn)`,
    changed_since: (l: string) => `${l} modified since, not restored`,
    not_kept: (l: string) => `${l} had no backup kept, not restored`,
    outside_workspace: (l: string) =>
      `${l} outside the workspace, not restored`,
    failed: (l: string) => `${l} could not be written back, not restored`,
    commands: (l: string) => `${l} modified by a command, not restored`,
    commandsUnknown:
      "commands ran this turn; any changes they made were not restored",
    join: ", ",
    sep: "; ",
    end: ".",
  },
} as const;

/** The results that say something, in the order the line names them. */
const ORDER = [
  "restored",
  "deleted",
  "changed_since",
  "not_kept",
  "outside_workspace",
  "failed",
] as const satisfies readonly UndoFileResult[];

export function undoNoteBody(r: UndoNoteInput, lang: "zh" | "en"): string {
  const t = TEXT[lang];
  const of = (result: UndoFileResult): string[] =>
    r.files.filter((f) => f.result === result).map((f) => f.path);
  const parts: string[] = [];
  if (of("restored").length === 0 && of("deleted").length === 0) {
    parts.push(t.none);
  }
  for (const result of ORDER) {
    const paths = of(result);
    if (paths.length > 0) parts.push(t[result](paths.join(t.join)));
  }
  if (r.commands.length > 0) parts.push(t.commands(r.commands.join(t.join)));
  else if (r.commandsUnknown) parts.push(t.commandsUnknown);
  return `${t.lead}${parts.join(t.sep)}${t.end}`;
}
