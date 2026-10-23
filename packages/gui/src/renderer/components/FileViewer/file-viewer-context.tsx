import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useSessionScoped } from "../../hooks/useSessionScoped.js";
import { useShortcut } from "../../lib/shortcut-registry.js";

/**
 * The file-viewer panel's state (ADR 0050). Two contexts on purpose:
 *
 * - `FileViewerOpenContext` carries ONLY a stable opener (or null when the
 *   bridge cannot read files — the website demo). Record rows read this
 *   one, and its identity never changes, so the load-bearing
 *   record-identity memo chain (Conversation → ActivityBlock) is never
 *   invalidated by the panel opening — the same contract as
 *   `LightboxContext`.
 * - `FileViewerStateContext` carries the live state (target, width,
 *   docked/overlay) for the FEW consumers that must re-render with it:
 *   the panel, the workspace-body shell, and the rail's WebGL gates.
 */
/** Line range a cite anchors to (ADR 0050 v1.5): the panel scrolls there
 *  and highlights the band. 1-based, inclusive. */
export interface ViewerAnchor {
  readonly from: number;
  readonly to: number;
  /** The range counts a PDF's pages, not lines (a PDF quote's label, ADR
   *  0078 amendment 2026-10-21): the PDF view scrolls to the first. */
  readonly unit?: "page";
}

/** One open file: the record-spelled path to read, plus an optional
 *  display LABEL — an attachment's real file name, where `path` is its
 *  stored copy under `.herta/attachments/` and would read as machine
 *  internals in the tab (owner 2026-08-31) — and an optional line anchor
 *  from a finding cite. */
/** What a non-file tab shows (ADR 0059): a commit by id, a path's
 *  working-tree diff against HEAD, or the repository's history (§6).
 *  Absent = the file itself. */
export type ViewerTabKind = "commit" | "diff" | "log" | "page";

/** The page tab's path: a page tab is not a file, and there is one per
 *  session (ADR 0083 §2). */
export const PAGE_TAB_PATH = "page:";

export interface FileViewerTarget {
  /** The path to read — or, on a `commit` tab, the commit id (ADR 0059). */
  readonly path: string;
  /** A commit tab: `path` is a hex commit id and the panel reads the
   *  commit. A diff tab: `path` is the file whose change is shown.
   *  Absent = a file. */
  readonly kind?: ViewerTabKind;
  readonly label?: string;
  readonly anchor?: ViewerAnchor;
}

/** Options the opener takes beside the path. */
export interface OpenFileOpts {
  readonly kind?: ViewerTabKind;
  readonly label?: string;
  readonly anchor?: ViewerAnchor;
}

/** Tab cap (ADR 0050 v1.5): opening past it evicts the oldest inactive
 *  tab — a strip that scrolls is worse than a bounded one. */
export const MAX_VIEWER_TABS = 6;

export interface FileViewerState {
  /** Open files, in open order. Empty = panel closed. */
  readonly tabs: readonly FileViewerTarget[];
  /** Index of the shown tab; 0 when none. */
  readonly active: number;
  /** The shown tab, or null when closed. */
  readonly target: FileViewerTarget | null;
  /** Panel width in px (docked track / overlay sheet alike). */
  readonly widthPx: number;
  /** Measured workspace-body content width; 0 before first measure. */
  readonly bodyWidth: number;
  /** Open in COLUMN mode — the rail is parked (mode A). False while the
   *  threshold fallback has degraded the panel to an overlay sheet. */
  readonly docked: boolean;
  /** Open in any mode. */
  readonly open: boolean;
  /** Close the whole panel (all tabs). */
  readonly close: () => void;
  /** Show an already-open tab. */
  readonly activateTab: (index: number) => void;
  /** Close one tab; closing the last closes the panel. */
  readonly closeTab: (index: number) => void;
  /** Live width during a drag — state only, no storage write. */
  readonly setWidthPx: (w: number) => void;
  /** Persist the current width (the drag's pointer-up). `localStorage`'s
   *  setItem is a synchronous IPC to the browser process; a precision mouse
   *  delivers hundreds of pointer events a second, so the write rides the
   *  end of the gesture, not every frame of it (2026-09-03). */
  readonly persistWidthPx: () => void;
  readonly setBodyWidth: (w: number) => void;
}

const OpenContext = createContext<
  ((path: string, opts?: OpenFileOpts) => void) | null
>(null);
const StateContext = createContext<FileViewerState | null>(null);

/** The stable opener, or null when file reads are unavailable (no bridge
 *  method — the demo) or no provider is mounted (bare component tests).
 *  Rows render a plain, non-clickable name on null. */
export function useFileViewerOpen():
  | ((path: string, opts?: OpenFileOpts) => void)
  | null {
  return useContext(OpenContext);
}

/** Live panel state; null without a provider (bare tests). */
export function useFileViewerState(): FileViewerState | null {
  return useContext(StateContext);
}

/** True while the utility rail is parked behind the docked panel — the
 *  WebGL loops gate on this exactly as they gate on `disconnected`
 *  (ADR 0050 §4). */
export function useRailParked(): boolean {
  return useContext(StateContext)?.docked ?? false;
}

/** Conversation column minimum — MUST match the grid's minmax() in
 *  reference-ux.css. Exported for the clamp tests. */
export const CONVERSATION_MIN_PX = 560;
/** The conv|panel gap (the conversation's margin-right). */
export const VIEWER_GAP_PX = 24;
/** Panel minimum — below this the content is unreadable and the divider
 *  stops; the owner's "user must not be able to break the layout". */
export const VIEWER_MIN_PX = 320;
/** First-open default: the owner's picked 40% of the workspace. */
export const VIEWER_DEFAULT_FRACTION = 0.4;

const WIDTH_STORE_KEY = "herta.fileViewer.widthPx";

/** Clamp a requested panel width so the conversation keeps its minimum.
 *  When even the panel minimum cannot fit beside it, the caller degrades
 *  to overlay mode — this function only answers with a usable number.
 *  floor, not round: the measured body width is fractional during the
 *  sidebar slide, and rounding UP handed the panel a half-pixel the
 *  conversation didn't have (2026-09-01 flash bug — see below). */
export function clampViewerWidth(requested: number, bodyWidth: number): number {
  const max = bodyWidth - CONVERSATION_MIN_PX - VIEWER_GAP_PX;
  return Math.floor(
    Math.min(Math.max(requested, VIEWER_MIN_PX), Math.max(max, VIEWER_MIN_PX)),
  );
}

/** Column mode fits only when the panel MINIMUM leaves the conversation
 *  its minimum; otherwise the panel overlays (ADR 0050 thresholds).
 *
 *  Deliberately independent of the panel's current width: the old test
 *  (`bodyWidth - clampedWidth - gap >= conversation min`) sits at EXACT
 *  equality on every frame of a sidebar slide once the clamp binds, so
 *  sub-pixel measurement noise flipped docked↔overlay repeatedly — each
 *  overlay entry restarts the sheet animation from opacity 0, which the
 *  user sees as the panel flashing (2026-09-01, window mode + wide
 *  panel). The clamp already guarantees a docked panel leaves the
 *  conversation its floor, so the mode question is only "is the body
 *  wide enough for the panel minimum at all". */
export function viewerFitsDocked(bodyWidth: number): boolean {
  return bodyWidth - VIEWER_MIN_PX - VIEWER_GAP_PX >= CONVERSATION_MIN_PX;
}

function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(WIDTH_STORE_KEY);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function FileViewerProvider({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  // Session-scoped, deliberately (the transient-state audit class): a file
  // belongs to the session whose record named it — a switch, delete, or
  // disconnect closes the panel rather than pointing it at another
  // session's workspace. Tabs + active index travel as ONE value so a
  // session boundary can never strand an index into another session's list.
  const [tabState, setTabState] = useSessionScoped<{
    readonly tabs: readonly FileViewerTarget[];
    readonly active: number;
  }>({ tabs: [], active: 0 });
  const [widthPx, setWidthState] = useState<number>(
    () => readStoredWidth() ?? 0,
  );
  const [bodyWidth, setBodyWidth] = useState(0);

  // Availability rides the CONTEXT bridge — the same object the demo and
  // the test mock inject — never window.herta directly. Without the
  // optional method (the website demo today), file names simply render as
  // plain text.
  const { bridge } = useHertaBridge();
  const available = bridge.readWorkspaceFile !== undefined;

  const openRef = useCallback(
    (path: string, opts?: OpenFileOpts) => {
      const next: FileViewerTarget = {
        path,
        ...(opts?.kind !== undefined ? { kind: opts.kind } : {}),
        ...(opts?.label !== undefined ? { label: opts.label } : {}),
        ...(opts?.anchor !== undefined ? { anchor: opts.anchor } : {}),
      };
      setTabState((s) => {
        // Identity is the path AND the kind: a commit tab and a file tab
        // never collapse into each other.
        const existing = s.tabs.findIndex(
          (t) => t.path === path && t.kind === opts?.kind,
        );
        if (existing >= 0) {
          // Same file: refresh its target (a new cite re-anchors it) and
          // bring it forward.
          const tabs = s.tabs.map((t, i) => (i === existing ? next : t));
          return { tabs, active: existing };
        }
        // The page tab is pinned first (ADR 0083 §2).
        if (opts?.kind === "page")
          return { tabs: [next, ...s.tabs], active: 0 };
        let tabs = [...s.tabs, next];
        let active = tabs.length - 1;
        if (tabs.length > MAX_VIEWER_TABS) {
          // Evict the OLDEST tab that is not the page (never the one just
          // opened); the page is never evicted.
          const oldest = tabs.findIndex((t) => t.kind !== "page");
          tabs = tabs.filter((_, i) => i !== oldest);
          if (oldest < active) active -= 1;
        }
        return { tabs, active };
      });
    },
    [setTabState],
  );
  const close = useCallback(
    () => setTabState({ tabs: [], active: 0 }),
    [setTabState],
  );
  // Ctrl/⌘+Shift+B opens the panel on the page tab (ADR 0083 §2), where the
  // bridge has a page to show.
  const pageAvailable = bridge.pageShow !== undefined;
  useShortcut(
    "openBrowser",
    () => {
      openRef(PAGE_TAB_PATH, { kind: "page" });
      return true;
    },
    pageAvailable,
  );
  const activateTab = useCallback(
    (index: number) =>
      // Guard shape mirrors closeTab below — also keeps the comparison out
      // of the `>text<` window the no-hardcoded-english scanner reads as a
      // JSX text node.
      setTabState((s) =>
        index < 0 || index >= s.tabs.length ? s : { ...s, active: index },
      ),
    [setTabState],
  );
  const closeTab = useCallback(
    (index: number) =>
      setTabState((s) => {
        if (index < 0 || index >= s.tabs.length) return s;
        const tabs = s.tabs.filter((_, i) => i !== index);
        const active =
          tabs.length === 0
            ? 0
            : Math.min(
                s.active > index ? s.active - 1 : s.active,
                tabs.length - 1,
              );
        return { tabs, active };
      }),
    [setTabState],
  );
  // The latest width lives in a ref too, so the persist reads the value the
  // drag ended on rather than the render it was captured in.
  const widthRef = useRef(0);
  const setWidthPx = useCallback((w: number) => {
    widthRef.current = w;
    setWidthState(w);
  }, []);
  const persistWidthPx = useCallback(() => {
    if (widthRef.current <= 0) return;
    try {
      window.localStorage.setItem(
        WIDTH_STORE_KEY,
        String(Math.round(widthRef.current)),
      );
    } catch {
      // storage can be unavailable; the width just won't persist
    }
  }, []);

  const { tabs, active } = tabState;
  const target = tabs[active] ?? null;
  const open = tabs.length > 0;
  // Width resolves lazily against the measured body: stored value if sane,
  // else the 40% default — re-clamped every render so a window resize or
  // sidebar toggle can never leave a stale overwide panel.
  const effectiveWidth =
    bodyWidth > 0
      ? clampViewerWidth(
          widthPx > 0 ? widthPx : bodyWidth * VIEWER_DEFAULT_FRACTION,
          bodyWidth,
        )
      : Math.max(widthPx, VIEWER_MIN_PX);
  const docked = open && viewerFitsDocked(bodyWidth);

  const state = useMemo<FileViewerState>(
    () => ({
      tabs,
      active,
      target,
      widthPx: effectiveWidth,
      bodyWidth,
      docked,
      open,
      close,
      activateTab,
      closeTab,
      setWidthPx,
      persistWidthPx,
      setBodyWidth,
    }),
    [
      tabs,
      active,
      target,
      effectiveWidth,
      bodyWidth,
      docked,
      open,
      close,
      activateTab,
      closeTab,
      setWidthPx,
      persistWidthPx,
    ],
  );

  return (
    <OpenContext.Provider value={available ? openRef : null}>
      <StateContext.Provider value={state}>{children}</StateContext.Provider>
    </OpenContext.Provider>
  );
}
