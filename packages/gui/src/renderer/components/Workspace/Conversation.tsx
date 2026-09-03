import { Fragment, memo, useRef } from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useActiveSession } from "../../hooks/useActiveSession.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { ConversationPinProvider } from "./ConversationPin.js";
import { GalaxyTravelRow } from "./GalaxyTravelRow.js";
import { activityHasTerminalMarker } from "./group-record.js";
import { MorphClone } from "./MorphClone.js";
import { PendingActivity } from "./PendingActivity.js";
import { RecapCompactRow } from "./RecapCompactRow.js";
import { StreamingReply } from "./StreamingReply.js";
import { SupervisorHoldRow } from "./SupervisorHoldRow.js";
import { TopicRail } from "./TopicRail.js";
import { TurnFailedRow } from "./TurnFailedRow.js";
import { UserBubble } from "./UserBubble.js";
import { useConversationRows } from "./useConversationRows.js";
import { useConversationScroll } from "./useConversationScroll.js";
import {
  useIncomingMorph,
  useIncomingMorphDetection,
} from "./useIncomingMorph.js";
import { useInFlightIndicator } from "./useInFlightIndicator.js";
import { useJumpChip } from "./useJumpChip.js";
import { useOutgoingMorph } from "./useOutgoingMorph.js";
import { useRecordWindow } from "./useRecordWindow.js";
import { useRemoveAttachment } from "./useRemoveAttachment.js";
import { useRewindTurn } from "./useRewindTurn.js";
import { useSessionEntrance } from "./useSessionEntrance.js";
import { useSupervisorHold } from "./useSupervisorHold.js";
import { useTopicJump } from "./useTopicJump.js";
import { useTurnFollow } from "./useTurnFollow.js";
import { useWorkspaceRefs } from "./WorkspaceRefs.js";

// The timing/threshold constants this component used to declare now live
// with the machine that owns them (split 2026-09-03); re-exported here so
// the tests and any other importer keep their `./Conversation.js` path.
export {
  GLIDE_WINDOW_MS,
  OUTGOING_FLIGHT_MS,
  SHADOW_SETTLE_MS,
} from "./conversation-timing.js";
export {
  GALAXY_APPEAR_DELAY_MS,
  IN_FLIGHT_EXIT_MS,
  IN_FLIGHT_MIN_VISIBLE_MS,
} from "./useInFlightIndicator.js";
export {
  UNPINNED_TRIM_AT,
  UNPINNED_TRIM_KEEP_TAIL,
  UNPINNED_TRIM_MIN,
} from "./useRecordWindow.js";
export { SUPERVISOR_HINT_DELAY_MS } from "./useSupervisorHold.js";

// memo (user profile 2026-07-12): Conversation takes no props, so every
// PARENT re-render — notably the sidebar toggle flipping Workbench state,
// which profiled as an 89ms long task on the click — re-rendered the whole
// row tree for nothing. Store updates still flow via useActiveSession.
export const Conversation = memo(function Conversation(): JSX.Element {
  const t = useT();
  const {
    record,
    recordStart,
    status,
    streamingText,
    retryText,
    pendingUser,
    pendingUserImages,
    retracting,
    retractKeepLen,
    turnStartedAt,
    backendStartedAt,
    backendActive,
    backendInFlight,
    recapCompacting,
    supervisorChecking,
    sessionId,
    pendingJump,
    turnFailed,
    turnFailedStatus,
    turnFailedProviderCode,
    topics,
    lang,
  } = useActiveSession();
  const { bridge, sessionStore } = useHertaBridge();
  const reduced = useReducedMotion();
  // No clock here: adaptive timestamps ("just now" → "N min ago") refresh via
  // the shared coarse tick each BubbleTime leaf subscribes to (lib/now-tick,
  // perf 2026-08-25). Keeping `now` in this component put the tick in the row
  // memo's deps, so every 30s rebuilt and reconciled every mounted row element
  // to refresh at most a few labels.
  // The per-FRAME reveal (useRevealedText / useRetractMorph) lives in the
  // StreamingReply leaf, not here: its state commits once per rAF frame while
  // tokens stream, and hosting it in Conversation re-rendered the ENTIRE
  // conversation (every historical bubble) 60×/s. Conversation re-renders per
  // DELTA (streamingText identity), which the memoized rows absorb.

  // ── the machines (split 2026-09-03) ──────────────────────────────────────
  // This component used to host five state machines inline; each is now a
  // hook in its own file and this is the wiring. The hooks are called in the
  // order their effects sat here, so React's per-commit effect order is
  // unchanged — which is why the scroll engine is created AFTER the two
  // morphs (it takes the clone flags they own) and the morphs take its
  // predicates as getters, and why the incoming morph's detection half is a
  // separate call after the in-flight indicator (it keys on the stream as
  // the flow shows it, which that machine defines).
  const { composerRef, overlayRef } = useWorkspaceRefs();
  /** The `.conversation-flow` column — the morphs watch its WIDTH so a
   *  container reflow mid-flight (sidebar toggle, rail gutter) settles them
   *  early instead of landing at the pre-reflow slot. */
  const flowRef = useRef<HTMLDivElement>(null);
  const outgoing = useOutgoingMorph({
    pendingUser,
    pendingUserImages,
    reduced,
    composerRef,
    overlayRef,
    flowRef,
    isReadingHistory: () => scroll.isReadingHistory(),
  });
  const incoming = useIncomingMorph({
    composerRef,
    overlayRef,
    flowRef,
    owedScroll: () => scroll.owedScroll(),
    isGliding: () => scroll.isGliding(),
  });
  const scroll = useConversationScroll({
    outgoingClone: outgoing.outgoingClone,
    incomingClone: incoming.incomingClone,
    reduced,
  });
  const handleRewind = useRewindTurn({
    bridge,
    sessionStore,
    scroll,
    reduced,
    t,
    lang,
  });
  const inFlight = useInFlightIndicator({
    status,
    streamingText,
    outgoingClone: outgoing.outgoingClone,
    backendActive,
    supervisorChecking,
    pendingUser,
    turnFailed,
    reduced,
    sessionId,
  });
  useIncomingMorphDetection(incoming, {
    visibleStreamingText: inFlight.visibleStreamingText,
    reduced,
    retracting,
    composerRef,
    overlayRef,
  });
  const supervisor = useSupervisorHold({ supervisorChecking, scroll });
  const jumpChip = useJumpChip({ scroll, record, recordStart, sessionId });
  const jumpToTopic = useTopicJump({
    scroll,
    sessionStore,
    reduced,
    pendingJump,
    sessionId,
  });
  useTurnFollow({
    scroll,
    isFlightArmed: outgoing.isFlightArmed,
    reduced,
    record,
    pendingUser,
    status,
    showInFlight: inFlight.showInFlight,
    inFlightExiting: inFlight.inFlightExiting,
    sendArmed: inFlight.sendArmed,
    showSupervisorHold: supervisor.showSupervisorHold,
    backendActive,
    recapCompacting,
  });
  const { loadEarlier } = useRecordWindow({
    scroll,
    sessionStore,
    record,
    recordStart,
    sessionId,
  });
  useSessionEntrance({ scroll, sessionId, reduced, sessionStore });
  const removeAttachmentFactory = useRemoveAttachment({
    sessionId,
    bridge,
    sessionStore,
    t,
  });
  const { items, rows } = useConversationRows({
    record,
    recordStart,
    lang,
    status,
    turnStartedAt,
    backendStartedAt,
    backendInFlight,
    backendActive,
    handleRewind,
    removeAttachmentFactory,
  });

  // ── render ───────────────────────────────────────────────────────────────
  const {
    pendingEchoImages,
    pendingUserAt,
    outgoingClone,
    hidePendingUser,
    cloneRef,
    pendingUserBubbleRef,
  } = outgoing;
  const { incomingCloneRef, streamingBubbleRef, incomingClone, hideStreaming } =
    incoming;
  const { sendArmed, inFlightPresent, inFlightExitingVisible } = inFlight;
  const { showSupervisorHold, onRevealGrow } = supervisor;
  // Mirrors TopicRail's own render guard: when the rail is up, the shell
  // reserves a left gutter so ticks never overlap content (activity LEDs)
  // on panes narrower than the flow's centered measure.
  const railVisible = topics.length >= 2;
  return (
    <ConversationPinProvider unpin={scroll.unpin}>
      <div
        className={`conversation-shell${railVisible ? " has-topic-rail" : ""}`}
      >
        <div
          className={`conversation${scroll.fog.top ? " has-fog-top" : ""}${
            scroll.fog.bottom ? " has-fog-bottom" : ""
          }`}
          ref={scroll.scrollRef}
        >
          {/* Centered readable column (user feedback 2026-07-06): with the left
            sidebar hidden the pane widens and fixed-width bubbles hugging the
            edges left the middle empty. The flow caps at a readable measure
            and centers; below the cap it is width-neutral. */}
          {/* `is-busy` hides the rewind control while a turn runs (the CSS
            rule, 2026-07-30). It used to be withheld as a prop, which put the
            turn's status inside the row memo and re-rendered every row in the
            session on send; a class on this one element costs nothing and the
            handler carries the real guard. */}
          <div
            ref={flowRef}
            className={`conversation-flow${status === "idle" ? "" : " is-busy"}`}
          >
            {/* Load-earlier paging: the window's start > 0 means older blocks
              exist main-side. In-flow (scrolls with the history it extends);
              the viewport is anchored across the prepend (see loadEarlier). */}
            {recordStart > 0 && (
              <button
                type="button"
                className="load-earlier"
                onClick={loadEarlier}
              >
                {t("workspace.loadEarlier", { n: recordStart })}
              </button>
            )}
            {/* Rows are keyed by record index, which COLLIDES across sessions —
            the panel stays mounted through a switch, so React would reuse row
            instances and leak per-row state (an ActivityBlock's expanded
            toggle / frozen duration from session A showing on session B's
            group at the same index). The session-keyed Fragment remounts the
            row set per session; within one session, indices are stable
            (append-only record). */}
            <Fragment key={sessionId ?? "none"}>{rows}</Fragment>
            {pendingUser !== null && (
              <UserBubble
                text={pendingUser}
                lang={lang}
                // Optimistic local echo of the just-sent message — stamped at
                // the send (pendingUserAt), so it reads "just now". Once it
                // lands in the record it carries the stamped `at` (same
                // minute), so the label stays stable.
                at={pendingUserAt}
                hidden={hidePendingUser}
                bubbleRef={pendingUserBubbleRef}
                {...(pendingEchoImages.length > 0
                  ? { images: pendingEchoImages }
                  : {})}
              />
            )}
            {outgoingClone !== null && pendingUser !== null && (
              <MorphClone
                ref={cloneRef}
                overlay={overlayRef}
                variant="user"
                text={outgoingClone.text}
                lang={lang}
                {...(outgoingClone.images.length > 0
                  ? { images: outgoingClone.images }
                  : {})}
                {...(outgoingClone.imagesWidthPx !== undefined
                  ? { imagesWidthPx: outgoingClone.imagesWidthPx }
                  : {})}
              />
            )}
            <StreamingReply
              lang={lang}
              // Held back while an in-flight row is still on screen — the
              // reply enters after the row's fade (see visibleStreamingText).
              streamingText={inFlight.visibleStreamingText}
              retryText={retryText}
              retracting={retracting}
              retractKeepLen={retractKeepLen}
              reduced={reduced}
              hideStreaming={hideStreaming}
              showIncomingClone={incomingClone}
              streamingBubbleRef={streamingBubbleRef}
              incomingCloneRef={incomingCloneRef}
              overlayRef={overlayRef}
              onGrow={onRevealGrow}
            />

            {/* Supervisor judgment hold (bug 4): sits right under the held
            streaming bubble; mutually exclusive with the in-flight rows
            (inFlightSettled excludes supervisorChecking, and a live stream
            excludes the galaxy anyway). */}
            {showSupervisorHold && <SupervisorHoldRow />}
            {/* Both rows ride `inFlightPresent` — which carries the
            render-synchronous hide, the minimum-visible hold, AND the quiet
            exit fade; see the definitions for why those are one expression. */}
            {inFlightPresent && recapCompacting && (
              <RecapCompactRow exiting={inFlightExitingVisible} />
            )}
            {inFlightPresent && !recapCompacting && (
              <GalaxyTravelRow exiting={inFlightExitingVisible} />
            )}
            {/* Non-interrupt turn failure (slice 4): the reply was lost to a
            provider/connection error and nothing committed — say so instead
            of silently evaporating the half-typed sentence. */}
            {/* Deferred like 处理中… below: while the in-flight row is up or
            fading (or the send that will bring it up has not settled yet), the
            notice waits — the message went out, the row travels, THEN "the
            reply was lost". Never both at once (review 2026-07-31). */}
            {turnFailed &&
              status === "idle" &&
              !inFlightPresent &&
              !sendArmed && (
                <TurnFailedRow
                  status={turnFailedStatus}
                  providerCode={turnFailedProviderCode}
                />
              )}
            {/* The 处理中… backend placeholder sits at the BOTTOM of the flow —
          backend work happens after Herta speaks the @板砖 delegation, so it
          must appear below her reply (record block or still-streaming bubble),
          never above it. Hidden once the real activity group is active. Also
          deferred while the in-flight row is still holding its minimum OR
          fading out — that row renders ABOVE this slot, so mounting under it
          shoved this row down and let it slide back up when the row left;
          instead the row leaves first (through its exit fade) and this one
          fades in where it stood (user 2026-07-31). */}
            {backendActive &&
              !inFlightPresent &&
              // …and while a send is armed but its row not yet up (the bubble
              // is still flying), so a backend that starts before the morph
              // settles does not put 处理中 under a bubble in flight, only to
              // yield to the row a moment later.
              !sendArmed &&
              (() => {
                const last = items[items.length - 1];
                const lastIsActive =
                  last !== undefined &&
                  last.kind === "activity" &&
                  status !== "idle" &&
                  !activityHasTerminalMarker(last.blocks);
                return lastIsActive ? null : (
                  <PendingActivity
                    turnStartedAt={turnStartedAt}
                    backendStartedAt={backendStartedAt}
                    lang={lang}
                  />
                );
              })()}
            {/* Turn headroom: empty room reserved under the newest turn so
              the answer fills a region instead of crawling along the bottom
              edge. Height is written imperatively (turn-headroom.ts); it is
              0 until you send, and 0 again once a turn outgrows the pane. */}
            <div
              ref={scroll.headroomRef}
              className="turn-headroom"
              aria-hidden="true"
            />
            <div ref={scroll.endRef} aria-hidden="true" />
          </div>
        </div>
        {/* Jump-to-latest chip: new content arrived below a reader who scrolled
          up (pinned autoscroll correctly stays off; this is the one-click way
          back). Floats over the bottom scroll.fog; hidden the moment the reader is
          back at the bottom — by click or by scrolling there themselves. */}
        {/* Topic guide rail: one tick per topic on the left edge; hover swells
          the neighborhood + raises the topic card, click jumps (paging older
          history in if the anchor is outside the loaded window). Keyed by
          session so its transient state (fold expansion, hover) never leaks
          across a switch. */}
        <TopicRail
          key={sessionId ?? "none"}
          topics={topics}
          lang={lang}
          onJump={jumpToTopic}
          scrollerRef={scroll.scrollRef}
        />
        {jumpChip.mounted && (
          <button
            type="button"
            className={`jump-to-latest${jumpChip.open ? " is-open" : ""}`}
            onClick={scroll.jumpToLatest}
          >
            <span className="jump-to-latest__arrow" aria-hidden="true">
              ↓
            </span>
            {t("workspace.jumpToLatest")}
          </button>
        )}
      </div>
    </ConversationPinProvider>
  );
});
