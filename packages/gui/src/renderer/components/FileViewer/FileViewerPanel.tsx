import {
  lazy,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { useT } from "../../i18n/LocaleProvider.js";
import type {
  ReadWorkspaceBytesReply,
  ReadWorkspaceCommitReply,
  ReadWorkspaceDiffReply,
  ReadWorkspaceFileReply,
} from "../../ipc/bridge-types.js";
import { Tooltip } from "../Tooltip/Tooltip.js";
import {
  CONVERSATION_MIN_PX,
  clampViewerWidth,
  type FileViewerTarget,
  useFileViewerState,
  VIEWER_GAP_PX,
  VIEWER_MIN_PX,
  type ViewerAnchor,
} from "./file-viewer-context.js";
import {
  PieceQuoteIcon,
  type PieceQuoting,
  usePieceQuoting,
} from "./PieceQuote.js";
import { CodeView } from "./renderers/CodeView.js";
import { CommitView } from "./renderers/CommitView.js";
import { DiffView } from "./renderers/DiffView.js";
import { ImageView } from "./renderers/ImageView.js";
import { LogView } from "./renderers/LogView.js";
import { ViewerErrorBoundary } from "./renderers/ViewerErrorBoundary.js";
import {
  needsBytes,
  type ViewerKindInfo,
  viewerKindFor,
} from "./viewer-kind.js";

/**
 * The file-viewer panel (ADR 0050): read-only evidence beside the record.
 * Renders as the workspace grid's third track in docked mode (the rail
 * parked behind it) or as an absolute sheet in overlay mode — the
 * `.workspace-body` shell owns that distinction; this component is the
 * same DOM either way. v1.5: a bounded tab strip (open files), and line
 * anchors from finding cites (scroll + highlight band).
 *
 * ADR 0054: the file's KIND (by extension) picks the renderer — Markdown
 * as the page (with a source toggle), code with tokens, pictures, PDF,
 * Word, spreadsheets, decks. Rich kinds read bytes; each rich renderer is
 * its own lazy chunk behind an error boundary, so the base panel stays the
 * ADR 0050 text panel and a renderer failure is one honest notice.
 */

const MarkdownView = lazy(() =>
  import("./renderers/MarkdownView.js").then((m) => ({
    default: m.MarkdownView,
  })),
);
const CsvView = lazy(() =>
  import("./renderers/CsvView.js").then((m) => ({ default: m.CsvView })),
);
const PdfView = lazy(() =>
  import("./renderers/PdfView.js").then((m) => ({ default: m.PdfView })),
);
const DocxView = lazy(() =>
  import("./renderers/DocxView.js").then((m) => ({ default: m.DocxView })),
);
const SheetView = lazy(() =>
  import("./renderers/SheetView.js").then((m) => ({ default: m.SheetView })),
);
const SlidesView = lazy(() =>
  import("./renderers/SlidesView.js").then((m) => ({ default: m.SlidesView })),
);

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "text"; readonly reply: ReadWorkspaceFileReply }
  | { readonly kind: "bytes"; readonly reply: ReadWorkspaceBytesReply }
  /** A commit tab (ADR 0059): the target's kind, not a path, chose it. */
  | { readonly kind: "commit"; readonly reply: ReadWorkspaceCommitReply }
  /** A diff tab (ADR 0059 §5): the path's working-tree change. */
  | { readonly kind: "diff"; readonly reply: ReadWorkspaceDiffReply };

/** Markdown shows the page by default, a cited open too: the band lands on
 *  the blocks those lines render to (ADR 0054, amended 2026-10-13). Only a
 *  page whose blocks cannot be matched to its lines shows that cite at the
 *  source. The header toggle overrides per tab. */
type ViewMode = "rendered" | "source";

/** A tab's identity — the path AND the kind, the same rule the opener
 *  dedups by. A file tab and its diff tab share a path; keyed by path
 *  alone they shared a React key and a Markdown mode (UX review
 *  2026-09-22, item 19). */
function tabKey(tab: Pick<FileViewerTarget, "path" | "kind">): string {
  return `${tab.kind ?? "file"}:${tab.path}`;
}

/** How long the copy action's tip says "Copied" before it reverts. */
const COPIED_MS = 1500;

/** A control inside the panel that answers Escape itself: a text field (the
 *  history search) or an open menu (the branch picker). */
function claimsEscape(target: EventTarget): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  ) {
    return true;
  }
  return target.closest('[role="listbox"], [aria-expanded="true"]') !== null;
}

function tabName(tab: FileViewerTarget): string {
  if (tab.label !== undefined) return tab.label;
  const parts = tab.path.split("/").filter((s) => s.length > 0);
  const name = parts[parts.length - 1] ?? tab.path;
  // A diff tab and a file tab for the same path sit side by side; the
  // sign says which is which.
  return tab.kind === "diff" ? `± ${name}` : name;
}

export function FileViewerPanel(): JSX.Element | null {
  const t = useT();
  const v = useFileViewerState();
  const { bridge, sessionStore } = useHertaBridge();
  const sessionId = useSessionSelector((s) => s.sessionId);
  const sessionLang = useSessionSelector((s) => s.lang);
  const [pieceOn, togglePiece] = usePieceQuoting();
  const target = v?.target ?? null;
  const path = target?.path ?? null;
  const anchor = target?.anchor;
  const isCommit = target?.kind === "commit";
  const isDiff = target?.kind === "diff";
  const isLog = target?.kind === "log";
  const kindInfo: ViewerKindInfo =
    path === null
      ? { kind: "text" }
      : isCommit
        ? { kind: "commit" }
        : isDiff
          ? { kind: "diff" }
          : isLog
            ? { kind: "log" }
            : viewerKindFor(path);
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [modes, setModes] = useState<Readonly<Record<string, ViewMode>>>({});
  // Per tab, the cited target whose lines the rendered page could not place;
  // a new cite tries the page again.
  const [unplaced, setUnplaced] = useState<
    Readonly<Record<string, FileViewerTarget>>
  >({});
  const panelRef = useRef<HTMLElement | null>(null);
  // What the body currently shows, so a re-read of the same tab keeps it on
  // screen until the new read answers.
  const loadedKey = useRef<string | null>(null);

  // Keyed on the TARGET too, not only its path: a re-cite of an open file
  // replaces the target (a new cite, a new anchor) with the path unchanged,
  // and the tab kept showing what it read before 板砖 wrote the file — the
  // band on stale lines (UX review 2026-09-22, item 9). A re-cite is the
  // moment the file most likely changed, so it re-reads. Clicking an open
  // tab keeps its target and reads nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `target` is the re-read trigger, not an input
  useEffect(() => {
    setCopied("idle");
    if (path === null || sessionId === null) return;
    let alive = true;
    const key = `${kindInfo.kind}:${path}`;
    if (loadedKey.current !== key) setLoad({ kind: "loading" });
    loadedKey.current = key;
    const readText = bridge.readWorkspaceFile?.bind(bridge);
    const readBytes = bridge.readWorkspaceBytes?.bind(bridge);
    const readCommit = bridge.readWorkspaceCommit?.bind(bridge);
    const readDiff = bridge.readWorkspaceDiff?.bind(bridge);
    if (kindInfo.kind === "log") {
      // The log tab pages itself (LogView); nothing to load here.
      setLoad({ kind: "loading" });
    } else if (kindInfo.kind === "diff") {
      if (readDiff === undefined) {
        setLoad({ kind: "diff", reply: { ok: false, reason: "not_found" } });
      } else {
        readDiff(sessionId, path).then(
          (reply) => {
            if (alive) setLoad({ kind: "diff", reply });
          },
          () => {
            if (alive)
              setLoad({
                kind: "diff",
                reply: { ok: false, reason: "not_found" },
              });
          },
        );
      }
    } else if (kindInfo.kind === "commit") {
      // A commit tab reads the commit, never a file; without the bridge
      // method the tab answers with the commit notice.
      if (readCommit === undefined) {
        setLoad({
          kind: "commit",
          reply: { ok: false, reason: "not_found" },
        });
      } else {
        readCommit(sessionId, path).then(
          (reply) => {
            if (alive) setLoad({ kind: "commit", reply });
          },
          () => {
            if (alive)
              setLoad({
                kind: "commit",
                reply: { ok: false, reason: "not_found" },
              });
          },
        );
      }
    } else if (needsBytes(kindInfo.kind) && readBytes !== undefined) {
      // A rich kind without the bytes read (an older bridge) takes the text
      // read and lands on its binary notice — the ADR 0050 behaviour.
      readBytes(sessionId, path).then(
        (reply) => {
          if (alive) setLoad({ kind: "bytes", reply });
        },
        () => {
          if (alive)
            setLoad({
              kind: "bytes",
              reply: { ok: false, reason: "unreadable" },
            });
        },
      );
    } else if (readText === undefined) {
      setLoad({ kind: "text", reply: { ok: false, reason: "unreadable" } });
    } else {
      readText(sessionId, path).then(
        (reply) => {
          if (alive) setLoad({ kind: "text", reply });
        },
        () => {
          if (alive)
            setLoad({
              kind: "text",
              reply: { ok: false, reason: "unreadable" },
            });
        },
      );
    }
    return () => {
      alive = false;
    };
  }, [path, sessionId, bridge, kindInfo.kind, target]);
  useEffect(() => {
    if (path === null) loadedKey.current = null;
  }, [path]);

  // A new target for a tab (a fresh cite) drops that tab's toggle so the
  // anchor rule applies again. Only a NEW target: activating an open tab
  // shows its existing target, and resetting there threw away the toggle
  // on every tab switch (UX review 2026-09-22, item 19).
  const seenTargets = useRef(new WeakSet<FileViewerTarget>());
  useEffect(() => {
    if (target === null) return;
    if (seenTargets.current.has(target)) return;
    seenTargets.current.add(target);
    const key = tabKey(target);
    setModes((m) => {
      if (!(key in m)) return m;
      const next = { ...m };
      delete next[key];
      return next;
    });
  }, [target]);

  // "Copied" is a moment, not a state: it reverts on its own (UX review
  // 2026-09-22, item 21 — it stayed until the path changed). So is a refused
  // write, which is said rather than swallowed (2026-09-30).
  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // Focus the panel on open so Escape works immediately; the opener (a
  // record row) keeps working for keyboard users because focus moves to a
  // labeled region, not into the void. On close, focus goes back to the
  // opener when nothing else took it: left on body, the next Escape was
  // "nobody's" — and the approval panel used to count that as its own and
  // deny (UX review 2026-09-22, item 2).
  //
  // Both focus calls pass preventScroll (owner 2026-09-24). A plain focus()
  // scrolls its target into view, and both targets can be OFF-SCREEN when
  // focused: the panel slides in from the right, and an opener in the
  // repository card sits in the rail, which is parked 777px to the right
  // when the close begins. Focusing that row scrolled the whole .app 656px
  // left: the sidebar vanished, the cards appeared mid-window without
  // sliding, then fought the unwinding scroll back to their rest — "the
  // cards bounce". A record-row opener is on screen, so it never showed there.
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (path !== null) {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        active !== document.body &&
        panel !== null &&
        !panel.contains(active)
      ) {
        returnFocus.current = active;
      }
      panel?.focus({ preventScroll: true });
      return;
    }
    const back = returnFocus.current;
    returnFocus.current = null;
    const active = document.activeElement;
    if (back?.isConnected && (active === null || active === document.body)) {
      back.focus({ preventScroll: true });
    }
  }, [path]);

  const onDividerDown = useDividerDrag();

  if (v === null || path === null) return null;

  // The copy action's text: the workspace-relative path, or on a commit
  // tab the full commit id.
  const relative =
    load.kind === "loading" || !load.reply.ok
      ? path
      : load.kind === "commit"
        ? load.reply.commit.sha
        : load.kind === "diff"
          ? load.reply.diff.path
          : load.reply.relative;
  // Piece quoting (ADR 0078): the code layout and rendered markdown, and a
  // PDF's text (ADR 0078 amendment 2026-10-21).
  const quotable =
    (load.kind === "text" && load.reply.ok && kindInfo.kind !== "csv") ||
    (load.kind === "bytes" && load.reply.ok && kindInfo.kind === "pdf");
  const piece: PieceQuoting | undefined = quotable
    ? {
        enabled: pieceOn,
        path: relative,
        lang: sessionLang,
        onQuote: (quotes) => {
          for (const q of quotes) sessionStore.addComposerQuote(q);
        },
        onNoText: () =>
          sessionStore.setComposerNotice(t("viewer.piece.noText")),
      }
    : undefined;
  const activeName = tabName(v.tabs[v.active] ?? { path });
  const modeKey = tabKey(target ?? { path });
  const mode: ViewMode =
    modes[modeKey] ??
    (anchor !== undefined && target !== null && unplaced[modeKey] === target
      ? "source"
      : "rendered");
  const onAnchorUnmapped =
    target === null
      ? undefined
      : (): void =>
          setUnplaced((u) =>
            u[modeKey] === target ? u : { ...u, [modeKey]: target },
          );
  const isMarkdown = kindInfo.kind === "markdown";

  return (
    <section
      ref={panelRef}
      className="file-viewer"
      data-testid="file-viewer"
      data-kind={kindInfo.kind}
      aria-label={activeName}
      tabIndex={-1}
      onKeyDown={(e) => {
        // Escape belongs to the innermost thing that answers it: the
        // history search and the branch picker handle their own, and the
        // panel closes only on one nothing inside claimed (UX review
        // 2026-09-22, item 18 — Escape in the search box closed the viewer).
        if (e.key !== "Escape" || e.defaultPrevented) return;
        if (claimsEscape(e.target)) return;
        // Marked: this Escape closed the viewer, it does not stop the run
        // (ADR 0082 §5).
        e.preventDefault();
        v.close();
      }}
    >
      {/* Pointer-only resize affordance; the width also self-clamps on
          every resize, so no keyboard path is required to keep the layout
          sane. Hidden from the tree — it narrates nothing useful, and the
          col-resize cursor + hover line ARE the hint (no native title:
          the OS-beige tooltip mismatch, owner 2026-08-10/31). */}
      <div
        className="file-viewer__divider"
        aria-hidden="true"
        onPointerDown={onDividerDown}
      />
      <div className="file-viewer__head">
        {/* Open files as a bounded tab strip (ADR 0050 v1.5). Each chip's
            own × closes THAT file; the header × closes the whole panel. */}
        <div className="file-viewer__tabs" role="tablist">
          {v.tabs.map((tab, i) => (
            <span
              key={tabKey(tab)}
              className={`file-viewer__tab${i === v.active ? " is-active" : ""}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={i === v.active}
                className="file-viewer__tab-name"
                onClick={() => v.activateTab(i)}
              >
                {tabName(tab)}
              </button>
              <button
                type="button"
                className="file-viewer__tab-x"
                aria-label={`${t("viewer.closeTab")} ${tabName(tab)}`}
                onClick={() => v.closeTab(i)}
              >
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 9 9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M1.5 1.5l6 6M7.5 1.5l-6 6" />
                </svg>
              </button>
            </span>
          ))}
        </div>
        {/* The app's styled pill, not native `title` (owner 2026-08-31 — the
          same OS-beige mismatch the attachment ✕ had), and PORTALED so the
          panel's overflow clip can't cut it. */}
        <span className="file-viewer__actions">
          {piece !== undefined && (
            <Tooltip
              label={t(
                pieceOn ? "viewer.piece.turnOff" : "viewer.piece.turnOn",
              )}
              placement="bottom"
              align="center"
              portal
            >
              <button
                type="button"
                className={`file-viewer__action${pieceOn ? " is-on" : ""}`}
                data-testid="viewer-piece-switch"
                aria-pressed={pieceOn}
                aria-label={t(
                  pieceOn ? "viewer.piece.turnOff" : "viewer.piece.turnOn",
                )}
                onClick={togglePiece}
              >
                <PieceQuoteIcon on={pieceOn} />
              </button>
            </Tooltip>
          )}
          {isMarkdown && (
            <Tooltip
              label={
                mode === "rendered"
                  ? t("viewer.showSource")
                  : t("viewer.showRendered")
              }
              placement="bottom"
              align="center"
              portal
            >
              <button
                type="button"
                className={`file-viewer__action${mode === "source" ? " is-on" : ""}`}
                data-testid="viewer-toggle-source"
                aria-pressed={mode === "source"}
                aria-label={
                  mode === "rendered"
                    ? t("viewer.showSource")
                    : t("viewer.showRendered")
                }
                onClick={() =>
                  setModes((m) => ({
                    ...m,
                    [modeKey]: mode === "rendered" ? "source" : "rendered",
                  }))
                }
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 13 13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4.5 3.5 1.5 6.5l3 3M8.5 3.5l3 3-3 3" />
                </svg>
              </button>
            </Tooltip>
          )}
          {/* The history tab has nothing to copy. */}
          {!isLog && (
            <Tooltip
              label={
                copied === "copied"
                  ? t("viewer.copied")
                  : copied === "failed"
                    ? t("viewer.copyFailed")
                    : isCommit
                      ? t("viewer.copySha")
                      : t("viewer.copyPath")
              }
              placement="bottom"
              align="center"
              portal
            >
              <button
                type="button"
                className="file-viewer__action"
                aria-label={
                  isCommit ? t("viewer.copySha") : t("viewer.copyPath")
                }
                onClick={() => {
                  const write = navigator.clipboard?.writeText(relative);
                  if (write === undefined) {
                    setCopied("failed");
                    return;
                  }
                  void write.then(
                    () => setCopied("copied"),
                    () => setCopied("failed"),
                  );
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 13 13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  aria-hidden="true"
                >
                  <rect x="4" y="4" width="7" height="7" rx="1.5" />
                  <path d="M9 4V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v4.5A1.5 1.5 0 0 0 3 9h1" />
                </svg>
              </button>
            </Tooltip>
          )}
          {/* A commit is not a file the OS could open; neither is history. */}
          {!isCommit && !isLog && (
            <Tooltip
              label={t("viewer.openExternal")}
              placement="bottom"
              align="center"
              portal
            >
              <button
                type="button"
                className="file-viewer__action"
                aria-label={t("viewer.openExternal")}
                onClick={() => {
                  if (sessionId !== null)
                    void bridge.openWorkspaceFile?.(sessionId, path);
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 13 13"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M5.5 2.5H3A1.5 1.5 0 0 0 1.5 4v6A1.5 1.5 0 0 0 3 11.5h6A1.5 1.5 0 0 0 10.5 10V7.5" />
                  <path d="M7.5 1.5h4v4M11.2 1.8 6.5 6.5" />
                </svg>
              </button>
            </Tooltip>
          )}
          <Tooltip
            label={t("viewer.close")}
            placement="bottom"
            align="center"
            portal
          >
            <button
              type="button"
              className="file-viewer__action"
              aria-label={t("viewer.close")}
              onClick={v.close}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
              </svg>
            </button>
          </Tooltip>
        </span>
      </div>
      <FileViewerBody
        path={path}
        load={load}
        kindInfo={kindInfo}
        mode={mode}
        anchor={anchor}
        onAnchorUnmapped={onAnchorUnmapped}
        piece={piece}
      />
    </section>
  );
}

function Notice({ text }: { readonly text: string }): JSX.Element {
  return (
    <div className="file-viewer__body">
      <p className="file-viewer__notice">{text}</p>
    </div>
  );
}

function FileViewerBody({
  path,
  load,
  kindInfo,
  mode,
  anchor,
  onAnchorUnmapped,
  piece,
}: {
  readonly path: string;
  readonly load: LoadState;
  readonly kindInfo: ViewerKindInfo;
  readonly mode: ViewMode;
  readonly anchor?: ViewerAnchor | undefined;
  readonly onAnchorUnmapped?: (() => void) | undefined;
  readonly piece?: PieceQuoting | undefined;
}): JSX.Element {
  const t = useT();
  if (kindInfo.kind === "log") {
    return (
      <ViewerErrorBoundary
        key="log"
        fallback={<Notice text={t("viewer.renderFailed")} />}
      >
        <LogView />
      </ViewerErrorBoundary>
    );
  }
  if (load.kind === "loading") {
    // A local read answers in single-digit milliseconds; a spinner would
    // only flash. Hold the empty body for the beat.
    return <div className="file-viewer__body" />;
  }
  if (load.kind === "diff") {
    if (!load.reply.ok) {
      return (
        <Notice
          text={t(
            load.reply.reason === "outside_workspace"
              ? "viewer.outside"
              : load.reply.reason === "timeout"
                ? "viewer.timeout"
                : "viewer.diff.notFound",
          )}
        />
      );
    }
    return (
      <ViewerErrorBoundary
        key={`diff:${path}`}
        fallback={<Notice text={t("viewer.renderFailed")} />}
      >
        <DiffView diff={load.reply.diff} />
      </ViewerErrorBoundary>
    );
  }
  if (load.kind === "commit") {
    if (!load.reply.ok) {
      return (
        <Notice
          text={t(
            load.reply.reason === "timeout"
              ? "viewer.timeout"
              : "viewer.commit.notFound",
          )}
        />
      );
    }
    return (
      <ViewerErrorBoundary
        key={`commit:${path}`}
        fallback={<Notice text={t("viewer.renderFailed")} />}
      >
        <CommitView commit={load.reply.commit} />
      </ViewerErrorBoundary>
    );
  }
  const { reply } = load;
  if (!reply.ok) {
    const key =
      reply.reason === "not_found" || reply.reason === "not_a_file"
        ? "viewer.notFound"
        : reply.reason === "binary"
          ? "viewer.binary"
          : reply.reason === "outside_workspace"
            ? "viewer.outside"
            : reply.reason === "too_large"
              ? "viewer.tooLarge"
              : "viewer.unreadable";
    return <Notice text={t(key)} />;
  }
  const failed = <Notice text={t("viewer.renderFailed")} />;
  const pending = <div className="file-viewer__body" />;
  let body: JSX.Element;
  if (load.kind === "text") {
    const { content, truncated } = load.reply as Extract<
      ReadWorkspaceFileReply,
      { ok: true }
    >;
    switch (kindInfo.kind) {
      case "markdown":
        body =
          mode === "rendered" ? (
            <MarkdownView
              content={content}
              truncated={truncated}
              piece={piece}
              anchor={anchor}
              onAnchorUnmapped={onAnchorUnmapped}
            />
          ) : (
            <CodeView
              content={content}
              truncated={truncated}
              language="markdown"
              anchor={anchor}
              piece={piece}
            />
          );
        break;
      case "csv":
        body = <CsvView content={content} truncated={truncated} />;
        break;
      default:
        body = (
          <CodeView
            content={content}
            truncated={truncated}
            language={kindInfo.language}
            anchor={anchor}
            piece={piece}
          />
        );
        break;
    }
  } else {
    const { bytes } = load.reply as Extract<
      ReadWorkspaceBytesReply,
      { ok: true }
    >;
    switch (kindInfo.kind) {
      case "image":
        body = <ImageView bytes={bytes} path={path} />;
        break;
      case "pdf":
        body = (
          <PdfView
            bytes={bytes}
            piece={piece}
            anchor={anchor?.unit === "page" ? anchor : undefined}
          />
        );
        break;
      case "docx":
        body = <DocxView bytes={bytes} />;
        break;
      case "xlsx":
        body = <SheetView bytes={bytes} />;
        break;
      case "pptx":
        body = <SlidesView bytes={bytes} />;
        break;
      default:
        // A bytes reply for a text kind cannot happen (the read is chosen
        // by kind); the honest answer if it ever does is the notice.
        body = failed;
        break;
    }
  }
  return (
    <ViewerErrorBoundary key={`${path}:${mode}`} fallback={failed}>
      <Suspense fallback={pending}>{body}</Suspense>
    </ViewerErrorBoundary>
  );
}

/** Divider drag: pointer-captured, transition-suppressed via the
 *  `is-resizing` class on the workspace-body, clamped so neither pane can
 *  break the layout (ADR 0050 — conversation ≥560px, panel ≥320px). */
function useDividerDrag(): (e: ReactPointerEvent<HTMLDivElement>) => void {
  const v = useFileViewerState();
  return useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (v === null) return;
      const divider = e.currentTarget;
      const body = divider.closest(".workspace-body");
      const startX = e.clientX;
      const startW = v.widthPx;
      // Capture is an enhancement (keeps the drag alive off the strip); a
      // capture failure must not abort the drag half-armed — pre-fix it
      // threw before the listeners attached and left `is-resizing` stuck
      // on the grid (caught live via a synthetic pointer, 2026-08-31).
      try {
        divider.setPointerCapture(e.pointerId);
      } catch {
        // fall through — window-level listeners below still track the drag
      }
      body?.classList.add("is-resizing");
      const onMove = (ev: PointerEvent): void => {
        const w = clampViewerWidth(startW + (startX - ev.clientX), v.bodyWidth);
        v.setWidthPx(w);
      };
      const onUp = (): void => {
        // One storage write per gesture, not per frame (see persistWidthPx).
        v.persistWidthPx();
        body?.classList.remove("is-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      // Window-level on purpose: a real drag leaves the 9px strip on its
      // first frame, and the capture above is best-effort.
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [v],
  );
}

// Re-exported so the shell (App) and tests share one source of the
// layout constants without importing the context module twice.
export { CONVERSATION_MIN_PX, VIEWER_GAP_PX, VIEWER_MIN_PX };
