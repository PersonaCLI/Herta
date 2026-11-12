/**
 * Which rule-deny codes cap a 板砖 run's status (ADR 0047 §2, amended
 * 2026-09-29).
 *
 * Finding 6: a run whose mutations were refused — by the user or by policy —
 * must not report 完成. A rule-deny counts as that refusal unless it is
 * provably not one. The line between them is one question:
 *
 *   would the SAME change, asked correctly, be allowed?
 *
 * Yes → the call itself was wrong, and the model fixes it by calling again:
 * a malformed argument, an edit anchor that does not match, a target in the
 * wrong state, a file not read first. Nothing was refused. The editors plan
 * their edit inside the permission rule, so what would otherwise be a tool
 * failure — which never caps the status — arrives as a rule-deny. A live run
 * (todo lab, 2026-09-29) that finished everything read 部分完成 because its
 * first edit used a relative path (`path_not_absolute`).
 *
 * No → a refusal: policy withheld the change (outside the workspace, a
 * denied path, a blocked command), or the tool cannot make it however it is
 * asked (a file too large or binary to edit, a read that failed). These
 * count, as does every code not listed in either set — unknown stays
 * conservative.
 *
 * The rules that return these codes live in @herta/tools; its
 * `deny-codes.test.ts` fails when a rule returns a code decided in neither
 * set, so a new code is decided here, once.
 */

/** Rule-deny codes that refuse nothing: the call was wrong, not the change. */
export const CALL_ERROR_DENY_CODES: ReadonlySet<string> = new Set([
  // The call's shape.
  "invalid_input",
  "path_not_absolute",
  // The edit's anchor.
  "edit_not_found",
  "edit_ambiguous",
  "insert_out_of_range",
  // The target's state: create an existing file, edit a missing one.
  "not_found",
  "create_exists",
  // Read before edit (CLAUDE.md: stale edits are hard failures — of the
  // call; view again and the same edit is allowed).
  "view_required",
  "stale_view",
  // A page step off this machine (ADR 0083 §7): the page tools work on
  // loopback only, and the refusal names web_fetch for a public page — a
  // step that changes nothing. Undecided, it read a run that finished on
  // localhost as 部分完成 (review 2026-10-30, T2).
  "browser_off_loopback",
]);

/** Rule-deny codes that are refusals. Listed so every code a rule returns is
 *  decided; any code in neither set counts as a refusal too. */
export const REFUSAL_DENY_CODES: ReadonlySet<string> = new Set([
  // Policy.
  "path_outside_workspace",
  "path_denied",
  "command_blocked",
  // The tool cannot make the change, however it is asked.
  "file_too_large",
  "binary_file",
  "read_failed",
]);
