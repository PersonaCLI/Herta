/**
 * Which tools write a file and which run a command, said once (review
 * 2026-11-10).
 *
 * The runtime (what counts as a changed file, what carries an exit code),
 * the journal's seal (what a cut-off call may have left behind) and the
 * approval cache (which tools share the "writes for this task" consent)
 * each kept their own copy of these names. A tool added had to be added to
 * every copy, and a copy that was missed did not fail: the tool's writes
 * just stopped being counted there.
 *
 * Two pairs, because two questions (ADR 0086):
 *
 * - What 板砖 HAS: `bash` and `str_replace_editor` (ADR 0040). The runtime
 *   and the approval cache ask this.
 * - What a run journal ON DISK may name: those, and the standard set's
 *   `run_command`, `edit_file` and `write_new_file`. That set is deleted,
 *   but a journal written on it is still sealed, and a cut-off `edit_file`
 *   has to read as a write that may have landed, not as a read. Only the
 *   seal asks this.
 *
 * The editor is a writing tool by name; whether one CALL of it wrote (a
 * `view` does not) is for its caller to read off the call.
 */

/** The shell-shaped tool: its result data is a command's (exit code,
 *  output), and its input names a command. */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set(["bash"]);

/** The file-writing tool: its result data carries a path and a diff. */
export const WRITING_TOOLS: ReadonlySet<string> = new Set([
  "str_replace_editor",
]);

/** `COMMAND_TOOLS`, and the command tool a journal from the standard set
 *  names. For the journal's seal only. */
export const JOURNAL_COMMAND_TOOLS: ReadonlySet<string> = new Set([
  ...COMMAND_TOOLS,
  "run_command",
]);

/** `WRITING_TOOLS`, and the writing tools a journal from the standard set
 *  names. For the journal's seal only. */
export const JOURNAL_WRITING_TOOLS: ReadonlySet<string> = new Set([
  ...WRITING_TOOLS,
  "edit_file",
  "write_new_file",
]);
