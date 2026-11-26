/**
 * The session's view of its workspace's repository (ADR 0058, ADR 0059):
 * the probe behind the rail's repository card, the git-dir watcher that
 * keeps the card live, and the viewer's four git reads. They were fields
 * and methods of SessionImpl (review 2026-11-10, moved 2026-11-25); the
 * session holds one of these and delegates to it, so what a host sees of
 * the session is unchanged.
 *
 * Every read goes to the session's EFFECTIVE backend workspace, read from
 * the holder the session shares at each call: a workspace switch moves the
 * next probe, and the answer to it re-arms the watcher on the new git dir.
 */
import type { RepoContextSnapshot } from "@herta/core";
import {
  type BranchList,
  type CommitDescription,
  describeBranches,
  describeCommit,
  describeLog,
  describeRepoOutcome,
  describeWorkingDiff,
  type GitReadTimeout,
  type LogPage,
  type LogQuery,
  type RepoContextOutcome,
  type WorkingDiff,
} from "@herta/tools";
import {
  REPO_WATCH_DEBOUNCE_MS,
  REPO_WATCH_MAX_WAIT_SPANS,
  type RepoWatcher,
  watchGitDir,
} from "./repo-watch.js";
import type { RepoEvent } from "./types.js";

/** The probe, the watcher and the readers a session's repository uses.
 *  Production uses git's (`sessionRepoReaders`); tests pass stubs through
 *  `SessionInternalDeps`, whose fields carry the same names. */
export interface SessionRepoReaders {
  readonly repoDescriber: (
    workspace: string,
    signal?: AbortSignal,
  ) => Promise<RepoContextOutcome>;
  readonly repoWatcher: RepoWatcher;
  readonly repoWatchDebounceMs: number;
  readonly commitDescriber: (
    workspace: string,
    ref: string,
    signal?: AbortSignal,
  ) => Promise<CommitDescription | null | GitReadTimeout>;
  readonly workingDiffDescriber: (
    workspace: string,
    path: string,
    signal?: AbortSignal,
  ) => Promise<WorkingDiff | null | GitReadTimeout>;
  readonly logDescriber: (
    workspace: string,
    opts: LogQuery,
    signal?: AbortSignal,
  ) => Promise<LogPage | null | GitReadTimeout>;
  readonly branchesDescriber: (
    workspace: string,
    signal?: AbortSignal,
  ) => Promise<BranchList | null | GitReadTimeout>;
}

/** Each reader from `deps` where a test supplied one, else git's. */
export function sessionRepoReaders(
  deps: Partial<SessionRepoReaders>,
): SessionRepoReaders {
  return {
    repoDescriber: deps.repoDescriber ?? describeRepoOutcome,
    repoWatcher: deps.repoWatcher ?? watchGitDir,
    repoWatchDebounceMs: deps.repoWatchDebounceMs ?? REPO_WATCH_DEBOUNCE_MS,
    commitDescriber: deps.commitDescriber ?? describeCommit,
    workingDiffDescriber: deps.workingDiffDescriber ?? describeWorkingDiff,
    logDescriber: deps.logDescriber ?? describeLog,
    branchesDescriber: deps.branchesDescriber ?? describeBranches,
  };
}

export class SessionRepo {
  /** The session's effective backend workspace: the holder it shares. */
  private readonly wsHolder: { readonly current: string };
  /** Where an answer goes: the session's projector. */
  private readonly emitRepo: (ev: RepoEvent) => void;

  // The workspace's repository as last probed (ADR 0058) — the rail's
  // repository card. Probed on create, on a workspace change, at every
  // turn's end and on request; one probe at a time, a request during one
  // runs exactly one more after it (a burst of focus events is one probe).
  private _repo: RepoContextSnapshot | null = null;
  private repoProbeInFlight = false;
  private repoProbeAgain = false;
  private readonly repoDescriber: (
    workspace: string,
    signal?: AbortSignal,
  ) => Promise<RepoContextOutcome>;
  // A probe that could not answer with nothing on screen tries once more,
  // a max-wait span later (ADR 0058 §7.6); one retry per definite answer.
  private repoRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private repoRetried = false;
  // The git-dir watcher (ADR 0058 amendment, 2026-09-07): armed on the git
  // dir each probe answer names, re-armed when it changes (a workspace
  // switch), dropped when the answer is "not a repository" or the session
  // closes. Its bursts debounce into one probe.
  private readonly repoWatcher: RepoWatcher;
  private readonly repoWatchDebounceMs: number;
  private repoWatchedDir: string | null = null;
  private stopRepoWatch: (() => void) | null = null;
  private repoWatchTimer: NodeJS.Timeout | null = null;
  /** When the current burst of watcher events began (the max-wait). */
  private repoWatchSince: number | null = null;
  private repoClosed = false;
  private readonly commitDescriber: (
    workspace: string,
    ref: string,
    signal?: AbortSignal,
  ) => Promise<CommitDescription | null | GitReadTimeout>;
  private readonly workingDiffDescriber: (
    workspace: string,
    path: string,
    signal?: AbortSignal,
  ) => Promise<WorkingDiff | null | GitReadTimeout>;
  private readonly logDescriber: (
    workspace: string,
    opts: LogQuery,
    signal?: AbortSignal,
  ) => Promise<LogPage | null | GitReadTimeout>;
  private readonly branchesDescriber: (
    workspace: string,
    signal?: AbortSignal,
  ) => Promise<BranchList | null | GitReadTimeout>;

  constructor(
    opts: SessionRepoReaders & {
      readonly wsHolder: { readonly current: string };
      readonly emitRepo: (ev: RepoEvent) => void;
    },
  ) {
    this.wsHolder = opts.wsHolder;
    this.emitRepo = opts.emitRepo;
    this.repoDescriber = opts.repoDescriber;
    this.repoWatcher = opts.repoWatcher;
    this.repoWatchDebounceMs = opts.repoWatchDebounceMs;
    this.commitDescriber = opts.commitDescriber;
    this.workingDiffDescriber = opts.workingDiffDescriber;
    this.logDescriber = opts.logDescriber;
    this.branchesDescriber = opts.branchesDescriber;
  }

  get repo(): RepoContextSnapshot | null {
    return this._repo;
  }

  /** Probe the workspace's repository and emit the answer (ADR 0058). One
   *  probe at a time: a request during one is remembered and runs once
   *  after it, so a burst of triggers (focus flicker, a turn ending as the
   *  user tabs back) costs one extra probe, not one per trigger. The probe
   *  never throws (its own contract); a throw here still lands as null. */
  async refreshRepo(): Promise<void> {
    if (this.repoClosed) return;
    if (this.repoProbeInFlight) {
      this.repoProbeAgain = true;
      return;
    }
    this.repoProbeInFlight = true;
    try {
      do {
        this.repoProbeAgain = false;
        const workspace = this.wsHolder.current;
        let outcome: RepoContextOutcome;
        try {
          outcome = await this.repoDescriber(workspace);
        } catch {
          outcome = { kind: "transient", reason: "aborted" };
        }
        if (this.repoClosed) return;
        if (outcome.kind === "transient") {
          // A probe that could not answer (a `git status` past its budget
          // during the rebase the user is watching, a lock, an interrupt)
          // says nothing about the repository: the card and the watcher
          // stand, and the next change or focus probes again (§7.6). With
          // nothing on screen and no watcher to re-probe, try once more.
          if (
            this._repo === null &&
            this.repoWatchedDir === null &&
            !this.repoRetried
          ) {
            this.repoRetried = true;
            this.repoRetryTimer = setTimeout(() => {
              this.repoRetryTimer = null;
              void this.refreshRepo();
            }, this.repoWatchDebounceMs * REPO_WATCH_MAX_WAIT_SPANS);
            this.repoRetryTimer.unref?.();
          }
          continue;
        }
        this.repoRetried = false;
        const repo = outcome.kind === "repo" ? outcome.repo : null;
        this._repo = repo;
        this.syncRepoWatch(repo?.gitDir ?? null);
        this.emitRepo({ kind: "repo", workspace, repo });
      } while (this.repoProbeAgain);
    } finally {
      this.repoProbeInFlight = false;
    }
  }

  /** Keep exactly one watcher, on the git dir the latest answer names. */
  private syncRepoWatch(gitDir: string | null): void {
    if (gitDir === this.repoWatchedDir) return;
    this.stopRepoWatch?.();
    this.stopRepoWatch = null;
    this.repoWatchedDir = gitDir;
    if (gitDir === null || this.repoClosed) return;
    this.stopRepoWatch = this.repoWatcher(gitDir, (gone) =>
      this.onRepoChanged(gone === true),
    );
  }

  /** A git-dir change: one probe after the burst settles — or at latest a
   *  few debounce spans after the burst began, so events that never pause
   *  (a long checkout, a rebase) still reach the card. `gone`: the
   *  watcher closed itself because its dir vanished (repo-watch.ts); probe
   *  now, and forget it so the next answer re-arms one even under the
   *  same path. */
  private onRepoChanged(gone = false): void {
    if (this.repoClosed) return;
    if (gone) {
      this.stopRepoWatch = null;
      this.repoWatchedDir = null;
    }
    if (this.repoWatchTimer !== null) clearTimeout(this.repoWatchTimer);
    const now = Date.now();
    if (this.repoWatchSince === null) this.repoWatchSince = now;
    const overdue =
      now - this.repoWatchSince >=
      this.repoWatchDebounceMs * REPO_WATCH_MAX_WAIT_SPANS;
    const probe = (): void => {
      this.repoWatchTimer = null;
      this.repoWatchSince = null;
      void this.refreshRepo();
    };
    if (gone || overdue) {
      probe();
      return;
    }
    this.repoWatchTimer = setTimeout(probe, this.repoWatchDebounceMs);
    this.repoWatchTimer.unref?.();
  }

  /** The watcher's teardown, and the end of probing: nothing runs git for
   *  a session that is closing. */
  stopRepoTracking(): void {
    this.repoClosed = true;
    if (this.repoWatchTimer !== null) {
      clearTimeout(this.repoWatchTimer);
      this.repoWatchTimer = null;
    }
    if (this.repoRetryTimer !== null) {
      clearTimeout(this.repoRetryTimer);
      this.repoRetryTimer = null;
    }
    this.syncRepoWatch(null);
  }

  /** One commit, read from the workspace's repository for the viewer's
   *  commit tab (ADR 0059). Null for anything git cannot show. */
  describeCommit(
    ref: string,
  ): Promise<CommitDescription | null | GitReadTimeout> {
    return this.commitDescriber(this.wsHolder.current, ref);
  }

  /** One workspace-relative path's working-tree change against HEAD, for
   *  the viewer's diff tab (ADR 0059 §5). The caller jails the path. */
  describeWorkingDiff(
    path: string,
  ): Promise<WorkingDiff | null | GitReadTimeout> {
    return this.workingDiffDescriber(this.wsHolder.current, path);
  }

  /** A page of the workspace repository's history (ADR 0059 §6). */
  describeLog(opts: LogQuery): Promise<LogPage | null | GitReadTimeout> {
    return this.logDescriber(this.wsHolder.current, opts);
  }

  /** The workspace repository's branches (ADR 0059 §6) — read-only. */
  describeBranches(): Promise<BranchList | null | GitReadTimeout> {
    return this.branchesDescriber(this.wsHolder.current);
  }
}
