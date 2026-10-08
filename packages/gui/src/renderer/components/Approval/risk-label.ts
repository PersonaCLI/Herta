import type { CommandConsequence, RiskLevel } from "@herta/core";
import type { MessageKey } from "../../i18n/keys.js";

/** Maps a permission risk level to its chrome message key (localized at the
 *  display site — these are user-only approval UI, never in Herta's record). */
export const RISK_KEY: Record<RiskLevel, MessageKey> = {
  workspace_read: "approval.risk.read",
  workspace_write: "approval.risk.write",
  workspace_destructive: "approval.risk.destructive",
  network: "approval.risk.network",
};

/** True for the one risk level that warrants danger styling. */
export function isDangerRisk(risk: RiskLevel): boolean {
  return risk === "workspace_destructive";
}

/** Maps a permission ask-class code to a localized summary key (user bug
 *  2026-07-23: the raw English rule reason — "unrecognized command — review
 *  carefully" — showed verbatim in zh sessions). The reason string stays the
 *  neutral machine contract (D2); an UNRECOGNIZED or absent code falls back
 *  to that raw reason so a future ask class degrades readably, never blank. */
export const REASON_KEY: Record<string, MessageKey> = {
  command_ask_unknown: "approval.reason.commandUnknown",
  command_ask_interpreter: "approval.reason.commandInterpreter",
  command_ask_destructive: "approval.reason.commandDestructive",
  command_ask_network: "approval.reason.commandNetwork",
  command_ask_write: "approval.reason.commandWrite",
  command_ask_reader_path: "approval.reason.commandReaderPath",
  command_ask_recursive_read: "approval.reason.commandRecursiveRead",
  // Split off from `unknown` (permission lab 2026-08-17): the harness knows
  // these programs; the card should say what the line does.
  command_ask_vcs: "approval.reason.commandVcs",
  command_ask_fs: "approval.reason.commandFs",
  command_ask_delete: "approval.reason.commandDelete",
  command_ask_process: "approval.reason.commandProcess",
  command_ask_cwd_escape: "approval.reason.commandCwdEscape",
  command_ask_unresolved: "approval.reason.commandUnresolved",
  // macOS / Linux machine-level changes (platform review 2026-09-23).
  command_ask_system: "approval.reason.commandSystem",
  // A line whose reach into `.herta` the guard cannot bound (review
  // 2026-09-30): never trust-covered, never a rule.
  command_ask_harness_state: "approval.reason.commandHarnessState",
  // Named out of `unknown` (ADR 0075 step 1): a fetch-and-run, and a line
  // whose real command the text does not show.
  command_ask_download_exec: "approval.reason.commandDownloadExec",
  command_ask_opaque: "approval.reason.commandOpaque",
  // Classes named earlier that never got copy, so their raw English reason
  // showed on zh cards (found 2026-10-09 by the source scan in the test).
  command_ask_outside: "approval.reason.commandOutside",
  command_ask_local_exec: "approval.reason.commandLocalExec",
  command_ask_interpreter_inline: "approval.reason.commandInterpreterInline",
  command_ask_script: "approval.reason.commandScript",
  command_ask_env: "approval.reason.commandEnv",
  write_new_file_ask: "approval.reason.writeNewFile",
  edit_file_ask: "approval.reason.editFile",
  // The minimal contract's editor (ADR 0040) — its raw reason ("writes
  // NOTES.md (str_replace, +1/-1 lines)") showed verbatim in zh cards.
  str_replace_editor_ask: "approval.reason.strReplaceEditor",
};

/** Maps a consequence note code (ADR 0049 §5) to its one-sentence card copy.
 *  Display-only, like everything on this card — the tier already enforced.
 *  An unrecognized code renders nothing rather than raw machine text. */
export const CONSEQUENCE_KEY: Record<CommandConsequence, MessageKey> = {
  discards_uncommitted: "approval.consequence.discardsUncommitted",
  deletes_untracked: "approval.consequence.deletesUntracked",
  deletes_stash: "approval.consequence.deletesStash",
  rewrites_local_history: "approval.consequence.rewritesLocalHistory",
  rewrites_remote_history: "approval.consequence.rewritesRemoteHistory",
  concludes_in_progress_operation:
    "approval.consequence.concludesInProgressOperation",
};
