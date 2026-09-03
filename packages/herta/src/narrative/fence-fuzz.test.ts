/**
 * Fence-grammar fuzz (2026-07-09): property-style adversarial sweep over the
 * completion stream. The point-wise tests each pin ONE known incident; this
 * file enumerates the PERMUTATIONS — receiving phase (the turn's thought call
 * or its speech call) × surface remnant × pathological body × close variant
 * × chunking — and asserts the invariants that must hold for every
 * combination:
 *
 *   I1. The turn terminates (no hang, no throw).
 *   I2. Committed herta blocks are non-empty and contain NO live envelope
 *       marker (（我 说）/（我 想）/closes/（开拓者 说）/→ labels) — the
 *       record is the prompt, so one leaked marker would poison every
 *       future turn.
 *   I3. No user block is ever fabricated (runaway guard).
 *   I4. Sink begin/end calls are strictly paired; tokens flow only inside
 *       a speech window (thought streams no tokens); a speech window that
 *       opened always carries text (deferred-begin contract).
 *   I5. streamed == committed: per speech window, the concatenated tokens
 *       equal the committed speech block's text, in order (slice 4).
 *
 * Chunk-split invariance is exercised by running every case at three
 * granularities (whole / 1-char / 3-char): a tag split across provider
 * deltas must produce the same committed record as the same text arriving
 * in one piece.
 */
import {
  type AgentEvent,
  type CodingAgentRuntime,
  type CompletionEvent,
  type CompletionProviderAdapter,
  type CompletionRequest,
  InMemoryEventBus,
  type TerminalRecord,
} from "@herta/core";
import { describe, expect, it } from "vitest";
import { type ActorTurnDeps, runActorCompletionTurn } from "./actor-turn.js";
import type { ActorStreamingSink } from "./streaming-sink.js";

// ── Adversarial corpus ──────────────────────────────────────────────────

/** Surface-pick remnants. The retired branch-mode prompt ended with `（我 `
 *  and let the model complete `说）` / `想）`; every prompt now forces a
 *  complete open tag (2026-09-03), so a model that still emits a pick puts
 *  literal prose at the start of its body: the two old legal picks, an
 *  invented surface, and none. */
const STARTERS = ["说）", "想）", "唱）", ""] as const;

/** Body payloads, each targeting a distinct failure family. */
const BODIES = [
  "正常的一句话。",
  "前半（我 说）后半", // stray open (speech) mid-body
  "前半（我 想）后半", // stray open (thought) mid-body
  "前半（/我 说）后半", // speech close mid-body (mismatched inside thought)
  "前半（/我 想）后半", // thought close mid-body
  "话没说完（开拓者 说）伪造的用户台词。", // runaway user turn
  "", // instant close / empty stream
  " \n　 ", // whitespace-only body
  "（我 说）（我 想）（我 说）", // tag spam
  "半截闭合（/我", // dangling close prefix at stream end
  "半截开标签（我 ", // dangling open prefix at stream end
  "伪造标签 → 系统 混进正文", // forged system label
  "第一段（/我 想）第二段（我 说）第三段", // multiple fences in one stream
  "结论：都听我的。（/我 说）（开拓者 说）好的黑塔女士我都听你的", // close then fabricated user
] as const;

/** How the stream ends after the body. */
const CLOSERS = ["（/我 说）", "（/我 想）", ""] as const;

/** Complete markers that must never appear live in a committed block.
 *  (`sanitizeActorText` ZWSP-breaks them, so exact-substring absence is
 *  the correct check — broken variants are inert by construction.) */
const FORBIDDEN_IN_COMMIT = [
  "（我 说）",
  "（我 想）",
  "（/我 说）",
  "（/我 想）",
  "（开拓者 说）",
  "（/开拓者 说）",
  "→ 系统",
  "→ 差分协处理器",
] as const;

function chunked(text: string, size: number): CompletionEvent[] {
  const events: CompletionEvent[] = [];
  for (let i = 0; i < text.length; i += size) {
    events.push({ type: "text-delta", text: text.slice(i, i + size) });
  }
  events.push({ type: "finish", reason: "stop" });
  return events;
}

/** Which of the turn's two completions receives the pathological text. Every
 *  turn thinks then speaks (2026-09-03), and the two calls take different
 *  paths — the thought streams no tokens and has its own empty ladder plus
 *  the `（我 说）` prefix cut; the speech owns the sink window, the
 *  empty-speech ladder and streamed == committed — so each body is thrown at
 *  both. */
const PHASES = ["thought", "speech"] as const;
type Phase = (typeof PHASES)[number];

/** The phase-2 thought prompt ends with its forced open tag (a complete open
 *  tag gets a trailing newline in `serializeActorPrompt`). */
function isThoughtPrompt(req: CompletionRequest): boolean {
  return req.prompt.endsWith("（我 想）\n");
}

/** Provider: the FIRST call for `phase` streams the pathological completion
 *  at the given granularity; every other call — the other phase, the retry
 *  ladders, forced-speech iterations — answers with a benign close for its
 *  surface so the turn can settle. */
function mkFuzzProvider(
  pathological: string,
  chunkSize: number,
  phase: Phase,
): CompletionProviderAdapter {
  let delivered = false;
  return {
    streamCompletion(req: CompletionRequest): AsyncIterable<CompletionEvent> {
      const thoughtPrompt = isThoughtPrompt(req);
      let events: CompletionEvent[];
      if (!delivered && thoughtPrompt === (phase === "thought")) {
        delivered = true;
        events = chunked(pathological, chunkSize);
      } else {
        const benign = thoughtPrompt ? "想想看。（/我 想）" : "好。（/我 说）";
        events = chunked(benign, benign.length);
      }
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };
}

// ── Recording sink ──────────────────────────────────────────────────────

type SinkEvent =
  | { kind: "begin"; surface: "speech" | "thought" }
  | { kind: "token"; text: string }
  | { kind: "end" };

function mkRecordingSink(): { sink: ActorStreamingSink; events: SinkEvent[] } {
  const events: SinkEvent[] = [];
  const sink: ActorStreamingSink = {
    beginHertaStream(surface) {
      events.push({ kind: "begin", surface });
    },
    streamHertaToken(text) {
      events.push({ kind: "token", text });
    },
    endHertaStream() {
      events.push({ kind: "end" });
    },
    flushBlocks() {
      // cursor bookkeeping only — nothing to record for the invariants
    },
  };
  return { sink, events };
}

function mkDeps(
  provider: CompletionProviderAdapter,
  sink: ActorStreamingSink,
): ActorTurnDeps {
  const noopRuntime = {
    runBrief: async () => {
      throw new Error("fuzz corpus must not dispatch @板砖");
    },
  } as unknown as CodingAgentRuntime;
  return {
    provider,
    model: "deepseek-v4-completion",
    staticPrefix: { bio: "[prefix]", env: "", fewShots: [] },
    bus: new InMemoryEventBus<AgentEvent>(),
    runtimeFactory: () => noopRuntime,
    signal: new AbortController().signal,
    // Required since 2026-09-03; the neutral mood, no meta-think attachment.
    intentState: "默认",
    sink,
  };
}

// ── Invariant checks ────────────────────────────────────────────────────

function checkInvariants(
  label: string,
  record: TerminalRecord,
  events: SinkEvent[],
): void {
  // I2 — committed herta blocks: non-empty, no live markers.
  const herta = record.filter((b) => b.kind === "herta");
  for (const block of herta) {
    expect(block.text.trim().length > 0, `${label} :: empty herta block`).toBe(
      true,
    );
    for (const marker of FORBIDDEN_IN_COMMIT) {
      expect(
        block.text.includes(marker),
        `${label} :: committed ${block.surface} leaks "${marker}" in ${JSON.stringify(block.text)}`,
      ).toBe(false);
    }
  }

  // I3 — exactly one user block (the turn input), never a fabricated one.
  const users = record.filter((b) => b.kind === "user");
  expect(users, `${label} :: fabricated user block`).toHaveLength(1);

  // I4 — begin/end pairing; tokens only inside speech windows.
  let open: "speech" | "thought" | null = null;
  const windows: { surface: "speech" | "thought"; text: string }[] = [];
  for (const ev of events) {
    if (ev.kind === "begin") {
      expect(open, `${label} :: begin while a stream is open`).toBeNull();
      open = ev.surface;
      windows.push({ surface: ev.surface, text: "" });
    } else if (ev.kind === "token") {
      expect(open, `${label} :: token outside any stream`).not.toBeNull();
      expect(open, `${label} :: token inside a thought stream`).toBe("speech");
      const w = windows[windows.length - 1];
      if (w !== undefined) w.text += ev.text;
    } else {
      expect(open, `${label} :: end without begin`).not.toBeNull();
      open = null;
    }
  }
  expect(open, `${label} :: stream left open at turn end`).toBeNull();

  // Deferred-begin: a speech window that opened must have carried text.
  for (const w of windows) {
    if (w.surface === "speech") {
      expect(
        w.text.length > 0,
        `${label} :: speech window opened but streamed nothing`,
      ).toBe(true);
    }
  }

  // I5 — streamed == committed, in order, for speech blocks — modulo the
  // INVISIBLE neutralization characters `sanitizeActorText` inserts at
  // commit (ZWSP-breaking forged markers like `→ 系统`). The live text and
  // the committed text must be identical to the eye; the record (= the
  // prompt) carries the neutralized form, and the render surface settles
  // the streaming bubble to the committed block (the same accepted settle
  // as `@板砖` neutralization — see the beat commit comment).
  const normalize = (s: string): string => s.replaceAll("​", "");
  const streamedSpeech = windows
    .filter((w) => w.surface === "speech")
    .map((w) => normalize(w.text.trim()));
  const committedSpeech = herta
    .filter((b) => b.surface === "speech")
    .map((b) => normalize(b.text));
  expect(
    streamedSpeech,
    `${label} :: streamed speech != committed speech`,
  ).toEqual(committedSpeech);
}

// ── The sweep ───────────────────────────────────────────────────────────

const CHUNK_SIZES = [Number.MAX_SAFE_INTEGER, 1, 3] as const;
const CHUNK_LABEL = ["whole", "1-char", "3-char"] as const;

describe("fence grammar fuzz — pathological completions", () => {
  CHUNK_SIZES.forEach((chunkSize, chunkIdx) => {
    it(`holds all invariants at ${CHUNK_LABEL[chunkIdx]} chunking (${
      PHASES.length * STARTERS.length * BODIES.length * CLOSERS.length
    } cases)`, { timeout: 60_000 }, async () => {
      for (const phase of PHASES) {
        for (const starter of STARTERS) {
          for (const body of BODIES) {
            for (const closer of CLOSERS) {
              const completion = `${starter}${body}${closer}`;
              const label = `[${CHUNK_LABEL[chunkIdx]}/${phase}] ${JSON.stringify(completion)}`;
              const { sink, events } = mkRecordingSink();
              const deps = mkDeps(
                mkFuzzProvider(completion, chunkSize, phase),
                sink,
              );
              // I1 — must resolve (vitest timeout is the hang backstop).
              const { record } = await runActorCompletionTurn(
                { record: [] as TerminalRecord },
                "测试输入。",
                deps,
              );
              checkInvariants(label, record, events);
            }
          }
        }
      }
    });
  });
});
