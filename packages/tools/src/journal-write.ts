import { createHash } from "node:crypto";
import {
  errorMessage,
  journalUnavailableResult,
  type ToolContext,
  type ToolResult,
} from "@herta/core";

const sha256 = (b: Buffer | string): string =>
  createHash("sha256").update(b).digest("hex");

/**
 * Record a file write BEFORE it happens, in the two places that need it:
 *
 * - the run's journal (ADR 0071 §1.1): the file's hash now and the hash it
 *   will have. A run the app died in is sealed by comparing the file
 *   against both, so the write's outcome is decided rather than guessed.
 *   Fail-closed: a write the journal cannot record is not performed.
 * - the undo store (ADR 0074 §1): the bytes the write replaces (`before`,
 *   null for a file being created), so the user can take the turn's edits
 *   back. After the journal entry — a write the journal refuses never
 *   happens, so it leaves nothing to undo — and best effort: the store
 *   never stops the write.
 *
 * Every writer calls this right before `writeFileAtomic`, handing over the
 * exact bytes it read (`journal-write.test.ts` holds both).
 *
 * Returns null when the write may go ahead; otherwise the refusal to answer
 * INSTEAD of writing.
 */
export async function journalWrite<T>(
  ctx: ToolContext,
  path: string,
  before: Buffer | null,
  afterBytes: Buffer | string,
): Promise<ToolResult<T> | null> {
  const after = sha256(afterBytes);
  if (ctx.journal !== undefined) {
    try {
      await ctx.journal.recordWrite({
        path,
        before: before === null ? null : sha256(before),
        after,
      });
    } catch (err) {
      return journalUnavailableResult(errorMessage(err)) as ToolResult<T>;
    }
  }
  await ctx.undo?.captureWrite({ path, before, after }).catch(() => undefined);
  return null;
}
