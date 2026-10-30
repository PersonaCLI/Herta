import { relative } from "node:path";
import {
  type HertaTool,
  type LaunchEntry,
  type PermissionRule,
  type RulePermissionEngine,
  type ServerHost,
  ServerHostError,
  type ServerState,
  type ToolCallRequest,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from "@herta/core";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { errResult } from "../errors.js";
import { formatInputIssues } from "../input-issues.js";
import { redactSecrets } from "../run-command/redactor.js";
import { makeRunCommandRule } from "../run-command/rule.js";
import {
  entryCommand,
  LAUNCH_FILE,
  LAUNCH_FILE_EXAMPLE,
  readLaunchFile,
} from "./launch-file.js";

export const devServerInputSchema = z
  .object({
    action: z
      .enum(["list", "start", "logs", "stop"])
      .describe(
        "list: the servers herta.launch.json names and which run. start: start one and wait until its port answers. logs: read its output. stop: stop it.",
      ),
    name: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe(
        "The entry's name in herta.launch.json, as dev_server list shows it (start, logs, stop) — not its npm script's: an entry named web may run npm run dev.",
      ),
    sinceByte: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "logs only: read past this cursor — the previous read's nextByte.",
      ),
  })
  .strict();

export const devServerJsonSchema = zodToJsonSchema(devServerInputSchema);

export interface DevServerData {
  readonly action: "list" | "start" | "logs" | "stop";
  readonly name?: string;
  /** start: `npm run dev`. */
  readonly command?: string;
  /** start: where it answers. */
  readonly url?: string;
  /** start: its port answered before anything was started. */
  readonly already?: boolean;
  readonly logPath?: string;
  /** logs and stop: its state now. */
  readonly state?: ServerState;
  readonly exitCode?: number | null;
  /** stop: it was running. */
  readonly wasRunning?: boolean;
  /** logs: the output read, redacted. */
  readonly text?: string;
  readonly nextByte?: number;
  /** list. */
  readonly entries?: readonly {
    readonly name: string;
    readonly state: ServerState | "idle";
    readonly url: string;
    readonly command: string;
  }[];
}

const FAILURE: Record<ServerHostError["code"], string> = {
  spawn_failed: "server_spawn_failed",
  unsafe_args: "unsafe_shim_arg",
  exited: "server_exited",
  timeout: "server_timeout",
  aborted: "server_aborted",
};

const SUGGESTION: Record<ServerHostError["code"], string> = {
  spawn_failed:
    "Check the entry's command in herta.launch.json: the program must be installed and on PATH (run npm install first if it is a project script).",
  unsafe_args:
    "Rewrite the entry's args without & | < > ^ % ! \" — they cannot pass through a Windows .cmd shim safely.",
  exited:
    "Read why in its log (dev_server logs, or the log path), fix the cause, then start it again.",
  timeout:
    "Read its log (dev_server logs): check the entry's port matches the one the server prints, or what it waits for.",
  aborted: "Start it again when it is wanted.",
};

const noFile = (code: "no_launch_file" | "bad_launch_file", message: string) =>
  errResult<DevServerData>(
    code,
    message,
    code === "no_launch_file"
      ? `Write ${LAUNCH_FILE} at the workspace root, e.g. ${LAUNCH_FILE_EXAMPLE} — the command as argv, the port it serves on, and cwd if it is not the root.`
      : `Fix ${LAUNCH_FILE}: ${LAUNCH_FILE_EXAMPLE}`,
  );

/** What one `logs` read shows the model (§6: results are bounded). The ring
 *  holds 256K, and a chatty server's first read sent all of it (review
 *  2026-10-30); the newest output is where a server's error is. */
const MODEL_LOG_CHARS = 8_000;

/** The newest whole lines of `text` within `max` chars. */
function newestLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = text.slice(-max);
  const nl = tail.indexOf("\n");
  return nl >= 0 && nl < tail.length - 1 ? tail.slice(nl + 1) : tail;
}

/**
 * The launcher's step for 板砖 (ADR 0083 §5–§6): list, start, read the logs
 * of and stop the dev servers `herta.launch.json` names, by name. A start
 * runs exactly the entry its rule judged (`registerDevServerRule`), so an
 * edit to the file between the card and the start cannot swap the command.
 */
export function createDevServer(opts: { readonly host: ServerHost }): {
  readonly tool: HertaTool;
  readonly rule: PermissionRule;
} {
  /** Entries the rule judged, by call — what the start runs. */
  const judged = new Map<string, LaunchEntry>();
  const keep = (id: string, entry: LaunchEntry): void => {
    judged.set(id, entry);
    // A denied call never runs; the oldest judgments go.
    while (judged.size > 32) {
      const first = judged.keys().next().value;
      if (first === undefined) break;
      judged.delete(first);
    }
  };

  const rule: PermissionRule = async (call, ctx) => {
    const parsed = devServerInputSchema.safeParse(call.input);
    if (!parsed.success)
      return {
        kind: "deny",
        code: "invalid_input",
        reason: formatInputIssues(parsed.error),
      };
    if (parsed.data.action !== "start") return { kind: "allow" };
    const file = await readLaunchFile(ctx.workspaceRoot);
    // The step itself reports a missing or bad file, with what to write.
    if (!file.ok) return { kind: "allow" };
    const entry = file.entries.find((e) => e.name === parsed.data.name);
    if (entry === undefined) return { kind: "allow" };
    // Classified exactly as run_command would classify the same argv in
    // the same directory (§5): a launcher entry is never a permission.
    const verdict = await makeRunCommandRule()(
      {
        ...call,
        tool: "run_command",
        input: {
          argv: [entry.command, ...entry.args],
          cwd: relative(ctx.workspaceRoot, entry.cwd) || ".",
        },
      },
      ctx,
    );
    if (verdict.kind === "deny") return verdict;
    keep(call.id, entry);
    // The card and an automatic review read the command from here.
    return verdict.kind === "ask"
      ? { ...verdict, argv: [entry.command, ...entry.args] }
      : verdict;
  };

  const tool: HertaTool = {
    name: "dev_server",
    readOnly: false,
    schema(): ToolSchema {
      return {
        name: "dev_server",
        description:
          "The app's dev servers, as herta.launch.json at the workspace root names them: list them, start one (waits until its port answers, up to 60 s; a port that already answers is used as it is), read its logs, stop it. The session owns what it starts: the servers keep running across your runs and stop with the session. Start a server rather than running a dev server through the shell. Open its page with browser_navigate.",
        inputSchema: devServerJsonSchema,
      };
    },
    summarize(input: unknown): string | undefined {
      const i = input as { action?: unknown; name?: unknown } | undefined;
      if (typeof i?.action !== "string") return undefined;
      return typeof i.name === "string" ? `${i.action} ${i.name}` : i.action;
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<DevServerData>> {
      const parsed = devServerInputSchema.safeParse(call.input);
      if (!parsed.success)
        return errResult(
          "invalid_input",
          formatInputIssues(parsed.error),
          "usage: {action: list} or {action: start|logs|stop, name}",
        );
      const { action, name, sinceByte } = parsed.data;
      if (action !== "list" && name === undefined)
        return errResult(
          "invalid_input",
          `${action} needs a name`,
          "Give the server's name from herta.launch.json (dev_server list shows them).",
        );
      const server = name as string;

      switch (action) {
        case "list": {
          const file = await readLaunchFile(ctx.workspaceRoot);
          if (!file.ok) return noFile(file.code, file.message);
          const entries = file.entries.map((e) => {
            const st = opts.host.status(e.name);
            return {
              name: e.name,
              state: st?.state ?? ("idle" as const),
              url: e.url,
              command: entryCommand(e),
            };
          });
          return {
            ok: true,
            data: { action, entries },
            summary: `${entries.length} dev server${entries.length === 1 ? "" : "s"}`,
            modelText: [
              `dev_server list — ${LAUNCH_FILE}:`,
              ...entries.map(
                (e) =>
                  `- ${e.name}: ${e.command} → ${e.url} — ${e.state === "idle" ? "not started" : e.state}`,
              ),
            ].join("\n"),
          };
        }
        case "start": {
          const entry = judged.get(call.id);
          judged.delete(call.id);
          if (entry === undefined) {
            const file = await readLaunchFile(ctx.workspaceRoot);
            if (!file.ok) return noFile(file.code, file.message);
            if (!file.entries.some((e) => e.name === server))
              return errResult(
                "no_server_entry",
                `${LAUNCH_FILE} names no server ${server}`,
                file.entries.length === 0
                  ? `${LAUNCH_FILE} names no servers yet: add an entry, e.g. ${LAUNCH_FILE_EXAMPLE}`
                  : `Use an entry's own name: ${file.entries.map((e) => `${e.name} (${entryCommand(e)})`).join(", ")}. Or add an entry for ${server}.`,
              );
            // The rule judges every start; a start it never saw does not run.
            return errResult(
              "permission_failed",
              `the start of ${server} was not judged`,
              "Call dev_server start again.",
            );
          }
          try {
            const started = await opts.host.start(entry, {
              by: "banzhuan",
              signal: ctx.signal,
            });
            const st = started.status;
            return {
              ok: true,
              data: {
                action,
                name: entry.name,
                command: st.command,
                url: st.url,
                already: started.already,
                ...(st.logPath !== "" ? { logPath: st.logPath } : {}),
              },
              summary: started.already
                ? `${entry.name} already answers at ${st.url}`
                : `${entry.name} ready at ${st.url}`,
              modelText: started.already
                ? `dev_server start ${entry.name}: port ${entry.port} already answers — a server is running there${st.logPath !== "" ? ` (started this session; log ${st.logPath})` : ", not started by Herta, so there is no log here"}. Nothing was started. Open ${st.url} with browser_navigate.`
                : `dev_server start ${entry.name}: ready at ${st.url} (log ${st.logPath}). Open it with browser_navigate.`,
            };
          } catch (err) {
            if (!(err instanceof ServerHostError)) throw err;
            const last = err.tail.trim().split("\n").slice(-3).join(" ⏎ ");
            return {
              ...errResult<DevServerData>(
                FAILURE[err.code],
                `${redactSecrets(err.message)}${last !== "" ? ` — last output: ${last.slice(-300)}` : ""}`,
                SUGGESTION[err.code],
              ),
              ...(err.tail !== ""
                ? {
                    modelText: `dev_server start ${entry.name} failed: ${FAILURE[err.code]}: ${err.message}\nThe end of its log:\n${err.tail}`,
                  }
                : {}),
            };
          }
        }
        case "logs": {
          const read = opts.host.logs(server, sinceByte ?? 0);
          if (read === null)
            return errResult(
              "server_not_running",
              `${server} has not been started this session`,
              "Start it with dev_server start; dev_server list shows what runs.",
            );
          const text = redactSecrets(read.text);
          const shown = newestLines(text, MODEL_LOG_CHARS);
          const skipped = text.length - shown.length;
          const logPath = opts.host.status(server)?.logPath ?? "";
          return {
            ok: true,
            data: {
              action,
              name: server,
              state: read.state,
              ...(read.exitCode !== undefined
                ? { exitCode: read.exitCode }
                : {}),
              text,
              nextByte: read.nextByte,
            },
            summary: `${server} ${read.state} — ${text.length} new chars`,
            modelText: [
              `dev_server logs ${server} — ${read.state}${read.exitCode != null ? ` (exit ${read.exitCode})` : ""}; nextByte ${read.nextByte}${read.elidedBytes > 0 ? ` (${read.elidedBytes} earlier chars rolled off)` : ""}`,
              ...(skipped > 0
                ? [
                    `The newest ${shown.length} chars; the ${skipped} before them${logPath !== "" ? ` are in ${logPath}` : " are not shown"}.`,
                  ]
                : []),
              text === "" ? "(no new output)" : shown,
            ].join("\n"),
          };
        }
        case "stop": {
          const before = opts.host.status(server);
          const wasRunning =
            before?.state === "starting" || before?.state === "ready";
          const after = await opts.host.stop(server);
          if (after === null)
            return errResult(
              "server_not_running",
              `${server} has not been started this session`,
              "dev_server list shows what runs.",
            );
          return {
            ok: true,
            data: { action, name: server, state: after.state, wasRunning },
            summary: wasRunning
              ? `${server} stopped`
              : `${server} was not running`,
            modelText: wasRunning
              ? `dev_server stop ${server}: stopped.`
              : `dev_server stop ${server}: it was not running (${after.state}).`,
          };
        }
      }
    },
  };
  return { tool, rule };
}

/** Mount `dev_server` with its rule (ADR 0083 §5): the start classified as
 *  run_command would classify the entry's argv; list, logs and stop free. */
export function registerDevServer(
  engine: RulePermissionEngine,
  register: (tool: HertaTool) => void,
  host: ServerHost,
): void {
  const { tool, rule } = createDevServer({ host });
  register(tool);
  engine.registerRule("dev_server", rule);
}
