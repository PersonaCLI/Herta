import { isBrowserOpVerb } from "@herta/core/browser-host";
import { isServerOpVerb } from "@herta/core/server-host";
/**
 * Which phase of a run an operation belongs to — 探索 (looking), 修改
 * (changing), 验证 (checking) — for the rail's trace card (ADR 0073).
 *
 * Display only, and a reading, not a claim: the card groups consecutive
 * steps under one phase so a run reads as "looked, changed, checked", the
 * way a person would tell it. Nothing is decided by it — the permission
 * classifier, not this, knows what a command may do.
 */
export type TracePhase = "explore" | "modify" | "verify";

/** The phase of a projected op row, from its verb and argument. */
export function opPhase(verb: string, arg: string): TracePhase {
  switch (verb) {
    case "Writing":
    case "Saving memory":
      return "modify";
    case "Running":
      return commandPhase(arg);
    // Ending a background command is part of running and checking it.
    case "Stopping":
      return "verify";
    default:
      // A page step looks at the running app: checking the work (ADR 0083).
      if (isBrowserOpVerb(verb) || isServerOpVerb(verb)) return "verify";
      // Reading, Searching, Inspecting, Digesting — and a legacy Planning
      // row — are all looking.
      return "explore";
  }
}

const EXPLORE_PROGRAMS: ReadonlySet<string> = new Set([
  "ls",
  "dir",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "egrep",
  "rg",
  "ag",
  "find",
  "fd",
  "tree",
  "wc",
  "pwd",
  "echo",
  "printf",
  "which",
  "where",
  "type",
  "file",
  "stat",
  "du",
  "df",
  "env",
  "printenv",
  "sort",
  "uniq",
  "cut",
  "tr",
  "nl",
  "jq",
  "diff",
  "cd",
  "ps",
  "pgrep",
  "lsof",
  "netstat",
  "ss",
  "tasklist",
  "date",
  "uname",
  "whoami",
  "hostname",
  "xxd",
  "hexdump",
  "od",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "true",
]);

const MODIFY_PROGRAMS: ReadonlySet<string> = new Set([
  "mkdir",
  "rm",
  "rmdir",
  "mv",
  "cp",
  "touch",
  "chmod",
  "chown",
  "ln",
  "tee",
  "patch",
  "dd",
  "truncate",
  "unzip",
  "wget",
]);

const GIT_READS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "grep",
  "branch",
  "remote",
  "rev-parse",
  "ls-files",
  "describe",
  "shortlog",
  "reflog",
]);

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "pip",
  "pip3",
  "cargo",
  "go",
  "gem",
  "composer",
]);

const INSTALLS: ReadonlySet<string> = new Set([
  "install",
  "i",
  "ci",
  "add",
  "remove",
  "rm",
  "uninstall",
  "update",
  "upgrade",
  "get",
]);

const PACKAGE_READS: ReadonlySet<string> = new Set([
  "ls",
  "list",
  "view",
  "info",
  "outdated",
  "show",
  "why",
  "freeze",
]);

const RANK: Record<TracePhase, number> = { explore: 0, modify: 1, verify: 2 };

/**
 * The phase of a shell line. Each command of a chain (`&&`, `||`, `;`,
 * `|`) is read on its own and the strongest wins — checking over changing
 * over looking — so `cd sub && npm test` is a check and `mkdir x && cat > …`
 * a change. A write redirect makes a looking command a change. Running
 * anything else (a script, a build, a test) is a check.
 */
export function commandPhase(line: string): TracePhase {
  let phase: TracePhase = "explore";
  for (const part of line.split(/&&|\|\||;|\|/)) {
    const p = segmentPhase(part.trim());
    if (RANK[p] > RANK[phase]) phase = p;
    if (phase === "verify") break;
  }
  return phase;
}

function segmentPhase(segment: string): TracePhase {
  if (segment.length === 0) return "explore";
  const words = segment.split(/\s+/);
  // Leading assignments (`FOO=1 npm test`) are not the program.
  const at = words.findIndex((w) => !ASSIGNMENT_RE.test(w));
  if (at === -1) return "explore";
  const program = programName(words[at] as string);
  const sub = words[at + 1] ?? "";
  // `> file` / `>> file` — not `2>&1`, not `>/dev/null`.
  const writes = /(^|[^0-9&])>{1,2}\s*(?!&|\/dev\/null)\S/.test(segment);
  if (program === "git") {
    return GIT_READS.has(sub) && !writes ? "explore" : "modify";
  }
  if (program === "sed" || program === "perl") {
    return /\s-i/.test(segment) || writes ? "modify" : "explore";
  }
  if (program === "awk" || program === "curl") {
    return writes || /\s-o\s/.test(segment) ? "modify" : "explore";
  }
  if (PACKAGE_MANAGERS.has(program)) {
    if (INSTALLS.has(sub)) return "modify";
    if (PACKAGE_READS.has(sub)) return "explore";
    return "verify";
  }
  if (program === "node" || program === "python" || program === "python3") {
    // A version query is looking; running a script is checking it.
    return /^(-v|--version|-V)$/.test(sub) ? "explore" : "verify";
  }
  if (MODIFY_PROGRAMS.has(program)) return "modify";
  if (EXPLORE_PROGRAMS.has(program)) return writes ? "modify" : "explore";
  if (program === "tar") return /\s-?x/.test(segment) ? "modify" : "explore";
  return "verify";
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `/usr/bin/git` → `git`, `npm.cmd` → `npm`, lower case. */
function programName(word: string): string {
  const base =
    word
      .replace(/^["']|["']$/g, "")
      .split(/[\\/]/)
      .pop() ?? "";
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}
