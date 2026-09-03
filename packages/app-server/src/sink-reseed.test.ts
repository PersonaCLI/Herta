/**
 * Sink-cursor reseed after a failed turn (audit 2026-07-10, finding 10).
 *
 * A PLAIN provider throw (not an abort) leaves the driver's in-memory record
 * at its pre-turn value while the sink's canonical-diff cursor sits at the
 * failed turn's high-water mark (the user block, at least, was flushed —
 * streamed and persisted — before the provider call). Pre-fix nothing
 * reseeded the cursor, so the NEXT turn's user block landed below it: never
 * streamed (the renderer's optimistic echo was then cleared by `finished`,
 * so the message visually vanished) and never persisted (disk kept the
 * failed turn's user text in its place). This is the reproduction the audit
 * asked for before fixing — the one P1 whose full chain was not
 * independently reproduced.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CompletionEvent,
  CompletionProviderAdapter,
  CompletionRequest,
} from "@herta/core";
import { readSessionFile, V2RecordPersister } from "@herta/core";
import { describe, expect, it } from "vitest";
import { SessionImpl } from "./session.js";
import {
  isThoughtPrompt,
  stubChatProvider,
  stubThoughtStream,
} from "./testing/stub-providers.js";
import type { AppServerConfig, RecordEvent } from "./types.js";

function mkConfig(): AppServerConfig {
  const root = mkdtempSync(join(tmpdir(), "herta-sink-reseed-test-"));
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

/** Actor stub: call #1 (turn 1's thought phase) streams one delta then throws
 *  a PLAIN error (mid-turn provider failure — NOT an AbortError, so the driver
 *  keeps its pre-turn record); later calls answer the thought prompt with the
 *  canned thought and stream a well-formed speech. */
function failingThenOkActor(): CompletionProviderAdapter {
  let call = 0;
  return {
    streamCompletion(
      request: CompletionRequest,
      _signal: AbortSignal,
    ): AsyncIterable<CompletionEvent> {
      call += 1;
      if (call === 1) {
        return (async function* () {
          yield { type: "text-delta", text: "你" } satisfies CompletionEvent;
          throw new Error("provider exploded mid-turn");
        })();
      }
      if (isThoughtPrompt(request)) return stubThoughtStream();
      return (async function* () {
        yield {
          type: "text-delta",
          text: "第二回合回复。",
        } satisfies CompletionEvent;
        yield {
          type: "text-delta",
          text: "（/我 说）",
        } satisfies CompletionEvent;
        yield { type: "finish", reason: "stop" } satisfies CompletionEvent;
      })();
    },
  };
}

/** Scripted-posture deps — see interrupt.test.ts (no meta-think preamble, no
 *  supervisor, no opening seed). */
function scriptedPostureDeps(): {
  metaThinkOverride: import("@herta/herta").MetaThinkCorpus;
  supervisorReferenceOverride: string;
  openingOverride: null;
} {
  const empty = {
    默认: "",
    被烦版: "",
    教学版: "",
    被戳穿版: "",
    任务部署版: "",
    板砖代答版: "",
    被顶嘴版: "",
    倾听版: "",
  };
  return {
    metaThinkOverride: { preThink: { ...empty }, preSpeak: { ...empty } },
    supervisorReferenceOverride: "",
    openingOverride: null,
  };
}

describe("sink cursor after a failed turn (audit finding 10)", () => {
  it("the turn AFTER a provider failure still streams and persists its user block", async () => {
    const cfg = mkConfig();
    const sessionId = "sink-reseed-repro";
    const sessionFile = join(cfg.transcriptDir, `${sessionId}.jsonl`);
    const persister = V2RecordPersister.forNewSession({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      startedAt: new Date(),
      transcriptDir: cfg.transcriptDir,
    });
    const session = await SessionImpl.create({
      sessionId,
      workspaceRoot: cfg.workspaceRoot,
      effectiveWorkspace: cfg.workspaceRoot,
      isDefaultWorkspace: false,
      config: cfg,
      persister,
      deps: {
        providerOverrides: {
          actor: failingThenOkActor(),
          title: stubChatProvider([]),
        },
        staticPrefixOverride: { bio: "[test-bio]", env: "", fewShots: [] },
        ...scriptedPostureDeps(),
      },
    });

    // Collect everything the record channel streams.
    const streamed: RecordEvent[] = [];
    const consumer = (async () => {
      for await (const ev of session.subscribeRecord()) {
        streamed.push(ev);
      }
    })();

    // Turn 1: the provider throws mid-turn — submitText rejects.
    await expect(session.submitText("第一回合，会失败")).rejects.toThrow(
      /provider exploded/,
    );

    // Turn 2 must be a fully-functional turn.
    const r2 = await session.submitText("第二回合请求");
    expect("turnId" in r2).toBe(true);

    await session.close();
    await consumer;

    // The turn-2 user block STREAMED on the record channel (pre-fix it landed
    // below the desynced cursor and the renderer never saw it — the optimistic
    // echo was cleared by `finished`, so the message visually vanished).
    const streamedUserTexts = streamed
      .filter(
        (e): e is Extract<RecordEvent, { kind: "block" }> => e.kind === "block",
      )
      .map((e) => e.block)
      .filter((b) => b.kind === "user")
      .map((b) => (b as { text: string }).text);
    expect(streamedUserTexts).toContain("第二回合请求");

    // …and PERSISTED (pre-fix disk kept only the FAILED turn's user text).
    const { record } = readSessionFile(sessionFile);
    expect(
      record.some((b) => b.kind === "user" && b.text === "第二回合请求"),
    ).toBe(true);

    // The in-memory record agrees.
    expect(
      session.record.some(
        (b) => b.kind === "user" && b.text === "第二回合请求",
      ),
    ).toBe(true);

    // The sink invariant (`mirror.length === emittedCount`) was restored by
    // the reseed: resyncRecord is willing to emit again (it no-ops when the
    // invariant is broken). We can't reach into the sink, but a functioning
    // turn 2 plus the assertions above pin the observable contract.
  });
});
