import type {
  ProjectCommandRuleStore,
  SessionApprovalCache,
  ToolRegistry,
  V2RecordPersister,
} from "@herta/core";
import { errorMessage, isAbortError } from "@herta/core";
import type { PromptLang, V2ActorDriver } from "@herta/herta";
import { ProviderError } from "@herta/providers";
import { aliasBrickInput } from "../render/banzhuan-alias.js";
import type { NarrativeRenderer } from "../render/narrative-renderer.js";
import type { Style } from "../render/style.js";
import type { Input } from "./input.js";
import { handleSlashCommand } from "./slash-commands.js";

export interface ReplDeps {
  actor: V2ActorDriver;
  renderer: NarrativeRenderer;
  tools: ToolRegistry;
  input: Input;
  out: NodeJS.WritableStream;
  style: Style;
  /** Session interaction language. `en` translates a typed `@Brick` back to the
   *  wire token `@板砖` before dispatch. Default "zh" (no translation). */
  lang?: PromptLang;
  approvalCache?: SessionApprovalCache;
  /** Threaded into SlashContext for /permissions (project rules, ADR 0030). */
  commandRules?: ProjectCommandRuleStore;
  /** Threaded into SlashContext for /resume. */
  transcriptDir?: string;
  /** Threaded into SlashContext for /resume. */
  currentWorkspaceRoot?: string;
  /** Mutable backend-workspace holder, threaded into SlashContext for /workspace. */
  workspaceHolder?: { current: string };
  /** Threaded into SlashContext for /workspace (appends workspace_set lines). */
  persister?: V2RecordPersister;
  /** Threaded into SlashContext for /workspace set|reset. */
  home?: string;
  /** Threaded into SlashContext for /workspace reset (managed default). */
  sessionId?: string;
}

export async function repl(deps: ReplDeps): Promise<void> {
  printGreeting(deps);
  // Render any pre-loaded blocks before the first input prompt. The
  // differential NarrativeRenderer ensures subsequent per-turn update()
  // calls don't re-render. Three startup scenarios:
  //   - empty record (no opening, no resume): update([]) is a no-op.
  //   - new session with seed: renders Herta's first （我 说） block.
  //   - resumed session: renders the full loaded record.
  deps.renderer.update(deps.actor.getRecord());
  while (true) {
    deps.out.write("> ");
    const line = await deps.input.readLine("");
    if (line === null) break;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("/")) {
      const r = await handleSlashCommand(trimmed, {
        tools: deps.tools,
        out: deps.out,
        style: deps.style,
        lang: deps.lang,
        approvalCache: deps.approvalCache,
        commandRules: deps.commandRules,
        driver: deps.actor,
        transcriptDir: deps.transcriptDir,
        currentWorkspaceRoot: deps.currentWorkspaceRoot,
        workspaceHolder: deps.workspaceHolder,
        persister: deps.persister,
        home: deps.home,
        sessionId: deps.sessionId,
      });
      if (r.action === "quit") break;
      continue;
    }
    const controller = new AbortController();
    const interruptHandle = installInterruptHandler(controller);
    try {
      // EN input alias: a typed `@Brick` becomes the wire token `@板砖` BEFORE
      // dispatch, so the delegation trigger is unchanged (display-only surface
      // both ways). Slash commands above are never aliased. zh passes through.
      const wireText = aliasBrickInput(trimmed, deps.lang ?? "zh");
      const record = await deps.actor.runTurn(wireText, controller.signal);
      deps.renderer.update(record);
    } catch (err) {
      // Slice 9: if we crashed mid-stream, the renderer may be in
      // streaming state. Reset it so the next turn starts cleanly. The
      // partial text on screen stays there (terminals can't roll back);
      // the error message follows on a new line.
      const rendererWithCancel = deps.renderer as {
        cancelStream?: () => void;
      };
      if (typeof rendererWithCancel.cancelStream === "function") {
        rendererWithCancel.cancelStream();
      }
      const msg = errorMessage(err);
      // Classify before printing (audit 2026-07-24, 1.13). Ctrl+C — which the
      // greeting advertises — printed a red `✗ internal: turn aborted`,
      // indistinguishable from a crash, and a 401 sent the user to debug
      // Herta instead of their key. The information was already on the error;
      // it was simply discarded. The GUI path treats the same throw as an
      // interrupt.
      if (isAbortError(err)) {
        deps.out.write(deps.style.dim("  (interrupted)\n"));
      } else if (err instanceof ProviderError) {
        const status = err.status !== undefined ? ` ${err.status}` : "";
        deps.out.write(deps.style.red(`✗ provider${status}: ${msg}\n`));
      } else {
        // Mirror the v0.1 TranscriptRenderer.renderTurnFailure format —
        // `✗ ${kind}: ${message}\n` in red — for genuinely unclassified throws.
        deps.out.write(deps.style.red(`✗ internal: ${msg}\n`));
      }
    } finally {
      interruptHandle.dispose();
    }
  }
  printGoodbye(deps);
}

function printGreeting(deps: ReplDeps): void {
  deps.out.write(`${deps.style.bright("Herta")}\n`);
  deps.out.write(
    `${deps.style.dim("/help for commands, Ctrl+C to interrupt")}\n`,
  );
}

function printGoodbye(deps: ReplDeps): void {
  deps.out.write(`${deps.style.dim("session ended.")}\n`);
}

interface InterruptHandle {
  dispose: () => void;
}

function installInterruptHandler(controller: AbortController): InterruptHandle {
  const handler = (): void => {
    controller.abort();
  };
  process.on("SIGINT", handler);
  return {
    dispose: () => {
      process.off("SIGINT", handler);
    },
  };
}
