import type { CommitDescription, RepoContextSnapshot } from "@herta/app-server";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import { createMockHertaBridge } from "../../ipc/mock-bridge.js";
import { getHoverTip, hideHoverTip } from "../common/hover-tip.js";
import { FileViewerPanel } from "../FileViewer/FileViewerPanel.js";
import { FileViewerProvider } from "../FileViewer/file-viewer-context.js";
import { CARD_ROW_LEAVE_MS } from "./card-motion.js";
import { dirtyMark, RepoCard } from "./RepoCard.js";
import { REPO_FOCUS_REFRESH_MIN_MS } from "./useRepoCard.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The app's tip an element raises (focus shows it at once), or undefined
 *  when it raises none. */
function tipOf(el: Element | null | undefined): string | undefined {
  if (el === null || el === undefined) return undefined;
  act(() => {
    fireEvent.focusIn(el);
  });
  const text = getHoverTip()?.text;
  act(() => {
    hideHoverTip();
  });
  return text;
}

/** jsdom lays nothing out: give an element the widths of text cut off. */
function clip(el: Element | null | undefined): void {
  if (el === null || el === undefined) return;
  Object.defineProperty(el, "scrollWidth", { value: 300, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: 120, configurable: true });
}

const SNAPSHOT = {
  sessionId: "s1",
  workspaceRoot: "/r",
  record: [],
  overlay: null,
  backendWorkspace: "/repo",
  backendWorkspaceIsDefault: false,
} as const;

const REPO: RepoContextSnapshot = {
  root: "E:/repo",
  prefix: "",
  gitDir: "E:/repo/.git",
  branch: "feat/repo-card",
  detached: false,
  headShort: "a1b2c3d",
  upstream: "origin/feat/repo-card",
  ahead: 2,
  behind: 1,
  upstreamGone: false,
  defaultBranch: "main",
  inProgress: null,
  conflicted: [],
  dirty: [
    { x: " ", y: "M", path: "packages/gui/src/renderer/RepoCard.tsx" },
    { x: "A", y: " ", path: "docs/adr/0058.md" },
    { x: "?", y: "?", path: "scratch.txt" },
  ],
  dirtyTotal: 3,
  recentSubjects: [
    "a1b2c3d feat(gui): the rail shows the repository",
    "0f0f0f0 docs: ADR 0058",
    "9999999 chore: seed",
  ],
  recentCommits: [
    {
      sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      shortSha: "a1b2c3d",
      subject: "feat(gui): the rail shows the repository",
      unpushed: true,
    },
    {
      sha: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
      shortSha: "0f0f0f0",
      subject: "docs: ADR 0058",
      unpushed: true,
    },
    {
      sha: "9999999999999999999999999999999999999999",
      shortSha: "9999999",
      subject: "chore: seed",
      unpushed: false,
    },
  ],
};

function mount(withViewer = false) {
  const mock = createMockHertaBridge();
  const bridge = withViewer
    ? {
        ...mock.bridge,
        readWorkspaceFile: async () => ({ ok: true as const, text: "" }),
      }
    : mock.bridge;
  const card = <RepoCard />;
  const rendered = renderWithLocale(
    <HertaBridgeProvider bridge={bridge as typeof mock.bridge}>
      {withViewer ? <FileViewerProvider>{card}</FileViewerProvider> : card}
    </HertaBridgeProvider>,
    { locale: "zh" },
  );
  act(() => {
    mock.emitReset(SNAPSHOT);
  });
  return { mock, ...rendered };
}

describe("RepoCard (ADR 0058)", () => {
  it("is absent until the session's workspace answers as a repository, then slides in with branch, upstream, ↑↓, the dirty rows and the last commit", () => {
    const { mock, container } = mount();
    expect(container.querySelector(".repo-card")).toBeNull();
    act(() => {
      mock.emitRepo({ kind: "repo", workspace: "/repo", repo: REPO });
    });
    const card = container.querySelector(".repo-card");
    expect(card?.classList.contains("is-open")).toBe(true);
    expect(card?.textContent).toContain("feat/repo-card");
    expect(card?.textContent).toContain("origin/feat/repo-card");
    expect(card?.querySelector(".repo-card__delta")?.textContent).toBe("↑2 ↓1");
    expect(card?.querySelector(".plan-card__count")?.textContent).toBe(
      "3 处改动",
    );
    const rows =
      card?.querySelectorAll(".repo-card__list .repo-card__row") ?? [];
    expect(rows.length).toBe(3);
    expect(rows[0]?.querySelector(".plan-card__mark")?.textContent).toBe("M");
    expect(rows[1]?.querySelector(".plan-card__mark")?.textContent).toBe("A");
    expect(rows[2]?.querySelector(".plan-card__mark")?.textContent).toBe("?");
    expect(rows[2]?.classList.contains("is-untracked")).toBe(true);
    // The recent commits, id as the mark, subject as the text (ADR 0058 §5.4).
    const log = [...(card?.querySelectorAll(".repo-card__log-row") ?? [])];
    expect(
      log.map((r) => r.querySelector(".repo-card__sha")?.textContent),
    ).toEqual(["a1b2c3d", "0f0f0f0", "9999999"]);
    expect(log[0]?.querySelector(".repo-card__subject")?.textContent).toBe(
      "feat(gui): the rail shows the repository",
    );
    expect(card?.querySelector(".repo-card__section")?.textContent).toBe(
      "最近提交",
    );
    // The two commits not on the upstream carry the mark (ADR 0058 §5.6).
    expect(log.map((r) => r.classList.contains("is-unpushed"))).toEqual([
      true,
      true,
      false,
    ]);
    expect(log[0]?.querySelector(".repo-card__unpushed")?.textContent).toBe(
      "↑",
    );
    // Without a file-reading bridge the paths and subjects are plain spans,
    // and there is no history opener.
    expect(card?.querySelector("button.repo-card__path")).toBeNull();
    expect(card?.querySelector(".repo-card__all")).toBeNull();
  });

  it("rows that arrive enter and rows that leave stay for the exit, then drop (ADR 0058 §5.7)", () => {
    vi.useFakeTimers();
    const { mock, container } = mount();
    act(() => {
      mock.emitRepo({ kind: "repo", workspace: "/repo", repo: REPO });
    });
    // The first answer: settled rows, no entrance.
    expect(container.querySelector(".repo-card__row.is-entering")).toBeNull();
    act(() => {
      mock.emitRepo({
        kind: "repo",
        workspace: "/repo",
        repo: {
          ...REPO,
          dirty: [
            { x: " ", y: "M", path: "packages/gui/src/renderer/RepoCard.tsx" },
            { x: " ", y: "M", path: "src/fresh.ts" },
          ],
          dirtyTotal: 2,
        },
      });
    });
    const rows = [
      ...container.querySelectorAll(".repo-card__list .repo-card__row"),
    ];
    expect(
      rows.map((r) => [
        r.querySelector(".repo-card__path")?.textContent,
        r.classList.contains("is-entering"),
        r.classList.contains("is-leaving"),
      ]),
    ).toEqual([
      ["packages/gui/src/renderer/RepoCard.tsx", false, false],
      ["docs/adr/0058.md", false, true],
      ["scratch.txt", false, true],
      ["src/fresh.ts", true, false],
    ]);
    act(() => {
      vi.advanceTimersByTime(CARD_ROW_LEAVE_MS + 5);
    });
    expect(
      [...container.querySelectorAll(".repo-card__list .repo-card__row")].map(
        (r) => r.querySelector(".repo-card__path")?.textContent,
      ),
    ).toEqual(["packages/gui/src/renderer/RepoCard.tsx", "src/fresh.ts"]);
    // The header's count swapped in place rather than repainting.
    expect(
      container.querySelector(".repo-card__count .swap-text"),
    ).not.toBeNull();
  });

  it("the list's label opens the full history where the bridge reads it (ADR 0059 §6)", async () => {
    const mock = createMockHertaBridge();
    const readWorkspaceLog = vi.fn(async () => ({
      ok: true as const,
      page: {
        entries: [
          {
            sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
            shortSha: "a1b2c3d",
            subject: "feat(gui): the rail shows the repository",
            author: "Tester",
            authoredAt: "2026-09-07T10:00:00+08:00",
            unpushed: true,
          },
        ],
        skip: 0,
        hasMore: false,
        upstream: "origin/main",
      },
    }));
    Object.assign(mock.bridge, {
      readWorkspaceFile: async () => ({ ok: false, reason: "not_found" }),
      readWorkspaceLog,
    });
    const rendered = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <FileViewerProvider>
          <RepoCard />
          <FileViewerPanel />
        </FileViewerProvider>
      </HertaBridgeProvider>,
      { locale: "zh" },
    );
    act(() => {
      mock.emitReset(SNAPSHOT);
      mock.emitRepo({ kind: "repo", workspace: "/repo", repo: REPO });
    });
    const all = rendered.container.querySelector("button.repo-card__all");
    expect(all?.textContent).toBe("全部");
    fireEvent.click(all as Element);
    await waitFor(() =>
      expect(readWorkspaceLog).toHaveBeenCalledWith("s1", {
        skip: 0,
        limit: 50,
      }),
    );
    await waitFor(() =>
      expect(
        rendered.container
          .querySelector(".file-viewer")
          ?.getAttribute("data-kind"),
      ).toBe("log"),
    );
    expect(
      rendered.container.querySelector(".file-viewer__tab-name")?.textContent,
    ).toBe("提交记录");
    await waitFor(() =>
      expect(
        rendered.container.querySelectorAll(".log-view__row"),
      ).toHaveLength(1),
    );
    expect(
      rendered.container
        .querySelector(".log-view__row")
        ?.classList.contains("is-unpushed"),
    ).toBe(true);
  });

  it("a clean tree says so, an operation mid-flight is flagged with its conflicts, and a truncated list says how many more", () => {
    const { mock, container } = mount();
    act(() => {
      mock.emitRepo({
        kind: "repo",
        workspace: "/repo",
        repo: { ...REPO, dirty: [], dirtyTotal: 0, ahead: 0, behind: 0 },
      });
    });
    let card = container.querySelector(".repo-card");
    expect(card?.querySelector(".plan-card__count")?.textContent).toBe(
      "工作区干净",
    );
    expect(card?.querySelector(".repo-card__delta")).toBeNull();
    act(() => {
      mock.emitRepo({
        kind: "repo",
        workspace: "/repo",
        repo: {
          ...REPO,
          inProgress: "merge",
          conflicted: ["a.ts", "b.ts"],
          dirtyTotal: 45,
        },
      });
    });
    card = container.querySelector(".repo-card");
    expect(card?.querySelector(".repo-card__flag")?.textContent).toBe(
      "合并进行中 · 2 个冲突",
    );
    expect(card?.querySelector(".repo-card__more")?.textContent).toBe(
      "还有 42 项",
    );
  });

  it("a detached HEAD and an unborn branch are named honestly", () => {
    const { mock, container } = mount();
    act(() => {
      mock.emitRepo({
        kind: "repo",
        workspace: "/repo",
        repo: { ...REPO, branch: null, detached: true, upstream: null },
      });
    });
    // The branch swaps in place (SwapText): read the entering line, not the
    // 240 ms leaving twin beside it.
    expect(
      container.querySelector(".repo-card__branch-name .swap-text__in")
        ?.textContent,
    ).toBe("游离 HEAD");
    act(() => {
      mock.emitRepo({
        kind: "repo",
        workspace: "/repo",
        repo: {
          ...REPO,
          branch: null,
          detached: false,
          headShort: null,
          upstream: null,
          recentSubjects: [],
          recentCommits: [],
        },
      });
    });
    expect(
      container.querySelector(".repo-card__branch-name .swap-text__in")
        ?.textContent,
    ).toBe("尚无提交");
    // The three commit rows are on their way out (the exit plays where
    // they were); none is a live row any more.
    expect(
      container.querySelectorAll(".repo-card__log-row:not(.is-leaving)"),
    ).toHaveLength(0);
  });

  it("paths open in the file viewer where the bridge can read files", () => {
    const { mock, container } = mount(true);
    act(() => {
      mock.emitRepo({ kind: "repo", workspace: "/repo", repo: REPO });
    });
    const button = container.querySelector("button.repo-card__path");
    expect(button?.textContent).toBe("packages/gui/src/renderer/RepoCard.tsx");
    // Without a diff-reading bridge the row opens the FILE.
    expect(button?.getAttribute("aria-label")).toBe(
      "查看文件 packages/gui/src/renderer/RepoCard.tsx",
    );
  });

  it("a subfolder workspace names its prefix, spells paths from the workspace, and opens only what lies inside it (ADR 0058 amendment)", () => {
    const { mock, container } = mount(true);
    act(() => {
      mock.emitRepo({
        kind: "repo",
        workspace: "/repo/packages/gui",
        repo: { ...REPO, prefix: "packages/gui/" },
      });
    });
    // The store keeps the answer: the workspace in the snapshot is /repo, so
    // re-emit for it (the mount's snapshot) — the card reads the store.
    act(() => {
      mock.emitRepo({
        kind: "repo",
        workspace: "/repo",
        repo: { ...REPO, prefix: "packages/gui/" },
      });
    });
    const card = container.querySelector(".repo-card");
    expect(card?.querySelector(".repo-card__scope")?.textContent).toBe(
      "工作区位于 packages/gui/",
    );
    const rows = [
      ...(card?.querySelectorAll(".repo-card__list .repo-card__row") ?? []),
    ];
    expect(
      rows.map((r) => r.querySelector(".repo-card__path")?.textContent),
    ).toEqual([
      "src/renderer/RepoCard.tsx",
      "../../docs/adr/0058.md",
      "../../scratch.txt",
    ]);
    // Inside: a button. Outside: a span that says so, still spelled honestly.
    expect(rows[0]?.querySelector("button.repo-card__path")).not.toBeNull();
    expect(rows[1]?.querySelector("button.repo-card__path")).toBeNull();
    expect(rows[1]?.classList.contains("is-outside")).toBe(true);
    // Its tip says where it really is, even seen whole.
    expect(tipOf(rows[1]?.querySelector(".repo-card__path"))).toContain(
      "docs/adr/0058.md",
    );
  });

  it("a dirty row opens its DIFF against HEAD where the bridge reads diffs; a conflict row opens the file (ADR 0059 §5)", async () => {
    const mock = createMockHertaBridge();
    const readWorkspaceFile = vi.fn(async () => ({
      ok: false as const,
      reason: "not_found" as const,
    }));
    const readWorkspaceDiff = vi.fn(async (_s: string, path: string) => ({
      ok: true as const,
      diff: {
        path,
        untracked: false,
        missing: false,
        patch: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-one\n+two\n`,
        patchTruncated: false,
        added: 1,
        deleted: 1,
      },
    }));
    Object.assign(mock.bridge, { readWorkspaceFile, readWorkspaceDiff });
    const rendered = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <FileViewerProvider>
          <RepoCard />
          <FileViewerPanel />
        </FileViewerProvider>
      </HertaBridgeProvider>,
      { locale: "zh" },
    );
    act(() => {
      mock.emitReset(SNAPSHOT);
      mock.emitRepo({
        kind: "repo",
        workspace: "/repo",
        repo: {
          ...REPO,
          dirty: [
            { x: " ", y: "M", path: "src/a.ts" },
            { x: "U", y: "U", path: "src/clash.ts" },
          ],
          dirtyTotal: 2,
        },
      });
    });
    const rows = rendered.container.querySelectorAll("button.repo-card__path");
    expect(rows[0]?.getAttribute("aria-label")).toBe("查看改动 src/a.ts");
    expect(rows[1]?.getAttribute("aria-label")).toBe("查看文件 src/clash.ts");
    fireEvent.click(rows[0] as Element);
    await waitFor(() =>
      expect(readWorkspaceDiff).toHaveBeenCalledWith("s1", "src/a.ts"),
    );
    await waitFor(() =>
      expect(
        rendered.container
          .querySelector(".file-viewer")
          ?.getAttribute("data-kind"),
      ).toBe("diff"),
    );
    expect(
      rendered.container.querySelector(".file-viewer__tab-name")?.textContent,
    ).toBe("± a.ts");
    expect(
      rendered.container.querySelectorAll(".diff-body__line.is-add"),
    ).toHaveLength(1);
    fireEvent.click(rows[1] as Element);
    await waitFor(() =>
      expect(readWorkspaceFile).toHaveBeenCalledWith("s1", "src/clash.ts"),
    );
  });

  it("a recent commit opens as a commit tab in the viewer (ADR 0059)", async () => {
    const mock = createMockHertaBridge();
    const commit: CommitDescription = {
      sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      shortSha: "a1b2c3d",
      subject: "feat(gui): the rail shows the repository",
      body: "",
      author: "Tester",
      authoredAt: "2026-09-07T10:00:00+08:00",
      parents: ["0000000000000000000000000000000000000000"],
      files: [{ path: "src/a.ts", status: "modified", added: 1, deleted: 1 }],
      filesTotal: 1,
      patch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-one\n+two\n",
      patchTruncated: false,
    };
    const readWorkspaceCommit = vi.fn(async () => ({
      ok: true as const,
      commit,
    }));
    Object.assign(mock.bridge, {
      readWorkspaceFile: async () => ({ ok: false, reason: "not_found" }),
      readWorkspaceCommit,
    });
    const rendered = renderWithLocale(
      <HertaBridgeProvider bridge={mock.bridge}>
        <FileViewerProvider>
          <RepoCard />
          <FileViewerPanel />
        </FileViewerProvider>
      </HertaBridgeProvider>,
      { locale: "zh" },
    );
    act(() => {
      mock.emitReset(SNAPSHOT);
      mock.emitRepo({ kind: "repo", workspace: "/repo", repo: REPO });
    });
    const buttons = rendered.container.querySelectorAll(
      "button.repo-card__subject",
    );
    expect(buttons).toHaveLength(3);
    expect(buttons[1]?.getAttribute("aria-label")).toBe("查看提交 0f0f0f0");
    fireEvent.click(buttons[1] as Element);
    await waitFor(() =>
      expect(readWorkspaceCommit).toHaveBeenCalledWith("s1", "0f0f0f0"),
    );
    await waitFor(() =>
      expect(
        rendered.container
          .querySelector(".file-viewer")
          ?.getAttribute("data-kind"),
      ).toBe("commit"),
    );
    expect(
      rendered.container.querySelector(".commit-view__subject")?.textContent,
    ).toBe(commit.subject);
    expect(
      rendered.container.querySelector(".file-viewer__tab-name")?.textContent,
    ).toBe("0f0f0f0");
  });

  it("its tips are the app's own, and a path or a commit seen whole raises none (owner 2026-10-08)", () => {
    // The file rows showed the OS's tooltip, and every commit row repeated
    // its own fully visible subject in a second box.
    const { mock, container } = mount(true);
    act(() => {
      mock.emitRepo({ kind: "repo", workspace: "/repo", repo: REPO });
    });
    const card = container.querySelector(".repo-card");
    // No OS tooltip anywhere on the card.
    expect(card?.querySelectorAll("[title]")).toHaveLength(0);
    // A path seen whole: no tip. Cut off: the path.
    const path = card?.querySelector(".repo-card__list .repo-card__path");
    expect(tipOf(path)).toBeUndefined();
    clip(path);
    expect(tipOf(path)).toBe(path?.textContent);
    // A commit subject seen whole: no tip. Cut off: the subject — the sha
    // beside it is already on the row.
    const subject = card?.querySelector(".repo-card__subject");
    expect(tipOf(subject)).toBeUndefined();
    clip(subject);
    expect(tipOf(subject)).toBe(subject?.textContent);
    // A status letter's tip says what it means, always.
    const mark = card?.querySelector(".repo-card__list .plan-card__mark");
    expect(tipOf(mark)).toBeTruthy();
    expect(tipOf(mark)).not.toBe(mark?.textContent);
  });

  it("a window focus asks the session to probe again, throttled", () => {
    vi.useFakeTimers();
    const { mock } = mount();
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(mock.calls.refreshRepo).toBe(1);
    act(() => {
      vi.advanceTimersByTime(REPO_FOCUS_REFRESH_MIN_MS + 10);
      window.dispatchEvent(new Event("focus"));
    });
    expect(mock.calls.refreshRepo).toBe(2);
  });

  it("when the workspace stops being a repository the card retracts, then unmounts after the slide", () => {
    vi.useFakeTimers();
    const { mock, container } = mount();
    act(() => {
      mock.emitRepo({ kind: "repo", workspace: "/repo", repo: REPO });
    });
    expect(container.querySelector(".repo-card.is-open")).not.toBeNull();
    act(() => {
      mock.emitRepo({ kind: "repo", workspace: "/repo", repo: null });
    });
    const card = container.querySelector(".repo-card");
    expect(card).not.toBeNull();
    expect(card?.classList.contains("is-open")).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector(".repo-card")).toBeNull();
  });
});

describe("dirtyMark", () => {
  it("reads the worktree column first, the index column when the worktree is clean, and names conflicts and untracked files apart", () => {
    expect(dirtyMark({ x: " ", y: "M", path: "a" }).glyph).toBe("M");
    expect(dirtyMark({ x: "M", y: " ", path: "a" }).glyph).toBe("M");
    expect(dirtyMark({ x: "A", y: " ", path: "a" }).kind).toBe("added");
    expect(dirtyMark({ x: " ", y: "D", path: "a" }).kind).toBe("deleted");
    expect(dirtyMark({ x: "R", y: " ", path: "a" }).kind).toBe("renamed");
    expect(dirtyMark({ x: "?", y: "?", path: "a" }).kind).toBe("untracked");
    expect(dirtyMark({ x: "U", y: "U", path: "a" }).kind).toBe("conflict");
    expect(dirtyMark({ x: "A", y: "A", path: "a" }).glyph).toBe("!");
  });
});

describe("RepoCard — a gone upstream (ADR 0058 §7)", () => {
  it("names the upstream as gone instead of in sync, and every recent commit carries the mark", () => {
    const { mock, container } = mount();
    act(() => {
      mock.emitRepo({
        kind: "repo",
        workspace: "/repo",
        repo: {
          ...REPO,
          ahead: 0,
          behind: 0,
          upstreamGone: true,
          recentCommits: REPO.recentCommits.map((c) => ({
            ...c,
            unpushed: true,
          })),
        },
      });
    });
    const card = container.querySelector(".repo-card");
    const upstream = card?.querySelector(".repo-card__upstream");
    expect(upstream?.classList.contains("is-gone")).toBe(true);
    expect(tipOf(upstream)).toBe("上游 origin/feat/repo-card 已不存在");
    expect(card?.querySelector(".repo-card__gone")?.textContent).toBe("已删除");
    expect(card?.querySelector(".repo-card__delta")).toBeNull();
    const log = [...(card?.querySelectorAll(".repo-card__log-row") ?? [])];
    expect(log.map((r) => r.classList.contains("is-unpushed"))).toEqual([
      true,
      true,
      true,
    ]);
  });
});
