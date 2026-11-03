import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HERTA_PERSON_PRIME } from "../schema.js";
import {
  mkTempKnowledgeDb,
  type TempDb,
} from "../testing/mk-temp-knowledge-db.js";
import { extractHertaScenes } from "./extract-scenes.js";

describe("extractHertaScenes", () => {
  let h: TempDb;
  beforeEach(() => {
    h = mkTempKnowledgeDb();
  });
  // Closed after each test: an open database holds its directory on Windows,
  // and the eight left open made the temp-dir tracker's removal outlast its
  // own hook (2026-11-03).
  afterEach(() => {
    h.cleanup();
  });

  function seedDoc(opts: {
    docId: string;
    title: string;
    path: string;
    turns: Array<{
      ordinal: number;
      text: string;
      speakerEntityId?: string;
      speakerSurface?: string;
      isDialogue?: boolean;
    }>;
  }): void {
    h.store.upsertDocument({
      id: opts.docId,
      kind: "world_lore",
      title: opts.title,
      path: opts.path,
      sourceHash: `hash-${opts.docId}`,
      createdAt: "2026-01-01T00:00:00Z",
    });
    for (const t of opts.turns) {
      h.store.insertChunk({
        id: `${opts.docId}#${t.ordinal}`,
        documentId: opts.docId,
        ordinal: t.ordinal,
        sectionPath: ["root"],
        text: t.text,
        textHash: `${opts.docId}-${t.ordinal}`,
        tokenEstimate: 10,
        isDialogue: t.isDialogue ?? true,
        isHertaVoiceEvidence: t.speakerEntityId === HERTA_PERSON_PRIME,
        isCanonFactCandidate: false,
        qualityScore: 0.5,
        ...(t.speakerEntityId !== undefined
          ? { speakerEntityId: t.speakerEntityId }
          : {}),
        ...(t.speakerSurface !== undefined
          ? { speaker: t.speakerSurface }
          : {}),
      });
    }
  }

  it("returns a scene per document containing target speaker, ordinal-ordered", () => {
    seedDoc({
      docId: "doc1",
      title: "First scene",
      path: "data/test/doc1.html",
      turns: [
        { ordinal: 0, text: "narrator beat", speakerSurface: "?" },
        {
          ordinal: 1,
          text: "Herta line 1",
          speakerEntityId: HERTA_PERSON_PRIME,
        },
        { ordinal: 2, text: "March's reply", speakerSurface: "三月七" },
        {
          ordinal: 3,
          text: "Herta line 2",
          speakerEntityId: HERTA_PERSON_PRIME,
        },
      ],
    });
    seedDoc({
      docId: "doc2",
      title: "Second scene",
      path: "data/test/doc2.html",
      turns: [
        { ordinal: 0, text: "Herta solo", speakerEntityId: HERTA_PERSON_PRIME },
        { ordinal: 1, text: "narrator beat" },
      ],
    });

    const scenes = extractHertaScenes(h.store, {
      targetEntityId: HERTA_PERSON_PRIME,
    });
    expect(scenes).toHaveLength(2);
    expect(scenes[0]!.documentId).toBe("doc1");
    expect(scenes[0]!.turns.map((t) => t.ordinal)).toEqual([0, 1, 2, 3]);
    expect(scenes[0]!.targetTurnCount).toBe(2);
  });

  it("flags target turns with isTarget=true", () => {
    seedDoc({
      docId: "doc1",
      title: "x",
      path: "data/x.html",
      turns: [
        { ordinal: 0, text: "她说", speakerEntityId: HERTA_PERSON_PRIME },
        { ordinal: 1, text: "回应", speakerSurface: "螺丝咕姆" },
      ],
    });
    const scenes = extractHertaScenes(h.store, {
      targetEntityId: HERTA_PERSON_PRIME,
    });
    expect(scenes[0]!.turns[0]!.isTarget).toBe(true);
    expect(scenes[0]!.turns[1]!.isTarget).toBe(false);
  });

  it("collects otherSpeakers, preferring canonical name then surface", () => {
    h.store.upsertEntity({
      id: "person.screwllum",
      kind: "person",
      canonicalName: "螺丝咕姆",
      aliases: [],
    });
    seedDoc({
      docId: "doc1",
      title: "x",
      path: "data/x.html",
      turns: [
        { ordinal: 0, text: "Herta", speakerEntityId: HERTA_PERSON_PRIME },
        {
          ordinal: 1,
          text: "named",
          speakerEntityId: "person.screwllum",
          speakerSurface: "螺丝",
        },
        { ordinal: 2, text: "surface-only", speakerSurface: "三月七" },
      ],
    });
    const scenes = extractHertaScenes(h.store, {
      targetEntityId: HERTA_PERSON_PRIME,
    });
    // canonical name from entities wins over surface; surface fallback for unresolved speaker
    expect(scenes[0]!.otherSpeakers).toEqual(
      expect.arrayContaining(["螺丝咕姆", "三月七"]),
    );
  });

  it("drops scenes below minTargetTurns", () => {
    seedDoc({
      docId: "doc-light",
      title: "x",
      path: "data/x.html",
      turns: [
        {
          ordinal: 0,
          text: "Herta single line",
          speakerEntityId: HERTA_PERSON_PRIME,
        },
        { ordinal: 1, text: "filler", speakerSurface: "?" },
      ],
    });
    const scenes = extractHertaScenes(h.store, {
      targetEntityId: HERTA_PERSON_PRIME,
      minTargetTurns: 2,
    });
    expect(scenes).toHaveLength(0);
  });

  it("drops scenes below minTurns", () => {
    seedDoc({
      docId: "doc1",
      title: "x",
      path: "data/x.html",
      turns: [
        {
          ordinal: 0,
          text: "lonely Herta",
          speakerEntityId: HERTA_PERSON_PRIME,
        },
      ],
    });
    const scenes = extractHertaScenes(h.store, {
      targetEntityId: HERTA_PERSON_PRIME,
      minTurns: 2,
    });
    expect(scenes).toHaveLength(0);
  });

  it("honors limit", () => {
    for (let i = 0; i < 5; i++) {
      seedDoc({
        docId: `doc${i}`,
        title: `Doc ${i}`,
        path: `data/d${i}.html`,
        turns: [
          {
            ordinal: 0,
            text: `Herta ${i}`,
            speakerEntityId: HERTA_PERSON_PRIME,
          },
          { ordinal: 1, text: `r ${i}`, speakerSurface: "x" },
        ],
      });
    }
    const scenes = extractHertaScenes(h.store, {
      targetEntityId: HERTA_PERSON_PRIME,
      limit: 2,
    });
    expect(scenes).toHaveLength(2);
  });

  it("returns empty array when no document contains target speaker", () => {
    seedDoc({
      docId: "doc1",
      title: "x",
      path: "data/x.html",
      turns: [{ ordinal: 0, text: "no herta here", speakerSurface: "三月七" }],
    });
    const scenes = extractHertaScenes(h.store, {
      targetEntityId: HERTA_PERSON_PRIME,
    });
    expect(scenes).toEqual([]);
  });

  it("scene output is JSON-serializable", () => {
    seedDoc({
      docId: "doc1",
      title: "x",
      path: "data/x.html",
      turns: [
        { ordinal: 0, text: "Herta", speakerEntityId: HERTA_PERSON_PRIME },
        { ordinal: 1, text: "other", speakerSurface: "三月七" },
      ],
    });
    const scenes = extractHertaScenes(h.store, {
      targetEntityId: HERTA_PERSON_PRIME,
    });
    const json = JSON.stringify(scenes[0]);
    const parsed = JSON.parse(json);
    expect(parsed.turns).toHaveLength(2);
  });
});
