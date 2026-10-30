import { describe, expect, it } from "vitest";
import type { FlowIssueView } from "../../../shared/flow.js";
import {
  dayLabel,
  dayText,
  flowDays,
  latestNumber,
  localDay,
  siteHue,
  siteMark,
} from "./flow-days.js";

/** Flow's day tabs (ADR 0084 §3, the owner's pick in the tuner). */

const post = (id: string) => ({
  id,
  url: `https://x.example/${id}`,
  site: "Node.js",
  date: "2026-10-29",
  title: id,
  summary: "s",
  why: "w",
  detail: "d",
  points: [],
  word: null,
  picture: null,
});
const issue = (
  id: string,
  localDate: string,
  number: number,
  ids: string[],
): FlowIssueView => ({
  id,
  number,
  localDate,
  lang: "zh",
  posts: ids.map(post),
  evidence: { queries: [], hits: [], pages: [] },
});

describe("day tabs", () => {
  it("one per day with an issue, newest first; a refresh's issue leads its day", () => {
    const days = flowDays([
      issue("2026-10-28-1", "2026-10-28", 10, ["a"]),
      issue("2026-10-30-1", "2026-10-30", 12, ["b", "c"]),
      issue("2026-10-30-2", "2026-10-30", 13, ["d"]),
    ]);
    expect(days.map((d) => d.localDate)).toEqual(["2026-10-30", "2026-10-28"]);
    expect(days[0]?.posts.map((p) => p.id)).toEqual(["d", "b", "c"]);
    expect(days[0]?.posts[0]?.issueId).toBe("2026-10-30-2");
    expect(
      latestNumber([
        issue("x", "2026-10-30", 12, []),
        issue("y", "2026-10-30", 13, []),
      ]),
    ).toBe(13);
    expect(latestNumber([])).toBeNull();
  });

  it("today, yesterday, then weekdays", () => {
    expect(dayLabel("2026-10-30", "2026-10-30")).toEqual({ kind: "today" });
    expect(dayLabel("2026-10-29", "2026-10-30")).toEqual({ kind: "yesterday" });
    expect(dayLabel("2026-10-27", "2026-10-30")).toEqual({
      kind: "weekday",
      weekday: 2,
    });
    // across a month's edge
    expect(dayLabel("2026-10-31", "2026-11-01")).toEqual({ kind: "yesterday" });
  });

  it("dates under the dividers, and the local day", () => {
    expect(dayText("2026-10-30", "en")).toBe("Oct 30");
    expect(dayText("2026-10-03", "zh")).toBe("10月3日");
    expect(localDay(new Date(2026, 9, 3))).toBe("2026-10-03");
  });

  it("a site's mark and hue are stable", () => {
    expect(siteMark("The Next Web")).toBe("TN");
    expect(siteMark("Node.js")).toBe("NJ");
    expect(siteMark("GitHub")).toBe("GI");
    expect(siteHue("GitHub")).toBe(siteHue("GitHub"));
  });
});
