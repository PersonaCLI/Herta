import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceSettingsState } from "./settings-ipc.js";

/**
 * The Settings rows' IPC door, driven with a fake registrar (ADR 0042 §7c:
 * the 实时语音 toggle). `electron` is mocked to the one call the handlers
 * make at this depth — `app.getPath("userData")` — into a temp dir.
 */
const userData = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => userData.dir, isPackaged: false },
}));

const { CMD } = await import("../preload/channels.js");
const { registerSettingsHandlers } = await import("./settings-ipc.js");

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

afterEach(() => {
  if (userData.dir.length > 0) {
    rmSync(userData.dir, { recursive: true, force: true });
    userData.dir = "";
  }
});

describe("settings IPC — 实时语音 off mid-reply (ADR 0042 §7c)", () => {
  it("turning the voice OFF stops the speech in flight; turning it on stops nothing", async () => {
    userData.dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    const handlers = new Map<string, Handler>();
    const stopSpeech = vi.fn();
    const voice: VoiceSettingsState = {
      synthesizer: null,
      voiceModel: null,
      minimaxVoice: null,
      engine: "local",
      realtimeEnabled: true,
      minimaxFetch: (async () => new Response("")) as never,
      anyMiniMaxKey: () => false,
      minimaxRefusal: () => null,
      stopSpeech,
    };
    registerSettingsHandlers({
      handle: ((channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      }) as never,
      hooks: {},
      host: () => null,
      workspaceRoot: () => userData.dir,
      voice,
    });
    const set = handlers.get(CMD.setRealtimeVoice);
    expect(set).toBeDefined();
    await set?.(null, false);
    expect(stopSpeech).toHaveBeenCalledTimes(1);
    expect(voice.realtimeEnabled).toBe(false);
    await set?.(null, true);
    expect(stopSpeech).toHaveBeenCalledTimes(1);
    expect(voice.realtimeEnabled).toBe(true);
  });
});

describe("settings IPC — Dream says what the running app has (dream review 2026-09-22, finding 20)", () => {
  it("answers the saved flag AND the running one; before bootstrap it says only the saved one", async () => {
    userData.dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    const handlers = new Map<string, Handler>();
    let running: boolean | undefined;
    registerSettingsHandlers({
      handle: ((channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      }) as never,
      hooks: {},
      host: () => null,
      workspaceRoot: () => userData.dir,
      voice: {
        synthesizer: null,
        voiceModel: null,
        minimaxVoice: null,
        engine: "local",
        realtimeEnabled: false,
        minimaxFetch: (async () => new Response("")) as never,
        anyMiniMaxKey: () => false,
        minimaxRefusal: () => null,
        stopSpeech: () => {},
      },
      dreamRunning: () => running,
    });
    const get = handlers.get(CMD.getDreamConfig);
    const set = handlers.get(CMD.setDreamConfig);
    expect(await get?.(null)).toEqual({ enabled: false });
    running = false; // the host bootstrapped with Dream off
    await set?.(null, { enabled: true });
    expect(await get?.(null)).toEqual({ enabled: true, running: false });
  });
});

describe("settings IPC — PDF picture transcription (2026-10-01)", () => {
  it("defaults on; a write persists, reaches the running host at once, and ignores anything but a boolean", async () => {
    userData.dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    const handlers = new Map<string, Handler>();
    const setPdfPictureTranscription = vi.fn();
    registerSettingsHandlers({
      handle: ((channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      }) as never,
      hooks: {},
      host: () => ({ setPdfPictureTranscription }) as never,
      workspaceRoot: () => userData.dir,
      voice: {
        synthesizer: null,
        voiceModel: null,
        minimaxVoice: null,
        engine: "local",
        realtimeEnabled: false,
        minimaxFetch: (async () => new Response("")) as never,
        anyMiniMaxKey: () => false,
        minimaxRefusal: () => null,
        stopSpeech: () => {},
      },
    });
    const get = handlers.get(CMD.getPdfPictureTranscripts);
    const set = handlers.get(CMD.setPdfPictureTranscripts);
    expect(await get?.(null)).toBe(true);

    await set?.(null, false);
    expect(await get?.(null)).toBe(false);
    expect(setPdfPictureTranscription).toHaveBeenLastCalledWith(false);

    await set?.(null, "yes");
    expect(setPdfPictureTranscription).toHaveBeenCalledTimes(1);
    expect(await get?.(null)).toBe(false);
  });
});

describe("settings IPC — attention (ADR 0072 §1)", () => {
  it("both default on; a write carries either one, ignores anything but a boolean, and tells main both values", async () => {
    userData.dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    const handlers = new Map<string, Handler>();
    const changed = vi.fn();
    registerSettingsHandlers({
      handle: ((channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      }) as never,
      hooks: { onAttentionChanged: changed },
      host: () => null,
      workspaceRoot: () => userData.dir,
      voice: {
        synthesizer: null,
        voiceModel: null,
        minimaxVoice: null,
        engine: "local",
        realtimeEnabled: false,
        minimaxFetch: (async () => new Response("")) as never,
        anyMiniMaxKey: () => false,
        minimaxRefusal: () => null,
        stopSpeech: () => {},
      },
    });
    const get = handlers.get(CMD.getAttention);
    const set = handlers.get(CMD.setAttention);
    expect(await get?.(null)).toEqual({ notifications: true, keepAwake: true });

    await set?.(null, { keepAwake: false });
    expect(await get?.(null)).toEqual({
      notifications: true,
      keepAwake: false,
    });
    expect(changed).toHaveBeenLastCalledWith({
      notifications: true,
      keepAwake: false,
    });

    await set?.(null, { notifications: "no", keepAwake: 1 });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await get?.(null)).toEqual({
      notifications: true,
      keepAwake: false,
    });
  });
});

describe("settings IPC — models and effort apply live (ADR 0081)", () => {
  function setup(): {
    handlers: Map<string, Handler>;
    applied: unknown[];
  } {
    userData.dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    const handlers = new Map<string, Handler>();
    const applied: unknown[] = [];
    registerSettingsHandlers({
      handle: ((channel: string, fn: Handler) => {
        handlers.set(channel, fn);
      }) as never,
      hooks: {},
      host: () => ({ setModels: (m: unknown) => applied.push(m) }) as never,
      workspaceRoot: () => userData.dir,
      voice: {
        synthesizer: null,
        voiceModel: null,
        minimaxVoice: null,
        engine: "local",
        realtimeEnabled: false,
        minimaxFetch: (async () => new Response("")) as never,
        anyMiniMaxKey: () => false,
        minimaxRefusal: () => null,
        stopSpeech: () => {},
      },
    });
    return { handlers, applied };
  }

  it("a model pick is saved and reaches the running host at once", async () => {
    const { handlers, applied } = setup();
    await handlers.get(CMD.setModelConfig)?.(null, {
      actor: "deepseek-flash",
      backend: "deepseek-v4-pro",
    });
    expect(await handlers.get(CMD.getModelConfig)?.(null)).toEqual({
      actor: "deepseek-flash",
      backend: "deepseek-v4-pro",
    });
    expect(applied).toEqual([
      { actorModel: "deepseek-flash", backendModel: "deepseek-v4-pro" },
    ]);
  });

  it("an effort pick reaches the host; a contract pick alone does not (it waits for a restart)", async () => {
    const { handlers, applied } = setup();
    await handlers.get(CMD.setBackendConfig)?.(null, { thinking: "max" });
    expect(applied).toEqual([{ thinking: "max" }]);
    await handlers.get(CMD.setBackendConfig)?.(null, { contract: "standard" });
    expect(applied).toEqual([{ thinking: "max" }]);
  });

  it("an env override still wins over a live pick, as at a fresh start", async () => {
    const { handlers, applied } = setup();
    vi.stubEnv("HERTA_ACTOR_MODEL", "deepseek-v4-pro");
    try {
      await handlers.get(CMD.setModelConfig)?.(null, {
        actor: "deepseek-flash",
        backend: "deepseek-flash",
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(applied).toEqual([
      { actorModel: "deepseek-v4-pro", backendModel: "deepseek-flash" },
    ]);
  });

  it("a model pick and an effort pick in flight together are both saved (release review 2026-10-22)", async () => {
    const { handlers } = setup();
    await Promise.all([
      handlers.get(CMD.setModelConfig)?.(null, {
        actor: "deepseek-flash",
        backend: "deepseek-v4-pro",
      }),
      handlers.get(CMD.setBackendConfig)?.(null, { thinking: "max" }),
      handlers.get(CMD.setDreamConfig)?.(null, { enabled: false }),
    ]);
    expect(await handlers.get(CMD.getModelConfig)?.(null)).toEqual({
      actor: "deepseek-flash",
      backend: "deepseek-v4-pro",
    });
    expect(await handlers.get(CMD.getBackendConfig)?.(null)).toMatchObject({
      thinking: "max",
    });
    expect(await handlers.get(CMD.getDreamConfig)?.(null)).toMatchObject({
      enabled: false,
    });
  });

  it("an off-list model is refused and nothing reaches the host", async () => {
    const { handlers, applied } = setup();
    await handlers.get(CMD.setModelConfig)?.(null, {
      actor: "gpt-9",
      backend: "deepseek-flash",
    });
    expect(applied).toEqual([]);
  });
});
