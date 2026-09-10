export {
  type ActorHints,
  DEFAULT_ACTOR_HINTS,
  defaultActorHintsFor,
  loadActorHints,
  SUPERVISOR_VETO_TEMPLATE,
  selectBeatHint,
} from "./narrative/actor-hints.js";
export {
  type ActorPrompt,
  type StaticHertaPrefix,
  serializeActorPrompt,
} from "./narrative/actor-prompt.js";
export {
  type ActorTurnDeps,
  type ActorTurnState,
  runActorCompletionTurn,
} from "./narrative/actor-turn.js";
export {
  type BanzhuanBridgeDeps,
  type BeatFirer,
  invokeBanzhuanBridge,
} from "./narrative/backend-bridge.js";
export {
  projectBackendEvent,
  sanitizeSystemBlock,
} from "./narrative/backend-record-projection.js";
export {
  BeatPolicy,
  type BeatPolicyOpts,
  classifyBeatTrigger,
  type TriggerSpec,
  workflowKindForBeat,
} from "./narrative/beat-policy.js";
export {
  type BuildRecapRuntimeOpts,
  buildRecapRuntime,
} from "./narrative/build-recap-runtime.js";
export {
  buildCompactionBody,
  type CompactOptions,
  compactRecordForPrompt,
  digestSystemBlock,
} from "./narrative/compact-record.js";
export { COMPACTION_TEXT } from "./narrative/compaction-text.js";
export {
  collapseLongDiffs,
  resolveDiffPromptMaxLines,
} from "./narrative/diff-collapse.js";
export {
  escapeUserText,
  FORBIDDEN_USER_PATTERNS,
} from "./narrative/escape.js";
export {
  type ClassifyIntentInput,
  type ClassifyIntentResult,
  classifyIntent,
  lastNSpeechTurns,
  lastNTurnsForSupervisor,
} from "./narrative/intent-router.js";
export {
  type AttachedMetaThink,
  buildMetaThinkSection,
  loadMetaThinkCorpus,
  type MetaThinkCorpus,
  MOOD_DESCRIPTIONS,
  MOOD_STATES,
  type MoodState,
  resolveMetaThink,
} from "./narrative/meta-think.js";
export {
  extractBand,
  type OpeningChoice,
  type PickOpeningOpts,
  parseOpeningFile,
  pickOpening,
  type TimeBand,
  timeBandsAt,
} from "./narrative/opening-picker.js";
export {
  neutralizeBanzhuanTrigger,
  type ParsedHertaBlock,
  parseHertaBlock,
  stripBanzhuanTrigger,
} from "./narrative/parse.js";
export {
  PROMPT_ASSETS,
  PROMPT_ASSETS_EN,
  type PromptAssets,
} from "./narrative/prompt-assets.generated.js";
export { promptAssetsFor } from "./narrative/prompt-assets.js";
export type { PromptLang } from "./narrative/prompt-lang.js";
export {
  deleteRecapCache,
  readRecapCache,
  writeRecapCache,
} from "./narrative/recap-cache.js";
export {
  createRevealDriver,
  type RevealDriver,
  type RevealDriverDeps,
} from "./narrative/reveal-driver.js";
export { materializeSeedFeian } from "./narrative/seed-feian.js";
export {
  serializeBlock,
  serializeTerminalRecord,
} from "./narrative/serialize.js";
export {
  type CompactionConfig,
  DEFAULT_COMPACTION_CONFIG,
  type RecapCache,
} from "./narrative/session-recap.js";
export {
  makeRecapSummarize,
  type PreparedRecap,
  prepareTurnRecap,
  type RecapRuntime,
} from "./narrative/session-recap-runtime.js";
export {
  buildTitlePrompt,
  generateSessionTitle,
  sanitizeTitle,
} from "./narrative/session-title.js";
export {
  DEFAULT_MAX_REVEAL_MS,
  EN_CLAUSE_PUNCT,
  EN_EFFECTIVE_MS_PER_CHAR,
  EN_SENTENCE_PUNCT,
  EN_WORD_BASE_MS,
  EN_WORD_LEAD_MS,
  EN_WORD_PER_CHAR_MS,
  type FenceRegion,
  fenceRegions,
  HOLD_AT,
  HOLD_MIN_FRACTION,
  holdIndexFor,
  humanizedCharDelay,
  isCjkPacingChar,
  JITTER_RATIO,
  MAX_STARTUP_MS,
  NEWLINE_PAUSE_RATIO,
  nextRevealEnd,
  PAUSE_PUNCTUATION,
  type PacingDecision,
  type PacingMode,
  PUNCTUATION_PAUSE_RATIO,
  pacingDecision,
  RAMP_MAX_MULTIPLIER,
  RAMP_START,
  resolveMaxRevealMs,
  revealUnitDelay,
  spanMatchedBaseMs,
  startupDelayMs,
  TARGET_VISIBLE_MS,
} from "./narrative/slow-stream-pacing.js";
export {
  buildStaticHertaPrefix,
  type StaticPrefixDeps,
} from "./narrative/static-prefix.js";
export type {
  ActorStreamingSink,
  LiveSlowStreamController,
  SlowStreamController,
} from "./narrative/streaming-sink.js";
export {
  buildMissingDispatchPrompt,
  buildSupervisorPrompt,
  isTriggerRelatedFinding,
  judgeMissingDispatch,
  parseSupervisorVerdict,
  SUPERVISOR_ENABLED_MARKER,
  type SupervisorCheckInput,
  type SupervisorCheckResult,
  type SupervisorFinding,
  supervisorReferenceFor,
} from "./narrative/supervisor.js";
export { buildSupervisorVetoHint } from "./narrative/thought-hint.js";
export {
  V2ActorDriver,
  type V2ActorDriverDeps,
} from "./narrative/v2-actor-driver.js";
