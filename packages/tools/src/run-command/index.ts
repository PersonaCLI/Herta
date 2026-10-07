import { StringDecoder } from "node:string_decoder";
import type {
  HertaTool,
  OutputFn,
  ProgressFn,
  RunCommandData,
  ToolCallRequest,
  ToolContext,
  ToolResult,
  ToolSchema,
} from "@herta/core";
import { childProcessEnv } from "../child-env.js";
import { errResult } from "../errors.js";
import { formatInputIssues } from "../input-issues.js";
import { resolveSafePath } from "../path-safety.js";
import { SpawnedBackgroundProcess } from "./background-process.js";
import { classifyCommand } from "./classifier.js";
import { allowedEnvKeys, findDisallowedEnvKey } from "./env-guard.js";
import { LiveOutput } from "./live-output.js";
import { writeRunLog } from "./logger.js";
import { checkReaderArgvPaths } from "./reader-guard.js";
import { redactSecrets } from "./redactor.js";
import { runCommandWriteGuard } from "./rule.js";
import { runCommand } from "./runner.js";
import { runCommandInputSchema, runCommandJsonSchema } from "./schema.js";
import { resolveWindowsShim } from "./shim-wrapper.js";
import { detectTestRun } from "./test-detector.js";

export { commandOutputTool, commandStopTool } from "./background-tools.js";
export { makeRunCommandRule, registerRunCommandRule } from "./rule.js";
export type { RunCommandInput } from "./schema.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BYTES_PER_STREAM = 1_048_576;
const HEAD_BYTES = 16_384;
const TAIL_BYTES = 16_384;

// RunCommandData moved to @herta/core (cross-layer contract: the bridge in
// @herta/herta reads it, and herta must not depend on tools — the package
// graph is a DAG, 2026-07-05). Re-exported here so tools' consumers keep
// their import path.
export type { RunCommandData } from "@herta/core";

function truncateForReturn(text: string): {
  out: string;
  truncated: boolean;
} {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= HEAD_BYTES + TAIL_BYTES) {
    return { out: text, truncated: false };
  }
  const head = buf.subarray(0, HEAD_BYTES).toString("utf-8");
  const tail = buf.subarray(buf.length - TAIL_BYTES).toString("utf-8");
  const elided = buf.length - HEAD_BYTES - TAIL_BYTES;
  return {
    out: `${head}\n... [${elided} bytes elided] ...\n${tail}`,
    truncated: true,
  };
}

export function runCommandTool(): HertaTool {
  return {
    name: "run_command",
    schema(): ToolSchema {
      return {
        name: "run_command",
        description:
          "Execute an argv-style command (no shell interpretation). Allow-list covers test runners, lint, git read-only, and read-only utilities. Other commands ASK for permission. Catastrophic commands are blocked. Output is captured (up to 1MB per stream), truncated for return, and persisted to .herta/logs/ (the log notes when a stream exceeded the 1MB capture cap).",
        inputSchema: runCommandJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
      _progress: ProgressFn,
      output?: OutputFn,
    ): Promise<ToolResult<RunCommandData>> {
      const parsed = runCommandInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return {
          ...errResult("invalid_input", formatInputIssues(parsed.error)),
          suggestion:
            'usage: {argv: ["cmd", …args], cwd?, timeoutMs?, env?, runInBackground?}',
        };
      }
      const { argv, cwd, timeoutMs, env, runInBackground } = parsed.data;

      const safe = await resolveSafePath(ctx.workspaceRoot, cwd ?? ".");
      if (!safe.ok) {
        return errResult(safe.code, safe.message);
      }

      // Classify the model's ORIGINAL argv — the permission tier is decided
      // before any harness-side shim wrapping (audit 2026-07-10 finding 3:
      // the model never gets to escalate by phrasing its own cmd wrapper).
      const verdict = classifyCommand(argv, {
        writeGuard: runCommandWriteGuard(ctx.workspaceRoot, safe.resolved),
      });
      if (verdict.kind === "block") {
        return errResult("command_blocked", verdict.reason);
      }

      // Model-supplied env guard (ADR 0025 slice 4; ALLOWLIST since audit S1).
      // Runs before the child is spawned: allow-tier commands carry no
      // approval card, so a key that redirects code resolution would execute
      // arbitrary code with nothing shown to the user. Proven exploit that
      // motivated the inversion: GIT_CONFIG_* + `git diff` → diff.external.
      if (env !== undefined) {
        const bad = findDisallowedEnvKey(env);
        if (bad !== null) {
          return errResult(
            "env_key_denied",
            `env key not allowed: ${bad} — run_command accepts only inert config vars, ` +
              `because commands like \`git diff\` and \`pytest\` run without an approval prompt. ` +
              `Allowed: ${allowedEnvKeys.join(", ")}. ` +
              `If you genuinely need another variable, set it inline through a shell ` +
              `(e.g. sh -c 'FOO=bar cmd') — that is ask-tier, so the user sees and approves it.`,
          );
        }
      }
      // childProcessEnv: minus the AppImage launcher's own entries (2026-09-23).
      const childEnv =
        env !== undefined
          ? { ...childProcessEnv(), ...env }
          : childProcessEnv();

      // Execution-time reader-argv realpath backstop (audit T3.4): the
      // permission rule already denied disguised-symlink reads, but re-check
      // here to close the TOCTOU window (a symlink swapped in between the
      // permission check and this spawn). Cheap — only fires for allow-listed
      // readers with existing file operands.
      const readerDenial = await checkReaderArgvPaths(
        ctx.workspaceRoot,
        safe.resolved,
        argv,
      );
      if (readerDenial !== null) {
        return errResult(readerDenial.code, readerDenial.message);
      }

      // Windows .cmd shim wrapping (ADR 0025 slice 4) — deterministic, AFTER
      // classification/approval; refuses cmd-metacharacter args rather than
      // risk injection through cmd.exe's re-parse.
      const shim = resolveWindowsShim(argv);
      if (shim.kind === "unsafe_args") {
        return errResult(
          "unsafe_shim_arg",
          `cannot safely wrap ${argv[0]} for Windows: argument contains a shell metacharacter (${shim.offending}). Rephrase without & | < > ^ % ! " or newlines.`,
        );
      }
      const execArgv = shim.argv;

      // Background branch (ADR 0025 slice 4): spawn, register with the
      // per-brief host, return the id immediately. The process is reaped
      // when the brief ends (CodingAgentRuntime's finally) — no unmanaged
      // backgrounding.
      if (runInBackground === true) {
        const bgId = ctx.bg.nextId();
        const proc = new SpawnedBackgroundProcess({
          id: bgId,
          argv: execArgv,
          cwd: safe.resolved,
          env: childEnv,
        });
        if (await proc.spawnFailed()) {
          return errResult(
            "not_found",
            `binary not found: ${argv[0]} (background) — check the command name`,
          );
        }
        ctx.bg.register(proc);
        const redactedBgArgv = argv.map((a) => redactSecrets(a));
        // In the run's journal until it ends (ADR 0071 §1.6).
        const bgPid = proc.pid;
        if (bgPid !== undefined && ctx.journal !== undefined) {
          const journal = ctx.journal;
          journal.recordSpawn({
            pid: bgPid,
            command: redactedBgArgv.join(" "),
            role: "background",
          });
          void proc.closed().then(() => journal.recordExit(bgPid));
        }
        return {
          ok: true,
          data: {
            argv: redactedBgArgv,
            cwd: safe.relative === "" ? "." : safe.relative,
            exitCode: null,
            signal: null,
            durationMs: 0,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutBytes: 0,
            stderrBytes: 0,
            logPath: "",
            timedOut: false,
            backgroundId: bgId,
            running: true,
          },
          summary: `started \`${redactedBgArgv.slice(0, 2).join(" ")}\` in background (${bgId}) — command_output to read, command_stop to end`,
        };
      }

      const effectiveTimeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // The live view (ADR 0073): each stream decoded on its own (a chunk
      // can split a character) and cut into lines on its own (so a stdout
      // line and a stderr line never splice), redacted as the result is.
      const live =
        output !== undefined
          ? {
              stdout: {
                decoder: new StringDecoder("utf8"),
                lines: new LiveOutput(output),
              },
              stderr: {
                decoder: new StringDecoder("utf8"),
                lines: new LiveOutput(output),
              },
            }
          : null;
      // The run's journal learns the pid (ADR 0071 §1.6): a relaunch after a
      // crash ends a command still running.
      let spawnedPid: number | undefined;
      const raw = await runCommand(execArgv, {
        cwd: safe.resolved,
        timeoutMs: effectiveTimeoutMs,
        signal: ctx.signal,
        maxBytesPerStream: MAX_BYTES_PER_STREAM,
        env: childEnv,
        onSpawn: (pid) => {
          spawnedPid = pid;
          ctx.journal?.recordSpawn({
            pid,
            command: argv.map((a) => redactSecrets(a)).join(" "),
            role: "foreground",
          });
        },
        ...(live !== null
          ? {
              onOutput: (chunk: Buffer, stream: "stdout" | "stderr") => {
                const s = live[stream];
                s.lines.push(s.decoder.write(chunk));
              },
            }
          : {}),
      });
      if (live !== null) {
        for (const s of [live.stdout, live.stderr]) {
          s.lines.push(s.decoder.end());
          s.lines.flush();
        }
      }
      if (spawnedPid !== undefined) ctx.journal?.recordExit(spawnedPid);

      if (raw.cause === "not_found") {
        // Do NOT steer toward shell wrappers here: the old text said "wrap
        // in cmd /c", pointing the model straight at what was then a
        // classifier blind spot (2026-07-10 audit, finding 3). Wrapped
        // commands are re-classified and prompt for approval.
        //
        // Platform-conditional (audit S7): the .cmd-shim explanation is
        // Windows-only and actively misleading on macOS/Linux, where the
        // real cause is almost always PATH — a Finder-launched .app starts
        // with launchd's minimal PATH (the harness repairs that at startup,
        // but a tool installed after launch, or one only on an interactive
        // shell's PATH, still will not resolve).
        return errResult(
          "not_found",
          process.platform === "win32"
            ? `binary not found: ${argv[0]} — on Windows, npm/pnpm are .cmd shims that only resolve under a shell; a cmd /c wrapper works but requires user approval`
            : `binary not found: ${argv[0]} — it is not on this app's PATH. If it is installed via a version manager (nvm/pyenv/rustup) or Homebrew, it may only be on an interactive shell's PATH; try an absolute path, or restart the app after installing it`,
        );
      }
      if (raw.cause === "spawn_error") {
        return errResult(
          "spawn_failed",
          raw.spawnError?.message ?? "spawn failed",
        );
      }
      if (raw.cause === "timeout") {
        // Keep the partial output the runner buffered before the kill — it's
        // usually WHY the command hung (the last test name, the waiting
        // prompt) — and persist the run log like any other run. Previously
        // both were discarded, contradicting the bounded-failure-excerpt +
        // persist-full-output policy exactly when diagnostics mattered most.
        const stdoutPartial = redactSecrets(raw.stdout.toString("utf-8"));
        const stderrPartial = redactSecrets(raw.stderr.toString("utf-8"));
        const stdoutP = truncateForReturn(stdoutPartial);
        const stderrP = truncateForReturn(stderrPartial);
        const redactedArgvPartial = argv.map((a) => redactSecrets(a));
        const partialLogPath = await writeRunLog(
          ctx.workspaceRoot,
          ctx.sessionId,
          call.id,
          {
            ts: new Date().toISOString(),
            cwd: safe.relative === "" ? "." : safe.relative,
            argv: redactedArgvPartial,
            exitCode: raw.exitCode,
            signal: raw.signal,
            timedOut: true,
            durationMs: raw.durationMs,
            stdout: stdoutPartial,
            stderr: stderrPartial,
            stdoutBytes: raw.stdoutBytes,
            stderrBytes: raw.stderrBytes,
            stdoutCapped: raw.stdoutBytes > raw.stdout.length,
            stderrCapped: raw.stderrBytes > raw.stderr.length,
          },
        );
        return {
          ok: false,
          error: {
            code: "timeout",
            message: `command exceeded ${effectiveTimeoutMs}ms`,
            retryable: true,
          },
          data: {
            argv: redactedArgvPartial,
            cwd: safe.relative === "" ? "." : safe.relative,
            exitCode: raw.exitCode,
            signal: raw.signal,
            durationMs: raw.durationMs,
            stdout: stdoutP.out,
            stderr: stderrP.out,
            stdoutTruncated: stdoutP.truncated,
            stderrTruncated: stderrP.truncated,
            stdoutBytes: raw.stdoutBytes,
            stderrBytes: raw.stderrBytes,
            logPath: partialLogPath,
            timedOut: true,
          },
          summary: `timed out: ${argv[0]} (${effectiveTimeoutMs}ms) — partial output captured, log at ${partialLogPath}`,
        };
      }
      if (raw.cause === "aborted") {
        const err = new Error("aborted");
        (err as Error & { name: string }).name = "AbortError";
        throw err;
      }

      const stdoutText = redactSecrets(raw.stdout.toString("utf-8"));
      const stderrText = redactSecrets(raw.stderr.toString("utf-8"));
      const stdoutT = truncateForReturn(stdoutText);
      const stderrT = truncateForReturn(stderrText);
      const redactedArgv = argv.map((a) => redactSecrets(a));

      const logPath = await writeRunLog(
        ctx.workspaceRoot,
        ctx.sessionId,
        call.id,
        {
          ts: new Date().toISOString(),
          cwd: safe.relative === "" ? "." : safe.relative,
          argv: redactedArgv,
          exitCode: raw.exitCode,
          signal: raw.signal,
          timedOut: raw.timedOut,
          durationMs: raw.durationMs,
          stdout: stdoutText,
          stderr: stderrText,
          stdoutBytes: raw.stdoutBytes,
          stderrBytes: raw.stderrBytes,
          stdoutCapped: raw.stdoutBytes > raw.stdout.length,
          stderrCapped: raw.stderrBytes > raw.stderr.length,
        },
      );

      const data: RunCommandData = {
        argv: redactedArgv,
        cwd: safe.relative === "" ? "." : safe.relative,
        exitCode: raw.exitCode,
        signal: raw.signal,
        durationMs: raw.durationMs,
        stdout: stdoutT.out,
        stderr: stderrT.out,
        stdoutTruncated: stdoutT.truncated,
        stderrTruncated: stderrT.truncated,
        stdoutBytes: raw.stdoutBytes,
        stderrBytes: raw.stderrBytes,
        logPath,
        timedOut: raw.timedOut,
        readOnly: verdict.kind === "allow",
      };

      const testRun = detectTestRun(data);
      if (testRun !== null) data.testRun = testRun;

      const head = redactedArgv.slice(0, 2).join(" ");
      const summary = `ran \`${head}\` (exit ${raw.exitCode ?? "null"}, ${(raw.durationMs / 1000).toFixed(2)}s) — log at ${logPath}`;

      return { ok: true, data, summary };
    },
  };
}
