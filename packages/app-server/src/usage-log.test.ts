import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportUsageNote } from "@herta/core";
import { reportProviderFailure, reportProviderUsage } from "@herta/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installUsageLog } from "./usage-log.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "usage-log-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const call = (n: number) => ({
  endpoint: "completion" as const,
  model: "deepseek-v4-pro",
  promptTokens: 1000 + n,
  completionTokens: n,
  cacheHitTokens: 960,
  cacheMissTokens: 40 + n,
});

describe("installUsageLog", () => {
  it("appends one JSON line per reported call, in order, numbers only — and stops when uninstalled", async () => {
    const file = join(dir, "nested", "usage.jsonl");
    const uninstall = installUsageLog(file);
    for (let n = 0; n < 5; n++) reportProviderUsage(call(n));
    await uninstall();
    reportProviderUsage(call(99)); // after uninstall: nobody is listening
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(5);
    const rows = lines.map((l) => JSON.parse(l));
    expect(rows.map((r) => r.completion)).toEqual([0, 1, 2, 3, 4]);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["at", "completion", "endpoint", "hit", "miss", "model", "prompt"].sort(),
    );
    expect(rows[0]).toMatchObject({
      endpoint: "completion",
      model: "deepseek-v4-pro",
      prompt: 1000,
      hit: 960,
      miss: 40,
    });
    expect(Number.isNaN(Date.parse(rows[0].at))).toBe(false);
  });

  it("the idle dream pass's calls say so — `source: dream` — and the session's own carry no source (dream review 2026-09-22, finding 4)", async () => {
    const file = join(dir, "usage.jsonl");
    const uninstall = installUsageLog(file);
    reportProviderUsage(call(1));
    reportProviderUsage({ ...call(2), endpoint: "chat", source: "dream" });
    await uninstall();
    const rows = readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows[0]).not.toHaveProperty("source");
    expect(rows[1]).toMatchObject({ endpoint: "chat", source: "dream" });
  });

  it("writes a run's and a turn's measurements beside the calls, told apart by `note` (long-run study item 6)", async () => {
    const file = join(dir, "usage.jsonl");
    const uninstall = installUsageLog(file);
    reportProviderUsage(call(1));
    reportUsageNote({
      kind: "backend-run",
      steps: 37,
      clearedSteps: 12,
      droppedSteps: 3,
      maxDropped: 16,
      peakSent: 198_000,
      peakUntrimmed: 260_000,
      budget: 200_000,
    });
    reportUsageNote({
      kind: "actor-turn",
      calls: 4,
      firstPrompt: 21_930,
      peakPrompt: 38_000,
    });
    await uninstall();
    reportUsageNote({
      kind: "actor-turn",
      calls: 1,
      firstPrompt: 1,
      peakPrompt: 1,
    });
    const rows = readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(3);
    expect(rows[0]).not.toHaveProperty("note");
    expect(rows[1]).toEqual({
      at: rows[1].at,
      note: "backend-run",
      steps: 37,
      clearedSteps: 12,
      droppedSteps: 3,
      maxDropped: 16,
      peakSent: 198_000,
      peakUntrimmed: 260_000,
      budget: 200_000,
    });
    expect(rows[2]).toEqual({
      at: rows[2].at,
      note: "actor-turn",
      calls: 4,
      firstPrompt: 21_930,
      peakPrompt: 38_000,
    });
  });

  it("moves an oversized log aside once, at install, and starts a fresh one", async () => {
    const file = join(dir, "usage.jsonl");
    writeFileSync(file, "x".repeat(4 * 1024 * 1024 + 1));
    const uninstall = installUsageLog(file);
    reportProviderUsage(call(1));
    await uninstall();
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(file, "utf8").trimEnd().split("\n")).toHaveLength(1);
  });

  it("an unwritable path costs the call nothing", async () => {
    // A FILE where the directory should be: mkdir and every append fail.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "");
    const uninstall = installUsageLog(join(blocker, "usage.jsonl"));
    expect(() => reportProviderUsage(call(1))).not.toThrow();
    await expect(uninstall()).resolves.toBeUndefined();
  });
});

describe("installUsageLog — whose call, how long, and the calls with no usage (review 2026-11-10)", () => {
  it("a usage line carries the site and the wall time when the provider said them", async () => {
    const file = join(dir, "usage.jsonl");
    const uninstall = installUsageLog(file);
    reportProviderUsage({ ...call(1), site: "supervisor", ms: 11_502 });
    reportProviderUsage(call(2));
    await uninstall();
    const rows = readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ site: "supervisor", ms: 11_502 });
    // An unlabelled provider's line is the one it always was.
    expect(rows[1]).not.toHaveProperty("site");
    expect(rows[1]).not.toHaveProperty("ms");
  });

  it("a call that stated no usage leaves a `call` note with what ended it", async () => {
    const file = join(dir, "usage.jsonl");
    const uninstall = installUsageLog(file);
    reportProviderFailure({
      endpoint: "chat",
      model: "deepseek-flash",
      site: "supervisor",
      outcome: "aborted",
      ms: 60_002,
    });
    await uninstall();
    reportProviderFailure({
      endpoint: "chat",
      model: "deepseek-flash",
      outcome: "network",
      ms: 5,
    }); // after uninstall: nobody is listening
    const rows = readFileSync(file, "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      note: "call",
      outcome: "aborted",
      endpoint: "chat",
      model: "deepseek-flash",
      site: "supervisor",
      ms: 60_002,
    });
    // Numbers and names only, as every line of this file.
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["at", "endpoint", "model", "ms", "note", "outcome", "site"].sort(),
    );
  });
});
