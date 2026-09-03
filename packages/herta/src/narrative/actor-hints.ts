import { promptAssetsFor } from "./prompt-assets.js";
import type { PromptLang } from "./prompt-lang.js";
import {
  actorHintTexts,
  BEAT_HINT_PATCH_PREVIEW,
  BEAT_HINT_TOOL_FAIL,
  BEAT_HINT_VERIFICATION_FINISHED,
  PHASE_TWO_SPEECH_HINT,
  PHASE_TWO_SPEECH_RETRY_HINTS,
  PHASE_TWO_SPEECH_SLOT_RETRY_HINTS,
  PHASE_TWO_THOUGHT_HINT,
  PHASE_TWO_THOUGHT_RETRY_HINTS,
  PHASE_TWO_THOUGHT_SLOT_RETRY_HINTS,
} from "./thought-hint.js";

/**
 * The actor's `〔…〕` hint set. Authored as `packages/herta/prompts/hints/
 * *.txt` and COMPILED into the bundle via `PROMPT_ASSETS` (M-prompts-1,
 * 2026-07-05 — these are instruction prompts, Tier 1: previously they were
 * read from the workspace's `.herta/narrative/hints/` at runtime, which
 * made format contracts user-editable and absent in any other workspace).
 * The beat hints are stored fully-resolved (the shared `@板砖` clause
 * already spliced); `supervisorVetoTemplate` still carries the runtime
 * `{{reason}}` placeholder (substituted by `buildSupervisorVetoHint`).
 */
export interface ActorHints {
  readonly phase2Thought: string;
  readonly phase2Speech: string;
  readonly speechRetry: readonly [string, string, string];
  /** The SLOT ladder (2026-08-12): used when the failing attempt emitted a
   *  template placeholder rather than nothing. The empty ladder's accusation
   *  ("闭合得太快" / "不能空白") is simply false in that case, so recovery
   *  was re-rolling rather than correcting. */
  readonly speechSlotRetry: readonly [string, string, string];
  readonly thoughtRetry: readonly [string, string, string];
  /** The thought-lane SLOT ladder (2026-08-12). A slot-only thought never
   *  reaches the user, but it enters the record and next turn's prompt,
   *  where it reads as something she actually thought. */
  readonly thoughtSlotRetry: readonly [string, string, string];
  readonly beatPatchPreview: string;
  readonly beatVerification: string;
  readonly beatToolFail: string;
  readonly supervisorVetoTemplate: string;
  /** Rethink-respeak stage 1 (2026-07-18): the fresh （我 想） that digests
   *  a supervisor veto before the respeak. Carries `{{reason}}`. */
  readonly supervisorRethinkTemplate: string;
  /** Rethink-respeak stage 2: the slim （我 说） hint after a committed
   *  rethink thought. Static — the reason lives in the fresh thought. */
  readonly supervisorRespeak: string;
}

/** Default supervisor-veto templates per language. The zh value is the
 *  former baked-in string from `buildSupervisorVetoHint`, with the
 *  `${reason}` interpolation replaced by the `{{reason}}` placeholder the
 *  new builder substitutes; the en value mirrors the EN bundle's
 *  `supervisor_veto` hint. Fallback only — the compiled asset wins. */
const SUPERVISOR_VETO_TEMPLATE_TEXT: Record<PromptLang, string> = {
  zh: "〔我刚才说的话被自己回头一看就否了：{{reason}}。现在重新说一次，必须以（我 说）开始，以（/我 说）结束，针对刚才被否的那点调一下，别再犯一样的错。〕",
  en: "〔That last line, I can't stand it myself: {{reason}}. Say it again. Must start with （我 说） and end with （/我 说）; steer around that pit instead of stepping in it twice.〕",
};

/** Back-compat zh alias — byte-identical to the pre-slice-4 const. */
export const SUPERVISOR_VETO_TEMPLATE = SUPERVISOR_VETO_TEMPLATE_TEXT.zh;

/** Fallbacks for the two-stage rethink-respeak hints (2026-07-18).
 *  Mirror the compiled `supervisor_rethink` / `supervisor_respeak` assets;
 *  compiled assets win. */
const SUPERVISOR_RETHINK_TEMPLATE_TEXT: Record<PromptLang, string> = {
  zh: "〔我刚才要说的那句被自己回头看否了：{{reason}}。先别急着开口——重新想一遍：那句话错在哪个点上；我刚才那套想法里有没有哪一步本身就站不住；正确的说法应该落在什么上面——是终端记录里有凭证的事，是我自己真实经历过的事，还是根本不用动事实、只该换一种口吻。想的时候两条底线别丢：记录里真摆着的凭证不用怀疑，不用替它翻案；这个终端里动文件的一直是板砖，不是我——嘴上说「我记了」「我写好了」，盘上不会因此多出一个字，没有板砖的写入行就等于没有这回事。必须以（我 想）开始，以（/我 想）结束，只想这一件事，别展开新话题。〕",
  en: '〔That line I was about to say — I refused it myself: {{reason}}. Don\'t rush to speak. Think it through again first: where exactly did that line go wrong; is there a step in what I was just thinking that doesn\'t hold up on its own; and what should the correct line rest on — something the terminal record vouches for, something I have genuinely lived, or no change of fact at all — just a different way of saying it. Two baselines while thinking: evidence really sitting in the record is not to be doubted or relitigated; and in this terminal it has always been 板砖 that touches the files, not me — saying "I noted it down" or "I wrote it up" puts nothing on the disk, and without 板砖\'s write line there is no such thing. Must start with （我 想） and end with （/我 想）; think only about this, open no new topics.〕',
};

const SUPERVISOR_RESPEAK_TEXT: Record<PromptLang, string> = {
  zh: "〔想完了。现在照着刚才想清楚的说出来。必须以（我 说）开始，以（/我 说）结束。重说的是一次完整的回话：刚才那句话本来要回应开拓者的事，这次也要回应到位——改错的地方改掉，【没被否掉的】意思一样不少，别只把改好的那半句单独丢出来。但被否的那个说法，连同靠它撑起来的宣称，整个丢掉——不是换个说法保住，一个字都不许再出现，也不许换个名字、换个文件名再冒出来。说全不等于说长：一句话能回应完的就一句话，不用拿软话把句子填满。刚才想的里面定了要派活就写全 @板砖 真派出去，定了要承认就直说，定了要换口吻就用换好的口吻说；只说我自己的话，别替开拓者说他的。〕",
  en: "〔Thought through. Now say it the way I just worked out. Must start with （我 说） and end with （/我 说）. This redo is a complete reply: whatever the refused line was answering for the Trailblazer, this one answers it too — fix what was wrong, keep every part of the meaning that【was not refused】, and don't hand over only the corrected half-sentence on its own. But the refuted wording, together with any claim that stood on it, gets dropped whole — not rescued under a different phrasing; not one word of it reappears, and not under a new name or a new filename either. Complete doesn't mean long: if one sentence answers it all, one sentence is right, and no padding the line with soft talk. If the rethink settled on dispatching, spell out @板砖 and actually send the job; if it settled on admitting, say it plainly; if it settled on a different register, speak in that register. My words only — never speak the Trailblazer's lines for them.〕",
};

/** Hardcoded fallback for every hint. A missing/empty compiled asset (a
 *  hint file deleted from `packages/herta/prompts/hints/` without a code
 *  change) falls back to its value here, so the format contract degrades
 *  to a working default rather than breaking. */
export const DEFAULT_ACTOR_HINTS: ActorHints = {
  phase2Thought: PHASE_TWO_THOUGHT_HINT,
  phase2Speech: PHASE_TWO_SPEECH_HINT,
  speechRetry: PHASE_TWO_SPEECH_RETRY_HINTS,
  speechSlotRetry: PHASE_TWO_SPEECH_SLOT_RETRY_HINTS,
  thoughtRetry: PHASE_TWO_THOUGHT_RETRY_HINTS,
  thoughtSlotRetry: PHASE_TWO_THOUGHT_SLOT_RETRY_HINTS,
  beatPatchPreview: BEAT_HINT_PATCH_PREVIEW,
  beatVerification: BEAT_HINT_VERIFICATION_FINISHED,
  beatToolFail: BEAT_HINT_TOOL_FAIL,
  supervisorVetoTemplate: SUPERVISOR_VETO_TEMPLATE,
  supervisorRethinkTemplate: SUPERVISOR_RETHINK_TEMPLATE_TEXT.zh,
  supervisorRespeak: SUPERVISOR_RESPEAK_TEXT.zh,
};

/**
 * Language-aware hardcoded fallback set (slice 4). `"zh"` returns the
 * exact `DEFAULT_ACTOR_HINTS` object (byte-identical, referentially
 * equal); `"en"` builds the equivalent from `actorHintTexts("en")` plus
 * the EN supervisor-veto template. Used when a compiled hint asset is
 * missing/empty and by the actor turn when no `hints` dep is provided.
 */
export function defaultActorHintsFor(lang: PromptLang = "zh"): ActorHints {
  if (lang === "zh") return DEFAULT_ACTOR_HINTS;
  const t = actorHintTexts(lang);
  return {
    phase2Thought: t.phase2Thought,
    phase2Speech: t.phase2Speech,
    speechRetry: t.speechRetry,
    speechSlotRetry: t.speechSlotRetry,
    thoughtRetry: t.thoughtRetry,
    thoughtSlotRetry: t.thoughtSlotRetry,
    beatPatchPreview: t.beatPatchPreview,
    beatVerification: t.beatVerification,
    beatToolFail: t.beatToolFail,
    supervisorVetoTemplate: SUPERVISOR_VETO_TEMPLATE_TEXT[lang],
    supervisorRethinkTemplate: SUPERVISOR_RETHINK_TEMPLATE_TEXT[lang],
    supervisorRespeak: SUPERVISOR_RESPEAK_TEXT[lang],
  };
}

/** One compiled hint from the given bundle's hints record. Trimmed; null
 *  on missing/empty so the caller's per-field fallback applies. */
function asset(
  hints: Readonly<Record<string, string>>,
  name: string,
): string | null {
  const raw = hints[name];
  if (raw === undefined) return null;
  const trimmed = raw.trimEnd();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Map a beat trigger signature to the appropriate beat hint from the
 * loaded `ActorHints`. Unknown signatures fall back to `phase2Speech`
 * (the generic speech hint), matching the pre-externalization behavior.
 */
export function selectBeatHint(
  hints: ActorHints,
  triggerSignature: string,
): string {
  if (triggerSignature === "patch.preview:first") return hints.beatPatchPreview;
  if (triggerSignature === "verification.finished") {
    return hints.beatVerification;
  }
  if (triggerSignature.startsWith("tool.fail:")) return hints.beatToolFail;
  return hints.phase2Speech;
}

/**
 * Resolve the actor hints from the compiled bundle for `lang`
 * (`promptAssetsFor(lang).hints`), falling back per-field to the
 * matching `defaultActorHintsFor(lang)` on missing/empty. The shared
 * `@板砖` clause (`beat_no_banzhuan_clause`, or its language default) is
 * spliced into the three beat hints in place of the `{{no_banzhuan}}`
 * token. `supervisor_veto` keeps its `{{reason}}` placeholder (resolved
 * at runtime). Pure and synchronous — no disk I/O (M-prompts-1).
 * Default "zh" — byte-identical to the pre-slice-4 zero-arg call.
 */
export function loadActorHints(lang: PromptLang = "zh"): ActorHints {
  const hints = promptAssetsFor(lang).hints;
  const defaults = defaultActorHintsFor(lang);
  const clause =
    asset(hints, "beat_no_banzhuan_clause") ??
    actorHintTexts(lang).beatNoBanzhuanClause;
  const splice = (raw: string | null, def: string): string =>
    (raw ?? def).split("{{no_banzhuan}}").join(clause);
  return {
    phase2Thought: asset(hints, "phase2_thought") ?? defaults.phase2Thought,
    phase2Speech: asset(hints, "phase2_speech") ?? defaults.phase2Speech,
    speechRetry: [
      asset(hints, "speech_retry_1") ?? defaults.speechRetry[0],
      asset(hints, "speech_retry_2") ?? defaults.speechRetry[1],
      asset(hints, "speech_retry_3") ?? defaults.speechRetry[2],
    ],
    speechSlotRetry: [
      asset(hints, "speech_slot_retry_1") ?? defaults.speechSlotRetry[0],
      asset(hints, "speech_slot_retry_2") ?? defaults.speechSlotRetry[1],
      asset(hints, "speech_slot_retry_3") ?? defaults.speechSlotRetry[2],
    ],
    thoughtRetry: [
      asset(hints, "thought_retry_1") ?? defaults.thoughtRetry[0],
      asset(hints, "thought_retry_2") ?? defaults.thoughtRetry[1],
      asset(hints, "thought_retry_3") ?? defaults.thoughtRetry[2],
    ],
    thoughtSlotRetry: [
      asset(hints, "thought_slot_retry_1") ?? defaults.thoughtSlotRetry[0],
      asset(hints, "thought_slot_retry_2") ?? defaults.thoughtSlotRetry[1],
      asset(hints, "thought_slot_retry_3") ?? defaults.thoughtSlotRetry[2],
    ],
    beatPatchPreview: splice(
      asset(hints, "beat_patch_preview"),
      defaults.beatPatchPreview,
    ),
    beatVerification: splice(
      asset(hints, "beat_verification"),
      defaults.beatVerification,
    ),
    beatToolFail: splice(asset(hints, "beat_tool_fail"), defaults.beatToolFail),
    supervisorVetoTemplate:
      asset(hints, "supervisor_veto") ?? defaults.supervisorVetoTemplate,
    supervisorRethinkTemplate:
      asset(hints, "supervisor_rethink") ?? defaults.supervisorRethinkTemplate,
    supervisorRespeak:
      asset(hints, "supervisor_respeak") ?? defaults.supervisorRespeak,
  };
}
