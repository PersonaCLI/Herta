import { basename } from "node:path";
import { peelReaderHead, tokenize } from "./shell-classifier.js";

/**
 * The first `exec` of a line that would take the persistent shell over, as
 * written, and how; null when none would (ADR 0040 amendment 2026-11-19).
 *
 * Measured on the real shell (2026-11-19): `exec <program>` replaces the
 * shell with the program. `exec bash` ended it at once, and `exec sleep 30`
 * held the call until its timeout; either way every `cd` and variable the
 * brief had set was gone. `exec >file` moved the shell's own output for the
 * rest of the session, the harness's end-of-call line with it, so the call
 * waited out its timeout. `exec 2>file`, `exec 3>file` and `exec <file`
 * left the shell working, and are not refused.
 *
 * `steps` are the classifier's (`classifyShellCommandDetailed`), each read as
 * the reader guard reads it (`peelReaderHead`): they say whether the line has
 * an `exec` at all and what it runs. Its redirections are read from the line
 * itself, quoted text blanked: the steps drop a duplication (`>&2`, `2>&1`)
 * and split `&>` at the `&`.
 */
export function execTakesOverShell(
  steps: ReadonlyArray<{ readonly text: string }>,
  command: string,
): { readonly command: string; readonly replaces: boolean } | null {
  let bareExec = false;
  for (const { text } of steps) {
    const words = peelReaderHead(tokenize(text).words);
    if (words.length === 0 || basename(words[0] as string) !== "exec") {
      continue;
    }
    // exec's own options (-c, -l, -a NAME) and named descriptors (`{fd}>f`,
    // which the tokenizer leaves as a word).
    let i = 1;
    while (i < words.length) {
      const w = words[i] as string;
      if (w === "--") {
        i += 1;
        break;
      }
      if (w === "-a") {
        i += 2;
        continue;
      }
      if (/^-[cl]+$/.test(w) || /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(w)) {
        i += 1;
        continue;
      }
      break;
    }
    if (i < words.length) return { command: text.trim(), replaces: true };
    bareExec = true;
  }
  if (!bareExec) return null;
  const moved = execMovingStdout(blankQuotes(command));
  return moved === null ? null : { command: moved, replaces: false };
}

/** A redirection operator and the descriptor in front of it. `>&` comes
 *  before `>` so `>&2` is read whole. */
const REDIRECT = /(?:^|[\s;])(\d*)(&>>?|>&|>>?\|?)/g;

/** Whether redirections move descriptor 1: `>f`, `1>f`, `>>f`, `&>f`,
 *  `>&2`, `1>&-`. A named descriptor (`{fd}>f`) and 0 or 2 do not. */
function redirectsStdout(text: string): boolean {
  for (const m of text.matchAll(REDIRECT)) {
    const fd = m[1] as string;
    const op = m[2] as string;
    if (op.startsWith("&>") || fd === "" || fd === "1") return true;
  }
  return false;
}

/** `exec` where a command starts. */
const EXEC_WORD = /(?:^|[\s;&|({!])exec(?=\s|$)/g;

/** The first `exec …` in the text whose redirections move descriptor 1, as
 *  written up to the end of its command; null when there is none. The
 *  command ends at `;`, `&&`, `||`, `|` or a line break, but not at the `&`
 *  of `&>` / `>&` or the `|` of `>|`. */
function execMovingStdout(text: string): string | null {
  for (const m of text.matchAll(EXEC_WORD)) {
    const from = (m.index ?? 0) + m[0].length;
    let end = from;
    for (; end < text.length; end += 1) {
      const ch = text[end] as string;
      const prev = text[end - 1];
      if (ch === "\n" || ch === ";") break;
      if (ch === "|" && prev !== ">") break;
      if (ch === "&" && text[end + 1] !== ">" && prev !== ">" && prev !== "<") {
        break;
      }
    }
    const rest = text.slice(from, end);
    if (redirectsStdout(rest)) return `exec${rest}`.trim();
  }
  return null;
}

/** The text with everything inside quotes turned to spaces, so quoted words
 *  are not read as commands or redirections. */
function blankQuotes(text: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quote === null) {
      if (ch === "\\") {
        out += `${ch}${text[i + 1] ?? ""}`;
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
      out += ch;
      continue;
    }
    if (quote === '"' && ch === "\\") {
      out += "  ";
      i += 1;
      continue;
    }
    if (ch === quote) {
      quote = null;
      out += ch;
      continue;
    }
    out += ch === "\n" ? "\n" : " ";
  }
  return out;
}
