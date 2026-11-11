import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderEvent } from "@herta/core";
import { describe, expect, it } from "vitest";
import { parseSSE } from "./sse.js";
import { mapStream } from "./stream.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "__fixtures__");

async function eventsFromFixture(name: string): Promise<ProviderEvent[]> {
  const text = await readFile(join(FIXTURE_DIR, name), "utf8");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  const ctl = new AbortController();
  const out: ProviderEvent[] = [];
  for await (const ev of mapStream(parseSSE(stream, ctl.signal), ctl.signal)) {
    out.push(ev);
  }
  return out;
}

describe("mapStream", () => {
  it("text-only.sse → deltas + finish{stop}", async () => {
    const events = await eventsFromFixture("text-only.sse");
    expect(events).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " world" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("tool-call-single.sse → the arguments as they stream, then one tool-call-request + finish{tool_calls}", async () => {
    const events = await eventsFromFixture("tool-call-single.sse");
    expect(events).toEqual([
      // ADR 0073: each argument fragment, as it arrives (an empty one is not
      // sent).
      {
        type: "tool-call-delta",
        id: "call_1",
        tool: "read_file",
        argsDelta: '{"path":',
      },
      {
        type: "tool-call-delta",
        id: "call_1",
        tool: "read_file",
        argsDelta: '"foo.ts"}',
      },
      {
        type: "tool-call-request",
        call: { id: "call_1", tool: "read_file", input: { path: "foo.ts" } },
      },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("tool-call-parallel.sse → each call's fragments under its own id, then 2 tool-call-requests in index order", async () => {
    const events = await eventsFromFixture("tool-call-parallel.sse");
    expect(events).toEqual([
      {
        type: "tool-call-delta",
        id: "call_1",
        tool: "read_file",
        argsDelta: '{"path":"a"}',
      },
      {
        type: "tool-call-delta",
        id: "call_2",
        tool: "list_files",
        argsDelta: '{"path":"b"}',
      },
      {
        type: "tool-call-request",
        call: { id: "call_1", tool: "read_file", input: { path: "a" } },
      },
      {
        type: "tool-call-request",
        call: { id: "call_2", tool: "list_files", input: { path: "b" } },
      },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("tool-call-with-text.sse → text deltas, then the call's arguments, then tool-call, then finish", async () => {
    const events = await eventsFromFixture("tool-call-with-text.sse");
    expect(events).toEqual([
      { type: "text-delta", text: "Looking up " },
      { type: "text-delta", text: "the file." },
      {
        type: "tool-call-delta",
        id: "call_1",
        tool: "read_file",
        argsDelta: '{"path":"foo"}',
      },
      {
        type: "tool-call-request",
        call: { id: "call_1", tool: "read_file", input: { path: "foo" } },
      },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("content-filter.sse → finish{error}, no throw", async () => {
    const events = await eventsFromFixture("content-filter.sse");
    expect(events).toEqual([
      { type: "text-delta", text: "This" },
      { type: "finish", reason: "error" },
    ]);
  });

  it("reasoning-content.sse emits reasoning-delta events alongside text", async () => {
    const events = await eventsFromFixture("reasoning-content.sse");
    expect(events).toEqual([
      { type: "reasoning-delta", text: "thinking..." },
      { type: "reasoning-delta", text: " more" },
      { type: "text-delta", text: "Answer." },
      { type: "finish", reason: "stop" },
    ]);
  });

  // Was: "throws ProviderError{tool-args}". Changed 2026-08-13 — throwing
  // killed the whole brief on the first mis-escaped argument and discarded
  // every tool call already run in it. The failure now travels as data and
  // the turn loop hands it back to the model as a result it can act on.
  it("malformed-args.sse marks the call instead of throwing", async () => {
    const events = (await eventsFromFixture("malformed-args.sse")).filter(
      (e) => e.type !== "tool-call-delta",
    );
    expect(events).toHaveLength(2);
    const [first, second] = events;
    if (first?.type !== "tool-call-request") throw new Error("no call");
    expect(first.call.id).toBe("call_1");
    expect(first.call.tool).toBe("read_file");
    // input is inert: nothing was recoverable, so it must not look usable.
    expect(first.call.input).toEqual({});
    expect(first.call.malformedArgs?.raw).toBe("{not json");
    expect(first.call.malformedArgs?.parseError).toBeTruthy();
    expect(second).toEqual({ type: "finish", reason: "tool_calls" });
  });

  it("truncated-stream.sse throws ProviderError{sse}", async () => {
    await expect(
      eventsFromFixture("truncated-stream.sse"),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "sse",
    });
  });
});

/** Drive mapStream from chunk objects directly — the existing suite's
 *  FakeProvider bypasses mapStream entirely, which is why the two holes below
 *  were never caught (audit BL4). */
async function mapChunks(chunks: unknown[]): Promise<ProviderEvent[]> {
  const ctl = new AbortController();
  const src = (async function* () {
    for (const c of chunks) yield c;
  })();
  const out: ProviderEvent[] = [];
  for await (const ev of mapStream(src, ctl.signal)) out.push(ev);
  return out;
}

describe("mapStream argument deltas (ADR 0073)", () => {
  const callChunk = (tc: Record<string, unknown>) => ({
    choices: [
      { delta: { tool_calls: [{ index: 0, ...tc }] }, finish_reason: null },
    ],
  });

  it("a fragment that lands before the call's id and name is not lost: the first delta after them carries it", async () => {
    const events = await mapChunks([
      callChunk({ function: { arguments: '{"pa' } }),
      callChunk({ id: "c1", function: { name: "bash", arguments: 'th":' } }),
      callChunk({ function: { arguments: '"x"}' } }),
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    expect(events.filter((e) => e.type === "tool-call-delta")).toEqual([
      {
        type: "tool-call-delta",
        id: "c1",
        tool: "bash",
        argsDelta: '{"path":',
      },
      { type: "tool-call-delta", id: "c1", tool: "bash", argsDelta: '"x"}' },
    ]);
    // The deltas concatenate to exactly what the finished call parses.
    const req = events.find((e) => e.type === "tool-call-request");
    expect(req?.type === "tool-call-request" && req.call.input).toEqual({
      path: "x",
    });
  });
});

describe("mapStream truncation (audit BL4)", () => {
  const textChunk = (t: string) => ({
    choices: [{ delta: { content: t }, finish_reason: null }],
  });

  it("a stream that ends after text with no finish_reason is an error, not a stop", async () => {
    // Fabricating `stop` here overwrote stream-model-inference's "error"
    // default, which made backend-turn-loop's truncation guard unreachable —
    // so a backend turn cut off mid-generation was reported to Herta as 完成
    // and she narrated a finished commission.
    await expect(
      mapChunks([textChunk("I edited "), textChunk("the parser")]),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "sse",
      retryable: true,
    });
  });

  it("an empty stream is still a benign stop", async () => {
    // No text, no tool calls — an unusual but harmless shape the callers
    // already handle. Only a TRUNCATED generation is a failure.
    expect(await mapChunks([])).toEqual([{ type: "finish", reason: "stop" }]);
  });

  it("a mid-stream error payload is surfaced, not dropped", async () => {
    await expect(
      mapChunks([
        textChunk("part"),
        { error: { message: "upstream gateway timeout" } },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "sse",
      message: expect.stringContaining("upstream gateway timeout"),
    });
  });

  it("a benign `error: null` on every chunk does not kill the stream", async () => {
    // Some OpenAI-compatible gateways stamp this unconditionally.
    const events = await mapChunks([
      { error: null, ...textChunk("ok") },
      { error: null, choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    expect(events).toEqual([
      { type: "text-delta", text: "ok" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("a normal finish is untouched", async () => {
    expect(
      await mapChunks([
        textChunk("hi"),
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    ).toEqual([
      { type: "text-delta", text: "hi" },
      { type: "finish", reason: "stop" },
    ]);
  });
});

describe("mapStream — a turn cut off at the output limit (review 2026-11-10)", () => {
  it("hands the call it was writing to the loop, marked as cut off, and runs the one before it", async () => {
    const events = (await eventsFromFixture("tool-call-cut-off.sse")).filter(
      (e) => e.type !== "tool-call-delta",
    );
    expect(events).toHaveLength(3);
    const [whole, cut, finish] = events;
    if (whole?.type !== "tool-call-request") throw new Error("no first call");
    expect(whole.call).toEqual({
      id: "call_1",
      tool: "bash",
      input: { command: "echo ok" },
    });
    if (cut?.type !== "tool-call-request") throw new Error("no second call");
    expect(cut.call.id).toBe("call_2");
    expect(cut.call.input).toEqual({});
    expect(cut.call.malformedArgs?.truncated).toBe(true);
    expect(cut.call.malformedArgs?.raw).toContain("cat > big.txt");
    // The loop takes its tool branch, where a marked call is answered.
    expect(finish).toEqual({ type: "finish", reason: "tool_calls" });
  });

  it("text cut off with no call in hand is still `length`", async () => {
    const events = await eventsFromFixture("text-cut-off.sse");
    expect(events).toEqual([
      { type: "text-delta", text: "The report so far" },
      { type: "finish", reason: "length" },
    ]);
  });

  it("arguments that are not JSON at an ordinary finish are not marked", async () => {
    const events = await eventsFromFixture("malformed-args.sse");
    const call = events.find((e) => e.type === "tool-call-request");
    if (call?.type !== "tool-call-request") throw new Error("no call");
    expect(call.call.malformedArgs).toBeDefined();
    expect(call.call.malformedArgs?.truncated).toBeUndefined();
  });
});
