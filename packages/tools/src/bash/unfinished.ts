import { spawn } from "node:child_process";
import { childProcessEnv } from "../child-env.js";

/**
 * Whether a command leaves bash waiting for more input, by bash's own parser
 * (ADR 0040 amendment 2026-11-19). Returns bash's first line about it, or
 * null.
 *
 * The persistent shell reads its commands from stdin and stdin stays open.
 * A quote that is never closed, or a heredoc whose terminator never comes,
 * swallowed the harness's own closing lines, and the call waited out its
 * timeout and lost the shell with every `cd` and variable the brief had set
 * (measured 2026-11-19: `echo "x`, `echo 'x`, `cat <<EOF` with no `EOF`).
 *
 * `bash -n` decides, never a guess: it reads the text to its end and runs
 * nothing. It costs a process start, so it runs only when the text may be
 * unfinished (`mayBeUnfinished`): a heredoc whose terminator line is not
 * there, or a quote still open at the end once closed heredoc bodies are set
 * aside. That filter may fire on text bash reads as whole (`echo "a <<EOF"`,
 * a quote inside `$(…)` within quotes); bash then says so and nothing is
 * refused. If bash cannot be asked (it fails to start, or takes longer than
 * `timeoutMs`), nothing is refused either: the line runs as it did before.
 *
 * Not covered: an `if` with no `fi`, a `for` with no `done`, a `$(` with no
 * `)`. Those do not hang. The shell reports a syntax error and exits at once
 * (measured the same day), and the next call starts a fresh one.
 */
export async function unfinishedInput(
  command: string,
  bashPath: string,
  timeoutMs = 5_000,
): Promise<string | null> {
  if (!mayBeUnfinished(command)) return null;
  const said = await bashParse(command, bashPath, timeoutMs);
  if (said === null) return null;
  const line = said.split("\n").find((l) => INCOMPLETE.test(l));
  return line === undefined
    ? null
    : line.replace(/^.*?: line \d+: /, "").trim();
}

/** What `bash -n` says when the text ends inside something: an open quote,
 *  an unterminated heredoc (a warning, exit 0), a construct left open. */
const INCOMPLETE =
  /unexpected EOF while looking for matching|unexpected end of file|delimited by end-of-file/;

/** A heredoc opener: `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD`
 *  (not `<<<`, a here-string). */
const HEREDOC_OPEN =
  /(?<!<)<<(?!<)(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z_][A-Za-z0-9_.-]*))/g;

/** The cheap look: is it worth asking bash? */
export function mayBeUnfinished(command: string): boolean {
  const lines = command.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    kept.push(line);
    const openers = [...line.matchAll(HEREDOC_OPEN)];
    for (const m of openers) {
      const stripTabs = m[1] === "-";
      const terminator = (m[2] ?? m[3] ?? m[4]) as string;
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const raw = lines[j] as string;
        if ((stripTabs ? raw.replace(/^\t+/, "") : raw) === terminator) break;
      }
      if (j >= lines.length) return true;
      i = j;
    }
  }
  return quoteOpenAtEnd(kept.join("\n"));
}

/** Whether a quote is still open at the end of `text`: single quotes take
 *  everything literally, double quotes and `$'…'` honour a backslash, a
 *  backslash outside quotes escapes the next character, and a `#` that
 *  starts a word comments out the rest of its line. */
function quoteOpenAtEnd(text: string): boolean {
  let quote: "'" | '"' | "$'" | null = null;
  let wordStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if ((quote === '"' && ch === '"') || (quote === "$'" && ch === "'"))
        quote = null;
      continue;
    }
    if (ch === "\\") {
      i += 1;
      wordStart = false;
      continue;
    }
    if (ch === "#" && wordStart) {
      const end = text.indexOf("\n", i);
      if (end < 0) break;
      i = end;
      wordStart = true;
      continue;
    }
    if (ch === "'") {
      quote = text[i - 1] === "$" ? "$'" : "'";
      wordStart = false;
      continue;
    }
    if (ch === '"') {
      quote = '"';
      wordStart = false;
      continue;
    }
    wordStart = /[\s;&|()<>]/.test(ch);
  }
  return quote !== null;
}

/** `bash -n` over the text: what it wrote to stderr, or null when it could
 *  not be asked. Never rejects. */
function bashParse(
  command: string,
  bashPath: string,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bashPath, ["-n"], {
        stdio: ["pipe", "ignore", "pipe"],
        env: childProcessEnv(),
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, timeoutMs);
    let err = "";
    child.stderr?.on("data", (d: Buffer) => {
      err += d.toString("utf8");
    });
    child.on("error", () => done(null));
    child.on("close", () => done(err));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(`${command}\n`);
  });
}
