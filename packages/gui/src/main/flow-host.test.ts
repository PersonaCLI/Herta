import { join } from "node:path";
import type { FlowIssue, FlowSettings, FlowStatus } from "@herta/app-server";
import { describe, expect, it, vi } from "vitest";
import { CMD, EVT } from "../preload/channels.js";
import {
  createFlowHost,
  type FlowLike,
  flowIssueView,
  flowStateView,
  recentWorkspaces,
} from "./flow-host.js";
import { resolveFlowImage } from "./flow-protocol.js";

/** Flow in the desktop's main (ADR 0084): the panel's shapes, the doors
 *  it opens, and the picture scheme's guard. */

const ON: FlowSettings = { enabled: true, topics: ["ai"] };
const IDLE: FlowStatus = {
  running: false,
  stage: null,
  unread: null,
  lastAttemptAt: null,
  lastFailure: null,
  refreshesLeft: 3,
};

const issue: FlowIssue = {
  id: "2026-10-30-1",
  localDate: "2026-10-30",
  number: 4,
  lang: "zh",
  createdAt: "2026-10-30T01:00:00.000Z",
  cards: [
    {
      url: "https://nodejs.org/en/blog/release/v24",
      site: "Node.js",
      date: "2026-10-29T08:00:00Z",
      title: "Node 24",
      summary: "s",
      why: "w",
      detail: "d",
      points: ["p"],
      word: "行。",
      picture: "0.png",
    },
    {
      url: "https://example.com/x",
      site: "Example",
      date: "",
      title: "X",
      summary: "s",
      why: "",
      detail: "d",
      points: [],
      word: null,
      picture: null,
    },
  ],
  evidence: {
    queries: [{ text: "node release", from: "model", hits: 8, failure: null }],
    hits: [],
    pages: [
      {
        url: "https://nodejs.org/en/blog/release/v24",
        ok: true,
        title: "t",
        chars: 10,
        file: null,
        failure: null,
      },
      {
        url: "https://example.com/x",
        ok: false,
        title: "",
        chars: 0,
        file: null,
        failure: "timeout",
      },
    ],
    calls: { queries: 1, search: 1, cards: 1, fetch: 2, detail: 1, word: 1 },
  },
};

describe("the panel's shapes", () => {
  it("an issue: pictures as herta-flow URLs, a day from the date, pages that were read", () => {
    const v = flowIssueView(issue);
    expect(v.posts[0]).toMatchObject({
      id: "2026-10-30-1/0",
      date: "2026-10-29",
      picture: "herta-flow://image/2026-10-30-1/0.png",
      word: "行。",
    });
    expect(v.posts[1]).toMatchObject({ date: null, picture: null, word: null });
    expect(v.evidence).toEqual({
      queries: ["node release"],
      hits: [],
      pages: ["https://nodejs.org/en/blog/release/v24"],
    });
  });

  it("the state: no key is said before any attempt; the service's error is 'other'", () => {
    expect(flowStateView(IDLE, ON, false).failed).toBe("no_key");
    expect(flowStateView(IDLE, { ...ON, enabled: false }, false).failed).toBe(
      null,
    );
    expect(
      flowStateView(
        { ...IDLE, lastFailure: { at: 1, reason: "error" } },
        ON,
        true,
      ).failed,
    ).toBe("other");
    expect(
      flowStateView(
        { ...IDLE, running: true, stage: { stage: "search", i: 2, n: 8 } },
        ON,
        true,
      ).gathering,
    ).toEqual({ stage: "search", i: 2, n: 8 });
    expect(flowStateView(null, ON, true)).toEqual({
      enabled: true,
      gathering: null,
      failed: null,
      unreadIssueId: null,
      refreshesLeft: 3,
    });
  });

  it("recent workspaces: the last two weeks, most recent first, each once", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const row = (ws: string, ago: number) => ({
      sessionId: `${ws}${ago}`,
      workspaceRoot: ws,
      startedAt: "",
      lastActivityAt: new Date(now - ago * day).toISOString(),
    });
    const host = {
      listSessions: vi.fn(() => [
        row("/a", 3),
        row("/b", 1),
        row("/a", 2),
        row("/old", 20),
      ]),
    };
    expect(recentWorkspaces(host as never, now)).toEqual(["/b", "/a"]);
    expect(host.listSessions).toHaveBeenCalledWith({
      workspaceRoot: null,
      limit: 60,
    });
    expect(recentWorkspaces(null, now)).toEqual([]);
  });
});

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function harness(settings: unknown = ON) {
  const handlers = new Map<string, Handler>();
  const sent: { channel: string; payload: unknown }[] = [];
  const opened: string[] = [];
  const written: FlowSettings[] = [];
  const service: FlowLike = {
    start: vi.fn(),
    tick: vi.fn(async () => "started" as const),
    refresh: vi.fn(async () => "limit" as const),
    issues: vi.fn(async () => [issue]),
    markRead: vi.fn(async () => IDLE),
    state: vi.fn(async () => IDLE),
    dispose: vi.fn(async () => undefined),
  };
  const host = createFlowHost({
    dir: join("x", "flow"),
    host: () => null,
    apiKey: () => "sk-test",
    lang: () => "zh",
    readSettings: async () => settings,
    writeSettings: async (next) => {
      written.push(next);
    },
    send: (channel, payload) => sent.push({ channel, payload }),
    openExternal: async (url) => {
      opened.push(url);
    },
    service: () => service,
  });
  host.register(((channel: string, listener: Handler) =>
    handlers.set(channel, listener)) as never);
  const call = (channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)?.(null, ...args));
  return { host, service, sent, opened, written, call };
}

describe("Flow's doors", () => {
  it("a source opens only when it is a kept post's", async () => {
    const h = harness();
    expect(await h.call(CMD.flowOpenSource, "https://evil.example/")).toBe(
      false,
    );
    expect(await h.call(CMD.flowOpenSource, 42)).toBe(false);
    expect(
      await h.call(
        CMD.flowOpenSource,
        "https://nodejs.org/en/blog/release/v24",
      ),
    ).toBe(true);
    expect(h.opened).toEqual(["https://nodejs.org/en/blog/release/v24"]);
  });

  it("settings are normalized and kept; turning Flow on ticks at once", async () => {
    const h = harness({ enabled: false });
    await h.host.start();
    expect(await h.call(CMD.flowSettings)).toMatchObject({ enabled: false });
    const saved = await h.call(CMD.flowSetSettings, {
      enabled: true,
      topics: ["space", "space", "nope", "ai"],
    });
    expect(saved).toEqual({ enabled: true, topics: ["space", "ai"] });
    expect(h.written).toHaveLength(1);
    expect(h.service.tick).toHaveBeenCalledTimes(1);
    expect(h.sent.at(-1)?.channel).toBe(EVT.flow);
  });

  it("refresh says what it did; a marked issue clears", async () => {
    const h = harness();
    expect(await h.call(CMD.flowRefresh)).toBe("limit");
    await h.call(CMD.flowMarkRead, "2026-10-30-1");
    expect(h.service.markRead).toHaveBeenCalledWith("2026-10-30-1");
    await h.call(CMD.flowMarkRead, { not: "an id" });
    expect(h.service.markRead).toHaveBeenCalledTimes(1);
  });
});

describe("the picture scheme (§8)", () => {
  const dir = join("data", "flow");
  it("serves an issue's picture by id and name", () => {
    expect(
      resolveFlowImage("herta-flow://image/2026-10-30-1/0.png", dir),
    ).toEqual({
      file: join(dir, "images", "2026-10-30-1", "0.png"),
      type: "image/png",
    });
    expect(
      resolveFlowImage("herta-flow://image/2026-10-30-12/4.jpg", dir)?.type,
    ).toBe("image/jpeg");
  });

  it("refuses anything that names a path, another host or another type", () => {
    for (const url of [
      "herta-flow://image/../state.json",
      "herta-flow://image/2026-10-30-1/../../state.json",
      "herta-flow://image/2026-10-30-1/%2e%2e%2fx.png",
      "herta-flow://pages/2026-10-30-1/0.png",
      "herta-flow://image/2026-10-30-1/0.svg",
      "herta-flow://image/2026-10-30-1/0.png?x=1",
      "herta-flow://image/2026-10-30-1/sub/0.png",
      "herta-attachment://image/2026-10-30-1/0.png",
      "not a url",
    ]) {
      expect(resolveFlowImage(url, dir), url).toBeNull();
    }
  });
});
