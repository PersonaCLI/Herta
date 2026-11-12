/**
 * `.gitignore`, for the walk that has no ripgrep to ask (review 2026-11-10,
 * second pass).
 *
 * `search_text` uses ripgrep as its finder, and ripgrep honours `.gitignore`.
 * Where no `rg` is installed the JS scanner walked everything but a short
 * list of directory names: 9 221 files in this repository against 2 474
 * tracked. It ran out its 10 seconds in a mid-size repo and reported no
 * match for a pattern that had one. The two engines also disagreed about
 * which files a search covers.
 *
 * This reads the patterns as gitignore(5) gives them: `#` comments, `!` to
 * re-include, a trailing `/` for directories only, a pattern with a slash
 * anchored to its file's directory and one without matching at any depth,
 * `*` and `?` within one name, `[…]` classes, and `**` across names. The
 * last pattern that matches decides, and a deeper file's patterns come
 * after a shallower one's. A directory that is ignored is not entered, so
 * nothing under it can be re-included, as in git.
 *
 * Not read, where ripgrep reads them: a `.gitignore` above the workspace
 * root (the walk never reads outside it), `.git/info/exclude`, the user's
 * global excludes, and `.ignore` / `.rgignore`.
 */

export interface IgnoreRule {
  readonly re: RegExp;
  readonly negate: boolean;
  readonly dirOnly: boolean;
}

/** A file that is not a list of patterns is not read as one. */
export const GITIGNORE_MAX_BYTES = 256 * 1024;
const MAX_RULES = 4_000;

const REGEX_META = /[\\^$.*+?()[\]{}|]/;

/** One name-glob as a regex body: `*` and `?` stay inside a name. */
function segmentBody(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "\\" && i + 1 < glob.length) {
      i += 1;
      const next = glob[i] as string;
      out += REGEX_META.test(next) ? `\\${next}` : next;
    } else if (c === "*") {
      // `a**b` is two stars within one name, which is one.
      while (glob[i + 1] === "*") i += 1;
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) {
        out += "\\[";
        continue;
      }
      let body = glob.slice(i + 1, close);
      const not = body.startsWith("!") || body.startsWith("^");
      if (not) body = body.slice(1);
      out += `[${not ? "^" : ""}${body.replace(/\\/g, "\\\\").replace(/\]/g, "\\]")}]`;
      i = close;
    } else {
      out += REGEX_META.test(c) ? `\\${c}` : c;
    }
  }
  return out;
}

/** A whole pattern, already stripped of `!`, a leading `/` and a trailing
 *  `/`, as a regex body over a slash-separated path. */
function patternBody(pattern: string): string {
  const parts = pattern.split("/");
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    const last = i === parts.length - 1;
    if (part === "**") {
      if (last) {
        // `a/**`: everything inside.
        out += ".*";
      } else {
        // `**/a`, `a/**/b`: zero or more directories.
        out += "(?:.*/)?";
      }
      continue;
    }
    out += segmentBody(part);
    if (!last) out += "/";
  }
  return out;
}

/** The rules of one `.gitignore`, in file order. A line that cannot be read
 *  as a pattern is skipped, as git skips it. */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (rules.length >= MAX_RULES) break;
    if (raw === "" || raw.startsWith("#")) continue;
    // Trailing spaces are not part of the pattern unless escaped.
    let line = raw.replace(/(?<!\\)[ \t]+$/, "");
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.replace(/\/+$/, "");
    }
    if (line === "") continue;
    // A slash at the start or in the middle ties the pattern to this file's
    // directory; without one it matches a name at any depth below.
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (line === "") continue;
    try {
      const body = patternBody(line);
      rules.push({
        re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`),
        negate,
        dirOnly,
      });
    } catch {
      // not a pattern this can read
    }
  }
  return rules;
}

interface Frame {
  /** The directory the rules came from, relative to the workspace root,
   *  slash-separated, with a trailing slash unless it is the root (""). */
  readonly base: string;
  readonly rules: readonly IgnoreRule[];
}

/**
 * The `.gitignore` files that apply at one point of a walk, outermost first.
 * Immutable: `with` returns the stack one directory deeper, so a walk hands
 * each directory its own without undoing anything on the way back up.
 */
export class IgnoreStack {
  static readonly EMPTY = new IgnoreStack([]);

  private constructor(private readonly frames: readonly Frame[]) {}

  /** This stack plus the `.gitignore` text found in directory `dirRel`
   *  ("" for the workspace root). */
  with(dirRel: string, text: string): IgnoreStack {
    const rules = parseGitignore(text);
    if (rules.length === 0) return this;
    const base = dirRel === "" ? "" : `${dirRel.replace(/\/+$/, "")}/`;
    return new IgnoreStack([...this.frames, { base, rules }]);
  }

  /** Whether the entry at workspace-relative `rel` is ignored. */
  ignores(rel: string, isDir: boolean): boolean {
    let ignored = false;
    for (const frame of this.frames) {
      if (!rel.startsWith(frame.base)) continue;
      const within = rel.slice(frame.base.length);
      for (const rule of frame.rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.re.test(within)) ignored = !rule.negate;
      }
    }
    return ignored;
  }
}
