import type { TerminalRecordBlock } from "@herta/app-server";

/** The system-block member of the record union (no name-import needed). */
export type SystemBlock = Extract<TerminalRecordBlock, { kind: "system" }>;

/** The user-block member: a message, or a steer inside a run. */
export type UserBlock = Extract<TerminalRecordBlock, { kind: "user" }>;

/** Herta's block: her speech, or her answer during a run. */
export type HertaBlock = Extract<TerminalRecordBlock, { kind: "herta" }>;

/** A steer as the run took it: the Trailblazer's words, or her answer that
 *  carried a live `@板砖` (ADR 0085 §4) — its `steered` sentences. */
export type SteerBlock = UserBlock | HertaBlock;

/** One entry of a run as the record holds it (ADR 0085 §6): 板砖's rows,
 *  and the steers it took where it took them. */
export type RunEntry =
  | { readonly kind: "row"; readonly block: SystemBlock }
  | { readonly kind: "steer"; readonly block: SteerBlock };

/** Who steered, and what reached 板砖. */
export function steerOf(block: SteerBlock): {
  readonly speaker: "trailblazer" | "herta";
  readonly text: string;
} {
  return block.kind === "user"
    ? { speaker: "trailblazer", text: block.text }
    : { speaker: "herta", text: block.steered ?? block.text };
}

/** The structured done-marker roll-up (derived from the block, no name-import). */
export type DoneMarkerSummary = NonNullable<SystemBlock["markerSummary"]>;

/**
 * What the activity header should display. `structured` carries the typed
 * roll-up (new records) so the renderer composes a localized summary;
 * `raw` carries the canonical body verbatim (records persisted before the
 * structured field existed). `noop` is recognised by role alone — it has no
 * counts, so it never needs a `markerSummary` on the block.
 */
export type ActivitySummary =
  | {
      readonly kind: "structured";
      readonly marker: DoneMarkerSummary;
      /** The marker block's own `at` stamp — DiffStat's recency gate reads
       *  it so history never replays the count-up (2026-08-25). */
      readonly at?: string;
    }
  | { readonly kind: "noop" }
  | { readonly kind: "raw"; readonly text: string };

export type RenderItem =
  | {
      readonly kind: "block";
      readonly block: TerminalRecordBlock;
      readonly index: number;
      /** Pictures the 开拓者 sent WITH this message (ADR 0048 §4), lifted out
       *  of the activity run that follows it so the bubble can show them as
       *  what they are: part of what was handed over, not work Herta did.
       *  Only ever set on a `user` block. */
      readonly images?: readonly SystemBlock[];
    }
  | {
      readonly kind: "activity";
      readonly startIndex: number;
      readonly blocks: readonly SystemBlock[];
    }
  | {
      /** One dispatch of 板砖's, from its first row to its marker (ADR 0085
       *  §6): the chat draws it as one row, under the bubble that sent it. */
      readonly kind: "run";
      /** The run's first block, as an index into the window. */
      readonly startIndex: number;
      /** Every system block of the run, across the beats that split it. */
      readonly blocks: readonly SystemBlock[];
      /** The blocks and the steers, in record order: the 完整记录 tab's
       *  rows. */
      readonly entries: readonly RunEntry[];
      /** The stamp of her bubble that dispatched it: the run's time is
       *  counted from there, as the live row counts from the backend's
       *  start — 板砖 thinks before its first row lands. */
      readonly dispatchedAt?: string;
    };

/** What the record folds into before runs are drawn (no `run` items yet):
 *  the Markdown export reads this. */
export type RecordItem = Exclude<RenderItem, { readonly kind: "run" }>;

/** An image attachment block — a picture that was stored, with or without a
 *  caption. Text/document attachments are NOT lifted: their content is the
 *  excerpt in the row, and there is nothing to look at. */
function isImageAttachment(block: SystemBlock): boolean {
  return (
    block.digest?.kind === "attachment" && block.digest.image !== undefined
  );
}

/**
 * Lift the pictures a message came with onto the message itself (ADR 0048 §4).
 *
 * The RECORD order is user-block-then-attachments: the picture is evidence
 * that arrived with the words, and it sits inside the turn's span so a rewind
 * takes both. The SCREEN reads better the other way round — the thumbnail
 * above the bubble, the way the 开拓者 experienced sending it — and D7 is
 * exactly the licence to differ here: same record, different overlay.
 *
 * Only the run IMMEDIATELY after a user block is considered, and only its
 * leading image blocks. An image attached in any other position (an
 * out-of-turn attach, a picture 板砖 produced) stays an ordinary activity row,
 * because it did not come with a message.
 */
export function liftUserImages(items: readonly RenderItem[]): RenderItem[] {
  const out: RenderItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue;
    const next = items[i + 1];
    if (
      item.kind !== "block" ||
      item.block.kind !== "user" ||
      next === undefined ||
      next.kind !== "activity"
    ) {
      out.push(item);
      continue;
    }
    // Leading images only: a run of [image, image, op, image] gives up its
    // first two, and the op row keeps everything after it in order.
    let n = 0;
    while (n < next.blocks.length) {
      const b = next.blocks[n];
      if (b === undefined || !isImageAttachment(b)) break;
      n += 1;
    }
    if (n === 0) {
      out.push(item);
      continue;
    }
    out.push({ ...item, images: next.blocks.slice(0, n) });
    const rest = next.blocks.slice(n);
    // The run may be entirely images — then it contributes no activity item at
    // all, and the next iteration must not re-emit it.
    if (rest.length > 0) {
      out.push({
        kind: "activity",
        // Keyed by the first REMAINING block's index, so the key stays unique
        // and the "is this group newer than the last user turn" comparisons
        // downstream still describe the blocks actually in it.
        startIndex: next.startIndex + n,
        blocks: rest,
      });
    }
    i += 1; // consumed `next`
  }
  return out;
}

/**
 * Fold the flat record into render items: maximal runs of consecutive
 * `system` blocks become one `activity` item (keyed by its first index,
 * stable because the record is append-only); user/herta blocks pass through.
 * Pure presentation — the record itself is unchanged (D7).
 */
export function groupRecord(
  record: readonly TerminalRecordBlock[],
): RecordItem[] {
  const items: RecordItem[] = [];
  let i = 0;
  while (i < record.length) {
    const block = record[i];
    if (block === undefined) {
      i += 1;
      continue;
    }
    if (block.kind === "system") {
      const startIndex = i;
      const blocks: SystemBlock[] = [];
      while (i < record.length) {
        const b = record[i];
        if (b === undefined || b.kind !== "system") break;
        blocks.push(b);
        i += 1;
      }
      items.push({ kind: "activity", startIndex, blocks });
    } else {
      items.push({ kind: "block", block, index: i });
      i += 1;
    }
  }
  return items;
}

/** The previous array for a run that starts with this block — reused while
 *  the run is element-for-element the same. Weak: a record that is dropped
 *  takes its entries with it. */
type RunCache = WeakMap<SystemBlock, readonly SystemBlock[]>;
// Two caches, not one: a run that opens with pictures and the pictures
// lifted out of it START WITH THE SAME BLOCK, and sharing a cache would
// have each evict the other on every commit.
const activityRuns: RunCache = new WeakMap();
const liftedImages: RunCache = new WeakMap();

function sameRun(
  a: readonly SystemBlock[],
  b: readonly SystemBlock[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function stableRun(
  cache: RunCache,
  run: readonly SystemBlock[],
): readonly SystemBlock[] {
  const first = run[0];
  if (first === undefined) return run;
  const prev = cache.get(first);
  if (prev !== undefined && sameRun(prev, run)) return prev;
  cache.set(first, run);
  return run;
}

/**
 * Give every run of blocks the ARRAY it had last time, when nothing in it
 * changed (perf audit 2026-09-20, ADR 0068 §8).
 *
 * `groupRecord` rebuilds every group's `blocks` array on each record commit,
 * and `memo(ActivityBlock)` compares props by identity — so one new block at
 * the tail re-rendered EVERY activity group in the window: each re-derived
 * its rows, re-folded its patches through `summarizeDiff`, re-minted the
 * objects its steps memoize on. A tool call is two or three commits, a
 * parallel batch five to ten, each its own synchronous render. The same
 * went for a user bubble's lifted pictures (a fresh `slice` per commit).
 *
 * The store keeps block OBJECTS across an append, a load-earlier prepend
 * and a window trim, so "the same run" is decidable by reference, in one
 * pass over the window. A run that really changed — the live group growing,
 * a reset or a rewind minting new blocks — fails the comparison and gets
 * its new array, as it must. Only identity is touched: the items, their
 * indices and their order are exactly what came in.
 */
export function shareRunIdentity(items: readonly RenderItem[]): RenderItem[] {
  return items.map((item) => {
    if (item.kind === "activity" || item.kind === "run") {
      const blocks = stableRun(activityRuns, item.blocks);
      return blocks === item.blocks ? item : { ...item, blocks };
    }
    if (item.images === undefined) return item;
    const images = stableRun(liftedImages, item.images);
    return images === item.images ? item : { ...item, images };
  });
}

function isTerminal(b: SystemBlock): boolean {
  return b.role === "done-marker" || b.role === "noop-marker";
}

/** A group that is the Trailblazer's own act, or the app's, never 板砖's:
 *  files handed over, an undo line, a dev server started or stopped from
 *  the page tab. It keeps its own line even inside a run. */
function standsAlone(blocks: readonly SystemBlock[]): boolean {
  return blocks.every(
    (b) =>
      b.digest?.kind === "attachment" ||
      b.digest?.kind === "undo" ||
      b.digest?.kind === "server",
  );
}

/**
 * Fold each of 板砖's dispatches into one `run` item (ADR 0085 §6, build
 * step 1): the chat keeps one row per run, under the bubble that dispatched
 * it, and the run's rows move to its 完整记录 tab.
 *
 * A run opens at a group with a coprocessor block and takes every group
 * after it — the beats that split it stay bubbles in place — until its
 * terminal marker, or until a message that is not a steer or talk during
 * the run (ADR 0085 step 3). A steer inside it is both: a bubble where it
 * was sent, and an entry of the run where 板砖 took it; so is her answer
 * that steered. Talk is a bubble only. A group that stands alone (an attachment, an undo line, a server
 * the Trailblazer started) keeps its own line. Blocks after a marker in the
 * same group belong to the next dispatch.
 *
 * Pure presentation (D7): every block is still drawn, by the row or by the
 * tab.
 */
export function groupRuns(items: readonly RenderItem[]): RenderItem[] {
  const out: RenderItem[] = [];
  let open: {
    readonly at: number;
    readonly startIndex: number;
    readonly blocks: SystemBlock[];
    readonly entries: RunEntry[];
    readonly dispatchedAt: string | undefined;
  } | null = null;
  const seal = (): void => {
    if (open === null) return;
    out[open.at] = {
      kind: "run",
      startIndex: open.startIndex,
      blocks: open.blocks,
      entries: open.entries,
      ...(open.dispatchedAt !== undefined
        ? { dispatchedAt: open.dispatchedAt }
        : {}),
    };
    open = null;
  };
  for (const item of items) {
    if (item.kind !== "activity") {
      if (item.kind === "block" && item.block.kind === "user") {
        if (item.block.steer === true)
          open?.entries.push({ kind: "steer", block: item.block });
        else if (item.block.duringRun !== true) seal();
      }
      if (
        item.kind === "block" &&
        item.block.kind === "herta" &&
        item.block.steered !== undefined
      )
        open?.entries.push({ kind: "steer", block: item.block });
      out.push(item);
      continue;
    }
    if (open !== null && standsAlone(item.blocks)) {
      out.push(item);
      continue;
    }
    let rest = item.blocks;
    let restStart = item.startIndex;
    while (rest.length > 0) {
      if (open === null) {
        // A patch preview is 板砖's too: a run whose first call is a write that
        // asks has nothing else to show while the card is up (review
        // 2026-11-05, N7).
        if (
          !rest.some(
            (b) => b.label === "差分协处理器" || b.digest?.kind === "patch",
          )
        ) {
          out.push(
            rest === item.blocks
              ? item
              : { kind: "activity", startIndex: restStart, blocks: rest },
          );
          break;
        }
        const before = out[out.length - 1];
        open = {
          at: out.length,
          startIndex: restStart,
          blocks: [],
          entries: [],
          dispatchedAt:
            before?.kind === "block" && before.block.kind === "herta"
              ? before.block.at
              : undefined,
        };
        // Held until the run is sealed: its blocks are still arriving.
        out.push(item);
      }
      const end = rest.findIndex(isTerminal);
      const taken = end === -1 ? rest : rest.slice(0, end + 1);
      for (const block of taken) {
        open.blocks.push(block);
        open.entries.push({ kind: "row", block });
      }
      if (end === -1) break;
      seal();
      restStart += end + 1;
      rest = rest.slice(end + 1);
    }
  }
  seal();
  return out;
}

/** Chip identity: backend if any backend block, else system. */
export function activityChipLabel(
  blocks: readonly SystemBlock[],
): "差分协处理器" | "系统" {
  return blocks.some((b) => b.label === "差分协处理器")
    ? "差分协处理器"
    : "系统";
}

/**
 * The done/noop marker summary shown in the header, or null when the run has
 * no terminal marker yet. Prefers the structured roll-up (localizable);
 * falls back to the canonical body for pre-structured records.
 */
export function activitySummary(
  blocks: readonly SystemBlock[],
): ActivitySummary | null {
  const marker = blocks.find(isTerminal);
  if (marker === undefined) return null;
  if (marker.role === "noop-marker") return { kind: "noop" };
  if (marker.markerSummary !== undefined) {
    return {
      kind: "structured",
      marker: marker.markerSummary,
      ...(marker.at !== undefined ? { at: marker.at } : {}),
    };
  }
  return { kind: "raw", text: marker.body };
}

export function activityHasTerminalMarker(
  blocks: readonly SystemBlock[],
): boolean {
  return blocks.some(isTerminal);
}

/** The operational rows (terminal markers are header summary, not steps). */
export function activitySteps(
  blocks: readonly SystemBlock[],
): readonly SystemBlock[] {
  return blocks.filter((b) => !isTerminal(b));
}

/** One rendered row: the operation, plus the patch preview it produced. */
export interface ActivityRow {
  readonly block: SystemBlock;
  /** The patch this operation wrote, folded into the row (2026-08-25). */
  readonly patch?: SystemBlock;
}

/**
 * Pair each patch preview with the operation that produced it.
 *
 * `patch.preview` is published by the permission RULE, which runs BEFORE the
 * tool does — so the diff block is projected AHEAD of its own operation row,
 * and the record read backwards: a wall of diff, then the action that caused
 * it (owner, 2026-08-25). Folding the preview into the following operation
 * puts the action first and the evidence inside it, which is also what makes
 * the diff collapsible instead of unconditionally printed.
 *
 * The pairing is by ADJACENCY, not by verb. `permissions.check` publishes the
 * preview and `tool.call.started` projects the op immediately after, so the
 * next step IS the operation — whatever it is called. That matters: under the
 * minimal contract (the default) a heredoc write comes from `bash`, and its
 * row reads `Running`, not `Writing`.
 *
 * Adjacency is also the safety property. A DENIED write publishes its preview
 * and then never starts, so what follows is a tool-fail row; without the
 * adjacency requirement the orphaned diff would attach itself to some later,
 * unrelated operation. A preview that finds no operation immediately after it
 * stands as its own row instead — the record never loses a block to a
 * presentation rule (D7).
 */
export function activityRows(
  blocks: readonly SystemBlock[],
): readonly ActivityRow[] {
  const steps = activitySteps(blocks);
  const rows: ActivityRow[] = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    if (step === undefined) {
      i += 1;
      continue;
    }
    if (!isPreview(step)) {
      rows.push({ block: step });
      i += 1;
      continue;
    }
    // A run of previews, then the run of operations right after it: pair them
    // in order. One preview + one op is the only shape the runtime produces
    // today (a write is never part of a parallel read-only batch), but pairing
    // by position keeps a batched one honest instead of guessing.
    const previews: SystemBlock[] = [];
    while (i < steps.length) {
      const b = steps[i];
      if (b === undefined || !isPreview(b)) break;
      previews.push(b);
      i += 1;
    }
    for (const preview of previews) {
      const next = steps[i];
      if (next !== undefined && next.digest?.kind === "op") {
        rows.push({ block: next, patch: preview });
        i += 1;
      } else {
        rows.push({ block: preview });
      }
    }
  }
  return rows;
}

/** A patch preview. `skip` is how records before 2026-08-25 carried one. */
function isPreview(b: SystemBlock): boolean {
  return b.digest?.kind === "patch" || b.digest?.kind === "skip";
}

/** The record's last message that opens a turn (a steer opens none: ADR
 *  0063 §1.10; nor does talk during a run: ADR 0085), or -1. */
export function lastTurnIndex(record: readonly TerminalRecordBlock[]): number {
  for (let i = record.length - 1; i >= 0; i--) {
    const b = record[i];
    if (b?.kind === "user" && b.steer !== true && b.duringRun !== true)
      return i;
  }
  return -1;
}

/**
 * Where 撤销 goes (ADR 0074 §4): the latest turn's LAST finished run — a
 * turn can hold several dispatches, and the undo takes them all — as an
 * index into `items`, or -1. `undone`: the turn already holds its undo line,
 * and that run says so instead.
 */
export function undoTarget(
  items: readonly RenderItem[],
  lastTurn: number,
): { readonly card: number; readonly undone: boolean } {
  let card = -1;
  let undone = false;
  items.forEach((item, idx) => {
    if (item.kind === "block" || item.startIndex <= lastTurn) return;
    if (item.blocks.some((b) => b.digest?.kind === "undo")) undone = true;
    else if (
      item.kind === "run" &&
      item.blocks.some((b) => b.role === "done-marker")
    )
      card = idx;
  });
  return { card, undone };
}

/** The latest turn's last run while it has no marker, as an index into
 *  `items`, or -1. Whether it is still WORKING is the session's to say (the
 *  turn runs, the backend started): an earlier run cut short has no marker
 *  either. */
export function openRun(
  items: readonly RenderItem[],
  lastTurn: number,
): number {
  for (let idx = items.length - 1; idx >= 0; idx -= 1) {
    const item = items[idx];
    if (item === undefined || item.kind === "block") continue;
    if (item.startIndex <= lastTurn) return -1;
    if (item.kind !== "run") continue;
    return activityHasTerminalMarker(item.blocks) ? -1 : idx;
  }
  return -1;
}
