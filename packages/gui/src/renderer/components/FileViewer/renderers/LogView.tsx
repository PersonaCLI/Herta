import type { BranchList, LogEntry } from "@herta/app-server";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHertaBridge } from "../../../context/HertaBridgeContext.js";
import { useReducedMotion } from "../../../hooks/useReducedMotion.js";
import { useSessionSelector } from "../../../hooks/useSessionSelector.js";
import { useLocale, useT } from "../../../i18n/LocaleProvider.js";
import { hoverTipProps } from "../../common/hover-tip.js";
import { Select } from "../../Settings/Select.js";
import { useFileViewerOpen } from "../file-viewer-context.js";
import { formatCommitDate } from "./commit-patch.js";

/** Rows per page — the reader's own default (`LOG_PAGE_SIZE` in tools). */
export const LOG_PAGE = 50;
/** Typing settles for this long before the history is asked again. */
export const LOG_SEARCH_DEBOUNCE_MS = 250;
/** The picker's value for "HEAD, whatever it is" — a detached or unborn
 *  HEAD has no branch name to stand in for it. */
const HEAD_VALUE = "\0HEAD";

type Load =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly skip: number }
  | { readonly kind: "failed" };

/**
 * The repository's history beside the record (ADR 0059 §6): newest first,
 * a page at a time, each row the commit tab's opener, the commits not on
 * the upstream marked. The first page reloads when HEAD moves (a commit
 * lands while the tab is open), so the tab is as live as the card; later
 * pages append, and the appended rows ease in one after another.
 *
 * Two read-only controls (§6 amendment): a branch picker choosing WHOSE
 * history to read — nothing is checked out, the working tree is untouched,
 * and the marks are measured against the chosen branch's own upstream —
 * and a message search, a fixed string matched case-insensitively, applied
 * once typing settles.
 */
export function LogView(): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const { bridge } = useHertaBridge();
  const reduced = useReducedMotion();
  const openFile = useFileViewerOpen();
  const sessionId = useSessionSelector((s) => s.sessionId);
  const repo = useSessionSelector((s) => s.repo);
  const head = repo?.headShort ?? null;

  const [entries, setEntries] = useState<readonly LogEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [upstream, setUpstream] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "idle" });
  /** Index from which rows are "new" this render — they stagger in. */
  const [freshFrom, setFreshFrom] = useState(0);
  /** The picked branch; null = HEAD. */
  const [ref, setRef] = useState<string | null>(null);
  /** The settled search (what the history was asked for) and the live
   *  field it settles from. */
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState("");
  const [branches, setBranches] = useState<BranchList | null>(null);
  const seq = useRef(0);

  const fetchPage = useCallback(
    (skip: number) => {
      const read = bridge.readWorkspaceLog?.bind(bridge);
      if (read === undefined || sessionId === null) {
        setLoad({ kind: "failed" });
        return;
      }
      seq.current += 1;
      const mine = seq.current;
      setLoad({ kind: "loading", skip });
      read(sessionId, {
        skip,
        limit: LOG_PAGE,
        ...(ref !== null ? { ref } : {}),
        ...(query.length > 0 ? { query } : {}),
      }).then(
        (reply) => {
          if (mine !== seq.current) return;
          if (!reply.ok) {
            setLoad({ kind: "failed" });
            return;
          }
          setEntries((cur) =>
            skip === 0 ? reply.page.entries : [...cur, ...reply.page.entries],
          );
          setFreshFrom(skip);
          setHasMore(reply.page.hasMore);
          setUpstream(reply.page.upstream);
          setLoad({ kind: "idle" });
        },
        () => {
          if (mine === seq.current) setLoad({ kind: "failed" });
        },
      );
    },
    [bridge, sessionId, ref, query],
  );

  // The first page — again whenever HEAD moves, the branch is picked, or
  // the search settles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `head` is the reload trigger, not a value the fetch reads.
  useEffect(() => {
    fetchPage(0);
  }, [fetchPage, head]);

  // The branch list — again whenever HEAD moves (a checkout, a new branch).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `head` is the reload trigger, not a value the read uses.
  useEffect(() => {
    const read = bridge.readWorkspaceBranches?.bind(bridge);
    if (read === undefined || sessionId === null) return;
    let alive = true;
    read(sessionId).then(
      (reply) => {
        if (alive) setBranches(reply.ok ? reply.branches : null);
      },
      () => {
        if (alive) setBranches(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [bridge, sessionId, head]);

  // Typing settles into the query after a beat; Enter settles it at once.
  useEffect(() => {
    const t = setTimeout(() => setQuery(typed.trim()), LOG_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [typed]);

  const branch =
    repo === null
      ? null
      : repo.branch !== null
        ? repo.branch
        : repo.detached
          ? t("repo.card.detached")
          : t("repo.card.unborn");

  // The picker: HEAD's branch first under its own name (or the detached /
  // unborn label), then every other branch, locals before remotes.
  const current = branches?.current ?? null;
  const options =
    branches === null
      ? []
      : [
          ...(current === null
            ? [{ value: HEAD_VALUE, label: branch ?? "HEAD" }]
            : []),
          ...branches.branches.map((b) => ({ value: b.name, label: b.name })),
        ];
  const pickerValue = ref ?? current ?? HEAD_VALUE;
  const showPicker = options.length > 1;

  return (
    <div className="file-viewer__body">
      <div
        className="file-viewer__scroll commit-view log-view"
        data-testid="log-view"
      >
        <header className="commit-view__head log-view__head">
          <div className="log-view__tools">
            {showPicker ? (
              <span className="log-view__pick">
                <Select<string>
                  value={pickerValue}
                  ariaLabel={t("viewer.log.branch")}
                  options={options}
                  onChange={(v) =>
                    setRef(v === HEAD_VALUE || v === current ? null : v)
                  }
                />
              </span>
            ) : (
              branch !== null && (
                <span className="log-view__branch">{branch}</span>
              )
            )}
            <input
              type="search"
              className="log-view__search"
              value={typed}
              placeholder={t("viewer.log.search")}
              aria-label={t("viewer.log.search")}
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setQuery(typed.trim());
              }}
            />
          </div>
          {upstream !== null && (
            <p className="commit-view__meta">
              <span>{t("repo.card.upstream", { name: upstream })}</span>
            </p>
          )}
        </header>
        {entries.length === 0 && load.kind === "idle" && (
          <p className="file-viewer__notice">
            {query.length > 0 ? t("viewer.log.noMatch") : t("repo.card.unborn")}
          </p>
        )}
        {load.kind === "failed" && entries.length === 0 && (
          <p className="file-viewer__notice">{t("viewer.log.notFound")}</p>
        )}
        <ol className="log-view__list">
          {entries.map((e, i) => {
            const fresh = !reduced && i >= freshFrom;
            return (
              <li
                key={e.sha}
                className={`log-view__row${e.unpushed ? " is-unpushed" : ""}${
                  fresh ? " is-entering" : ""
                }`}
                style={
                  fresh
                    ? {
                        animationDelay: `${Math.min(i - freshFrom, 24) * 18}ms`,
                      }
                    : undefined
                }
              >
                <button
                  type="button"
                  className="log-view__commit"
                  aria-label={`${t("activity.commit.openAria")} ${e.shortSha}`}
                  onClick={() =>
                    openFile?.(e.shortSha, {
                      kind: "commit",
                      label: e.shortSha,
                    })
                  }
                >
                  <span className="log-view__sha">{e.shortSha}</span>
                  {/* The app's tip, not the OS's, for a subject the row
                      clipped (owner 2026-09-09). */}
                  <span
                    className="log-view__subject"
                    {...hoverTipProps(e.subject)}
                  >
                    {e.subject}
                  </span>
                  {e.unpushed && (
                    <span
                      className="log-view__unpushed"
                      role="img"
                      aria-label={t("repo.card.unpushed")}
                      {...hoverTipProps(t("repo.card.unpushed"))}
                    >
                      ↑
                    </span>
                  )}
                  <span className="log-view__who">
                    {e.author}
                    <span className="commit-view__sep" aria-hidden="true">
                      ·
                    </span>
                    {formatCommitDate(e.authoredAt, locale)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {hasMore && (
          <button
            type="button"
            className="log-view__more"
            disabled={load.kind === "loading"}
            onClick={() => fetchPage(entries.length)}
          >
            {t("viewer.log.more")}
          </button>
        )}
        {!hasMore && entries.length > 0 && load.kind === "idle" && (
          <p className="file-viewer__notice log-view__end">
            {t("viewer.log.end")}
          </p>
        )}
      </div>
    </div>
  );
}
