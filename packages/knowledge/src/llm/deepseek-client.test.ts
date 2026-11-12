import { describe, expect, it } from "vitest";
import { RealDeepSeekClient } from "./deepseek-client.js";
import { DeepSeekHttpError, DeepSeekShapeError } from "./types.js";

interface FakeFetchCall {
  url: string;
  init: RequestInit;
}

function makeFakeFetch(
  responses: ReadonlyArray<
    { status: number; body: unknown } | { networkError: true }
  >,
): { fetch: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  let i = 0;
  const fakeFetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[i++];
    if (r === undefined) throw new Error("fake fetch ran out of responses");
    if ("networkError" in r) {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

describe("RealDeepSeekClient", () => {
  it("posts to /v1/chat/completions with Bearer auth and json_object response_format", async () => {
    const { fetch, calls } = makeFakeFetch([
      {
        status: 200,
        body: {
          choices: [{ message: { content: '{"chunks":[]}' } }],
          model: "deepseek-chat",
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        },
      },
    ]);
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch,
    });
    const out = await client.chatJson({
      systemPrompt: "system json",
      userPayload: '{"x":1}',
      model: "deepseek-chat",
    });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c?.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(c?.init.method).toBe("POST");
    const headers = c?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-xxx");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(c?.init.body as string);
    expect(body.model).toBe("deepseek-chat");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toEqual([
      { role: "system", content: "system json" },
      { role: "user", content: '{"x":1}' },
    ]);
    expect(out.rawJsonText).toBe('{"chunks":[]}');
    expect(out.model).toBe("deepseek-chat");
    expect(out.usage?.totalTokens).toBe(30);
  });

  it("tells onUsage each call's counts, the cache split included — and a throwing observer never breaks the call (dream review 2026-09-22, finding 4)", async () => {
    const { fetch } = makeFakeFetch([
      {
        status: 200,
        body: {
          choices: [{ message: { content: "{}" } }],
          model: "deepseek-v4-pro",
          usage: {
            prompt_tokens: 4000,
            completion_tokens: 900,
            total_tokens: 4900,
            prompt_cache_hit_tokens: 3000,
            prompt_cache_miss_tokens: 1000,
          },
        },
      },
      {
        status: 200,
        body: {
          choices: [{ message: { content: "{}" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      },
    ]);
    const seen: unknown[] = [];
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-v4-pro",
      fetch,
      onUsage: (u) => {
        seen.push(u);
        throw new Error("a broken observer");
      },
    });
    const input = {
      systemPrompt: "s",
      userPayload: "{}",
      model: "deepseek-v4-pro",
    };
    await expect(client.chatJson(input)).resolves.toMatchObject({
      rawJsonText: "{}",
    });
    await client.chatJson(input);
    expect(seen).toEqual([
      {
        model: "deepseek-v4-pro",
        promptTokens: 4000,
        completionTokens: 900,
        cacheHitTokens: 3000,
        cacheMissTokens: 1000,
        // How long the call took rides the same line (review 2026-11-10).
        ms: expect.any(Number),
      },
      {
        model: "deepseek-v4-pro",
        promptTokens: 10,
        completionTokens: 5,
        cacheHitTokens: null,
        cacheMissTokens: null,
        ms: expect.any(Number),
      },
    ]);
  });

  it("throws DeepSeekHttpError on 4xx without retry", async () => {
    const { fetch, calls } = makeFakeFetch([
      { status: 401, body: { error: { message: "Unauthorized" } } },
    ]);
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch,
    });
    await expect(
      client.chatJson({
        systemPrompt: "s",
        userPayload: "{}",
        model: "deepseek-chat",
      }),
    ).rejects.toBeInstanceOf(DeepSeekHttpError);
    expect(calls).toHaveLength(1);
  });

  it("retries on 5xx and succeeds within maxRetries", async () => {
    const { fetch, calls } = makeFakeFetch([
      { status: 500, body: { error: "transient" } },
      { status: 503, body: { error: "transient" } },
      {
        status: 200,
        body: {
          choices: [{ message: { content: "{}" } }],
          model: "deepseek-chat",
        },
      },
    ]);
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch,
      maxRetries: 3,
      backoffMs: 1,
    });
    const out = await client.chatJson({
      systemPrompt: "s",
      userPayload: "{}",
      model: "deepseek-chat",
    });
    expect(calls).toHaveLength(3);
    expect(out.rawJsonText).toBe("{}");
  });

  it("retries on network error and succeeds", async () => {
    const { fetch, calls } = makeFakeFetch([
      { networkError: true },
      {
        status: 200,
        body: {
          choices: [{ message: { content: "{}" } }],
          model: "deepseek-chat",
        },
      },
    ]);
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch,
      maxRetries: 2,
      backoffMs: 1,
    });
    const out = await client.chatJson({
      systemPrompt: "s",
      userPayload: "{}",
      model: "deepseek-chat",
    });
    expect(calls).toHaveLength(2);
    expect(out.rawJsonText).toBe("{}");
  });

  it("gives up after maxRetries on persistent 5xx", async () => {
    const { fetch, calls } = makeFakeFetch([
      { status: 500, body: { error: "x" } },
      { status: 500, body: { error: "x" } },
      { status: 500, body: { error: "x" } },
    ]);
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch,
      maxRetries: 3,
      backoffMs: 1,
    });
    await expect(
      client.chatJson({
        systemPrompt: "s",
        userPayload: "{}",
        model: "deepseek-chat",
      }),
    ).rejects.toBeInstanceOf(DeepSeekHttpError);
    expect(calls).toHaveLength(3);
  });

  it("throws DeepSeekShapeError when response has no choices[0].message.content", async () => {
    const { fetch } = makeFakeFetch([
      { status: 200, body: { choices: [], model: "deepseek-chat" } },
    ]);
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch,
    });
    await expect(
      client.chatJson({
        systemPrompt: "s",
        userPayload: "{}",
        model: "deepseek-chat",
      }),
    ).rejects.toBeInstanceOf(DeepSeekShapeError);
  });

  it("API key never appears in DeepSeekHttpError body excerpt", async () => {
    const { fetch } = makeFakeFetch([
      {
        status: 401,
        body: { error: "Unauthorized: token sk-xxx-leaked-in-body" },
      },
    ]);
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx-leaked-in-body",
      model: "deepseek-chat",
      fetch,
    });
    let caught: unknown;
    try {
      await client.chatJson({
        systemPrompt: "s",
        userPayload: "{}",
        model: "deepseek-chat",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DeepSeekHttpError);
    const msg = (caught as Error).message;
    expect(msg).not.toContain("Authorization");
    expect(msg).not.toContain("Bearer ");
  });
});

describe("RealDeepSeekClient.chatJson — reasoning_effort", () => {
  it("sends thinking + reasoning_effort when reasoningEffort is set, keeps json mode", async () => {
    let sentBody: Record<string, unknown> = {};
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: "deepseek-v4-pro",
          choices: [{ message: { content: '{"ok":true}' } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new RealDeepSeekClient({
      apiKey: "k",
      model: "deepseek-v4-pro",
      fetch: fakeFetch,
    });
    const out = await client.chatJson({
      systemPrompt: "sys",
      userPayload: "u",
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
    });
    expect(out.rawJsonText).toBe('{"ok":true}');
    expect((sentBody.response_format as { type: string }).type).toBe(
      "json_object",
    );
    expect(sentBody.reasoning_effort).toBe("max");
    expect((sentBody.thinking as { type: string }).type).toBe("enabled");
  });

  it("omits thinking when reasoningEffort is unset (back-compat with existing callers)", async () => {
    let sentBody: Record<string, unknown> = {};
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: "m",
          choices: [{ message: { content: "{}" } }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await new RealDeepSeekClient({
      apiKey: "k",
      model: "m",
      fetch: fakeFetch,
    }).chatJson({ systemPrompt: "s", userPayload: "u", model: "m" });
    expect(sentBody.reasoning_effort).toBeUndefined();
    expect(sentBody.thinking).toBeUndefined();
  });
});

describe("RealDeepSeekClient — a call can be cut (review 2026-11-10, second pass)", () => {
  const ask = { systemPrompt: "s", userPayload: "{}", model: "deepseek-chat" };
  const answer = (): Response =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "{}" } }],
        model: "deepseek-chat",
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  /** A request that never answers until its signal cuts it. */
  const hanging = (seen: { calls: number }): typeof fetch =>
    ((_url: unknown, init?: RequestInit) => {
      seen.calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("cut"), { name: "AbortError" })),
        );
      });
    }) as unknown as typeof fetch;

  it("the client's signal cuts the request in flight, and it is not tried again", async () => {
    const seen = { calls: 0 };
    const cut = new AbortController();
    const failures: unknown[] = [];
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch: hanging(seen),
      maxRetries: 3,
      backoffMs: 1,
      signal: cut.signal,
      onFailure: (f) => failures.push(f),
    });
    const call = client.chatJson(ask);
    await new Promise((r) => setTimeout(r, 5));
    cut.abort();
    await expect(call).rejects.toMatchObject({ name: "AbortError" });
    expect(seen.calls).toBe(1);
    expect(failures).toEqual([
      { model: "deepseek-chat", outcome: "aborted", ms: expect.any(Number) },
    ]);
    // A client already cut makes no request at all.
    await expect(client.chatJson(ask)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(seen.calls).toBe(1);
  });

  it("the signal ends the wait between two attempts at once", async () => {
    const cut = new AbortController();
    let calls = 0;
    const failing = (async () => {
      calls += 1;
      // Cut while the client waits out its backoff.
      setTimeout(() => cut.abort(), 5);
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch: failing,
      maxRetries: 3,
      backoffMs: 60_000,
      signal: cut.signal,
    });
    const started = Date.now();
    await expect(client.chatJson(ask)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toBe(1);
  });

  it("an attempt has a deadline of its own, and one that passes it is tried again", async () => {
    const seen = { calls: 0 };
    const slowThenFine = ((url: unknown, init?: RequestInit) => {
      if (seen.calls === 0) return hanging(seen)(url as string, init);
      seen.calls += 1;
      return Promise.resolve(answer());
    }) as unknown as typeof fetch;
    const usages: { ms?: number }[] = [];
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch: slowThenFine,
      maxRetries: 2,
      backoffMs: 1,
      timeoutMs: 20,
      onUsage: (u) => usages.push(u),
    });
    const out = await client.chatJson(ask);
    expect(out.rawJsonText).toBe("{}");
    expect(seen.calls).toBe(2);
    // The usage line carries the whole call's time, the lost attempt included.
    expect(usages[0]?.ms).toBeGreaterThanOrEqual(20);
  });

  it("a call that only ever times out says so", async () => {
    const seen = { calls: 0 };
    const failures: { outcome: string }[] = [];
    const client = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch: hanging(seen),
      maxRetries: 2,
      backoffMs: 1,
      timeoutMs: 10,
      onFailure: (f) => failures.push(f),
    });
    await expect(client.chatJson(ask)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(seen.calls).toBe(2);
    expect(failures.map((f) => f.outcome)).toEqual(["timeout"]);
  });

  it("names what ended a refused call and a malformed one, and a throwing observer never breaks either", async () => {
    const outcomes: string[] = [];
    const refused = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch: (async () =>
        new Response("{}", { status: 401 })) as unknown as typeof fetch,
      onFailure: (f) => {
        outcomes.push(f.outcome);
        throw new Error("observer broke");
      },
    });
    await expect(refused.chatJson(ask)).rejects.toBeInstanceOf(
      DeepSeekHttpError,
    );
    const shapeless = new RealDeepSeekClient({
      apiKey: "sk-xxx",
      model: "deepseek-chat",
      fetch: (async () =>
        new Response("{}", { status: 200 })) as unknown as typeof fetch,
      onFailure: (f) => outcomes.push(f.outcome),
    });
    await expect(shapeless.chatJson(ask)).rejects.toThrow(/shape invalid/);
    expect(outcomes).toEqual(["http", "shape"]);
  });
});
