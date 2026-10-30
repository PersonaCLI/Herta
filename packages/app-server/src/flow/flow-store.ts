import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { WebPage } from "@herta/core";
import { redactSecrets, webPageFileName } from "@herta/tools";
import { normalizeTitle, normalizeUrl } from "./flow-text.js";
import type { FlowFailure, FlowIssue } from "./flow-types.js";

/**
 * Flow's files (ADR 0084 §10), under the app's data dir beside the session
 * transcripts, never in a workspace:
 *
 *   issues/<YYYY-MM-DD>-<n>.json   an issue: its cards and evidence
 *   pages/<issueId>/               the pages its details were read from
 *   images/<issueId>/<n>.<ext>     its pictures (§8), by card
 *   state.json                     the cadence and the unread mark
 *
 * Async fs throughout: the store runs on the desktop's main thread
 * (ADR 0068). Every write is a temp file renamed into place, so a crash
 * mid-write leaves the old file or none, never half of one.
 */

/** A picture's type and the extension it is kept under (§8): exactly the
 *  types `fetchPreviewImage` passes. The desktop serves these names only. */
export const FLOW_IMAGE_EXT: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** Seven days are kept (§1): today and the six before it. */
export const FLOW_KEEP_DAYS = 7;

/** The cadence and the unread mark (§10). */
export interface FlowStateFile {
  /** When the last issue run started, ms epoch. */
  readonly lastAttemptAt: number | null;
  /** The local date the two counts below belong to. */
  readonly day: string | null;
  /** Automatic attempts that day (at most three, §6). */
  readonly attempts: number;
  /** Manual refreshes that day (at most three, §5). */
  readonly refreshes: number;
  /** The last run's failure, until a run succeeds. */
  readonly lastFailure: {
    readonly at: number;
    readonly reason: FlowFailure;
  } | null;
  /** The issue not yet opened. */
  readonly unread: string | null;
  /** The next issue's episode number (§3). */
  readonly nextNumber: number;
}

export const EMPTY_FLOW_STATE: FlowStateFile = {
  lastAttemptAt: null,
  day: null,
  attempts: 0,
  refreshes: 0,
  lastFailure: null,
  unread: null,
  nextNumber: 1,
};

/** What the last seven issues showed: a hit matching either is not shown
 *  again (§5 step 3). */
export interface FlowSeen {
  readonly urls: ReadonlySet<string>;
  readonly titles: ReadonlySet<string>;
}

const ISSUE_FILE = /^(\d{4}-\d{2}-\d{2})-(\d+)\.json$/;
const DATED = /^(\d{4}-\d{2}-\d{2})-\d+/;

/** `YYYY-MM-DD` of a moment, in local time: an issue belongs to the
 *  Trailblazer's day, not UTC's (§1). */
export function localDateOf(ms: number): string {
  const d = new Date(ms);
  return formatDate(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The local date `days` after (or before) a `YYYY-MM-DD`. */
export function addLocalDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(y, m - 1, d + days);
  return formatDate(t.getFullYear(), t.getMonth(), t.getDate());
}

function formatDate(y: number, m0: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The oldest local date still kept on `now`'s day. */
function keepFrom(now: number): string {
  return addLocalDays(localDateOf(now), -(FLOW_KEEP_DAYS - 1));
}

function isIssue(x: unknown): x is FlowIssue {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.localDate === "string" &&
    typeof o.number === "number" &&
    (o.lang === "zh" || o.lang === "en") &&
    Array.isArray(o.cards) &&
    o.evidence !== null &&
    typeof o.evidence === "object"
  );
}

function readStateValue(raw: unknown): FlowStateFile {
  if (raw === null || typeof raw !== "object") return EMPTY_FLOW_STATE;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const f = o.lastFailure as Record<string, unknown> | null | undefined;
  return {
    lastAttemptAt: typeof o.lastAttemptAt === "number" ? o.lastAttemptAt : null,
    day: str(o.day),
    attempts: num(o.attempts, 0),
    refreshes: num(o.refreshes, 0),
    lastFailure:
      f !== null &&
      typeof f === "object" &&
      typeof f.at === "number" &&
      typeof f.reason === "string"
        ? { at: f.at, reason: f.reason as FlowFailure }
        : null,
    unread: str(o.unread),
    nextNumber: Math.max(1, Math.floor(num(o.nextNumber, 1))),
  };
}

/**
 * What a set of issues showed. A post's title is the card call's own, so
 * the source's title — the one tomorrow's hit will carry — is indexed from
 * the evidence as well. A hit that was found but not shown is not seen: it
 * may make a later issue.
 */
export function seenOf(issues: readonly FlowIssue[]): FlowSeen {
  const urls = new Set<string>();
  const titles = new Set<string>();
  const addTitle = (t: string): void => {
    const n = normalizeTitle(t);
    if (n !== "") titles.add(n);
  };
  for (const issue of issues) {
    const shown = new Set<string>();
    for (const card of issue.cards) {
      const u = normalizeUrl(card.url);
      shown.add(u);
      urls.add(u);
      addTitle(card.title);
    }
    for (const hit of issue.evidence.hits ?? []) {
      if (shown.has(normalizeUrl(hit.url))) addTitle(hit.title);
    }
  }
  return { urls, titles };
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export class FlowStore {
  readonly issuesDir: string;
  readonly pagesDir: string;
  readonly imagesDir: string;
  readonly stateFile: string;
  /** State writes in order: the trigger and the service both update it. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {
    this.issuesDir = join(dir, "issues");
    this.pagesDir = join(dir, "pages");
    this.imagesDir = join(dir, "images");
    this.stateFile = join(dir, "state.json");
  }

  async writeIssue(issue: FlowIssue): Promise<void> {
    await mkdir(this.issuesDir, { recursive: true });
    await writeAtomic(
      join(this.issuesDir, `${issue.id}.json`),
      JSON.stringify(issue),
    );
  }

  /** The issues of the last seven local days, newest first. An unreadable
   *  file is skipped, not fatal. */
  async issues(now: number): Promise<FlowIssue[]> {
    const from = keepFrom(now);
    const found = (await this.issueNames()).filter((f) => f.date >= from);
    const read = await Promise.all(
      found.map(async (f) => {
        try {
          const raw: unknown = JSON.parse(
            await readFile(join(this.issuesDir, f.name), "utf8"),
          );
          return isIssue(raw) ? raw : null;
        } catch {
          return null;
        }
      }),
    );
    return read.filter((x): x is FlowIssue => x !== null);
  }

  async hasIssueFor(localDate: string): Promise<boolean> {
    return (await this.issueNames()).some((f) => f.date === localDate);
  }

  /** `<date>-<n+1>`, n the day's issues so far: a refresh makes a new one
   *  rather than overwriting the morning's (§5). */
  async nextIssueId(localDate: string): Promise<string> {
    let n = 0;
    for (const f of await this.issueNames()) {
      if (f.date === localDate) n = Math.max(n, f.n);
    }
    return `${localDate}-${n + 1}`;
  }

  /**
   * Delete what has turned seven days old (§10): the issue with its pages
   * and images. Leftovers of a crashed write or a failed run go the same
   * way by their date. Returns the issue ids removed.
   */
  async prune(now: number): Promise<string[]> {
    const from = keepFrom(now);
    const removed: string[] = [];
    for (const name of await listDir(this.issuesDir)) {
      const date = DATED.exec(name)?.[1];
      if (date === undefined || date >= from) continue;
      await rm(join(this.issuesDir, name), { force: true });
      const m = ISSUE_FILE.exec(name);
      if (m !== null) removed.push(name.slice(0, -".json".length));
    }
    for (const base of [this.pagesDir, this.imagesDir]) {
      for (const name of await listDir(base)) {
        const date = DATED.exec(name)?.[1];
        if (date === undefined || date >= from) continue;
        await rm(join(base, name), { recursive: true, force: true });
      }
    }
    if (removed.length > 0) {
      await this.updateState((s) =>
        s.unread !== null && removed.includes(s.unread)
          ? { ...s, unread: null }
          : s,
      );
    }
    return removed;
  }

  /** A failed run's pages: it made no issue to keep them with. */
  async removeIssueFiles(issueId: string): Promise<void> {
    if (!DATED.test(issueId)) return;
    await rm(join(this.pagesDir, issueId), { recursive: true, force: true });
    await rm(join(this.imagesDir, issueId), { recursive: true, force: true });
  }

  async readState(): Promise<FlowStateFile> {
    await this.chain;
    return this.readStateNow();
  }

  /** Read, change, write — in order with every other update. A failed
   *  write leaves the file as it was and resolves to the state unchanged. */
  updateState(
    change: (s: FlowStateFile) => FlowStateFile,
  ): Promise<FlowStateFile> {
    const next = this.chain.then(async () => {
      const now = await this.readStateNow();
      const changed = change(now);
      if (changed === now) return now;
      try {
        await mkdir(this.dir, { recursive: true });
        await writeAtomic(this.stateFile, JSON.stringify(changed));
        return changed;
      } catch {
        return now;
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** The URLs and titles the last seven days' issues showed (§5 step 3). */
  async seen(now: number): Promise<FlowSeen> {
    return seenOf(await this.issues(now));
  }

  /**
   * Keep a page a detail was read from, as `web_fetch` keeps one under
   * `.herta/web/` (ADR 0080): a header of URL, title and time, then the
   * redacted Markdown. Returns its path relative to the flow dir, or null
   * when it could not be written — the detail stands without it.
   */
  async savePage(
    issueId: string,
    url: string,
    page: WebPage,
    at: Date,
  ): Promise<string | null> {
    try {
      const u = new URL(url);
      const dir = join(this.pagesDir, issueId);
      const name = webPageFileName(u);
      const title = redactSecrets(page.title);
      const header = [
        `URL: ${u.href}`,
        ...(title !== "" ? [`Title: ${title}`] : []),
        `Fetched: ${at.toISOString()}`,
        "---",
        "",
      ].join("\n\n");
      await mkdir(dir, { recursive: true });
      await writeAtomic(join(dir, name), header + redactSecrets(page.markdown));
      return `pages/${issueId}/${name}`;
    } catch {
      return null;
    }
  }

  /**
   * Keep a card's picture (§8) as `images/<issueId>/<index>.<ext>`. Returns
   * the file name, or null for a type the guard would not pass or a failed
   * write — the card stands without it.
   */
  async saveImage(
    issueId: string,
    index: number,
    bytes: Uint8Array,
    type: string,
  ): Promise<string | null> {
    const ext = FLOW_IMAGE_EXT[type.split(";")[0]?.trim().toLowerCase() ?? ""];
    if (ext === undefined) return null;
    try {
      const dir = join(this.imagesDir, issueId);
      const name = `${index}.${ext}`;
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `${name}.tmp`);
      await writeFile(tmp, bytes);
      await rename(tmp, join(dir, name));
      return name;
    } catch {
      return null;
    }
  }

  private async readStateNow(): Promise<FlowStateFile> {
    try {
      return readStateValue(JSON.parse(await readFile(this.stateFile, "utf8")));
    } catch {
      return EMPTY_FLOW_STATE;
    }
  }

  /** The issue files by date and n, newest first. */
  private async issueNames(): Promise<
    { readonly name: string; readonly date: string; readonly n: number }[]
  > {
    const out: { name: string; date: string; n: number }[] = [];
    for (const name of await listDir(this.issuesDir)) {
      const m = ISSUE_FILE.exec(name);
      if (m === null) continue;
      out.push({ name, date: m[1] as string, n: Number(m[2]) });
    }
    return out.sort((a, b) =>
      a.date === b.date ? b.n - a.n : a.date < b.date ? 1 : -1,
    );
  }
}
