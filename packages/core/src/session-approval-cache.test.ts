import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "./event-bus.js";
import { EXEC_WRAPPER_PROGRAMS } from "./program-identity.js";
import {
  permissionCacheScope,
  SessionApprovalCache,
  wireTaskScopedApprovalCache,
} from "./session-approval-cache.js";
import type { AgentEvent, PermissionRequest } from "./types/events.js";

describe("SessionApprovalCache", () => {
  // The two tools whose asks can be remembered: the editor and bash.
  const EDITOR = "str_replace_editor";

  it("starts empty", () => {
    const c = new SessionApprovalCache();
    expect(c.size()).toBe(0);
    expect(c.list()).toEqual([]);
    expect(c.has(EDITOR, "workspace_write", "a.ts")).toBe(false);
  });

  it("isCacheable: only the editor and bash, at workspace_write, WITH a scope", () => {
    const c = new SessionApprovalCache();
    expect(c.isCacheable(EDITOR, "workspace_write", "a.ts")).toBe(true);
    expect(c.isCacheable("bash", "workspace_write", "node")).toBe(true);
    // Cacheable tool but NO scope — fail-closed, not cacheable (audit T3.4).
    expect(c.isCacheable(EDITOR, "workspace_write")).toBe(false);
    expect(c.isCacheable("bash", "workspace_write")).toBe(false);
    // Cacheable tools at non-write risks — not cacheable.
    expect(c.isCacheable(EDITOR, "workspace_destructive", "a.ts")).toBe(false);
    expect(c.isCacheable(EDITOR, "workspace_read", "a.ts")).toBe(false);
    expect(c.isCacheable(EDITOR, "network", "a.ts")).toBe(false);
    // No other tool, and none of the deleted standard set's (ADR 0086).
    for (const tool of [
      "show_excerpt",
      "dev_server",
      "edit_file",
      "write_new_file",
      "run_command",
    ]) {
      expect(c.isCacheable(tool, "workspace_write", "x"), tool).toBe(false);
    }
  });

  it("add records cacheable scoped tuples", () => {
    const c = new SessionApprovalCache();
    c.add(EDITOR, "workspace_write", "task");
    expect(c.size()).toBe(1);
    expect(c.has(EDITOR, "workspace_write", "task")).toBe(true);
  });

  it("a file write is kept under the file_write key, per scope (ADR 0026)", () => {
    const c = new SessionApprovalCache();
    // Approving "writes for this task" covers creating a file AND the
    // follow-up edits: the key is the act, not the tool's name.
    c.add(EDITOR, "workspace_write", "task");
    expect(c.list()).toEqual(["file_write:task:workspace_write"]);
    expect(c.has(EDITOR, "workspace_write", "task")).toBe(true);
    // A different scope still misses (bash programs keep theirs).
    expect(c.has(EDITOR, "workspace_write", "other")).toBe(false);
    expect(c.has("bash", "workspace_write", "task")).toBe(false);
  });

  it("add no-ops on non-cacheable tuples (defense-in-depth)", () => {
    const c = new SessionApprovalCache();
    c.add("bash", "workspace_write"); // no program scope
    c.add(EDITOR, "workspace_destructive", "a.ts");
    c.add(EDITOR, "network", "a.ts");
    c.add(EDITOR, "workspace_write"); // no scope
    c.add("run_command", "workspace_write", "git"); // no such tool any more
    expect(c.size()).toBe(0);
  });

  it("add is idempotent", () => {
    const c = new SessionApprovalCache();
    c.add(EDITOR, "workspace_write", "a.ts");
    c.add(EDITOR, "workspace_write", "a.ts");
    expect(c.size()).toBe(1);
  });

  it("clear empties the cache", () => {
    const c = new SessionApprovalCache();
    c.add(EDITOR, "workspace_write", "a.ts");
    c.add(EDITOR, "workspace_write", "b.ts");
    expect(c.size()).toBe(2);
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.list()).toEqual([]);
  });

  it("list returns a sorted snapshot with the normalized tool + scope in the key", () => {
    const c = new SessionApprovalCache();
    c.add(EDITOR, "workspace_write", "task");
    c.add("bash", "workspace_write", "git");
    const snapshot = c.list();
    expect(snapshot).toEqual([
      "bash:git:workspace_write",
      "file_write:task:workspace_write",
    ]);
    // Mutate the cache afterwards — snapshot stays unchanged.
    c.clear();
    expect(snapshot).toEqual([
      "bash:git:workspace_write",
      "file_write:task:workspace_write",
    ]);
  });

  describe("bash, cached per program", () => {
    it("isCacheable(bash, workspace_write, <program>) is true", () => {
      const c = new SessionApprovalCache();
      expect(c.isCacheable("bash", "workspace_write", "python3")).toBe(true);
      expect(c.isCacheable("bash", "workspace_write", "node")).toBe(true);
    });

    it("isCacheable(bash) without a program is false (granularity required)", () => {
      const c = new SessionApprovalCache();
      expect(c.isCacheable("bash", "workspace_write")).toBe(false);
    });

    it("isCacheable(bash, <non-write risk>) is false even with a program", () => {
      const c = new SessionApprovalCache();
      expect(c.isCacheable("bash", "workspace_destructive", "rm")).toBe(false);
      expect(c.isCacheable("bash", "network", "curl")).toBe(false);
      expect(c.isCacheable("bash", "workspace_read", "cat")).toBe(false);
    });

    it("has(bash, ..., program) only matches the same program", () => {
      const c = new SessionApprovalCache();
      c.add("bash", "workspace_write", "python3");
      expect(c.has("bash", "workspace_write", "python3")).toBe(true);
      expect(c.has("bash", "workspace_write", "node")).toBe(false);
      expect(c.has("bash", "workspace_write")).toBe(false);
    });

    it("add(bash, workspace_destructive, program) is no-op", () => {
      const c = new SessionApprovalCache();
      c.add("bash", "workspace_destructive", "rm");
      expect(c.size()).toBe(0);
    });

    it("list includes the scope in every key", () => {
      const c = new SessionApprovalCache();
      c.add(EDITOR, "workspace_write", "task");
      c.add("bash", "workspace_write", "python3");
      c.add("bash", "workspace_write", "node");
      expect(c.list()).toEqual([
        "bash:node:workspace_write",
        "bash:python3:workspace_write",
        "file_write:task:workspace_write",
      ]);
    });
  });
});

describe("permissionCacheScope — command wrappers (audit S5)", () => {
  // As bash asks: the request carries the argv its rule derived from the
  // line (ADR 0040). `run_command` asked with the argv in its input; the
  // scoping rules these tests pin are the same ones.
  const scopeFor = (argv: readonly string[]) =>
    permissionCacheScope({
      id: "r",
      call: { id: "c", tool: "bash", input: { command: argv.join(" ") } },
      reason: "x",
      risk: "workspace_write",
      argv,
    });

  it("refuses to cache WRAPPERS, which do not identify what runs", () => {
    // These were in NEVER_RULABLE but missing from the cache's own set, so
    // approving `timeout 600 npm run build` silently pre-approved
    // `timeout 5 node -e '<payload>'` for the rest of the task — no overlay.
    for (const w of [
      "timeout",
      "time",
      "sudo",
      "doas",
      "pkexec",
      "nice",
      "nohup",
      "xargs",
      "stdbuf",
      "env",
    ]) {
      expect(scopeFor([w, "600", "npm", "run", "build"])).toBeUndefined();
    }
  });

  it("refuses every exec-wrapper the classifier peels — macOS's own included (Mac findings 2026-10-24)", () => {
    // One remembered `caffeinate -i npm run build` covered `caffeinate rm
    // -rf /`: the shared list was the classifier's alone.
    for (const w of EXEC_WRAPPER_PROGRAMS) {
      expect(scopeFor([w, "npm", "run", "build"]), w).toBeUndefined();
    }
    for (const w of ["caffeinate", "arch", "sandbox-exec", "watch", "flock"]) {
      expect(EXEC_WRAPPER_PROGRAMS.has(w), w).toBe(true);
      expect(scopeFor([`/usr/bin/${w}`, "-i", "make"]), w).toBeUndefined();
    }
  });

  it("a package manager's exec scopes nothing; its other subcommands still scope by it (review 2026-10-30)", () => {
    // Remembering `pnpm run build` covered `pnpm exec rm -rf /`.
    for (const argv of [
      ["pnpm", "exec", "rm", "-rf", "/"],
      ["pnpm", "--filter", "web", "exec", "vitest"],
      ["pnpm", "dlx", "create-vite"],
      ["yarn", "exec", "eslint"],
      ["npm", "exec", "--yes", "--", "eslint"],
      ["npm", "x", "eslint"],
      ["bun", "x", "eslint"],
      ["direnv", "exec", ".", "npm", "test"],
    ])
      expect(scopeFor(argv), argv.join(" ")).toBeUndefined();
    for (const w of ["chrt", "unbuffer", "wsl", "exec", "bwrap"])
      expect(scopeFor([w, "npm", "run", "build"]), w).toBeUndefined();
    expect(scopeFor(["pnpm", "run", "build"])).toBe("pnpm");
    expect(scopeFor(["npm", "test"])).toBe("npm");
  });

  it("still refuses shells / wrappers, and interpreters WITHOUT a pinnable script", () => {
    for (const i of ["bash", "sh", "npx", "make"]) {
      expect(scopeFor([i, "build.py"])).toBeUndefined();
    }
    // Interpreters: bare argv[0] never scopes (it would cover `-e`/`-c`), and
    // neither do the arbitrary-code / out-of-workspace shapes…
    expect(scopeFor(["python", "-c", "print(1)"])).toBeUndefined();
    expect(scopeFor(["node", "-e", "1"])).toBeUndefined();
    expect(scopeFor(["node", "--eval", "1"])).toBeUndefined();
    expect(scopeFor(["node", "/etc/x.mjs"])).toBeUndefined();
    expect(scopeFor(["node", "../x.mjs"])).toBeUndefined();
    expect(scopeFor(["node"])).toBeUndefined();
    // …but the PINNED `<interp> <workspace-script>` scopes by that pair
    // (permission lab 2026-08-17: `node scripts/stats.mjs` asked 3× in one
    // brief) — the same shape ADR 0030 rules derive, for the same reason.
    expect(scopeFor(["python", "build.py"])).toBe("python build.py");
    expect(scopeFor(["node", "scripts/stats.mjs", "--json"])).toBe(
      "node scripts/stats.mjs",
    );
  });

  it("normalizes path and .exe before deciding", () => {
    expect(scopeFor(["/usr/bin/timeout", "5", "x"])).toBeUndefined();
    // A path-qualified interpreter still pins by its script.
    expect(scopeFor(["C:\\tools\\python.exe", "x.py"])).toBe(
      "C:\\tools\\python.exe x.py",
    );
    expect(scopeFor(["C:\\tools\\python.exe", "-c", "1"])).toBeUndefined();
  });

  it("still caches a real binary that DOES identify what runs", () => {
    expect(scopeFor(["rustfmt", "src/lib.rs"])).toBe("rustfmt");
    expect(scopeFor(["gofmt", "-w", "main.go"])).toBe("gofmt");
  });
});

describe("wireTaskScopedApprovalCache (ADR 0026)", () => {
  const finished = (layer: "actor" | "backend"): AgentEvent =>
    ({
      type: "turn.finished",
      layer,
      summary: {
        durationMs: 1,
        toolCallCount: 0,
        messageCount: 0,
        endedAt: "t",
      },
    }) as AgentEvent;

  it("clears the cache when the BACKEND brief ends (finished or failed)", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const cache = new SessionApprovalCache();
    wireTaskScopedApprovalCache(bus, cache);
    cache.add("str_replace_editor", "workspace_write", "task");
    expect(cache.size()).toBe(1);
    bus.publish(finished("backend"));
    expect(cache.size()).toBe(0);

    cache.add("bash", "workspace_write", "git");
    bus.publish({
      type: "turn.failed",
      layer: "backend",
      error: { kind: "provider_error", message: "boom" },
    } as unknown as AgentEvent);
    expect(cache.size()).toBe(0);
  });

  it("ignores ACTOR-layer turn ends — only the brief bounds the grant", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const cache = new SessionApprovalCache();
    wireTaskScopedApprovalCache(bus, cache);
    cache.add("str_replace_editor", "workspace_write", "task");
    bus.publish(finished("actor"));
    expect(cache.size()).toBe(1);
  });

  it("returns an unsubscribe that detaches the wire", () => {
    const bus = new InMemoryEventBus<AgentEvent>();
    const cache = new SessionApprovalCache();
    const off = wireTaskScopedApprovalCache(bus, cache);
    off();
    cache.add("str_replace_editor", "workspace_write", "task");
    bus.publish(finished("backend"));
    expect(cache.size()).toBe(1);
  });
});

describe("permissionCacheScope", () => {
  const req = (
    tool: string,
    over: Partial<PermissionRequest> = {},
  ): PermissionRequest => ({
    id: "r1",
    call: { id: "c1", tool, input: {} },
    reason: "x",
    risk: "workspace_write",
    ...over,
  });

  it("bash → argv[0] of the program its rule derived", () => {
    expect(permissionCacheScope(req("bash", { argv: ["npm", "test"] }))).toBe(
      "npm",
    );
  });

  it("the editor → the constant task scope (ADR 0026)", () => {
    // Still gated on the rule-resolved path being PRESENT — the request must
    // carry a canonical target for the ask to be cacheable at all.
    expect(
      permissionCacheScope(req("str_replace_editor", { files: ["src/a.ts"] })),
    ).toBe("task");
  });

  it("returns undefined (fail-closed) when the scope is missing", () => {
    // bash with no derived argv, the editor with no files, and any other tool.
    expect(permissionCacheScope(req("bash"))).toBeUndefined();
    expect(permissionCacheScope(req("str_replace_editor"))).toBeUndefined();
    expect(
      permissionCacheScope(req("show_excerpt", { files: ["x"] })),
    ).toBeUndefined();
  });

  it("the deleted standard set's tools scope nothing, however they are asked (ADR 0086)", () => {
    expect(
      permissionCacheScope(
        req("run_command", {
          call: {
            id: "c",
            tool: "run_command",
            input: { argv: ["npm", "test"] },
          },
          argv: ["npm", "test"],
        }),
      ),
    ).toBeUndefined();
    for (const tool of ["edit_file", "write_new_file"]) {
      expect(
        permissionCacheScope(req(tool, { files: ["src/a.ts"] })),
        tool,
      ).toBeUndefined();
    }
  });

  it("the editor's writes share the task scope; bash scopes by the RULE-derived argv[0], interpreters excluded (ADR 0040)", () => {
    expect(
      permissionCacheScope(req("str_replace_editor", { files: ["src/a.ts"] })),
    ).toBe("task");
    expect(permissionCacheScope(req("str_replace_editor"))).toBeUndefined();
    // A remember for the task covers the editor's next write.
    const c = new SessionApprovalCache();
    c.add("str_replace_editor", "workspace_write", "task");
    expect(c.has("str_replace_editor", "workspace_write", "task")).toBe(true);
    // bash: the rule's argv decides; no argv → not cacheable.
    expect(
      permissionCacheScope(req("bash", { argv: ["git", "commit", "-m", "x"] })),
    ).toBe("git");
    expect(permissionCacheScope(req("bash"))).toBeUndefined();
    // An interpreter with a pinnable workspace script scopes by the pair;
    // the arbitrary-code shape never.
    expect(permissionCacheScope(req("bash", { argv: ["node", "x.mjs"] }))).toBe(
      "node x.mjs",
    );
    expect(
      permissionCacheScope(req("bash", { argv: ["node", "-e", "1"] })),
    ).toBeUndefined();
    // A chained line whose only program is git scopes as "git" via
    // `programs`; two distinct programs → not cacheable; an interpreter via
    // `programs` (no argv to pin a script) is excluded.
    expect(permissionCacheScope(req("bash", { programs: ["git"] }))).toBe(
      "git",
    );
    expect(
      permissionCacheScope(req("bash", { programs: ["npm", "git"] })),
    ).toBeUndefined();
    expect(
      permissionCacheScope(req("bash", { programs: ["python3"] })),
    ).toBeUndefined();
    expect(
      permissionCacheScope(req("bash", { argv: ["bash", "x.sh"] })),
    ).toBeUndefined();
    expect(c.isCacheable("bash", "workspace_write", "git")).toBe(true);
    expect(c.isCacheable("bash", "workspace_write", undefined)).toBe(false);
  });

  it("interpreters never scope by their BARE name (a python remember must not cover python -c, audit T3.4 review) — only by a pinned workspace script", () => {
    const rc = (argv: string[]) => permissionCacheScope(req("bash", { argv }));
    // The pinned pair is the scope: covers `python build.py <any args>` and
    // nothing else run through python.
    expect(rc(["python", "build.py"])).toBe("python build.py");
    expect(rc(["python3", "x.py"])).toBe("python3 x.py");
    expect(rc(["node", "s.js"])).toBe("node s.js");
    expect(rc(["/usr/bin/perl", "s.pl"])).toBe("/usr/bin/perl s.pl");
    expect(rc(["C:\\Python\\python.exe", "x.py"])).toBe(
      "C:\\Python\\python.exe x.py",
    );
    // No pin → nothing: shells, -c/-e bodies, module runs, missing script.
    expect(rc(["bash", "-c", "echo hi"])).toBeUndefined();
    expect(rc(["python", "-c", "print(1)"])).toBeUndefined();
    expect(rc(["python", "-m", "pytest"])).toBeUndefined();
    expect(rc(["node"])).toBeUndefined();
    // A specific tool binary still caches under its name.
    expect(rc(["pytest"])).toBe("pytest");
    expect(rc(["npm", "run", "build"])).toBe("npm");
  });
});
