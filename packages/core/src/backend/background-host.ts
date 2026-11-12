/**
 * Per-brief registry of the processes the harness keeps for a run and must
 * end with it. Lives in core so ToolContext can carry it (a tool implements
 * the process entry; the runtime owns the lifecycle). Reset per `runBrief`
 * like the transcript/read-ledger state, and — the load-bearing rule —
 * `stopAll()` runs when the brief ends, so nothing a brief started can
 * outlive the dispatch that started it (the shell policy's "no unmanaged
 * backgrounding", kept).
 *
 * One kind of entry registers: bash's persistent shell (ADR 0040), under a
 * fixed id, with everything it backgrounded in its process group. Until ADR
 * 0086 there was a second kind, the standard set's managed background
 * commands, which the model started and addressed by a `bg-N` id; the
 * registry minted those ids, listed them to the model, and counted the ones
 * still running at the end of a brief as a risk on the report. That half
 * went with the tools.
 */
export interface BackgroundProcess {
  readonly id: string;
  readonly argv: readonly string[];
  isRunning(): boolean;
  /** Kill the whole process tree; resolves when the process has closed
   *  (or a bounded grace period elapsed). Idempotent. */
  kill(): Promise<void>;
}

export class BackgroundHost {
  private readonly entries = new Map<string, BackgroundProcess>();

  register(p: BackgroundProcess): void {
    if (this.entries.has(p.id)) {
      throw new Error(`duplicate background id: ${p.id}`);
    }
    this.entries.set(p.id, p);
  }

  /** The entry its owner registered: the tool that owns the persistent
   *  shell finds it again on the next call this way. */
  get(id: string): BackgroundProcess | undefined {
    return this.entries.get(id);
  }

  /** Kill every entry that may still have something running. Reaping is
   *  routine, not a finding: nothing is counted or reported. */
  async stopAll(): Promise<void> {
    const running = [...this.entries.values()].filter((p) => p.isRunning());
    await Promise.allSettled(running.map((p) => p.kill()));
  }
}
