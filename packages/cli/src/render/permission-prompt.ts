import type { Readable } from "node:stream";
import {
  type AskResolver,
  abortError,
  type CommandConsequence,
  type PermissionRequest,
} from "@herta/core";
import type { Style } from "./style.js";

/** One-line consequence copy (ADR 0049 §5) — the CLI prompt's register is
 *  terse machine-English (`risk: workspace_destructive`), so the note stays
 *  in it too. Display-only; the tier already enforced. */
const CONSEQUENCE_NOTE: Record<CommandConsequence, string> = {
  discards_uncommitted: "discards uncommitted changes (unrecoverable)",
  deletes_untracked: "deletes untracked files (unrecoverable)",
  deletes_stash: "deletes stashed work (unrecoverable)",
  rewrites_local_history: "rewrites local commit history",
  rewrites_remote_history: "overwrites the remote branch's history",
  concludes_in_progress_operation:
    "a merge/rebase is mid-flight — this step concludes it",
};

type StdinLike = Readable & {
  setRawMode?: (mode: boolean) => unknown;
  isTTY?: boolean;
};

export type CliPromptOutcome =
  | "allow"
  | "allow_remember"
  | "allow_project"
  | "deny";

export interface PresentDetailedOptions {
  showRemember: boolean;
  /** Display form of the project rule a [p] choice would persist (ADR 0030).
   *  Absent → the [p] option is neither shown nor accepted — never offer a
   *  choice that would silently no-op (the showRemember contract). */
  projectRule?: string;
}

export class CliAskResolver implements AskResolver {
  constructor(
    private readonly stdin: StdinLike,
    private readonly stdout: NodeJS.WritableStream,
    private readonly style: Style,
  ) {}

  async present(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<"allow" | "deny"> {
    const outcome = await this.presentDetailed(request, signal, {
      showRemember: false,
    });
    return outcome === "deny" ? "deny" : "allow";
  }

  async presentDetailed(
    request: PermissionRequest,
    signal: AbortSignal,
    opts: PresentDetailedOptions,
  ): Promise<CliPromptOutcome> {
    // Yield to the event loop so the backend-bridge's drain task gets
    // a chance to flush any events that were enqueued just before the
    // permission engine called us (typically the `patch.preview` event
    // from the same tool run). Without this yield the resolver writes
    // its prompt synchronously WHILE patch.preview / tool.call.started
    // events sit on the bus queue, and they only render AFTER the
    // prompt is on screen — leaving the user looking at `[y/a/N]`
    // before they've seen the diff they're being asked to approve.
    //
    // Two `setImmediate` ticks are deliberate: the drain itself uses
    // `setImmediate` to yield, so we need one tick for the drain to
    // wake AND one more for it to settle after processing the queue.
    // N3 fix (2026-05-23).
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.renderBlock(request, opts);
    return this.readSingleKey(signal, opts);
  }

  private renderBlock(
    request: PermissionRequest,
    opts: PresentDetailedOptions,
  ): void {
    // The diff itself is rendered earlier via the `patch.preview` bus
    // event (TranscriptRenderer.renderPatchPreview). Don't re-render it
    // here — the user has already seen it. The permission prompt just
    // surfaces the decision: which risk class, which files, allow or deny.
    //
    // Defensive leading newline: even with the drain-yield above, any
    // other writer that's mid-line right when we get here (e.g. a
    // slow-streamed Herta token finishing) could leave the cursor
    // away from col 0. A leading `\n` guarantees the prompt starts
    // on a fresh line. The cost is at most one blank line in the
    // rendered transcript — cheap compared to the prompt landing
    // inline with prior output (N3 fix, 2026-05-23).
    this.stdout.write("\n");
    this.stdout.write(this.style.dim(`  risk: ${request.risk}\n`));
    if (request.consequence !== undefined) {
      this.stdout.write(
        this.style.dim(`  note: ${CONSEQUENCE_NOTE[request.consequence]}\n`),
      );
    }
    // The minimal contract's `bash` (ADR 0040): the record's Running row shows
    // the header form (cd-prefix dropped, first line); the whole command is
    // what is being approved, so print it here — bounded, like the GUI's
    // console well.
    if (request.call.tool === "bash") {
      const input = request.call.input;
      const command =
        typeof input === "object" && input !== null
          ? (input as { command?: unknown }).command
          : undefined;
      if (typeof command === "string" && command.trim().length > 0) {
        const lines = command.trimEnd().split(/\r?\n/);
        const shown = lines.slice(0, 12);
        this.stdout.write(this.style.dim("  command:\n"));
        for (const line of shown) {
          this.stdout.write(this.style.dim(`    ${line}\n`));
        }
        if (lines.length > shown.length) {
          this.stdout.write(
            this.style.dim(
              `    … ${lines.length - shown.length} more line(s)\n`,
            ),
          );
        }
      }
    }
    if (request.files && request.files.length > 0) {
      this.stdout.write(
        this.style.dim(`  files: ${request.files.join(", ")}\n`),
      );
    }
    if (opts.projectRule !== undefined) {
      // Spell out the exact grant before offering [p] (ADR 0030) — same
      // inspect-before-commit contract as the GUI's dim rule caption.
      this.stdout.write(
        this.style.dim(
          `  [p] remembers in this project: ${opts.projectRule}\n`,
        ),
      );
    }
    const keys = `y${opts.showRemember ? "/a" : ""}${
      opts.projectRule !== undefined ? "/p" : ""
    }/N`;
    this.stdout.write(`  ${this.style.bold(`[${keys}]`)} `);
  }

  private readSingleKey(
    signal: AbortSignal,
    opts: PresentDetailedOptions,
  ): Promise<CliPromptOutcome> {
    return new Promise<CliPromptOutcome>((resolve, reject) => {
      const stdin = this.stdin;
      let settled = false;

      const settle = (decision: CliPromptOutcome, echo: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.stdout.write(`${echo}\n`);
        resolve(decision);
      };

      const onData = (chunk: Buffer | string): void => {
        const ch =
          (typeof chunk === "string" ? chunk : chunk.toString("utf8"))[0] ?? "";
        if (ch === "y" || ch === "Y") {
          settle("allow", "y");
        } else if (opts.showRemember && (ch === "a" || ch === "A")) {
          settle("allow_remember", "a");
        } else if (
          opts.projectRule !== undefined &&
          (ch === "p" || ch === "P")
        ) {
          settle("allow_project", "p");
        } else {
          settle("deny", "n");
        }
      };

      // An interrupt is an ABORT, not a decision. This used to settle("deny"),
      // which fabricated a user denial: the loop emitted permission.resolved
      // {deny} plus a "User denied <tool>" tool result that entered the
      // report's residualRisks and the next dispatch's working history
      // (audit 2026-07-10, finding 4 — the ADR-0010 poisoned-history class).
      // Rejecting with an AbortError still settles the promise (no hang) and
      // the turn loop rethrows it into turn.failed{interrupted} — no
      // permission.resolved, no fabricated tool result. Constructed (core's
      // abortError, not signal.reason) so isAbortError always classifies it.
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.stdout.write("\n");
        reject(abortError("permission gate aborted by interrupt"));
      };

      const cleanup = (): void => {
        stdin.off("data", onData);
        signal.removeEventListener("abort", onAbort);
        if (stdin.setRawMode && stdin.isTTY) stdin.setRawMode(false);
        stdin.pause();
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
      if (stdin.setRawMode && stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.once("data", onData);
    });
  }
}
