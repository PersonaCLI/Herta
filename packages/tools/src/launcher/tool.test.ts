import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LaunchEntry,
  type ServerHost,
  ServerHostError,
  type ServerStatus,
  type ToolCallRequest,
} from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { mkToolContext } from "../testing/tool-context.js";
import { createDevServer, type DevServerData } from "./tool.js";

/** dev_server (ADR 0083 §5–§6): the start judged as run_command would
 *  judge the entry's argv, and run exactly as judged. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(servers: unknown[]): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "herta-devserver-")));
  dirs.push(d);
  writeFileSync(
    join(d, "herta.launch.json"),
    JSON.stringify({ version: 1, servers }),
  );
  return d;
}

class FakeHost implements ServerHost {
  started: LaunchEntry[] = [];
  failWith: ServerHostError | null = null;
  private readonly statuses = new Map<string, ServerStatus>();
  list(): readonly ServerStatus[] {
    return [...this.statuses.values()];
  }
  status(name: string): ServerStatus | null {
    return this.statuses.get(name) ?? null;
  }
  async start(entry: LaunchEntry) {
    if (this.failWith !== null) throw this.failWith;
    this.started.push(entry);
    const status: ServerStatus = {
      name: entry.name,
      state: "ready",
      port: entry.port,
      url: entry.url,
      command: [entry.command, ...entry.args].join(" "),
      by: "banzhuan",
      logPath: `.herta/logs/servers/${entry.name}-1.log`,
    };
    this.statuses.set(entry.name, status);
    return { status, already: false };
  }
  logs(name: string) {
    return this.statuses.has(name)
      ? {
          name,
          text: "VITE ready\n",
          nextByte: 11,
          elidedBytes: 0,
          state: "ready" as const,
        }
      : null;
  }
  async stop(name: string) {
    const s = this.statuses.get(name);
    if (s === undefined) return null;
    const stopped = { ...s, state: "stopped" as const };
    this.statuses.set(name, stopped);
    return stopped;
  }
  async stopAll() {}
}

const call = (id: string, input: unknown): ToolCallRequest => ({
  id,
  tool: "dev_server",
  input,
});

describe("dev_server", () => {
  it("a start is classified as run_command would classify the entry's argv", async () => {
    const ws = workspace([
      { name: "web", command: "npm", args: ["run", "dev"], port: 5173 },
      { name: "tests", command: "npm", args: ["test"], port: 4000 },
      { name: "wipe", command: "rm", args: ["-rf", "/"], port: 4001 },
    ]);
    const { rule } = createDevServer({ host: new FakeHost() });
    const ctx = mkToolContext({ workspaceRoot: ws });
    const web = await rule(call("c1", { action: "start", name: "web" }), ctx);
    expect(web.kind).toBe("ask");
    // The card and an automatic review read the command the start runs.
    expect(web.kind === "ask" ? web.argv : undefined).toEqual([
      "npm",
      "run",
      "dev",
    ]);
    expect(
      (await rule(call("c2", { action: "start", name: "tests" }), ctx)).kind,
    ).toBe("allow");
    expect(
      (await rule(call("c3", { action: "start", name: "wipe" }), ctx)).kind,
    ).toBe("deny");
    expect((await rule(call("c4", { action: "list" }), ctx)).kind).toBe(
      "allow",
    );
    expect(
      (await rule(call("c5", { action: "stop", name: "web" }), ctx)).kind,
    ).toBe("allow");
  });

  it("starts exactly the entry the rule judged, though the file changed since", async () => {
    const ws = workspace([
      { name: "web", command: "npm", args: ["test"], port: 5173 },
    ]);
    const host = new FakeHost();
    const { tool, rule } = createDevServer({ host });
    const ctx = mkToolContext({ workspaceRoot: ws });
    const c = call("c1", { action: "start", name: "web" });
    expect((await rule(c, ctx)).kind).toBe("allow");
    writeFileSync(
      join(ws, "herta.launch.json"),
      JSON.stringify({
        version: 1,
        servers: [
          { name: "web", command: "curl", args: ["evil.example"], port: 5173 },
        ],
      }),
    );
    const r = await tool.run(c, ctx, () => {});
    expect(r.ok).toBe(true);
    expect(host.started.map((e) => [e.command, ...e.args])).toEqual([
      ["npm", "test"],
    ]);
    // A start the rule never saw does not run.
    const unjudged = await tool.run(
      call("c9", { action: "start", name: "web" }),
      ctx,
      () => {},
    );
    expect(unjudged.ok).toBe(false);
    expect(host.started).toHaveLength(1);
  });

  it("no file, or no such entry: says what to write", async () => {
    const empty = mkdtempSync(join(tmpdir(), "herta-devserver-"));
    dirs.push(empty);
    const { tool } = createDevServer({ host: new FakeHost() });
    const none = await tool.run(
      call("c1", { action: "list" }),
      mkToolContext({ workspaceRoot: empty }),
      () => {},
    );
    expect(none.ok).toBe(false);
    expect(none.error?.code).toBe("no_launch_file");
    expect(none.suggestion).toContain("herta.launch.json");
    const ws = workspace([
      { name: "web", command: "npm", args: ["test"], port: 5173 },
    ]);
    const missing = await tool.run(
      call("c2", { action: "start", name: "api" }),
      mkToolContext({ workspaceRoot: ws }),
      () => {},
    );
    expect(missing.error?.code).toBe("no_server_entry");
  });

  it("a failed start carries the end of its log; list, logs and stop report the state", async () => {
    const ws = workspace([
      { name: "web", command: "npm", args: ["test"], port: 5173 },
    ]);
    const host = new FakeHost();
    const { tool, rule } = createDevServer({ host });
    const ctx = mkToolContext({ workspaceRoot: ws });
    host.failWith = new ServerHostError(
      "exited",
      "web exited with code 1 before port 5173 answered",
      "Error: Cannot find module 'vite'",
    );
    const c1 = call("c1", { action: "start", name: "web" });
    await rule(c1, ctx);
    const failed = await tool.run(c1, ctx, () => {});
    expect(failed.error?.code).toBe("server_exited");
    expect(failed.error?.message).toContain("Cannot find module 'vite'");

    host.failWith = null;
    const c2 = call("c2", { action: "start", name: "web" });
    await rule(c2, ctx);
    expect((await tool.run(c2, ctx, () => {})).data).toMatchObject({
      action: "start",
      name: "web",
      already: false,
      url: "http://localhost:5173/",
    });
    const listed = (
      await tool.run(call("c3", { action: "list" }), ctx, () => {})
    ).data as DevServerData | undefined;
    expect(listed?.entries).toEqual([
      {
        name: "web",
        state: "ready",
        url: "http://localhost:5173/",
        command: "npm test",
      },
    ]);
    expect(
      (
        await tool.run(
          call("c4", { action: "logs", name: "web" }),
          ctx,
          () => {},
        )
      ).data,
    ).toMatchObject({ text: "VITE ready\n", nextByte: 11 });
    expect(
      (
        await tool.run(
          call("c5", { action: "stop", name: "web" }),
          ctx,
          () => {},
        )
      ).data,
    ).toMatchObject({ wasRunning: true, state: "stopped" });
    expect(
      tool.summarize?.({ action: "start", name: "web" }, { workspaceRoot: ws }),
    ).toBe("start web");
  });
});
