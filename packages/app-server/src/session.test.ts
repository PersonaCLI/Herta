/**
 * Session lifecycle + subscribeRecord tests (Task 4, v0.3 Slice 2).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalRecord } from "@herta/core";
import type { OpeningChoice } from "@herta/herta";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionImpl, spanEditedFiles } from "./session.js";
import { createSessionHost } from "./session-host.js";
import { makePng } from "./testing/image-fixtures.js";
import {
  STUB_THOUGHT,
  stubChatProvider,
  stubCompletionProvider,
} from "./testing/stub-providers.js";
import type {
  AppServerConfig,
  RecordEvent,
  SessionAgentEvent,
  VoiceCueEvent,
} from "./types.js";

/**
 * A MetaThinkCorpus with every mood-state key present but mapped to the
 * empty string. corpusHasContent() returns false for this, so V2ActorDriver
 * attaches no meta-think preamble — the turn still runs the always-think
 * rhythm (thought, then forced speech; the single-phase path went on
 * 2026-09-03), which the stub actor answers deterministically. The keys
 * mirror MOOD_STATES; an all-empty `{}` would not satisfy
 * `Record<MoodState, string>` under strict mode.
 */
function emptyMetaThinkCorpus(): import("@herta/herta").MetaThinkCorpus {
  const blank = {
    默认: "",
    被烦版: "",
    教学版: "",
    被戳穿版: "",
    任务部署版: "",
    板砖代答版: "",
    被顶嘴版: "",
    倾听版: "",
  };
  return { preThink: { ...blank }, preSpeak: { ...blank } };
}

function mkConfig(): AppServerConfig {
  const root = mkdtempSync(join(tmpdir(), "herta-app-server-session-test-"));
  return {
    workspaceRoot: root,
    transcriptDir: join(root, ".herta", "transcript", "v2"),
    projectMemoryDir: join(root, ".herta", "memory"),
    userMemoryDir: join(root, ".herta", "user-memory"),
    narrativeDir: join(root, ".herta", "narrative"),
    providers: {
      deepseekApiKey: "sk-test",
      actorModel: "deepseek-v4-base",
      backendModel: "deepseek-v4-chat",
      routerModel: "deepseek-v4-flash",
    },
  };
}

// ── Lifecycle tests (no submitText — no real provider needed) ─────────────

describe("Session — createSession + basic record state", () => {
  it("createSession returns a Session with empty record and null overlay", async () => {
    const host = createSessionHost(mkConfig());
    // createSession calls SessionImpl.create which makes real disk calls
    // (buildStaticHertaPrefix etc.) but NOT any network calls until submitText.
    const session = await host.createSession({});
    expect(session.record).toEqual([]);
    expect(session.overlay).toBeNull();
    expect(typeof session.sessionId).toBe("string");
    expect(session.sessionId.length).toBeGreaterThan(0);
    await host.closeActiveSession();
  });

  it("createSession writes a session_meta header to the JSONL on disk", async () => {
    const cfg = mkConfig();
    const host = createSessionHost(cfg);
    const session = await host.createSession({});
    const sessionFile = join(cfg.transcriptDir, `${session.sessionId}.jsonl`);
    expect(existsSync(sessionFile)).toBe(true);
    const firstLine = readFileSync(sessionFile, "utf8").split("\n")[0] ?? "";
    const header = JSON.parse(firstLine) as { _kind: string };
    expect(header._kind).toBe("session_meta");
    await host.closeActiveSession();
  });

  it("creating a second session closes the prior active session", async () => {
    const host = createSessionHost(mkConfig());
    const first = await host.createSession({});
    const second = await host.createSession({});
    expect(host.activeSession).toBe(second);
    expect(first.sessionId).not.toBe(second.sessionId);
    await host.closeActiveSession();
  });

  it("a new host session defaults the backend workspace to the managed sandbox", async () => {
    const cfg = mkConfig();
    const host = createSessionHost(cfg);
    const s = await host.createSession({});
    expect(s.backendWorkspaceIsDefault).toBe(true);
    expect(s.backendWorkspace).toBe(
      join(homedir(), ".herta", "workspaces", s.sessionId),
    );
    await s.close();
  });

  it("createSession({ backendWorkspace }) overrides the default (not default)", async () => {
    const cfg = mkConfig();
    const host = createSessionHost(cfg);
    const s = await host.createSession({ backendWorkspace: cfg.transcriptDir });
    expect(s.backendWorkspace).toBe(cfg.transcriptDir);
    expect(s.backendWorkspaceIsDefault).toBe(false);
    await s.close();
  });
});

// ── Interaction language (slice 4) ─────────────────────────────────────────

describe("Session — interaction language threading (slice 4)", () => {
  /** Parse the persisted seed (herta) block from a new session's JSONL —
   *  written at create, BEFORE playOpening, so no streaming is needed. */
  function persistedSeedText(cfg: AppServerConfig, sessionId: string): string {
    const raw = readFileSync(
      join(cfg.transcriptDir, `${sessionId}.jsonl`),
      "utf8",
    );
    const seed = raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map(
        (l) =>
          JSON.parse(l) as { _kind?: string; kind?: string; text?: string },
      )
      .find((l) => l._kind === undefined && l.kind === "herta");
    return seed?.text ?? "";
  }

  it("createSession({ lang: 'en' }) seeds an opening from the EN bundle", async () => {
    const cfg = mkConfig();
    const host = createSessionHost(cfg);
    const session = await host.createSession({ lang: "en" });
    // Every EN seed contains latin words; no zh seed does (verified over the
    // full compiled corpus) — a robust bundle discriminator.
    expect(persistedSeedText(cfg, session.sessionId)).toMatch(/[A-Za-z]{3,}/);
    await host.closeActiveSession();
  });

  it("createSession defaults to zh (byte-identical pre-slice-4 corpus)", async () => {
    const cfg = mkConfig();
    const host = createSessionHost(cfg);
    const session = await host.createSession({});
    const seed = persistedSeedText(cfg, session.sessionId);
    expect(seed.length).toBeGreaterThan(0);
    expect(seed).not.toMatch(/[A-Za-z]{3,}/);
    await host.closeActiveSession();
  });

  it("an EN session's opening emits NO voice cue (no EN wavs in v1)", async () => {
    const cfg = mkConfig();
    // Real pickOpening (no openingOverride) with lang "en": the picker
    // returns no voiceClipId, so the session must never pair a CN wav.
    const session = await SessionImpl.create({
      sessionId: "en-voice-test",
      workspaceRoot: cfg.workspaceRoot,
      effectiveWorkspace: cfg.workspaceRoot,
      isDefaultWorkspace: false,
      config: cfg,
      lang: "en",
      persister: (await import("@herta/core")).V2RecordPersister.forNewSession({
        sessionId: "en-voice-test",
        workspaceRoot: cfg.workspaceRoot,
        startedAt: new Date(),
        transcriptDir: cfg.transcriptDir,
      }),
      deps: {
        providerOverrides: {
          actor: stubCompletionProvider([]),
          router: stubChatProvider([]),
          title: stubChatProvider([]),
        },
        staticPrefixOverride: { bio: "[test-bio]", env: "", fewShots: [] },
        metaThinkOverride: emptyMetaThinkCorpus(),
        supervisorReferenceOverride: "",
        openingLeadMs: 0,
        // openingOverride deliberately OMITTED → the real EN pick runs.
      },
    });
    const cues: VoiceCueEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeVoice()) cues.push(ev);
    })();
    // EN seeds are long prose — fast-forward the char-by-char reveal instead
    // of streaming it in real time (mirrors the cadence test).
    vi.useFakeTimers();
    const p = session.playOpening();
    await vi.advanceTimersByTimeAsync(300_000);
    await p;
    vi.useRealTimers();
    expect(session.record).toHaveLength(1); // the EN seed still streams in
    await session.close();
    await consumer;
    expect(cues.filter((c) => c.kind === "cue")).toEqual([]);
  });

  it("threads lang into the session-title prompt (EN instructions)", async () => {
    const cfg = mkConfig();
    const captured: string[] = [];
    const { session, cleanup } = await mkStubSession(
      cfg,
      undefined,
      1,
      undefined,
      {
        lang: "en",
        titleProvider: {
          streamChat(frame, _signal) {
            captured.push("stableSystem" in frame ? frame.stableSystem : "");
            return (async function* () {
              yield { type: "text-delta" as const, text: "Session title" };
              yield { type: "finish" as const, reason: "stop" as const };
            })();
          },
        },
      },
    );
    await session.submitText("hello");
    await session.whenTitleSettled();
    expect(captured).toHaveLength(1);
    // EN instruction prose; the zh instruction contains no latin words.
    expect(captured[0]).toMatch(/[A-Za-z]{3,}/);
    await cleanup();
  });
});

// ── subscribeRecord tests (use stubCompletionProvider to avoid network) ────

/**
 * Build a minimal SessionImpl for subscribeRecord tests using stub providers.
 *
 * Each turn is a thought then a speech. The stub answers the thought prompt
 * with STUB_THOUGHT and the speech prompt with one script ("你好。（/我 说）"),
 * so a submitText("hi") appends three blocks: user, herta thought, herta
 * speech.
 */
async function mkStubSession(
  cfg: AppServerConfig,
  // When provided, simulates a RESUMED session loaded with this record (the
  // factory loads it instead of picking an opening seed). Used by D2 tests.
  initialRecord?: TerminalRecord,
  // How many turns the stubs can serve (one actor + one router script each).
  // Defaults to 1; rewind-then-resubmit tests pass 2.
  turns = 1,
  // Opening-related dep overrides (wav-matched cadence tests): force a specific
  // opening and/or inject its clip duration instead of reading a wav from disk.
  openingDeps?: {
    openingOverride?: OpeningChoice;
    openingDurationMs?: number | null;
  },
  // Extra knobs for particle-voice tests: the speech the stub actor emits, and
  // a deterministic random source for the particle variant pick.
  extra?: {
    actorSpeech?: string;
    particleRandom?: () => number;
    easterEggRandom?: () => number;
    easterEggNow?: () => number;
    // Live DeepSeek key getter (no-key onboarding tests). Defaults to the
    // config's static key when omitted.
    deepSeekKey?: () => string;
    // Interaction language (slice 4 threading tests). Defaults to zh.
    lang?: "zh" | "en";
    // Title-provider override (slice 4: capture the title prompt's language).
    titleProvider?: import("@herta/core").ProviderAdapter;
  },
): Promise<{
  session: SessionImpl;
  cleanup: () => Promise<void>;
}> {
  const { V2RecordPersister } = await import("@herta/core");
  const { randomUUID } = await import("node:crypto");
  const sessionId = randomUUID();

  const persister = V2RecordPersister.forNewSession({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    startedAt: new Date(),
    transcriptDir: cfg.transcriptDir,
  });

  // Stub actor: one script per turn = that turn's speech. The prompt carries
  // the open tag, so a script is just the body plus its close tag; the
  // thought prompt preceding each speech is auto-answered (not scripted).
  const actorStub = stubCompletionProvider(
    Array.from({ length: turns }, () => ({
      deltas: [extra?.actorSpeech ?? "你好。", "（/我 说）"],
      stopReason: "stop" as const,
    })),
  );

  // Stub router (chat-mode): the V2ActorDriver calls classifyIntent once per
  // turn. The resolved state only selects a meta-think preamble, and the
  // empty corpus has none; the router just needs to return a benign,
  // recognizable state name without throwing.
  const stubRouter = stubChatProvider(
    Array.from({ length: turns }, () => ({
      events: [
        { type: "text-delta", text: "默认" },
        { type: "finish", reason: "stop" },
      ],
    })),
  );

  const session = await SessionImpl.create({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    effectiveWorkspace: cfg.workspaceRoot,
    isDefaultWorkspace: false,
    config: cfg,
    persister,
    ...(extra?.deepSeekKey !== undefined
      ? { deepSeekKey: extra.deepSeekKey }
      : {}),
    ...(extra?.lang !== undefined ? { lang: extra.lang } : {}),
    ...(initialRecord !== undefined ? { initialRecord } : {}),
    deps: {
      providerOverrides: {
        actor: actorStub,
        router: stubRouter,
        // No network in tests: without a title override, a successful turn's
        // fire-and-forget title generation makes a REAL DeepSeek call. The
        // empty stub throws on call; title gen is best-effort → title null.
        title: extra?.titleProvider ?? stubChatProvider([]),
      },
      staticPrefixOverride: { bio: "[test-bio]", env: "", fewShots: [] },
      metaThinkOverride: emptyMetaThinkCorpus(),
      supervisorReferenceOverride: "",
      // D3: skip the opening-stream lead beat so playOpening tests don't each
      // sleep ~1s of real time. The lead is verified separately at the driver
      // level with fake timers.
      openingLeadMs: 0,
      // Default NO opening (M-prompts-1): pickOpening now draws from the
      // COMPILED corpus, so an unseeded tmp workspace no longer implies
      // "no opening" — stub tests must opt out explicitly. D3 opening
      // tests pass a deterministic OpeningChoice instead.
      openingOverride: openingDeps?.openingOverride ?? null,
      ...(openingDeps?.openingDurationMs !== undefined
        ? { openingDurationMs: openingDeps.openingDurationMs }
        : {}),
      ...(extra?.particleRandom !== undefined
        ? { particleRandom: extra.particleRandom }
        : {}),
      ...(extra?.easterEggRandom !== undefined
        ? { easterEggRandom: extra.easterEggRandom }
        : {}),
      ...(extra?.easterEggNow !== undefined
        ? { easterEggNow: extra.easterEggNow }
        : {}),
    },
  });

  return {
    session,
    cleanup: () => session.close(),
  };
}

/** Deterministic opening for the D3 streaming-opening tests — injected via
 *  `openingOverride` (the corpus is compiled since M-prompts-1, so tests no
 *  longer write opening files into the tmp workspace). */
const TEST_OPENING: OpeningChoice = {
  preamble: "黑塔的工作室，午后。",
  seedText: "你来了。",
  sourceFile: "001-neutral-test.txt",
  band: "neutral",
  // Slice 4: the session keys the voice cue on THIS field (never derives a
  // stem from sourceFile) — a zh opening carries its filename stem.
  voiceClipId: "001-neutral-test",
};

/** Write a particle catalog with 嗯/{01,02}.opus so loadParticleCatalog finds it. */
function writeTestParticle(cfg: AppServerConfig): void {
  const dir = join(cfg.workspaceRoot, "data", "voice", "particle", "嗯");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "01.opus"), "x");
  writeFileSync(join(dir, "02.opus"), "x");
}

/** Write one easter-egg clip so loadClipStems finds it (stem returned below). */
const EASTER_EGG_STEM = "你动它干什么";
function writeTestEasterEgg(cfg: AppServerConfig): void {
  const dir = join(cfg.workspaceRoot, "data", "voice", "easter_egg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${EASTER_EGG_STEM}.opus`), "x");
}

describe("Session — D3 streaming opening (new sessions)", () => {
  it("defers the opening seed from the snapshot and streams it in via playOpening", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg, undefined, 1, {
      openingOverride: TEST_OPENING,
    });
    // D3: the seed is deferred — the onReset snapshot is EMPTY so the renderer
    // streams it in rather than showing it instantly.
    expect(session.record).toEqual([]);

    // Subscribe BEFORE playOpening so we observe the seed settle on the record
    // stream (the renderer resolves its streaming bubble to this block).
    const blocks: Extract<RecordEvent, { kind: "block" }>["block"][] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeRecord()) {
        if (ev.kind === "block") {
          blocks.push(ev.block);
          break; // exactly one: the seed settle
        }
      }
    })();
    await session.playOpening();
    await consumer;

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: "herta",
      surface: "speech",
      text: "你来了。",
    });
    // Committed as block 0 so subsequent turns carry the opening in context.
    expect(session.record).toHaveLength(1);
    expect(session.record[0]).toMatchObject({
      kind: "herta",
      text: "你来了。",
    });
    await cleanup();
  });

  it("does not re-stream the opening seed on the first turn (after playOpening commits it)", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg, undefined, 1, {
      openingOverride: TEST_OPENING,
    });
    await session.playOpening();
    expect(session.record).toHaveLength(1); // seed committed as block 0

    const blocks: Extract<RecordEvent, { kind: "block" }>["block"][] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeRecord()) {
        if (ev.kind === "block") {
          blocks.push(ev.block);
          if (blocks.length >= 3) break; // user + thought + speech this turn
        }
      }
    })();
    await session.submitText("hi");
    await consumer;

    // The first turn streams ONLY its new blocks (user + thought + speech);
    // the seed at block 0 is never re-streamed (the sink's cursor is past it).
    expect(blocks.map((b) => ({ ...b, at: undefined }))).toEqual(
      session.record.slice(1),
    );
    expect(
      blocks.some((b) => b.kind === "herta" && b.text === "你来了。"),
    ).toBe(false);
    expect(blocks.every((b) => typeof b.at === "string")).toBe(true);
    await cleanup();
  });

  it("persists the seed at create (durable) and playOpening does not re-persist it", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg, undefined, 1, {
      openingOverride: TEST_OPENING,
    });
    const sessionFile = join(cfg.transcriptDir, `${session.sessionId}.jsonl`);
    const seedLines = (raw: string): number =>
      raw.split("\n").filter((l) => l.includes("你来了。")).length;

    // On disk at create — BEFORE it streams — so a mid-stream close never loses
    // it (on resume it loads as block 0 = instant history).
    expect(seedLines(readFileSync(sessionFile, "utf8"))).toBe(1);
    await session.playOpening();
    // Still exactly one: playOpening settles without re-writing (commitOpeningSeed
    // skips the persist hook).
    expect(seedLines(readFileSync(sessionFile, "utf8"))).toBe(1);
    await cleanup();
  });

  it("playOpening is a no-op for a resumed session (no deferred seed)", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg, [
      { kind: "herta", surface: "speech", text: "历史开场白" },
      { kind: "user", text: "在吗" },
      { kind: "herta", surface: "speech", text: "在。" },
    ]);
    const before = session.record;
    await session.playOpening();
    // Unchanged — resumed sessions carry their opening in the loaded record.
    expect(session.record).toEqual(before);
    await cleanup();
  });

  it("playOpening emits a voice cue for the opening's clip", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg, undefined, 1, {
      openingOverride: TEST_OPENING, // sourceFile 001-neutral-test.txt
    });
    const cues: VoiceCueEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeVoice()) {
        cues.push(ev);
        if (ev.kind === "cue") break;
      }
    })();
    await session.playOpening();
    await consumer;
    // clipId = the opening's voiceClipId (slice 4 — no longer derived from
    // sourceFile); category routes it to openings/<id>.opus.
    expect(cues).toContainEqual({
      kind: "cue",
      category: "openings",
      clipId: "001-neutral-test",
    });
    await cleanup();
  });

  it("playOpening emits NO voice cue when the opening carries no voiceClipId (slice 4)", async () => {
    const cfg = mkConfig();
    // An EN-style opening: text but NO voice pairing (no EN wavs in v1).
    const { session, cleanup } = await mkStubSession(cfg, undefined, 1, {
      openingOverride: {
        preamble: "Herta's workshop, afternoon.",
        seedText: "You're here.",
        sourceFile: "001-neutral-test.txt",
        band: "neutral",
      },
    });
    const cues: VoiceCueEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeVoice()) cues.push(ev);
    })();
    await session.playOpening();
    expect(session.record).toHaveLength(1); // the seed still streams + commits
    await cleanup();
    await consumer;
    expect(cues.filter((c) => c.kind === "cue")).toEqual([]);
  });

  it("playOpening emits no voice cue when there is no opening", async () => {
    const cfg = mkConfig(); // helper defaults openingOverride: null → no opening
    const { session, cleanup } = await mkStubSession(cfg);
    const cues: VoiceCueEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeVoice()) cues.push(ev);
    })();
    await session.playOpening(); // no-op (no deferred seed)
    // Give the (empty) stream a tick; then tear down to end the consumer.
    await cleanup();
    await consumer;
    expect(cues.filter((c) => c.kind === "cue")).toEqual([]);
  });

  it("matches the opening reveal cadence to the clip's duration", async () => {
    const cfg = mkConfig();
    // 3-char seed (no punctuation) over a 1500ms clip → base 500ms/char.
    const { session, cleanup } = await mkStubSession(cfg, undefined, 1, {
      openingOverride: {
        preamble: "黑塔的工作室。",
        seedText: "你来了",
        sourceFile: join(
          cfg.workspaceRoot,
          ".herta/narrative/openings/001-test.txt",
        ),
        band: "neutral",
      },
      openingDurationMs: 1500,
    });
    const deltas: string[] = [];
    const consumer = (async () => {
      for await (const e of session.subscribeAgentEvents()) {
        if (e.kind === "agent" && e.event.type === "assistant.delta") {
          deltas.push(e.event.text);
        }
      }
    })();

    vi.useFakeTimers();
    const p = session.playOpening();
    // At 100ms a default 80ms cadence would already have emitted the first
    // char; the wav-matched 500ms base means nothing has streamed yet.
    await vi.advanceTimersByTimeAsync(100);
    expect(deltas.join("")).toBe("");
    // First char lands at the matched base (~500ms).
    await vi.advanceTimersByTimeAsync(400);
    expect(deltas.join("")).toBe("你");
    // Drain the rest and settle.
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(deltas.join("")).toBe("你来了");
    vi.useRealTimers();
    await cleanup();
    await consumer;
  });

  it("plays a particle cue when the turn's first speech begins with a particle", async () => {
    const cfg = mkConfig(); // no opening → no opening cue to interfere
    writeTestParticle(cfg); // 嗯/{01,02}.opus
    const { session, cleanup } = await mkStubSession(
      cfg,
      undefined,
      1,
      undefined,
      {
        actorSpeech: "嗯，你来了。",
        particleRandom: () => 0, // → "01"
      },
    );
    const cues: VoiceCueEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeVoice()) {
        cues.push(ev);
        if (ev.kind === "cue") break;
      }
    })();
    await session.submitText("hi");
    await consumer;
    expect(cues).toContainEqual({
      kind: "cue",
      category: "particle/嗯",
      clipId: "01",
    });
    await cleanup();
  });

  it("plays no particle cue when the particle is not at the start of the speech", async () => {
    const cfg = mkConfig();
    writeTestParticle(cfg);
    const { session, cleanup } = await mkStubSession(
      cfg,
      undefined,
      1,
      undefined,
      {
        actorSpeech: "你来了，嗯。", // particle mid-line → no match
        particleRandom: () => 0,
      },
    );
    const cues: VoiceCueEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeVoice()) cues.push(ev);
    })();
    await session.submitText("hi");
    await cleanup();
    await consumer;
    expect(cues.filter((c) => c.kind === "cue")).toEqual([]);
  });

  it("maybePlayEasterEgg plays a cue on a low roll outside the cooldown", async () => {
    const cfg = mkConfig();
    writeTestEasterEgg(cfg);
    const { session, cleanup } = await mkStubSession(
      cfg,
      undefined,
      1,
      undefined,
      { easterEggRandom: () => 0.4, easterEggNow: () => 5_000_000 }, // <0.5 → plays
    );
    const cues: VoiceCueEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeVoice()) cues.push(ev);
    })();
    session.maybePlayEasterEgg();
    await cleanup();
    await consumer;
    expect(cues).toContainEqual({
      kind: "cue",
      category: "easter_egg",
      clipId: EASTER_EGG_STEM,
    });
  });

  it("maybePlayEasterEgg does not play on a high roll", async () => {
    const cfg = mkConfig();
    writeTestEasterEgg(cfg);
    const { session, cleanup } = await mkStubSession(
      cfg,
      undefined,
      1,
      undefined,
      { easterEggRandom: () => 0.6, easterEggNow: () => 5_000_000 }, // ≥0.5 → skip
    );
    const cues: VoiceCueEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeVoice()) cues.push(ev);
    })();
    session.maybePlayEasterEgg();
    await cleanup();
    await consumer;
    expect(cues.filter((c) => c.kind === "cue")).toEqual([]);
  });

  it("maybePlayEasterEgg throttles to at most one play per hour", async () => {
    const cfg = mkConfig();
    writeTestEasterEgg(cfg);
    let now = 5_000_000;
    const { session, cleanup } = await mkStubSession(
      cfg,
      undefined,
      1,
      undefined,
      { easterEggRandom: () => 0.4, easterEggNow: () => now }, // always passes 50%
    );
    const cues: VoiceCueEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeVoice()) cues.push(ev);
    })();
    session.maybePlayEasterEgg(); // plays
    now += 30 * 60 * 1000; // +30min — within cooldown
    session.maybePlayEasterEgg(); // skipped
    now += 31 * 60 * 1000; // +61min total — cooldown elapsed
    session.maybePlayEasterEgg(); // plays again
    await cleanup();
    await consumer;
    expect(cues.filter((c) => c.kind === "cue")).toHaveLength(2);
  });

  it("maybePlayEasterEgg does nothing when there are no easter-egg clips", async () => {
    const cfg = mkConfig(); // no writeTestEasterEgg
    const { session, cleanup } = await mkStubSession(
      cfg,
      undefined,
      1,
      undefined,
      { easterEggRandom: () => 0, easterEggNow: () => 5_000_000 },
    );
    const cues: VoiceCueEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeVoice()) cues.push(ev);
    })();
    session.maybePlayEasterEgg();
    await cleanup();
    await consumer;
    expect(cues.filter((c) => c.kind === "cue")).toEqual([]);
  });

  it("an EN session plays NO easter-egg cue even with a clip on disk (no EN voice v1)", async () => {
    // Adversarial review 2026-07-15: the easter-egg clips (all Chinese wavs)
    // were loaded regardless of interaction language, so an EN session played
    // Chinese audio on a 板砖-card lift. create() now skips the clip load for
    // non-zh, so maybePlayEasterEgg no-ops even on a guaranteed-play roll.
    const cfg = mkConfig();
    writeTestEasterEgg(cfg); // a (Chinese) easter-egg wav sits on disk
    const { session, cleanup } = await mkStubSession(
      cfg,
      undefined,
      1,
      undefined,
      {
        lang: "en",
        easterEggRandom: () => 0, // would always pass the 50% gate
        easterEggNow: () => 5_000_000,
      },
    );
    const cues: VoiceCueEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeVoice()) cues.push(ev);
    })();
    session.maybePlayEasterEgg();
    await cleanup();
    await consumer;
    expect(cues.filter((c) => c.kind === "cue")).toEqual([]);
  });

  it("rejects a second turn while one is in flight (single-turn invariant)", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);
    // First turn starts and sets currentTurn synchronously (before its first
    // await), so a concurrent submit must reject rather than run a second turn
    // on the single-threaded driver. Guards playOpening/regenerate too — all
    // three share the currentTurn check (the renderer lock does not gate the
    // main-process open/create entry points).
    const first = session.submitText("hi");
    await expect(session.submitText("again")).rejects.toThrow(
      "a turn is already in progress",
    );
    await first;
    await cleanup();
  });
});

describe("Session — D2 resume regenerate (orphaned reply recovery)", () => {
  it("regenerates and streams the reply for a session ending on an orphaned user message", async () => {
    const cfg = mkConfig();
    // A resumed session whose reply was lost mid-stream: loaded record ends with
    // a user message and no following Herta block.
    const { session, cleanup } = await mkStubSession(cfg, [
      { kind: "herta", surface: "speech", text: "你来了。" },
      { kind: "user", text: "在吗" },
    ]);
    expect(session.record).toHaveLength(2); // pre-regenerate: seed + orphan

    const blocks: Extract<RecordEvent, { kind: "block" }>["block"][] = [];
    const recordConsumer = (async () => {
      for await (const ev of session.subscribeRecord()) {
        if (ev.kind === "block") {
          blocks.push(ev.block);
          // Exactly two new blocks: the regenerated reply's thought + speech.
          if (blocks.length >= 2) break;
        }
      }
    })();
    const lifecycle: string[] = [];
    const lifeConsumer = (async () => {
      for await (const ev of session.subscribeTurnLifecycle()) {
        lifecycle.push(ev.kind);
        if (ev.kind === "finished" || ev.kind === "failed") break;
      }
    })();

    await session.regenerateLastReplyIfOrphaned();
    await recordConsumer;
    await lifeConsumer;

    // Only the regenerated reply streamed — the already-shown seed + user block
    // are NOT re-streamed (the sink's seeded cursor skips them).
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      kind: "herta",
      surface: "thought",
      text: STUB_THOUGHT,
    });
    expect(blocks[1]).toMatchObject({
      kind: "herta",
      surface: "speech",
      text: "你好。",
    });
    // It ran as a turn (locks the composer via lifecycle): started → finished.
    expect(lifecycle).toEqual(["started", "finished"]);
    // Final record: seed + the intact user block + the regenerated reply
    // (its thought, then its speech).
    expect(session.record).toHaveLength(4);
    expect(session.record[1]).toEqual({ kind: "user", text: "在吗" });
    expect(session.record[2]).toMatchObject({
      kind: "herta",
      surface: "thought",
    });
    expect(session.record[3]).toMatchObject({ kind: "herta", text: "你好。" });
    await cleanup();
  });

  it("is a no-op when the resumed session ends on a Herta reply", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg, [
      { kind: "user", text: "在吗" },
      { kind: "herta", surface: "speech", text: "在。" },
    ]);
    await session.regenerateLastReplyIfOrphaned();
    // No turn ran, no new block.
    expect(session.record).toHaveLength(2);
    expect(session.record[1]).toMatchObject({ kind: "herta", text: "在。" });
    await cleanup();
  });
});

describe("Session — subscribeRecord (single-subscriber)", () => {
  it("runs a turn through V2ActorDriver and broadcasts the new blocks", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);
    const events: RecordEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeRecord()) {
        events.push(ev);
        if (events.length >= 3) break; // user + thought + speech
      }
    })();
    await session.submitText("hi");
    await consumer;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({ kind: "block" });
    await cleanup();
  });

  it("emits block events for each block appended by submitText", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);

    const events: RecordEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeRecord()) {
        events.push(ev);
        // user block + herta thought + herta speech = 3 blocks
        if (events.length >= 3) break;
      }
    })();

    await session.submitText("hi");
    await consumer;

    // One block event per appended block, in record order — the thought is
    // broadcast like any other block (the GUI hides it; the sink does not).
    expect(
      events.map((e) =>
        e.kind === "block" ? { ...e.block, at: undefined } : e,
      ),
    ).toEqual([
      { kind: "user", text: "hi", at: undefined },
      { kind: "herta", surface: "thought", text: STUB_THOUGHT, at: undefined },
      { kind: "herta", surface: "speech", text: "你好。", at: undefined },
    ]);
    await cleanup();
  });

  it("persists every committed block to the JSONL by the time submitText resolves", async () => {
    // With the canonical-diff sink (2026-06-01), blocks are broadcast live
    // DURING the turn via BusActorStreamingSink.flushBlocks, and persisted
    // AFTER runActorCompletionTurn returns (inside the driver's runTurn loop).
    // The old "persist-before-broadcast" ordering no longer holds at the
    // per-block level, but the per-TURN invariant does: by the time
    // submitText resolves, all blocks are on disk. This test verifies that
    // contract: after submitText returns, the JSONL has header + all blocks.
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);

    const sessionFile = join(cfg.transcriptDir, `${session.sessionId}.jsonl`);

    const consumer = (async () => {
      for await (const ev of session.subscribeRecord()) {
        if (ev.kind === "block") break;
      }
    })();

    await session.submitText("hi");
    await consumer;

    // After submitText resolves, all blocks must be on disk: the user block,
    // the thought, and the speech (meta lines such as `turn_end` sit between
    // them and are not counted).
    const jsonl = readFileSync(sessionFile, "utf8");
    const lines = jsonl.split("\n").filter((l) => l.length > 0);
    const header = JSON.parse(lines[0] ?? "{}") as { _kind?: string };
    expect(header._kind).toBe("session_meta");
    const blocks = lines
      .map((l) => JSON.parse(l) as { _kind?: string; kind?: string })
      .filter((o) => o._kind === undefined);
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "herta", "herta"]);
    await cleanup();
  });
});

// ── setWorkspace / resetWorkspace tests ───────────────────────────────────────

describe("Session — setWorkspace / resetWorkspace", () => {
  it("setWorkspace updates the effective workspace and emits a workspace event", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);
    const got = (async () => {
      for await (const ev of session.subscribeWorkspace()) {
        if (ev.kind === "workspace") return ev;
      }
      return null;
    })();
    await session.setWorkspace(cfg.transcriptDir);
    const ev = await got;
    expect(ev?.kind).toBe("workspace");
    if (ev?.kind === "workspace") {
      expect(ev.workspace).toBe(cfg.transcriptDir);
      expect(ev.isDefault).toBe(false);
    }
    expect(session.backendWorkspace).toBe(cfg.transcriptDir);
    await cleanup();
  });

  it("resetWorkspace restores the managed default + flags isDefault", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);
    await session.setWorkspace(cfg.transcriptDir);
    await session.resetWorkspace();
    expect(session.backendWorkspaceIsDefault).toBe(true);
    await cleanup();
  });

  it("setWorkspace records a → 系统 note in the record", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);
    const got = (async () => {
      for await (const ev of session.subscribeRecord()) {
        if (
          ev.kind === "block" &&
          ev.block.kind === "system" &&
          ev.block.body.includes("workspace →")
        ) {
          return ev.block;
        }
      }
      return null;
    })();
    await session.setWorkspace(cfg.transcriptDir);
    const block = await got;
    expect(block).not.toBeNull();
    expect(block?.kind).toBe("system");
    if (block?.kind === "system") {
      expect(block.label).toBe("系统");
      expect(block.body).toContain("workspace →");
      expect(block.body).toContain(cfg.transcriptDir);
    }
    // The note is also on the synchronous snapshot.
    expect(
      session.record.some(
        (b) => b.kind === "system" && b.body.includes("workspace →"),
      ),
    ).toBe(true);
    await cleanup();
  });

  it("resetWorkspace records a → 系统 note in the record", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);
    await session.setWorkspace(cfg.transcriptDir);
    await session.resetWorkspace();
    const notes = session.record.filter(
      (b) => b.kind === "system" && b.body.includes("workspace →"),
    );
    // One for the set, one for the reset.
    expect(notes.length).toBe(2);
    expect(notes[notes.length - 1]).toMatchObject({
      kind: "system",
      label: "系统",
    });
    await cleanup();
  });
});

// ── noop-marker live-stream test ──────────────────────────────────────────────

/**
 * Build a SessionImpl for a NO-OP `@板砖` turn.
 *
 * Actor (completion) provider — two scripted speeches (the thought before
 * each one is auto-answered by the stub, so the record carries a thought
 * block ahead of both):
 *   Speech 1: Herta's first speech contains @板砖, triggering the bridge.
 *   Speech 2: After the bridge completes, Herta emits a closing speech.
 *
 * Backend (chat) provider — one scripted turn that emits TEXT ONLY (no tool
 * calls). With no tool/patch work the bridge projects zero `→ 系统` /
 * `→ 差分协处理器` blocks (`projectedAny` stays false), so it appends the
 * `无产出` terminal block with `role: "noop-marker"` instead of a done-marker.
 *
 * The injection seam: `deps.providerOverrides.backend` flows into the real
 * `CodingAgentRuntime` the session's `runtimeFactory` constructs, so stubbing
 * the backend chat provider with a no-tool-call response is enough to drive a
 * true no-op delegation without any custom runtime wiring.
 */
async function mkNoopBanzhuanSession(cfg: AppServerConfig): Promise<{
  session: SessionImpl;
  cleanup: () => Promise<void>;
}> {
  const { V2RecordPersister } = await import("@herta/core");
  const { randomUUID } = await import("node:crypto");
  const sessionId = randomUUID();

  const persister = V2RecordPersister.forNewSession({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    startedAt: new Date(),
    transcriptDir: cfg.transcriptDir,
  });

  const actorStub = stubCompletionProvider([
    {
      // Speech 1: Herta delegates to 板砖.
      deltas: ["@板砖 看看公开资料就行。（/我 说）"],
      stopReason: "stop",
    },
    {
      // Speech 2: Main-loop closing speech after the bridge completes.
      deltas: ["行，没什么要动的。（/我 说）"],
      stopReason: "stop",
    },
  ]);

  // Backend: a single text-only turn — no tool calls → no projected work.
  const backendStub = stubChatProvider([
    {
      events: [
        { type: "text-delta", text: "Nothing to do here." },
        { type: "finish", reason: "stop" },
      ],
    },
  ]);

  // Empty meta-think corpus + empty supervisor reference: no preamble, no
  // supervisor pass — the stubs count exact provider calls.
  const stubRouter = stubChatProvider([
    {
      events: [
        { type: "text-delta", text: "默认" },
        { type: "finish", reason: "stop" },
      ],
    },
  ]);

  const session = await SessionImpl.create({
    sessionId,
    workspaceRoot: cfg.workspaceRoot,
    effectiveWorkspace: cfg.workspaceRoot,
    isDefaultWorkspace: false,
    config: cfg,
    persister,
    deps: {
      providerOverrides: {
        actor: actorStub,
        backend: backendStub,
        router: stubRouter,
        // No network in tests — see mkStubSession's title note.
        title: stubChatProvider([]),
      },
      staticPrefixOverride: { bio: "[test-bio]", env: "", fewShots: [] },
      metaThinkOverride: emptyMetaThinkCorpus(),
      supervisorReferenceOverride: "",
      openingOverride: null,
    },
  });

  return {
    session,
    cleanup: () => session.close(),
  };
}

describe("Session — noop-marker reaches the live record stream", () => {
  it("emits a role:'noop-marker' block on subscribeRecord for a no-op @板砖 turn", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkNoopBanzhuanSession(cfg);

    // The noop-marker is synthesized off-bus by the bridge (it rides the
    // actor turn's return value). It reaches record subscribers via the
    // bridge's flushBlocks(current) call after appending the marker — the
    // single canonical-diff path through BusActorStreamingSink. This test
    // fails if the marker stops reaching the live stream.
    const blocks: RecordEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeRecord()) {
        blocks.push(ev);
        // user + thought + herta(@板砖) + noop-marker + thought +
        // herta(closing) = 6 blocks.
        if (blocks.length >= 6) break;
      }
    })();

    await session.submitText("看看公开资料");
    await consumer;

    const noopMarkers = blocks.filter(
      (e): e is Extract<RecordEvent, { kind: "block" }> =>
        e.kind === "block" &&
        e.block.kind === "system" &&
        (e.block as { role?: string }).role === "noop-marker",
    );
    expect(noopMarkers).toHaveLength(1);
    const marker = noopMarkers[0]?.block as {
      label: string;
      body: string;
      role: string;
    };
    expect(marker.label).toBe("差分协处理器");
    expect(marker.role).toBe("noop-marker");
    expect(marker.body.startsWith("无产出")).toBe(true);

    await cleanup();
  }, 15_000);
});

// ── Actor streaming delta tests ───────────────────────────────────────────────

describe("Session — actor assistant.delta reaches the agent stream", () => {
  it("publishes actor-layer assistant.delta events on subscribeAgentEvents during submitText", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);

    const seen: SessionAgentEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeAgentEvents()) {
        seen.push(ev);
      }
    })();

    await session.submitText("hi");
    await cleanup(); // closes the projector → ends the agent stream → consumer resolves
    await consumer;

    const actorDeltas = seen.filter(
      (
        e,
      ): e is {
        kind: "agent";
        event: { type: "assistant.delta"; layer: "actor"; text: string };
      } =>
        e.kind === "agent" &&
        e.event.type === "assistant.delta" &&
        (e.event as { layer?: string }).layer === "actor",
    );
    expect(actorDeltas.length).toBeGreaterThanOrEqual(1);
    const streamed = actorDeltas.map((e) => e.event.text).join("");
    expect(streamed).toContain("你好");
    // Thought-surface tokens never reach the agent stream (hidden per D6/D7):
    // the sink drops them, so only the speech is in the streaming bubble.
    expect(streamed).not.toContain(STUB_THOUGHT);
  });
});

// ── Prompt dump (HERTA_DUMP_PROMPTS) ──────────────────────────────────────────

describe("Session — prompt dump (HERTA_DUMP_PROMPTS)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("writes turn prompt files to <sessionId>.prompts when HERTA_DUMP_PROMPTS is set", async () => {
    vi.stubEnv("HERTA_DUMP_PROMPTS", "1");
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);
    await session.submitText("hi");
    const promptsDir = join(cfg.transcriptDir, `${session.sessionId}.prompts`);
    expect(existsSync(promptsDir)).toBe(true);
    const files = readdirSync(promptsDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.some((f) => /^turn-\d{3}-.*\.txt$/.test(f))).toBe(true);
    await cleanup();
  });

  it("does NOT create a prompts dir when HERTA_DUMP_PROMPTS is unset", async () => {
    vi.stubEnv("HERTA_DUMP_PROMPTS", undefined);
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);
    await session.submitText("hi");
    const promptsDir = join(cfg.transcriptDir, `${session.sessionId}.prompts`);
    expect(existsSync(promptsDir)).toBe(false);
    await cleanup();
  });
});

describe("Session — rewindLastTurn", () => {
  it("withdraws the last user turn, returns the user text, empties the record", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);
    await session.submitText("在吗");
    expect(session.record).toHaveLength(3); // user + thought + speech
    const result = await session.rewindLastTurn();
    expect(result).toEqual({ ok: true, userText: "在吗", editedFiles: false });
    expect(session.record).toEqual([]);
    await cleanup();
  });

  it("returns no_user_turn when there is nothing to rewind", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);
    const result = await session.rewindLastTurn();
    expect(result).toEqual({ ok: false, reason: "no_user_turn" });
    await cleanup();
  });

  it("truncates the persisted JSONL back to the header", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);
    await session.submitText("在吗");
    const sessionFile = join(cfg.transcriptDir, `${session.sessionId}.jsonl`);
    // Count BLOCK lines, not raw lines: meta lines (`workspace_set`,
    // `turn_end`) legitimately sit between blocks and must not make this
    // assertion brittle — it is about what the rewind withdraws.
    const blockCount = (): number =>
      readFileSync(sessionFile, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .filter(
          (l) => (JSON.parse(l) as { _kind?: string })._kind === undefined,
        ).length;
    expect(blockCount()).toBe(3); // user + thought + speech
    await session.rewindLastTurn();
    expect(blockCount()).toBe(0); // header only remains
    await cleanup();
  });

  it("emits a reset RecordEvent carrying the truncated record", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg);
    await session.submitText("在吗");
    const seen: RecordEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeRecord()) {
        seen.push(ev);
        if (ev.kind === "reset") break;
      }
    })();
    await session.rewindLastTurn();
    await consumer;
    const reset = seen.find((e) => e.kind === "reset");
    expect(reset?.kind).toBe("reset");
    if (reset?.kind === "reset") expect(reset.record).toEqual([]);
    await cleanup();
  });

  it("keeps a prior turn intact when rewinding a later one (multi-turn)", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg, [
      { kind: "user", text: "u1" },
      { kind: "herta", surface: "speech", text: "h1" },
      { kind: "user", text: "u2" },
      { kind: "herta", surface: "speech", text: "h2" },
    ]);
    const result = await session.rewindLastTurn();
    expect(result).toEqual({ ok: true, userText: "u2", editedFiles: false });
    expect(session.record).toEqual([
      { kind: "user", text: "u1" },
      { kind: "herta", surface: "speech", text: "h1" },
    ]);
    await cleanup();
  });

  it("rewind then a NEW turn persists cleanly (sink cursor reset; no off-by-one / dup)", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg, undefined, 2);
    await session.submitText("first");
    await session.rewindLastTurn();
    await session.submitText("second");
    // In-memory record is exactly the second turn (first turn fully withdrawn).
    expect(
      session.record.map((b) => ({
        kind: b.kind,
        text: "text" in b ? b.text : "",
      })),
    ).toEqual([
      { kind: "user", text: "second" },
      { kind: "herta", text: STUB_THOUGHT },
      { kind: "herta", text: "你好。" },
    ]);
    // The JSONL holds exactly header + the second turn's three blocks — the
    // first turn's lines were truncated and never re-appended (cursor reset
    // correctly).
    const sessionFile = join(cfg.transcriptDir, `${session.sessionId}.jsonl`);
    const blocks = readFileSync(sessionFile, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((o) => o._kind === undefined);
    expect(blocks.map((b) => b.text)).toEqual([
      "second",
      STUB_THOUGHT,
      "你好。",
    ]);
    await cleanup();
  });

  it("flags editedFiles when the withdrawn span has a 板砖 file-edit done-marker", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(cfg, [
      { kind: "user", text: "改一下登录" },
      { kind: "herta", surface: "speech", text: "@板砖 改" },
      {
        kind: "system",
        label: "差分协处理器",
        body: "完成 · 2 files · tests 1/1",
        role: "done-marker",
        evidenceDetail: "↳ 改动文件: auth.ts, login.ts",
      },
    ]);
    const result = await session.rewindLastTurn();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userText).toBe("改一下登录");
      expect(result.editedFiles).toBe(true);
    }
    await cleanup();
  });
});

describe("spanEditedFiles", () => {
  it("true for a 差分协处理器 done-marker reporting changed files (evidence)", () => {
    expect(
      spanEditedFiles([
        { kind: "user", text: "x" },
        {
          kind: "system",
          label: "差分协处理器",
          body: "完成 · 1 file · tests 1/1",
          role: "done-marker",
          evidenceDetail: "↳ 改动文件: a.ts",
        },
      ]),
    ).toBe(true);
  });

  it("false for a no-op backend marker (no file count)", () => {
    expect(
      spanEditedFiles([
        {
          kind: "system",
          label: "差分协处理器",
          body: "无产出 — 这次没有触发任何文件、目录或命令操作。",
          role: "noop-marker",
        },
      ]),
    ).toBe(false);
  });

  it("false for a plain reply with no backend blocks", () => {
    expect(
      spanEditedFiles([
        { kind: "user", text: "在吗" },
        { kind: "herta", surface: "speech", text: "在。" },
      ]),
    ).toBe(false);
  });
});

describe("Session — no-key onboarding (live DeepSeek key)", () => {
  it("returns needsKey and runs no turn when the live key is empty", async () => {
    const cfg = mkConfig();
    const { session, cleanup } = await mkStubSession(
      cfg,
      undefined,
      1,
      undefined,
      { deepSeekKey: () => "" },
    );
    const before = session.record;
    const result = await session.submitText("hi");
    expect(result).toEqual({ needsKey: true });
    // The pre-check returns before any record mutation — no user/herta block.
    expect(session.record).toEqual(before);
    await cleanup();
  });

  it("consults the live key per submit (empty → set runs the turn)", async () => {
    const cfg = mkConfig();
    let key = "";
    const { session, cleanup } = await mkStubSession(
      cfg,
      undefined,
      1,
      undefined,
      { deepSeekKey: () => key },
    );
    // First send with no key: deferred onboarding, no turn.
    expect(await session.submitText("hi")).toEqual({ needsKey: true });

    // Key set live (no restart, no re-create): the next send runs the turn.
    key = "sk-live";
    const second = await session.submitText("hi");
    expect(second).toHaveProperty("turnId");
    expect(session.record.some((b) => b.kind === "herta")).toBe(true);
    await cleanup();
  });
});

describe("Session — attachFiles (ADR 0033)", () => {
  /** A hermetic attach setup: the default backend workspace lives under the
   *  real homedir, so point the session at a temp dir first — which also
   *  exercises the documented contract that attachments land under the
   *  EFFECTIVE backend workspace, not the record anchor. */
  async function mkAttachSession() {
    const cfg = mkConfig();
    const made = await mkStubSession(cfg);
    const backendWs = mkdtempSync(join(tmpdir(), "herta-attach-ws-"));
    const set = await made.session.setWorkspace(backendWs);
    expect(set.ok).toBe(true);
    const srcDir = mkdtempSync(join(tmpdir(), "herta-attach-src-"));
    return { ...made, cfg, backendWs, srcDir };
  }

  it("ingests files into the backend workspace and appends one block per file", async () => {
    const { session, backendWs, srcDir, cleanup } = await mkAttachSession();
    writeFileSync(join(srcDir, "spec.md"), "# spec\nbody\n");
    writeFileSync(join(srcDir, "notes.txt"), "notes\n");

    const r = await session.attachFiles([
      join(srcDir, "spec.md"),
      join(srcDir, "notes.txt"),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files).toHaveLength(2);

    const attachBlocks = session.record.filter(
      (b) => b.kind === "system" && b.digest?.kind === "attachment",
    );
    expect(attachBlocks).toHaveLength(2);
    // The stored file is really under the EFFECTIVE workspace…
    const rel = r.files[0]?.path ?? "";
    expect(existsSync(join(backendWs, ...rel.split("/")))).toBe(true);
    // …and BL6 holds: the .herta dir self-ignores before any git add -A.
    expect(existsSync(join(backendWs, ".herta", ".gitignore"))).toBe(true);
    await cleanup();
  });

  it("refuses more than the per-action cap outright — no prefix ingested", async () => {
    const { session, srcDir, cleanup } = await mkAttachSession();
    const paths = Array.from({ length: 11 }, (_, i) => {
      const p = join(srcDir, `f${i}.txt`);
      writeFileSync(p, "x\n");
      return p;
    });
    const r = await session.attachFiles(paths);
    expect(r).toEqual({ ok: false, reason: "too_many" });
    expect(
      session.record.some(
        (b) => b.kind === "system" && b.digest?.kind === "attachment",
      ),
    ).toBe(false);
    await cleanup();
  });

  it("caps a MESSAGE at five pictures, counting what is already staged (owner 2026-08-27)", async () => {
    const { session, cleanup } = await mkAttachSession();
    const png = (n: string) => ({ bytes: makePng(4, 4), name: n });
    // Six in one batch: whole-batch refusal, nothing staged (the same
    // no-silent-prefix rule as the attachFiles cap above).
    const six = await session.stageImages(
      Array.from({ length: 6 }, (_, i) => png(`p${i}.png`)),
    );
    expect(six).toEqual({ ok: false, reason: "too_many_images" });
    // Five is fine…
    const five = await session.stageImages(
      Array.from({ length: 5 }, (_, i) => png(`q${i}.png`)),
    );
    expect(five.ok).toBe(true);
    if (five.ok) expect(five.staged).toHaveLength(5);
    // …and the cap counts the strip, not the batch: one more is refused.
    const more = await session.stageImages([png("r.png")]);
    expect(more).toEqual({ ok: false, reason: "too_many_images" });
    // Unstaging frees a slot again.
    if (five.ok) {
      const freed = five.staged[0]?.id ?? "";
      expect(await session.unstageImage(freed)).toBe(true);
      const retry = await session.stageImages([png("r.png")]);
      expect(retry.ok).toBe(true);
    }
    await cleanup();
  });

  it("removeAttachment deletes the file and MARKS the block, keeping the count", async () => {
    const { session, backendWs, srcDir, cleanup } = await mkAttachSession();
    writeFileSync(join(srcDir, "spec.md"), "# spec\nSECRET-BODY-LINE\n");
    const a = await session.attachFiles([join(srcDir, "spec.md")]);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const rel = a.files[0]?.path ?? "";
    const before = session.record.length;
    expect(existsSync(join(backendWs, ...rel.split("/")))).toBe(true);

    const r = await session.removeAttachment(rel);
    expect(r).toEqual({ ok: true, removed: 1 });

    // The file is gone…
    expect(existsSync(join(backendWs, ...rel.split("/")))).toBe(false);
    // …the block count is UNCHANGED (rewind, topic anchors and the sink
    // cursor all index by block position)…
    expect(session.record.length).toBe(before);
    // …and the block now says so, with no prompt-visible body left.
    const block = session.record.find(
      (b) => b.kind === "system" && b.digest?.kind === "attachment",
    );
    if (block?.kind !== "system") throw new Error("no attachment block");
    expect(block.digest).toMatchObject({ unreadable: "removed" });
    expect(block.body).toContain("已移除");
    expect(block.evidenceDetail).toBeUndefined();
    expect(JSON.stringify(session.record)).not.toContain("SECRET-BODY-LINE");
    await cleanup();
  });

  it("a source-only document (no text — an .xlsx) is removed by its SOURCE path, the only path its row has (ADR 0038 amendment)", async () => {
    const { makeOleBytes } = await import("./testing/document-fixtures.js");
    const { session, backendWs, srcDir, cleanup } = await mkAttachSession();
    writeFileSync(join(srcDir, "sheet.xlsx"), makeOleBytes());
    const a = await session.attachFiles([join(srcDir, "sheet.xlsx")]);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.files[0]?.path).toBe("");
    const block = session.record.find(
      (b) => b.kind === "system" && b.digest?.kind === "attachment",
    );
    const digest = block?.kind === "system" ? block.digest : undefined;
    const source = digest?.kind === "attachment" ? (digest.source ?? "") : "";
    expect(source).toMatch(/\/sheet-[0-9a-f]{8}\.xlsx$/);
    expect(existsSync(join(backendWs, ...source.split("/")))).toBe(true);
    // An empty path never matches anything — not even another path-less row.
    expect(await session.removeAttachment("")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await session.removeAttachment(source)).toEqual({
      ok: true,
      removed: 1,
    });
    expect(existsSync(join(backendWs, ...source.split("/")))).toBe(false);
    const after = session.record.find(
      (b) => b.kind === "system" && b.digest?.kind === "attachment",
    );
    if (after?.kind !== "system") throw new Error("no attachment block");
    expect(after.digest).toMatchObject({ unreadable: "removed", path: "" });
    expect(after.digest).not.toHaveProperty("source");
    await cleanup();
  });

  it("removeAttachment takes the outline sidecar with the text and drops its citation from the digest (2026-08-23)", async () => {
    const { makePdf } = await import("./testing/document-fixtures.js");
    const { session, backendWs, srcDir, cleanup } = await mkAttachSession();
    writeFileSync(
      join(srcDir, "book.pdf"),
      makePdf([["one"], ["two"]], {
        bookmarks: [
          { title: "Chapter 1", page: 1 },
          { title: "Chapter 2", page: 2 },
        ],
      }),
    );
    const a = await session.attachFiles([join(srcDir, "book.pdf")]);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const rel = a.files[0]?.path ?? "";
    const block = session.record.find(
      (b) => b.kind === "system" && b.digest?.kind === "attachment",
    );
    const digest = block?.kind === "system" ? block.digest : undefined;
    const sidecar =
      digest?.kind === "attachment" ? (digest.outline?.path ?? "") : "";
    expect(sidecar).toMatch(/\.pdf\.outline\.txt$/);
    expect(existsSync(join(backendWs, ...sidecar.split("/")))).toBe(true);

    // A digest sidecar 板砖 built later (ADR 0043) goes with the text too.
    const digestRel = rel.replace(/\.txt$/, ".digest.txt");
    writeFileSync(join(backendWs, ...digestRel.split("/")), "# 文档摘要\n");

    // …and the original's copy (ADR 0038 amendment) with everything else.
    const source = digest?.kind === "attachment" ? (digest.source ?? "") : "";
    expect(source).toMatch(/\.pdf$/);
    expect(existsSync(join(backendWs, ...source.split("/")))).toBe(true);

    expect(await session.removeAttachment(rel)).toEqual({
      ok: true,
      removed: 1,
    });
    expect(existsSync(join(backendWs, ...rel.split("/")))).toBe(false);
    expect(existsSync(join(backendWs, ...sidecar.split("/")))).toBe(false);
    expect(existsSync(join(backendWs, ...digestRel.split("/")))).toBe(false);
    expect(existsSync(join(backendWs, ...source.split("/")))).toBe(false);
    const after = session.record.find(
      (b) => b.kind === "system" && b.digest?.kind === "attachment",
    );
    if (after?.kind !== "system") throw new Error("no attachment block");
    expect(after.digest).toMatchObject({ unreadable: "removed" });
    expect(after.digest).not.toHaveProperty("outline");
    expect(after.digest).not.toHaveProperty("source");
    expect(JSON.stringify(session.record)).not.toContain("Chapter 2");
    await cleanup();
  });

  it("rewind keeps an attachment whose row sits above the cut (attached before the send)", async () => {
    // The common flow: attach, then send. The attach block precedes the user
    // block, so the rewind's truncation never touches it — and the GC must
    // not either: the row is still on screen, its ✕ still works, and its
    // file must still exist behind both.
    const { session, backendWs, srcDir, cleanup } = await mkAttachSession();
    writeFileSync(join(srcDir, "spec.md"), "# spec\nbody\n");
    const a = await session.attachFiles([join(srcDir, "spec.md")]);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const rel = a.files[0]?.path ?? "";
    await session.submitText("看看这个文件");
    const r = await session.rewindLastTurn();
    expect(r.ok).toBe(true);
    expect(
      session.record.some(
        (b) => b.kind === "system" && b.digest?.kind === "attachment",
      ),
    ).toBe(true);
    expect(existsSync(join(backendWs, ...rel.split("/")))).toBe(true);
    await cleanup();
  });

  it("rewind garbage-collects the stored copies of WITHDRAWN attachment blocks — sidecars included (2026-08-26)", async () => {
    // D-Record-only amendment: an attachment block inside the withdrawn span
    // (attached after the turn's reply, then rewound before the next send)
    // takes its row's ✕ affordance with it — so the stored copy would be
    // orphaned with no in-app way to delete it. The rewind GCs it: text,
    // outline sidecar, and any ADR 0043 digest sidecar, same set as the ✕.
    const { makePdf } = await import("./testing/document-fixtures.js");
    const { session, backendWs, srcDir, cleanup } = await mkAttachSession();
    await session.submitText("hi");
    writeFileSync(
      join(srcDir, "book.pdf"),
      makePdf([["one"], ["two"]], {
        bookmarks: [
          { title: "Chapter 1", page: 1 },
          { title: "Chapter 2", page: 2 },
        ],
      }),
    );
    const a = await session.attachFiles([join(srcDir, "book.pdf")]);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const rel = a.files[0]?.path ?? "";
    const block = session.record.find(
      (b) => b.kind === "system" && b.digest?.kind === "attachment",
    );
    const digest = block?.kind === "system" ? block.digest : undefined;
    const sidecar =
      digest?.kind === "attachment" ? (digest.outline?.path ?? "") : "";
    expect(existsSync(join(backendWs, ...sidecar.split("/")))).toBe(true);
    const digestRel = rel.replace(/\.txt$/, ".digest.txt");
    writeFileSync(join(backendWs, ...digestRel.split("/")), "# 文档摘要\n");

    const r = await session.rewindLastTurn();
    expect(r.ok).toBe(true);
    // The block left the record with the turn…
    expect(
      session.record.some(
        (b) => b.kind === "system" && b.digest?.kind === "attachment",
      ),
    ).toBe(false);
    // …and the stored copies left the disk with it.
    expect(existsSync(join(backendWs, ...rel.split("/")))).toBe(false);
    expect(existsSync(join(backendWs, ...sidecar.split("/")))).toBe(false);
    expect(existsSync(join(backendWs, ...digestRel.split("/")))).toBe(false);
    await cleanup();
  });

  it("rewind RESTAGES the message's pictures instead of deleting them (owner 2026-08-27)", async () => {
    const { session, backendWs, cleanup } = await mkAttachSession();
    const staged = await session.stageImages([
      { bytes: makePng(5, 5), name: "shot.png" },
    ]);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    const rel = staged.staged[0]?.path ?? "";
    await session.submitText("看看这张图", {
      stagedImageIds: staged.staged.map((s) => s.id),
    });
    expect(
      session.record.some(
        (b) => b.kind === "system" && b.digest?.kind === "attachment",
      ),
    ).toBe(true);

    const r = await session.rewindLastTurn();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The block left the record with the turn…
    expect(
      session.record.some(
        (b) => b.kind === "system" && b.digest?.kind === "attachment",
      ),
    ).toBe(false);
    // …but the picture went back to the strip, its file intact: the copy is
    // on disk, the caption is paid for, and the rewound message's pictures
    // belong with its restored draft.
    expect(r.images).toHaveLength(1);
    expect(r.images?.[0]?.path).toBe(rel);
    expect(existsSync(join(backendWs, ...rel.split("/")))).toBe(true);
    expect(session.stagedImageList.map((s) => s.path)).toEqual([rel]);
    await cleanup();
  });

  it("rewind falls back to the GC when the strip is already full (the five-picture cap holds)", async () => {
    const { session, backendWs, cleanup } = await mkAttachSession();
    const one = await session.stageImages([
      { bytes: makePng(5, 5), name: "sent.png" },
    ]);
    if (!one.ok) return;
    const rel = one.staged[0]?.path ?? "";
    await session.submitText("发图", {
      stagedImageIds: one.staged.map((s) => s.id),
    });
    // Fill the strip AFTER the send.
    const five = await session.stageImages(
      Array.from({ length: 5 }, (_, i) => ({
        bytes: makePng(5, 5),
        name: `later${i}.png`,
      })),
    );
    expect(five.ok).toBe(true);

    const r = await session.rewindLastTurn();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // No room: the withdrawn picture is GC'd like a document, not restaged
    // past the cap.
    expect(r.images).toBeUndefined();
    expect(session.stagedImageList).toHaveLength(5);
    expect(existsSync(join(backendWs, ...rel.split("/")))).toBe(false);
    await cleanup();
  });

  it("rewind keeps a stored file a SURVIVING block still cites (idempotent re-attach shares the path)", async () => {
    // Content-hashed names make re-attaching the identical document a write
    // to the SAME stored path — two blocks, one file. Withdrawing the later
    // block must not delete the earlier row's document out from under it.
    const { session, backendWs, srcDir, cleanup } = await mkAttachSession();
    writeFileSync(join(srcDir, "spec.md"), "# spec\nbody\n");
    const first = await session.attachFiles([join(srcDir, "spec.md")]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const rel = first.files[0]?.path ?? "";
    await session.submitText("看看这个文件");
    const again = await session.attachFiles([join(srcDir, "spec.md")]);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.files[0]?.path).toBe(rel);

    const r = await session.rewindLastTurn();
    expect(r.ok).toBe(true);
    // The pre-send block survives, so its file must too.
    expect(
      session.record.some(
        (b) => b.kind === "system" && b.digest?.kind === "attachment",
      ),
    ).toBe(true);
    expect(existsSync(join(backendWs, ...rel.split("/")))).toBe(true);
    await cleanup();
  });

  it("the removal survives a reload — it is on disk, not just in memory", async () => {
    const { session, cfg, srcDir, cleanup } = await mkAttachSession();
    writeFileSync(join(srcDir, "spec.md"), "# spec\nbody\n");
    const a = await session.attachFiles([join(srcDir, "spec.md")]);
    if (!a.ok) return;
    await session.removeAttachment(a.files[0]?.path ?? "");

    const { readSessionFile } = await import("@herta/core");
    const onDisk = readSessionFile(
      join(cfg.transcriptDir, `${session.sessionId}.jsonl`),
    );
    const b = onDisk.record.find(
      (x) => x.kind === "system" && x.digest?.kind === "attachment",
    );
    expect(b?.kind === "system" && b.digest).toMatchObject({
      unreadable: "removed",
    });
    await cleanup();
  });

  it("an unknown path is not_found, and a second removal is idempotent", async () => {
    const { session, srcDir, cleanup } = await mkAttachSession();
    writeFileSync(join(srcDir, "spec.md"), "# spec\n");
    const a = await session.attachFiles([join(srcDir, "spec.md")]);
    if (!a.ok) return;
    const rel = a.files[0]?.path ?? "";

    expect(await session.removeAttachment("nope/missing.md")).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await session.removeAttachment(rel)).toEqual({
      ok: true,
      removed: 1,
    });
    // Already withdrawn — the second call finds nothing left to mark rather
    // than re-marking and re-deleting.
    expect(await session.removeAttachment(rel)).toEqual({
      ok: false,
      reason: "not_found",
    });
    await cleanup();
  });

  it("refuses a path outside this session's attachment directory", async () => {
    // The path comes from the RENDERER. Even if a block somehow cited an
    // outside file, the unlink is gated on the session's own prefix.
    const { session, cleanup } = await mkAttachSession();
    expect(await session.removeAttachment("../../etc/passwd")).toEqual({
      ok: false,
      reason: "not_found",
    });
    await cleanup();
  });

  it("attachments FOLLOW a workspace change — the cited path keeps resolving", async () => {
    // Before this, changing 板砖's working directory silently broke every
    // document already handed over: the block cites a workspace-RELATIVE path,
    // and the file stayed under the old root.
    const { session, backendWs, srcDir, cleanup } = await mkAttachSession();
    writeFileSync(join(srcDir, "spec.md"), "# spec\nbody\n");
    const a = await session.attachFiles([join(srcDir, "spec.md")]);
    if (!a.ok) return;
    const rel = a.files[0]?.path ?? "";
    expect(existsSync(join(backendWs, ...rel.split("/")))).toBe(true);

    const nextWs = mkdtempSync(join(tmpdir(), "herta-attach-ws2-"));
    expect((await session.setWorkspace(nextWs)).ok).toBe(true);

    // The SAME relative path now resolves under the new root…
    expect(existsSync(join(nextWs, ...rel.split("/")))).toBe(true);
    // …and exactly one copy exists — a move, not a copy.
    expect(existsSync(join(backendWs, ...rel.split("/")))).toBe(false);
    await cleanup();
  });

  it("removal after a workspace change deletes the real file, not a ghost", async () => {
    // The mirror of the bug above: removeAttachment unlinks from the CURRENT
    // root with force:true, so without the migration it reported success while
    // the real file sat orphaned under the old workspace.
    const { session, srcDir, cleanup } = await mkAttachSession();
    writeFileSync(join(srcDir, "spec.md"), "# spec\n");
    const a = await session.attachFiles([join(srcDir, "spec.md")]);
    if (!a.ok) return;
    const rel = a.files[0]?.path ?? "";

    const nextWs = mkdtempSync(join(tmpdir(), "herta-attach-ws3-"));
    await session.setWorkspace(nextWs);
    expect(await session.removeAttachment(rel)).toEqual({
      ok: true,
      removed: 1,
    });
    expect(existsSync(join(nextWs, ...rel.split("/")))).toBe(false);
    await cleanup();
  });

  it("a workspace change with no attachments is a harmless no-op", async () => {
    const { session, cleanup } = await mkAttachSession();
    const nextWs = mkdtempSync(join(tmpdir(), "herta-attach-ws4-"));
    expect((await session.setWorkspace(nextWs)).ok).toBe(true);
    await cleanup();
  });

  it("a credential-shaped source is refused at the door, per file", async () => {
    const { session, backendWs, srcDir, cleanup } = await mkAttachSession();
    writeFileSync(join(srcDir, "id_rsa"), "----KEY----\n");
    const r = await session.attachFiles([join(srcDir, "id_rsa")]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0]?.unreadable).toBe("denied");
    expect(r.files[0]?.path).toBe("");
    // Nothing on disk, and the record block says refused — not silence.
    expect(existsSync(join(backendWs, ".herta", "attachments"))).toBe(false);
    const block = session.record.find(
      (b) => b.kind === "system" && b.digest?.kind === "attachment",
    );
    expect(block?.kind === "system" && block.body).toContain("已拒收");
    await cleanup();
  });
});

// ── Contract-fallback record note (ADR 0044) ────────────────────────────────
//
// types.ts had PROMISED "falls back to `standard` and projects a `→ 系统`
// line saying so" since ADR 0040 — the implementation only console.warn'd,
// which no GUI user sees (user report 2026-08-24). One note per NEW session,
// naming the remedy; deferred past the opening so record order matches disk.

describe("contract-fallback record note (ADR 0044)", () => {
  const savedBash = process.env.HERTA_BASH;
  afterEach(() => {
    if (savedBash === undefined) delete process.env.HERTA_BASH;
    else process.env.HERTA_BASH = savedBash;
  });

  function noteBlocks(record: TerminalRecord) {
    return record.filter(
      (b) => b.kind === "system" && b.body.includes("Git for Windows"),
    );
  }
  /** minimal configured + deterministic no-bash (findBash override miss). */
  function minimalCfg(): AppServerConfig {
    const cfg = { ...mkConfig(), backendContract: "minimal" as const };
    process.env.HERTA_BASH = join(cfg.workspaceRoot, "no-such-bash.exe");
    return cfg;
  }

  it("one 系统 note naming the remedy, flushed AFTER the opening, one-shot", async () => {
    const { session, cleanup } = await mkStubSession(
      minimalCfg(),
      undefined,
      1,
      { openingOverride: TEST_OPENING },
    );
    // Deferred, not appended at create — the record's block order must match
    // the persisted order (the opening seed is persisted first).
    expect(noteBlocks(session.record)).toHaveLength(0);
    await session.playOpening();
    const record = session.record;
    const notes = noteBlocks(record);
    expect(notes).toHaveLength(1);
    const note = notes[0];
    if (note?.kind !== "system") throw new Error("no note block");
    expect(note.label).toBe("系统");
    expect(note.body).toContain("极简");
    // The opening streamed first; the note is the record's last block.
    expect(record.length).toBeGreaterThanOrEqual(2);
    expect(record[record.length - 1]).toBe(note);
    // One-shot.
    await session.playOpening();
    expect(noteBlocks(session.record)).toHaveLength(1);
    await cleanup();
  });

  it("a front-end that never plays openings (the CLI) gets it on the first submit, before the user block", async () => {
    const { session, cleanup } = await mkStubSession(minimalCfg());
    await session.submitText("hi");
    const record = session.record;
    expect(noteBlocks(record)).toHaveLength(1);
    const noteIdx = record.findIndex((b) => noteBlocks([b]).length === 1);
    const userIdx = record.findIndex((b) => b.kind === "user");
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(noteIdx).toBeLessThan(userIdx);
    await cleanup();
  });

  it("the note is persisted — and a RESUMED session does not repeat it", async () => {
    const cfg = minimalCfg();
    const first = await mkStubSession(cfg);
    await first.session.playOpening();
    expect(noteBlocks(first.session.record)).toHaveLength(1);
    const { readSessionFile } = await import("@herta/core");
    const onDisk = readSessionFile(
      join(cfg.transcriptDir, `${first.session.sessionId}.jsonl`),
    );
    expect(noteBlocks(onDisk.record)).toHaveLength(1);
    await first.cleanup();

    // Resume with the persisted record: initialRecord non-empty → no re-add.
    const resumed = await mkStubSession(cfg, onDisk.record);
    await resumed.session.playOpening();
    expect(noteBlocks(resumed.session.record)).toHaveLength(1);
    await resumed.cleanup();
  });

  it("no note when the standard contract was configured, or when bash exists", async () => {
    const cfgStd = { ...mkConfig(), backendContract: "standard" as const };
    process.env.HERTA_BASH = join(cfgStd.workspaceRoot, "no-such-bash.exe");
    const std = await mkStubSession(cfgStd);
    await std.session.playOpening();
    expect(noteBlocks(std.session.record)).toHaveLength(0);
    await std.cleanup();

    // "bash exists": any existing path satisfies findBash's override check.
    const cfgMin = { ...mkConfig(), backendContract: "minimal" as const };
    process.env.HERTA_BASH = cfgMin.workspaceRoot;
    const min = await mkStubSession(cfgMin);
    await min.session.playOpening();
    expect(noteBlocks(min.session.record)).toHaveLength(0);
    await min.cleanup();
  });
});
