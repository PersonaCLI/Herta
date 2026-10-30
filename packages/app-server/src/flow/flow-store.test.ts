import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTmpDir } from "../testing/tmp-workspace.js";
import {
  addLocalDays,
  EMPTY_FLOW_STATE,
  FlowStore,
  localDateOf,
  seenOf,
} from "./flow-store.js";
import type { FlowCard, FlowIssue } from "./flow-types.js";

/** Flow's files (ADR 0084 §10): issues, pages, images and state.json,
 *  written atomically and kept seven days. */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTmpDir(d);
});
async function store(): Promise<FlowStore> {
  const d = await mkdtemp(join(tmpdir(), "herta-flow-store-"));
  dirs.push(d);
  return new FlowStore(join(d, "flow"));
}

/** Noon, local, on a day of October 2026. */
const at = (day: number, hour = 12): number =>
  new Date(2026, 9, day, hour).getTime();

function card(url: string, title = `Title of ${url}`): FlowCard {
  return {
    url,
    site: "example.com",
    date: "2026-10-30",
    title,
    summary: "s",
    why: "",
    detail: "d",
    points: [],
    word: null,
    picture: null,
  };
}

function issue(
  id: string,
  cards: FlowCard[] = [],
  hits: { url: string; title: string }[] = [],
): FlowIssue {
  return {
    id,
    localDate: id.slice(0, 10),
    number: 1,
    lang: "zh",
    createdAt: new Date(0).toISOString(),
    cards,
    evidence: {
      queries: [],
      hits: hits.map((h) => ({
        query: 0,
        title: h.title,
        site: "x",
        date: null,
        url: h.url,
        fate: "kept" as const,
      })),
      pages: [],
      calls: { queries: 1, search: 0, cards: 0, fetch: 0, detail: 0, word: 0 },
    },
  };
}

describe("local dates", () => {
  it("are the Trailblazer's day, and step across a month", () => {
    expect(localDateOf(at(30, 0))).toBe("2026-10-30");
    expect(localDateOf(at(30, 23))).toBe("2026-10-30");
    expect(addLocalDays("2026-10-30", 2)).toBe("2026-11-01");
    expect(addLocalDays("2026-10-01", -1)).toBe("2026-09-30");
  });
});

describe("FlowStore issues", () => {
  it("writes and reads back the last seven days, newest first; a refresh is the next n", async () => {
    const s = await store();
    await s.writeIssue(issue("2026-10-28-1"));
    await s.writeIssue(issue("2026-10-30-1"));
    expect(await s.nextIssueId("2026-10-30")).toBe("2026-10-30-2");
    await s.writeIssue(issue("2026-10-30-2"));
    expect(await s.nextIssueId("2026-10-31")).toBe("2026-10-31-1");
    const got = await s.issues(at(30));
    expect(got.map((i) => i.id)).toEqual([
      "2026-10-30-2",
      "2026-10-30-1",
      "2026-10-28-1",
    ]);
    expect(await s.hasIssueFor("2026-10-30")).toBe(true);
    expect(await s.hasIssueFor("2026-10-29")).toBe(false);
  });

  it("skips an unreadable or foreign file instead of failing", async () => {
    const s = await store();
    await s.writeIssue(issue("2026-10-30-1"));
    await writeFile(join(s.issuesDir, "2026-10-29-1.json"), "{not json");
    await writeFile(join(s.issuesDir, "2026-10-28-1.json"), '{"id":3}');
    await writeFile(join(s.issuesDir, "notes.txt"), "x");
    expect((await s.issues(at(30))).map((i) => i.id)).toEqual(["2026-10-30-1"]);
  });

  it("writes through a temp file renamed into place, leaving none behind", async () => {
    const s = await store();
    // A crash mid-write left a temp file: it is not an issue.
    await mkdir(s.issuesDir, { recursive: true });
    await writeFile(join(s.issuesDir, "2026-10-30-1.json.tmp"), "{half");
    await s.writeIssue(issue("2026-10-30-1"));
    const names = await readdir(s.issuesDir);
    expect(names).toContain("2026-10-30-1.json");
    expect((await s.issues(at(30))).map((i) => i.id)).toEqual(["2026-10-30-1"]);
    await s.updateState((st) => ({ ...st, nextNumber: 4 }));
    expect(await readdir(s.dir)).not.toContain("state.json.tmp");
  });
});

describe("FlowStore prune", () => {
  it("deletes an issue seven days old with its pages and images, and keeps six", async () => {
    const s = await store();
    await s.writeIssue(issue("2026-10-23-1"));
    await s.writeIssue(issue("2026-10-24-1"));
    for (const base of [s.pagesDir, s.imagesDir]) {
      await mkdir(join(base, "2026-10-23-1"), { recursive: true });
      await writeFile(join(base, "2026-10-23-1", "a.md"), "x");
      await mkdir(join(base, "2026-10-24-1"), { recursive: true });
    }
    await mkdir(s.issuesDir, { recursive: true });
    await writeFile(join(s.issuesDir, "2026-10-20-1.json.tmp"), "x");
    await s.updateState((st) => ({ ...st, unread: "2026-10-23-1" }));

    const removed = await s.prune(at(30));
    expect(removed).toEqual(["2026-10-23-1"]);
    expect(await readdir(s.issuesDir)).toEqual(["2026-10-24-1.json"]);
    expect(await readdir(s.pagesDir)).toEqual(["2026-10-24-1"]);
    expect(await readdir(s.imagesDir)).toEqual(["2026-10-24-1"]);
    // The unread mark goes with its issue.
    expect((await s.readState()).unread).toBeNull();
    // Reads agree with the prune before it runs, too.
    expect((await s.issues(at(31))).map((i) => i.id)).toEqual([]);
  });

  it("removes a failed run's pages by its id", async () => {
    const s = await store();
    await mkdir(join(s.pagesDir, "2026-10-30-1"), { recursive: true });
    await s.removeIssueFiles("2026-10-30-1");
    await s.removeIssueFiles("../escape");
    expect(await readdir(s.pagesDir)).toEqual([]);
  });
});

describe("FlowStore state", () => {
  it("starts empty, survives a malformed file, and applies updates in order", async () => {
    const s = await store();
    expect(await s.readState()).toEqual(EMPTY_FLOW_STATE);
    await mkdir(s.dir, { recursive: true });
    await writeFile(s.stateFile, "[garbage");
    expect(await s.readState()).toEqual(EMPTY_FLOW_STATE);
    await Promise.all([
      s.updateState((st) => ({ ...st, attempts: st.attempts + 1 })),
      s.updateState((st) => ({ ...st, attempts: st.attempts + 1 })),
      s.updateState((st) => ({
        ...st,
        lastFailure: { at: 5, reason: "network" },
        unread: "2026-10-30-1",
        nextNumber: 3,
        day: "2026-10-30",
        lastAttemptAt: 9,
      })),
    ]);
    const st = await s.readState();
    expect(st).toEqual({
      lastAttemptAt: 9,
      day: "2026-10-30",
      attempts: 2,
      refreshes: 0,
      lastFailure: { at: 5, reason: "network" },
      unread: "2026-10-30-1",
      nextNumber: 3,
    });
    expect(JSON.parse(await readFile(s.stateFile, "utf8"))).toEqual(st);
  });
});

describe("the seen index", () => {
  it("holds the shown URLs, the posts' titles and their sources' titles — not hits never shown", async () => {
    const s = await store();
    await s.writeIssue(
      issue(
        "2026-10-29-1",
        [card("https://vite.dev/blog/v7/?utm_source=x", "Vite 7 发布")],
        [
          { url: "https://vite.dev/blog/v7", title: "Announcing Vite 7" },
          { url: "https://other.dev/x", title: "Never shown" },
        ],
      ),
    );
    const seen = await s.seen(at(30));
    expect(seen.urls.has("https://vite.dev/blog/v7")).toBe(true);
    expect(seen.titles.has("vite7发布")).toBe(true);
    expect(seen.titles.has("announcingvite7")).toBe(true);
    expect(seen.titles.has("nevershown")).toBe(false);
    expect(seenOf([]).urls.size).toBe(0);
  });
});

describe("savePage", () => {
  it("keeps the page as web_fetch does, redacted, under the issue", async () => {
    const s = await store();
    const rel = await s.savePage(
      "2026-10-30-1",
      "https://example.com/a",
      { title: "A page", markdown: "body sk-abcdefghijklmnopqrstu" },
      new Date(0),
    );
    expect(rel).toMatch(/^pages\/2026-10-30-1\/example\.com-[0-9a-f]{8}\.md$/);
    const text = await readFile(join(s.dir, rel as string), "utf8");
    expect(text).toContain("URL: https://example.com/a");
    expect(text).toContain("Title: A page");
    expect(text).toContain("body [REDACTED:api_key]");
    expect(
      await s.savePage(
        "2026-10-30-1",
        "not a url",
        { title: "", markdown: "" },
        new Date(0),
      ),
    ).toBeNull();
  });
});
