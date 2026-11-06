import type {
  ActorPromptFrame,
  ProviderAdapter,
  TerminalRecordBlock,
} from "@herta/core";
import { sanitizeActorText } from "./escape.js";
import { type MoodState, moodDescriptions } from "./meta-think.js";
import type { PromptLang } from "./prompt-lang.js";
import { fenceLengthFor, serializeTerminalRecord } from "./serialize.js";
import {
  FEIAN_GROUNDING_SLOT,
  supervisorSystemPromptFor,
} from "./supervisor-system-prompt.js";
import {
  buildMissingDispatchSystemPrompt,
  buildTriggerRecheckSystemPrompt,
} from "./trigger-recheck-system-prompt.js";

/**
 * Input to the supervisor's speech check. The supervisor evaluates
 * `candidateSpeech` against `recentRecord` (for drift), the mood
 * (for voice register), and the optional `currentTurnThought` (for
 * intent alignment), all anchored by the hardcoded
 * `SUPERVISOR_SYSTEM_PROMPT` from `supervisor-system-prompt.ts`.
 *
 * Hidden / sidecar: nothing here enters `TerminalRecord`. The actor
 * captures the prompt for diagnostic dumping via `onPromptBuilt`
 * before `streamChat` begins; the result's `prompt` + `rawOutput`
 * fields fire after `streamChat` finishes.
 *
 * SPEC v0.2 Supervisor design §4.1.
 */
export interface SupervisorCheckInput {
  readonly provider: ProviderAdapter;
  /**
   * Optional, retained for backwards compatibility with callers
   * that used to pass the user-authored canon file content here.
   * As of 2026-05-21 the supervisor's system prompt is fully
   * self-contained (hardcoded in `supervisor-system-prompt.ts`)
   * and this field is IGNORED by `buildSupervisorPrompt`. The
   * actor still uses `ActorTurnDeps.supervisorReference.length > 0`
   * as the supervisor enable-toggle at the call-site level — since
   * M-prompts-1 (2026-07-05) that string is a config-derived enable
   * marker, no longer the content of a workspace file (the old
   * `.herta/narrative/supervisor_reference.txt` existence-toggle is
   * retired; the supervisor defaults ON).
   */
  readonly reference?: string;
  readonly recentRecord: readonly TerminalRecordBlock[];
  readonly currentState: MoodState;
  /**
   * The session's live 废案 (discarded-draft memory) few-shots — the SAME
   * `staticPrefix.fewShots` the actor loaded this session (废案 + 记录 files
   * from `.herta/narrative/`). Spliced into the supervisor's cached system
   * message as grounding so a legitimate reference to a 废案-sourced fact is
   * not blocked as 事件编造 / 关系编造. Undefined / empty → no section (the
   * supervisor falls back to recent-record + 角色资料 grounding only). It ONLY
   * widens what counts as grounded; hard red-lines are untouched (D4). See
   * `docs/superpowers/specs/2026-06-21-supervisor-feian-grounding.md`.
   */
  readonly feianFewShots?: readonly string[];
  /**
   * The whole session's 板砖 completion receipts — done/noop marker roll-ups
   * extracted from the FULL record by `sessionMarkerReceipts` (2026-07-17).
   * Rule 9 (板砖产出凭空宣布) accepts receipts "from this turn or an earlier
   * one", but `recentRecord` is only the last ~8 blocks, so a receipt that
   * scrolled out of that window was invisible and a LEGITIMATE reference to
   * older completed work read as fabrication (rule 9 deliberately leans
   * BLOCK). This list restores the full-session evidence horizon. Like the
   * 废案 grounding it only WIDENS what counts as receipted; absent/empty →
   * no section, rule 9 falls back to `recentRecord` alone.
   */
  readonly sessionReceipts?: readonly string[];
  /** Most recent thought block from the CURRENT turn, if any. The
   *  supervisor uses it as a reference for what the speech was meant
   *  to deliver. May be undefined when no thought has fired (single-
   *  phase fallback) or when running outside two-phase mode. */
  readonly currentTurnThought?: string;
  readonly candidateSpeech: string;
  /**
   * Language of the LLM-facing prompt prose (EN interaction slice 3b).
   * Defaults to `"zh"` (byte-identical to the pre-slice-3b prompt).
   * Structural narrative-grammar tokens — the `### …` review headers,
   * the step-conclusion / OK / BLOCK output grammar, `@板砖`, 废案,
   * the no-thought placeholder — stay CN in BOTH variants (D2/D7/D8).
   * Slice 4 threads the interaction-language setting through here.
   */
  readonly lang?: PromptLang;
  /**
   * Ask the supervisor to also WRITE the corrected line when it blocks
   * (ADR 0065): a final `改说：<the line as it should be said>` block after
   * the BLOCK lines. The request rides the user message's tail, so the
   * cached system message is byte-identical with or without it. The actor
   * adopts the line as the re-speak when it is usable and falls back to
   * its own rethink + respeak otherwise. Default false (no request, no
   * `revision` in the parsed verdict).
   */
  readonly askRevision?: boolean;
  readonly signal: AbortSignal;
  /** Optional callback fired once the prompt has been constructed and
   *  BEFORE `provider.streamChat` is called. Allows the caller to
   *  surface the prompt for diagnostic dumping even if the provider
   *  call later throws. */
  readonly onPromptBuilt?: (prompt: string) => void;
}

/**
 * Input to the trigger re-pass's focused recheck (`recheckTrigger`).
 * A strict subset of `SupervisorCheckInput`: the dedicated prompt judges
 * only the `@板砖` dispatch token, so mood register, 废案 grounding, and
 * the supervisor reference are all irrelevant and absent. `recentRecord`
 * supplies "is this a present-moment dispatch?" context;
 * `currentTurnThought` supplies the delegation intent.
 *
 * SPEC v0.2 / 2026-06-27 trigger-recheck-prompt design §5.2.
 */
export interface TriggerRecheckInput {
  readonly provider: ProviderAdapter;
  readonly recentRecord: readonly TerminalRecordBlock[];
  readonly currentTurnThought?: string;
  readonly candidateSpeech: string;
  /** Prompt-prose language, defaulting `"zh"` — same semantics as
   *  `SupervisorCheckInput.lang` (EN interaction slice 3b). */
  readonly lang?: PromptLang;
  /** The line answers the Trailblazer while 板砖 runs: its `@板砖` is a steer,
   *  and stands only if they asked for one (ADR 0085 amendment 2026-11-06). */
  readonly duringRun?: boolean;
  readonly signal: AbortSignal;
  readonly onPromptBuilt?: (prompt: string) => void;
}

/**
 * Verdict from the supervisor.
 *
 * - `"ok"` → commit the candidate speech as-is.
 * - `"block"` → discard the candidate, retry phase-2 speech with `reason`
 *   interpolated into the retry hint. `reason` is the block findings'
 *   details joined with `；`.
 *
 * `prompt` and `rawOutput` are always present for diagnostic dumping.
 * `rawOutput` is `""` if the provider returned zero text-delta events
 * (which the parser handles as fail-soft `ok`). `reasoning` carries the
 * concatenated `reasoning-delta` events from the chat-with-thinking
 * provider; `""` when the provider returned no reasoning content. Used
 * only for diagnostic dumping — the parser does NOT consult reasoning
 * to decide the verdict (only the final text-delta line counts).
 *
 * SPEC v0.2 / 2026-06-05 tiered-supervisor design §4.2.
 */
export interface SupervisorCheckResult {
  readonly verdict: "ok" | "block";
  readonly reason?: string;
  readonly blockFindings: readonly SupervisorFinding[];
  readonly prompt: string;
  readonly rawOutput: string;
  readonly reasoning: string;
}

/**
 * Format the supervisor's prompt + reasoning + rawOutput into the body
 * of the `supervisor-out` diagnostic dump. Used by both `recheckTrigger`
 * and the actor's inlined call site to keep the dump layout consistent.
 *
 * When `reasoning` is empty, the `---思考---` section is omitted so
 * dumps from non-thinking providers stay compact.
 *
 * SPEC v0.2 Supervisor design §5.3.
 */
export function formatSupervisorOutDump(opts: {
  prompt: string;
  reasoning: string;
  rawOutput: string;
}): string {
  const parts: string[] = [opts.prompt];
  if (opts.reasoning.length > 0) {
    parts.push("---思考---", opts.reasoning);
  }
  parts.push("---回应---", opts.rawOutput);
  return parts.join("\n\n");
}

const USER_MESSAGE_SEPARATOR = "\n\n---评审消息---\n\n";

/**
 * Build the supervisor's prompt and provider-frame from inputs. Pure
 * function (no I/O, no state). Exported so the actor's call site can
 * fire `onPrompt("supervisor", prompt)` before the provider call begins
 * AND have the prompt available for the `[supervisor failed]` synthetic
 * dump body if `streamChat` throws.
 *
 * SPEC v0.2 Supervisor design §5.1, §5.2.
 */
/**
 * Extract the session's 板砖 completion receipts from the FULL record: every
 * done/noop marker's roll-up body, plus the first `↳ 改动文件` line of its
 * evidenceDetail when present (so a receipt is matchable to a claim about
 * WHICH files were touched). Ordered oldest→newest, capped to the last
 * `max` markers. Pure; bodies were sanitized at block construction.
 */
export function sessionMarkerReceipts(
  record: readonly TerminalRecordBlock[],
  max = 20,
): string[] {
  const receipts: string[] = [];
  for (const b of record) {
    if (b.kind !== "system") continue;
    if (b.role !== "done-marker" && b.role !== "noop-marker") continue;
    const files = b.evidenceDetail
      ?.split("\n")
      .find((line) => line.startsWith("↳ 改动文件:"));
    const entry = files === undefined ? b.body : `${b.body}（${files}）`;
    receipts.push(entry.length > 200 ? `${entry.slice(0, 200)}…` : entry);
  }
  return receipts.slice(Math.max(0, receipts.length - max));
}

export function buildSupervisorPrompt(
  input: Pick<
    SupervisorCheckInput,
    | "recentRecord"
    | "currentState"
    | "currentTurnThought"
    | "candidateSpeech"
    | "feianFewShots"
    | "sessionReceipts"
    | "lang"
    | "askRevision"
  >,
): { prompt: string; frame: ActorPromptFrame } {
  const lang = input.lang ?? "zh";
  const systemMessage = buildSystemMessage(input.feianFewShots, lang);
  const userMessage = buildUserMessage(input);
  const prompt = `${systemMessage}${USER_MESSAGE_SEPARATOR}${userMessage}`;
  const frame: ActorPromptFrame = {
    stableSystem: systemMessage,
    memoryContext: "",
    retrievedLore: "",
    messages: [
      {
        role: "user",
        text: userMessage,
        // Deterministic sentinel: the supervisor frame is sidecar and
        // the `ts` is never inspected. A stable value keeps this
        // function pure so callers can rely on identical inputs
        // producing identical outputs.
        ts: "1970-01-01T00:00:00.000Z",
      },
    ],
    toolSchemas: [],
  };
  return { prompt, frame };
}

/** Per-language closing instruction of the trigger-recheck user message.
 *  Headers and the OK / BLOCK：<类别> grammar stay CN in both (D2). */
const TRIGGER_RECHECK_USER_MESSAGE_TAIL: Record<PromptLang, string> = {
  zh: `只判断上面 \`### 我刚才要说出口的话\` 代码块里那段话中的 \`@板砖\` 此刻该不该真的触发（代码块围栏本身不算话的一部分），然后只输出最终判定行（OK，或一行/多行 BLOCK：<类别>：<第一人称一句>）。`,
  en: `Judge only whether the \`@板砖\` inside the \`### 我刚才要说出口的话\` code block above should really fire right now (the code fence itself is not part of the line), then output only the final verdict line(s) (OK, or one or more lines of BLOCK：<类别>：<one first-person sentence in English>).`,
};

/** The recheck's rule for an answer during a run. The hint cannot carry
 *  this: told when not to write the sentence, she stopped writing it when
 *  asked to (the lab, 2026-11-06). The judge sits where the sentence is
 *  already written, and costs no call an answer without one would make. */
const DURING_RUN_RULE: Record<PromptLang, string> = {
  zh: `这段话是板砖跑着的时候我回开拓者的。这里的 \`@板砖\` 是把话递给正在跑的板砖，只有开拓者在这趟里说的话要板砖改做什么、多做什么，才该触发。他只是问话、聊天，或者这句只是把板砖手上的活再说一遍、替他加了他没要的活：BLOCK：@板砖未要求：<第一人称一句>。`,
  en: `This line is my reply to the Trailblazer while 板砖 runs. An \`@板砖\` here hands words to the running 板砖, and should fire only if what the Trailblazer said during this run asks 板砖 to change course or do something more. If they only asked or chatted, or the sentence only repeats the work 板砖 already has, or adds work they did not ask for: BLOCK：@板砖未要求：<one first-person sentence>.`,
};

/** Closing instruction of the missing-dispatch judge's user message
 *  (ADR 0036) — same three-header body, opposite question. */
const MISSING_DISPATCH_USER_MESSAGE_TAIL: Record<PromptLang, string> = {
  zh: `只判断上面 \`### 我刚才要说出口的话\` 代码块里那段话是否在承诺板砖此刻执行一件具体活、却没有会真触发的 \`@板砖\`（代码块围栏本身不算话的一部分），然后只输出最终判定行（OK，或 BLOCK：漏派：<第一人称一句>）。`,
  en: `Judge only whether the line inside the \`### 我刚才要说出口的话\` code block above promises present 板砖 work without a live \`@板砖\` (the code fence itself is not part of the line), then output only the final verdict line (OK, or BLOCK：漏派：<one first-person sentence in English>).`,
};

function buildTriggerRecheckUserMessage(
  input: Pick<
    TriggerRecheckInput,
    | "recentRecord"
    | "currentTurnThought"
    | "candidateSpeech"
    | "lang"
    | "duringRun"
  >,
  tail: Record<PromptLang, string> = TRIGGER_RECHECK_USER_MESSAGE_TAIL,
): string {
  const lang = input.lang ?? "zh";
  const serializedRecord = serializeTerminalRecord(input.recentRecord, {
    lang,
  });
  const thought = input.currentTurnThought ?? "（这一回没想过，直接想说）";
  // Same fencing + sanitize as buildUserMessage (slice 2): the candidate is
  // model output and must not be able to spoof this prompt's `###` sections.
  // Role "speech" keeps `@板砖` live — judging it is this prompt's whole job.
  const thoughtSafe = sanitizeActorText(thought, { role: "speech" });
  const candidateSafe = sanitizeActorText(input.candidateSpeech, {
    role: "speech",
  });
  return `### 最近的对话
${serializedRecord}

### 我刚才内心想的
${fenceModelText(thoughtSafe)}

### 我刚才要说出口的话
${fenceModelText(candidateSafe)}

---

${input.duringRun === true ? `${DURING_RUN_RULE[lang]}\n\n` : ""}${tail[lang]}`;
}

/**
 * Build the trigger re-pass's focused recheck prompt + provider-frame.
 * Pure (no I/O, no state). Parallels `buildSupervisorPrompt` but uses the
 * dedicated `TRIGGER_RECHECK_SYSTEM_PROMPT` and a three-header user message
 * (no 心情 header). The system message is a plain constant — no 废案 slot to
 * splice.
 *
 * SPEC v0.2 / 2026-06-27 trigger-recheck-prompt design §5.2.
 */
export function buildTriggerRecheckPrompt(
  input: Pick<
    TriggerRecheckInput,
    | "recentRecord"
    | "currentTurnThought"
    | "candidateSpeech"
    | "lang"
    | "duringRun"
  >,
): { prompt: string; frame: ActorPromptFrame } {
  const systemMessage = buildTriggerRecheckSystemPrompt(input.lang ?? "zh");
  const userMessage = buildTriggerRecheckUserMessage(input);
  const prompt = `${systemMessage}${USER_MESSAGE_SEPARATOR}${userMessage}`;
  const frame: ActorPromptFrame = {
    stableSystem: systemMessage,
    memoryContext: "",
    retrievedLore: "",
    messages: [
      {
        role: "user",
        text: userMessage,
        ts: "1970-01-01T00:00:00.000Z",
      },
    ],
    toolSchemas: [],
  };
  return { prompt, frame };
}

/**
 * Build the missing-dispatch judge's prompt + frame (ADR 0036) — the
 * trigger recheck's mirror: same three-header user message, the opposite
 * question in the system message ("did this line promise present 板砖 work
 * with no live `@板砖`?"). Pure, like its sibling.
 */
export function buildMissingDispatchPrompt(
  input: Pick<
    TriggerRecheckInput,
    "recentRecord" | "currentTurnThought" | "candidateSpeech" | "lang"
  >,
): { prompt: string; frame: ActorPromptFrame } {
  const systemMessage = buildMissingDispatchSystemPrompt(input.lang ?? "zh");
  const userMessage = buildTriggerRecheckUserMessage(
    input,
    MISSING_DISPATCH_USER_MESSAGE_TAIL,
  );
  const prompt = `${systemMessage}${USER_MESSAGE_SEPARATOR}${userMessage}`;
  const frame: ActorPromptFrame = {
    stableSystem: systemMessage,
    memoryContext: "",
    retrievedLore: "",
    messages: [
      {
        role: "user",
        text: userMessage,
        ts: "1970-01-01T00:00:00.000Z",
      },
    ],
    toolSchemas: [],
  };
  return { prompt, frame };
}

/**
 * Render the session's 废案 (discarded-draft memory) as a grounding section for
 * the supervisor's system message. Mirrors what the actor's static prefix
 * carries, so the supervisor treats 废案-sourced facts as having 出处 (not as
 * 事件编造 / 关系编造). Returns `""` when there are no 废案 — the slot then
 * collapses to nothing. The framing ONLY widens what counts as grounded; the
 * hard red-line bans (称呼 / 服务 / 抒情 / 工具 / @板砖) are untouched by design
 * (D4). Blank entries are dropped.
 *
 * `lang` selects the intro prose only (EN interaction slice 3b); the
 * 废案 bodies are session data and pass through verbatim in both.
 */
export function renderFeianGrounding(
  fewShots: readonly string[],
  lang: PromptLang = "zh",
): string {
  const items = fewShots.filter((s) => s.trim().length > 0);
  if (items.length === 0) return "";
  const intro = FEIAN_GROUNDING_INTRO[lang];
  return `\n\n${intro}\n\n${items.join("\n\n")}`;
}

/** Intro prose for the 废案 grounding section, per prompt language.
 *  The heading slots in as `## 4.` under the character-reference
 *  section of the matching system-prompt variant. */
const FEIAN_GROUNDING_INTRO: Record<PromptLang, string> = {
  zh: `## 4. 黑塔的记忆参考（废案）

以下「废案」是黑塔记忆里真实发生过的历史片段，属于「角色资料」的一部分，在出处核查里算作有效出处。

- 这些片段里出现过的事件、关系、对象、称呼、往来，都算【有出处】。黑塔在话里回指它们，等同于回指"角色资料里真实出现过的东西"，不算凭空假设、不算事件编造、不算关系编造。
- 它们是【背景记忆】，不是"范例对话"那种评审样例，也不是"最近的对话"。做接话检查里的"凭空假设"判断、以及事件编造 / 关系编造检查时，把废案和"最近的对话""角色资料"同等当作可定位的出处。
- 只扩大"有出处"的范围，不放松任何硬性红线：称呼、服务客套、温柔抒情、工具调用、@板砖 触发与范围这些硬性禁止项一律照旧——一句话即使取材自废案，命中硬性禁止项仍然判不过。

（以下为本次会话加载的废案全文。）`,
  en: `## 4. Herta's memory reference (废案)

The 废案 below are real historical fragments from Herta's memory. They are part of the character reference, and count as valid sources in source-checking.

- Events, relationships, objects, forms of address, and dealings that appear in these fragments all count as【sourced】. When Herta refers back to them in a line, it is the same as referring back to "something that genuinely appears in the character reference" — not an out-of-thin-air assumption, not event fabrication, not relationship fabrication.
- They are【background memory】— not review samples like the "sample dialogues", and not "the recent conversation". When applying the out-of-thin-air test in the 接话 check, and the event / relationship fabrication checks, treat the 废案 as locatable sources on a par with "the recent conversation" and the character reference.
- They only widen what counts as sourced; no hard red line is relaxed: the hard bans on address, service-speak / pleasantries, tender sentimentality, tool-call syntax, and @板砖 trigger & scope all still apply — a line that draws on a 废案 still fails if it hits a hard ban.

(The full text of this session's loaded 废案 follows.)`,
};

/**
 * Build the supervisor system message: the hardcoded role prompt (in the
 * requested language) with the 废案 grounding slot replaced by the session's
 * rendered 废案 section (or `""`). A function replacement is used so
 * `$`-sequences inside 废案 text are never interpreted as replacement
 * patterns.
 */
function buildSystemMessage(
  feianFewShots: readonly string[] | undefined,
  lang: PromptLang,
): string {
  const section = renderFeianGrounding(feianFewShots ?? [], lang);
  return supervisorSystemPromptFor(lang).replace(
    FEIAN_GROUNDING_SLOT,
    () => section,
  );
}

/** Wrap model-authored text in an escalated ```text fence so an injected
 *  `### 我刚才要说出口的话` heading (or any markdown structure) inside the
 *  candidate cannot masquerade as this prompt's real sections. Escalation
 *  (`fenceLengthFor`) keeps a backtick run in the text from closing the
 *  fence early — same move the record serializer uses for system bodies. */
function fenceModelText(text: string): string {
  const fence = "`".repeat(fenceLengthFor(text));
  return `${fence}text\n${text}\n${fence}`;
}

/** Per-language closing instruction of the supervisor's user message.
 *  The `### …` headers above it and the output-grammar tokens inside it
 *  (接话检查 / 过 / 不过 / 不适用 / OK / BLOCK：<类别>) are the machine
 *  contract and stay CN in both variants. */
const USER_MESSAGE_TAIL: Record<PromptLang, string> = {
  zh: `请按系统消息里的四步硬性检查，对照上面 \`### 我刚才要说出口的话\` 代码块里的那段话做评审（代码块的围栏本身不算话的一部分）。正式回答先输出四行检查结论（接话检查 / 声音检查 / 设定检查 / 意图检查，每行"过 / 不过——<一句短理由> / 不适用"），最后输出最终判定行（OK，或一行/多行 BLOCK：<类别>：<第一人称一句>）；任何一行"不过"都必须有对应的 BLOCK 行。`,
  en: `Apply the four-step hard check from the system message to the passage inside the \`### 我刚才要说出口的话\` code block above (the code fence itself is not part of the line). The formal answer first outputs the four conclusion lines (接话检查 / 声音检查 / 设定检查 / 意图检查, each line "过 / 不过——<one short reason> / 不适用"), then the final verdict line(s) (OK, or one or more lines of BLOCK：<类别>：<one first-person sentence in English>); every 不过 line must have a matching BLOCK line.`,
};

/** The 改说 request (ADR 0065), appended to the user message's tail only
 *  when the actor asks for it. The keyword and the grammar around it are
 *  the machine contract (`parseSupervisorVerdict`); the rules are what the
 *  lab found a usable line needs: the sentences that passed survive, only
 *  the named problem changes, nothing after the block. */
const REVISION_REQUEST: Record<PromptLang, string> = {
  zh: `若判定为 BLOCK：在最后一行 BLOCK 之后另起一行，以"改说："开头，写出这段话改正后的完整版本——就是我此刻该说出口的那段话本身。保留原话里没有问题的句子，只改 BLOCK 指出的地方，长度不超过原话；直接写正文，不带（我 说）之类的标签，不带围栏，不带引号，不带任何说明；"改说："之后不要再输出任何别的东西。判定为 OK 时不要输出改说。`,
  en: `If the verdict is BLOCK: after the last BLOCK line, start a new line beginning with "改说：" and give the corrected passage in full — the line I should actually say now, in English. Keep the sentences that passed, change only what the BLOCK lines named, and stay no longer than the original; write the text itself, with no （我 说） tags, no fences, no quotation marks and no commentary; output nothing after the 改说 block. Never output 改说 on an OK verdict.`,
};

/** Intro prose for the session-receipts section, per prompt language. The
 *  `### 本会话的板砖完成记录` header above it is the machine contract and
 *  stays CN in both variants (like every other `### …` header here). */
const RECEIPTS_INTRO: Record<PromptLang, string> = {
  zh: "（整个会话至今 → 差分协处理器 的完成/无产出标记一览，按时间顺序——含「最近的对话」窗口之外的旧凭证。第 9 条的凭证核对以这份清单加「最近的对话」为准。）",
  en: "(All → 差分协处理器 done/no-output markers of this session so far, oldest first — including receipts older than the recent-conversation window. Rule 9's receipt check runs against this list plus the recent conversation.)",
};

function renderSessionReceipts(
  receipts: readonly string[] | undefined,
  lang: PromptLang,
): string {
  const items = (receipts ?? []).filter((r) => r.trim().length > 0);
  if (items.length === 0) return "";
  const lines = items.map((r) => `- ${r}`).join("\n");
  return `### 本会话的板砖完成记录\n${RECEIPTS_INTRO[lang]}\n${lines}\n\n`;
}

function buildUserMessage(
  input: Pick<
    SupervisorCheckInput,
    | "recentRecord"
    | "currentState"
    | "currentTurnThought"
    | "candidateSpeech"
    | "sessionReceipts"
    | "lang"
    | "askRevision"
  >,
): string {
  const lang = input.lang ?? "zh";
  const moodDescription = moodDescriptions(lang)[input.currentState];
  const tail =
    input.askRevision === true
      ? `${USER_MESSAGE_TAIL[lang]}\n\n${REVISION_REQUEST[lang]}`
      : USER_MESSAGE_TAIL[lang];
  const serializedRecord = serializeTerminalRecord(input.recentRecord, {
    lang,
  });
  const thought = input.currentTurnThought ?? "（这一回没想过，直接想说）";
  // sanitize (role "speech", NOT "system-body"): forged evidence labels and
  // cross-role delimiters are ZWSP-broken, but a real `@板砖` must stay live
  // — the supervisor's own §8 check reviews trigger usage and would judge a
  // broken token as absent.
  const thoughtSafe = sanitizeActorText(thought, { role: "speech" });
  const candidateSafe = sanitizeActorText(input.candidateSpeech, {
    role: "speech",
  });
  const moodLine =
    lang === "en"
      ? `${input.currentState} (tone baseline in this mood: ${moodDescription})`
      : `${input.currentState}（这心情下我的语气基线：${moodDescription}）`;
  return `### 我现在的心情
${moodLine}

### 最近的对话
${serializedRecord}

${renderSessionReceipts(input.sessionReceipts, lang)}### 我刚才内心想的
${fenceModelText(thoughtSafe)}

### 我刚才要说出口的话
${fenceModelText(candidateSafe)}

---

${tail}`;
}

/**
 * A single supervisor finding: a category label (for offline stats) plus
 * a one-line detail. For BLOCK findings the detail is a first-person
 * clause ("我刚才不该…") so it reads in-voice when wrapped by
 * `buildSupervisorVetoHint`.
 */
export interface SupervisorFinding {
  readonly category: string;
  readonly detail: string;
}

/** Match a verdict keyword at the START of a trimmed line. `BLOCK` must
 *  not be immediately followed by an ASCII letter (so `BLOCKED` in stray
 *  prose doesn't match). `charAt` past the end returns `""`, which is not
 *  a letter — so a bare `BLOCK` line still matches. */
function matchVerdictKeyword(line: string): "BLOCK" | "重来" | null {
  if (
    line.startsWith("BLOCK") &&
    !/[A-Za-z]/.test(line.charAt("BLOCK".length))
  ) {
    return "BLOCK";
  }
  return line.startsWith("重来") ? "重来" : null;
}

/** Match the 改说 keyword that opens the supervisor's corrected line (ADR
 *  0065). The keyword must be the whole line or be followed by a colon —
 *  prose that merely begins with the characters (改说得更短) is not it.
 *  Returns the text after the colon (possibly empty: the line may start on
 *  the next line), or null. */
function matchRevisionKeyword(line: string): string | null {
  const m = /^改说\s*(?:[:：]\s*(.*))?$/u.exec(line);
  if (m === null) return null;
  return (m[1] ?? "").trim();
}

/** Tidy the captured 改说 text: a wrapping pair of quotes and a stray
 *  speech envelope are tolerated (the prompt forbids both, models add
 *  them anyway) so the actor's usability check judges the line itself. */
function tidyRevision(lines: readonly string[]): string {
  let text = lines.join("\n").trim();
  for (const [open, close] of [
    ["「", "」"],
    ["“", "”"],
    ['"', '"'],
  ] as const) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim();
      break;
    }
  }
  if (text.startsWith("（我 说）")) text = text.slice("（我 说）".length);
  if (text.endsWith("（/我 说）")) {
    text = text.slice(0, text.length - "（/我 说）".length);
  }
  // A quote opened and never closed (the 2026-09-18 soak: `"……'一切'？…`)
  // is the model half-obeying "no quotation marks"; the lone mark would
  // otherwise reach the screen and the record. Only an UNPAIRED opener is
  // dropped — a line that quotes something inside itself keeps both.
  for (const [open, close] of [
    ['"', '"'],
    ["“", "”"],
    ["「", "」"],
  ] as const) {
    if (text.startsWith(open) && !text.slice(open.length).includes(close)) {
      text = text.slice(open.length).trimStart();
      break;
    }
  }
  return text.trim();
}

/** Step-conclusion line marked failed, e.g. `设定检查：不过——沿用了"杨叔"`.
 *  Anchored so `声音检查：过，不过略短` (过 + the conjunction 不过) does NOT
 *  match — only a conclusion whose verdict slot IS 不过 counts. */
const STEP_FAIL_RE = /^(接话|声音|设定|意图)检查\s*[:：]\s*不过\s*(.*)$/;

/** Parse a step-conclusion line marked 不过 into a fallback finding.
 *  Null when the line isn't a failed step conclusion. */
function parseStepFailLine(line: string): SupervisorFinding | null {
  const m = STEP_FAIL_RE.exec(line);
  if (m === null) return null;
  const detail = (m[2] ?? "").replace(/^[\s—－–\-:：，、。]+/, "").trim();
  return {
    category: m[1] as string,
    detail: detail.length > 0 ? detail : "这一步没过，但没给出具体理由",
  };
}

/** Parse the text after a BLOCK keyword into a finding. Strips a
 *  single leading separator colon, then optionally splits `类别：detail`.
 *  Returns null when there's nothing left (bare keyword → noise). */
function parseFindingBody(afterKeyword: string): SupervisorFinding | null {
  let body = afterKeyword.trim();
  if (/^[:：]/.test(body)) body = body.slice(1).trim();
  if (body.length === 0) return null;
  const colon = body.search(/[:：]/);
  if (colon > 0) {
    const category = body.slice(0, colon).trim();
    const detail = body.slice(colon + 1).trim();
    if (category.length > 0 && detail.length > 0) return { category, detail };
  }
  return { category: "未分类", detail: body };
}

/**
 * Parse the supervisor model's raw text-delta output into a binary
 * verdict. Pure function — no I/O.
 *
 * Scans EVERY line: each `BLOCK：<类别>：<detail>` line becomes a block
 * finding. A BLOCK line with only one colon → `category: "未分类"`.
 * Legacy `重来：<reason>` → a block finding (transition tolerance).
 * Lines that aren't a recognized verdict keyword are ignored as
 * analysis noise — EXCEPT step-conclusion lines marked 不过 (the
 * structured four-line format, 2026-07-13): when the model marks a
 * step failed but forgets the matching BLOCK line, those step lines
 * become the findings instead of silently approving. BLOCK lines,
 * when present, stay authoritative (first-person, retry-hint quality)
 * and the step lines are ignored.
 *
 * Verdict: any block → `"block"`; else `"ok"`. Fail-soft asymmetry
 * preserved: garbled / empty / no recognizable verdict line → `"ok"`
 * (a misbehaving supervisor approves, never mass-blocks). `reason` is
 * set only on `"block"`, the block details joined with `；` for
 * `buildSupervisorVetoHint`.
 *
 * `revision` (ADR 0065): the text of a `改说：` block — everything from
 * the keyword to the end of the output, since the corrected line is the
 * last thing the supervisor writes. A verdict line landing AFTER it (the
 * wrong order) still counts as a verdict and ends the capture: a swallowed
 * BLOCK must never read as an OK. Set only on `"block"` and only when
 * non-empty; whether the line can stand as the re-speak is the actor's
 * call (`usableRevision` in actor-turn.ts).
 */
export function parseSupervisorVerdict(raw: string): {
  verdict: "ok" | "block";
  reason?: string;
  blockFindings: readonly SupervisorFinding[];
  revision?: string;
} {
  const blockFindings: SupervisorFinding[] = [];
  const stepFailFindings: SupervisorFinding[] = [];
  const revisionLines: string[] = [];
  let inRevision = false;
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (inRevision) {
      if (matchVerdictKeyword(line) === null && line !== "OK") {
        revisionLines.push(line);
        continue;
      }
      inRevision = false;
    }
    if (line.length === 0) continue;
    const revisionStart = matchRevisionKeyword(line);
    if (revisionStart !== null) {
      inRevision = true;
      if (revisionStart.length > 0) revisionLines.push(revisionStart);
      continue;
    }
    const kw = matchVerdictKeyword(line);
    if (kw === null) {
      const stepFail = parseStepFailLine(line);
      if (stepFail !== null) stepFailFindings.push(stepFail);
      continue;
    }
    if (kw === "重来") {
      const finding = parseFindingBody(line.slice("重来".length));
      blockFindings.push(
        finding ?? { category: "未分类", detail: "未给出具体理由" },
      );
      continue;
    }
    const finding = parseFindingBody(line.slice(kw.length));
    if (finding === null) continue;
    blockFindings.push(finding);
  }
  if (blockFindings.length === 0 && stepFailFindings.length > 0) {
    blockFindings.push(...stepFailFindings);
  }
  if (blockFindings.length > 0) {
    const revision = tidyRevision(revisionLines);
    return {
      verdict: "block",
      reason: blockFindings.map((f) => f.detail).join("；"),
      blockFindings,
      ...(revision.length > 0 ? { revision } : {}),
    };
  }
  return { verdict: "ok", blockFindings };
}

/**
 * True when a supervisor BLOCK finding is about the `@板砖` trigger itself
 * (scope misuse, tool discipline, a category that names the token directly, or
 * any finding whose detail contains the `@板砖` dispatch token (bare 板砖 is a
 * world noun and appears in unrelated findings)) — as opposed to an unrelated
 * violation (称呼, 声音, …). The veto-retry re-pass neutralizes the trigger
 * only for trigger-related blocks, so a legitimate dispatch is never killed by
 * an unrelated nitpick (2026-06-11 trigger-discipline design §3.2).
 *
 * Categories may also name the token directly (the verdict-rules list offers
 * @板砖触发/范围); e.g. `category: "@板砖触发"` is matched by the
 * `category.includes("@板砖")` clause even when the canonical category labels
 * (称呼/关系/事件/工具/范围/服务/软化/声音/接话) are not present.
 *
 * No 调度/触发符 category match: those words aren't in the canonical category
 * list; matching them would reward off-vocabulary supervisor output.
 */
export function isTriggerRelatedFinding(finding: SupervisorFinding): boolean {
  return (
    finding.category.includes("@板砖") ||
    finding.category.includes("范围") ||
    finding.category.includes("工具") ||
    finding.detail.includes("@板砖")
  );
}

/**
 * Run the trigger re-pass's focused recheck end-to-end. Convenience
 * wrapper around `buildTriggerRecheckPrompt` + `provider.streamChat` +
 * `parseSupervisorVerdict`. Production entry point for the actor's
 * veto-retry trigger re-pass (actor-turn.ts) and its tests.
 *
 * Returns the same `SupervisorCheckResult` shape as the full pass so the
 * `supervisor-retry` / `supervisor-retry-out` diagnostic dumps are
 * unchanged. Verdict mapping at the call site: `ok` → let the dispatch
 * fire; `block` → neutralize the `@`. Fail-soft is inherited from
 * `parseSupervisorVerdict` (garbled / empty → `ok` → fire).
 *
 * `onPromptBuilt` (if provided) fires once after the prompt is built and
 * before `streamChat` begins, so callers capture the prompt for the
 * diagnostic dump even if `streamChat` later throws.
 *
 * SPEC v0.2 / 2026-06-27 trigger-recheck-prompt design §5.2.
 */
export async function recheckTrigger(
  input: TriggerRecheckInput,
): Promise<SupervisorCheckResult> {
  const { prompt, frame } = buildTriggerRecheckPrompt({
    recentRecord: input.recentRecord,
    currentTurnThought: input.currentTurnThought,
    candidateSpeech: input.candidateSpeech,
    lang: input.lang ?? "zh",
    ...(input.duringRun === true ? { duringRun: true } : {}),
  });
  input.onPromptBuilt?.(prompt);
  let buffered = "";
  let reasoning = "";
  for await (const ev of input.provider.streamChat(frame, input.signal)) {
    if (ev.type === "text-delta") {
      buffered += ev.text;
    } else if (ev.type === "reasoning-delta") {
      reasoning += ev.text;
    } else if (ev.type === "finish") {
      break;
    }
    // tool-call-request events are deliberately ignored — the
    // supervisor never calls tools.
  }
  const parsed = parseSupervisorVerdict(buffered);
  const base = {
    verdict: parsed.verdict,
    blockFindings: parsed.blockFindings,
    prompt,
    rawOutput: buffered,
    reasoning,
  };
  return parsed.reason !== undefined
    ? { ...base, reason: parsed.reason }
    : base;
}

/**
 * Run the missing-dispatch judge end-to-end (ADR 0036) — recheckTrigger's
 * mirror. The call site (actor-turn) gates it on a candidate that MENTIONS
 * 板砖 while carrying no dispatch-effective `@板砖`, and folds a BLOCK into
 * the supervisor veto so the rethink-respeak machinery resolves it: she
 * either really dispatches or takes the promise back. The harness never
 * injects an `@` itself — a fabricated dispatch would be worse than a
 * missed one. Fail-soft is inherited from `parseSupervisorVerdict`
 * (garbled / empty → `ok` → commit unchanged).
 */
export async function judgeMissingDispatch(
  input: TriggerRecheckInput,
): Promise<SupervisorCheckResult> {
  const { prompt, frame } = buildMissingDispatchPrompt({
    recentRecord: input.recentRecord,
    currentTurnThought: input.currentTurnThought,
    candidateSpeech: input.candidateSpeech,
    lang: input.lang ?? "zh",
  });
  input.onPromptBuilt?.(prompt);
  let buffered = "";
  let reasoning = "";
  for await (const ev of input.provider.streamChat(frame, input.signal)) {
    if (ev.type === "text-delta") {
      buffered += ev.text;
    } else if (ev.type === "reasoning-delta") {
      reasoning += ev.text;
    } else if (ev.type === "finish") {
      break;
    }
  }
  const parsed = parseSupervisorVerdict(buffered);
  const base = {
    verdict: parsed.verdict,
    blockFindings: parsed.blockFindings,
    prompt,
    rawOutput: buffered,
    reasoning,
  };
  return parsed.reason !== undefined
    ? { ...base, reason: parsed.reason }
    : base;
}

/**
 * Enable marker threaded through `ActorTurnDeps.supervisorReference`
 * (M-prompts-1, 2026-07-05). Historically that field carried the
 * content of `.herta/narrative/supervisor_reference.txt`, whose mere
 * EXISTENCE toggled the supervisor on (the content has been ignored
 * since 2026-05-21). A workspace file whose presence silently arms or
 * disarms a safety-adjacent quality gate is exactly the accident the
 * compiled-prompts migration removes: callers now pass this marker
 * (supervisor ON, the default) or `""` (explicitly disabled via
 * config/env), and no file is consulted.
 */
export const SUPERVISOR_ENABLED_MARKER = "enabled";

/**
 * Resolve the actor-deps `supervisorReference` toggle string from a boolean
 * enable flag.
 *
 * This one string gates more than the veto (audit BL16). In `actor-turn`, both
 * `@板砖` trigger re-pass checks sit inside the same `supervisorReference !==
 * ""` block, so disabling the supervisor also disables the guard against a
 * rhetorical `@板砖` firing a real dispatch — while the dispatch itself, keyed
 * on the literal token, remains unconditional. Turning this off does not
 * merely relax quality checking; it changes when the backend runs.
 *
 * Left as-is deliberately: the toggle is dev-only (no shipped UI reaches it),
 * and hoisting the trigger checks out of the block would mean running a
 * supervisor call in the configuration whose whole purpose is not to.
 */
export function supervisorReferenceFor(enabled: boolean): string {
  return enabled ? SUPERVISOR_ENABLED_MARKER : "";
}
