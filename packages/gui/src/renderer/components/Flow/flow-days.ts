import type { FlowIssueView, FlowPostView } from "../../../shared/flow.js";

/** A post with the issue it came in. */
export interface FlowDayPost extends FlowPostView {
  readonly issueId: string;
}

/** One day tab: every post of that local day's issues, newest issue first
 *  (a refresh makes a second issue for the same day, ADR 0084 §6). */
export interface FlowDay {
  readonly localDate: string;
  readonly posts: readonly FlowDayPost[];
  readonly issueIds: readonly string[];
}

/** Days with an issue, newest first; a day with none has no tab (§3). */
export function flowDays(issues: readonly FlowIssueView[]): FlowDay[] {
  const byDay = new Map<string, FlowIssueView[]>();
  for (const issue of issues) {
    const list = byDay.get(issue.localDate) ?? [];
    list.push(issue);
    byDay.set(issue.localDate, list);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([localDate, list]) => {
      const newest = [...list].sort((a, b) => b.number - a.number);
      return {
        localDate,
        issueIds: newest.map((i) => i.id),
        posts: newest.flatMap((i) =>
          i.posts.map((p) => ({ ...p, issueId: i.id })),
        ),
      };
    });
}

/** The newest issue's episode number, for the masthead. */
export function latestNumber(issues: readonly FlowIssueView[]): number | null {
  let n: number | null = null;
  for (const i of issues) if (n === null || i.number > n) n = i.number;
  return n;
}

/** A local day as `YYYY-MM-DD`. */
export function localDay(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** What a day's tab says: today, yesterday, or its weekday (0 = Sunday). */
export type DayLabel =
  | { readonly kind: "today" }
  | { readonly kind: "yesterday" }
  | { readonly kind: "weekday"; readonly weekday: number };

export function dayLabel(localDate: string, today: string): DayLabel {
  if (localDate === today) return { kind: "today" };
  const t = parseDay(today);
  const d = parseDay(localDate);
  const yesterday = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1);
  if (localDay(yesterday) === localDate) return { kind: "yesterday" };
  return { kind: "weekday", weekday: d.getDay() };
}

/** A day's month and date in the UI's language (10月30日 / Oct 30), from
 *  the platform's own calendar data rather than a catalog pattern. */
export function dayText(localDate: string, locale: "zh" | "en"): string {
  return parseDay(localDate).toLocaleDateString(
    locale === "zh" ? "zh-CN" : "en-US",
    { month: "short", day: "numeric" },
  );
}

function parseDay(localDate: string): Date {
  const [y = 1970, m = 1, d = 1] = localDate.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** A post's site mark: its first letters, two at most. */
export function siteMark(site: string): string {
  const words = site
    .replace(/^www\./i, "")
    .split(/[\s.\-_/]+/)
    .filter(Boolean);
  if (words.length >= 2)
    return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  return (words[0] ?? site).slice(0, 2).toUpperCase();
}

/** A stable hue per site, for its mark and its cover. */
export function siteHue(site: string): number {
  let h = 0;
  for (const c of site) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
