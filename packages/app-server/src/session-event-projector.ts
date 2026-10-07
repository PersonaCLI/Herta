import type { AgentEvent, EventBus } from "@herta/core";
import type {
  OverlayEvent,
  RecordEvent,
  RepoEvent,
  ResumeEvent,
  SessionAgentEvent,
  SpeechControlEvent,
  TitleEvent,
  TurnLifecycleEvent,
  UndoEvent,
  VoiceCueEvent,
  WorkspaceEvent,
} from "./types.js";

interface BoundedQueue<T> {
  push(event: T): void;
  /** Returns the next event, blocking via a deferred until one arrives. */
  next(): Promise<{ value: T; done: false } | { value: undefined; done: true }>;
  close(): void;
}

function makeBoundedQueue<
  T extends { kind: "dropped"; count: number } | { kind: string },
>(capacity: number): BoundedQueue<T> {
  const buffer: T[] = [];
  let droppedCount = 0;
  let closed = false;
  let waiter:
    | ((
        value: { value: T; done: false } | { value: undefined; done: true },
      ) => void)
    | null = null;

  return {
    push(event: T): void {
      if (closed) return;
      if (waiter !== null) {
        const w = waiter;
        waiter = null;
        // Drain any pending drop sentinel first.
        if (droppedCount > 0) {
          const sentinel = { kind: "dropped", count: droppedCount } as T;
          droppedCount = 0;
          buffer.push(event);
          w({ value: sentinel, done: false });
          return;
        }
        w({ value: event, done: false });
        return;
      }
      if (buffer.length >= capacity) {
        buffer.shift();
        droppedCount += 1;
      }
      buffer.push(event);
    },
    async next(): Promise<
      { value: T; done: false } | { value: undefined; done: true }
    > {
      if (droppedCount > 0 && buffer.length > 0) {
        // Note: in the push branch above we already inject the
        // sentinel ahead of the next value; here we cover the case
        // where overflow happened entirely before next() was called.
        const sentinel = { kind: "dropped", count: droppedCount } as T;
        droppedCount = 0;
        return { value: sentinel, done: false };
      }
      const v = buffer.shift();
      if (v !== undefined) return { value: v, done: false };
      if (closed) return { value: undefined, done: true };
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    close(): void {
      closed = true;
      if (waiter !== null) {
        const w = waiter;
        waiter = null;
        w({ value: undefined, done: true });
      }
    },
  };
}

export interface SessionEventProjectorOpts {
  /** Per-subscriber queue capacity. Default 1000. */
  readonly queueCapacity?: number;
  /** Optional bus to auto-subscribe. If omitted, callers drive the
   *  projector via the `emit*` methods directly (useful for unit tests). */
  readonly bus?: EventBus<AgentEvent>;
}

export class SessionEventProjector {
  private readonly capacity: number;
  private readonly recordSubs = new Set<BoundedQueue<RecordEvent>>();
  private readonly overlaySubs = new Set<BoundedQueue<OverlayEvent>>();
  private readonly agentSubs = new Set<BoundedQueue<SessionAgentEvent>>();
  private readonly turnSubs = new Set<BoundedQueue<TurnLifecycleEvent>>();
  private readonly speechSubs = new Set<BoundedQueue<SpeechControlEvent>>();
  private readonly titleSubs = new Set<BoundedQueue<TitleEvent>>();
  private readonly workspaceSubs = new Set<BoundedQueue<WorkspaceEvent>>();
  private readonly voiceSubs = new Set<BoundedQueue<VoiceCueEvent>>();
  private readonly repoSubs = new Set<BoundedQueue<RepoEvent>>();
  private readonly resumeSubs = new Set<BoundedQueue<ResumeEvent>>();
  private readonly undoSubs = new Set<BoundedQueue<UndoEvent>>();
  private busUnsubscribe: (() => void) | null = null;
  // Set by close() so that subscriptions created after close immediately
  // yield done without blocking.
  private _closed = false;

  constructor(opts: SessionEventProjectorOpts = {}) {
    this.capacity = opts.queueCapacity ?? 1000;
    if (opts.bus !== undefined) {
      this.busUnsubscribe = opts.bus.onAny((event) => this.onBusEvent(event));
    }
  }

  // ───── public emit (used by Session for non-bus events) ─────

  emitRecord(ev: RecordEvent): void {
    for (const q of this.recordSubs) q.push(ev);
  }

  emitOverlay(ev: OverlayEvent): void {
    for (const q of this.overlaySubs) q.push(ev);
  }

  emitAgent(ev: SessionAgentEvent): void {
    for (const q of this.agentSubs) q.push(ev);
  }

  emitTurnLifecycle(ev: TurnLifecycleEvent): void {
    for (const q of this.turnSubs) q.push(ev);
  }

  emitSpeech(ev: SpeechControlEvent): void {
    for (const q of this.speechSubs) q.push(ev);
  }

  emitTitle(ev: TitleEvent): void {
    for (const q of this.titleSubs) q.push(ev);
  }

  emitWorkspace(ev: WorkspaceEvent): void {
    for (const q of this.workspaceSubs) q.push(ev);
  }

  emitVoice(ev: VoiceCueEvent): void {
    for (const q of this.voiceSubs) q.push(ev);
  }

  emitRepo(ev: RepoEvent): void {
    for (const q of this.repoSubs) q.push(ev);
  }

  emitResume(ev: ResumeEvent): void {
    for (const q of this.resumeSubs) q.push(ev);
  }

  emitUndo(ev: UndoEvent): void {
    for (const q of this.undoSubs) q.push(ev);
  }

  // ───── subscribe ─────

  subscribeRecord(): AsyncIterable<RecordEvent> {
    return this.makeIterable(this.recordSubs);
  }
  subscribeOverlay(): AsyncIterable<OverlayEvent> {
    return this.makeIterable(this.overlaySubs);
  }
  subscribeAgentEvents(): AsyncIterable<SessionAgentEvent> {
    return this.makeIterable(this.agentSubs);
  }
  subscribeTurnLifecycle(): AsyncIterable<TurnLifecycleEvent> {
    return this.makeIterable(this.turnSubs);
  }
  subscribeSpeech(): AsyncIterable<SpeechControlEvent> {
    return this.makeIterable(this.speechSubs);
  }
  subscribeTitle(): AsyncIterable<TitleEvent> {
    return this.makeIterable(this.titleSubs);
  }
  subscribeWorkspace(): AsyncIterable<WorkspaceEvent> {
    return this.makeIterable(this.workspaceSubs);
  }
  subscribeVoice(): AsyncIterable<VoiceCueEvent> {
    return this.makeIterable(this.voiceSubs);
  }
  subscribeRepo(): AsyncIterable<RepoEvent> {
    return this.makeIterable(this.repoSubs);
  }
  subscribeResume(): AsyncIterable<ResumeEvent> {
    return this.makeIterable(this.resumeSubs);
  }
  subscribeUndo(): AsyncIterable<UndoEvent> {
    return this.makeIterable(this.undoSubs);
  }

  // Test-only counters used by session-event-projector.test.ts.
  recordSubscriberCount(): number {
    return this.recordSubs.size;
  }

  close(): void {
    this._closed = true;
    if (this.busUnsubscribe !== null) {
      this.busUnsubscribe();
      this.busUnsubscribe = null;
    }
    for (const q of this.recordSubs) q.close();
    for (const q of this.overlaySubs) q.close();
    for (const q of this.agentSubs) q.close();
    for (const q of this.turnSubs) q.close();
    for (const q of this.speechSubs) q.close();
    for (const q of this.titleSubs) q.close();
    for (const q of this.workspaceSubs) q.close();
    for (const q of this.voiceSubs) q.close();
    for (const q of this.repoSubs) q.close();
    for (const q of this.resumeSubs) q.close();
    for (const q of this.undoSubs) q.close();
    this.repoSubs.clear();
    this.resumeSubs.clear();
    this.undoSubs.clear();
    this.recordSubs.clear();
    this.overlaySubs.clear();
    this.agentSubs.clear();
    this.turnSubs.clear();
    this.speechSubs.clear();
    this.titleSubs.clear();
    this.workspaceSubs.clear();
    this.voiceSubs.clear();
  }

  // ───── private ─────

  private makeIterable<T extends { kind: string }>(
    set: Set<BoundedQueue<T>>,
  ): AsyncIterable<T> {
    const capacity = this.capacity;
    // If the projector is already closed, return an immediately-done
    // iterable rather than creating a queue that would block forever.
    if (this._closed) {
      return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
          return {
            async next(): Promise<IteratorResult<T>> {
              return { value: undefined, done: true };
            },
          };
        },
      };
    }
    // EAGER registration: create and register the queue NOW (at
    // subscribeRecord/subscribeOverlay/… call time), NOT inside
    // [Symbol.asyncIterator](). This ensures events emitted before the
    // consumer starts its for-await loop are buffered and not lost.
    const q = makeBoundedQueue<T>(capacity);
    set.add(q);
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          async next(): Promise<IteratorResult<T>> {
            const result = await q.next();
            if (result.done) {
              set.delete(q);
              return { value: undefined, done: true };
            }
            return { value: result.value, done: false };
          },
          async return(): Promise<IteratorResult<T>> {
            set.delete(q);
            q.close();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  private onBusEvent(event: AgentEvent): void {
    // Every event fans out raw on the agent stream so callers wanting
    // low-level traces / debug overlays see everything. Record-stream
    // projection is NO LONGER done here — committed record blocks reach
    // subscribers via BusActorStreamingSink.flushBlocks in canonical order
    // (see docs/superpowers/specs/2026-06-01-gui-record-stream-ordering-design.md).
    // Keeping a second projection here would double-publish and re-introduce
    // the arrival-order ordering bug.
    this.emitAgent({ kind: "agent", event });
  }
}
