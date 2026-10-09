/**
 * Session wiring shared by BOTH front-ends of the v0.2 runtime — the desktop
 * host (`SessionImpl.create`) and the dev CLI (`packages/cli/src/app/main.ts`).
 *
 * Until 2026-08-19 each bootstrap assembled the identical stack by hand —
 * tool registry + contract fallback, permission engine + rules, backend
 * context builder, runtime factory, static prefix + own-dream exclusions,
 * opening seed, router/supervisor providers, prompt dump, recap — with
 * "mirrors the other one" comments pointing both ways, and the mirror broke
 * once (the CLI fed an EN session the zh dream manifest). `buildRecapRuntime`
 * had already been extracted for exactly this reason; this module finishes
 * the job. What stays in each caller is what genuinely differs: how asks are
 * presented (stdout prompt vs GUI overlay), where speech streams (terminal
 * renderer vs bus sink), voice cues, titles.
 *
 * Two layers, two factories:
 *   - `createBackendStack`  — the silent 板砖 side (D6): tools, permissions,
 *     context builder, per-dispatch `CodingAgentRuntime` factory, event bus.
 *   - `createActorStack`    — Herta's side (D8): providers, static prefix,
 *     opening, meta-think/hints/supervisor, recap, prompt dump.
 * The caller constructs the `V2ActorDriver` from the two (its sink and voice
 * callbacks are the front-end's own).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentEvent,
  type AskResolver,
  BackendContextBuilder,
  type BackendContract,
  CodingAgentRuntime,
  type CompletionProviderAdapter,
  darwinBackendHostNote,
  dreamDirFor,
  type EventBus,
  errorMessage,
  InMemoryEventBus,
  InMemoryToolRegistry,
  narrativeDirFor,
  ProjectCommandRuleStore,
  type ProviderAdapter,
  RulePermissionEngine,
  SessionApprovalCache,
  type TerminalRecord,
  type TerminalRecordBlock,
  windowsBackendHostNote,
  wireTaskScopedApprovalCache,
} from "@herta/core";
import {
  type ActorHints,
  buildRecapRuntime,
  buildStaticHertaPrefix,
  type DriverSessionScope,
  loadActorHints,
  loadMetaThinkCorpus,
  type MetaThinkCorpus,
  materializeSeedFeian,
  type OpeningChoice,
  type PromptLang,
  pickOpening,
  type RecapRuntime,
  readRecapCache,
  type StaticHertaPrefix,
  type StaticPrefixRebuilder,
  supervisorReferenceFor,
  type V2ActorDriverDeps,
} from "@herta/herta";
// The narrow entry, NOT the package root: the root is the whole knowledge
// package — ingest, voice tooling, the SQLite store and its native addon —
// and cost the unbundled CLI ~470 ms on every start for these three names
// (measured 2026-09-21; see knowledge/src/dream-prompt.ts).
import {
  readManifest,
  resolveDreamConfig,
  selectPromptExclusions,
} from "@herta/knowledge/dream-prompt";
import { FileMemoryManager } from "@herta/memory";
import {
  type ApiKey,
  deepseekCompletionProvider,
  deepseekProvider,
} from "@herta/providers";
import {
  createMinimalTools,
  createMvpTools,
  type DigestModel,
  describeRepoContext,
  diffCommittedRange,
  digestToolFor,
  findBash,
  gitDiffTool,
  gitStatusTool,
  PersistentShell,
  primeShellPaths,
  probeRepoState,
  registerEditFileRule,
  registerMinimalRules,
  registerRunCommandRule,
  registerWriteNewFileRule,
  shellWorkspaceHint,
} from "@herta/tools";
import type { AppServerConfig } from "./types.js";

// The usage log (token counts per model call) — a host that builds its
// stacks by hand, as the CLI does, installs it from the same entry point.
// ADR 0075: the automatic reviewer — the desktop session mounts it itself;
// the CLI, a front-end over this same wiring, mounts it from here.
export {
  AutoReviewer,
  defaultReviewModel,
  type ReviewDeps,
  reviewBeforeCard,
} from "./auto-review.js";
export { installUsageLog } from "./usage-log.js";

// ── Backend stack ───────────────────────────────────────────────────────────

/**
 * The BACKEND provider makes no transport retries of its own (2026-09-03).
 *
 * Two retry layers used to stack: the provider's `retryPost` retried a 429
 * or 5xx twice per call (0.5 s, 1 s), and the backend turn loop's
 * `BackendRetryState` then retried the whole call up to three more times
 * with 2/4/8/16 s backoff — so one persistent rate limit cost twelve full-
 * prompt POSTs of the backend frame and half a minute before `provider_failed`,
 * against an API that was already saying "slow down". The loop's policy is
 * the one designed for this (named reasons, jittered backoff, a hard cap), so
 * the backend provider runs with the transport layer's retries off and lets
 * the policy pace. The actor and the sidecars keep the provider default —
 * they have no loop above them.
 */
export const BACKEND_PROVIDER_MAX_RETRIES = 0;

/**
 * The backend (板砖) model's provider, built the ONE way both hosts build it
 * (2026-09-03). The desktop session and the CLI each spelled this out —
 * model, thinking level, the retry constant, the base-URL lever — and the
 * two had already parted on a neighbour (the vision rule below). What
 * differs per host stays with the host: WHERE the model name and the
 * thinking level come from (Settings vs. env). `thinking` accepts the
 * Settings vocabulary ("off") and the CLI's (`false`) alike; absent →
 * "high". Per the DeepSeek doc (2026-09-10) both `deepseek-flash` and
 * `deepseek-v4-pro` take low / high / max; thinking is on by default at
 * "high" when the block is omitted.
 */
export function createBackendProvider(opts: {
  readonly apiKey: ApiKey;
  readonly model: string;
  readonly thinking?: "low" | "high" | "max" | "off" | false;
  /** The dev-only chaos/staging base URL (see AppServerConfig.providers). */
  readonly baseUrl?: string;
  /** Test seam. */
  readonly fetchImpl?: typeof fetch;
}): ProviderAdapter {
  return deepseekProvider({
    apiKey: opts.apiKey,
    model: opts.model,
    thinking:
      opts.thinking === "off" || opts.thinking === false
        ? false
        : (opts.thinking ?? "high"),
    // The turn loop's retry policy paces a rate limit; the transport must
    // not stack its own retries under it (see the constant).
    maxRetries: BACKEND_PROVIDER_MAX_RETRIES,
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
}

/**
 * Whether the backend MODEL can read a picture (ADR 0048 §5). Derived from
 * the model name rather than a separate setting — the capability IS the
 * model, and two switches that could disagree would eventually disagree.
 * Since the 2026-09 API the flash itself reads images: `deepseek-flash`
 * (V4.1 Flash) sees, and so does the retired `deepseek-v4-flash-vision-exp`
 * DeepSeek still serves with it (the substring rule this started with).
 * `deepseek-v4-pro` does NOT — and no longer answers an image with a 400
 * either: it replies that it cannot see the picture (probe 2026-09-10), so
 * mounting `view_image` on it would let 板砖 "look" and be told nothing.
 * One rule for both hosts (2026-09-03): `createBackendStack` applies it
 * itself from the model name it is handed.
 */
export function isVisionModel(model: string): boolean {
  return model === "deepseek-flash" || model.includes("vision");
}

/** The digest tool's side model as both hosts mount it (ADR 0043): the
 *  flash sidecar over the same key and base URL as everything else. */
export function defaultDigestModel(
  apiKey: ApiKey,
  baseUrl: { baseUrl?: string } = {},
): DigestModel {
  return digestModelFrom(makeDigestProvider(apiKey, baseUrl));
}

/**
 * The digest tool's side model (ADR 0043): one chat call in, plain text out.
 * Flash with thinking OFF — a chunk summary is extraction, not reasoning,
 * and the reasoning chain would cost more tokens than the answer (the title
 * provider's lesson: a reasoning model's maxTokens must cover the chain).
 * `maxTokens` bounds a runaway summary; `temperature` low for stability
 * across the parallel calls. Built from a ProviderAdapter so the chaos
 * proxy / provider overrides see it like every other sidecar.
 */
export function digestModelFrom(provider: ProviderAdapter): DigestModel {
  return async ({ system, user }, signal) => {
    let out = "";
    for await (const ev of provider.streamChat(
      {
        stableSystem: system,
        repoInstructions: "",
        memoryContext: "",
        retrievedLore: "",
        messages: [{ role: "user", text: user, ts: new Date().toISOString() }],
        toolSchemas: [],
      },
      signal,
    )) {
      if (ev.type === "text-delta") out += ev.text;
      else if (ev.type === "finish") {
        if (ev.reason === "error") throw new Error("digest model error");
        break;
      }
    }
    return out;
  };
}

export function makeDigestProvider(
  apiKey: ApiKey,
  baseUrl: { baseUrl?: string } = {},
): ProviderAdapter {
  return deepseekProvider({
    apiKey,
    model: "deepseek-flash",
    thinking: false,
    maxTokens: 1024,
    temperature: 0.2,
    ...baseUrl,
  });
}

export interface BackendStackOpts {
  /** The ONE mutable holder of the effective 板砖 workspace. Shared with the
   *  caller (setWorkspace / `/workspace set` mutate `.current`); every
   *  per-dispatch reader below reads it fresh. Never reassign the holder. */
  readonly wsHolder: { current: string };
  /** Record-store anchor (project memory lives under it). */
  readonly workspaceRoot: string;
  readonly lang: PromptLang;
  /** The contract the caller asked for (ADR 0040). `minimal` needs a bash on
   *  this machine; without one the stack runs `standard` and reports it via
   *  `contract` / `bashPath` so the caller can warn where it sees fit. */
  readonly wantMinimal: boolean;
  readonly backendProvider: ProviderAdapter;
  /** The backend model's NAME, beside its provider: the stack derives from
   *  it whether the model can read images (ADR 0048 §5, `isVisionModel`) and
   *  mounts `view_image` accordingly — so a visual question can be answered
   *  by a RE-LOOK rather than by the attachment caption's one-shot reading.
   *  Was a caller-supplied `vision` flag until 2026-09-03; the two hosts
   *  had each derived it their own way. */
  readonly backendModel: string;
  /** The digest tool's side model (ADR 0043); null mounts the tool as
   *  `unavailable` (no key, tests). */
  readonly digestModel: DigestModel | null;
  /** Test seam for the host-note decision (ADR 0044); defaults to
   *  `process.platform`. On "win32" the STANDARD contract carries
   *  `windowsBackendHostNote` — the minimal contract never does (it runs on
   *  bash by construction). */
  readonly platform?: NodeJS.Platform;
  /** Builds the front-end's ask resolver once the cache and rule store it
   *  consults exist. The returned resolver is the permission engine's. */
  readonly makeAsk: (deps: {
    readonly cache: SessionApprovalCache;
    readonly rules: ProjectCommandRuleStore;
  }) => AskResolver;
  /** The steer source (ADR 0063) every dispatch's runtime drains at its
   *  loop head — the session's `SteerChannel`. Absent (the CLI): no steer. */
  readonly pendingUserInput?: () => readonly string[];
  /** Where this session keeps its run journal (ADR 0071; see
   *  `dispatchJournalPath`). Absent (the CLI): no journal is kept. */
  readonly journalPath?: string;
  /** Where this session keeps what 板砖's editors replace, for undo (ADR
   *  0074; see `undoStoreDir`). Absent (the CLI): nothing is kept. */
  readonly undoDir?: string;
  /** Whether the session already holds an attached document (a reopened
   *  record with attachment rows). Mounts `digest_document` at build; a
   *  session without one gets it from `mountDigestTool` when the first
   *  document lands (ADR 0067). Absent = false (the CLI never attaches). */
  readonly attachmentsPresent?: boolean;
}

export interface BackendStack {
  readonly contract: BackendContract;
  /** The bash the minimal contract runs on; null when none was found or the
   *  standard contract was requested. */
  readonly bashPath: string | null;
  /** Single shared bus across actor, backend, renderer and permission rules. */
  readonly bus: EventBus<AgentEvent>;
  readonly approvalCache: SessionApprovalCache;
  readonly commandRules: ProjectCommandRuleStore;
  readonly permissions: RulePermissionEngine;
  readonly backendTools: InMemoryToolRegistry;
  readonly backendBuilder: BackendContextBuilder;
  readonly memory: FileMemoryManager;
  /** Per-invocation `CodingAgentRuntime` (per ADR 0007): each `@板砖`
   *  dispatch gets a fresh one, reading the workspace holder at call time. */
  readonly runtimeFactory: () => CodingAgentRuntime;
  /** Mount `digest_document` (ADR 0067) — idempotent. The session calls it
   *  when the first document is attached; the builder lists tools per
   *  brief, so the next dispatch sees it. */
  readonly mountDigestTool: () => void;
  /** Re-decide the git tools from the CURRENT workspace (ADR 0067): mounted
   *  inside a git repository, unmounted outside. Standard contract only —
   *  the minimal contract's bash runs git itself. The session calls it after
   *  a workspace move; a no-op when nothing changes. */
  readonly refreshGitTools: () => void;
}

/** A workspace is "inside a git repository" when it carries a `.git` entry
 *  (a directory, or the file a worktree keeps). Cheap and synchronous: the
 *  decision is made at build and at a workspace move, never per call. */
export function hasGitDir(workspace: string): boolean {
  return existsSync(join(workspace, ".git"));
}

/**
 * What `createBackendStack` would otherwise have to find out while holding
 * the thread: how this machine's bash spells `/tmp` (one bash start, Windows
 * only). The stack build is synchronous and, in the desktop app, runs on
 * the main thread — a host awaits this first and the build finds the answer
 * cached. Optional: a host that skips it gets the same stack, just slower.
 * Never rejects.
 */
export function prepareBackendStack(opts: {
  readonly wantMinimal: boolean;
}): Promise<void> {
  return opts.wantMinimal ? primeShellPaths(findBash()) : Promise.resolve();
}

/** Which host note a session's backend frame carries (ADR 0044, amended
 *  2026-09-23), as a spreadable deps fragment. Exported for its tests. */
export function hostNoteFor(
  platform: NodeJS.Platform,
  contract: BackendContract,
  lang: "zh" | "en",
): { hostNote?: string } {
  if (platform === "win32" && contract === "standard") {
    return { hostNote: windowsBackendHostNote(lang) };
  }
  if (platform === "darwin") return { hostNote: darwinBackendHostNote(lang) };
  return {};
}

export function createBackendStack(opts: BackendStackOpts): BackendStack {
  const { wsHolder, lang } = opts;

  // Approval cache + project rules first: the ask resolver consults them.
  const approvalCache = new SessionApprovalCache();
  // Project-scoped command allow rules (ADR 0030) — persisted under the
  // EFFECTIVE workspace's .herta/permissions.json. Reads the holder so a
  // mid-session workspace change re-anchors the rules with the workspace.
  const commandRules = new ProjectCommandRuleStore(() => wsHolder.current);
  const ask = opts.makeAsk({ cache: approvalCache, rules: commandRules });
  const permissions = new RulePermissionEngine({ ask });

  const memory = new FileMemoryManager({ workspaceRoot: opts.workspaceRoot });

  const bus = new InMemoryEventBus<AgentEvent>();
  // Task-scope approval lifetime (ADR 0026): the remember cache clears when
  // each backend brief ends, so a remembered allow never outlives the task.
  wireTaskScopedApprovalCache(bus, approvalCache);

  // Tool registry — the contract asked for (ADR 0040): the trained two-tool
  // shape (+ the two record channels) when a bash exists, else the standard
  // set.
  const bashPath = opts.wantMinimal ? findBash() : null;
  const contract: BackendContract =
    opts.wantMinimal && bashPath !== null ? "minimal" : "standard";
  const backendTools = new InMemoryToolRegistry();
  // The shell's own spelling of the workspace, read fresh per schema /
  // prompt build so a mid-session workspace change is reflected.
  const workspaceShellPath = (): string =>
    bashPath === null
      ? wsHolder.current
      : new PersistentShell({ bashPath, workspaceRoot: wsHolder.current })
          .workspaceShellPath;
  // Whether the backend MODEL can read a picture (ADR 0048 §5). Mounts
  // `view_image` on either contract; false everywhere else, so a model
  // without vision is never told it can look.
  const vision = isVisionModel(opts.backendModel);
  // The toolset follows the environment, per session (ADR 0067): the
  // digest tool waits for a document, the git tools for a repository. Both
  // decisions are made here and at the two events that change them —
  // never per turn, since the tools array heads the cached prefix.
  if (contract === "minimal") {
    for (const t of createMinimalTools({
      bashPath: bashPath as string,
      workspaceShellPath,
      digestModel: opts.digestModel,
      lang,
      vision,
      digest: false,
    }))
      backendTools.register(t);
  } else {
    for (const t of createMvpTools({
      digestModel: opts.digestModel,
      lang,
      vision,
      digest: false,
      gitTools: hasGitDir(wsHolder.current),
    }))
      backendTools.register(t);
  }
  const mountDigestTool = (): void => {
    if (backendTools.get("digest_document") !== undefined) return;
    backendTools.register(
      digestToolFor({ digestModel: opts.digestModel, lang, bashPath }),
    );
  };
  if (opts.attachmentsPresent === true) mountDigestTool();
  const refreshGitTools = (): void => {
    if (contract !== "standard") return;
    const want = hasGitDir(wsHolder.current);
    const have = backendTools.get("git_status") !== undefined;
    if (want && !have) {
      backendTools.register(gitStatusTool());
      backendTools.register(gitDiffTool());
    } else if (!want && have) {
      backendTools.unregister("git_status");
      backendTools.unregister("git_diff");
    }
  };

  const backendBuilder = new BackendContextBuilder({
    tools: backendTools,
    contract,
    workspaceHint: () =>
      contract === "minimal"
        ? shellWorkspaceHint(bashPath, wsHolder.current, lang)
        : undefined,
    // ADR 0044: the standard contract on Windows says what the host is —
    // without it the backend's Unix habits (grep/sed/ls) are a not_found
    // each, which is what a bash-less machine's user reads as "很多命令
    // 执行不了". win32 standard only. macOS (amended 2026-09-23): BOTH
    // contracts, because the GNU habits (`sed -i`, `grep -P`, bash-4 syntax)
    // fail in the Mac's BSD shell as much as through run_command. Per
    // SESSION, like the toolset (ADR 0067) — never a per-turn prompt change.
    // The note texts live in core.
    ...hostNoteFor(opts.platform ?? process.platform, contract, lang),
  });

  // Permission rules attach to the shared engine.
  if (contract === "minimal") {
    registerMinimalRules(permissions, { bus, bashPath });
  } else {
    registerEditFileRule(permissions, { bus });
    registerWriteNewFileRule(permissions, { bus });
    registerRunCommandRule(permissions);
  }

  const runtimeFactory = (): CodingAgentRuntime =>
    new CodingAgentRuntime({
      sessionId: randomUUID(),
      provider: opts.backendProvider,
      tools: backendTools,
      permissions,
      backendBuilder,
      bus,
      clock: () => new Date(),
      // Read fresh from the shared holder so a mid-session workspace change
      // is picked up on the next dispatch.
      workspaceRoot: wsHolder.current,
      memory,
      // The dispatch baseline (2026-08-25). INJECTED because the probe needs
      // git and core cannot import `@herta/tools` — tools already depends on
      // core, so importing the other way would close a cycle. Without it the
      // report only ever learns about a path from one of the three editors,
      // and `bash` is not one of them: on the DEFAULT contract every shell
      // write, move and delete was invisible to `changedFiles`.
      repoProbe: (signal) => probeRepoState(wsHolder.current, signal),
      // The baseline's second half (2026-08-26): attribute the committed
      // range when this dispatch moved HEAD forward, instead of refusing
      // attribution on every brief that ends in a commit.
      repoRangeDiff: (from, to, signal) =>
        diffCommittedRange(wsHolder.current, from, to, signal),
      // The frame's repo-snapshot section (ADR 0049 §2): gathered once at
      // brief start beside the baseline, so the backend stops spending tool
      // calls rediscovering branch/state the harness already held.
      repoContext: (signal) => describeRepoContext(wsHolder.current, signal),
      // The steer source (ADR 0063): one channel per session, read by every
      // dispatch's loop at the top of each iteration.
      ...(opts.pendingUserInput !== undefined
        ? { pendingUserInput: opts.pendingUserInput }
        : {}),
      // The run journal (ADR 0071): one per session, each dispatch replaces
      // it; the contract rides along so a resumed run can tell it still fits.
      ...(opts.journalPath !== undefined
        ? { journalPath: opts.journalPath }
        : {}),
      // The undo store (ADR 0074): what the editors replace, per segment.
      ...(opts.undoDir !== undefined ? { undoDir: opts.undoDir } : {}),
      contract,
    });

  return {
    contract,
    bashPath,
    bus,
    approvalCache,
    commandRules,
    permissions,
    backendTools,
    backendBuilder,
    memory,
    runtimeFactory,
    mountDigestTool,
    refreshGitTools,
  };
}

// ── Actor stack ─────────────────────────────────────────────────────────────

/** The shipped default of ADR 0065's fast veto path: ON. Set by the lab
 *  (`scripts/respeak-lab.mjs` config `sup-revise` + `respeak-judge.mjs`,
 *  2026-09-17): the supervisor's corrected line won 10 of 12 blind pairs
 *  against the actor's rethink + respeak and tied the other 2, every line
 *  usable, ~5 s less on the veto path's mean. The ADR keeps the numbers;
 *  `HERTA_SUPERVISOR_REVISION=0` restores the two-stage path. */
const SUPERVISOR_REVISION_DEFAULT = true;

/** `HERTA_SUPERVISOR_REVISION=1|0` overrides the shipped default in both
 *  front-ends — the lab's A/B lever and the operator's escape hatch. */
function supervisorRevisionDefault(): boolean {
  const raw = process.env.HERTA_SUPERVISOR_REVISION;
  if (raw === "1") return true;
  if (raw === "0") return false;
  return SUPERVISOR_REVISION_DEFAULT;
}

/** Test-only seams (the app-server's `SessionInternalDeps` thread these
 *  through); production callers omit them. */
export interface ActorStackOverrides {
  readonly actorProvider?: CompletionProviderAdapter;
  readonly routerProvider?: ProviderAdapter;
  readonly supervisorProvider?: ProviderAdapter;
  /** Skip the async static-prefix disk scan AND the seed-废案 materialization. */
  readonly staticPrefix?: StaticHertaPrefix;
  readonly metaThink?: MetaThinkCorpus;
  readonly supervisorReference?: string;
  /** `null` → explicitly no opening; undefined → the real `pickOpening`. */
  readonly opening?: OpeningChoice | null;
}

export interface ActorStackOpts {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly lang: PromptLang;
  /** The record a reopened session loads (own-dream exclusions; no opening).
   *  Empty for a new session. */
  readonly initialRecord: TerminalRecord;
  readonly apiKey: ApiKey;
  /** Dev-only chaos/staging lever; spread into every provider built here. */
  readonly baseUrl?: string;
  /** Supervisor toggle (default ON in both front-ends). */
  readonly supervisorEnabled: boolean;
  /** ADR 0065: the supervisor's corrected line stands in for the actor's
   *  rethink + respeak on a veto. Undefined → the shipped default, unless
   *  `HERTA_SUPERVISOR_REVISION` overrides it (`1` on, `0` off — the lab's
   *  A/B lever and the operator's escape hatch). */
  readonly supervisorRevision?: boolean;
  /** Dream config for the reopen own-dream filter (app-server settings;
   *  the CLI passes nothing → defaults). */
  readonly dream?: AppServerConfig["dream"];
  /** Where `HERTA_DUMP_PROMPTS` writes `<sessionId>.prompts/` (transcript dir). */
  readonly promptDumpDir: string;
  /** A disk-loaded few-shot was rejected — a fact about the workspace's
   *  files, surfaced by the caller (CLI: stderr). */
  readonly onFewShotDropped?: (name: string, reason: string) => void;
  /** Prompt-dump lifecycle notes (CLI prints them; the host stays silent). */
  readonly onPromptDump?: (note: string) => void;
  readonly overrides?: ActorStackOverrides;
}

export interface ActorStack {
  readonly actorProvider: CompletionProviderAdapter;
  readonly routerProvider: ProviderAdapter;
  readonly supervisorProvider: ProviderAdapter;
  /** The static prefix with the opening's preamble (if any) folded in —
   *  ready for `V2ActorDriverDeps.staticPrefix`. */
  readonly staticPrefix: StaticHertaPrefix;
  /** The picked opening (new sessions only) — its voice pairing is the
   *  caller's concern. */
  readonly opening: OpeningChoice | undefined;
  /** The opening's seed line as TerminalRecord block 0 (stamped at
   *  construction so the in-memory seed matches the persisted one), or null
   *  when there is no opening. The caller decides whether to load it into
   *  the driver immediately (CLI) or stream it in (host). */
  readonly seedBlock: TerminalRecordBlock | null;
  readonly metaThinkCorpus: MetaThinkCorpus;
  /** Resolved `supervisorRevision` (ADR 0065) for `V2ActorDriverDeps`. */
  readonly supervisorRevision: boolean;
  /** Whether the driver starts the first thought while the router is still
   *  classifying (ADR 0066 amendment 2026-09-21) — on unless
   *  `HERTA_SPECULATIVE_THOUGHT=0`. For `V2ActorDriverDeps`. */
  readonly speculativeThought: boolean;
  readonly actorHints: ActorHints;
  readonly supervisorReference: string;
  readonly recap: RecapRuntime;
  readonly onPrompt: V2ActorDriverDeps["onPrompt"];
  /** ADR 0069 §1, for `V2ActorDriverDeps`: re-derives the prefix at a step
   *  event. Undefined when the prefix is overridden (tests). */
  readonly rebuildStaticPrefix: StaticPrefixRebuilder | undefined;
  /** The recap boundary `staticPrefix` was derived against. */
  readonly prefixRecapBoundary: number;
  /** ADR 0069 §3: the session-scoped parts for ANOTHER session of this
   *  workspace and language — its prefix and exclusions, its recap runtime,
   *  its rebuilder. The CLI's in-REPL `/resume` rebinds the driver with
   *  them instead of keeping the boot session's. */
  readonly sessionScope: (
    sessionId: string,
    record: TerminalRecord,
  ) => Promise<DriverSessionScope>;
}

export async function createActorStack(
  opts: ActorStackOpts,
): Promise<ActorStack> {
  const { workspaceRoot, sessionId, lang, initialRecord } = opts;
  const overrides = opts.overrides ?? {};
  const baseUrl = opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {};

  // Fresh-workspace bootstrap (M-prompts-1): materialize the compiled seed
  // 废案 into the live narrative dir so the static prefix below finds a
  // starting memory corpus. No-op once ANY 废案 exists (never resurrects
  // cap-evicted seeds). Skipped when the prefix is overridden (tests).
  if (overrides.staticPrefix === undefined) {
    await materializeSeedFeian(workspaceRoot, lang);
  }

  // Static Herta prefix (bio/env compiled in; 废案 from the live, lang-aware
  // narrative dir — an EN session reads .herta/narrative-en, not the zh
  // corpus; must stay consistent with buildStaticHertaPrefix's lang-derived
  // relPath prefix), with the reopen own-dream filter applied: 废案 distilled
  // from the session's OWN episodes stay out while their source content is
  // still verbatim in its record (behind the recap boundary they return as
  // recovered memory). Derived at open, and again at each step event
  // (ADR 0069 §1) against the record and boundary of that moment.
  const derivePrefix = (
    sid: string,
    record: TerminalRecord,
    recapBoundaryIndex: number,
  ): Promise<StaticHertaPrefix> => {
    const excludeFewShotFiles =
      record.length > 0
        ? ownDreamExclusions({
            workspaceRoot,
            sessionId: sid,
            record,
            dream: opts.dream,
            lang,
            recapBoundaryIndex,
          })
        : undefined;
    return buildStaticHertaPrefix({
      workspaceRoot,
      lang,
      // ALWAYS log a dropped few-shot (ADR 0051): the 2026-08-06 guard
      // regression silently dropped the entire 废案 corpus for 25 days
      // because only the CLI passed a logger and the GUI path had none —
      // a voice-defining failure with zero observable signal. The caller's
      // handler (when given) still runs; the warn is the floor, not the
      // ceiling.
      onFewShotDropped: (name, reason) => {
        console.warn(`few-shot dropped from prefix: ${name} — ${reason}`);
        opts.onFewShotDropped?.(name, reason);
      },
      readFile: async (relPath) =>
        readFile(join(workspaceRoot, relPath), "utf-8"),
      readNarrativeDir: async () => {
        try {
          return await readdir(narrativeDirFor(workspaceRoot, lang));
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === "ENOENT") return [];
          throw err;
        }
      },
      ...(excludeFewShotFiles !== undefined ? { excludeFewShotFiles } : {}),
    });
  };
  // A rebuild keeps what the session-scoped prefix carries besides the
  // corpus: a new session's opening preamble stays for the session's life.
  // No rebuilder when the prefix is a test override — there is no corpus
  // behind it to follow.
  const rebuilderFor = (sid: string): StaticPrefixRebuilder | undefined =>
    overrides.staticPrefix !== undefined
      ? undefined
      : async ({ record, recapBoundaryIndex, current }) => {
          const next = await derivePrefix(sid, record, recapBoundaryIndex);
          return current.opening !== undefined
            ? { ...next, opening: current.opening }
            : next;
        };

  const prefixRecapBoundary =
    initialRecord.length > 0
      ? cachedRecapBoundary(workspaceRoot, sessionId, initialRecord)
      : 0;
  const staticPrefix: StaticHertaPrefix =
    overrides.staticPrefix ??
    (await derivePrefix(sessionId, initialRecord, prefixRecapBoundary));

  // Opening (new sessions only — a resumed record already carries block 0).
  // The preamble is session-zero scaffolding visible only to the model: it
  // folds into the static prefix and never enters the TerminalRecord (Slice
  // 8 §3 decision B); the seed line becomes record block 0.
  const opening: OpeningChoice | undefined =
    initialRecord.length > 0
      ? undefined
      : overrides.opening !== undefined
        ? (overrides.opening ?? undefined)
        : pickOpening({ lang });
  const effectiveStaticPrefix: StaticHertaPrefix =
    opening !== undefined
      ? { ...staticPrefix, opening: opening.preamble }
      : staticPrefix;
  const seedBlock: TerminalRecordBlock | null =
    opening !== undefined
      ? {
          kind: "herta",
          surface: "speech",
          text: opening.seedText,
          at: new Date().toISOString(),
        }
      : null;

  // Providers. Router: flash with thinking OFF (router lab 2026-09-17,
  // `scripts/router-lab.mjs`: flash 4.1 routed 33/33 graded samples both
  // with and without thinking; off ran 670 ms mean / 1.3 s max against
  // 915 ms / 2.8 s at "low"). "low" had been the floor since 2026-08-03
  // because flash 4.0 could not classify without thinking — that failure
  // shape (empty output, schema metalanguage) did not recur in 39 calls.
  // The router sits on every turn's critical path, so the tail matters.
  // Supervisor: its own flash adapter at "high" — a precision gate (misses
  // buried-rule shapes ~1/3 even at high, trigger-gate 2026-07-29); the
  // recap summarizer rides this adapter for the same reason.
  const actorProvider =
    overrides.actorProvider ??
    deepseekCompletionProvider({ apiKey: opts.apiKey, ...baseUrl });
  const routerProvider =
    overrides.routerProvider ??
    deepseekProvider({
      apiKey: opts.apiKey,
      model: "deepseek-flash",
      thinking: false,
      ...baseUrl,
    });
  // Test seam preserved: with only a router override present, the
  // supervisor (and recap, which takes this adapter) still receive that
  // stub — stub-session tests rely on one stub covering all three roles.
  const supervisorProvider =
    overrides.supervisorProvider ??
    overrides.routerProvider ??
    deepseekProvider({
      apiKey: opts.apiKey,
      model: "deepseek-flash",
      thinking: "high",
      ...baseUrl,
    });

  // Compiled prompt assets (M-prompts-1): hints and the meta-think corpus
  // resolve from the bundle; the supervisor toggle is config/env-driven.
  const metaThinkCorpus = overrides.metaThink ?? loadMetaThinkCorpus(lang);
  const actorHints = loadActorHints(lang);
  const supervisorReference =
    overrides.supervisorReference ??
    supervisorReferenceFor(opts.supervisorEnabled);
  const supervisorRevision =
    opts.supervisorRevision ?? supervisorRevisionDefault();

  // Recap runtime — automatic long-session compaction (ADR 0009). The
  // manual /compact path (CLI) bypasses `enabled`. Keyed by session: its
  // sidecar is `.herta/compaction/<sessionId>.json`.
  const recapFor = (sid: string): Promise<RecapRuntime> =>
    buildRecapRuntime({
      routerProvider: supervisorProvider,
      workspaceRoot,
      sessionId: sid,
      enabled: true,
      lang,
    });
  const recap = await recapFor(sessionId);

  // Another session of this workspace and language, rebound in place (the
  // CLI's in-REPL /resume, ADR 0069 §3). A loaded record is never new, so
  // there is no opening to carry.
  const sessionScope = async (
    sid: string,
    record: TerminalRecord,
  ): Promise<DriverSessionScope> => {
    const boundary =
      record.length > 0 ? cachedRecapBoundary(workspaceRoot, sid, record) : 0;
    const rebuild = rebuilderFor(sid);
    return {
      staticPrefix:
        overrides.staticPrefix ?? (await derivePrefix(sid, record, boundary)),
      recap: await recapFor(sid),
      ...(rebuild !== undefined ? { rebuildStaticPrefix: rebuild } : {}),
      prefixRecapBoundary: boundary,
    };
  };

  return {
    actorProvider,
    routerProvider,
    supervisorProvider,
    staticPrefix: effectiveStaticPrefix,
    opening,
    seedBlock,
    metaThinkCorpus,
    supervisorRevision,
    // On by default; `0` is the operator's escape hatch and the lab's A/B
    // lever, the same shape as HERTA_SUPERVISOR_REVISION.
    speculativeThought: process.env.HERTA_SPECULATIVE_THOUGHT !== "0",
    actorHints,
    supervisorReference,
    recap,
    onPrompt: makePromptDump(opts.promptDumpDir, sessionId, opts.onPromptDump),
    rebuildStaticPrefix: rebuilderFor(sessionId),
    prefixRecapBoundary,
    sessionScope,
  };
}

/**
 * The recap boundary a session's prompt starts from: the cached sidecar
 * boundary, validated the way the recap runtime validates it — it must index
 * a user block inside this record, else the runtime treats the session as
 * uncompacted and so must everything that follows the runtime's view (the
 * own-dream filter, and the open session's dreamable span, ADR 0069 §2).
 * 0 = no recap engaged: the whole record is verbatim.
 */
export function cachedRecapBoundary(
  workspaceRoot: string,
  sessionId: string,
  record: TerminalRecord,
): number {
  const cached = readRecapCache(workspaceRoot, sessionId)?.boundaryIndex ?? 0;
  return cached > 0 && cached < record.length && record[cached]?.kind === "user"
    ? cached
    : 0;
}

/**
 * Filenames of dreamed 废案 to withhold from a session's prefix (design
 * 2026-07-07): those whose source episodes still sit verbatim in the record,
 * or were withdrawn from it. Fail-open — any error returns undefined (no
 * exclusions), which is exactly the pre-filter behavior. Lang-aware: an EN
 * session reads its own dream manifest (.herta/dream-en), not the zh one.
 */
export function ownDreamExclusions(opts: {
  workspaceRoot: string;
  sessionId: string;
  record: TerminalRecord;
  dream: AppServerConfig["dream"];
  lang: PromptLang;
  /** The boundary the prompt uses. Omitted → the validated cached one (a
   *  session being opened); a step-event rebuild passes the turn's own
   *  (ADR 0069 §1). */
  recapBoundaryIndex?: number;
}): ReadonlySet<string> | undefined {
  try {
    const recapBoundaryIndex =
      opts.recapBoundaryIndex ??
      cachedRecapBoundary(opts.workspaceRoot, opts.sessionId, opts.record);
    const excluded = selectPromptExclusions({
      manifest: readManifest(dreamDirFor(opts.workspaceRoot, opts.lang)),
      sessionId: opts.sessionId,
      record: opts.record,
      recapBoundaryIndex,
      config: resolveDreamConfig(opts.dream),
    });
    return excluded.size > 0 ? excluded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Optional prompt dump for debugging, enabled by `HERTA_DUMP_PROMPTS` (any
 * truthy value): each LLM call writes its literal prompt bytes to
 * `<dumpDir>/<sessionId>.prompts/turn-NNN-<label>.txt`. Off by default; a
 * dump failure must never break a turn (reported via `note`, then swallowed).
 */
function makePromptDump(
  dumpDir: string,
  sessionId: string,
  note?: (text: string) => void,
): V2ActorDriverDeps["onPrompt"] {
  if (!process.env.HERTA_DUMP_PROMPTS) return undefined;
  const promptsDir = join(dumpDir, `${sessionId}.prompts`);
  try {
    mkdirSync(promptsDir, { recursive: true });
  } catch (err) {
    const msg = errorMessage(err);
    note?.(`prompt dump disabled (mkdir failed: ${msg})`);
    return undefined;
  }
  note?.(`dumping prompts to ${promptsDir}/`);
  let promptCounter = 0;
  return (label, prompt): void => {
    try {
      promptCounter += 1;
      const filename = `turn-${String(promptCounter).padStart(3, "0")}-${label}.txt`;
      writeFileSync(join(promptsDir, filename), prompt, "utf-8");
    } catch (err) {
      const msg = errorMessage(err);
      note?.(`prompt dump failed: ${msg}`);
    }
  };
}
