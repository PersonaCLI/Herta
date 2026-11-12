// The conversation's row tree: the record grouped into bubble/activity items,
// the bubble rows memoized on their real inputs, and the assembled rows with
// the activity groups. Extracted from Conversation.tsx on 2026-09-03 (owner's
// request: the file hosted five state machines). Pure derivation — memos
// only, no effects — with every dependency array exactly as it was, so the
// element identities the row memos below Conversation rely on are unchanged.

import type { TerminalRecord, TerminalRecordBlock } from "@herta/app-server";
import { useMemo } from "react";
import { useT } from "../../i18n/LocaleProvider.js";
import type { SessionStatus } from "../../store/session-store.js";
import { ErrorBoundary } from "../ErrorBoundary.js";
import { ActivityBlock } from "./ActivityBlock.js";
import {
  groupRecord,
  groupRuns,
  lastTurnIndex,
  liftUserImages,
  openRun,
  type SystemBlock,
  shareRunIdentity,
  undoTarget,
} from "./group-record.js";
import { HertaBubble } from "./HertaBubble.js";
import { RunRow } from "./RunRow.js";
import { imageViewsFromBlocks, UserBubble } from "./UserBubble.js";
import type { RemoveAttachmentFactory } from "./useRemoveAttachment.js";

const NO_UNDO_CARD = { card: -1, undone: false } as const;

/** Per-row crash fallback (audit 2026-07-13 T2.2): the row renderers are
 *  fed model-shaped record blocks every turn, so a malformed one must cost
 *  one muted line — not unmount the whole conversation. */
function RowRenderError(): JSX.Element {
  const t = useT();
  return (
    <div className="row-render-error" role="note">
      {t("conversation.rowError")}
    </div>
  );
}

function renderBlock(
  block: TerminalRecordBlock,
  index: number,
  // Conversation language, for the 板砖→Brick display alias on the bubbles.
  lang: "zh" | "en",
  // Set only on the LATEST user block when idle — wires its rewind control.
  onRewind?: () => void,
  // Pictures sent WITH this message (ADR 0048 §4), lifted onto the bubble.
  images?: readonly SystemBlock[],
  // A quoted Flow post's page to the OS browser (ADR 0084 §9).
  onOpenWebPage?: (url: string) => void,
): JSX.Element | null {
  // Blocks → bubble views here rather than in UserBubble, so the optimistic
  // echo (whose pictures come from the composer strip, not the record) can
  // feed the same prop.
  const imageViews = images !== undefined ? imageViewsFromBlocks(images) : [];
  // Per-block timestamp (Slice 4): `at` is stamped at the output boundaries
  // (live sink emit + JSONL persist), so each bubble shows its own time.
  // Pre-timestamp blocks lack `at` → the bubble hides its timestamp line
  // rather than fabricating a shared "now" (the old all-same bug). The
  // adaptive label (just now / N min ago / time / date+time) is derived in
  // the bubble's BubbleTime leaf off the shared coarse clock (perf
  // 2026-08-25), so the current time never enters this render — a clock
  // tick invalidates label leafs, not row elements.
  switch (block.kind) {
    case "user":
      return (
        <UserBubble
          key={index}
          absIndex={index}
          text={block.text}
          at={block.at}
          lang={lang}
          {...(block.mentions !== undefined
            ? { mentions: block.mentions }
            : {})}
          {...(block.picks !== undefined ? { picks: block.picks } : {})}
          {...(onRewind !== undefined ? { onRewind } : {})}
          {...(onOpenWebPage !== undefined ? { onOpenWebPage } : {})}
          {...(imageViews.length > 0 ? { images: imageViews } : {})}
        />
      );
    case "herta":
      if (block.surface === "thought") return null; // per SPEC D8
      return (
        <HertaBubble key={index} text={block.text} at={block.at} lang={lang} />
      );
    default:
      return null;
  }
}

export function useConversationRows(opts: {
  readonly record: TerminalRecord;
  readonly recordStart: number;
  readonly lang: "zh" | "en";
  readonly status: SessionStatus;
  readonly backendStartedAt: number | null;
  readonly backendActive: boolean;
  readonly handleRewind: () => Promise<void>;
  readonly removeAttachmentFactory: RemoveAttachmentFactory | undefined;
  /** Opens a web page the record names in the OS browser (ADR 0080 §5). */
  readonly openWebPage: ((url: string) => void) | undefined;
  /** Main says the latest turn's edits can be taken back (ADR 0074 §4). */
  readonly undoable: boolean;
  /** An undo is on its way. */
  readonly undoBusy: boolean;
  readonly handleUndo: () => Promise<void>;
  /** The rows are the trailing window's. When they are a window of history
   *  instead (a far jump), their last turn is not the session's last: no
   *  rewind, no 撤销 and no live run belong to anything in them. */
  readonly atLive: boolean;
}) {
  const {
    record,
    recordStart,
    lang,
    status,
    backendStartedAt,
    backendActive,
    handleRewind,
    removeAttachmentFactory,
    openWebPage,
    undoable,
    undoBusy,
    handleUndo,
    atLive,
  } = opts;

  // Memoized on record identity: the store mutates `record` only per BLOCK
  // (deltas accumulate in streamingText), so the grouping — O(n) over all
  // blocks — reruns per block, not per delta/frame.
  const items = useMemo(
    // Pictures sent with a message ride the bubble rather than the activity
    // run that carries them in the record (ADR 0048 §4) — same record,
    // different overlay.
    //
    // Each of 板砖's dispatches folds into one run row (ADR 0085 §6).
    //
    // `shareRunIdentity` last: an unchanged run keeps the ARRAY it had on the
    // previous commit, so `memo(ActivityBlock)` and `memo(RunRow)` — and a
    // user bubble's lifted pictures — skip instead of re-deriving the whole
    // window per block.
    () => shareRunIdentity(groupRuns(liftUserImages(groupRecord(record)))),
    [record],
  );
  // The rewind control shows only on the LATEST user turn, and only when idle
  // (no in-flight turn to race the truncation). Find the last `user` block
  // that starts a turn — a steer is words inside 板砖's run, not a turn, and
  // ⟲ on it offered to withdraw only the steer (ADR 0063 §1.10).
  const lastUserIndex = useMemo(() => lastTurnIndex(record), [record]);
  // The 撤销 chip's run (ADR 0074 §4).
  const undoCard = useMemo(
    () => (atLive ? undoTarget(items, lastUserIndex) : NO_UNDO_CARD),
    [items, lastUserIndex, atLive],
  );
  // The run still working: the latest turn's run with no marker yet, while
  // the turn runs and the backend has started. The backend's anchor is the
  // honest signal (audit 2026-07-24, L1): it is null until a dispatch
  // starts, and the turn-start handler clears it. The chat's 处理中
  // placeholder stands down for this run, wherever her beats have put it.
  const liveRun = useMemo(
    () => (atLive ? openRun(items, lastUserIndex) : -1),
    [items, lastUserIndex, atLive],
  );
  const runLive =
    liveRun !== -1 &&
    status !== "idle" &&
    (backendActive || backendStartedAt !== null);
  // ── the bubble rows ──────────────────────────────────────────────────────
  // Memoized on their REAL inputs (user profile 2026-07-12): per-frame state
  // flickers during the sidebar slide (pinned, fog edges) re-rendered
  // Conversation ~60×/s, and every render re-ran renderBlock — 240 × Intl date
  // formatting — measured as 119ms scripting per 210ms of animation plus an
  // 89ms long task on the toggle click itself.
  //
  // Split out from the activity rows (2026-07-30) so that "their real inputs"
  // is actually true. Sharing one memo with the activity groups meant sharing
  // their dependencies — status, turnStartedAt, backendStartedAt,
  // backendInFlight, backendActive, canRewind — every one of which flips
  // at the moment of a send, so pressing send re-rendered every bubble in the
  // session, and again when the turn ended. None of them can change what a
  // bubble looks like. Now they cannot reach one: this memo survives a send,
  // the elements it holds stay referentially identical, and React skips those
  // subtrees outright.
  //
  // Aligned with `items` (activity slots hold null) so the assembly below can
  // index straight into it.
  const blockRows = useMemo(
    () =>
      items.map((item) =>
        item.kind === "block" ? (
          // Every row wrapped in a boundary (audit 2026-07-13 T2.2): a
          // render throw in one bubble is contained to that bubble. The
          // boundary renders its child directly (no wrapper DOM), so the
          // entrance-stagger child scan is unaffected.
          //
          // ABSOLUTE index as the key (windowing): a load-earlier
          // prepend shifts every relative index, which would remount
          // (and re-run entrance styles on) every existing row.
          <ErrorBoundary
            key={recordStart + item.index}
            label="record-row"
            fallback={<RowRenderError />}
          >
            {renderBlock(
              item.block,
              recordStart + item.index,
              lang,
              // Handed over whenever this IS the latest user turn; whether a
              // rewind is allowed right now is no longer part of the row's
              // render (see handleRewind's own idle check, and the
              // `.is-busy` rule that hides the control mid-turn).
              atLive && item.index === lastUserIndex ? handleRewind : undefined,
              item.images,
              openWebPage,
            )}
          </ErrorBoundary>
        ) : null,
      ),
    // The 30s clock is deliberately absent (perf 2026-08-25): timestamps
    // subscribe to the shared tick in their BubbleTime leaf, so a tick
    // invalidates label leafs, never these row elements.
    [
      items,
      recordStart,
      lang,
      lastUserIndex,
      handleRewind,
      openWebPage,
      atLive,
    ],
  );

  // ── assembly ────────────────────────────────────────────────────────────
  // Re-runs when the turn state moves, but only the activity groups are built
  // here; the bubble rows come from `blockRows` by reference.
  const rows = useMemo(
    () =>
      items.map((item, idx) => {
        if (item.kind === "block") return blockRows[idx];
        if (item.kind === "run") {
          return (
            <ErrorBoundary
              key={`a${recordStart + item.startIndex}`}
              label="activity-row"
              fallback={<RowRenderError />}
            >
              <RunRow
                blocks={item.blocks}
                absIndex={recordStart + item.startIndex}
                dispatchedAt={item.dispatchedAt}
                active={runLive && idx === liveRun}
                // Only the live turn's runs read the backend's start (see
                // turnStartedAt below for why history must not).
                backendStartedAt={
                  atLive && item.startIndex > lastUserIndex
                    ? backendStartedAt
                    : null
                }
                lang={lang}
                {...(idx !== undoCard.card
                  ? {}
                  : undoCard.undone
                    ? { undo: { state: "done" as const } }
                    : undoable && status === "idle"
                      ? {
                          undo: {
                            state: undoBusy
                              ? ("busy" as const)
                              : ("offer" as const),
                            onUndo: () => void handleUndo(),
                          },
                        }
                      : {})}
              />
            </ErrorBoundary>
          );
        }
        // A group that stands alone — an attachment, an undo line, a server
        // note — is never 板砖's live work: its rows are drawn as they are.
        return (
          <ErrorBoundary
            key={`a${recordStart + item.startIndex}`}
            label="activity-row"
            fallback={<RowRenderError />}
          >
            <ActivityBlock
              blocks={item.blocks}
              lang={lang}
              onRemoveAttachment={removeAttachmentFactory}
              {...(openWebPage !== undefined
                ? { onOpenWebPage: openWebPage }
                : {})}
            />
          </ErrorBoundary>
        );
      }),
    [
      items,
      blockRows,
      recordStart,
      lang,
      status,
      backendStartedAt,
      removeAttachmentFactory,
      openWebPage,
      // The live-turn gate above. Changes only with the record, which
      // already invalidates via `items` — listed for the lint contract.
      lastUserIndex,
      // The 撤销 chip (ADR 0074 §4): its card moves with the record; its
      // offer changes at turn end and after an undo — rarely.
      undoCard,
      undoable,
      undoBusy,
      handleUndo,
      liveRun,
      runLive,
      atLive,
    ],
  );

  return { items, rows, runLive };
}
