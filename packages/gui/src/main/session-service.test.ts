import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import type { Session, SessionMetadata } from "@herta/app-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildConfig,
  findProjectRoot,
  handleSetWorkspace,
  isSafeSessionId,
  mainNavigationBlock,
  pickLatest,
  resolveWorkspaceRoot,
  sanitizeCreateOpts,
  sanitizeLogQuery,
  startForwarders,
} from "./session-service.js";

describe("sanitizeLogQuery (the history tab's IPC door, ADR 0059 §6)", () => {
  it("passes integer paging, a branch-shaped ref and a trimmed query; drops an empty query", () => {
    expect(sanitizeLogQuery({ skip: 0, limit: 50 })).toEqual({
      skip: 0,
      limit: 50,
    });
    expect(
      sanitizeLogQuery({
        skip: 50,
        limit: 50,
        ref: "feature/x",
        query: " fix ",
      }),
    ).toEqual({ skip: 50, limit: 50, ref: "feature/x", query: "fix" });
    expect(sanitizeLogQuery({ skip: 0, limit: 50, query: "   " })).toEqual({
      skip: 0,
      limit: 50,
    });
  });

  it("refuses non-objects, bad paging, an option-shaped or malformed ref, and an oversized query", () => {
    expect(sanitizeLogQuery(null)).toBeNull();
    expect(sanitizeLogQuery("x")).toBeNull();
    expect(sanitizeLogQuery({ skip: -1, limit: 50 })).toBeNull();
    expect(sanitizeLogQuery({ skip: 0.5, limit: 50 })).toBeNull();
    expect(sanitizeLogQuery({ skip: 0, limit: 0 })).toBeNull();
    expect(sanitizeLogQuery({ skip: 0, limit: 10_000 })).toBeNull();
    expect(
      sanitizeLogQuery({ skip: 0, limit: 50, ref: "--output=x" }),
    ).toBeNull();
    expect(sanitizeLogQuery({ skip: 0, limit: 50, ref: "a..b" })).toBeNull();
    expect(sanitizeLogQuery({ skip: 0, limit: 50, ref: 7 })).toBeNull();
    expect(
      sanitizeLogQuery({ skip: 0, limit: 50, query: "q".repeat(201) }),
    ).toBeNull();
  });
});

describe("isSafeSessionId (IPC boundary, audit 2026-07-13 T1.2)", () => {
  it("accepts host-minted UUIDs and plain stems", () => {
    expect(isSafeSessionId("0b6e6d0e-4f3a-4d55-9d3c-2a9c8f7e1b2d")).toBe(true);
    expect(isSafeSessionId("legacy_stem-01")).toBe(true);
  });

  it("rejects traversal, separators, drives, dots, and non-strings", () => {
    expect(isSafeSessionId("../../../../Users/x/report")).toBe(false);
    expect(isSafeSessionId("..")).toBe(false);
    expect(isSafeSessionId("a/b")).toBe(false);
    expect(isSafeSessionId("a\\b")).toBe(false);
    expect(isSafeSessionId("C:evil")).toBe(false);
    expect(isSafeSessionId("a.b")).toBe(false);
    expect(isSafeSessionId("")).toBe(false);
    expect(isSafeSessionId(42)).toBe(false);
    expect(isSafeSessionId(undefined)).toBe(false);
  });
});

describe("sanitizeCreateOpts (IPC boundary, audit 2026-07-13 T1.2)", () => {
  const home = join(tmpdir(), "fake-home");

  it("passes the renderer's normal shapes through", () => {
    expect(sanitizeCreateOpts({}, home)).toEqual({});
    expect(sanitizeCreateOpts(undefined, home)).toEqual({});
    expect(sanitizeCreateOpts(null, home)).toEqual({});
  });

  it("rejects non-object opts and non-string overrides", () => {
    expect(sanitizeCreateOpts("x", home)).toBeNull();
    expect(sanitizeCreateOpts({ backendWorkspace: 5 }, home)).toBeNull();
    expect(sanitizeCreateOpts({ workspaceRoot: [] }, home)).toBeNull();
  });

  it("rejects a backendWorkspace that fails the D4 workspace guard", () => {
    // The home dir itself and a filesystem root are both forbidden roots.
    expect(sanitizeCreateOpts({ backendWorkspace: home }, home)).toBeNull();
    expect(
      sanitizeCreateOpts({ workspaceRoot: parse(home).root }, home),
    ).toBeNull();
  });

  it("resolves and passes a legitimate override", () => {
    const ws = mkdtempSync(join(tmpdir(), "herta-create-ws-"));
    expect(sanitizeCreateOpts({ backendWorkspace: ws }, home)).toEqual({
      backendWorkspace: ws,
    });
  });
});

describe("mainNavigationBlock (tray navigation guards — audit 2026-07-10)", () => {
  const activeIdle = { sessionId: "s-1", overlay: null };
  const activeGated = {
    sessionId: "s-1",
    overlay: { kind: "pending-permission" },
  };

  it("allows switching to a DIFFERENT session while idle", () => {
    expect(mainNavigationBlock(activeIdle, "s-2")).toBeNull();
  });

  it("allows new-chat while idle", () => {
    expect(mainNavigationBlock(activeIdle)).toBeNull();
  });

  it("allows anything with no active session (bootstrap)", () => {
    expect(mainNavigationBlock(null, "s-2")).toBeNull();
    expect(mainNavigationBlock(null)).toBeNull();
  });

  it("blocks re-opening the ACTIVE session (mid-turn teardown hazard)", () => {
    expect(mainNavigationBlock(activeIdle, "s-1")).toBe("already-active");
  });

  it("blocks switch AND new-chat while an approval gate is pending (silent auto-deny hazard)", () => {
    expect(mainNavigationBlock(activeGated, "s-2")).toBe("gate-pending");
    expect(mainNavigationBlock(activeGated)).toBe("gate-pending");
    // Gate check dominates even for the same-session case.
    expect(mainNavigationBlock(activeGated, "s-1")).toBe("gate-pending");
  });

  it("blocks switch AND new-chat while a turn is in flight (2026-07-12 — the caller fronts the window instead)", () => {
    const activeBusy = { sessionId: "s-1", overlay: null, turnInFlight: true };
    expect(mainNavigationBlock(activeBusy, "s-2")).toBe("turn-in-flight");
    expect(mainNavigationBlock(activeBusy)).toBe("turn-in-flight");
    // A pending gate still dominates (it is the stricter hazard)…
    const gatedBusy = {
      sessionId: "s-1",
      overlay: { kind: "pending-permission" },
      turnInFlight: true,
    };
    expect(mainNavigationBlock(gatedBusy, "s-2")).toBe("gate-pending");
    // …and the same-session no-op stays "already-active" (no window flash).
    expect(mainNavigationBlock(activeBusy, "s-1")).toBe("already-active");
  });
});

describe("buildConfig", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a config with the secure-store key, dirs, models, and thinking", async () => {
    vi.stubEnv("HERTA_ACTOR_MODEL", undefined);
    vi.stubEnv("HERTA_BACKEND_MODEL", undefined);
    const cwd = mkdtempSync(join(tmpdir(), "herta-bc-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "herta-bc-home-"));
    const cfg = await buildConfig(cwd, home, "sk-test-123");
    expect(cfg.workspaceRoot).toBe(cwd);
    expect(cfg.providers.deepseekApiKey).toBe("sk-test-123");
    // Must match the working CLI: the completion endpoint accepts only
    // deepseek-flash / deepseek-v4-pro (2026-09-10; deepseek-v4-base 400s).
    // Defaults: actor Pro (owner 2026-08-17); backend the flash — the
    // vision-capable one since the rename (owner 2026-08-28, ADR 0048
    // §5a/§5b — 板砖 can re-look out of the box).
    expect(cfg.providers.actorModel).toBe("deepseek-v4-pro");
    expect(cfg.providers.backendModel).toBe("deepseek-flash");
    expect(cfg.providers.routerModel).toBe("deepseek-flash");
    // "high" is the default backend reasoning effort (Settings → Coprocessor
    // can lower/raise it; with no settings file the default stands).
    expect(cfg.thinking).toBe("high");
    expect(cfg.transcriptDir).toContain(".herta");
  });

  it("honors HERTA_ACTOR_MODEL / HERTA_BACKEND_MODEL overrides", async () => {
    vi.stubEnv("HERTA_ACTOR_MODEL", "deepseek-flash");
    vi.stubEnv("HERTA_BACKEND_MODEL", "deepseek-flash");
    const cwd = mkdtempSync(join(tmpdir(), "herta-bc-cwd-ov-"));
    const home = mkdtempSync(join(tmpdir(), "herta-bc-home-ov-"));
    const cfg = await buildConfig(cwd, home, "sk-test-123");
    expect(cfg.providers.actorModel).toBe("deepseek-flash");
    expect(cfg.providers.backendModel).toBe("deepseek-flash");
  });

  it("defaults Dream enabled to true with no settings file", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "herta-bc-dream-"));
    const home = mkdtempSync(join(tmpdir(), "herta-bc-dreamh-"));
    const cfg = await buildConfig(cwd, home, "sk-test-123");
    expect(cfg.dream?.enabled).toBe(true);
  });

  it("honors a persisted Dream enabled:false from settings.json", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "herta-bc-dream2-"));
    const home = mkdtempSync(join(tmpdir(), "herta-bc-dream2h-"));
    mkdirSync(join(cwd, ".herta"), { recursive: true });
    writeFileSync(
      join(cwd, ".herta", "settings.json"),
      JSON.stringify({ dream: { enabled: false } }),
      "utf-8",
    );
    const cfg = await buildConfig(cwd, home, "sk-test-123");
    expect(cfg.dream?.enabled).toBe(false);
  });

  it("honors a persisted backend thinking tier from settings.json", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "herta-bc-think-"));
    const home = mkdtempSync(join(tmpdir(), "herta-bc-thinkh-"));
    mkdirSync(join(cwd, ".herta"), { recursive: true });
    writeFileSync(
      join(cwd, ".herta", "settings.json"),
      JSON.stringify({ backend: { thinking: "low" } }),
      "utf-8",
    );
    const cfg = await buildConfig(cwd, home, "sk-test-123");
    expect(cfg.thinking).toBe("low");
  });

  it("honors a persisted per-stage model choice from settings.json (2026-08-17)", async () => {
    vi.stubEnv("HERTA_ACTOR_MODEL", undefined);
    vi.stubEnv("HERTA_BACKEND_MODEL", undefined);
    const cwd = mkdtempSync(join(tmpdir(), "herta-bc-model-"));
    const home = mkdtempSync(join(tmpdir(), "herta-bc-modelh-"));
    mkdirSync(join(cwd, ".herta"), { recursive: true });
    writeFileSync(
      join(cwd, ".herta", "settings.json"),
      JSON.stringify({ models: { actor: "deepseek-flash" } }),
      "utf-8",
    );
    const cfg = await buildConfig(cwd, home, "sk-test-123");
    // Actor follows the setting; backend, unset, keeps the built-in default
    // (the flash). A PERSISTED backend choice is also honored.
    expect(cfg.providers.actorModel).toBe("deepseek-flash");
    expect(cfg.providers.backendModel).toBe("deepseek-flash");
    writeFileSync(
      join(cwd, ".herta", "settings.json"),
      JSON.stringify({ models: { backend: "deepseek-v4-pro" } }),
      "utf-8",
    );
    expect(
      (await buildConfig(cwd, home, "sk-test-123")).providers.backendModel,
    ).toBe("deepseek-v4-pro");
  });

  it("a settings.json from before the 2026-09 rename still means the flash — for BOTH stages, and the retired vision row folds into it", async () => {
    vi.stubEnv("HERTA_ACTOR_MODEL", undefined);
    vi.stubEnv("HERTA_BACKEND_MODEL", undefined);
    const cwd = mkdtempSync(join(tmpdir(), "herta-bc-legacy-"));
    const home = mkdtempSync(join(tmpdir(), "herta-bc-legacyh-"));
    mkdirSync(join(cwd, ".herta"), { recursive: true });
    writeFileSync(
      join(cwd, ".herta", "settings.json"),
      JSON.stringify({
        models: {
          actor: "deepseek-v4-flash",
          backend: "deepseek-v4-flash-vision-exp",
        },
      }),
      "utf-8",
    );
    const cfg = await buildConfig(cwd, home, "sk-test-123");
    // Not the Pro default: a user who had picked the flash keeps the flash
    // (and its price) across the rename.
    expect(cfg.providers.actorModel).toBe("deepseek-flash");
    expect(cfg.providers.backendModel).toBe("deepseek-flash");
  });

  it("an env override still beats the setting (dev/lab knob), and an off-enum setting is ignored", async () => {
    vi.stubEnv("HERTA_ACTOR_MODEL", "deepseek-v4-pro");
    vi.stubEnv("HERTA_BACKEND_MODEL", undefined);
    const cwd = mkdtempSync(join(tmpdir(), "herta-bc-model2-"));
    const home = mkdtempSync(join(tmpdir(), "herta-bc-model2h-"));
    mkdirSync(join(cwd, ".herta"), { recursive: true });
    writeFileSync(
      join(cwd, ".herta", "settings.json"),
      JSON.stringify({
        models: { actor: "deepseek-flash", backend: "deepseek-v4-base" },
      }),
      "utf-8",
    );
    const cfg = await buildConfig(cwd, home, "sk-test-123");
    expect(cfg.providers.actorModel).toBe("deepseek-v4-pro"); // env won
    // off-enum → the built-in default (the flash)
    expect(cfg.providers.backendModel).toBe("deepseek-flash");
  });

  it("backendContract (ADR 0040): default MINIMAL (owner flip 2026-08-17); setting honored; env beats setting; off-enum → default", async () => {
    vi.stubEnv("HERTA_BACKEND_CONTRACT", undefined);
    const cwd = mkdtempSync(join(tmpdir(), "herta-bc-contract-"));
    const home = mkdtempSync(join(tmpdir(), "herta-bc-contracth-"));
    expect((await buildConfig(cwd, home, "sk")).backendContract).toBe(
      "minimal",
    );
    mkdirSync(join(cwd, ".herta"), { recursive: true });
    writeFileSync(
      join(cwd, ".herta", "settings.json"),
      JSON.stringify({ backend: { thinking: "high", contract: "standard" } }),
      "utf-8",
    );
    expect((await buildConfig(cwd, home, "sk")).backendContract).toBe(
      "standard",
    );
    vi.stubEnv("HERTA_BACKEND_CONTRACT", "minimal");
    expect((await buildConfig(cwd, home, "sk")).backendContract).toBe(
      "minimal",
    );
    vi.stubEnv("HERTA_BACKEND_CONTRACT", undefined);
    writeFileSync(
      join(cwd, ".herta", "settings.json"),
      JSON.stringify({ backend: { contract: "极简" } }),
      "utf-8",
    );
    expect((await buildConfig(cwd, home, "sk")).backendContract).toBe(
      "minimal",
    );
  });

  it("falls back to 'high' for an off-enum hand-edited thinking value", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "herta-bc-think2-"));
    const home = mkdtempSync(join(tmpdir(), "herta-bc-think2h-"));
    mkdirSync(join(cwd, ".herta"), { recursive: true });
    writeFileSync(
      join(cwd, ".herta", "settings.json"),
      JSON.stringify({ backend: { thinking: "medium" } }),
      "utf-8",
    );
    const cfg = await buildConfig(cwd, home, "sk-test-123");
    expect(cfg.thinking).toBe("high");
  });

  it("uses the secure-store key", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "herta-bc-cwd3-"));
    const home = mkdtempSync(join(tmpdir(), "herta-bc-home3-"));
    const cfg = await buildConfig(cwd, home, "sk-secure");
    expect(cfg.providers.deepseekApiKey).toBe("sk-secure");
  });

  it("voiceAssetsDir: dev default under the workspace, packaged override wins", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "herta-bc-voice-"));
    const home = mkdtempSync(join(tmpdir(), "herta-bc-voiceh-"));
    // No override → defaultDirsFor's dev layout.
    const dev = await buildConfig(cwd, home, null);
    expect(dev.voiceAssetsDir).toBe(join(cwd, "data", "voice"));
    // Packaged override (resolveVoiceRoot output) is passed through verbatim.
    const packagedRoot = join(cwd, "fake-resources", "voice");
    const packaged = await buildConfig(cwd, home, null, packagedRoot);
    expect(packaged.voiceAssetsDir).toBe(packagedRoot);
  });

  it("tolerates no key (empty string, no throw) — onboarding is deferred to submit", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "herta-bc-cwd2-"));
    const home = mkdtempSync(join(tmpdir(), "herta-bc-home2-"));
    const cfg = await buildConfig(cwd, home, null);
    expect(cfg.providers.deepseekApiKey).toBe("");
  });

  it("ignores the DEEPSEEK_API_KEY env — the GUI is secure-store-only", async () => {
    // Removing the external-source paths is the whole point: env (like the old
    // deepseek-api-key.txt) must NOT silently supply a key, so "No key set"
    // stays honest and the first send defers to onboarding.
    vi.stubEnv("DEEPSEEK_API_KEY", "sk-env-should-be-ignored");
    const cwd = mkdtempSync(join(tmpdir(), "herta-bc-env-"));
    const home = mkdtempSync(join(tmpdir(), "herta-bc-envh-"));
    const cfg = await buildConfig(cwd, home, null);
    expect(cfg.providers.deepseekApiKey).toBe("");
  });
});

describe("findProjectRoot", () => {
  it("returns the nearest ancestor containing a .git marker", () => {
    const root = mkdtempSync(join(tmpdir(), "herta-proot-"));
    mkdirSync(join(root, ".git"));
    const nested = join(root, "packages", "gui");
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(root);
  });
  it("returns undefined when no .git marker exists up the tree", () => {
    const isolated = mkdtempSync(join(tmpdir(), "herta-nogit-"));
    // OS temp dirs are not inside a git repo, so the walk reaches the fs
    // root without finding .git.
    expect(findProjectRoot(isolated)).toBeUndefined();
  });
});

describe("resolveWorkspaceRoot", () => {
  // Real directories, not invented POSIX strings: the function canonicalizes
  // (audit S8), so a made-up "/custom/root" would come back drive-qualified on
  // Windows and the assertion would be testing the path library, not the
  // precedence rule it means to pin.
  let custom: string;
  let userData: string;
  beforeEach(() => {
    custom = realpathSync(mkdtempSync(join(tmpdir(), "herta-custom-")));
    userData = realpathSync(mkdtempSync(join(tmpdir(), "herta-userdata-")));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("prefers HERTA_WORKSPACE_ROOT over auto-detection", () => {
    vi.stubEnv("HERTA_WORKSPACE_ROOT", custom);
    expect(resolveWorkspaceRoot()).toBe(custom);
  });
  it("auto-detects the project root from cwd when the env is unset", () => {
    vi.stubEnv("HERTA_WORKSPACE_ROOT", undefined);
    // The test runner's cwd is inside this repo (which has .git at its
    // root), so resolveWorkspaceRoot returns a real directory that is an
    // ancestor of (or equal to) cwd and contains .git.
    const result = resolveWorkspaceRoot();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // It must be the detected root, i.e. findProjectRoot(cwd) when present.
    const detected = findProjectRoot(process.cwd());
    expect(result).toBe(detected ?? process.cwd());
  });
  it("anchors at the packaged userData dir before auto-detection", () => {
    vi.stubEnv("HERTA_WORKSPACE_ROOT", undefined);
    // Packaged app: cwd is the (unwritable) install dir, so the per-user
    // data dir wins over any .git walk from cwd.
    expect(resolveWorkspaceRoot(userData)).toBe(userData);
  });
  it("lets HERTA_WORKSPACE_ROOT override even the packaged userData dir", () => {
    vi.stubEnv("HERTA_WORKSPACE_ROOT", custom);
    expect(resolveWorkspaceRoot(custom)).toBe(custom);
    expect(resolveWorkspaceRoot(userData)).toBe(custom);
  });

  it("canonicalizes a symlinked root (audit S8)", () => {
    // This path never reaches validateWorkspaceRoot, so if it did not
    // canonicalize here it would not canonicalize anywhere — and every file
    // operation in the session would be denied as outside the workspace.
    const real = join(custom, "real");
    const link = join(custom, "link");
    mkdirSync(real);
    try {
      symlinkSync(real, link, "junction");
    } catch {
      return; // needs elevation / Developer Mode on Windows
    }
    vi.stubEnv("HERTA_WORKSPACE_ROOT", link);
    expect(resolveWorkspaceRoot()).toBe(real);
  });
});

function fakeSession(): Session {
  async function* recordGen() {
    yield {
      kind: "block",
      blockId: "b1",
      block: { kind: "user", text: "hi" },
    } as never;
    await new Promise(() => undefined); // parks
  }
  const empty = async function* () {
    await new Promise(() => undefined);
  };
  return {
    sessionId: "s",
    workspaceRoot: "/r",
    lang: "zh",
    record: [],
    overlay: null,
    title: null,
    topics: [],
    turnInFlight: false,
    backendWorkspace: "/r",
    backendWorkspaceIsDefault: true,
    submitText: async () => ({ turnId: "t" }),
    interrupt: async () => ({ ok: true }),
    resolveApproval: async () => ({ ok: true }),
    setWorkspace: async () => ({ ok: true as const }),
    resetWorkspace: async () => ({ ok: true as const }),
    subscribeRecord: recordGen as never,
    subscribeOverlay: empty as never,
    subscribeSpeech: empty as never,
    subscribeAgentEvents: empty as never,
    subscribeTurnLifecycle: empty as never,
    subscribeTitle: empty as never,
    subscribeWorkspace: empty as never,
    subscribeVoice: empty as never,
    close: async () => undefined,
  } as Session;
}

describe("handleSetWorkspace", () => {
  it("rejects a forbidden root and does not touch the session", async () => {
    const set = vi.fn();
    const host = {
      activeSession: { sessionId: "s", setWorkspace: set },
    } as never;
    const res = await handleSetWorkspace(
      host,
      "s",
      parse(process.cwd()).root,
      process.cwd(),
    );
    expect(res.ok).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });
  it("sets a valid root on the matching session", async () => {
    const set = vi.fn(async () => ({ ok: true as const }));
    const host = {
      activeSession: { sessionId: "s", setWorkspace: set },
    } as never;
    const res = await handleSetWorkspace(host, "s", process.cwd(), "/home/u");
    expect(res.ok).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
  });
  it("surfaces the idle-only refusal when a turn is in flight (audit finding 13)", async () => {
    const set = vi.fn(async () => ({
      ok: false as const,
      reason: "turn_in_progress" as const,
    }));
    const host = {
      activeSession: { sessionId: "s", setWorkspace: set },
    } as never;
    const res = await handleSetWorkspace(host, "s", process.cwd(), "/home/u");
    expect(res).toEqual({ ok: false, message: "a turn is in progress" });
  });
});

function meta(sessionId: string, lastActivityAt: string): SessionMetadata {
  return {
    sessionId,
    workspaceRoot: "/r",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt,
  };
}

describe("pickLatest", () => {
  it("picks the max-by-lastActivityAt even when the input is not pre-sorted", () => {
    const sessions = [
      meta("older", "2026-01-01T00:00:00.000Z"),
      meta("newest", "2026-03-01T00:00:00.000Z"),
      meta("middle", "2026-02-01T00:00:00.000Z"),
    ];
    expect(pickLatest(sessions).sessionId).toBe("newest");
  });
  it("returns the sole element for a single-element array", () => {
    const only = meta("only", "2026-01-01T00:00:00.000Z");
    expect(pickLatest([only])).toBe(only);
  });
  it("returns the first encountered on a tie", () => {
    const first = meta("first", "2026-02-01T00:00:00.000Z");
    const second = meta("second", "2026-02-01T00:00:00.000Z");
    expect(pickLatest([first, second])).toBe(first);
  });
});

describe("startForwarders", () => {
  it("pipes session events to send() on the right channel and stops cleanly", async () => {
    const sent: Array<[string, unknown]> = [];
    const send = (ch: string, payload: unknown): void => {
      sent.push([ch, payload]);
    };
    const stop = startForwarders(fakeSession(), send);
    // drain microtasks until the first record event lands (bounded retries to avoid flakiness)
    for (
      let i = 0;
      i < 10 && !sent.some(([ch]) => ch === "session:record");
      i++
    ) {
      await Promise.resolve();
    }
    expect(sent.some(([ch]) => ch === "session:record")).toBe(true);
    stop(); // no throw
  });

  it("stop() CLOSES every parked subscription iterator (pumps don't leak per switch)", async () => {
    // Mirrors the projector's iterator shape: next() parks on a deferred,
    // return() resolves it done and counts. The old stop only flipped a flag
    // the pump checked after its NEXT event — a switched-away session that
    // never emitted again left all 8 pumps parked forever.
    let returns = 0;
    function closableIterable<T>(): AsyncIterable<T> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
          let waiter: ((r: IteratorResult<T>) => void) | null = null;
          return {
            next: () =>
              new Promise<IteratorResult<T>>((resolve) => {
                waiter = resolve;
              }),
            return: async (): Promise<IteratorResult<T>> => {
              returns += 1;
              waiter?.({ value: undefined, done: true });
              waiter = null;
              return { value: undefined, done: true };
            },
          };
        },
      };
    }
    const session = {
      ...fakeSession(),
      subscribeRecord: () => closableIterable(),
      subscribeOverlay: () => closableIterable(),
      subscribeSpeech: () => closableIterable(),
      subscribeAgentEvents: () => closableIterable(),
      subscribeTurnLifecycle: () => closableIterable(),
      subscribeTitle: () => closableIterable(),
      subscribeWorkspace: () => closableIterable(),
      subscribeVoice: () => closableIterable(),
    } as unknown as Session;
    const stop = startForwarders(session, () => undefined);
    await Promise.resolve(); // let all 8 pumps park in next()
    stop();
    expect(returns).toBe(8);
  });
});
