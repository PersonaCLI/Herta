import type { ApprovalOverlayState } from "@herta/app-server";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HertaBridgeProvider } from "../context/HertaBridgeContext.js";
import { createMockHertaBridge } from "../ipc/mock-bridge.js";
import { useOverlay } from "./useOverlay.js";

const pending: ApprovalOverlayState = {
  kind: "pending-permission",
  requestId: "req-1",
  risk: "workspace_write",
  tool: "edit_file",
  summary: "edit src/a.ts",
  cacheable: false,
};

function renderOverlay() {
  const mock = createMockHertaBridge();
  const hook = renderHook(() => useOverlay(), {
    wrapper: ({ children }) => (
      <HertaBridgeProvider bridge={mock.bridge}>{children}</HertaBridgeProvider>
    ),
  });
  const reset = (overlay: ApprovalOverlayState | null): void => {
    act(() => {
      mock.emitReset({
        sessionId: "s-1",
        workspaceRoot: "/r",
        record: [],
        overlay,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      });
    });
  };
  return { hook, reset };
}

describe("useOverlay", () => {
  it("returns null when no overlay is active", () => {
    const { hook } = renderOverlay();
    expect(hook.result.current).toBeNull();
  });

  it("reflects a pending approval carried by the active session's reset, and null again once it clears", () => {
    // The review (2026-09-10) found the old second case asserting null after
    // a reset whose overlay was null — a hook returning null always passed.
    const { hook, reset } = renderOverlay();
    reset(pending);
    expect(hook.result.current).toEqual(pending);
    reset(null);
    expect(hook.result.current).toBeNull();
  });
});
