import type { ServerHost, ServerStatus } from "@herta/core";
import { Launcher } from "@herta/tools";

/** Where a session's servers are journaled, so a relaunch can end what an
 *  exit left running (the session host's `serverJournal`). */
interface ServerJournalLike {
  spawned(s: {
    readonly pid: number;
    readonly startedAt: number;
    readonly name: string;
    readonly sessionId: string;
  }): Promise<void>;
  exited(pid: number): Promise<void>;
}

/**
 * The window's dev servers, one launcher per session (ADR 0083 §5). The
 * session owns them: they keep running while the Trailblazer moves between
 * sessions, as the session's page does, and stop when the session is
 * deleted, its workspace moves (the session does that) or the window and
 * app close. Each spawn is journaled for the next launch.
 */
export class ServerRegistry {
  private readonly launchers = new Map<string, Launcher>();
  private journal: ServerJournalLike | null = null;
  /** Set as the window closes. What the launchers report after that — the
   *  servers' own exits as `dispose` stops them — has no window to reach,
   *  and the report into a destroyed window threw in main (Mac check,
   *  2026-10-24). The journal still hears every exit. */
  private disposed = false;

  constructor(
    private readonly events: {
      /** A server's state changed (the new-tab page, later). */
      readonly changed?: (sessionId: string, status: ServerStatus) => void;
      /** A server answers: the page may open on it. */
      readonly ready?: (sessionId: string, url: string) => void;
    } = {},
  ) {}

  /** The session host's journal, once the host exists. */
  attachJournal(journal: ServerJournalLike | null): void {
    this.journal = journal;
  }

  forSession(sessionId: string): ServerHost {
    const have = this.launchers.get(sessionId);
    if (have !== undefined) return have;
    const launcher = new Launcher({
      onSpawn: (s) => void this.journal?.spawned({ ...s, sessionId }),
      onExit: (pid) => void this.journal?.exited(pid),
      onChange: (status) => {
        if (this.disposed) return;
        this.events.changed?.(sessionId, status);
        if (status.state === "ready")
          this.events.ready?.(sessionId, status.url);
      },
    });
    this.launchers.set(sessionId, launcher);
    return launcher;
  }

  /** The session was deleted: its servers stop. */
  closeSession(sessionId: string): void {
    const launcher = this.launchers.get(sessionId);
    if (launcher === undefined) return;
    this.launchers.delete(sessionId);
    void launcher.stopAll();
  }

  /** The window or the app closes: every server stops. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const all = [...this.launchers.values()];
    this.launchers.clear();
    await Promise.allSettled(all.map((l) => l.stopAll()));
  }
}
