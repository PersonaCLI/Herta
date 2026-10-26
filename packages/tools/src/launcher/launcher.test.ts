import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LaunchEntry, ServerHostError } from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { entryUrl, readLaunchFile } from "./launch-file.js";
import { Launcher, portAnswers } from "./launcher.js";

/** The launcher (ADR 0083 §5), against real processes on loopback. */

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "herta-launcher-")));
  dirs.push(d);
  return d;
}

/** A port nothing listens on, found by binding and letting go. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A dev server: prints, waits `delayMs`, then serves on its port — or
 *  exits with `exit` instead. */
function plantServer(
  ws: string,
  opts: { delayMs?: number; exit?: number } = {},
): void {
  writeFileSync(
    join(ws, "server.mjs"),
    [
      'import { createServer } from "node:http";',
      "const port = Number(process.argv[2]);",
      'console.log("starting on " + port);',
      'console.log("token=ghp_1234567890abcdefghijklmnopqrstuvwxyz0");',
      opts.exit !== undefined
        ? `console.error("boom: missing config"); process.exit(${opts.exit});`
        : `setTimeout(() => createServer((q, s) => s.end("ok")).listen(port, () => console.log("ready")), ${opts.delayMs ?? 0});`,
      "",
    ].join("\n"),
  );
}

const entryFor = (ws: string, port: number, name = "web"): LaunchEntry => ({
  name,
  command: process.execPath,
  args: ["server.mjs", String(port)],
  port,
  cwd: ws,
  url: `http://localhost:${port}/`,
  workspace: ws,
});

describe("Launcher", () => {
  it("starts an entry, waits until its port answers, logs it redacted, stops it", async () => {
    const ws = workspace();
    plantServer(ws, { delayMs: 400 });
    const port = await freePort();
    const spawned: number[] = [];
    const exited: number[] = [];
    const launcher = new Launcher({
      onSpawn: (s) => spawned.push(s.pid),
      onExit: (pid) => exited.push(pid),
    });
    const started = await launcher.start(entryFor(ws, port), {
      by: "banzhuan",
    });
    expect(started.already).toBe(false);
    expect(started.status.state).toBe("ready");
    expect(started.status.logPath).toMatch(
      /^\.herta\/logs\/servers\/web-\d{8}T\d{6}\.log$/u,
    );
    expect(await portAnswers(port)).toBe(true);
    expect(spawned).toHaveLength(1);

    const read = launcher.logs("web", 0);
    expect(read?.text).toContain("starting on");
    expect(read?.text).not.toContain("ghp_1234567890");
    const again = launcher.logs("web", read?.nextByte ?? 0);
    expect(again?.text).toBe("");

    const stopped = await launcher.stop("web");
    expect(stopped?.state).toBe("stopped");
    expect(exited).toEqual(spawned);
    expect(await portAnswers(port)).toBe(false);
    const log = readFileSync(join(ws, started.status.logPath), "utf8");
    expect(log).toContain("command: ");
    expect(log).toContain("starting on");
    expect(log).not.toContain("ghp_1234567890");
  }, 30_000);

  it("a port that already answers starts nothing", async () => {
    const ws = workspace();
    plantServer(ws);
    const port = await freePort();
    const busy = (await import("node:http")).createServer((_q, s) =>
      s.end("x"),
    );
    await new Promise<void>((r) => busy.listen(port, () => r()));
    servers.push(busy as unknown as Server);
    let spawned = 0;
    const launcher = new Launcher({ onSpawn: () => (spawned += 1) });
    const started = await launcher.start(entryFor(ws, port), {
      by: "banzhuan",
    });
    expect(started.already).toBe(true);
    expect(spawned).toBe(0);
    expect(launcher.list()).toEqual([]);
  });

  it("one that exits before its port answers fails with the end of its log", async () => {
    const ws = workspace();
    plantServer(ws, { exit: 3 });
    const launcher = new Launcher();
    const err = await launcher
      .start(entryFor(ws, await freePort()), { by: "banzhuan" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerHostError);
    expect((err as ServerHostError).code).toBe("exited");
    expect((err as ServerHostError).tail).toContain("boom: missing config");
    expect(launcher.status("web")?.state).toBe("exited");
  }, 30_000);

  it("one that never answers is stopped at the bound", async () => {
    const ws = workspace();
    plantServer(ws, { delayMs: 60_000 });
    const launcher = new Launcher({ readyTimeoutMs: 800 });
    const err = await launcher
      .start(entryFor(ws, await freePort()), { by: "banzhuan" })
      .catch((e: unknown) => e);
    expect((err as ServerHostError).code).toBe("timeout");
    expect(launcher.status("web")?.state).toBe("stopped");
  }, 30_000);

  it("a program that is not there fails to spawn", async () => {
    const ws = workspace();
    const launcher = new Launcher();
    const err = await launcher
      .start(
        {
          ...entryFor(ws, await freePort()),
          command: "herta-no-such-program-xyz",
        },
        { by: "trailblazer" },
      )
      .catch((e: unknown) => e);
    expect((err as ServerHostError).code).toBe("spawn_failed");
  });
});

describe("herta.launch.json", () => {
  it("reads entries: argv, port, cwd inside the workspace, the page's address", async () => {
    const ws = workspace();
    mkdirSync(join(ws, "apps", "web"), { recursive: true });
    writeFileSync(
      join(ws, "herta.launch.json"),
      JSON.stringify({
        version: 1,
        servers: [
          {
            name: "web",
            command: "npm",
            args: ["run", "dev"],
            port: 5173,
            cwd: "apps/web",
          },
          {
            name: "api",
            command: "node",
            args: ["api.mjs"],
            port: 3000,
            url: "/health",
          },
        ],
      }),
    );
    const file = await readLaunchFile(ws);
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect(file.entries.map((e) => [e.name, e.url])).toEqual([
      ["web", "http://localhost:5173/"],
      ["api", "http://localhost:3000/health"],
    ]);
    expect(file.entries[0]?.cwd.endsWith(join("apps", "web"))).toBe(true);
  });

  it("refuses a missing file, a cwd outside, a public url, a duplicate name", async () => {
    const ws = workspace();
    expect(await readLaunchFile(ws)).toMatchObject({
      ok: false,
      code: "no_launch_file",
    });
    const bad = async (servers: unknown[]) => {
      writeFileSync(
        join(ws, "herta.launch.json"),
        JSON.stringify({ version: 1, servers }),
      );
      return readLaunchFile(ws);
    };
    const one = { name: "web", command: "npm", port: 5173 };
    expect(await bad([{ ...one, cwd: "../elsewhere" }])).toMatchObject({
      code: "bad_launch_file",
    });
    expect(await bad([{ ...one, url: "https://example.com/" }])).toMatchObject({
      code: "bad_launch_file",
    });
    expect(await bad([one, one])).toMatchObject({ code: "bad_launch_file" });
    expect(await bad([{ ...one, shell: "npm run dev" }])).toMatchObject({
      code: "bad_launch_file",
    });
    writeFileSync(join(ws, "herta.launch.json"), "{ not json");
    expect(await readLaunchFile(ws)).toMatchObject({ code: "bad_launch_file" });
  });

  it("a url is a path or an address on this machine", () => {
    expect(entryUrl(5173, undefined)).toBe("http://localhost:5173/");
    expect(entryUrl(5173, "/login")).toBe("http://localhost:5173/login");
    expect(entryUrl(5173, "http://127.0.0.1:5173/app")).toBe(
      "http://127.0.0.1:5173/app",
    );
    expect(entryUrl(5173, "http://example.com/")).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")(
  "Launcher — a command that backgrounds its server (Mac findings 2026-10-24, item 9)",
  () => {
    const shEntry = (ws: string, port: number, line: string): LaunchEntry => ({
      ...entryFor(ws, port),
      command: "sh",
      args: ["-c", line],
    });

    it("exits before its port answers: what it left is ended, not left holding the port", async () => {
      const ws = workspace();
      plantServer(ws, { delayMs: 400 });
      const port = await freePort();
      const launcher = new Launcher();
      const err = await launcher
        .start(
          shEntry(
            ws,
            port,
            `"${process.execPath}" server.mjs ${port} > /dev/null 2>&1 &`,
          ),
          { by: "banzhuan" },
        )
        .catch((e: unknown) => e);
      expect((err as ServerHostError).code).toBe("exited");
      await new Promise((r) => setTimeout(r, 900));
      expect(await portAnswers(port)).toBe(false);
    }, 30_000);

    it("answered, then its command exited: stop still ends the server", async () => {
      const ws = workspace();
      plantServer(ws);
      const port = await freePort();
      const launcher = new Launcher();
      await launcher.start(
        shEntry(
          ws,
          port,
          `"${process.execPath}" server.mjs ${port} > /dev/null 2>&1 & sleep 1`,
        ),
        { by: "banzhuan" },
      );
      expect(await portAnswers(port)).toBe(true);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(launcher.status("web")?.state).toBe("exited");
      expect(await portAnswers(port)).toBe(true);
      await launcher.stopAll();
      await new Promise((r) => setTimeout(r, 200));
      expect(await portAnswers(port)).toBe(false);
    }, 30_000);
  },
);
