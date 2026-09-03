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
  activityHasTerminalMarker,
  groupRecord,
  liftUserImages,
  type SystemBlock,
} from "./group-record.js";
import { HertaBubble } from "./HertaBubble.js";
import { planContext } from "./plan-context.js";
import { imageViewsFromBlocks, UserBubble } from "./UserBubble.js";
import type { RemoveAttachmentFactory } from "./useRemoveAttachment.js";

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
          {...(onRewind !== undefined ? { onRewind } : {})}
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
  readonly turnStartedAt: number | null;
  readonly backendStartedAt: number | null;
  readonly backendInFlight: number;
  readonly backendActive: boolean;
  readonly handleRewind: () => Promise<void>;
  readonly removeAttachmentFactory: RemoveAttachmentFactory | undefined;
}) {
  const {
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
  } = opts;

  // Memoized on record identity: the store mutates `record` only per BLOCK
  // (deltas accumulate in streamingText), so the grouping — O(n) over all
  // blocks — reruns per block, not per delta/frame.
  const items = useMemo(
    // Pictures sent with a message ride the bubble rather than the activity
    // run that carries them in the record (ADR 0048 §4) — same record,
    // different overlay.
    () => liftUserImages(groupRecord(record)),
    [record],
  );
  // The CURRENT dispatch's 任务清单, scanned across the WHOLE record — an
  // in-turn beat splits one backend run into several activity groups, and
  // each ActivityBlock sees only its own blocks, so the continuation group
  // has no todo projection of its own to read. Computed once here (O(n)
  // backward from the end, memoized on the record like `items`) and handed
  // ONLY to the group rendered as active, below.
  const plan = useMemo(() => planContext(record), [record]);
  // The rewind control shows only on the LATEST user turn, and only when idle
  // (no in-flight turn to race the truncation). Find the last `user` block index.
  const lastUserIndex = useMemo(() => {
    for (let i = record.length - 1; i >= 0; i--) {
      if (record[i]?.kind === "user") return i;
    }
    return -1;
  }, [record]);
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
  // backendInFlight, backendActive, plan, canRewind — every one of which flips
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
              item.index === lastUserIndex ? handleRewind : undefined,
              item.images,
            )}
          </ErrorBoundary>
        ) : null,
      ),
    // The 30s clock is deliberately absent (perf 2026-08-25): timestamps
    // subscribe to the shared tick in their BubbleTime leaf, so a tick
    // invalidates label leafs, never these row elements.
    [items, recordStart, lang, lastUserIndex, handleRewind],
  );

  // ── assembly ────────────────────────────────────────────────────────────
  // Re-runs when the turn state moves, but only the activity groups are built
  // here; the bubble rows come from `blockRows` by reference.
  const rows = useMemo(
    () =>
      items.map((item, idx, all) => {
        if (item.kind === "block") return blockRows[idx];
        const isLast = idx === all.length - 1;
        // "Live" requires the CURRENT turn to actually own this group (audit
        // 2026-07-24, L1). The terminal-marker guard only recognizes 板砖's
        // done/noop markers, so an out-of-turn 系统 note (a workspace set /
        // reset) has none — and the moment the NEXT turn started, that
        // already-committed historical row began pulsing with a shimmering
        // header and a duration counting from 0s, as if 板砖 were performing
        // it right now. A backend anchor is the honest signal: it is null
        // until a dispatch actually starts, and the turn-start handler
        // clears it.
        const isActive =
          isLast &&
          status !== "idle" &&
          !activityHasTerminalMarker(item.blocks) &&
          (backendActive || backendStartedAt !== null);
        return (
          <ErrorBoundary
            key={`a${recordStart + item.startIndex}`}
            label="activity-row"
            fallback={<RowRenderError />}
          >
            <ActivityBlock
              blocks={item.blocks}
              active={isActive}
              // Live-turn state reaches only the live TURN's groups — every
              // group after the last user block, which includes the born-done
              // parts a beat split minted (they freeze their whole-run
              // duration from backendStartedAt while it is still set, so
              // strict `isActive` would starve them). Handed to every group,
              // the timestamps' null↔value flips at each turn boundary
              // defeated ActivityBlock's memo for the whole mounted history —
              // the last live-turn state still reaching historical rows after
              // adf67dc (perf review 2026-07-31).
              turnStartedAt={
                item.startIndex > lastUserIndex ? turnStartedAt : null
              }
              backendStartedAt={
                item.startIndex > lastUserIndex ? backendStartedAt : null
              }
              lang={lang}
              inFlightCount={isActive ? backendInFlight : 1}
              // Same discipline as inFlightCount: a historical group must
              // never receive live state. `plan` describes the dispatch in
              // flight, so a past group showing it would claim 板砖 is
              // working through a plan it finished turns ago.
              plan={isActive ? plan : null}
              onRemoveAttachment={removeAttachmentFactory}
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
      turnStartedAt,
      backendStartedAt,
      backendInFlight,
      plan,
      removeAttachmentFactory,
      // Read by the activity group's `isActive` (L1) — without it the rows
      // memo would keep rendering the last group as live after the backend
      // stopped.
      backendActive,
      // The live-turn gate above. Changes only with the record, which
      // already invalidates via `items` — listed for the lint contract.
      lastUserIndex,
    ],
  );

  return { items, rows };
}
