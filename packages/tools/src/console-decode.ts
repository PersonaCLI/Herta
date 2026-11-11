import { execFile } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/**
 * What a child process wrote, as text (review 2026-11-10).
 *
 * Every byte a child wrote was read as UTF-8. On Windows that is true of what
 * Git Bash's own tools print and false of what the machine's native programs
 * do: `ipconfig`, `tasklist`, `where`, a compiler, Python writing to a pipe —
 * they write in the machine's code page for programs that are not Unicode
 * ones. On a Chinese Windows that is 936 (GBK), and every Chinese character
 * such a program printed reached 板砖, the record and the log as U+FFFD: an
 * error message it could not read, on the machines this app is used on most.
 *
 * One stream carries both, line by line, so there is no one encoding to pick.
 * A line is read as UTF-8, and where it is not valid UTF-8 it is read in the
 * machine's code page instead. UTF-8 is strict enough that text in a legacy
 * code page almost never passes for it, so a line is very rarely read as the
 * wrong one. A line break is a safe place to cut in both: 0x0A and 0x0D are
 * never the second byte of a character in GBK, Big5, Shift_JIS or EUC-KR.
 *
 * Off Windows, on a machine whose code page is UTF-8 already, and until the
 * code page is known (`primeConsoleEncoding`), nothing changes: plain UTF-8,
 * as before.
 */

/** A Windows code page as the label `TextDecoder` reads it by; null for one
 *  that needs no second reading (UTF-8) or that this cannot read. 936 is
 *  read as GB18030, which is GBK and the characters added to it since. */
export function codePageLabel(codePage: number): string | null {
  if (codePage === 936 || codePage === 54936) return "gb18030";
  if (codePage === 950) return "big5";
  if (codePage === 932) return "shift_jis";
  if (codePage === 949) return "euc-kr";
  if (codePage === 874) return "windows-874";
  if (codePage >= 1250 && codePage <= 1258) return `windows-${codePage}`;
  return null;
}

/** The `ACP` value out of `reg query …\Nls\CodePage /v ACP`. */
export function parseAcp(regOutput: string): number | null {
  const m = /\bACP\s+REG_SZ\s+(\d+)/u.exec(regOutput);
  return m === null ? null : Number(m[1]);
}

/** undefined until asked; null once known to need no second reading. */
let legacy: string | null | undefined;
let priming: Promise<void> | null = null;

/** The label of this machine's legacy code page, or null: not Windows,
 *  UTF-8 already, unreadable, or not asked yet. Never spawns. */
export function consoleLegacyEncoding(): string | null {
  return legacy ?? null;
}

const PROBE_TIMEOUT_MS = 3_000;

/**
 * Asks Windows for its code page once, without holding the thread, and
 * fills what `consoleLegacyEncoding` answers. The registry is asked, not
 * `chcp`: a console's code page is the one cmd's own built-ins use, and the
 * registry's `ACP` is the one a program writes a pipe in. On a machine
 * where the two differ the built-ins are the ones read wrong. Never
 * rejects; a no-op off Windows and once the answer is in.
 */
export function primeConsoleEncoding(): Promise<void> {
  if (legacy !== undefined) return Promise.resolve();
  if (process.platform !== "win32") {
    legacy = null;
    return Promise.resolve();
  }
  if (priming !== null) return priming;
  priming = new Promise<void>((settled) => {
    const done = (label: string | null): void => {
      legacy = usable(label);
      priming = null;
      settled();
    };
    try {
      // By its full path: a `reg` earlier on PATH is not asked.
      const reg = join(
        process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows",
        "System32",
        "reg.exe",
      );
      execFile(
        reg,
        [
          "query",
          "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
          "/v",
          "ACP",
        ],
        { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          const acp = err === null ? parseAcp(stdout) : null;
          done(acp === null ? null : codePageLabel(acp));
        },
      );
    } catch {
      done(null);
    }
  });
  return priming;
}

/** `label` if this runtime can read it, else null. */
function usable(label: string | null): string | null {
  if (label === null) return null;
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return null;
  }
}

/** For tests: what the machine's answer would have been. */
export function setConsoleLegacyEncodingForTest(
  label: string | null | undefined,
): void {
  legacy = label;
}

const LF = 0x0a;
const CR = 0x0d;

/** Bytes held for a line break before they are read anyway: a minified
 *  file is one line, and it is not kept from the screen until its end. */
const MAX_HELD_BYTES = 65_536;

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `bytes` as UTF-8, or null where they are not. With `cutEnd`, a UTF-8
 *  character cut short at the very end (a capture that stopped at its cap)
 *  does not make the rest something else: it reads as one U+FFFD. */
function asUtf8(bytes: Uint8Array, cutEnd: boolean): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    if (!cutEnd) return null;
  }
  const whole = utf8Boundary(bytes);
  if (whole === bytes.length) return null;
  try {
    return `${strictUtf8.decode(bytes.subarray(0, whole))}�`;
  } catch {
    return null;
  }
}

/** Whole lines, read as UTF-8 where they are and in `fallback` where not.
 *  `cutEnd`: the last line may stop in the middle of a character. */
function readLines(
  bytes: Uint8Array,
  fallback: TextDecoder,
  cutEnd = false,
): string {
  const all = asUtf8(bytes, cutEnd);
  if (all !== null) return all;
  // Not all of it is UTF-8: line by line, so each is read as what it is.
  let out = "";
  let start = 0;
  for (let i = 0; i <= bytes.length; i += 1) {
    const atBreak = i < bytes.length && (bytes[i] === LF || bytes[i] === CR);
    if (!atBreak && i < bytes.length) continue;
    const end = atBreak ? i + 1 : i;
    if (end > start) {
      const line = bytes.subarray(start, end);
      out +=
        asUtf8(line, cutEnd && end === bytes.length) ?? fallback.decode(line);
    }
    start = end;
  }
  return out;
}

/** Where `bytes` can be cut without splitting a UTF-8 character at its
 *  end: its length, or up to three bytes short of it. */
function utf8Boundary(bytes: Uint8Array): number {
  const n = bytes.length;
  for (let back = 1; back <= 3 && back <= n; back += 1) {
    const b = bytes[n - back] as number;
    if ((b & 0xc0) === 0x80) continue;
    if (b < 0xc0) return n;
    const needs = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
    return needs > back ? n - back : n;
  }
  return n;
}

/**
 * One stream of a child's output, a chunk at a time.
 *
 * With no legacy code page it is a `StringDecoder`: text comes out as it
 * comes in. With one, text comes out a whole line at a time, since a line is
 * what is read as one encoding or the other; a line with no break in it
 * comes out when it ends, or at {@link MAX_HELD_BYTES}.
 */
export class ConsoleDecoder {
  private readonly plain: StringDecoder | null;
  private readonly fallback: TextDecoder | null;
  private held: Buffer = Buffer.alloc(0);

  constructor(legacyLabel: string | null = consoleLegacyEncoding()) {
    const label = usable(legacyLabel);
    this.fallback = label === null ? null : new TextDecoder(label);
    this.plain = label === null ? new StringDecoder("utf8") : null;
  }

  write(chunk: Buffer): string {
    if (this.plain !== null) return this.plain.write(chunk);
    const all =
      this.held.length === 0 ? chunk : Buffer.concat([this.held, chunk]);
    let cut = Math.max(all.lastIndexOf(LF), all.lastIndexOf(CR)) + 1;
    if (cut === 0 && all.length > MAX_HELD_BYTES) cut = utf8Boundary(all);
    this.held = all.subarray(cut);
    return cut === 0
      ? ""
      : readLines(all.subarray(0, cut), this.fallback as TextDecoder);
  }

  /** What is left when the stream ends. */
  end(): string {
    if (this.plain !== null) return this.plain.end();
    const rest = this.held;
    this.held = Buffer.alloc(0);
    return rest.length === 0
      ? ""
      : readLines(rest, this.fallback as TextDecoder);
  }
}

/** A whole captured output at once: a command's result, a log's slice. */
export function decodeConsoleOutput(
  bytes: Buffer,
  legacyLabel: string | null = consoleLegacyEncoding(),
): string {
  const label = usable(legacyLabel);
  if (label === null) return bytes.toString("utf-8");
  return readLines(bytes, new TextDecoder(label), true);
}
