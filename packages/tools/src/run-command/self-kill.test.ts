import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  type AgentEvent,
  BackgroundHost,
  InMemoryEventBus,
  NoopMemoryManager,
  ReadLedger,
} from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { makeBashRule } from "../bash/rule.js";
import { classifyShellCommandDetailed } from "../bash/shell-classifier.js";
import { makeMsysPaths, type ShellPaths } from "../bash/shell-paths.js";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { classifyCommand } from "./classifier.js";
import { makeRunCommandRule } from "./rule.js";
import {
  type HostIdentity,
  type HostProcess,
  hostIdentity,
  registerHostHelperPids,
  selfKillDenial,
} from "./self-kill.js";

/** The CLI on Windows: node.exe at 4242, started by a shell at 4100, with
 *  one helper of the same program at 4300. */
const PROCESSES: readonly HostProcess[] = [
  {
    pid: 4242,
    self: true,
    name: "node.exe",
    ppid: 4100,
    commandLine: "C:\\Program Files\\nodejs\\node.exe C:\\apps\\herta\\cli.js",
  },
  { pid: 4100 },
  { pid: 4300, name: "node.exe" },
];
const host: HostIdentity = { processes: () => PROCESSES };

const verdict = (argv: string[]) => classifyCommand(argv, { host });

describe("a kill aimed at the app itself is blocked (2026-11-04)", () => {
  it("by pid, its parent's pid, a helper's pid, or a group it leads", () => {
    for (const argv of [
      ["kill", "4242"],
      ["kill", "-9", "4242"],
      ["kill", "-s", "KILL", "4242"],
      ["kill", "--", "-4242"],
      ["kill", "4100"],
      ["kill", "4300"],
      ["taskkill", "/PID", "4242", "/F"],
      ["taskkill", "//PID", "4100", "//T", "//F"],
      ["taskkill", "-pid", "4300"],
      ["tskill", "4242"],
      ["sudo", "kill", "-9", "4242"],
    ]) {
      const v = verdict(argv);
      expect(v.kind, argv.join(" ")).toBe("block");
    }
  });

  it("by the program name it runs as, a wildcard of it, or a pattern that matches it", () => {
    for (const argv of [
      ["taskkill", "/F", "/IM", "node.exe"],
      ["taskkill", "//F", "//IM", "node.exe"],
      ["taskkill", "/F", "/IM", "NODE.EXE"],
      ["taskkill", "/F", "/IM", "no*"],
      ["taskkill", "/F", "/FI", "IMAGENAME eq node.exe"],
      ["pkill", "node"],
      ["pkill", "-9", "nod"],
      ["pkill", "-x", "node"],
      ["pkill", "-f", "herta"],
      ["pkill", "-f", "cli\\.js"],
      ["killall", "node"],
      ["killall", "-9", "node"],
      ["tskill", "node"],
    ]) {
      expect(verdict(argv).kind, argv.join(" ")).toBe("block");
    }
  });

  it("every process of a user, or one a filter alone chooses", () => {
    for (const argv of [
      ["kill", "-9", "-1"],
      ["kill", "--", "-1"],
      ["pkill", "-u", "robin"],
      ["pkill", "--euid=robin"],
      ["killall", "-u", "robin"],
      ["taskkill", "/F", "/FI", "USERNAME eq robin"],
      ["pkill", "-v", "python"],
    ]) {
      expect(verdict(argv).kind, argv.join(" ")).toBe("block");
    }
  });

  it("the children of its parent, the app among them", () => {
    expect(verdict(["pkill", "-P", "4100"]).kind).toBe("block");
    expect(verdict(["pkill", "-P", "4100", "python"]).kind).toBe("ask");
  });

  it("through PowerShell's Stop-Process, and its `kill` alias", () => {
    for (const argv of [
      ["Stop-Process", "-Id", "4242"],
      ["Stop-Process", "4242", "-Force"],
      ["Stop-Process", "-Force", "4242"],
      ["Stop-Process", "-Name", "node"],
      ["Stop-Process", "-n", "no*"],
      ["Stop-Process", "-ProcessName", "python,", "node"],
      ["spps", "-Id", "1,4300"],
      ["kill", "-Name", "node", "-Force"],
    ]) {
      expect(verdict(argv).kind, argv.join(" ")).toBe("block");
    }
  });

  it("inside a body handed to another shell", () => {
    for (const argv of [
      ["cmd", "/c", "taskkill /F /IM node.exe"],
      ["cmd.exe", "/d", "/s", "/c", "echo bye & taskkill /PID 4242 /F"],
      ["powershell", "-Command", "Stop-Process -Name node -Force"],
      ["pwsh", "-NoProfile", "-Command", "Stop-Process 4242"],
      ["bash", "-c", "sleep 1; kill -9 4242"],
      ["sh", "-c", "kill $PPID"],
    ]) {
      expect(verdict(argv).kind, argv.join(" ")).toBe("block");
    }
  });

  it("the refusal names the process and a move that serves the purpose", () => {
    const byName = verdict(["taskkill", "/F", "/IM", "node.exe"]);
    expect(byName.kind).toBe("block");
    if (byName.kind !== "block") return;
    expect(byName.reason).toContain("pid 4242, node.exe");
    expect(byName.reason).toContain("no approval can allow it");
    expect(byName.suggestion).toContain("by its own pid");
    const byPid = verdict(["kill", "4100"]);
    if (byPid.kind !== "block") throw new Error("not blocked");
    expect(byPid.reason).toContain("the process that started this app");
    expect(byPid.suggestion).toContain("that pid belongs to this app");
  });
});

describe("a kill of anything else asks as before (2026-11-04)", () => {
  it("other pids, names, users' filters and machines", () => {
    for (const argv of [
      ["kill", "574"],
      ["kill", "-9", "574", "575"],
      ["kill", "-n", "9", "574"],
      ["kill", "%1"],
      ["kill", "0"],
      ["taskkill", "/PID", "9999", "/F"],
      ["taskkill", "/F", "/IM", "python.exe"],
      ["taskkill", "/F", "/FI", "IMAGENAME eq python.exe"],
      ["taskkill", "/S", "buildbox", "/IM", "node.exe"],
      ["taskkill", "/F", "/IM", "node.exe", "/FI", "PID gt 5000"],
      ["pkill", "-f", "vite"],
      ["pkill", "python"],
      ["pkill", "-x", "nod"],
      ["killall", "python3"],
      ["killall", "nod"],
      ["Stop-Process", "-Id", "574"],
      ["Stop-Process", "-Name", "python"],
      ["tskill", "python"],
      ["cmd", "/c", "taskkill /F /IM python.exe"],
    ]) {
      const v = verdict(argv);
      expect(v.kind, argv.join(" ")).toBe("ask");
    }
  });

  it("lines that end nothing are not judged as kills", () => {
    // `kill -l` lists signals; `-WhatIf` only says what Stop-Process would do.
    expect(verdict(["kill", "-l"]).kind).not.toBe("block");
    expect(verdict(["Stop-Process", "-Name", "node", "-WhatIf"]).kind).not.toBe(
      "block",
    );
    // Under run_command nothing expands `$PPID`: it is a literal word.
    expect(verdict(["kill", "$PPID"]).kind).toBe("ask");
  });

  it("with no host passed, the classifier judges no kill as the app's", () => {
    expect(classifyCommand(["taskkill", "/F", "/IM", "node.exe"]).kind).toBe(
      "ask",
    );
  });
});

const WS = process.platform === "win32" ? "E:\\repo" : "/home/u/repo";
const paths: ShellPaths =
  process.platform === "win32"
    ? makeMsysPaths("C:\\Users\\u\\AppData\\Local\\Temp")
    : {
        toNative: (p) => (p.startsWith("/") ? p : null),
        toShell: (p) => p,
        tmpNative: null,
      };
const shellVerdict = (line: string) =>
  classifyShellCommandDetailed(line, { workspaceRoot: WS, paths, host })
    .verdict;

describe("the bash contract's lines (2026-11-04)", () => {
  it("`$PPID` in the persistent shell is the app; `$$` is the shell itself", () => {
    expect(shellVerdict("kill -9 $PPID").kind).toBe("block");
    expect(shellVerdict('kill "$PPID"').kind).toBe("block");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own `${PPID}`, not a template
    expect(shellVerdict("kill ${PPID}").kind).toBe("block");
    expect(shellVerdict("kill $$").kind).toBe("ask");
  });

  it("any segment of a chained line, the refusal's suggestion kept", () => {
    const v = shellVerdict("npm run build && taskkill //F //IM node.exe");
    expect(v.kind).toBe("block");
    expect(v.kind === "block" ? v.suggestion : "").toContain("by its own pid");
    expect(shellVerdict("sleep 1; kill 574").kind).toBe("ask");
  });
});

describe("nothing a line says reaches a regular expression (review 2026-11-05)", () => {
  /** One process, so a table can name it. */
  const named = (name: string, commandLine = name): HostIdentity => ({
    processes: () => [{ pid: 4242, self: true, name, ppid: 4100, commandLine }],
  });
  const denied = (argv: string[], who: HostIdentity): boolean =>
    selfKillDenial(argv, who, false) !== null;

  /** The classifier is synchronous on the main thread. This command line is
   *  short on purpose: a backtracking engine spends seconds on it and fails
   *  the test, where on the app's real one it never comes back and the test
   *  run would hang with it. */
  const short = named("node.exe", "a".repeat(26));

  it("a line built to backtrack answers at once", () => {
    const started = performance.now();
    const verdicts = [
      ["pkill", "-f", "(.+)+X"],
      ["taskkill", "/IM", `${"*".repeat(24)}b`],
      ["taskkill", "/FI", `PID eq ${" ".repeat(1600)}\nx\ny`],
    ].map((argv) => classifyCommand(argv, { host: short }).kind);
    expect(performance.now() - started).toBeLessThan(1000);
    // Nobody can tell what the pattern selects; a filter it cannot read
    // lets every process through, the app's own included.
    expect(verdicts).toEqual(["ask", "ask", "block"]);
  });

  it("the bash contract's line asks too", () => {
    const started = performance.now();
    const v = classifyShellCommandDetailed("sudo pkill -f '(.+)+X'", {
      workspaceRoot: WS,
      paths,
      host: short,
    }).verdict;
    expect(performance.now() - started).toBeLessThan(1000);
    expect(v.kind).toBe("ask");
  });

  it("what a kill is usually written with still reads", () => {
    for (const argv of [
      ["pkill", "-x", "node.exe"],
      ["pkill", "-f", "node.exe"],
      ["pkill", "-f", "node.*cli"],
      ["pkill", "-f", "nodejs.+cli\\.js$"],
      ["pkill", "^node$"],
      ["pkill", "-f", "vite|herta"],
      ["pkill", "-i", "NODE"],
      ["pkill", "."],
      ["pkill", ""],
      ["killall", "-r", "no.*"],
      ["killall", "-r", "vite|node"],
      ["killall", "-I", "NODE"],
      ["taskkill", "/IM", "N?DE*"],
      ["taskkill", "/IM", "*.exe"],
      ["Stop-Process", "-Name", "no*"],
      ["tskill", "no*"],
    ]) {
      expect(verdict(argv).kind, argv.join(" ")).toBe("block");
    }
    for (const argv of [
      ["pkill", "-f", "vite|webpack"],
      ["pkill", "-x", "no.e.ex"],
      ["pkill", "-f", "^vite"],
      ["pkill", "^ode"],
      ["pkill", "nod$"],
      ["pkill", "node\\.py"],
      ["pkill", "-f", "a\\|node"],
      ["killall", "no.*"],
      ["killall", "-r", "^ode"],
      ["taskkill", "/IM", "n?de.py"],
    ]) {
      expect(verdict(argv).kind, argv.join(" ")).toBe("ask");
    }
  });

  it("a pattern a glob cannot say asks, whatever it would match", () => {
    for (const argv of [
      ["pkill", "[n]ode"],
      ["pkill", "no(de)"],
      ["pkill", "nod+e"],
      ["pkill", "node?"],
      ["pkill", "n.?de"],
      ["pkill", "n.{2}e"],
      ["pkill", "\\bnode"],
      ["pkill", "node\\"],
      ["pkill", "-v", "[p]ython"],
      ["pkill", "-f", `${"a|".repeat(1000)}node`],
      ["killall", "-r", "[n]ode"],
    ]) {
      expect(verdict(argv).kind, argv.join(" ")).toBe("ask");
    }
  });

  it("reads a pattern as the program would, against a real engine", () => {
    const patterns = [
      "node",
      "^node",
      "node$",
      "^node$",
      "n.de",
      "n.*e",
      "n.+e",
      "no.*de$",
      ".*",
      ".+",
      ".",
      "",
      "a|node",
      "x|y",
      "^x|e$",
      "no\\.de",
      "^$",
    ];
    const names = ["node", "no.de", "xnodex", "ne", "n", ""];
    for (const pattern of patterns) {
      for (const name of names) {
        const who = named(name);
        const label = `${pattern} on ${name}`;
        expect(denied(["pkill", pattern], who), label).toBe(
          new RegExp(pattern).test(name),
        );
        expect(denied(["pkill", "-x", pattern], who), `-x ${label}`).toBe(
          new RegExp(`^(?:${pattern})$`).test(name),
        );
        expect(denied(["pkill", "-if", pattern.toUpperCase(), "--"], who)).toBe(
          new RegExp(pattern.toUpperCase(), "i").test(name),
        );
      }
    }
    const wildcards = [
      "*",
      "?",
      "n*",
      "*e",
      "n?de",
      "*o*e",
      "**",
      "n*d*",
      "?*",
    ];
    for (const wild of [...wildcards, "NODE", "*.DE", "no.d?"]) {
      for (const name of names) {
        const source = wild
          .replace(/\./g, "\\.")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".");
        expect(
          denied(["taskkill", "/IM", wild], named(name)),
          `${wild} on ${name}`,
        ).toBe(new RegExp(`^${source}$`, "i").test(name));
      }
    }
  });

  it("the file builds no RegExp at all", async () => {
    const source = await readFile(
      new URL("./self-kill.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/new RegExp|RegExp\(/);
  });
});

describe("hostIdentity — this process, its parent, the desktop's helpers", () => {
  afterEach(() => registerHostHelperPids(() => []));

  it("lists its own pid and program name, and its parent's pid", () => {
    const procs = hostIdentity().processes();
    const own = procs.find((p) => p.self === true);
    expect(own?.pid).toBe(process.pid);
    expect(own?.name).toBe(basename(process.execPath));
    expect(own?.ppid).toBe(process.ppid);
    expect(procs.some((p) => p.pid === process.ppid)).toBe(true);
  });

  it("adds the helpers the desktop registers, and survives a list that throws", () => {
    registerHostHelperPids(() => [process.pid, 999_001, 999_002]);
    const pids = hostIdentity()
      .processes()
      .map((p) => p.pid);
    expect(pids.filter((p) => p === process.pid)).toHaveLength(1);
    expect(pids).toContain(999_001);
    expect(pids).toContain(999_002);
    registerHostHelperPids(() => {
      throw new Error("metrics unavailable");
    });
    expect(
      hostIdentity()
        .processes()
        .some((p) => p.self === true),
    ).toBe(true);
  });
});

describe("the rules refuse it with no card, and say what to do (2026-11-04)", () => {
  let ws: TmpWorkspace;
  afterEach(async () => {
    if (ws) await ws.cleanup();
  });
  const ctxFor = (workspaceRoot: string) => ({
    sessionId: "s",
    signal: new AbortController().signal,
    workspaceRoot,
    reads: new ReadLedger(),
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    memory: new NoopMemoryManager(),
  });

  it("run_command: this test process's own pid and program name", async () => {
    ws = await mkTmpWorkspace({});
    const rule = makeRunCommandRule();
    const call = (argv: string[]) => ({
      id: "c1",
      tool: "run_command",
      input: { argv },
    });
    for (const argv of [
      ["taskkill", "/F", "/IM", basename(process.execPath)],
      ["kill", "-9", String(process.pid)],
    ]) {
      const v = await rule(call(argv), ctxFor(ws.root));
      expect(v.kind, argv.join(" ")).toBe("deny");
      if (v.kind !== "deny") continue;
      expect(v.code).toBe("command_blocked");
      expect(v.suggestion).toBeDefined();
    }
    // Anti-vacuous: another pid still asks.
    expect((await rule(call(["kill", "574"]), ctxFor(ws.root))).kind).toBe(
      "ask",
    );
  });

  it("bash: `kill $PPID` from the persistent shell", async () => {
    ws = await mkTmpWorkspace({});
    const rule = makeBashRule({ bashPath: null });
    const v = await rule(
      { id: "c1", tool: "bash", input: { command: "kill -9 $PPID" } },
      ctxFor(ws.root),
    );
    expect(v.kind).toBe("deny");
    expect(v.kind === "deny" ? v.suggestion : undefined).toBeDefined();
  });
});
