import { describe, expect, it } from "vitest";
import type { BackgroundProcess } from "./background-host.js";
import { BackgroundHost } from "./background-host.js";

function fakeProc(
  id: string,
  running = true,
): BackgroundProcess & {
  killed: boolean;
} {
  let alive = running;
  const p = {
    id,
    argv: ["node", "-e", ""],
    killed: false,
    isRunning: () => alive,
    kill: async () => {
      p.killed = true;
      alive = false;
    },
  };
  return p;
}

describe("BackgroundHost", () => {
  it("registers an entry and hands it back to its owner by id", () => {
    const h = new BackgroundHost();
    const p = fakeProc("shell");
    h.register(p);
    expect(h.get("shell")).toBe(p);
    expect(h.get("nope")).toBeUndefined();
  });

  it("rejects duplicate ids", () => {
    const h = new BackgroundHost();
    h.register(fakeProc("x"));
    expect(() => h.register(fakeProc("x"))).toThrow(/duplicate/);
  });

  it("stopAll kills only the entries that may still have something running", async () => {
    const h = new BackgroundHost();
    const running = fakeProc("r", true);
    const dead = fakeProc("d", false);
    h.register(running);
    h.register(dead);
    await h.stopAll();
    expect(running.killed).toBe(true);
    expect(dead.killed).toBe(false);
  });

  it("stopAll tolerates a kill that rejects (allSettled), and still kills the rest", async () => {
    const h = new BackgroundHost();
    h.register({
      id: "boom",
      argv: [],
      isRunning: () => true,
      kill: async () => {
        throw new Error("kill failed");
      },
    });
    const other = fakeProc("other");
    h.register(other);
    await expect(h.stopAll()).resolves.toBeUndefined();
    expect(other.killed).toBe(true);
  });

  it("has no model-facing half: no minted ids, no listing, nothing counted (ADR 0086)", () => {
    const h = new BackgroundHost() as unknown as Record<string, unknown>;
    expect(h.nextId).toBeUndefined();
    expect(h.list).toBeUndefined();
    expect(h.getInternal).toBeUndefined();
  });
});
