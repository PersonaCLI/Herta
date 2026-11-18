import { basename } from "node:path";
import { peelReaderHead, tokenize } from "./shell-classifier.js";

/**
 * The first command of a line that turns on bash's `noexec` (`set -n`,
 * `set -o noexec`, a cluster such as `-en`), as written; null when none
 * does (review 2026-11-10, ADR 0040 amendment 2026-11-18).
 *
 * In a shell that reads its commands from stdin, as the persistent shell
 * does, `noexec` makes bash read every later line and run none of them. The
 * harness's own closing lines are among them, so the call's end never
 * arrived: it waited out its whole timeout and the shell was replaced, with
 * every `cd` and variable the brief had set. Nothing can turn the option
 * off again (`set +n` is itself not run), so the line is refused before it
 * reaches the shell. `bash -n file` checks a script's syntax in a child
 * shell, which is what `set -n` is usually reached for.
 *
 * `steps` are the classifier's (`classifyShellCommandDetailed`): every
 * simple command of the line, substitution bodies and loop items included.
 * Each is read as the reader guard reads it (`peelReaderHead`), so `if …;
 * then set -n; fi` and `command set -n` are found as well.
 */
export function noexecCommand(
  steps: ReadonlyArray<{ readonly text: string }>,
): string | null {
  for (const { text } of steps) {
    const words = peelReaderHead(tokenize(text).words);
    if (words.length === 0 || basename(words[0] as string) !== "set") {
      continue;
    }
    if (setTurnsOnNoexec(words.slice(1))) return text.trim();
  }
  return null;
}

/** Whether `set`'s arguments turn `noexec` on: a short cluster with `n`, or
 *  `-o noexec` (the name may follow a cluster that ends in `o`, as in
 *  `-eo noexec`). Reading stops at `--`, a lone `-`, or the first word that
 *  is not an option: the rest are positional parameters. */
function setTurnsOnNoexec(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--" || a === "-" || !/^[-+][A-Za-z]+$/.test(a)) return false;
    const on = a.startsWith("-");
    const letters = a.slice(1);
    if (on && letters.includes("n")) return true;
    if (letters.endsWith("o")) {
      const name = args[i + 1];
      if (on && name === "noexec") return true;
      i += 1;
    }
  }
  return false;
}
