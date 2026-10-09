import type { PermissionRequest } from "./types/events.js";

/**
 * The one shortcut automatic review keeps (ADR 0064 amendment 2026-10-10,
 * ADR 0075): a request whose every change is a workspace file the harness
 * keeps for undo runs WITHOUT a review. Everything else that would ask goes
 * to the reviewer — scripts, local executables, deletes, git changes,
 * copies and moves, which workspace trust used to let through unexamined.
 *
 * WHY THIS AND NOT TRUST'S WIDER SET. Trust (ADR 0064) answered every class
 * whose effects stay inside the workspace, never asking whether the user
 * wanted them: `rm -rf src` nobody asked for, or a downloaded `./a.exe`,
 * ran without a card. A review reads the user's request; it costs a model
 * call (about 2 s). An edit the record shows as a diff, which undo can take
 * back, gains nothing from that wait, so it keeps the shortcut.
 *
 * The rule decides `undoable` from the request's own text (the editors
 * always; the bash rule by `writesUndoable`). This check adds the classes
 * as a second, independent gate: a request is covered only when it is both
 * marked and of a write class, so a stray mark on anything else covers
 * nothing. `command_ask_write` alone is NOT enough — it also names
 * `find -exec` and a shell body with a redirect, which run programs.
 */
export const UNDOABLE_WRITE_CODES: ReadonlySet<string> = new Set([
  "edit_file_ask",
  "write_new_file_ask",
  "str_replace_editor_ask",
  "command_ask_write",
  "command_ask_fs",
]);

/**
 * True when the rule marked the request undoable, its risk is a workspace
 * write, and EVERY class it carries is a write class. A request with no
 * class at all is not covered: the shortcut is earned by a classification,
 * never assumed.
 */
export function undoableWrite(request: PermissionRequest): boolean {
  if (request.undoable !== true || request.risk !== "workspace_write")
    return false;
  const codes =
    request.codes !== undefined && request.codes.length > 0
      ? request.codes
      : request.code !== undefined
        ? [request.code]
        : [];
  if (codes.length === 0) return false;
  return codes.every((c) => UNDOABLE_WRITE_CODES.has(c));
}
