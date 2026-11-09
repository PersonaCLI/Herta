import type {
  MemoryItem,
  MemoryManager,
  MemoryQuery,
  MemoryReplaceOutcome,
} from "@herta/core";
import { FileMemoryManager } from "@herta/memory";
import { describe, expect, it, onTestFinished } from "vitest";
import { mkTmpWorkspace } from "../testing/tmp-workspace.js";
import { mkToolContext } from "../testing/tool-context.js";
import { memorySaveTool } from "./index.js";

class CapturingMemoryManager implements MemoryManager {
  saved: MemoryItem[] = [];
  async recall(_q: MemoryQuery): Promise<MemoryItem[]> {
    return this.saved;
  }
  async save(item: MemoryItem): Promise<void> {
    this.saved.push(item);
  }
  async replace(
    _handle: string,
    _item: MemoryItem,
  ): Promise<MemoryReplaceOutcome> {
    return { ok: false, reason: "not_found" };
  }
  currentItems(): readonly MemoryItem[] {
    return this.saved;
  }
}

describe("memory_save tool", () => {
  it("saves a valid item and returns ok with id+kind+text", async () => {
    const memory = new CapturingMemoryManager();
    const r = await memorySaveTool().run(
      {
        id: "c1",
        tool: "memory_save",
        input: {
          kind: "build_command",
          text: "pnpm build",
          why: "the user said the build runs through pnpm",
        },
      },
      mkToolContext({ workspaceRoot: "/tmp/x", memory }),
      () => {},
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as {
      id: string;
      kind: string;
      text: string;
      why: string;
    };
    expect(data.kind).toBe("build_command");
    expect(data.why).toBe("the user said the build runs through pnpm");
    expect(data.text).toBe("pnpm build");
    expect(typeof data.id).toBe("string");
    expect(memory.saved.length).toBe(1);
    expect(memory.saved[0]?.kind).toBe("build_command");
    expect(memory.saved[0]?.confidence).toBe(1);
    expect(memory.saved[0]?.scope).toBe("repo");
    expect(memory.saved[0]?.why).toBe(
      "the user said the build runs through pnpm",
    );
  });

  it("rejects invalid kind with invalid_input", async () => {
    const memory = new CapturingMemoryManager();
    const r = await memorySaveTool().run(
      {
        id: "c1",
        tool: "memory_save",
        input: { kind: "not_a_real_kind", text: "x", why: "y" },
      },
      mkToolContext({ workspaceRoot: "/tmp/x", memory }),
      () => {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("invalid_input");
    expect(memory.saved.length).toBe(0);
  });

  it("rejects text > 500 characters with invalid_input", async () => {
    const memory = new CapturingMemoryManager();
    const r = await memorySaveTool().run(
      {
        id: "c1",
        tool: "memory_save",
        input: { kind: "repo_fact", text: "x".repeat(501), why: "y" },
      },
      mkToolContext({ workspaceRoot: "/tmp/x", memory }),
      () => {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("invalid_input");
    expect(memory.saved.length).toBe(0);
  });

  it("a reason is required: a fact with no why is invalid_input (ADR 0077)", async () => {
    const memory = new CapturingMemoryManager();
    const r = await memorySaveTool().run(
      {
        id: "c1",
        tool: "memory_save",
        input: { kind: "repo_fact", text: "x" },
      },
      mkToolContext({ workspaceRoot: "/tmp/x", memory }),
      () => {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("invalid_input");
    expect(r.suggestion).toContain("why");
    expect(memory.saved.length).toBe(0);
  });

  it("the same fact saved again re-confirms it: one item, its date and reason refreshed (ADR 0077)", async () => {
    const ws = await mkTmpWorkspace({});
    try {
      const memory = new FileMemoryManager({ workspaceRoot: ws.root });
      const ctx = mkToolContext({ workspaceRoot: ws.root, memory });
      const save = (why: string) =>
        memorySaveTool().run(
          {
            id: "c1",
            tool: "memory_save",
            input: { kind: "test_command" as const, text: "pnpm vitest", why },
          },
          ctx,
          () => {},
        );
      const r1 = await save("first run found it");
      const [first] = await memory.recall({});
      await new Promise((r) => setTimeout(r, 5));
      const r2 = await save("the user confirmed it");
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      const items = await memory.recall({});
      expect(items.length).toBe(1);
      expect(items[0]?.id).toBe(first?.id);
      expect(items[0]?.createdAt).toBe(first?.createdAt);
      expect(items[0]?.why).toBe("the user confirmed it");
      expect((items[0]?.lastSeen ?? "") > (first?.lastSeen ?? "")).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });

  it("describes what is worth saving and what is not", () => {
    const description = memorySaveTool().schema().description;
    for (const part of [
      "cannot tell a later run",
      "preference or correction the user stated",
      "Do NOT save",
      "code, the config or git",
      "progress on the current task",
      "secrets",
    ])
      expect(description, part).toContain(part);
  });

  it("redacts secret-shaped substrings in text before saving", async () => {
    const memory = new CapturingMemoryManager();
    await memorySaveTool().run(
      {
        id: "c1",
        tool: "memory_save",
        input: {
          kind: "herta_lesson",
          text: "AWS key leaked: AKIAIOSFODNN7EXAMPLE — rotated.",
          why: "found key AKIAIOSFODNN7EXAMPLE in a log",
        },
      },
      mkToolContext({ workspaceRoot: "/tmp/x", memory }),
      () => {},
    );
    expect(memory.saved.length).toBe(1);
    const stored = memory.saved[0]?.text ?? "";
    expect(stored).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(stored).toContain("[REDACTED:aws_access_key]");
    // The reason is redacted the same way.
    expect(memory.saved[0]?.why ?? "").not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  describe("replaces — a correction (ADR 0077 amendment 2026-11-09)", () => {
    async function run(memory: MemoryManager, input: Record<string, unknown>) {
      return memorySaveTool().run(
        { id: "c", tool: "memory_save", input },
        mkToolContext({ workspaceRoot: "/tmp/x", memory }),
        () => {},
      );
    }

    it("takes the named fact out and says which, in its data and its summary", async () => {
      const ws = await mkTmpWorkspace({});
      onTestFinished(() => ws.cleanup());
      const memory = new FileMemoryManager({ workspaceRoot: ws.root });
      const first = await run(memory, {
        kind: "test_command",
        text: "the tests run with node --test test/",
        why: "the user said so",
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const oldId = (first.data as { id: string }).id;

      const r = await run(memory, {
        kind: "test_command",
        text: "the tests run with bare node --test",
        why: "node --test test/ failed on Node 22 in this run; bare node --test passed",
        replaces: `id:${oldId.slice(0, 8)}`,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const data = r.data as { replaced?: { id: string; text: string } };
      expect(data.replaced).toEqual({
        id: oldId,
        kind: "test_command",
        text: "the tests run with node --test test/",
      });
      expect(r.summary).toBe(
        `remembered: test_command, replacing ${oldId.slice(0, 8)}`,
      );
      const texts = (await memory.recall({})).map((it) => it.text);
      expect(texts).toEqual(["the tests run with bare node --test"]);
    });

    it("an id that names no fact saves nothing, and says how to name one", async () => {
      const ws = await mkTmpWorkspace({});
      onTestFinished(() => ws.cleanup());
      const memory = new FileMemoryManager({ workspaceRoot: ws.root });
      const r = await run(memory, {
        kind: "test_command",
        text: "bare node --test",
        why: "it passed",
        replaces: "deadbeef",
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error?.code).toBe("replaces_not_found");
      expect(r.error?.retryable).toBe(true);
      expect(r.suggestion).toContain("id:");
      expect(await memory.recall({})).toEqual([]);
    });

    it("its schema field is described for the model", () => {
      const schema = memorySaveTool().schema().inputSchema as {
        properties: Record<string, { description?: string }>;
        required?: string[];
      };
      expect(schema.properties.replaces?.description).toContain("id:");
      expect(schema.required ?? []).not.toContain("replaces");
    });
  });
});
