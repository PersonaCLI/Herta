import type {
  SystemBlock,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import { COMPACTION_TEXT } from "./compaction-text.js";
import {
  groupRunsForHerta,
  LIVE_RUN_VERBATIM_STEPS,
  liveRunForHerta,
} from "./run-grouping.js";
import { serializeTerminalRecord } from "./serialize.js";

const user = (text: string, extra: object = {}): TerminalRecordBlock => ({
  kind: "user",
  text,
  ...extra,
});
const talk = (text: string) => user(text, { duringRun: true });
const steer = (text: string) => user(text, { steer: true });
const herta = (text: string, extra: object = {}): TerminalRecordBlock => ({
  kind: "herta",
  surface: "speech",
  text,
  ...extra,
});
const answer = (text: string) => herta(text, { duringRun: true });
const op = (verb: string, arg: string): SystemBlock =>
  ({
    kind: "system",
    label: "差分协处理器",
    body: `${verb} ${arg}`,
    digest: { kind: "op", verb, arg },
  }) as SystemBlock;
const exit = (exitCode: number, tail = "out"): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: `↳ exit ${exitCode} · 1 lines`,
  digest: { kind: "text", text: "", exitCode, lineCount: 1 },
  evidenceDetail: `↳ 输出:\n${tail}`,
  evidence: [{ kind: "output", text: tail }],
});
const finding: SystemBlock = {
  kind: "system",
  label: "差分协处理器",
  body: "↳ finding: Login.jsx:12 reads data.session with no check",
  digest: {
    kind: "finding",
    claim: "Login.jsx:12 reads data.session with no check",
    cites: ["Login.jsx:12"],
  },
} as SystemBlock;
const marker: SystemBlock = {
  kind: "system",
  label: "差分协处理器",
  body: "完成 · 1 个文件",
  role: "done-marker",
  markerSummary: {
    kind: "done",
    state: "completed",
    fileCount: 1,
    riskCount: 0,
  },
  evidenceDetail: "↳ 改动文件: src/Login.jsx",
  evidence: [{ kind: "files", paths: ["src/Login.jsx"] }],
};
const attachment: SystemBlock = {
  kind: "system",
  label: "系统",
  body: "附件 notes.txt",
  digest: {
    kind: "attachment",
    name: "notes.txt",
    path: ".herta/attachments/s/notes.txt",
    lines: 1,
    chars: 4,
  },
} as SystemBlock;

const dispatch = herta("@板砖 查一下登录为什么没反应");

describe("groupRunsForHerta — each run after its dispatch, the talk after it (ADR 0085 §3)", () => {
  it("with no talk during a run nothing moves: the same array comes back", () => {
    const records: TerminalRecord[] = [
      [
        user("修一下"),
        dispatch,
        op("Reading", "a.ts"),
        marker,
        herta("好了。"),
      ],
      // A steer is a message to 板砖: it stays inside.
      [
        user("修"),
        dispatch,
        op("Reading", "a.ts"),
        steer("先别动 api"),
        marker,
      ],
      // A run cut short, then a turn: the turn ends it.
      [
        user("修"),
        dispatch,
        op("Reading", "a.ts"),
        user("算了"),
        herta("行。"),
      ],
      [],
    ];
    for (const r of records) {
      const g = groupRunsForHerta(r);
      expect(g.record).toBe(r);
      expect(g.live).toBeNull();
    }
  });

  it("talk during an ended run, with what came with it and her answer, follows the run's marker", () => {
    const r1 = op("Reading", "a.ts");
    const r2 = op("Writing", "a.ts");
    const record: TerminalRecord = [
      user("修一下"),
      dispatch,
      r1,
      talk("顺便问下，周末那个会几点？"),
      attachment,
      answer("三点。"),
      r2,
      marker,
      herta("修好了。"),
    ];
    const g = groupRunsForHerta(record);
    expect(g.live).toBeNull();
    expect(g.record).toEqual([
      user("修一下"),
      dispatch,
      r1,
      r2,
      marker,
      talk("顺便问下，周末那个会几点？"),
      attachment,
      answer("三点。"),
      herta("修好了。"),
    ]);
  });

  it("her checkpoint stays inside the run; a steer stays where 板砖 took it", () => {
    const record: TerminalRecord = [
      dispatch,
      op("Reading", "a.ts"),
      herta("读到了。"),
      talk("几点了？"),
      steer("先别动 api"),
      op("Reading", "b.ts"),
    ];
    const g = groupRunsForHerta(record);
    expect(
      g.record.map((b) => (b.kind === "system" ? b.body : b.text)),
    ).toEqual([
      "@板砖 查一下登录为什么没反应",
      "Reading a.ts",
      "读到了。",
      "先别动 api",
      "Reading b.ts",
      "几点了？",
    ]);
    // Still working: the run is the live one, the talk after it.
    expect(g.live).toEqual({ start: 1, end: 5 });
  });
});

describe("liveRunForHerta — a run still working, while the Trailblazer talks", () => {
  const entries = [
    op("Reading", "src/a.ts"),
    op("Running", "npm run build"),
    exit(2, "boom"),
    op("Reading", "src/b.ts"),
    steer("先别动 api 目录"),
    op("Reading", "src/c.ts"),
    finding,
    op("Writing", "src/c.ts"),
    op("Running", "npm test"),
  ];

  it("names its state first, folds its earlier steps, keeps the newest steps, failures and findings, the steer in place", () => {
    const out = liveRunForHerta(entries, "zh");
    const t = COMPACTION_TEXT.zh;
    const shape = out.map((b) =>
      b.kind === "user"
        ? `steer:${b.text}`
        : b.kind === "system" && b.body.startsWith(t.runLiveHeader)
          ? "fold"
          : b.kind === "system"
            ? b.body
            : b.text,
    );
    expect(shape).toEqual([
      t.runLive(6),
      "fold",
      // The failed build, whole: its command and its exit.
      "Running npm run build",
      "↳ exit 2 · 1 lines",
      "fold",
      "steer:先别动 api 目录",
      "fold",
      "↳ finding: Login.jsx:12 reads data.session with no check",
      // The newest steps, verbatim.
      "Writing src/c.ts",
      "Running npm test",
    ]);
    expect(LIVE_RUN_VERBATIM_STEPS).toBe(2);
  });
});

describe("her view with talk during a run (ADR 0085 §3)", () => {
  it("a live run reads as its live form, the talk after it; the dispatch line and what came before are unchanged", () => {
    const head: TerminalRecord = [user("修一下登录"), dispatch];
    const record: TerminalRecord = [
      ...head,
      op("Reading", "src/a.ts"),
      op("Reading", "src/b.ts"),
      talk("顺便问下，周末那个会几点？"),
      op("Reading", "src/c.ts"),
      op("Writing", "src/c.ts"),
    ];
    const view = serializeTerminalRecord(record, {
      verbatimSinceLastDispatch: true,
    });
    const before = serializeTerminalRecord(head, {
      verbatimSinceLastDispatch: true,
    });
    // The prefix up to the dispatch is the bytes it was: cached.
    expect(view.startsWith(before)).toBe(true);
    const at = (s: string) => view.indexOf(s);
    expect(at(COMPACTION_TEXT.zh.runLive(4))).toBeGreaterThan(at("@板砖"));
    expect(at(COMPACTION_TEXT.zh.runLiveHeader)).toBeGreaterThan(0);
    expect(at("src/c.ts")).toBeGreaterThan(
      at(COMPACTION_TEXT.zh.runLiveHeader),
    );
    // The talk follows the run, as speech.
    expect(at("（开拓者 说）\n顺便问下，周末那个会几点？")).toBeGreaterThan(
      view.lastIndexOf("src/c.ts"),
    );
    expect(view.endsWith("（/开拓者 说）")).toBe(true);
  });

  it("with no talk the live run reads exactly as before: verbatim since the dispatch", () => {
    const record: TerminalRecord = [
      user("修一下登录"),
      dispatch,
      op("Reading", "src/a.ts"),
      op("Reading", "src/b.ts"),
      steer("先别动 api"),
      op("Reading", "src/c.ts"),
    ];
    const view = serializeTerminalRecord(record, {
      verbatimSinceLastDispatch: true,
    });
    expect(view).not.toContain(COMPACTION_TEXT.zh.runLive(3));
    expect(view).not.toContain(COMPACTION_TEXT.zh.runLiveHeader);
    // The steer is the speech block it always was.
    expect(view).toContain("（开拓者 说）\n先别动 api\n（/开拓者 说）");
  });

  it("her answer during the run is not her verdict: the marker keeps its roll-up for the verdict turn", () => {
    const record: TerminalRecord = [
      user("修一下登录"),
      dispatch,
      op("Reading", "src/Login.jsx"),
      talk("周末那个会几点？"),
      answer("三点。"),
      op("Writing", "src/Login.jsx"),
      marker,
    ];
    const view = serializeTerminalRecord(record);
    // State 1: the changed file reaches the prompt that writes her verdict.
    expect(view).toContain("src/Login.jsx");
    const markerAt = view.indexOf("改了：src/Login.jsx");
    expect(markerAt).toBeGreaterThan(-1);
    // The talk and her answer follow the run.
    expect(view.indexOf("周末那个会几点？")).toBeGreaterThan(markerAt);
    expect(view.indexOf("三点。")).toBeGreaterThan(markerAt);
    // Anti-vacuous: had her answer counted as the verdict, the marker would
    // have folded with its run (State 2) and the roll-up gone.
    const spoken = serializeTerminalRecord([...record, herta("修好了。")]);
    expect(spoken).not.toContain("改了：src/Login.jsx");
  });
});
