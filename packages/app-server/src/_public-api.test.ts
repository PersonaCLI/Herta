import { describe, expect, it } from "vitest";
import * as appServer from "./index.js";

describe("@herta/app-server — public API surface", () => {
  it("exports exactly the documented runtime symbols", () => {
    const runtimeKeys = Object.keys(appServer).sort();
    expect(runtimeKeys).toEqual(
      [
        // A host's quit hold must outlast close()'s settle wait (ADR 0071
        // §1.7), so the desktop main process reads the one number.
        "CLOSE_SETTLE_CAP_MS",
        "createSessionHost",
        "defaultDirsFor",
        // Flow (ADR 0084): the desktop main owns one service and reads its
        // settings section through the normalizer.
        "DEFAULT_FLOW_SETTINGS",
        "FlowService",
        "normalizeFlowSettings",
        // Long-session windowing (2026-07-12): the shared tail-slice helper
        // used by every full-record payload to the renderer.
        "RECORD_TAIL_BLOCKS",
        "recordTail",
      ].sort(),
    );
  });

  it("does NOT export internal seams or test helpers", () => {
    const keys = Object.keys(appServer);
    expect(keys).not.toContain("SessionImpl");
    expect(keys).not.toContain("SessionEventProjector");
    expect(keys).not.toContain("OverlayAskResolver");
    expect(keys).not.toContain("stubCompletionProvider");
    expect(keys).not.toContain("stubChatProvider");
  });
});
