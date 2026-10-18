import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveSafePath, type SafePathDenied } from "../path-safety.js";
import { readerPathCandidates } from "./classifier.js";

/**
 * The fs-based half of the reader-argv guard (audit T3.4). The synchronous
 * classifier can only inspect argv TEXT, so a workspace file with an innocent
 * basename that is actually a SYMLINK to `~/.ssh/id_rsa` (or anywhere outside
 * the repo) passed `readerArgvGuard` and was auto-allowed — the OS followed
 * the link and the credential's contents entered the tool result, the
 * evidence store, `.herta/logs`, and the prompt tail. read_file /
 * search_text / glob already realpath every target through
 * resolveSafePath; run_command's readers were the one gap.
 *
 * This mirrors that: for each file-path operand of an allow-listed reader,
 * canonicalize it against the EFFECTIVE cwd and, if it resolves to an
 * existing file whose real target leaves the workspace or names credential
 * material, DENY (matching read_file's hard-deny; ask would be worse — the
 * displayed command `cat notes.txt` HIDES that it really reads id_rsa, so the
 * user can't knowingly approve it).
 *
 * Only EXISTING operands are checked: a grep/find PATTERN or a not-yet-created
 * name doesn't resolve to a file (realpath throws) and is skipped, so no false
 * denials — and a reader can't exfiltrate a file that doesn't exist. The
 * textual absolute/parent/credential-name cases stay in the classifier's
 * `readerArgvGuard` (ask), where the user sees the real target.
 *
 * Returns the first denial, or null when every operand is safe / not a reader.
 * Runs in the permission rule (where deny gates execution) AND at tool
 * execution time (defense-in-depth against a symlink swapped in the window
 * between the permission check and the spawn).
 *
 * Read carve-outs (large-document lab, 2026-08-23): this guard only ever
 * judges the operands of a READ-ONLY command, so it carries the same three
 * read carve-outs `str_replace_editor view` has — attachments (ADR 0033),
 * harness evidence (ADR 0025 slice 2) and the redacted logs (ADR 0036). It
 * did not, and under the minimal contract (the default since 2026-08-17)
 * that was the ONLY reader without them: `sed -n '1,400p'
 * .herta/attachments/<sid>/report.pdf.txt` was hard-denied with "denied
 * segment: .herta", while `str_replace_editor view` of the same path passed.
 * A one-screen document survived on `view` alone; anything longer hit the
 * 16K clip whose note says "grep -n inside the file" — and grep was denied.
 * 板砖 worked around it by `cp`-ing the document into the workspace root
 * (an ask, and a copy of the user's document in their repo — the storage
 * shape ADR 0033 rejected) or by hiding the path in a shell variable (an
 * unrecognised command, so one approval card per chunk). The structural
 * `.herta` denial is the only check the carve-outs skip: the credential
 * basename/directory denylist still runs on the realpath'd target, and
 * every shell output is redacted before it reaches the model or the record.
 */
const READER_CARVE_OUTS = {
  allowAttachmentPaths: true,
  allowHarnessReadPaths: true,
  allowEvidenceExcerptPaths: true,
} as const;
/**
 * A recovery hint for the one denial that reads as a dead end (live vision
 * probe, 2026-08-27).
 *
 * `.herta/` holds settings, project memory and every transcript, so listing
 * it stays denied — but the model's orientation reflex is `ls`/`find` over
 * the directory it was pointed at, and a bare "denied segment: .herta" told
 * it the attachments were unreachable. In two of three live briefs it then
 * gave up without ever opening the file it had been handed the path to.
 *
 * The carve-out it needed was already there: `.herta/attachments/<session>/`
 * and below IS readable, by path. This says so, at the exact moment the
 * model is deciding whether to give up. The GUARD is unchanged — an allow is
 * still earned, not widened (ADR 0045's lesson); only the message improves.
 */
function hintFor(candidate: string, code: string): string {
  if (code !== "path_denied") return "";
  const normalized = candidate.replace(/\\/g, "/");
  if (!/(^|\/)\.herta(\/|$)/.test(normalized)) return "";
  return " (listing .herta is denied; an attachment under .herta/attachments/<session>/, or a page web_fetch saved under .herta/web/, is readable directly by its full path)";
}

export async function checkReaderArgvPaths(
  workspaceRoot: string,
  effectiveCwd: string,
  argv: readonly string[],
): Promise<SafePathDenied | null> {
  const candidates = readerPathCandidates(argv);
  if (candidates === null) return null;

  for (const cand of candidates) {
    // resolve() (not join) so a Windows DRIVE-RELATIVE operand like `E:.env`
    // canonicalizes the way the OS actually opens it — against drive E's cwd
    // (the workspace) — instead of the literal `E:\HERTA\E:.env` a naive join
    // produces (which realpaths to ENOENT and was silently skipped, leaking a
    // workspace credential; audit T3.4 review). resolve() also subsumes the
    // genuinely-absolute case.
    const abs = resolve(effectiveCwd, cand);
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      // Nonexistent operand (pattern / missing file): nothing to canonicalize
      // and nothing a reader can leak. Skip.
      continue;
    }
    // `real` is an existing canonical path; resolveSafePath re-realpaths it
    // (idempotent) and applies the SAME workspace-prefix + credential
    // denylist that guards read_file, inheriting its Windows case handling.
    const r = await resolveSafePath(workspaceRoot, real, READER_CARVE_OUTS);
    if (!r.ok) {
      return {
        ok: false,
        code: r.code,
        message: `read-only command targets ${cand} → ${r.message}${hintFor(cand, r.code)}`,
      };
    }
  }
  return null;
}
