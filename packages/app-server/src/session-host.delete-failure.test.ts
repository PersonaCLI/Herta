/**
 * A delete that fails part-way (UX review 2026-09-22, item 6). Its own file:
 * the failure is injected by mocking `deleteSessionFiles`, which would
 * otherwise reach every delete in session-host.test.ts.
 *
 * The real shape: the transcript goes first, then the managed workspace — a
 * document in it open in Word holds the folder past the retry deadline. A
 * throw here used to reach the window as a rejected delete, with the closed
 * session still on screen.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTmpDir } from "./testing/tmp-workspace.js";
import type { AppServerConfig } from "./types.js";

const failure = vi.hoisted(() => ({
  mode: "none" as "none" | "after-transcript" | "before-anything",
}));

vi.mock("@herta/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@herta/core")>();
  return {
    ...real,
    deleteSessionFiles: async (
      transcriptDir: string,
      sessionId: string,
      ...rest: unknown[]
    ): Promise<void> => {
      if (failure.mode === "before-anything") {
        throw new Error("EPERM: operation not permitted");
      }
      if (failure.mode === "after-transcript") {
        rmSync(join(transcriptDir, `${sessionId}.jsonl`), { force: true });
        throw new Error("EBUSY: resource busy or locked");
      }
      return (real.deleteSessionFiles as (...a: unknown[]) => Promise<void>)(
        transcriptDir,
        sessionId,
        ...rest,
      );
    },
  };
});

const { createSessionHost } = await import("./session-host.js");

// 20 s, tests and hook: each test builds the whole session stack through the
// host — the second one twice, create and reopen — with the repository
// probe's `git` in the workspace each time: half a second alone, past the
// default 5 s in a loaded suite (2026-11-03). The hook outwaits
// removeTmpDir's own 10 s for a `git` still holding the workspace.
const tmpDirs: string[] = [];
afterEach(async () => {
  failure.mode = "none";
  for (const d of tmpDirs.splice(0)) await removeTmpDir(d);
}, 20_000);

function mkConfig(): AppServerConfig {
  const root = mkdtempSync(join(tmpdir(), "herta-delete-failure-test-"));
  tmpDirs.push(root);
  return {
    workspaceRoot: root,
    transcriptDir: join(root, ".herta", "transcript", "v2"),
    projectMemoryDir: join(root, ".herta", "memory"),
    userMemoryDir: join(root, ".herta", "user-memory"),
    narrativeDir: join(root, ".herta", "narrative"),
    providers: {
      deepseekApiKey: "sk-test",
      actorModel: "deepseek-v4-base",
      backendModel: "deepseek-v4-chat",
      routerModel: "deepseek-flash",
    },
  };
}

describe("deleteSession — a remove that fails part-way resolves, never throws", () => {
  it("the transcript gone, the workspace held: ok false, removed TRUE — the caller drops the card", async () => {
    const cfg = mkConfig();
    const host = createSessionHost(cfg);
    const s = await host.createSession({});
    failure.mode = "after-transcript";
    const r = await host.deleteSession(s.sessionId);
    expect(r).toEqual({ ok: false, wasActive: true, removed: true });
    expect(host.activeSession).toBeNull();
    expect(existsSync(join(cfg.transcriptDir, `${s.sessionId}.jsonl`))).toBe(
      false,
    );
  }, 20_000);

  it("nothing removed: ok false, removed FALSE — the session is still there to reopen", async () => {
    const cfg = mkConfig();
    const host = createSessionHost(cfg);
    const s = await host.createSession({});
    failure.mode = "before-anything";
    const r = await host.deleteSession(s.sessionId);
    expect(r).toEqual({ ok: false, wasActive: true, removed: false });
    expect(existsSync(join(cfg.transcriptDir, `${s.sessionId}.jsonl`))).toBe(
      true,
    );
    // Closed by the delete, and reopenable.
    failure.mode = "none";
    const again = await host.openSession({ sessionId: s.sessionId });
    expect(host.activeSession).toBe(again);
    await host.closeActiveSession();
  }, 20_000);
});
