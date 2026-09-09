import type {
  RepoContextDirtyFile,
  RepoContextSnapshot,
  RepoInProgressState,
  RepoRecentCommit,
} from "@herta/app-server";
import {
  repoPathInsideWorkspace,
  workspaceRelativeRepoPath,
} from "@herta/core/repo-path";
import { useCallback, useRef } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useListTransitions } from "../../hooks/useListTransitions.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import type { MessageKey } from "../../i18n/keys.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { hoverTipProps } from "../common/hover-tip.js";
import { useFileViewerOpen } from "../FileViewer/file-viewer-context.js";
import { SwapText } from "../Workspace/SwapText.js";
import { useScrollEdges } from "../Workspace/useScrollEdges.js";
import { cardRowMotion, rowPhaseClass } from "./card-motion.js";
import { useRepoCard } from "./useRepoCard.js";

/**
 * The workspace's repository as a rail card (ADR 0058), under the device:
 * the branch and where it stands against its upstream, an operation left
 * mid-flight (a merge, a rebase), the uncommitted files, and the recent
 * commits. What the backend frame already knows at every dispatch (ADR
 * 0049 §2), now in the user's own column — read without asking.
 *
 * Rides the .plan-card chrome (glass, slide, fog, mark) so the rail keeps
 * one card family; the `repo-card` variant carries what differs. Facts,
 * stated in FORM (the 2026-07-27 rule): nothing here pulses. What MOVES is
 * change and touch (§5.7) — a row that arrives or leaves eases in or out
 * where it sits, the header's count and the branch name swap in place,
 * and a row under the pointer lifts as a glass pill. Paths are spelled
 * from the WORKSPACE (git spells them from the repository's root; a
 * subfolder workspace sees `../` for what lies beside it — §5.1) and
 * open in the viewer where the bridge can read them (ADR 0050): as their
 * diff against HEAD (ADR 0059 §5), a conflict as the file. Commits open
 * as commit tabs (ADR 0059); the unpushed ones carry a mark (§5.6); the
 * list's own label opens the full history (ADR 0059 §6).
 */
export function RepoCard(): JSX.Element | null {
  const t = useT();
  const { repo, open, settled } = useRepoCard();
  const openFile = useFileViewerOpen();
  const { bridge } = useHertaBridge();
  // Rows move on CHANGE, not on the card's own arrival: until the first
  // answer has been on screen, the lists render settled (the card's slide
  // is the entrance), exactly as under reduced motion (card-motion.ts).
  const reducedMotion = useReducedMotion();
  const reduced = reducedMotion || !settled;
  // A dirty row opens its DIFF where the bridge can read one (ADR 0059
  // §5), the file where it cannot (an older bridge, the demo).
  const diffs = bridge.readWorkspaceDiff !== undefined;
  const history = bridge.readWorkspaceLog !== undefined;
  const listRef = useRef<HTMLOListElement>(null);
  const edges = useScrollEdges(listRef, repo);
  const logRef = useRef<HTMLOListElement>(null);
  const logEdges = useScrollEdges(logRef, repo);

  const dirtyKey = useCallback((f: RepoContextDirtyFile) => f.path, []);
  const commitKey = useCallback((c: RepoRecentCommit) => c.sha, []);
  const motion = cardRowMotion(reducedMotion, settled);
  const dirtyRows = useListTransitions(
    repo?.dirty ?? EMPTY_DIRTY,
    dirtyKey,
    motion,
  );
  const commitRows = useListTransitions(
    repo?.recentCommits ?? EMPTY_COMMITS,
    commitKey,
    motion,
  );

  if (repo === null) return null;

  const branchLabel =
    repo.branch !== null
      ? repo.branch
      : repo.detached
        ? t("repo.card.detached")
        : t("repo.card.unborn");
  const branchTitle =
    repo.headShort !== null
      ? `${branchLabel} · ${repo.headShort}`
      : branchLabel;
  const deltaParts: string[] = [];
  if (repo.ahead > 0) deltaParts.push(`↑${repo.ahead}`);
  if (repo.behind > 0) deltaParts.push(`↓${repo.behind}`);
  const deltaTitle = [
    repo.ahead > 0 ? t("repo.card.ahead", { n: String(repo.ahead) }) : null,
    repo.behind > 0 ? t("repo.card.behind", { n: String(repo.behind) }) : null,
  ]
    .filter((s) => s !== null)
    .join(" · ");
  const count =
    repo.dirtyTotal === 0
      ? t("repo.card.clean")
      : t("repo.card.dirty", { n: String(repo.dirtyTotal) });
  const hidden = repo.dirtyTotal - repo.dirty.length;
  const prefix = repo.prefix;

  return (
    <section
      className={`plan-card repo-card${open ? " is-open" : ""}`}
      data-testid="repo-card"
      aria-label={t("repo.card.title")}
      aria-hidden={!open}
    >
      <header className="plan-card__head">
        <span className="plan-card__title">{t("repo.card.title")}</span>
        <span className="plan-card__count repo-card__count">
          <SwapText text={count} reduced={reduced} />
        </span>
      </header>
      <div className="repo-card__branch">
        <span className="repo-card__branch-name" title={branchTitle}>
          <SwapText text={branchLabel} reduced={reduced} />
        </span>
        {repo.upstream !== null && (
          <span
            className="repo-card__upstream"
            title={t("repo.card.upstream", { name: repo.upstream })}
          >
            {repo.upstream}
          </span>
        )}
        {deltaParts.length > 0 && (
          <span className="repo-card__delta" title={deltaTitle}>
            <SwapText text={deltaParts.join(" ")} reduced={reduced} />
          </span>
        )}
      </div>
      {prefix.length > 0 && (
        <p className="repo-card__scope" title={repo.root}>
          {t("repo.card.scope", { prefix })}
        </p>
      )}
      {repo.inProgress !== null && (
        <p className="repo-card__flag">
          {t(IN_PROGRESS_KEY[repo.inProgress])}
          {repo.conflicted.length > 0 &&
            ` · ${t("repo.card.conflicts", { n: String(repo.conflicted.length) })}`}
        </p>
      )}
      {dirtyRows.length > 0 && (
        <ol
          ref={listRef}
          className={`plan-card__list repo-card__list${
            edges.top ? " has-fog-top" : ""
          }${edges.bottom ? " has-fog-bottom" : ""}`}
        >
          {dirtyRows.map((row) => {
            const file = row.item;
            const mark = dirtyMark(file);
            const shown = workspaceRelativeRepoPath(file.path, prefix);
            const inside = repoPathInsideWorkspace(file.path, prefix);
            return (
              <li
                key={row.key}
                className={`plan-card__row repo-card__row is-${mark.kind}${
                  inside ? "" : " is-outside"
                }${rowPhaseClass(row.phase)}`}
                aria-hidden={row.phase === "leave" || undefined}
              >
                <span
                  className="plan-card__mark"
                  title={t(STATUS_KEY[mark.kind])}
                >
                  {mark.glyph}
                </span>
                {openFile !== null && inside && row.phase !== "leave" ? (
                  <button
                    type="button"
                    className="repo-card__path"
                    title={file.path}
                    aria-label={`${
                      diffs && mark.kind !== "conflict"
                        ? t("activity.diff.openAria")
                        : t("activity.file.openAria")
                    } ${shown}`}
                    onClick={() =>
                      // A conflict's markers live in the file itself; every
                      // other change reads best as its diff against HEAD.
                      diffs && mark.kind !== "conflict"
                        ? openFile(shown, { kind: "diff" })
                        : openFile(shown)
                    }
                  >
                    {shown}
                  </button>
                ) : (
                  <span
                    className="repo-card__path"
                    title={
                      inside
                        ? file.path
                        : `${file.path} · ${t("viewer.outside")}`
                    }
                  >
                    {shown}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {hidden > 0 && (
        <p className="repo-card__more">
          {t("repo.card.more", { n: String(hidden) })}
        </p>
      )}
      {commitRows.length > 0 && (
        <>
          <div className="repo-card__section">
            <span>{t("repo.card.recent")}</span>
            {history && openFile !== null && (
              <button
                type="button"
                className="repo-card__all"
                onClick={() =>
                  openFile("history", {
                    kind: "log",
                    label: t("viewer.log.tab"),
                  })
                }
              >
                {t("repo.card.all")}
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3.5 2l3 3-3 3" />
                </svg>
              </button>
            )}
          </div>
          <ol
            ref={logRef}
            className={`plan-card__list repo-card__log${
              logEdges.top ? " has-fog-top" : ""
            }${logEdges.bottom ? " has-fog-bottom" : ""}`}
          >
            {commitRows.map((row) => {
              const c = row.item;
              return (
                <li
                  key={row.key}
                  className={`plan-card__row repo-card__row repo-card__log-row${
                    c.unpushed ? " is-unpushed" : ""
                  }${rowPhaseClass(row.phase)}`}
                  aria-hidden={row.phase === "leave" || undefined}
                >
                  <span className="plan-card__mark repo-card__sha">
                    {c.shortSha}
                  </span>
                  {openFile !== null && row.phase !== "leave" ? (
                    <button
                      type="button"
                      className="repo-card__path repo-card__subject"
                      {...hoverTipProps(`${c.shortSha} ${c.subject}`)}
                      aria-label={`${t("activity.commit.openAria")} ${c.shortSha}`}
                      onClick={() =>
                        openFile(c.shortSha, {
                          kind: "commit",
                          label: c.shortSha,
                        })
                      }
                    >
                      {c.subject}
                    </button>
                  ) : (
                    <span
                      className="repo-card__path repo-card__subject"
                      {...hoverTipProps(`${c.shortSha} ${c.subject}`)}
                    >
                      {c.subject}
                    </span>
                  )}
                  {c.unpushed && (
                    <span
                      className="repo-card__unpushed"
                      role="img"
                      aria-label={t("repo.card.unpushed")}
                      {...hoverTipProps(t("repo.card.unpushed"))}
                    >
                      ↑
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

const EMPTY_DIRTY: readonly RepoContextDirtyFile[] = [];
const EMPTY_COMMITS: readonly RepoRecentCommit[] = [];

export type DirtyMarkKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict"
  | "other";

/**
 * One glyph per porcelain status pair — the worktree column when it says
 * something, the index column otherwise: what `git status --short` shows,
 * read the way a person reads it. Conflicts and untracked files are their
 * own kinds because they mean something different from an edit.
 */
export function dirtyMark(file: RepoContextDirtyFile): {
  readonly kind: DirtyMarkKind;
  readonly glyph: string;
} {
  const { x, y } = file;
  if (x === "?") return { kind: "untracked", glyph: "?" };
  if (
    x === "U" ||
    y === "U" ||
    (x === "A" && y === "A") ||
    (x === "D" && y === "D")
  ) {
    return { kind: "conflict", glyph: "!" };
  }
  const code = y !== " " && y !== "" ? y : x;
  switch (code) {
    case "M":
    case "T":
      return { kind: "modified", glyph: "M" };
    case "A":
      return { kind: "added", glyph: "A" };
    case "D":
      return { kind: "deleted", glyph: "D" };
    case "R":
    case "C":
      return { kind: "renamed", glyph: "R" };
    default:
      return { kind: "other", glyph: code.length > 0 ? code : "·" };
  }
}

const STATUS_KEY: Record<DirtyMarkKind, MessageKey> = {
  modified: "repo.card.status.modified",
  added: "repo.card.status.added",
  deleted: "repo.card.status.deleted",
  renamed: "repo.card.status.renamed",
  untracked: "repo.card.status.untracked",
  conflict: "repo.card.status.conflict",
  other: "repo.card.status.other",
};

const IN_PROGRESS_KEY: Record<RepoInProgressState, MessageKey> = {
  merge: "repo.card.inProgress.merge",
  rebase: "repo.card.inProgress.rebase",
  "cherry-pick": "repo.card.inProgress.cherryPick",
  revert: "repo.card.inProgress.revert",
  bisect: "repo.card.inProgress.bisect",
};

/** Exported for tests and the ADR's example. */
export type { RepoContextSnapshot };
