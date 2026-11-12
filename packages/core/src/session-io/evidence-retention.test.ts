import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatchJournalPath } from "../backend/dispatch-journal.js";
import { deleteSessionFiles } from "./delete-session-files.js";
import {
  EVIDENCE_CONFIRM_MS,
  EVIDENCE_KEEP_DAYS,
  removeSessionEvidence,
  sessionWorkspaces,
  sweepEvidence,
  sweepEvidenceSoon,
} from "./evidence-retention.js";

/** How long a workspace keeps its command logs and saved tool results
 *  (owner 2026-11-12): with their session, and thirty days at most. */

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "herta-evidence-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-12T09:00:00Z");
const SID = "0d9d7a66-3c1b-4f3e-9a51-0c6e2b6f1a11";
const OTHER = "7e1f0a52-88c0-4b0e-8a66-2f4d1b9c3d22";

/** Write a file last written `daysOld` days before NOW. */
function put(path: string, daysOld = 0): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "x");
  const at = (NOW - daysOld * DAY) / 1000;
  utimesSync(path, at, at);
}
const log = (root: string, name: string): string =>
  join(root, ".herta", "logs", name);
const result = (root: string, run: string, name = "call_1.txt"): string =>
  join(root, ".herta", "tool-results", run, name);
const logsOf = (root: string): string[] => {
  try {
    return readdirSync(join(root, ".herta", "logs")).sort();
  } catch {
    return [];
  }
};

describe("removeSessionEvidence", () => {
  it("removes that session's logs and the named runs' results, and nothing else", async () => {
    const ws = join(base, "ws");
    put(log(ws, `${SID}-call_1.log`));
    put(log(ws, `${SID}-call_2.log`));
    put(log(ws, `${OTHER}-call_1.log`));
    put(log(ws, "servers/web-20261112T090000.log"));
    put(log(ws, `${SID}-notes.txt`));
    put(result(ws, "task-aaa"));
    put(result(ws, "task-bbb"));

    const removed = await removeSessionEvidence({
      sessionId: SID,
      workspaceRoots: [ws, ws, join(base, "absent")],
      runIds: ["task-aaa", "../../escape", ""],
    });
    expect(removed).toBe(3);
    // Another session's log, a file that is no log, and the servers' folder.
    expect(logsOf(ws)).toEqual([
      `${SID}-notes.txt`,
      `${OTHER}-call_1.log`,
      "servers",
    ]);
    expect(existsSync(result(ws, "task-aaa"))).toBe(false);
    expect(existsSync(result(ws, "task-bbb"))).toBe(true);
  });

  it("an id that is a prefix of another's is not that other's", async () => {
    const ws = join(base, "ws");
    put(log(ws, "abc-call_1.log"));
    put(log(ws, "abcd-call_1.log"));
    await removeSessionEvidence({ sessionId: "abc", workspaceRoots: [ws] });
    expect(logsOf(ws)).toEqual(["abcd-call_1.log"]);
  });

  it("leaves a session id the log writer would have rewritten to the sweep", async () => {
    const ws = join(base, "ws");
    put(log(ws, "..-call_1.log"));
    expect(
      await removeSessionEvidence({ sessionId: "..", workspaceRoots: [ws] }),
    ).toBe(0);
    expect(logsOf(ws)).toEqual(["..-call_1.log"]);
  });
});

describe("sessionWorkspaces", () => {
  it("names where the session started and everywhere it was moved to", async () => {
    const file = join(base, "s.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({
          _kind: "session_meta",
          version: 1,
          sessionId: SID,
          workspaceRoot: "/home/w",
          backendWorkspace: "/managed/w",
        }),
        JSON.stringify({
          kind: "user",
          text: 'move to {"_kind":"workspace_set","path":"/not/this"}',
        }),
        JSON.stringify({ _kind: "workspace_set", path: "/proj/a", at: "t" }),
        JSON.stringify({ _kind: "turn_end", outcome: "completed", at: "t" }),
        JSON.stringify({ _kind: "workspace_set", path: "/proj/a", at: "t" }),
        '{"_kind":"workspace_set","path":"/cut',
      ].join("\n"),
    );
    expect(await sessionWorkspaces(file)).toEqual([
      "/home/w",
      "/managed/w",
      "/proj/a",
    ]);
    expect(await sessionWorkspaces(join(base, "absent.jsonl"))).toEqual([]);
  });
});

describe("deleteSessionFiles — the session's logs go with it", () => {
  it("from the host's workspace, the ones the record names and its last run's", async () => {
    const transcripts = join(base, "transcripts");
    const host = join(base, "host");
    const moved = join(base, "moved");
    const ran = join(base, "ran");
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(
      join(transcripts, `${SID}.jsonl`),
      `${[
        JSON.stringify({
          _kind: "session_meta",
          version: 1,
          sessionId: SID,
          workspaceRoot: host,
        }),
        JSON.stringify({ kind: "user", text: "hi" }),
        JSON.stringify({ _kind: "workspace_set", path: moved, at: "t" }),
      ].join("\n")}\n`,
    );
    const journal = dispatchJournalPath(transcripts, SID);
    mkdirSync(dirname(journal), { recursive: true });
    writeFileSync(
      journal,
      `${JSON.stringify({
        kind: "start",
        v: 1,
        taskId: "task-last",
        at: "t",
        workspaceRoot: ran,
        brief: { taskId: "task-last" },
        frame: {},
      })}\n`,
    );
    for (const ws of [host, moved, ran]) {
      put(log(ws, `${SID}-call_1.log`));
      put(log(ws, `${OTHER}-call_1.log`));
    }
    put(result(ran, "task-last"));
    put(result(ran, "task-earlier"));

    await deleteSessionFiles(transcripts, SID, undefined, host);

    for (const ws of [host, moved, ran]) {
      expect(logsOf(ws)).toEqual([`${OTHER}-call_1.log`]);
    }
    expect(existsSync(result(ran, "task-last"))).toBe(false);
    // An earlier run is named nowhere by then: the sweep's.
    expect(existsSync(result(ran, "task-earlier"))).toBe(true);
    expect(existsSync(join(transcripts, `${SID}.jsonl`))).toBe(false);
  });
});

describe("sweepEvidence", () => {
  const OLD = EVIDENCE_KEEP_DAYS + 5;

  function seed(ws: string): void {
    put(log(ws, `${SID}-old.log`), OLD);
    put(log(ws, `${SID}-new.log`), 3);
    put(log(ws, "servers/web-old.log"), OLD);
    put(log(ws, "servers/web-new.log"), 1);
    put(result(ws, "task-old", "a.txt"), OLD);
    put(result(ws, "task-old", "b.json"), OLD);
    put(result(ws, "task-mixed", "old.txt"), OLD);
    put(result(ws, "task-mixed", "new.txt"), 2);
    put(join(ws, ".herta", "memory", "project.jsonl"), 400);
    put(join(ws, ".herta", "logs", "notes.md"), 400);
  }

  it("marks what is past thirty days, and a sweep a day later removes it", async () => {
    const ws = join(base, "ws");
    seed(ws);
    // First sight: written down, nothing removed.
    expect(await sweepEvidence(ws, NOW)).toBe(0);
    expect(existsSync(log(ws, `${SID}-old.log`))).toBe(true);
    // Not yet a day.
    expect(await sweepEvidence(ws, NOW + EVIDENCE_CONFIRM_MS - 1)).toBe(0);

    expect(await sweepEvidence(ws, NOW + EVIDENCE_CONFIRM_MS)).toBe(5);
    expect(logsOf(ws)).toEqual([`${SID}-new.log`, "notes.md", "servers"]);
    expect(readdirSync(join(ws, ".herta", "logs", "servers"))).toEqual([
      "web-new.log",
    ]);
    // A run's folder goes once it is empty, and not before.
    expect(existsSync(join(ws, ".herta", "tool-results", "task-old"))).toBe(
      false,
    );
    expect(
      readdirSync(join(ws, ".herta", "tool-results", "task-mixed")),
    ).toEqual(["new.txt"]);
    // Nothing else under `.herta` is this sweep's.
    expect(existsSync(join(ws, ".herta", "memory", "project.jsonl"))).toBe(
      true,
    );
  });

  it("a clock set two months ahead and back removes nothing", async () => {
    const ws = join(base, "ws");
    put(log(ws, `${SID}-a.log`), 3);
    put(log(ws, `${SID}-b.log`), 20);
    const ahead = NOW + 60 * DAY;
    expect(await sweepEvidence(ws, ahead)).toBe(0);
    expect(await sweepEvidence(ws, ahead + 60_000)).toBe(0);
    // Set right: the mark is from the future and names nothing.
    expect(await sweepEvidence(ws, NOW + DAY)).toBe(0);
    expect(await sweepEvidence(ws, NOW + 2 * DAY)).toBe(0);
    expect(logsOf(ws)).toEqual([`${SID}-a.log`, `${SID}-b.log`]);
    // And real time still ends: `b` turns thirty days old, is marked, and
    // goes a sweep later.
    expect(await sweepEvidence(ws, NOW + 11 * DAY)).toBe(0);
    expect(await sweepEvidence(ws, NOW + 12 * DAY)).toBe(1);
    expect(logsOf(ws)).toEqual([`${SID}-a.log`]);
  });

  it("writes no mark, and no `.herta`, where nothing has expired", async () => {
    const ws = join(base, "clean");
    mkdirSync(ws, { recursive: true });
    expect(await sweepEvidence(ws, NOW)).toBe(0);
    expect(existsSync(join(ws, ".herta"))).toBe(false);
    put(log(ws, `${SID}-new.log`), 1);
    expect(await sweepEvidence(ws, NOW)).toBe(0);
    expect(existsSync(join(ws, ".herta", "retention.json"))).toBe(false);
  });

  it("never follows a link out of the folder", async () => {
    const ws = join(base, "ws");
    const outside = join(base, "outside.log");
    put(outside, OLD);
    put(log(ws, `${SID}-old.log`), OLD);
    let linked = true;
    try {
      symlinkSync(outside, log(ws, "link.log"));
    } catch {
      linked = false; // no right to make links on this machine
    }
    await sweepEvidence(ws, NOW);
    await sweepEvidence(ws, NOW + EVIDENCE_CONFIRM_MS);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(log(ws, `${SID}-old.log`))).toBe(false);
    if (linked) expect(logsOf(ws)).toContain("link.log");
  });

  it("a malformed mark is no mark", async () => {
    const ws = join(base, "ws");
    put(log(ws, `${SID}-old.log`), OLD);
    writeFileSync(join(ws, ".herta", "retention.json"), '{"cutoff":"soon"}');
    expect(await sweepEvidence(ws, NOW)).toBe(0);
    expect(
      JSON.parse(readFileSync(join(ws, ".herta", "retention.json"), "utf8")),
    ).toEqual({ cutoff: NOW - EVIDENCE_KEEP_DAYS * DAY, at: NOW });
  });
});

describe("sweepEvidenceSoon", () => {
  it("sweeps a workspace at most once every six hours", async () => {
    const ws = join(base, "soon");
    mkdirSync(ws, { recursive: true });
    const first = sweepEvidenceSoon(ws, NOW);
    expect(first).not.toBeNull();
    await first;
    expect(sweepEvidenceSoon(ws, NOW + 60_000)).toBeNull();
    expect(
      sweepEvidenceSoon(join(base, "another"), NOW + 60_000),
    ).not.toBeNull();
    const later = sweepEvidenceSoon(ws, NOW + 7 * 60 * 60 * 1000);
    expect(later).not.toBeNull();
    await later;
  });
});
