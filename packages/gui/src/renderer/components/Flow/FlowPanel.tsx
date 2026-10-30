import { Marked } from "marked";
import {
  type CSSProperties,
  type JSX,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  FlowIssueView,
  FlowPostView,
  FlowStateView,
} from "../../../shared/flow.js";
import stationIcon from "../../assets/herta-station-icon.png";
import stationIconNight from "../../assets/herta-station-icon-night.png";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { useLocale, useT } from "../../i18n/LocaleProvider.js";
import { OVERLAY_Z, useModalOverlay } from "../../lib/overlay-stack.js";
import {
  PAGE_TAB_PATH,
  useFileViewerOpen,
} from "../FileViewer/file-viewer-context.js";
import { setSanitizedHtml } from "../FileViewer/renderers/dom-html.js";
import {
  dayLabel,
  dayText,
  type FlowDay,
  type FlowDayPost,
  flowDays,
  latestNumber,
  localDay,
  siteHue,
  siteMark,
} from "./flow-days.js";
import { HertaAvatar } from "./HertaAvatar.js";

/**
 * Flow (ADR 0084): the day's issue of the Trailblazer's world, as a panel of
 * its own over the main area (§2) — the one-line masthead, day tabs, posts
 * with Herta's word under each, a post that opens in place, and an end.
 * It joins the overlay stack under the approval card, so a request that
 * arrives while it is open still draws above it, and the page view parks.
 */
export function FlowPanel(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly state: FlowStateView;
  readonly issues: readonly FlowIssueView[];
  readonly onRefresh: () => void;
  readonly onMarkRead: (issueId: string) => void;
  readonly onTurnOn: () => void;
  /** Ask Herta (§9); absent → no such button. */
  readonly onAsk?: (post: FlowPostView) => void;
}): JSX.Element | null {
  const t = useT();
  const { locale } = useLocale();
  const { bridge } = useHertaBridge();
  const openFile = useFileViewerOpen();
  const sessionId = useSessionSelector((s) => s.sessionId);
  const isTop = useModalOverlay("flow", props.open, OVERLAY_Z.flow);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(props.open);
  const [opened, setOpened] = useState<{
    post: FlowDayPost;
    from: DOMRect | null;
  } | null>(null);
  // Going back plays out before the post unmounts: it shrinks into its card
  // while the list returns (owner 2026-10-30: back "suddenly changed").
  const [closing, setClosing] = useState(false);
  // Her word types in the first time a post is seen (§3): the posts of the
  // issue unread when the panel opened.
  const [typing, setTyping] = useState<string | null>(null);

  const days = useMemo(
    () => flowDays(props.issues).slice(0, 7),
    [props.issues],
  );
  const today = localDay(new Date());
  const number = latestNumber(props.issues);

  useEffect(() => {
    if (props.open) setMounted(true);
  }, [props.open]);

  // Opening: the unread issue's words type in, and it is marked read.
  const unread = props.state.unreadIssueId;
  useEffect(() => {
    if (!props.open || unread === null) return;
    setTyping(unread);
    props.onMarkRead(unread);
  }, [props.open, unread, props.onMarkRead]);

  useEffect(() => {
    if (!props.open || !isTop) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (opened !== null) setClosing(true);
      else props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, isTop, opened, props.onClose]);

  // 查看原文 with no session open: a session is made and the page opens in
  // its browser once it is up (owner 2026-10-30: it went to the OS browser).
  // After the viewer's own reset for the new session, which runs in the same
  // commit's effects and would close a tab opened before it.
  const pendingSource = useRef<string | null>(null);
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  useEffect(() => {
    const url = pendingSource.current;
    if (url === null || sessionId === null) return;
    pendingSource.current = null;
    window.setTimeout(() => {
      bridge.pageNavigate?.(sessionId, { url });
      openFileRef.current?.(PAGE_TAB_PATH, { kind: "page" });
    }, 0);
  }, [sessionId, bridge]);

  if (!mounted) return null;
  // The source opens in the app's own browser, in the page tab (owner
  // 2026-10-30), and Flow closes so the tab can be seen. The page belongs to
  // a session: with none open, one is made first. Only where the app has no
  // browser does the OS browser open it.
  const openSource = (url: string): void => {
    if (openFile === null || bridge.pageNavigate === undefined) {
      bridge.flowOpenSource?.(url);
      return;
    }
    props.onClose();
    if (sessionId !== null) {
      bridge.pageNavigate(sessionId, { url });
      openFile(PAGE_TAB_PATH, { kind: "page" });
      return;
    }
    pendingSource.current = url;
    const giveUp = (): void => {
      pendingSource.current = null;
      bridge.flowOpenSource?.(url);
    };
    void bridge.createSession({}).then((s) => {
      if (s === null) giveUp();
    }, giveUp);
  };
  const jump = (localDate: string): void => {
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-flow-day="${localDate}"]`,
    );
    if (el !== null && el !== undefined && scrollRef.current !== null)
      scrollRef.current.scrollTo({
        top: el.offsetTop - 12,
        behavior: "smooth",
      });
  };
  const dayName = (localDate: string): string => {
    const l = dayLabel(localDate, today);
    if (l.kind === "today") return t("flow.today");
    if (l.kind === "yesterday") return t("flow.yesterday");
    return t(`flow.weekday${l.weekday}` as "flow.weekday0");
  };
  const dateText = (localDate: string): string =>
    dayText(localDate, locale === "zh" ? "zh" : "en");

  return (
    <section
      className={`flow-panel${props.open ? " is-open" : ""}${opened !== null && !closing ? " is-reading" : ""}`}
      aria-label={t("flow.title")}
      data-testid="flow-panel"
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && !props.open) setMounted(false);
      }}
    >
      <div className="flow-scroll" ref={scrollRef}>
        <div className="flow-col">
          <header className="flow-mast">
            <StationIcon />
            <b className="flow-mast-name">{t("flow.masthead")}</b>
            {number !== null && (
              <span>{t("flow.issueNumber", { n: number })}</span>
            )}
            <span>· {t("flow.relay")}</span>
            <i className="flow-mast-rule" />
          </header>
          {days.length > 0 && (
            <nav className="flow-tabs" aria-label={t("flow.days")}>
              {days.map((d) => (
                <button
                  key={d.localDate}
                  type="button"
                  className={`flow-tab${d.localDate === today && props.state.gathering !== null ? " is-gathering" : ""}${unread !== null && d.issueIds.includes(unread) ? " is-unseen" : ""}`}
                  onClick={() => jump(d.localDate)}
                >
                  {dayName(d.localDate)}
                </button>
              ))}
            </nav>
          )}
          <FlowStateCard
            state={props.state}
            hasToday={days[0]?.localDate === today}
            onRefresh={props.onRefresh}
            onTurnOn={props.onTurnOn}
          />
          {days.map((d) => (
            <FlowDaySection
              key={d.localDate}
              day={d}
              name={dayName(d.localDate)}
              date={dateText(d.localDate)}
              typing={typing}
              onOpen={(post, from) => setOpened({ post, from })}
            />
          ))}
          {days.length > 0 && <p className="flow-end">{t("flow.end")}</p>}
        </div>
      </div>
      {opened !== null && (
        <FlowOpened
          post={opened.post}
          from={opened.from}
          closing={closing}
          onBack={() => setClosing(true)}
          onClosed={() => {
            setOpened(null);
            setClosing(false);
          }}
          onOpenSource={() => openSource(opened.post.url)}
          {...(props.onAsk !== undefined
            ? { onAsk: () => props.onAsk?.(opened.post) }
            : {})}
        />
      )}
    </section>
  );
}

function FlowStateCard(props: {
  readonly state: FlowStateView;
  readonly hasToday: boolean;
  readonly onRefresh: () => void;
  readonly onTurnOn: () => void;
}): JSX.Element | null {
  const t = useT();
  const s = props.state;
  if (!s.enabled)
    return (
      <div className="flow-state">
        <h3>{t("flow.off.title")}</h3>
        <p>{t("flow.off.body")}</p>
        <button type="button" onClick={props.onTurnOn}>
          {t("flow.off.turnOn")}
        </button>
      </div>
    );
  if (s.gathering !== null)
    return <FlowGathering gathering={s.gathering} skeleton={!props.hasToday} />;
  if (s.failed !== null && !props.hasToday)
    return (
      <div className="flow-state">
        <h3>{t("flow.failed.title")}</h3>
        <p>{t(`flow.failed.${s.failed}` as "flow.failed.other")}</p>
        {s.failed !== "no_key" && (
          <button type="button" onClick={props.onRefresh}>
            {t("flow.retry")}
          </button>
        )}
      </div>
    );
  return null;
}

const STAGES = ["queries", "search", "cards", "detail", "word"] as const;

/**
 * An issue being gathered (owner 2026-10-30: it "looks like a draft"): the
 * signal, the step in words, a bar across the five stages, the stages as a
 * tracker, and — before the day has an issue — placeholder posts where the
 * posts will land.
 */
function FlowGathering(props: {
  readonly gathering: NonNullable<FlowStateView["gathering"]>;
  readonly skeleton: boolean;
}): JSX.Element {
  const t = useT();
  const g = props.gathering;
  const at = Math.max(0, STAGES.indexOf(g.stage));
  const within =
    g.i !== undefined && g.n !== undefined && g.n > 0
      ? Math.min(1, g.i / g.n)
      : 0.5;
  const done = Math.round(((at + within) / STAGES.length) * 100);
  return (
    <>
      <div className="flow-gather" aria-live="polite">
        <div className="flow-gather-head">
          <span className="flow-gather-signal" aria-hidden="true">
            <StationIcon />
          </span>
          <div>
            <h3>{t("flow.gathering.title")}</h3>
            <p>
              {g.i !== undefined && g.n !== undefined
                ? t(`flow.stage.${g.stage}N` as "flow.stage.searchN", {
                    i: g.i,
                    n: g.n,
                  })
                : t(`flow.stage.${g.stage}` as "flow.stage.queries")}
            </p>
          </div>
        </div>
        <div
          className="flow-gather-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={done}
        >
          <i style={{ width: `${done}%` }} />
        </div>
        <ol className="flow-gather-steps">
          {STAGES.map((stage, k) => (
            <li
              key={stage}
              className={k < at ? "is-done" : k === at ? "is-now" : undefined}
            >
              <span className="flow-gather-dot" aria-hidden="true" />
              {t(`flow.step.${stage}` as "flow.step.queries")}
            </li>
          ))}
        </ol>
      </div>
      {props.skeleton && (
        <div className="flow-skeleton" aria-hidden="true">
          <div className="flow-skel-lead">
            <i className="flow-skel-pic" />
            <i className="flow-skel-line" style={{ width: "72%" }} />
            <i className="flow-skel-line" style={{ width: "48%" }} />
          </div>
          {[0, 1].map((n) => (
            <div key={n} className="flow-skel-row">
              <div>
                <i className="flow-skel-line" style={{ width: "34%" }} />
                <i className="flow-skel-line" style={{ width: "88%" }} />
                <i className="flow-skel-line" style={{ width: "64%" }} />
              </div>
              <i className="flow-skel-thumb" />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** A day: its lead story large, the rest as compact rows (an issue has a
 *  front page, owner 2026-10-30: "the cards seem too huge"). */
function FlowDaySection(props: {
  readonly day: FlowDay;
  readonly name: string;
  readonly date: string;
  readonly typing: string | null;
  readonly onOpen: (post: FlowDayPost, from: DOMRect | null) => void;
}): JSX.Element {
  const t = useT();
  const [lead, ...rest] = props.day.posts;
  return (
    <>
      <div className="flow-day" data-flow-day={props.day.localDate}>
        <b>{props.name}</b>
        <span>
          {props.date} · {t("flow.posts", { n: props.day.posts.length })}
        </span>
      </div>
      {lead === undefined && (
        <p className="flow-thin">{t("flow.nothingNew")}</p>
      )}
      {lead !== undefined && (
        <FlowPost
          key={`${lead.issueId}/${lead.id}`}
          post={lead}
          index={0}
          lead
          typeWord={props.typing === lead.issueId}
          when={props.name}
          onOpen={props.onOpen}
        />
      )}
      {rest.length > 0 && (
        <div className="flow-list">
          {rest.map((p, i) => (
            <FlowPost
              key={`${p.issueId}/${p.id}`}
              post={p}
              index={i + 1}
              lead={false}
              typeWord={props.typing === p.issueId}
              when={props.name}
              onOpen={props.onOpen}
            />
          ))}
        </div>
      )}
    </>
  );
}

/** One post: the lead with its picture across the top and the title over
 *  it, or a row with its number, its words and a small picture beside. */
function FlowPost(props: {
  readonly post: FlowDayPost;
  readonly index: number;
  readonly lead: boolean;
  readonly typeWord: boolean;
  readonly when: string;
  readonly onOpen: (post: FlowDayPost, from: DOMRect | null) => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const p = props.post;
  const open = (): void =>
    props.onOpen(p, ref.current?.getBoundingClientRect() ?? null);
  const meta = (
    <div className="flow-post-meta">
      <SiteMark site={p.site} />
      <span className="flow-post-site">{p.site}</span>
      <span className="flow-post-when">{props.when}</span>
    </div>
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a post opens as a whole; a <button> cannot hold its picture, title and her word
    <div
      ref={ref}
      className={props.lead ? "flow-post flow-lead" : "flow-post flow-row"}
      style={{ "--i": props.index } as CSSProperties}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      {props.lead ? (
        <>
          <div className="flow-lead-pic">
            <FlowPicture post={p} />
            <div className="flow-lead-over">
              {meta}
              <div className="flow-post-title">{p.title}</div>
            </div>
          </div>
          <div className="flow-post-body">
            <div className="flow-post-summary">{p.summary}</div>
            <span className="flow-chip">{p.why}</span>
          </div>
        </>
      ) : (
        <div className="flow-row-main">
          <span className="flow-row-num" aria-hidden="true">
            {String(props.index + 1).padStart(2, "0")}
          </span>
          <div className="flow-post-body">
            {meta}
            <div className="flow-post-title">{p.title}</div>
            <div className="flow-post-summary">{p.summary}</div>
            <span className="flow-chip">{p.why}</span>
          </div>
          <FlowPicture post={p} />
        </div>
      )}
      {p.word !== null && <HerWord text={p.word} animate={props.typeWord} />}
    </div>
  );
}

function SiteMark(props: { readonly site: string }): JSX.Element {
  return (
    <span
      className="flow-mark"
      style={{ "--hue": siteHue(props.site) } as CSSProperties}
      aria-hidden="true"
    >
      {siteMark(props.site)}
    </span>
  );
}

/** The post's picture resolving out of its halftone (§3), or the designed
 *  cover when it has none. */
function FlowPicture(props: { readonly post: FlowPostView }): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const p = props.post;
  const cover = p.picture === null || failed;
  return (
    <div
      className={`flow-pic${loaded ? " is-loaded" : ""}${cover ? " is-cover" : ""}`}
      style={{ "--hue": siteHue(p.site) } as CSSProperties}
    >
      <div className="flow-pic-halftone" aria-hidden="true">
        {cover && <span>{siteMark(p.site)}</span>}
      </div>
      {!cover && p.picture !== null && (
        <img
          src={p.picture}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

/** Her word, a note in her own hand under the post: typed in at her own
 *  cadence once, then still (§3). */
function HerWord(props: {
  readonly text: string;
  readonly animate: boolean;
}): JSX.Element {
  const t = useT();
  const chars = useMemo(() => Array.from(props.text), [props.text]);
  const reduced =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [shown, setShown] = useState(
    props.animate && !reduced ? 0 : chars.length,
  );
  useEffect(() => {
    if (!props.animate || reduced) {
      setShown(chars.length);
      return;
    }
    setShown(0);
    const id = setInterval(() => {
      setShown((n) => {
        if (n + 1 >= chars.length) clearInterval(id);
        return Math.min(chars.length, n + 1);
      });
    }, 45);
    return () => clearInterval(id);
  }, [props.animate, reduced, chars]);
  return (
    <div className="flow-word">
      <HertaAvatar className="flow-word-av" />
      <div className="flow-word-note">
        <b>{t("flow.her")}</b>
        <span
          className={`flow-word-text${shown < chars.length ? " is-typing" : ""}`}
          aria-hidden="true"
        >
          {chars.slice(0, shown).join("")}
        </span>
        <span className="flow-sr">{props.text}</span>
      </div>
    </div>
  );
}

/** A post opened in place: it grows from its card (§3) into the full view,
 *  and on the way back shrinks into it again while the page fades. */
function FlowOpened(props: {
  readonly post: FlowDayPost;
  readonly from: DOMRect | null;
  readonly closing: boolean;
  readonly onBack: () => void;
  readonly onClosed: () => void;
  readonly onOpenSource: () => void;
  readonly onAsk?: () => void;
}): JSX.Element {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const p = props.post;
  // The parent's callback is new each render; the timer must not restart.
  const onClosedRef = useRef(props.onClosed);
  onClosedRef.current = props.onClosed;
  useLayoutEffect(() => {
    const onClosed = (): void => onClosedRef.current();
    if (!props.closing) return;
    const root = rootRef.current;
    const card = cardRef.current;
    const from = props.from;
    const reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    const to = card?.getBoundingClientRect();
    if (
      root === null ||
      card === null ||
      from === null ||
      reduced ||
      to === undefined ||
      to.width === 0 ||
      to.height === 0
    ) {
      onClosed();
      return;
    }
    // One scale for both axes: a tall article squeezed to a row's height
    // read as a smear; at the row's width it simply recedes as it fades.
    const k = from.width / to.width;
    root.classList.add("is-closing");
    card.style.transition =
      "transform 380ms var(--flow-spring), opacity 320ms ease";
    card.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${k})`;
    card.style.opacity = "0.4";
    const id = window.setTimeout(onClosed, 360);
    return () => window.clearTimeout(id);
  }, [props.closing, props.from]);
  useLayoutEffect(() => {
    const card = cardRef.current;
    const from = props.from;
    const reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (card === null || from === null || reduced) return;
    const to = card.getBoundingClientRect();
    if (to.width === 0 || to.height === 0) return;
    card.style.transition = "none";
    card.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
    void card.offsetWidth;
    card.style.transition = "";
    card.style.transform = "";
  }, [props.from]);
  return (
    <div className="flow-open" data-testid="flow-open" ref={rootRef}>
      <div className="flow-open-bar">
        <button type="button" onClick={props.onBack}>
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </svg>
          {t("flow.back")}
        </button>
      </div>
      <div className="flow-open-card" ref={cardRef}>
        <FlowPicture post={p} />
        <div className="flow-open-body">
          <h2>{p.title}</h2>
          <div className="flow-open-meta">
            {p.site}
            {p.date !== null ? ` · ${p.date}` : ""} · {p.why}
          </div>
          {p.points.length > 0 && (
            <section className="flow-open-points">
              <h3>{t("flow.points")}</h3>
              <ul>
                {p.points.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </section>
          )}
          <FlowArticle text={p.detail} />
          {p.word !== null && <HerWord text={p.word} animate={false} />}
          <div className="flow-open-acts">
            {props.onAsk !== undefined && (
              <button
                type="button"
                className="is-primary"
                onClick={props.onAsk}
              >
                {t("flow.ask")}
              </button>
            )}
            <button type="button" onClick={props.onOpenSource}>
              {t("flow.openSource")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const article = new Marked({ gfm: true, breaks: false, async: false });

/** The write-up as an article (amendment round 3): the pipeline keeps a small
 *  part of Markdown — headings, paragraphs, lists, bold, tables — and it
 *  renders here through the viewer's one sanitizing door, as a file's
 *  Markdown does. */
function FlowArticle(props: { readonly text: string }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (ref.current === null) return;
    setSanitizedHtml(ref.current, article.parse(props.text) as string);
  }, [props.text]);
  return <div className="flow-article" ref={ref} />;
}

/** The Herta space station that relays the issue (the masthead's
 *  「空间站「黑塔」转播」), in place of a violet broadcast glyph (owner
 *  2026-10-30). The app's own line drawing, a night version for the dark
 *  shell; both stay mounted so a theme flip swaps with no decode flash, as
 *  the sending row's do. */
function StationIcon(): JSX.Element {
  return (
    <span className="flow-station" aria-hidden="true">
      <img
        className="flow-station-img flow-station-img--day"
        src={stationIcon}
        alt=""
        draggable={false}
      />
      <img
        className="flow-station-img flow-station-img--night"
        src={stationIconNight}
        alt=""
        draggable={false}
      />
    </span>
  );
}

/** The top bar's Flow glyph: a broadcast's waves. */
export function FlowIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <path d="M8.2 15.8a5.4 5.4 0 0 1 0-7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.4 18.6a9.4 9.4 0 0 1 0-13.2M18.6 5.4a9.4 9.4 0 0 1 0 13.2" />
    </svg>
  );
}
