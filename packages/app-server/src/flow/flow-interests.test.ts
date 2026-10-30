import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { narrativeDirFor, trailblazerNotesFileName } from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { removeTmpDir } from "../testing/tmp-workspace.js";
import {
  DEFAULT_FLOW_SETTINGS,
  gatherFlowInterests,
  hasInterests,
  NOTES_CHARS,
  normalizeFlowSettings,
} from "./flow-interests.js";
import {
  DEFAULT_FLOW_TOPICS,
  FLOW_TOPIC_GROUPS,
  flowTopicNames,
  knownFlowTopics,
  MAX_FLOW_TOPICS,
} from "./flow-topics.js";
import type { FlowSettings } from "./flow-types.js";

/** What the topics come from (ADR 0084 §4, amendment "topics are picked"):
 *  the keywords picked, and her notes, read by the harness. */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTmpDir(d);
});
async function workspace(
  name: string,
  files: Record<string, string> = {},
): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "herta-flow-ws-"));
  dirs.push(base);
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    await mkdir(join(root, f, ".."), { recursive: true });
    await writeFile(join(root, f), text);
  }
  return root;
}

const ON: FlowSettings = { enabled: true, topics: ["ai", "space"] };

describe("the keyword list", () => {
  it("has distinct ids, a name in each language, and defaults from the list", () => {
    const ids = FLOW_TOPIC_GROUPS.flatMap((g) => g.topics.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of FLOW_TOPIC_GROUPS)
      for (const t of g.topics) {
        expect(t.zh.trim()).not.toBe("");
        expect(t.en.trim()).not.toBe("");
      }
    expect(knownFlowTopics(DEFAULT_FLOW_TOPICS)).toEqual(DEFAULT_FLOW_TOPICS);
  });

  it("keeps known ids once each, at most twelve, and names them in a language", () => {
    expect(knownFlowTopics(["ai", "ai", "nope", 3, "space"])).toEqual([
      "ai",
      "space",
    ]);
    const ids = FLOW_TOPIC_GROUPS.flatMap((g) => g.topics.map((t) => t.id));
    expect(knownFlowTopics(ids)).toHaveLength(MAX_FLOW_TOPICS);
    expect(flowTopicNames(["space", "ai"], "zh")).toEqual([
      "航天与天文",
      "人工智能",
    ]);
    expect(flowTopicNames(["space", "ai"], "en")).toEqual(["Space", "AI"]);
  });
});

describe("gatherFlowInterests", () => {
  it("reads the picked topics in the issue's language, and her notes always", async () => {
    const root = await workspace("w", {
      "package.json": JSON.stringify({ dependencies: { vite: "6" } }),
      [join(".herta", "narrative", trailblazerNotesFileName("zh"))]:
        "开拓者在做一个 CLI。",
    });
    const got = await gatherFlowInterests({
      settings: ON,
      workspaceRoots: [root],
      lang: "zh",
    });
    // A workspace's libraries are no source any more (owner 2026-10-30).
    expect(got).toEqual({
      named: ["人工智能", "航天与天文"],
      notes: "开拓者在做一个 CLI。",
    });
    expect(hasInterests(got)).toBe(true);

    const notesOnly = await gatherFlowInterests({
      settings: { ...ON, topics: [] },
      workspaceRoots: [root],
      lang: "zh",
    });
    expect(notesOnly.named).toEqual([]);
    expect(hasInterests(notesOnly)).toBe(true);

    const nothing = await gatherFlowInterests({
      settings: { ...ON, topics: [] },
      workspaceRoots: [],
      lang: "en",
    });
    expect(hasInterests(nothing)).toBe(false);
  });

  it("reads her notes in the issue's language first, the other when that has none, capped", async () => {
    const enOnly = await workspace("e", {
      [join(".herta", "narrative-en", trailblazerNotesFileName("en"))]:
        "Builds a CLI.",
    });
    const zhLong = await workspace("z", {
      [join(".herta", "narrative", trailblazerNotesFileName("zh"))]:
        "长".repeat(NOTES_CHARS + 50),
    });
    expect(narrativeDirFor(enOnly, "en")).toContain("narrative-en");
    const zh = await gatherFlowInterests({
      settings: ON,
      workspaceRoots: [enOnly],
      lang: "zh",
    });
    expect(zh.notes).toBe("Builds a CLI.");
    const capped = await gatherFlowInterests({
      settings: ON,
      workspaceRoots: [zhLong, enOnly],
      lang: "zh",
    });
    expect(Array.from(capped.notes)).toHaveLength(NOTES_CHARS);
    const none = await gatherFlowInterests({
      settings: ON,
      workspaceRoots: [join(zhLong, "missing")],
      lang: "en",
    });
    expect(none.notes).toBe("");
  });
});

describe("normalizeFlowSettings", () => {
  it("is off by default with the default topics, and falls back field by field", () => {
    expect(normalizeFlowSettings(undefined)).toEqual(DEFAULT_FLOW_SETTINGS);
    expect(DEFAULT_FLOW_SETTINGS).toEqual({
      enabled: false,
      topics: DEFAULT_FLOW_TOPICS,
    });
    expect(
      normalizeFlowSettings({ enabled: "yes", topics: ["space", 3, "nope"] }),
    ).toEqual({ enabled: false, topics: ["space"] });
    // None picked stays none picked.
    expect(normalizeFlowSettings({ enabled: true, topics: [] })).toEqual({
      enabled: true,
      topics: [],
    });
  });

  it("a section from before topics were picked gets the default topics", () => {
    expect(
      normalizeFlowSettings({
        enabled: true,
        sources: { named: true, stacks: true, notes: true },
        interests: ["Rust"],
      }),
    ).toEqual({ enabled: true, topics: DEFAULT_FLOW_TOPICS });
  });
});
