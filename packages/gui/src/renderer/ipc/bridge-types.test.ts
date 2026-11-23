import { describe, expect, it } from "vitest";
import type {
  HertaBridge,
  SessionSnapshot,
  SpeechControlEvent,
} from "./bridge-types.js";

describe("bridge-types", () => {
  it("declares a SessionSnapshot shape", () => {
    const snap: SessionSnapshot = {
      sessionId: "s-1",
      workspaceRoot: "/repo",
      record: [],
      overlay: null,
      backendWorkspace: "/repo",
      backendWorkspaceIsDefault: true,
    };
    expect(snap.sessionId).toBe("s-1");
  });

  it("declares a HertaBridge with commands + event subscriptions", () => {
    // Compile-time smoke: construct a conforming object.
    const bridge: HertaBridge = {
      platform: "win32",
      settingKeys: ["dream", "locale", "closeToTray"],
      getSetting: (async () => undefined) as HertaBridge["getSetting"],
      setSetting: async () => undefined,
      windowMinimize: () => undefined,
      windowToggleMaximize: () => undefined,
      windowClose: () => undefined,
      windowIsMaximized: async () => false,
      onWindowMaximized: () => () => undefined,
      submitText: async () => ({ turnId: "t" }),
      interrupt: async () => ({ ok: true }),
      rewindLastTurn: async () => ({ ok: false, reason: "no_user_turn" }),
      maybePlayEasterEgg: async () => undefined,
      listSessions: async () => [],
      openSession: async () => ({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      }),
      createSession: async () => ({
        sessionId: "s",
        workspaceRoot: "/r",
        record: [],
        overlay: null,
        backendWorkspace: "/r",
        backendWorkspaceIsDefault: true,
      }),
      deleteSession: async () => ({ ok: true, wasActive: false }),
      resolveApproval: async () => ({ ok: true }),
      pickWorkspace: async () => null,
      setWorkspace: async () => ({ ok: true }),
      resetWorkspace: async () => ({ ok: true }),
      pickAttachments: async () => null,
      attachFiles: async () => ({ ok: true }),
      removeAttachment: async () => ({ ok: true }),
      stageImages: async () => ({ ok: true, staged: [], rejected: [] }),
      unstageImage: async () => true,
      pathForFile: () => "/tmp/x.md",
      getDeepSeekKeyStatus: async () => ({
        set: false,
        hint: null,
        encrypted: false,
      }),
      setDeepSeekKey: async () => ({
        ok: true,
        encrypted: true,
        status: { set: true, hint: "1234", encrypted: true },
        unverified: false,
      }),
      clearDeepSeekKey: async () => ({
        ok: true,
        status: { set: false, hint: null, encrypted: false },
      }),
      onWorkspace: () => () => undefined,
      onRecord: () => () => undefined,
      onOverlay: () => () => undefined,
      onSpeech: () => () => undefined,
      onAgent: () => () => undefined,
      onTurn: () => () => undefined,
      onReset: () => () => undefined,
      onTitle: () => () => undefined,
      onSessionDeleted: () => () => undefined,
      onVoice: () => () => undefined,
    };
    expect(typeof bridge.submitText).toBe("function");
    expect(typeof bridge.onSpeech).toBe("function");
  });

  it("declares SpeechControlEvent with the retract + overflow variants", () => {
    // Compile-time smoke: retract control plus the relayed overflow sentinel.
    const ev: SpeechControlEvent = { kind: "retract" };
    const dropped: SpeechControlEvent = { kind: "dropped", count: 1 };
    expect(ev.kind).toBe("retract");
    expect(dropped.kind).toBe("dropped");
  });
});
