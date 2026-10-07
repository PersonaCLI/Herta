import { describe, expect, it } from "vitest";
import { takeRefused } from "./no-network.js";

describe("the no-network guard (no-network.ts)", () => {
  it("refuses a remote fetch at once and records it for the test's afterEach", async () => {
    await expect(
      fetch("https://api.deepseek.com/chat/completions"),
    ).rejects.toThrow(/tests never reach the network/);
    // Drained here, so this test's own afterEach does not fail it.
    expect(takeRefused()).toEqual([
      "https://api.deepseek.com/chat/completions",
    ]);
  });

  it("leaves loopback alone", async () => {
    // Nothing listens on port 1: a connect error — not the guard's refusal.
    await expect(fetch("http://127.0.0.1:1/")).rejects.not.toThrow(
      /tests never reach the network/,
    );
    expect(takeRefused()).toEqual([]);
  });
});
