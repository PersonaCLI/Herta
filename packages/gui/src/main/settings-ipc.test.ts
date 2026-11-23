import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const { registerSettingsHandlers, settingRows } = await import(
  "./settings-ipc.js"
);
const { SETTING_KEYS } = await import("../shared/setting-keys.js");

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

/** A setting through the keyed pair, as the renderer calls it (owner
 *  2026-11-23: one `settings:get` / `settings:set` for every row). */
function settingOf(
  handlers: Map<string, Handler>,
  key: string,
): { get: () => Promise<unknown>; set: (value: unknown) => Promise<unknown> } {
  const call = (channel: string, ...args: unknown[]): Promise<unknown> => {
    const fn = handlers.get(channel);
    if (fn === undefined) throw new Error(`no handler for ${channel}`);
    return fn(null, ...args);
  };
  return {
    get: () => call(CMD.getSetting, key),
    set: (value) => call(CMD.setSetting, key, value),
  };
}

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
    expect(handlers.has(CMD.setSetting)).toBe(true);
    const { set } = settingOf(handlers, "realtimeVoice");
    await set(false);
    expect(stopSpeech).toHaveBeenCalledTimes(1);
    expect(voice.realtimeEnabled).toBe(false);
    await set(true);
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
    const { get, set } = settingOf(handlers, "dream");
    expect(await get()).toEqual({ enabled: false });
    running = false; // the host bootstrapped with Dream off
    await set({ enabled: true });
    expect(await get()).toEqual({ enabled: true, running: false });
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
    const { get, set } = settingOf(handlers, "pdfPictureTranscripts");
    expect(await get()).toBe(true);

    await set(false);
    expect(await get()).toBe(false);
    expect(setPdfPictureTranscription).toHaveBeenLastCalledWith(false);

    await set("yes");
    expect(setPdfPictureTranscription).toHaveBeenCalledTimes(1);
    expect(await get()).toBe(false);
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
    const { get, set } = settingOf(handlers, "attention");
    expect(await get()).toEqual({ notifications: true, keepAwake: true });

    await set({ keepAwake: false });
    expect(await get()).toEqual({
      notifications: true,
      keepAwake: false,
    });
    expect(changed).toHaveBeenLastCalledWith({
      notifications: true,
      keepAwake: false,
    });

    await set({ notifications: "no", keepAwake: 1 });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await get()).toEqual({
      notifications: true,
      keepAwake: false,
    });
  });
});

describe("settings IPC — models and effort apply live (ADR 0081)", () => {
  function setup(hooks: { pathReady?: Promise<unknown> } = {}): {
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
      hooks,
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
    await settingOf(handlers, "model").set({
      actor: "deepseek-flash",
      backend: "deepseek-v4-pro",
    });
    expect(await settingOf(handlers, "model").get()).toEqual({
      actor: "deepseek-flash",
      backend: "deepseek-v4-pro",
    });
    expect(applied).toEqual([
      { actorModel: "deepseek-flash", backendModel: "deepseek-v4-pro" },
    ]);
  });

  it("an effort pick reaches the host; a pick of the retired tool set is ignored (ADR 0086)", async () => {
    const { handlers, applied } = setup();
    await settingOf(handlers, "backend").set({ thinking: "max" });
    expect(applied).toEqual([{ thinking: "max" }]);
    // An older renderer could still send the choice: it is neither applied
    // nor saved, and the config it reads back has no such field.
    await settingOf(handlers, "backend").set({ contract: "standard" });
    expect(applied).toEqual([{ thinking: "max" }]);
    const read = (await settingOf(handlers, "backend").get()) as Record<
      string,
      unknown
    >;
    expect(read.thinking).toBe("max");
    expect("contract" in read).toBe(false);
    expect(typeof read.bashFound).toBe("boolean");
    expect(
      readFileSync(join(userData.dir, ".herta", "settings.json"), "utf-8"),
    ).not.toContain("contract");
  });

  it("the bash check answers once main has recovered PATH (review 2026-11-10)", async () => {
    // The window no longer waits for the PATH probes, so the pane can ask
    // first; `findBash` reads PATH, and an answer read before the probes
    // land would say no bash where a fresh terminal finds one.
    let land = (): void => {};
    const pathReady = new Promise<void>((resolve) => {
      land = resolve;
    });
    const { handlers } = setup({ pathReady });
    let answered = false;
    const read = settingOf(handlers, "backend")
      .get()
      .then((v) => {
        answered = true;
        return v;
      });
    await new Promise((r) => setTimeout(r, 20));
    expect(answered).toBe(false);
    land();
    expect(await read).toMatchObject({ thinking: "high" });
    expect(answered).toBe(true);
  });

  it("an env override still wins over a live pick, as at a fresh start", async () => {
    const { handlers, applied } = setup();
    vi.stubEnv("HERTA_ACTOR_MODEL", "deepseek-v4-pro");
    try {
      await settingOf(handlers, "model").set({
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
      settingOf(handlers, "model").set({
        actor: "deepseek-flash",
        backend: "deepseek-v4-pro",
      }),
      settingOf(handlers, "backend").set({ thinking: "max" }),
      settingOf(handlers, "dream").set({ enabled: false }),
    ]);
    expect(await settingOf(handlers, "model").get()).toEqual({
      actor: "deepseek-flash",
      backend: "deepseek-v4-pro",
    });
    expect(await settingOf(handlers, "backend").get()).toMatchObject({
      thinking: "max",
    });
    expect(await settingOf(handlers, "dream").get()).toMatchObject({
      enabled: false,
    });
  });

  it("an off-list model is refused and nothing reaches the host", async () => {
    const { handlers, applied } = setup();
    await settingOf(handlers, "model").set({
      actor: "gpt-9",
      backend: "deepseek-flash",
    });
    expect(applied).toEqual([]);
  });
});

describe("settings IPC — one keyed pair (owner 2026-11-23)", () => {
  function deps(handlers: Map<string, Handler>) {
    return {
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
        engine: "local" as const,
        realtimeEnabled: false,
        minimaxFetch: (async () => new Response("")) as never,
        anyMiniMaxKey: () => false,
        minimaxRefusal: () => null,
        stopSpeech: () => {},
      },
    };
  }

  it("the table has a row for every key and for nothing else", () => {
    userData.dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    const rows = settingRows(deps(new Map()));
    expect(Object.keys(rows).sort()).toEqual([...SETTING_KEYS].sort());
  });

  it("a key that is not a setting is refused, read or write, and nothing is written", async () => {
    userData.dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    const handlers = new Map<string, Handler>();
    registerSettingsHandlers(deps(handlers));
    await expect(settingOf(handlers, "deepSeekKey").get()).rejects.toThrow(
      /not a setting/,
    );
    await expect(settingOf(handlers, "__proto__").set(true)).rejects.toThrow(
      /not a setting/,
    );
    await expect(
      handlers.get(CMD.getSetting)?.(null, { key: "theme" }),
    ).rejects.toThrow(/not a setting/);
    expect(existsSync(join(userData.dir, "settings.json"))).toBe(false);
  });

  it("a write is a user action; a read is the pane loading (dream review 2026-09-22, finding 12)", () => {
    // The session service counts a channel by its name.
    expect(CMD.setSetting.startsWith("settings:set")).toBe(true);
    expect(CMD.getSetting.startsWith("settings:set")).toBe(false);
  });
});
