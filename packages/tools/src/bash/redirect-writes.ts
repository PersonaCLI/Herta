import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { relative as relativePath } from "node:path";
import type { RedirectWriteSummary, ToolCallUndo } from "@herta/core";
import { computeUnifiedDiff } from "../edit-file/engine.js";
import { resolveSafePath } from "../path-safety.js";
import { splitShellSegments } from "../run-command/classifier.js";
import {
  countDiffLines,
  MAX_FILE_BYTES,
} from "../str-replace-editor/engine.js";
import { heredocBodiesInert, withoutHeredocOpeners } from "./heredoc-write.js";
import {
  classifyShellCommandDetailed,
  normalizeFdRedirects,
  resolveWorkspacePath,
  type ShellClassifyOpts,
  stripHeredocBodies,
  tokenize,
} from "./shell-classifier.js";

/**
 * The files a shell line writes through its own redirections, kept for undo
 * (ADR 0074 amendment, 2026-10-08).
 *
 * 板砖 on the `bash` contract writes files with the shell, never through an
 * editor — `cat > f <<'EOF' … EOF` for a file, `printf '…' > f` for a line
 * or two — so the undo store saw none of its work and the 撤销 chip never
 * came. Every `> f`, `>> f` and `tee [-a] f` names its target in the text:
 * the harness reads what is there before the line runs (the editors'
 * "before") and what landed after it. What is captured is a FACT about that
 * path — these bytes before, this hash after — not a claim about what the
 * command did, so a body the shell expanded, a program's output, or a write
 * that never happened is told truly; the three-way restore does the rest.
 */

/** A redirection's target as it was before the line ran. */
export interface RedirectTarget {
  /** Workspace-relative, as the editors report it. */
  readonly relative: string;
  /** The scan's spelling of it (what `writesAccounted` matches). */
  readonly native: string;
  /** The path the editors key the undo store by (`resolveSafePath`). */
  readonly resolved: string;
  /** Its bytes before the line; null when it did not exist. */
  readonly before: Buffer | null;
}

/** One simple command of the line, read for what it writes. */
interface WriteSegment {
  /** Its text, heredoc operators blanked. */
  readonly text: string;
  /** The program, by its file name (`/usr/bin/tee` → `tee`). */
  readonly program: string;
  readonly words: readonly string[];
  /** The workspace files it writes, by redirection or as `tee`'s operands. */
  readonly targets: readonly { native: string; relative: string }[];
  /** Every file it writes is among `targets` (or is `/dev/null`): none is
   *  a variable, a pattern, or somewhere outside the workspace. */
  readonly complete: boolean;
  /** It writes at all. */
  readonly writes: boolean;
}

/** Where output goes to be dropped or shown, not kept. */
const DISCARD: ReadonlySet<string> = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
]);

/** The line's simple commands, heredoc bodies left out. Pure. */
function segmentsOf(command: string, opts: ShellClassifyOpts): WriteSegment[] {
  const out: WriteSegment[] = [];
  for (const raw of splitShellSegments(
    normalizeFdRedirects(stripHeredocBodies(command)),
  )) {
    const text = withoutHeredocOpeners(raw).trim();
    if (text.length === 0) continue;
    const { words, redirects } = tokenize(text);
    const program = words[0]?.split(/[\\/]/).pop() ?? "";
    const named: string[] = [];
    let complete = true;
    for (const r of redirects) {
      if (r.kind !== "out") continue;
      if (r.glob === true) complete = false;
      else named.push(r.target);
    }
    if (program === "tee") {
      named.push(...words.slice(1).filter((w) => !w.startsWith("-")));
    }
    const targets: { native: string; relative: string }[] = [];
    for (const name of named) {
      if (DISCARD.has(name)) continue;
      const at = resolveWorkspacePath(name, opts);
      // A variable, a substitution, `~`, a path outside the workspace: a
      // write this scan does not hold.
      if (at === null) complete = false;
      else targets.push(at);
    }
    out.push({
      text,
      program,
      words,
      targets,
      complete,
      writes: named.length > 0,
    });
  }
  return out;
}

const sha256 = (b: Buffer): string =>
  createHash("sha256").update(b).digest("hex");

const looksBinary = (b: Buffer): boolean =>
  b.subarray(0, Math.min(4096, b.length)).includes(0);

/**
 * Read the targets of the line's redirections before it runs. A target the
 * editors could not write is not one: outside the workspace, Herta's own
 * state, a directory, a binary file or one past their size bound. Never
 * throws.
 */
export async function readRedirectTargets(
  command: string,
  opts: ShellClassifyOpts,
): Promise<RedirectTarget[]> {
  const out: RedirectTarget[] = [];
  const seen = new Set<string>();
  for (const seg of segmentsOf(command, opts)) {
    for (const t of seg.targets) {
      const safe = await resolveSafePath(opts.workspaceRoot, t.native, {
        mutation: true,
      }).catch(() => null);
      if (safe === null || !safe.ok || seen.has(safe.resolved)) continue;
      seen.add(safe.resolved);
      let before: Buffer | null = null;
      try {
        const info = await stat(safe.resolved);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
        before = await readFile(safe.resolved);
        if (looksBinary(before)) continue;
      } catch (err) {
        // Absent: the line creates it. Anything else: not readable, so
        // nothing could be put back.
        if ((err as { code?: string }).code !== "ENOENT") continue;
        before = null;
      }
      out.push({
        relative: safe.relative,
        native: t.native,
        resolved: safe.resolved,
        before,
      });
    }
  }
  return out;
}

/**
 * After the line: each target whose bytes changed is handed to the undo
 * store with what it replaced and the hash it now has, and returned for the
 * run's report. A target that did not change (the line failed first, or
 * wrote the same bytes) or that is gone (something else removed it) is no
 * write. Never throws; `undo` never rejects.
 */
export async function settleRedirectTargets(
  targets: readonly RedirectTarget[],
  undo: ToolCallUndo | undefined,
): Promise<RedirectWriteSummary[]> {
  const out: RedirectWriteSummary[] = [];
  for (const t of targets) {
    let after: Buffer;
    try {
      after = await readFile(t.resolved);
    } catch {
      continue;
    }
    if (t.before !== null && after.equals(t.before)) continue;
    await undo?.captureWrite({
      path: t.resolved,
      before: t.before,
      after: sha256(after),
    });
    let added = 0;
    let removed = 0;
    if (after.length <= MAX_FILE_BYTES && !looksBinary(after)) {
      const diff = computeUnifiedDiff(
        t.before?.toString("utf-8") ?? "",
        after.toString("utf-8"),
        t.relative,
      );
      added = countDiffLines(diff, "+");
      removed = countDiffLines(diff, "-");
    }
    out.push({
      relPath: t.relative,
      created: t.before === null,
      added,
      removed,
    });
  }
  return out;
}

/** Programs that only print: with their output sent to a captured file,
 *  that file is all they change. */
const PRINTERS: ReadonlySet<string> = new Set(["cat", "printf", "echo", "tee"]);

/**
 * Whether the files the line's redirections write are ALL it can change:
 * every writing part is a printer (`cat`, `printf`, `echo`, `tee`) whose
 * targets were read, with no command substitution and no heredoc body that
 * runs one; every other part is `allow`-class (a read, a test), `mkdir -p`
 * inside the workspace, or the model's `cd` to where the shell already is.
 * Undo then has nothing unknown to name for the line. Conservative: any
 * part it cannot follow says no.
 */
export function writesAccounted(
  command: string,
  opts: ShellClassifyOpts,
  targets: readonly RedirectTarget[],
): boolean {
  return targets.length > 0 && heldParts(command, opts, targets) !== null;
}

/**
 * Whether everything the line changes is held (ADR 0064 amendment,
 * 2026-10-10): the files its printers write, read before it runs
 * (`writesAccounted`), and folders `mkdir -p` makes inside the workspace —
 * at least one of the two, and nothing else. Such a line runs without a
 * review when automatic review is on: undo can put back every file it
 * touches, and a new folder loses nothing.
 */
export function writesUndoable(
  command: string,
  opts: ShellClassifyOpts,
  targets: readonly RedirectTarget[],
): boolean {
  const held = heldParts(command, opts, targets);
  return held !== null && held > 0;
}

/** The number of parts that write or make a folder when every part of the
 *  line is held (see `writesAccounted`), else null. */
function heldParts(
  command: string,
  opts: ShellClassifyOpts,
  targets: readonly RedirectTarget[],
): number | null {
  if (!heredocBodiesInert(command, opts)) return null;
  const read = new Set(targets.map((t) => t.native));
  const cwd = opts.cwd ?? opts.workspaceRoot;
  const rest: string[] = [];
  let changes = 0;
  for (const seg of segmentsOf(command, opts)) {
    const { program, words } = seg;
    if (seg.writes) {
      if (!PRINTERS.has(program) || !seg.complete) return null;
      if (/\$\(|`/.test(seg.text)) return null;
      if (!seg.targets.every((t) => read.has(t.native))) return null;
      // Output only dropped (`> /dev/null`) changes nothing.
      if (seg.targets.length > 0) changes += 1;
      continue;
    }
    if (program === "cd" || program === "pushd") {
      // Only the habit `cd <where the shell is> &&`: anywhere else, the
      // scan resolved the targets against the wrong folder.
      const to =
        words.length === 2
          ? resolveWorkspacePath(words[1] as string, opts)
          : null;
      if (to === null || relativePath(cwd, to.native) !== "") return null;
      continue;
    }
    if (program === "mkdir") {
      const args = words.slice(1);
      const dirs = args.filter((a) => !a.startsWith("-"));
      const flagsOk = args
        .filter((a) => a.startsWith("-"))
        .every((a) => a === "-p" || a === "--parents");
      if (!flagsOk || dirs.length === 0) return null;
      for (const d of dirs) {
        const at = resolveWorkspacePath(d, opts);
        if (at === null) return null;
        // Any repository's `.git`, nested ones included, and Herta's state.
        const parts = at.relative.toLowerCase().split("/");
        if (parts.includes(".git") || parts.includes(".herta")) return null;
      }
      changes += 1;
      continue;
    }
    rest.push(seg.text);
  }
  const restAllowed =
    rest.length === 0 ||
    classifyShellCommandDetailed(rest.join("\n"), opts).verdict.kind ===
      "allow";
  return restAllowed ? changes : null;
}
