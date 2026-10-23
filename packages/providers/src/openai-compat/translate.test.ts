import type { BackendPromptFrame, PromptFrame } from "@herta/core";
import { describe, expect, it } from "vitest";
import { translate } from "./translate.js";

const baseOpts = {
  model: "deepseek-v4-pro",
  temperature: 0.3,
  maxTokens: 1024,
};

describe("translate", () => {
  it("emits a minimal user-only request", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [{ role: "user", text: "hello", ts: "2026-05-03T00:00:00Z" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body).toEqual({
      model: "deepseek-v4-pro",
      stream: true,
      temperature: 0.3,
      max_tokens: 1024,
      messages: [{ role: "user", content: "hello" }],
    });
    expect("tools" in body).toBe(false);
    expect("tool_choice" in body).toBe(false);
  });

  it("maps assistant tool-call + tool-result round-trip", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        { role: "user", text: "list", ts: "t" },
        {
          role: "assistant",
          text: "",
          toolCalls: [
            { id: "call_1", tool: "list_files", input: { path: "." } },
          ],
          ts: "t",
        },
        {
          role: "tool",
          toolCallId: "call_1",
          result: { ok: true, data: ["a.ts"], summary: "1 file" },
          ts: "t",
        },
        {
          role: "assistant",
          text: "Found a.ts.",
          toolCalls: [],
          ts: "t",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "user", content: "list" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "list_files", arguments: '{"path":"."}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '1 file\n\n{"data":["a.ts"]}',
      },
      { role: "assistant", content: "Found a.ts." },
    ]);
  });

  it("sends modelText verbatim when a tool authored it (ADR 0040) — summary/data stay harness-only", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        {
          role: "tool",
          toolCallId: "call_1",
          result: {
            ok: true,
            data: { exitCode: 1, stdout: "x" },
            summary: "ran `npm test` (exit 1)",
            modelText: "TAP version 13\nnot ok 1 - a\n[exit code: 1]",
          },
          ts: "t",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "TAP version 13\nnot ok 1 - a\n[exit code: 1]",
    });
  });

  it("uses JSON-stringified data when summary is empty", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        {
          role: "tool",
          toolCallId: "call_1",
          result: { ok: true, data: { x: 1 }, summary: "" },
          ts: "t",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: '{"data":{"x":1}}',
    });
  });

  it("maps tool schemas to OpenAI tools array", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [],
      toolSchemas: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    };
    const body = translate(frame, baseOpts);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
    ]);
  });

  it("merges extraBody after base fields (vendor wins)", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [],
      toolSchemas: [],
    };
    const body = translate(frame, {
      ...baseOpts,
      extraBody: {
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        temperature: 0.99,
      },
    });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.temperature).toBe(0.99);
  });

  it("omits temperature/max_tokens when not provided", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [],
      toolSchemas: [],
    };
    const body = translate(frame, { model: "deepseek-v4-pro" });
    expect("temperature" in body).toBe(false);
    expect("max_tokens" in body).toBe(false);
  });

  it("prepends a system message when stableSystem is non-empty", () => {
    const frame: PromptFrame = {
      stableSystem: "HELLO HERTA",
      memoryContext: "",
      retrievedLore: "",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "system", content: "HELLO HERTA" },
      { role: "user", content: "ping" },
    ]);
  });

  it("does not emit a system message when stableSystem is empty", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("emits only stableSystem when the other slots are empty", () => {
    const frame: PromptFrame = {
      stableSystem: "S",
      memoryContext: "",
      retrievedLore: "",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "ping" },
    ]);
  });

  it("emits two system messages when stable and memory are non-empty", () => {
    const frame: PromptFrame = {
      stableSystem: "S",
      memoryContext: "M",
      retrievedLore: "",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "system", content: "M" },
      { role: "user", content: "ping" },
    ]);
  });

  it("threads reasoningContent back as reasoning_content on the assistant message", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        { role: "user", text: "list", ts: "t" },
        {
          role: "assistant",
          text: "",
          toolCalls: [
            { id: "call_1", tool: "list_files", input: { path: "." } },
          ],
          ts: "t",
          reasoningContent: "The user wants files. Calling list_files.",
        },
        {
          role: "tool",
          toolCallId: "call_1",
          result: { ok: true, data: ["a.ts"], summary: "1 file" },
          ts: "t",
        },
        {
          role: "assistant",
          text: "Found a.ts.",
          toolCalls: [],
          ts: "t",
          reasoningContent: "Result has one file.",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "user", content: "list" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "list_files", arguments: '{"path":"."}' },
          },
        ],
        reasoning_content: "The user wants files. Calling list_files.",
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '1 file\n\n{"data":["a.ts"]}',
      },
      {
        role: "assistant",
        content: "Found a.ts.",
        reasoning_content: "Result has one file.",
      },
    ]);
  });

  it("omits reasoning_content when reasoningContent is empty or absent", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        { role: "assistant", text: "hi", toolCalls: [], ts: "t" },
        {
          role: "assistant",
          text: "still hi",
          toolCalls: [],
          ts: "t",
          reasoningContent: "",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    for (const m of body.messages) {
      expect("reasoning_content" in m).toBe(false);
    }
  });

  it("omits memoryContext system message when empty", () => {
    const frame: PromptFrame = {
      stableSystem: "S",
      memoryContext: "",
      retrievedLore: "",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "ping" },
    ]);
  });

  it("emits retrievedLore as a system message after memoryContext", () => {
    const frame: PromptFrame = {
      stableSystem: "S",
      memoryContext: "M",
      retrievedLore: "L",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "system", content: "M" },
      { role: "system", content: "L" },
      { role: "user", content: "ping" },
    ]);
  });

  it("omits retrievedLore system message when empty", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [{ role: "user", text: "ping", ts: "t" }],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
  });

  it("emits summary + data envelope when both are present", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        {
          role: "tool",
          toolCallId: "call_1",
          result: {
            ok: true,
            data: { chunkId: "h12", title: "doc" },
            summary: "lore_search: 1 results for 'Herta'",
          },
          ts: "t",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content:
        'lore_search: 1 results for \'Herta\'\n\n{"data":{"chunkId":"h12","title":"doc"}}',
    });
  });

  it("emits error + suggestion alongside summary on a denied tool call", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        {
          role: "tool",
          toolCallId: "call_1",
          result: {
            ok: false,
            error: {
              code: "permission_denied",
              message: "User denied edit_file",
              retryable: false,
            },
            suggestion: "Choose a read-only inspection path or ask the user.",
            summary: "denied",
          },
          ts: "t",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content:
        'denied\n\n{"error":{"code":"permission_denied","message":"User denied edit_file","retryable":false},"suggestion":"Choose a read-only inspection path or ask the user."}',
    });
  });

  it("preserves summary-only output when no data is present (back-compat)", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        {
          role: "tool",
          toolCallId: "call_1",
          result: { ok: true, summary: "ok" },
          ts: "t",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "ok",
    });
  });

  it("emits literal {} when both summary and data are absent (degenerate fallback)", () => {
    const frame: PromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [
        {
          role: "tool",
          toolCallId: "call_1",
          result: { ok: true, summary: "" },
          ts: "t",
        },
      ],
      toolSchemas: [],
    };
    const body = translate(frame, baseOpts);
    expect(body.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "{}",
    });
  });
});

describe("translateBackend", () => {
  function makeBackendFrame(
    overrides: Partial<BackendPromptFrame> = {},
  ): BackendPromptFrame {
    return {
      backendSystem: "You are the coding execution backend for Herta CLI.",
      scopedMemory: "",
      toolSchemas: [],
      messages: [],
      ...overrides,
    };
  }

  it("emits backendSystem as a system message", () => {
    const frame = makeBackendFrame();
    const req = translate(frame, { model: "test-model" });
    expect(req.messages[0]).toEqual({
      role: "system",
      content: "You are the coding execution backend for Herta CLI.",
    });
  });

  it('in thinking mode every assistant message carries reasoning_content — "" when the model gave none — so a request that goes on after its final answer is accepted (live todo lab 2026-09-29)', () => {
    // The end-of-run check's shape: the model's final answer (here with no
    // reasoning), then the state trailer — no user message in between.
    // DeepSeek refused exactly this with the field omitted, and took it with
    // the field as "".
    const frame = makeBackendFrame({
      messages: [
        { role: "user", text: "fix it", ts: "t" },
        {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "c1", tool: "bash", input: { command: "ls" } }],
          ts: "t",
          reasoningContent: "Look first.",
        },
        {
          role: "tool",
          toolCallId: "c1",
          result: { ok: true, summary: "listed" },
          ts: "t",
        },
        { role: "assistant", text: "Done.", toolCalls: [], ts: "t" },
      ],
      trailingState: "（收尾检查：……）",
    });
    const thinking = {
      model: "deepseek-v4-pro",
      extraBody: { thinking: { type: "enabled" }, reasoning_effort: "high" },
    };
    const req = translate(frame, thinking);
    const assistants = req.messages.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.reasoning_content)).toEqual([
      "Look first.",
      "",
    ]);
    expect(req.messages.at(-1)).toEqual({
      role: "system",
      content: "（收尾检查：……）",
    });

    // Thinking disabled, or not asked for: the field stays off an answer
    // that has none, as before.
    for (const opts of [
      {
        model: "deepseek-flash",
        extraBody: { thinking: { type: "disabled" } },
      },
      { model: "test-model" },
    ]) {
      const last = translate(frame, opts).messages.filter(
        (m) => m.role === "assistant",
      )[1];
      expect(last !== undefined && "reasoning_content" in last).toBe(false);
    }
  });

  it("emits scopedMemory as an additional system message when non-empty", () => {
    const frame = makeBackendFrame({
      scopedMemory: "User dislikes long replies.",
    });
    const req = translate(frame, { model: "test-model" });
    expect(req.messages).toEqual([
      { role: "system", content: frame.backendSystem },
      { role: "system", content: "User dislikes long replies." },
    ]);
  });

  it("omits empty scoped fields", () => {
    const frame = makeBackendFrame({
      scopedMemory: "",
    });
    const req = translate(frame, { model: "test-model" });
    expect(req.messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("forwards tool schemas to the OpenAI tools field", () => {
    const frame = makeBackendFrame({
      toolSchemas: [
        {
          name: "read_file",
          description: "read a file",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    const req = translate(frame, { model: "test-model" });
    expect(req.tools).toHaveLength(1);
    expect(req.tools?.[0]?.function.name).toBe("read_file");
  });

  it("forwards transcript messages after system messages", () => {
    const frame = makeBackendFrame({
      messages: [
        { role: "user", text: "hello", ts: "2026-05-07T00:00:00.000Z" },
      ],
    });
    const req = translate(frame, { model: "test-model" });
    expect(req.messages[0]?.role).toBe("system");
    expect(req.messages.at(-1)).toEqual({ role: "user", content: "hello" });
  });

  // ── Tool-result images (ADR 0048 slice 3) ──────────────────────────────

  const imageResult = (paths: readonly string[]) => ({
    role: "tool" as const,
    toolCallId: "call_1",
    ts: "2026-08-27T00:00:00.000Z",
    result: {
      ok: true,
      summary: `viewing ${paths.join(", ")}`,
      images: paths.map((p) => ({
        dataUri: `data:image/png;base64,AAAA-${p}`,
        path: p,
      })),
    },
  });

  it("puts a tool result's images in a USER message after it", () => {
    // The API takes images in user messages only. Emitting them inside the
    // tool message would 400 the whole turn, so the fan-out lives here — in
    // the layer that knows the wire format.
    const req = translate(
      makeBackendFrame({ messages: [imageResult(["shots/a.png"])] }),
      { model: "test-model" },
    );
    const tool = req.messages.at(-2);
    const user = req.messages.at(-1);
    expect(tool).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "viewing shots/a.png",
    });
    expect(user).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[shots/a.png]" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA-shots/a.png" },
        },
      ],
    });
  });

  it("holds the pictures until every tool call of the turn is answered", () => {
    // A user message between two tool messages 400s the request: the API
    // wants each tool_call_id answered first (a screenshot beside a command,
    // ADR 0083 lab 2026-10-23).
    const ts = "2026-10-23T00:00:00.000Z";
    const req = translate(
      makeBackendFrame({
        messages: [
          {
            role: "assistant",
            ts,
            text: "",
            toolCalls: [
              { id: "call_1", tool: "browser_screenshot", input: {} },
              { id: "call_2", tool: "bash", input: { command: "ls" } },
            ],
          },
          imageResult(["shot-1.png"]),
          {
            role: "tool",
            toolCallId: "call_2",
            ts,
            result: { ok: true, summary: "2 files" },
          },
          { role: "user", ts, text: "next" },
        ],
      }),
      { model: "test-model" },
    );
    const roles = req.messages.map((m) => m.role);
    expect(roles.slice(-5)).toEqual([
      "assistant",
      "tool",
      "tool",
      "user",
      "user",
    ]);
    const pictures = req.messages.at(-2) as {
      content: { type: string; text?: string }[];
    };
    expect(pictures.content[0]?.text).toBe("[shot-1.png]");
    expect(pictures.content).toHaveLength(2);
  });

  it("names every picture in the text part, so a multi-image call can cite", () => {
    const req = translate(
      makeBackendFrame({ messages: [imageResult(["a.png", "b.png"])] }),
      { model: "test-model" },
    );
    const user = req.messages.at(-1) as {
      content: { type: string; text?: string }[];
    };
    expect(user.content[0]?.text).toBe("[a.png, b.png]");
    expect(user.content).toHaveLength(3);
  });

  it("leaves an ordinary tool result exactly as it was — one message, a string", () => {
    // The 99% path. Content parts on every tool message would change the
    // cached prefix bytes for every brief that never sees a picture.
    const req = translate(
      makeBackendFrame({
        messages: [
          {
            role: "tool",
            toolCallId: "call_1",
            ts: "2026-08-27T00:00:00.000Z",
            result: { ok: true, summary: "2 files" },
          },
        ],
      }),
      { model: "test-model" },
    );
    expect(req.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "2 files",
    });
  });

  it("an empty images array adds no message", () => {
    const req = translate(
      makeBackendFrame({
        messages: [
          {
            role: "tool",
            toolCallId: "call_1",
            ts: "2026-08-27T00:00:00.000Z",
            result: { ok: true, summary: "nothing", images: [] },
          },
        ],
      }),
      { model: "test-model" },
    );
    expect(req.messages.at(-1)).toMatchObject({ role: "tool" });
  });
});
