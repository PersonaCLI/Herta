import { type RefObject, useEffect, useRef, useState } from "react";
import {
  type PageBounds,
  type PageState,
  typedPageUrl,
} from "../../../shared/browser-page.js";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { subscribeOverlayStack, topOverlay } from "../../lib/overlay-stack.js";
import { pageInMotion, subscribePageMotion } from "../../lib/page-motion.js";
import { PageNewTab } from "./PageNewTab.js";

/** How many frames the tab's box must hold still before the page is laid
 *  over it again: a drag or the panel's slide shows the still frame. */
const SETTLE_FRAMES = 6;

/** An overlay that draws over the viewer: everything on the stack except the
 *  approval panel, an inline layer that stays out of the page by placement
 *  (ADR 0083 §3). */
function coveredNow(): boolean {
  const top = topOverlay();
  return top !== null && top !== "approval";
}

/** The page's still frame, and the size it was taken at: it is drawn at that
 *  size from the top left, so a narrowing panel crops it rather than
 *  squashing it, and the page reflows when it is laid back on. */
export interface PageStill {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

const sameBox = (a: PageBounds | null, b: PageBounds | null): boolean =>
  a !== null &&
  b !== null &&
  a.x === b.x &&
  a.y === b.y &&
  a.width === b.width &&
  a.height === b.height;

/**
 * Keep main's page over the tab's content area (ADR 0083 §3). The page is a
 * native view drawn over the window, so it cannot follow the DOM by itself:
 * each frame the box is read, and the page is laid over it once it holds
 * still. It gives way to a still frame of itself — main takes it off at once
 * and answers with its last frame — the moment an overlay opens over the
 * viewer or the divider is pressed, and whenever the box moves (the panel
 * sliding, the window resized). At once on the first two, not on the next
 * frame: the page draws over any overlay, and under the pointer it takes the
 * mouse from the window (spike, 2026-10-23).
 */
function usePageSurface(
  sessionId: string,
  body: RefObject<HTMLDivElement | null>,
  live: boolean,
  setStill: (still: PageStill | null) => void,
): void {
  const { bridge } = useHertaBridge();
  useEffect(() => {
    if (!live || bridge.pageShow === undefined) return;
    let alive = true;
    let raf = 0;
    let busy = false;
    let quiet = 0;
    let last: PageBounds | null = null;
    let shown: PageBounds | null = null;
    let clearStill = 0;
    const freeze = async (): Promise<void> => {
      if (shown === null || busy) return;
      busy = true;
      const at = shown;
      shown = null;
      const shot = await (bridge.pageFreeze?.() ?? Promise.resolve(null)).catch(
        () => null,
      );
      if (!alive) return;
      if (shot !== null) {
        window.clearTimeout(clearStill);
        setStill({ src: shot, width: at.width, height: at.height });
      }
      busy = false;
    };
    const blocked = (): boolean => coveredNow() || pageInMotion();
    const offOverlay = subscribeOverlayStack(() => {
      if (blocked()) void freeze();
    });
    const offMotion = subscribePageMotion(() => {
      if (blocked()) void freeze();
    });
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const el = body.current;
      if (el === null || busy) return;
      const r = el.getBoundingClientRect();
      const box: PageBounds = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
      quiet = sameBox(box, last) ? quiet + 1 : 0;
      last = box;
      const wanted =
        box.width > 0 &&
        box.height > 0 &&
        !blocked() &&
        document.visibilityState === "visible";
      if (shown !== null) {
        if (!wanted || !sameBox(box, shown)) void freeze();
        return;
      }
      if (wanted && quiet >= SETTLE_FRAMES) {
        bridge.pageShow?.(sessionId, box);
        shown = box;
        window.clearTimeout(clearStill);
        clearStill = window.setTimeout(() => setStill(null), 150);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      offOverlay();
      offMotion();
      cancelAnimationFrame(raf);
      window.clearTimeout(clearStill);
      bridge.pageHide?.();
    };
  }, [bridge, sessionId, live, body, setStill]);
}

/** The page has somewhere to be: an address past the blank page. */
const isLive = (page: PageState | null): boolean =>
  page !== null && page.url.length > 0 && page.url !== "about:blank";

/** An address sent with Enter, shown until the page gets there: `from` is
 *  where the page was, `started` that its load has begun. */
interface Pending {
  readonly shown: string;
  readonly from: string;
  readonly started: boolean;
}

/**
 * The submitted address against the page's latest state: kept while the load
 * has not left `from`, gone once the page is somewhere else or the load ended
 * where it began (failed, stopped, the same address again). The bar showed the
 * old address — on a new tab, nothing — from Enter until the server answered
 * (owner 2026-10-28).
 */
export function settlePending(
  pending: Pending | null,
  page: PageState | null,
): Pending | null {
  if (pending === null || page === null) return pending;
  if (page.url !== pending.from) return null;
  if (page.loading) {
    return pending.started ? pending : { ...pending, started: true };
  }
  return pending.started ? null : pending;
}

/**
 * The page tab (ADR 0083 §2, §4): the browser's controls over the area the
 * page is laid on. The Trailblazer may go anywhere http(s) reaches; main
 * reads the address and decides, never the renderer.
 */
export function PageView({
  sessionId,
}: {
  readonly sessionId: string;
}): JSX.Element {
  const t = useT();
  const { bridge, sessionStore } = useHertaBridge();
  const body = useRef<HTMLDivElement | null>(null);
  const [page, setPage] = useState<PageState | null>(null);
  const [still, setStill] = useState<PageStill | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  // The picker (ADR 0083 §4): on, a click in the page picks an element for
  // the composer; main says when the pick is over.
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    setPicking(false);
    const off = bridge.onPagePicked?.((e) => {
      if (e.sessionId !== sessionId) return;
      setPicking(false);
      if (e.pick !== null) sessionStore.addComposerPick(e.pick);
    });
    return () => {
      off?.();
      bridge.pagePick?.(sessionId, false);
    };
  }, [bridge, sessionStore, sessionId]);

  useEffect(() => {
    let alive = true;
    setPage(null);
    void bridge.pageState?.(sessionId).then((s) => {
      if (alive && s !== null) setPage(s);
    });
    const off = bridge.onPageState?.((s) => {
      if (s.sessionId === sessionId) setPage(s);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [bridge, sessionId]);

  const live = isLive(page);
  useEffect(() => {
    setPending((p) => settlePending(p, page));
  }, [page]);
  usePageSurface(sessionId, body, live, setStill);
  // A page that goes away takes the pick with it.
  useEffect(() => {
    if (!live) setPicking(false);
  }, [live]);

  const go = (to: Parameters<NonNullable<typeof bridge.pageNavigate>>[1]) =>
    bridge.pageNavigate?.(sessionId, to);

  return (
    <div className="page-view" data-testid="page-view">
      <div className="page-view__bar">
        <button
          type="button"
          className="file-viewer__action"
          aria-label={t("page.back")}
          disabled={page?.canGoBack !== true}
          onClick={() => go({ go: "back" })}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M7.5 2.5 4 6l3.5 3.5" />
          </svg>
        </button>
        <button
          type="button"
          className="file-viewer__action"
          aria-label={t("page.forward")}
          disabled={page?.canGoForward !== true}
          onClick={() => go({ go: "forward" })}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4.5 2.5 8 6 4.5 9.5" />
          </svg>
        </button>
        <button
          type="button"
          className="file-viewer__action"
          aria-label={t(page?.loading === true ? "page.stop" : "page.reload")}
          disabled={!live}
          onClick={() => go({ go: page?.loading === true ? "stop" : "reload" })}
        >
          {page?.loading === true ? (
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          ) : (
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9.6 4.4A4 4 0 1 0 10 7" />
              <path d="M10 2v2.6H7.4" />
            </svg>
          )}
        </button>
        <form
          className="page-view__address"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed === null) return;
            const shown = typed.trim();
            // An address main would not load stays in the field to be put
            // right, rather than vanishing (main still reads it alone).
            if (typedPageUrl(shown) === null) return;
            go({ url: shown });
            setPending({ shown, from: page?.url ?? "", started: false });
            setTyped(null);
          }}
        >
          <input
            className="page-view__url"
            aria-label={t("page.address")}
            placeholder={t("page.addressPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            value={typed ?? pending?.shown ?? (live ? (page?.url ?? "") : "")}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              // Escape puts the address back; it is this field's.
              if (e.key === "Escape" && typed !== null) {
                e.preventDefault();
                e.stopPropagation();
                setTyped(null);
              }
            }}
          />
        </form>
        {bridge.pagePick !== undefined && (
          <button
            type="button"
            className={`file-viewer__action page-view__pick${picking ? " is-picking" : ""}`}
            aria-label={t(picking ? "page.pickStop" : "page.pick")}
            aria-pressed={picking}
            disabled={!live}
            onClick={() => {
              const on = !picking;
              setPicking(on);
              bridge.pagePick?.(sessionId, on);
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2.5 1.8 9.6 5.2 6.4 6.3 5.2 9.6Z" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className="file-viewer__action"
          aria-label={t("page.openExternal")}
          disabled={!live}
          onClick={() => void bridge.pageOpenExternal?.(sessionId)}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M7 2h3v3M10 2 5.5 6.5M8.5 7.5V10h-6.5V3.5H4.5" />
          </svg>
        </button>
      </div>
      <div ref={body} className="page-view__body">
        {still !== null && (
          <img
            className="page-view__still"
            src={still.src}
            style={{ width: still.width, height: still.height }}
            alt=""
            draggable={false}
          />
        )}
        {!live && <PageNewTab sessionId={sessionId} />}
      </div>
    </div>
  );
}
