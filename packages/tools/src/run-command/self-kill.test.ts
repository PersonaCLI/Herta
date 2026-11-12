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
  { pid: 4242, self: true, name: "node.exe" },
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
      ["killall", "node"],
      ["killall", "-9", "node"],
      ["tskill", "node"],
    ]) {
      expect(verdict(argv).kind, argv.join(" ")).toBe("block");
    }
  });

  it("every process there is, or every one but a name", () => {
    for (const argv of [
      ["kill", "-9", "-1"],
      ["kill", "--", "-1"],
      ["pkill", "-v", "python"],
    ]) {
      expect(verdict(argv).kind, argv.join(" ")).toBe("block");
    }
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

// Owner 2026-11-12: the guard is cut to kills by pid and by program name.
// Before the cut these lines were read, and those that reach the app were
// blocked. A block has no card; an ask has one, which a review model may
// answer.
describe("a kill chosen by command line, by user or by parent is not read: it asks (owner 2026-11-12)", () => {
  /** A host that still says what the guard used to read, through a cast
   *  (the type has lost the fields). The cut is that the guard does not READ
   *  these, not that nobody tells it: a guard taught them back would block
   *  the lines below on this host, and on the plain one it would not. */
  const told = {
    processes: () => [
      {
        pid: 4242,
        self: true,
        name: "node.exe",
        ppid: 4100,
        commandLine:
          "C:\\Program Files\\nodejs\\node.exe C:\\apps\\herta\\cli.js",
        user: "trailblazer",
        uid: 1000,
      },
      { pid: 4100 },
      { pid: 4300, name: "node.exe", ppid: 4242 },
    ],
  } as unknown as HostIdentity;
  const on = (argv: string[]) => classifyCommand(argv, { host: told });
  const onLine = (line: string) =>
    classifyShellCommandDetailed(line, { workspaceRoot: WS, paths, host: told })
      .verdict;

  it("by command line, the app's own included", () => {
    for (const argv of [
      ["pkill", "-f", "herta"],
      ["pkill", "-f", "cli\\.js"],
      ["pkill", "-f", "node"],
      ["pkill", "--full", "node"],
      ["pkill", "-if", "NODE"],
      ["pkill", "node", "-f"],
      ["pkill", "-f", "vite"],
    ]) {
      expect(on(argv).kind, argv.join(" ")).toBe("ask");
    }
  });

  it("by user, alone or beside a pid or a name that is the app's", () => {
    for (const argv of [
      ["pkill", "-u", "trailblazer"],
      ["pkill", "--euid=trailblazer"],
      ["pkill", "-U", "1000"],
      ["pkill", "-u", "root,trailblazer"],
      ["pkill", "-u", "trailblazer", "node"],
      ["killall", "-u", "trailblazer"],
      ["killall", "-u", "trailblazer", "node"],
      ["killall", "--user=trailblazer", "node"],
      ["taskkill", "/F", "/FI", "USERNAME eq trailblazer"],
      ["taskkill", "/F", "/FI", "USERNAME eq DESKTOP-1\\trailblazer"],
      ["taskkill", "/F", "/FI", "USERNAME ne postgres"],
      ["taskkill", "/F", "/IM", "node.exe", "/FI", "USERNAME eq trailblazer"],
      ["taskkill", "/PID", "4242", "/FI:USERNAME eq trailblazer"],
      ["taskkill", "/F", "/IM", "node.exe", "/FI", "USERNAME eq postgres"],
    ]) {
      expect(on(argv).kind, argv.join(" ")).toBe("ask");
    }
  });

  it("by parent, the app's own parent and the app as a parent included", () => {
    for (const argv of [
      ["pkill", "-P", "4100"],
      ["pkill", "--parent", "4242"],
      ["pkill", "--parent=4242"],
      ["pkill", "-P", "4242", "node"],
      ["pkill", "-P", "4100", "python"],
    ]) {
      expect(on(argv).kind, argv.join(" ")).toBe("ask");
    }
  });

  it("in the shell's own lane, and through the pipe that spells one", () => {
    for (const line of [
      "pkill -KILL -u $USER",
      "pkill -u $(id -u)",
      "killall -u $USER",
      "pkill -f cli.js",
      "pgrep -f cli.js | xargs -r kill",
      "pgrep -u trailblazer node | xargs kill",
    ]) {
      expect(onLine(line).kind, line).toBe("ask");
      expect(on(["bash", "-c", line]).kind, line).toBe("ask");
    }
  });

  it("asks as a kill does, in the class no rule can allow", () => {
    for (const argv of [
      ["pkill", "-f", "herta"],
      ["pkill", "-u", "trailblazer"],
      ["pkill", "-P", "4242"],
      ["killall", "-u", "trailblazer", "node"],
      ["taskkill", "/F", "/FI", "USERNAME eq trailblazer"],
    ]) {
      const v = on(argv);
      expect(v.kind === "ask" ? v.code : v.kind, argv.join(" ")).toBe(
        "command_ask_process",
      );
    }
  });

  it("the same line without that option still blocks", () => {
    for (const argv of [
      ["pkill", "node"],
      ["pkill", "-i", "NODE"],
      ["killall", "node"],
      ["taskkill", "/F", "/IM", "node.exe"],
      ["taskkill", "/PID", "4242"],
      ["bash", "-c", "pgrep node | xargs -r kill"],
    ]) {
      expect(on(argv).kind, argv.join(" ")).toBe("block");
    }
  });
});

describe("a kill of anything else asks as before (2026-11-04)", () => {
  it("other pids, names, users' filters and machines", () => {
    for (const argv of [
      ["kill", "574"],
      ["kill", "-9", "574", "575"],
      ["kill", "-n", "9", "574"],
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
    // A job of the same shell asked here too until ADR 0045's amendment
    // 2026-11-11 (2): a job number can only name what this shell started,
    // never the app, so it is neither blocked nor asked.
    expect(verdict(["kill", "%1"]).kind).toBe("allow");
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
  const named = (name: string): HostIdentity => ({
    processes: () => [{ pid: 4242, self: true, name }],
  });
  const denied = (argv: string[], who: HostIdentity): boolean =>
    selfKillDenial(argv, who, false) !== null;

  /** The classifier is synchronous on the main thread. This name is short on
   *  purpose: a backtracking engine spends seconds on it and fails the test,
   *  where on a long one it never comes back and the test run would hang
   *  with it. (It was the app's command line until `pkill -f` stopped being
   *  read, owner 2026-11-12; a name is matched the same way.) The wildcard
   *  keeps the name it was sized on: over this one it would not come back. */
  const short = named("a".repeat(26));
  const plain = named("node.exe");

  it("a line built to backtrack answers at once", () => {
    const started = performance.now();
    const verdicts = [
      classifyCommand(["pkill", "(.+)+X"], { host: short }),
      classifyCommand(["taskkill", "/IM", `${"*".repeat(24)}b`], {
        host: plain,
      }),
      classifyCommand(["taskkill", "/FI", `PID eq ${" ".repeat(1600)}\nx\ny`], {
        host: plain,
      }),
    ].map((v) => v.kind);
    expect(performance.now() - started).toBeLessThan(1000);
    // Nobody can tell what the pattern selects, or what that filter does.
    expect(verdicts).toEqual(["ask", "ask", "ask"]);
  });

  it("the bash contract's line asks too", () => {
    const started = performance.now();
    const v = classifyShellCommandDetailed("sudo pkill '(.+)+X'", {
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
      ["pkill", "node.exe"],
      ["pkill", "no.*exe"],
      ["pkill", "no.+\\.exe$"],
      ["pkill", "^node$"],
      ["pkill", "vite|node"],
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
      ["pkill", "vite|webpack"],
      ["pkill", "-x", "no.e.ex"],
      ["pkill", "^vite"],
      ["pkill", "^ode"],
      ["pkill", "nod$"],
      ["pkill", "node\\.py"],
      ["pkill", "a\\|node"],
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
      ["pkill", `${"a|".repeat(1000)}node`],
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
        expect(denied(["pkill", "-i", pattern.toUpperCase(), "--"], who)).toBe(
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

  it("a quoted $PPID is a word", () => {
    expect(shellVerdict("kill '$PPID'").kind).not.toBe("block");
    expect(shellVerdict("kill -0 $PPID").kind).not.toBe("block");
    expect(shellVerdict('kill "$PPID"').kind).toBe("block");
  });

  it("a real signal and a real path still block", () => {
    for (const argv of [
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

  it("a helper is reached by its pid and by its name; by its parent the line asks (owner 2026-11-12)", () => {
    // The helper still says who started it, through a cast: the guard does
    // not read that, whoever tells it.
    const desktop = {
      processes: () => [
        { pid: 4242, self: true, name: "Herta" },
        { pid: 4300, name: "Herta", ppid: 4242 },
      ],
    } as unknown as HostIdentity;
    const on = (argv: string[]) => classifyCommand(argv, { host: desktop });
    expect(on(["kill", "4300"]).kind).toBe("block");
    expect(on(["pkill", "Herta"]).kind).toBe("block");
    expect(on(["pkill", "-P", "4242"]).kind).toBe("ask");
    expect(on(["pkill", "-P", "1234"]).kind).toBe("ask");
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
      "pgrep -x node | xargs -r kill",
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
    // Not on Windows, where the number can outlive its process (G7).
    expect(procs.some((p) => p.pid === process.ppid)).toBe(
      process.platform !== "win32",
    );
    // Its pid and name are all it says of itself (owner 2026-11-12): no
    // command line, user or parent, which no reader here asks for.
    expect(Object.keys(own ?? {}).sort()).toEqual(["name", "pid", "self"]);
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
