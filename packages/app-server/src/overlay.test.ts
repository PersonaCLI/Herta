/**
 * Overlay flow tests — OverlayAskResolver + Session.resolveApproval.
 *
 * v0.3 Slice 2 Task 6. Six cases:
 *   1. pending → resolve (allow path): overlay emits pending, resolveApproval
 *      clears it, session.overlay returns to null.
 *   2. stale requestId: no_pending_overlay when nothing is pending.
 *   3. deny path: OverlayEvent { kind: "resolved" } after deny decision.
 *   4. Single-slot enforcement: sequential approval pair, never two overlays
 *      at once.
 *   5. stale_request: resolveExternal with r2 while r1 is pending returns
 *      { ok: false, reason: "stale_request" } and does NOT clear r1.
 *   6. persistence cache: allow with persistence="session" causes the next
 *      identical ask to short-circuit without a new overlay event.
 *
 * Tests exercise OverlayAskResolver directly via RulePermissionEngine.check(),
 * bypassing the full actor → backend → submitText path. This matches the
 * CodingAgentRuntime e2e pattern in
 * packages/herta/src/permission-engine-runtime.e2e.test.ts — the permission
 * stack is what we're validating, not the actor/backend integration.
 */

import type { ApprovalOverlayState, PermissionRequest } from "@herta/core";
import { RulePermissionEngine, SessionApprovalCache } from "@herta/core";
import { describe, expect, it } from "vitest";
import { OverlayAskResolver } from "./overlay-ask-resolver.js";
import { SessionEventProjector } from "./session-event-projector.js";
import type { OverlayEvent } from "./types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRequest(id = "req-1", file = "x.txt"): PermissionRequest {
  return {
    id,
    call: {
      id: "call-1",
      tool: "str_replace_editor",
      input: { command: "str_replace", path: file },
    },
    reason: "writes a file",
    risk: "workspace_write",
    // The rule-resolved path — the approval cache keys on it (audit T3.4).
    files: [file],
  };
}

/**
 * Build an OverlayAskResolver wired to a projector and a captured overlay
 * reference. Returns:
 *  - resolver: the OverlayAskResolver under test.
 *  - projector: SessionEventProjector that receives overlay events.
 *  - getOverlay: reads the current in-memory overlay snapshot.
 *  - cache: the SessionApprovalCache wired into the resolver.
 */
function makeResolver(): {
  resolver: OverlayAskResolver;
  projector: SessionEventProjector;
  getOverlay: () => ApprovalOverlayState | null;
  cache: SessionApprovalCache;
} {
  let overlay: ApprovalOverlayState | null = null;
  const projector = new SessionEventProjector({ queueCapacity: 64 });
  const cache = new SessionApprovalCache();

  const resolver = new OverlayAskResolver({
    cache,
    setPendingOverlay(pending) {
      overlay = pending;
      projector.emitOverlay({ kind: "pending", overlay: pending });
    },
    clearOverlay(requestId) {
      overlay = null;
      projector.emitOverlay({ kind: "resolved", requestId });
    },
  });

  return { resolver, projector, getOverlay: () => overlay, cache };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("OverlayAskResolver — pending + resolveExternal", () => {
  it("sets overlay when present() is called and clears it on allow", async () => {
    const { resolver, projector, getOverlay } = makeResolver();

    const collected: OverlayEvent[] = [];
    const consumer = (async () => {
      for await (const ev of projector.subscribeOverlay()) {
        collected.push(ev);
        if (ev.kind === "resolved") break;
      }
    })();

    const request = makeRequest("r1");
    const decisionPromise = resolver.present(
      request,
      new AbortController().signal,
    );

    // Overlay should now be set synchronously inside present().
    expect(getOverlay()).toMatchObject({
      kind: "pending-permission",
      requestId: "r1",
    });

    // Resolve externally (simulates Session.resolveApproval).
    const result = resolver.resolveExternal({
      requestId: "r1",
      decision: "allow",
    });
    expect(result).toEqual({ ok: true });

    // The decision promise should resolve to "allow".
    expect(await decisionPromise).toBe("allow");
    // Overlay is now null.
    expect(getOverlay()).toBeNull();

    await consumer;

    expect(collected).toMatchObject([
      {
        kind: "pending",
        overlay: { kind: "pending-permission", requestId: "r1" },
      },
      { kind: "resolved", requestId: "r1" },
    ]);

    projector.close();
  });

  it("returns no_pending_overlay when resolveExternal is called with no pending request", async () => {
    const { resolver, projector } = makeResolver();

    const result = resolver.resolveExternal({
      requestId: "never-existed",
      decision: "allow",
    });

    expect(result).toEqual({ ok: false, reason: "no_pending_overlay" });
    projector.close();
  });

  it("emits resolved event and resolves to deny on deny decision", async () => {
    const { resolver, projector, getOverlay } = makeResolver();

    const collected: OverlayEvent[] = [];
    const consumer = (async () => {
      for await (const ev of projector.subscribeOverlay()) {
        collected.push(ev);
        if (ev.kind === "resolved") break;
      }
    })();

    const request = makeRequest("r2");
    const decisionPromise = resolver.present(
      request,
      new AbortController().signal,
    );

    expect(getOverlay()).toMatchObject({
      kind: "pending-permission",
      requestId: "r2",
    });

    const result = resolver.resolveExternal({
      requestId: "r2",
      decision: "deny",
    });
    expect(result).toEqual({ ok: true });

    // Decision resolves to deny.
    expect(await decisionPromise).toBe("deny");
    expect(getOverlay()).toBeNull();

    await consumer;
    expect(collected).toMatchObject([
      { kind: "pending" },
      { kind: "resolved", requestId: "r2" },
    ]);

    projector.close();
  });

  it("single-slot: sequential overlays work, only one pending at a time", async () => {
    /**
     * Simulate two sequential RulePermissionEngine asks (e.g. two tool calls
     * that each need approval). We drive them one at a time:
     *   ask A → resolve A → overlay null → ask B → resolve B → overlay null.
     * At no point does the overlay slot hold two requests simultaneously.
     */
    const { resolver, projector, getOverlay } = makeResolver();

    const permissions = new RulePermissionEngine({ ask: resolver });
    permissions.registerRule("tool_a", () => ({
      kind: "ask",
      reason: "writes file A",
      risk: "workspace_write" as const,
    }));
    permissions.registerRule("tool_b", () => ({
      kind: "ask",
      reason: "writes file B",
      risk: "workspace_write" as const,
    }));

    const collected: OverlayEvent[] = [];
    const consumer = (async () => {
      for await (const ev of projector.subscribeOverlay()) {
        collected.push(ev);
        // Two pending + two resolved = 4 events.
        if (collected.length >= 4) break;
      }
    })();

    const signal = new AbortController().signal;
    const ctx = {
      sessionId: "test",
      signal,
      workspaceRoot: "/repo",
      reads: {} as import("@herta/core").ReadLedger,
      bg: {} as import("@herta/core").BackgroundHost,
      bus: {
        publish: () => {},
        onAny: () => () => {},
      } as unknown as import("@herta/core").EventBus<
        import("@herta/core").AgentEvent
      >,
      memory: {
        query: async () => [],
        store: async () => {},
        formatContext: () => "",
      } as unknown as import("@herta/core").MemoryManager,
    };

    // Ask A.
    const callA = { id: "c-a", tool: "tool_a", input: {} };
    const decisionA = permissions.check(callA, ctx);

    // Yield to let present() run synchronously (the Promise executor fires immediately).
    await Promise.resolve();

    // Overlay should be pending for A.
    expect(getOverlay()).toMatchObject({ kind: "pending-permission" });
    const overlayA = getOverlay() as { requestId: string };

    // Resolve A — this unblocks decisionA.
    const resultA = resolver.resolveExternal({
      requestId: overlayA.requestId,
      decision: "allow",
    });
    expect(resultA).toEqual({ ok: true });
    const decA = await decisionA;
    expect(decA.kind).toBe("ask");

    // Overlay is now null between the two asks.
    expect(getOverlay()).toBeNull();

    // Ask B.
    const callB = { id: "c-b", tool: "tool_b", input: {} };
    const decisionB = permissions.check(callB, ctx);

    await Promise.resolve();

    expect(getOverlay()).toMatchObject({ kind: "pending-permission" });
    const overlayB = getOverlay() as { requestId: string };
    expect(overlayB.requestId).not.toBe(overlayA.requestId);

    const resultB = resolver.resolveExternal({
      requestId: overlayB.requestId,
      decision: "allow",
    });
    expect(resultB).toEqual({ ok: true });
    const decB = await decisionB;
    expect(decB.kind).toBe("ask");

    expect(getOverlay()).toBeNull();

    await consumer;

    // Events: pending(A), resolved(A), pending(B), resolved(B).
    expect(collected.map((e) => e.kind)).toEqual([
      "pending",
      "resolved",
      "pending",
      "resolved",
    ]);

    projector.close();
  });

  it("stale_request: resolveExternal for wrong id returns stale_request and preserves pending r1", async () => {
    /**
     * present() for r1 is in-flight. A resolveExternal for r2 (different id)
     * must return { ok: false, reason: "stale_request" } and must NOT clear
     * the r1 pending slot.
     */
    const { resolver, projector, getOverlay } = makeResolver();

    const request1 = makeRequest("r1");
    const decisionPromise = resolver.present(
      request1,
      new AbortController().signal,
    );

    // r1 is now pending.
    expect(getOverlay()).toMatchObject({
      kind: "pending-permission",
      requestId: "r1",
    });

    // Try to resolve with a different id.
    const staleResult = resolver.resolveExternal({
      requestId: "r2",
      decision: "allow",
    });
    expect(staleResult).toEqual({ ok: false, reason: "stale_request" });

    // r1 is still pending — the slot was not cleared.
    expect(getOverlay()).toMatchObject({
      kind: "pending-permission",
      requestId: "r1",
    });

    // Clean up: resolve r1 so the pending promise doesn't leak.
    const cleanupResult = resolver.resolveExternal({
      requestId: "r1",
      decision: "deny",
    });
    expect(cleanupResult).toEqual({ ok: true });
    expect(await decisionPromise).toBe("deny");
    expect(getOverlay()).toBeNull();

    projector.close();
  });

  it("persistence cache: allow+session causes next identical ask to short-circuit without overlay", async () => {
    /**
     * First ask for a file write → resolve allow+session.
     * Second identical ask → present() should return "allow" immediately
     * (cache hit) without emitting a new "pending" overlay event.
     */
    const { resolver, projector, getOverlay } = makeResolver();

    const collected: OverlayEvent[] = [];
    // Collect overlay events in the background.
    const consumer = (async () => {
      for await (const ev of projector.subscribeOverlay()) {
        collected.push(ev);
        // First ask: pending + resolved = 2 events, then we break.
        if (collected.length >= 2) break;
      }
    })();

    // First ask.
    const request1 = makeRequest("r1");
    const decision1Promise = resolver.present(
      request1,
      new AbortController().signal,
    );

    expect(getOverlay()).toMatchObject({
      kind: "pending-permission",
      requestId: "r1",
    });

    // Resolve with persistence="session".
    const result1 = resolver.resolveExternal({
      requestId: "r1",
      decision: "allow",
      persistence: "session",
    });
    expect(result1).toEqual({ ok: true });
    expect(await decision1Promise).toBe("allow");
    expect(getOverlay()).toBeNull();

    // Wait for the consumer to drain the two events.
    await consumer;
    expect(collected.map((e) => e.kind)).toEqual(["pending", "resolved"]);

    // Second ask — same tool/risk. Should short-circuit from cache.
    const request2 = makeRequest("r2"); // different id, same tool+risk
    const decision2Promise = resolver.present(
      request2,
      new AbortController().signal,
    );

    // No new overlay event — overlay stays null.
    expect(getOverlay()).toBeNull();

    // The promise resolves immediately to "allow".
    expect(await decision2Promise).toBe("allow");

    // Still only 2 overlay events total (no new "pending" for r2).
    expect(collected).toHaveLength(2);

    projector.close();
  });

  it("persistence cache is TASK-scoped: a remembered write short-circuits a DIFFERENT file within the brief (ADR 0026)", async () => {
    // Deliberate owner decision 2026-07-24, replacing the T3.4 per-path key:
    // one grant covers every file write until the brief ends (the cache is
    // cleared at backend turn end by wireTaskScopedApprovalCache — tested in
    // core). Every auto-approved write still projects its patch preview.
    const { resolver, getOverlay } = makeResolver();

    // Grant the task scope via x.txt.
    const decision1 = resolver.present(
      makeRequest("r1", "x.txt"),
      new AbortController().signal,
    );
    resolver.resolveExternal({
      requestId: "r1",
      decision: "allow",
      persistence: "session",
    });
    expect(await decision1).toBe("allow");

    // A different file auto-allows with NO new overlay surfaced.
    const decision2 = await resolver.present(
      makeRequest("r2", ".github/workflows/ci.yml"),
      new AbortController().signal,
    );
    expect(decision2).toBe("allow");
    expect(getOverlay()).not.toMatchObject({
      kind: "pending-permission",
      requestId: "r2",
    });
  });
});
