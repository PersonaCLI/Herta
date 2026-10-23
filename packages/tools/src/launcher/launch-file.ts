import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isLoopbackUrl, type LaunchEntry } from "@herta/core";
import { z } from "zod";
import { formatInputIssues } from "../input-issues.js";
import { resolveSafePath } from "../path-safety.js";

/**
 * `herta.launch.json` at the workspace root (ADR 0083 §5, question 7): the
 * project's dev servers, as the team commits them and as 板砖 may draft
 * them. Project knowledge, not harness state, which is why it is not under
 * `.herta`. An existing `.claude/launch.json` is not read.
 *
 * ```json
 * { "version": 1,
 *   "servers": [ { "name": "web", "command": "npm", "args": ["run", "dev"],
 *                  "port": 5173, "cwd": "apps/web" } ] }
 * ```
 *
 * The file grants nothing: every start classifies the entry's argv as
 * `run_command` would.
 */
export const LAUNCH_FILE = "herta.launch.json";

/** What `dev_server` says to write when there is no file, or a bad one. */
export const LAUNCH_FILE_EXAMPLE =
  '{ "version": 1, "servers": [ { "name": "web", "command": "npm", "args": ["run", "dev"], "port": 5173 } ] }';

const entrySchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u,
        "a short name: letters, digits, . _ -",
      ),
    command: z.string().min(1).max(512),
    args: z.array(z.string().max(2048)).max(64).optional(),
    port: z.number().int().min(1).max(65535),
    cwd: z.string().min(1).max(1024).optional(),
    url: z.string().min(1).max(2048).optional(),
  })
  .strict();

const fileSchema = z
  .object({
    version: z.literal(1),
    servers: z.array(entrySchema).max(32),
  })
  .strict();

export type LaunchFileResult =
  | { readonly ok: true; readonly entries: readonly LaunchEntry[] }
  | {
      readonly ok: false;
      readonly code: "no_launch_file" | "bad_launch_file";
      readonly message: string;
    };

/** Where an entry's page opens: its `url` (a path, or a loopback address),
 *  or the root of its port. Null for a `url` that is not on this machine. */
export function entryUrl(port: number, url: string | undefined): string | null {
  if (url === undefined) return `http://localhost:${port}/`;
  if (url.startsWith("/")) return `http://localhost:${port}${url}`;
  return isLoopbackUrl(url) && url !== "about:blank" ? url : null;
}

/**
 * The workspace's launch entries, resolved: `cwd` inside the workspace,
 * the page's address on this machine, names unique. Read fresh each time —
 * 板砖 may have just written the file.
 */
export async function readLaunchFile(
  workspaceRoot: string,
): Promise<LaunchFileResult> {
  let raw: string;
  try {
    raw = await readFile(join(workspaceRoot, LAUNCH_FILE), "utf8");
  } catch {
    return {
      ok: false,
      code: "no_launch_file",
      message: `no ${LAUNCH_FILE} at the workspace root`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      code: "bad_launch_file",
      message: `${LAUNCH_FILE} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      code: "bad_launch_file",
      message: `${LAUNCH_FILE}: ${formatInputIssues(parsed.error)}`,
    };
  }
  const entries: LaunchEntry[] = [];
  const seen = new Set<string>();
  for (const e of parsed.data.servers) {
    if (seen.has(e.name)) {
      return {
        ok: false,
        code: "bad_launch_file",
        message: `${LAUNCH_FILE}: two servers are named ${e.name}`,
      };
    }
    seen.add(e.name);
    const cwd = await resolveSafePath(workspaceRoot, e.cwd ?? ".");
    if (!cwd.ok) {
      return {
        ok: false,
        code: "bad_launch_file",
        message: `${LAUNCH_FILE}: ${e.name}'s cwd: ${cwd.message}`,
      };
    }
    const url = entryUrl(e.port, e.url);
    if (url === null) {
      return {
        ok: false,
        code: "bad_launch_file",
        message: `${LAUNCH_FILE}: ${e.name}'s url must be a path or an address on this machine`,
      };
    }
    entries.push({
      name: e.name,
      command: e.command,
      args: e.args ?? [],
      port: e.port,
      cwd: cwd.resolved,
      url,
      workspace: workspaceRoot,
    });
  }
  return { ok: true, entries };
}

/** `npm run dev`: an entry's argv as one line, for rows and cards. */
export function entryCommand(entry: {
  readonly command: string;
  readonly args: readonly string[];
}): string {
  return [entry.command, ...entry.args]
    .map((a) => (/\s/u.test(a) ? JSON.stringify(a) : a))
    .join(" ");
}
