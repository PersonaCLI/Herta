import type { CompletionEvent, ProviderEvent } from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAICompatibleCompletionProvider } from "./openai-compat/completion-provider.js";
import { mapCompletionStream } from "./openai-compat/completion-stream.js";
import { OpenAICompatibleProvider } from "./openai-compat/provider.js";
import { mapStream } from "./openai-compat/stream.js";
import { visionCaptioner } from "./openai-compat/vision-caption.js";
import {
  type ProviderCallFailure,
  type ProviderUsage,
  parseUsageChunk,
  reportProviderFailure,
  reportProviderUsage,
  setProviderFailureSink,
  setProviderUsageSink,
} from "./usage.js";

async function* fromArray(items: unknown[]): AsyncGenerator<unknown> {
  for (const i of items) yield i;
}
const live = new AbortController().signal;

// The shape DeepSeek really sends (probed live 2026-09-20): usage rides the
// chunk that carries finish_reason, on both endpoints.
const DEEPSEEK_USAGE = {
  prompt_tokens: 21_930,
  completion_tokens: 188,
  total_tokens: 22_118,
  prompt_tokens_details: { cached_tokens: 21_504 },
  prompt_cache_hit_tokens: 21_504,
  prompt_cache_miss_tokens: 426,
};

afterEach(() => setProviderUsageSink(undefined));

describe("parseUsageChunk", () => {
  it("reads DeepSeek's block, cache pair included", () => {
    expect(parseUsageChunk({ choices: [], usage: DEEPSEEK_USAGE })).toEqual({
      promptTokens: 21_930,
      completionTokens: 188,
      cacheHitTokens: 21_504,
      cacheMissTokens: 426,
    });
  });

  it("accepts OpenAI's cached_tokens as the hit count and derives the miss", () => {
    expect(
      parseUsageChunk({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 64 },
        },
      }),
    ).toEqual({
      promptTokens: 100,
      completionTokens: 5,
      cacheHitTokens: 64,
      cacheMissTokens: 36,
    });
  });

  it("says nothing about a cache the provider did not mention", () => {
    expect(
      parseUsageChunk({ usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    ).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      cacheHitTokens: null,
      cacheMissTokens: null,
    });
  });

  it("is null for the placeholder, an absent block and junk", () => {
    expect(parseUsageChunk({ choices: [{}], usage: null })).toBeNull();
    expect(parseUsageChunk({ choices: [{}] })).toBeNull();
    expect(parseUsageChunk(null)).toBeNull();
    expect(parseUsageChunk("usage")).toBeNull();
    expect(parseUsageChunk({ usage: { prompt_tokens: "7" } })).toBeNull();
    expect(
      parseUsageChunk({ usage: { prompt_tokens: -1, completion_tokens: 1 } }),
    ).toBeNull();
  });
});

describe("the stream mappers state usage BEFORE finish — every consumer stops reading there", () => {
  it("chat: a consumer that breaks at finish has already been told", async () => {
    const seen: unknown[] = [];
    const order: string[] = [];
    const events = mapStream(
      fromArray([
        { choices: [{ delta: { content: "hi" } }], usage: null },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: DEEPSEEK_USAGE,
        },
      ]),
      live,
      (u) => {
        seen.push(u);
        order.push("usage");
      },
    );
    for await (const ev of events as AsyncIterable<ProviderEvent>) {
      order.push(ev.type);
      if (ev.type === "finish") break;
    }
    expect(order).toEqual(["text-delta", "usage", "finish"]);
    expect(seen).toEqual([
      {
        promptTokens: 21_930,
        completionTokens: 188,
        cacheHitTokens: 21_504,
        cacheMissTokens: 426,
      },
    ]);
  });

  it("completion: the same, and a stream without usage reports nothing", async () => {
    const order: string[] = [];
    for await (const ev of mapCompletionStream(
      fromArray([
        { choices: [{ text: "嗯" }] },
        {
          choices: [{ text: "", finish_reason: "stop" }],
          usage: DEEPSEEK_USAGE,
        },
      ]),
      live,
      () => order.push("usage"),
    ) as AsyncIterable<CompletionEvent>) {
      order.push(ev.type);
      if (ev.type === "finish") break;
    }
    expect(order).toEqual(["text-delta", "usage", "finish"]);

    let told = 0;
    for await (const _ of mapCompletionStream(
      fromArray([{ choices: [{ text: "x", finish_reason: "stop" }] }]),
      live,
      () => {
        told += 1;
      },
    )) {
      // drain
    }
    expect(told).toBe(0);
  });

  it("reads an OpenAI-style trailing usage chunk when the consumer drains that far", async () => {
    const seen: unknown[] = [];
    for await (const _ of mapStream(
      fromArray([
        { choices: [{ delta: { content: "a" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
      ]),
      live,
      (u) => seen.push(u),
    )) {
      // drain
    }
    expect(seen).toHaveLength(1);
  });
});

describe("the providers name the endpoint and the model, and tell both listeners", () => {
  const sse = (chunks: unknown[]): typeof fetch => {
    const text = `${chunks
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join("")}data: [DONE]\n\n`;
    return async () =>
      new Response(text, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
  };

  it("chat", async () => {
    const sink: ProviderUsage[] = [];
    const own: ProviderUsage[] = [];
    setProviderUsageSink((u) => sink.push(u));
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test",
      apiKey: "sk",
      model: "deepseek-flash",
      onUsage: (u) => own.push(u),
      fetchImpl: sse([
        { choices: [{ delta: { content: "hi" } }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: DEEPSEEK_USAGE,
        },
      ]),
    });
    for await (const ev of provider.streamChat(
      {
        stableSystem: "",
        memoryContext: "",
        retrievedLore: "",
        messages: [{ role: "user", text: "hi", ts: "t" }],
        toolSchemas: [],
      },
      live,
    )) {
      if (ev.type === "finish") break; // as the real consumers do
    }
    const expected = {
      endpoint: "chat",
      model: "deepseek-flash",
      promptTokens: 21_930,
      completionTokens: 188,
      cacheHitTokens: 21_504,
      cacheMissTokens: 426,
      // How long the call took rides the same line (review 2026-11-10).
      ms: expect.any(Number),
    };
    expect(sink).toEqual([expected]);
    expect(own).toEqual([expected]);
  });

  it("completion — the model is the REQUEST's", async () => {
    const sink: ProviderUsage[] = [];
    setProviderUsageSink((u) => sink.push(u));
    const provider = new OpenAICompatibleCompletionProvider({
      baseUrl: "https://example.test",
      apiKey: "sk",
      path: "/beta/completions",
      fetchImpl: sse([
        { choices: [{ text: "嗯" }] },
        {
          choices: [{ text: "", finish_reason: "stop" }],
          usage: DEEPSEEK_USAGE,
        },
      ]),
    });
    for await (const ev of provider.streamCompletion(
      { model: "deepseek-v4-pro", prompt: "（我 说）", stop: ["\n"] },
      live,
    )) {
      if (ev.type === "finish") break;
    }
    expect(sink).toEqual([
      {
        endpoint: "completion",
        model: "deepseek-v4-pro",
        promptTokens: 21_930,
        completionTokens: 188,
        cacheHitTokens: 21_504,
        cacheMissTokens: 426,
        ms: expect.any(Number),
      },
    ]);
  });
});

describe("every call leaves one line (review 2026-11-10)", () => {
  const frame = {
    stableSystem: "",
    memoryContext: "",
    retrievedLore: "",
    messages: [{ role: "user" as const, text: "hi", ts: "t" }],
    toolSchemas: [],
  };
  const body = (chunks: unknown[]): string =>
    `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
  const answering = (chunks: unknown[]): typeof fetch => {
    return async () =>
      new Response(body(chunks), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
  };
  const chat = (fetchImpl: typeof fetch): OpenAICompatibleProvider =>
    new OpenAICompatibleProvider({
      baseUrl: "https://example.test",
      apiKey: "sk",
      model: "deepseek-flash",
      site: "supervisor",
      maxRetries: 0,
      fetchImpl,
    });
  let usages: ProviderUsage[];
  let failures: ProviderCallFailure[];
  const listen = (): void => {
    usages = [];
    failures = [];
    setProviderUsageSink((u) => usages.push(u));
    setProviderFailureSink((f) => failures.push(f));
  };
  afterEach(() => setProviderFailureSink(undefined));

  it("a call that states its usage says whose it was, and leaves no failure", async () => {
    listen();
    for await (const ev of chat(
      answering([
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: DEEPSEEK_USAGE,
        },
      ]),
    ).streamChat(frame, live)) {
      if (ev.type === "finish") break;
    }
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ site: "supervisor", endpoint: "chat" });
    expect(usages[0]?.ms).toBeGreaterThanOrEqual(0);
    expect(failures).toEqual([]);
  });

  it("a call that fails leaves the provider's own code, and the error is still thrown", async () => {
    listen();
    const refused: typeof fetch = async () =>
      new Response("{}", { status: 401 });
    await expect(
      (async () => {
        for await (const _ of chat(refused).streamChat(frame, live)) {
          // never reached
        }
      })(),
    ).rejects.toMatchObject({ name: "ProviderError", code: "http" });
    expect(usages).toEqual([]);
    expect(failures).toEqual([
      {
        endpoint: "chat",
        model: "deepseek-flash",
        site: "supervisor",
        outcome: "http",
        ms: expect.any(Number),
      },
    ]);
  });

  it("a call cut by its deadline or an interrupt says aborted", async () => {
    listen();
    const ctl = new AbortController();
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    const reading = (async () => {
      for await (const _ of chat(hanging).streamChat(frame, ctl.signal)) {
        // never reached
      }
    })();
    ctl.abort();
    await expect(reading).rejects.toBeDefined();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      outcome: "aborted",
      site: "supervisor",
    });
  });

  it("a reader that leaves before the usage arrives is said too", async () => {
    listen();
    const provider = new OpenAICompatibleCompletionProvider({
      baseUrl: "https://example.test",
      apiKey: "sk",
      path: "/beta/completions",
      site: "actor",
      fetchImpl: answering([
        { choices: [{ text: "嗯" }] },
        {
          choices: [{ text: "", finish_reason: "stop" }],
          usage: DEEPSEEK_USAGE,
        },
      ]),
    });
    for await (const ev of provider.streamCompletion(
      { model: "deepseek-v4-pro", prompt: "（我 说）", stop: ["\n"] },
      live,
    )) {
      if (ev.type === "text-delta") break; // before the finish chunk
    }
    expect(usages).toEqual([]);
    expect(failures).toEqual([
      {
        endpoint: "completion",
        model: "deepseek-v4-pro",
        site: "actor",
        outcome: "unread",
        ms: expect.any(Number),
      },
    ]);
  });

  it("a provider nobody labelled reports as before, with no site", async () => {
    listen();
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test",
      apiKey: "sk",
      model: "deepseek-flash",
      fetchImpl: answering([
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: DEEPSEEK_USAGE,
        },
      ]),
    });
    for await (const ev of provider.streamChat(frame, live)) {
      if (ev.type === "finish") break;
    }
    expect(usages[0]).not.toHaveProperty("site");
  });

  it("a stream read to its end that never stated a usage is not called unread", async () => {
    listen();
    for await (const _ of chat(
      answering([{ choices: [{ delta: {}, finish_reason: "stop" }] }]),
    ).streamChat(frame, live)) {
      // read to the end
    }
    expect(usages).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ outcome: "no_usage" });
  });

  it("a deadline that cut the stream says aborted, whatever its reason was", async () => {
    listen();
    const ctl = new AbortController();
    // As the transport does: the body fails with the signal's own reason,
    // here a plain Error (the review deadline's), not an AbortError.
    const cut: typeof fetch = async (_url, init) => {
      const first = `data: ${JSON.stringify({
        choices: [{ delta: { content: "嗯" } }],
      })}\n\n`;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(first));
          init?.signal?.addEventListener("abort", () =>
            controller.error(init.signal?.reason),
          );
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const reading = (async () => {
      for await (const ev of chat(cut).streamChat(frame, ctl.signal)) {
        if (ev.type === "text-delta") ctl.abort(new Error("review timed out"));
      }
    })();
    await expect(reading).rejects.toBeDefined();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      outcome: "aborted",
      site: "supervisor",
    });
  });

  describe("the caption, the one call that is not a stream", () => {
    const captioner = (fetchImpl: typeof fetch) =>
      visionCaptioner({
        baseUrl: "https://example.test",
        apiKey: "sk",
        model: "vision-model",
        maxRetries: 0,
        fetchImpl,
      });
    const picture = {
      system: "describe",
      user: "what is this",
      imageDataUri: "data:image/png;base64,iVBORw0KGgo=",
    };
    const replying = (payload: unknown, status = 200): typeof fetch => {
      return async () =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        });
    };
    const said = (content: string) => ({
      choices: [{ message: { content }, finish_reason: "stop" }],
    });

    it("states its usage with the site and the wall time", async () => {
      listen();
      await captioner(replying({ ...said("a cat"), usage: DEEPSEEK_USAGE }))(
        picture,
        live,
      );
      expect(usages).toHaveLength(1);
      expect(usages[0]).toMatchObject({
        endpoint: "chat",
        model: "vision-model",
        site: "vision",
        ms: expect.any(Number),
      });
      expect(failures).toEqual([]);
    });

    it("a caption that fails leaves a line too", async () => {
      listen();
      await expect(
        captioner(replying({}, 401))(picture, live),
      ).rejects.toMatchObject({ code: "http" });
      expect(usages).toEqual([]);
      expect(failures).toEqual([
        {
          endpoint: "chat",
          model: "vision-model",
          site: "vision",
          outcome: "http",
          ms: expect.any(Number),
        },
      ]);
    });

    it("a caption paid for and then refused as empty leaves its usage, once", async () => {
      listen();
      await expect(
        captioner(replying({ ...said(""), usage: DEEPSEEK_USAGE }))(
          picture,
          live,
        ),
      ).rejects.toMatchObject({ code: "sse" });
      expect(usages).toHaveLength(1);
      expect(failures).toEqual([]);
    });

    it("an answer with no usage on it says so", async () => {
      listen();
      await captioner(replying(said("a cat")))(picture, live);
      expect(usages).toEqual([]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        outcome: "no_usage",
        site: "vision",
      });
    });
  });

  it("a failure sink that throws never reaches the call", async () => {
    setProviderFailureSink(() => {
      throw new Error("sink broke");
    });
    expect(() =>
      reportProviderFailure({
        endpoint: "chat",
        model: "m",
        outcome: "network",
        ms: 1,
      }),
    ).not.toThrow();
  });
});

describe("the process-wide sink", () => {
  const usage: ProviderUsage = {
    endpoint: "chat",
    model: "deepseek-flash",
    promptTokens: 1,
    completionTokens: 1,
    cacheHitTokens: 0,
    cacheMissTokens: 1,
  };

  it("receives reports while installed and nothing after", () => {
    const got: ProviderUsage[] = [];
    reportProviderUsage(usage); // no sink: a no-op
    setProviderUsageSink((u) => got.push(u));
    reportProviderUsage(usage);
    setProviderUsageSink(undefined);
    reportProviderUsage(usage);
    expect(got).toEqual([usage]);
  });

  it("a sink that throws never reaches the call it observes", () => {
    setProviderUsageSink(() => {
      throw new Error("disk full");
    });
    expect(() => reportProviderUsage(usage)).not.toThrow();
  });
});
