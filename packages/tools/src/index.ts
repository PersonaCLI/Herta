import type {
  AgentEvent,
  EventBus,
  HertaTool,
  RulePermissionEngine,
  WebClient,
} from "@herta/core";
import { bashTool, registerBashRule, shellPathsFor } from "./bash/index.js";
import {
  type DigestModel,
  digestDocumentTool,
} from "./digest-document/index.js";
import { memorySaveTool } from "./memory-save/index.js";
import { reportFindingTool } from "./report-finding/index.js";
import { showExcerptTool } from "./show-excerpt/index.js";
import {
  registerStrReplaceEditorRule,
  strReplaceEditorTool,
} from "./str-replace-editor/index.js";
import { viewImageTool } from "./view-image/index.js";
import { webTools } from "./web/index.js";

// A command's result as the record and the report read it. `bash` returns it.
export type { RunCommandData } from "@herta/core";
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
export {
  BROWSER_STORE_DIR,
  type BrowserActData,
  type BrowserNavigateData,
  type BrowserReadData,
  type BrowserScreenshotData,
  browserActTool,
  browserNavigateTool,
  browserReadTool,
  browserScreenshotTool,
  createBrowserTools,
  MAX_SCREENSHOTS,
  pageRoute,
  registerBrowserRules,
} from "./browser/index.js";
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
// The launcher (ADR 0083 §5): herta.launch.json, the session's dev servers,
// and dev_server.
export {
  entryCommand,
  entryUrl,
  LAUNCH_FILE,
  type LaunchFileResult,
  readLaunchFile,
} from "./launcher/launch-file.js";
export {
  Launcher,
  type LauncherOptions,
  portAnswers,
  READY_TIMEOUT_MS,
  SERVER_LOG_DIR,
} from "./launcher/launcher.js";
export {
  createDevServer,
  type DevServerData,
  registerDevServer,
} from "./launcher/tool.js";
export type { MemorySaveData } from "./memory-save/index.js";
export { memorySaveTool } from "./memory-save/index.js";
export type { MemorySaveInput } from "./memory-save/schema.js";
// Exported so the attachment ingest (ADR 0033) can assert end-to-end that
// whatever it writes is reachable through the carve-out and refused without
// it — the two halves living in different packages is exactly why that needs
// a test rather than a shared assumption.
export type { ResolveSafePathOpts, SafePathResult } from "./path-safety.js";
export {
  harnessHomeWriteDenial,
  hertaStateWriteDenial,
  holdsHarnessHome,
  namesHertaState,
  patternReachesHarnessHome,
  resolveSafePath,
} from "./path-safety.js";
export {
  killProcesses,
  listProcesses,
  type ProcessRow,
  processTree,
  SAME_PROCESS_WINDOW_MS,
  sameProcessStart,
} from "./process-reap.js";
export {
  findingClaimLanguageLine,
  MAX_FINDING_CITES,
  MAX_FINDING_CLAIM_CHARS,
  type ReportFindingData,
  type ReportFindingInput,
  type ReportFindingToolOpts,
  reportFindingTool,
} from "./report-finding/index.js";
// Exported for the attachment ingest (ADR 0033, 2026-08-10): a command's
// output already redacts, and an uploaded document is the same class of
// untrusted text reaching the record and a provider — one definition of
// "secret-shaped", or none.
export { redactSecrets } from "./run-command/redactor.js";
// ADR 0075's reviewer: the risk a command carries whatever the model says.
export {
  bodyUnreadable,
  maxReviewRisk,
  type ReviewFloor,
  type ReviewRisk,
  reviewRiskFloor,
} from "./run-command/review-floor.js";
// The argv rule (ADR 0086): the `run_command` tool is gone, and its rule is
// what classifies a dev server's argv before it starts (ADR 0083 §5).
export { makeRunCommandRule } from "./run-command/rule.js";
export type { RunCommandInput } from "./run-command/schema.js";
// A kill aimed at the app itself is blocked (2026-11-04); the desktop's main
// hands over Electron's other processes.
export { registerHostHelperPids } from "./run-command/self-kill.js";
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
export {
  checkFetchUrl,
  isLocalHost,
  MAX_FETCH_URL_CHARS,
  PAGE_HEAD_CHARS,
  registerWebRules,
  WEB_PAGE_DIR,
  type WebFetchData,
  type WebFetchInput,
  type WebSearchData,
  type WebSearchInput,
  webFetchTool,
  webPageFileName,
  webSearchTool,
  webTools,
} from "./web/index.js";
export {
  fetchPreviewImage,
  type PreviewImage,
  type PreviewRefusal,
  previewImageUrl,
  publicAddress,
} from "./web/preview-image.js";

/** The document-digest seam (ADR 0043): the side model and the summary
 *  language. `model: null` mounts the tool in its
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
   * The web seam (ADR 0080). Mounts `web_search` and `web_fetch` when
   * given; absent or null leaves them out. The wiring passes
   * one whenever the session has a DeepSeek key (§4).
   */
  readonly webClient?: WebClient | null;
}

/**
 * The digest tool as a stack mounts it later (ADR 0067): the same path
 * mapping the other record channels use, the shell's spelling. With no bash
 * (a test that builds the tool alone) paths are taken as they are.
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

/**
 * `view_image` as a stack mounts it later (ADR 0081): when the backend model
 * switches to one that reads images. The same path mapping as the digest
 * tool's.
 */
export function viewImageToolFor(opts: {
  readonly bashPath: string | null;
}): HertaTool {
  if (opts.bashPath === null) return viewImageTool();
  const paths = shellPathsFor(opts.bashPath);
  return viewImageTool({
    mapPath: (p: string): string => paths.toNative(p) ?? p,
  });
}

export interface MinimalToolsOpts extends DigestToolsOpts {
  /** From `findBash()`; the set cannot run without one (ADR 0086). */
  bashPath: string;
  /** How the shell spells the workspace (schema example paths). Getter —
   *  the workspace can change between dispatches. */
  workspaceShellPath: () => string;
}

/**
 * 板砖's tool set, the only one (ADR 0040, ADR 0086; "minimal" is the name it
 * had beside the standard set, and the name a run's journal still records):
 * the trained shape's two tools
 * plus the record channels a shell cannot replace — `report_finding`
 * (conclusions reach the record and the report; the model's final prose
 * reaches nobody, D6), `show_excerpt` (lines the user asked to SEE; a
 * `view` is silent to the record), and `digest_document`
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
    // Project memory (ADR 0077): ADR 0060's recall had nothing to read on
    // a default install until this was mounted here.
    memorySaveTool(),
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
    // The web (ADR 0080): search and page fetch through the provider.
    ...(opts.webClient != null ? webTools(opts.webClient) : []),
  ];
}

/** Permission rules for `createMinimalTools`. */
export function registerMinimalRules(
  engine: RulePermissionEngine,
  deps: { bus?: EventBus<AgentEvent>; bashPath: string | null },
): void {
  registerBashRule(engine, deps);
  registerStrReplaceEditorRule(engine, deps);
}

// The lore tools (lore_search / lore_open / lore_neighbors) were removed
// 2026-07-06: no runtime ever registered them, and the packaged app
// deliberately ships without the knowledge DB they query. If canon search
// ever becomes a real feature, restore them from git history as a
// power-user, bring-your-own-DB tool set — the DB stays non-redistributable
// either way.
//
// The standard tool set (read_file, search_text, glob, edit_file,
// write_new_file, run_command with its background pair, git_status,
// git_diff, and `createMvpTools`) was deleted in ADR 0086. What the bash set
// stands on stayed: `edit-file/engine.ts`, and from `run-command/` the
// classifier, the argv rule, the redactor, the runner and the guards.
export {
  ConsoleDecoder,
  consoleLegacyEncoding,
  decodeConsoleOutput,
  primeConsoleEncoding,
} from "./console-decode.js";
