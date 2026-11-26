/**
 * The session's dev servers from the Trailblazer's side (ADR 0083 §5): the
 * launcher's entries with their state, and starting or stopping one from
 * the new-tab page. They were fields and methods of SessionImpl (review
 * 2026-11-10, moved 2026-11-25); the session holds one of these and
 * delegates to it.
 *
 * What a start or a stop leaves in the record goes through the session's
 * `noteServer`, which holds a note until a moment between turns. 板砖's own
 * `dev_server` calls do not come here: they run in the backend's tool.
 */
import { relative } from "node:path";
import { type ServerHost, ServerHostError } from "@herta/core";
import type { ServerNote } from "@herta/herta";
import { entryCommand, makeRunCommandRule, readLaunchFile } from "@herta/tools";
import type {
  ServerEntryView,
  ServerListing,
  StartServerResult,
} from "./types.js";

export class SessionServers {
  /** The session's dev servers (ADR 0083 §5); null without a launcher. */
  private readonly servers: ServerHost | null;
  /** Ask-class launcher entries the Trailblazer confirmed in this session —
   *  by name, argv and directory, so a changed entry asks again. */
  private readonly confirmedServers = new Set<string>();
  /** The session's effective backend workspace: the holder it shares. */
  private readonly wsHolder: { readonly current: string };
  /** A launcher event for the record, held by the session until a
   *  moment between turns. */
  private readonly noteServer: (note: ServerNote) => void;

  constructor(opts: {
    readonly servers: ServerHost | null;
    readonly wsHolder: { readonly current: string };
    readonly noteServer: (note: ServerNote) => void;
  }) {
    this.servers = opts.servers;
    this.wsHolder = opts.wsHolder;
    this.noteServer = opts.noteServer;
  }

  async listServers(): Promise<ServerListing> {
    if (this.servers === null) return { ok: false, reason: "no_launcher" };
    const file = await readLaunchFile(this.wsHolder.current);
    if (!file.ok)
      return { ok: false, reason: file.code, message: file.message };
    const host = this.servers;
    return {
      ok: true,
      entries: file.entries.map((e): ServerEntryView => {
        const st = host.status(e.name);
        return {
          name: e.name,
          command: entryCommand(e),
          port: e.port,
          url: e.url,
          state: st?.state ?? "idle",
          ...(st !== null ? { by: st.by } : {}),
          ...(st !== null && st.logPath !== "" ? { logPath: st.logPath } : {}),
          ...(st?.exitCode !== undefined ? { exitCode: st.exitCode } : {}),
        };
      }),
    };
  }

  async startServer(
    name: string,
    opts: { readonly confirmed?: string } = {},
  ): Promise<StartServerResult> {
    if (this.servers === null) return { ok: false, reason: "no_launcher" };
    const root = this.wsHolder.current;
    const file = await readLaunchFile(root);
    if (!file.ok)
      return { ok: false, reason: file.code, message: file.message };
    const entry = file.entries.find((e) => e.name === name);
    if (entry === undefined) return { ok: false, reason: "no_entry" };
    const command = entryCommand(entry);
    // Classified exactly as run_command would classify this argv in this
    // directory (ADR 0083 §5): 板砖 may have written the file, and a page
    // it read could have steered what it wrote. The Trailblazer's own
    // click answers an ask — never a reviewer (it is their action).
    const verdict = await makeRunCommandRule()(
      {
        id: `run-${name}`,
        tool: "run_command",
        input: {
          argv: [entry.command, ...entry.args],
          cwd: relative(root, entry.cwd) || ".",
        },
      },
      { workspaceRoot: root } as Parameters<
        ReturnType<typeof makeRunCommandRule>
      >[1],
    );
    if (verdict.kind === "deny")
      return { ok: false, reason: "refused", message: verdict.reason };
    const key = [entry.name, entry.command, ...entry.args, entry.cwd].join(
      "\0",
    );
    if (verdict.kind === "ask") {
      // The answer names the card it answers: the file is read again here,
      // and an entry rewritten while the card was open asks again with what
      // it runs now (review 2026-10-30, U2).
      if (opts.confirmed === key) this.confirmedServers.add(key);
      else if (!this.confirmedServers.has(key))
        return {
          ok: false,
          reason: "confirm",
          command,
          ...(verdict.code !== undefined ? { code: verdict.code } : {}),
          shown: key,
        };
    }
    try {
      const started = await this.servers.start(entry, { by: "trailblazer" });
      this.noteServer({
        kind: "started",
        name: entry.name,
        command,
        url: started.status.url,
        already: started.already,
      });
      return { ok: true, already: started.already, url: started.status.url };
    } catch (err) {
      if (!(err instanceof ServerHostError)) throw err;
      return {
        ok: false,
        reason: "failed",
        code: err.code,
        message: err.message,
      };
    }
  }

  async stopServer(name: string): Promise<{ readonly ok: boolean }> {
    if (this.servers === null) return { ok: false };
    const before = this.servers.status(name);
    const running = before?.state === "starting" || before?.state === "ready";
    const after = await this.servers.stop(name);
    if (after === null) return { ok: false };
    if (running) this.noteServer({ kind: "stopped", name });
    return { ok: true };
  }
}
