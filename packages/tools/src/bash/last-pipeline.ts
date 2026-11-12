/**
 * A shell line as its pipelines and what joins them — for one question: is
 * the exit status the harness holds the test runner's own?
 *
 * A line's exit code is its last command's, and a pipeline's is its last
 * stage's. So `npm test | tee log` exits 0 whatever the tests did, and the
 * harness recorded a red run as passed (real run 2026-11-12, ADR 0040
 * amendment of that date). The shell now reports the statuses of every stage
 * of the last pipeline it ran (`PIPESTATUS`); this says which stage is
 * which, and what ran after the runner.
 *
 * It reads plain lines only, and answers null for anything else. A wrong
 * answer here would pin a test's verdict on the wrong program's exit, so a
 * line with a construct this does not model — a subshell or group, a command
 * substitution, a heredoc, a comment, a control keyword, a background `&`, a
 * line continuation — is not read at all, and the caller decides what an
 * unread line may claim. The caller also checks the stage count against what
 * the shell reported, so the two have to agree before a stage's status is
 * used.
 */
export interface Pipeline {
  /** The stages, left to right, trimmed. One for a plain command. */
  readonly stages: readonly string[];
  /** What joins it to the next pipeline: `&&`, `||`, or `;` for a semicolon
   *  or a line break. Empty on the line's last pipeline. */
  readonly join: "&&" | "||" | ";" | "";
}

/** First words that open a compound command or change how the rest reads. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "time",
  "coproc",
  "!",
  "[[",
]);

interface Scanned {
  readonly stages: string[];
  readonly join: Pipeline["join"];
}

function scan(command: string): Scanned[] | null {
  const text = command;
  // A backslash before a newline joins two lines into one.
  if (/\\\r?\n/.test(text)) return null;

  let quote: '"' | "'" | null = null;
  let current = "";
  let stages: string[] = [];
  const out: Scanned[] = [];
  const closeStage = (): void => {
    stages.push(current);
    current = "";
  };
  const closePipeline = (join: Pipeline["join"]): void => {
    closeStage();
    // A pipeline of nothing (`a;; b`, a blank line, a trailing `;`) is not
    // one: what joined the pipeline before it to the rest still does.
    if (stages.some((s) => s.trim().length > 0)) out.push({ stages, join });
    stages = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    const next = text[i + 1] ?? "";
    const prev = i > 0 ? (text[i - 1] as string) : "";
    if (quote !== null) {
      current += ch;
      if (quote === '"' && ch === "\\") {
        // An escaped character inside double quotes, the quote included.
        current += next;
        i += 1;
        continue;
      }
      if (quote === '"' && (ch === "`" || (ch === "$" && next === "(")))
        return null;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      current += ch + next;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    // Another shell: a substitution, a subshell, a group.
    if (ch === "`" || ch === "(" || ch === ")" || ch === "{" || ch === "}")
      return null;
    if (ch === "$" && next === "(") return null;
    // A heredoc: its body is not commands.
    if (ch === "<" && next === "<") return null;
    // A comment: `#` where a word starts.
    if (ch === "#" && (prev === "" || /\s/.test(prev) || prev === ";"))
      return null;
    if (ch === "|") {
      if (prev === ">") {
        // `>|`, the clobber redirect.
        current += ch;
        continue;
      }
      if (next === "|") {
        closePipeline("||");
        i += 1;
        continue;
      }
      // `|` and `|&` both join two stages of one pipeline.
      closeStage();
      if (next === "&") i += 1;
      continue;
    }
    if (ch === "&") {
      // `2>&1`, `>&2`, `&>file`, `<&3`: a redirection, not a separator.
      if (prev === ">" || prev === "<" || next === ">") {
        current += ch;
        continue;
      }
      if (next === "&") {
        closePipeline("&&");
        i += 1;
        continue;
      }
      // A job sent to the background has no status to report here.
      return null;
    }
    if (ch === ";" || ch === "\n" || ch === "\r") {
      closePipeline(";");
      continue;
    }
    current += ch;
  }
  if (quote !== null) return null;
  closePipeline("");
  if (out.length === 0) return null;
  for (const p of out) {
    const trimmed = p.stages.map((s) => s.trim());
    // An empty stage (`a | | b`, a dangling `|`) is a line bash would refuse.
    if (trimmed.some((s) => s.length === 0)) return null;
    for (const stage of trimmed) {
      const first = stage.split(/\s+/, 1)[0] ?? "";
      if (KEYWORDS.has(first)) return null;
    }
  }
  return out;
}

/** The line's pipelines in order, or null for a line this does not read. */
export function pipelinesOf(command: string): Pipeline[] | null {
  const scanned = scan(command);
  if (scanned === null) return null;
  return scanned.map((p, i) => ({
    stages: p.stages.map((s) => s.trim()),
    // A trailing separator (`npm test;`) joins the last pipeline to nothing.
    join: i === scanned.length - 1 ? "" : p.join,
  }));
}
