import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskResolver } from "@herta/core";
import { FakeProvider } from "@herta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKEND_PROVIDER_MAX_RETRIES,
  createBackendProvider,
  createBackendStack,
  isVisionModel,
} from "./session-wiring.js";

describe("BACKEND_PROVIDER_MAX_RETRIES", () => {
  it("is zero — the turn loop's retry policy is the one layer that paces a rate limit (2026-09-03)", () => {
    // With the provider's own two transport retries stacked under the
    // loop's four attempts, one persistent 429 cost twelve full-prompt
    // POSTs. Both hosts (session.ts, the CLI) pass this to the backend
    // provider; the actor and the sidecars keep the transport default.
    expect(BACKEND_PROVIDER_MAX_RETRIES).toBe(0);
  });
});

describe("createBackendProvider — the one backend provider both hosts build (2026-09-03)", () => {
  const frame = {
    stableSystem: "s",
    repoInstructions: "",
    memoryContext: "",
    retrievedLore: "",
    messages: [
      { role: "user" as const, text: "hi", ts: "2026-09-03T00:00:00Z" },
    ],
    toolSchemas: [],
  };

  /** Drive one call through a fetch double that answers 429, and hand back
   *  the request bodies it saw — one per POST. */
  async function postedBodies(
    opts: Parameters<typeof createBackendProvider>[0],
  ): Promise<Record<string, unknown>[]> {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;
    const provider = createBackendProvider({ ...opts, fetchImpl });
    try {
      for await (const _ev of provider.streamChat(
        frame,
        new AbortController().signal,
      )) {
        // consume
      }
    } catch {
      // the 429 surfaces as a ProviderError — the bodies are what we want
    }
    return bodies;
  }

  it("sends the model with thinking high by default, and exactly one POST on a 429", async () => {
    const bodies = await postedBodies({
      apiKey: "k",
      model: "deepseek-v4-flash",
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.model).toBe("deepseek-v4-flash");
    expect(bodies[0]?.thinking).toEqual({ type: "enabled" });
    expect(bodies[0]?.reasoning_effort).toBe("high");
  });

  it("accepts the Settings vocabulary ('off') and the CLI's (false) alike — no thinking block", async () => {
    for (const thinking of ["off", false] as const) {
      const bodies = await postedBodies({
        apiKey: "k",
        model: "deepseek-v4-flash",
        thinking,
      });
      expect(bodies[0]?.thinking).toBeUndefined();
      expect(bodies[0]?.reasoning_effort).toBeUndefined();
    }
    const low = await postedBodies({
      apiKey: "k",
      model: "deepseek-v4-flash",
      thinking: "low",
    });
    expect(low[0]?.reasoning_effort).toBe("low");
  });

  it("honours the base-URL lever", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      urls.push(String(url));
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;
    const provider = createBackendProvider({
      apiKey: "k",
      model: "deepseek-v4-flash",
      baseUrl: "http://127.0.0.1:9/chaos",
      fetchImpl,
    });
    await (async () => {
      for await (const _ev of provider.streamChat(
        frame,
        new AbortController().signal,
      )) {
        // consume
      }
    })().catch(() => undefined);
    expect(urls[0]?.startsWith("http://127.0.0.1:9/chaos")).toBe(true);
  });
});

const originalEnv = { ...process.env };
const tmpDirs: string[] = [];
afterEach(() => {
  process.env = { ...originalEnv };
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

function mkWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "herta-wiring-"));
  tmpDirs.push(dir);
  return dir;
}

const noAsk: AskResolver = {
  present: async () => "deny",
};

describe("createBackendStack", () => {
  it("standard contract: registers the MVP tool set and the file/command rules", () => {
    const root = mkWorkspace();
    let seen: { cacheSize: number; rulesListed: number } | null = null;
    const stack = createBackendStack({
      wsHolder: { current: root },
      workspaceRoot: root,
      lang: "zh",
      wantMinimal: false,
      backendProvider: new FakeProvider({ turns: [] }),
      backendModel: "deepseek-v4-flash",
      digestModel: null,
      makeAsk: ({ cache, rules }) => {
        seen = { cacheSize: cache.size(), rulesListed: rules.list().length };
        return noAsk;
      },
    });
    expect(stack.contract).toBe("standard");
    expect(stack.bashPath).toBeNull();
    // The ask resolver was built from the SAME cache/rules the stack exposes.
    expect(seen).toEqual({ cacheSize: 0, rulesListed: 0 });
    const names = stack.backendTools.list().map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("run_command");
    expect(names).toContain("report_finding");
    // Both contracts mount the digest tool (ADR 0043) — with a null model it
    // answers `unavailable` instead of disappearing.
    expect(names).toContain("digest_document");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("str_replace_editor");
  });

  it("minimal contract falls back to standard when no bash is found", () => {
    const root = mkWorkspace();
    // HERTA_BASH pointing at a nonexistent file makes findBash return null
    // without probing PATH — deterministic on every machine.
    process.env.HERTA_BASH = join(root, "no-such-bash.exe");
    const stack = createBackendStack({
      wsHolder: { current: root },
      workspaceRoot: root,
      lang: "en",
      wantMinimal: true,
      backendProvider: new FakeProvider({ turns: [] }),
      backendModel: "deepseek-v4-flash",
      digestModel: null,
      makeAsk: () => noAsk,
    });
    expect(stack.contract).toBe("standard");
    expect(stack.bashPath).toBeNull();
    expect(stack.backendTools.list().map((t) => t.name)).not.toContain("bash");
  });

  it("mounts view_image from the MODEL NAME — one vision rule for both hosts (2026-09-03)", () => {
    const names = (model: string): string[] =>
      createBackendStack({
        wsHolder: { current: mkWorkspace() },
        workspaceRoot: mkWorkspace(),
        lang: "zh",
        wantMinimal: false,
        backendProvider: new FakeProvider({ turns: [] }),
        backendModel: model,
        digestModel: null,
        makeAsk: () => noAsk,
      })
        .backendTools.list()
        .map((t) => t.name);
    expect(names("deepseek-v4-flash-vision-exp")).toContain("view_image");
    expect(names("deepseek-v4-flash")).not.toContain("view_image");
    expect(isVisionModel("deepseek-v4-flash-vision")).toBe(true);
    expect(isVisionModel("deepseek-v4-pro")).toBe(false);
  });

  // ADR 0044: the standard contract on a Windows host carries the host note
  // (what the machine is, where the Unix habits go); other platforms and the
  // minimal contract never do. Platform injected — these run everywhere.
  describe("host note (ADR 0044)", () => {
    const buildInput = {
      brief: { taskId: "t-1" },
      userMessages: [{ text: "hi" }],
      scopedRepoInstructions: "",
      scopedMemory: "",
      messages: [],
    };
    const mkStack = (
      platform: NodeJS.Platform,
      wantMinimal: boolean,
      root: string,
    ) =>
      createBackendStack({
        wsHolder: { current: root },
        workspaceRoot: root,
        lang: "zh",
        wantMinimal,
        backendProvider: new FakeProvider({ turns: [] }),
        backendModel: "deepseek-v4-flash",
        digestModel: null,
        platform,
        makeAsk: () => noAsk,
      });

    it("win32 + standard: the frame carries the host-environment section", () => {
      const stack = mkStack("win32", false, mkWorkspace());
      expect(stack.contract).toBe("standard");
      const sys = stack.backendBuilder.build(buildInput).backendSystem;
      expect(sys).toContain("# 主机环境");
      expect(sys).toContain("search_text");
    });

    it("win32 + minimal-fallen-back-to-standard: carries it too (this IS the bash-less machine)", () => {
      const root = mkWorkspace();
      process.env.HERTA_BASH = join(root, "no-such-bash.exe");
      const stack = mkStack("win32", true, root);
      expect(stack.contract).toBe("standard");
      expect(stack.backendBuilder.build(buildInput).backendSystem).toContain(
        "# 主机环境",
      );
    });

    it("win32 + minimal (bash present): no note — the shell provides the Unix environment", () => {
      const root = mkWorkspace();
      // Any EXISTING path satisfies findBash's override check; the shell is
      // never spawned by stack construction.
      process.env.HERTA_BASH = root;
      const stack = mkStack("win32", true, root);
      expect(stack.contract).toBe("minimal");
      expect(
        stack.backendBuilder.build(buildInput).backendSystem,
      ).not.toContain("# 主机环境");
    });

    it("non-Windows platforms: no note", () => {
      for (const platform of ["linux", "darwin"] as const) {
        const stack = mkStack(platform, false, mkWorkspace());
        expect(
          stack.backendBuilder.build(buildInput).backendSystem,
        ).not.toContain("# 主机环境");
      }
    });
  });
});
