/**
 * The launcher's contract (ADR 0083 §5): the dev servers a session owns,
 * started from `herta.launch.json` by 板砖 (`dev_server`) or by the
 * Trailblazer (Run). The desktop's main implements it, one per session; the
 * CLI has none. The host runs what it is handed — whether an entry may run
 * at all is the permission rule's to decide, before the host is called
 * (D4): a launcher entry is a convenience, never a permission.
 */

/** One `herta.launch.json` entry, resolved: an argv, never a shell string. */
export interface LaunchEntry {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly port: number;
  /** Absolute, inside the workspace. */
  readonly cwd: string;
  /** Where the page opens once the server answers: a loopback http(s) URL. */
  readonly url: string;
  /** The workspace root, absolute: the logs go under its `.herta/logs/`. */
  readonly workspace: string;
}

/** Who started a server: 板砖's step, or the Trailblazer's Run. */
export type ServerStarter = "banzhuan" | "trailblazer";

export type ServerState =
  /** Spawned, its port not answering yet. */
  | "starting"
  /** Its port answers. */
  | "ready"
  /** It ended on its own. */
  | "exited"
  /** It was stopped. */
  | "stopped";

export interface ServerStatus {
  readonly name: string;
  readonly state: ServerState;
  readonly port: number;
  readonly url: string;
  /** `npm run dev`, as the entry wrote it. */
  readonly command: string;
  readonly by: ServerStarter;
  readonly pid?: number;
  /** The log, workspace-relative (`.herta/logs/servers/web-….log`). */
  readonly logPath: string;
  /** Set once it exited on its own; null when ended by a signal. */
  readonly exitCode?: number | null;
}

export interface ServerStarted {
  readonly status: ServerStatus;
  /** Its port already answered before anything was started — a server the
   *  Trailblazer runs elsewhere, say: nothing was started (§5). */
  readonly already: boolean;
}

export interface ServerLogs {
  readonly name: string;
  /** Redacted output from the cursor on. */
  readonly text: string;
  /** The cursor for the next read. */
  readonly nextByte: number;
  /** Output before the cursor's position that the buffer no longer holds. */
  readonly elidedBytes: number;
  readonly state: ServerState;
  readonly exitCode?: number | null;
}

/**
 * Why a start failed:
 *  - `spawn_failed` — the program could not be started (not found).
 *  - `unsafe_args` — a Windows `.cmd` shim cannot carry an argument safely.
 *  - `exited` — it ended before its port answered.
 *  - `timeout` — its port did not answer within the bound (60 s); stopped.
 *  - `aborted` — the step was stopped while it waited; the server too.
 */
export type ServerFailure =
  | "spawn_failed"
  | "unsafe_args"
  | "exited"
  | "timeout"
  | "aborted";

export class ServerHostError extends Error {
  readonly code: ServerFailure;
  /** The end of its log, redacted, when there is one. */
  readonly tail: string;

  constructor(code: ServerFailure, message: string, tail = "") {
    super(message);
    this.name = "ServerHostError";
    this.code = code;
    this.tail = tail;
  }
}

export interface ServerHost {
  /** The session's servers, running or ended, in start order. */
  list(): readonly ServerStatus[];
  status(name: string): ServerStatus | null;
  /** Start an entry and wait until its port answers (bounded); a port that
   *  already answers starts nothing. Rejects with `ServerHostError`. */
  start(
    entry: LaunchEntry,
    opts: { readonly by: ServerStarter; readonly signal?: AbortSignal },
  ): Promise<ServerStarted>;
  /** Its output from `sinceByte` on, or null for a name never started. */
  logs(name: string, sinceByte: number): ServerLogs | null;
  /** Stop it and everything it started; null for a name never started. */
  stop(name: string): Promise<ServerStatus | null>;
  /** Stop every server (the workspace moved, the session went). */
  stopAll(): Promise<void>;
}

/** The op verbs of `dev_server`'s rows (ADR 0083 §10). */
export type ServerOpVerb =
  | "Starting dev server"
  | "Stopping dev server"
  | "Reading server log"
  | "Listing dev servers";

const SERVER_OP_VERBS: ReadonlySet<string> = new Set<ServerOpVerb>([
  "Starting dev server",
  "Stopping dev server",
  "Reading server log",
  "Listing dev servers",
]);

export function isServerOpVerb(verb: string): verb is ServerOpVerb {
  return SERVER_OP_VERBS.has(verb);
}

/** A `dev_server` call's op verb, from the summary its tool wrote (its
 *  action leads), or null for any other tool. Shared by the projection and
 *  the desktop's live feed; an unknown summary reads as a start. */
export function serverOpVerb(tool: string, summary = ""): ServerOpVerb | null {
  if (tool !== "dev_server") return null;
  const word = /^\S*/.exec(summary)?.[0] ?? "";
  return word === "stop"
    ? "Stopping dev server"
    : word === "logs"
      ? "Reading server log"
      : word === "list"
        ? "Listing dev servers"
        : "Starting dev server";
}

/** A `dev_server` row's argument: the entry's name, the action dropped. */
export function serverOpArg(summary: string): string {
  return summary.trim().replace(/^\S*\s*/, "");
}
