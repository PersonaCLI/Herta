import { describe, expect, it } from "vitest";
import type {
  ApprovalResult,
  AppServerConfig,
  CreateSessionOpts,
  ListSessionsOpts,
  OpenSessionOpts,
  OverlayEvent,
  RecordEvent,
  ResolveApprovalOpts,
  SessionAgentEvent,
  SessionMetadata,
  TurnLifecycleEvent,
} from "./index.js";

describe("@herta/app-server — type exports", () => {
  it("exports AppServerConfig with the expected shape", () => {
    const cfg: AppServerConfig = {
      workspaceRoot: "/tmp/x",
      transcriptDir: "/tmp/x/.herta/transcript/v2",
      projectMemoryDir: "/tmp/x/.herta/memory",
      userMemoryDir: "/home/u/.herta/memory",
      narrativeDir: "/tmp/x/.herta/narrative",
      providers: {
        deepseekApiKey: "sk-test",
        actorModel: "deepseek-v4-base",
        backendModel: "deepseek-v4-chat",
        routerModel: "deepseek-flash",
      },
    };
    expect(cfg.workspaceRoot).toBe("/tmp/x");
  });

  it("exports RecordEvent as a discriminated union with 'block' and 'dropped' variants", () => {
    const ev1: RecordEvent = {
      kind: "block",
      blockId: "b-1",
      block: { kind: "user", text: "hi" },
    };
    const ev2: RecordEvent = { kind: "dropped", count: 7 };
    expect(ev1.kind).toBe("block");
    expect(ev2.kind).toBe("dropped");
  });

  it("exports ApprovalResult as ok-true | ok-false-with-reason", () => {
    const ok: ApprovalResult = { ok: true };
    const stale: ApprovalResult = { ok: false, reason: "stale_request" };
    const none: ApprovalResult = { ok: false, reason: "no_pending_overlay" };
    expect(ok.ok).toBe(true);
    expect(stale.ok).toBe(false);
    expect(none.ok).toBe(false);
  });

  it("exports OverlayEvent with pending / resolved / dropped variants", () => {
    const dropped: OverlayEvent = { kind: "dropped", count: 1 };
    expect(dropped.kind).toBe("dropped");
  });

  it("exports TurnLifecycleEvent with started / finished / failed", () => {
    // `artifact_created` was retired 2026-09-03: nothing ever emitted it
    // (the capsule-era evidence store went with ADR 0041).
    const started: TurnLifecycleEvent = { kind: "started", turnId: "t-1" };
    const finished: TurnLifecycleEvent = { kind: "finished", turnId: "t-1" };
    const failed: TurnLifecycleEvent = {
      kind: "failed",
      turnId: "t-1",
      error: { code: "boom", message: "x" },
    };
    expect(started.kind).toBe("started");
    expect(finished.kind).toBe("finished");
    expect(failed.kind).toBe("failed");
  });

  // Compile-time smoke (these only need to compile):
  it("declares CreateSessionOpts / OpenSessionOpts / ListSessionsOpts / ResolveApprovalOpts / SessionAgentEvent / SessionMetadata", () => {
    const c: CreateSessionOpts = { workspaceRoot: "/x" };
    const o: OpenSessionOpts = { sessionId: "s-1" };
    const l: ListSessionsOpts = { limit: 10, workspaceRoot: null };
    const r: ResolveApprovalOpts = {
      requestId: "r-1",
      decision: "allow",
      persistence: "session",
    };
    const a: SessionAgentEvent = { kind: "dropped", count: 0 };
    const m: SessionMetadata = {
      sessionId: "s-1",
      workspaceRoot: "/x",
      startedAt: "2026-05-27T00:00:00.000Z",
      lastActivityAt: "2026-05-27T00:00:00.000Z",
    };
    expect([c, o, l, r, a, m]).toHaveLength(6);
  });
});
