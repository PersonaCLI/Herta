import { setUsageNoteSink, type UsageNote, WebClientError } from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { deepseekWebClient, unescapeFetchedMarkdown } from "./web-client.js";

interface Seen {
  url: string;
  body: unknown;
  auth: string | null;
}

function stubFetch(
  responses: readonly (() => Response)[],
  seen: Seen[] = [],
): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      auth: headers.get("authorization"),
    });
    const make = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return (make as () => Response)();
  }) as typeof fetch;
}

const json = (status: number, body: unknown): (() => Response) => {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
};

const signal = new AbortController().signal;

afterEach(() => setUsageNoteSink(undefined));

describe("unescapeFetchedMarkdown", () => {
  it("takes the backslash off ASCII punctuation, as the fetcher escapes it", () => {
    expect(
      unescapeFetchedMarkdown(
        "\\# Node\\.js\nimport \\{ unlinkSync \\} from \\'node\\:fs\\'\\;",
      ),
    ).toBe("# Node.js\nimport { unlinkSync } from 'node:fs';");
  });

  it("keeps a page's own backslash, which the fetcher doubled", () => {
    expect(unescapeFetchedMarkdown("C:\\\\Users\\\\x")).toBe("C:\\Users\\x");
  });

  it("leaves letters, digits and non-ASCII alone", () => {
    expect(unescapeFetchedMarkdown("\\n \\d 中文\\。")).toBe(
      "\\n \\d 中文\\。",
    );
  });
});

describe("deepseekWebClient.search", () => {
  it("posts the query with the key and maps each result", async () => {
    const seen: Seen[] = [];
    const client = deepseekWebClient({
      apiKey: "k-test",
      minIntervalMs: 0,
      fetchImpl: stubFetch(
        [
          json(200, {
            results: [
              {
                title: "update | Vitest",
                url: "https://vitest.dev/config/update",
                snippet: "short",
                summary: "# update\n- Type: boolean",
                site_name: "Vitest",
                date: "2026-02-19T16:00:00+00:00",
                rerank_score: 2.1,
                authority: 3,
              },
              { title: "no url", url: "ftp://x" },
              {
                title: "",
                url: "https://example.com/a",
                snippet: "only a snippet",
                summary: "",
                site_name: null,
                date: null,
              },
            ],
          }),
        ],
        seen,
      ),
    });
    const hits = await client.search("vitest update flag", signal);
    expect(seen[0]?.url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(seen[0]?.body).toEqual({ query: "vitest update flag", count: 8 });
    expect(seen[0]?.auth).toBe("Bearer k-test");
    expect(hits).toEqual([
      {
        title: "update | Vitest",
        url: "https://vitest.dev/config/update",
        site: "Vitest",
        date: "2026-02-19T16:00:00+00:00",
        summary: "# update\n- Type: boolean",
      },
      {
        title: "https://example.com/a",
        url: "https://example.com/a",
        site: null,
        date: null,
        summary: "only a snippet",
      },
    ]);
  });

  it("an empty result list is a success", async () => {
    const client = deepseekWebClient({
      apiKey: "k",
      minIntervalMs: 0,
      fetchImpl: stubFetch([json(200, { results: [] })]),
    });
    expect(await client.search("nothing", signal)).toEqual([]);
  });

  it("writes one usage note per call", async () => {
    const notes: UsageNote[] = [];
    setUsageNoteSink((n) => notes.push(n));
    const client = deepseekWebClient({
      apiKey: "k",
      minIntervalMs: 0,
      fetchImpl: stubFetch([json(200, { results: [] })]),
    });
    await client.search("q", signal);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: "web",
      endpoint: "search",
      ok: true,
    });
  });
});

describe("deepseekWebClient.fetchPage", () => {
  it("returns the page unescaped", async () => {
    const seen: Seen[] = [];
    const client = deepseekWebClient({
      apiKey: "k",
      minIntervalMs: 0,
      fetchImpl: stubFetch(
        [json(200, { title: "File system", content: "\\# Node\\.js docs" })],
        seen,
      ),
    });
    const page = await client.fetchPage(
      "https://nodejs.org/api/fs.html",
      signal,
    );
    expect(seen[0]?.url).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(seen[0]?.body).toEqual({ url: "https://nodejs.org/api/fs.html" });
    expect(page).toEqual({ title: "File system", markdown: "# Node.js docs" });
  });

  it.each([
    [404, "not_found"],
    [403, "rejected"],
    [402, "balance"],
    [401, "auth"],
    [400, "invalid"],
  ])("a %i fails as %s, without a retry", async (status, code) => {
    const seen: Seen[] = [];
    const notes: UsageNote[] = [];
    setUsageNoteSink((n) => notes.push(n));
    const client = deepseekWebClient({
      apiKey: "k",
      minIntervalMs: 0,
      fetchImpl: stubFetch(
        [json(status, { error: { message: "failed to fetch URL" } })],
        seen,
      ),
    });
    const err = await client
      .fetchPage("https://example.com/", signal)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebClientError);
    expect((err as WebClientError).code).toBe(code);
    expect(seen).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: "web",
      endpoint: "fetch",
      ok: false,
    });
  });

  it("retries a 429 once, then fails as unavailable", async () => {
    const seen: Seen[] = [];
    const client = deepseekWebClient({
      apiKey: "k",
      minIntervalMs: 0,
      fetchImpl: stubFetch(
        [json(429, { error: { message: "slow down" } })],
        seen,
      ),
    });
    const err = await client
      .fetchPage("https://example.com/", signal)
      .catch((e: unknown) => e);
    expect((err as WebClientError).code).toBe("unavailable");
    expect(seen).toHaveLength(2);
  });

  it("a 5xx then a page succeeds on the retry", async () => {
    const client = deepseekWebClient({
      apiKey: "k",
      minIntervalMs: 0,
      fetchImpl: stubFetch([
        json(503, { error: { message: "busy" } }),
        json(200, { title: "", content: "ok" }),
      ]),
    });
    expect(await client.fetchPage("https://example.com/", signal)).toEqual({
      title: "",
      markdown: "ok",
    });
  });

  it("a page with no text is not found, not an empty page", async () => {
    const client = deepseekWebClient({
      apiKey: "k",
      minIntervalMs: 0,
      fetchImpl: stubFetch([json(200, { title: "x", content: "  " })]),
    });
    const err = await client
      .fetchPage("https://example.com/", signal)
      .catch((e: unknown) => e);
    expect((err as WebClientError).code).toBe("not_found");
  });

  it("rethrows an abort", async () => {
    const ac = new AbortController();
    ac.abort();
    const client = deepseekWebClient({
      apiKey: "k",
      minIntervalMs: 0,
      fetchImpl: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        return json(200, { title: "", content: "x" })();
      }) as typeof fetch,
    });
    const err = await client
      .fetchPage("https://example.com/", ac.signal)
      .catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
  });

  it("spaces calls to the same endpoint under the account's 5 a second", async () => {
    const starts: number[] = [];
    const client = deepseekWebClient({
      apiKey: "k",
      baseUrl: "https://spacing.test",
      minIntervalMs: 50,
      fetchImpl: (async () => {
        starts.push(Date.now());
        return json(200, { results: [] })();
      }) as typeof fetch,
    });
    await Promise.all([
      client.search("a", signal),
      client.search("b", signal),
      client.search("c", signal),
    ]);
    expect(starts).toHaveLength(3);
    const sorted = [...starts].sort((a, b) => a - b);
    expect(
      (sorted[2] as number) - (sorted[0] as number),
    ).toBeGreaterThanOrEqual(90);
  });
});
