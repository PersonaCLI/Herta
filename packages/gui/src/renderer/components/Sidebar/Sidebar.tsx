import { useEffect, useMemo, useRef, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useFlipList } from "../../hooks/useFlipList.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { useSessionList } from "../../hooks/useSessionList.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { useScrollEdges } from "../Workspace/useScrollEdges.js";
import { groupSessions } from "./group-sessions.js";
import { SettingsIcon } from "./icons.js";
import { SessionGroup } from "./SessionGroup.js";
import { sessionDisplayTitle } from "./session-display-title.js";

/** Keystroke → transcript-scan debounce. Title matches stay instant; content
 *  hits merge in when the scan returns. */
const SEARCH_DEBOUNCE_MS = 200;

/** sessionId → the hit's preview snippet + the record index to land on. */
export interface SearchHitView {
  readonly snippet: string;
  readonly blockIndex: number;
}

const NO_HITS: ReadonlyMap<string, SearchHitView> = new Map();

export interface SidebarProps {
  /**
   * The reference time used to bucket sessions by recency.
   * Defaults to `new Date()` in production. Pass a fixed date
   * in tests to avoid date-coupling failures.
   */
  readonly now?: Date;
  /** Whether the search field is open (owned by Workbench). */
  readonly searchOpen?: boolean;
  /** Current search query (owned by Workbench). */
  readonly query?: string;
  /** Called as the user types in the search field. */
  readonly onQueryChange?: (q: string) => void;
  /** Called when the user presses Escape in the search field. */
  readonly onCloseSearch?: () => void;
  /** Called when the foot Settings button is clicked (opens the Settings modal). */
  readonly onOpenSettings?: () => void;
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const t = useT();
  const { bridge } = useHertaBridge();
  const sessions = useSessionList();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchOpen = props.searchOpen ?? false;
  const query = props.query ?? "";
  const q = query.trim().toLowerCase();

  // Transcript content search (2026-07-11): the filter used to be
  // title-only, which stops working the moment you remember what was SAID
  // but not what the title generator picked. A debounced main-process scan
  // returns sessionId → snippet for dialogue matches; the list shows a
  // session when its TITLE or its CONTENT matches, and content-matched
  // cards show the matching snippet as their preview line. Stale responses
  // are dropped by sequence; a bridge without searchSessions (fakes, the
  // website demo) degrades to title-only.
  const [contentHits, setContentHits] =
    useState<ReadonlyMap<string, SearchHitView>>(NO_HITS);
  /** Whether the content scan has ANSWERED for the current query — tracked
   *  alongside its results so the empty state can tell "no hits" from "not
   *  yet" and from "the scan failed" (audit 2026-07-24, 1.13). */
  const [scanState, setScanState] = useState<
    "idle" | "pending" | "ok" | "failed"
  >("idle");
  const searchSeq = useRef(0);
  useEffect(() => {
    const my = ++searchSeq.current;
    if (q === "" || bridge.searchSessions === undefined) {
      setContentHits(NO_HITS);
      // No scan will run: the title filter IS the whole answer here, so an
      // empty result is legitimately definitive.
      setScanState("idle");
      return;
    }
    setScanState("pending");
    const timer = window.setTimeout(() => {
      bridge
        .searchSessions?.(q)
        .then((hits) => {
          if (my !== searchSeq.current) return; // superseded by a newer query
          setContentHits(
            new Map(
              hits.map((h) => [
                h.sessionId,
                { snippet: h.snippet, blockIndex: h.blockIndex },
              ]),
            ),
          );
          setScanState("ok");
        })
        .catch(() => {
          // Best-effort: the title filter still stands — but record that the
          // content half never answered, so we don't claim the workspace has
          // nothing.
          if (my === searchSeq.current) setScanState("failed");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [q, bridge]);
  // Memoized: `groups` (a fresh Map) feeds the flipKeys memo, which feeds
  // useFlipList's layout effect. Rebuilt inline these invalidated on EVERY
  // render, so any unrelated Sidebar commit re-ran the FLIP measure — a
  // forced getBoundingClientRect per card plus getAnimations().finish(),
  // which snapped in-flight delete/reorder glides dead one frame in. The
  // `new Date()` fallback (prod path; tests pass `now`) is created inside
  // the memo, so date-group labels refresh on any list change — day-level
  // granularity, more than enough.
  const filtered = useMemo(
    () =>
      q === ""
        ? sessions
        : sessions.filter(
            (s) =>
              sessionDisplayTitle(s).toLowerCase().includes(q) ||
              contentHits.has(s.sessionId),
          ),
    [sessions, q, contentHits],
  );
  const groups = useMemo(
    () => groupSessions(filtered, props.now ?? new Date()),
    [filtered, props.now],
  );
  // "No matching sessions" is a CLAIM about the whole workspace, so it waits
  // for the content scan to actually answer (audit 2026-07-24, 1.13).
  // `filtered` is title-matches ∪ contentHits, and contentHits only fills
  // after a debounce plus a main-process scan whose rejection is swallowed —
  // so searching for a phrase the user remembers Herta SAYING (the whole
  // point of content search) showed a confident empty state for the first
  // few hundred ms of every query, and permanently if the scan failed.
  const noMatches =
    q !== "" && filtered.length === 0 && scanState !== "pending";
  /** Nothing to show YET: the title filter matched nothing and the content
   *  scan is still running. */
  const searchingEmpty =
    q !== "" && filtered.length === 0 && scanState === "pending";

  // The search input is ALWAYS mounted (so the open/close height animation
  // is symmetric), which means `autoFocus` can't fire on open — focus it
  // imperatively when the field opens.
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // (The stale-card-raster heal after a delete/reorder lives in useFlipList —
  // it repaints exactly the rows the FLIP moved, once each glide ends. An
  // earlier attempt here re-rastered the .sidebar-list mask instead, which
  // does NOT clear a per-row stale texture, commits 4a383fd/406dfe7.)

  // FLIP reorder glide (user 2026-06-13): deletions, an activated session
  // jumping to the top, and regrouping all reorder the DOM, which CSS can't
  // transition — the hook measures [data-flip-key] rows and glides the
  // movers. It glides only on a genuine reorder; `searchOpen` is threaded in
  // so it can suppress its glide on a search toggle (whose row motion is the
  // CSS height transition — a FLIP glide there fought it, snapping the
  // content up ahead of the collapsing field).
  const sidebarRef = useRef<HTMLElement>(null);
  // The session list scrolls between a fixed search header and the pinned
  // Settings footer; useScrollEdges drives the top/bottom content-fade (mirrors
  // the conversation pane) so an edge only blurs when content overflows it.
  const listRef = useRef<HTMLDivElement>(null);
  // `groups` as the re-observe signal (audit 2026-07-24, M5): this list's
  // direct children are React-minted per-date groups, and the hook snapshots
  // the child set once. At mount the list is EMPTY (sessions load async), so
  // nothing was ever observed and the fog never lit; a search toggle likewise
  // left the observed set stale. The memo's identity changes exactly when the
  // rendered groups do.
  const edges = useScrollEdges(listRef, groups);
  const reduced = useReducedMotion();
  const flipKeys = useMemo(
    () =>
      Array.from(groups.entries()).flatMap(([label, items]) => [
        `label:${label}`,
        ...items.map((s) => s.sessionId),
      ]),
    [groups],
  );
  useFlipList(sidebarRef, flipKeys, reduced, searchOpen);

  return (
    <aside className="sidebar" data-testid="sidebar" ref={sidebarRef}>
      <div className={`sidebar-search-wrap${searchOpen ? " is-open" : ""}`}>
        <div className="sidebar-search-inner">
          <input
            ref={searchInputRef}
            className="sidebar-search"
            type="text"
            placeholder={t("session.searchPlaceholder")}
            aria-label={t("session.filterAria")}
            aria-hidden={!searchOpen}
            tabIndex={searchOpen ? 0 : -1}
            value={query}
            onChange={(e) => props.onQueryChange?.(e.target.value)}
            onKeyDown={(e) => {
              // A zh user cancelling an IME candidate list with Escape must
              // not lose the whole search field (and its query) with it.
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape") {
                // Consume it. An Escape that closes the search must not also
                // reach the approval panel's window listener, which reads a
                // stray Escape as "deny the pending permission" (audit
                // 2026-07-24, H2). The panel now origin-tests as well — this
                // is the belt to that braces.
                e.stopPropagation();
                props.onCloseSearch?.();
              }
            }}
          />
        </div>
      </div>
      <div
        ref={listRef}
        className={`sidebar-list${edges.top ? " has-fog-top" : ""}${
          edges.bottom ? " has-fog-bottom" : ""
        }`}
      >
        {searchingEmpty ? (
          // The content scan hasn't answered yet — say so rather than
          // claiming the workspace has nothing (audit 2026-07-24, 1.13).
          <div className="sidebar-empty">{t("session.searching")}</div>
        ) : noMatches ? (
          <div className="sidebar-empty">
            {t("session.noMatches")}
            {scanState === "failed" ? ` ${t("session.searchUnavailable")}` : ""}
          </div>
        ) : (
          Array.from(groups.entries()).map(([label, items]) => (
            <SessionGroup
              key={label}
              label={label}
              sessions={items}
              snippets={q === "" ? undefined : contentHits}
            />
          ))
        )}
      </div>
      <button
        type="button"
        className="sidebar-settings"
        aria-label={t("topbar.settings")}
        onClick={props.onOpenSettings}
      >
        <SettingsIcon />
        <span className="sidebar-settings-label">{t("topbar.settings")}</span>
      </button>
    </aside>
  );
}
