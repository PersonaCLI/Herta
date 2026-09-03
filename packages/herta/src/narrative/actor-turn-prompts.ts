// Prompt-side helpers of the actor turn: hint-set resolution, the Slice 10
// single-phase prompt builder and the thought / speech-tag splitter.
// Extracted from actor-turn.ts on 2026-09-03 (owner's request: the file had
// grown to 3,200 lines); bodies and comments are verbatim.

import type { TerminalRecord } from "@herta/core";
import { type ActorHints, defaultActorHintsFor } from "./actor-hints.js";
import { type ActorPrompt, serializeActorPrompt } from "./actor-prompt.js";
import type { ActorTurnDeps } from "./actor-turn-deps.js";
import { stripStopSequence } from "./streaming-sink.js";
import {
  BRANCH_OPEN_TAG,
  FORCED_SPEECH_OPEN_TAG,
  STOP_THOUGHT_CLOSE,
} from "./thought-hint.js";

export function resolveHints(deps: ActorTurnDeps): ActorHints {
  return deps.hints ?? defaultActorHintsFor(deps.lang ?? "zh");
}

/**
 * Construct the Slice 10 single-phase prompt (used when no mood routing
 * is configured, and as a building block for phase 1 of two-phase mode).
 */
export function buildSinglePhasePrompt(opts: {
  deps: ActorTurnDeps;
  record: TerminalRecord;
  priorTurnLength: number;
  forceSpeech: boolean;
  recap?: string;
  recapBoundaryIndex?: number;
}): string {
  const prompt: ActorPrompt = {
    staticPrefix: opts.deps.staticPrefix,
    record: opts.record,
    priorTurnLength: opts.priorTurnLength,
    formatHint: opts.forceSpeech
      ? undefined
      : resolveHints(opts.deps).thoughtHintLine,
    openTag: opts.forceSpeech ? FORCED_SPEECH_OPEN_TAG : BRANCH_OPEN_TAG,
    ...(opts.recap !== undefined ? { recap: opts.recap } : {}),
    recapBoundaryIndex: opts.recapBoundaryIndex ?? 0,
    lang: opts.deps.lang ?? "zh",
  };
  return serializeActorPrompt(prompt);
}

/**
 * Extract the thought portion of a thought-surface phase-2 stream that
 * ran past a `（我 说）` tag.
 *
 * A thought stream sometimes contains `（我 说）` — either because Herta
 * referenced the speech tag in her planning prose (echoing the phase-2
 * thought prompt's own instruction language, e.g. "接着在 `（我 说）`
 * 里 …"), or because she genuinely skipped her `（/我 想）` close and
 * rolled into speech. In BOTH cases the text from `（我 说）` on is
 * discarded — the actor never promotes it to a speech block; the real
 * speech is generated fresh by the next forced-speech iteration. This
 * avoids the 2026-06-14 bug where the post-tag planning prose was
 * shipped to the user as Herta's line.
 *
 * Returns the trimmed thought: everything before the first `（我 说）`,
 * with a trailing `（/我 想）` and any stray `（我 想）` open tags removed.
 * When `（我 说）` is absent the whole (cleaned) text is returned.
 */
export function thoughtBeforeSpeechTag(text: string): string {
  const splitIdx = text.indexOf("（我 说）");
  const thoughtPart = splitIdx < 0 ? text : text.slice(0, splitIdx);
  return stripStopSequence(thoughtPart, STOP_THOUGHT_CLOSE)
    .replaceAll("（我 想）", "")
    .trim();
}
