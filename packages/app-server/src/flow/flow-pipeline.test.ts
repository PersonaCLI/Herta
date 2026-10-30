import {
  abortError,
  type WebClient,
  WebClientError,
  type WebPage,
  type WebSearchHit,
} from "@herta/core";
import type { DigestModel } from "@herta/tools";
import { describe, expect, it, vi } from "vitest";
import type { FlowInterests } from "./flow-interests.js";
import {
  checkQueries,
  FLOW_LIMITS,
  type FlowPipelineDeps,
  type FlowWord,
  fallbackQueries,
  inIssueLanguage,
  runFlowIssue,
} from "./flow-pipeline.js";
import type { FlowStageInfo } from "./flow-types.js";

/** The gathering pipeline (ADR 0084 §5): fixed stages, a fixed budget,
 *  every model output a shape code checks. Fakes only. */

const NOW = new Date(2026, 9, 30, 12).getTime();
const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number): string => new Date(NOW - h * HOUR).toISOString();

const INTERESTS: FlowInterests = {
  named: ["Rust", "LLM inference"],
  notes: "",
};

function hit(url: string, over: Partial<WebSearchHit> = {}): WebSearchHit {
  return {
    title: `Title of ${url}`,
    url,
    site: "Example",
    date: hoursAgo(5),
    summary: `What ${url} says.`,
    ...over,
  };
}

type Answer<T> = T | Error | ((arg: string) => T | Error);
const answer = <T>(a: Answer<T>, arg: string): T => {
  const v = typeof a === "function" ? (a as (x: string) => T | Error)(arg) : a;
  if (v instanceof Error) throw v;
  return v;
};

class FakeWeb implements WebClient {
  readonly searched: string[] = [];
  readonly fetched: string[] = [];
  constructor(
    private readonly results: Answer<readonly WebSearchHit[]>,
    private readonly pages: Answer<WebPage> = (url) => ({
      title: `Page ${url}`,
      markdown: `# Page\n\nThe body of ${url}.`,
    }),
  ) {}
  async search(query: string): Promise<readonly WebSearchHit[]> {
    this.searched.push(query);
    return answer(this.results, query);
  }
  async fetchPage(url: string): Promise<WebPage> {
    this.fetched.push(url);
    return answer(this.pages, url);
  }
}

type Kind = "queries" | "cards" | "detail";
const kindOf = (system: string): Kind =>
  /search queries|搜索词/.test(system)
    ? "queries"
    : /choose the news|挑选新闻/.test(system)
      ? "cards"
      : "detail";

/** A side model answering each kind of call from its own queue; the last
 *  answer repeats. Every call is recorded. */
function fakeModel(replies: Partial<Record<Kind, Answer<string>[]>>) {
  const calls: { kind: Kind; system: string; user: string }[] = [];
  const queues: Record<Kind, Answer<string>[]> = {
    queries: replies.queries ?? ['{"queries": ["Rust news", "Vite release"]}'],
    cards: replies.cards ?? ['{"cards": []}'],
    detail: replies.detail ?? [
      '{"detail": "A write-up of the page.", "points": ["One point"]}',
    ],
  };
  const model: DigestModel = async ({ system, user }) => {
    const kind = kindOf(system);
    calls.push({ kind, system, user });
    const q = queues[kind];
    const next = q.length > 1 ? q.shift() : q[0];
    return answer(next as Answer<string>, user);
  };
  const count = (k: Kind) => calls.filter((c) => c.kind === k).length;
  return { model, calls, count };
}

const cardsJson = (
  cards: Partial<{
    url: string;
    title: string;
    summary: string;
    why: string;
  }>[],
): string =>
  JSON.stringify({
    cards: cards.map((c, i) => ({
      title: `Card ${i + 1}`,
      summary: `Summary ${i + 1}.`,
      why: "you use vite",
      ...c,
    })),
  });

function deps(
  over: Partial<FlowPipelineDeps> & {
    readonly web: WebClient;
    readonly model: DigestModel;
  },
): FlowPipelineDeps {
  return {
    interests: INTERESTS,
    seen: { urls: new Set(), titles: new Set() },
    recentTitles: [],
    now: () => NOW,
    lang: "en",
    ...over,
  };
}

const run = (d: FlowPipelineDeps, signal = new AbortController().signal) =>
  runFlowIssue(d, signal);

describe("runFlowIssue — a whole issue", () => {
  it("runs the stages in order and writes checked cards with her word", async () => {
    const web = new FakeWeb((q) =>
      q === "Rust news"
        ? [hit("https://blog.rust-lang.org/a")]
        : [hit("https://vite.dev/blog/v7")],
    );
    const m = fakeModel({
      cards: [
        cardsJson([
          { url: "https://blog.rust-lang.org/a", title: "Rust 1.99" },
          { url: "https://vite.dev/blog/v7", title: "Vite 7" },
        ]),
      ],
    });
    const stages: FlowStageInfo[] = [];
    const word = vi.fn<FlowWord>(async (post) => `On ${post.title}.`);
    const res = await run(
      deps({ web, model: m.model, word, onStage: (s) => stages.push(s) }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cards.map((c) => [c.title, c.word])).toEqual([
      ["Rust 1.99", "On Rust 1.99."],
      ["Vite 7", "On Vite 7."],
    ]);
    expect(res.cards[0]).toMatchObject({
      url: "https://blog.rust-lang.org/a",
      site: "Example",
      detail: "A write-up of the page.",
      points: ["One point"],
      picture: null,
    });
    expect(word).toHaveBeenCalledWith(
      {
        title: "Rust 1.99",
        site: "Example",
        date: hoursAgo(5),
        summary: "Summary 1.",
        why: "you use vite",
      },
      expect.any(AbortSignal),
      "en",
    );
    expect(stages).toEqual([
      { stage: "queries" },
      { stage: "search", i: 1, n: 2 },
      { stage: "search", i: 2, n: 2 },
      { stage: "cards" },
      { stage: "detail", i: 1, n: 2 },
      { stage: "detail", i: 2, n: 2 },
      { stage: "word", i: 1, n: 2 },
      { stage: "word", i: 2, n: 2 },
    ]);
    expect(res.evidence.calls).toEqual({
      queries: 1,
      search: 2,
      cards: 1,
      fetch: 2,
      detail: 2,
      word: 2,
    });
    expect(res.evidence.queries.map((q) => [q.text, q.from, q.hits])).toEqual([
      ["Rust news", "model", 1],
      ["Vite release", "model", 1],
    ]);
    expect(res.evidence.pages.every((p) => p.ok)).toBe(true);
  });

  it("is 'no interests' when no source has anything, before any call", async () => {
    const web = new FakeWeb([]);
    const m = fakeModel({});
    const res = await run(
      deps({
        web,
        model: m.model,
        interests: { named: [], notes: " " },
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: "no_interests" });
    expect(m.calls).toHaveLength(0);
  });
});

describe("runFlowIssue — the hits (§5 step 3)", () => {
  it("drops stale, undated, future, seen and duplicate hits, and says why", async () => {
    const web = new FakeWeb([
      hit("https://a.dev/fresh"),
      hit("https://a.dev/stale", { date: hoursAgo(73) }),
      hit("https://a.dev/undated", { date: null }),
      hit("https://a.dev/garbled", { date: "last week" }),
      hit("https://a.dev/future", { date: hoursAgo(-30) }),
      hit("https://a.dev/seen-url"),
      hit("https://a.dev/seen-title", { title: "Already Shown!" }),
      hit("https://a.dev/fresh/#dup"),
      hit("https://mirror.dev/x", { title: "Title of https://a.dev/fresh" }),
    ]);
    const m = fakeModel({ queries: ['{"queries": ["one"]}'] });
    const res = await run(
      deps({
        web,
        model: m.model,
        seen: {
          urls: new Set(["https://a.dev/seen-url"]),
          titles: new Set(["alreadyshown"]),
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.evidence.hits.map((h) => [h.url, h.fate])).toEqual([
      ["https://a.dev/fresh", "kept"],
      ["https://a.dev/stale", "stale"],
      ["https://a.dev/undated", "undated"],
      ["https://a.dev/garbled", "undated"],
      ["https://a.dev/future", "undated"],
      ["https://a.dev/seen-url", "seen"],
      ["https://a.dev/seen-title", "seen"],
      ["https://a.dev/fresh/#dup", "duplicate"],
      ["https://mirror.dev/x", "duplicate"],
    ]);
    const cardsCall = m.calls.find((c) => c.kind === "cards");
    expect(cardsCall?.user).toContain("https://a.dev/fresh");
    expect(cardsCall?.user).not.toContain("https://a.dev/stale");
    expect(cardsCall?.user).not.toContain("seen-url");
  });

  it("sends at most thirty hits on", async () => {
    const web = new FakeWeb((q) =>
      Array.from({ length: 8 }, (_, i) => hit(`https://${q}.dev/${i}`)),
    );
    const m = fakeModel({
      queries: ['{"queries": ["a", "b", "c", "d", "e"]}'],
    });
    const res = await run(deps({ web, model: m.model }));
    const fates = res.evidence.hits.map((h) => h.fate);
    expect(fates.filter((f) => f === "kept")).toHaveLength(FLOW_LIMITS.hits);
    expect(fates.filter((f) => f === "over_budget")).toHaveLength(10);
  });

  it("is a valid 'nothing new' when no hit is left: no card call, no cards", async () => {
    const web = new FakeWeb([
      hit("https://a.dev/old", { date: hoursAgo(100) }),
    ]);
    const m = fakeModel({});
    const res = await run(deps({ web, model: m.model }));
    expect(res).toMatchObject({ ok: true, cards: [] });
    expect(m.count("cards")).toBe(0);
  });
});

describe("runFlowIssue — the cards (§5 step 4)", () => {
  it("drops a card whose URL is not a hit's, and takes date and site from the hit", async () => {
    const web = new FakeWeb([
      hit("https://vite.dev/blog/v7", {
        site: "766974656a73",
        date: hoursAgo(2),
      }),
    ]);
    const m = fakeModel({
      cards: [
        cardsJson([
          { url: "https://invented.example/news" },
          // A trailing slash and a utm tag still name the hit.
          { url: "https://vite.dev/blog/v7/?utm_source=ds" },
        ]),
      ],
    });
    const res = await run(deps({ web, model: m.model }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cards).toHaveLength(1);
    expect(res.cards[0]).toMatchObject({
      url: "https://vite.dev/blog/v7",
      site: "vitejs",
      date: hoursAgo(2),
    });
    expect(web.fetched).toEqual(["https://vite.dev/blog/v7"]);
  });

  it("caps every field, strips Markdown and HTML, makes mentions inert and redacts", async () => {
    const web = new FakeWeb([hit("https://a.dev/x")]);
    const m = fakeModel({
      cards: [
        cardsJson([
          {
            url: "https://a.dev/x",
            title: `**Big** [news](https://evil.example) ${"t".repeat(200)}`,
            summary: `<b>Ask</b> @板砖 or @brick; key sk-abcdefghijklmnopqrstu ${"s".repeat(400)}`,
            why: "w".repeat(200),
          },
        ]),
      ],
      detail: [
        JSON.stringify({
          detail: `## Heading\n\n${"d".repeat(3000)}`,
          points: Array.from(
            { length: 9 },
            (_, i) => `${i} ${"p".repeat(100)}`,
          ),
        }),
      ],
    });
    const res = await run(deps({ web, model: m.model }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = res.cards[0];
    expect(c).toBeDefined();
    if (c === undefined) return;
    expect(c.title.startsWith("Big news t")).toBe(true);
    expect(c.title).not.toMatch(/[*[\]()]|evil/);
    expect(Array.from(c.title).length).toBeLessThanOrEqual(FLOW_LIMITS.title);
    expect(c.summary).toContain("Ask @​板砖 or @​brick");
    expect(c.summary).toContain("[REDACTED:api_key]");
    expect(c.summary).not.toContain("<b>");
    expect(Array.from(c.summary).length).toBeLessThanOrEqual(
      FLOW_LIMITS.summary,
    );
    expect(Array.from(c.why).length).toBeLessThanOrEqual(FLOW_LIMITS.why);
    expect(c.detail.startsWith("### Heading\n\nddd")).toBe(true);
    expect(Array.from(c.detail).length).toBeLessThanOrEqual(FLOW_LIMITS.detail);
    expect(c.points).toHaveLength(FLOW_LIMITS.points);
    for (const p of c.points) {
      expect(Array.from(p).length).toBeLessThanOrEqual(FLOW_LIMITS.point);
    }
  });

  it("never names the app HERTA in a why-line: the prompt says so and code backs it", async () => {
    const web = new FakeWeb([hit("https://electronjs.org/blog/43")]);
    const m = fakeModel({
      cards: [
        cardsJson([
          {
            url: "https://electronjs.org/blog/43",
            why: "你的 HERTA 跑在 Electron 43 上",
          },
        ]),
      ],
    });
    const res = await run(
      deps({
        web,
        model: m.model,
        lang: "zh",
        interests: INTERESTS,
      }),
    );
    expect(res.ok && res.cards[0]?.why).toBe("你的项目 跑在 Electron 43 上");
    const prompt = m.calls.find((c) => c.kind === "cards");
    expect(prompt?.system).toContain("不要把它叫作 HERTA");
    expect(prompt?.system).toContain("优先选择中文或英文来源");
    // The picked topics, never a workspace (owner 2026-10-30).
    expect(prompt?.user).toContain("读者选的主题：\n- Rust\n- LLM inference");
    expect(prompt?.user).not.toContain("HERTA");
  });

  it("asks for English or the issue's language, and never HERTA, in English too", async () => {
    const web = new FakeWeb([hit("https://a.dev/x")]);
    const m = fakeModel({});
    await run(deps({ web, model: m.model }));
    const sys = m.calls.find((c) => c.kind === "cards")?.system ?? "";
    expect(sys).toContain("Prefer sources written in English");
    expect(sys).toContain("never call it HERTA or Herta");
    expect(sys).toContain('"your project"');
  });

  it("is a thin day when few cards come back: never padded", async () => {
    const web = new FakeWeb([
      hit("https://a.dev/1"),
      hit("https://a.dev/2"),
      hit("https://a.dev/3"),
    ]);
    const m = fakeModel({ cards: [cardsJson([{ url: "https://a.dev/2" }])] });
    const res = await run(deps({ web, model: m.model }));
    expect(res.ok && res.cards.map((c) => c.url)).toEqual(["https://a.dev/2"]);
  });

  it("writes up the post's own story, not the whole roundup it sits in", async () => {
    const web = new FakeWeb([hit("https://news.dev/morning")]);
    const m = fakeModel({
      cards: [
        cardsJson([
          {
            url: "https://news.dev/morning",
            title: "Genie 4 builds worlds",
            summary: "DeepMind's world model.",
          },
        ]),
      ],
    });
    await run(deps({ web, model: m.model }));
    const call = m.calls.find((c) => c.kind === "detail");
    expect(call?.user).toContain("This post: Genie 4 builds worlds");
    expect(call?.user).toContain("Summary: DeepMind's world model.");
    expect(call?.user).toContain("Page title: Page https://news.dev/morning");
    expect(call?.system).toContain("roundup of several stories");
  });

  it("takes an empty list as 'nothing new', not a failure", async () => {
    const web = new FakeWeb([hit("https://a.dev/1")]);
    const m = fakeModel({ cards: ['{"cards": []}'] });
    const res = await run(deps({ web, model: m.model }));
    expect(res).toMatchObject({ ok: true, cards: [] });
    expect(m.count("cards")).toBe(1);
  });

  it("retries a card call once — unparseable, or every card failing its checks — then fails", async () => {
    const web = new FakeWeb([hit("https://a.dev/1")]);
    const retried = fakeModel({
      cards: [
        cardsJson([{ url: "https://invented.example/" }]),
        cardsJson([{ url: "https://a.dev/1" }]),
      ],
    });
    const ok = await run(deps({ web, model: retried.model }));
    expect(ok.ok && ok.cards).toHaveLength(1);
    expect(retried.count("cards")).toBe(2);

    const broken = fakeModel({ cards: ["not json", "still not json"] });
    const res = await run(deps({ web, model: broken.model }));
    expect(res).toMatchObject({ ok: false, reason: "error" });
    expect(broken.count("cards")).toBe(2);
  });

  it("calls a card failure 'network' when the network was what failed", async () => {
    const web = new FakeWeb([hit("https://a.dev/1")]);
    const net = Object.assign(new Error("fetch failed"), { code: "network" });
    const m = fakeModel({ cards: [net] });
    const res = await run(deps({ web, model: m.model }));
    expect(res).toMatchObject({ ok: false, reason: "network" });
  });
});

describe("runFlowIssue — queries (§5 step 1)", () => {
  it("checks each query: length, URL, secret, duplicate, at most eight", () => {
    expect(
      checkQueries([
        "Vite 7 release",
        "vite 7 release",
        "x".repeat(101),
        "see https://vite.dev",
        "www.example.com news",
        "github.com/vitejs/vite releases",
        "token sk-abcdefghijklmnopqrstu",
        "DEEPSEEK_API_KEY=abc",
        42,
        "Node.js 24",
        "  ",
      ]),
    ).toEqual(["Vite 7 release", "Node.js 24"]);
    expect(
      checkQueries(Array.from({ length: 12 }, (_, i) => `topic ${i}`)),
    ).toHaveLength(FLOW_LIMITS.queries);
  });

  it("takes out a year that is not this one; a name with a year in it stays", () => {
    const oct = new Date(2026, 9, 30, 12).getTime();
    expect(
      checkQueries(
        [
          "biome release notes 2025",
          "TypeScript news October 2026",
          "ES2024 features",
          "2025",
        ],
        oct,
      ),
    ).toEqual([
      "biome release notes",
      "TypeScript news October 2026",
      "ES2024 features",
    ]);
    // Three days into January, last year's news is still fresh.
    const jan = new Date(2027, 0, 2, 12).getTime();
    expect(checkQueries(["Vitest 2026 recap", "Vitest 2025"], jan)).toEqual([
      "Vitest 2026 recap",
      "Vitest",
    ]);
  });

  it("tells the query call today's date, and the run's year survives its check", async () => {
    const web = new FakeWeb([]);
    const m = fakeModel({
      queries: ['{"queries": ["Biome release 2019", "Rust news"]}'],
    });
    const res = await run(deps({ web, model: m.model }));
    const system = m.calls.find((c) => c.kind === "queries")?.system ?? "";
    const today = new Date(NOW);
    expect(system).toContain(
      `Today is ${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`,
    );
    expect(system).toContain("no version number");
    expect(res.evidence.queries.map((q) => q.text)).toEqual([
      "Biome release",
      "Rust news",
    ]);
  });

  it("falls back to deterministic queries after the model's fail twice", async () => {
    expect(fallbackQueries(INTERESTS, "en")).toEqual([
      "Rust news",
      "LLM inference news",
    ]);
    expect(fallbackQueries(INTERESTS, "zh")[0]).toBe("Rust 最新动态");

    const web = new FakeWeb([]);
    const m = fakeModel({
      queries: ['{"queries": ["https://x.dev/a"]}', new Error("boom")],
    });
    const res = await run(deps({ web, model: m.model }));
    expect(m.count("queries")).toBe(2);
    expect(res.evidence.queries.map((q) => [q.text, q.from])).toEqual([
      ["Rust news", "fallback"],
      ["LLM inference news", "fallback"],
    ]);
    expect(web.searched).toHaveLength(2);
  });

  it("fails when neither the model nor the interests give a query", async () => {
    const web = new FakeWeb([]);
    const m = fakeModel({ queries: ["{}"] });
    const res = await run(
      deps({
        web,
        model: m.model,
        interests: { named: [], notes: "Likes Rust." },
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: "error" });
    expect(web.searched).toHaveLength(0);
  });
});

describe("runFlowIssue — the budget", () => {
  it("never exceeds eight searches, five cards, five fetches, seven side calls", async () => {
    const web = new FakeWeb((q) => [hit(`https://news.dev/${q}`)]);
    const twelve = Array.from({ length: 12 }, (_, i) => `q${i}`);
    const m = fakeModel({
      queries: [JSON.stringify({ queries: twelve })],
      cards: [
        cardsJson(
          Array.from({ length: 8 }, (_, i) => ({
            url: `https://news.dev/q${i}`,
          })),
        ),
      ],
    });
    const word = vi.fn<FlowWord>(async () => "Hm.");
    const res = await run(deps({ web, model: m.model, word }));
    expect(web.searched).toHaveLength(FLOW_LIMITS.queries);
    expect(res.ok && res.cards).toHaveLength(FLOW_LIMITS.cards);
    expect(web.fetched).toHaveLength(FLOW_LIMITS.fetches);
    expect(m.calls).toHaveLength(7);
    expect(word).toHaveBeenCalledTimes(5);
  });

  it("retries each side call at most once: fourteen calls at the very worst", async () => {
    const web = new FakeWeb((q) => [hit(`https://news.dev/${q}`)]);
    const m = fakeModel({
      queries: ["nope", JSON.stringify({ queries: ["a", "b", "c", "d", "e"] })],
      cards: [
        "nope",
        cardsJson(
          ["a", "b", "c", "d", "e"].map((q) => ({
            url: `https://news.dev/${q}`,
          })),
        ),
      ],
      detail: ["nope"],
    });
    const res = await run(deps({ web, model: m.model }));
    expect(m.count("queries")).toBe(2);
    expect(m.count("cards")).toBe(2);
    expect(m.count("detail")).toBe(10);
    expect(m.calls.length).toBeLessThanOrEqual(2 * 7);
    // A write-up that failed twice is the card's own summary: in the
    // issue's language, where the hit's may be in any.
    expect(res.ok && res.cards[0]?.detail).toBe("Summary 1.");
  });
});

describe("runFlowIssue — the pages (§5 step 5)", () => {
  it("falls back to the card's own summary when the fetch fails, with no detail call", async () => {
    const web = new FakeWeb(
      [hit("https://a.dev/pdf", { summary: "The **hit's** summary." })],
      () => new WebClientError("not_found", "a PDF"),
    );
    const m = fakeModel({ cards: [cardsJson([{ url: "https://a.dev/pdf" }])] });
    const res = await run(deps({ web, model: m.model }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cards[0]).toMatchObject({
      detail: res.cards[0]?.summary,
      points: [],
    });
    expect(res.cards[0]?.detail).not.toContain("hit's");
    expect(res.evidence.pages).toEqual([
      {
        url: "https://a.dev/pdf",
        ok: false,
        title: "",
        chars: 0,
        file: null,
        failure: "not_found",
      },
    ]);
    expect(m.count("detail")).toBe(0);
  });

  it("keeps the page through savePage and records where", async () => {
    const web = new FakeWeb([hit("https://a.dev/x")]);
    const m = fakeModel({ cards: [cardsJson([{ url: "https://a.dev/x" }])] });
    const savePage = vi.fn(async () => "pages/2026-10-30-1/a.dev-1234abcd.md");
    const res = await run(deps({ web, model: m.model, savePage }));
    expect(savePage).toHaveBeenCalledWith("https://a.dev/x", {
      title: "Page https://a.dev/x",
      markdown: "# Page\n\nThe body of https://a.dev/x.",
    });
    expect(res.evidence.pages[0]?.file).toBe(
      "pages/2026-10-30-1/a.dev-1234abcd.md",
    );
  });
});

describe("runFlowIssue — failures that end the issue", () => {
  it("stops at once on 'balance' from a search", async () => {
    const web = new FakeWeb(() => new WebClientError("balance", "402", 402));
    const m = fakeModel({});
    const res = await run(deps({ web, model: m.model }));
    expect(res).toMatchObject({ ok: false, reason: "balance" });
    expect(web.searched).toHaveLength(1);
    expect(res.evidence.queries[0]?.failure).toBe("balance");
  });

  it("stops on 'auth' from a fetch, and on a 402 from the side model", async () => {
    const web = new FakeWeb(
      [hit("https://a.dev/x")],
      () => new WebClientError("auth", "401", 401),
    );
    const m = fakeModel({ cards: [cardsJson([{ url: "https://a.dev/x" }])] });
    expect(await run(deps({ web, model: m.model }))).toMatchObject({
      ok: false,
      reason: "auth",
    });

    const broke = Object.assign(new Error("Payment Required"), { status: 402 });
    const m2 = fakeModel({ queries: [broke] });
    const res = await run(deps({ web: new FakeWeb([]), model: m2.model }));
    expect(res).toMatchObject({ ok: false, reason: "balance" });
    expect(m2.count("queries")).toBe(1);
  });

  it("is 'network' when every search was unavailable, 'error' when refused otherwise", async () => {
    const down = new FakeWeb(() => new WebClientError("unavailable", "503"));
    expect(
      await run(deps({ web: down, model: fakeModel({}).model })),
    ).toMatchObject({ ok: false, reason: "network" });
    const refused = new FakeWeb(() => new WebClientError("invalid", "400"));
    expect(
      await run(deps({ web: refused, model: fakeModel({}).model })),
    ).toMatchObject({ ok: false, reason: "error" });
  });

  it("goes on when some searches fail", async () => {
    const web = new FakeWeb((q) =>
      q === "Rust news"
        ? new WebClientError("unavailable", "503")
        : [hit("https://vite.dev/x")],
    );
    const m = fakeModel({
      cards: [cardsJson([{ url: "https://vite.dev/x" }])],
    });
    const res = await run(deps({ web, model: m.model }));
    expect(res.ok && res.cards).toHaveLength(1);
    expect(res.evidence.queries[0]?.failure).toBe("unavailable");
  });

  it("is 'aborted' when the signal fires", async () => {
    const ac = new AbortController();
    const web = new FakeWeb(() => {
      ac.abort();
      return abortError();
    });
    const res = await run(deps({ web, model: fakeModel({}).model }), ac.signal);
    expect(res).toMatchObject({ ok: false, reason: "aborted" });
  });
});

describe("runFlowIssue — her word (§7)", () => {
  const oneCard = () => {
    const web = new FakeWeb([hit("https://a.dev/x")]);
    const m = fakeModel({ cards: [cardsJson([{ url: "https://a.dev/x" }])] });
    return { web, m };
  };

  it("leaves the word null when she has none, or her completion throws", async () => {
    const a = oneCard();
    const none = await run(
      deps({ web: a.web, model: a.m.model, word: async () => null }),
    );
    expect(none.ok && none.cards[0]?.word).toBeNull();
    const b = oneCard();
    const threw = await run(
      deps({
        web: b.web,
        model: b.m.model,
        word: async () => {
          throw new Error("provider down");
        },
      }),
    );
    expect(threw.ok && threw.cards[0]?.word).toBeNull();
    expect(threw.ok && threw.cards).toHaveLength(1);
  });

  it("ends the issue when her completion is aborted", async () => {
    const { web, m } = oneCard();
    const ac = new AbortController();
    const res = await run(
      deps({
        web,
        model: m.model,
        word: async () => {
          ac.abort();
          throw abortError();
        },
      }),
      ac.signal,
    );
    expect(res).toMatchObject({ ok: false, reason: "aborted" });
  });

  it("shows her word as she said it, with mentions inert and secrets redacted", async () => {
    const { web, m } = oneCard();
    const res = await run(
      deps({
        web,
        model: m.model,
        word: async () => "  @板砖 sk-abcdefghijklmnopqrstu 不看。 ",
      }),
    );
    expect(res.ok && res.cards[0]?.word).toBe(
      "@​板砖 [REDACTED:api_key] 不看。",
    );
  });
});

describe("a write-up in the issue's language", () => {
  it("zh wants more Han than Hangul and kana; en more Latin than those", () => {
    expect(inIssueLanguage("GitHub 发布了 Copilot Fusion。", "zh")).toBe(true);
    expect(
      inIssueLanguage("깃허브가 '코파일럿 프로젝트'를 공개했다.", "zh"),
    ).toBe(false);
    expect(inIssueLanguage("GitHub shipped Copilot Fusion.", "en")).toBe(true);
    expect(inIssueLanguage("GitHub 发布了新的代理编排系统。", "en")).toBe(
      false,
    );
  });
});
