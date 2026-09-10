import type { PendingPermissionApproval } from "@herta/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useSessionSelector } from "../../hooks/useSessionSelector.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { OVERLAY_Z, useModalOverlay } from "../../lib/overlay-stack.js";
import { DiffBody } from "../Workspace/DiffBody.js";
import { countHeredocs, foldHeredocs } from "./fold-heredocs.js";
import {
  CONSEQUENCE_KEY,
  isDangerRisk,
  REASON_KEY,
  RISK_KEY,
} from "./risk-label.js";

/** Exit-animation duration; must match .approval-panel.is-out in reference-ux.css. */
const EXIT_MS = 200;

/**
 * User-only approval surface for backend (@板砖) permission gates. Reads the
 * active session's overlay from the store; renders a bottom panel over the
 * composer when a permission is pending. Resolving calls bridge.resolveApproval
 * — the store then clears the overlay, which drives the exit animation. Per D7
 * this panel is never part of the terminal record.
 */
export function ApprovalPanel(): JSX.Element | null {
  const t = useT();
  // Selector-based: the store replaces `overlay` only on overlay events, so
  // this re-renders on gate open/close — not on every streaming delta.
  const overlay = useSessionSelector((s) => s.overlay);
  const { bridge } = useHertaBridge();
  const pending = overlay?.kind === "pending-permission" ? overlay : null;

  const [shown, setShown] = useState<PendingPermissionApproval | null>(null);
  const [leaving, setLeaving] = useState(false);
  const timerRef = useRef<number>();
  const allowRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Sync the rendered overlay from the store, with a timed exit when it clears.
  useEffect(() => {
    if (pending !== null) {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      setShown(pending);
      setLeaving(false);
    } else if (shown !== null && timerRef.current === undefined) {
      setLeaving(true);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        setShown(null);
        setLeaving(false);
      }, EXIT_MS);
    }
  }, [pending, shown]);

  // Clear a pending exit timer on unmount.
  useEffect(
    () => () => {
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    },
    [],
  );

  // ── Conversation reserve (2026-07-27) ────────────────────────────────────
  // The panel is absolute at the footer's bottom and TALLER than the footer,
  // so its top reaches over the conversation. Anything streaming while a gate
  // is open — typically Herta's beat about the very operation being approved —
  // landed in that covered band, invisible, and "appeared all at once" when
  // the panel exited (owner 2026-07-27). Publish the OVERHANG (panel height −
  // footer height, offsetHeight so the entry translate never skews it) as
  // --approval-reserve on the workspace node; .conversation pads its bottom by
  // it, keeping the flow's tail above the panel. The pinned-follow rides the
  // scroller's existing ResizeObserver (padding resizes the content box), and
  // unpinned readers are untouched by construction.
  //
  // Cleared when the exit STARTS (`leaving`), not when it finishes: the
  // conversation relaxes down behind the fading panel, and a pinned scroller
  // clamps automatically. Panel growth after mount — the diff disclosure
  // opening, command text re-wrapping — re-publishes via the ResizeObserver.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null || shown === null || leaving) return;
    const workspace = panel.closest<HTMLElement>(".workspace");
    if (workspace === null) return;
    const publish = (): void => {
      const footer = panel.offsetParent as HTMLElement | null;
      const overhang = panel.offsetHeight - (footer?.offsetHeight ?? 0);
      if (overhang > 0) {
        workspace.style.setProperty("--approval-reserve", `${overhang}px`);
      } else {
        workspace.style.removeProperty("--approval-reserve");
      }
    };
    publish();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(publish)
        : null;
    ro?.observe(panel);
    return () => {
      ro?.disconnect();
      workspace.style.removeProperty("--approval-reserve");
    };
  }, [shown, leaving]);

  // Overlay-stack registration: the panel owns global keyboard semantics
  // (Escape, autofocus) only while it is the TOPMOST overlay. With Settings /
  // the key prompt open above it, Escape must not silently deny and the panel
  // must not steal focus from inside the modal (an invisible Allow button
  // catching a stray Enter). When the covering modal closes, `isTop` flips
  // back and the focus effect re-fires — the panel regains focus naturally.
  const isTop = useModalOverlay(
    "approval",
    shown !== null && !leaving,
    OVERLAY_Z.approval,
  );

  // One resolution per request: the panel stays interactive until the
  // `resolved` overlay event round-trips over IPC, so an unlatched panel let
  // a second click (or Escape key-repeat) send contradictory decisions for
  // the same requestId.
  const [resolving, setResolving] = useState(false);
  // Diff disclosure (user 2026-07-24): default-collapsed so a long patch
  // never floods the panel; the well below caps its height and scrolls.
  const [diffOpen, setDiffOpen] = useState(false);
  const shownRequestId = shown?.requestId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: shownRequestId is the re-arm trigger, not an input
  useEffect(() => {
    // A FRESH request re-arms the latch (a new gate can follow a resolved one
    // while the panel is still mounted) and starts with the diff collapsed.
    setResolving(false);
    setDiffOpen(false);
  }, [shownRequestId]);

  // +/− counts for the disclosure label, from the overlay's unified diff
  // (file headers excluded). Null when the request carries no diff.
  const diffStats = useMemo(() => {
    const diff = shown?.diff;
    if (diff === undefined) return null;
    const lines = diff.split("\n");
    let add = 0;
    let del = 0;
    for (const l of lines) {
      if (l.startsWith("+++") || l.startsWith("---")) continue;
      if (l.startsWith("+")) add += 1;
      else if (l.startsWith("-")) del += 1;
    }
    return { n: lines.length, add, del };
  }, [shown?.diff]);

  // The command as the card shows it (2026-08-17): when the ask carries a
  // diff that covers every heredoc in the command (the rule's heredoc-write
  // preview), the bodies fold out of the command well — the shell line stays,
  // the content is in the diff below. Otherwise verbatim: the diff is the
  // only place a folded body could be seen, so without one nothing folds.
  const shownCommand = useMemo(() => {
    const command = shown?.command;
    if (command === undefined) return undefined;
    if (shown?.diff === undefined) return command;
    const n = countHeredocs(command);
    if (n === 0 || (shown.files?.length ?? 0) < n) return command;
    return foldHeredocs(command, (lines) =>
      t("approval.heredocFolded", { n: lines }),
    ).text;
  }, [shown?.command, shown?.diff, shown?.files, t]);

  // Focus the primary action when a fresh request appears (or when the
  // overlay covering this panel closes).
  useEffect(() => {
    if (shown !== null && !leaving && isTop) allowRef.current?.focus();
  }, [shown, leaving, isTop]);

  const resolve = (
    decision: "allow" | "deny",
    persistence?: "once" | "session" | "always",
  ): void => {
    if (shown === null || resolving) return;
    setResolving(true);
    bridge
      .resolveApproval(
        persistence === undefined
          ? { requestId: shown.requestId, decision }
          : { requestId: shown.requestId, decision, persistence },
      )
      .then(undefined, () => {
        // The resolve never reached the session (it was disposed or
        // switched between the overlay and the click): the latch would
        // otherwise leave all four buttons disabled with no message until
        // the next request (2026-09-10). Re-arm; the overlay's own events
        // decide whether there is still anything to answer.
        setResolving(false);
      });
  };

  // Escape denies while a live request is shown AND this panel is the top
  // overlay (see above). Tab/Shift+Tab cycle focus INSIDE the panel — a
  // focus trap (audit 2026-07-10, finding 9): without it, Shift+Tab walked
  // out of the panel into surrounding controls (pre-fix that included the
  // suppressed composer's invisible-but-enabled stop button, where Enter
  // aborted the gated turn; the CSS visibility fix removes that target, the
  // trap keeps keyboard focus from leaving the user's one live decision).
  // resolve closes over `shown`/`resolving`; re-bind on the deps that change
  // the closure's behavior.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resolve closes over shown/resolving intentionally
  useEffect(() => {
    if (shown === null || leaving || !isTop) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        // Deny only when the Escape is OURS: it originated inside the panel,
        // or with nothing focused (body/documentElement). A surface that
        // consumes Escape locally — the sidebar search field, a session
        // card's 确认删除 — must never silently deny the gate behind it
        // (audit 2026-07-24, H2: opening search over a pending gate and
        // pressing Escape refused the operation with no attribution).
        //
        // An ORIGIN test, not another registration rule: `isTop` protects
        // only against the five surfaces that opted into the overlay stack,
        // so every future Escape consumer would have to know the stack
        // exists. That opt-in model is exactly what let the bug the stack
        // was built for recur (see lib/overlay-stack.ts's header).
        // Foreign == the key originated in another FOCUSED element. A
        // window/document/body target means nothing was focused, which is
        // ours (and is what the keyboard-only path produces).
        const target = e.target;
        const root = panelRef.current;
        const foreign =
          target instanceof Element &&
          target !== document.body &&
          target !== document.documentElement &&
          (root === null || !root.contains(target));
        if (foreign) return;
        resolve("deny");
        return;
      }
      if (e.key !== "Tab") return;
      const root = panelRef.current;
      if (root === null) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>("button:not(:disabled)"),
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      // At the cycle's edge — or with focus outside the panel entirely —
      // clamp back into the panel instead of letting Tab escape.
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !root.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, leaving, isTop, resolving]);

  if (shown === null) return null;

  // Localize the summary by ask-class code; unknown/absent codes fall back
  // to the raw (neutral-English) rule reason. See REASON_KEY.
  const reasonKey =
    shown.code === undefined ? undefined : REASON_KEY[shown.code];
  const summary = reasonKey === undefined ? shown.summary : t(reasonKey);
  // A chained shell line carries every ask class it triggered (2026-08-17);
  // the top label says the highest-risk one, this line names the rest — so
  // `kill 574; curl localhost` reads "network" AND "ends processes", not
  // just the first. Unrecognized codes are skipped rather than shown raw.
  const alsoLabels =
    shown.codes === undefined
      ? []
      : shown.codes
          .filter((c) => c !== shown.code)
          .map((c) => REASON_KEY[c])
          .filter((k): k is NonNullable<typeof k> => k !== undefined)
          .map((k) => t(k));

  return (
    <div
      ref={panelRef}
      className={`approval-panel${leaving ? " is-out" : ""}`}
      data-testid="approval-panel"
      role="dialog"
      // The one place in the product where D4 puts the decision in the user's
      // hands, and a screen reader used to announce the whole of it as
      // "Permission request. Allow, button." — the summary, the literal
      // command, and the file list were unassociated markup that focus was
      // moved straight past. `aria-describedby` makes them the dialog's
      // description, so they are read out before the buttons; `aria-modal`
      // keeps an AT virtual cursor from roaming the background, which the Tab
      // trap below cannot do (it constrains focus, not the virtual cursor).
      aria-modal="true"
      aria-label={t("approval.title")}
      aria-describedby="approval-panel-desc"
    >
      <div className="approval-panel__head">
        <span className="approval-panel__title">{t("approval.title")}</span>
        <span
          className={`approval-panel__risk${isDangerRisk(shown.risk) ? " is-danger" : ""}`}
        >
          {t(RISK_KEY[shown.risk])}
        </span>
      </div>
      <div id="approval-panel-desc" className="approval-panel__desc">
        <p className="approval-panel__summary">{summary}</p>
        {shown.consequence !== undefined && (
          // Consequence note (ADR 0049 §5): what this command will do to work
          // that cannot be recovered — informational, the tier enforces.
          <p className="approval-panel__consequence">
            {t(CONSEQUENCE_KEY[shown.consequence])}
          </p>
        )}
        {alsoLabels.length > 0 && (
          <p className="approval-panel__also">
            {t("approval.alsoClasses", { list: alsoLabels.join("；") })}
          </p>
        )}
        {shownCommand !== undefined && (
          <pre className="approval-panel__command">{shownCommand}</pre>
        )}
        {shown.projectRule !== undefined && (
          <p className="approval-panel__rule">
            {t("approval.projectRuleNote", { rule: shown.projectRule })}
          </p>
        )}
        {shown.files !== undefined && shown.files.length > 0 && (
          <ul className="approval-panel__files">
            {shown.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
      </div>
      {shown.diff !== undefined && diffStats !== null && (
        <>
          <button
            type="button"
            className="diff-disclosure approval-panel__diff-toggle"
            aria-expanded={diffOpen}
            aria-controls="approval-panel-diff"
            // Without this the announced name is the visible label including
            // the ▸/▾ glyph, which says what the diff IS but never what the
            // button does (audit S13).
            aria-label={
              diffOpen
                ? t("approval.diffHideAria")
                : t("approval.diffShowAria", {
                    n: diffStats.n,
                    add: diffStats.add,
                    del: diffStats.del,
                  })
            }
            onClick={() => setDiffOpen((v) => !v)}
          >
            {diffOpen
              ? `▾ ${t("workspace.diffCollapse")}`
              : `▸ ${t("workspace.diffExpand", {
                  n: diffStats.n,
                  add: diffStats.add,
                  del: diffStats.del,
                })}`}
          </button>
          {/* Stays mounted; the wrapper animates open/closed (grid rows
              0fr → 1fr) so the panel grows smoothly instead of jumping to
              its new height (owner 2026-08-17). `hidden` while closed
              keeps it out of the tab order and the AT tree — a
              `visibility` transition on the inner well delays the hide
              until the collapse has played. */}
          <div
            className={`approval-panel__diff-wrap${diffOpen ? " is-open" : ""}`}
            aria-hidden={!diffOpen}
          >
            <div className="approval-panel__diff-clip">
              {/* Same rendered diff as the record's folded write row
                  (2026-08-25 evening) — one diff rendering in the app, not a
                  plain <pre> here and a tinted one there. The well keeps its
                  own chrome and its own collapse animation; `onDark` only
                  swaps the tints for ones that read on it. */}
              <div
                id="approval-panel-diff"
                className="approval-panel__diff"
                tabIndex={diffOpen ? 0 : -1}
              >
                <DiffBody text={shown.diff} onDark />
              </div>
            </div>
          </div>
        </>
      )}
      <div className="approval-panel__actions">
        <button
          ref={allowRef}
          type="button"
          className="approval-btn approval-btn--allow"
          disabled={resolving}
          onClick={() => resolve("allow", "once")}
        >
          {t("approval.allow")}
        </button>
        {shown.cacheable === true && (
          <button
            type="button"
            className="approval-btn approval-btn--always"
            disabled={resolving}
            onClick={() => resolve("allow", "session")}
          >
            {t("approval.alwaysAllow")}
          </button>
        )}
        {shown.projectRule !== undefined && (
          <button
            type="button"
            className="approval-btn approval-btn--always"
            disabled={resolving}
            // Short click target (owner 2026-08-04) — the exact grant is
            // spelled out by the dim __rule note above the actions.
            onClick={() => resolve("allow", "always")}
          >
            {t("approval.allowProject")}
          </button>
        )}
        <button
          type="button"
          className="approval-btn approval-btn--deny"
          disabled={resolving}
          onClick={() => resolve("deny")}
        >
          {t("approval.deny")}
        </button>
      </div>
    </div>
  );
}
