import type {
  AgentEvent,
  EventBus,
  HertaTool,
  RulePermissionEngine,
} from "@herta/core";
import { bashTool, registerBashRule, shellPathsFor } from "./bash/index.js";
import {
  type DigestModel,
  digestDocumentTool,
} from "./digest-document/index.js";
import { editFileTool } from "./edit-file/index.js";
import { gitDiffTool } from "./git-diff/index.js";
import { gitStatusTool } from "./git-status/index.js";
import { globTool } from "./glob/index.js";
import { memorySaveTool } from "./memory-save/index.js";
import { readFileTool } from "./read-file/index.js";
import { reportFindingTool } from "./report-finding/index.js";
import {
  commandOutputTool,
  commandStopTool,
  runCommandTool,
} from "./run-command/index.js";
import { searchTextTool } from "./search-text/index.js";
import { showExcerptTool } from "./show-excerpt/index.js";
import {
  registerStrReplaceEditorRule,
  strReplaceEditorTool,
} from "./str-replace-editor/index.js";
import { viewImageTool } from "./view-image/index.js";
import { writeNewFileTool } from "./write-new-file/index.js";

export {
  BASH_DESCRIPTION,
  BASH_TIMEOUT_MS,
  type BashToolOpts,
  bashTool,
  classifyShellCommand,
  classifyShellCommandDetailed,
  findBash,
  makeBashRule,
  makeMsysPaths,
  PersistentShell,
  primeShellPaths,
  registerBashRule,
  SHELL_BG_ID,
  type ShellPaths,
  type ShellRunResult,
  shellPathsFor,
  shellWorkspaceHint,
  stripShellComments,
} from "./bash/index.js";
export {
  listMsysProcesses,
  type MsysGroup,
  type MsysRow,
  msysGroupWinpids,
} from "./bash/msys-processes.js";
export type { BashInput } from "./bash/schema.js";
// Exported for the attachment ingest (ADR 0033): the denylist must apply to
// the SOURCE file at the door, because safeStoredName's hash suffix means the
// stored name (`id_rsa-ab12cd34`) no longer matches the basename rules — a
// deny that only ran on the stored side would be a bypass, not a guard.
export {
  isCredentialBasename,
  isSensitiveSegment,
} from "./credential-denylist.js";
export {
  chunkDocument,
  DIGEST_CHUNK_CHARS,
  type DocumentChunk,
} from "./digest-document/chunker.js";
export {
  DIGEST_CONCURRENCY,
  type DigestDocumentData,
  type DigestDocumentToolOpts,
  type DigestModel,
  digestDocumentTool,
  digestSidecarFor,
  isDigestSidecar,
  MAX_DIGEST_CHUNKS,
} from "./digest-document/index.js";
export type { EditFileData, EditFileRuleDeps } from "./edit-file/index.js";
export {
  editFileTool,
  makeEditFileRule,
  registerEditFileRule,
} from "./edit-file/index.js";
export type { EditFileInput } from "./edit-file/schema.js";
export type { ToolErrorCode } from "./errors.js";
export { TOOL_ERROR_CODES } from "./errors.js";
export type {
  CommitDescription,
  CommitFileChange,
  CommitFileStatus,
  GitReadOptions,
} from "./git/commit-show.js";
export {
  describeCommit,
  MAX_COMMIT_FILES,
  MAX_COMMIT_PATCH_BYTES,
} from "./git/commit-show.js";
export type {
  BranchEntry,
  BranchList,
  LogEntry,
  LogPage,
  LogQuery,
} from "./git/log-list.js";
export {
  describeBranches,
  describeLog,
  isSafeRefName,
  LOG_PAGE_SIZE,
  MAX_BRANCHES,
  MAX_LOG_LIMIT,
  MAX_LOG_QUERY_CHARS,
} from "./git/log-list.js";
export type {
  RangeChangedFile,
  RepoContextOutcome,
  RepoProbeTransientReason,
} from "./git/repo-probe.js";
export {
  classifyProbeFailure,
  describeRepoContext,
  describeRepoOutcome,
  detectInProgressState,
  diffCommittedRange,
  probeRepoState,
  resolveGitDir,
} from "./git/repo-probe.js";
export type { GitReadTimeout } from "./git/spawn-git.js";
export { GIT_READ_TIMEOUT, isGitReadTimeout } from "./git/spawn-git.js";
export type { WorkingDiff } from "./git/working-diff.js";
export {
  describeWorkingDiff,
  MAX_WORKING_DIFF_BYTES,
} from "./git/working-diff.js";
export type { GitDiffData, GitDiffFile } from "./git-diff/index.js";
export { gitDiffTool } from "./git-diff/index.js";
export type { GitDiffInput } from "./git-diff/schema.js";
export type { GitStatusData, GitStatusFile } from "./git-status/index.js";
export { gitStatusTool } from "./git-status/index.js";
export type { GitStatusInput } from "./git-status/schema.js";
export { globToRegExp } from "./glob/glob-to-regex.js";
export type { GlobData, GlobFileEntry } from "./glob/index.js";
export { globTool } from "./glob/index.js";
export type { GlobInput } from "./glob/schema.js";
export type { MemorySaveData } from "./memory-save/index.js";
export { memorySaveTool } from "./memory-save/index.js";
export type { MemorySaveInput } from "./memory-save/schema.js";
// Exported so the attachment ingest (ADR 0033) can assert end-to-end that
// whatever it writes is reachable through the carve-out and refused without
// it — the two halves living in different packages is exactly why that needs
// a test rather than a shared assumption.
export type { ResolveSafePathOpts, SafePathResult } from "./path-safety.js";
export { resolveSafePath } from "./path-safety.js";
export {
  killProcesses,
  listProcesses,
  type ProcessRow,
  processTree,
  SAME_PROCESS_WINDOW_MS,
  sameProcessStart,
} from "./process-reap.js";
export type { ReadFileData } from "./read-file/index.js";
export { readFileTool } from "./read-file/index.js";
export type { ReadFileInput } from "./read-file/schema.js";
export {
  findingClaimLanguageLine,
  MAX_FINDING_CITES,
  MAX_FINDING_CLAIM_CHARS,
  type ReportFindingData,
  type ReportFindingInput,
  type ReportFindingToolOpts,
  reportFindingTool,
} from "./report-finding/index.js";
export type { RunCommandData } from "./run-command/index.js";
export {
  commandOutputTool,
  commandStopTool,
  makeRunCommandRule,
  registerRunCommandRule,
  runCommandTool,
} from "./run-command/index.js";
// Exported for the attachment ingest (ADR 0033, 2026-08-10): run_command
// output and search_text results already redact, and an uploaded document is
// the same class of untrusted text reaching the record and a provider — one
// definition of "secret-shaped", or none.
export { redactSecrets } from "./run-command/redactor.js";
// ADR 0075's reviewer: the risk a command carries whatever the model says.
export {
  maxReviewRisk,
  type ReviewFloor,
  type ReviewRisk,
  reviewRiskFloor,
} from "./run-command/review-floor.js";
export type { RunCommandInput } from "./run-command/schema.js";
export type { SearchMatch, SearchTextData } from "./search-text/index.js";
export {
  ATTACHMENT_SEARCH_MAX_BYTES,
  isAttachmentSearchRoot,
  isHertaCarveOutSearchRoot,
  searchTextTool,
} from "./search-text/index.js";
export type { SearchTextInput } from "./search-text/schema.js";
export {
  MAX_EXCERPT_CHARS,
  MAX_EXCERPT_LINES,
  showExcerptTool,
} from "./show-excerpt/index.js";
export type { ShowExcerptInput } from "./show-excerpt/schema.js";
export {
  makeStrReplaceEditorRule,
  registerStrReplaceEditorRule,
  type StrReplaceEditorData,
  type StrReplaceEditorToolOpts,
  strReplaceEditorTool,
} from "./str-replace-editor/index.js";
export type { StrReplaceEditorInput } from "./str-replace-editor/schema.js";
export { looksBinary, SNIFF_BYTES } from "./text-sniff.js";
export {
  canonicalWorkspaceRoot,
  validateWorkspaceRoot,
  type WorkspaceRootCheck,
} from "./validate-workspace-root.js";
export type { ViewImageData } from "./view-image/index.js";
export {
  MAX_VIEW_IMAGE_BYTES,
  MAX_VIEW_IMAGES,
  viewImageTool,
} from "./view-image/index.js";
export type { ViewImageInput } from "./view-image/schema.js";
export type {
  WriteNewFileData,
  WriteNewFileRuleDeps,
} from "./write-new-file/index.js";
export {
  makeWriteNewFileRule,
  registerWriteNewFileRule,
  writeNewFileTool,
} from "./write-new-file/index.js";
export type { WriteNewFileInput } from "./write-new-file/schema.js";

/** The document-digest seam both contracts share (ADR 0043): the side model
 *  and the summary language. `model: null` mounts the tool in its
 *  `unavailable` state (no key / tests) rather than leaving it out, so the
 *  model learns the refusal instead of inventing a workaround. */
export interface DigestToolsOpts {
  readonly digestModel: DigestModel | null;
  readonly lang?: "zh" | "en";
  /**
   * Whether the backend MODEL can read an image (ADR 0048 slice 3). Mounts
   * `view_image`.
   *
   * Gated rather than always-on: a model without vision answers 400 to an
   * image part, and a tool the model is told it has but cannot use is worse
   * than no tool — it invites a call that fails, and invites the model to
   * believe it looked. Absent = false, which is every stack today.
   */
  readonly vision?: boolean;
  /**
   * Mount `digest_document` now (ADR 0067). Default true — a lab or a test
   * that builds the set directly keeps the whole set. The app's wiring
   * passes false and mounts the tool through `digestToolFor` once the
   * session actually holds a document: ~280 schema tokens on every call
   * are worth nothing in a session that never attaches one.
   */
  readonly digest?: boolean;
  /**
   * Mount `git_status` / `git_diff` (the standard contract only; the
   * minimal contract's bash runs git itself). Default true. The wiring
   * passes whether the workspace is inside a git repository and refreshes
   * it when the workspace moves (ADR 0067).
   */
  readonly gitTools?: boolean;
}

/**
 * The digest tool as a stack mounts it later (ADR 0067): the same path
 * mapping the contract's other record channels use — the shell's spelling
 * on the minimal contract, identity on the standard one.
 */
export function digestToolFor(
  opts: DigestToolsOpts & { readonly bashPath: string | null },
): HertaTool {
  const paths = shellPathsFor(opts.bashPath);
  return digestDocumentTool({
    model: opts.digestModel,
    ...(opts.bashPath !== null
      ? { mapPath: (p: string): string => paths.toNative(p) ?? p }
      : {}),
    ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
  });
}

export interface MinimalToolsOpts extends DigestToolsOpts {
  /** From `findBash()`; the minimal contract cannot run without one. */
  bashPath: string;
  /** How the shell spells the workspace (schema example paths). Getter —
   *  the workspace can change between dispatches. */
  workspaceShellPath: () => string;
}

/**
 * The minimal contract's tool set (ADR 0040): the trained shape's two tools
 * plus the record channels a shell cannot replace — `report_finding`
 * (conclusions reach the record and the report; the model's final prose
 * reaches nobody, D6), `show_excerpt` (lines the user asked to SEE; a
 * `view` is silent to the record like read_file is), and `digest_document`
 * (ADR 0043: a whole attached document's content in one call — a shell can
 * only read it end to end).
 *
 * `todo_write`, mounted here by ADR 0047 §4, left with the backend's todo
 * list (ADR 0073): the rail's trace card shows what 板砖 is doing from its
 * own op rows, and the newer models this contract tracks plan in their own
 * text rather than through a list tool.
 */
export function createMinimalTools(opts: MinimalToolsOpts): HertaTool[] {
  // The two record channels accept the SHELL's path spelling too — the model
  // cites what `pwd`/`ls` printed (`/e/repo/src/x`, `/tmp/…` on MSYS), which
  // the native resolver would read as root-relative on the current drive
  // (live GUI run 2026-08-17: `show_excerpt … path_outside_workspace:
  // E:\tmp\claude\…`). Native and relative spellings pass through unchanged.
  const paths = shellPathsFor(opts.bashPath);
  const mapPath = (p: string): string => paths.toNative(p) ?? p;
  return [
    bashTool({ bashPath: opts.bashPath }),
    strReplaceEditorTool({
      bashPath: opts.bashPath,
      workspaceShellPath: opts.workspaceShellPath,
    }),
    reportFindingTool({
      mapPath,
      ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
    }),
    showExcerptTool({ mapPath }),
    ...(opts.digest !== false
      ? [
          digestDocumentTool({
            model: opts.digestModel,
            mapPath,
            ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
          }),
        ]
      : []),
    // Only on a vision-capable model (ADR 0048 §5): the caption is one shot
    // and lossy, and a visual question that outruns it deserves a RE-LOOK
    // rather than a longer guess.
    ...(opts.vision === true ? [viewImageTool({ mapPath })] : []),
  ];
}

/** Permission rules for `createMinimalTools` (edit/write rules for the
 *  standard tools stay registered by the caller if it also mounts them). */
export function registerMinimalRules(
  engine: RulePermissionEngine,
  deps: { bus?: EventBus<AgentEvent>; bashPath: string | null },
): void {
  registerBashRule(engine, deps);
  registerStrReplaceEditorRule(engine, deps);
}

export function createMvpTools(
  opts: DigestToolsOpts = { digestModel: null },
): HertaTool[] {
  return [
    readFileTool(),
    // Presentation, not navigation: read_file is silent to the user and to
    // Herta, so "show me what's in that file" needs its own tool (ADR 0027).
    showExcerptTool(),
    // list_files left the set on 2026-09-18 (ADR 0067): glob finds files by
    // name and run_command's `ls`/`dir` lists a directory, the way Claude
    // Code retired its LS tool. ~160 schema tokens per call, every call.
    searchTextTool(),
    globTool(),
    editFileTool(),
    runCommandTool(),
    commandOutputTool(),
    commandStopTool(),
    writeNewFileTool(),
    // Structured git reads — inside a git repository only (ADR 0067): the
    // wiring decides from the workspace and refreshes on a move.
    ...(opts.gitTools !== false ? [gitStatusTool(), gitDiffTool()] : []),
    memorySaveTool(),
    // The backend's channel for CONCLUSIONS (ADR 0039): its final prose has
    // none by design, so an analysis brief needs this or it delivers nothing.
    reportFindingTool(opts.lang !== undefined ? { lang: opts.lang } : {}),
    // A whole attached document's content in one call (ADR 0043) — see
    // DigestToolsOpts.digest for when the wiring mounts it instead.
    ...(opts.digest !== false
      ? [
          digestDocumentTool({
            model: opts.digestModel,
            ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
          }),
        ]
      : []),
    // Vision-capable models only (ADR 0048 §5) — see createMinimalTools.
    ...(opts.vision === true ? [viewImageTool()] : []),
  ];
}

// The lore tools (lore_search / lore_open / lore_neighbors) were removed
// 2026-07-06: no runtime ever registered them (both bootstraps use only
// createMvpTools), and the packaged app deliberately ships without the
// knowledge DB they query. If canon search ever becomes a real feature,
// restore them from git history as a power-user, bring-your-own-DB tool
// set — the DB stays non-redistributable either way.
