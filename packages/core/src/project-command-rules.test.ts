import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveProjectCommandRule,
  isRuleEligibleAskCode,
  ProjectCommandRuleStore,
  ruleDisplay,
} from "./project-command-rules.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herta-rules-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function store(): ProjectCommandRuleStore {
  return new ProjectCommandRuleStore(() => root);
}

describe("isRuleEligibleAskCode", () => {
  it("accepts only the unknown and interpreter ask classes", () => {
    expect(isRuleEligibleAskCode("command_ask_unknown")).toBe(true);
    expect(isRuleEligibleAskCode("command_ask_interpreter")).toBe(true);
    expect(isRuleEligibleAskCode("command_ask_destructive")).toBe(false);
    expect(isRuleEligibleAskCode("command_ask_network")).toBe(false);
    expect(isRuleEligibleAskCode("command_ask_write")).toBe(false);
    expect(isRuleEligibleAskCode("command_ask_reader_path")).toBe(false);
    expect(isRuleEligibleAskCode("command_ask_recursive_read")).toBe(false);
    // A reach into .herta the guard cannot bound is asked every time.
    expect(isRuleEligibleAskCode("command_ask_harness_state")).toBe(false);
    expect(isRuleEligibleAskCode(undefined)).toBe(false);
  });
});

describe("deriveProjectCommandRule", () => {
  it("interpreter + workspace script → pinned prefix with free args", () => {
    const rule = deriveProjectCommandRule(["node", "src/index.mjs", "a.txt"]);
    expect(rule).toEqual({
      argvPrefix: ["node", "src/index.mjs"],
      anyArgs: true,
    });
    expect(ruleDisplay(rule as NonNullable<typeof rule>)).toBe(
      "node src/index.mjs:*",
    );
  });

  it("git subcommands with an undecidable operand get NO wildcard", () => {
    // `git checkout main` switches branch; `git checkout main.ts` throws that
    // file away. Same string shape, and git decides by asking whether the name
    // resolves as a ref — which no classifier reading the text can do. A `:*`
    // turned one approval into a standing grant over every future spelling:
    // approving `git checkout -b feature/x` persisted `git checkout:*`, which
    // then auto-approved `git checkout main src/foo.ts` with no card at all
    // (reproduced end to end, 2026-08-25).
    for (const argv of [
      ["git", "checkout", "-b", "feature/x"],
      ["git", "switch", "-c", "feature/x"],
      ["git", "restore", "--staged", "src/a.ts"],
    ]) {
      const rule = deriveProjectCommandRule(argv);
      expect(rule, argv.join(" ")).toEqual({
        argvPrefix: argv,
        anyArgs: false,
      });
      expect(ruleDisplay(rule as never)).toBe(argv.join(" "));
    }
  });

  it("every other git subcommand still derives ADR 0030's wildcard", () => {
    for (const [argv, display] of [
      [["git", "commit", "-m", "x"], "git commit:*"],
      [["git", "add", "-A"], "git add:*"],
      [["git", "push", "origin", "main"], "git push:*"],
      [["git", "clean", "-n"], "git clean:*"],
    ] as const) {
      const rule = deriveProjectCommandRule([...argv]);
      expect(rule?.anyArgs, display).toBe(true);
      expect(ruleDisplay(rule as never)).toBe(display);
    }
  });

  it("interpreter with a flag operand (-e eval) derives NOTHING", () => {
    expect(deriveProjectCommandRule(["node", "-e", "code"])).toBeNull();
    expect(deriveProjectCommandRule(["python", "-c", "code"])).toBeNull();
    expect(deriveProjectCommandRule(["node", "--eval", "x"])).toBeNull();
  });

  it("interpreter with an out-of-workspace script derives NOTHING", () => {
    expect(deriveProjectCommandRule(["node", "/etc/x.js"])).toBeNull();
    expect(deriveProjectCommandRule(["node", "C:\\x.js"])).toBeNull();
    expect(deriveProjectCommandRule(["node", "../x.js"])).toBeNull();
    expect(deriveProjectCommandRule(["node", "~/x.js"])).toBeNull();
    expect(deriveProjectCommandRule(["node"])).toBeNull();
  });

  it("interpreter matching is basename-normalized but tokens stay verbatim", () => {
    const rule = deriveProjectCommandRule(["node.exe", "src/i.mjs"]);
    expect(rule).toEqual({
      argvPrefix: ["node.exe", "src/i.mjs"],
      anyArgs: true,
    });
  });

  it("shells, wrappers, npx and make are never derivable", () => {
    expect(deriveProjectCommandRule(["bash", "-c", "x"])).toBeNull();
    expect(
      deriveProjectCommandRule(["powershell", "-Command", "x"]),
    ).toBeNull();
    expect(deriveProjectCommandRule(["env", "node", "x.js"])).toBeNull();
    expect(deriveProjectCommandRule(["xargs", "rm"])).toBeNull();
    expect(deriveProjectCommandRule(["npx", "tsc"])).toBeNull();
    expect(deriveProjectCommandRule(["make", "build"])).toBeNull();
    expect(deriveProjectCommandRule(["sudo", "ls"])).toBeNull();
    expect(deriveProjectCommandRule(["CMD.EXE", "/c", "dir"])).toBeNull();
  });

  it("plain binary with a subcommand-shaped argv[1] → prefix rule", () => {
    expect(deriveProjectCommandRule(["dotnet", "build", "-c", "Rel"])).toEqual({
      argvPrefix: ["dotnet", "build"],
      anyArgs: true,
    });
  });

  it("plain binary without a subcommand → exact argv rule", () => {
    const rule = deriveProjectCommandRule(["ffmpeg", "-i", "in.mp4", "o.mp4"]);
    expect(rule).toEqual({
      argvPrefix: ["ffmpeg", "-i", "in.mp4", "o.mp4"],
      anyArgs: false,
    });
    expect(ruleDisplay(rule as NonNullable<typeof rule>)).toBe(
      "ffmpeg -i in.mp4 o.mp4",
    );
  });

  it("empty / malformed argv derives nothing", () => {
    expect(deriveProjectCommandRule([])).toBeNull();
    expect(deriveProjectCommandRule([""])).toBeNull();
  });
});

describe("ProjectCommandRuleStore", () => {
  it("starts empty and matches nothing without a file", () => {
    expect(store().list()).toEqual([]);
    expect(store().matches(["node", "src/index.mjs"])).toBe(false);
  });

  it("add → persists; matches prefix rules with any trailing args", () => {
    const s = store();
    s.add({ argvPrefix: ["node", "src/index.mjs"], anyArgs: true });
    expect(s.matches(["node", "src/index.mjs"])).toBe(true);
    expect(s.matches(["node", "src/index.mjs", "sample.txt"])).toBe(true);
    expect(s.matches(["node", "src/other.mjs"])).toBe(false);
    expect(s.matches(["node"])).toBe(false);
    // A fresh store instance reads the same file (persistence, not memory).
    expect(store().matches(["node", "src/index.mjs", "x"])).toBe(true);
  });

  it("exact rules match only the identical argv", () => {
    const s = store();
    s.add({ argvPrefix: ["ffmpeg", "-i", "a.mp4"], anyArgs: false });
    expect(s.matches(["ffmpeg", "-i", "a.mp4"])).toBe(true);
    expect(s.matches(["ffmpeg", "-i", "a.mp4", "extra"])).toBe(false);
  });

  it("duplicate adds write one entry", () => {
    const s = store();
    s.add({ argvPrefix: ["node", "a.js"], anyArgs: true });
    s.add({ argvPrefix: ["node", "a.js"], anyArgs: true });
    expect(s.list()).toHaveLength(1);
  });

  it("remove by display form", () => {
    const s = store();
    s.add({ argvPrefix: ["node", "a.js"], anyArgs: true });
    s.add({ argvPrefix: ["dotnet", "build"], anyArgs: true });
    expect(s.remove("node a.js:*")).toBe(true);
    expect(s.remove("node a.js:*")).toBe(false);
    expect(s.list().map(ruleDisplay)).toEqual(["dotnet build:*"]);
  });

  it("a hand-written shell rule NEVER matches (defense-in-depth)", () => {
    const s = store();
    // Seed a legit rule so the directory exists, then corrupt the file by hand.
    s.add({ argvPrefix: ["node", "a.js"], anyArgs: true });
    const file = join(root, ".herta", "permissions.json");
    const payload = {
      version: 1,
      commandAllow: [
        { argvPrefix: ["bash", "-c"], anyArgs: true, addedAt: "x", cwd: "" },
        { argvPrefix: ["node", "a.js"], anyArgs: true, addedAt: "x", cwd: "" },
      ],
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    expect(s.matches(["bash", "-c", "rm -rf /"])).toBe(false);
    expect(s.list()).toHaveLength(1); // the bash entry is dropped on load
    expect(s.matches(["node", "a.js"])).toBe(true);
  });

  it("add refuses a shell shape even if a caller passes one", () => {
    const s = store();
    s.add({ argvPrefix: ["bash", "-c"], anyArgs: true });
    expect(s.list()).toEqual([]);
  });

  it("malformed file or entries load as empty / partial, never throw", () => {
    const s = store();
    s.add({ argvPrefix: ["node", "a.js"], anyArgs: true });
    const file = join(root, ".herta", "permissions.json");
    writeFileSync(file, "{not json", "utf8");
    expect(s.list()).toEqual([]);
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        commandAllow: [
          { argvPrefix: [], anyArgs: true, addedAt: "x", cwd: "" },
          { argvPrefix: ["ok", "fine"], anyArgs: "yes", addedAt: "x", cwd: "" },
          // No cwd — a pre-BL15 rule. Dropped, not defaulted to the root:
          // defaulting would silently keep granting the broad any-directory
          // match the field exists to narrow.
          { argvPrefix: ["legacy", "build"], anyArgs: true, addedAt: "x" },
          {
            argvPrefix: ["dotnet", "build"],
            anyArgs: true,
            addedAt: "x",
            cwd: "",
          },
        ],
      }),
      "utf8",
    );
    expect(s.list().map(ruleDisplay)).toEqual(["dotnet build:*"]);
  });

  describe("a rule is scoped to the directory it was granted in (audit BL15)", () => {
    it("does not match the same command from another cwd", () => {
      const s = store();
      // `node src/index.mjs:*` pins a workspace-RELATIVE script path, and cwd
      // is model-supplied — so without this the one approval covered
      // src/index.mjs under every directory in the tree that had one.
      s.add({ argvPrefix: ["node", "src/index.mjs"], anyArgs: true, cwd: "" });
      expect(s.matches(["node", "src/index.mjs", "a.txt"])).toBe(true);
      expect(
        s.matches(["node", "src/index.mjs", "a.txt"], "vendor/other"),
      ).toBe(false);
    });

    it("treats undefined, empty and '.' as the workspace root", () => {
      const s = store();
      s.add({ argvPrefix: ["dotnet", "build"], anyArgs: true, cwd: "." });
      for (const cwd of [undefined, "", ".", "./"]) {
        expect(s.matches(["dotnet", "build"], cwd), String(cwd)).toBe(true);
      }
    });

    it("normalizes separators so a rule survives platform differences", () => {
      const s = store();
      s.add({ argvPrefix: ["dotnet", "build"], anyArgs: true, cwd: "a\\b" });
      expect(s.matches(["dotnet", "build"], "a/b")).toBe(true);
      expect(s.matches(["dotnet", "build"], "a/b/")).toBe(true);
    });

    it("the same command in two directories is two grants", () => {
      const s = store();
      s.add({ argvPrefix: ["dotnet", "build"], anyArgs: true, cwd: "" });
      s.add({ argvPrefix: ["dotnet", "build"], anyArgs: true, cwd: "svc" });
      expect(s.list()).toHaveLength(2);
      // …and adding the same one twice is still one.
      s.add({ argvPrefix: ["dotnet", "build"], anyArgs: true, cwd: "svc" });
      expect(s.list()).toHaveLength(2);
    });
  });

  it("follows a moved workspace root via the provider", () => {
    const rootB = mkdtempSync(join(tmpdir(), "herta-rules-b-"));
    try {
      let current = root;
      const s = new ProjectCommandRuleStore(() => current);
      s.add({ argvPrefix: ["node", "a.js"], anyArgs: true });
      expect(s.matches(["node", "a.js"])).toBe(true);
      current = rootB;
      expect(s.matches(["node", "a.js"])).toBe(false); // other workspace
      s.add({ argvPrefix: ["dotnet", "build"], anyArgs: true });
      expect(
        JSON.parse(
          readFileSync(join(rootB, ".herta", "permissions.json"), "utf8"),
        ).commandAllow,
      ).toHaveLength(1);
    } finally {
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  describe("the auto-review opt-in (ADR 0075) rides the same file", () => {
    it("is off until chosen, persists, and survives trust and rule edits both ways", () => {
      const root = mkdtempSync(join(tmpdir(), "herta-rules-review-"));
      try {
        const store = new ProjectCommandRuleStore(() => root);
        expect(store.autoReview()).toBe(false);
        store.setAutoReview(true);
        expect(new ProjectCommandRuleStore(() => root).autoReview()).toBe(true);
        store.setTrust("workspace");
        store.add({ argvPrefix: ["git", "commit"], anyArgs: true });
        store.remove("git commit:*");
        expect(store.autoReview()).toBe(true);
        expect(store.trust()).toBe("workspace");
        store.setAutoReview(false);
        expect(store.autoReview()).toBe(false);
        expect(store.trust()).toBe("workspace");
        const file = JSON.parse(
          readFileSync(join(root, ".herta", "permissions.json"), "utf8"),
        );
        expect(file.autoReview).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("only the literal true opts in", () => {
      const root = mkdtempSync(join(tmpdir(), "herta-rules-review-"));
      try {
        mkdirSync(join(root, ".herta"), { recursive: true });
        writeFileSync(
          join(root, ".herta", "permissions.json"),
          JSON.stringify({ version: 1, commandAllow: [], autoReview: "yes" }),
        );
        expect(new ProjectCommandRuleStore(() => root).autoReview()).toBe(
          false,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("workspace trust (ADR 0064) rides the same file", () => {
    it("starts unset, persists a choice, clears back to null, and survives rule edits", () => {
      const root = mkdtempSync(join(tmpdir(), "herta-rules-trust-"));
      try {
        const store = new ProjectCommandRuleStore(() => root);
        expect(store.trust()).toBeNull();
        store.setTrust("workspace");
        expect(store.trust()).toBe("workspace");
        expect(new ProjectCommandRuleStore(() => root).trust()).toBe(
          "workspace",
        );
        // Adding and removing a rule keeps the trust choice.
        store.add({ argvPrefix: ["git", "commit"], anyArgs: true });
        expect(store.trust()).toBe("workspace");
        expect(store.list()).toHaveLength(1);
        store.remove("git commit:*");
        expect(store.trust()).toBe("workspace");
        store.setTrust("ask");
        expect(store.trust()).toBe("ask");
        store.setTrust(null);
        expect(store.trust()).toBeNull();
        // And setting trust keeps the rules.
        store.add({ argvPrefix: ["npm", "run"], anyArgs: true });
        store.setTrust("workspace");
        expect(store.list().map(ruleDisplay)).toEqual(["npm run:*"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("a hand-written value that is not a trust level loads as unset", () => {
      const root = mkdtempSync(join(tmpdir(), "herta-rules-trust-"));
      try {
        mkdirSync(join(root, ".herta"), { recursive: true });
        writeFileSync(
          join(root, ".herta", "permissions.json"),
          JSON.stringify({ version: 1, commandAllow: [], trust: "always" }),
        );
        expect(new ProjectCommandRuleStore(() => root).trust()).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
