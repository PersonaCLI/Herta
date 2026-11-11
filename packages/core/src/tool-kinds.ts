/**
 * Which tools write a file and which run a command, said once (review
 * 2026-11-10).
 *
 * The runtime (what counts as a changed file, what carries an exit code),
 * the journal's seal (what a cut-off call may have left behind) and the
 * approval cache (which tools share the "writes for this task" consent)
 * each kept their own copy of these names. A tool added to one contract had
 * to be added to every copy, and a copy that was missed did not fail: the
 * tool's writes just stopped being counted there.
 *
 * Both contracts are here: `edit_file` / `write_new_file` / `run_command`
 * are the standard one's, `str_replace_editor` / `bash` the minimal one's
 * (ADR 0040). The editor is a writing tool by name; whether one CALL of it
 * wrote (a `view` does not) is for its caller to read off the call.
 */

/** The shell-shaped tools: their result data is a command's (exit code,
 *  output), and their input names a command. */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set([
  "run_command",
  "bash",
]);

/** The file-writing tools: their result data carries a path and a diff. */
export const WRITING_TOOLS: ReadonlySet<string> = new Set([
  "edit_file",
  "write_new_file",
  "str_replace_editor",
]);
