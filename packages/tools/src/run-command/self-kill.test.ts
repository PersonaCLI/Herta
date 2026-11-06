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
import { classifyCommand, pipedKills } from "./classifier.js";
import { makeRunCommandRule } from "./rule.js";
import {
  type HostIdentity,
  type HostProcess,
  helperNames,
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
    user: "trailblazer",
    uid: 1000,
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
      ["pkill", "-u", "trailblazer"],
      ["pkill", "--euid=trailblazer"],
      ["killall", "-u", "trailblazer"],
      ["taskkill", "/F", "/FI", "USERNAME eq trailblazer"],
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
    // Nobody can tell what the pattern selects, or what that filter does.
    expect(verdicts).toEqual(["ask", "ask", "ask"]);
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

describe("what cannot touch the app is not refused (review 2026-11-05)", () => {
  it("a filter it cannot read, another user, signal 0 and a workspace program", () => {
    for (const argv of [
      ["taskkill", "/F", "/FI", "WINDOWTITLE eq vite*"],
      ["taskkill", "/FI", "STATUS eq NOT RESPONDING", "/F"],
      ["taskkill", "/FI", "MEMUSAGE gt 100000"],
      ["taskkill", "/FI:PID eq 5678", "/F"],
      ["pkill", "-u", "root"],
      ["pkill", "--euid=postgres"],
      ["pkill", "-U", "0"],
      ["killall", "-u", "postgres"],
      ["pkill", "-u", "root", "node"],
      ["taskkill", "/F", "/FI", "USERNAME eq postgres"],
      ["kill", "-0", "4242"],
      ["kill", "-s", "0", "4100"],
      ["kill", "--signal=0", "4242"],
      ["pkill", "-0", "node"],
      ["pkill", "--signal", "0", "node"],
      ["killall", "-0", "node"],
      ["killall", "-s", "0", "node"],
      ["./kill", "4242"],
      ["scripts/kill", "4242"],
      ["./scripts/pkill", "node"],
    ]) {
      expect(verdict(argv).kind, argv.join(" ")).not.toBe("block");
    }
  });

  it("a word only the shell reads is the shell's own user, and a quoted $PPID is a word", () => {
    expect(shellVerdict("pkill -KILL -u $USER").kind).toBe("block");
    expect(shellVerdict("pkill -u $(id -u)").kind).toBe("block");
    expect(shellVerdict("killall -u $USER").kind).toBe("block");
    expect(shellVerdict("kill '$PPID'").kind).not.toBe("block");
    expect(shellVerdict("kill -0 $PPID").kind).not.toBe("block");
    expect(shellVerdict('kill "$PPID"').kind).toBe("block");
  });

  it("the app's own user, a real signal and a real path still block", () => {
    for (const argv of [
      ["pkill", "-u", "TRAILBLAZER"],
      ["pkill", "-u", "1000"],
      ["pkill", "-u", "root,trailblazer"],
      ["pkill", "-u", "trailblazer", "node"],
      ["taskkill", "/F", "/FI", "USERNAME eq DESKTOP-1\\trailblazer"],
      ["taskkill", "/F", "/FI", "USERNAME ne postgres"],
      ["kill", "-1", "4242"],
      ["kill", "-s", "TERM", "4242"],
      ["/bin/kill", "4242"],
      ["/usr/bin/pkill", "node"],
      ["C:\\Windows\\System32\\taskkill.exe", "/PID", "4242"],
      ["C:/Windows/System32/taskkill", "/PID", "4242"],
      ["taskkill", "/PID:4242"],
      ["taskkill", "/IM:node.exe"],
      ["taskkill", "/FI:PID eq 4242"],
    ]) {
      expect(verdict(argv).kind, argv.join(" ")).toBe("block");
    }
  });

  it("an app that cannot say who it runs as asks about a plain user", () => {
    const unknown: HostIdentity = {
      processes: () => [{ pid: 4242, self: true, name: "node.exe" }],
    };
    expect(
      classifyCommand(["pkill", "-u", "trailblazer"], { host: unknown }).kind,
    ).toBe("ask");
  });
});

describe("find's own semicolon (review 2026-11-05)", () => {
  it("`-exec … \\;` is an argument, and the line classifies as `{} +` does", () => {
    for (const line of [
      "find . -type f -name '*.ts' -exec wc -l {} \\;",
      "find src -name '*.js' -exec grep -l TODO {} \\;",
      "find . -name '*.orig' -exec rm {} \\;",
      "find . -name '*.log' -execdir rm {} \\;",
    ]) {
      expect(shellVerdict(line).kind, line).toBe("ask");
    }
    expect(
      verdict(["bash", "-c", "find src -name '*.js' -exec grep -l TODO {} \\;"])
        .kind,
    ).not.toBe("block");
  });

  it("what follows it, or an escaped backslash, is still a command", () => {
    for (const line of [
      "find . -exec echo {} \\; ; rm -rf /",
      "find . -exec echo {} \\; && rm -rf /",
      "find / -name x -exec rm {} \\;",
      "find . -exec echo \\\\; rm -rf /",
      "echo a\\\\; rm -rf /",
      "echo a\\; rm -rf /",
    ]) {
      expect(shellVerdict(line).kind, line).toBe("block");
    }
  });
});

describe("a literal kill of the app behind a compound or exec (review 2026-11-05)", () => {
  it("blocks through exec", () => {
    for (const line of [
      "exec kill 4242",
      "exec kill -9 $PPID",
      "exec -a x kill 4242",
      "exec -c kill 4242",
      "exec taskkill //F //PID 4242",
      "exec env kill 4242",
      "exec bash -c 'kill 4242'",
    ]) {
      expect(shellVerdict(line).kind, line).toBe("block");
    }
    expect(shellVerdict("exec kill 574").kind).toBe("ask");
    expect(shellVerdict("exec node server.js").kind).toBe("ask");
  });

  it("blocks inside a group, a subshell, a condition or a block of a body", () => {
    for (const line of [
      "bash -c '(kill 4242)'",
      "bash -c '{ kill 4242; }'",
      "bash -c '! kill 4242'",
      "bash -c 'FOO=1 kill 4242'",
      "bash -c 'x=1 env kill 4242'",
      "bash -c 'if true; then kill 4242; fi'",
      "bash -c 'while true; do kill 4242; done'",
      "bash -c 'k(){ kill 4242; }; k'",
      "bash -c '2>/dev/null kill 4242'",
      "bash -c '(kill -9 $PPID)'",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own `${PPID}`, not a template
      "bash -c '(kill ${PPID})'",
      'cmd /c "(taskkill /F /PID 4242)"',
      'cmd /c "@taskkill /F /PID 4242"',
      'cmd /c "call taskkill /F /PID 4242"',
      'cmd /c "start /b taskkill /F /PID 4242"',
      'cmd /c ">nul taskkill /PID 4242"',
      "powershell -c '& { Stop-Process -Id 4242 }'",
      "powershell -c '. { Stop-Process -Id 4242 }'",
      "powershell -c 'if ($true) { Stop-Process -Id 4242 }'",
      "powershell -c 'try { Stop-Process -Id 4242 } catch {}'",
      "powershell -c '$null = Stop-Process -Id 4242'",
    ]) {
      expect(shellVerdict(line).kind, line).toBe("block");
    }
    for (const argv of [
      ["bash", "-c", "(kill -9 $PPID)"],
      ["bash", "-c", "{ kill -9 $PPID; }"],
      ["bash", "-c", "x=1 kill $PPID"],
      ["cmd", "/c", "(taskkill /F /PID 4242)"],
      ["cmd", "/c", "call taskkill /F /PID 4242"],
    ]) {
      expect(verdict(argv).kind, argv.join(" ")).toBe("block");
    }
  });

  it("blocks in a heredoc fed to a shell, however its delimiter is quoted", () => {
    for (const line of [
      "bash <<'EOF'\nkill 4242\nEOF",
      "bash <<EOF\nkill 4242\nEOF",
      "sh <<'EOF'\ntaskkill //F //PID 4242\nEOF",
      "bash -s <<'EOF'\nkill -9 $PPID\nEOF",
      "/bin/bash <<'EOF'\n(kill 4242)\nEOF",
    ]) {
      expect(shellVerdict(line).kind, line).toBe("block");
    }
  });

  it("leaves what only mentions it alone", () => {
    for (const line of [
      "cat <<'EOF'\nkill 4242\nEOF",
      "cat > notes.txt <<'EOF'\nkill 4242\nEOF",
      "bash -c 'echo \"(kill 4242)\"'",
      "bash -c 'echo kill 4242'",
      "bash -c '(kill 5678)'",
      "bash <<'EOF'\nkill 5678\nEOF",
    ]) {
      expect(shellVerdict(line).kind, line).not.toBe("block");
    }
  });
});

describe("the rest of what reaches the app (review 2026-11-05, G3–G5, G12)", () => {
  const blocks = (argv: string[]) =>
    expect(verdict(argv).kind, argv.join(" ")).toBe("block");

  it("a pid in another spelling is that pid", () => {
    blocks(["kill", "+4242"]);
    blocks(["kill", "' 4242'"]);
    blocks(["Stop-Process", "-Id:4242"]);
    blocks(["Stop-Process", "-Id", "0x1092"]);
    blocks(["Stop-Process", "-Id", "+4242"]);
    blocks(["kill", "-Id:4242"]);
    blocks(["Stop-Process", "-Name:node"]);
  });

  it("-WhatIf ends nothing, unless it is turned off", () => {
    expect(verdict(["Stop-Process", "-Id", "4242", "-WhatIf"]).kind).not.toBe(
      "block",
    );
    blocks(["Stop-Process", "-Id", "4242", "-WhatIf:$false"]);
  });

  it("a helper is a child of the app, so pkill -P reaches it", () => {
    const parent: HostIdentity = {
      processes: () => [
        { pid: 4242, self: true, name: "Herta" },
        { pid: 4300, name: "Herta", ppid: 4242 },
      ],
    };
    expect(
      classifyCommand(["pkill", "-P", "4242"], { host: parent }).kind,
    ).toBe("block");
    expect(
      classifyCommand(["pkill", "-P", "1234"], { host: parent }).kind,
    ).not.toBe("block");
  });

  it("names a Mac's helpers, which are programs of their own", () => {
    expect(helperNames("Herta", "darwin")).toContain("Herta Helper (Renderer)");
    expect(helperNames("Herta", "win32")).toEqual(["Herta"]);
    const mac: HostIdentity = {
      processes: () => [
        { pid: 4242, self: true, name: "Herta" },
        { pid: 4300, name: "Herta Helper (GPU)" },
      ],
    };
    expect(
      classifyCommand(["killall", "Herta Helper (GPU)"], { host: mac }).kind,
    ).toBe("block");
    expect(classifyCommand(["pkill", "-vx", "Herta"], { host: mac }).kind).toBe(
      "block",
    );
  });

  it("a pipe that is a kill by name is that kill", () => {
    for (const line of [
      "pgrep node | xargs kill -9",
      "pgrep -f cli.js | xargs -r kill",
      "pidof node.exe | xargs kill",
      "Get-Process node | Stop-Process -Force",
      "gps node | kill",
    ]) {
      expect(pipedKills(line).length, line).toBe(1);
      blocks(["bash", "-c", line]);
    }
    expect(shellVerdict("pgrep node | xargs kill -9").kind).toBe("block");
  });

  it("a pipe that ends something else, or reads, is left alone", () => {
    for (const line of [
      "pgrep vite | xargs kill",
      "pgrep node | wc -l",
      "pgrep node || xargs kill",
      "Get-Process vite | Stop-Process",
      "Get-Process node | Select-Object Id",
      "echo 'pgrep node | xargs kill'",
    ]) {
      expect(verdict(["bash", "-c", line]).kind, line).not.toBe("block");
    }
  });

  it("a shell it did not know no longer hides a block-tier body", () => {
    for (const shell of ["fish", "ash", "csh", "tcsh", "mksh", "yash"]) {
      expect(classifyCommand([shell, "-c", "rm -rf /"], {}).kind, shell).toBe(
        "block",
      );
      blocks([shell, "-c", "kill 4242"]);
    }
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
    // Not on Windows, where the number can outlive its process (G7).
    expect(procs.some((p) => p.pid === process.ppid)).toBe(
      process.platform !== "win32",
    );
    expect(own?.user?.length).toBeGreaterThan(0);
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
