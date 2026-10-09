import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import type { TerminalRecord } from "@herta/core";
import {
  InMemoryToolRegistry,
  ProjectCommandRuleStore,
  SessionApprovalCache,
  type ToolSchema,
} from "@herta/core";
import type { V2ActorDriver } from "@herta/herta";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStyle } from "../render/style.js";
import { MockWritable } from "../testing/mock-streams.js";
import { handleSlashCommand } from "./slash-commands.js";

const style = makeStyle({ enabled: false });

function mkTools(): InMemoryToolRegistry {
  const tools = new InMemoryToolRegistry();
  tools.register({
    name: "echo",
    schema: (): ToolSchema => ({
      name: "echo",
      description: "echo input",
      inputSchema: {},
    }),
    run: async () => ({ ok: true, summary: "ok" }),
  });
  return tools;
}

function mkCtx(opts?: {
  tools?: InMemoryToolRegistry;
  out?: MockWritable;
  approvalCache?: SessionApprovalCache;
  commandRules?: ProjectCommandRuleStore;
}) {
  return {
    tools: opts?.tools ?? mkTools(),
    out: opts?.out ?? new MockWritable(),
    style,
    approvalCache: opts?.approvalCache,
    commandRules: opts?.commandRules,
  };
}

describe("handleSlashCommand", () => {
  it("/help lists every active slash command", async () => {
    const out = new MockWritable();
    await handleSlashCommand("/help", mkCtx({ out }));
    const text = out.full();
    expect(text).toContain("/help");
    expect(text).toContain("/compact");
    expect(text).toContain("/tools");
    expect(text).toContain("/permissions");
    expect(text).toContain("/quit");
    // /trace, /evidence, /clear, /lore are all removed.
    expect(text).not.toContain("/trace");
    expect(text).not.toContain("/evidence");
    expect(text).not.toContain("/clear");
    expect(text).not.toContain("/lore");
  });

  it("/compact arms the driver's force-compact flag and confirms", async () => {
    const out = new MockWritable();
    let armed = 0;
    const driver = {
      forceCompactNextTurn: (): void => {
        armed += 1;
      },
    } as unknown as V2ActorDriver;
    const r = await handleSlashCommand("/compact", {
      ...mkCtx({ out }),
      driver,
    });
    expect(r.action).toBe("continue");
    expect(armed).toBe(1);
    // Confirmation line — NOT the old placeholder.
    const text = out.full();
    expect(text).not.toContain("not yet implemented");
    expect(text).toContain("先前记录");
  });

  it("/compact without a driver reports it is not available", async () => {
    const out = new MockWritable();
    const r = await handleSlashCommand("/compact", mkCtx({ out }));
    expect(r.action).toBe("continue");
    expect(out.full()).toContain("not available in this build");
  });

  it("/compact confirms in English for an EN session, keeping the 「先前记录」 token CN", async () => {
    const out = new MockWritable();
    const driver = {
      forceCompactNextTurn: (): void => {},
    } as unknown as V2ActorDriver;
    await handleSlashCommand("/compact", {
      ...mkCtx({ out }),
      driver,
      lang: "en",
    });
    const text = out.full();
    expect(text).toContain("folds older dialogue");
    // D2: the record heading it names stays CN inside the EN sentence.
    expect(text).toContain("「先前记录」");
    expect(text).not.toContain("下次回合");
  });

  it("/compact zh confirmation is byte-identical", async () => {
    const out = new MockWritable();
    const driver = {
      forceCompactNextTurn: (): void => {},
    } as unknown as V2ActorDriver;
    await handleSlashCommand("/compact", {
      ...mkCtx({ out }),
      driver,
      lang: "zh",
    });
    expect(out.full()).toContain("下次回合会把更早的对话压缩进「先前记录」。");
  });

  it("/tools lists registered tool names", async () => {
    const out = new MockWritable();
    await handleSlashCommand("/tools", mkCtx({ out }));
    expect(out.full()).toContain("echo");
    expect(out.full()).toContain("echo input");
  });

  it("/quit returns action 'quit'", async () => {
    const out = new MockWritable();
    const r = await handleSlashCommand("/quit", mkCtx({ out }));
    expect(r.action).toBe("quit");
  });

  it("/exit is an alias for /quit", async () => {
    const out = new MockWritable();
    const r = await handleSlashCommand("/exit", mkCtx({ out }));
    expect(r.action).toBe("quit");
  });

  it("unknown command prints red error and continue", async () => {
    const out = new MockWritable();
    const r = await handleSlashCommand("/zonk", mkCtx({ out }));
    expect(r.action).toBe("continue");
    expect(out.full()).toContain("unknown command");
    expect(out.full()).toContain("/help");
  });

  it("/trace is now an unknown command", async () => {
    const out = new MockWritable();
    const r = await handleSlashCommand("/trace", mkCtx({ out }));
    expect(r.action).toBe("continue");
    expect(out.full()).toContain("unknown command: /trace");
  });

  it("/evidence is now an unknown command", async () => {
    const out = new MockWritable();
    const r = await handleSlashCommand("/evidence", mkCtx({ out }));
    expect(r.action).toBe("continue");
    expect(out.full()).toContain("unknown command: /evidence");
  });

  it("/clear is still an unknown command", async () => {
    const out = new MockWritable();
    const r = await handleSlashCommand("/clear", mkCtx({ out }));
    expect(r.action).toBe("continue");
    expect(out.full()).toContain("unknown command: /clear");
  });

  it("/lore is still an unknown command", async () => {
    const out = new MockWritable();
    const r = await handleSlashCommand("/lore", mkCtx({ out }));
    expect(r.action).toBe("continue");
    expect(out.full()).toContain("unknown command: /lore");
  });

  it("/permissions empty state when cache is empty", async () => {
    const cache = new SessionApprovalCache();
    const out = new MockWritable();
    await handleSlashCommand(
      "/permissions",
      mkCtx({ out, approvalCache: cache }),
    );
    expect(out.full()).toContain("no session approvals");
  });

  it("/permissions empty state when cache field is undefined", async () => {
    const out = new MockWritable();
    await handleSlashCommand("/permissions", mkCtx({ out }));
    expect(out.full()).toContain("no session approvals");
  });

  it("/permissions lists approvals sorted", async () => {
    const cache = new SessionApprovalCache();
    cache.add("write_new_file", "workspace_write", "task");
    cache.add("run_command", "workspace_write", "git");
    const out = new MockWritable();
    await handleSlashCommand(
      "/permissions",
      mkCtx({ out, approvalCache: cache }),
    );
    const text = out.full();
    expect(text).toContain("session approvals (2)");
    expect(text).toContain("file_write:task:workspace_write");
    expect(text).toContain("run_command:git:workspace_write");
    expect(text).toContain("/permissions clear");
  });

  it("/permissions clear empties the cache and prints count", async () => {
    const cache = new SessionApprovalCache();
    cache.add("edit_file", "workspace_write", "a.ts");
    cache.add("write_new_file", "workspace_write", "b.ts");
    const out = new MockWritable();
    await handleSlashCommand(
      "/permissions clear",
      mkCtx({ out, approvalCache: cache }),
    );
    expect(cache.size()).toBe(0);
    expect(out.full()).toContain("cleared 2");
  });

  it("/permissions clear without a cache is a no-op", async () => {
    const out = new MockWritable();
    await handleSlashCommand("/permissions clear", mkCtx({ out }));
    expect(out.full()).toContain("cleared 0");
  });

  it("/permissions foo prints unknown subcommand", async () => {
    const out = new MockWritable();
    await handleSlashCommand("/permissions foo", mkCtx({ out }));
    expect(out.full()).toContain("unknown subcommand: foo");
  });

  describe("/permissions project rules (ADR 0030)", () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "herta-slash-rules-"));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    function mkRules(): ProjectCommandRuleStore {
      const s = new ProjectCommandRuleStore(() => root);
      s.add({ argvPrefix: ["node", "src/index.mjs"], anyArgs: true });
      return s;
    }

    it("/permissions auto-review on|off switches the reviewer for this workspace (ADR 0075)", async () => {
      const rules = new ProjectCommandRuleStore(() => root);
      const ctx = (out: MockWritable) => ({
        ...mkCtx({ out, commandRules: rules }),
        autoReviewAvailable: true,
      });
      let out = new MockWritable();
      await handleSlashCommand("/permissions auto-review on", ctx(out));
      expect(rules.autoReview()).toBe(true);
      expect(out.full()).toContain("auto-review: on");
      out = new MockWritable();
      await handleSlashCommand("/permissions", ctx(out));
      expect(out.full()).toContain("auto-review on");
      out = new MockWritable();
      await handleSlashCommand("/permissions auto-review off", ctx(out));
      expect(rules.autoReview()).toBe(false);
      out = new MockWritable();
      await handleSlashCommand("/permissions auto-review maybe", ctx(out));
      expect(out.full()).toContain("usage: /permissions auto-review on|off");
      // Without a reviewer mounted, it says so and changes nothing.
      out = new MockWritable();
      await handleSlashCommand(
        "/permissions auto-review on",
        mkCtx({ out, commandRules: rules }),
      );
      expect(out.full()).toContain("not available");
      expect(rules.autoReview()).toBe(false);
    });

    it("/permissions lists project rules alongside session approvals", async () => {
      const out = new MockWritable();
      await handleSlashCommand(
        "/permissions",
        mkCtx({ out, commandRules: mkRules() }),
      );
      const text = out.full();
      expect(text).toContain("project rules (1)");
      expect(text).toContain("node src/index.mjs:*");
      expect(text).toContain("/permissions remove <rule>");
    });

    it("/permissions remove deletes a rule by its (spaced) display form", async () => {
      const rules = mkRules();
      const out = new MockWritable();
      await handleSlashCommand(
        "/permissions remove node src/index.mjs:*",
        mkCtx({ out, commandRules: rules }),
      );
      expect(out.full()).toContain(
        "removed project rule: node src/index.mjs:*",
      );
      expect(rules.list()).toEqual([]);
    });

    it("/permissions remove reports a miss without deleting anything", async () => {
      const rules = mkRules();
      const out = new MockWritable();
      await handleSlashCommand(
        "/permissions remove dotnet build:*",
        mkCtx({ out, commandRules: rules }),
      );
      expect(out.full()).toContain("no project rule matches: dotnet build:*");
      expect(rules.list()).toHaveLength(1);
    });

    it("/permissions remove without a store reports unavailability", async () => {
      const out = new MockWritable();
      await handleSlashCommand("/permissions remove x", mkCtx({ out }));
      expect(out.full()).toContain("not available in this build");
    });
  });

  it("/help lists /permissions", async () => {
    const out = new MockWritable();
    await handleSlashCommand("/help", mkCtx({ out }));
    expect(out.full()).toContain("/permissions");
  });

  describe("/resume", () => {
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "v2-resume-slash-"));
    });
    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    function writeSession(
      sessionId: string,
      workspaceRoot: string,
      mtime?: Date,
      lang?: "zh" | "en",
      userText?: string,
    ): string {
      const path = join(tmp, `${sessionId}.jsonl`);
      const header = JSON.stringify({
        _kind: "session_meta",
        version: 1,
        sessionId,
        startedAt: "2026-05-15T12:00:00.000Z",
        workspaceRoot,
        ...(lang !== undefined ? { lang } : {}),
      });
      const user = JSON.stringify({
        kind: "user",
        text: userText ?? `hello from ${sessionId}`,
      });
      writeFileSync(path, `${header}\n${user}\n`, "utf8");
      if (mtime !== undefined) utimesSync(path, mtime, mtime);
      return path;
    }

    function mkDriverStub(): {
      loaded: TerminalRecord[];
      swapped: { sessionFile: string }[];
      notes: { label: string; body: string }[];
      driver: V2ActorDriver;
    } {
      const loaded: TerminalRecord[] = [];
      const swapped: { sessionFile: string }[] = [];
      const notes: { label: string; body: string }[] = [];
      const driver = {
        loadRecord: (r: TerminalRecord): void => {
          loaded.push(r);
        },
        setPersister: (p: { sessionFile: string }): void => {
          swapped.push(p);
        },
        appendSystemNote: (label: string, body: string): void => {
          notes.push({ label, body });
        },
      } as unknown as V2ActorDriver;
      return { loaded, swapped, notes, driver };
    }

    it("prints 'not available' when /resume deps are missing", async () => {
      const out = new MockWritable();
      const r = await handleSlashCommand("/resume", mkCtx({ out }));
      expect(r.action).toBe("continue");
      expect(out.full()).toContain("not available in this build");
    });

    it("bare /resume lists workspace-scoped sessions", async () => {
      writeSession("aaaa1111", "/proj/x");
      writeSession("bbbb2222", "/other");
      const out = new MockWritable();
      const { driver } = mkDriverStub();
      const ctx = {
        ...mkCtx({ out }),
        driver,
        transcriptDir: tmp,
        currentWorkspaceRoot: "/proj/x",
      };
      const r = await handleSlashCommand("/resume", ctx);
      expect(r.action).toBe("continue");
      const text = out.full();
      expect(text).toContain("aaaa1111");
      expect(text).not.toContain("bbbb2222");
      expect(text).toContain("hello from aaaa1111");
    });

    it("bare /resume aliases 板砖→Brick in an EN-born session's preview (zh + legacy literal)", async () => {
      writeSession(
        "eeee1111",
        "/proj/x",
        undefined,
        "en",
        "让 @板砖 修 parser",
      );
      writeSession("cccc2222", "/proj/x", undefined, "zh", "让 @板砖 修 bug");
      writeSession("aaaa3333", "/proj/x", undefined, undefined, "@板砖 干活");
      const out = new MockWritable();
      const { driver } = mkDriverStub();
      const ctx = {
        ...mkCtx({ out }),
        driver,
        transcriptDir: tmp,
        currentWorkspaceRoot: "/proj/x",
      };
      await handleSlashCommand("/resume", ctx);
      const text = out.full();
      // EN-born entry displays the alias; the record itself stays @板砖.
      expect(text).toContain("让 @Brick 修 parser");
      expect(text).not.toContain("让 @板砖 修 parser");
      // zh-born and legacy (no header lang) entries keep the literal token.
      expect(text).toContain("让 @板砖 修 bug");
      expect(text).toContain("@板砖 干活");
    });

    it("/resume all lists across all workspaces", async () => {
      writeSession("aaaa1111", "/proj/x");
      writeSession("bbbb2222", "/other");
      const out = new MockWritable();
      const { driver } = mkDriverStub();
      const ctx = {
        ...mkCtx({ out }),
        driver,
        transcriptDir: tmp,
        currentWorkspaceRoot: "/proj/x",
      };
      await handleSlashCommand("/resume all", ctx);
      const text = out.full();
      expect(text).toContain("aaaa1111");
      expect(text).toContain("bbbb2222");
      expect(text).toContain("/other"); // workspaceRoot shown in `all` mode
    });

    it("/resume latest loads the most recent workspace session", async () => {
      writeSession("aaaa1111", "/proj/x", new Date("2026-05-10T00:00:00Z"));
      writeSession("bbbb2222", "/proj/x", new Date("2026-05-14T00:00:00Z"));
      const out = new MockWritable();
      const { loaded, swapped, driver } = mkDriverStub();
      const ctx = {
        ...mkCtx({ out }),
        driver,
        transcriptDir: tmp,
        currentWorkspaceRoot: "/proj/x",
      };
      await handleSlashCommand("/resume latest", ctx);
      expect(loaded).toHaveLength(1);
      expect(swapped).toHaveLength(1);
      expect(swapped[0]?.sessionFile).toBe(join(tmp, "bbbb2222.jsonl"));
      expect(out.full()).toContain("loaded session bbbb2222");
    });

    it("/resume rebinds the loaded session's own prefix and recap before swapping the record (ADR 0069 §3)", async () => {
      writeSession("bbbb2222", "/proj/x");
      const out = new MockWritable();
      const { loaded, swapped, driver } = mkDriverStub();
      const order: string[] = [];
      const rebound: { sessionId: string; blocks: number }[] = [];
      const ctx = {
        ...mkCtx({ out }),
        driver: {
          ...driver,
          loadRecord: (r: TerminalRecord): void => {
            order.push("loadRecord");
            driver.loadRecord(r);
          },
        } as unknown as V2ActorDriver,
        rebindSession: async (
          sessionId: string,
          record: TerminalRecord,
        ): Promise<void> => {
          order.push("rebind");
          rebound.push({ sessionId, blocks: record.length });
        },
        transcriptDir: tmp,
        currentWorkspaceRoot: "/proj/x",
      };
      await handleSlashCommand("/resume latest", ctx);
      expect(rebound).toEqual([{ sessionId: "bbbb2222", blocks: 1 }]);
      expect(order).toEqual(["rebind", "loadRecord"]);
      expect(loaded).toHaveLength(1);
      expect(swapped).toHaveLength(1);
    });

    it("/resume that cannot prepare the session's prefix stays on the current session", async () => {
      writeSession("bbbb2222", "/proj/x");
      const out = new MockWritable();
      const { loaded, swapped, driver } = mkDriverStub();
      const ctx = {
        ...mkCtx({ out }),
        driver,
        rebindSession: async (): Promise<void> => {
          throw new Error("narrative dir unreadable");
        },
        transcriptDir: tmp,
        currentWorkspaceRoot: "/proj/x",
      };
      await handleSlashCommand("/resume latest", ctx);
      expect(loaded).toHaveLength(0);
      expect(swapped).toHaveLength(0);
      expect(out.full()).toContain("could not prepare bbbb2222");
    });

    it("/resume latest prints empty state when no workspace sessions", async () => {
      const out = new MockWritable();
      const { loaded, driver } = mkDriverStub();
      const ctx = {
        ...mkCtx({ out }),
        driver,
        transcriptDir: tmp,
        currentWorkspaceRoot: "/proj/x",
      };
      await handleSlashCommand("/resume latest", ctx);
      expect(loaded).toHaveLength(0);
      expect(out.full()).toContain("no sessions in this workspace yet");
    });

    it("/resume <unique-prefix> loads the matching session", async () => {
      writeSession("aaaa1111", "/proj/x");
      writeSession("bbbb2222", "/proj/x");
      const out = new MockWritable();
      const { loaded, swapped, driver } = mkDriverStub();
      const ctx = {
        ...mkCtx({ out }),
        driver,
        transcriptDir: tmp,
        currentWorkspaceRoot: "/proj/x",
      };
      await handleSlashCommand("/resume aaa", ctx);
      expect(loaded).toHaveLength(1);
      expect(swapped[0]?.sessionFile).toBe(join(tmp, "aaaa1111.jsonl"));
    });

    it("/resume refuses a session born under the other language", async () => {
      writeSession("eeee1111", "/proj/x", undefined, "en");
      const out = new MockWritable();
      const { loaded, swapped, driver } = mkDriverStub();
      const ctx = {
        ...mkCtx({ out }), // no ctx.lang → this REPL runs as zh
        driver,
        transcriptDir: tmp,
        currentWorkspaceRoot: "/proj/x",
      };
      await handleSlashCommand("/resume eeee", ctx);
      expect(loaded).toHaveLength(0);
      expect(swapped).toHaveLength(0);
      const text = out.full();
      expect(text).toContain("created as en");
      expect(text).toContain("herta --resume eeee1111");
    });

    it("/resume loads a session whose birth language matches the REPL", async () => {
      writeSession("eeee1111", "/proj/x", undefined, "en");
      const out = new MockWritable();
      const { loaded, driver } = mkDriverStub();
      const ctx = {
        ...mkCtx({ out }),
        lang: "en" as const,
        driver,
        transcriptDir: tmp,
        currentWorkspaceRoot: "/proj/x",
      };
      await handleSlashCommand("/resume eeee", ctx);
      expect(loaded).toHaveLength(1);
      expect(out.full()).toContain("loaded session eeee1111");
    });

    it("/resume loads a legacy session (no header lang) under any REPL language", async () => {
      writeSession("aaaa1111", "/proj/x");
      const out = new MockWritable();
      const { loaded, driver } = mkDriverStub();
      const ctx = {
        ...mkCtx({ out }),
        lang: "en" as const,
        driver,
        transcriptDir: tmp,
        currentWorkspaceRoot: "/proj/x",
      };
      await handleSlashCommand("/resume aaaa", ctx);
      expect(loaded).toHaveLength(1);
    });

    it("/resume <ambiguous-prefix> prints candidates and aborts", async () => {
      writeSession("aabb0001", "/proj/x");
      writeSession("aacc0002", "/proj/x");
      const out = new MockWritable();
      const { loaded, driver } = mkDriverStub();
      const ctx = {
        ...mkCtx({ out }),
        driver,
        transcriptDir: tmp,
        currentWorkspaceRoot: "/proj/x",
      };
      await handleSlashCommand("/resume aa", ctx);
      expect(loaded).toHaveLength(0); // not loaded
      const text = out.full();
      expect(text).toContain("ambiguous prefix 'aa'");
      expect(text).toContain("aabb0001");
      expect(text).toContain("aacc0002");
    });

    it("/resume <unknown> prints no-match error", async () => {
      writeSession("aaaa1111", "/proj/x");
      const out = new MockWritable();
      const { loaded, driver } = mkDriverStub();
      const ctx = {
        ...mkCtx({ out }),
        driver,
        transcriptDir: tmp,
        currentWorkspaceRoot: "/proj/x",
      };
      await handleSlashCommand("/resume nope", ctx);
      expect(loaded).toHaveLength(0);
      expect(out.full()).toContain("no session matching 'nope'");
    });

    it("/help lists /resume", async () => {
      const out = new MockWritable();
      await handleSlashCommand("/help", mkCtx({ out }));
      expect(out.full()).toContain("/resume");
    });

    it("relative time for future mtime (clock skew) clamps to '0s ago'", async () => {
      // Set mtime ~10 seconds in the future to simulate clock skew.
      const futureTime = new Date(Date.now() + 10_000);
      writeSession("future01", "/proj/x", futureTime);
      const out = new MockWritable();
      const { driver } = mkDriverStub();
      const ctx = {
        ...mkCtx({ out }),
        driver,
        transcriptDir: tmp,
        currentWorkspaceRoot: "/proj/x",
      };
      await handleSlashCommand("/resume", ctx);
      const text = out.full();
      expect(text).toContain("future01");
      // The clamp ensures we render "0s ago" rather than "-Ns ago".
      expect(text).not.toMatch(/-\d+s ago/);
      expect(text).toContain("0s ago");
    });
  });

  describe("/workspace", () => {
    it("/workspace shows the current effective workspace", async () => {
      const out = new MockWritable();
      const ctx = {
        ...mkCtx({ out }),
        workspaceHolder: { current: "/proj/x" },
        home: "/home/u",
      };
      await handleSlashCommand("/workspace", ctx);
      expect(out.full()).toContain("/proj/x");
    });

    it("/workspace set <path> validates and updates the holder", async () => {
      const out = new MockWritable();
      const holder = { current: "/proj/x" };
      const ctx = {
        ...mkCtx({ out }),
        workspaceHolder: holder,
        home: "/home/u",
      };
      await handleSlashCommand(`/workspace set ${process.cwd()}`, ctx);
      expect(holder.current).toBe(process.cwd());
    });

    it("/workspace set rejects a forbidden root and keeps the holder", async () => {
      const out = new MockWritable();
      const holder = { current: "/proj/x" };
      const ctx = {
        ...mkCtx({ out }),
        workspaceHolder: holder,
        home: "/home/u",
      };
      await handleSlashCommand(
        `/workspace set ${parse(process.cwd()).root}`,
        ctx,
      );
      expect(holder.current).toBe("/proj/x");
    });

    it("/workspace set records a → 系统 note on the driver", async () => {
      const out = new MockWritable();
      const holder = { current: "/proj/x" };
      const notes: { label: string; body: string }[] = [];
      const driver = {
        appendSystemNote: (label: string, body: string): void => {
          notes.push({ label, body });
        },
      } as unknown as V2ActorDriver;
      const ctx = {
        ...mkCtx({ out }),
        workspaceHolder: holder,
        home: "/home/u",
        driver,
      };
      await handleSlashCommand(`/workspace set ${process.cwd()}`, ctx);
      // Cyan confirmation still prints.
      expect(out.full()).toContain("workspace set");
      // And the driver got exactly one out-of-turn system note.
      expect(notes).toHaveLength(1);
      expect(notes[0]?.label).toBe("系统");
      expect(notes[0]?.body).toContain("workspace →");
      expect(notes[0]?.body).toContain(process.cwd());
    });

    it("/workspace reset records a → 系统 note on the driver", async () => {
      const out = new MockWritable();
      const holder = { current: process.cwd() };
      const notes: { label: string; body: string }[] = [];
      const driver = {
        appendSystemNote: (label: string, body: string): void => {
          notes.push({ label, body });
        },
      } as unknown as V2ActorDriver;
      const ctx = {
        ...mkCtx({ out }),
        workspaceHolder: holder,
        home: "/home/u",
        sessionId: "sess-1234",
        driver,
      };
      await handleSlashCommand("/workspace reset", ctx);
      expect(out.full()).toContain("workspace reset");
      expect(notes).toHaveLength(1);
      expect(notes[0]?.label).toBe("系统");
      expect(notes[0]?.body).toContain("workspace →");
    });

    it("/workspace set still works without a driver (cyan print only)", async () => {
      const out = new MockWritable();
      const holder = { current: "/proj/x" };
      const ctx = {
        ...mkCtx({ out }),
        workspaceHolder: holder,
        home: "/home/u",
      };
      await handleSlashCommand(`/workspace set ${process.cwd()}`, ctx);
      expect(holder.current).toBe(process.cwd());
      expect(out.full()).toContain("workspace set");
    });

    it("/workspace without a holder degrades gracefully", async () => {
      const out = new MockWritable();
      await handleSlashCommand("/workspace", mkCtx({ out }));
      expect(out.full().length).toBeGreaterThan(0);
    });

    it("/help lists /workspace", async () => {
      const out = new MockWritable();
      await handleSlashCommand("/help", mkCtx({ out }));
      expect(out.full()).toContain("/workspace");
    });
  });
});
