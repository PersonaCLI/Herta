import { FLOW_TOPIC_GROUPS } from "@herta/app-server/flow-topics";
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FlowIssueView, FlowStateView } from "../../../shared/flow.js";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { toggleTopic } from "../Settings/FlowSettings.js";
import { FlowPanel } from "./FlowPanel.js";
import { localDay } from "./flow-days.js";

/** Flow's panel (ADR 0084 §3): its states, a day's posts with her word, a
 *  post that opens in place, and the unread issue marked read. */

const today = localDay(new Date());
const ON: FlowStateView = {
  enabled: true,
  gathering: null,
  failed: null,
  unreadIssueId: null,
  refreshesLeft: 3,
};
const issue: FlowIssueView = {
  id: `${today}-1`,
  number: 7,
  localDate: today,
  lang: "en",
  posts: [
    {
      id: `${today}-1/0`,
      url: "https://nodejs.org/en/blog/release/v24",
      site: "Node.js",
      date: today,
      title: "Node.js 24 is out",
      summary: "A new major.",
      why: "Your project needs Node 22+",
      detail: "The full write-up.",
      points: ["require(esm) is stable"],
      word: "Wait a month.",
      picture: null,
    },
  ],
  evidence: { queries: ["node release"], hits: [], pages: [] },
};

function show(props: {
  state: FlowStateView;
  issues?: readonly FlowIssueView[];
  onTurnOn?: () => void;
  onMarkRead?: (id: string) => void;
  onClose?: () => void;
  onAsk?: (post: { readonly url: string }) => void;
}) {
  const mock = createMockHertaBridge();
  const flowOpenSource = vi.fn();
  Object.assign(mock.bridge, { flowOpenSource });
  const view = renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <FlowPanel
        open
        onClose={props.onClose ?? (() => undefined)}
        state={props.state}
        issues={props.issues ?? []}
        onRefresh={() => undefined}
        onMarkRead={props.onMarkRead ?? (() => undefined)}
        onTurnOn={props.onTurnOn ?? (() => undefined)}
        {...(props.onAsk !== undefined ? { onAsk: props.onAsk } : {})}
      />
    </HertaBridgeProvider>,
  );
  return { ...view, flowOpenSource };
}

describe("FlowPanel", () => {
  it("off: says what Flow does and turns it on", () => {
    const onTurnOn = vi.fn();
    const { getByText } = show({ state: { ...ON, enabled: false }, onTurnOn });
    fireEvent.click(getByText("Turn on Flow"));
    expect(onTurnOn).toHaveBeenCalledTimes(1);
  });

  it("gathering: the stage, i of n, the bar and the tracker; placeholders until the day has posts", () => {
    const { getByText, getByRole, container } = show({
      state: { ...ON, gathering: { stage: "search", i: 3, n: 8 } },
    });
    expect(getByText("Searching 3/8")).toBeTruthy();
    // Search is the second of five stages, three of eight done: 1.375 / 5.
    expect(getByRole("progressbar").getAttribute("aria-valuenow")).toBe("28");
    expect(
      [...container.querySelectorAll(".flow-gather-steps li")].map(
        (li) => li.className,
      ),
    ).toEqual(["is-done", "is-now", "", "", ""]);
    expect(container.querySelector(".flow-skeleton")).not.toBeNull();

    // With today's issue already in, a second gathering shows no placeholders.
    const again = show({
      state: { ...ON, gathering: { stage: "word", i: 1, n: 5 } },
      issues: [issue],
    });
    expect(again.container.querySelector(".flow-skeleton")).toBeNull();
  });

  it("a day's posts: the masthead's number, the tab, the post and her word", () => {
    const { getByText, getByRole, container } = show({
      state: ON,
      issues: [issue],
    });
    expect(getByText("No. 7")).toBeTruthy();
    expect(getByRole("button", { name: "Today" })).toBeTruthy();
    expect(getByText("Node.js 24 is out")).toBeTruthy();
    // Her word, whole for a reader, while it types for the eye.
    expect(container.querySelector(".flow-sr")?.textContent).toBe(
      "Wait a month.",
    );
  });

  it("a day leads with its first post; the rest are numbered rows (round 2)", () => {
    const second = {
      ...(issue.posts[0] as FlowIssueView["posts"][number]),
      id: `${today}-1/1`,
      url: "https://vite.dev/blog/vite-plus",
      title: "Vite+ 1.0",
      word: null,
    };
    const { container } = show({
      state: ON,
      issues: [{ ...issue, posts: [...issue.posts, second] }],
    });
    expect(
      container.querySelector(".flow-lead .flow-post-title")?.textContent,
    ).toBe("Node.js 24 is out");
    expect(container.querySelector(".flow-row-num")?.textContent).toBe("02");
    expect(
      container.querySelector(".flow-row .flow-post-title")?.textContent,
    ).toBe("Vite+ 1.0");
    // Her mark is the avatar image, beside her word only.
    expect(container.querySelectorAll("img.flow-word-av")).toHaveLength(1);
  });

  it("a post opens in place; Escape goes back, then closes", () => {
    const onClose = vi.fn();
    const { getByText, queryByTestId, flowOpenSource } = show({
      state: ON,
      issues: [issue],
      onClose,
    });
    fireEvent.click(getByText("Node.js 24 is out"));
    expect(queryByTestId("flow-open")).toBeTruthy();
    expect(getByText("The full write-up.")).toBeTruthy();
    fireEvent.click(getByText("View the source"));
    expect(flowOpenSource).toHaveBeenCalledWith(
      "https://nodejs.org/en/blog/release/v24",
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByTestId("flow-open")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Ask Herta hands the opened post over (§9)", () => {
    const onAsk = vi.fn();
    const { getByText } = show({ state: ON, issues: [issue], onAsk });
    fireEvent.click(getByText("Node.js 24 is out"));
    fireEvent.click(getByText("Ask Herta"));
    expect(onAsk).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://nodejs.org/en/blog/release/v24",
      }),
    );
  });

  it("the unread issue is marked read when the panel shows it", async () => {
    const onMarkRead = vi.fn();
    show({
      state: { ...ON, unreadIssueId: issue.id },
      issues: [issue],
      onMarkRead,
    });
    await waitFor(() => expect(onMarkRead).toHaveBeenCalledWith(issue.id));
  });
});

describe("Settings → Flow's topics (amendment: topics are picked)", () => {
  it("a keyword toggles in the list's own order, at most twelve", () => {
    expect(toggleTopic(["space"], "ai")).toEqual(["ai", "space"]);
    expect(toggleTopic(["ai", "space"], "ai")).toEqual(["space"]);
    const all = FLOW_TOPIC_GROUPS.flatMap((g) => g.topics.map((t) => t.id));
    const twelve = all.slice(0, 12);
    expect(toggleTopic(twelve, all[12] as string)).toBe(twelve);
  });
});
