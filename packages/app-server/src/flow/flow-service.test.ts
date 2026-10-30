import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  abortError,
  type WebClient,
  WebClientError,
  type WebSearchHit,
} from "@herta/core";
import type { DigestModel } from "@herta/tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTmpDir } from "../testing/tmp-workspace.js";
import { FlowService, type FlowServiceOptions } from "./flow-service.js";
import type { FlowEvent, FlowSettings } from "./flow-types.js";

/** Flow for its host (ADR 0084): a tick runs one issue and tells the host;
 *  refresh makes the day's next; the panel marks it read. */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTmpDir(d);
});

const at = (day: number, hour: number): number =>
  new Date(2026, 9, day, hour).getTime();

const ON: FlowSettings = { enabled: true, topics: ["ai"] };

function hit(url: string, hoursOld = 3, now = at(30, 9)): WebSearchHit {
  return {
    title: `Title of ${url}`,
    url,
    site: "Example",
    date: new Date(now - hoursOld * 60 * 60 * 1000).toISOString(),
    summary: `What ${url} says.`,
  };
}

async function setup(over: Partial<FlowServiceOptions> = {}) {
  const base = await mkdtemp(join(tmpdir(), "herta-flow-svc-"));
  dirs.push(base);
  const ws = join(base, "acme-login");
  await mkdir(ws, { recursive: true });
  await writeFile(
    join(ws, "package.json"),
    JSON.stringify({ dependencies: { vite: "6" } }),
  );
  const clock = { t: at(30, 9) };
  const events: FlowEvent[] = [];
  let n = 0;
  const web: WebClient = {
    // A new page each search, so a refresh has something unseen to show.
    search: vi.fn(async () => {
      n += 1;
      return [hit(`https://news.dev/${n}`, 3, clock.t)];
    }),
    fetchPage: vi.fn(async (url: string) => ({
      title: "Page",
      markdown: `Body of ${url}.`,
    })),
  };
  const model: DigestModel = async ({ system, user }) => {
    if (/search queries|搜索词/.test(system)) {
      return '{"queries": ["Rust news"]}';
    }
    if (/choose the news|挑选新闻/.test(system)) {
      const url = /https:\/\/news\.dev\/\d+/.exec(user)?.[0] ?? "";
      return JSON.stringify({
        cards: [
          { url, title: "Rust 2.0", summary: "It shipped.", why: "Rust" },
        ],
      });
    }
    return '{"detail": "The write-up.", "points": ["A point"]}';
  };
  const service = new FlowService({
    dir: join(base, "flow"),
    settings: () => ON,
    hasKey: () => true,
    isBusy: () => false,
    webClient: () => web,
    sideModel: () => model,
    word: async (post) => `${post.title}? Fine.`,
    workspaceRoots: async () => [ws],
    lang: () => "en",
    onChange: (e) => events.push(e),
    now: () => clock.t,
    // Never the network from a test.
    picture: async () => null,
    ...over,
  });
  return { service, events, clock, web, base, flowDir: join(base, "flow") };
}

describe("FlowService", () => {
  it("keeps a card's picture beside its issue, and none of a type it cannot serve (§8)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { service, flowDir } = await setup({
      picture: async () => ({ bytes: png, type: "image/png" }),
    });
    await service.tick();
    await service.idle();
    const [issue] = await service.issues();
    expect(issue?.cards[0]?.picture).toBe("0.png");
    expect(await readdir(join(flowDir, "images", "2026-10-30-1"))).toEqual([
      "0.png",
    ]);

    const other = await setup({
      picture: async () => ({ bytes: png, type: "image/svg+xml" }),
    });
    await other.service.tick();
    await other.service.idle();
    const [plain] = await other.service.issues();
    expect(plain?.cards[0]?.picture).toBeNull();
  });

  it("a tick runs one issue, stores it and tells the host", async () => {
    const { service, events, flowDir } = await setup();
    expect(await service.tick()).toBe("started");
    await service.idle();

    const issues = await service.issues();
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue).toMatchObject({
      id: "2026-10-30-1",
      localDate: "2026-10-30",
      number: 1,
      lang: "en",
    });
    expect(issue?.cards).toHaveLength(1);
    expect(issue?.cards[0]).toMatchObject({
      title: "Rust 2.0",
      word: "Rust 2.0? Fine.",
      detail: "The write-up.",
    });
    expect(issue?.evidence.pages[0]?.file).toMatch(/^pages\/2026-10-30-1\//);
    expect(await readdir(join(flowDir, "pages"))).toEqual(["2026-10-30-1"]);

    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("state");
    expect(kinds).toContain("stage");
    expect(kinds.slice(-2)).toEqual(["landed", "state"]);
    expect(events.find((e) => e.kind === "landed")).toEqual({
      kind: "landed",
      issueId: "2026-10-30-1",
      cards: 1,
    });
    const first = events[0];
    expect(first?.kind === "state" && first.status.running).toBe(true);
    const last = events.at(-1);
    expect(last?.kind === "state" && last.status).toMatchObject({
      running: false,
      stage: null,
      unread: "2026-10-30-1",
      lastFailure: null,
    });

    // Today is done: the next tick starts nothing.
    expect(await service.tick()).toBe("done_today");
    await service.dispose();
  });

  it("refresh makes the day's next issue and the next episode", async () => {
    const { service } = await setup();
    await service.tick();
    await service.idle();
    expect(await service.refresh()).toBe("started");
    await service.idle();
    const issues = await service.issues();
    expect(issues.map((i) => [i.id, i.number])).toEqual([
      ["2026-10-30-2", 2],
      ["2026-10-30-1", 1],
    ]);
    const st = await service.state();
    expect(st.unread).toBe("2026-10-30-2");
    expect(st.refreshesLeft).toBe(2);
    await service.dispose();
  });

  it("markRead clears the dot, but not for an issue that landed since", async () => {
    const { service, events } = await setup();
    await service.tick();
    await service.idle();
    expect((await service.markRead("2026-10-29-1")).unread).toBe(
      "2026-10-30-1",
    );
    const st = await service.markRead("2026-10-30-1");
    expect(st.unread).toBeNull();
    expect(events.at(-1)).toEqual({ kind: "state", status: st });
    await service.dispose();
  });

  it("a failed run emits its reason, keeps no pages and backs off", async () => {
    const { service, events, flowDir } = await setup({
      webClient: () => ({
        search: async () => {
          throw new WebClientError("balance", "402", 402);
        },
        fetchPage: async () => ({ title: "", markdown: "" }),
      }),
    });
    await service.tick();
    await service.idle();
    expect(events).toContainEqual({ kind: "failed", reason: "balance" });
    expect(await service.issues()).toEqual([]);
    const st = await service.state();
    expect(st.lastFailure?.reason).toBe("balance");
    expect(await service.tick()).toBe("backoff");
    await expect(readdir(join(flowDir, "issues"))).rejects.toThrow();
    await service.dispose();
  });

  it("prunes an issue seven days old at a tick, even with Flow off", async () => {
    const settings = { now: ON };
    const { service, clock, flowDir, events } = await setup({
      settings: () => settings.now,
    });
    await service.tick();
    await service.idle();
    expect(await readdir(join(flowDir, "issues"))).toEqual([
      "2026-10-30-1.json",
    ]);

    settings.now = { ...ON, enabled: false };
    clock.t = at(30, 9) + 7 * 24 * 60 * 60 * 1000;
    expect(await service.tick()).toBe("off");
    expect(await readdir(join(flowDir, "issues"))).toEqual([]);
    expect(await readdir(join(flowDir, "pages"))).toEqual([]);
    const last = events.at(-1);
    expect(last?.kind === "state" && last.status.unread).toBeNull();
    await service.dispose();
  });

  it("dispose aborts the run in flight without a failure or an event", async () => {
    // Her word waits until the run is aborted: the run is mid-flight.
    const waiting = { now: false };
    const { service, events } = await setup({
      word: (_post, signal) =>
        new Promise((_r, reject) => {
          waiting.now = true;
          signal.addEventListener("abort", () => reject(abortError()));
        }),
    });
    await service.tick();
    while (!waiting.now) await new Promise((r) => setTimeout(r, 5));
    expect((await service.state()).running).toBe(true);
    const before = events.length;
    await service.dispose();
    expect(events.length).toBe(before);
    expect(await service.issues()).toEqual([]);
    expect((await service.state()).lastFailure).toBeNull();
    expect(await service.tick()).toBe("off");
  });
});
