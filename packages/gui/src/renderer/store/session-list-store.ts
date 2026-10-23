import type {
  RecordEvent,
  SessionDeletedEvent,
  SessionMetadata,
  TitleEvent,
} from "@herta/app-server";
import { namePickedElements } from "@herta/core/page-element";
import type { HertaBridge } from "../ipc/bridge-types.js";

/** The most recent live title (one session's), used to drive the sidebar
 *  typewriter for exactly that entry. */
export interface LiveTitle {
  readonly sessionId: string;
  readonly title: string;
}

/**
 * Renderer mirror of the sidebar session list. Loaded once on
 * construction via listSessions() and refreshed whenever the active
 * session changes (reset) — a new/opened session may add an entry. A live
 * `session:title` event updates the matching entry's title and records it as
 * the `liveTitle` so the sidebar animates that one entry.
 *
 * It also tracks the active session's latest user message live (from the
 * record stream), so the moment you switch away the just-left card already
 * shows your last message — without waiting for the async disk refresh, which
 * would otherwise flash a stale value and break the preview cross-fade.
 */
export class SessionListStore {
  private sessions: readonly SessionMetadata[] = [];
  private liveTitle: LiveTitle | null = null;
  private activeSessionId: string | null = null;
  private readonly listeners = new Set<() => void>();
  private bridge: HertaBridge | null = null;
  private unsubReset: (() => void) | null = null;
  private unsubRecord: (() => void) | null = null;
  private unsubTitle: (() => void) | null = null;
  private unsubDeleted: (() => void) | null = null;
  private connected = false;
  /** Tombstones for optimistically-deleted session ids: a refresh whose
   *  listSessions() snapshot predates the on-disk delete must not resurrect
   *  the card (audit 2026-07-10). UUIDs never recur, so grow-only is safe. */
  private readonly deletedIds = new Set<string>();

  // Pure constructor — subscription happens in connect(), driven by the
  // provider's useEffect. See SessionStore for the StrictMode rationale.

  /** Load the list + subscribe to reset/record/title events. Returns a
   *  disconnect function. Idempotent and re-callable after disconnect. */
  connect(bridge: HertaBridge): () => void {
    this.disconnect();
    this.bridge = bridge;
    this.connected = true;
    void this.refresh();
    this.unsubReset = bridge.onReset((e) => {
      this.activeSessionId =
        "error" in e || "noSession" in e ? null : e.sessionId;
      // A reset naming a session is AUTHORITATIVE proof it exists — clear
      // any tombstone for it (web bug 2026-07-10: the site's demo bridge
      // recreates its fixed LIVE_ID after a delete, and the ghost-card
      // tombstone suppressed the re-created session's card forever; app
      // session ids are UUIDs, so this is a no-op there).
      if (this.activeSessionId !== null) {
        this.deletedIds.delete(this.activeSessionId);
      }
      void this.refresh();
    });
    this.unsubRecord = bridge.onRecord((e) => this.onRecord(e));
    this.unsubTitle = bridge.onTitle((e) => this.onTitle(e));
    this.unsubDeleted = bridge.onSessionDeleted((e) =>
      this.onSessionDeleted(e),
    );
    return () => this.disconnect();
  }

  private disconnect(): void {
    this.connected = false;
    this.unsubReset?.();
    this.unsubReset = null;
    this.unsubRecord?.();
    this.unsubRecord = null;
    this.unsubTitle?.();
    this.unsubTitle = null;
    this.unsubDeleted?.();
    this.unsubDeleted = null;
    this.bridge = null;
  }

  readonly subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  readonly getSnapshot = (): readonly SessionMetadata[] => this.sessions;

  /** The session whose title just arrived live (for sidebar animation), or
   *  null. Stable reference until the next live title. */
  readonly getLiveTitleSnapshot = (): LiveTitle | null => this.liveTitle;

  /** The live title finished typing in on its card: from now on it is a
   *  title like any other. Without this the card typed it in again on every
   *  remount — a search filter, a move into another day group — for the
   *  rest of the run (UX review 2026-09-22, item 25). A newer live title
   *  (another session's) is left alone. */
  settleLiveTitle(sessionId: string): void {
    if (this.liveTitle?.sessionId !== sessionId) return;
    this.liveTitle = null;
    for (const l of this.listeners) l();
  }

  /** The user renamed a session (ADR 0072 §3): its card shows the name at
   *  once. No type-in — the user just typed it — and a generated title that
   *  was still typing in on that card stops. */
  applyUserTitle(sessionId: string, title: string | null): void {
    this.sessions = this.sessions.map((s) => {
      if (s.sessionId !== sessionId) return s;
      // null: a failed rename going back to no title at all.
      const { title: _old, ...rest } = s;
      return title === null ? rest : { ...rest, title };
    });
    if (this.liveTitle?.sessionId === sessionId) this.liveTitle = null;
    for (const l of this.listeners) l();
  }

  dispose(): void {
    this.disconnect();
    this.listeners.clear();
  }

  private onRecord(e: RecordEvent): void {
    // A record-stream RESET means the record was replaced wholesale — today
    // that is a rewind (truncation) or an overflow heal. Either way the
    // optimistic `lastUserText` written below may now describe a message that
    // no longer exists: rewinding a just-sent message left the sidebar card
    // previewing the withdrawn text forever, because nothing on this store's
    // three subscriptions fires for a rewind (user 2026-08-03 — `onReset` is
    // the SESSION channel, not this one). Re-read disk truth; the rewind
    // truncates the JSONL before emitting, so the refresh sees the short file.
    if (e.kind === "reset") {
      void this.refresh();
      return;
    }
    if (e.kind !== "block" || e.block.kind !== "user") return;
    const id = this.activeSessionId;
    if (id === null) return;
    const text = e.block.text;
    // Keep the active session's last user message current in the renderer —
    // and bump it to the head with a fresh lastActivityAt. The sidebar
    // buckets by lastActivityAt (disk mtime, only refreshed on reset) and
    // preserves list order, so without the live bump a reactivated old
    // session stayed in its stale bucket ("Yesterday") while its preview
    // updated (user 2026-06-13). Disk truth converges on the next refresh
    // (the transcript write moves the mtime the same way).
    const bumped = this.sessions.find((s) => s.sessionId === id);
    if (bumped === undefined) return;
    this.sessions = [
      {
        ...bumped,
        // A picked page element reads as the element (ADR 0083 §4).
        lastUserText: namePickedElements(
          text,
          e.block.picks,
          bumped.lang ?? "zh",
        ),
        lastActivityAt: new Date().toISOString(),
      },
      ...this.sessions.filter((s) => s.sessionId !== id),
    ];
    for (const l of this.listeners) l();
  }

  private onSessionDeleted(e: SessionDeletedEvent): void {
    // Drop the deleted card optimistically (no refetch). Clear the active
    // pointer if it was the open one, so a later record event doesn't revive
    // its lastUserText. Tombstone the id (audit 2026-07-10): an in-flight
    // refresh whose listSessions() snapshot was taken BEFORE the files were
    // deleted can otherwise re-commit the card as a ghost — refreshSeq only
    // orders refreshes against each other, not against deletes. Session ids
    // are UUIDs (never reused), so the set only ever grows by real deletes
    // within one app run.
    this.deletedIds.add(e.sessionId);
    this.sessions = this.sessions.filter((s) => s.sessionId !== e.sessionId);
    if (this.activeSessionId === e.sessionId) this.activeSessionId = null;
    for (const l of this.listeners) l();
  }

  private onTitle(e: TitleEvent): void {
    if (e.kind !== "title") return;
    // Update the matching entry's title (so it persists after the animation)
    // and flag it as the live one (so the sidebar types just that entry in).
    this.sessions = this.sessions.map((s) =>
      s.sessionId === e.sessionId ? { ...s, title: e.title } : s,
    );
    this.liveTitle = { sessionId: e.sessionId, title: e.title };
    for (const l of this.listeners) l();
  }

  private refreshSeq = 0;

  private async refresh(): Promise<void> {
    const bridge = this.bridge;
    if (bridge === null) return;
    // Overlapping refreshes (every reset triggers one) resolve out of order:
    // a slower OLDER listSessions() must not overwrite a newer one with stale
    // ordering/titles. Only the latest request may commit.
    const my = ++this.refreshSeq;
    const next = await bridge.listSessions();
    // Ignore a late resolution that lands after disconnect or a newer refresh.
    if (!this.connected || my !== this.refreshSeq) return;
    // Filter tombstoned ids: a snapshot read before the delete landed on
    // disk must not resurrect the card (see onSessionDeleted).
    this.sessions = next.filter((s) => !this.deletedIds.has(s.sessionId));
    for (const l of this.listeners) l();
  }
}
