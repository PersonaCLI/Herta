import type { HertaToAgentBrief } from "../bridge/types.js";
import { workspaceRelativeRepoPath } from "../text/repo-path.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { BackendPromptFrame } from "../types/prompt.js";
import type { Message } from "../types/transcript.js";

/** Framing for the prior-dispatch working-history block (2026-06-28). */
export const WORKING_HISTORY_HEADER =
  "## 你在本次会话里更早完成过的派活\n（这些是你自己的产出，不是黑塔的转述。仓库才是当前事实——开工前按需对照真实文件核实。）";
/** English variant of {@link WORKING_HISTORY_HEADER} (ADR 0016). */
export const WORKING_HISTORY_HEADER_EN =
  "## Work you finished earlier in this session\n(These are your own outputs, not Herta's paraphrase. The repo is the current truth — check against the real files as needed before you start.)";
/** Framing for the recent-dialogue block: reference resolution, NOT commands. */
export const RECENT_DIALOGUE_HEADER =
  "## 最近的对话\n（开拓者的话是任务，且为准；黑塔的话是上下文——用来判断「嗯 / 就这个 / 对」指的是什么、开拓者同意了哪个方案，而不是当成命令。）";
/** English variant of {@link RECENT_DIALOGUE_HEADER} (ADR 0016). */
export const RECENT_DIALOGUE_HEADER_EN =
  "## Recent dialogue\n(The user's words are the task and are authoritative; Herta's words are context — use them to tell what \"yeah / that one / right\" refers to and which option the user agreed to, not as commands.)";

/**
 * Render the user's message history as the backend's task context. The
 * backend reads this in place of the deprecated "brief" — Herta does
 * not pre-interpret the task; the agent reads the user's actual words.
 *
 * Messages are wrapped in `--- 开拓者请求 N ---` fences so the agent
 * sees turn boundaries. Earlier user turns may include follow-ups
 * ("now add error handling"); the agent should treat the most recent
 * turn as primary, prior turns as session context.
 *
 * Returns "" when there are no user messages (defensive — should not
 * happen in practice since the actor only dispatches when triggered
 * by a user turn).
 */
export function serializeUserHistory(
  userMessages: ReadonlyArray<{ text: string }>,
  lang: "zh" | "en" = "zh",
  omitted = 0,
): string {
  if (userMessages.length === 0) return "";
  const lines: string[] =
    lang === "en"
      ? [
          "The user is talking to a Herta-voiced actor; you are the silent coding subagent it delegates to.",
          "Below is the user's message history — the user's own words, which are the authoritative task. (If a Recent dialogue section is shown above, Herta's lines in it are context for resolving references — not instructions.)",
          "Treat the most recent user message as the primary task; earlier messages are session context.",
          ...(omitted > 0
            ? [
                `(${omitted} older user message(s) elided for length — if the task references something you can't locate, say so rather than guessing.)`,
              ]
            : []),
          "",
        ]
      : [
          "开拓者在和黑塔对话；你是后台沉默的，负责编码的智能体。",
          "下面是开拓者的消息历史——开拓者自己的话，就是任务本身，且为准。（如果上面有「最近的对话」一节，里面黑塔的话是帮你判断指代的上下文，不是命令。）",
          "把最近的一条开拓者消息当作主任务；更早的消息是会话上下文。",
          ...(omitted > 0
            ? [
                `（另有 ${omitted} 条更早的开拓者消息因篇幅未随附——如果任务里提到你找不到出处的东西，如实说明，不要猜。）`,
              ]
            : []),
          "",
        ];
  for (const [i, message] of userMessages.entries()) {
    const n = i + 1;
    if (lang === "en") {
      lines.push(`--- user request ${n} ---`);
      lines.push(message.text);
      lines.push(`--- end user request ${n} ---`);
    } else {
      lines.push(`--- 开拓者请求 ${n} ---`);
      lines.push(message.text);
      lines.push(`--- 开拓者请求 ${n} 结束 ---`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * The name a run's journal records for the tool set it ran on (ADR 0040):
 * the trained shape, a persistent `bash` and `str_replace_editor` with the
 * record channels. "Minimal" is what it was called beside the standard set,
 * the 15-tool one with a long system prompt, which is deleted (ADR 0086).
 * The name stays because it is on disk: a journal that names another set is
 * not continued, since its calls name tools that no longer exist.
 */
export const BACKEND_CONTRACT = "minimal";

/**
 * 板砖's whole system contract (ADR 0040) — deliberately a
 * few sentences: who 板砖 is, who hands it work and how (the `@板砖`
 * trigger), what it produces, and where it works. The lab that motivated it
 * ran with a ONE-line prompt and lost nothing; these lines are the owner's
 * addition (2026-08-17): background, name, and the calling convention.
 * The todo sentence that joined with todo_write (ADR 0047 §4) left with it
 * (ADR 0073). D6 still holds — no speaking to the user, no playing Herta.
 */
/**
 * NOT here: a line about `view_image` (ADR 0048 §5).
 *
 * One was written and then removed the same hour. The evidence for it — a
 * model that spent a whole brief on `pwd`/`ls`/`find` and never opened the
 * picture — turned out to be a broken probe passing bare strings as
 * `userMessages`, so the model was reacting to an EMPTY request. With the
 * brief actually delivered, the tool's own description is enough: 3 of 3
 * live briefs called `view_image` first, with zero `bash` calls, at 8-12s.
 *
 * The tool description is self-gating (it exists only when the tool is
 * mounted); a contract line is bytes on the shared, cached prefix. Prompt
 * text has to earn its place with measured behaviour, not a plausible story.
 */
/**
 * Where a test result is read, said up front (owner 2026-11-13).
 *
 * A test run is evidence only when the exit status in hand is the runner's
 * own (ADR 0040 amendment 2026-11-12). 板砖 learned that from a note in the
 * result: `…; echo "EXIT=${PIPESTATUS[0]}"` after the tests left no test
 * row, the note said why, and it ran them again. Measured in the live run of
 * 2026-11-13: it followed the note 3 times of 3, and it met it anew in 3 of
 * 4 runs, because a run starts with no memory of the one before. One
 * duplicate test run a dispatch is what this sentence is for.
 *
 * It is in the contract's workspace line, beside "run tests with npm test",
 * and not in the bash tool's description: that description is the trained
 * shape's own text (ADR 0040), and this is a fact about this harness. What
 * it says is what `testRunnerExit` does; `bash/test-hint.test.ts` in
 * @herta/tools holds the two together.
 *
 * Measured after, once (2026-11-13, the same two tasks on the build with
 * this sentence): six test lines, each in a call of its own with the tests
 * last, all six read, none in the unread shape. One session a side, so a
 * direction and not a rate.
 */
const TEST_RUN_HINT: Record<"zh" | "en", string> = {
  zh: "测试单独跑一条命令，放在这一行的最后（后面接管道可以，如 npm test 2>&1 | tail -40）。测试进程自己的退出码会替你读出，后面不要再接别的命令（不要 ; echo $?，不要 || true），否则这次的结果不会记入。",
  en: 'Run them in a call of their own, as its last command (a pipe after them is fine: npm test 2>&1 | tail -40). The runner\'s own exit status is read for you, so put nothing after it (no "; echo $?", no "|| true"), or the result is not recorded.',
};

export function minimalBackendContract(
  lang: "zh" | "en",
  workspaceHint?: string,
): string {
  const zh = [
    "你是板砖，黑塔的差分协处理器——负责实际动手的软件工程师助手。",
    "开拓者（用户）在和黑塔对话；凡是要读文件、改代码、跑命令的活，开拓者或黑塔会在话里写 @板砖 派给你，你收到的任务就是开拓者的原话。",
    "你不和开拓者说话，也不扮演黑塔。你的产出是仓库里的改动和命令的结果；分析得出的结论要用 report_finding 逐条记下（claim 用中文写，附 path:line 出处），要给人看某几行时用 show_excerpt——你最后一条消息里的文字没有人会看到。",
    ...(workspaceHint !== undefined && workspaceHint.length > 0
      ? [
          `工作区：${workspaceHint}。bash 一开始就在工作区里，目录和变量在命令之间保持，不必每条命令都先 cd。搜索代码优先用 git grep -n（只搜已跟踪文件）；跑测试用 npm test 或 node --test。${TEST_RUN_HINT.zh}`,
        ]
      : []),
  ];
  const en = [
    "You are Brick (板砖), Herta's differential coprocessor — the software engineer assistant that does the hands-on work.",
    "The user is talking with Herta; whenever a task means reading files, changing code or running commands, the user or Herta hands it to you by writing @Brick (or @板砖) in the conversation, and what you receive is the user's own words.",
    "You do not speak to the user and you do not play Herta. Your output is the changes in the repository and the results of the commands you run; record analytical conclusions one by one with report_finding (claim in English, cite path:line), and use show_excerpt when someone needs to see specific lines — the text of your final message is seen by no one.",
    ...(workspaceHint !== undefined && workspaceHint.length > 0
      ? [
          `Workspace: ${workspaceHint}. bash starts inside it and keeps its directory and variables between commands — no need to cd first every time. Search code with git grep -n (tracked files only); run tests with npm test or node --test. ${TEST_RUN_HINT.en}`,
        ]
      : []),
  ];
  return (lang === "en" ? en : zh).join("\n");
}

/**
 * Host-environment note for macOS (ADR 0044 amended — platform review
 * 2026-09-23). The Windows note that used to sit beside it told the standard
 * set there was no bash; with no bash there is now no backend (ADR 0086).
 *
 * The backend's training bias is GNU/Linux, and a Mac's command line is BSD:
 * `sed -i 's/a/b/' f` is an error there (and `sed -i -e …` leaves `f-e`
 * backup files behind), `grep -P`, `date -d`, `stat -c`, `find -printf` and
 * `timeout` are missing or different, and Apple's /bin/bash is 3.2 — no
 * associative arrays, `mapfile`, `${x,,}` or `globstar`. Each of those is a
 * failed command and a retry the user watches, so the note says what the host
 * is: the shell 板砖 works in IS the BSD userland. Text only; the wiring
 * decides when it applies.
 */
export function darwinBackendHostNote(lang: "zh" | "en"): string {
  return lang === "en"
    ? `# Host environment

This machine runs macOS. Its command-line tools are the BSD versions, not
GNU: \`sed -i\` needs an explicit empty suffix (\`sed -i '' 's/a/b/' file\`),
and \`grep -P\`, \`date -d\`, \`stat -c\`, \`find -printf\` and \`timeout\` are
missing or behave differently. Apple's /bin/bash is version 3.2 (check
\`echo $BASH_VERSION\`): no \`declare -A\`, \`mapfile\`, \`\${var,,}\` or
\`globstar\`. Prefer portable POSIX forms.`
    : `# 主机环境

这台机器是 macOS，命令行工具是 BSD 版本，不是 GNU：\`sed -i\` 必须带一个空后缀
（\`sed -i '' 's/a/b/' file\`）；\`grep -P\`、\`date -d\`、\`stat -c\`、\`find -printf\`
和 \`timeout\` 不存在或行为不同。苹果自带的 /bin/bash 是 3.2 版（\`echo $BASH_VERSION\`
可查）：没有 \`declare -A\`、\`mapfile\`、\`\${var,,}\` 和 \`globstar\`。优先用可移植的
POSIX 写法。`;
}

/** A repo operation the working tree is in the middle of (ADR 0049 §1). */
export type RepoInProgressState =
  | "merge"
  | "rebase"
  | "cherry-pick"
  | "revert"
  | "bisect";

/** One uncommitted path with its porcelain XY status, for the snapshot. */
export interface RepoContextDirtyFile {
  /** Index (staged) status column, " " when unchanged. */
  readonly x: string;
  /** Worktree status column, " " when unchanged. */
  readonly y: string;
  readonly path: string;
}

/**
 * What the repo looked like when the dispatch started (ADR 0049 §2) —
 * the structured input the builder renders into the frame's repo-snapshot
 * section. Produced by the git probe in `@herta/tools` (core cannot import
 * tools); every field is best-effort and the whole snapshot is optional:
 * no repo, no git, or a probe failure simply omits the section.
 *
 * This is PROMPT context, not record: the user's record gets real
 * `git_status` blocks when git work happens. The section exists so the
 * backend stops spending tool calls rediscovering facts the harness
 * already held at brief start.
 */
export interface RepoContextSnapshot {
  /** The working tree's top-level directory as git spells it (absolute,
   *  forward slashes even on Windows). */
  readonly root: string;
  /** The workspace's path INSIDE the repository — `git rev-parse
   *  --show-prefix`: `packages/gui/` (trailing slash), "" when the
   *  workspace is the root. `dirty` / `conflicted` keep git's root-relative
   *  spelling; readers that resolve against the workspace rebase them with
   *  `workspaceRelativeRepoPath` (ADR 0058 amendment, 2026-09-07). */
  readonly prefix: string;
  /** The (per-worktree) git dir, absolute — what a watcher follows for
   *  commits, checkouts and fetches made outside the app. Null when it
   *  could not be located without spawning. */
  readonly gitDir: string | null;
  /** Current branch name, or null when detached / unknowable. */
  readonly branch: string | null;
  /** HEAD is not on any branch. */
  readonly detached: boolean;
  /** Short commit id of HEAD, or null on an unborn branch. */
  readonly headShort: string | null;
  /** The tracked upstream ref (e.g. "origin/main"), or null when unset. */
  readonly upstream: string | null;
  /** The upstream is set but its ref is gone (deleted on the remote, ADR
   *  0058 §7): the counts read 0 only because git cannot measure against
   *  it, and every commit here is unpublished. */
  readonly upstreamGone: boolean;
  readonly ahead: number;
  readonly behind: number;
  /** The remote's default branch (from origin/HEAD), or null when unset. */
  readonly defaultBranch: string | null;
  /** An operation mid-flight (merge/rebase/…), or null when none. */
  readonly inProgress: RepoInProgressState | null;
  /** Paths with unmerged (conflict) status. Bounded by the producer. */
  readonly conflicted: readonly string[];
  /** Uncommitted paths (staged, unstaged, untracked). Bounded by the
   *  producer; `dirtyTotal` keeps the true count. */
  readonly dirty: readonly RepoContextDirtyFile[];
  readonly dirtyTotal: number;
  /** `<short sha> <subject>` lines, newest first, bounded by the producer —
   *  the frame's text form of `recentCommits`. */
  readonly recentSubjects: readonly string[];
  /** The same commits, structured, for the rail card (ADR 0058 §5.4/§5.6):
   *  the card draws id, subject and an unpushed mark apart. */
  readonly recentCommits: readonly RepoRecentCommit[];
}

/** One recent commit as the card draws it. */
export interface RepoRecentCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  /** Not on the tracked upstream yet (false when there is no upstream). */
  readonly unpushed: boolean;
}

/**
 * Render the repo snapshot as one bounded prompt section (ADR 0049 §2).
 * Exported for tests. The full-status pointer names what the model can
 * actually run, `git status` in bash, so the honest-truncation line never
 * recommends a tool it cannot call.
 */
/** Recent subjects the FRAME renders; the snapshot may carry more. */
const MAX_PROMPT_SUBJECTS = 5;

export function renderRepoContext(
  snapshot: RepoContextSnapshot,
  lang: "zh" | "en",
): string {
  const zh = lang !== "en";
  const statusPointer = zh
    ? "在 bash 里跑 git status 看全量"
    : "run git status in bash for the full set";

  const lines: string[] = [
    zh ? "# 仓库快照" : "# Repo snapshot",
    zh
      ? "（本次派活开始时采集；你开始改动后即过期，以工具的实时结果为准。）"
      : "(taken when this dispatch started; stale once you start changing things — trust live tool output.)",
  ];

  // Branch line: detached and unborn are stated plainly rather than dressed
  // up as a branch that isn't there.
  if (snapshot.detached) {
    const at = snapshot.headShort ?? "?";
    lines.push(
      zh ? `分支: 游离 HEAD @ ${at}` : `branch: detached HEAD @ ${at}`,
    );
  } else if (snapshot.branch !== null) {
    const name = snapshot.branch;
    if (snapshot.headShort === null) {
      lines.push(
        zh ? `分支: ${name}（尚无提交）` : `branch: ${name} (no commits yet)`,
      );
    } else if (snapshot.upstream !== null) {
      const counts = snapshot.upstreamGone
        ? zh
          ? "（上游已不存在，本地提交均未发布）"
          : " (upstream gone; nothing here is published)"
        : zh
          ? `（领先 ${snapshot.ahead}，落后 ${snapshot.behind}）`
          : ` (ahead ${snapshot.ahead}, behind ${snapshot.behind})`;
      lines.push(
        zh
          ? `分支: ${name} → ${snapshot.upstream}${counts}`
          : `branch: ${name} → ${snapshot.upstream}${counts}`,
      );
    } else {
      lines.push(
        zh ? `分支: ${name}（无上游）` : `branch: ${name} (no upstream)`,
      );
    }
  }
  if (snapshot.defaultBranch !== null) {
    lines.push(
      zh
        ? `默认分支: ${snapshot.defaultBranch}`
        : `default branch: ${snapshot.defaultBranch}`,
    );
  }

  // A workspace that is a SUBFOLDER of its repository: say so once, and
  // spell every path from the workspace — what the tools resolve against
  // and what `git status` prints from that cwd. A `../` path is outside the
  // workspace and outside the tools' reach; stating it beats a path that
  // resolves nowhere (ADR 0058 amendment, 2026-09-07).
  const prefix = snapshot.prefix;
  const spell = (p: string): string => workspaceRelativeRepoPath(p, prefix);
  if (prefix.length > 0) {
    lines.push(
      zh
        ? `仓库根目录: ${snapshot.root}（工作区是其中的 ${prefix}；下列路径相对工作区，../ 开头的在工作区之外）`
        : `repo root: ${snapshot.root} (the workspace is its ${prefix}; paths below are workspace-relative, ../ means outside the workspace)`,
    );
  }

  if (snapshot.inProgress !== null) {
    lines.push(
      zh
        ? `进行中的操作: ${snapshot.inProgress}`
        : `operation in progress: ${snapshot.inProgress}`,
    );
    if (snapshot.conflicted.length > 0) {
      const shown = snapshot.conflicted.map(spell).join(zh ? "、" : ", ");
      lines.push(
        zh
          ? `冲突文件 ${snapshot.conflicted.length} 个: ${shown}`
          : `conflicted (${snapshot.conflicted.length}): ${shown}`,
      );
    }
  }

  if (snapshot.dirtyTotal === 0) {
    lines.push(zh ? "未提交改动: 无" : "uncommitted changes: none");
  } else {
    lines.push(
      zh
        ? `未提交改动 ${snapshot.dirtyTotal} 项:`
        : `uncommitted changes (${snapshot.dirtyTotal}):`,
    );
    for (const f of snapshot.dirty) {
      lines.push(`${f.x}${f.y} ${spell(f.path)}`);
    }
    const omitted = snapshot.dirtyTotal - snapshot.dirty.length;
    if (omitted > 0) {
      lines.push(
        zh
          ? `（另有 ${omitted} 项未列出；${statusPointer}）`
          : `(${omitted} more not listed; ${statusPointer})`,
      );
    }
  }

  if (snapshot.recentSubjects.length > 0) {
    lines.push(zh ? "最近提交:" : "recent commits:");
    // The probe carries more for the rail's commit list (ADR 0058 §5.4);
    // the frame keeps the five it always had — prompt bytes are a budget.
    for (const s of snapshot.recentSubjects.slice(0, MAX_PROMPT_SUBJECTS))
      lines.push(`  ${s}`);
  }

  return lines.join("\n");
}

export interface BackendContextBuilderDeps {
  tools: ToolRegistry;
  /**
   * How the shell spells the workspace, for the contract's last
   * line — a GETTER because a session's workspace can change between
   * dispatches (`setWorkspace`) while the builder lives on. Undefined /
   * "" → the line is omitted.
   */
  workspaceHint?: () => string | undefined;
  /**
   * Host-environment section appended to the contract (ADR 0044). The WIRING
   * decides who gets one: `darwinBackendHostNote` on macOS (2026-09-23 — that
   * shell IS the BSD userland). Undefined / "" → the section is omitted and
   * the frame is byte-identical to before.
   */
  hostNote?: string;
}

export interface BackendBuildInput {
  brief: HertaToAgentBrief;
  /**
   * The user-only message history (any role !== "user" filtered out at
   * the actor side). The backend sees the user's actual words across
   * all turns in this session, not Herta's intermediate utterances.
   */
  userMessages: ReadonlyArray<{ text: string }>;
  /** Older user messages elided by the caller's caps (ADR 0025 slice 2);
   *  rendered as an honest elision note in the history header. */
  omittedUserMessages?: number;
  /** Pre-rendered recent user/Herta dialogue since the last dispatch (referent
   *  resolution). Rendered by the bridge; "" / undefined when absent. */
  recentDialogue?: string;
  /** Pre-rendered prior-dispatch working history (the backend's own done-marker
   *  outcomes). Rendered by the bridge; "" / undefined when absent. */
  workingHistory?: string;
  /** The session's interaction language (ADR 0016). "en" drives the backend's
   *  own prompt (contract, history framing, headers) in English; absent /
   *  "zh" keeps it Chinese, byte-identical to before. Only the backend's
   *  instructions localize — the received task content is verbatim either way. */
  lang?: "zh" | "en";
  /** The repo snapshot taken at brief start (ADR 0049 §2), rendered as one
   *  bounded section after the contract. Absent → section omitted, frame
   *  byte-identical to before (the `hostNote` pattern). */
  repoContext?: RepoContextSnapshot;
  scopedMemory: string;
  messages: readonly Message[];
}

/**
 * Pure constructor of `BackendPromptFrame` from explicit inputs.
 *
 * Runs no capsule activation pipeline by design — the caller decides the
 * scoped strings (`CodingAgentRuntime` renders the project memory at brief
 * start, ADR 0060; nothing populates the repo-instructions slot, per
 * CLAUDE.md's no-HERTA.md rule). This keeps the backend frame
 * deterministic and free of Herta-identity context.
 */
export class BackendContextBuilder {
  private readonly tools: ToolRegistry;
  private readonly workspaceHint: (() => string | undefined) | undefined;
  private readonly hostNote: string | undefined;

  constructor(deps: BackendContextBuilderDeps) {
    this.tools = deps.tools;
    this.workspaceHint = deps.workspaceHint;
    this.hostNote = deps.hostNote;
  }

  build(input: BackendBuildInput): BackendPromptFrame {
    const lang = input.lang ?? "zh";
    const userHistory = serializeUserHistory(
      input.userMessages,
      lang,
      input.omittedUserMessages ?? 0,
    );
    const base = minimalBackendContract(lang, this.workspaceHint?.());
    const contract =
      this.hostNote !== undefined && this.hostNote.length > 0
        ? `${base}\n\n${this.hostNote}`
        : base;
    const workingHeader =
      lang === "en" ? WORKING_HISTORY_HEADER_EN : WORKING_HISTORY_HEADER;
    const recentHeader =
      lang === "en" ? RECENT_DIALOGUE_HEADER_EN : RECENT_DIALOGUE_HEADER;
    const sections: string[] = [contract];
    if (input.repoContext !== undefined) {
      sections.push(renderRepoContext(input.repoContext, lang));
    }
    if (input.workingHistory !== undefined && input.workingHistory.length > 0) {
      sections.push(`${workingHeader}\n\n${input.workingHistory}`);
    }
    if (input.recentDialogue !== undefined && input.recentDialogue.length > 0) {
      sections.push(`${recentHeader}\n\n${input.recentDialogue}`);
    }
    if (userHistory.length > 0) sections.push(userHistory);
    return {
      backendSystem: sections.join("\n\n"),
      scopedMemory: input.scopedMemory,
      toolSchemas: this.tools.list().map((t) => t.schema()),
      messages: [...input.messages],
    };
  }
}
