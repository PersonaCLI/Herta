import { describe, expect, it } from "vitest";
import type { RunEntry, SystemBlock, UserBlock } from "./group-record.js";
import {
  formatDuration,
  liveState,
  runFacts,
  runSections,
  runTookMs,
} from "./run-facts.js";

type Verb = "Reading" | "Writing" | "Running" | "Searching";
const op = (verb: Verb, arg: string, at?: string): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: `${verb} ${arg}`,
  digest: { kind: "op", verb, arg },
  ...(at !== undefined ? { at } : {}),
});
const exit = (code: number): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: `↳ exit ${code} · 2 lines`,
  digest: { kind: "text", text: "", exitCode: code, lineCount: 2 },
});
const tests: SystemBlock = {
  kind: "system",
  label: "差分协处理器",
  body: "↳ tests: 3 passed",
  digest: { kind: "tests", status: "passed", summary: "3 passed" },
};
const patch: SystemBlock = {
  kind: "system",
  label: "系统",
  body: "patch preview: a.ts (+1 -0)",
  digest: { kind: "patch", files: ["a.ts"], add: 1, del: 0 },
};
const marker = (at?: string): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: "完成 · 1 file",
  role: "done-marker",
  ...(at !== undefined ? { at } : {}),
});
const steer = (text: string): UserBlock => ({
  kind: "user",
  text,
  steer: true,
});
const rows = (...blocks: (SystemBlock | UserBlock)[]): RunEntry[] =>
  blocks.map((block) =>
    block.kind === "user" ? { kind: "steer", block } : { kind: "row", block },
  );

describe("runFacts (ADR 0085 §6)", () => {
  it("counts its steps and distinct files, and names the newest step's phase", () => {
    const f = runFacts([
      op("Reading", "a.ts"),
      op("Writing", "a.ts"),
      op("Writing", "a.ts"),
      op("Running", "npm test"),
      tests,
    ]);
    expect(f.steps).toBe(4);
    expect(f.files).toBe(1);
    expect(f.phase).toBe("verify");
    expect(f.summary).toBeNull();
  });

  it("is timed from her dispatching bubble, else its first row, to its marker", () => {
    const blocks = [
      op("Reading", "a.ts", "2026-11-04T08:00:02.000Z"),
      marker("2026-11-04T08:00:09.000Z"),
    ];
    expect(runTookMs(runFacts(blocks, "2026-11-04T08:00:00.000Z"))).toBe(9000);
    expect(runTookMs(runFacts(blocks))).toBe(7000);
    // No stamps, no time: nothing is made up.
    expect(runTookMs(runFacts([op("Reading", "a.ts"), marker()]))).toBeNull();
    // Still running: no end.
    expect(
      runTookMs(runFacts([op("Reading", "a.ts", "2026-11-04T08:00:02.000Z")])),
    ).toBeNull();
  });

  it("reads the marker's roll-up once it ended", () => {
    expect(runFacts([op("Reading", "a.ts"), marker()]).summary).toEqual({
      kind: "raw",
      text: "完成 · 1 file",
    });
  });
});

describe("liveState: the device's words", () => {
  it("an approval holds it; a check reads as one; anything else is working", () => {
    expect(liveState("verify", true)).toBe("waiting");
    expect(liveState("verify", false)).toBe("verifying");
    expect(liveState("modify", false)).toBe("working");
    expect(liveState(undefined, false)).toBe("working");
  });

  it("formats a time as the activity line did", () => {
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(187_000)).toBe("3:07");
  });
});

describe("runSections — the 完整记录 tab's stretches", () => {
  it("groups rows by phase, a result under its own step's", () => {
    const sections = runSections(
      rows(
        op("Reading", "a.ts"),
        op("Searching", "foo"),
        patch,
        op("Writing", "a.ts"),
        op("Running", "npm test"),
        exit(0),
      ),
    );
    expect(
      sections.map((s) =>
        s.kind === "phase" ? [s.phase, s.rows.length] : ["steer", 0],
      ),
    ).toEqual([
      ["explore", 2],
      // The patch folds into the write it previewed: one row, not two.
      ["modify", 1],
      // The exit row stands under the command that made it.
      ["verify", 2],
    ]);
  });

  it("a test run is a check whatever its command looked like, its result with it", () => {
    const sections = runSections(
      rows(op("Writing", "a.ts"), op("Running", "make all"), tests),
    );
    const last = sections[sections.length - 1];
    expect(last?.kind === "phase" && last.phase).toBe("verify");
    expect(last?.kind === "phase" ? last.rows.length : 0).toBe(2);
  });

  it("a test result with no command before it is a check on its own; the read before it stays a look (lab 2026-11-04)", () => {
    const sections = runSections(rows(op("Reading", "a.ts"), patch, tests));
    expect(
      sections.map((s) =>
        s.kind === "phase" ? [s.phase, s.rows.length] : ["steer", 0],
      ),
    ).toEqual([
      ["explore", 2],
      ["verify", 1],
    ]);
  });

  it("a steer breaks the stretch it lands in, and stands where 板砖 took it", () => {
    const sections = runSections(
      rows(
        op("Reading", "a.ts"),
        steer("先别动 api 目录"),
        op("Reading", "b.ts"),
      ),
    );
    expect(sections.map((s) => s.kind)).toEqual(["phase", "steer", "phase"]);
    const s = sections[1];
    expect(s?.kind === "steer" && s.block.text).toBe("先别动 api 目录");
  });

  it("the marker is not a row: the tab ends on its facts", () => {
    const sections = runSections(rows(op("Reading", "a.ts"), marker()));
    expect(sections).toHaveLength(1);
    expect(sections[0]?.kind === "phase" ? sections[0].rows : []).toHaveLength(
      1,
    );
  });

  it("a stretch keeps its key as rows arrive", () => {
    const first = runSections(rows(op("Reading", "a.ts")));
    const later = runSections(
      rows(op("Reading", "a.ts"), op("Reading", "b.ts"), op("Writing", "b.ts")),
    );
    expect(later[0]?.key).toBe(first[0]?.key);
    expect(later[1]?.key).not.toBe(later[0]?.key);
  });
});
