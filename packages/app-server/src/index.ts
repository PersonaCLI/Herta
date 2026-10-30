// @herta/app-server — surface-agnostic session API over the v0.2 runtime.
//
// See:
//   docs/superpowers/specs/2026-05-27-v0.3-slice-2-app-server-design.md
//   docs/superpowers/plans/2026-05-27-v0.3-slice-2-app-server.md
//
// Public surface:
//   - createSessionHost(config: AppServerConfig): SessionHost
//   - defaultDirsFor(opts): DefaultDirs (convenience for callers)
//   - All public types
//
// Re-export ApprovalOverlayState + the session record types from
// @herta/core so surface consumers (e.g. the GUI renderer) can pull the
// overlay vocabulary and record shapes from the app-server boundary
// instead of reaching into @herta/core directly. `types.ts` only
// *imports* TerminalRecord / TerminalRecordBlock / AgentEvent for its own
// declarations, so `export type * from "./types.js"` does NOT surface
// them — they must be re-exported explicitly here.
export type {
  AgentEvent,
  ApprovalOverlayState,
  RepoContextDirtyFile,
  RepoContextSnapshot,
  RepoInProgressState,
  RepoRecentCommit,
  SessionTopic,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
// The viewer's commit tab (ADR 0059) reads these through the same boundary.
export type {
  BranchEntry,
  BranchList,
  CommitDescription,
  CommitFileChange,
  CommitFileStatus,
  LogEntry,
  LogPage,
  LogQuery,
  WorkingDiff,
} from "@herta/tools";
// The attachment ingest (ADR 0033) is deliberately NOT re-exported here: it is
// called only by SessionImpl inside this package, and `_public-api.test.ts`
// pins this barrel to the symbols consumers actually need. Its own tests
// import it by relative path.
export type { DefaultDirs, DefaultDirsOpts } from "./config-helpers.js";
export { defaultDirsFor } from "./config-helpers.js";
// Flow (ADR 0084): the desktop's main owns one FlowService, reads its
// settings section through the normalizer, and hands the renderer the
// issue and status shapes. Its store, trigger and pipeline stay internal.
export {
  DEFAULT_FLOW_SETTINGS,
  normalizeFlowSettings,
} from "./flow/flow-interests.js";
export type { FlowWord } from "./flow/flow-pipeline.js";
export { FlowService, type FlowServiceOptions } from "./flow/flow-service.js";
export type {
  FlowRefreshResult,
  FlowTickResult,
} from "./flow/flow-trigger.js";
export type * from "./flow/flow-types.js";
export type { RecordTail } from "./record-window.js";
export { RECORD_TAIL_BLOCKS, recordTail } from "./record-window.js";
// The quit hold's floor (ADR 0071 §1.7).
export { CLOSE_SETTLE_CAP_MS } from "./session.js";
export { createSessionHost } from "./session-host.js";
export type { SessionSearchHit } from "./session-search.js";
export type * from "./types.js";
