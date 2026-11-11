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

/** Between a prune finding something expired and a prune deleting it (see
 *  `prune`). Under a day, so an app opened at the same hour each morning
 *  finds yesterday's mark due. */
export const FLOW_PRUNE_CONFIRM_MS = 20 * 60 * 60 * 1000;

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
  /** What a prune last found expired, and when by the clock: everything
   *  dated before `from`. Absent until a prune has marked (see `prune`). */
  readonly pruneMark?: { readonly from: string; readonly at: number };
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

const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const rowsOf = (
  v: unknown,
  ok: (r: Record<string, unknown>) => boolean,
): boolean => Array.isArray(v) && v.every((r) => isObj(r) && ok(r));

/** Every field the panel reads, to its type. A card missing its `word` or
 *  `points` crashed the workbench when Flow opened, and a bad `evidence`
 *  failed the whole list (the 0.1.10 review): such a file is skipped. */
function isCard(c: Record<string, unknown>): boolean {
  return (
    isStr(c.url) &&
    isStr(c.site) &&
    isStr(c.date) &&
    isStr(c.title) &&
    isStr(c.summary) &&
    isStr(c.why) &&
    isStr(c.detail) &&
    Array.isArray(c.points) &&
    c.points.every(isStr) &&
    (c.word === null || isStr(c.word)) &&
    (c.picture === null || isStr(c.picture))
  );
}

function isEvidence(e: unknown): boolean {
  return (
    isObj(e) &&
    rowsOf(e.queries, (q) => isStr(q.text)) &&
    rowsOf(
      e.hits,
      (h) =>
        isStr(h.title) &&
        isStr(h.site) &&
        isStr(h.url) &&
        isStr(h.fate) &&
        (h.date === null || isStr(h.date)),
    ) &&
    rowsOf(e.pages, (p) => isStr(p.url) && typeof p.ok === "boolean") &&
    isObj(e.calls)
  );
}

function isIssue(x: unknown): x is FlowIssue {
  if (!isObj(x)) return false;
  return (
    isStr(x.id) &&
    isStr(x.localDate) &&
    typeof x.number === "number" &&
    (x.lang === "zh" || x.lang === "en") &&
    rowsOf(x.cards, isCard) &&
    isEvidence(x.evidence)
  );
}

function readStateValue(raw: unknown): FlowStateFile {
  if (raw === null || typeof raw !== "object") return EMPTY_FLOW_STATE;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const f = o.lastFailure as Record<string, unknown> | null | undefined;
  const p = o.pruneMark as Record<string, unknown> | null | undefined;
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
    ...(p !== null &&
    typeof p === "object" &&
    typeof p.from === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(p.from) &&
    typeof p.at === "number" &&
    Number.isFinite(p.at)
      ? { pruneMark: { from: p.from, at: p.at } }
      : {}),
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
   * Delete what has been seven days old for most of a day (§10): the issue
   * with its pages and images. Leftovers of a crashed write or a failed run
   * go the same way by their date. Returns the issue ids removed.
   *
   * Not at first sight (review 2026-11-10, second pass). "Seven days old" is
   * the machine's clock, and a clock set a week ahead for one tick emptied
   * the store for good. What a prune finds expired it marks in state.json,
   * and a prune `FLOW_PRUNE_CONFIRM_MS` later deletes what that mark named
   * and the clock still does. A mark from the future (the clock was set
   * back) names nothing. The panel is as it was: `issues` shows seven days
   * by the clock, so an expired issue leaves the list at once and the disk
   * a day later. A clock that stays wrong for a day still deletes.
   */
  async prune(now: number): Promise<string[]> {
    const from = keepFrom(now);
    const bases = [this.issuesDir, this.pagesDir, this.imagesDir];
    const listed = await Promise.all(bases.map(listDir));
    const datedBefore = (name: string, date: string): boolean => {
      const d = DATED.exec(name)?.[1];
      return d !== undefined && d < date;
    };
    if (!listed.some((names) => names.some((n) => datedBefore(n, from)))) {
      return [];
    }
    const held = (await this.readState()).pruneMark;
    const mark = held !== undefined && held.at <= now ? held : undefined;
    // Due: what the mark named, as far as the clock still agrees.
    const before =
      mark !== undefined && now - mark.at >= FLOW_PRUNE_CONFIRM_MS
        ? mark.from < from
          ? mark.from
          : from
        : undefined;
    const removed: string[] = [];
    let waiting = false;
    for (const [i, names] of listed.entries()) {
      const base = bases[i] as string;
      for (const name of names) {
        if (!datedBefore(name, from)) continue;
        if (before === undefined || !datedBefore(name, before)) {
          waiting = true;
          continue;
        }
        await rm(join(base, name), { recursive: true, force: true });
        if (base === this.issuesDir && ISSUE_FILE.test(name)) {
          removed.push(name.slice(0, -".json".length));
        }
      }
    }
    // What is still expired waits from now. A mark not yet due stands: it
    // is consumed first, and the next one names the rest.
    const remark = waiting && (mark === undefined || before !== undefined);
    if (removed.length > 0 || remark) {
      await this.updateState((st) => ({
        ...st,
        ...(st.unread !== null && removed.includes(st.unread)
          ? { unread: null }
          : {}),
        ...(remark ? { pruneMark: { from, at: now } } : {}),
      }));
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
  async updateState(
    change: (s: FlowStateFile) => FlowStateFile,
  ): Promise<FlowStateFile> {
    return (await this.changeState(change)).state;
  }

  /** As `updateState`, resolving to whether the change reached the disk.
   *  The trigger starts a run only once its attempt is recorded: a write
   *  that failed silently left every daily cap open, a paid issue each
   *  tick (the 0.1.10 review). */
  async commitState(
    change: (s: FlowStateFile) => FlowStateFile,
  ): Promise<boolean> {
    return (await this.changeState(change)).saved;
  }

  private changeState(
    change: (s: FlowStateFile) => FlowStateFile,
  ): Promise<{ readonly state: FlowStateFile; readonly saved: boolean }> {
    const next = this.chain.then(async () => {
      const now = await this.readStateNow();
      const changed = change(now);
      if (changed === now) return { state: now, saved: true };
      try {
        await mkdir(this.dir, { recursive: true });
        await writeAtomic(this.stateFile, JSON.stringify(changed));
        return { state: changed, saved: true };
      } catch {
        return { state: now, saved: false };
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
