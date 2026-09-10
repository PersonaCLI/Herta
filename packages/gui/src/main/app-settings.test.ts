import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isBackendContract,
  isBackendThinking,
  isModelChoice,
  normalizeModelChoice,
  readAppSettings,
  writeAppSettings,
} from "./app-settings.js";

describe("app-settings", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const mk = (): string => {
    dir = mkdtempSync(join(tmpdir(), "herta-settings-"));
    return dir;
  };

  it("returns {} for a missing file", async () => {
    expect(await readAppSettings(mk())).toEqual({});
  });

  it("write then read round-trips", async () => {
    const ws = mk();
    await writeAppSettings(ws, { dream: { enabled: false } });
    expect(await readAppSettings(ws)).toEqual({ dream: { enabled: false } });
  });

  it("returns {} for corrupt JSON", async () => {
    const ws = mk();
    mkdirSync(join(ws, ".herta"), { recursive: true });
    writeFileSync(join(ws, ".herta", "settings.json"), "{ not json", "utf-8");
    expect(await readAppSettings(ws)).toEqual({});
  });

  it("returns {} for a malformed nested dream field", async () => {
    const ws = mk();
    mkdirSync(join(ws, ".herta"), { recursive: true });
    writeFileSync(
      join(ws, ".herta", "settings.json"),
      JSON.stringify({ dream: 5 }),
      "utf-8",
    );
    expect(await readAppSettings(ws)).toEqual({});
  });

  it("backend.thinking round-trips", async () => {
    const ws = mk();
    await writeAppSettings(ws, { backend: { thinking: "low" } });
    expect(await readAppSettings(ws)).toEqual({ backend: { thinking: "low" } });
  });

  it("returns {} for a malformed nested backend field", async () => {
    const ws = mk();
    mkdirSync(join(ws, ".herta"), { recursive: true });
    writeFileSync(
      join(ws, ".herta", "settings.json"),
      JSON.stringify({ backend: "max" }),
      "utf-8",
    );
    expect(await readAppSettings(ws)).toEqual({});
  });

  it("backend.contract round-trips beside thinking; isBackendContract accepts exactly the two names (ADR 0040)", async () => {
    const ws = mk();
    await writeAppSettings(ws, {
      backend: { thinking: "max", contract: "minimal" },
    });
    expect(await readAppSettings(ws)).toEqual({
      backend: { thinking: "max", contract: "minimal" },
    });
    expect(isBackendContract("standard")).toBe(true);
    expect(isBackendContract("minimal")).toBe(true);
    expect(isBackendContract("极简")).toBe(false);
    expect(isBackendContract("")).toBe(false);
    expect(isBackendContract(undefined)).toBe(false);
  });

  it("isBackendThinking accepts the three tiers and rejects everything else", () => {
    expect(isBackendThinking("low")).toBe(true);
    expect(isBackendThinking("high")).toBe(true);
    expect(isBackendThinking("max")).toBe(true);
    // A hand-edited settings.json can hold anything — off-enum values must
    // fall back to the default rather than reach the API.
    expect(isBackendThinking("medium")).toBe(false);
    expect(isBackendThinking("off")).toBe(false);
    expect(isBackendThinking("")).toBe(false);
    expect(isBackendThinking(undefined)).toBe(false);
    expect(isBackendThinking(5)).toBe(false);
  });

  it("models round-trips, a malformed models section falls back to {}, and isModelChoice accepts exactly the two names (2026-08-17; renamed 2026-09-10)", async () => {
    const ws = mk();
    await writeAppSettings(ws, {
      models: { actor: "deepseek-flash", backend: "deepseek-v4-pro" },
    });
    expect(await readAppSettings(ws)).toEqual({
      models: { actor: "deepseek-flash", backend: "deepseek-v4-pro" },
    });
    writeFileSync(
      join(ws, ".herta", "settings.json"),
      JSON.stringify({ models: "flash" }),
      "utf-8",
    );
    expect(await readAppSettings(ws)).toEqual({});
    expect(isModelChoice("deepseek-v4-pro")).toBe(true);
    expect(isModelChoice("deepseek-flash")).toBe(true);
    // The completion endpoint 400s on anything else (deepseek-v4-base did).
    expect(isModelChoice("deepseek-v4-base")).toBe(false);
    expect(isModelChoice("flash")).toBe(false);
    expect(isModelChoice(undefined)).toBe(false);
    // The 2026-08 names are not CURRENT names — this guard is for what the
    // pane may write; readers fold them through normalizeModelChoice.
    expect(isModelChoice("deepseek-v4-flash")).toBe(false);
    expect(isModelChoice("deepseek-v4-flash-vision-exp")).toBe(false);
  });

  it("a settings.json from before the 2026-09 rename reads as the flash — never as the Pro default (normalizeModelChoice)", async () => {
    // DeepSeek retired `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp`
    // (both served by V4.1 Flash now). A file the 2026-08 pane wrote keeps
    // meaning "flash", and the old 板砖-only vision row folds into the same
    // name, since the flash itself reads images (ADR 0048 §5b).
    expect(normalizeModelChoice("deepseek-v4-flash")).toBe("deepseek-flash");
    expect(normalizeModelChoice("deepseek-v4-flash-vision-exp")).toBe(
      "deepseek-flash",
    );
    expect(normalizeModelChoice("deepseek-flash")).toBe("deepseek-flash");
    expect(normalizeModelChoice("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(normalizeModelChoice("deepseek-v4-base")).toBeUndefined();
    expect(normalizeModelChoice(undefined)).toBeUndefined();
    expect(normalizeModelChoice(5)).toBeUndefined();

    const ws = mk();
    await writeAppSettings(ws, {
      models: { actor: "deepseek-v4-pro", backend: "deepseek-flash" },
    });
    expect((await readAppSettings(ws)).models?.backend).toBe("deepseek-flash");
  });

  it("read + merge + write preserves unrelated keys (the handler pattern)", async () => {
    const ws = mk();
    mkdirSync(join(ws, ".herta"), { recursive: true });
    writeFileSync(
      join(ws, ".herta", "settings.json"),
      JSON.stringify({ dream: { enabled: true }, other: 42 }),
      "utf-8",
    );
    const s = await readAppSettings(ws);
    await writeAppSettings(ws, { ...s, dream: { ...s.dream, enabled: false } });
    const out = (await readAppSettings(ws)) as Record<string, unknown>;
    expect(out.other).toBe(42);
    expect((out.dream as { enabled: boolean }).enabled).toBe(false);
  });
});
