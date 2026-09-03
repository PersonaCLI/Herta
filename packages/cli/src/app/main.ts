import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createActorStack,
  createBackendProvider,
  createBackendStack,
  defaultDigestModel,
} from "@herta/app-server/wiring";
import {
  ensureHertaGitignore,
  InMemoryToolRegistry,
  listSessions,
  readSessionFile,
  resolveEffectiveWorkspace,
  SessionFileError,
} from "@herta/core";
import { type PromptLang, V2ActorDriver } from "@herta/herta";
import { resolveDeepSeekKey } from "@herta/providers";
import { canonicalWorkspaceRoot } from "@herta/tools";
import { CachingAskResolver } from "../render/caching-ask-resolver.js";
import { NarrativeRenderer } from "../render/narrative-renderer.js";
import { CliAskResolver } from "../render/permission-prompt.js";
import { makeStyle } from "../render/style.js";
import { Input } from "../repl/input.js";
import { repl } from "../repl/repl.js";
import { V2RecordPersister } from "../repl/v2-record-persister.js";
import {
  parseArgs,
  parseThinking,
  printUsage,
  printVersion,
} from "./config.js";

export interface MainDeps {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  cwd?: string;
  homedir?: string;
}

export async function main(
  argv: string[],
  deps?: Partial<MainDeps>,
): Promise<number> {
  const stdin = deps?.stdin ?? process.stdin;
  const stdout = deps?.stdout ?? process.stdout;
  const stderr = deps?.stderr ?? process.stderr;

  const args = parseArgs(argv);
  if (args.help) {
    printUsage(stdout);
    return 0;
  }
  if (args.version) {
    printVersion(stdout);
    return 0;
  }

  // Interaction language — the language Herta talks in (prompt assets, seed
  // 废案, openings, recap/title, actor hints). Per-invocation flag; the CLI
  // has no per-user config file, and the static prefix is per-session anyway,
  // so a flag is the natural scope. Default "zh". Canonical record tokens
  // (（我 说）, → 系统, → 差分协处理器) stay CN in both modes (D2/D7/D8).
  let lang: PromptLang = "zh";
  if (args.lang !== undefined) {
    if (args.lang !== "zh" && args.lang !== "en") {
      stderr.write(`herta: --lang: expected zh or en, got '${args.lang}'\n`);
      return 2;
    }
    lang = args.lang;
  }

  // Canonical (audit S8): resolveSafePath realpaths every candidate file and
  // prefix-compares it against this root, so a cwd reached through a symlink
  // — `cd /tmp/proj` on macOS is the everyday case — would deny every file
  // operation as outside the workspace.
  const workspaceRoot = canonicalWorkspaceRoot(deps?.cwd ?? process.cwd());
  const transcriptDir = join(workspaceRoot, ".herta", "transcript", "v2");
  // `.herta` holds transcripts (the user's own words), command logs, tool
  // results and permission grants, right beside their source. Self-ignore it
  // before anything writes there (audit BL6).
  ensureHertaGitignore(workspaceRoot);

  // Resolve --resume target early (before the API key check) so that a bad
  // prefix fails fast without a key lookup.
  let resumeTarget:
    | {
        sessionFile: string;
        record: import("@herta/core").TerminalRecord;
        sessionId: string;
        // Stashed from the single load below so the workspace resolver does not
        // re-parse the whole (multi-MB) transcript a second time on boot.
        meta: ReturnType<typeof readSessionFile>["meta"];
        latestWorkspaceSet: ReturnType<
          typeof readSessionFile
        >["latestWorkspaceSet"];
      }
    | undefined;
  if (args.resume !== undefined) {
    const candidates = listSessions({
      transcriptDir,
      currentWorkspaceRoot: workspaceRoot,
      allWorkspaces: true,
      limit: Number.POSITIVE_INFINITY,
    });
    let chosenFile: string | undefined;
    if (args.resume === "latest") {
      const workspaceOnly = candidates.filter(
        (c) => c.workspaceRoot === workspaceRoot,
      );
      if (workspaceOnly.length === 0) {
        stderr.write(
          `herta: --resume latest: no sessions in this workspace yet\n`,
        );
        return 2;
      }
      const latestEntry = workspaceOnly[0];
      if (latestEntry === undefined) return 2; // unreachable after length check
      chosenFile = latestEntry.sessionFile;
    } else {
      // Prefix match: workspace first, then across workspaces.
      const prefix = args.resume;
      const workspaceMatches = candidates
        .filter((c) => c.workspaceRoot === workspaceRoot)
        .filter((c) => c.sessionId.startsWith(prefix));
      const matches =
        workspaceMatches.length > 0
          ? workspaceMatches
          : candidates.filter((c) => c.sessionId.startsWith(prefix));
      if (matches.length === 0) {
        stderr.write(`herta: --resume: no session matching '${args.resume}'\n`);
        return 2;
      }
      if (matches.length > 1) {
        stderr.write(
          `herta: --resume: ambiguous prefix '${args.resume}' — ${matches.length} matches:\n`,
        );
        for (const c of matches.slice(0, 10)) {
          stderr.write(`  ${c.sessionId}\n`);
        }
        return 2;
      }
      const singleMatch = matches[0];
      if (singleMatch === undefined) return 2; // unreachable after length check
      chosenFile = singleMatch.sessionFile;
    }
    try {
      const loaded = readSessionFile(chosenFile);
      resumeTarget = {
        sessionFile: chosenFile,
        record: loaded.record,
        sessionId: loaded.meta.sessionId,
        meta: loaded.meta,
        latestWorkspaceSet: loaded.latestWorkspaceSet,
      };
    } catch (err) {
      if (err instanceof SessionFileError) {
        stderr.write(`herta: --resume: ${err.message}\n`);
        return 2;
      }
      throw err;
    }
  }

  // Pin a resumed session to the language it was CREATED under (persisted in
  // the header) — mirrors the GUI host's header-wins rule (app-server
  // session-host.ts). The flag governs NEW sessions only; on resume it is just
  // the fallback for legacy headers written before per-session persistence.
  // An explicit conflicting flag is NOT obeyed: flipping mid-record splits the
  // prompt language from the record language (zh prompts over an EN record —
  // the exact drift ADR 0014 pins against), and worse, silently changes which
  // dream corpus/manifest the session reads and later distills into.
  if (resumeTarget?.meta.lang !== undefined) {
    if (args.lang !== undefined && args.lang !== resumeTarget.meta.lang) {
      stderr.write(
        `herta: --resume: session was created as ${resumeTarget.meta.lang}; ignoring --lang ${args.lang} (per-session language is pinned)\n`,
      );
    }
    lang = resumeTarget.meta.lang;
  }

  let apiKey: string;
  try {
    apiKey = await resolveDeepSeekKey({
      cwd: deps?.cwd,
      homedir: deps?.homedir,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`herta: ${msg}\n`);
    return 2;
  }

  // Dev chaos/staging lever (E2E-4 failure injection): the CLI is repo-run
  // dev tooling, so a plain env override is acceptable here — the GUI gates
  // the same knob on !app.isPackaged (see gui session-service.ts).
  const devBaseUrl = process.env.HERTA_DEEPSEEK_BASE_URL;
  const baseUrl =
    devBaseUrl !== undefined && devBaseUrl !== ""
      ? { baseUrl: devBaseUrl }
      : {};
  // Default the VISION flash (owner 2026-08-28, ADR 0048 §5a — parity with
  // the GUI): 板砖 can re-look at a picture out of the box. Plain flash was
  // the default from 2026-08-17 and stays one env var away, as does Pro.
  const backendModel =
    process.env.HERTA_BACKEND_MODEL ?? "deepseek-v4-flash-vision-exp";
  // The one way both hosts build it (@herta/app-server's session-wiring):
  // the env supplies the model and the thinking level (HERTA_BACKEND_THINKING
  // accepts low/high/max/false; default "high"), the wiring supplies
  // everything the GUI session would spell the same.
  const thinking = parseThinking(process.env.HERTA_BACKEND_THINKING, stderr);
  const backendProvider = createBackendProvider({
    apiKey,
    model: backendModel,
    ...(thinking !== undefined ? { thinking } : {}),
    ...baseUrl,
  });
  const isTty =
    typeof (stdout as { isTTY?: boolean }).isTTY === "boolean" &&
    (stdout as { isTTY?: boolean }).isTTY === true;
  const style = makeStyle({ enabled: isTty && !process.env.NO_COLOR });

  // Single mutable holder for the effective backend workspace. Shared by
  // the factory closure below (read fresh per dispatch), the project
  // command-rule store, and the repl's SlashContext (mutated by
  // `/workspace set|reset`). Seeded from the effective workspace: cwd for a
  // fresh session, the resolved root for a resume (latest workspace_set →
  // header backendWorkspace → workspaceRoot).
  // NEVER reassign `wsHolder` — only mutate `wsHolder.current` so every
  // holder reader observes the change. (Declared before the permission
  // stack: the rule store reads it per ask.)
  const wsHolder = {
    current:
      resumeTarget !== undefined
        ? // Reuse the meta + latestWorkspaceSet captured at load time above —
          // no second readSessionFile (which re-parses the whole transcript).
          resolveEffectiveWorkspace(
            resumeTarget.meta,
            resumeTarget.latestWorkspaceSet,
          )
        : workspaceRoot,
  };

  // Backend stack (shared wiring with the app-server host — see
  // @herta/app-server's session-wiring.ts): tools for the contract asked
  // for, permission engine + rules, context builder, per-dispatch runtime
  // factory, the shared bus. The contract knob (ADR 0040): the trained
  // two-tool shape (+ the two record channels) is the DEFAULT when a bash
  // exists on this machine (owner flip 2026-08-17, parity with the GUI); the
  // standard 15-tool set otherwise, or with HERTA_BACKEND_CONTRACT=standard.
  // The CLI takes the knob from the environment like its model knobs.
  const backend = createBackendStack({
    wsHolder,
    workspaceRoot,
    lang,
    wantMinimal: process.env.HERTA_BACKEND_CONTRACT !== "standard",
    backendProvider,
    // ADR 0048 §5: the stack mounts `view_image` only when this model can
    // actually see — one rule for both hosts (isVisionModel in the wiring);
    // without it an operator on the vision model would pay its latency and
    // still be told it has no eyes.
    backendModel,
    // The digest tool's side model (ADR 0043) — the same flash sidecar the
    // GUI host builds.
    digestModel: defaultDigestModel(apiKey, baseUrl),
    makeAsk: ({ cache, rules }) =>
      new CachingAskResolver(
        new CliAskResolver(stdin as NodeJS.ReadStream, stdout, style),
        cache,
        stdout,
        style,
        rules,
      ),
  });
  if (
    process.env.HERTA_BACKEND_CONTRACT === "minimal" &&
    backend.bashPath === null
  ) {
    // Warn only on an EXPLICIT request; the default falls back silently.
    stderr.write(
      "herta: HERTA_BACKEND_CONTRACT=minimal but no bash found (install Git for Windows or set HERTA_BASH); running the standard contract\n",
    );
  }
  const { bus, approvalCache, commandRules } = backend;

  // Actor session ID — for new sessions, a fresh uuid; for resumes, the
  // original session's id from the loaded file's header. Reusing the
  // original id keeps tool-log filenames correlated across resumes
  // (e.g., .herta/logs/<sessionId>-<callId>.log).
  const actorSessionId = resumeTarget?.sessionId ?? randomUUID();

  // Construct the persister: new file for fresh sessions, append-only for
  // resumes (header already on disk).
  const persister =
    resumeTarget === undefined
      ? V2RecordPersister.forNewSession({
          sessionId: actorSessionId,
          workspaceRoot,
          startedAt: new Date(),
          transcriptDir,
          // Birth language into the header (ADR 0014): reopens pin to it, the
          // GUI sidebar/store classify by it, and the dream pass groups by it
          // — a lang-less EN header would be distilled by the ZH pass.
          lang,
        })
      : V2RecordPersister.forResume({
          sessionFile: resumeTarget.sessionFile,
        });

  // Herta the actor no longer has any inline tools (2026-05-23 sweep —
  // file reads / directory listings are delegated to the backend via
  // `@板砖`). The empty registry exists only so the `/tools` slash
  // command can render with no entries; the backend's full tool set
  // is owned by the backend stack and remains the source of truth for
  // what the coding agent can do.
  const actorTools = new InMemoryToolRegistry();

  const input = new Input(stdin as NodeJS.ReadStream, stdout);

  // Actor stack (shared wiring with the app-server host): static prefix
  // (seed 废案 materialized on a fresh workspace; on --resume, this
  // session's own dreamed 废案 withheld while their source is still in the
  // loaded record), the opening for a new session, router/supervisor
  // providers, meta-think corpus + hints, recap runtime, prompt dump.
  //
  // Supervisor toggle (M-prompts-1): default ON; HERTA_SUPERVISOR=0
  // disables it for dev runs. It disables MORE than the veto (audit BL16):
  // the `@板砖` trigger re-pass gates in actor-turn live inside the same
  // `supervisorReference !== ""` block, so HERTA_SUPERVISOR=0 also turns off
  // the check that a rhetorical `@板砖` does not fire a real dispatch — while
  // the dispatch itself, keyed on the literal token, stays unconditional.
  // Dev-only: no shipped UI reaches this env var.
  const actor = await createActorStack({
    workspaceRoot,
    sessionId: actorSessionId,
    lang,
    initialRecord: resumeTarget?.record ?? [],
    apiKey,
    ...baseUrl,
    supervisorEnabled: process.env.HERTA_SUPERVISOR !== "0",
    promptDumpDir: transcriptDir,
    // A dropped few-shot (audit BL3) is otherwise invisible — the prefix just
    // silently loses a memory. stderr, not the record: this is a fact about
    // the workspace's files, not something Herta observed.
    onFewShotDropped: (name, reason) => {
      stderr.write(`herta: skipped ${name} — ${reason}\n`);
    },
    onPromptDump: (note) => {
      stderr.write(style.dim(`herta: ${note}\n`));
    },
  });

  // Default to deepseek-v4-pro for the v0.2 narrative-completion actor.
  // The actor is the user's primary touchpoint with Herta — voice fidelity
  // and Chinese nuance matter more here than per-turn latency. Operators
  // can override via HERTA_ACTOR_MODEL=deepseek-v4-flash to trade quality
  // for ~3x speed and ~10x lower cost.
  //
  // NOTE: as of 2026-05, the DeepSeek API accepts only `deepseek-v4-pro`
  // or `deepseek-v4-flash` on the completion endpoint. Any other model
  // identifier produces a 400 "supported API model names are..." error.
  const model = process.env.HERTA_ACTOR_MODEL ?? "deepseek-v4-pro";

  // `lang` selects the reveal cadence (EN word-paced, zh per code point) and
  // the 板砖→Brick display alias — session-constant, so a constructor opt.
  const v2Renderer = new NarrativeRenderer(stdout, style, { lang });

  // Transient compaction hint: show "正在压缩对话记忆…" while the recap
  // summarizer LLM is running. The indicator is written without a trailing
  // newline so `endCompactionHint()` erases it in place via `\r\x1b[K`.
  // This is purely ephemeral UI — it does NOT become a durable record block.
  bus.on("recap.compaction", (event) => {
    if (event.phase === "start") {
      v2Renderer.beginCompactionHint();
    } else {
      v2Renderer.endCompactionHint();
    }
  });

  const driver = new V2ActorDriver({
    provider: actor.actorProvider,
    model,
    staticPrefix: actor.staticPrefix,
    bus,
    runtimeFactory: backend.runtimeFactory,
    persister,
    sink: v2Renderer,
    onPrompt: actor.onPrompt,
    routerProvider: actor.routerProvider,
    metaThinkCorpus: actor.metaThinkCorpus,
    hints: actor.actorHints,
    supervisorProvider: actor.supervisorProvider,
    supervisorReference: actor.supervisorReference,
    recap: actor.recap,
    lang,
  });

  if (resumeTarget !== undefined) {
    driver.loadRecord(resumeTarget.record);
    stdout.write(
      `${style.dim(`resumed session — ${resumeTarget.record.length} block${resumeTarget.record.length === 1 ? "" : "s"} restored`)}\n`,
    );
  } else if (actor.seedBlock !== null) {
    // New session with an opening: inject the seed block as TerminalRecord
    // block 0 AND persist it to the JSONL so it survives across resumes.
    // The preamble is already folded into the static prefix; it does NOT
    // enter TerminalRecord (per Slice 8 §3 decision B). The CLI doesn't
    // render timestamps, but a CLI-created session opened in the GUI shows
    // the opening line's time.
    driver.loadRecord([actor.seedBlock]);
    persister.appendBlock(actor.seedBlock);
  }

  await repl({
    actor: driver,
    tools: actorTools,
    input,
    renderer: v2Renderer,
    out: stdout,
    style,
    lang,
    approvalCache,
    commandRules,
    transcriptDir,
    currentWorkspaceRoot: workspaceRoot,
    workspaceHolder: wsHolder,
    persister,
    home: deps?.homedir ?? homedir(),
    sessionId: actorSessionId,
  });

  return 0;
}
