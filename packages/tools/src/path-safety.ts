import { existsSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative as relativePath,
  resolve,
  sep,
} from "node:path";
import { isPathInside } from "@herta/core";
import {
  isCredentialBasename,
  isSensitiveSegment,
} from "./credential-denylist.js";

export interface SafePathOk {
  ok: true;
  resolved: string;
  relative: string;
}
export interface SafePathDenied {
  ok: false;
  code: "path_denied" | "path_outside_workspace";
  message: string;
}
export type SafePathResult = SafePathOk | SafePathDenied;

/** Whole-directory-tree denials (audit T3.4): `.git` protects git internals;
 *  `.herta` is harness-owned state (memory, capsules, logs, transcript,
 *  secrets, keys) that no TOOL has any business reading or writing — the
 *  harness writes it via direct node:fs, never through resolveSafePath, so
 *  this denies the tool path without touching legitimate harness writes.
 *  Promoted from the former `.herta/keys` PAIR (which left the rest of
 *  `.herta` tool-writable). Credential basenames + `.ssh`/`.aws`/`.gnupg`
 *  segments are owned by credential-denylist.ts (shared with the run_command
 *  classifier). */
const DENY_SEGMENTS_EXACT = [".git", ".herta"];

/**
 * Harness-evidence prefixes a READ may opt into (ADR 0025 slice 2).
 * `.herta` stays a whole-tree denial for every mutation and for listing;
 * these two subtrees hold ONLY output the harness itself wrote FOR the
 * model, so letting `read_file` (and only `read_file`) follow the "full
 * output at <path>" pointers is re-reading what the model already saw in
 * truncated form, not a new information channel. Everything else under
 * `.herta` (memory, capsules, transcript, keys) stays denied.
 *
 * Redaction is NOT uniform across the two, and the claim that it was is what
 * this paragraph used to say (audit BL17). `run_command` logs ARE
 * secret-redacted at capture time; `.herta/tool-results` is written verbatim,
 * because `read_file` is the one tool whose output never passes through
 * `redactSecrets` — redacting on the way to disk would desync the persisted
 * bytes from what the model already received and break offset/limit re-reads
 * of the same file.
 *
 * That is sound for THIS boundary: the model is re-reading its own prior tool
 * output, so redaction would hide nothing it has not already seen. It stops
 * being sound the moment those bytes reach a surface the model's own context
 * is not already equivalent to. Any future EXPORT path — a bug-report bundle,
 * a support upload, a "share this session" feature — must redact at that
 * boundary, and must not assume the file on disk is already clean.
 *
 * Symlink safety: the check runs on the POST-realpath relative path, so
 * a symlink planted inside `.herta/logs/` pointing at `.herta/keys/…`
 * (or outside the workspace) resolves to its target first and is judged
 * on where it actually lands — the carve-out cannot be used as a hop.
 * The credential-basename check below still applies inside the carve-out
 * (fail-closed for anything key-shaped, whoever wrote it).
 */
const HARNESS_READ_PREFIXES = [".herta/logs/", ".herta/tool-results/"];

/**
 * User-supplied documents the 开拓者 attached to a session (ADR 0033).
 *
 * A THIRD class, deliberately not folded into HARNESS_READ_PREFIXES above,
 * because the two carve-outs answer different questions and one flag meaning
 * both would leave the next reader guessing which applied:
 *
 *   - HARNESS_READ_PREFIXES is for NAVIGATING harness internals — output the
 *     harness wrote for the model, which the model has already seen in
 *     truncated form. `read_file` only. `show_excerpt` is deliberately
 *     excluded (ADR 0027 §5, pinned by a test): presenting harness internals
 *     to the user is not what that tool is for.
 *   - This one is USER CONTENT that merely happens to live under a harness
 *     directory, so it is stored session-scoped and disappears with the
 *     session. Presenting it back to the user is precisely the point — a
 *     document Herta can read but can never quote would answer half the
 *     request — so `show_excerpt` DOES get this one.
 *
 * Same guarantees as the harness carve-out and for the same reasons: judged on
 * the POST-realpath relative path, so a symlink planted in the attachments dir
 * is resolved to its target and judged on where it lands; must be a file
 * strictly beneath the prefix; skips only the structural `.herta` denial, so
 * the credential-basename and credential-directory checks still run over
 * whatever the user handed us.
 */
const ATTACHMENT_READ_PREFIXES = [".herta/attachments/"];

/**
 * Shell-output evidence the model may EXCERPT back to the user (ADR 0036,
 * amending ADR 0027 §5's blanket exclusion — persona E2E 2026-08-11).
 *
 * A FOURTH class, and deliberately `.herta/logs/` ONLY — not
 * `.herta/tool-results/`, though both are readable via the harness carve-out
 * above. The asymmetry is the redaction boundary documented on
 * HARNESS_READ_PREFIXES: `run_command` logs pass `redactSecrets` at capture
 * time, so quoting them to the user surfaces nothing the redactor let
 * through; `tool-results` is written VERBATIM (a deliberate choice — see
 * that comment), so presenting it would turn an unredacted internal file
 * into user-facing text. Quote-grade evidence is the redacted subtree alone.
 *
 * Why amend §5 at all: the E2E showed the one honest way to answer "念给我
 * 听那行输出" is a bounded excerpt of the persisted log — the backend tried
 * exactly that three times and was denied, leaving paraphrase (or worse) as
 * the only path to a receipt the user asked to hear verbatim.
 */
const EVIDENCE_EXCERPT_PREFIXES = [".herta/logs/"];

/**
 * The one harness directory a DISCOVERY tool may enter (persona re-test
 * 2026-08-11 residual).
 *
 * ADR 0036 opened `.herta/logs/` to `read_file`/`show_excerpt` by full path,
 * which is enough only if you already know the filename — and the names are
 * `<uuid>-call_NN_<opaque>.log`. Both re-test arcs watched the backend burn
 * calls guessing (`.herta/logs/*call_00*`, then `.herta/logs/*`, then
 * `.herta` itself → path_denied), and in one of them Herta filled the gap by
 * reciting the log line from memory. A receipt you cannot FIND is barely a
 * receipt.
 *
 * Deliberately its own constant, not a member of the prefix lists above,
 * because it is the only carve-out that must also match the directory ITSELF
 * (`.herta/logs`, no trailing slash) — the others are strictly-beneath file
 * reads. `.herta` stays denied (its siblings are keys, memory, transcripts),
 * and `.herta/tool-results` stays denied for discovery exactly as it is for
 * excerpting: it is written unredacted.
 */
const EVIDENCE_DISCOVERY_ROOT = ".herta/logs";

function isWindows(): boolean {
  return process.platform === "win32";
}

/** Canonicalize a NONEXISTENT path by realpath-ing its deepest existing
 *  ancestor and re-joining the not-yet-created suffix. Bounded by path depth
 *  (dirname reaches a fixed point at the filesystem root); if no ancestor
 *  resolves (detached drive etc.) the raw candidate returns — the prefix
 *  check then fails closed for anything outside the root. */
async function realpathViaExistingAncestor(candidate: string): Promise<string> {
  let dir = dirname(candidate);
  const suffix: string[] = [basename(candidate)];
  while (true) {
    try {
      const real = await realpath(dir);
      return join(real, ...suffix.reverse());
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return candidate; // hit the root; nothing resolved
      suffix.push(basename(dir));
      dir = parent;
    }
  }
}

function caseNormalize(s: string): string {
  return isWindows() ? s.toLowerCase() : s;
}

/** The name Win32 will ACTUALLY open for a path component (audit T3.4 review):
 *  CreateFileW trims trailing dots and spaces, and an NTFS alternate-data-
 *  stream suffix (`name::$DATA`) opens the default stream `name`. Without this
 *  normalization the write path — which re-joins a NONEXISTENT basename
 *  verbatim (write_new_file never realpaths a live inode) — compared `.env `
 *  / `id_rsa.` / `.git ` / `.env::$DATA` against the denylist, all misses, yet
 *  the write landed on the denied target after the OS trimmed the suffix.
 *  POSIX keeps trailing dots/spaces significant and allows colons, so this is
 *  a Windows-only normalization. */
function winCanonicalizeSegment(seg: string): string {
  if (!isWindows()) return seg;
  return seg.replace(/:.*$/, "").replace(/[. ]+$/, "");
}

/** git's own `is_git_directory` shape: a HEAD file beside `objects/` and
 *  `refs/` directories. A directory shaped like this is a bare repo to git —
 *  it will happily run hooks from it. Sync and cheap (three stats), callable
 *  from the sync shell classifier. */
function isGitDirShaped(dir: string): boolean {
  try {
    const head = join(dir, "HEAD");
    return (
      existsSync(head) &&
      statSync(head).isFile() &&
      existsSync(join(dir, "objects")) &&
      statSync(join(dir, "objects")).isDirectory() &&
      existsSync(join(dir, "refs")) &&
      statSync(join(dir, "refs")).isDirectory()
    );
  } catch {
    return false;
  }
}

/** True when `dir` holds an entry named `name` matching `kind` — name folded
 *  the way the filesystem folds it (Windows opens `head` for `HEAD`). */
function hasEntry(dir: string, name: string, kind: "file" | "dir"): boolean {
  try {
    const p = join(dir, name);
    if (!existsSync(p)) return false;
    const st = statSync(p);
    return kind === "file" ? st.isFile() : st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Denial message when WRITING `resolvedAbsolute` would create — or feed —
 * a bare-repo shape outside `.git` (ADR 0049 §6), else null.
 *
 * The vector: git treats any directory holding the `HEAD`+`objects/`+`refs/`
 * triple as a bare repository and runs hooks from it, so a write that
 * completes the triple at the workspace root (or any subdirectory the shell
 * can cd into) plus one ordinary git command is code execution — and the
 * per-segment `.git` denial never fires because no segment is `.git`.
 *
 * Deliberately the PRECISE rule, not a name blocklist: plenty of honest
 * projects have `objects/` or `hooks/` directories, so a write is denied only
 * when it is the FINAL missing piece of the triple or lands in the hooks /
 * internals of a directory that already has the whole shape. Sync fs, bounded
 * by path depth. Exported for the bash redirect guard.
 */
export function gitDirShapeWriteDenial(
  workspaceRoot: string,
  resolvedAbsolute: string,
): string | null {
  if (!isPathInside(workspaceRoot, resolvedAbsolute, { strict: true })) {
    return null;
  }
  const rel = relativePath(workspaceRoot, resolvedAbsolute);
  const raw = rel.split(sep);
  let dir = workspaceRoot;
  for (let i = 0; i < raw.length; i++) {
    const seg = caseNormalize(winCanonicalizeSegment(raw[i] as string));
    const isLast = i === raw.length - 1;
    // Writing HEAD where objects/ and refs/ already sit completes the triple.
    // POSIX git wants the exact spelling `HEAD`; a case-insensitive
    // filesystem opens `head` for it, which caseNormalize mirrors.
    if (isLast && seg === caseNormalize("HEAD")) {
      if (hasEntry(dir, "objects", "dir") && hasEntry(dir, "refs", "dir")) {
        return `writing ${rel} would complete a bare-repository shape (HEAD beside objects/ and refs/) — git would run hooks from this directory`;
      }
    }
    // Writing INTO objects/ or refs/ where HEAD and the other half already
    // exist completes it from the other side.
    if (!isLast && (seg === "objects" || seg === "refs")) {
      const sibling = seg === "objects" ? "refs" : "objects";
      if (hasEntry(dir, "HEAD", "file") && hasEntry(dir, sibling, "dir")) {
        return `writing ${rel} would complete a bare-repository shape at ${dir === workspaceRoot ? "the workspace root" : dir} — git would run hooks from this directory`;
      }
    }
    // Hooks inside an already-complete shape are the payload itself.
    if (!isLast && seg === "hooks" && isGitDirShaped(dir)) {
      return `writing ${rel} targets the hooks of a bare-repository-shaped directory — git runs these as programs`;
    }
    dir = join(dir, raw[i] as string);
  }
  return null;
}

export interface ResolveSafePathOpts {
  /**
   * Allow READ access to the harness-evidence subtrees
   * (`.herta/logs/`, `.herta/tool-results/`). Passed by the READERS only —
   * read_file, `str_replace_editor view`, report_finding's cite check, and
   * the shell reader guard (the operands of an allow-listed `cat`/`sed`/…)
   * — never by any mutating or listing tool. See HARNESS_READ_PREFIXES.
   */
  allowHarnessReadPaths?: boolean;
  /**
   * Allow READ access to session attachments (`.herta/attachments/`).
   * Passed by every reader INCLUDING show_excerpt and the shell reader guard
   * — the asymmetry with show_excerpt NOT getting the flag above is the whole
   * point of there being two. See ATTACHMENT_READ_PREFIXES.
   */
  allowAttachmentPaths?: boolean;
  /**
   * Allow READ access to the secret-redacted shell-output logs
   * (`.herta/logs/` only — never `tool-results/`, which is unredacted).
   * Passed by show_excerpt so a persisted command receipt can be quoted
   * back verbatim. See EVIDENCE_EXCERPT_PREFIXES.
   */
  allowEvidenceExcerptPaths?: boolean;
  /**
   * Allow DISCOVERY (listing / searching) of the redacted log directory
   * itself — `.herta/logs` and anything beneath it, nothing else under
   * `.herta`. Passed by list_files and search_text so the backend can find
   * the receipt it is about to read; without it the log filenames are
   * unguessable. See EVIDENCE_DISCOVERY_ROOT.
   */
  allowEvidenceDiscoveryPaths?: boolean;
  /**
   * The caller intends to WRITE this path (ADR 0049 §6). Passed by the three
   * editors (edit_file, write_new_file, str_replace_editor's writing
   * commands) — never by readers. Adds the bare-repo-shape denial
   * ({@link gitDirShapeWriteDenial}) on top of the structural checks.
   */
  mutation?: boolean;
}

export async function resolveSafePath(
  workspaceRoot: string,
  inputPath: string,
  opts: ResolveSafePathOpts = {},
): Promise<SafePathResult> {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: "empty path",
    };
  }

  const candidate = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(workspaceRoot, inputPath);

  // Canonicalize through symlinks. For a NONEXISTENT target (write_new_file
  // — always, since the file doesn't exist yet) the old fallback used the
  // UNRESOLVED candidate, so a pre-existing directory symlink inside the
  // workspace that points OUTSIDE passed the prefix check and the write
  // landed at the symlink's target outside the repo. Walk up to the deepest
  // EXISTING ancestor, realpath that, and re-join the nonexistent suffix.
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    resolved = await realpathViaExistingAncestor(candidate);
  }

  // The ONE containment rule (core): the platform's own case policy, which
  // is what the win32-only lowercase fold here used to spell by hand.
  if (!isPathInside(workspaceRoot, resolved)) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `resolved path is outside workspace root: ${resolved}`,
    };
  }

  const rel = relativePath(workspaceRoot, resolved).split(sep).join("/");

  if (rel.length > 0) {
    // Compare against the name Win32 will actually open (trailing dots/spaces
    // trimmed, NTFS ADS suffix resolved) — no-op on POSIX.
    const segments = rel.split("/").map(winCanonicalizeSegment);

    // Read carve-outs: judged on the canonicalized, post-realpath segments
    // (so `.herta ` / ADS tricks and symlink hops are already collapsed).
    // Must be a FILE strictly beneath one of the allowed prefixes. Skips only
    // the structural `.herta` denial below — the credential checks still run.
    const canonicalRel = segments.join("/");
    const beneathAny = (prefixes: readonly string[]): boolean =>
      prefixes.some(
        (p) =>
          caseNormalize(canonicalRel).startsWith(caseNormalize(p)) &&
          canonicalRel.length > p.length,
      );
    // Discovery matches the log ROOT itself as well as anything beneath it —
    // the one carve-out that has to, since `list_files .herta/logs` names a
    // directory rather than a file strictly inside one.
    const atOrBeneath = (root: string): boolean => {
      const rel = caseNormalize(canonicalRel);
      const r = caseNormalize(root);
      return rel === r || rel.startsWith(`${r}/`);
    };
    const inReadCarveOut =
      (opts.allowHarnessReadPaths === true &&
        beneathAny(HARNESS_READ_PREFIXES)) ||
      (opts.allowAttachmentPaths === true &&
        beneathAny(ATTACHMENT_READ_PREFIXES)) ||
      (opts.allowEvidenceExcerptPaths === true &&
        beneathAny(EVIDENCE_EXCERPT_PREFIXES)) ||
      (opts.allowEvidenceDiscoveryPaths === true &&
        atOrBeneath(EVIDENCE_DISCOVERY_ROOT));

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i] as string;
      const segLower = caseNormalize(seg);

      // `.git` / `.herta` are STRUCTURAL tree denials kept case-sensitive on
      // POSIX (a repo could hold an unrelated `.GIT` dir, and denying it would
      // break legit work) — caseNormalize only folds on Windows. Either read
      // carve-out (see above) skips exactly this check; credential denials
      // below are never skipped, for either.
      if (!inReadCarveOut) {
        for (const denied of DENY_SEGMENTS_EXACT) {
          if (caseNormalize(denied) === segLower) {
            return {
              ok: false,
              code: "path_denied",
              message: `path contains denied segment: ${denied}`,
            };
          }
        }
      }

      // Credential directories (.ssh/.aws/.gnupg) are CREDENTIAL denials, so
      // matched case-insensitively even on POSIX (fail-closed for secret
      // material — a `.SSH` dir is almost certainly keys regardless of case).
      // The deliberate asymmetry with .git/.herta above is the structural-vs-
      // credential distinction. Owned by the shared denylist.
      if (isSensitiveSegment(seg)) {
        return {
          ok: false,
          code: "path_denied",
          message: `path contains credential directory: ${seg}`,
        };
      }
    }

    const base = segments[segments.length - 1] as string;
    if (isCredentialBasename(base)) {
      return {
        ok: false,
        code: "path_denied",
        message: `denied credential basename: ${base}`,
      };
    }

    // Bare-repo shape guard (ADR 0049 §6) — mutations only. Runs on the
    // post-realpath resolved path, so a symlink hop is already collapsed.
    if (opts.mutation === true) {
      const shapeDenial = gitDirShapeWriteDenial(workspaceRoot, resolved);
      if (shapeDenial !== null) {
        return { ok: false, code: "path_denied", message: shapeDenial };
      }
    }
  }

  return { ok: true, resolved, relative: rel };
}
