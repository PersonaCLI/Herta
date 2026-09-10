import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { writeFileAtomicSync } from "@herta/core";
import { nextFeianIndex } from "./feian-format.js";

/** D4 guard: throws unless `target` resolves to a path inside `root`. */
export function assertUnderDreamRoot(target: string, root: string): void {
  const r = resolve(root);
  const t = resolve(target);
  if (t !== r && !t.startsWith(r + sep)) {
    throw new Error(`dream: refusing to write outside ${r}: ${t}`);
  }
}

export interface PromoteInput {
  narrativeDir: string;
  dreamDir: string;
  title: string;
  /** The validated 废案 body. Its header is rewritten to the assigned NN. */
  feianBody: string;
  runId: string;
  /** Pre-assigned index. When omitted, the next free index is scanned from the
   *  narrative dir. The reconsolidation junction assigns it BEFORE archiving
   *  OLD so the merged file can never reuse OLD's number. */
  nn?: number;
}

export interface PromoteResult {
  nn: number;
  file: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function promoteCandidate(input: PromoteInput): PromoteResult {
  mkdirSync(input.narrativeDir, { recursive: true });
  const nn = input.nn ?? nextFeianIndex(readdirSync(input.narrativeDir));
  // Fix 2: sanitize filename chars that would break paths, but keep the
  // original title in the internal line-1 header.
  const safeTitle = input.title.replace(/[/\\:*?"<>|]/g, "_");
  const file = `### 废案_${pad(nn)}：${safeTitle}.txt`;
  // Rewrite the internal line-1 header to the assigned NN (Dream always emits
  // the numbered form). Replace only the first header line (uses original title).
  const body = input.feianBody.replace(
    /^### 废案(?:_\d+)?：.*$/m,
    `### 废案_${pad(nn)}：${input.title}`,
  );
  // Fix 1 (D4 guard): target path must be inside narrativeDir. The atomic
  // write's temp sits beside the target, so it is inside too.
  const target = join(input.narrativeDir, file);
  assertUnderDreamRoot(target, input.narrativeDir);
  writeFileAtomicSync(target, body);
  return { nn, file };
}

export interface ArchiveInput {
  narrativeDir: string;
  dreamDir: string;
  file: string;
  reason: string;
}

export function archiveLiveRecord(input: ArchiveInput): void {
  const archiveDir = join(input.dreamDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  // Fix 1 (D4 guard): archive target must be inside dreamDir.
  assertUnderDreamRoot(join(archiveDir, input.file), input.dreamDir);
  renameSync(
    join(input.narrativeDir, input.file),
    join(archiveDir, input.file),
  );
}
