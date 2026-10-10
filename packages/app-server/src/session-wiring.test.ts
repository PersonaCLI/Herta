import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskResolver } from "@herta/core";
import { FakeProvider } from "@herta/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKEND_PROVIDER_MAX_RETRIES,
  createBackendProvider,
  createBackendStack,
  hostNoteFor,
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
      model: "deepseek-flash",
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.model).toBe("deepseek-flash");
    expect(bodies[0]?.thinking).toEqual({ type: "enabled" });
    expect(bodies[0]?.reasoning_effort).toBe("high");
  });

  it("accepts the Settings vocabulary ('off') and the CLI's (false) alike — the thinking block sent DISABLED (omitted, the API reasons by default)", async () => {
    for (const thinking of ["off", false] as const) {
      const bodies = await postedBodies({
        apiKey: "k",
        model: "deepseek-flash",
        thinking,
      });
      expect(bodies[0]?.thinking).toEqual({ type: "disabled" });
      expect(bodies[0]?.reasoning_effort).toBeUndefined();
    }
    const low = await postedBodies({
      apiKey: "k",
      model: "deepseek-flash",
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
      model: "deepseek-flash",
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
    let seen: { cacheSize: number; autoReview: boolean | null } | null = null;
    const stack = createBackendStack({
      wsHolder: { current: root },
      workspaceRoot: root,
      lang: "zh",
      wantMinimal: false,
      backendProvider: new FakeProvider({ turns: [] }),
      backendModel: "deepseek-v4-pro",
      digestModel: null,
      makeAsk: ({ cache, workspacePermissions }) => {
        seen = {
          cacheSize: cache.size(),
          autoReview: workspacePermissions.autoReview(),
        };
        return noAsk;
      },
    });
    expect(stack.contract).toBe("standard");
    expect(stack.bashPath).toBeNull();
    // The ask resolver was built from the SAME cache/rules the stack exposes.
    expect(seen).toEqual({ cacheSize: 0, autoReview: null });
    const names = stack.backendTools.list().map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("run_command");
    expect(names).toContain("report_finding");
    // Neither contract mounts the digest tool until a document is attached
    // (ADR 0067) — see the environment-gate block below.
    expect(names).not.toContain("digest_document");
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
      backendModel: "deepseek-v4-pro",
      digestModel: null,
      makeAsk: () => noAsk,
    });
    expect(stack.contract).toBe("standard");
    expect(stack.bashPath).toBeNull();
    expect(stack.backendTools.list().map((t) => t.name)).not.toContain("bash");
  });

  it("mounts view_image from the MODEL NAME — one vision rule for both hosts (2026-09-03); the flash itself sees since the 2026-09 API", () => {
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
    // `deepseek-flash` (V4.1 Flash) reads images, and so does the retired
    // vision name DeepSeek still serves with it. Pro does not — and it no
    // longer 400s an image, it says it cannot see it (probe 2026-09-10), so
    // the rule must keep it out. The retired PLAIN flash name is not offered
    // anywhere; an env override using it gets no `view_image`, on purpose.
    expect(names("deepseek-flash")).toContain("view_image");
    expect(names("deepseek-v4-flash-vision-exp")).toContain("view_image");
    expect(names("deepseek-v4-pro")).not.toContain("view_image");
    expect(isVisionModel("deepseek-v4-flash")).toBe(false);
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
        backendModel: "deepseek-v4-pro",
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

    it("linux: no note — the GNU userland is what the backend expects", () => {
      const stack = mkStack("linux", false, mkWorkspace());
      expect(
        stack.backendBuilder.build(buildInput).backendSystem,
      ).not.toContain("# 主机环境");
    });

    it("darwin: BOTH contracts carry the macOS note — its shell is the BSD userland (2026-09-23)", () => {
      const standard = mkStack("darwin", false, mkWorkspace());
      expect(standard.contract).toBe("standard");
      const root = mkWorkspace();
      process.env.HERTA_BASH = root; // any existing path (see above)
      const minimal = mkStack("darwin", true, root);
      expect(minimal.contract).toBe("minimal");
      for (const stack of [standard, minimal]) {
        const sys = stack.backendBuilder.build(buildInput).backendSystem;
        expect(sys).toContain("# 主机环境");
        expect(sys).toContain("macOS");
        expect(sys).not.toContain("Windows"); // not the Windows note
      }
    });

    it("hostNoteFor: the whole decision table", () => {
      expect(hostNoteFor("win32", "standard", "en").hostNote).toContain(
        "Windows",
      );
      expect(hostNoteFor("win32", "minimal", "en")).toEqual({});
      expect(hostNoteFor("darwin", "standard", "en").hostNote).toContain(
        "macOS",
      );
      expect(hostNoteFor("darwin", "minimal", "en").hostNote).toContain(
        "macOS",
      );
      expect(hostNoteFor("linux", "standard", "en")).toEqual({});
      expect(hostNoteFor("linux", "minimal", "en")).toEqual({});
    });
  });

  // ADR 0067: the toolset follows the environment, decided per session at
  // build and at the two events that change it — never per turn, since the
  // tools array heads the prefix the provider caches.
  describe("environment gates (ADR 0067)", () => {
    const names = (stack: ReturnType<typeof createBackendStack>): string[] =>
      stack.backendTools.list().map((t) => t.name);
    const mkStack = (
      root: string,
      extra: { wantMinimal?: boolean; attachmentsPresent?: boolean } = {},
    ) =>
      createBackendStack({
        wsHolder: { current: root },
        workspaceRoot: root,
        lang: "zh",
        wantMinimal: extra.wantMinimal ?? false,
        backendProvider: new FakeProvider({ turns: [] }),
        backendModel: "deepseek-v4-pro",
        digestModel: null,
        makeAsk: () => noAsk,
        ...(extra.attachmentsPresent !== undefined
          ? { attachmentsPresent: extra.attachmentsPresent }
          : {}),
      });

    it("standard contract outside a git repository: no git_status / git_diff, and no list_files anywhere", () => {
      const stack = mkStack(mkWorkspace());
      expect(stack.contract).toBe("standard");
      const n = names(stack);
      expect(n).not.toContain("git_status");
      expect(n).not.toContain("git_diff");
      expect(n).not.toContain("list_files");
      expect(n).toContain("glob");
    });

    it("standard contract inside a git repository: both git tools mount at build", () => {
      const root = mkWorkspace();
      mkdirSync(join(root, ".git"));
      const n = names(mkStack(root));
      expect(n).toContain("git_status");
      expect(n).toContain("git_diff");
    });

    it("refreshGitTools follows the CURRENT workspace: mounts on a move into a repository, unmounts on a move out, idempotent either way", () => {
      const plain = mkWorkspace();
      const repo = mkWorkspace();
      mkdirSync(join(repo, ".git"));
      const wsHolder = { current: plain };
      const stack = createBackendStack({
        wsHolder,
        workspaceRoot: plain,
        lang: "zh",
        wantMinimal: false,
        backendProvider: new FakeProvider({ turns: [] }),
        backendModel: "deepseek-v4-pro",
        digestModel: null,
        makeAsk: () => noAsk,
      });
      expect(names(stack)).not.toContain("git_status");
      stack.refreshGitTools();
      expect(names(stack)).not.toContain("git_status");

      wsHolder.current = repo;
      stack.refreshGitTools();
      stack.refreshGitTools();
      const inRepo = names(stack);
      expect(inRepo.filter((x) => x === "git_status")).toHaveLength(1);
      expect(inRepo).toContain("git_diff");

      wsHolder.current = plain;
      stack.refreshGitTools();
      const out = names(stack);
      expect(out).not.toContain("git_status");
      expect(out).not.toContain("git_diff");
      // Everything else stayed put.
      expect(out).toContain("read_file");
      expect(out).toContain("run_command");
    });

    it("minimal contract: no git tools either way — bash runs git itself; refresh is a no-op", () => {
      const root = mkWorkspace();
      mkdirSync(join(root, ".git"));
      process.env.HERTA_BASH = root;
      const stack = mkStack(root, { wantMinimal: true });
      expect(stack.contract).toBe("minimal");
      expect(names(stack)).not.toContain("git_status");
      stack.refreshGitTools();
      expect(names(stack)).not.toContain("git_status");
      expect(names(stack)).toContain("bash");
    });

    it("digest_document waits for a document: absent at build, mounted once by mountDigestTool, on both contracts", () => {
      const standard = mkStack(mkWorkspace());
      expect(names(standard)).not.toContain("digest_document");
      standard.mountDigestTool();
      standard.mountDigestTool();
      expect(
        names(standard).filter((x) => x === "digest_document"),
      ).toHaveLength(1);

      const root = mkWorkspace();
      process.env.HERTA_BASH = root;
      const minimal = mkStack(root, { wantMinimal: true });
      expect(minimal.contract).toBe("minimal");
      expect(names(minimal)).not.toContain("digest_document");
      minimal.mountDigestTool();
      expect(names(minimal)).toContain("digest_document");
    });

    it("a session that already holds a document (attachmentsPresent) mounts digest_document at build", () => {
      const stack = mkStack(mkWorkspace(), { attachmentsPresent: true });
      expect(names(stack)).toContain("digest_document");
      // The builder lists the live registry per brief, so the frame's tool
      // schemas follow the mount without a rebuild.
      const frame = stack.backendBuilder.build({
        brief: { taskId: "t-1" },
        userMessages: [{ text: "hi" }],
        scopedRepoInstructions: "",
        scopedMemory: "",
        messages: [],
      });
      expect(frame.toolSchemas.map((s) => s.name)).toContain("digest_document");
    });
  });
});
