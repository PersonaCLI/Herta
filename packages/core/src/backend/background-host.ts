/**
 * Per-brief registry of managed background commands (ADR 0025 slice 4).
 * Lives in core so ToolContext can carry it (tools implement the
 * concrete process entries; the runtime owns the lifecycle). Reset per
 * `runBrief` like the transcript/read-ledger state, and — the
 * load-bearing rule — `stopAll()` runs when the brief ends, so a
 * background dev server can never outlive the dispatch that started it
 * (the shell policy's "no unmanaged backgrounding", kept).
 */
export interface BackgroundProcess {
  readonly id: string;
  readonly argv: readonly string[];
  isRunning(): boolean;
  /** Kill the whole process tree; resolves when the process has closed
   *  (or a bounded grace period elapsed). Idempotent. */
  kill(): Promise<void>;
  /**
   * Harness-owned, not model-started (ADR 0040): bash's persistent shell
   * registers here so it dies with the brief, and its reaping is routine —
   * it is not "a command the model left running" and must not surface as a
   * residual risk. It is the only entry there is now: the model-started
   * ones were the standard set's managed background commands (ADR 0086).
   */
  readonly internal?: boolean;
}

export class BackgroundHost {
  private seq = 0;
  private readonly entries = new Map<string, BackgroundProcess>();

  nextId(): string {
    this.seq += 1;
    return `bg-${this.seq}`;
  }

  register(p: BackgroundProcess): void {
    if (this.entries.has(p.id)) {
      throw new Error(`duplicate background id: ${p.id}`);
    }
    this.entries.set(p.id, p);
  }

  /** Model-visible lookup (internal harness processes are not addressable). */
  get(id: string): BackgroundProcess | undefined {
    const p = this.entries.get(id);
    return p === undefined || p.internal === true ? undefined : p;
  }

  /** Harness-side lookup incl. internal entries (the tool that owns a
   *  persistent shell finds it again on the next call this way). */
  getInternal(id: string): BackgroundProcess | undefined {
    return this.entries.get(id);
  }

  /** Model-visible entries (internal harness processes excluded). */
  list(): readonly BackgroundProcess[] {
    return [...this.entries.values()].filter((p) => p.internal !== true);
  }

  /** Kill every still-running process (internal ones too); returns how
   *  many MODEL-STARTED processes were killed — the number the report
   *  surfaces as "still running at brief end". */
  async stopAll(): Promise<number> {
    const running = [...this.entries.values()].filter((p) => p.isRunning());
    await Promise.allSettled(running.map((p) => p.kill()));
    return running.filter((p) => p.internal !== true).length;
  }
}
