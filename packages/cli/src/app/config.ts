import pkg from "../../package.json" with { type: "json" };

export interface ParsedArgs {
  help: boolean;
  version: boolean;
  /**
   * Value of `--resume <value>` or `--resume=<value>`. `"latest"` resolves
   * to the most-recent workspace session at startup. Anything else is
   * treated as a session id prefix. `undefined` means the flag was not set.
   */
  resume: string | undefined;
  /**
   * Raw value of `--lang <value>` or `--lang=<value>`. `undefined` means the
   * flag was not set (default interaction language "zh"). Validation against
   * the `"zh" | "en"` union happens in `main` so an invalid value can fail
   * fast with exit code 2 — a bare `--lang` with no value parses as `""`,
   * which fails that same validation.
   */
  lang: string | undefined;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let help = false;
  let version = false;
  let resume: string | undefined;
  let lang: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--version" || arg === "-v") version = true;
    else if (arg === "--resume") {
      // Space-separated: `--resume <value>`. Empty string falls back to "latest".
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-") && next.length > 0) {
        resume = next;
        i++; // consume the value
      } else {
        resume = "latest"; // bare --resume or empty value = latest
      }
    } else if (arg.startsWith("--resume=")) {
      const value = arg.slice("--resume=".length);
      resume = value.length > 0 ? value : "latest";
    } else if (arg === "--lang") {
      // Space-separated: `--lang <value>`. A missing value parses as ""
      // so main's zh|en validation rejects it with a clear error.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        lang = next;
        i++; // consume the value
      } else {
        lang = "";
      }
    } else if (arg.startsWith("--lang=")) {
      lang = arg.slice("--lang=".length);
    }
  }
  return { help, version, resume, lang };
}

export function printUsage(out: NodeJS.WritableStream): void {
  out.write(`usage: herta [options]\n`);
  out.write(`\n`);
  out.write(`options:\n`);
  out.write(`  --help, -h          show this help and exit\n`);
  out.write(`  --version, -v       show version and exit\n`);
  out.write(`  --resume <id>       resume a session by id prefix\n`);
  out.write(`  --resume latest     resume the most recent workspace session\n`);
  out.write(`  --resume            shorthand for --resume latest\n`);
  out.write(
    `  --lang <zh|en>      interaction language for this session (default zh)\n`,
  );
  out.write(`\n`);
  out.write(`Run with no options to start a fresh interactive REPL.\n`);
}

export function printVersion(out: NodeJS.WritableStream): void {
  out.write(`Herta v${pkg.version}\n`);
}

/** Per the official DeepSeek doc (2026-09-10): both `deepseek-flash` and
 *  `deepseek-v4-pro` accept "low" | "high" | "max" as reasoning_effort
 *  (thinking is on by default at "high"). "medium" was never a valid value.
 *  `false` sends the thinking block disabled. */
export type ThinkingLevel = false | "low" | "high" | "max";

/**
 * Parse a thinking-level env string. Returns false / low / high / max for
 * valid inputs; undefined for unset OR invalid input. Invalid input
 * (including the never-valid "medium") writes a one-line warning to the
 * provided stream so typos and stale env vars are visible.
 */
export function parseThinking(
  raw: string | undefined,
  stderr: NodeJS.WritableStream,
): ThinkingLevel | undefined {
  if (raw === undefined) return undefined;
  if (raw === "false" || raw === "off") return false;
  if (raw === "low" || raw === "high" || raw === "max") return raw;
  stderr.write(
    `herta: ignoring invalid thinking level "${raw}" (use false/low/high/max)\n`,
  );
  return undefined;
}
