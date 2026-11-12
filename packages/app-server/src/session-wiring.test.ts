import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskResolver, BrowserHost, ServerHost } from "@herta/core";
import { FakeProvider } from "@herta/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKEND_PROVIDER_MAX_RETRIES,
  BackendUnavailableError,
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "herta-wiring-")));
  tmpDirs.push(dir);
  return dir;
}

const noAsk: AskResolver = {
  present: async () => "deny",
};

describe("createBackendStack", () => {
  // A bash that "exists": any existing path satisfies findBash's override
  // check, and building a stack never starts the shell. Deterministic on a
  // machine with no bash at all; the no-bash tests point it at a missing file.
  beforeEach(() => {
    process.env.HERTA_BASH = mkWorkspace();
  });

  it("registers the one tool set and its rules, and builds the ask resolver from the cache and choices it exposes", () => {
    const root = mkWorkspace();
    let seen: { cacheSize: number; autoReview: boolean | null } | null = null;
    const stack = createBackendStack({
      wsHolder: { current: root },
      workspaceRoot: root,
      lang: "zh",
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
    expect(stack.contract).toBe("minimal");
    expect(stack.bashPath).not.toBeNull();
    expect(stack.unavailable).toBeNull();
    // The ask resolver was built from the SAME cache/rules the stack exposes.
    expect(seen).toEqual({ cacheSize: 0, autoReview: null });
    const names = stack.backendTools.list().map((t) => t.name);
    expect([...names].sort()).toEqual([
      "bash",
      "memory_save",
      "report_finding",
      "show_excerpt",
      "str_replace_editor",
    ]);
    // The digest tool waits for a document (ADR 0067) — see the
    // environment-gate block below. And nothing of the standard set, which
    // was deleted (ADR 0086).
    expect(names).not.toContain("digest_document");
    for (const gone of [
      "read_file",
      "search_text",
      "glob",
      "edit_file",
      "write_new_file",
      "run_command",
      "git_status",
      "git_diff",
    ]) {
      expect(names, gone).not.toContain(gone);
    }
  });

  it("with no bash there is no backend: nothing is fallen back to, and a dispatch is refused with the remedy (ADR 0086)", () => {
    const root = mkWorkspace();
    // HERTA_BASH pointing at a nonexistent file makes findBash return null
    // without probing PATH — deterministic on every machine.
    process.env.HERTA_BASH = join(root, "no-such-bash.exe");
    const mk = (platform: NodeJS.Platform, lang: "en" | "zh") =>
      createBackendStack({
        wsHolder: { current: root },
        workspaceRoot: root,
        lang,
        platform,
        backendProvider: new FakeProvider({ turns: [] }),
        backendModel: "deepseek-v4-pro",
        digestModel: null,
        makeAsk: () => noAsk,
      });
    const stack = mk("win32", "en");
    expect(stack.unavailable).toBe("no_bash");
    expect(stack.contract).toBe("minimal");
    expect(stack.bashPath).toBeNull();
    // Not the standard set, and no shell either: nothing is mounted.
    const names = stack.backendTools.list().map((t) => t.name);
    for (const name of [
      "bash",
      "str_replace_editor",
      "read_file",
      "edit_file",
      "run_command",
    ]) {
      expect(names, name).not.toContain(name);
    }
    expect(() => stack.runtimeFactory()).toThrow(BackendUnavailableError);
    expect(() => stack.runtimeFactory()).toThrow(/Install Git for Windows/);
    expect(() => stack.runtimeFactory()).toThrow(/HERTA_BASH/);
    // Off Windows the remedy does not name a Windows installer; in Chinese
    // it is said in Chinese.
    expect(() => mk("linux", "en").runtimeFactory()).toThrow(/Install bash/);
    expect(() => mk("linux", "en").runtimeFactory()).not.toThrow(/Git for/);
    expect(() => mk("win32", "zh").runtimeFactory()).toThrow(
      /板砖无法执行任务/,
    );

    // With a bash there is a backend, as before.
    process.env.HERTA_BASH = root;
    expect(mk("win32", "en").unavailable).toBeNull();
  });

  it("mounts view_image from the MODEL NAME — one vision rule for both hosts (2026-09-03); the flash itself sees since the 2026-09 API", () => {
    const names = (model: string): string[] =>
      createBackendStack({
        wsHolder: { current: mkWorkspace() },
        workspaceRoot: mkWorkspace(),
        lang: "zh",
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

  it("resolves 板砖's provider and the vision tool when a dispatch starts, from the live model (ADR 0081)", () => {
    let model = "deepseek-v4-pro";
    const providers: string[] = [];
    const providerFor = (m: string): FakeProvider => {
      providers.push(m);
      return new FakeProvider({ turns: [] });
    };
    const stack = createBackendStack({
      wsHolder: { current: mkWorkspace() },
      workspaceRoot: mkWorkspace(),
      lang: "zh",
      backendProvider: () => providerFor(model),
      backendModel: () => model,
      digestModel: null,
      makeAsk: () => noAsk,
    });
    const names = (): string[] => stack.backendTools.list().map((t) => t.name);
    // Built on pro: no eyes, and no provider asked for yet.
    expect(names()).not.toContain("view_image");
    expect(providers).toEqual([]);
    // Settings switches to the flash: nothing changes until a dispatch.
    model = "deepseek-flash";
    expect(names()).not.toContain("view_image");
    stack.runtimeFactory();
    expect(providers).toEqual(["deepseek-flash"]);
    expect(names()).toContain("view_image");
    // And back: the next dispatch drops the tool again.
    model = "deepseek-v4-pro";
    stack.runtimeFactory();
    expect(providers).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(names()).not.toContain("view_image");
  });

  it("mounts web_search / web_fetch with a web client, and lets them run without asking (ADR 0080)", async () => {
    const webClient = {
      search: async () => [],
      fetchPage: async () => ({ title: "", markdown: "" }),
    };
    let asked = 0;
    const build = (client: typeof webClient | null) =>
      createBackendStack({
        wsHolder: { current: mkWorkspace() },
        workspaceRoot: mkWorkspace(),
        lang: "zh",
        backendProvider: new FakeProvider({ turns: [] }),
        backendModel: "deepseek-v4-pro",
        digestModel: null,
        webClient: client,
        makeAsk: () => ({
          present: async () => {
            asked += 1;
            return "deny" as const;
          },
        }),
      });
    const withWeb = build(webClient);
    const names = withWeb.backendTools.list().map((t) => t.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    const ctx = {
      sessionId: "s",
      signal: new AbortController().signal,
      workspaceRoot: mkWorkspace(),
    } as unknown as Parameters<typeof withWeb.permissions.check>[1];
    for (const tool of ["web_search", "web_fetch"]) {
      const d = await withWeb.permissions.check(
        { id: "1", tool, input: {} },
        ctx,
      );
      expect(d.kind).toBe("allow");
    }
    expect(asked).toBe(0);
    const without = build(null)
      .backendTools.list()
      .map((t) => t.name);
    expect(without).not.toContain("web_search");
    expect(without).not.toContain("web_fetch");
  });

  it("mounts the page steps with a browser page: loopback free, another host refused, and act and screenshot follow the model's eyes (ADR 0083)", async () => {
    let model = "deepseek-v4-pro";
    let url: string | null = null;
    const browser = {
      sessionKey: "s",
      currentUrl: () => url,
    } as unknown as BrowserHost;
    const build = (page: BrowserHost | null) =>
      createBackendStack({
        wsHolder: { current: mkWorkspace() },
        workspaceRoot: mkWorkspace(),
        lang: "zh",
        backendProvider: new FakeProvider({ turns: [] }),
        backendModel: () => model,
        digestModel: null,
        browser: page,
        makeAsk: () => noAsk,
      });
    const stack = build(browser);
    stack.runtimeFactory();
    const names = (): string[] => stack.backendTools.list().map((t) => t.name);
    for (const tool of [
      "browser_navigate",
      "browser_read",
      "browser_act",
      "browser_screenshot",
    ])
      expect(names()).toContain(tool);
    const actSchema = (): string =>
      JSON.stringify(
        stack.backendTools.get("browser_act")?.schema().inputSchema,
      );
    // Pro reads no images: no positions to give.
    expect(actSchema()).not.toContain('"x"');
    model = "deepseek-flash";
    stack.runtimeFactory();
    expect(actSchema()).toContain('"x"');
    const ctx = {
      sessionId: "s",
      signal: new AbortController().signal,
      workspaceRoot: mkWorkspace(),
    } as unknown as Parameters<typeof stack.permissions.check>[1];
    const check = (tool: string, input: unknown) =>
      stack.permissions.check({ id: "1", tool, input }, ctx);
    expect(
      (await check("browser_navigate", { url: "localhost:5173" })).kind,
    ).toBe("allow");
    expect(
      (await check("browser_navigate", { url: "https://example.com" })).kind,
    ).toBe("deny");
    url = "https://github.com/login";
    expect((await check("browser_read", { mode: "tree" })).kind).toBe("deny");
    // Without a page, none of them.
    const without = build(null)
      .backendTools.list()
      .map((t) => t.name);
    expect(without.some((n) => n.startsWith("browser_"))).toBe(false);
  });

  it("mounts dev_server with a launcher: a start asks as run_command would, a list is free (ADR 0083 §5)", async () => {
    const ws = mkWorkspace();
    writeFileSync(
      join(ws, "herta.launch.json"),
      JSON.stringify({
        version: 1,
        servers: [
          { name: "web", command: "npm", args: ["run", "dev"], port: 5173 },
        ],
      }),
    );
    const servers = {
      list: () => [],
      status: () => null,
    } as unknown as ServerHost;
    const build = (host: ServerHost | null) =>
      createBackendStack({
        wsHolder: { current: ws },
        workspaceRoot: ws,
        lang: "zh",
        backendProvider: new FakeProvider({ turns: [] }),
        backendModel: () => "deepseek-v4-pro",
        digestModel: null,
        servers: host,
        makeAsk: () => noAsk,
      });
    const stack = build(servers);
    expect(stack.backendTools.get("dev_server")).toBeDefined();
    const ctx = {
      sessionId: "s",
      signal: new AbortController().signal,
      workspaceRoot: ws,
    } as unknown as Parameters<typeof stack.permissions.check>[1];
    const check = (input: unknown) =>
      stack.permissions.check({ id: "1", tool: "dev_server", input }, ctx);
    expect((await check({ action: "list" })).kind).toBe("allow");
    expect((await check({ action: "start", name: "web" })).kind).not.toBe(
      "allow",
    );
    expect(build(null).backendTools.get("dev_server")).toBeUndefined();
  });

  // ADR 0044: on macOS the frame carries the host note (its shell is a BSD
  // userland). Windows carried one for the standard set, which told it there
  // was no bash; with no bash there is no backend now. Platform injected —
  // these run everywhere.
  describe("host note (ADR 0044)", () => {
    const buildInput = {
      brief: { taskId: "t-1" },
      userMessages: [{ text: "hi" }],
      scopedMemory: "",
      messages: [],
    };
    const mkStack = (platform: NodeJS.Platform, root: string) =>
      createBackendStack({
        wsHolder: { current: root },
        workspaceRoot: root,
        lang: "zh",
        backendProvider: new FakeProvider({ turns: [] }),
        backendModel: "deepseek-v4-pro",
        digestModel: null,
        platform,
        makeAsk: () => noAsk,
      });

    it("win32 with no bash: no backend, so no frame to carry a note (ADR 0086)", () => {
      const root = mkWorkspace();
      process.env.HERTA_BASH = join(root, "no-such-bash.exe");
      const stack = mkStack("win32", root);
      // This used to be the standard set with the host note; it is nothing
      // now, and says so where a dispatch would have started.
      expect(stack.unavailable).toBe("no_bash");
      expect(() => stack.runtimeFactory()).toThrow(/Git for Windows/);
    });

    it("win32 with a bash: no note — the shell provides the Unix environment", () => {
      const stack = mkStack("win32", mkWorkspace());
      expect(stack.unavailable).toBeNull();
      expect(
        stack.backendBuilder.build(buildInput).backendSystem,
      ).not.toContain("# 主机环境");
    });

    it("linux: no note — the GNU userland is what the backend expects", () => {
      const stack = mkStack("linux", mkWorkspace());
      expect(
        stack.backendBuilder.build(buildInput).backendSystem,
      ).not.toContain("# 主机环境");
    });

    it("darwin: the frame carries the macOS note — its shell is the BSD userland (2026-09-23)", () => {
      const sys = mkStack("darwin", mkWorkspace()).backendBuilder.build(
        buildInput,
      ).backendSystem;
      expect(sys).toContain("# 主机环境");
      expect(sys).toContain("macOS");
      expect(sys).not.toContain("Windows");
    });

    it("hostNoteFor: the whole decision table", () => {
      expect(hostNoteFor("win32", "en")).toEqual({});
      expect(hostNoteFor("linux", "en")).toEqual({});
      expect(hostNoteFor("darwin", "en").hostNote).toContain("macOS");
      expect(hostNoteFor("darwin", "zh").hostNote).toContain("macOS");
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
      extra: { attachmentsPresent?: boolean } = {},
    ) =>
      createBackendStack({
        wsHolder: { current: root },
        workspaceRoot: root,
        lang: "zh",
        backendProvider: new FakeProvider({ turns: [] }),
        backendModel: "deepseek-v4-pro",
        digestModel: null,
        makeAsk: () => noAsk,
        ...(extra.attachmentsPresent !== undefined
          ? { attachmentsPresent: extra.attachmentsPresent }
          : {}),
      });

    it("no git tools, inside a repository or out of one: bash runs git itself", () => {
      const plain = mkWorkspace();
      const repo = mkWorkspace();
      mkdirSync(join(repo, ".git"));
      for (const root of [plain, repo]) {
        const n = names(mkStack(root));
        expect(n).toContain("bash");
        expect(n).not.toContain("git_status");
        expect(n).not.toContain("git_diff");
        expect(n).not.toContain("list_files");
      }
    });

    it("digest_document waits for a document: absent at build, mounted once by mountDigestTool", () => {
      const stack = mkStack(mkWorkspace());
      expect(names(stack)).not.toContain("digest_document");
      stack.mountDigestTool();
      stack.mountDigestTool();
      expect(names(stack).filter((x) => x === "digest_document")).toHaveLength(
        1,
      );
    });

    it("a session that already holds a document (attachmentsPresent) mounts digest_document at build", () => {
      const stack = mkStack(mkWorkspace(), { attachmentsPresent: true });
      expect(names(stack)).toContain("digest_document");
      // The builder lists the live registry per brief, so the frame's tool
      // schemas follow the mount without a rebuild.
      const frame = stack.backendBuilder.build({
        brief: { taskId: "t-1" },
        userMessages: [{ text: "hi" }],
        scopedMemory: "",
        messages: [],
      });
      expect(frame.toolSchemas.map((s) => s.name)).toContain("digest_document");
    });
  });
});
