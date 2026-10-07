import {
  type HertaTool,
  type OutputFn,
  type ProgressFn,
  type RunCommandData,
  summarizeShellCommand,
  type ToolCallRequest,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { splitShellSegments } from "../run-command/classifier.js";
import { LiveOutput } from "../run-command/live-output.js";
import { writeRunLog } from "../run-command/logger.js";
import { checkReaderArgvPaths } from "../run-command/reader-guard.js";
import { redactSecrets } from "../run-command/redactor.js";
import { detectTestRun } from "../run-command/test-detector.js";
import { PersistentShell, SHELL_BG_ID } from "./persistent-shell.js";
import { bashInputSchema, bashJsonSchema } from "./schema.js";
import {
  classifyShellCommandDetailed,
  peelReaderHead,
  tokenize,
} from "./shell-classifier.js";
import { shellPathsFor } from "./shell-paths.js";

export { findBash } from "./find-bash.js";
export {
  findHeredocWrites,
  type HeredocPreview,
  type HeredocWrite,
  previewHeredocWrites,
} from "./heredoc-write.js";
export {
  PersistentShell,
  type PersistentShellOpts,
  SHELL_BG_ID,
  type ShellRunResult,
} from "./persistent-shell.js";
export { makeBashRule, registerBashRule } from "./rule.js";
export type { BashInput } from "./schema.js";
export {
  classifyShellCommand,
  classifyShellCommandDetailed,
} from "./shell-classifier.js";
export {
  makeMsysPaths,
  primeShellPaths,
  type ShellPaths,
  shellPathsFor,
} from "./shell-paths.js";

/** The trained shape's description (ADR 0040) — persistence facts, the
 *  `sed -n` hint, the "background long-lived commands" nudge. The two lines
 *  the DeepSeek preset carries about internet/apt mirrors are NOT here: they
 *  describe a training sandbox, not this machine. */
export const BASH_DESCRIPTION = [
  "Run commands in a bash shell",
  '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
  "* State is persistent across command calls and discussions with the user.",
  "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
  "* Please avoid commands that may produce a very large amount of output.",
  "* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.",
].join("\n");

/** Per-command timeout: the trained runtime's 300 s (inside the shell
 *  policy's 600 s foreground cap). */
export const BASH_TIMEOUT_MS = 300_000;
/** What the MODEL sees per call: head + tail of the merged output. */
const MODEL_HEAD_CHARS = 12_000;
const MODEL_TAIL_CHARS = 4_000;
/** What the RECORD keeps as `data.stdout` (the bridge shows a bounded tail;
 *  the full text is in the .herta/logs file). Kept small so the harness
 *  payload never trips the 24K oversized-result persistence — the model
 *  reads `modelText`, not this. */
const RECORD_TAIL_CHARS = 4_000;

export interface BashToolOpts {
  /** Absolute path of the bash binary (from `findBash()`). */
  bashPath: string;
}

function clipForModel(text: string): { out: string; truncated: boolean } {
  if (text.length <= MODEL_HEAD_CHARS + MODEL_TAIL_CHARS) {
    return { out: text, truncated: false };
  }
  const omitted = text.length - MODEL_HEAD_CHARS - MODEL_TAIL_CHARS;
  return {
    out: `${text.slice(0, MODEL_HEAD_CHARS)}\n\n<response clipped> [${omitted} chars omitted — narrow the command (grep -n, sed -n, head/tail) to see them]\n\n${text.slice(-MODEL_TAIL_CHARS)}`,
    truncated: true,
  };
}

/** The shell's own spelling of the workspace, for the 板砖 prompt line —
 *  spawns nothing (mapping only) until a shell has run. */
export function shellWorkspaceHint(
  bashPath: string | null,
  workspaceRoot: string,
  lang: "zh" | "en" = "zh",
): string {
  if (bashPath === null) return workspaceRoot;
  const shell = new PersistentShell({ bashPath, workspaceRoot });
  const shellForm = shell.workspaceShellPath;
  if (shellForm === workspaceRoot.replace(/\\/g, "/")) return workspaceRoot;
  return lang === "en"
    ? `${workspaceRoot} (spelled ${shellForm} inside bash)`
    : `${workspaceRoot}（bash 里写作 ${shellForm}）`;
}

/**
 * `bash(command)` — the minimal contract's shell (ADR 0040).
 *
 * One PersistentShell per brief, registered as an INTERNAL background entry
 * so the runtime's brief-end `stopAll()` reaps it. Output is redacted,
 * persisted to `.herta/logs` like run_command's, and returned to the model
 * as plain text (`modelText`) with `[exit code: N]` on non-zero, while the
 * harness gets RunCommandData (exit, duration, tail, testRun) so the record
 * shows the same rows a run_command would.
 */
export function bashTool(opts: BashToolOpts): HertaTool {
  return {
    name: "bash",
    schema(): ToolSchema {
      return {
        name: "bash",
        description: BASH_DESCRIPTION,
        inputSchema: bashJsonSchema,
      };
    },
    summarize(input: unknown, ctx: { workspaceRoot: string }) {
      // The record header (`Running <this>`). The loop's generic form strips
      // the model's `cd <workspace> &&` prefix in the spellings it can derive
      // from the native path; only THIS shell knows the MSYS `/tmp/…` form
      // of a %TEMP% checkout (live GUI 2026-08-17: every row still read
      // "Running cd /tmp/claude/…" because the workspace lived under %TEMP%).
      const command =
        typeof input === "object" && input !== null
          ? (input as { command?: unknown }).command
          : undefined;
      if (typeof command !== "string" || command.length === 0) return undefined;
      const shellForm = shellPathsFor(opts.bashPath).toShell(ctx.workspaceRoot);
      return summarizeShellCommand(command, ctx.workspaceRoot, [shellForm]);
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
      _progress: ProgressFn,
      output?: OutputFn,
    ): Promise<ToolResult> {
      const parsed = bashInputSchema.safeParse(call.input);
      if (!parsed.success) {
        const message = formatInputIssues(parsed.error);
        return {
          ok: false,
          error: { code: "invalid_input", message, retryable: false },
          summary: "failed: invalid_input",
          modelText: `Parameter \`command\` is required for the bash tool: ${message}`,
        };
      }
      const command = parsed.data.command;

      let shell = ctx.bg.getInternal(SHELL_BG_ID);
      if (!(shell instanceof PersistentShell)) {
        // The shell lives for the brief; the run's journal learns each bash
        // it starts (ADR 0071 §1.6).
        const journal = ctx.journal;
        shell = new PersistentShell({
          bashPath: opts.bashPath,
          workspaceRoot: ctx.workspaceRoot,
          ...(journal !== undefined
            ? {
                onSpawn: (pid: number) =>
                  journal.recordSpawn({
                    pid,
                    command: "bash (persistent shell)",
                    role: "shell",
                  }),
                onExit: (pid: number) => journal.recordExit(pid),
                // The real shell under the launcher: what a relaunch must
                // find when the launcher died with the app (ADR 0071 §1.6).
                onShellPid: (pid, group) =>
                  journal.recordSpawn({
                    pid,
                    command: "bash (persistent shell)",
                    role: "shell",
                    msys: { pgid: group.pgid, ps: group.ps },
                  }),
              }
            : {}),
        });
        ctx.bg.register(shell);
      }
      const sh = shell as PersistentShell;
      // The rule's own verdict, taken again before the line runs (its `cd`
      // would move the cwd the rule read): `allow` is a class that changes
      // nothing a user would take back, and undo leaves it out of what it
      // names (ADR 0074 §2).
      const readOnly =
        classifyShellCommandDetailed(command, {
          workspaceRoot: ctx.workspaceRoot,
          paths: shellPathsFor(opts.bashPath),
          cwd: sh.cwd,
        }).verdict.kind === "allow";

      // Execution-time reader realpath backstop (TOCTOU, mirrors run_command).
      // Peeled exactly as the RULE peels (`rule.ts`): the rule learned on
      // 2026-08-24 that an un-peeled `time cat x` hands the guard a first
      // word that is no reader and switches it off; this second look kept
      // the old spelling, so behind one harmless word it re-checked nothing
      // (perf audit 2026-09-20, found in passing).
      for (const segment of splitShellSegments(command)) {
        const { words } = tokenize(segment);
        if (words.length === 0) continue;
        const denial = await checkReaderArgvPaths(
          ctx.workspaceRoot,
          sh.cwd,
          peelReaderHead(words),
        );
        if (denial !== null) {
          return {
            ok: false,
            error: {
              code: denial.code,
              message: denial.message,
              retryable: false,
            },
            summary: `failed: ${denial.code}`,
            modelText: `Command refused by the harness: ${denial.message}`,
          };
        }
      }

      // The live view (ADR 0073): whole lines, redacted as the result is.
      const live =
        output !== undefined ? new LiveOutput((text) => output(text)) : null;
      const r = await sh.run(command, {
        timeoutMs: BASH_TIMEOUT_MS,
        signal: ctx.signal,
        ...(live !== null
          ? { onOutput: (text: string) => live.push(text) }
          : {}),
      });
      live?.flush();
      if (ctx.signal.aborted) {
        const err = new Error("aborted");
        (err as Error & { name: string }).name = "AbortError";
        throw err;
      }

      const redacted = redactSecrets(r.output);
      const notes: string[] = [];
      if (r.cwdReset) {
        notes.push(
          `[the command left the workspace; the shell has been moved back to ${sh.workspaceShellPath}]`,
        );
      }
      if (r.freshShell && sh.spawns > 1) {
        notes.push(
          "[note: a fresh shell — the previous one was reset, so its cwd and variables are gone]",
        );
      }
      if (r.timedOut) {
        notes.push(
          `[command timed out after ${BASH_TIMEOUT_MS / 1000}s; the shell was reset — cwd and variables are lost. Run long-lived commands in the background.]`,
        );
      } else if (r.shellExited) {
        notes.push("[shell exited]");
      } else if (r.exitCode !== 0 && r.exitCode !== null) {
        notes.push(`[exit code: ${r.exitCode}]`);
      }
      const modelBody = clipForModel(redacted);
      const modelText = [modelBody.out, ...notes]
        .filter((s) => s.length > 0)
        .join("\n");

      const firstLine = command.trimStart().split(/\r?\n/)[0] ?? command;
      const displayCmd = redactSecrets(
        firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine,
      );
      const logPath = await writeRunLog(
        ctx.workspaceRoot,
        ctx.sessionId,
        call.id,
        {
          ts: new Date().toISOString(),
          cwd: sh.cwd,
          argv: ["bash", "-c", redactSecrets(command)],
          exitCode: r.exitCode,
          signal: null,
          timedOut: r.timedOut,
          durationMs: r.durationMs,
          stdout: redacted,
          stderr: "",
          stdoutBytes: r.outputBytes,
          stderrBytes: 0,
          stdoutCapped: r.capped,
          stderrCapped: false,
        },
      );

      const tail =
        redacted.length > RECORD_TAIL_CHARS
          ? redacted.slice(-RECORD_TAIL_CHARS)
          : redacted;
      const data: RunCommandData = {
        argv: [displayCmd],
        cwd: ".",
        exitCode: r.exitCode,
        signal: null,
        durationMs: r.durationMs,
        stdout: tail,
        stderr: "",
        stdoutTruncated: tail.length < redacted.length || r.capped,
        stderrTruncated: false,
        stdoutBytes: r.outputBytes,
        stderrBytes: 0,
        logPath,
        timedOut: r.timedOut,
        readOnly,
      };
      // Test evidence: the first segment that IS a test runner names the run
      // (`cd x && npm test` → npm test); the shell's exit is the pipeline's.
      for (const segment of splitShellSegments(command)) {
        const { words } = tokenize(segment);
        if (words.length === 0) continue;
        const testRun = detectTestRun({
          argv: words,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          timedOut: r.timedOut,
        });
        if (testRun !== null) {
          data.testRun = testRun;
          break;
        }
      }

      if (r.timedOut) {
        return {
          ok: false,
          error: {
            code: "timeout",
            message: `command exceeded ${BASH_TIMEOUT_MS}ms`,
            retryable: true,
          },
          data,
          summary: `timed out: ${displayCmd} (${BASH_TIMEOUT_MS}ms) — partial output captured, log at ${logPath}`,
          modelText,
        };
      }
      const exitText =
        r.exitCode === null ? "shell exited" : `exit ${r.exitCode}`;
      return {
        ok: true,
        data,
        summary: `ran \`${displayCmd}\` (${exitText}, ${(r.durationMs / 1000).toFixed(2)}s) — log at ${logPath}`,
        modelText,
      };
    },
  };
}
